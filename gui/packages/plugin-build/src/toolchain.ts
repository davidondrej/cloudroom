import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { omitNpmScriptPolicyEnv } from "@cloudroom/process-utils";
import toolchainLock from "../toolchain/package-lock.json" with { type: "json" };
import toolchainPackage from "../toolchain/package.json" with { type: "json" };
import { resolvePluginNpmCli } from "./npm-cli.js";

const run = promisify(execFile);

export const NODE_ESM_REQUIRE_BANNER = [
  'import { createRequire as __createRequire } from "node:module";',
  'import { dirname as __pathDirname } from "node:path";',
  'import { fileURLToPath as __fileURLToPath } from "node:url";',
  "const require = __createRequire(import.meta.url);",
  "var __filename = __fileURLToPath(import.meta.url);",
  "var __dirname = __pathDirname(__filename);",
].join("\n");

// Fetched toolchains install exactly what toolchain/package-lock.json locks (#2158), so every transitive version
// passes the 48-hour rule and CVE watch sees it. The lock has integrity hashes but no `resolved` URLs, so npm
// fetches from the user's registry and scoped registries. Bump: edit toolchain/package.json, then in toolchain/ run
// `node ../node_modules/npm/bin/npm-cli.js install --package-lock-only --ignore-scripts --min-release-age=2 --omit-lockfile-registry-resolved`
// (the repo-pinned npm 11; npm 10 silently ignores --min-release-age).
export const PLUGIN_TOOLCHAIN_PINS = toolchainPackage.dependencies;
const LOCK_HASH = createHash("sha256")
  .update(JSON.stringify(toolchainLock))
  .digest("hex")
  .slice(0, 12);

export interface PluginBuildToolchain {
  esbuild: string;
  tailwindNode: string;
  tailwindOxide: string;
  tailwindCssDir: string;
}

function pinKey(): string {
  return Object.entries(PLUGIN_TOOLCHAIN_PINS)
    .map(([name, version]) => `${name}@${version}`)
    .sort()
    .join(",");
}

export function toolchainCacheDir(baseDir: string): string {
  const key = Object.values(PLUGIN_TOOLCHAIN_PINS).join("-");
  return join(baseDir, `toolchain-${key}-${LOCK_HASH}`);
}

function packageDir(require: NodeRequire, name: string): string | null {
  let dir: string;
  try {
    dir = dirname(require.resolve(name));
  } catch {
    return null;
  }
  for (let depth = 0; depth < 10; depth += 1) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          (parsed as { name?: unknown }).name === name
        ) {
          return dir;
        }
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function readVersion(require: NodeRequire, name: string): string | null {
  const dir = packageDir(require, name);
  if (dir === null) return null;
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    );
    const version =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { version?: unknown }).version
        : undefined;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

function toolchainFrom(require: NodeRequire): PluginBuildToolchain | null {
  for (const [name, pinned] of Object.entries(PLUGIN_TOOLCHAIN_PINS)) {
    if (readVersion(require, name) !== pinned) return null;
  }
  try {
    const tailwindCssDir = packageDir(require, "tailwindcss");
    if (tailwindCssDir === null) return null;
    return {
      esbuild: pathToFileURL(require.resolve("esbuild")).href,
      tailwindNode: pathToFileURL(require.resolve("@tailwindcss/node")).href,
      tailwindOxide: pathToFileURL(require.resolve("@tailwindcss/oxide")).href,
      tailwindCssDir,
    };
  } catch {
    return null;
  }
}

function resolveLocalToolchain(): PluginBuildToolchain | null {
  return toolchainFrom(createRequire(import.meta.url));
}

async function isInstalled(dir: string): Promise<boolean> {
  try {
    const raw = await readFile(join(dir, ".bb-toolchain.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { pins?: unknown }).pins !== pinKey()
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return toolchainFrom(createRequire(join(dir, "noop.js"))) !== null;
}

export async function resolvePluginBuildToolchain(
  baseDir: string,
  options?: {
    onFetchStart?: () => void;
    onFetchDone?: (elapsedMs: number) => void;
    ignoreLocal?: boolean;
  },
): Promise<PluginBuildToolchain> {
  if (options?.ignoreLocal !== true) {
    const local = resolveLocalToolchain();
    if (local !== null) return local;
  }

  const dir = toolchainCacheDir(baseDir);
  if (await isInstalled(dir)) {
    const cached = toolchainFrom(createRequire(join(dir, "noop.js")));
    if (cached !== null) return cached;
  }

  options?.onFetchStart?.();
  const startedAt = Date.now();
  const staging = `${dir}.staging-${randomUUID()}`;
  try {
    await mkdir(staging, { recursive: true });
    await writeFile(
      join(staging, "package.json"),
      `${JSON.stringify(toolchainPackage, null, 2)}\n`,
    );
    await writeFile(
      join(staging, "package-lock.json"),
      `${JSON.stringify(toolchainLock, null, 2)}\n`,
    );
    await run(
      process.execPath,
      [
        resolvePluginNpmCli(),
        "ci",
        "--prefix",
        staging,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      {
        maxBuffer: 1024 * 1024 * 16,
        env: omitNpmScriptPolicyEnv(process.env),
      },
    );
    const staged = toolchainFrom(createRequire(join(staging, "noop.js")));
    if (staged === null) {
      throw new Error(
        "the downloaded plugin build toolchain is incomplete or misversioned",
      );
    }
    await writeFile(
      join(staging, ".bb-toolchain.json"),
      `${JSON.stringify({ pins: pinKey() }, null, 2)}\n`,
    );
    await mkdir(dirname(dir), { recursive: true });
    try {
      await rename(staging, dir);
    } catch {
      if (!(await isInstalled(dir))) throw new Error(errorPromoting(dir));
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  const promoted = toolchainFrom(createRequire(join(dir, "noop.js")));
  if (promoted === null) throw new Error(errorPromoting(dir));
  options?.onFetchDone?.(Date.now() - startedAt);
  return promoted;
}

function errorPromoting(dir: string): string {
  return `could not install the plugin build toolchain into ${dir}`;
}
