import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  /** App unclean-exit only: "hung" if a window was unresponsive, else "unknown". */
  cause?: "hung" | "unknown";
}

let target: { dataDir: string; version: string; isQuitting: () => boolean } | null = null;
let runningFile: string | null = null;
// Windows is shutting down or logging off. It ends our processes, which isn't a crash. macOS quits apps normally.
let sessionEnding = false;
let startedAt = 0;
// Set once quitting: no more writes, but each clear still retries the delete.
let stopped = false;
const unresponsiveWindows = new Set<number>();

// Through a temp file, so a kill mid-write (likely while frozen) can't leave bad JSON.
const writeRunningFile = () => {
  if (runningFile && target && !stopped) try {
    writeFileSync(`${runningFile}.tmp`, JSON.stringify({ version: target.version, at: startedAt, unresponsive: unresponsiveWindows.size > 0 }), { mode: 0o600 });
    renameSync(`${runningFile}.tmp`, runningFile);
  } catch {}
};
const clearRunningFile = () => {
  stopped = true;
  if (runningFile) try { rmSync(runningFile, { force: true }); } catch {}
};

export function startCrashReports(dataDir: string, version: string, isQuitting: () => boolean): void {
  target = { dataDir, version, isQuitting };
  app.on("child-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") saveCrash({ what: (details.name ?? details.type).toLowerCase(), reason: details.reason, exit_code: details.exitCode });
  });
  // running.json lives while the app runs. Still there at launch means the last run never quit: the app crashed,
  // was ended in Task Manager, or the PC lost power. Nothing else sees the main process die.
  runningFile = join(dataDir, "running.json");
  try {
    // Another version ran last: it ended for an update, and the installer may have had to kill it.
    const last = JSON.parse(readFileSync(runningFile, "utf8")) as { version?: unknown; unresponsive?: unknown };
    if (last.version === version) saveCrash({ what: "app", reason: "unclean-exit", exit_code: null, cause: last.unresponsive === true ? "hung" : "unknown" });
  } catch {}
  startedAt = Date.now();
  writeRunningFile();
  // will-quit covers app.quit(); "exit" covers app.exit(), which skips will-quit.
  app.on("will-quit", clearRunningFile);
  process.on("exit", clearRunningFile);
}

/** App windows only (main.ts's window factory), not the log viewer or dialogs. */
export function watchWindowCrashes(window: BrowserWindow): void {
  // A frozen window. The main process fires these, so a frozen main process itself stays "unknown".
  const id = window.id;
  const responsive = () => { if (unresponsiveWindows.delete(id)) writeRunningFile(); };
  window.webContents.on("render-process-gone", (_event, details) => {
    responsive();
    if (details.reason !== "clean-exit") saveCrash({ what: "window", reason: details.reason, exit_code: details.exitCode });
  });
  window.on("unresponsive", () => { unresponsiveWindows.add(id); writeRunningFile(); });
  window.on("responsive", responsive);
  window.on("closed", responsive);
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
