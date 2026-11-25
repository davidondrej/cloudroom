import { existsSync, statSync, statfsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { cpus, homedir, release, totalmem } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { getAppSettings } from "@cloudroom/db";
import { stripTextGitUrlCredentials } from "@cloudroom/domain";
import { execPortableFile, findCliExecutable, type KnownCli } from "@cloudroom/process-utils";
import { readOrCreateSecretFile } from "@cloudroom/secret-storage";
import type { AppDeps } from "../../types.js";
import { TELEMETRY_ID_FILE_NAME, type TelemetryValue } from "../system/telemetry.js";
import { claudeAuthStatus, claudeBinary } from "./claude-token.js";
import { macAccess } from "./previews.js";
import type { SandboxDirectory } from "./sandboxes.js";
import { copyLogins } from "./sync.js";

/**
 * Onboarding telemetry (ADR 0198): a snapshot of this Mac's agent setup, plus connect and install results.
 * Only categories, versions, booleans, and day counts. Never paths, emails, tokens, or file contents.
 * Failures also go to our database with the account (ADR 0201).
 */
type Deps = Pick<AppDeps, "telemetry" | "config" | "logger" | "db"> & { sandboxes: Pick<SandboxDirectory, "setupEvent">; telemetryAllowed: boolean };
let deps: Deps | null = null;
let firstLaunchAt = Date.now();
let failureSnapshotSent = false;
let cloudFailureSnapshotSent = false;
type UpdateAttempt = { from: string; to: string; at: number; location?: string; needs_password?: boolean; quit_timeout?: boolean; updater_error?: string; yielded?: boolean };
let updateAttempt: Promise<UpdateAttempt | null> = Promise.resolve(null);
let appReadySeen = false;

/** Seconds since this install's data folder was created, so every setup event lines up on one timeline. */
export const secondsSinceFirstLaunch = () => Math.max(0, Math.round((Date.now() - firstLaunchAt) / 1000));
const sharingEnabled = (current: Deps | null): current is Deps =>
  Boolean(current?.telemetryAllowed && getAppSettings(current.db).telemetryEnabled);

export function startSetupTelemetry(appDeps: Deps): void {
  deps = appDeps;
  try { firstLaunchAt = statSync(appDeps.config.dataDir).birthtimeMs || firstLaunchAt; } catch { /* keep now */ }
  const marker = join(appDeps.config.dataDir, "cloudroom-setup-snapshot.json");
  updateAttempt = readFile(join(appDeps.config.dataDir, "update-attempt.json"), "utf8").then(text => JSON.parse(text) as UpdateAttempt).catch(() => null);
  setTimeout(() => {
    linkInstall();
    void reportUpdateAttempt(appDeps.config.dataDir).catch(error => appDeps.logger.debug({ err: error }, "Update report failed"));
    void reportCrashes(appDeps.config.dataDir).catch(error => appDeps.logger.debug({ err: error }, "Crash report failed"));
    if (process.platform === "win32") void reportWindowsInstall().catch(error => appDeps.logger.debug({ err: error }, "Install report failed"));
    void readFile(marker).then(() => {}, async () => {
      if (await sendSnapshot("first_launch")) {
        await writeFile(marker, JSON.stringify({ sentAt: Date.now() }), { mode: 0o600 });
      }
    }).catch(error => appDeps.logger.debug({ err: error }, "Setup snapshot failed"));
  }, 5_000).unref();
}

/** One Connect attempt in setup or Settings. The first failure of each app run also sends a fresh snapshot.
 *  Claude only: `linkMs` is when its CLI printed the sign-in link, `uiSeenAgoS` how long ago a screen last watched it. */
export function reportAgentConnect(agent: "claude" | "codex", outcome: "ok" | "failed" | "cancelled", details: { code?: string | null; message?: string | null; ms?: number | null; cliVersion?: string | null; cliPlace?: string | null; linkMs?: number | null; uiSeenAgoS?: number | null } = {}): void {
  capture("agent_connect", () => ({
    agent, outcome, code: details.code ?? null, message: scrub(details.message), ms: details.ms ?? null, cli_version: details.cliVersion ?? null, cli_place: details.cliPlace ?? null,
    link_after_ms: details.linkMs ?? null, ui_seen_ago_s: details.uiSeenAgoS ?? null,
  }));
  if (outcome === "failed" && !failureSnapshotSent && sharingEnabled(deps)) {
    failureSnapshotSent = true;
    void sendSnapshot("connect_failed").catch(() => {});
  }
}

/** Cloud refused a thread's start. The first time each app run, a snapshot with a network check, saved with the account. */
export function reportCloudFailure(): void {
  if (cloudFailureSnapshotSent || !sharingEnabled(deps)) return;
  cloudFailureSnapshotSent = true;
  void sendSnapshot("cloud_failed").catch(() => {});
}

export function reportCliInstall(cli: KnownCli, trigger: "claude_connect" | "codex_connect" | "local_thread" | "repair", outcome: "ok" | "failed", ms: number, message?: string | null): void {
  capture("cli_install", () => ({ cli, trigger, outcome, ms, message: scrub(message) }));
}

export function reportSignInFailed(message: string): void {
  capture("account_sign_in_failed", () => ({ message: scrub(message) }));
}

/** A file path: `~/…`, `C:\…` (with `Program Files`), or `/…` not inside a URL or a word like `and/or`. */
const PATH = /(?:~|(?<!\w)[A-Za-z]:|(?<![\w.:/\\~-]))[\\/](?:Program Files(?: \(x86\))?[\\/])?[^\s"'`<>|,;()]+/g;
const WORKTREE = /[\\/]worktrees(?:[\\/]|$)/i;
/** Tool and system folders: they say which install ran and name nothing of the user's. Any other path may name a project. */
const TOOL_PATH = /^(?:~[\\/](?:\.|AppData|Library)|[A-Za-z]:[\\/](?:Program Files|ProgramData|Windows)|\/(?:usr|opt|bin|sbin|etc|nix|snap|Applications|System|Library)(?:\/|$))/i;
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const KNOWN_TOKEN = /\b(?:(?:gh[pousr]|github_pat|whsec|polar_oat|sbp)_[A-Za-z0-9_-]{8,}|(?:glpat|xox[baprs])-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/g;

function scrubSecrets(text: string): string {
  return stripTextGitUrlCredentials(text)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/gi, "$1***@")
    .replace(PRIVATE_KEY, "<private-key>")
    .replace(/\bBearer\s+[^\s"',;]+|\bBasic\s+[A-Za-z0-9+/=]{8,}/g, match => `${match.split(/\s/)[0]} ***`)
    .replace(/\b((?:api[_-]?)?key|(?:access[_-]?|refresh[_-]?)?token|(?:client[_-]?)?secret|password|passwd|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, "$1$2***")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(KNOWN_TOKEN, "***")
    .replace(/\b(?:ey[A-Za-z0-9_-]{10,}\.){2}[A-Za-z0-9_-]+/g, "jwt-***")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "email-***")
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, "$1");
}

function scrubPaths(text: string): string {
  return text
    .replace(/file:\/\/\S+/gi, "<path>")
    .replaceAll(homedir(), "~")
    .replace(/(?<![\w.:/\\~-])\/(?:Users|home)\/[^/\s"'`<>|,;()]+/g, "~")
    .replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"':]+/gi, "~")
    // One segment from the root is a slash command, like Claude's `/login`. A worktree under a dot folder
    // (`~/.gui-cloudroom/.../worktrees/`, `~/.codex/worktrees/`) holds a project, so it is never a tool folder.
    .replace(PATH, path => !WORKTREE.test(path) && (TOOL_PATH.test(path) || /^\/[^/\\]+$/.test(path)) ? path : "<path>");
}

/** Drops tokens, keys, credentials, emails, URL queries, long random strings, and every path outside tool and system
 *  folders (ADR 0198); keeps the last 300 characters. */
export function scrub(text: string | null | undefined): string | null {
  if (!text) return null;
  return scrubPaths(scrubSecrets(text).replace(/[A-Za-z0-9_-]{30,}/g, "***"))
    .replace(/\s+/g, " ")
    .trim()
    .slice(-300) || null;
}

/** Scrubs secrets, emails, URL queries, and private paths from longer agent feedback without dropping newlines or normal identifiers. */
export function scrubFeedback(text: string): string {
  return scrubPaths(
    scrubSecrets(text)
      .replace(/\b[0-9a-fA-F]{32,}\b/g, "***")
      .replace(/\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]+\b/g, "***"),
  ).trim();
}

/** Where a CLI lives, as a category. */
export function cliPlace(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.includes("/Claude/claude-code/")) return "claude_app";
  if (path.includes(".app/")) return "app_bundle";
  if (path.includes("/.local/bin/")) return "local_bin";
  if (/\/(\.npm-global|\.nvm|\.volta|\.bun|\.fnm|\.asdf|node_modules|pnpm)\//.test(path)) return "npm";
  if (path.startsWith("/opt/homebrew/") || path.startsWith("/usr/local/")) return "homebrew";
  return "other";
}

/**
 * "Restart to update" leaves update-attempt.json (desktop-update-resume.ts). Still on the old version
 * means the install failed, so report why from macOS's installer log. Failures reach our database.
 */
/** Windows: the installer leaves how long it took next to Cloudroom.exe (build/installer.nsh). Sent once. */
async function reportWindowsInstall(): Promise<void> {
  if (!sharingEnabled(deps)) return;
  const file = join(dirname(process.execPath), "install-timing.json");
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return;
  await rm(file, { force: true });
  const { ms, update, staged, swap_ms, lock_wait_ms, prompts } = JSON.parse(text) as Record<string, unknown>;
  const count = (value: unknown) => typeof value === "number" && value >= 0 ? value : null;
  // lock_wait_ms: setup waited for Cloudroom.exe to unlock. prompts: "Cloudroom is still running" dialogs shown.
  // staged: the update swapped in a version unpacked in the background (#2525); swap_ms is that swap alone.
  if (typeof ms === "number" && ms >= 0) capture("windows_install", () => ({ ms, update: update === true, staged: staged === true, swap_ms: count(swap_ms), lock_wait_ms: count(lock_wait_ms), prompts: count(prompts) }));
}

async function reportUpdateAttempt(dataDir: string): Promise<void> {
  if (!sharingEnabled(deps)) return;
  const attempt = await updateAttempt;
  if (attempt === null) return;
  await rm(join(dataDir, "update-attempt.json"), { force: true });
  const version = process.env.BB_DESKTOP_VERSION ?? null;
  const failed = version === attempt.from;
  const lines = failed ? await shipItLines(attempt.at) : [];
  capture("update_install", () => ({
    outcome: failed ? "failed" : "ok", from: attempt.from, to: attempt.to, version, ms: Date.now() - attempt.at,
    // Set by the desktop app (desktop-update-resume.ts): why Squirrel.Mac may never have installed.
    location: attempt.location ?? null, needs_password: attempt.needs_password ?? null,
    quit_timeout: attempt.quit_timeout ?? false, updater_error: scrub(attempt.updater_error),
    ...(failed ? { code: updateFailureCode(lines), message: scrub(lines.filter(line => /error|abort|cancel|fail/i.test(line)).at(-1)) } : {}),
  }), { yielded: attempt.yielded === true });
}

export function reportAppReady(): void {
  if (appReadySeen) return;
  appReadySeen = true;
  void updateAttempt.then(attempt => {
    if (attempt === null || attempt.from === (process.env.BB_DESKTOP_VERSION ?? null)) return;
    capture("update_ready", () => ({ from: attempt.from, to: attempt.to, ms: Date.now() - attempt.at }));
  });
}

/** Crashes the desktop app noted in last-crash.json (desktop-crash-report.ts) during the last run. Every platform. */
async function reportCrashes(dataDir: string): Promise<void> {
  if (!sharingEnabled(deps)) return;
  const file = join(dataDir, "last-crash.json");
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return;
  await rm(file, { force: true });
  const crashes = JSON.parse(text) as { what: string; reason: string; exit_code: number | null; logs?: string; attempt?: number; cause?: string; version: string; at: number }[];
  for (const crash of crashes) {
    capture("app_crash", () => ({
      what: crash.what, reason: crash.reason, exit_code: crash.exit_code, version: crash.version, attempt: crash.attempt ?? null, cause: crash.cause ?? null,
      minutes_ago: Math.round((Date.now() - crash.at) / 60_000),
      // The newest 8,000 characters: the events endpoint drops an event whose properties pass 16 KB as JSON.
      logs: crash.logs?.split("\n").map(line => scrub(line)).filter(Boolean).join("\n").slice(-8_000) || null,
    }));
  }
}

/** ShipIt's log lines since the attempt, without their timestamp prefix. Its timestamps are local time. */
async function shipItLines(since: number): Promise<string[]> {
  const log = await readFile(home("Library", "Caches", "dev.cloudroom.gui.ShipIt", "ShipIt_stderr.log"), "utf8").catch(() => "");
  return log.split("\n").filter(line => Date.parse(line.slice(0, 23).replace(" ", "T")) >= since).map(line => line.slice(24));
}

function updateFailureCode(lines: string[]): string {
  const log = lines.join("\n");
  if (!log) return "installer_never_ran";
  if (/App Still Running|running instances of the target app/.test(log)) return "app_still_running";
  if (/Failed to copy bundle/.test(log)) return "copy_failed";
  return "installer_failed";
}

/** Links this install to its Cloudroom account, so its usage events map to an account. At startup and after sign-in. */
export const linkInstall = () => { void save("install_linked", {}); };

const helperProblems = new Map<string, number>();
export function reportMacHelperProblem(detail: string): void {
  if (!sharingEnabled(deps)) return;
  const now = Date.now(), next = helperProblems.get(detail);
  if (next === undefined ? helperProblems.size >= 20 : next > now) return;
  helperProblems.set(detail, Infinity);
  void save("mac_helper", { outcome: "failed", message: scrub(detail), seconds_since_first_launch: secondsSinceFirstLaunch() }).then((saved) => {
    if (!saved) helperProblems.set(detail, now + 5 * 60_000);
  });
}

/** Mac access is on, but its helper didn't start (#109). One try per UTC day; the marker keeps it to one a day per install. */
let helperDownDay = "";
export function reportMacHelperDown(message: string): void {
  const day = new Date().toISOString().slice(0, 10);
  if (!sharingEnabled(deps) || helperDownDay === day) return;
  helperDownDay = day;
  const marker = join(deps.config.dataDir, "cloudroom-mac-helper-down.txt");
  void readFile(marker, "utf8").catch(() => "").then(async (last) => {
    if (last === day) return;
    if (await save("mac_helper", { outcome: "failed", code: "helper_not_running", message: scrub(message), seconds_since_first_launch: secondsSinceFirstLaunch() })) await writeFile(marker, day, { mode: 0o600 });
  }).catch(() => {});
}

/** Telemetry must never break setup, so building or sending an event can't throw. `eventOnly` never reaches our database. */
function capture(name: "setup_snapshot" | "agent_connect" | "cli_install" | "account_sign_in_failed" | "update_install" | "update_ready" | "app_crash" | "windows_install", properties: () => Record<string, TelemetryValue>, eventOnly: Record<string, TelemetryValue> = {}): void {
  if (!sharingEnabled(deps)) return;
  try {
    const event: Record<string, TelemetryValue> = { ...properties(), seconds_since_first_launch: secondsSinceFirstLaunch() };
    deps.telemetry.capture({ name, properties: { ...event, ...eventOnly } });
    if (event.outcome === "failed" || event.reason === "connect_failed" || event.reason === "cloud_failed") void save(name, event);
  } catch (error) { deps?.logger.debug({ err: error, event: name }, "Setup telemetry failed"); }
}

/** Saves an event with the signed-in account through the website. Signed out, telemetry off, or opted out via env var: nothing is sent. */
function save(event: string, context: Record<string, TelemetryValue>): Promise<boolean> {
  return Promise.resolve().then(async () => {
    if (!sharingEnabled(deps)) return false;
    const installId = await readOrCreateSecretFile({ bytes: 16, dataDir: deps.config.dataDir, encoding: "hex", fileName: TELEMETRY_ID_FILE_NAME });
    await deps.sandboxes.setupEvent(event, { ...context, install_id: installId });
    return true;
  }).catch(error => { deps?.logger.debug({ err: error, event }, "Setup event not saved"); return false; });
}

const run = (file: string, args: string[]) => execPortableFile(file, args, { timeoutMs: 8_000 }).then(({ stdout }) => stdout.trim(), (error: { stdout?: unknown }) => (process.platform === "win32" ? "" : String(error.stdout ?? "").trim()));
const version = (text: string) => text.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? null;
const home = (...parts: string[]) => join(homedir(), ...parts);
const onPath = (cli: string) => (process.env.PATH ?? "").split(delimiter).some(dir => dir && existsSync(join(dir, cli)));

/** Which agents are signed in on this computer: `claude`, `codex`, `both`, or `none`.
 *  Only checks CLI status / file existence; never reads credential file contents. */
export async function localLogins(): Promise<string> {
  const claude = await claudeAuthStatus().catch(() => null);
  const claudeIn = claude?.loggedIn === true;
  const codexIn = existsSync(join(process.env.CODEX_HOME || home(".codex"), "auth.json"));
  return claudeIn && codexIn ? "both" : claudeIn ? "claude" : codexIn ? "codex" : "none";
}

/** Our website and the Claude and ChatGPT sign-in hosts, reached the way this app and the agent CLIs reach them, not the
 *  browser. Any HTTP answer counts: `<name>_ms`, or `<name>_error` when none came. */
const NETWORK_HOSTS = { website: "https://www.cloudroom.dev", claude: "https://platform.claude.com", openai: "https://auth.openai.com" };
async function networkCheck(): Promise<Record<string, TelemetryValue>> {
  const results = await Promise.all(Object.entries(NETWORK_HOSTS).map(async ([name, url]) => {
    const started = Date.now();
    const error = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(5_000) }).then(() => null, networkError);
    return { [`${name}_ms`]: error ? null : Date.now() - started, [`${name}_error`]: error };
  }));
  return Object.assign({}, ...results);
}
/** fetch() keeps the network's own code (ENOTFOUND, ECONNRESET, CERT_HAS_EXPIRED) in `error.cause`. */
function networkError(error: unknown): string {
  if ((error as { name?: unknown } | null)?.name === "TimeoutError") return "timeout";
  const code = String((error as { cause?: { code?: unknown } } | null)?.cause?.code ?? "");
  return /ENOTFOUND|EAI_AGAIN/.test(code) ? "dns"
    : /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO/.test(code) ? "tls"
    : /TIMEDOUT|CONNECT_TIMEOUT/.test(code) ? "timeout"
    : /UNREACH|ENETDOWN/.test(code) ? "unreachable"
    : code === "ECONNREFUSED" ? "refused"
    : /ECONNRESET|EPIPE|SOCKET/.test(code) ? "reset"
    : "other";
}
/** The system proxy settings: macOS's `scutil --proxy`, or Windows' Internet Settings (ProxyEnable, AutoConfigURL). */
const proxySettings = () => process.platform === "darwin" ? run("/usr/sbin/scutil", ["--proxy"])
  : process.platform === "win32" ? run(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe"), ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"])
  : Promise.resolve("");

async function sendSnapshot(reason: "first_launch" | "connect_failed" | "cloud_failed"): Promise<boolean> {
  if (!sharingEnabled(deps)) return false;
  const claude = claudeBinary() ?? null, codex = findCliExecutable("codex") ?? null;
  // A failure's snapshot also checks the network.
  const network = reason !== "first_launch" ? networkCheck() : {};
  const [osVersion, claudeVersion, codexVersion, proxy, logins, access, reach] = await Promise.all([
    process.platform === "darwin" ? run("/usr/bin/sw_vers", ["-productVersion"]) : Promise.resolve(release()),
    claude ? run(claude, ["--version"]).then(version) : null,
    codex ? run(codex, ["--version"]).then(version) : null,
    proxySettings(),
    copyLogins(deps),
    macAccess(deps),
    network,
  ]);
  let diskFreeGb: number | null = null;
  try { const disk = statfsSync(homedir()); diskFreeGb = Math.round((disk.bavail * disk.bsize) / 1e9); } catch { /* unknown */ }
  capture("setup_snapshot", () => ({
    reason,
    os_version: osVersion || null,
    cpu: cpus()[0]?.model.trim().slice(0, 60) ?? null,
    ram_gb: Math.round(totalmem() / 1e9),
    disk_free_gb: diskFreeGb,
    shell: process.env.SHELL?.split("/").at(-1) ?? null,
    data_dir_age_days: Math.floor(secondsSinceFirstLaunch() / 86_400),
    claude_cli_place: cliPlace(claude),
    claude_cli_on_path: onPath("claude"),
    claude_cli_version: claudeVersion,
    codex_cli_place: cliPlace(codex),
    codex_cli_on_path: onPath("codex"),
    codex_cli_version: codexVersion,
    old_bb_data: existsSync(home(".bb")),
    dev_build_data: existsSync(home(".gui-cloudroom-dev")),
    env_proxy: ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].some(name => Boolean(process.env[name])),
    system_proxy: /(HTTPS|HTTP|ProxyAutoConfig|ProxyAutoDiscovery)Enable\s*:\s*1|ProxyEnable\s+REG_DWORD\s+0x1\b|AutoConfigURL\s+REG_SZ\s+\S/.test(proxy),
    copy_logins: logins,
    mac_access: access,
    ...reach,
  }));
  return true;
}
