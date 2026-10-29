import type { ThreadListEntry } from "@cloudroom/domain";
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import {
  collapseChildThreadsAtom,
  collapsedThreadIdsAtom,
  expandedThreadIdsAtom,
} from "./sidebarCollapsedAtoms";

type ParentLink = Pick<ThreadListEntry, "parentThreadId">;

function getCollapsedThreadIds({
  collapseChildThreads,
  collapsedIds,
  expandedIds,
  threads,
}: {
  collapseChildThreads: boolean;
  collapsedIds: readonly string[];
  expandedIds: readonly string[];
  threads: readonly ParentLink[];
}): Set<string> {
  if (!collapseChildThreads) return new Set(collapsedIds);
  const expanded = new Set(expandedIds);
  const collapsed = new Set<string>();
  for (const { parentThreadId } of threads) {
    if (parentThreadId !== null && !expanded.has(parentThreadId)) {
      collapsed.add(parentThreadId);
    }
  }
  return collapsed;
}

export function useThreadCollapse(threads: readonly ParentLink[]) {
  const collapseChildThreads = useAtomValue(collapseChildThreadsAtom);
  const [collapsedIds, setCollapsedIds] = useAtom(collapsedThreadIdsAtom);
  const [expandedIds, setExpandedIds] = useAtom(expandedThreadIdsAtom);
  const collapsedThreadIds = useMemo(
    () =>
      getCollapsedThreadIds({
        collapseChildThreads,
        collapsedIds,
        expandedIds,
        threads,
      }),
    [collapseChildThreads, collapsedIds, expandedIds, threads],
  );
  const toggleThreadCollapsed = useCallback(
    (threadId: string) => {
      const setIds = collapseChildThreads ? setExpandedIds : setCollapsedIds;
      setIds((current) =>
        current.includes(threadId)
          ? current.filter((id) => id !== threadId)
          : [...current, threadId],
      );
    },
    [collapseChildThreads, setCollapsedIds, setExpandedIds],
  );
  const expandThreads = useCallback(
    (threadIds: readonly string[]) => {
      if (threadIds.length === 0) return;
      if (collapseChildThreads) {
        setExpandedIds((current) => {
          const added = threadIds.filter((id) => !current.includes(id));
          return added.length === 0 ? current : [...current, ...added];
        });
        return;
      }
      setCollapsedIds((current) => {
        const next = current.filter((id) => !threadIds.includes(id));
        return next.length === current.length ? current : next;
      });
    },
    [collapseChildThreads, setCollapsedIds, setExpandedIds],
  );
  return { collapsedThreadIds, expandThreads, toggleThreadCollapsed };
}
