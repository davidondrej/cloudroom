import { execFile } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { CLOUDROOM_PYTHON_PATH, CLOUDROOM_PREVIEW_SCRIPT_PATH } from "../../cloudroom-workspace-asset.js";

export const macAccessLevels = ["off", "read-only", "ask", "full"] as const;
export type MacAccessLevel = typeof macAccessLevels[number];
/** Read-only and Ask run commands in a macOS sandbox, so other systems offer only Off and Full. */
export const supportedMacAccessLevels: readonly MacAccessLevel[] = process.platform === "darwin" ? macAccessLevels : ["off", "full"];

type Deps = Pick<AppDeps, "config">;
const folder = (deps: Deps) => join(deps.config.dataDir, "cloudroom-preview");
// Cloudroom Dev shares the real app's account, so its helper uses only the sandboxes of threads Dev woke.
const devBuild = (deps: Deps) => deps.config.appVersion.startsWith("0.0.0");
const noted = new Set<string>();

/** After a wake the helper lists the new sandbox now instead of at its next minute check. */
export async function noteWake(deps: Deps, thread: string): Promise<void> {
  if (devBuild(deps) && !noted.has(thread)) {
    await appendFile(join(folder(deps), "own-threads"), thread + "\n", { mode: 0o600 });
    noted.add(thread);
  }
  await checkPreviewsNow(deps);
}

export async function checkPreviewsNow(deps: Deps): Promise<void> {
  await writeFile(join(folder(deps), "woke"), "").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
const statusSchema = z.object({ state: z.enum(["connected", "offline"]), count: z.number().int().nonnegative().optional(), message: z.string().max(512).optional(), detail: z.string().max(512).optional(), checkedAt: z.number() });

export async function previewStatus(deps: Deps, freshMs = 15_000) {
  try {
    const status = statusSchema.parse(JSON.parse(await readFile(join(folder(deps), "status.json"), "utf8")));
    const age = Date.now() - status.checkedAt;
    const fresh = age >= -5000 && age <= freshMs;
    return { state: fresh ? status.state : "offline", count: status.count ?? 0, message: status.message ?? null, detail: fresh ? status.detail ?? null : null };
  } catch { return { state: "offline", count: 0, message: null, detail: null }; }
}

/** How much cloud agents may do on this computer (ADR 0113, levels in ADR 0186), or null until first-run setup asks. The preview helper runs Mac access. */
/** The preview helper that runs Mac access is macOS and Linux only for now. */
export const macAccessSupported = process.platform !== "win32";
const macAccessFile = (deps: Deps) => join(deps.config.dataDir, "cloudroom-mac-access.json");
export async function macAccess(deps: Deps): Promise<MacAccessLevel | null> {
  return readFile(macAccessFile(deps), "utf8").then((text) => {
    const saved = JSON.parse(text);
    return macAccessLevels.includes(saved.level) ? saved.level as MacAccessLevel : saved.enabled === true ? "full" : "off";
  }, () => null);
}
export async function setMacAccess(deps: Deps, level: MacAccessLevel): Promise<void> {
  if (!macAccessSupported) throw new ApiError(409, "mac_access_unsupported", "Cloud agents can't use a Windows computer yet.");
  if (!supportedMacAccessLevels.includes(level)) throw new ApiError(400, "mac_access_unsupported", "Read and Ask need macOS. Pick Off or Full.");
  await writeFile(macAccessFile(deps), JSON.stringify({ level }), { mode: 0o600 });
  if (await readFile(join(folder(deps), "config.json")).then(() => true, () => false)) await setupPreviews(deps);
}

// The helper outlives the app, so restart it once per launch: macOS only applies a newly granted Full Disk Access to new processes.
let restartedThisLaunch = false;

export async function setupPreviews(deps: Deps): Promise<void> {
  const launcher = process.platform === "darwin" && process.versions.electron ? ["--launcher", process.execPath] : [];
  const restart = restartedThisLaunch ? [] : ["--restart"];
  try {
    await promisify(execFile)(CLOUDROOM_PYTHON_PATH, ["-B", "-E", "-s", CLOUDROOM_PREVIEW_SCRIPT_PATH, "configure", folder(deps), "--connection", join(deps.config.dataDir, "cloudroom.json"), "--mac-access", await macAccess(deps) ?? "off", ...launcher, ...restart, ...(devBuild(deps) ? ["--own-threads"] : [])], { timeout: 30_000, maxBuffer: 64 * 1024 });
    restartedThisLaunch = true;
  } catch { throw new ApiError(503, "cloudroom_preview_setup", "Cloud previews could not start. Inspect the private preview helper status. Cloud sessions are unaffected."); }
}

export async function stopPreviews(deps: Deps): Promise<void> {
  if (!await readFile(join(folder(deps), "config.json")).then(() => true, () => false)) return;
  try {
    await promisify(execFile)(CLOUDROOM_PYTHON_PATH, ["-B", "-E", "-s", CLOUDROOM_PREVIEW_SCRIPT_PATH, "stop", folder(deps)], { timeout: 20_000, maxBuffer: 64 * 1024 });
  } catch { throw new ApiError(503, "cloudroom_preview_stop", "Preview shutdown or SSH-key revocation could not be confirmed. Retry sign-out when the cloud is reachable."); }
}
