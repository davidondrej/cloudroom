import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DirectoryEntry } from "@cloudroom/host-daemon-contract";

/** macOS asks before an app reads inside these home folders, so the picker never looks inside them unasked. */
const MAC_PRIVACY_FOLDERS = new Set(["Applications", "Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures", "Public"]);
/** Build and dependency folders: huge, and never a project of their own. */
const SKIP_NAMES = new Set(["node_modules", "vendor", "dist", "build", "target", "venv", "__pycache__"]);
const MAX_DEPTH = 4;
const MAX_FOLDERS = 50_000;
const WALK_BUDGET_MS = 3_000;
const FRESH_MS = 5 * 60_000;
const RESULTS = 30;
const PARALLEL = 64;

type Activity = Pick<DirectoryEntry, "activityAt" | "git">;
interface Folder extends Activity { name: string; path: string; depth: number }

/** Home as given and as resolved: listings use the resolved path, so a symlinked home must match both. */
let homes: Set<string> | null = null;
const homePaths = () => {
  if (!homes) {
    let real = os.homedir();
    try { real = realpathSync(real); } catch {}
    homes = new Set([os.homedir(), real]);
  }
  return homes;
};

export const isPrivacyFolder = (folder: string) =>
  process.platform === "darwin" && homePaths().has(path.dirname(folder)) && MAC_PRIVACY_FOLDERS.has(path.basename(folder));

/** When a folder was last used: its own change time, or for a Git repo the latest commit, checkout, or staging. */
export async function folderActivity(folder: string, probeGit = true): Promise<Activity> {
  const [self, dotGit] = await Promise.all([
    fs.stat(folder).catch(() => null),
    probeGit ? fs.lstat(path.join(folder, ".git")).catch(() => null) : null,
  ]);
  const activityAt = Math.round(self?.mtimeMs ?? 0);
  if (!dotGit) return { activityAt };
  if (!dotGit.isDirectory()) return { activityAt, git: "worktree" };
  const touched = await Promise.all(["index", "logs/HEAD"].map((file) =>
    fs.stat(path.join(folder, ".git", file)).then((info) => Math.round(info.mtimeMs), () => 0)));
  return { activityAt: Math.max(activityAt, ...touched), git: "repo" };
}

interface Visit { folder: string; depth: number; inRepo: boolean }

/** Reads one folder, records it, and returns the subfolders worth entering.
 *  Inside a repo only nested repos count, so `~/code` can be a repo of repos without its `src` folders flooding results. */
async function visit({ folder, depth, inRepo }: Visit, found: Folder[]): Promise<Visit[]> {
  const dirents = await fs.readdir(folder, { withFileTypes: true }).catch(() => null);
  if (!dirents) return [];
  const dotGit = dirents.find((dirent) => dirent.name === ".git");
  // A worktree or submodule belongs to another repo, so it is never a new project.
  if (dotGit && !dotGit.isDirectory()) return [];
  if (depth > 0 && (dotGit || !inRepo)) found.push({ name: path.basename(folder), path: folder, depth, ...(await folderActivity(folder, Boolean(dotGit))) });
  if (depth >= MAX_DEPTH) return [];
  const children: Visit[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || dirent.name.startsWith(".") || SKIP_NAMES.has(dirent.name)) continue;
    const child = path.join(folder, dirent.name);
    if (isPrivacyFolder(child)) found.push({ name: dirent.name, path: child, depth: depth + 1, activityAt: 0 });
    else children.push({ folder: child, depth: depth + 1, inRepo: inRepo || Boolean(dotGit) });
  }
  return children;
}

/** Every folder under `root`, a few levels deep, within a time and size budget.
 *  A read that never returns (a dead network mount) is abandoned at the deadline, so the walk always finishes. */
async function walk(root: string): Promise<Folder[]> {
  const started = Date.now();
  const found: Folder[] = [];
  const untilDeadline = <T>(work: Promise<T>, fallback: T) => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), Math.max(0, started + WALK_BUDGET_MS - Date.now())); });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  };
  let level: Visit[] = [{ folder: root, depth: 0, inRepo: false }];
  while (level.length > 0) {
    const next: Visit[] = [];
    for (let i = 0; i < level.length; i += PARALLEL) {
      if (Date.now() - started > WALK_BUDGET_MS || found.length >= MAX_FOLDERS) return found;
      const visits = level.slice(i, i + PARALLEL).map((item) => untilDeadline(visit(item, found), [] as Visit[]));
      for (const children of await Promise.all(visits)) next.push(...children);
    }
    level = next;
  }
  return found;
}

/** One walk per root, kept for 5 minutes. Older results answer at once while a fresh walk runs. */
const indexes = new Map<string, { at: number; folders: Folder[] | null; walking: Promise<Folder[]> | null }>();
function folderIndex(root: string): Promise<Folder[]> {
  let index = indexes.get(root);
  if (!index) indexes.set(root, (index = { at: 0, folders: null, walking: null }));
  const entry = index;
  if (Date.now() - entry.at > FRESH_MS && !entry.walking) {
    entry.walking = walk(root)
      .then((folders) => Object.assign(entry, { folders, at: Date.now() }).folders as Folder[])
      .finally(() => { entry.walking = null; });
  }
  return entry.folders ? Promise.resolve(entry.folders) : (entry.walking as Promise<Folder[]>);
}

/** Exact name, then name prefix, then name contains. Within each: repos, then most recently used, then shallower. */
export function rankFolders<T extends Folder>(folders: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  const tier = (folder: T) => {
    const name = folder.name.toLowerCase();
    return name === q ? 3 : name.startsWith(q) ? 2 : name.includes(q) ? 1 : 0;
  };
  return folders
    .map((folder) => ({ folder, tier: tier(folder) }))
    .filter(({ tier }) => tier > 0)
    .sort((a, b) => b.tier - a.tier
      || Number(b.folder.git === "repo") - Number(a.folder.git === "repo")
      || (b.folder.activityAt ?? 0) - (a.folder.activityAt ?? 0)
      || a.folder.depth - b.folder.depth)
    .map(({ folder }) => folder);
}

/** Folders anywhere under `root` whose names match `query`, best first. An empty query only warms the index. */
export async function searchFolders(root: string, query: string): Promise<DirectoryEntry[]> {
  const folders = await folderIndex(root);
  if (!query.trim()) return [];
  return rankFolders(folders, query).slice(0, RESULTS)
    .map(({ name, path: folder, activityAt, git }) => ({ kind: "directory" as const, name, path: folder, activityAt, ...(git ? { git } : {}) }));
}
