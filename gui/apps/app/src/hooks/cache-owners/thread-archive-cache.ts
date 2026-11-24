import { isThreadRunning } from "@cloudroom/client-core";
import { atom } from "jotai";
import type { QueryClient } from "@tanstack/react-query";
import type { ThreadListEntry, ThreadWithRuntime } from "@cloudroom/domain";
import { threadQueryKey, threadsQueryKey } from "../queries/query-keys";
import {
  applyToCachedSidebarNavigationThreads,
  getCachedSidebarNavigationThreads,
} from "./query-cache";
import {
  applyToCachedThreadLists,
  getCachedThreadLists,
  iterateThreadListCacheEntries,
} from "./thread-list-cache-data";

// Each action owns its family, so settling a child cannot reveal it while its parent is pending.
export const pendingArchiveFamiliesAtom = atom<readonly ReadonlySet<string>[]>(
  [],
);
export const pendingArchiveIdsAtom = atom(
  (get) =>
    new Set(get(pendingArchiveFamiliesAtom).flatMap((family) => [...family])),
);

type CachedLiveThreadMatcher = (thread: ThreadListEntry) => boolean;

export interface CachedThreadSnapshot {
  id: string;
  thread: ThreadWithRuntime | undefined;
}

interface CachedLiveThreadIdsMatchingArgs {
  matchesThread: CachedLiveThreadMatcher;
  queryClient: QueryClient;
}

interface CachedThreadSnapshotsArgs {
  queryClient: QueryClient;
  threadIds: readonly string[];
}

interface ApplyArchivedThreadIdsArgs {
  queryClient: QueryClient;
  threadIds: readonly string[];
}

interface RemoveLiveThreadsFromCachedListsArgs {
  matchesThread: CachedLiveThreadMatcher;
  queryClient: QueryClient;
}

export function getCachedLiveThreadIdsMatching({
  matchesThread,
  queryClient,
}: CachedLiveThreadIdsMatchingArgs): string[] {
  const threadIds = new Set<string>();
  for (const { data } of getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  })) {
    for (const thread of iterateThreadListCacheEntries(data)) {
      if (thread.archivedAt === null && matchesThread(thread)) {
        threadIds.add(thread.id);
      }
    }
  }
  for (const thread of getCachedSidebarNavigationThreads(queryClient)) {
    if (thread.archivedAt === null && matchesThread(thread)) {
      threadIds.add(thread.id);
    }
  }
  return Array.from(threadIds);
}

/** A status event can reach the sidebar before detail or a paged list. On a timestamp tie, keep the warning. */
export function newestThread<
  T extends Pick<ThreadListEntry, "status" | "updatedAt">,
>(current: T, copy?: T): T {
  return copy &&
    (copy.updatedAt > current.updatedAt ||
      (copy.updatedAt === current.updatedAt && isThreadRunning(copy)))
    ? copy
    : current;
}

export function getCachedArchiveTree(
  queryClient: QueryClient,
  rootThreadId: string,
) {
  const latest = new Map<string, ThreadListEntry>();
  const add = (thread: ThreadListEntry) =>
    latest.set(thread.id, newestThread(thread, latest.get(thread.id)));
  for (const { data } of getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  })) {
    for (const thread of iterateThreadListCacheEntries(data)) add(thread);
  }
  for (const thread of getCachedSidebarNavigationThreads(queryClient))
    add(thread);
  const childrenByParentId = new Map<string, ThreadListEntry[]>();
  for (const thread of latest.values()) {
    if (thread.archivedAt !== null || thread.parentThreadId === null) continue;
    const children = childrenByParentId.get(thread.parentThreadId);
    if (children) children.push(thread);
    else childrenByParentId.set(thread.parentThreadId, [thread]);
  }
  const descendants: ThreadListEntry[] = [];
  const visited = new Set([rootThreadId]);
  const pending = [rootThreadId];
  for (let parentId = pending.pop(); parentId; parentId = pending.pop()) {
    for (const child of childrenByParentId.get(parentId) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      descendants.push(child);
      pending.push(child.id);
    }
  }
  return { root: latest.get(rootThreadId), descendants };
}

export function getCachedThreadSnapshots({
  queryClient,
  threadIds,
}: CachedThreadSnapshotsArgs): CachedThreadSnapshot[] {
  return threadIds.map((threadId) => ({
    id: threadId,
    thread: queryClient.getQueryData<ThreadWithRuntime>(
      threadQueryKey(threadId),
    ),
  }));
}

export function applyArchivedThreadIds({
  queryClient,
  threadIds,
}: ApplyArchivedThreadIdsArgs): void {
  const archivedAt = Date.now();
  for (const threadId of threadIds) {
    queryClient.setQueryData<ThreadWithRuntime>(
      threadQueryKey(threadId),
      (thread) => {
        if (!thread) {
          return thread;
        }
        return { ...thread, archivedAt };
      },
    );
  }
  const archivedIds = new Set(threadIds);
  removeLiveThreadsFromCachedLists({
    queryClient,
    matchesThread: (thread) => archivedIds.has(thread.id),
  });
}

export function removeLiveThreadsFromCachedLists({
  matchesThread,
  queryClient,
}: RemoveLiveThreadsFromCachedListsArgs): void {
  const removeMatchingLiveThreads = (list: ThreadListEntry[]) =>
    list.filter(
      (thread) => thread.archivedAt !== null || !matchesThread(thread),
    );
  applyToCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
    mapper: removeMatchingLiveThreads,
  });
  applyToCachedSidebarNavigationThreads({
    queryClient,
    mapper: removeMatchingLiveThreads,
  });
}
