import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, type WebContents } from "electron";

export const CRASH_FILE_NAME = "last-crash.json";

interface Crash {
  what: string;
  reason: string;
  exit_code: number | null;
  logs?: string;
}

let target: { dataDir: string; version: string; isQuitting: () => boolean } | null = null;

export function startCrashReports(dataDir: string, version: string, isQuitting: () => boolean): void {
  if (process.platform !== "win32") return;
  target = { dataDir, version, isQuitting };
  app.on("child-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") saveCrash({ what: (details.name ?? details.type).toLowerCase(), reason: details.reason, exit_code: details.exitCode });
  });
}

export function watchWindowCrashes(webContents: WebContents): void {
  if (process.platform !== "win32") return;
  webContents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") saveCrash({ what: "window", reason: details.reason, exit_code: details.exitCode });
  });
}

export function saveCrash(crash: Crash): void {
  if (!target || target.isQuitting()) return;
  const file = join(target.dataDir, CRASH_FILE_NAME);
  try {
    let crashes: unknown[] = [];
    try { crashes = JSON.parse(readFileSync(file, "utf8")) as unknown[]; } catch {}
    crashes = [...(Array.isArray(crashes) ? crashes : []), { ...crash, version: target.version, at: Date.now() }].slice(-5);
    writeFileSync(file, JSON.stringify(crashes), { mode: 0o600 });
  } catch {}
}
