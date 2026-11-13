import { execFile } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
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

// `.cloudroom-tmp` in a data folder, given at its real path. Synchronous, so
// ensureDataTempDir's callers can make their folder and start in one step.
function ownTempDir(realDataDir: string): string {
  const base = join(realDataDir, ".cloudroom-tmp");
  if (process.platform === "win32") {
    // Windows has no owner or mode bits to check. The data folder is in the
    // user's profile, which only this account and administrators can write.
    mkdirSync(base, { recursive: true });
    if (!lstatSync(base).isDirectory()) {
      throw new Error(`${base} must be a folder`);
    }
    return base;
  }
  // `.cloudroom-tmp` must be a real, owner-only folder this account owns.
  try {
    mkdirSync(base, { mode: 0o700 });
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
  return ownTempDir(realDataDir);
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
  mkdirSync(dataDir, { recursive: true });
  // The native call, like fs/promises realpath above: the same path everywhere.
  return ownTempDir(realpathSync.native(dataDir));
}
