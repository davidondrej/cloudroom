import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  WorkspaceOpenTargetCapabilities,
  WorkspaceOpenTargetId,
} from "@cloudroom/host-daemon-contract";
import {
  execPortableFile,
  sanitizeInheritedChildProcessEnv,
} from "@cloudroom/process-utils";

type ErrorCode =
  | "path_not_found"
  | "path_not_openable"
  | "remote_mapping_missing"
  | "remote_target_unsupported"
  | "target_unavailable"
  | "unsupported_platform";

export class WorkspaceOpenTargetError extends Error {
  readonly code: ErrorCode;

  constructor(options: { code: ErrorCode; message: string }) {
    super(options.message);
    this.name = "WorkspaceOpenTargetError";
    this.code = options.code;
  }
}

export function fail(code: ErrorCode, message: string): never {
  throw new WorkspaceOpenTargetError({ code, message });
}

export interface ExecFileOptions {
  env?: NodeJS.ProcessEnv;
}

export interface WorkspaceOpenTargetRuntime {
  applicationDirectories: string[];
  desktopFileDirectories?: string[];
  env?: NodeJS.ProcessEnv;
  execFile: (
    file: string,
    args: string[],
    options?: ExecFileOptions,
  ) => Promise<{ stdout: string }>;
  platform: NodeJS.Platform;
}

export interface OpenPathInTargetArgs {
  columnNumber: number | null;
  context: { kind: "local" } | { kind: "remote-ssh"; sshAuthority: string };
  lineNumber: number | null;
  path: string;
  targetId: WorkspaceOpenTargetId;
}

export interface ListWorkspaceOpenTargetsOptions {
  path?: string;
}

export interface Invocation {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export interface ExistingPath {
  path: string;
  type: "directory" | "file";
}

export interface Location {
  columnNumber: number | null;
  lineNumber: number | null;
}

export interface SshRequest extends Location {
  path: string;
  sshAuthority: string;
}

export interface LocalTerminalRequest extends Location {
  editorCommand: string | null;
  path: string;
  pathType: ExistingPath["type"];
  shellPath: string;
}

const capabilities = (line: boolean, column: boolean) =>
  ({
    openDirectory: true,
    openFile: true,
    openFileAtColumn: column,
    openFileAtLine: line,
  }) satisfies WorkspaceOpenTargetCapabilities;

export const FULL = capabilities(true, true);
export const BASIC = capabilities(false, false);
export const LINE_ONLY = capabilities(true, false);

const execFileAsync = promisify(execFile);

async function defaultExecFile(
  file: string,
  args: string[],
  options?: ExecFileOptions,
): Promise<{ stdout: string }> {
  const env = sanitizeInheritedChildProcessEnv({
    env: options?.env ?? process.env,
  });
  if (process.platform === "win32") {
    const result = await execPortableFile(file, args, {
      cwd: os.homedir(),
      env,
    });
    return { stdout: result.stdout };
  }
  const result = await execFileAsync(file, args, { env });
  return { stdout: result.stdout };
}

export interface WorkspaceOpenTargetRuntimeOptions {
  shellPath?: string;
}

export function createWorkspaceOpenTargetRuntime(
  options: WorkspaceOpenTargetRuntimeOptions = {},
): WorkspaceOpenTargetRuntime {
  const home = os.homedir();
  return {
    applicationDirectories: [
      "/Applications",
      "/System/Applications",
      path.join(home, "Applications"),
    ],
    desktopFileDirectories: [
      "/usr/share/applications",
      "/usr/local/share/applications",
      path.join(home, ".local/share/applications"),
    ],
    env: {
      ...process.env,
      ...(options.shellPath !== undefined ? { PATH: options.shellPath } : {}),
    },
    execFile: defaultExecFile,
    platform: process.platform,
  };
}

export async function hasExecutable(
  executable: string,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<boolean> {
  try {
    await runtime.execFile(
      runtime.platform === "win32" ? "where.exe" : "which",
      [executable],
      { env: runtime.env },
    );
    return true;
  } catch {
    return false;
  }
}

export async function hasSystemExecutable(
  executable: string,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<boolean> {
  try {
    await runtime.execFile("which", [executable]);
    return true;
  } catch {
    return false;
  }
}

export function isWsl(runtime: WorkspaceOpenTargetRuntime): boolean {
  return (
    runtime.platform === "linux" &&
    (runtime.env?.WSL_DISTRO_NAME !== undefined ||
      runtime.env?.WSL_INTEROP !== undefined)
  );
}

export async function requireOpenablePath(
  targetPath: string,
): Promise<ExistingPath> {
  const stat = await fs.stat(targetPath).catch(() => null);
  if (!stat) {
    fail("path_not_found", `Open target path does not exist: ${targetPath}`);
  }
  if (stat.isDirectory()) return { path: targetPath, type: "directory" };
  if (stat.isFile()) return { path: targetPath, type: "file" };
  return fail(
    "path_not_openable",
    `Open target path must be a file or directory: ${targetPath}`,
  );
}

export async function launch(
  invocation: Invocation,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<void> {
  await runtime.execFile(invocation.file, invocation.args, {
    env: invocation.env,
  });
}
