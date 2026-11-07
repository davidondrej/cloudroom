import { realpath as resolveSymlinksPreservingDrive } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  DirectoryEntry,
  HostDaemonOnlineRpcResult,
  HostPathEntryKind,
} from "@cloudroom/host-daemon-contract";
import {
  CommandDispatchError,
  type CommandDispatchOptions,
  type CommandOf,
} from "../command-dispatch-support.js";
import { isFsErrorWithCode } from "../fs-errors.js";
import { userExecutableProcessOptions } from "../user-executable-env.js";
import {
  finalizeListedFiles,
  finalizeListedPaths,
  listWorkspacePaths,
} from "./file-list.js";
import {
  readFileForTransport,
  readFileFromGitRef,
  readFileMetadataForTransport,
  readRootRelativeFileForTransport,
  type ReadFileContentForTransportResult,
} from "./file-read.js";
import {
  isNetworkDriveReachable,
  listFilesystemRoots,
  readWindowsDriveTypes,
} from "./filesystem-roots.js";
import { resolveNonSymlinkDirectoryPath } from "./root-path.js";
import { folderActivity, isPrivacyFolder, searchFolders } from "./folder-search.js";

const SAFE_GIT_REF_REGEX = /^[A-Za-z0-9_./~^@-]+$/;

interface HostDiskPathCommand {
  path: string;
  rootPath?: string;
}

function assertSafeGitRef(ref: string): void {
  if (
    ref.length === 0 ||
    ref.startsWith("-") ||
    ref.includes("..") ||
    !SAFE_GIT_REF_REGEX.test(ref)
  ) {
    throw new CommandDispatchError("invalid_ref", `Invalid git ref: ${ref}`);
  }
}

// Agents often write Windows paths as `/C:/...` (file-URL style). On Windows
// that form never names a real file (`:` is invalid in names), so drop the slash.
export function normalizeWindowsDrivePath(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" && /^\/[A-Za-z]:[\\/]/u.test(filePath)
    ? filePath.slice(1)
    : filePath;
}

function assertAbsoluteHostDiskPathCommand(command: HostDiskPathCommand): void {
  if (!path.isAbsolute(command.path)) {
    throw new CommandDispatchError("invalid_path", "Path must be absolute");
  }

  const rootPath = command.rootPath;
  if (rootPath !== undefined && !path.isAbsolute(rootPath)) {
    throw new CommandDispatchError("invalid_path", "rootPath must be absolute");
  }
}

export async function listHostFiles(
  command: CommandOf<"host.list_files">,
): Promise<HostDaemonOnlineRpcResult<"host.list_files">> {
  if (!path.isAbsolute(command.path)) {
    throw new CommandDispatchError("invalid_path", "Path must be absolute");
  }

  try {
    const realRootPath = await resolveNonSymlinkDirectoryPath({
      description: "Path",
      path: command.path,
    });

    return finalizeListedFiles({
      filePaths: (
        await listWorkspacePaths({
          root: realRootPath,
          includeHidden: command.includeHidden,
          excludeNames: command.excludeNames,
          respectGitIgnore: command.respectGitIgnore,
          includeFiles: true,
          includeDirectories: false,
        })
      ).map((entry) => entry.path),
      limit: command.limit,
      ...(command.query ? { query: command.query } : {}),
    });
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) {
      return { files: [], truncated: false };
    }
    throw error;
  }
}

export async function listHostPaths(
  command: CommandOf<"host.list_paths">,
): Promise<HostDaemonOnlineRpcResult<"host.list_paths">> {
  if (!path.isAbsolute(command.path)) {
    throw new CommandDispatchError("invalid_path", "Path must be absolute");
  }

  try {
    const realRootPath = await resolveNonSymlinkDirectoryPath({
      description: "Path",
      path: command.path,
    });

    return finalizeListedPaths({
      paths: await listWorkspacePaths({
        root: realRootPath,
        includeFiles: command.includeFiles,
        includeDirectories: command.includeDirectories,
        includeHidden: command.includeHidden,
        excludeNames: command.excludeNames,
        respectGitIgnore: command.respectGitIgnore,
      }),
      limit: command.limit,
      includeFiles: command.includeFiles,
      includeDirectories: command.includeDirectories,
      ...(command.query ? { query: command.query } : {}),
    });
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) {
      return { paths: [], truncated: false };
    }
    throw error;
  }
}

const DIRECTORY_BROWSE_SKIP_NAMES = new Set(["node_modules"]);
/** Above this many folders a listing skips the per-folder activity probe. */
const ACTIVITY_PROBE_MAX_FOLDERS = 2_000;
const resolveBrowsedDirectory = promisify(resolveSymlinksPreservingDrive);

function compareDirectoryEntries(a: DirectoryEntry, b: DirectoryEntry): number {
  if (a.kind !== b.kind) {
    return a.kind === "directory" ? -1 : 1;
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

export async function browseHostDirectory(
  command: CommandOf<"host.browse_directory">,
): Promise<HostDaemonOnlineRpcResult<"host.browse_directory">> {
  const requestedPath = command.path ?? os.homedir();
  if (!path.isAbsolute(requestedPath)) {
    throw new CommandDispatchError("invalid_path", "Path must be absolute");
  }

  const driveTypes =
    process.platform === "win32" ? readWindowsDriveTypes() : null;
  const readDriveTypes = async () => (await driveTypes) ?? null;
  if (
    process.platform === "win32" &&
    !(await isNetworkDriveReachable(requestedPath, readDriveTypes))
  ) {
    throw new CommandDispatchError(
      "invalid_path",
      `The drive for "${requestedPath}" isn't responding`,
    );
  }
  const stat = await fs.stat(requestedPath);
  if (!stat.isDirectory()) {
    throw new CommandDispatchError(
      "invalid_path",
      `Path "${requestedPath}" is not a directory`,
    );
  }
  const directory =
    process.platform === "win32"
      ? await resolveBrowsedDirectory(requestedPath)
      : await fs.realpath(requestedPath);

  const parent = path.dirname(directory);
  const listing = async (entries: DirectoryEntry[]) => ({
    directory,
    parent: parent === directory ? null : parent,
    entries,
    roots: await listFilesystemRoots({ readDriveTypes }),
  });
  if (command.search !== undefined) {
    return listing(await searchFolders(directory, command.search));
  }

  const dirents = await fs.readdir(directory, { withFileTypes: true });
  const entries: DirectoryEntry[] = [];
  const links = new Set<string>();
  for (const dirent of dirents) {
    if (dirent.name.startsWith(".")) continue;
    if (DIRECTORY_BROWSE_SKIP_NAMES.has(dirent.name)) continue;

    const fullPath = path.join(directory, dirent.name);
    let kind: HostPathEntryKind;
    if (dirent.isSymbolicLink()) {
      try {
        kind = (await fs.stat(fullPath)).isDirectory() ? "directory" : "file";
      } catch {
        continue;
      }
      links.add(fullPath);
    } else if (dirent.isDirectory()) {
      kind = "directory";
    } else if (dirent.isFile()) {
      kind = "file";
    } else {
      continue;
    }

    entries.push({ kind, name: dirent.name, path: fullPath });
  }

  entries.sort(compareDirectoryEntries);
  // A link may point into a privacy-protected folder, so it gets no activity probe.
  const folders = entries.filter((entry) => entry.kind === "directory" && !links.has(entry.path));
  if (folders.length <= ACTIVITY_PROBE_MAX_FOLDERS) {
    await Promise.all(folders.map(async (folder) => {
      Object.assign(folder, await folderActivity(folder.path, !isPrivacyFolder(folder.path)));
    }));
  }
  return listing(entries);
}

export async function checkHostPathsExist(
  command: CommandOf<"host.paths_exist">,
): Promise<HostDaemonOnlineRpcResult<"host.paths_exist">> {
  const entries = await Promise.all(
    command.paths.map(async (path) => [path, await pathExists(path)] as const),
  );
  return { existence: Object.fromEntries(entries) };
}

export function readHostFile(
  command: CommandOf<"host.read_file"> & { ifNoneMatch?: undefined },
  options?: Pick<CommandDispatchOptions, "runtimeManager">,
): Promise<ReadFileContentForTransportResult>;
export function readHostFile(
  command: CommandOf<"host.read_file">,
  options?: Pick<CommandDispatchOptions, "runtimeManager">,
): Promise<HostDaemonOnlineRpcResult<"host.read_file">>;
export async function readHostFile(
  command: CommandOf<"host.read_file">,
  options?: Pick<CommandDispatchOptions, "runtimeManager">,
): Promise<HostDaemonOnlineRpcResult<"host.read_file">> {
  command = { ...command, path: normalizeWindowsDrivePath(command.path) };
  assertAbsoluteHostDiskPathCommand(command);

  if (command.ref !== undefined) {
    if (command.rootPath === undefined) {
      throw new CommandDispatchError(
        "invalid_path",
        "rootPath is required when ref is set",
      );
    }
    assertSafeGitRef(command.ref);
    return readFileFromGitRef({
      ...(command.ifNoneMatch !== undefined
        ? { ifNoneMatch: command.ifNoneMatch }
        : {}),
      rootPath: command.rootPath,
      resolvedPath: command.path,
      resultPath: command.path,
      ref: command.ref,
      ...userExecutableProcessOptions(
        options?.runtimeManager.getShellEnv() ?? {},
      ),
    });
  }

  return readFileForTransport({
    ...(command.ifNoneMatch !== undefined
      ? { ifNoneMatch: command.ifNoneMatch }
      : {}),
    resolvedPath: command.path,
    resultPath: command.path,
    ...(command.rootPath !== undefined ? { rootPath: command.rootPath } : {}),
  });
}

export async function readHostFileMetadata(
  command: CommandOf<"host.file_metadata">,
): Promise<HostDaemonOnlineRpcResult<"host.file_metadata">> {
  command = { ...command, path: normalizeWindowsDrivePath(command.path) };
  assertAbsoluteHostDiskPathCommand(command);
  return readFileMetadataForTransport({
    resolvedPath: command.path,
    resultPath: command.path,
    ...(command.rootPath !== undefined ? { rootPath: command.rootPath } : {}),
  });
}

export async function readHostRelativeFile(
  command: CommandOf<"host.read_file_relative">,
): Promise<HostDaemonOnlineRpcResult<"host.read_file_relative">> {
  return readRootRelativeFileForTransport({
    rootPath: command.rootPath,
    relativePath: command.path,
    dotfiles: command.dotfiles,
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.stat(normalizeWindowsDrivePath(path));
    return true;
  } catch (error) {
    if (
      isFsErrorWithCode(error, "ENOENT") ||
      isFsErrorWithCode(error, "ENOTDIR")
    ) {
      return false;
    }
    return true;
  }
}
