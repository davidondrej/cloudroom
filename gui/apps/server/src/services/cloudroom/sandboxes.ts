import { execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import type { HostDaemonContributedEnvEntry } from "@cloudroom/host-daemon-contract";
import { cursorAuthFile, execPortableFile, findCliExecutable, killPortableProcess, spawnPortableProcess, tarCommand, userEnvironmentEntries } from "@cloudroom/process-utils";
import { rawThreadIdSchema, reasoningLevelSchema, COMPUTER } from "@cloudroom/domain";
import { z } from "zod";
import { hasSupportedFrontmatterDelimiter, parseFrontmatter } from "../skills/injected-skills.js";
import { macClaudeSignedIn } from "./claude-token.js";
import { CloudroomConnectionError, CloudroomError } from "./client.js";
import { macHarnessVersions } from "./harness-versions.js";
import { cancelMcpSignIns, isRemoteMcp, mcpSignInKey, needsMcpSignIn, type McpSignIn, type RemoteMcpServer } from "./mcp-login.js";

export const SANDBOX_PREFIX = "sandbox:";
export const sandboxThread = (coreUrl: string) => coreUrl.startsWith(SANDBOX_PREFIX) ? coreUrl.slice(SANDBOX_PREFIX.length) : null;
export class SandboxAsleep extends Error {}

const viewSchema = z.object({
  thread: z.string(), state: z.enum(["new", "awake", "asleep", "archived", "deleted", "failed"]), generation: z.number(),
  issue: z.string().nullable(), origin: z.string().url().optional(), token: z.string().optional(),
  startup: z.object({ source: z.enum(["spare", "image", "template", "backup", "resume", "restart", "reuse"]), duration_ms: z.number().nonnegative() }).optional().catch(undefined),
  /** The sandbox runs on the user's own VPS (ADR 0319). */
  vps: z.boolean().optional(),
});
type View = z.infer<typeof viewSchema>;
// Threads the website started (ADR 0239, 0267): `source` is the automation's own Cloud thread or the thread that
// launched it, and `harness`/`model`/`reasoning` the thread's own agent (ADR 0250).
const runSchema = z.object({ thread: rawThreadIdSchema, project: z.string(), title: z.string().nullable(), session: z.string().regex(/^cr_[A-Za-z0-9_-]{1,80}$/), source: z.string(),
  harness: z.string().nullable().optional().catch(null), model: z.string().nullable().optional().catch(null), reasoning: reasoningLevelSchema.nullable().optional().catch(null) });
export type AutomationRun = z.infer<typeof runSchema>;
const awakeSchema = z.object({
  sandboxes: z.array(z.object({ thread: z.string(), origin: z.string().url(), token: z.string() })),
  runs: z.array(runSchema).catch([]).default([]),
  recheck_ms: z.number().int().min(1_000).max(3_600_000).catch(60_000),
});
export type SandboxAccount = { website: string; userId: string; token: string };
type AccountRequest = { account: SandboxAccount; signal: AbortSignal };
export type SandboxConnection = { url: string; token: string };
export type SandboxTrigger = "app_launch" | "app_activity" | "composer" | "thread_typing" | "thread_view";
/** Why a sleeping thread wakes before any work is sent: the user opened it or started typing (ADR 0176). */
export type SandboxWakeTrigger = Extract<SandboxTrigger, "thread_typing" | "thread_view">;
/** Logins the website keeps for every sandbox of an account (ADR 0145). */
export type SandboxLogin = "claude" | "codex" | "pi" | "github" | "cursor" | "opencode" | "mcp" | "hermes" | "devin" | "openclaw";
/** GitHub projects also name their repository and cloud folder, so the website can build a template. */
export type SandboxProject = { id: string; repository: string | null; folder: string };
const RECHECK_MS = 60_000;
const PRELOAD_BATCH = 10, PRELOADS_PER_HOUR = 30, PRELOAD_AGAIN_MS = 3_600_000;
const placeOf = (thread: string, project: SandboxProject) => ({ thread, project: project.id, ...(project.repository ? { repository: project.repository, folder: project.folder } : {}) });
export type CloudQueue = { position: number; total: number; regionBlocked: boolean };
/** The account's Cloud Credits in the rolling 30 days (ADR 0307), for the sidebar card; null credits while metering is stale.
 *  `og` is the OG letter, which the website sends only to OGs still on the free Pro it gave them (ADR 0218). */
export type PlanUsage = { plan: string; credits: number | null; creditsLimit: number; og: { name: string | null; endsAt: string } | null };
const USAGE_LIMIT = "cloud_usage_limit";
const AGENT_LIMIT = "cloud_agent_limit";
const CLOUD_QUEUE = "cloud_queue";
const CLOUD_REGION = "cloud_region";
// The Mac's skills and global instructions that sandboxes receive, one way (docs/scopes/sandboxes.md).
const SKILL_ROOTS = [".agents/skills", ".claude/skills", ".codex/skills", ".pi/agent/skills"];
const INSTRUCTION_FILES = [".claude/CLAUDE.md", ".codex/AGENTS.md", ".pi/agent/AGENTS.md", ".config/opencode/AGENTS.md"];
const CONFIG_LIMIT = 45 * 1024 * 1024;
const codexAuthPath = () => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
export const hasMacCodexLogin = () => access(codexAuthPath()).then(() => true, () => false);

/** The account's cloud Claude login while this Mac's Claude Code is signed out (ADR 0175). */
let cloudClaude: Record<string, string> | null = null;
/** Variables that sign in Local Claude threads with it. The Mac's Keychain and terminal `claude` stay untouched. */
export const cloudClaudeEnvironment = (): HostDaemonContributedEnvEntry[] => Object.entries(cloudClaude ?? {})
  .map(([name, value]) => ({ name, value, source: { core: "machine-environment" }, reason: "Cloud Claude login" }));
// Same variables as Core's (core/src/runtime/claude.rs): Claude prefers an API key over a token, so pass only one.
function claudeVariables(value: string): Record<string, string> | null {
  const { token, plan, apiKey } = JSON.parse(value) as Record<string, unknown>;
  if (typeof apiKey === "string" && apiKey) return { ANTHROPIC_API_KEY: apiKey };
  if (typeof token !== "string" || !token) return null;
  return { CLAUDE_CODE_OAUTH_TOKEN: token, ...(typeof plan === "string" && plan ? { CLAUDE_CODE_SUBSCRIPTION_TYPE: plan } : {}) };
}

/** Why `codex login` failed: Codex's own last line, with a fix for `forced_login_method = "api"`, which blocks the ChatGPT sign-in Cloudroom needs. */
export function codexLoginFailure(output: string): string {
  if (!output.includes("ChatGPT login is disabled")) {
    const last = output.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").at(-1)?.trim().slice(0, 300);
    return last ? `Codex sign-in failed: ${last}` : "Codex sign-in did not finish. Click Connect to try again.";
  }
  const config = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  return `Codex on this ${COMPUTER} only allows API-key login, but Cloudroom needs ChatGPT sign-in. Remove \`forced_login_method = "api"\` from ${config}, then click Connect again. If the file is locked, run \`chflags nouchg ${config}\` first.`;
}

type MacCodexLogin = { child: ChildProcess; url: string | null; error: string | null; done: boolean };
let macCodexLoginRun: MacCodexLogin | null = null;
/** Runs `codex login` on this Mac. Codex opens the default browser and saves the login itself; one run at a time, 10 minutes at most. */
export function startMacCodexLogin(): MacCodexLogin {
  if (macCodexLoginRun && !macCodexLoginRun.done) return macCodexLoginRun;
  const child = spawnPortableProcess({ command: findCliExecutable("codex") ?? "codex", args: ["login"], stdio: ["ignore", "pipe", "pipe"], timeout: 10 * 60_000 });
  const run: MacCodexLogin = { child, url: null, error: null, done: false };
  let output = "";
  const read = (chunk: Buffer) => { output += chunk.toString(); run.url ??= output.match(/https:\/\/auth\.openai\.com\/\S+/)?.[0] ?? null; };
  child.stdout?.on("data", read);
  child.stderr?.on("data", read);
  child.on("error", (error: NodeJS.ErrnoException) => {
    run.done = true;
    run.error = error.code === "ENOENT" ? `Codex is not installed on this ${COMPUTER}. Install it with \`npm i -g @openai/codex\`, then click Connect again.` : `Codex sign-in could not start: ${error.message}`;
  });
  // A cancel or the 10-minute timeout kills Codex (code null); only a real exit has an error worth showing.
  child.on("exit", code => { run.done = true; if (code !== 0) run.error ??= codexLoginFailure(code === null ? "" : output); });
  macCodexLoginRun = run;
  return run;
}
/** The current `codex login` run; a finished run is returned once, then forgotten. */
export function macCodexLogin(): MacCodexLogin | null {
  const run = macCodexLoginRun;
  if (run?.done) macCodexLoginRun = null;
  return run;
}
export function cancelMacCodexLogin(): void {
  if (macCodexLoginRun) killPortableProcess(macCodexLoginRun.child, "SIGTERM");
  macCodexLoginRun = null;
}

/** When the saved Codex access token stops working, in milliseconds, or null when the login has none. */
function codexTokenExpiry(text: string): number | null {
  try {
    const token = (JSON.parse(text) as { tokens?: { access_token?: unknown } }).tokens?.access_token;
    const exp = typeof token === "string" ? (JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as { exp?: unknown }).exp : null;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch { return null; }
}
/** True only when this Mac's Codex login is dead: its access token is past expiry and Codex itself could not renew it.
 *  A valid token, an offline Mac, or any other failure counts as signed in, so working logins behave as before. */
export async function macCodexLoginExpired(): Promise<boolean> {
  const expiry = codexTokenExpiry(await readFile(codexAuthPath(), "utf8").catch(() => ""));
  if (expiry === null || Date.now() < expiry) return false;
  return new Promise(resolve => {
    const child = spawnPortableProcess({ command: findCliExecutable("codex") ?? "codex", args: ["app-server"], stdio: ["pipe", "pipe", "ignore"], timeout: 20_000 });
    const end = (expired: boolean) => { resolve(expired); killPortableProcess(child, "SIGTERM"); };
    const send = (message: object) => child.stdin?.write(`${JSON.stringify(message)}\n`);
    child.stdin?.on("error", () => end(false));
    child.on("error", () => end(false));
    child.on("exit", () => end(false));
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let at; (at = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(at + 1)) {
        let message: { id?: unknown; result?: { account?: unknown; requiresOpenaiAuth?: unknown } };
        try { message = JSON.parse(buffer.slice(0, at)); } catch { continue; }
        if (message.id === 1) {
          send({ method: "initialized" });
          // Codex renews the token itself and saves it; a rejected renewal reports no account.
          send({ id: 2, method: "account/read", params: { refreshToken: true } });
        }
        if (message.id === 2) end(message.result?.account === null && message.result.requiresOpenaiAuth === true);
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "cloudroom", version: "1" } } });
  });
}

function contentDigest(tar: Buffer): string {
  const hash = createHash("sha256");
  for (let at = 0; at + 512 <= tar.length && tar[at] !== 0;) {
    const end = at + 512 + Math.ceil(Number.parseInt(tar.toString("latin1", at + 124, at + 136).replace(/\0/g, "").trim() || "0", 8) / 512) * 512;
    hash.update(tar.subarray(at, at + 136)).update(tar.subarray(at + 156, end));
    at = end;
  }
  return hash.digest("hex");
}

/** OpenCode 1 keeps its logins in auth.json. OpenCode 2 keeps them in its database and exports them as a JSON array,
 *  kept byte for byte so a sandbox's unchanged export matches it (ADR 0172). */
export async function macOpencodeLogin(): Promise<string | null> {
  const binary = findCliExecutable("opencode");
  const version = (await macHarnessVersions()).opencode;
  const value = binary && version && !version.startsWith("1.")
    ? (await execPortableFile(binary, ["auth", "export", "--standalone"], { timeoutMs: 20_000, maxBuffer: 1024 * 1024 }).catch(() => null))?.stdout ?? null
    : await readFile(join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "opencode/auth.json"), "utf8").catch(() => null);
  try { const parsed: unknown = value && JSON.parse(value); return parsed && (!Array.isArray(parsed) || parsed.length) ? value : null; } catch { return null; }
}

/** What Cloud gets for OpenCode: its login, plus the custom providers in its global opencode.json (feedback #547).
 *  The rest of that file, such as MCP servers, plugins, and permissions, belongs to this computer. */
async function macOpencodeCloudLogin(): Promise<string | null> {
  const [auth, text] = await Promise.all([macOpencodeLogin(), readFile(join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode/opencode.json"), "utf8").catch(() => null)]);
  let provider: unknown;
  try { provider = text ? (JSON.parse(text) as { provider?: unknown }).provider : undefined; } catch { /* Comments: copy the login only. */ }
  if (!provider || typeof provider !== "object" || !Object.keys(provider).length) return auth;
  const config = JSON.stringify({ provider });
  return JSON.stringify(auth ? { auth, config } : { config });
}

/** Hermes seeds config.yaml and .env from long commented templates. Comments and blank lines stay on this computer;
 *  text inside YAML block scalars (`key: |`) is kept as is. */
function withoutComments(text: string): string {
  let block = -1;
  const kept = text.split("\n").filter(line => {
    const indent = line.length - line.trimStart().length;
    if (block >= 0 && (!line.trim() || indent > block)) return true;
    block = /(:|^\s*-)\s*[|>][-+0-9]*\s*(#.*)?$/.test(line) ? indent : -1;
    return line.trim() !== "" && !line.trimStart().startsWith("#");
  });
  return kept.length ? `${kept.join("\n")}\n` : "";
}

/** This computer's Hermes login, API keys, and providers, or null when Hermes has none here. */
async function macHermesLogin(): Promise<string | null> {
  const home = process.env.HERMES_HOME || join(homedir(), ".hermes");
  const read = (file: string) => readFile(join(home, file), "utf8").catch(() => "");
  const [auth, env, config] = await Promise.all([read("auth.json"), read(".env").then(withoutComments), read("config.yaml").then(withoutComments)]);
  const login = Object.fromEntries(Object.entries({ auth, env, config }).filter(([, value]) => value.trim()));
  return auth.trim() || env.trim() ? JSON.stringify(login) : null;
}

/** This computer's Devin CLI login file, or null when Devin is signed out here. */
export async function macDevinLogin(): Promise<string | null> {
  const path = join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "devin", "credentials.toml");
  const credentials = await readFile(path, "utf8").catch(() => "");
  return credentials.trim() ? JSON.stringify({ credentials }) : null;
}

/** Claude plans stay on this Mac: Anthropic allows them only in Claude Code, not in OpenClaw (ADR 0265). API keys travel.
 *  Plan sign-ins, plan tokens (`sk-ant-oat…`, `CLAUDE_CODE_OAUTH_TOKEN`), and `claude-cli` models are all dropped. */
const claudePlan = (profile: unknown) => {
  const { provider, type, mode } = (profile ?? {}) as Record<string, unknown>;
  return (typeof provider === "string" && /^(anthropic|claude)/.test(provider) && (type ?? mode) !== "api_key") || JSON.stringify(profile ?? null).includes("sk-ant-oat");
};
const claudePlanEntry = (name: string, value: unknown) => /^claude-cli(\/|$)/.test(name) || (/CLAUDE|ANTHROPIC/i.test(name) && /OAUTH|SESSION|SETUP_TOKEN/i.test(name))
  || (typeof value === "string" && (/sk-ant-oat/.test(value) || value.startsWith("claude-cli/")));
function withoutClaudePlans(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter(item => !claudePlanEntry("", item)).map(withoutClaudePlans);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([name, item]) => !claudePlanEntry(name, item) && !claudePlan(item)).map(([name, item]) => [name, withoutClaudePlans(item)]));
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const jsonObject = (text: string): Record<string, unknown> => { try { return record(JSON.parse(text)); } catch { return {}; } };

/** This computer's OpenClaw sign-ins and API keys, and its model settings, or null when OpenClaw has none here.
 *  OpenClaw keeps logins in SQLite, read with macOS's own sqlite3. Memory and persona files stay here, like Hermes'. */
export async function macOpenclawLogin(): Promise<string | null> {
  const home = process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw");
  const query = (file: string, sql: string) => promisify(execFile)("/usr/bin/sqlite3", ["-readonly", join(home, file), sql], { timeout: 10_000 })
    .then(result => record(jsonObject(result.stdout).profiles), () => ({}));
  const [shared, agent, configText, envText] = await Promise.all([
    query("state/openclaw.sqlite", "SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.store'"),
    query("agents/main/agent/openclaw-agent.sqlite", "SELECT store_json FROM auth_profile_store WHERE store_key = 'primary'"),
    readFile(process.env.OPENCLAW_CONFIG_PATH || join(home, "openclaw.json"), "utf8").catch(() => "{}"),
    readFile(join(home, ".env"), "utf8").then(withoutComments, () => ""),
  ]);
  const profiles = Object.fromEntries(Object.entries({ ...shared, ...agent }).filter(([, profile]) => !claudePlan(profile)));
  const env = envText.split("\n").filter(line => !claudePlanEntry(line.split("=")[0].replace(/^\s*export\s+/, "").trim(), line.slice(line.indexOf("=") + 1))).join("\n");
  const mac = jsonObject(configText);
  const defaults = record(record(mac.agents).defaults);
  // Only the model, provider, and key settings travel: the Gateway, chat apps, and paths belong to this Mac.
  const config = record(withoutClaudePlans(Object.fromEntries(Object.entries({
    agents: { defaults: { model: defaults.model } },
    models: mac.models,
    auth: mac.auth,
    env: mac.env,
  }).filter(([, value]) => value !== undefined))));
  const sent = record(record(config.agents).defaults);
  if (typeof sent.model === "object" && !record(sent.model).primary) delete sent.model;
  if (!Object.keys(profiles).length && !env.trim() && config.env === undefined && config.models === undefined) return null;
  return JSON.stringify({ profiles, config, ...(env.trim() ? { env } : {}) });
}

/** This computer's Cursor CLI login in the file shape the CLI keeps on Linux, or null when Cursor is signed out here.
 *  On macOS the CLI stores it in the Keychain through /usr/bin/security, so reading it the same way shows no macOS prompt. */
export async function macCursorLogin(): Promise<string | null> {
  const login = (accessToken: unknown, refreshToken: unknown) =>
    typeof accessToken === "string" && accessToken && typeof refreshToken === "string" && refreshToken ? JSON.stringify({ accessToken, refreshToken }, null, 2) : null;
  const file = cursorAuthFile();
  if (file) {
    const saved = await readFile(file, "utf8").then(text => JSON.parse(text) as { accessToken?: unknown; refreshToken?: unknown } | null, () => null);
    return login(saved?.accessToken, saved?.refreshToken);
  }
  if (process.platform !== "darwin") return null;
  const read = (service: string) => promisify(execFile)("/usr/bin/security", ["find-generic-password", "-a", "cursor-user", "-s", service, "-w"], { timeout: 10_000 })
    .then(result => result.stdout.trim(), () => "");
  const [accessToken, refreshToken] = await Promise.all([read("cursor-access-token"), read("cursor-refresh-token")]);
  return login(accessToken, refreshToken);
}

/** Whether Cursor rejects this API key, checked with this computer's Cursor CLI. A missing CLI or no answer accepts it. */
export async function cursorKeyRejected(apiKey: string): Promise<boolean> {
  const binary = findCliExecutable("cursor-agent");
  if (!binary) return false;
  try {
    await execPortableFile(binary, ["--disable-auto-update", "--list-models"], { timeoutMs: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, CURSOR_API_KEY: apiKey } });
    return false;
  } catch (error) {
    const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
    return /API key is invalid/i.test(`${stdout}${stderr}`);
  }
}

/** "" on any failure, including spawn errors execFile throws instead of rejecting (an Intel binary without Rosetta). */
const output = async (command: string, args: string[]) => {
  try { return (await promisify(execFile)(command, args, { timeout: 10_000 })).stdout.trim(); } catch { return ""; }
};
export const githubAccountSchema = z.object({ login: z.string(), name: z.string().nullable(), avatarUrl: z.string().nullable() });
export type GithubAccount = z.infer<typeof githubAccountSchema>;
/** This Mac's GitHub CLI token, or "" when `gh` is missing or signed out. */
export const macGithubToken = () => output("gh", ["auth", "token", "--hostname", "github.com"]);
/** The GitHub login sandboxes receive. Agents commit as the user, with the Mac's Git identity. */
export async function sandboxGithubLogin(token: string): Promise<string> {
  const [name, email] = await Promise.all([output("git", ["config", "--global", "user.name"]), output("git", ["config", "--global", "user.email"])]);
  return JSON.stringify({ token, ...(name ? { name } : {}), ...(email ? { email } : {}) });
}

const environmentSchema = z.object({
  variables: z.array(z.object({ name: z.string(), hint: z.string() })), setup: z.string(),
  repos: z.array(z.string()).default([]), mcp: z.array(z.string()).default([]), available: z.array(z.string()).optional(), pushed: z.record(z.string(), z.number()).optional(), ids: z.record(z.string(), z.number()).optional(), login: z.string().optional(),
});
export type CloudEnvironment = z.infer<typeof environmentSchema>;
export const cloudEnvironmentRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get") }),
  z.object({ action: z.literal("set"), variables: z.record(z.string(), z.string()) }),
  z.object({ action: z.literal("remove"), name: z.string().min(1) }),
  z.object({ action: z.literal("setup"), setup: z.string() }),
  z.object({ action: z.literal("addRepo"), repo: z.string().min(1) }),
  z.object({ action: z.literal("removeRepo"), repo: z.string().min(1) }),
  z.object({ action: z.literal("githubRepos") }),
]);
/** One MCP server in Claude Code's format, as the website stores it for sandboxes. */
export type McpServer = { type: "stdio"; command: string; args: string[]; env: Record<string, string> } | { type: "http" | "sse"; url: string; headers: Record<string, string> };
type McpChange = { action: "mcp"; servers: Record<string, McpServer>; remove: string[] };
export type CloudEnvironmentRequest = z.infer<typeof cloudEnvironmentRequestSchema>;

/** API keys, tokens, and secrets exported in this Mac's login shell (say, ~/.zshrc): what local agents get (ADR 0130). */
export async function macVariables(): Promise<Record<string, string>> {
  // Windows apps get the user's variables from the system, not from a shell profile.
  if (process.platform === "win32") return secretVariables(userEnvironmentEntries());
  const marker = "__CLOUDROOM_ENV__";
  const run = promisify(execFile)(process.env.SHELL || "/bin/zsh", ["-ilc", `printf '${marker}\\0'; env -0`], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  run.child.stdin?.end();
  const output = await run.then(result => result.stdout, () => "");
  return secretVariables(output.slice(output.indexOf(`${marker}\0`) + marker.length + 1).split("\0"));
}

function secretVariables(entries: string[]): Record<string, string> {
  return Object.fromEntries(entries.flatMap(entry => {
    const at = entry.indexOf("="), name = entry.slice(0, at), value = entry.slice(at + 1);
    const wanted = at > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && /KEY|TOKEN|SECRET/i.test(name) && !/^(BB|ROOM|CLOUDROOM|ELECTRON)_/.test(name);
    return wanted && value && !/[\r\n]/.test(value) ? [[name, value]] : [];
  }));
}

export type MacSkill = { name: string; description: string; paths: string[] };
/** This Mac's skills: folders with a SKILL.md in a harness skill root. One name may sit in several roots. */
export async function macSkills(): Promise<MacSkill[]> {
  const home = homedir();
  const found = new Map<string, MacSkill>();
  for (const root of SKILL_ROOTS) {
    for (const name of await readdir(join(home, root)).catch(() => [])) {
      const file = join(home, root, name, "SKILL.md");
      if (name.startsWith(".") || !await stat(file).then(info => info.isFile(), () => false)) continue;
      const skill = found.get(name) ?? { name, paths: [], description: await readFile(file, "utf8").then(text => hasSupportedFrontmatterDelimiter(text) ? String(parseFrontmatter(text).description ?? "").replace(/\s+/g, " ").trim() : "").catch(() => "") };
      skill.paths.push(`${root}/${name}`);
      found.set(name, skill);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function configFiles(home: string, paths: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const path of paths) {
    const root = await realpath(join(home, path));
    const ancestors = new Set<string>();
    const visit = async (path: string): Promise<void> => {
      const full = join(home, path);
      const target = await realpath(full).catch(() => null);
      if (!target || (target !== root && !target.startsWith(root + sep)) || ancestors.has(target)) return;
      const info = await stat(full);
      if (!info.isFile() && !info.isDirectory()) return;
      files.push(path.split(sep).join("/"));
      if (!info.isDirectory()) return;
      ancestors.add(target);
      for (const name of await readdir(full)) {
        if (![".git", "node_modules", ".DS_Store"].includes(name)) await visit(join(path, name));
      }
      ancestors.delete(target);
    };
    await visit(path);
  }
  return files;
}

export type MacMcpServer = { name: string; server: McpServer | null };
const texts = (value: unknown) => Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
// Paths that exist only on this Mac, and servers running on it.
/** Windows paths and %VARIABLES% (digits and parentheses too, like %ProgramFiles(x86)%) that exist only on this PC. */
export const WINDOWS_LOCAL_PATH = /(^|[\s=:'"])([A-Za-z]:[\\/]|\\\\|~[\\/]|%[A-Za-z_][A-Za-z0-9_()]*%)/;
const MAC_PATH = process.platform === "win32"
  ? WINDOWS_LOCAL_PATH
  : /(^|[\s=:'"])(~\/|\/Users\/|\/Volumes\/|\/Applications\/|\/Library\/|\/opt\/homebrew\/|\/private\/)/;
const LOCAL_URL = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i;
const portable = (server: McpServer) => server.type === "stdio"
  ? !server.command.includes("/") && !(process.platform === "win32" && (server.command.includes("\\") || MAC_PATH.test(server.command))) && ![...server.args, ...Object.values(server.env)].some(text => MAC_PATH.test(text))
  : !LOCAL_URL.test(server.url);
/** On Windows, Claude Code runs npx through `cmd /c` and Codex may name `npx.cmd`. Sandboxes run the command itself. */
function windowsCommand(server: McpServer): McpServer {
  if (process.platform !== "win32" || server.type !== "stdio") return server;
  const wrapped = /^cmd(\.exe)?$/i.test(server.command) && /^\/c$/i.test(server.args[0] ?? "") && server.args[1];
  const [command, args] = wrapped ? [server.args[1]!, server.args.slice(2)] : [server.command, server.args];
  return { ...server, command: command.replace(/\.(cmd|exe|bat)$/i, ""), args };
}
/** Claude Code's user-scope MCP servers; `${VAR}` stays as typed and is filled in the sandbox from the API keys. */
function claudeServer(value: Record<string, unknown>): McpServer | null {
  const type = value.type ?? (value.command ? "stdio" : undefined);
  if (type === "stdio" && typeof value.command === "string") return { type, command: value.command, args: list(value.args), env: texts(value.env) };
  if ((type === "http" || type === "sse") && typeof value.url === "string") return { type, url: value.url, headers: texts(value.headers) };
  return null;
}
/** A server from `codex mcp list --json`. Variables Codex reads from the environment become `${VAR}`. */
function codexServer(transport: Record<string, unknown>): McpServer | null {
  const fromEnvironment = (names: string[]) => Object.fromEntries(names.map(name => [name, `\${${name}}`]));
  if (transport.type === "stdio" && typeof transport.command === "string" && !transport.cwd) {
    const forwarded = Array.isArray(transport.env_vars) ? transport.env_vars.map(item => typeof item === "string" ? item : (item as { name?: unknown })?.name).filter((name): name is string => typeof name === "string") : [];
    return { type: "stdio", command: transport.command, args: list(transport.args), env: { ...fromEnvironment(forwarded), ...texts(transport.env) } };
  }
  if (transport.type === "streamable_http" && typeof transport.url === "string") {
    const headers = { ...texts(transport.http_headers), ...Object.fromEntries(Object.entries(texts(transport.env_http_headers)).map(([header, name]) => [header, `\${${name}}`])) };
    if (typeof transport.bearer_token_env_var === "string") headers.Authorization = `Bearer \${${transport.bearer_token_env_var}}`;
    return { type: "http", url: transport.url, headers };
  }
  return null;
}
/** This Mac's MCP servers from Claude Code (user scope) and Codex; Claude's wins on a name clash. `server` is null when
 *  it only works on this Mac. An older Codex without `mcp list --json` just adds none. */
export async function macMcpServers(): Promise<MacMcpServer[]> {
  const found = new Map<string, McpServer | null>();
  const add = (name: string, server: McpServer | null) => {
    server = server && windowsCommand(server);
    if (/^[A-Za-z0-9_-]{1,64}$/.test(name) && name !== "cloudroom" && !found.has(name)) found.set(name, server && portable(server) ? server : null);
  };
  const claudeFile = join(process.env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json");
  const claude = await readFile(claudeFile, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return "{}"; throw error; });
  const servers: unknown = (JSON.parse(claude) as { mcpServers?: unknown }).mcpServers;
  for (const [name, value] of Object.entries(servers && typeof servers === "object" ? servers : {})) add(name, value && typeof value === "object" ? claudeServer(value as Record<string, unknown>) : null);
  const codex = findCliExecutable("codex");
  if (codex) {
    const listed = await execPortableFile(codex, ["mcp", "list", "--json"], { timeoutMs: 15_000, maxBuffer: 4 * 1024 * 1024 })
      .then(({ stdout }) => z.array(z.object({ name: z.string(), enabled: z.boolean().default(true), transport: z.record(z.string(), z.unknown()) })).parse(JSON.parse(stdout)), () => []);
    for (const { name, enabled, transport } of listed) if (enabled) add(name, codexServer(transport));
  }
  return [...found].map(([name, server]) => ({ name, server })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Asks the website to delete this sign-in's token. Best effort: signing out never waits for the network. */
export function revokeDesktopToken(account: SandboxAccount): void {
  void fetch(`${account.website}/api/desktop/sign-out`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Basic ${Buffer.from(`${account.userId}:${account.token}`).toString("base64")}` },
  }).then(response => response.body?.cancel(), () => {});
}

/** Each cloud thread's own sandbox, managed by the website (docs/scopes/sandboxes.md). Lookups never wake it. */
export class SandboxDirectory {
  private readonly views = new Map<string, View>();
  /** A new thread's VPS-or-Cloud pick, sent with its first wake (ADR 0319). */
  private readonly targets = new Map<string, "vps" | "cloud">();
  /** Whether the account has a VPS connected, from its last status check: VPS accounts' prompts explain VPS threads. */
  vpsConnected = false;
  private readonly wakes = new Map<string, Promise<View>>();
  private readonly wakeStarts = new Map<string, number>();
  private readonly wakeHarnesses = new Map<string, Awaited<ReturnType<typeof macHarnessVersions>>>();
  // After a failed wake, wait before asking again. Network and server errors retry every 2 s three times first;
  // then 5 s, doubling to 5 minutes. Delivery retries every tick otherwise.
  private readonly backoff = new Map<string, { until: number; delay: number; tries: number }>();
  private readonly preloads = new Map<string, Promise<void>>();
  private readonly preloaded = new Map<string, number>();
  private readonly preloadQueue: { thread: string; project: SandboxProject }[] = [];
  private preloadWorkers = 0;
  private preloadOn = false;
  private uploaded = new Map<string, string>();
  /** Gets the threads automations started, from each awake check; the app shows the ones it doesn't have yet. */
  onRuns: (runs: AutomationRun[]) => void = () => {};
  /** `woke` runs after each wake, so the Mac helper lists the new sandbox now instead of at its next minute check. */
  constructor(readonly account: () => Promise<SandboxAccount | null>, private readonly woke: (thread: string) => void = () => {}) {}

  /** `only` sends the request solely for that account, so a login started under one account never reaches another. */
  private async call(body: Record<string, unknown>, path = "sandboxes", only?: AccountRequest): Promise<unknown> {
    const account = await this.account();
    if (!account) throw new CloudroomError("Sign in to Cloudroom to use cloud sandboxes.");
    if (only && (account.userId !== only.account.userId || account.website !== only.account.website)) throw new CloudroomError("The Cloudroom account changed. Try again.");
    let response: Response;
    try {
      response = await fetch(`${account.website}/api/desktop/${path}`, {
        method: "POST", redirect: "error", signal: only ? AbortSignal.any([only.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
        headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${account.userId}:${account.token}`).toString("base64")}` },
        body: JSON.stringify(body),
      });
    } catch (error) { throw new CloudroomConnectionError(`Cloudroom could not reach the website to manage this thread's sandbox: ${error instanceof Error ? error.message : String(error)}`); }
    const value = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown };
    if (!response.ok) {
      const message = typeof value.error === "string" ? value.error : `The website returned HTTP ${response.status}.`;
      if (response.status === 409 && /busy/i.test(message)) throw new CloudroomConnectionError(message);
      const code = typeof value.code === "string" ? value.code : null;
      if (code === USAGE_LIMIT) this.limit = { on: true, at: Date.now() };
      // Refused for the cloud queue or the region: ask again soon, so the composer shows the right card.
      if (code === CLOUD_QUEUE || code === CLOUD_REGION) this.mode = null;
      throw new CloudroomError(message, response.status >= 500 ? null : response.status, code);
    }
    return value;
  }

  private limit: { on: boolean; at: number } | null = null;
  private checkingLimit = false;
  usageLimited(): boolean {
    if (!this.checkingLimit && (!this.limit || Date.now() - this.limit.at > RECHECK_MS)) {
      this.checkingLimit = true;
      void this.checkMode().catch(() => { this.limit = { on: this.limit?.on ?? false, at: Date.now() }; }).finally(() => { this.checkingLimit = false; });
    }
    return this.limit?.on ?? false;
  }

  /** Reports today as active, with finished days' active minutes. True when the website saved the minutes. */
  async active(minutes: Record<string, number>): Promise<boolean> {
    const value = await this.call(Object.keys(minutes).length ? { minutes } : {}, "active");
    return z.object({ minutes: z.boolean().optional() }).parse(value).minutes !== false;
  }

  async requestMoreUsage() {
    return z.object({ sent: z.boolean() }).parse(await this.call({}, "usage-request"));
  }

  /** The member's friend invite codes. `create` makes one more (ADR 0169). */
  async invites(action: "list" | "create") {
    const value = await this.call({ action }, "invites");
    const joined = z.object({ name: z.string().nullable(), at: z.string() }).optional();
    return z.object({ codes: z.array(z.object({ code: z.string(), used: z.boolean(), url: z.string().optional(), joined })), left: z.number(), created: z.string().nullable(), waiting: z.number().nullable().default(null) }).parse(value);
  }

  popups(body: Record<string, string>): Promise<unknown> {
    return this.call(body, "popups");
  }

  /** Whether the website judges a generated thread title too vague to keep, at the user's sensitivity (2–5). */
  async titleTooVague(check: { title: string; firstMessage: string; agentReply: string; sensitivity: number }): Promise<boolean> {
    const value = await this.call({ ...check, sensitivity: String(check.sensitivity) }, "thread-title");
    return z.object({ rename: z.boolean() }).parse(value).rename;
  }

  /** Onboarding failures and the install ID link, saved with this account (ADR 0201). */
  setupEvent(event: string, context: Record<string, unknown>): Promise<unknown> {
    return this.call({ event, context }, "setup-events");
  }

  /** Backup voice transcription on the website, or null when signed out. */
  async transcribe(file: File): Promise<string | null> {
    const account = await this.account();
    if (!account) return null;
    const body = new FormData();
    body.set("file", file, file.name);
    const response = await fetch(`${account.website}/api/desktop/transcribe`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(110_000),
      headers: { Authorization: `Basic ${Buffer.from(`${account.userId}:${account.token}`).toString("base64")}` },
      body,
    });
    const value = await response.json().catch(() => ({})) as { text?: unknown; error?: unknown };
    if (!response.ok || typeof value.text !== "string") throw new CloudroomError(typeof value.error === "string" ? value.error : `The website returned HTTP ${response.status}.`);
    return value.text;
  }

  /** Thread share links on the website (docs/scopes/thread-share-links.md): save, stop, or open one. */
  async shares(body: Record<string, unknown>): Promise<unknown> {
    return this.call(body, "shares");
  }

  private remember(view: View): View {
    this.views.set(view.thread, view);
    return view;
  }

  private awake = new Map<string, { origin: string; token: string }>();
  awakeSandboxes(): { thread: string; url: string; token: string }[] {
    const awake = new Map([...this.awake].map(([thread, { origin, token }]) => [thread, { thread, url: origin, token }]));
    for (const view of this.views.values()) {
      if (view.state === "awake" && view.origin && view.token && Date.now() - (this.wakeStarts.get(view.thread) ?? 0) < 120_000) awake.set(view.thread, { thread: view.thread, url: view.origin, token: view.token });
    }
    return [...awake.values()];
  }
  private awakeNext = 0;
  private awakeEvery = 60_000;
  private awakeIssue: CloudroomError | null = null;
  private awakeCheck: Promise<void> | null = null;
  /** The account's awake sandboxes: one website call per app, at most every `recheck_ms`, however many threads it has.
   *  A failed check is retried within 10 s and keeps `awakeIssue`, so threads it can't place aren't taken for asleep. */
  private async awakeList(fresh = false): Promise<Map<string, { origin: string; token: string }>> {
    if (!fresh && Date.now() < this.awakeNext) return this.awake;
    if (!this.awakeCheck) {
      const check: Promise<void> = this.call({ action: "awake" }).then(value => awakeSchema.parse(value)).then(listed => {
        if (this.awakeCheck !== check) return;
        this.awake = new Map(listed.sandboxes.map(({ thread, origin, token }) => [thread, { origin, token }]));
        if (listed.runs.length) this.onRuns(listed.runs);
        this.awakeEvery = listed.recheck_ms;
        this.awakeIssue = null;
        this.awakeNext = Date.now() + listed.recheck_ms;
      }, (error: unknown) => {
        if (this.awakeCheck !== check) return;
        this.awakeIssue = error instanceof CloudroomError ? error : new CloudroomError("The website's list of awake cloud sandboxes was unreadable.");
        this.awakeNext = Date.now() + Math.min(this.awakeEvery, 10_000);
      }).finally(() => { if (this.awakeCheck === check) this.awakeCheck = null; });
      this.awakeCheck = check;
    }
    await this.awakeCheck;
    return this.awake;
  }

  /** Finds threads the website started (Loop runs, top-level launches) even when no known thread sleeps, so none
   *  stays hidden (ADR 0267). At most one website call per `recheck_ms`; none while signed out. */
  async discover(): Promise<void> {
    if (Date.now() < this.awakeNext || this.awakeCheck) return;
    if (!await this.account()) { this.awakeNext = Date.now() + this.awakeEvery; return; }
    await this.awakeList();
  }

  /** The thread's Core, or null while it sleeps. `wake` starts it; only callers with work to send pass true. */
  async connection(thread: string, project: SandboxProject, wake: boolean, trigger?: SandboxWakeTrigger, fresh = false): Promise<SandboxConnection | null> {
    const preloading = wake ? this.preloads.get(thread) : undefined;
    if (preloading) {
      this.wakeStarts.set(thread, Date.now());
      await preloading;
    }
    let view = this.views.get(thread);
    const place = placeOf(thread, project);
    if (!wake && view?.state !== "awake") {
      const found = (await this.awakeList(fresh)).get(thread);
      if (found) view = this.remember({ thread, state: "awake", generation: view?.generation ?? 0, issue: null, ...found });
      else if (this.awakeIssue) throw this.awakeIssue;
    }
    if (view?.state === "awake" && view.origin && view.token) return { url: view.origin, token: view.token };
    if (!wake) return null;
    const waiting = this.backoff.get(thread);
    if (waiting && Date.now() < waiting.until) throw new CloudroomConnectionError(`The cloud sandbox could not start. Retrying in ${Math.ceil((waiting.until - Date.now()) / 1000)} seconds.`);
    let pending = this.wakes.get(thread);
    if (!pending) {
      this.wakeStarts.set(thread, Date.now());
      // The Mac's harness versions: the sandbox upgrades to them before its agent starts (ADR 0133).
      pending = macHarnessVersions().then(harnesses => {
        this.wakeHarnesses.set(thread, harnesses);
        const target = this.targets.get(thread);
        return this.call({ action: "wake", ...place, ...(target ? { target } : {}), harnesses, ...(this.backoff.has(thread) ? { trigger: "retry" } : trigger ? { trigger } : {}) });
      }).then(value => this.remember(viewSchema.parse(value))).then(view => {
        this.targets.delete(thread);
        this.woke(view.thread);
        this.backoff.delete(thread);
        this.capped.delete(thread);
        if (this.limit?.on) this.limit = { on: false, at: Date.now() };
        return view;
      }, error => {
        if (error instanceof CloudroomError && error.code === AGENT_LIMIT) this.capped.add(thread);
        const previous = this.backoff.get(thread);
        const tries = (previous?.tries ?? 0) + 1;
        // A 4xx answer (say, usage limit) won't fix itself in 2 s, so it backs off at once.
        const quick = tries <= 3 && error instanceof CloudroomError && error.status === null;
        const delay = quick ? 2_000 : Math.min(Math.max(previous?.delay ?? 0, 2_500) * 2, 300_000);
        this.backoff.set(thread, { until: Date.now() + delay, delay, tries });
        throw error;
      }).finally(() => this.wakes.delete(thread));
      this.wakes.set(thread, pending);
    }
    const woken = await pending;
    if (!woken.origin || !woken.token) throw new CloudroomError(woken.issue ?? "The sandbox did not start.");
    return { url: woken.origin, token: woken.token };
  }

  private mode: { on: boolean; at: number } | null = null;
  /** Whether the account's new cloud threads get sandboxes. Unknown (website unreachable) keeps the last answer. */
  async forNewThreads(): Promise<boolean> {
    if (this.mode && Date.now() - this.mode.at < RECHECK_MS) return this.mode.on;
    try { return await this.checkMode(); }
    catch { return this.mode?.on ?? true; }
  }

  private async checkMode(): Promise<boolean> {
    const value = z.object({
      sandboxes: z.boolean(), limited: z.boolean().default(false),
      queue: z.object({ position: z.number(), total: z.number() }).nullable().default(null), region_blocked: z.boolean().default(false),
      plan: z.string().nullable().default(null), preload: z.boolean().default(false),
    }).parse(await this.call({ action: "mode" }));
    this.plan = value.plan;
    this.preloadOn = value.preload;
    this.mode = { on: value.sandboxes, at: Date.now() };
    this.limit = { on: value.limited, at: Date.now() };
    this.queue = value.queue || value.region_blocked ? { position: value.queue?.position ?? 0, total: value.queue?.total ?? 0, regionBlocked: value.region_blocked } : null;
    return value.sandboxes;
  }

  private queue: CloudQueue | null = null;
  /** The account's place in the cloud queue, or a blocked region: new Cloud threads wait (docs/scopes/public-launch.md).
   *  Null when it may start them. Refreshed with forNewThreads(). */
  cloudQueue(): CloudQueue | null { return this.queue; }

  async preload(threads: { thread: string; project: SandboxProject }[], beforeWake: () => Promise<void>): Promise<void> {
    if (!this.mode) await this.forNewThreads();
    if (this.usageLimited() || !this.preloadOn) return;
    const now = Date.now();
    for (const [thread, at] of this.preloaded) if (now - at >= PRELOAD_AGAIN_MS) this.preloaded.delete(thread);
    const room = Math.min(PRELOAD_BATCH - this.preloadQueue.length - this.preloads.size, PRELOADS_PER_HOUR - this.preloaded.size);
    const due = threads.filter(({ thread }) => !this.preloaded.has(thread) && !this.preloads.has(thread) && !this.wakes.has(thread) && !this.isAwake(thread) && !this.coolingDown(thread)).slice(0, Math.max(0, room));
    if (!due.length) return;
    for (const { thread } of due) this.preloaded.set(thread, now);
    this.preloadQueue.push(...due);
    await beforeWake().catch(() => {});
    const workers: Promise<void>[] = [];
    for (let started = this.preloadWorkers; started < 2; started++) workers.push(this.preloadNext());
    await Promise.all(workers);
  }

  private async preloadNext(): Promise<void> {
    this.preloadWorkers++;
    try {
      for (let item = this.preloadQueue.shift(); item; item = this.preloadQueue.shift()) await this.preloadOne(item.thread, item.project);
    } finally { this.preloadWorkers--; }
  }

  private preloadOne(thread: string, project: SandboxProject): Promise<void> {
    this.wakeStarts.set(thread, Date.now());
    const run = macHarnessVersions().then(harnesses => {
      this.wakeHarnesses.set(thread, harnesses);
      return this.call({ action: "wake", ...placeOf(thread, project), harnesses, trigger: "sidebar_preload" });
    }).then(value => this.woke(this.remember(viewSchema.parse(value)).thread)).catch(() => {}).finally(() => this.preloads.delete(thread));
    this.preloads.set(thread, run);
    return run;
  }

  private readonly capped = new Set<string>();
  /** Whether this new thread was refused for its plan's launch cap; cleared when it starts. */
  agentLimited(thread: string): boolean { return this.capped.has(thread); }
  /** Whether this run last saw the sandbox awake, without asking the website. */
  isAwake(thread: string): boolean { return this.views.get(thread)?.state === "awake" || this.awake.has(thread); }

  private plan: string | null = null;
  currentPlan(): string | null { return this.plan; }
  private usage: { value: PlanUsage | null; next: number } | null = null;
  private checkingUsage = false;
  /** The account's usage; null while billing is off, in the cloud queue, or before the website answers. Its plan is
   *  refreshed with forNewThreads(); the usage itself as often as the website says. */
  planUsage(): PlanUsage | null {
    if (!this.plan || this.queue) return null;
    if (!this.checkingUsage && Date.now() >= (this.usage?.next ?? 0)) {
      this.checkingUsage = true;
      void this.call({ action: "usage" }).then((value) => {
        // A website without credits (say, rolled back) shows no card rather than old units.
        const parsed = z.object({ plan: z.string(), credits: z.number().nullable(), credits_limit: z.number(),
          og: z.object({ name: z.string().nullable(), ends_at: z.string() }).nullable().catch(null) }).safeParse(value);
        const recheck = z.object({ recheck_seconds: z.number().default(600) }).parse(value).recheck_seconds;
        this.usage = {
          value: parsed.success ? { plan: parsed.data.plan, credits: parsed.data.credits, creditsLimit: parsed.data.credits_limit,
            og: parsed.data.plan === "pro" && parsed.data.og ? { name: parsed.data.og.name, endsAt: parsed.data.og.ends_at } : null } : null,
          next: Date.now() + Math.max(recheck, 60) * 1000,
        };
      }, () => { this.usage = { value: this.usage?.value ?? null, next: Date.now() + RECHECK_MS }; }).finally(() => { this.checkingUsage = false; });
    }
    // A plan change shows nothing until the next check, never the old plan's card.
    return this.usage?.value?.plan === this.plan ? this.usage.value : null;
  }

  /** What the account's cloud offers, read by the website from a running spare or sandbox. Null until one runs. */
  async capabilities(): Promise<unknown> {
    return z.object({ capabilities: z.unknown() }).parse(await this.call({ action: "capabilities" })).capabilities ?? null;
  }

  wokeSince(thread: string, at: number): boolean { return (this.wakeStarts.get(thread) ?? 0) >= at; }

  startupSince(thread: string, at: number) {
    const startup = this.views.get(thread)?.startup;
    const versions = this.wakeHarnesses.get(thread);
    if (!this.wokeSince(thread, at)) return { startup_source: "reuse" as const, sandbox_start_ms: 0, versions };
    return { startup_source: startup?.source ?? null, sandbox_start_ms: startup?.duration_ms ?? null, versions };
  }

  private warmed: { project: string; at: number } | null = null;
  /** Asks the website to keep hot spare sandboxes ready for the next cloud threads, in any project. The project lets it
   *  build that project's template. At most once a minute per project. */
  async warm(project: SandboxProject, trigger: SandboxTrigger = "composer"): Promise<void> {
    if (this.warmed?.project === project.id && Date.now() - this.warmed.at < RECHECK_MS) return;
    this.warmed = { project: project.id, at: Date.now() };
    await this.call({ action: "warm", project: project.id, trigger, ...(project.repository ? { repository: project.repository, folder: project.folder } : {}), harnesses: await macHarnessVersions() });
  }

  /** Forgets what was learned under the last account: sandbox tokens, uploaded logins and config, and its settings. */
  reset(): void {
    cancelMcpSignIns();
    this.signIns = null;
    this.mcpNames = null;
    this.mcpAt = 0;
    this.mcpDigest = "";
    this.views.clear();
    this.awake = new Map();
    this.awakeNext = 0;
    this.awakeIssue = null;
    this.awakeCheck = null;
    this.backoff.clear();
    this.uploaded.clear();
    this.mode = null;
    this.limit = null;
    this.plan = null;
    this.preloadOn = false;
    this.preloaded.clear();
    this.preloadQueue.length = 0;
    this.usage = null;
    this.capped.clear();
    this.warmed = null;
    this.copiedAt = 0;
    this.pulledAt = 0;
    cloudClaude = null;
    this.configAt = 0;
    this.configDigest = "";
    this.configIssue = null;
  }

  /** A broken stream or failed request may mean the sandbox went to sleep; look it up again next time. */
  forget(thread: string): void { this.views.delete(thread); this.awake.delete(thread); }
  coolingDown(thread: string | null): boolean { return Boolean(thread && (this.backoff.get(thread)?.until ?? 0) > Date.now()); }

  /** Saves a thread's title, project name, harness, model, Core session ID, and the thread that started it on the
   *  website (ADR 0182, 0239, 0256). */
  async label(thread: string, label: { title: string | null; project_name: string | null; project: string; session: string; harness: string; model: string | null; parent: string | null }): Promise<boolean> {
    return z.object({ saved: z.boolean() }).catch({ saved: false }).parse(await this.call({ action: "label", thread, ...label })).saved;
  }
  async archive(thread: string): Promise<void> { this.forget(thread); await this.call({ action: "archive", thread }); }
  async refreshCodex(thread: string): Promise<void> { await this.call({ action: "codex", thread }); }
  /** An unarchive right after an archive finds the sandbox busy until the archive ends (up to ~60 s), so keep trying. */
  async restore(thread: string): Promise<void> {
    this.forget(thread);
    this.backoff.delete(thread);
    for (let tries = 1; ; tries++) {
      try { return void await this.call({ action: "restore", thread }); }
      catch (error) { if (!(error instanceof CloudroomConnectionError) || tries >= 30) throw error; }
      await new Promise(resolve => setTimeout(resolve, 3_000));
    }
  }
  async remove(thread: string): Promise<void> { this.forget(thread); await this.call({ action: "remove", thread }); }

  /** Saves a login for every sandbox of this account (ADR 0145), skipping values already uploaded. */
  async saveLogin(name: SandboxLogin, value: string, only?: AccountRequest): Promise<void> {
    const digest = createHash("sha256").update(value).digest("hex");
    if (this.uploaded.get(name) === digest) return;
    await this.call({ name, value }, "logins", only);
    this.uploaded.set(name, digest);
  }

  /** The account's Codex accounts, which only the website renews (codex-accounts.ts). */
  codexAccounts(body: Record<string, unknown>): Promise<unknown> {
    return this.call(body, "codex-accounts");
  }

  /** The account's Cloud environment, shared with the website: variables (names only), repos, and the setup script. */
  async environment(request: CloudEnvironmentRequest | McpChange): Promise<CloudEnvironment> {
    const environment = environmentSchema.parse(await this.call(request, "environment"));
    this.mcpNames = environment.mcp;
    return environment;
  }

  async autoDelete(body: { action: "get" | "deleted" } | { action: "set"; days: number | null }): Promise<unknown> {
    return this.call(body, "auto-delete");
  }

  /** The user's own VPS (ADR 0319): status with live health, a pairing code, the two switches, or disconnect. */
  async vps(body: { action: "status" | "code" | "disconnect" } | { action: "settings"; useForCloud?: boolean; fallback?: boolean }): Promise<unknown> {
    const value = await this.call(body, "vps");
    if (body.action === "disconnect") this.vpsConnected = false;
    else if (typeof (value as { connected?: unknown }).connected === "boolean") this.vpsConnected = (value as { connected: boolean }).connected;
    return value;
  }

  /** Remembers a new Cloud thread's VPS-or-Cloud pick until its first wake sends it. */
  target(thread: string, target: "vps" | "cloud"): void {
    this.targets.set(thread, target);
  }

  /** Cloud automations live on the website, which runs them while this Mac is off (ADR 0212). */
  async automations(body: Record<string, unknown>): Promise<unknown> {
    return this.call(body, "automations");
  }

  /** Organizations live on the website (docs/scopes/organizations.md); the Organization plugin's requests pass through. */
  async org(body: Record<string, unknown>): Promise<unknown> {
    return this.call(body, "org");
  }

  private member: { userId: string; value: boolean; at: number } | null = null;
  /** Whether the account is in an organization (ADR 0277): false when signed out, null when the website can't say.
   *  Asks the website at once for a newly signed-in account, then every 15 minutes for members and every hour for
   *  everyone else. */
  async orgMember(): Promise<boolean | null> {
    const account = await this.account();
    if (!account) { this.member = null; return false; }
    const known = this.member?.userId === account.userId ? this.member : null;
    if (known && Date.now() - known.at < (known.value ? 15 : 60) * 60_000) return known.value;
    try {
      const value = z.object({ member: z.boolean() }).parse(await this.call({ action: "member" }, "org")).member;
      this.member = { userId: account.userId, value, at: Date.now() };
      return value;
    } catch { return known?.value ?? null; }
  }

  /** MCP servers in the cloud, as of the last Cloud environment answer. */
  private mcpNames: string[] | null = null;
  private mcpAt = 0;
  private mcpDigest = "";
  /** Adds MCP servers from this Mac to the Cloud environment, or removes them. */
  async setMacMcp(names: string[], cloud: boolean): Promise<CloudEnvironment> {
    if (!cloud) return this.environment({ action: "mcp", servers: {}, remove: names });
    const servers = Object.fromEntries((await macMcpServers()).flatMap(({ name, server }) => server && names.includes(name) ? [[name, server]] : []));
    if (!Object.keys(servers).length) throw new CloudroomError(`Those MCP servers only work on this ${COMPUTER}.`, 400);
    return this.environment({ action: "mcp", servers, remove: [] });
  }
  /** Copies edits to this Mac's MCP servers, such as a new key, to the ones already in the cloud. At most once a minute;
   *  never removes one, so a server missing for a moment stays in the cloud. */
  async refreshMacMcp(): Promise<void> {
    if (Date.now() - this.mcpAt < RECHECK_MS) return;
    this.mcpAt = Date.now();
    const names = this.mcpNames ?? (await this.environment({ action: "get" })).mcp;
    if (!names.length) return;
    const servers = Object.fromEntries((await macMcpServers()).flatMap(({ name, server }) => server && names.includes(name) ? [[name, server]] : []));
    const digest = createHash("sha256").update(JSON.stringify(servers)).digest("hex");
    if (digest === this.mcpDigest || !Object.keys(servers).length) return;
    await this.environment({ action: "mcp", servers, remove: [] });
    this.mcpDigest = digest;
  }

  /** The account's cloud MCP sign-ins: Claude Code's `mcpOAuth` records. Read from the website at most every 5 minutes. */
  private signIns: { at: number; value: Promise<Record<string, unknown>> } | null = null;
  private cloudMcpSignIns(fresh = false, only?: AccountRequest): Promise<Record<string, unknown>> {
    if (fresh || !this.signIns || Date.now() - this.signIns.at > 5 * 60_000) {
      const value = this.cloudLogin("mcp", only).then(text => {
        const saved = (text ? JSON.parse(text) : null) as { mcpOAuth?: unknown } | null;
        return saved?.mcpOAuth && typeof saved.mcpOAuth === "object" && !Array.isArray(saved.mcpOAuth) ? saved.mcpOAuth as Record<string, unknown> : {};
      });
      value.catch(() => { this.signIns = null; });
      this.signIns = { at: Date.now(), value };
    }
    return this.signIns.value;
  }
  /** For each cloud MCP server that uses OAuth: whether the cloud has signed in to it yet. Others are left out. */
  async mcpSignIns(servers: MacMcpServer[]): Promise<Record<string, "needed" | "done">> {
    const inCloud = this.mcpNames ?? (await this.environment({ action: "get" })).mcp;
    const remote = servers.flatMap(({ name, server }) => inCloud.includes(name) && isRemoteMcp(server) ? [{ name, server }] : []);
    if (!remote.length) return {};
    const saved = Object.values(await this.cloudMcpSignIns()) as Partial<McpSignIn>[];
    const states = await Promise.all(remote.map(async ({ name, server }) =>
      saved.some(signIn => signIn?.serverName === name && (signIn.accessToken || signIn.refreshToken)) ? "done" as const
        : await needsMcpSignIn(server) ? "needed" as const : null));
    return Object.fromEntries(remote.flatMap(({ name }, i) => states[i] ? [[name, states[i]]] : []));
  }
  /** Adds a new MCP sign-in to the account's others, replacing that server's old one. Awake sandboxes get it at once. */
  async saveMcpSignIn(name: string, server: RemoteMcpServer, signIn: McpSignIn, account: SandboxAccount): Promise<void> {
    const only = { account, signal: AbortSignal.timeout(120_000) };
    for (let tries = 1; ; tries++) {
      const others = Object.entries(await this.cloudMcpSignIns(true, only)).filter(([, saved]) => (saved as Partial<McpSignIn> | null)?.serverName !== name);
      try {
        return await this.saveLogin("mcp", JSON.stringify({ mcpOAuth: { ...Object.fromEntries(others), [mcpSignInKey(name, server)]: signIn } }), only);
      } catch (error) {
        // Usually a sandbox saved its refreshed sign-ins first.
        if (tries >= 3) throw error;
      } finally { this.signIns = null; }
    }
  }

  /** Which logins the website holds for this account's sandboxes. */
  async logins(): Promise<Record<SandboxLogin, boolean>> {
    // Missing names mean an older website that cannot hold that login yet.
    return z.object({ claude: z.boolean(), codex: z.boolean(), pi: z.boolean(), github: z.boolean(), cursor: z.boolean().default(false), opencode: z.boolean().default(false), mcp: z.boolean().default(false), hermes: z.boolean().default(false), devin: z.boolean().default(false), openclaw: z.boolean().default(false) }).parse(await this.call({ action: "status" }, "logins"));
  }

  /** Who the account's GitHub login belongs to, or null when GitHub or an older website can't tell. */
  async githubAccount(): Promise<GithubAccount | null> {
    return z.object({ account: githubAccountSchema.nullable() }).parse(await this.call({ action: "github" }, "logins")).account;
  }

  /** Forgets the account's GitHub login for every sandbox. */
  async removeGithubLogin(): Promise<void> {
    await this.call({ action: "remove", name: "github" }, "logins");
    this.uploaded.delete("github");
  }

  private copiedAt = 0;
  get loginsCopied(): boolean { return this.copiedAt > 0; }
  /** Copies this Mac's Codex, Pi, opencode, Hermes, Devin, Cursor, and GitHub logins when the user allowed it (ADRs 0128, 0130).
  /** Copies this Mac's Codex, Pi, opencode, Hermes, OpenClaw, Cursor, and GitHub logins when the user allowed it (ADRs 0128, 0130).
   *  At most once a minute, unless the user just clicked Connect. `github` is false after the user picked another GitHub account. */
  async copyMacLogins(force = false, github = true): Promise<void> {
    if (!force && Date.now() - this.copiedAt < RECHECK_MS) return;
    this.copiedAt = Date.now();
    const piHome = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent");
    const files = [["codex", codexAuthPath()], ["pi", join(piHome, "auth.json")]] as const;
    // One failed login never stops the others; all failures are reported together.
    const failed: string[] = [];
    const save = (name: "codex" | "pi" | "opencode" | "hermes" | "devin" | "openclaw" | "cursor" | "github", value: string) => this.saveLogin(name, value).catch((error: unknown) => { failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); });
    for (const [name, path] of files) {
      const value = await readFile(path, "utf8").catch(() => null);
      if (!value) continue;
      try { JSON.parse(value); } catch { continue; }
      await save(name, value);
    }
    const copy = async (name: "opencode" | "hermes" | "devin" | "openclaw" | "cursor", read: () => Promise<string | null>) => {
      const value = await read().catch((error: unknown) => { failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); return null; });
      if (value) await save(name, value);
    };
    await copy("opencode", macOpencodeCloudLogin);
    await copy("hermes", macHermesLogin);
    await copy("devin", macDevinLogin);
    await copy("openclaw", macOpenclawLogin);
    await copy("cursor", macCursorLogin);
    const githubToken = github ? await macGithubToken() : "";
    if (githubToken) await save("github", await sandboxGithubLogin(githubToken));
    if (failed.length) throw new CloudroomError(`Some logins could not be copied to cloud sandboxes. ${failed.join("; ")}`);
  }

  private pulledAt = 0;
  /** Fills in the Claude and Codex logins this Mac lacks from the account's cloud logins (ADR 0175).
   *  At most once a minute, unless a cloud login just changed. */
  async copyCloudLogins(force = false): Promise<void> {
    if (!force && Date.now() - this.pulledAt < RECHECK_MS) return;
    this.pulledAt = Date.now();
    const [claudeHere, codexHere] = await Promise.all([macClaudeSignedIn(), hasMacCodexLogin()]);
    if (claudeHere) cloudClaude = null;
    if (claudeHere !== false && codexHere) return;
    const saved = await this.logins();
    if (claudeHere === false) {
      const value = saved.claude ? await this.cloudLogin("claude") : null;
      cloudClaude = value ? claudeVariables(value) : null;
    }
    if (!codexHere && saved.codex) {
      const value = await this.cloudLogin("codex");
      if (!value) return;
      await mkdir(dirname(codexAuthPath()), { recursive: true, mode: 0o700 });
      // `wx` never replaces a login Codex saved meanwhile.
      await writeFile(codexAuthPath(), value, { mode: 0o600, flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      this.uploaded.set("codex", createHash("sha256").update(value).digest("hex"));
    }
  }

  private async cloudLogin(name: "claude" | "codex" | "mcp", only?: AccountRequest): Promise<string | null> {
    return z.object({ value: z.string().nullable() }).parse(await this.call({ action: "get", name }, "logins", only)).value;
  }

  private configAt = 0;
  private configDigest = "";
  private configRun: Promise<unknown> = Promise.resolve();
  /** Why the last skills upload failed, until one succeeds. */
  configIssue: string | null = null;
  /** Uploads this Mac's skills and instructions when they change, then pushes them to awake sandboxes. At most once a minute,
   *  unless the user just changed which skills the cloud gets. `inCloud` picks the skills by name. */
  copyMacConfig(inCloud: (name: string) => boolean, force = false): Promise<void> {
    // One upload at a time, so an older skill choice never lands after a newer one.
    const run = this.configRun.then(() => this.uploadConfig(inCloud, force)).catch((error: unknown) => {
      this.configIssue = error instanceof Error ? error.message : String(error);
      throw error;
    });
    this.configRun = run.catch(() => {});
    return run;
  }

  private async uploadConfig(inCloud: (name: string) => boolean, force: boolean): Promise<void> {
    if (!force && Date.now() - this.configAt < RECHECK_MS) return;
    this.configAt = Date.now();
    const home = homedir();
    const instructions = (await Promise.all(INSTRUCTION_FILES.map(path => stat(join(home, path)).then(() => path, () => null)))).filter((path): path is string => path !== null);
    const present = [...(await macSkills()).filter(skill => inCloud(skill.name)).flatMap(skill => skill.paths), ...instructions];
    const files = await configFiles(home, present);
    const run = files.length ? promisify(execFile)(tarCommand(), ["-c", "-h", "--no-recursion", "--format", "ustar", "-C", home, "--null", "-T", "-"],
      { encoding: "buffer", maxBuffer: 4 * CONFIG_LIMIT, timeout: 30_000, env: { ...process.env, COPYFILE_DISABLE: "1" } }) : null;
    run?.child.stdin?.on("error", () => {}).end(files.join("\0") + "\0");
    const tar = run ? (await run).stdout : Buffer.alloc(1024);
    const digest = contentDigest(tar);
    if (digest === this.configDigest) { this.configIssue = null; return; }
    const body = gzipSync(tar);
    if (body.length > CONFIG_LIMIT) throw new CloudroomError("Your skills are too large to copy to cloud sandboxes.");
    const { url } = z.object({ url: z.string().url() }).parse(await this.call({ action: "upload" }, "config"));
    const response = await fetch(url, { method: "PUT", redirect: "error", headers: { "Content-Type": "application/gzip", "x-upsert": "true" }, body, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new CloudroomError(`Your skills could not be copied to cloud sandboxes (HTTP ${response.status}).`);
    this.configDigest = digest;
    this.configIssue = null;
    // Awake sandboxes get the change now; sleeping ones apply it when they wake.
    await this.call({ action: "push" }, "config").catch((error: unknown) => {
      throw new CloudroomError(`Your skills were saved, but awake sandboxes could not get them yet: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}
