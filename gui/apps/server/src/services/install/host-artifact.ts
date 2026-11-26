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
import { dirname, join, posix, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createGzip } from "node:zlib";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@cloudroom/host-daemon-contract";

const execFileAsync = promisify(execFile);
const HOST_DEPENDENCIES = [
  "@parcel/watcher",
  "fs-native-extensions",
  "node-pty",
  "pino-roll",
] as const;
const HOST_DAEMON_FILES = [
  "room-cli",
  "room-parcel-watcher-child.mjs",
  "room-plugin-host-worker.mjs",
  "room-provider-bridge-worker.mjs",
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
    windowsHide: true,
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
  // Core's binary for the Git panel (`cloudroom git`), when this app bundles one, in a folder named for this
  // computer's OS and CPU: only joined machines with the same ones use it.
  await cp(
    join(packageRoot, "server", "dist", "assets", "cloudroom-core"),
    join(hostPackageRoot, "host-daemon", "cloudroom-core", `${process.platform}-${process.arch}`),
    { recursive: true },
  ).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  });
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

// The .tgz node-tar 7 wrote here with `portable: true`, byte for byte: per file
// a ustar header (after a pax header when the path is long or not ASCII), the
// data padded to 512 bytes, two zero blocks, then gzip level 9 with OS byte
// 255. Hard links are packed as plain files.
function tarString(block: Buffer, offset: number, size: number, value: string) {
  block.write(value, offset, size, "utf8");
  return value.length !== Buffer.byteLength(value) || value.length > size;
}

function tarNumber(block: Buffer, offset: number, size: number, value: number) {
  const octal = Math.floor(value).toString(8);
  block.write(
    octal.length === size - 1
      ? `${octal}\0`
      : `${octal.padStart(size - 2, "0")} \0`,
    offset,
    size,
    "ascii",
  );
}

// node-tar's split: a path of 100+ bytes keeps its leading folders in the
// 155-byte prefix ("package" always fits), and a name over 100 bytes needs pax.
function splitTarPath(path: string): [string, string, boolean] {
  if (Buffer.byteLength(path) < 100) return [path, "", false];
  let name = posix.basename(path);
  let prefix = posix.dirname(path);
  while (Buffer.byteLength(prefix) > 155) {
    name = posix.join(posix.basename(prefix), name);
    prefix = posix.dirname(prefix);
  }
  return Buffer.byteLength(name) <= 100
    ? [name, prefix, false]
    : [name.slice(0, 99), prefix, true];
}

function tarHeader(path: string, type: "0" | "x", mode: number, size: number) {
  const block = Buffer.alloc(512);
  const [name, prefix, tooLong] = splitTarPath(path);
  let needsPax = tarString(block, 0, 100, name) || tooLong;
  tarNumber(block, 100, 8, mode);
  tarNumber(block, 124, 12, size);
  tarNumber(block, 136, 12, NPM_PACK_MTIME.getTime() / 1000);
  block[156] = type.charCodeAt(0);
  block.write("ustar\u000000", 257, "ascii");
  tarNumber(block, 329, 8, 0);
  tarNumber(block, 337, 8, 0);
  needsPax = tarString(block, 345, 155, prefix) || needsPax;
  // The still-empty checksum field counts as 8 spaces.
  tarNumber(
    block,
    148,
    8,
    block.reduce((sum, byte) => sum + byte, 8 * 0x20),
  );
  return { block, needsPax };
}

function paxRecord(key: string, value: string | number): string {
  const record = ` ${key}=${value}\n`;
  const bytes = Buffer.byteLength(record);
  // The record's length counts its own digits.
  let digits = String(bytes).length;
  if (bytes + digits >= 10 ** digits) digits += 1;
  return `${digits + bytes}${record}`;
}

const padTo512 = (bytes: Buffer) =>
  Buffer.concat([bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);

async function* tarBlocks(root: string, files: string[]) {
  for (const file of files) {
    const stats = await lstat(join(root, file));
    const data = await readFile(join(root, file));
    // Windows has no exec bit, so every mode is set explicitly.
    const executable = HOST_EXECUTABLES.has(file) || (stats.mode & 0o111) !== 0;
    const path = `package/${file}`;
    const header = tarHeader(
      path,
      "0",
      executable ? 0o755 : 0o644,
      data.length,
    );
    if (header.needsPax) {
      const pax = Buffer.from(
        paxRecord("path", path) +
          paxRecord("mtime", NPM_PACK_MTIME.getTime() / 1000) +
          paxRecord("size", data.length),
      );
      const name = `PaxHeader/${posix.basename(path)}`.slice(0, 99);
      yield tarHeader(name, "x", 0o644, pax.length).block;
      yield padTo512(pax);
    }
    yield header.block;
    if (data.length > 0) yield padTo512(data);
  }
  yield Buffer.alloc(1024);
}

export async function packHostPackage(
  hostPackageRoot: string,
): Promise<Buffer> {
  const files = await listPackageFiles(hostPackageRoot);
  const chunks: Buffer[] = [];
  await pipeline(
    tarBlocks(hostPackageRoot, files),
    createGzip({ level: 9 }),
    async (gzipped: AsyncIterable<Buffer>) => {
      for await (const chunk of gzipped) chunks.push(chunk);
    },
  );
  const bytes = Buffer.concat(chunks);
  bytes[9] = 255; // gzip's OS byte: "unknown", the same on every OS
  return bytes;
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
