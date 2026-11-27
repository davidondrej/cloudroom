import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { access, mkdir, rm, stat } from "node:fs/promises";
import {
  gitShell,
  normalizeWindowsEnv,
  terminateWindowsProcessTrees,
} from "@cloudroom/process-utils";
import { UNAVAILABLE } from "./data.js";
import {
  AUTOMATION_SCRIPT_TIMEOUT_MAX_MS,
  type AutomationScriptInterpreter,
} from "./rpc-types.js";
import {
  resolveAutomationScriptPath,
  resolveDefaultInterpreter,
  scriptsRoot,
} from "./script-files.js";

const execFileAsync = promisify(execFile);
const SCRIPT_OUTPUT_MAX_BYTES = 1024 * 1024;
const SLEEP_GAP_MS = 5_000;

let resolvedRoomPath: string | null = null;

const ROOM_NOT_INJECTED_WARNING =
  "[Cloudroom] warning: could not locate the CLI, so `room-cli` is not on PATH for this script.";

async function commandWorks(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args, { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export function roomBinaryCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  const pushIfAbsolute = (candidate: string): void => {
    if (isAbsolute(candidate)) {
      candidates.push(candidate);
    }
  };
  const fromCli = env.ROOM_CLI?.trim();
  if (fromCli !== undefined && fromCli.length > 0) {
    pushIfAbsolute(fromCli);
  }
  const fromCliDir = env.BB_CLI_DIR?.trim();
  if (fromCliDir !== undefined && fromCliDir.length > 0) {
    pushIfAbsolute(join(fromCliDir, "room-cli"));
  }
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    const trimmed = entry.trim();
    if (trimmed.length > 0) {
      pushIfAbsolute(join(trimmed, "room-cli"));
    }
  }
  candidates.push("/opt/homebrew/bin/room-cli", "/usr/local/bin/room-cli");
  return candidates;
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const stats = await stat(candidate);
    if (!stats.isFile()) return false;
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveRoomBinary(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (resolvedRoomPath !== null) return resolvedRoomPath;
  for (const candidate of roomBinaryCandidates(env)) {
    if (!(await isExecutableFile(candidate))) continue;
    const works =
      process.platform === "win32"
        ? await commandWorks(process.execPath, [candidate, "--version"])
        : await commandWorks(candidate, ["--version"]);
    if (works) {
      resolvedRoomPath = candidate;
      return candidate;
    }
  }
  return null;
}

export function scriptPathEnv(
  roomPath: string | null,
  inheritedPath: string | undefined,
): string {
  const basePath = inheritedPath ?? "";
  if (roomPath === null || !isAbsolute(roomPath)) {
    return basePath;
  }
  const roomDir = dirname(roomPath);
  return basePath.length > 0 ? `${roomDir}${delimiter}${basePath}` : roomDir;
}

export function isWakeAgentSuppressed(output: string): boolean {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(last);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "wakeAgent" in parsed &&
      (parsed as { wakeAgent: unknown }).wakeAgent === false
    );
  } catch {
    return false;
  }
}

export interface ScriptRunResult {
  exitCode: number | null;
  output: string;
  stderr?: string;
  timedOut: boolean;
  /** A room-cli in the script got no answer from Cloudroom (#2656). */
  unavailable?: boolean;
}

const ANSI_ESCAPE =
  /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/gu;
const DECORATION_LINE = /^[~^=\-_*│|]+$/u;
const NODE_VERSION_LINE = /^Node\.js v\d+\.\d+/u;
const STACK_FRAME_LINE = /^\s+at\s+/u;
const ERROR_PROP_LINE = /^\s+[A-Za-z_]\w*:/u;
const ERROR_LINE_MAX = 200;
const NOISE_LINES = new Set([
  "[output truncated]",
  ROOM_NOT_INJECTED_WARNING,
]);

function lastMeaningfulLine(raw: string | undefined): string | null {
  if (!raw) return null;
  const lines = raw
    .replace(ANSI_ESCAPE, "")
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed.length > 0 &&
        !NOISE_LINES.has(trimmed) &&
        !DECORATION_LINE.test(trimmed)
      );
    });
  if (lines.length === 0) return null;
  let end = lines.length - 1;
  while (end > 0 && NODE_VERSION_LINE.test(lines[end]!.trim())) end -= 1;
  // Node.js prints trailing `{ errno, code, ... }` error properties after stack frames.
  if (end > 0 && lines[end]!.trim() === "}") {
    let probe = end - 1;
    while (probe > 0 && ERROR_PROP_LINE.test(lines[probe]!)) probe -= 1;
    if (STACK_FRAME_LINE.test(lines[probe]!)) end = probe;
  }
  const beforeFrames = end;
  while (end > 0 && STACK_FRAME_LINE.test(lines[end]!)) end -= 1;
  if (end === 0 && STACK_FRAME_LINE.test(lines[0]!)) end = beforeFrames;
  const text = lines[end]!.replace(/\s+/gu, " ").trim();
  if (!text) return null;
  return text.length > ERROR_LINE_MAX
    ? `${text.slice(0, ERROR_LINE_MAX - 1)}…`
    : text;
}

/** Last meaningful error line from a failed script: prefers stderr, falls back to combined output. */
export function scriptErrorLine(
  stderr: string | undefined,
  fallbackOutput?: string,
): string | null {
  return lastMeaningfulLine(stderr) ?? lastMeaningfulLine(fallbackOutput);
}

interface ScriptRunOutcome {
  status: "succeeded" | "failed" | "skipped";
  output: string | null;
  exitCode: number | null;
  error: string | null;
  skipReason: string | null;
}

export function mapScriptResultToRun(
  result: ScriptRunResult,
): ScriptRunOutcome {
  const unavailable = result.unavailable ? UNAVAILABLE : "";
  if (result.timedOut) {
    return {
      status: "failed",
      output: result.output.length > 0 ? result.output : null,
      exitCode: null,
      error: `${unavailable}Script timed out`,
      skipReason: null,
    };
  }
  if (result.exitCode !== 0) {
    const detail = scriptErrorLine(result.stderr, result.output);
    const error = detail
      ? `${unavailable}${detail}${result.exitCode !== null ? ` (exit ${result.exitCode})` : ""}`
      : `${unavailable}Script exited with code ${result.exitCode}`;
    return {
      status: "failed",
      output: result.output.length > 0 ? result.output : null,
      exitCode: result.exitCode,
      error,
      skipReason: null,
    };
  }
  if (result.output.trim().length === 0) {
    return {
      status: "skipped",
      output: null,
      exitCode: 0,
      error: null,
      skipReason: "empty output",
    };
  }
  if (isWakeAgentSuppressed(result.output)) {
    return {
      status: "skipped",
      output: null,
      exitCode: 0,
      error: null,
      skipReason: "wakeAgent false",
    };
  }
  return {
    status: "succeeded",
    output: result.output,
    exitCode: 0,
    error: null,
    skipReason: null,
  };
}

async function windowsProcessTree(pid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync(
      join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
      ],
      { timeout: 10_000, windowsHide: true },
    );
    const links = stdout
      .split(/\r?\n/u)
      .map((line) => line.trim().split(" ").map(Number));
    const tree = [pid];
    for (let index = 0; index < tree.length; index += 1) {
      for (const [childPid, parentPid] of links) {
        if (
          childPid !== undefined &&
          parentPid === tree[index] &&
          !tree.includes(childPid)
        ) {
          tree.push(childPid);
        }
      }
    }
    return tree;
  } catch {
    return [pid];
  }
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    const exited = child.exitCode !== null || child.signalCode !== null;
    void (
      exited
        ? Promise.resolve(true)
        : windowsProcessTree(child.pid).then((pids) =>
            terminateWindowsProcessTrees(pids),
          )
    ).then((ended) => {
      if (!ended) child.kill(signal);
      child.stdout?.destroy();
      child.stderr?.destroy();
    });
    return;
  }
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    try {
      child.kill(signal);
    } catch {}
  }
}

function executeWithProcessGroup(args: {
  command: string;
  scriptPath: string;
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}): Promise<ScriptRunResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    let outputLimitExceeded = false;
    let outputBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let forceKill: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout;
    const child = spawn(args.command, [args.scriptPath], {
      cwd: args.cwd,
      detached: process.platform !== "win32",
      env: args.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const terminateGroup = (): void => {
      signalProcessGroup(child, "SIGTERM");
      if (forceKill) return;
      forceKill = setTimeout(() => {
        signalProcessGroup(child, "SIGKILL");
      }, 1_000);
      forceKill.unref();
    };
    const capture = (target: Buffer[], chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = SCRIPT_OUTPUT_MAX_BYTES - outputBytes;
      if (remaining > 0) {
        const captured = buffer.subarray(0, remaining);
        target.push(captured);
        outputBytes += captured.byteLength;
      }
      if (buffer.byteLength > remaining && !outputLimitExceeded) {
        outputLimitExceeded = true;
        terminateGroup();
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => capture(stdoutChunks, chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture(stderrChunks, chunk));
    child.once("error", (error) => {
      capture(stderrChunks, `${error.message}\n`);
      terminateGroup();
    });
    child.once("close", (code) => {
      clearInterval(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (timedOut || outputLimitExceeded) {
        signalProcessGroup(child, "SIGKILL");
      }
      const suffix = outputLimitExceeded ? "\n[output truncated]\n" : "";
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      resolve({
        exitCode: timedOut ? null : outputLimitExceeded ? 1 : code,
        output: `${stdout}${stderr}${suffix}`,
        stderr,
        timedOut,
      });
    });
    // Count only awake time: with the lid closed a Mac wakes for a few seconds at a time, and a plain timer would
    // count the sleep in between and time the script out (2026-11-18). A tick gap over SLEEP_GAP_MS was sleep.
    let awakeMs = 0;
    let lastTick = Date.now();
    timeout = setInterval(
      () => {
        const now = Date.now();
        const gap = now - lastTick;
        lastTick = now;
        if (gap > 0 && gap <= SLEEP_GAP_MS) awakeMs += gap;
        if (awakeMs < args.timeoutMs) return;
        clearInterval(timeout);
        timedOut = true;
        terminateGroup();
      },
      Math.min(1_000, args.timeoutMs),
    );
    timeout.unref();
  });
}

export async function executeStoredScript(args: {
  pluginDataDir: string;
  automationId: string;
  runId: string;
  projectId: string;
  scriptFile: string;
  interpreter?: AutomationScriptInterpreter;
  timeoutMs: number;
  env?: Record<string, string>;
  serverUrl: string;
}): Promise<ScriptRunResult> {
  const scriptPath = await resolveAutomationScriptPath({
    dataDir: args.pluginDataDir,
    automationId: args.automationId,
    scriptFile: args.scriptFile,
  });
  const interpreter =
    args.interpreter ?? resolveDefaultInterpreter(args.scriptFile);
  const roomPath = await resolveRoomBinary();
  const warning = roomPath === null ? `${ROOM_NOT_INJECTED_WARNING}\n` : "";
  const unavailableDir = join(args.pluginDataDir, "unavailable");
  const unavailableFile = join(unavailableDir, args.runId);
  await mkdir(unavailableDir, { recursive: true });
  const scriptEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(args.env ?? {}),
    PATH: scriptPathEnv(roomPath, process.env.PATH),
    ROOM_SERVER_URL: args.serverUrl,
    ROOM_PROJECT_ID: args.projectId,
    BB_AUTOMATION_ID: args.automationId,
    BB_AUTOMATION_RUN_ID: args.runId,
    ROOM_LOOP_UNAVAILABLE_FILE: unavailableFile,
  };
  if (roomPath !== null) {
    scriptEnv.ROOM_CLI = roomPath;
  }
  const cwd = scriptsRoot(args.pluginDataDir);
  await mkdir(cwd, { recursive: true });
  const windowsShell =
    process.platform !== "win32"
      ? null
      : interpreter === "bash"
        ? await gitShell(scriptEnv).catch(() => null)
        : { command: interpreter, env: normalizeWindowsEnv(scriptEnv) };
  const result = await executeWithProcessGroup({
    command: windowsShell?.command ?? interpreter,
    scriptPath,
    cwd,
    timeoutMs: Math.min(args.timeoutMs, AUTOMATION_SCRIPT_TIMEOUT_MAX_MS),
    env: windowsShell?.env ?? scriptEnv,
  });
  const unavailable = await rm(unavailableFile).then(
    () => true,
    () => false,
  );
  return { ...result, output: `${warning}${result.output}`, unavailable };
}
