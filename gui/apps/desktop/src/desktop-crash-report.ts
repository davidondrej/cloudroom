import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, type BrowserWindow } from "electron";

export const CRASH_FILE_NAME = "last-crash.json";

interface Crash {
  what: string;
  reason: string;
  exit_code: number | null;
  logs?: string;
  /** Backend only: 1 for the first start, 2 and up for retries after a missing file (main.ts). */
  attempt?: number;
}

let target: { dataDir: string; version: string; isQuitting: () => boolean } | null = null;
let runningFile: string | null = null;
// Windows is shutting down or logging off. It ends our processes, which isn't a crash.
let sessionEnding = false;

const clearRunningFile = () => {
  if (runningFile) try { rmSync(runningFile, { force: true }); } catch {}
};

export function startCrashReports(dataDir: string, version: string, isQuitting: () => boolean): void {
  if (process.platform !== "win32") return;
  target = { dataDir, version, isQuitting };
  app.on("child-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") saveCrash({ what: (details.name ?? details.type).toLowerCase(), reason: details.reason, exit_code: details.exitCode });
  });
  // running.json lives while the app runs. Still there at launch means the last run never quit: the app crashed,
  // was ended in Task Manager, or the PC lost power. Nothing else sees the main process die.
  runningFile = join(dataDir, "running.json");
  try {
    // Another version ran last: it ended for an update, and the installer may have had to kill it.
    if ((JSON.parse(readFileSync(runningFile, "utf8")) as { version?: unknown }).version === version) {
      saveCrash({ what: "app", reason: "unclean-exit", exit_code: null });
    }
  } catch {}
  try { writeFileSync(runningFile, JSON.stringify({ version, at: Date.now() }), { mode: 0o600 }); } catch {}
  // will-quit covers app.quit(); "exit" covers app.exit(), which skips will-quit.
  app.on("will-quit", clearRunningFile);
  process.on("exit", clearRunningFile);
}

export function watchWindowCrashes(window: BrowserWindow): void {
  if (process.platform !== "win32") return;
  window.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") saveCrash({ what: "window", reason: details.reason, exit_code: details.exitCode });
  });
  window.on("query-session-end", () => {
    sessionEnding = true;
    clearRunningFile();
  });
}

export function saveCrash(crash: Crash): void {
  if (!target || target.isQuitting() || sessionEnding) return;
  const file = join(target.dataDir, CRASH_FILE_NAME);
  try {
    let crashes: unknown[] = [];
    try { crashes = JSON.parse(readFileSync(file, "utf8")) as unknown[]; } catch {}
    crashes = [...(Array.isArray(crashes) ? crashes : []), { ...crash, version: target.version, at: Date.now() }].slice(-5);
    writeFileSync(file, JSON.stringify(crashes), { mode: 0o600 });
  } catch {}
}
