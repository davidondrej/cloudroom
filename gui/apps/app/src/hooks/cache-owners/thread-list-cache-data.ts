import type {
  InfiniteData,
  QueryClient,
  QueryKey,
} from "@tanstack/react-query";
import type { ThreadListEntry } from "@cloudroom/domain";

export type ThreadListCacheData =
  | ThreadListEntry[]
  | InfiniteData<ThreadListEntry[]>;

function isThreadListEntryArray(value: unknown): value is ThreadListEntry[] {
  return Array.isArray(value);
}

function isInfiniteThreadListData(
  value: unknown,
): value is InfiniteData<ThreadListEntry[]> {
  return (
    typeof value === "object" &&
    value !== null &&
    "pages" in value &&
    Array.isArray((value as { pages: unknown }).pages)
  );
}

export function* iterateThreadListCacheEntries(
  data: ThreadListCacheData | undefined,
): Iterable<ThreadListEntry> {
  if (!data) {
    return;
  }
  if (isThreadListEntryArray(data)) {
    for (const entry of data) {
      yield entry;
    }
    return;
  }
  for (const page of data.pages) {
    for (const entry of page) {
      yield entry;
    }
  }
}

function mapThreadListCacheData<T extends ThreadListCacheData>(
  data: T,
  mapper: (list: ThreadListEntry[]) => ThreadListEntry[],
): T {
  if (isThreadListEntryArray(data)) {
    return mapper(data) as T;
  }
  let changed = false;
  const pages = data.pages.map((page) => {
    const nextPage = mapper(page);
    if (nextPage !== page) {
      changed = true;
    }
    return nextPage;
  });
  return changed ? ({ ...data, pages } as T) : data;
}

function isThreadListCacheData(value: unknown): value is ThreadListCacheData {
  return isThreadListEntryArray(value) || isInfiniteThreadListData(value);
}

interface CachedThreadList {
  queryKey: QueryKey;
  data: ThreadListCacheData;
}

export type CachedThreadListSnapshot = CachedThreadList[];

interface ThreadListCacheQueryOptions {
  queryKey: QueryKey;
}

interface ApplyToCachedThreadListsOptions extends ThreadListCacheQueryOptions {
  mapper: (list: ThreadListEntry[]) => ThreadListEntry[];
}

export function getCachedThreadLists(
  queryClient: QueryClient,
  options: ThreadListCacheQueryOptions,
): CachedThreadList[] {
  const result: CachedThreadList[] = [];
  for (const [queryKey, data] of queryClient.getQueriesData({
    queryKey: options.queryKey,
  })) {
    if (!isThreadListCacheData(data)) {
      continue;
    }
    result.push({ queryKey, data });
  }
  return result;
}

export function restoreCachedThreadLists(
  queryClient: QueryClient,
  snapshot: CachedThreadListSnapshot,
): void {
  for (const { queryKey, data } of snapshot) {
    queryClient.setQueryData(queryKey, data);
  }
}

/**
 * Puts one thread back into each cached list the snapshot had it in, just
 * before the threads that followed it there. A list that has it again is left
 * alone, and so is every other row: unlike restoring the whole snapshot, this
 * never undoes changes other mutations made since.
 */
export function restoreThreadInCachedLists(
  queryClient: QueryClient,
  snapshot: CachedThreadListSnapshot,
  threadId: string,
): void {
  for (const { queryKey, data } of snapshot) {
    const pages = isThreadListEntryArray(data) ? [data] : data.pages;
    const pageIndex = pages.findIndex((page) =>
      page.some((thread) => thread.id === threadId),
    );
    const order = pages[pageIndex]?.map((thread) => thread.id) ?? [];
    const entry = pages[pageIndex]?.[order.indexOf(threadId)];
    if (!entry) {
      continue;
    }
    const followers = new Set(order.slice(order.indexOf(threadId) + 1));
    const putBack = (list: ThreadListEntry[]): ThreadListEntry[] => {
      const next = list.findIndex((thread) => followers.has(thread.id));
      const at = next === -1 ? list.length : next;
      return [...list.slice(0, at), entry, ...list.slice(at)];
    };
    queryClient.setQueryData<ThreadListCacheData>(queryKey, (current) => {
      if (!isThreadListCacheData(current)) {
        return current;
      }
      for (const thread of iterateThreadListCacheEntries(current)) {
        if (thread.id === threadId) return current;
      }
      if (isThreadListEntryArray(current)) {
        return putBack(current);
      }
      // The same page, or the last one left.
      const target = Math.min(pageIndex, current.pages.length - 1);
      return {
        ...current,
        pages: current.pages.map((page, index) =>
          index === target ? putBack(page) : page,
        ),
      };
    });
  }
}

export function applyToCachedThreadLists(
  queryClient: QueryClient,
  options: ApplyToCachedThreadListsOptions,
): void {
  for (const { queryKey, data } of getCachedThreadLists(queryClient, {
    queryKey: options.queryKey,
  })) {
    const next = mapThreadListCacheData(data, options.mapper);
    if (next === data) {
      continue;
    }
    queryClient.setQueryData(queryKey, next);
  }
}
