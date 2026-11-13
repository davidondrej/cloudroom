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
const SHARED_CONFIG = ["mcpServers", "projects"];

const claudeHome = () =>
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const claudeConfig = () =>
  path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), ".claude.json");
const synced = new Map<string, number>();

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
  for (const key of SHARED_CONFIG)
    if (main[key] === undefined) delete next[key];
    else next[key] = main[key];
  if (JSON.stringify(next) !== JSON.stringify(own)) {
    const temp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await fs.rename(temp, file);
  }
  synced.set(profile, changed);
}

type Store = Record<string, unknown>;
type SignIn = { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown };
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

async function writeCredentials(dir: string, store: Store): Promise<void> {
  const json = JSON.stringify(store);
  if (process.platform === "darwin") {
    const account = keychainAccount(), service = keychainService(dir);
    const hex = Buffer.from(json, "utf8").toString("hex");
    const line = `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`;
    // Claude Code's own write: stdin keeps the token out of `ps`, argv past security's 4032-byte line limit.
    const { code } = line.length <= 4032
      ? await security(["-i"], line)
      : await security(["add-generic-password", "-U", "-a", account, "-s", service, "-X", hex]);
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
 */
export async function syncMcpSignIns(profile: string): Promise<boolean> {
  const mainDir = process.env.CLAUDE_CONFIG_DIR;
  if (
    process.platform === "darwin" &&
    (keychainFailed.has(keychainService(mainDir)) || keychainFailed.has(keychainService(profile)))
  )
    return false;
  const main = await readCredentials(claudeHome(), mainDir);
  if (!isRecord(main?.mcpOAuth) || !Object.keys(main.mcpOAuth).length) return false;
  // Read every turn: a sign-in the account lost is copied again even when the main login is unchanged.
  if (!mergeSignIns(main.mcpOAuth, (await readCredentials(profile, profile))?.mcpOAuth)) return false;
  const lock = path.join(profile, ".storage-write.lock");
  try {
    await fs.mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    const own = (await readCredentials(profile, profile)) ?? {};
    const merged = mergeSignIns(main.mcpOAuth, own.mcpOAuth);
    if (merged) {
      await writeCredentials(profile, { ...own, mcpOAuth: merged });
      const previous = isRecord(own.mcpOAuth) ? own.mcpOAuth : {};
      await clearMcpAuthCache(profile, Object.keys(merged).filter((key) => merged[key] !== previous[key]));
    }
    return merged !== null;
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

/**
 * An account's own saved login, for a usage read. Null when it is missing or can't be read. Usage reads go over every
 * account in the background, so once any Keychain read has failed (locked, denied, a timeout) none is tried until the
 * app restarts: each could show a macOS popup.
 */
export async function readLogin(profile: string): Promise<unknown> {
  if (process.platform === "darwin" && keychainFailed.size > 0) return null;
  return readCredentials(profile, profile).catch(() => null);
}

const mcpSyncs = new Map<string, Promise<void>>();

/**
 * Runs syncMcpSignIns in the background, one at a time per profile, and waits for it at most `waitMs`.
 * The provider env has a 5 s deadline and each Keychain call can take seconds: a slow Keychain may delay
 * this turn's MCP sign-ins, never its account.
 */
export async function startMcpSync(
  profile: string,
  onError: (error: unknown) => void,
  waitMs = 1_000,
): Promise<void> {
  let running = mcpSyncs.get(profile);
  if (!running) {
    running = syncMcpSignIns(profile).then(() => {}, onError).finally(() => mcpSyncs.delete(profile));
    mcpSyncs.set(profile, running);
  }
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([running, new Promise((resolve) => (timer = setTimeout(resolve, waitMs)))]);
  clearTimeout(timer);
}
