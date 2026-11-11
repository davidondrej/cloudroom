import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, realpath, stat } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
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
// folder above it. `dataFolder` allows two safe cases: a folder writable by
// this account's private group, and a root-owned sticky folder like /tmp,
// where others cannot rename or delete what this account owns.
async function othersCanChange(
  path: string,
  dataFolder: boolean,
): Promise<boolean> {
  const uid = process.getuid?.();
  for (let folder = path; ; folder = dirname(folder)) {
    const info = await stat(folder);
    if (info.uid !== uid && info.uid !== 0) return true;
    const sticky = dataFolder && info.uid === 0 && (info.mode & 0o1000) !== 0;
    if ((info.mode & 0o002) !== 0 && !sticky) return true;
    if (
      (info.mode & 0o020) !== 0 &&
      !sticky &&
      !(dataFolder && (await isPrivateGroup(info.gid)))
    ) {
      return true;
    }
    if (dirname(folder) === folder) return false;
  }
}

// Plugin processes can run for days and keep trusting the files in their temp
// folder. Every account can create entries in Linux's /tmp, and its cleaner
// deletes idle ones, so another account could recreate a deleted folder with
// its own code. Use the OS temp folder only when no other account can write
// to it or to any folder above it (each account has its own on macOS and
// Windows). Its real path is returned, so no symlink in it can be swapped.
async function privateOsTempDir(): Promise<string | null> {
  if (process.platform === "win32") return tmpdir();
  try {
    const path = await realpath(tmpdir());
    return (await othersCanChange(path, false)) ? null : path;
  } catch {
    return null;
  }
}

// Otherwise the folder goes in `.cloudroom-tmp` under the plugin's data
// folder. Neither may be replaceable by another account, and `.cloudroom-tmp`
// must be a real folder this account owns. It is made owner-only.
async function privateDataTempDir(dataDir: string): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  const realDataDir = await realpath(dataDir);
  if (await othersCanChange(realDataDir, true)) {
    throw new Error(
      `Another account can change ${realDataDir} or a folder above it. Make these folders writable only by you.`,
    );
  }
  const base = join(realDataDir, ".cloudroom-tmp");
  await mkdir(base, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(base);
  if (!info.isDirectory() || info.uid !== process.getuid?.()) {
    throw new Error(`${base} must be a folder owned by this account`);
  }
  if ((info.mode & 0o077) !== 0) await chmod(base, 0o700);
  return base;
}

/** Makes a plugin process's temp folder where no other account can write. */
export async function createPluginProcessTempDir(args: {
  pluginId: string;
  prefix: string;
  dataDir: string;
}): Promise<string> {
  const base =
    (await privateOsTempDir()) ?? (await privateDataTempDir(args.dataDir));
  return mkdtemp(
    join(base, `${args.prefix}-${safePluginSegment(args.pluginId)}-`),
  );
}
