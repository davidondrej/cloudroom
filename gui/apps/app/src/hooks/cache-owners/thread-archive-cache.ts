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

interface OptimisticallyArchiveThreadsArgs {
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

export function getCachedLiveThreadDescendants(
  queryClient: QueryClient,
  rootThreadId: string,
): ThreadListEntry[] {
  const childrenByParentId = new Map<string, Map<string, ThreadListEntry>>();
  const addThread = (thread: ThreadListEntry) => {
    if (thread.archivedAt !== null || thread.parentThreadId === null) return;
    const children = childrenByParentId.get(thread.parentThreadId) ?? new Map();
    children.set(thread.id, thread);
    childrenByParentId.set(thread.parentThreadId, children);
  };
  for (const { data } of getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  })) {
    for (const thread of iterateThreadListCacheEntries(data)) addThread(thread);
  }
  for (const thread of getCachedSidebarNavigationThreads(queryClient)) {
    addThread(thread);
  }
  const descendants: ThreadListEntry[] = [];
  const visited = new Set([rootThreadId]);
  const pending = [rootThreadId];
  for (let parentId = pending.pop(); parentId; parentId = pending.pop()) {
    for (const child of childrenByParentId.get(parentId)?.values() ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      descendants.push(child);
      pending.push(child.id);
    }
  }
  return descendants;
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

export function optimisticallyArchiveThreads({
  queryClient,
  threadIds,
}: OptimisticallyArchiveThreadsArgs): void {
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
