import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  experimental_defineHostEntry,
  type ExperimentalHostWorkerLease,
} from "@get-bb/plugin-sdk/host";
import { keepAwakeHostContract } from "./contract.js";

const CAFFEINATE_COMMAND = "/usr/bin/caffeinate";
const SYSTEMD_INHIBIT_COMMAND = "/usr/bin/systemd-inhibit";
const RESTART_DELAY_MS = 1_000;
const MAX_RESTART_DELAY_MS = 60_000;
const SETTLED_CHILD_MS = 10_000;
const WINDOWS_AWAKE_STATE = 0x80000001;

interface KeepAwakeChild {
  kill(signal: NodeJS.Signals): boolean;
  once(event: "error" | "exit", listener: () => void): this;
}

interface KeepAwakeHostDependencies {
  readonly pid: number;
  readonly platform: NodeJS.Platform;
  readonly hasSystemdInhibit?: boolean;
  now?(): number;
  spawn(
    command: string,
    args: readonly string[],
    options: { readonly stdio: "ignore"; readonly windowsHide: true },
  ): KeepAwakeChild;
}

function keepAwakeCommand(
  deps: KeepAwakeHostDependencies,
): readonly [string, readonly string[]] | null {
  const pid = String(deps.pid);
  if (deps.platform === "darwin") {
    return [CAFFEINATE_COMMAND, ["-d", "-i", "-s", "-w", pid]];
  }
  if (deps.platform === "linux" && deps.hasSystemdInhibit === true) {
    return [
      SYSTEMD_INHIBIT_COMMAND,
      [
        "--what=idle:sleep",
        "--who=Cloudroom",
        "--why=Agents are running",
        "--mode=block",
        "tail",
        `--pid=${pid}`,
        "-f",
        "/dev/null",
      ],
    ];
  }
  if (deps.platform === "win32") {
    return [
      `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "$ErrorActionPreference = 'Stop'",
          "$power = Add-Type -Name KeepAwake -Namespace Cloudroom -PassThru -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags);'",
          `if ($power::SetThreadExecutionState(${WINDOWS_AWAKE_STATE}) -eq 0) { exit 1 }`,
          `Wait-Process -Id ${pid}`,
        ].join("; "),
      ],
    ];
  }
  return null;
}

export function createKeepAwakeHostEntry(deps: KeepAwakeHostDependencies) {
  const command = keepAwakeCommand(deps);
  let child: KeepAwakeChild | null = null;
  let lifecycleSignal: AbortSignal | null = null;
  let desiredEnabled = false;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let restartDelayMs = RESTART_DELAY_MS;
  let workerLease: ExperimentalHostWorkerLease | null = null;
  const now = deps.now ?? Date.now;

  function clearRestart(): void {
    if (restartTimer === null) return;
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  function stop(): void {
    const active = child;
    child = null;
    active?.kill("SIGTERM");
  }

  function releaseWorkerLease(): void {
    const lease = workerLease;
    workerLease = null;
    void lease?.dispose();
  }

  function scheduleRestart(): void {
    if (
      restartTimer !== null ||
      !desiredEnabled ||
      lifecycleSignal?.aborted === true
    ) {
      return;
    }
    const delayMs = restartDelayMs;
    if (deps.platform === "win32") {
      restartDelayMs = Math.min(restartDelayMs * 2, MAX_RESTART_DELAY_MS);
    }
    restartTimer = setTimeout(() => {
      restartTimer = null;
      start();
    }, delayMs);
  }

  function start(): void {
    if (
      child !== null ||
      restartTimer !== null ||
      !desiredEnabled ||
      command === null ||
      lifecycleSignal?.aborted === true
    ) {
      return;
    }
    let next: KeepAwakeChild;
    try {
      next = deps.spawn(command[0], command[1], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      scheduleRestart();
      return;
    }
    child = next;
    const startedAt = now();
    const clear = (): void => {
      if (child !== next) return;
      child = null;
      if (now() - startedAt >= SETTLED_CHILD_MS) {
        restartDelayMs = RESTART_DELAY_MS;
      }
      scheduleRestart();
    };
    next.once("error", clear);
    next.once("exit", clear);
  }

  function disposeState(): void {
    desiredEnabled = false;
    clearRestart();
    stop();
    releaseWorkerLease();
  }

  function bindLifecycle(signal: AbortSignal): void {
    if (lifecycleSignal === signal) return;
    lifecycleSignal = signal;
    signal.addEventListener("abort", disposeState, { once: true });
  }

  function status(): { enabled: boolean; supported: boolean } {
    return { enabled: child !== null, supported: command !== null };
  }

  return experimental_defineHostEntry({
    contract: keepAwakeHostContract,
    handlers: {
      setEnabled(input, context) {
        bindLifecycle(context.lifecycle.signal);
        desiredEnabled = command !== null && input.enabled;
        if (!desiredEnabled) {
          restartDelayMs = RESTART_DELAY_MS;
          clearRestart();
          stop();
          releaseWorkerLease();
          return status();
        }
        workerLease ??= context.experimental_retainWorker();
        start();
        return status();
      },
    },
    dispose() {
      disposeState();
    },
  });
}

export default createKeepAwakeHostEntry({
  pid: process.pid,
  platform: process.platform,
  hasSystemdInhibit:
    process.platform === "linux" && existsSync(SYSTEMD_INHIBIT_COMMAND),
  spawn(command, args, options) {
    return spawn(command, [...args], options);
  },
});
