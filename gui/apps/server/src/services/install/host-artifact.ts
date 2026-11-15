import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@cloudroom/host-daemon-contract";
import { create as createTar } from "tar";

const execFileAsync = promisify(execFile);
const HOST_DEPENDENCIES = [
  "@parcel/watcher",
  "fs-native-extensions",
  "node-pty",
  "pino",
  "pino-pretty",
  "pino-roll",
] as const;
const HOST_DAEMON_FILES = [
  "room-cli",
  "bb-parcel-watcher-child.mjs",
  "bb-plugin-host-worker.mjs",
  "bb-provider-bridge-worker.mjs",
  "daemon-bundle.mjs",
] as const;
const HOST_PACKAGE_FILES = ["dist", "host-daemon", "README.md"] as const;
const HOST_BINS = {
  "room-cli": "dist/room-cli.js",
  "bb-app": "dist/bb-app.js",
} as const;
const HOST_EXECUTABLES: ReadonlySet<string> = new Set([
  ...Object.values(HOST_BINS),
  "host-daemon/dist/room-cli",
]);
const NPM_PACK_MTIME = new Date("1985-10-26T08:15:00.000Z");
const ALWAYS_PACKED =
  /^(package\.json|(readme|license|licence|copying)(\..*)?)$/iu;
const IGNORE_FILES = /^\.(npmignore|gitignore)$/iu;
const NEVER_PACKED =
  /^(\.npmrc|\.git|\.svn|\.hg|CVS|node_modules|\.DS_Store|npm-debug\.log|\._.*|\..*\.swp|.*\.orig)$/iu;

export interface RoomAppArtifact {
  digest: string;
  path: string;
  size: number;
}

export interface RoomAppArtifactService {
  getArtifact(): Promise<RoomAppArtifact>;
  getVersion(): Promise<string>;
}

export interface RoomAppArtifactCommandRunner {
  (command: string, args: readonly string[], cwd: string): Promise<string>;
}

interface CreateRoomAppArtifactServiceOptions {
  dataDir: string;
  commandRunner?: RoomAppArtifactCommandRunner;
  protocolVersion?: number;
  serverEntryUrl: string;
}

interface RoomAppPackageJson {
  dependencies: Record<string, string>;
  engines: { node: string };
  name: "bb-app";
  os: string[];
  version: string;
}

async function defaultCommandRunner(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  const result = await execFileAsync(command, [...args], {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

async function readRoomAppPackageJson(
  packageRoot: string,
): Promise<RoomAppPackageJson> {
  const parsed: unknown = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("name" in parsed) ||
    parsed.name !== "bb-app" ||
    !("version" in parsed) ||
    typeof parsed.version !== "string" ||
    !("dependencies" in parsed) ||
    !isStringRecord(parsed.dependencies) ||
    !("engines" in parsed) ||
    parsed.engines === null ||
    typeof parsed.engines !== "object" ||
    !("node" in parsed.engines) ||
    typeof parsed.engines.node !== "string" ||
    !("os" in parsed) ||
    !Array.isArray(parsed.os) ||
    !parsed.os.every((entry) => typeof entry === "string")
  ) {
    throw new Error(`Expected a bb-app package at ${packageRoot}`);
  }
  return {
    dependencies: parsed.dependencies,
    engines: { node: parsed.engines.node },
    name: parsed.name,
    os: parsed.os,
    version: parsed.version,
  };
}

interface ResolvedRoomAppPackage {
  layout: "packaged" | "repo";
  packageJson: RoomAppPackageJson;
  root: string;
}

export async function resolveRoomAppPackage(
  serverEntryUrl: string,
): Promise<ResolvedRoomAppPackage> {
  const serverEntryDir = dirname(fileURLToPath(serverEntryUrl));
  const candidates: readonly { layout: "packaged" | "repo"; root: string }[] = [
    { layout: "packaged", root: resolve(serverEntryDir, "../..") },
    {
      layout: "repo",
      root: resolve(serverEntryDir, "../../../packages/bb-app"),
    },
  ];
  for (const candidate of candidates) {
    try {
      const packageJson = await readRoomAppPackageJson(candidate.root);
      return { ...candidate, packageJson };
    } catch {}
  }
  throw new Error(
    `Unable to locate the bb-app package from ${serverEntryDir}; tried ${candidates
      .map((candidate) => candidate.root)
      .join(", ")}`,
  );
}

function hostPackageJson(packageJson: RoomAppPackageJson): object {
  const dependencies = Object.fromEntries(
    HOST_DEPENDENCIES.map((name) => {
      const version = packageJson.dependencies[name];
      if (version === undefined) {
        throw new Error(`bb-app is missing host dependency ${name}`);
      }
      return [name, version];
    }),
  );
  return {
    name: packageJson.name,
    version: packageJson.version,
    description: "Cloudroom enrolled host runtime",
    type: "module",
    os: packageJson.os,
    bin: HOST_BINS,
    files: HOST_PACKAGE_FILES,
    engines: packageJson.engines,
    dependencies,
  };
}

async function materializePackagedHostPackage(
  packageRoot: string,
  packageJson: RoomAppPackageJson,
  cacheDir: string,
): Promise<string> {
  const hostPackageRoot = await mkdtemp(join(cacheDir, "host-package-"));
  const distDir = join(hostPackageRoot, "dist");
  const hostDaemonSource = join(packageRoot, "host-daemon", "dist");
  const hostDaemonTarget = join(hostPackageRoot, "host-daemon", "dist");
  await mkdir(hostDaemonTarget, { recursive: true });
  await mkdir(distDir, { recursive: true });
  for (const target of Object.values(HOST_BINS)) {
    await copyFile(join(packageRoot, target), join(hostPackageRoot, target));
  }
  for (const fileName of HOST_DAEMON_FILES) {
    await copyFile(
      join(hostDaemonSource, fileName),
      join(hostDaemonTarget, fileName),
    );
  }
  await cp(
    join(hostDaemonSource, "room-cli-chunks"),
    join(hostDaemonTarget, "room-cli-chunks"),
    { recursive: true },
  );
  try {
    await copyFile(
      join(packageRoot, "README.md"),
      join(hostPackageRoot, "README.md"),
    );
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
  await writeFile(
    join(hostPackageRoot, "package.json"),
    `${JSON.stringify(hostPackageJson(packageJson), null, 2)}\n`,
  );
  return hostPackageRoot;
}

// npm pack's file rules for this package: the root holds only package.json,
// README/LICENSE and `files`. Ignore files would need npm's glob rules, so we
// refuse them instead of packing something npm wouldn't.
async function listPackageFiles(root: string, dir = ""): Promise<string[]> {
  const files: string[] = [];
  for (const name of (await readdir(join(root, dir))).sort()) {
    const path = dir ? `${dir}/${name}` : name;
    if (dir && IGNORE_FILES.test(name)) {
      throw new Error(
        `The host package has an unsupported ignore file: ${path}`,
      );
    }
    const packed = dir
      ? !NEVER_PACKED.test(name)
      : ALWAYS_PACKED.test(name) ||
        (HOST_PACKAGE_FILES as readonly string[]).includes(name);
    if (!packed) continue;
    const stats = await lstat(join(root, path));
    if (stats.isDirectory()) {
      files.push(...(await listPackageFiles(root, path)));
    } else if (stats.isFile()) {
      files.push(path);
    }
  }
  return files;
}

export async function packHostPackage(
  hostPackageRoot: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const archive = createTar(
    {
      cwd: hostPackageRoot,
      gzip: { level: 9 },
      mtime: NPM_PACK_MTIME,
      portable: true,
      prefix: "package",
      // Windows has no exec bit, so set every mode explicitly. This relies on
      // node-tar reusing this stat object; the mode test in
      // host-artifact.test.ts catches it if a tar update changes that.
      filter: (path, stat) => {
        const executable =
          HOST_EXECUTABLES.has(path.replaceAll("\\", "/")) ||
          (stat.mode! & 0o111) !== 0;
        stat.mode = (stat.mode! & ~0o7777) | (executable ? 0o755 : 0o644);
        return true;
      },
    },
    await listPackageFiles(hostPackageRoot),
  );
  for await (const chunk of archive) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createRoomAppArtifactService(
  options: CreateRoomAppArtifactServiceOptions,
): RoomAppArtifactService {
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const cacheDir = join(options.dataDir, "install-cache");
  const protocolVersion =
    options.protocolVersion ?? HOST_DAEMON_PROTOCOL_VERSION;
  let resolvedPackagePromise: Promise<ResolvedRoomAppPackage> | undefined;
  let artifactPromise: Promise<RoomAppArtifact> | undefined;

  function getResolvedPackage(): Promise<ResolvedRoomAppPackage> {
    resolvedPackagePromise ??= resolveRoomAppPackage(options.serverEntryUrl);
    return resolvedPackagePromise;
  }

  async function buildArtifact(): Promise<RoomAppArtifact> {
    const resolved = await getResolvedPackage();
    const { packageJson, root: packageRoot } = resolved;
    await mkdir(cacheDir, { recursive: true });
    let temporaryHostPackageRoot: string | undefined;
    let hostPackageRoot: string;
    if (resolved.layout === "repo") {
      const repoRoot = resolve(packageRoot, "../..");
      await commandRunner(
        "pnpm",
        ["exec", "turbo", "run", "build:host", "--filter=bb-app"],
        repoRoot,
      );
      hostPackageRoot = join(packageRoot, "host-package");
    } else {
      temporaryHostPackageRoot = await materializePackagedHostPackage(
        packageRoot,
        packageJson,
        cacheDir,
      );
      hostPackageRoot = temporaryHostPackageRoot;
    }

    try {
      const bytes = await packHostPackage(hostPackageRoot);
      const digest = sha256(bytes);
      const artifactPath = join(
        cacheDir,
        `bb-app-host-${packageJson.version}-protocol-${protocolVersion}-${digest}.tgz`,
      );
      const temporaryArtifactPath = `${artifactPath}.${process.pid}.tmp`;
      await writeFile(temporaryArtifactPath, bytes);
      await rename(temporaryArtifactPath, artifactPath);
      return { digest, path: artifactPath, size: bytes.length };
    } finally {
      if (temporaryHostPackageRoot !== undefined) {
        await rm(temporaryHostPackageRoot, { force: true, recursive: true });
      }
    }
  }

  return {
    getArtifact(): Promise<RoomAppArtifact> {
      artifactPromise ??= buildArtifact().catch((error: unknown) => {
        artifactPromise = undefined;
        throw error;
      });
      return artifactPromise;
    },
    async getVersion(): Promise<string> {
      return (await getResolvedPackage()).packageJson.version;
    },
  };
}
