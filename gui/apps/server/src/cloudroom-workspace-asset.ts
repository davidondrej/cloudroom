import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const windows = process.platform === "win32";
const bundledPython = new URL(windows ? "./assets/python/python.exe" : "./assets/python/bin/python3", import.meta.url);
export const CLOUDROOM_PYTHON_PATH = existsSync(bundledPython) ? fileURLToPath(bundledPython) : windows ? "python" : "python3";

export const CLOUDROOM_PREVIEW_SCRIPT_PATH = fileURLToPath(
  new URL("./assets/cloudroom-preview/client.py", import.meta.url),
);

export const CLOUDROOM_SYNC_SCRIPT_PATH = fileURLToPath(
  new URL("./assets/cloudroom-sync/client.py", import.meta.url),
);
