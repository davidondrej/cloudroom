import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { appendFile, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { COMPUTER_TITLE } from "@cloudroom/domain/computer-name";
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

/** This Mac's helper device, the one that takes Mac jobs from cloud sandboxes, or null before setup. */
export async function helperDevice(deps: Deps): Promise<string | null> {
  const config = await readFile(join(folder(deps), "config.json"), "utf8").then(text => JSON.parse(text), () => null);
  return typeof config?.device === "string" && /^[0-9a-f]{32}$/.test(config.device) ? config.device : null;
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

/** How much cloud agents may do on this computer (ADR 0113, levels in ADR 0186), or null until first-run setup asks. The preview helper runs Mac access, in Git Bash on Windows (#958). */
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
  if (!supportedMacAccessLevels.includes(level)) throw new ApiError(400, "mac_access_unsupported", "Read and Ask need macOS. Pick Off or Full.");
  // Written whole, so the helper, which rereads it before each Mac job, never sees half a file.
  const file = macAccessFile(deps), temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ level }), { mode: 0o600 });
  await rename(temp, file);
}
/** Mirrors the Jev Mac-command security review switch for the helper, which rereads it before each command. */
const macReviewFile = (deps: Deps) => join(deps.config.dataDir, "cloudroom-mac-review.json");
const macReviewWriteQueues = new Map<string, Promise<void>>();
export function setMacCommandReview(deps: Deps, enabled: boolean): Promise<void> {
  const file = macReviewFile(deps);
  const previous = macReviewWriteQueues.get(file) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ enabled }), { mode: 0o600 });
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  });
  const settled = next.finally(() => {
    if (macReviewWriteQueues.get(file) === settled) macReviewWriteQueues.delete(file);
  });
  macReviewWriteQueues.set(file, settled);
  return next;
}
/** Whether this app has set up its helper, which then needs each new Mac access level. */
export const previewsSetUp = (deps: Deps) => readFile(join(folder(deps), "config.json")).then(() => true, () => false);

// The helper outlives the app, so restart it once per launch: macOS only applies a newly granted Full Disk Access to new processes.
let restartedThisLaunch = false;

// Windows puts the app's room-cli on no PATH, so Mac jobs, which run in Git Bash, get its folder (#958).
const roomCliFolder = () => (process.platform === "win32" && process.env.ROOM_CLI ? { CLOUDROOM_ROOM_CLI: dirname(process.env.ROOM_CLI) } : {});

// The server's own credentials never reach the preview helper (which stays resident on Windows).
function helperEnv(deps: Deps): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLOUDROOM_SERVER_URL: `http://127.0.0.1:${deps.config.serverPort}`, ...roomCliFolder() };
  delete env.BB_SERVER_HEADERS;
  delete env.BB_CONNECT_MACHINE_CREDENTIAL;
  return env;
}

// Mac jobs point a nested room-cli at this server, the one that owns the helper, not whichever the CLI finds (#1243, #1290).
// An environment variable, as for CLOUDROOM_SHELL_PATH, so an older helper ignores it instead of failing on a new flag.
export async function setupPreviews(deps: Deps): Promise<void> {
  const launcher = process.platform === "darwin" && process.versions.electron ? ["--launcher", process.execPath] : [];
  const restart = restartedThisLaunch ? [] : ["--restart"];
  try {
    await promisify(execFile)(...helper(deps, ["configure", folder(deps), "--connection", join(deps.config.dataDir, "cloudroom.json"), "--mac-access", await macAccess(deps) ?? "off", ...launcher, ...restart, ...(devBuild(deps) ? ["--own-threads"] : [])]), { timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true, env: helperEnv(deps) });
    restartedThisLaunch = true;
  } catch (error) {
    // The helper's own reason, such as launchctl's, so Settings and the API say why (#109).
    const { stderr, killed, code } = error as { stderr?: string; killed?: boolean; code?: unknown };
    const reason = killed ? "setup took over 30 seconds" : String(stderr ?? "").trim().split("\n").at(-1)?.slice(0, 300).replace(/\.$/, "") || String(code ?? "unknown error");
    const repair = process.platform === "win32" ? windowsPreviewRepair(reason, folder(deps), `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ""}${userInfo().username}`) : null;
    throw new ApiError(503, "cloudroom_preview_setup", `Previews and ${COMPUTER_TITLE} access could not start: ${repair ?? `${reason}.`}`);
  }
}

/** Windows: an elevated Cloudroom or installer left files in the helper's folder that only Administrators can open, so the
 *  normal app gets "Permission denied" every launch (#2459). The repair needs an elevated shell once. */
export function windowsPreviewRepair(reason: string, dir: string, user: string): string | null {
  if (!/\[(?:Errno 13|WinError 5)\].*cloudroom-preview/.test(reason)) return null;
  // Single-quoted, so PowerShell expands nothing in a path or name ($, backticks). It reads curly single quotes as quotes too.
  // One grant on the folder itself: Windows passes it down to the files there. No /T, which walks into a junction inside
  // the folder even with /L; /L changes a link itself, never what it points to.
  const literal = (text: string) => `'${text.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
  return `Windows won't let Cloudroom open its preview files, probably because Cloudroom or its installer ran as administrator. Open PowerShell as administrator, run icacls ${literal(dir)} /grant ${literal(`${user}:(OI)(CI)F`)} /C /L and restart Cloudroom.`;
}

/** The helper rewrites status.json at least every 30 s while it runs. */
export const helperRunning = (deps: Deps) => stat(join(folder(deps), "status.json")).then(info => Date.now() - info.mtimeMs < 90_000, () => false);

export async function stopPreviews(deps: Deps): Promise<void> {
  if (!await readFile(join(folder(deps), "config.json")).then(() => true, () => false)) return;
  try {
    await promisify(execFile)(...helper(deps, ["stop", folder(deps)]), { timeout: 20_000, maxBuffer: 64 * 1024, windowsHide: true });
  } catch { throw new ApiError(503, "cloudroom_preview_stop", "Preview shutdown or SSH-key revocation could not be confirmed. Retry sign-out when the cloud is reachable."); }
}
