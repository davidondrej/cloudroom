export * from "./cli-locations.js";
export * from "./event-loop-delay.js";
export * from "./plugin-process-paths.js";
export * from "./process-info.js";
export * from "./socket-type-of-service.js";
export * from "./windows.js";
import {
  execFile,
  type ChildProcess,
  type StdioOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { access, lstat, readdir, readlink, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import crossSpawn from "cross-spawn";
import { normalizeWindowsEnv } from "./windows.js";

interface PortableSpawnRequest {
  command: string;
  args: string[];
  cwd?: string;
  detached?: boolean;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
  timeout?: number;
  windowsHide?: boolean;
}

export type PortableChildProcess = ChildProcess;

interface PortablePipedSpawnRequest {
  command: string;
  args: string[];
  cwd?: string;
  detached?: boolean;
  env?: NodeJS.ProcessEnv;
}

interface PortablePipedChildProcess extends PortableChildProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
}

interface PortableOutputChildProcess extends PortableChildProcess {
  stdin: null;
  stdout: Readable;
  stderr: Readable;
}

interface KillProcessGroupArgs {
  child: {
    pid?: number | undefined;
    exitCode?: number | null;
    signalCode?: NodeJS.Signals | null;
    kill: (signal: NodeJS.Signals) => unknown;
  };
  signal: NodeJS.Signals;
}

interface StopProcessGroupLeaderFirstArgs {
  child: ChildProcess;
  timeoutMs: number;
  killGraceMs: number;
}

interface ProcessWithCwd {
  pid: number;
  cwd: string;
}

interface ListProcessesWithCwdUnderArgs {
  directory: string;
}

interface KillProcessesWithCwdUnderArgs {
  directory: string;
  graceMs?: number;
}

interface ResolveContainedPathArgs {
  rootPath: string;
  candidatePath: string;
}

export interface SanitizeInheritedChildProcessEnvArgs {
  env: NodeJS.ProcessEnv;
  shellPath?: string;
}

type SafeProcessDiagnosticKind = "startupFailure" | "uncaughtException";

interface SafeProcessDiagnosticsOptions {
  logsDir: string;
  processName: string;
}

interface WriteSafeProcessDiagnosticReportArgs extends SafeProcessDiagnosticsOptions {
  kind: SafeProcessDiagnosticKind;
  error: unknown;
  now?: () => Date;
  createReportId?: () => string;
}

const MAX_DIAGNOSTIC_ERROR_CAUSE_DEPTH = 8;
const MAX_DIAGNOSTIC_AGGREGATE_ERRORS = 8;

interface SafeProcessDiagnosticError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  cause?: SafeProcessDiagnosticError;
  errors?: SafeProcessDiagnosticError[];
  errorsTruncated?: number;
  truncationReason?: "cycle" | "depth";
}

interface SafeProcessDiagnosticReport {
  diagnosticVersion: 1;
  kind: SafeProcessDiagnosticKind;
  processName: string;
  occurredAt: string;
  pid: number;
  runtime: {
    nodeVersion: string;
    platform: NodeJS.Platform;
    arch: string;
    execPath: string;
  };
  error: SafeProcessDiagnosticError;
}

type UncaughtExceptionMonitorHandler = (
  error: Error,
  origin: NodeJS.UncaughtExceptionOrigin,
) => void;

export function spawnPortableProcess(
  request: PortableSpawnRequest,
): PortableChildProcess {
  // Node's own timeout ends only the direct child, which for an npm `.cmd`
  // shim is cmd.exe; on Windows the whole tree ends first instead.
  const treeTimeout =
    process.platform === "win32" ? request.timeout : undefined;
  const child = crossSpawn(request.command, request.args, {
    cwd: request.cwd,
    detached: request.detached,
    env: request.env && normalizeWindowsEnv(request.env),
    stdio: request.stdio,
    timeout: treeTimeout === undefined ? request.timeout : undefined,
    windowsHide: request.windowsHide,
  });
  if (treeTimeout !== undefined) {
    const timer = setTimeout(
      () => killPortableProcess(child, "SIGTERM"),
      treeTimeout,
    );
    child.once("exit", () => clearTimeout(timer));
  }
  return child;
}

function assertPortablePipedProcess(
  child: PortableChildProcess,
): asserts child is PortablePipedChildProcess {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Portable child process did not attach piped stdio");
  }
}

function assertPortableOutputProcess(
  child: PortableChildProcess,
): asserts child is PortableOutputChildProcess {
  if (child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Portable child process did not attach output-only stdio");
  }
}

export function spawnPortablePipedProcess(
  request: PortablePipedSpawnRequest,
): PortablePipedChildProcess {
  const child = spawnPortableProcess({
    ...request,
    stdio: ["pipe", "pipe", "pipe"],
  });
  assertPortablePipedProcess(child);
  return child;
}

export function spawnPortableOutputProcess(
  request: PortablePipedSpawnRequest,
): PortableOutputChildProcess {
  const child = spawnPortableProcess({
    ...request,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  assertPortableOutputProcess(child);
  return child;
}

export function supportsProcessGroups(): boolean {
  return process.platform !== "win32";
}

export function killProcessGroup(args: KillProcessGroupArgs): void {
  if (process.platform === "win32") {
    // Windows has no process groups: end the tree first, then the root. Never
    // after the root exited: Windows may have given its PID to another process.
    const exited =
      (args.child.exitCode ?? null) !== null ||
      (args.child.signalCode ?? null) !== null;
    if (args.child.pid === undefined || exited) return;
    void terminateWindowsProcessTrees([args.child.pid]).finally(() => {
      args.child.kill(args.signal);
    });
    return;
  }
  if (supportsProcessGroups() && args.child.pid !== undefined) {
    try {
      process.kill(-args.child.pid, args.signal);
      return;
    } catch {}
  }
  args.child.kill(args.signal);
}

export async function killPortableProcess(
  child: ChildProcess,
  signal: NodeJS.Signals,
): Promise<ProcessStopResult> {
  if (process.platform === "win32") return stopWindowsProcessTree(child);
  child.kill(signal);
  return { treeTermination: "unverified" };
}

export function isProcessGroupAlive(child: {
  pid?: number | undefined;
}): boolean {
  if (!supportsProcessGroups() || child.pid === undefined) {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

// Windows helpers, hand-ported from get-bb/bb#4610, #4658 and #5429 (MIT).

export interface ProcessStopResult {
  treeTermination: "confirmed" | "unverified";
}

const WINDOWS_TREE_KILL_TIMEOUT_MS = 2_000;
const WINDOWS_ROOT_EXIT_TIMEOUT_MS = 1_000;

/** Ends each process and all its descendants with `taskkill /T /F`. */
export function terminateWindowsProcessTrees(
  pids: readonly number[],
): Promise<boolean> {
  if (pids.length === 0) return Promise.resolve(true);
  return new Promise((resolveTerminated) => {
    let settled = false;
    const finish = (terminated: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveTerminated(terminated);
    };
    const killer = execFile(
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      [...pids.flatMap((pid) => ["/pid", String(pid)]), "/T", "/F"],
      { windowsHide: true },
      (error) => finish(error === null),
    );
    const timer = setTimeout(() => {
      finish(false);
      killer.kill("SIGKILL");
    }, WINDOWS_TREE_KILL_TIMEOUT_MS);
  });
}

/**
 * Ends a child's whole tree, then the child itself. The tree goes first:
 * once the root is gone, taskkill can no longer find its descendants. Skips a
 * root that already exited, whose PID Windows may have reused. "confirmed"
 * only when taskkill succeeded and the root is seen to exit.
 */
async function stopWindowsProcessTree(
  child: ChildProcess,
): Promise<ProcessStopResult> {
  if (child.pid === undefined || hasChildExited(child)) {
    return { treeTermination: "unverified" };
  }
  const treeEnded = await terminateWindowsProcessTrees([child.pid]);
  if (!hasChildExited(child)) child.kill("SIGKILL");
  const rootExited =
    hasChildExited(child) ||
    (await new Promise<boolean>((resolveExit) => {
      const timer = setTimeout(
        () => resolveExit(false),
        WINDOWS_ROOT_EXIT_TIMEOUT_MS,
      );
      child.once("exit", () => {
        clearTimeout(timer);
        resolveExit(true);
      });
    }));
  return {
    treeTermination: treeEnded && rootExited ? "confirmed" : "unverified",
  };
}

/** Errors from writing to a child whose stdin closed. Windows reports EOF. */
const CLOSED_PIPE_ERROR_CODES = new Set([
  "EPIPE",
  "ERR_STREAM_DESTROYED",
  ...(process.platform === "win32" ? ["EOF"] : []),
]);

export function isClosedPipeError(error: Error): boolean {
  return (
    "code" in error &&
    typeof error.code === "string" &&
    CLOSED_PIPE_ERROR_CODES.has(error.code)
  );
}

/** Windows' own bsdtar. Git for Windows' GNU tar may come first on PATH, and it reads `C:\…` as a remote host. */
export function tarCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe`
    : "tar";
}

/**
 * Git for Windows' shell (`findGitShellPath`), with its own tools
 * (mkdir, cp, mktemp) on PATH: they sit next to it, outside the Windows PATH.
 */
export async function gitShell(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ command: string; env: NodeJS.ProcessEnv }> {
  const command = await findGitShellPath(env);
  if (command === null) {
    throw new Error(
      "Cloudroom needs Git for Windows 2.0 or later, and it could not find Git's shell.",
    );
  }
  return {
    command,
    env: normalizeWindowsEnv({
      ...env,
      PATH: `${win32.dirname(command)};${env.PATH ?? ""}`,
    }),
  };
}

/** A path as Git for Windows' shell prints it (`/c/Users/…`), as Windows reads it. */
export const msysPathToWindows = (path: string): string =>
  path.replace(/^\/([a-z])\//i, "$1:/");

/** The command that opens a folder in this OS's file manager. */
export function folderOpenerCommand(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "darwin") return "open";
  return platform === "win32" ? "explorer.exe" : "xdg-open";
}

/**
 * Runs a command to completion and returns its output. Unlike `execFile`, it
 * runs npm `.cmd` shims on Windows. Rejects on a non-zero exit or timeout;
 * like `execFile`, a non-zero exit's error carries `stdout` and `stderr`.
 */
export function execPortableFile(
  command: string,
  args: readonly string[],
  options: {
    timeoutMs?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    /** Bytes per stream, as `execFile`'s option; unlimited when unset. */
    maxBuffer?: number;
  },
): Promise<{ stdout: string; stderr: string }> {
  if (process.platform !== "win32") {
    try {
      return promisify(execFile)(command, [...args], {
        cwd: options.cwd,
        encoding: "utf8",
        env: options.env,
        signal: options.signal,
        ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return new Promise((resolveOutput, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason);
      return;
    }
    const child = spawnPortableOutputProcess({
      command,
      args: [...args],
      cwd: options.cwd,
      env: options.env,
    });
    let stdout = "";
    let stderr = "";
    const bytes = { stdout: 0, stderr: 0 };
    const stop = (error: unknown): void => {
      killPortableProcess(child, "SIGKILL");
      reject(error);
    };
    const read = (name: "stdout" | "stderr") => (chunk: string) => {
      bytes[name] += Buffer.byteLength(chunk);
      if (options.maxBuffer !== undefined && bytes[name] > options.maxBuffer) {
        settle();
        stop(
          Object.assign(new RangeError(`${name} maxBuffer length exceeded`), {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          }),
        );
        return;
      }
      if (name === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding("utf8").on("data", read("stdout"));
    child.stderr.setEncoding("utf8").on("data", read("stderr"));
    const onAbort = (): void => stop(options.signal?.reason);
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            stop(
              new Error(`${command} timed out after ${options.timeoutMs}ms`),
            );
          }, options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const settle = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", (error) => {
      settle();
      reject(error);
    });
    child.once("close", (code) => {
      settle();
      if (code === 0) {
        resolveOutput({ stdout, stderr });
        return;
      }
      reject(
        Object.assign(
          new Error(`${command} exited with code ${String(code)}`),
          { code, stdout, stderr },
        ),
      );
    });
  });
}

const PROCESS_GROUP_EXIT_POLL_MS = 100;

export function stopProcessGroupLeaderFirst(
  args: StopProcessGroupLeaderFirstArgs,
): Promise<ProcessStopResult> {
  const { child, timeoutMs, killGraceMs } = args;
  if (process.platform === "win32") return stopWindowsProcessTree(child);
  if (hasChildExited(child) && !isProcessGroupAlive(child)) {
    return Promise.resolve({ treeTermination: "confirmed" });
  }
  return new Promise<ProcessStopResult>((resolveStop) => {
    let settled = false;
    let hardTimer: NodeJS.Timeout | undefined;
    let poll: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(softTimer);
      if (hardTimer !== undefined) {
        clearTimeout(hardTimer);
      }
      if (poll !== undefined) {
        clearInterval(poll);
      }
      resolveStop({
        treeTermination: groupGone() ? "confirmed" : "unverified",
      });
    };
    const groupGone = (): boolean =>
      hasChildExited(child) && !isProcessGroupAlive(child);
    const softTimer = setTimeout(() => {
      if (groupGone()) {
        finish();
        return;
      }
      killProcessGroup({ child, signal: "SIGKILL" });
      if (killGraceMs <= 0) {
        finish();
        return;
      }
      hardTimer = setTimeout(finish, killGraceMs);
    }, timeoutMs);

    const stopSurvivingMembers = (): void => {
      if (!isProcessGroupAlive(child)) {
        finish();
        return;
      }
      killProcessGroup({ child, signal: "SIGTERM" });
      poll = setInterval(() => {
        if (!isProcessGroupAlive(child)) {
          finish();
        }
      }, PROCESS_GROUP_EXIT_POLL_MS);
    };

    if (hasChildExited(child)) {
      stopSurvivingMembers();
      return;
    }
    child.once("exit", stopSurvivingMembers);
    child.kill("SIGTERM");
  });
}

function isPathUnderDirectory(candidate: string, directory: string): boolean {
  const normalized = candidate.endsWith(" (deleted)")
    ? candidate.slice(0, -" (deleted)".length)
    : candidate;
  return (
    normalized === directory || normalized.startsWith(`${directory}${sep}`)
  );
}

async function listLinuxProcessCwds(): Promise<ProcessWithCwd[]> {
  const entries = await readdir("/proc");
  const results: ProcessWithCwd[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      if (!/^\d+$/.test(entry)) {
        return;
      }
      try {
        const cwd = await readlink(`/proc/${entry}/cwd`);
        results.push({ pid: Number(entry), cwd });
      } catch {}
    }),
  );
  return results;
}

async function listLsofProcessCwds(): Promise<ProcessWithCwd[]> {
  const child = spawnPortableOutputProcess({
    command: "lsof",
    args: ["-a", "-d", "cwd", "-F", "pn", "-w", "-n"],
  });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  child.stderr.resume();
  await new Promise<void>((resolveExit) => {
    child.once("error", () => resolveExit());
    child.once("exit", () => resolveExit());
  });
  const results: ProcessWithCwd[] = [];
  let pid: number | null = null;
  for (const line of Buffer.concat(chunks).toString("utf8").split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
    } else if (line.startsWith("n") && pid !== null) {
      results.push({ pid, cwd: line.slice(1) });
    }
  }
  return results;
}

async function resolveSweepDirectory(
  directory: string,
): Promise<string | null> {
  const resolved = resolve(directory);
  let parent = dirname(resolved);
  try {
    parent = await realpath(parent);
  } catch {}
  const canonical = join(parent, basename(resolved));
  try {
    if ((await lstat(canonical)).isSymbolicLink()) {
      return null;
    }
  } catch {}
  return canonical;
}

export async function findGitShellPath(
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<string | null> {
  const git = (args: string[]): Promise<string | null> =>
    execPortableFile("git", args, { env, signal, timeoutMs: 10_000 }).then(
      (result) => win32.normalize(result.stdout.trim() || "."),
      () => null,
    );
  const isDrivePath = (path: string | null): path is string =>
    path !== null && /^[A-Za-z]:\\/u.test(path);
  const reported = await git(["var", "GIT_SHELL_PATH"]);
  if (isDrivePath(reported) && existsSync(reported)) return reported;
  const execPath = await git(["--exec-path"]);
  if (!isDrivePath(execPath)) return null;
  const sh = win32.join(execPath, "..", "..", "..", "usr", "bin", "sh.exe");
  return existsSync(sh) ? sh : null;
}

export async function listProcessesWithCwdUnder(
  args: ListProcessesWithCwdUnderArgs,
): Promise<ProcessWithCwd[]> {
  if (process.platform === "win32") {
    return [];
  }
  const directory = await resolveSweepDirectory(args.directory);
  if (directory === null) {
    return [];
  }
  const all =
    process.platform === "linux"
      ? await listLinuxProcessCwds()
      : await listLsofProcessCwds();
  return all.filter(
    (entry) =>
      entry.pid !== process.pid && isPathUnderDirectory(entry.cwd, directory),
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

const MAX_CWD_SWEEP_ROUNDS = 5;

function signalProcesses(
  targets: ProcessWithCwd[],
  signal: NodeJS.Signals,
  signalled: Map<number, ProcessWithCwd>,
): void {
  for (const target of targets) {
    try {
      process.kill(target.pid, signal);
      signalled.set(target.pid, target);
    } catch {}
  }
}

export async function killProcessesWithCwdUnder(
  args: KillProcessesWithCwdUnderArgs,
): Promise<ProcessWithCwd[]> {
  const graceMs = args.graceMs ?? 2000;
  const signalled = new Map<number, ProcessWithCwd>();
  for (let round = 0; round < MAX_CWD_SWEEP_ROUNDS; round += 1) {
    const targets = await listProcessesWithCwdUnder({
      directory: args.directory,
    });
    if (targets.length === 0) {
      break;
    }
    signalProcesses(targets, "SIGTERM", signalled);
    const deadline = Date.now() + graceMs;
    while (
      Date.now() < deadline &&
      targets.some((target) => isProcessAlive(target.pid))
    ) {
      await delay(50);
    }
    const survivors = await listProcessesWithCwdUnder({
      directory: args.directory,
    });
    if (survivors.length === 0) {
      break;
    }
    signalProcesses(survivors, "SIGKILL", signalled);
    await delay(50);
  }
  return Array.from(signalled.values());
}

export function resolveContainedPath(
  args: ResolveContainedPathArgs,
): string | null {
  const resolvedRootPath = resolve(args.rootPath);
  const resolvedCandidatePath = resolve(args.candidatePath);
  const relativePath = relative(resolvedRootPath, resolvedCandidatePath);

  if (relativePath === "") {
    return null;
  }

  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null;
  }

  return resolvedCandidatePath;
}

export function isPathWithinDirectory(
  directoryPath: string,
  candidatePath: string,
): boolean {
  const relativePath = relative(directoryPath, candidatePath);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function sanitizeInheritedChildProcessEnv(
  args: SanitizeInheritedChildProcessEnvArgs,
): NodeJS.ProcessEnv {
  const sanitizedEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(args.env)) {
    if (value === undefined) {
      continue;
    }
    if (
      key === "NODE_ENV" ||
      key.startsWith("BB_") ||
      key.startsWith("ROOM_")
    ) {
      continue;
    }
    sanitizedEnv[key] = value;
  }
  if (args.shellPath !== undefined) {
    sanitizedEnv.PATH = args.shellPath;
  }
  return sanitizedEnv;
}

const NPM_SCRIPT_POLICY_ENV_KEYS: ReadonlySet<string> = new Set([
  "npm_config_allow_scripts",
  "npm_config_ignore_scripts",
  "npm_config_foreground_scripts",
]);

export function omitNpmScriptPolicyEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (NPM_SCRIPT_POLICY_ENV_KEYS.has(key.toLowerCase())) continue;
    childEnv[key] = value;
  }
  return childEnv;
}

function createCurrentDiagnosticDate(): Date {
  return new Date();
}

function sanitizeDiagnosticFilenamePart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return sanitized.length > 0 ? sanitized : "process";
}

function formatDiagnosticTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function createTruncatedDiagnosticError(
  truncationReason: "cycle" | "depth",
): SafeProcessDiagnosticError {
  return {
    name: "TruncatedErrorCause",
    message:
      truncationReason === "cycle"
        ? "Error cause serialization stopped because the cause chain contains a cycle"
        : `Error cause serialization stopped at the maximum depth of ${MAX_DIAGNOSTIC_ERROR_CAUSE_DEPTH}`,
    truncationReason,
  };
}

function serializeDiagnosticError(
  error: unknown,
  seenErrors: Set<Error> = new Set(),
  depth = 0,
): SafeProcessDiagnosticError {
  if (error instanceof Error) {
    if (seenErrors.has(error)) {
      return createTruncatedDiagnosticError("cycle");
    }
    if (depth >= MAX_DIAGNOSTIC_ERROR_CAUSE_DEPTH) {
      return createTruncatedDiagnosticError("depth");
    }
    seenErrors.add(error);

    const serialized: SafeProcessDiagnosticError = {
      name: error.name,
      message: error.message,
    };
    if (error.stack !== undefined) {
      serialized.stack = error.stack;
    }
    if ("code" in error && typeof error.code === "string") {
      serialized.code = error.code;
    }
    if (error.cause !== undefined) {
      serialized.cause = serializeDiagnosticError(
        error.cause,
        seenErrors,
        depth + 1,
      );
    }
    if (error instanceof AggregateError) {
      const aggregateErrors = error.errors.slice(
        0,
        MAX_DIAGNOSTIC_AGGREGATE_ERRORS,
      );
      serialized.errors = aggregateErrors.map((aggregateError) =>
        serializeDiagnosticError(aggregateError, seenErrors, depth + 1),
      );
      const errorsTruncated = error.errors.length - aggregateErrors.length;
      if (errorsTruncated > 0) {
        serialized.errorsTruncated = errorsTruncated;
      }
    }
    seenErrors.delete(error);
    return serialized;
  }

  return {
    name: "NonError",
    message: String(error),
  };
}

export function writeSafeProcessDiagnosticReport(
  args: WriteSafeProcessDiagnosticReportArgs,
): string {
  mkdirSync(args.logsDir, { recursive: true });
  const occurredAt = (args.now ?? createCurrentDiagnosticDate)();
  const reportId = sanitizeDiagnosticFilenamePart(
    (args.createReportId ?? randomUUID)(),
  );
  const processName = sanitizeDiagnosticFilenamePart(args.processName);
  const reportPath = join(
    args.logsDir,
    `process-${processName}-${args.kind}-${formatDiagnosticTimestamp(
      occurredAt,
    )}-${reportId}.json`,
  );
  const report: SafeProcessDiagnosticReport = {
    diagnosticVersion: 1,
    kind: args.kind,
    processName: args.processName,
    occurredAt: occurredAt.toISOString(),
    pid: process.pid,
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      execPath: process.execPath,
    },
    error: serializeDiagnosticError(args.error),
  };

  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
  });
  return reportPath;
}

export function installSafeProcessDiagnostics(
  options: SafeProcessDiagnosticsOptions,
): () => void {
  mkdirSync(options.logsDir, { recursive: true });
  const handleUncaughtExceptionMonitor: UncaughtExceptionMonitorHandler = (
    error,
  ) => {
    try {
      writeSafeProcessDiagnosticReport({
        ...options,
        kind: "uncaughtException",
        error,
      });
    } catch {}
  };

  process.on("uncaughtExceptionMonitor", handleUncaughtExceptionMonitor);

  return () => {
    process.off("uncaughtExceptionMonitor", handleUncaughtExceptionMonitor);
  };
}
