import type { HostDirectoryListing } from "@cloudroom/server-contract";

/** Path typing in the project picker: `~/co` + Tab gives `~/code/`, like a shell. */
export type FolderEntry = HostDirectoryListing["entries"][number];

/** A path as typed or pasted: leading spaces, one pair of quotes, and shell escapes (`My\ Folder`) removed.
 *  On Windows a drive path (`C:\code\app`) keeps its backslashes: they separate its folders. */
export function cleanPathQuery(query: string, windows = false): string {
  const text = query.trimStart();
  const quoted =
    text.length > 1 && (text[0] === '"' || text[0] === "'") && text.at(-1) === text[0];
  const unquoted = quoted ? text.slice(1, -1) : text;
  return windows && isDrivePath(unquoted) ? unquoted : unquoted.replace(/\\(.)/g, "$1");
}

/** `C:\…` or `C:/…`: an absolute path on a Windows drive. */
export const isDrivePath = (query: string) => /^[A-Za-z]:[\\/]/.test(query);

/** `~`, `~/…`, or `/…` turns the search into a path. `~foo` stays a name. */
export const isPathQuery = (query: string) =>
  query === "~" || query.startsWith("~/") || query.startsWith("/");

/** Splits at the last `/` (or `\` in a drive path): the folder to list, as typed, and the name being typed in it. */
export function splitPathQuery(query: string): { folder: string; leaf: string } {
  if (query === "~") return { folder: "~/", leaf: "" };
  const at = isDrivePath(query) ? Math.max(query.lastIndexOf("/"), query.lastIndexOf("\\")) : query.lastIndexOf("/");
  return { folder: query.slice(0, at + 1), leaf: query.slice(at + 1) };
}

/** The absolute folder a typed folder names, with `~`, `.`, and `..` resolved. Null until home is known. */
export function resolveFolder(folder: string, home: string | null): string | null {
  // The host resolves a drive path itself.
  if (isDrivePath(folder)) return folder;
  if (folder.startsWith("~") && !home) return null;
  const absolute = folder.startsWith("~") ? `${home}${folder.slice(1)}` : folder;
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** `/Users/me/code` → `~/code`. */
export function tildePath(path: string, home: string | null): string {
  if (!home) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Subfolders whose names start with `leaf`, most likely first: the exact name, then the most recently used. */
export function matchFolders(entries: readonly FolderEntry[], leaf: string): FolderEntry[] {
  const needle = leaf.toLowerCase();
  const exact = (entry: FolderEntry) =>
    entry.name === leaf ? 2 : entry.name.toLowerCase() === needle ? 1 : 0;
  return entries
    .filter((entry) => entry.kind === "directory" && entry.name.toLowerCase().startsWith(needle))
    .sort((a, b) => exact(b) - exact(a) || (b.activityAt ?? 0) - (a.activityAt ?? 0));
}

export const folderValue = (path: string) => `folder:${path}`;
