import { execFile, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { userInfo } from "node:os";
import { dirname } from "node:path";

export const IDLE_INSTALL_AFTER_MS = 10 * 60_000;
const IDLE_CHECK_MS = 15_000;

export interface IdleInstallArgs {
  isUpdateDownloaded(): boolean;
  systemIdleSeconds(): number;
  hasRunningThreads(): Promise<boolean>;
  /** False: never install by itself, only when a window asks (`report` returns true). */
  autoInstall?: boolean;
  report?(installAt: number | null): Promise<boolean>;
  install(): Promise<void>;
  now?: () => number;
}

export function startIdleInstall(args: IdleInstallArgs): {
  check(): Promise<void>;
  stop(): void;
} {
  const now = args.now ?? Date.now;
  let busyAt = now();
  let installing = false;
  // A slow server can make a check outlast the 15 s interval; overlapping checks would install twice.
  let checking = false;
  async function check(): Promise<void> {
    if (installing || checking) return;
    checking = true;
    try {
      if (!args.isUpdateDownloaded()) {
        busyAt = now();
        return;
      }
      const running = await args.hasRunningThreads().catch(() => true);
      if (running) busyAt = now();
      const installAt =
        running || args.autoInstall === false
          ? null
          : Math.max(busyAt, now() - args.systemIdleSeconds() * 1000) +
            IDLE_INSTALL_AFTER_MS;
      const requested = (await args.report?.(installAt).catch(() => false)) ?? false;
      if (!requested && (installAt === null || now() < installAt)) return;
      installing = true;
    } finally {
      checking = false;
    }
    await args.install();
  }
  const timer = setInterval(() => void check(), IDLE_CHECK_MS);
  timer.unref();
  return { check, stop: () => clearInterval(timer) };
}

// Our own ShipIt: a process named ShipIt with our launchd job label ("<bundle id>.ShipIt", Squirrel's
// SQRLShipItLauncher) as one argument, so another app's ShipIt doesn't count. A ShipIt running as root
// (a password install) counts too, since this user may not see its arguments.
const OUR_SHIPIT = `
id=$(defaults read "$1/Contents/Info" CFBundleIdentifier) || exit 1
shipit() {
  for p in $(pgrep -x ShipIt); do
    case "$(ps -o uid= -p "$p" | tr -d ' ') $(ps -o args= -p "$p") " in "0 "* | *" $id.ShipIt "*) return 0 ;; esac
  done
  return 1
}
`;

const REOPEN_SCRIPT = `${OUR_SHIPIT}running() { [ -n "$(lsappinfo find bundleid="$id")" ]; }
for _ in $(seq 1800); do kill -0 "$2" 2>/dev/null || break; sleep 1; done
sleep 5
for _ in $(seq 100); do
  running && exit 0
  shipit || break
  sleep 3
done
sleep 5
running || open "$1"
`;

/** Squirrel.Mac is still installing an update into this app. */
export function shipItRunning(execPath: string): Promise<boolean> {
  const bundle = macAppBundle(execPath);
  if (bundle === null) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", `${OUR_SHIPIT}shipit`, "sh", bundle],
      { timeout: 5_000 },
      (error) => resolve(error === null),
    );
  });
}

export function macAppBundle(execPath: string): string | null {
  return /^(.+?\.app)\/Contents\/MacOS\/[^/]+$/u.exec(execPath)?.[1] ?? null;
}

/** Where the app runs from. Squirrel.Mac can't replace a translocated app (opened from Downloads or the DMG). */
export function macAppLocation(execPath: string): "applications" | "translocated" | "other" {
  const bundle = macAppBundle(execPath) ?? "";
  if (bundle.includes("/AppTranslocation/")) return "translocated";
  return /^(\/Users\/[^/]+)?\/Applications\//u.test(bundle) ? "applications" : "other";
}

function canWrite(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Squirrel.Mac needs an admin password ("trying to add a new helper tool") when
// this user can't write the app bundle or its folder, e.g. another account installed it.
export function installNeedsPassword(execPath: string): boolean {
  const bundle = macAppBundle(execPath);
  return bundle !== null && !(canWrite(bundle) && canWrite(dirname(bundle)));
}

// Opened from the disk image or translocated from Downloads: no password helps, Squirrel.Mac
// refuses a read-only app ("Cannot update while running on a read-only volume").
export function appOnReadOnlyVolume(execPath: string): boolean {
  const bundle = macAppBundle(execPath);
  if (bundle === null) return false;
  try {
    accessSync(bundle, constants.W_OK);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EROFS";
  }
}

// An unanswered prompt (hidden behind windows, on another screen) would leave Restart to update
// spinning forever; after this the prompt closes and the button works again.
const OWNERSHIP_PROMPT_TIMEOUT_MS = 2 * 60_000;

const TAKE_OWNERSHIP_SCRIPT = [
  "on run argv",
  'do shell script "/usr/sbin/chown -R " & item 1 of argv & " " & quoted form of item 2 of argv & " && /bin/chmod -R u+w " & quoted form of item 2 of argv with prompt "Cloudroom needs your password once, so future updates install by themselves." with administrator privileges',
  "end run",
].flatMap((line) => ["-e", line]);

// One admin prompt makes this user the app's owner, so Squirrel.Mac never asks
// again. Only a writable folder (e.g. /Applications for admins) can be fixed this way.
export function takeAppOwnership(
  execPath: string,
): Promise<"fixed" | "canceled" | "timed-out" | "failed" | "skipped"> {
  const bundle = macAppBundle(execPath);
  if (bundle === null || !canWrite(dirname(bundle))) {
    return Promise.resolve("skipped");
  }
  const args = [...TAKE_OWNERSHIP_SCRIPT, String(userInfo().uid), bundle];
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", args, { timeout: OWNERSHIP_PROMPT_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (error === null) resolve(canWrite(bundle) ? "fixed" : "failed");
      else if (error.killed) resolve("timed-out");
      else resolve(/\(-128\)/u.test(stderr) ? "canceled" : "failed");
    });
  });
}

export function reopenAfterExit(execPath: string, pid: number): boolean {
  const bundle = macAppBundle(execPath);
  if (bundle === null) return false;
  spawn("/bin/sh", ["-c", REOPEN_SCRIPT, "sh", bundle, String(pid)], {
    detached: true,
    stdio: "ignore",
  }).unref();
  return true;
}
