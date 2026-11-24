import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexGuardConfig, codexHookSource, shellQuote } from "../../../../../core/src/runtime/command-guard.mjs";
export { checkCommand, commandGuardBlockReason } from "../../../../../core/src/runtime/command-guard.mjs";

let cached: { path: string; config: ReturnType<typeof codexGuardConfig> } | undefined;

// Codex runs whatever file is at this path before every shell command, outside
// its sandbox. So nothing less trusted may write `directory`: not another
// account, a Read-only Mac command, or an agent sandbox. The bridge's temp
// folder is one (see createPluginProcessTempDir).
export function prepareCodexGuard(directory: string): ReturnType<typeof codexGuardConfig> {
  const path = join(directory, "cloudroom-command-guard.mjs");
  // A missing guard lets every command through (`|| true` below), so each new
  // session writes it again if the file is gone.
  if (!existsSync(path)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(path, codexHookSource(), { mode: 0o600 });
  }
  if (cached?.path === path) return cached.config;
  // Codex runs without ELECTRON_RUN_AS_NODE, so without it the packaged app would
  // launch the full GUI (a Dock icon flash) and never run the guard.
  // Codex uses PowerShell for Windows hooks, including when the tool matches Bash.
  // Keep Windows launch failures visible: Codex reports failed hooks but only a deny blocks.
  const powershellQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const command = process.platform === "win32"
    ? `$env:ELECTRON_RUN_AS_NODE='1'; & ${powershellQuote(process.execPath)} ${powershellQuote(path)}`
    : `ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(path)} || true`;
  cached = { path, config: codexGuardConfig(command) };
  return cached.config;
}
