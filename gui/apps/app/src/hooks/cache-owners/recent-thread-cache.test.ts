import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { threadTimelineQueryKey } from "@/hooks/queries/query-keys";
import {
  RECENT_THREAD_CACHE_LIMIT,
  rememberRecentThread,
} from "./recent-thread-cache";

function openThreads(queryClient: QueryClient, threadIds: string[]): void {
  for (const threadId of threadIds) {
    queryClient.setQueryData(threadTimelineQueryKey(threadId), { rows: [] });
    rememberRecentThread(queryClient, threadId);
  }
}

const isCached = (queryClient: QueryClient, threadId: string) =>
  queryClient.getQueryData(threadTimelineQueryKey(threadId)) !== undefined;

const threadIds = Array.from(
  { length: RECENT_THREAD_CACHE_LIMIT + 1 },
  (_, index) => `thr_${index}`,
);

describe("rememberRecentThread", () => {
  it("drops only the least recently opened thread past the limit", () => {
    const queryClient = new QueryClient();
    openThreads(queryClient, threadIds.slice(0, -1));
    rememberRecentThread(queryClient, "thr_0");
    openThreads(queryClient, threadIds.slice(-1));

    expect(isCached(queryClient, "thr_0")).toBe(true);
    expect(isCached(queryClient, "thr_1")).toBe(false);
    for (const threadId of threadIds.slice(2)) {
      expect(isCached(queryClient, threadId)).toBe(true);
    }
  });

  it("keeps a dropped thread that is still on screen", () => {
    const queryClient = new QueryClient();
    openThreads(queryClient, threadIds.slice(0, 1));
    const unsubscribe = new QueryObserver(queryClient, {
      queryKey: threadTimelineQueryKey("thr_0"),
      queryFn: () => ({ rows: [] }),
      staleTime: Infinity,
    }).subscribe(() => {});
    openThreads(queryClient, threadIds.slice(1));

    expect(
      queryClient.getQueryData(threadTimelineQueryKey("thr_0")),
    ).toBeDefined();
    unsubscribe();
  });
});
