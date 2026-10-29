import { existsSync, readdirSync, statSync, statfsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { cpus, homedir, release, totalmem } from "node:os";
import { delimiter, join } from "node:path";
import { getAppSettings } from "@cloudroom/db";
import { execPortableFile, findCliExecutable, type KnownCli } from "@cloudroom/process-utils";
import { readOrCreateSecretFile } from "@cloudroom/secret-storage";
import type { AppDeps } from "../../types.js";
import { TELEMETRY_ID_FILE_NAME, type TelemetryValue } from "../system/telemetry.js";
import { claudeAuthStatus, claudeBinary, desktopClaude } from "./claude-token.js";
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

/** Seconds since this install's data folder was created, so every setup event lines up on one timeline. */
export const secondsSinceFirstLaunch = () => Math.max(0, Math.round((Date.now() - firstLaunchAt) / 1000));

export function startSetupTelemetry(appDeps: Deps): void {
  deps = appDeps;
  try { firstLaunchAt = statSync(appDeps.config.dataDir).birthtimeMs || firstLaunchAt; } catch { /* keep now */ }
  const marker = join(appDeps.config.dataDir, "cloudroom-setup-snapshot.json");
  setTimeout(() => {
    linkInstall();
    void reportUpdateAttempt(appDeps.config.dataDir).catch(error => appDeps.logger.debug({ err: error }, "Update report failed"));
    if (process.platform === "win32") void reportCrashes(appDeps.config.dataDir).catch(error => appDeps.logger.debug({ err: error }, "Crash report failed"));
    void readFile(marker).then(() => {}, async () => {
      await sendSnapshot("first_launch");
      await writeFile(marker, JSON.stringify({ sentAt: Date.now() }), { mode: 0o600 });
    }).catch(error => appDeps.logger.debug({ err: error }, "Setup snapshot failed"));
  }, 5_000).unref();
}

/** One Connect attempt in setup or Settings. The first failure of each app run also sends a fresh snapshot. */
export function reportAgentConnect(agent: "claude" | "codex", outcome: "ok" | "failed" | "cancelled", details: { code?: string | null; message?: string | null; ms?: number | null; cliVersion?: string | null; cliPlace?: string | null } = {}): void {
  capture("agent_connect", () => ({ agent, outcome, code: details.code ?? null, message: scrub(details.message), ms: details.ms ?? null, cli_version: details.cliVersion ?? null, cli_place: details.cliPlace ?? null }));
  if (outcome === "failed" && !failureSnapshotSent) {
    failureSnapshotSent = true;
    void sendSnapshot("connect_failed").catch(() => {});
  }
}

export function reportCliInstall(cli: KnownCli, trigger: "claude_connect" | "local_thread" | "repair", outcome: "ok" | "failed", ms: number, message?: string | null): void {
  capture("cli_install", () => ({ cli, trigger, outcome, ms, message: scrub(message) }));
}

export function reportSignInFailed(message: string): void {
  capture("account_sign_in_failed", () => ({ message: scrub(message) }));
}

/** Drops tokens, keys, emails, URL queries, long random strings, and home paths; keeps the last 300 characters. */
export function scrub(text: string | null | undefined): string | null {
  if (!text) return null;
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/\b(?:ey[A-Za-z0-9_-]{10,}\.){2}[A-Za-z0-9_-]+/g, "jwt-***")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "email-***")
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, "$1")
    .replace(/[A-Za-z0-9_-]{30,}/g, "***")
    .replaceAll(homedir(), "~")
    .replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"':]+/gi, "~")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-300) || null;
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
async function reportUpdateAttempt(dataDir: string): Promise<void> {
  const file = join(dataDir, "update-attempt.json");
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return;
  await rm(file, { force: true });
  const attempt = JSON.parse(text) as { from: string; to: string; at: number; location?: string; needs_password?: boolean; quit_timeout?: boolean; updater_error?: string };
  const version = process.env.BB_DESKTOP_VERSION ?? null;
  const failed = version === attempt.from;
  const lines = failed ? await shipItLines(attempt.at) : [];
  capture("update_install", () => ({
    outcome: failed ? "failed" : "ok", from: attempt.from, to: attempt.to, version, ms: Date.now() - attempt.at,
    // Set by the desktop app (desktop-update-resume.ts): why Squirrel.Mac may never have installed.
    location: attempt.location ?? null, needs_password: attempt.needs_password ?? null,
    quit_timeout: attempt.quit_timeout ?? false, updater_error: scrub(attempt.updater_error),
    ...(failed ? { code: updateFailureCode(lines), message: scrub(lines.filter(line => /error|abort|cancel|fail/i.test(line)).at(-1)) } : {}),
  }));
}

/** Windows: crashes the desktop app noted in last-crash.json (desktop-crash-report.ts) during the last run. */
async function reportCrashes(dataDir: string): Promise<void> {
  const file = join(dataDir, "last-crash.json");
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return;
  await rm(file, { force: true });
  const crashes = JSON.parse(text) as { what: string; reason: string; exit_code: number | null; logs?: string; version: string; at: number }[];
  for (const crash of crashes) {
    capture("app_crash", () => ({
      what: crash.what, reason: crash.reason, exit_code: crash.exit_code, version: crash.version,
      minutes_ago: Math.round((Date.now() - crash.at) / 60_000),
      logs: crash.logs?.split("\n").map(line => scrub(line)).filter(Boolean).join("\n") || null,
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

/** Links this install to its Cloudroom account, so its PostHog events map to a person. At startup and after sign-in. */
export const linkInstall = () => { void save("install_linked", {}); };

const helperProblems = new Map<string, number>();
export function reportMacHelperProblem(detail: string): void {
  const now = Date.now(), next = helperProblems.get(detail);
  if (next === undefined ? helperProblems.size >= 20 : next > now) return;
  helperProblems.set(detail, Infinity);
  void save("mac_helper", { outcome: "failed", message: scrub(detail), seconds_since_first_launch: secondsSinceFirstLaunch() }).then((saved) => {
    if (!saved) helperProblems.set(detail, now + 5 * 60_000);
  });
}

/** Telemetry must never break setup, so building or sending an event can't throw. */
function capture(name: "setup_snapshot" | "agent_connect" | "cli_install" | "account_sign_in_failed" | "update_install" | "app_crash", properties: () => Record<string, TelemetryValue>): void {
  try {
    const event: Record<string, TelemetryValue> = { ...properties(), seconds_since_first_launch: secondsSinceFirstLaunch() };
    deps?.telemetry.capture({ name, properties: event });
    if (event.outcome === "failed" || event.reason === "connect_failed") void save(name, event);
  } catch (error) { deps?.logger.debug({ err: error, event: name }, "Setup telemetry failed"); }
}

/** Saves an event with the signed-in account through the website. Signed out, telemetry off, or BB_TELEMETRY=false: nothing is sent. */
function save(event: string, context: Record<string, TelemetryValue>): Promise<boolean> {
  return Promise.resolve().then(async () => {
    if (!deps?.telemetryAllowed || !getAppSettings(deps.db).telemetryEnabled) return false;
    const installId = await readOrCreateSecretFile({ bytes: 16, dataDir: deps.config.dataDir, encoding: "hex", fileName: TELEMETRY_ID_FILE_NAME });
    await deps.sandboxes.setupEvent(event, { ...context, install_id: installId });
    return true;
  }).catch(error => { deps?.logger.debug({ err: error, event }, "Setup event not saved"); return false; });
}

const run = (file: string, args: string[]) => execPortableFile(file, args, { timeoutMs: 8_000 }).then(({ stdout }) => stdout.trim(), (error: { stdout?: unknown }) => (process.platform === "win32" ? "" : String(error.stdout ?? "").trim()));
const version = (text: string) => text.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? null;
const home = (...parts: string[]) => join(homedir(), ...parts);
const onPath = (cli: string) => (process.env.PATH ?? "").split(delimiter).some(dir => dir && existsSync(join(dir, cli)));
function daysSince(...paths: string[]): number | null {
  const times = paths.flatMap(path => { try { return [statSync(path).mtimeMs]; } catch { return []; } });
  return times.length ? Math.floor((Date.now() - Math.max(...times)) / 86_400_000) : null;
}
/** The newest entry's path inside `dir`, by name, `depth` levels down (Codex keeps sessions in YYYY/MM/DD folders). */
function newestPath(dir: string, depth: number): string {
  for (let level = 0; level < depth; level++) { const name = newest(dir); if (!name) break; dir = join(dir, name); }
  return dir;
}
function children(dir: string): string[] {
  try { return readdirSync(dir).map(name => join(dir, name)); } catch { return []; }
}
function newest(dir: string): string | null {
  try { return readdirSync(dir).filter(name => /^[0-9.]+$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1) ?? null; } catch { return null; }
}
async function appVersion(app: string): Promise<string | null> {
  const bundle = [join("/Applications", app), home("Applications", app)].find(path => existsSync(path));
  if (!bundle) return null;
  return version(await run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(bundle, "Contents", "Info.plist")])) ?? "unknown";
}
function jwtClaims(token: unknown): Record<string, unknown> | null {
  try { return typeof token === "string" ? JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as Record<string, unknown> : null; } catch { return null; }
}
const plan = (value: unknown) => (typeof value === "string" && /^[a-z_]{1,32}$/.test(value) ? value : null);

async function codexLogin(): Promise<Record<string, TelemetryValue>> {
  const text = await readFile(join(process.env.CODEX_HOME || home(".codex"), "auth.json"), "utf8").catch(() => null);
  if (text === null) return { codex_login: null, codex_plan: null, codex_token_expired: null };
  try {
    const auth = JSON.parse(text) as { OPENAI_API_KEY?: unknown; tokens?: { id_token?: unknown; access_token?: unknown } };
    const openai = jwtClaims(auth.tokens?.id_token)?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    const exp = jwtClaims(auth.tokens?.access_token)?.exp;
    return {
      codex_login: auth.tokens ? "chatgpt" : auth.OPENAI_API_KEY ? "api_key" : "unknown",
      codex_plan: plan(openai?.chatgpt_plan_type),
      codex_token_expired: typeof exp === "number" ? exp * 1000 < Date.now() : null,
    };
  } catch { return { codex_login: "unreadable", codex_plan: null, codex_token_expired: null }; }
}

async function sendSnapshot(reason: "first_launch" | "connect_failed"): Promise<void> {
  if (!deps) return;
  const claude = claudeBinary() ?? null, codex = findCliExecutable("codex") ?? null;
  const [osVersion, claudeVersion, codexVersion, claudeStatus, codexAuth, claudeApp, codexApp, chatgptApp, proxy, logins, access] = await Promise.all([
    process.platform === "darwin" ? run("/usr/bin/sw_vers", ["-productVersion"]) : Promise.resolve(release()),
    claude ? run(claude, ["--version"]).then(version) : null,
    codex ? run(codex, ["--version"]).then(version) : null,
    claudeAuthStatus(),
    codexLogin(),
    appVersion("Claude.app"),
    appVersion("Codex.app"),
    appVersion("ChatGPT.app"),
    process.platform === "darwin" ? run("/usr/sbin/scutil", ["--proxy"]) : Promise.resolve(""),
    copyLogins(deps),
    macAccess(deps),
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
    claude_logged_in: typeof claudeStatus?.loggedIn === "boolean" ? claudeStatus.loggedIn : null,
    claude_plan: plan(claudeStatus?.subscriptionType),
    claude_app_version: claudeApp,
    claude_app_cli_version: desktopClaude() ? newest(home("Library/Application Support/Claude/claude-code")) : null,
    claude_last_used_days: daysSince(home(".claude", "history.jsonl"), ...children(home(".claude", "projects"))),
    codex_cli_place: cliPlace(codex),
    codex_cli_on_path: onPath("codex"),
    codex_cli_version: codexVersion,
    ...codexAuth,
    codex_app_version: codexApp,
    chatgpt_app_version: chatgptApp,
    codex_last_used_days: daysSince(home(".codex", "history.jsonl"), newestPath(home(".codex", "sessions"), 3)),
    old_bb_data: existsSync(home(".bb")),
    dev_build_data: existsSync(home(".gui-cloudroom-dev")),
    env_proxy: ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].some(name => Boolean(process.env[name])),
    system_proxy: /(HTTPS|HTTP|ProxyAutoConfig|ProxyAutoDiscovery)Enable\s*:\s*1/.test(proxy),
    copy_logins: logins,
    mac_access: access,
  }));
}
