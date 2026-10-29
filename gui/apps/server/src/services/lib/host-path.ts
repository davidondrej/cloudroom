import { getLatestSessionForHost } from "@cloudroom/db";
import path from "node:path";
import {
  getHostPathFlavor,
  isWindowsHostPath,
  joinHostPath,
  type HostPathFlavor,
} from "@cloudroom/domain";
import type { AppDeps } from "../../types.js";

export function joinHostPathSegments(
  rootPath: string,
  ...segments: string[]
): string {
  if (!isWindowsHostPath(rootPath)) {
    return path.posix.join(rootPath, ...segments);
  }
  const joined = joinHostPath({
    rootPath,
    relativePath: segments.join("/"),
  });
  if (joined === null) {
    throw new Error(`Host path is not absolute: ${rootPath}`);
  }
  return joined;
}

export function invalidHostPathMessage(flavor: HostPathFlavor): string {
  return flavor === "windows"
    ? "Path must be an absolute path on this machine. Windows network and device paths are not supported; use a drive-letter path like C:\\Users\\me\\repo."
    : "Path must be an absolute path on the current host.";
}

export function getHostPathFlavorForHost(
  deps: Pick<AppDeps, "db" | "hub">,
  hostId: string,
): HostPathFlavor {
  const platform = deps.hub.getDaemonPlatformForHost(hostId);
  if (platform === "darwin" || platform === "linux" || platform === "wsl") {
    return "posix";
  }
  if (platform !== null && platform !== "unknown") {
    return "windows";
  }
  const dataDir = getLatestSessionForHost(deps.db, { hostId })?.dataDir;
  return (dataDir && getHostPathFlavor(dataDir)) || "posix";
}
