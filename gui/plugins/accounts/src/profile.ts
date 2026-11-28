import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Chat history, session state, and the user's own setup are shared. Logins and account caches are not.
const SHARED = [
  "projects",
  "file-history",
  "todos",
  "plans",
  "agent-memory",
  "settings.json",
  "CLAUDE.md",
  "skills",
  "agents",
  "commands",
  "output-styles",
  "hooks",
  "plugins",
  "rules",
  "keybindings.json",
];
const SESSION_DIRS = ["projects", "file-history", "todos", "plans"];

const claudeHome = () =>
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const claudeConfig = () =>
  path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), ".claude.json");
const synced = new Map<string, number>();
const linkedHome = new Map<string, { home: string; mtimeMs: number }>();

async function keepNewer(target: string, link: string): Promise<boolean> {
  const [from, to] = await Promise.all([
    fs.stat(target, { bigint: true }),
    fs.lstat(link, { bigint: true }).catch(() => null),
  ]);
  if (!to?.isFile()) return false;
  if (to.ino === from.ino && to.dev === from.dev) return true;
  if (to.mtimeMs > from.mtimeMs)
    await fs.cp(link, target, { preserveTimestamps: true });
  return false;
}

async function linkOnWindows(target: string, link: string): Promise<void> {
  if ((await fs.stat(target)).isDirectory())
    return fs.symlink(target, link, "junction");
  if (await keepNewer(target, link)) return;
  await fs.rm(link, { force: true });
  await fs
    .link(target, link)
    .catch((error: NodeJS.ErrnoException) =>
      error.code === "EXDEV"
        ? fs.cp(target, link, { preserveTimestamps: true })
        : Promise.reject(error),
    );
}

export async function releaseProfile(profile: string): Promise<void> {
  synced.delete(profile);
  linkedHome.delete(profile);
  mcpSyncedAt.delete(profile);
  if (process.platform !== "win32") return;
  const home = claudeHome();
  for (const name of SHARED) {
    const target = path.join(home, name);
    if (await fs.lstat(target).catch(() => null))
      await keepNewer(target, path.join(profile, name));
  }
}

export async function prepareProfile(profile: string): Promise<void> {
  const home = claudeHome();
  const homeMtime =
    process.platform !== "win32"
      ? (await fs.stat(home).catch(() => null))?.mtimeMs
      : undefined;
  const cachedLinks = linkedHome.get(profile);
  if (
    process.platform === "win32" ||
    homeMtime === undefined ||
    cachedLinks?.home !== home ||
    cachedLinks.mtimeMs !== homeMtime
  ) {
    await fs.mkdir(profile, { recursive: true, mode: 0o700 });
    await Promise.all(
      SESSION_DIRS.map((name) =>
        fs.mkdir(path.join(home, name), { recursive: true }),
      ),
    );
    await Promise.all(
      SHARED.map(async (name) => {
        const target = path.join(home, name);
        if (!(await fs.lstat(target).catch(() => null))) return;
        const link = path.join(profile, name);
        await (
          process.platform === "win32"
            ? linkOnWindows(target, link)
            : fs.symlink(target, link)
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
      }),
    );
    if (process.platform !== "win32") {
      const nextHomeMtime = (await fs.stat(home).catch(() => null))?.mtimeMs;
      if (nextHomeMtime !== undefined)
        linkedHome.set(profile, { home, mtimeMs: nextHomeMtime });
    }
  }
  const changed = (await fs.stat(claudeConfig()).catch(() => null))?.mtimeMs;
  if (changed === undefined || synced.get(profile) === changed) return;
  const main = JSON.parse(await fs.readFile(claudeConfig(), "utf8")) as Record<
    string,
    unknown
  >;
  const file = path.join(profile, ".claude.json");
  const own = JSON.parse(
    await fs.readFile(file, "utf8").catch(() => "{}"),
  ) as Record<string, unknown>;
  const next = { ...own };
  // Main's MCP servers sync in; ones added in this account stay (#2318): user scope (`claude mcp add -s user`)
  // and each folder's local scope (a plain `claude mcp add`). Every other `projects` field comes from main.
  const fromMain = path.join(profile, "cloudroom-main-mcp-servers.json");
  const saved: unknown = await fs
    .readFile(fromMain, "utf8")
    .then(JSON.parse)
    .catch(() => null);
  // The first version of this file listed only user-scope names.
  const before = isRecord(saved) ? saved : { mcpServers: saved };
  const shared = isRecord(main.mcpServers) ? main.mcpServers : {};
  if (main.mcpServers !== undefined || own.mcpServers !== undefined)
    next.mcpServers = mergeServers(own.mcpServers, shared, before.mcpServers);
  const mainProjects = isRecord(main.projects) ? main.projects : {};
  const ownProjects = isRecord(own.projects) ? own.projects : {};
  // With no per-folder list yet, the account's folder servers were all copies of main's.
  const beforeProjects = isRecord(before.projects)
    ? before.projects
    : Object.fromEntries(
        Object.entries(ownProjects).map(([cwd, entry]) => [
          cwd,
          isRecord(entry) && isRecord(entry.mcpServers)
            ? Object.keys(entry.mcpServers)
            : [],
        ]),
      );
  const projects: Store = { ...mainProjects };
  const sharedProjects: Record<string, string[]> = {};
  for (const cwd of new Set([
    ...Object.keys(mainProjects),
    ...Object.keys(ownProjects),
  ])) {
    const theirs = mainProjects[cwd];
    const from =
      isRecord(theirs) && isRecord(theirs.mcpServers) ? theirs.mcpServers : {};
    if (Object.keys(from).length) sharedProjects[cwd] = Object.keys(from);
    const mine = ownProjects[cwd];
    const servers = mergeServers(
      isRecord(mine) ? mine.mcpServers : undefined,
      from,
      beforeProjects[cwd],
    );
    if (Object.keys(servers).length <= Object.keys(from).length) continue;
    projects[cwd] = isRecord(theirs)
      ? { ...theirs, mcpServers: servers }
      : { mcpServers: servers };
  }
  if (main.projects === undefined && !Object.keys(projects).length)
    delete next.projects;
  else next.projects = projects;
  const save = async (target: string, text: string) => {
    const temp = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, text, { mode: 0o600 });
    await fs.rename(temp, target);
  };
  if (JSON.stringify(next) !== JSON.stringify(own))
    await save(file, JSON.stringify(next, null, 2));
  const names = JSON.stringify({
    mcpServers: Object.keys(shared),
    projects: sharedProjects,
  });
  if (names !== JSON.stringify(saved)) await save(fromMain, names);
  synced.set(profile, changed);
}

type Store = Record<string, unknown>;
/** Main's servers win; the account's own stay unless main had them last sync and has removed them since. */
function mergeServers(own: unknown, shared: Store, before: unknown): Store {
  const servers: Store = isRecord(own) ? { ...own } : {};
  for (const name of Array.isArray(before) ? before : [])
    if (!Object.hasOwn(shared, name)) delete servers[name];
  return Object.assign(servers, shared);
}
type SignIn = { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown };
type Warn = (error: Error) => void;
const NOT_FOUND = 44;
// A failed Keychain read may have shown a macOS popup, so that entry is not read again until the app restarts.
const keychainFailed = new Set<string>();

const isRecord = (value: unknown): value is Store =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasToken = (value: unknown): value is SignIn =>
  isRecord(value) && Boolean(value.accessToken || value.refreshToken);
const expiry = (signIn: SignIn) =>
  typeof signIn.expiresAt === "number" ? signIn.expiresAt : 0;

/** Claude Code's Keychain entry for a config folder: hashed once CLAUDE_CONFIG_DIR is set (verified on 2.1.316). */
export const keychainService = (dir?: string) =>
  `Claude Code-credentials${dir ? `-${createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8)}` : ""}`;

function keychainAccount(): string {
  let user = "";
  try {
    user = process.env.USER || os.userInfo().username;
  } catch {}
  return /^[a-zA-Z0-9._-]+$/.test(user) ? user : "claude-code-user";
}

function security(
  args: string[],
  input?: string,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile("security", args, { timeout: 5_000 }, (error, stdout) =>
      resolve({
        code: !error ? 0 : typeof error.code === "number" ? error.code : -1,
        stdout: String(stdout),
      }),
    );
    child.stdin?.end(input);
  });
}

// JSON.parse errors quote the input, so they never reach the log.
const parseStore = (raw: string): Store => {
  const text = raw.trim();
  let value: unknown;
  try {
    value = JSON.parse(/^(?:[0-9a-f]{2})+$/i.test(text) ? Buffer.from(text, "hex").toString("utf8") : text);
  } catch {}
  if (!isRecord(value)) throw new Error("Claude credentials are not readable JSON.");
  return value;
};

/** Like Claude Code: the Keychain on macOS, then `.credentials.json` in the folder. Null when neither exists; throws when unreadable. */
async function readCredentials(dir: string, keychainDir?: string): Promise<Store | null> {
  if (process.platform === "darwin") {
    const service = keychainService(keychainDir);
    const { code, stdout } = await security(["find-generic-password", "-a", keychainAccount(), "-w", "-s", service]);
    if (code === 0 && stdout.trim()) return parseStore(stdout);
    if (code !== 0 && code !== NOT_FOUND) {
      keychainFailed.add(service);
      throw new Error(`Keychain read failed (security exited ${code}); not tried again until the app restarts.`);
    }
  }
  const file = await fs
    .readFile(path.join(dir, ".credentials.json"), "utf8")
    .catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : Promise.reject(error)));
  return file?.trim() ? parseStore(file) : null;
}

// Stdin keeps the tokens out of `ps`. `security -i` reads 4095 characters a line (Claude Code keeps 64 spare) and
// has no other secret input. Never argv, Claude Code's own fallback for a larger store: any same-user process reads it.
const LINE_LIMIT = 4032;
const keychainLine = (dir: string, json: string) =>
  `add-generic-password -U -a "${keychainAccount()}" -s "${keychainService(dir)}" -X "${Buffer.from(json, "utf8").toString("hex")}"\n`;
const fits = (dir: string, store: Store) =>
  process.platform !== "darwin" ||
  keychainLine(dir, JSON.stringify(store)).length <= LINE_LIMIT;

async function writeCredentials(dir: string, store: Store): Promise<void> {
  const json = JSON.stringify(store);
  if (process.platform === "darwin") {
    const line = keychainLine(dir, json);
    if (line.length > LINE_LIMIT)
      throw new Error(
        `Credentials too large for a safe Keychain write (${line.length} characters, limit ${LINE_LIMIT}).`,
      );
    const { code } = await security(["-i"], line);
    if (code !== 0) throw new Error(`Keychain write failed (security exited ${code}).`);
    return;
  }
  const file = path.join(dir, ".credentials.json");
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, json, { mode: 0o600 });
  await fs.rename(temp, file);
}

/**
 * The profile's sign-ins with the main login's newer ones merged in, or null when nothing changes.
 * Copies carry only an access token that hasn't expired, never the refresh token: servers that rotate
 * refresh tokens would sign every other copy out once one refreshes. A sign-in the account made itself
 * (it has a refresh token) is kept.
 */
export function mergeSignIns(main: unknown, own: unknown): Store | null {
  const now = Date.now();
  if (!isRecord(main)) return null;
  const next: Store = isRecord(own) ? { ...own } : {};
  let changed = false;
  for (const [key, signIn] of Object.entries(main)) {
    if (!isRecord(signIn) || !signIn.accessToken) continue;
    if (typeof signIn.expiresAt === "number" && signIn.expiresAt <= now) continue;
    const mine = next[key];
    if (hasToken(mine) && (mine.refreshToken || expiry(mine) >= expiry(signIn))) continue;
    const { refreshToken: _, ...copy } = signIn;
    next[key] = copy;
    changed = true;
  }
  return changed ? next : null;
}

// Servers whose sign-in didn't fit, per account, so each change is logged once.
const skippedSignIns = new Map<string, string>();

/**
 * The account's store with the main login's newer MCP sign-ins, smallest first, as many as fit one Keychain write.
 * The account's own login and live sign-ins stay as they are; `warn` names the rest once per change.
 */
async function addSignIns(profile: string, main: unknown, warn: Warn) {
  const own = (await readCredentials(profile, profile)) ?? {};
  const merged = mergeSignIns(main, own.mcpOAuth) ?? {};
  const previous = isRecord(own.mcpOAuth) ? own.mcpOAuth : {};
  const size = (key: string) => JSON.stringify(merged[key]).length;
  const keys = Object.keys(merged).filter((k) => merged[k] !== previous[k]);
  // Start without the expired ones that can't refresh: a store saved through argv before #1917 can be
  // over the limit. A sign-in being replaced stays until its replacement fits, so a working one is never lost.
  const now = Date.now();
  const mcpOAuth: Store = {};
  for (const [key, value] of Object.entries(previous)) {
    const dead =
      hasToken(value) &&
      !value.refreshToken &&
      typeof value.expiresAt === "number" &&
      value.expiresAt <= now;
    if (!dead) mcpOAuth[key] = value;
  }
  const copied: string[] = [];
  const skipped = new Set<string>();
  for (const key of keys.sort((a, b) => size(a) - size(b))) {
    const next = { ...own, mcpOAuth: { ...mcpOAuth, [key]: merged[key] } };
    if (fits(profile, next)) {
      mcpOAuth[key] = merged[key];
      copied.push(key);
    } else skipped.add(key.replace(/\|[^|]*$/, ""));
  }
  const names = [...skipped].sort().join(", ");
  if (names && names !== skippedSignIns.get(profile))
    warn(new Error(`${names}: too large for one safe Keychain write.`));
  skippedSignIns.set(profile, names);
  return { store: { ...own, mcpOAuth }, copied };
}

async function clearMcpAuthCache(profile: string, copied: string[]): Promise<void> {
  const file = path.join(profile, "mcp-needs-auth-cache.json");
  const raw = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (raw === null) return;
  let cache: unknown;
  try {
    cache = JSON.parse(raw);
  } catch {}
  if (!isRecord(cache)) throw new Error("MCP authentication cache is not readable JSON.");
  let changed = false;
  for (const key of copied) {
    const separator = key.lastIndexOf("|");
    const name = separator < 0 ? key : key.slice(0, separator);
    if (!Object.hasOwn(cache, name)) continue;
    delete cache[name];
    changed = true;
  }
  if (!changed) return;
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(cache), { mode: 0o600 });
  await fs.rename(temp, file);
}

/**
 * Copies MCP OAuth sign-ins (`mcpOAuth`) from the main Claude login into an added account's own
 * credentials, so OAuth MCP servers work there without signing in again (#661). Only `mcpOAuth`
 * changes; the account's `claudeAiOauth` is kept. Takes Claude Code's own write lock, or skips this turn.
 * Sign-ins that don't fit one Keychain write are skipped and reported through `warn` once.
 */
export async function syncMcpSignIns(
  profile: string,
  warn: Warn = () => {},
): Promise<boolean> {
  const mainDir = process.env.CLAUDE_CONFIG_DIR;
  if (
    process.platform === "darwin" &&
    (keychainFailed.has(keychainService(mainDir)) || keychainFailed.has(keychainService(profile)))
  )
    return false;
  const main = await readCredentials(claudeHome(), mainDir);
  if (!isRecord(main?.mcpOAuth) || !Object.keys(main.mcpOAuth).length) return false;
  // Read every turn: a sign-in the account lost is copied again even when the main login is unchanged.
  const planned = await addSignIns(profile, main.mcpOAuth, warn);
  if (!planned.copied.length) return false;
  const lock = path.join(profile, ".storage-write.lock");
  try {
    await fs.mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    const { store, copied } = await addSignIns(profile, main.mcpOAuth, warn);
    if (copied.length) {
      await writeCredentials(profile, store);
      await clearMcpAuthCache(profile, copied);
    }
    return copied.length > 0;
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

/**
 * An account's own saved login, for a usage read. Null when it is missing or can't be read. Usage reads go over every
 * account in the background, so once any Keychain read has failed (locked, denied, a timeout) none is tried until the
 * app restarts: each could show a macOS popup.
 */
export async function readLogin(profile?: string): Promise<unknown> {
  if (process.platform === "darwin" && keychainFailed.size > 0) return null;
  return readCredentials(profile ?? claudeHome(), profile ?? process.env.CLAUDE_CONFIG_DIR).catch(() => null);
}

const MCP_SYNC_MIN_INTERVAL_MS = 60_000;
const mcpSyncs = new Map<string, Promise<void>>();
const mcpSyncedAt = new Map<string, number>();

/**
 * Runs syncMcpSignIns in the background, one at a time per profile.
 * Waits up to `waitMs` on the first sync per profile so a newly started app or account gets its MCP sign-ins;
 * later turns refresh in the background at most once per minute so Keychain calls never block follow-up turns.
 */
export async function startMcpSync(
  profile: string,
  onError: (error: unknown) => void,
  waitMs = 1_000,
): Promise<void> {
  const lastSyncedAt = mcpSyncedAt.get(profile);
  if (
    lastSyncedAt !== undefined &&
    Date.now() - lastSyncedAt < MCP_SYNC_MIN_INTERVAL_MS
  )
    return;
  let running = mcpSyncs.get(profile);
  if (!running) {
    running = syncMcpSignIns(profile, onError)
      .then(() => {
        mcpSyncedAt.set(profile, Date.now());
      }, onError)
      .finally(() => mcpSyncs.delete(profile));
    mcpSyncs.set(profile, running);
  }
  if (lastSyncedAt !== undefined) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([running, new Promise((resolve) => (timer = setTimeout(resolve, waitMs)))]);
  clearTimeout(timer);
}
