import { execFile } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { mkdir, mkdtemp, realpath, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function safePluginSegment(pluginId: string): string {
  return encodeURIComponent(pluginId);
}

export async function ensurePluginProcessDataDir(args: {
  daemonDataDir: string;
  pluginId: string;
  kind: "host-data" | "bridge-data";
}): Promise<string> {
  const directory = join(
    args.daemonDataDir,
    "plugins",
    safePluginSegment(args.pluginId),
    args.kind,
  );
  await mkdir(directory, { recursive: true });
  return directory;
}

const privateGroups = new Map<number, Promise<boolean>>();

// A user private group (the default on Fedora, RHEL and Ubuntu, which makes
// new folders 0775): named after this account, with no other members.
function isPrivateGroup(gid: number): Promise<boolean> {
  let result = privateGroups.get(gid);
  if (result === undefined) {
    result = execFileAsync("getent", ["group", String(gid)], { timeout: 5_000 })
      .then(({ stdout }) => {
        const [name, , , members = ""] = stdout.trim().split(":");
        const me = userInfo().username;
        return name === me && members.split(",").every((m) => !m || m === me);
      })
      .catch(() => false);
    privateGroups.set(gid, result);
  }
  return result;
}

// True when an account other than this one and root could replace `path` or a
// folder above it. Two cases are safe: a folder writable by this account's
// private group, and a root-owned sticky folder like /tmp, where others cannot
// rename or delete what this account owns.
async function othersCanChange(path: string): Promise<boolean> {
  const uid = process.getuid?.();
  for (let folder = path; ; folder = dirname(folder)) {
    const info = await stat(folder);
    if (info.uid !== uid && info.uid !== 0) return true;
    const sticky = info.uid === 0 && (info.mode & 0o1000) !== 0;
    if ((info.mode & 0o002) !== 0 && !sticky) return true;
    if (
      (info.mode & 0o020) !== 0 &&
      !sticky &&
      !(await isPrivateGroup(info.gid))
    ) {
      return true;
    }
    if (dirname(folder) === folder) return false;
  }
}

// `name` (`.cloudroom-tmp`, `environment-hooks`) in a data folder, given at its
// real path, made unless `create` is false. Synchronous, so ensureDataTempDir's
// callers can make their folder and start in one step.
function ownPrivateDir(realDataDir: string, name: string, create = true): string {
  const base = join(realDataDir, name);
  if (process.platform === "win32") {
    // Windows has no owner or mode bits to check. The data folder is in the
    // user's profile, which only this account and administrators can write.
    if (create) mkdirSync(base, { recursive: true });
    if (!lstatSync(base).isDirectory()) {
      throw new Error(`${base} must be a folder`);
    }
    return base;
  }
  // It must be a real, owner-only folder this account owns.
  try {
    if (create) mkdirSync(base, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = lstatSync(base);
  if (!info.isDirectory() || info.uid !== process.getuid?.()) {
    throw new Error(`${base} must be a folder owned by this account`);
  }
  if ((info.mode & 0o077) !== 0) chmodSync(base, 0o700);
  return base;
}

// Plugin processes can run for days, and keep running or loading the files in
// their temp folder: the Codex Command Guard, Pi's extension, Claude's skill
// plugins. Nothing less trusted than Cloudroom may write that folder, so it is
// never the OS temp folder. Other accounts can write Linux's /tmp. Code that
// runs as this account in a sandbox can write the account's own temp folder:
// macOS Read-only Mac commands may write all of /private/var/folders, and
// Codex's workspace-write sandbox may write $TMPDIR (%TEMP% on Windows). They
// cannot write Cloudroom's data folder, so the folder goes in `.cloudroom-tmp`
// under the plugin's data folder. Its real path is returned, so no symlink in
// it can be swapped.
async function privateDataTempDir(dataDir: string): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  const realDataDir = await realpath(dataDir);
  // No other account may be able to replace the data folder or a folder above it.
  if (process.platform !== "win32" && (await othersCanChange(realDataDir))) {
    throw new Error(
      `Another account can change ${realDataDir} or a folder above it. Make these folders writable only by you.`,
    );
  }
  return ownPrivateDir(realDataDir, ".cloudroom-tmp");
}

/** Makes a plugin process's temp folder in its data folder, never in the OS temp folder. */
export async function createPluginProcessTempDir(args: {
  prefix: string;
  dataDir: string;
}): Promise<string> {
  // The data folder's path names the plugin already. A short name keeps
  // Windows paths under 260 characters.
  return mkdtemp(
    join(await privateDataTempDir(args.dataDir), `${args.prefix}-`),
  );
}

/**
 * `<dataDir>/.cloudroom-tmp`, for what Cloudroom runs outside any sandbox (an
 * installer, Claude's sign-in opener) and for a tool's working folder. Make a
 * fresh folder in it with mkdtemp, and remove that folder when done.
 *
 * Never use the OS temp folder for these, for the reasons above. They stay out
 * of reach only while the data folder is outside every temp folder and project
 * folder, as the default ~/.gui-cloudroom is. Each plugin process start
 * already checks that no other account can change Cloudroom's data folder or a
 * folder above it.
 */
export function ensureDataTempDir(dataDir: string): string {
  return ensureDataPrivateDir(dataDir, ".cloudroom-tmp");
}

/**
 * `<dataDir>/<name>`: an owner-only folder for files Cloudroom keeps and later
 * runs outside any sandbox, such as an environment's saved lifecycle hooks.
 * The same rules as `.cloudroom-tmp` above apply.
 */
export function ensureDataPrivateDir(dataDir: string, name: string): string {
  mkdirSync(dataDir, { recursive: true });
  // The native call, like fs/promises realpath above: the same path everywhere.
  return ownPrivateDir(realpathSync.native(dataDir), name);
}

/**
 * `<dataDir>/<name>` as ensureDataPrivateDir made it before, with the same
 * checks, but never made here. For a folder no sandbox may read: on Linux,
 * Claude's sandbox hides only paths that exist when it starts, so the folder
 * must not appear while one runs.
 */
export function existingDataPrivateDir(dataDir: string, name: string): string {
  return ownPrivateDir(realpathSync.native(dataDir), name, false);
}

/**
 * `<dataDir>/chat-file-copies`: Cloudroom's copies of the images chats showed,
 * one folder per thread. Owner-only, and on the list below, because a copy is
 * written outside every sandbox and may hold any file an agent named.
 */
export const CHAT_FILE_COPIES_DIR_NAME = "chat-file-copies";

// Files in the data folder that hold credentials or every thread's data: the
// host key, the cloud account token, the auth secret, the browser broker token,
// Codex account tokens, share tokens, plugin state backups, the app database,
// and chat image copies. Not the whole folder: managed worktrees, attachments,
// and thread storage live there too, and agents need them.
const PRIVATE_DATA_FILES = [
  "auth.json",
  "auth-secret",
  "machine-environment-key",
  "cloudroom.json",
  "desktop-browser-broker.json",
  "cloudroom-codex-accounts.json",
  "thread-shares.json",
  "bb.db",
  "bb.db-wal",
  "bb.db-shm",
  "bb.db-journal",
  join("plugins", "accounts", "secrets"),
  join("plugins", "snapshots"),
  CHAT_FILE_COPIES_DIR_NAME,
];

// Real paths, not wildcards: Claude's sandbox matches wildcards differently on
// Linux. A secret created later is covered from the next session.
function childPaths(dir: string, pick: (name: string) => string | null): string[] {
  try {
    return readdirSync(dir).flatMap((name) => {
      const child = pick(name);
      return child === null ? [] : [join(dir, child)];
    });
  } catch {
    return [];
  }
}

/** Paths a sandboxed agent must never read (#2191); empty without a data folder. */
export function privateDataPaths(dataDir: string | undefined): string[] {
  const root = dataDir?.trim();
  if (!root) return [];
  const plugins = join(root, "plugins");
  return [
    ...new Set([
      ...PRIVATE_DATA_FILES.map((name) => join(root, name)),
      // Every plugin's secret settings and HTTP token.
      ...childPaths(plugins, (name) => join(name, "secrets")),
      // Claude logins of added accounts (Linux and Windows keep them in a file).
      ...childPaths(join(plugins, "accounts", "profiles"), (name) =>
        join(name, ".credentials.json"),
      ),
      // The preview helper's SSH key, including parked account folders.
      ...childPaths(root, (name) =>
        name.startsWith("cloudroom-preview") ? join(name, "id_ed25519") : null,
      ),
    ]),
  ];
}
