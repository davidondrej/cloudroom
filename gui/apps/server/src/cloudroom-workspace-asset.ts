import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const windows = process.platform === "win32";
const bundledPython = new URL(windows ? "./assets/python/python.exe" : "./assets/python/bin/python3", import.meta.url);
export const CLOUDROOM_PYTHON_PATH = existsSync(bundledPython) ? fileURLToPath(bundledPython) : windows ? "python" : "python3";

export const CLOUDROOM_PREVIEW_SCRIPT_PATH = fileURLToPath(
  new URL("./assets/cloudroom-preview/client.py", import.meta.url),
);

/** The Rust Mac helper (Core's `cloudroom helper`), bundled in the macOS app only. Dev builds can point at their own. */
export const CLOUDROOM_CORE_PATH = process.env.CLOUDROOM_HELPER_BINARY || fileURLToPath(
  new URL("./assets/cloudroom-core/cloudroom", import.meta.url),
);

export const CLOUDROOM_SYNC_SCRIPT_PATH = fileURLToPath(
  new URL("./assets/cloudroom-sync/client.py", import.meta.url),
);
