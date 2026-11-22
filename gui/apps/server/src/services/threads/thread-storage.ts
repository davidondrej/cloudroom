import { getLatestSessionForHost, getThread } from "@cloudroom/db";
import { chatFileCopySegments } from "@cloudroom/domain";
import { ApiError } from "../../errors.js";
import { joinHostPathSegments } from "../lib/host-path.js";
import type { WorkSessionDeps } from "../../types.js";
import { requireConnectedHostSession } from "../lib/entity-lookup.js";

interface RequireThreadStoragePathArgs {
  hostId: string;
  threadId: string;
}

export async function requireThreadStoragePath(
  deps: Pick<WorkSessionDeps, "db">,
  args: RequireThreadStoragePathArgs,
): Promise<string> {
  const session = getLatestSessionForHost(deps.db, { hostId: args.hostId });
  if (session === null) {
    throw new ApiError(
      502,
      "host_unavailable",
      "The host has no known storage location",
      false,
    );
  }
  return joinHostPathSegments(session.dataDir, "thread-storage", args.threadId);
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

/** Where the copy of a file a Local thread's chat showed may be. The host daemon saves an image to the thread's
 *  storage when a message shows it (saveChatImages). A fork shows its source's messages too, so the storage of each
 *  thread it was forked from follows. */
export async function listChatFileCopies(
  deps: Pick<WorkSessionDeps, "db">,
  args: { hostId: string; path: string; thread: ForkedThread },
): Promise<Array<{ path: string; rootPath: string }>> {
  const segments = chatFileCopySegments(args.path);
  const copies: Array<{ path: string; rootPath: string }> = [];
  let thread: ForkedThread | null = args.thread;
  while (segments && thread && copies.length < CHAT_FILE_COPY_FORK_DEPTH) {
    const rootPath = await requireThreadStoragePath(deps, {
      hostId: args.hostId,
      threadId: thread.id,
    });
    copies.push({
      path: joinHostPathSegments(rootPath, ...segments),
      rootPath,
    });
    thread = thread.sourceThreadId
      ? getThread(deps.db, thread.sourceThreadId)
      : null;
  }
  return copies;
}
