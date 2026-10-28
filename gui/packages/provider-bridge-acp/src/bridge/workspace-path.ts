import { promises as fs } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
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

async function realPath(path: string): Promise<string> {
  const absolutePath = resolve(path);
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
    return realPath(resolve(dirname(absolutePath), linkTarget));
  }
  const parent = dirname(absolutePath);
  if (parent === absolutePath) {
    return absolutePath;
  }
  return join(await realPath(parent), basename(absolutePath));
}
