import {
  getHostPathBasename,
  getHostPathFlavor,
  isAbsoluteHostPath,
  isHostPathRoot,
  isWindowsNetworkOrDevicePath,
  normalizeHostPath,
} from "./host-path.js";

export const INVALID_PROJECT_PATH_MESSAGE =
  "Project path must be an absolute path.";
export const PROJECT_PATH_ROOT_MESSAGE =
  "Project path must point to a project directory, not the filesystem root.";
export const UNSUPPORTED_WINDOWS_NETWORK_PROJECT_PATH_MESSAGE =
  "Windows network paths are not supported. Map the share to a drive letter and use a path like C:\\Users\\me\\repo.";

function isWindowsDriveProjectPath(path: string): boolean {
  return getHostPathFlavor(path) === "windows";
}

export function isAbsoluteProjectPath(path: string): boolean {
  const trimmedPath = path.trim();
  if (!trimmedPath) {
    return false;
  }

  return trimmedPath.startsWith("/") || isWindowsDriveProjectPath(trimmedPath);
}

export function normalizeProjectPathInput(path: string): string {
  // Whitespace before an absolute path is never part of it, and a trailing
  // line break or tab comes from pasted or command output. A POSIX folder
  // name can end in spaces (`Demo `), so keep those exact (#2666).
  const trimmedPath = path.trimStart().replace(/[\t\n\v\f\r]+$/u, "");
  if (!trimmedPath) {
    return "";
  }

  if (isWindowsDriveProjectPath(trimmedPath)) {
    const windowsPath = trimmedPath.trimEnd();
    return normalizeHostPath(windowsPath) ?? windowsPath;
  }

  if (trimmedPath === "/") {
    return trimmedPath;
  }

  return trimmedPath.replace(/\/+$/u, "");
}

export function getProjectPathValidationMessage(path: string): string | null {
  const normalizedPath = normalizeProjectPathInput(path);
  if (!normalizedPath) {
    return INVALID_PROJECT_PATH_MESSAGE;
  }
  if (
    isWindowsNetworkOrDevicePath(normalizedPath) &&
    !isAbsoluteHostPath(normalizedPath)
  ) {
    return UNSUPPORTED_WINDOWS_NETWORK_PROJECT_PATH_MESSAGE;
  }
  if (!isAbsoluteProjectPath(normalizedPath)) {
    return INVALID_PROJECT_PATH_MESSAGE;
  }
  if (
    isWindowsDriveProjectPath(normalizedPath)
      ? isHostPathRoot(normalizedPath)
      : normalizedPath === "/"
  ) {
    return PROJECT_PATH_ROOT_MESSAGE;
  }
  return null;
}

export function deriveProjectNameFromPath(path: string): string {
  const normalizedPath = normalizeProjectPathInput(path);
  if (isWindowsDriveProjectPath(normalizedPath)) {
    return getProjectPathValidationMessage(normalizedPath) === null
      ? (getHostPathBasename(normalizedPath) ?? "")
      : "";
  }
  if (
    !normalizedPath ||
    normalizedPath === "/" ||
    !normalizedPath.startsWith("/")
  ) {
    return "";
  }
  return normalizedPath.split("/").filter(Boolean).at(-1) ?? "";
}
