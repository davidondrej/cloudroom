import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface LocalRepo { name: string; path: string; updatedAt: number; remote: string | null }

const MAC_PRIVACY_FOLDERS = new Set(["Applications", "Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures", "Public"]);
const ROOTS = ["", "code", "Code", "Projects", "projects", "Developer", "dev", "src", "repos", "GitHub", "work"];

const mtime = (path: string) => stat(path).then((info) => info.mtimeMs, () => 0);
const originUrl = (git: string) => readFile(join(git, "config"), "utf8").then((config) => config.match(/\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/)?.[1] ?? null, () => null);

export async function localRepos(limit = 8): Promise<LocalRepo[]> {
  const home = homedir();
  const found = new Map<string, LocalRepo>();
  // On a Mac, ~/code and ~/Code are one folder; the real path gives each repo one spelling.
  const roots = new Set(await Promise.all(ROOTS.map((root) => realpath(join(home, root)).catch(() => ""))));
  roots.delete("");
  await Promise.all([...roots].map(async (folder) => {
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory() || entry.name.startsWith(".") || (folder === home && MAC_PRIVACY_FOLDERS.has(entry.name))) return;
      const path = join(folder, entry.name), git = join(path, ".git");
      const updatedAt = Math.max(await mtime(join(git, "index")), await mtime(join(git, "logs", "HEAD")), await mtime(git));
      if (updatedAt > 0) found.set(path.toLowerCase(), { name: entry.name, path, updatedAt, remote: await originUrl(git) });
    }));
  }));
  return [...found.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

/** The folder that holds most of the user's recent repos, so new clones land next to them. Falls back to ~/code. */
export async function repoHome(): Promise<string> {
  const home = homedir();
  const counts = new Map<string, number>();
  // Repos come newest first, so a tie goes to the folder with the most recent work.
  for (const repo of await localRepos(10)) {
    const parent = dirname(repo.path);
    if (parent !== home) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? join(home, "code");
}

/** A free folder for a new clone of `name`: <repo home>/<name>, then <name>-2, <name>-3, and so on. */
export async function cloneTarget(name: string): Promise<string> {
  const home = await repoHome();
  for (let n = 1; ; n++) {
    const path = join(home, n === 1 ? name : `${name}-${n}`);
    if (!(await stat(path).then(() => true, () => false))) return path;
  }
}
