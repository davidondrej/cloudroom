import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  experimental_defineHostEntry,
  type ExperimentalHostWorkerLease,
} from "@get-bb/plugin-sdk/host";
import { keepAwakeHostContract } from "./contract.js";

const REASON = "Keep Awake is on in Cloudroom";
const GNOME_INHIBIT = "/usr/bin/gnome-session-inhibit";
const SYSTEMD_INHIBIT = "/usr/bin/systemd-inhibit";
const RESTART_MIN_MS = 1_000;
const RESTART_MAX_MS = 60_000;
/** A helper that ran this long was healthy, so its next restart is quick again. */
const HEALTHY_MS = 10_000;

/**
 * The helper that keeps this OS awake. Every helper watches process `pid` and
 * exits with it, so sleep prevention can never outlive Cloudroom. `null` means
 * this OS is not supported.
 */
export function keepAwakeCommand(
  platform: NodeJS.Platform,
  pid: number,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): [command: string, args: string[]] | null {
  if (platform === "darwin") return ["/usr/bin/caffeinate", ["-d", "-i", "-s", "-w", String(pid)]];
  if (platform === "win32") {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$power = Add-Type -Name KeepAwake -Namespace Cloudroom -PassThru -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags);'",
      // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, as a decimal: PowerShell reads the hex as negative.
      `if ($power::SetThreadExecutionState(${0x80000001}) -eq 0) { exit 1 }`,
      `Wait-Process -Id ${pid}`,
    ].join("; ");
    return [
      `${env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      ["-NoProfile", "-NonInteractive", "-Command", script],
    ];
  }
  if (platform !== "linux") return null;
  const untilPidExits = ["tail", `--pid=${pid}`, "-f", "/dev/null"];
  // GNOME suspends on its own idle timer and ignores logind idle locks. An
  // idle inhibit stops that timer and still lets lid close and Suspend work.
  if (/gnome/i.test(env.XDG_CURRENT_DESKTOP ?? "") && exists(GNOME_INHIBIT)) {
    const args = ["--app-id", "Cloudroom", "--reason", REASON, "--inhibit", "idle"];
    return [GNOME_INHIBIT, [...args, ...untilPidExits]];
  }
  if (!exists(SYSTEMD_INHIBIT)) return null;
  const args = ["--what=idle:sleep", "--who=Cloudroom", `--why=${REASON}`, "--mode=block"];
  return [SYSTEMD_INHIBIT, [...args, ...untilPidExits]];
}

const command = keepAwakeCommand(process.platform, process.pid);
let wanted = false;
let helper: ChildProcess | null = null;
let restart: ReturnType<typeof setTimeout> | null = null;
let restartMs = RESTART_MIN_MS;
/** Stops the daemon from closing this idle worker, which would end the helper. */
let lease: ExperimentalHostWorkerLease | null = null;

function restartLater(): void {
  restart = setTimeout(() => {
    restart = null;
    start();
  }, restartMs);
  restartMs = Math.min(restartMs * 2, RESTART_MAX_MS);
}

function start(): void {
  if (!wanted || command === null || helper !== null || restart !== null) return;
  const startedAt = Date.now();
  let next: ChildProcess;
  try {
    next = spawn(command[0], command[1], { stdio: "ignore", windowsHide: true });
  } catch {
    restartLater();
    return;
  }
  helper = next;
  const ended = (): void => {
    if (helper !== next) return; // stopped on purpose, or already handled
    helper = null;
    if (Date.now() - startedAt >= HEALTHY_MS) restartMs = RESTART_MIN_MS;
    restartLater();
  };
  next.once("error", ended).once("exit", ended);
}

function stop(): void {
  wanted = false;
  if (restart !== null) clearTimeout(restart);
  restart = null;
  restartMs = RESTART_MIN_MS;
  const running = helper;
  helper = null;
  running?.kill("SIGTERM");
  void lease?.dispose();
  lease = null;
}

export default experimental_defineHostEntry({
  contract: keepAwakeHostContract,
  handlers: {
    setEnabled({ enabled }, context) {
      if (enabled && command !== null) {
        wanted = true;
        lease ??= context.experimental_retainWorker();
        start();
      } else {
        stop();
      }
      return { enabled: helper !== null, supported: command !== null };
    },
  },
  dispose: stop,
});
