import {
  chatFileCopyName,
  deleteChatFileCopies,
  saveChatFileCopy,
} from "@cloudroom/config/chat-file-copies";
import { getLatestSessionForHost, getThread } from "@cloudroom/db";
import { legacyChatFileCopySegments } from "@cloudroom/domain";
import { CHAT_FILE_COPIES_DIR_NAME } from "@cloudroom/process-utils";
import { ApiError } from "../../errors.js";
import { joinHostPathSegments } from "../lib/host-path.js";
import type { AppDeps, WorkSessionDeps } from "../../types.js";
import { resolvePrimaryHostId } from "../hosts/primary-host.js";
import { requireConnectedHostSession } from "../lib/entity-lookup.js";

interface RequireThreadStoragePathArgs {
  hostId: string;
  threadId: string;
}

/** The host's data folder, from its latest session, so also while it is offline. */
export function requireHostDataDir(
  deps: Pick<WorkSessionDeps, "db">,
  hostId: string,
): string {
  const session = getLatestSessionForHost(deps.db, { hostId });
  if (session === null) {
    throw new ApiError(
      502,
      "host_unavailable",
      "The host has no known storage location",
      false,
    );
  }
  return session.dataDir;
}

export async function requireThreadStoragePath(
  deps: Pick<WorkSessionDeps, "db">,
  args: RequireThreadStoragePathArgs,
): Promise<string> {
  return joinHostPathSegments(
    requireHostDataDir(deps, args.hostId),
    "thread-storage",
    args.threadId,
  );
}

export async function requireLiveThreadStoragePath(
  deps: Pick<WorkSessionDeps, "db" | "hub">,
  args: RequireThreadStoragePathArgs,
): Promise<string> {
  const session = requireConnectedHostSession(deps, args.hostId);
  return joinHostPathSegments(session.dataDir, "thread-storage", args.threadId);
}

const CHAT_FILE_COPY_FORK_DEPTH = 5;
type ForkedThread = { id: string; sourceThreadId: string | null };

/** Where the copy of a file a Local thread's chat showed may be. The host daemon saves an image when a message shows
 *  it (saveChatImages), in `<data folder>/chat-file-copies/<thread>/`. Copies saved before 2026-11-23 are in the
 *  thread's storage, so each thread's old copy comes after its new one. A fork shows its source's messages too, so the
 *  copies of each thread it was forked from follow. */
export async function listChatFileCopies(
  deps: Pick<WorkSessionDeps, "db">,
  args: { hostId: string; path: string; thread: ForkedThread },
): Promise<Array<{ path: string; rootPath: string }>> {
  const name = chatFileCopyName(args.path);
  const legacy = legacyChatFileCopySegments(args.path);
  if (name === null || legacy === null) return [];
  const dataDir = requireHostDataDir(deps, args.hostId);
  const copies: Array<{ path: string; rootPath: string }> = [];
  let thread: ForkedThread | null = args.thread;
  for (let depth = 0; thread && depth < CHAT_FILE_COPY_FORK_DEPTH; depth++) {
    const copiesPath = joinHostPathSegments(
      dataDir,
      CHAT_FILE_COPIES_DIR_NAME,
      thread.id,
    );
    const storagePath = joinHostPathSegments(
      dataDir,
      "thread-storage",
      thread.id,
    );
    copies.push(
      { path: joinHostPathSegments(copiesPath, name), rootPath: copiesPath },
      {
        path: joinHostPathSegments(storagePath, ...legacy),
        rootPath: storagePath,
      },
    );
    thread = thread.sourceThreadId
      ? getThread(deps.db, thread.sourceThreadId)
      : null;
  }
  return copies;
}

const chatFileCopyChains = new Map<string, Promise<void>>();

function runSerializedChatFileCopyOp<T>(
  threadId: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = chatFileCopyChains.get(threadId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  chatFileCopyChains.set(threadId, tail);
  void tail.finally(() => {
    if (chatFileCopyChains.get(threadId) === tail) {
      chatFileCopyChains.delete(threadId);
    }
  });
  return next;
}

/** Saves a locally cached chat image unless its thread was deleted before or during the download. */
export async function saveChatFileCopyForThread(
  deps: Pick<AppDeps, "db">,
  args: {
    data: Buffer;
    dataDir: string;
    filePath: string;
    requireThread: boolean;
    threadId: string;
  },
): Promise<void> {
  const isDeleted = () => {
    const thread = getThread(deps.db, args.threadId);
    return thread ? thread.deletedAt !== null : args.requireThread;
  };
  if (isDeleted()) return;
  await runSerializedChatFileCopyOp(args.threadId, async () => {
    if (isDeleted()) return;
    await saveChatFileCopy(args);
  });
}

/** Best-effort removal of locally cached chat images for threads with no host environment (e.g. Cloud threads). */
export function deleteLocalChatFileCopies(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger">,
  threadId: string,
): void {
  const dirs = new Set<string>([deps.config.dataDir]);
  const hostId = resolvePrimaryHostId(deps);
  if (hostId) {
    const session = getLatestSessionForHost(deps.db, { hostId });
    if (session?.dataDir) dirs.add(session.dataDir);
  }
  void runSerializedChatFileCopyOp(threadId, async () => {
    for (const dataDir of dirs) {
      await deleteChatFileCopies(dataDir, threadId).catch((error: unknown) => {
        deps.logger.warn(
          { err: error, threadId },
          "Could not delete cached chat file copies",
        );
      });
    }
  });
}
