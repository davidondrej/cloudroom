import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexGuardConfig, codexHookSource, shellQuote } from "../../../../../core/src/runtime/command-guard.mjs";
export { checkCommand, commandGuardBlockReason } from "../../../../../core/src/runtime/command-guard.mjs";

let config: ReturnType<typeof codexGuardConfig> | undefined;

export function prepareCodexGuard(): ReturnType<typeof codexGuardConfig> {
  if (config) return config;
  const directory = mkdtempSync(join(tmpdir(), "cloudroom-command-guard-"));
  const path = join(directory, "cloudroom-command-guard.mjs");
  writeFileSync(path, codexHookSource(), { mode: 0o600 });
  // Codex runs without ELECTRON_RUN_AS_NODE, so without it the packaged app would
  // launch the full GUI (a Dock icon flash) and never run the guard.
  // Codex uses PowerShell for Windows hooks, including when the tool matches Bash.
  // Keep Windows launch failures visible: Codex reports failed hooks but only a deny blocks.
  const powershellQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const command = process.platform === "win32"
    ? `$env:ELECTRON_RUN_AS_NODE='1'; & ${powershellQuote(process.execPath)} ${powershellQuote(path)}`
    : `ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(path)} || true`;
  config = codexGuardConfig(command);
  return config;
}
