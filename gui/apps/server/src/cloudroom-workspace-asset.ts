import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const windows = process.platform === "win32";
const bundledPython = new URL(windows ? "./assets/python/python.exe" : "./assets/python/bin/python3", import.meta.url);
export const CLOUDROOM_PYTHON_PATH = existsSync(bundledPython) ? fileURLToPath(bundledPython) : windows ? "python" : "python3";

/** Core owns the Mac helpers. Builds copy them into `dist/assets`; source runs read them from `core/`. */
function coreHelper(asset: string, source: string): string {
  const built = new URL(`./assets/${asset}`, import.meta.url);
  return fileURLToPath(existsSync(built) ? built : new URL(`../../../../core/src/${source}`, import.meta.url));
}

export const CLOUDROOM_PREVIEW_SCRIPT_PATH = coreHelper("cloudroom-preview/client.py", "preview/client.py");

/** The Rust Mac helper (Core's `cloudroom helper`), bundled in the macOS app only. Dev builds can point at their own. */
export const CLOUDROOM_CORE_PATH = process.env.CLOUDROOM_HELPER_BINARY || fileURLToPath(
  new URL("./assets/cloudroom-core/cloudroom", import.meta.url),
);

export const CLOUDROOM_SYNC_SCRIPT_PATH = coreHelper("cloudroom-sync/client.py", "sync/client.py");
