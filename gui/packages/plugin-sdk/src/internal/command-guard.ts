import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexGuardConfig, codexHookSource, shellQuote } from "./command-guard-runtime.mjs";
export { checkCommand, commandGuardBlockReason } from "./command-guard-runtime.mjs";

let config: ReturnType<typeof codexGuardConfig> | undefined;

export function prepareCodexGuard(): ReturnType<typeof codexGuardConfig> {
  if (config) return config;
  const directory = mkdtempSync(join(tmpdir(), "cloudroom-command-guard-"));
  const path = join(directory, "cloudroom-command-guard.mjs");
  writeFileSync(path, codexHookSource(), { mode: 0o600 });
  // Codex runs without ELECTRON_RUN_AS_NODE, so without it the packaged app would
  // launch the full GUI (a Dock icon flash) and never run the guard.
  const command = `ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(path)} || true`;
  config = codexGuardConfig(command);
  return config;
}
