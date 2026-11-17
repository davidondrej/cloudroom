import { promises as fs } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  sep,
} from "node:path";

export async function isPathInsideRoots(
  targetPath: string,
  roots: readonly string[],
): Promise<boolean> {
  let realTarget: string;
  try {
    realTarget = await realPath(targetPath);
  } catch {
    return false;
  }
  const realRoots = await Promise.all(
    roots.map((root) => realPath(root).catch(() => null)),
  );
  return realRoots.some((root) => {
    if (root === null) {
      return false;
    }
    const relativePath = relative(root, realTarget);
    return (
      relativePath === "" ||
      (!relativePath.startsWith("..") && !isAbsolute(relativePath))
    );
  });
}

// Never collapse ".." before the OS resolves symlinks: "link/../x" must
// follow "link" first, the way fs.readFile does.
function rawJoin(base: string, path: string): string {
  return isAbsolute(path) ? path : `${base}${sep}${path}`;
}

async function realPath(path: string): Promise<string> {
  const absolutePath = rawJoin(process.cwd(), path);
  try {
    return await fs.realpath(absolutePath);
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
  const stat = await fs.lstat(absolutePath).catch(() => null);
  if (stat?.isSymbolicLink()) {
    const linkTarget = await fs.readlink(absolutePath);
    return realPath(rawJoin(dirname(absolutePath), linkTarget));
  }
  const parent = dirname(absolutePath);
  if (parent === absolutePath) {
    return absolutePath;
  }
  return join(await realPath(parent), basename(absolutePath));
}
