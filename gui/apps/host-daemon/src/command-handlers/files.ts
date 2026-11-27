// The host's file commands, answered by Core's `cloudroom fs` (core/src/fs.rs): the same code reads and writes files
// for Local and Cloud threads. This side adds only what the app owns: file types, and ranking for searches.
// Until every computer has a Core with `fs` (a joined machine on another OS or CPU may have none, and Windows builds
// list no features yet), the old TypeScript handlers answer instead.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import mimeTypes from "mime-types";
import { fuzzyMatchPaths } from "@cloudroom/fuzzy-match";
import type {
  HostDaemonOnlineRpcResult,
  HostPathEntry,
  HostPathEntryKind,
} from "@cloudroom/host-daemon-contract";
import { coreWith } from "@cloudroom/host-workspace";
import { sanitizeInheritedChildProcessEnv } from "@cloudroom/process-utils";
import {
  CommandDispatchError,
  ExpectedCommandDispatchError,
  type CommandDispatchOptions,
  type CommandOf,
} from "../command-dispatch-support.js";
import { userExecutableProcessOptions } from "../user-executable-env.js";
import { writeHostFile as legacyWrite } from "./file-write.js";
import * as legacy from "./host-files.js";
import * as legacyPaths from "./path-mutations.js";

export { browseHostDirectory } from "./host-files.js";

const READ_FILE_BYTES = 50 * 1024 * 1024;
/** A 50 MB file as base64 in JSON, with room to spare. */
const MAX_OUTPUT_BYTES = 80 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

type Options = Pick<CommandDispatchOptions, "runtimeManager">;
type Listed = { kind: HostPathEntryKind; path: string; name: string };
type ReadResult = HostDaemonOnlineRpcResult<"host.read_file">;
type ContentResult = Extract<ReadResult, { content: string }>;

function core(): string | null {
  return coreWith("fs");
}

/** Runs `cloudroom fs COMMAND` with one JSON request, and turns its refusals into the daemon's errors. */
function coreFs<T>(binary: string, command: string, request: object, options?: Options): Promise<T> {
  const shellPath = userExecutableProcessOptions(options?.runtimeManager.getShellEnv() ?? {}).shellPath;
  return new Promise((resolve, reject) => {
    const child = execFile(binary, ["fs", command], {
      encoding: "utf8",
      env: sanitizeInheritedChildProcessEnv({ env: process.env, ...(shellPath !== undefined ? { shellPath } : {}) }),
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      let reply: { error?: { code: string; message: string; expected: boolean } } | undefined;
      try { reply = JSON.parse(stdout) as typeof reply; } catch { reply = undefined; }
      if (!error && reply) return resolve(reply as T);
      const refusal = error?.code === 1 ? reply?.error : undefined;
      if (refusal) {
        return reject(refusal.expected
          ? new ExpectedCommandDispatchError(refusal.code, refusal.message)
          : new CommandDispatchError(refusal.code, refusal.message));
      }
      reject(new Error(`cloudroom fs ${command} failed: ${stderr.trim() || error?.message || "no reply"}`));
    });
    child.stdin?.end(JSON.stringify(request));
  });
}

function fileType(path: string): { mimeType: string | undefined; image: boolean; limit: number } {
  const mimeType = mimeTypes.lookup(path) || undefined;
  // SVG is text the viewer can show and edit; other images are bytes.
  const image = Boolean(mimeType?.startsWith("image/") && mimeType !== "image/svg+xml");
  return { mimeType, image, limit: READ_FILE_BYTES };
}

function withType<T extends object>(result: T, mimeType: string | undefined): T {
  return mimeType ? { ...result, mimeType } : result;
}

export function readHostFile(
  command: CommandOf<"host.read_file"> & { ifNoneMatch?: undefined },
  options?: Options,
): Promise<ContentResult>;
export function readHostFile(command: CommandOf<"host.read_file">, options?: Options): Promise<ReadResult>;
export async function readHostFile(command: CommandOf<"host.read_file">, options?: Options): Promise<ReadResult> {
  const binary = core();
  if (!binary) return legacy.readHostFile(command, options);
  const { mimeType, image, limit } = fileType(command.path);
  return withType(await coreFs<ReadResult>(binary, "read", { ...command, image, limit }, options), mimeType);
}

export async function readHostRelativeFile(
  command: CommandOf<"host.read_file_relative">,
): Promise<HostDaemonOnlineRpcResult<"host.read_file_relative">> {
  const binary = core();
  if (!binary) return legacy.readHostRelativeFile(command);
  const { mimeType, image } = fileType(command.path);
  return withType(await coreFs<ContentResult>(binary, "read-relative", { ...command, image }), mimeType);
}

export async function readHostFileMetadata(
  command: CommandOf<"host.file_metadata">,
): Promise<HostDaemonOnlineRpcResult<"host.file_metadata">> {
  const binary = core();
  return binary ? coreFs(binary, "metadata", command) : legacy.readHostFileMetadata(command);
}

/** Core locks the file's folder, so saves from the same version take turns: one wins, the other gets a conflict. */
export async function writeHostFile(
  command: CommandOf<"host.write_file">,
): Promise<HostDaemonOnlineRpcResult<"host.write_file">> {
  const binary = core();
  const result = binary ? await coreFs<HostDaemonOnlineRpcResult<"host.write_file">>(binary, "write", command) : await legacyWrite(command);
  listings.clear();
  return result;
}

export async function mkdirHostPath(command: CommandOf<"host.mkdir">): Promise<HostDaemonOnlineRpcResult<"host.mkdir">> {
  const binary = core();
  const result = binary ? await coreFs<HostDaemonOnlineRpcResult<"host.mkdir">>(binary, "mkdir", command) : await legacyPaths.mkdirHostPath(command);
  listings.clear();
  return result;
}

export async function moveHostPath(
  command: CommandOf<"host.move_path">,
): Promise<HostDaemonOnlineRpcResult<"host.move_path">> {
  const binary = core();
  const result = binary ? await coreFs<HostDaemonOnlineRpcResult<"host.move_path">>(binary, "move", command) : await legacyPaths.moveHostPath(command);
  listings.clear();
  return result;
}

export async function removeHostPath(
  command: CommandOf<"host.remove_path">,
): Promise<HostDaemonOnlineRpcResult<"host.remove_path">> {
  const binary = core();
  const result = binary ? await coreFs<HostDaemonOnlineRpcResult<"host.remove_path">>(binary, "remove", command) : await legacyPaths.removeHostPath(command);
  listings.clear();
  return result;
}

export async function checkHostPathsExist(
  command: CommandOf<"host.paths_exist">,
): Promise<HostDaemonOnlineRpcResult<"host.paths_exist">> {
  const binary = core();
  return binary ? coreFs(binary, "exists", command) : legacy.checkHostPathsExist(command);
}

const LISTING_CACHE_TTL_MS = 15_000;
const LISTING_CACHE_MAX_ENTRIES = 16;

interface CachedListing {
  stamp: string;
  expiresAt: number;
  promise: Promise<Listed[]>;
}

/** Recent walks are reused for consecutive `@` keystrokes and shared across concurrent calls. */
const listings = new Map<string, CachedListing>();

async function readListingStamp(rootPath: string): Promise<string> {
  const [rootStat, ignoreStat] = await Promise.all([
    fs.stat(rootPath).catch(() => null),
    fs.stat(path.join(rootPath, ".gitignore")).catch(() => null),
  ]);
  return `${rootStat?.mtimeMs ?? 0}:${ignoreStat?.mtimeMs ?? 0}`;
}

async function listPaths(binary: string, command: CommandOf<"host.list_files"> | CommandOf<"host.list_paths">, files: boolean, folders: boolean) {
  const request = {
    path: command.path,
    includeFiles: files,
    includeDirectories: folders,
    includeHidden: command.includeHidden,
    excludeNames: [...new Set(command.excludeNames)].sort(),
    respectGitIgnore: command.respectGitIgnore,
  };
  const key = JSON.stringify(request);
  const stamp = await readListingStamp(command.path);
  const now = Date.now();
  const cached = listings.get(key);
  if (cached !== undefined && cached.stamp === stamp && cached.expiresAt > now) {
    return cached.promise;
  }
  const promise = coreFs<{ paths: Listed[] }>(binary, "list", request).then((reply) => reply.paths);
  const entry: CachedListing = {
    stamp,
    expiresAt: now + LISTING_CACHE_TTL_MS,
    promise,
  };
  if (listings.size >= LISTING_CACHE_MAX_ENTRIES && !listings.has(key)) {
    const oldestKey = listings.keys().next().value;
    if (oldestKey !== undefined) listings.delete(oldestKey);
  }
  listings.set(key, entry);
  void promise.then(
    () => {
      if (listings.get(key) === entry) {
        entry.expiresAt = Date.now() + LISTING_CACHE_TTL_MS;
      }
    },
    () => {
      if (listings.get(key) === entry) listings.delete(key);
    },
  );
  return promise;
}

/** Best matches first when there is a query, else the folder's order; at most `limit`. */
function rank(paths: Listed[], limit: number, query: string | undefined): { paths: HostPathEntry[]; truncated: boolean } {
  const ranked: HostPathEntry[] = query
    ? fuzzyMatchPaths({ items: paths, query, getPath: (entry) => entry.path, limit: limit + 1 })
      .map((match) => ({ ...match.item, score: match.score, positions: match.positions }))
    : paths.map((entry) => ({ ...entry, score: 0, positions: [] }));
  return { paths: ranked.slice(0, limit), truncated: ranked.length > limit };
}

export async function listHostFiles(
  command: CommandOf<"host.list_files">,
): Promise<HostDaemonOnlineRpcResult<"host.list_files">> {
  const binary = core();
  if (!binary) return legacy.listHostFiles(command);
  const { paths, truncated } = rank(await listPaths(binary, command, true, false), command.limit, command.query);
  return { files: paths.map(({ path, name }) => ({ path, name })), truncated };
}

export async function listHostPaths(
  command: CommandOf<"host.list_paths">,
): Promise<HostDaemonOnlineRpcResult<"host.list_paths">> {
  const binary = core();
  if (!binary) return legacy.listHostPaths(command);
  const listed = await listPaths(binary, command, command.includeFiles, command.includeDirectories);
  return rank(listed, command.limit, command.query);
}
