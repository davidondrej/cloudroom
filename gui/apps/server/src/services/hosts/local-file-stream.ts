import { isUtf8 } from "node:buffer";
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import mimeTypes from "mime-types";
import { getHost } from "@cloudroom/db";
import { isWindowsNetworkOrDevicePath } from "@cloudroom/domain";
import { isPathWithinDirectory } from "@cloudroom/process-utils";
import { ApiError } from "../../errors.js";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { findHostDataDir } from "../lib/entity-lookup.js";
import { readPrimaryHostIdFromDataDir } from "./primary-host.js";

const OCTET_STREAM_MIME_TYPE = "application/octet-stream";
const REVALIDATE_CACHE_CONTROL = "private, no-cache";
const NON_MEDIA_FILE_SIZE_LIMIT_BYTES = 50 * 1024 * 1024;
const UTF8_PROBE_MAX_BYTES = 25 * 1024 * 1024;

export interface LocalFileStreamOptions {
  headers?: HeadersInit;
  ifRange?: string | undefined;
  includeContentEncodingHeader?: boolean;
  range?: string | undefined;
}

interface LocalFileTarget {
  hostId: string;
  ifNoneMatch?: string | undefined;
  path: string;
  rootPath?: string;
}

interface LocalFileResponseHelpers {
  requestMatchesEntityTag: (
    ifNoneMatch: string | undefined,
    entityTag: string,
  ) => boolean;
  setUntrustedFileHeaders: (headers: Headers) => Headers;
}

function isFsErrorWithCode(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function mapFsError(error: unknown, shownPath: string): never {
  if (isFsErrorWithCode(error, "ENOENT") || isFsErrorWithCode(error, "ENOTDIR")) {
    throw new ApiError(404, "ENOENT", `Path does not exist: ${shownPath}`, false);
  }
  if (isFsErrorWithCode(error, "EPERM") || isFsErrorWithCode(error, "EACCES")) {
    const message =
      process.platform === "darwin" && error.code === "EPERM"
        ? "macOS blocked Cloudroom from reading this folder. Quit and reopen Cloudroom; if it keeps happening, check Cloudroom's access in System Settings > Privacy & Security."
        : error.message;
    throw new ApiError(403, "permission_denied", message, false);
  }
  throw error;
}

function normalizeLocalPath(filePath: string): string {
  return process.platform === "win32" && /^\/[A-Za-z]:[\\/]/u.test(filePath)
    ? filePath.slice(1)
    : filePath;
}

function assertValidLocalPath(filePath: string, label: string): void {
  if (filePath.includes("\0") || !path.isAbsolute(filePath)) {
    throw new ApiError(400, "invalid_path", `${label} must be absolute`, false);
  }
  if (process.platform === "win32" && isWindowsNetworkOrDevicePath(filePath)) {
    throw new ApiError(
      400,
      "invalid_path",
      "Network paths are not supported",
      false,
    );
  }
}

function isColocatedPrimaryHost(
  deps: Pick<LoggedWorkSessionDeps, "config" | "db" | "hub">,
  hostId: string,
): boolean {
  if (
    readPrimaryHostIdFromDataDir({ dataDir: deps.config.dataDir }) !== hostId
  ) {
    return false;
  }
  const host = getHost(deps.db, hostId);
  if (host === null || host.phase !== "active") {
    return false;
  }
  const hostDataDir = findHostDataDir(deps, hostId);
  return (
    hostDataDir !== null &&
    path.resolve(hostDataDir) === path.resolve(deps.config.dataDir)
  );
}

async function resolveReadableLocalPath(
  filePath: string,
  shownPath: string,
  rootPath: string | undefined,
): Promise<string> {
  if (rootPath === undefined) {
    return filePath;
  }
  const normalizedRoot = normalizeLocalPath(rootPath);
  assertValidLocalPath(normalizedRoot, "rootPath");
  const rootInfo = await lstat(normalizedRoot).catch((error: unknown) =>
    mapFsError(error, shownPath),
  );
  if (rootInfo.isSymbolicLink()) {
    throw new ApiError(
      400,
      "invalid_path",
      `Root path "${rootPath}" must not be a symlink`,
      false,
    );
  }
  if (!rootInfo.isDirectory()) {
    throw new ApiError(
      400,
      "invalid_path",
      `Root path "${rootPath}" is not a directory`,
      false,
    );
  }
  const realRoot = await realpath(normalizedRoot).catch((error: unknown) =>
    mapFsError(error, shownPath),
  );
  const realTarget = await realpath(filePath).catch((error: unknown) =>
    mapFsError(error, shownPath),
  );
  if (!isPathWithinDirectory(realRoot, realTarget)) {
    throw new ApiError(
      400,
      "invalid_path",
      `Path "${shownPath}" escapes read root`,
      false,
    );
  }
  return realTarget;
}

function isKnownBinaryMediaMimeType(mimeType: string): boolean {
  return (
    (mimeType.startsWith("image/") && mimeType !== "image/svg+xml") ||
    mimeType.startsWith("video/") ||
    mimeType.startsWith("audio/")
  );
}

function matchesIfRange(
  ifRange: string | undefined,
  entityTag: string,
  lastModified: string,
): boolean {
  if (ifRange === undefined) return true;
  const trimmed = ifRange.trim();
  if (trimmed === "") return true;
  if (trimmed.startsWith('"') || trimmed.startsWith("W/")) {
    return !trimmed.startsWith("W/") && trimmed === entityTag;
  }
  return trimmed === lastModified;
}

function parseSingleByteRange(
  rangeHeader: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(rangeHeader.trim());
  if (!match) return null;
  const rawStart = match[1] ?? "";
  const rawEnd = match[2] ?? "";
  if (rawStart === "" && rawEnd === "") return null;
  if (size === 0) return "unsatisfiable";

  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= size ||
    start > end
  ) {
    return "unsatisfiable";
  }
  return { start, end };
}

function streamHandleResponse(
  handle: FileHandle,
  args: {
    end?: number;
    headers: Headers;
    start?: number;
    status: 200 | 206;
  },
): Response {
  const stream = handle.createReadStream({
    autoClose: true,
    ...(args.start !== undefined ? { start: args.start } : {}),
    ...(args.end !== undefined ? { end: args.end } : {}),
  });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    status: args.status,
    headers: args.headers,
  });
}

/** Streams a file straight from local disk when the target host is this machine's active primary host. */
export async function tryServeColocatedLocalFile(
  deps: LoggedWorkSessionDeps,
  target: LocalFileTarget,
  options: LocalFileStreamOptions,
  helpers: LocalFileResponseHelpers,
): Promise<Response | null> {
  if (!isColocatedPrimaryHost(deps, target.hostId)) {
    return null;
  }

  const normalizedPath = normalizeLocalPath(target.path);
  assertValidLocalPath(normalizedPath, "Path");
  const readablePath = await resolveReadableLocalPath(
    normalizedPath,
    target.path,
    target.rootPath,
  );

  // Check file type before open() so reading a FIFO or device node never blocks.
  const preOpenStat = await stat(readablePath).catch((error: unknown) =>
    mapFsError(error, target.path),
  );
  if (preOpenStat.isDirectory()) {
    throw new ApiError(400, "invalid_path", "Path is a directory, not a file", false);
  }
  if (!preOpenStat.isFile()) {
    throw new ApiError(400, "invalid_path", "Path is not a regular file", false);
  }

  const handle = await open(readablePath, "r").catch((error: unknown) =>
    mapFsError(error, target.path),
  );
  let handoffToStream = false;
  try {
    const fileStat = await handle.stat();
    if (fileStat.isDirectory()) {
      throw new ApiError(400, "invalid_path", "Path is a directory, not a file", false);
    }
    if (!fileStat.isFile()) {
      throw new ApiError(400, "invalid_path", "Path is not a regular file", false);
    }

    const mimeType = mimeTypes.lookup(target.path) || OCTET_STREAM_MIME_TYPE;
    if (
      !isKnownBinaryMediaMimeType(mimeType) &&
      fileStat.size > NON_MEDIA_FILE_SIZE_LIMIT_BYTES
    ) {
      throw new ApiError(
        413,
        "file_too_large",
        `File size ${fileStat.size} bytes exceeds the 50 MB limit`,
        false,
      );
    }

    const entityTag = `"${fileStat.size.toString(16)}-${Math.trunc(fileStat.mtimeMs).toString(16)}-${fileStat.ino.toString(16)}"`;
    const lastModified = new Date(fileStat.mtimeMs).toUTCString();
    const headers = new Headers(options.headers);
    if (!headers.has("content-type")) headers.set("content-type", mimeType);
    if (!headers.has("cache-control")) {
      headers.set("cache-control", REVALIDATE_CACHE_CONTROL);
    }
    headers.set("etag", entityTag);
    headers.set("last-modified", lastModified);
    helpers.setUntrustedFileHeaders(headers);

    const needsUtf8Probe =
      options.includeContentEncodingHeader === true &&
      !isKnownBinaryMediaMimeType(mimeType) &&
      fileStat.size > 0 &&
      fileStat.size <= UTF8_PROBE_MAX_BYTES;
    if (options.includeContentEncodingHeader === true && !needsUtf8Probe) {
      headers.set(
        "x-bb-content-encoding",
        fileStat.size === 0 ? "utf8" : "base64",
      );
    }

    if (helpers.requestMatchesEntityTag(target.ifNoneMatch, entityTag)) {
      return new Response(null, { status: 304, headers });
    }

    if (needsUtf8Probe) {
      const buffer = await handle.readFile();
      headers.set("x-bb-content-encoding", isUtf8(buffer) ? "utf8" : "base64");
      headers.set("content-length", String(buffer.byteLength));
      return new Response(buffer as unknown as BodyInit, {
        status: 200,
        headers,
      });
    }

    headers.set("accept-ranges", "bytes");
    const range = matchesIfRange(options.ifRange, entityTag, lastModified)
      ? parseSingleByteRange(options.range, fileStat.size)
      : null;
    if (range === "unsatisfiable") {
      headers.set("content-range", `bytes */${fileStat.size}`);
      return new Response(null, { status: 416, headers });
    }
    if (range !== null) {
      headers.set("content-range", `bytes ${range.start}-${range.end}/${fileStat.size}`);
      headers.set("content-length", String(range.end - range.start + 1));
      const response = streamHandleResponse(handle, {
        end: range.end,
        headers,
        start: range.start,
        status: 206,
      });
      handoffToStream = true;
      return response;
    }

    headers.set("content-length", String(fileStat.size));
    if (fileStat.size === 0) {
      return new Response(new Uint8Array(0), { status: 200, headers });
    }
    const response = streamHandleResponse(handle, { headers, status: 200 });
    handoffToStream = true;
    return response;
  } finally {
    if (!handoffToStream) {
      await handle.close().catch(() => {});
    }
  }
}
