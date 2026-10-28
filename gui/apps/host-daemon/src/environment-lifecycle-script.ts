import { StringDecoder } from "node:string_decoder";
import {
  DEFAULT_ENV_SETUP_SCRIPT_NAME,
  DEFAULT_ENV_TEARDOWN_SCRIPT_NAME,
} from "@cloudroom/domain";
import { operationEnvironment } from "./operation-environment.js";
import type { HostDaemonContributedEnvEntry } from "@cloudroom/host-daemon-contract";
import {
  findGitShellPath,
  isProcessGroupAlive,
  killProcessGroup,
  spawnPortableOutputProcess,
  supportsProcessGroups,
  normalizeWindowsEnv,
  type ProcessStopResult,
} from "@cloudroom/process-utils";
import {
  findGitBashProcessGroup,
  stopGitBashProcessGroup,
} from "./git-bash-process-group.js";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { WorkspaceError } from "bb-environment-provider-host/git";
import { createTerminalOutputLineReader } from "bb-environment-provider-host/terminal-output";
import {
  createProvisionCancelledError,
  emitOutput,
  emitStep,
  throwIfProvisionAborted,
  type ProgressCallback,
} from "bb-environment-provider-host/transcript";

export interface RunSetupScriptArgs {
  workspacePath: string;
  timeoutMs: number;
  shellPath?: string;
  env?: NodeJS.ProcessEnv;
  contributedEnv?: readonly HostDaemonContributedEnvEntry[];
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
}

type RunTeardownScriptArgs = RunSetupScriptArgs;

interface LifecycleScriptCommand {
  command: string;
  args: string[];
  text: string;
  pathPrefix: string[];
}

interface BuildLifecycleScriptCommandArgs {
  kind: "setup" | "teardown";
  scriptName: string;
  platform: NodeJS.Platform;
  scriptPath: string;
  windowsBashPath: string | null;
}

interface RunLifecycleScriptArgs extends RunSetupScriptArgs {
  kind: "setup" | "teardown";
  scriptName: string;
}

export function buildLifecycleScriptCommand(
  args: BuildLifecycleScriptCommandArgs,
): LifecycleScriptCommand {
  if (args.platform === "win32") {
    if (args.windowsBashPath === null) {
      throw new WorkspaceError(
        "setup_script_failed",
        `${args.scriptName} needs Git for Windows 2.0 or later: Cloudroom runs ${args.kind} scripts with the bash that Git installs, and it could not find one.`,
      );
    }
    return {
      command: args.windowsBashPath,
      args: [args.scriptPath],
      text: `bash ${args.scriptName}`,
      pathPrefix: [path.win32.dirname(args.windowsBashPath)],
    };
  }

  return {
    command: "env",
    args: ["bash", args.scriptPath],
    text: `env bash ${args.scriptName}`,
    pathPrefix: [],
  };
}

/**
 * Puts `entries` first on PATH, leaving a single `PATH` key. On Windows the
 * env can hold both `Path` and `PATH`, and the child only sees the one that
 * sorts first, so prefixing just one of them can be silently lost.
 */
export function prependPathEntries(
  env: NodeJS.ProcessEnv,
  entries: readonly string[],
): NodeJS.ProcessEnv {
  // Only called for Windows hooks, so always merge Path/PATH.
  const base = normalizeWindowsEnv(env, "win32");
  return {
    ...base,
    PATH: [...entries, ...(base.PATH ? [base.PATH] : [])].join(path.delimiter),
  };
}

export class LifecycleScriptTerminationUnverifiedError extends Error {
  constructor(
    scriptName: string,
    message = `${scriptName} was stopped, but Cloudroom could not confirm that all of its processes exited`,
  ) {
    super(message);
    this.name = "LifecycleScriptTerminationUnverifiedError";
  }
}

// Workspaces where a hook's stop couldn't be confirmed. Its processes may still
// run there, so no setup or teardown hook starts again in that workspace until
// the daemon restarts. Shared by the hook RPC and environment.attach.
const unverifiedHookWorkspaces = new Set<string>();

function hookWorkspaceKey(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function markHookStopUnverified(workspacePath: string): void {
  unverifiedHookWorkspaces.add(hookWorkspaceKey(workspacePath));
}

export function clearUnverifiedHookStops(): void {
  unverifiedHookWorkspaces.clear();
}

export async function assertScriptProcessTreeStopped(
  stop: Promise<ProcessStopResult> | undefined,
  scriptName: string,
): Promise<void> {
  if (stop === undefined) {
    return;
  }
  const result = await stop.catch(() => null);
  if (result === null || result.treeTermination !== "confirmed") {
    throw new LifecycleScriptTerminationUnverifiedError(scriptName);
  }
}

const WINDOWS_OUTPUT_CLOSE_GRACE_MS = 2_000;

export async function resolveWindowsBashPath(
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string | null> {
  const gitShellPath = await findGitShellPath(env, signal);
  if (gitShellPath === null) {
    return null;
  }
  const bashPath = path.win32.join(
    path.win32.dirname(gitShellPath),
    "bash.exe",
  );
  try {
    await fs.access(bashPath);
    return bashPath;
  } catch {
    return gitShellPath;
  }
}

async function resolveLifecycleScriptPath(
  workspacePath: string,
  scriptName: string,
): Promise<string | null> {
  const scriptPath = path.join(workspacePath, scriptName);
  try {
    await fs.access(scriptPath);
  } catch {
    return null;
  }
  return scriptPath;
}

async function runLifecycleScript(
  args: RunLifecycleScriptArgs,
): Promise<{ ran: boolean }> {
  throwIfProvisionAborted(args.signal);
  if (unverifiedHookWorkspaces.has(hookWorkspaceKey(args.workspacePath))) {
    throw new LifecycleScriptTerminationUnverifiedError(
      args.scriptName,
      `${args.scriptName} was not started: processes from an earlier hook in this workspace may still be running. Restart Cloudroom to try again.`,
    );
  }
  try {
    return await runLifecycleScriptOnce(args);
  } catch (error) {
    if (error instanceof LifecycleScriptTerminationUnverifiedError) {
      markHookStopUnverified(args.workspacePath);
    }
    throw error;
  }
}

async function runLifecycleScriptOnce(
  args: RunLifecycleScriptArgs,
): Promise<{ ran: boolean }> {
  const scriptPath = await resolveLifecycleScriptPath(
    args.workspacePath,
    args.scriptName,
  );
  if (!scriptPath) {
    return { ran: false };
  }

  throwIfProvisionAborted(args.signal);
  const { timeoutMs } = args;
  const env = operationEnvironment(
    args.contributedEnv ?? [],
    {
      ...(args.env ?? process.env),
      ...(args.shellPath !== undefined ? { PATH: args.shellPath } : {}),
    },
    true,
  );
  const windowsBashPath =
    process.platform === "win32"
      ? await resolveWindowsBashPath(env, args.signal)
      : null;
  throwIfProvisionAborted(args.signal);
  const command = buildLifecycleScriptCommand({
    kind: args.kind,
    scriptName: args.scriptName,
    platform: process.platform,
    scriptPath,
    windowsBashPath,
  });
  const startedAt = Date.now();
  emitStep({
    onProgress: args.onProgress,
    key: `${args.kind}-started`,
    text: `Running ${args.scriptName}`,
    status: "started",
    startedAt,
  });

  const scriptEnv =
    command.pathPrefix.length === 0
      ? env
      : prependPathEntries(env, command.pathPrefix);
  const child = spawnPortableOutputProcess({
    command: command.command,
    args: command.args,
    cwd: args.workspacePath,
    detached: supportsProcessGroups(),
    env: scriptEnv,
  });
  const gitBash =
    windowsBashPath === null
      ? null
      : { bashPath: windowsBashPath, child, env: scriptEnv };
  const gitBashProcessGroup =
    gitBash === null ? null : findGitBashProcessGroup(gitBash);

  const outputLineReader = createTerminalOutputLineReader();
  let outputIndex = 0;
  let abortRequested = false;
  let timedOut = false;

  const emitScriptOutputLines = (lines: string[]): void => {
    for (const line of lines) {
      outputIndex += 1;
      emitOutput(args.onProgress, `${args.kind}-output-${outputIndex}`, line);
    }
  };

  const readers = [child.stdout, child.stderr].map((stream) => {
    const decoder = new StringDecoder("utf8");
    const emit = (text: string) => {
      emitScriptOutputLines(outputLineReader.push(text));
    };
    stream.on("data", (chunk: Buffer) => emit(decoder.write(chunk)));
    return () => emit(decoder.end());
  });

  let windowsTreeStop: Promise<ProcessStopResult> | undefined;
  let reportOutputLeftOpen: (() => void) | undefined;
  const outputLeftOpen = new Promise<null>((resolve) => {
    reportOutputLeftOpen = () => resolve(null);
  });
  const killScriptProcesses = (): void => {
    if (gitBash === null || gitBashProcessGroup === null) {
      killProcessGroup({ child, signal: "SIGKILL" });
      return;
    }
    if (windowsTreeStop !== undefined) {
      return;
    }
    windowsTreeStop = stopGitBashProcessGroup({
      ...gitBash,
      processGroup: gitBashProcessGroup,
    });
    windowsTreeStop
      .catch(() => undefined)
      .then(() => delay(WINDOWS_OUTPUT_CLOSE_GRACE_MS))
      .then(reportOutputLeftOpen, reportOutputLeftOpen);
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    killScriptProcesses();
  }, timeoutMs);
  const abortLifecycleScript = () => {
    if (abortRequested) {
      return;
    }
    abortRequested = true;
    killScriptProcesses();
  };
  args.signal?.addEventListener("abort", abortLifecycleScript, {
    once: true,
  });
  if (args.signal?.aborted) {
    abortLifecycleScript();
  }

  try {
    const closed = new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    const result = await Promise.race([closed, outputLeftOpen]);
    if (result === null) {
      child.stdout.destroy();
      child.stderr.destroy();
      throw new LifecycleScriptTerminationUnverifiedError(args.scriptName);
    }

    if (abortRequested || timedOut) {
      while (isProcessGroupAlive(child)) await delay(25);
      await assertScriptProcessTreeStopped(windowsTreeStop, args.scriptName);
    }

    for (const flush of readers) flush();
    emitScriptOutputLines(outputLineReader.flush());
    const durationMs = Date.now() - startedAt;
    if (abortRequested || args.signal?.aborted) {
      emitStep({
        onProgress: args.onProgress,
        key: `${args.kind}-cancelled`,
        text: `${args.scriptName} cancelled`,
        status: "failed",
        startedAt,
        metadata: { durationMs },
      });
      throw createProvisionCancelledError(args.signal?.reason);
    }

    const failScript = (detail: string): never => {
      emitStep({
        onProgress: args.onProgress,
        key: `${args.kind}-failed`,
        text: `${args.scriptName} failed`,
        status: "failed",
        startedAt,
        metadata: { durationMs },
      });
      throw new WorkspaceError(
        "setup_script_failed",
        `${args.kind === "setup" ? "Setup" : "Teardown"} script ${detail}: ${scriptPath}`,
      );
    };

    if (timedOut) {
      failScript(`timed out after ${timeoutMs}ms`);
    }

    if (result.signal) {
      failScript(`exited via signal ${result.signal}`);
    }

    if ((result.exitCode ?? 0) !== 0) {
      failScript(`failed with exit code ${result.exitCode}`);
    }

    emitStep({
      onProgress: args.onProgress,
      key: `${args.kind}-completed`,
      text: `${args.scriptName} finished`,
      status: "completed",
      startedAt,
      metadata: { durationMs },
    });
    return { ran: true };
  } finally {
    clearTimeout(timeout);
    args.signal?.removeEventListener("abort", abortLifecycleScript);
  }
}

export function runSetupScript(
  args: RunSetupScriptArgs,
): Promise<{ ran: boolean }> {
  return runLifecycleScript({
    ...args,
    kind: "setup",
    scriptName: DEFAULT_ENV_SETUP_SCRIPT_NAME,
  });
}

export async function runTeardownScript(
  args: RunTeardownScriptArgs,
): Promise<{ ran: boolean }> {
  const startedAt = Date.now();
  let failureReported = false;
  const onProgress: ProgressCallback = (entry) => {
    if (entry.type === "step" && entry.key === "teardown-failed") {
      failureReported = true;
    }
    args.onProgress?.(entry);
  };
  try {
    return await runLifecycleScript({
      ...args,
      onProgress,
      kind: "teardown",
      scriptName: DEFAULT_ENV_TEARDOWN_SCRIPT_NAME,
    });
  } catch (error) {
    if (args.signal?.aborted) throw error;
    if (!failureReported) {
      emitStep({
        onProgress: args.onProgress,
        key: "teardown-failed",
        text: `${DEFAULT_ENV_TEARDOWN_SCRIPT_NAME} failed`,
        status: "failed",
        startedAt,
        metadata: { durationMs: Date.now() - startedAt },
      });
    }
    emitOutput(
      args.onProgress,
      "teardown-error",
      error instanceof Error ? error.message : String(error),
    );
    // Its processes may still run: cleanup must not remove the workspace.
    if (error instanceof LifecycleScriptTerminationUnverifiedError) throw error;
    return { ran: true };
  }
}
