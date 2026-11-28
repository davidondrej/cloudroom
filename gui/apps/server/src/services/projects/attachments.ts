// oxlint-disable-next-line no-restricted-imports
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  resolve,
  win32,
} from "node:path";
import { and, eq, inArray, or } from "drizzle-orm";
import {
  cloudroomCommands,
  events,
  queuedThreadMessages,
  type DbQueryConnection,
} from "@cloudroom/db";
import { resolveContainedPath } from "@cloudroom/process-utils";
import {
  PROMPT_FILE_ATTACHMENT_LIMIT_BYTES,
  PROMPT_IMAGE_ATTACHMENT_LIMIT_BYTES,
  type PromptInput,
} from "@cloudroom/domain";
import type { UploadedPromptAttachment } from "@cloudroom/server-contract";
import { lookupMimeType } from "@cloudroom/config/mime-types";
import { ApiError } from "../../errors.js";
import { heicToJpeg } from "./heic-to-jpeg.js";

type PromptAttachmentInput = Extract<
  PromptInput,
  { type: "localFile" | "localImage" }
>;

interface ValidatePromptAttachmentReferencesArgs {
  dataDir: string;
  input: PromptInput[];
  projectId: string;
}

function sanitizeFilename(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]+/gu, "-");
  return base.length > 0 ? base : "attachment";
}

function buildStoredFilename(originalName: string): string {
  const sanitized = sanitizeFilename(originalName);
  const extension = extname(sanitized);
  const stem =
    extension.length > 0 ? sanitized.slice(0, -extension.length) : sanitized;
  return `${stem}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`;
}

/** The same file uploaded again gets the same name: a stored name minus its upload suffix. */
export function uploadedAttachmentName(path: string): string {
  return path.replace(/-\d{13}-[0-9a-z]{1,6}(?=(\.[^./\\]*)?$)/u, "");
}

function projectAttachmentDir(dataDir: string, projectId: string): string {
  return join(dataDir, "attachments", projectId);
}

function resolveAttachmentPath(
  attachmentDir: string,
  relativePath: string,
): string {
  const normalizedRelativePath = normalize(relativePath.replaceAll("\\", "/"));
  const resolvedAttachmentDir = resolve(attachmentDir);
  const resolvedCandidatePath = resolve(
    resolvedAttachmentDir,
    normalizedRelativePath,
  );

  if (resolvedCandidatePath === resolvedAttachmentDir) {
    throw new ApiError(
      400,
      "invalid_request",
      "Attachment path must refer to a file inside the project directory",
    );
  }

  const resolvedPath = resolveContainedPath({
    rootPath: resolvedAttachmentDir,
    candidatePath: resolvedCandidatePath,
  });

  if (resolvedPath) {
    return resolvedPath;
  }

  throw new ApiError(
    400,
    "invalid_request",
    "Attachment path escapes project directory",
  );
}

function pathLooksRuntimeReadable(rawPath: string): boolean {
  return (
    isAbsolute(rawPath) ||
    win32.isAbsolute(rawPath) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(rawPath)
  );
}

function shouldValidateProjectAttachmentReference(
  input: PromptInput,
): input is PromptAttachmentInput {
  if (input.type !== "localFile" && input.type !== "localImage") {
    return false;
  }
  return !pathLooksRuntimeReadable(input.path);
}

function missingAttachmentReferenceError(attachmentPath: string): ApiError {
  return new ApiError(
    400,
    "invalid_request",
    `Attachment ${attachmentPath} was not uploaded for this project. Upload files with POST /api/v1/projects/:id/attachments and use the returned path in localFile/localImage prompt input; relative workspace file paths are not valid attachment references.`,
  );
}

async function ensureAttachmentReferenceExists(
  dataDir: string,
  projectId: string,
  attachmentPath: string,
): Promise<void> {
  const dir = projectAttachmentDir(dataDir, projectId);
  const resolved = resolveAttachmentPath(dir, attachmentPath);
  const fileStat = await stat(resolved).catch(() => null);
  if (!fileStat || !fileStat.isFile()) {
    throw missingAttachmentReferenceError(attachmentPath);
  }
}

export async function validatePromptAttachmentReferences(
  args: ValidatePromptAttachmentReferencesArgs,
): Promise<void> {
  for (const input of args.input) {
    if (!shouldValidateProjectAttachmentReference(input)) {
      continue;
    }
    await ensureAttachmentReferenceExists(
      args.dataDir,
      args.projectId,
      input.path,
    );
  }
}

export async function storeAttachment(
  dataDir: string,
  projectId: string,
  upload: File,
): Promise<UploadedPromptAttachment> {
  const file = await heicToJpeg(upload);
  const isImage = (file.type || "").startsWith("image/");
  const sizeLimit = isImage
    ? PROMPT_IMAGE_ATTACHMENT_LIMIT_BYTES
    : PROMPT_FILE_ATTACHMENT_LIMIT_BYTES;
  if (file.size > sizeLimit) {
    throw new ApiError(
      400,
      "invalid_request",
      `Attachment exceeds ${Math.floor(sizeLimit / (1024 * 1024))}MB limit`,
    );
  }

  const dir = projectAttachmentDir(dataDir, projectId);
  await mkdir(dir, { recursive: true });

  const storedName = buildStoredFilename(file.name);
  const outputPath = join(dir, storedName);
  const bytes = Buffer.from(await file.arrayBuffer());
  await writeFile(outputPath, bytes);

  return {
    type: isImage ? "localImage" : "localFile",
    path: storedName,
    name: file.name,
    mimeType: file.type || undefined,
    sizeBytes: file.size,
  };
}

interface StoredAttachmentContent {
  content: Buffer;
  etag: string;
  mimeType?: string;
}

export async function readAttachment(
  dataDir: string,
  projectId: string,
  relativePath: string,
): Promise<StoredAttachmentContent> {
  const dir = projectAttachmentDir(dataDir, projectId);
  const resolved = resolveAttachmentPath(dir, relativePath);

  const fileStat = await stat(resolved).catch(() => null);
  if (!fileStat || !fileStat.isFile()) {
    throw new ApiError(404, "invalid_request", "Attachment not found");
  }

  return {
    content: await readFile(resolved),
    etag: `"${fileStat.size.toString(16)}-${Math.floor(fileStat.mtimeMs).toString(16)}"`,
    mimeType: lookupMimeType(resolved) || undefined,
  };
}

export async function copyProjectAttachments(
  dataDir: string,
  sourceProjectId: string,
  targetProjectId: string,
  attachmentPaths: readonly string[],
): Promise<void> {
  if (sourceProjectId === targetProjectId || attachmentPaths.length === 0) {
    return;
  }

  const uniquePaths = [...new Set(attachmentPaths)];
  const targetDir = projectAttachmentDir(dataDir, targetProjectId);
  const attachments = await Promise.all(
    uniquePaths.map(async (attachmentPath) => ({
      content: (await readAttachment(dataDir, sourceProjectId, attachmentPath))
        .content,
      targetPath: resolveAttachmentPath(targetDir, attachmentPath),
    })),
  );

  await Promise.all(
    attachments.map(async ({ content, targetPath }) => {
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, content);
    }),
  );
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function collectProjectAttachmentPath(
  rawPath: unknown,
  out: Set<string>,
): void {
  if (
    typeof rawPath === "string" &&
    rawPath.length > 0 &&
    !rawPath.startsWith("\\") &&
    !pathLooksRuntimeReadable(rawPath)
  ) {
    out.add(rawPath);
  }
}

function collectPromptInputAttachmentPaths(
  parts: unknown,
  out: Set<string>,
): void {
  if (!Array.isArray(parts)) return;
  for (const part of parts) {
    if (
      part &&
      typeof part === "object" &&
      (part.type === "localImage" || part.type === "localFile")
    ) {
      collectProjectAttachmentPath((part as { path?: unknown }).path, out);
    }
  }
}

function collectCloudCommandAttachmentPaths(
  list: unknown,
  out: Set<string>,
): void {
  if (!Array.isArray(list)) return;
  for (const item of list) {
    if (item && typeof item === "object") {
      collectProjectAttachmentPath(
        (item as { localPath?: unknown }).localPath,
        out,
      );
    }
  }
}

function collectThreadProjectAttachmentPaths(
  db: DbQueryConnection,
  threadId: string,
): string[] {
  const paths = new Set<string>();

  const eventRows = db
    .select({ type: events.type, data: events.data })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        or(
          eq(events.type, "client/turn/requested"),
          eq(events.type, "system/operation"),
          and(
            inArray(events.type, ["item/started", "item/completed"]),
            eq(events.itemKind, "userMessage"),
          ),
        ),
      ),
    )
    .all();

  for (const row of eventRows) {
    const data = safeParseJson(row.data) as Record<string, unknown> | null;
    if (!data || typeof data !== "object") continue;
    if (row.type === "client/turn/requested") {
      collectPromptInputAttachmentPaths(data.input, paths);
      if (Array.isArray(data.inputGroups)) {
        for (const group of data.inputGroups) {
          collectPromptInputAttachmentPaths(group, paths);
        }
      }
    } else if (row.type === "system/operation") {
      const metadata = data.metadata as Record<string, unknown> | undefined;
      collectPromptInputAttachmentPaths(metadata?.seed, paths);
    } else {
      const item = data.item as Record<string, unknown> | undefined;
      collectPromptInputAttachmentPaths(item?.content, paths);
    }
  }

  for (const row of db
    .select({ content: queuedThreadMessages.content })
    .from(queuedThreadMessages)
    .where(eq(queuedThreadMessages.threadId, threadId))
    .all()) {
    collectPromptInputAttachmentPaths(safeParseJson(row.content), paths);
  }

  for (const row of db
    .select({ input: cloudroomCommands.input })
    .from(cloudroomCommands)
    .where(eq(cloudroomCommands.threadId, threadId))
    .all()) {
    const input = safeParseJson(row.input) as Record<string, unknown> | null;
    if (!input || typeof input !== "object") continue;
    collectPromptInputAttachmentPaths(input.content, paths);
    collectCloudCommandAttachmentPaths(input.attachments, paths);
    const replacement = input.replacement as Record<string, unknown> | undefined;
    collectPromptInputAttachmentPaths(replacement?.content, paths);
    collectCloudCommandAttachmentPaths(replacement?.attachments, paths);
  }

  return [...paths];
}

/**
 * Copies every project-scoped attachment referenced by a thread into its new project folder.
 * Missing source files are skipped so a stale attachment never blocks a thread move.
 */
export async function copyThreadAttachmentsToProject(
  deps: {
    config: { dataDir: string };
    db: DbQueryConnection;
    logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
  },
  args: {
    threadId: string;
    sourceProjectId: string;
    targetProjectId: string;
  },
): Promise<void> {
  if (args.sourceProjectId === args.targetProjectId) {
    return;
  }

  const paths = collectThreadProjectAttachmentPaths(deps.db, args.threadId);
  if (paths.length === 0) {
    return;
  }

  const sourceDir = projectAttachmentDir(
    deps.config.dataDir,
    args.sourceProjectId,
  );
  const targetDir = projectAttachmentDir(
    deps.config.dataDir,
    args.targetProjectId,
  );

  await Promise.all(
    paths.map(async (attachmentPath) => {
      let sourcePath: string;
      let targetPath: string;
      try {
        sourcePath = resolveAttachmentPath(sourceDir, attachmentPath);
        targetPath = resolveAttachmentPath(targetDir, attachmentPath);
      } catch {
        return;
      }
      try {
        const sourceStat = await stat(sourcePath).catch(() => null);
        if (!sourceStat?.isFile()) {
          return;
        }
        const targetStat = await stat(targetPath).catch(() => null);
        if (targetStat?.isFile()) {
          return;
        }
        await mkdir(dirname(targetPath), { recursive: true });
        await copyFile(sourcePath, targetPath);
      } catch (error) {
        deps.logger?.warn(
          { error, threadId: args.threadId, attachmentPath },
          "Could not copy thread attachment to new project",
        );
      }
    }),
  );
}

export async function deleteProjectAttachments(
  dataDir: string,
  projectId: string,
): Promise<void> {
  await rm(projectAttachmentDir(dataDir, projectId), {
    force: true,
    recursive: true,
  });
}
