import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { appendFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { CLOUDROOM_CORE_PATH, CLOUDROOM_PYTHON_PATH, CLOUDROOM_PREVIEW_SCRIPT_PATH } from "../../cloudroom-workspace-asset.js";

export const macAccessLevels = ["off", "read-only", "ask", "full"] as const;
export type MacAccessLevel = typeof macAccessLevels[number];
/** Read-only and Ask run commands in a macOS sandbox, so other systems offer only Off and Full. */
export const supportedMacAccessLevels: readonly MacAccessLevel[] = process.platform === "darwin" ? macAccessLevels : ["off", "full"];

type Deps = Pick<AppDeps, "config">;
const folder = (deps: Deps) => join(deps.config.dataDir, "cloudroom-preview");
// Cloudroom Dev shares the real app's account, so its helper uses only the sandboxes of threads Dev woke.
const devBuild = (deps: Deps) => deps.config.appVersion.startsWith("0.0.0");
const noted = new Set<string>();
/**
 * Trial switch: a `rust-helper` file in the data folder runs the Rust helper in the bundled Core instead of client.py
 * (macOS only). Both use the same files and LaunchAgent, so deleting the file and restarting the app switches back.
 */
const helper = (deps: Deps, args: string[]): [string, string[]] =>
  process.platform === "darwin" && existsSync(CLOUDROOM_CORE_PATH) && existsSync(join(deps.config.dataDir, "rust-helper"))
    ? [CLOUDROOM_CORE_PATH, ["helper", ...args]]
    : [CLOUDROOM_PYTHON_PATH, ["-B", "-E", "-s", CLOUDROOM_PREVIEW_SCRIPT_PATH, ...args]];

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

/** The helper checks every 10 s (POLL_SECONDS in client.py) plus the checks' own time, so 45 s avoids a false "offline". */
export async function previewStatus(deps: Deps, freshMs = 45_000) {
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
  const text = await readFile(macAccessFile(deps), "utf8").catch(() => null);
  if (text === null) return null;
  // A damaged file counts as Off, as in the helper; it never rejects (#109).
  try {
    const saved = JSON.parse(text);
    return macAccessLevels.includes(saved.level) ? saved.level as MacAccessLevel : saved.enabled === true ? "full" : "off";
  } catch { return "off"; }
}
export async function setMacAccess(deps: Deps, level: MacAccessLevel): Promise<void> {
  if (!macAccessSupported) throw new ApiError(409, "mac_access_unsupported", "Cloud agents can't use a Windows computer yet.");
  if (!supportedMacAccessLevels.includes(level)) throw new ApiError(400, "mac_access_unsupported", "Read and Ask need macOS. Pick Off or Full.");
  // Written whole, so the helper, which rereads it before each Mac job, never sees half a file.
  const file = macAccessFile(deps), temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ level }), { mode: 0o600 });
  await rename(temp, file);
}
/** Whether this app has set up its helper, which then needs each new Mac access level. */
export const previewsSetUp = (deps: Deps) => readFile(join(folder(deps), "config.json")).then(() => true, () => false);

// The helper outlives the app, so restart it once per launch: macOS only applies a newly granted Full Disk Access to new processes.
let restartedThisLaunch = false;

export async function setupPreviews(deps: Deps): Promise<void> {
  const launcher = process.platform === "darwin" && process.versions.electron ? ["--launcher", process.execPath] : [];
  const restart = restartedThisLaunch ? [] : ["--restart"];
  try {
    await promisify(execFile)(...helper(deps, ["configure", folder(deps), "--connection", join(deps.config.dataDir, "cloudroom.json"), "--mac-access", await macAccess(deps) ?? "off", ...launcher, ...restart, ...(devBuild(deps) ? ["--own-threads"] : [])]), { timeout: 30_000, maxBuffer: 64 * 1024 });
    restartedThisLaunch = true;
  } catch (error) {
    // The helper's own reason, such as launchctl's, so Settings and the API say why (#109).
    const { stderr, killed, code } = error as { stderr?: string; killed?: boolean; code?: unknown };
    const reason = killed ? "setup took over 30 seconds" : String(stderr ?? "").trim().split("\n").at(-1)?.slice(0, 300).replace(/\.$/, "") || String(code ?? "unknown error");
    throw new ApiError(503, "cloudroom_preview_setup", `Previews and Mac access could not start: ${reason}.`);
  }
}

/** The helper rewrites status.json at least every 30 s while it runs. */
export const helperRunning = (deps: Deps) => stat(join(folder(deps), "status.json")).then(info => Date.now() - info.mtimeMs < 90_000, () => false);

export async function stopPreviews(deps: Deps): Promise<void> {
  if (!await readFile(join(folder(deps), "config.json")).then(() => true, () => false)) return;
  try {
    await promisify(execFile)(...helper(deps, ["stop", folder(deps)]), { timeout: 20_000, maxBuffer: 64 * 1024 });
  } catch { throw new ApiError(503, "cloudroom_preview_stop", "Preview shutdown or SSH-key revocation could not be confirmed. Retry sign-out when the cloud is reachable."); }
}
