import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { threadTimelineQueryKeyPrefix } from "../queries/query-keys";

export const RECENT_THREAD_CACHE_LIMIT = 20;
export const RECENT_THREAD_GC_TIME = Infinity;

const recentThreadIdsByClient = new WeakMap<QueryClient, string[]>();

export function rememberRecentThread(
  queryClient: QueryClient,
  threadId: string,
): void {
  let threadIds = recentThreadIdsByClient.get(queryClient);
  if (!threadIds) {
    threadIds = [];
    recentThreadIdsByClient.set(queryClient, threadIds);
  }
  const index = threadIds.indexOf(threadId);
  if (index !== -1) {
    threadIds.splice(index, 1);
  }
  threadIds.unshift(threadId);
  for (const evictedThreadId of threadIds.splice(RECENT_THREAD_CACHE_LIMIT)) {
    queryClient.removeQueries({
      queryKey: threadTimelineQueryKeyPrefix(evictedThreadId),
      type: "inactive",
    });
  }
}

export function useRememberRecentThread(
  threadId: string,
  enabled: boolean,
): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) {
      return;
    }
    rememberRecentThread(queryClient, threadId);
    return () => rememberRecentThread(queryClient, threadId);
  }, [enabled, queryClient, threadId]);
}
