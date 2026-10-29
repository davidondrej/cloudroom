import path from "node:path";
import { isHostPathWithin, isWindowsHostPath, joinHostPath } from "@cloudroom/domain";

export function isBbManagedWorkspacePath(args: {
  dataDir: string;
  path: string;
}): boolean {
  if (!isWindowsHostPath(args.dataDir)) {
    return [
      path.posix.join(args.dataDir, "worktrees"),
      path.posix.join(args.dataDir, "personal-workspaces"),
    ].some((root) => args.path === root || args.path.startsWith(`${root}/`));
  }
  return ["worktrees", "personal-workspaces"].some((name) => {
    const rootPath = joinHostPath({
      rootPath: args.dataDir,
      relativePath: name,
    });
    return (
      rootPath !== null &&
      isHostPathWithin({ rootPath, candidatePath: args.path })
    );
  });
}
