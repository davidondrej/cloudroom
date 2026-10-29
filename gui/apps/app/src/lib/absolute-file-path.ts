import {
  getHostPathDirname,
  isHostPathWithin,
  isWindowsHostPath,
  joinHostPath,
  normalizeHostPath,
} from "@cloudroom/domain";

interface ResolveAbsoluteFilePathArgs {
  path: string;
  rootPath: string | null | undefined;
}

interface BuildAbsoluteFilePathArgs {
  path: string;
  rootPath: string;
}

interface GetAbsoluteDirnameArgs {
  path: string;
}

interface IsAbsoluteFilePathWithinRootArgs {
  candidatePath: string;
  rootPath: string;
}

interface NormalizeAbsoluteFilePathArgs {
  path: string;
}

function trimTrailingSlash(path: string): string {
  if (path === "/") {
    return path;
  }
  return path.replace(/\/+$/u, "");
}

function trimLeadingSlash(path: string): string {
  return path.replace(/^\/+/u, "");
}

function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith("/") || isWindowsHostPath(path);
}

export function normalizeAbsoluteFilePath({
  path,
}: NormalizeAbsoluteFilePathArgs): string | null {
  if (isWindowsHostPath(path)) {
    return normalizeHostPath(path);
  }
  if (!path.startsWith("/")) {
    return null;
  }

  const normalizedSegments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (normalizedSegments.length > 0) {
        normalizedSegments.pop();
      }
      continue;
    }
    normalizedSegments.push(segment);
  }

  return normalizedSegments.length === 0
    ? "/"
    : `/${normalizedSegments.join("/")}`;
}

export function isAbsoluteFilePathWithinRoot({
  candidatePath,
  rootPath,
}: IsAbsoluteFilePathWithinRootArgs): boolean {
  if (isWindowsHostPath(candidatePath) || isWindowsHostPath(rootPath)) {
    return isHostPathWithin({ rootPath, candidatePath });
  }
  const normalizedCandidatePath = normalizeAbsoluteFilePath({
    path: candidatePath,
  });
  const normalizedRootPath = normalizeAbsoluteFilePath({ path: rootPath });
  if (normalizedCandidatePath === null || normalizedRootPath === null) {
    return false;
  }

  if (normalizedRootPath === "/") {
    return normalizedCandidatePath.startsWith("/");
  }

  return (
    normalizedCandidatePath === normalizedRootPath ||
    normalizedCandidatePath.startsWith(`${normalizedRootPath}/`)
  );
}

export function buildAbsoluteFilePath({
  path,
  rootPath,
}: BuildAbsoluteFilePathArgs): string {
  if (isAbsoluteFilePath(path)) {
    return path;
  }

  if (isWindowsHostPath(rootPath)) {
    return joinHostPath({ rootPath, relativePath: path }) ?? path;
  }

  const normalizedRootPath = trimTrailingSlash(rootPath);
  const relativePath = trimLeadingSlash(path);
  if (normalizedRootPath === "/") {
    return `/${relativePath}`;
  }
  return `${normalizedRootPath}/${relativePath}`;
}

export function resolveAbsoluteFilePath({
  path,
  rootPath,
}: ResolveAbsoluteFilePathArgs): string | null {
  if (isAbsoluteFilePath(path)) {
    return path;
  }
  if (!rootPath) {
    return null;
  }
  return buildAbsoluteFilePath({ path, rootPath });
}

export function getAbsoluteDirname({ path }: GetAbsoluteDirnameArgs): string {
  if (isWindowsHostPath(path)) {
    return getHostPathDirname(path) ?? path;
  }
  const trimmed = trimTrailingSlash(path);
  const lastSlashIndex = trimmed.lastIndexOf("/");
  return lastSlashIndex <= 0 ? "/" : trimmed.slice(0, lastSlashIndex);
}
