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
      const installAt = running
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

const REOPEN_SCRIPT = `
id=$(defaults read "$1/Contents/Info" CFBundleIdentifier) || exit 1
running() { [ -n "$(lsappinfo find bundleid="$id")" ]; }
for _ in $(seq 1800); do kill -0 "$2" 2>/dev/null || break; sleep 1; done
sleep 5
for _ in $(seq 100); do
  running && exit 0
  pgrep -x ShipIt >/dev/null || break
  sleep 3
done
sleep 5
running || open "$1"
`;

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

const TAKE_OWNERSHIP_SCRIPT = [
  "on run argv",
  'do shell script "/usr/sbin/chown -R " & item 1 of argv & " " & quoted form of item 2 of argv & " && /bin/chmod -R u+w " & quoted form of item 2 of argv with prompt "Cloudroom needs your password once, so future updates install by themselves." with administrator privileges',
  "end run",
].flatMap((line) => ["-e", line]);

// One admin prompt makes this user the app's owner, so Squirrel.Mac never asks
// again. Only a writable folder (e.g. /Applications for admins) can be fixed this way.
export function takeAppOwnership(
  execPath: string,
): Promise<"fixed" | "canceled" | "failed" | "skipped"> {
  const bundle = macAppBundle(execPath);
  if (bundle === null || !canWrite(dirname(bundle))) {
    return Promise.resolve("skipped");
  }
  const args = [...TAKE_OWNERSHIP_SCRIPT, String(userInfo().uid), bundle];
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", args, (error, _stdout, stderr) => {
      if (error === null) resolve(canWrite(bundle) ? "fixed" : "failed");
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
