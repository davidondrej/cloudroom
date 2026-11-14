import type { ThreadListEntry } from "@cloudroom/domain";
import type {
  PluginSidebarThread,
  PluginSidebarThreadIndicator,
} from "@get-bb/plugin-sdk";
import {
  getThreadListIndicatorLabel,
  resolveThreadListIndicator,
  threadListIndicatorStateForThread,
} from "@cloudroom/client-core";
import { isThreadRead } from "@cloudroom/client-core";
import { getThreadRoutePath } from "@/lib/route-paths";
import { getThreadDisplayTitle } from "./thread-title";

export function toPluginSidebarThread(
  entry: ThreadListEntry,
  hostNamesById: ReadonlyMap<string, string> = new Map(),
): PluginSidebarThread {
  const resolvedIndicator = resolveThreadListIndicator(
    threadListIndicatorStateForThread(entry, false),
  );
  const indicator: PluginSidebarThreadIndicator =
    resolvedIndicator === "queued-waiting" ||
    resolvedIndicator === "queued-failed"
      ? "none"
      : resolvedIndicator;

  return {
    id: entry.id,
    projectId: entry.projectId,
    title: entry.title,
    titleFallback: entry.titleFallback,
    displayTitle: getThreadDisplayTitle(entry),
    href: getThreadRoutePath({
      projectId: entry.projectId,
      threadId: entry.id,
    }),
    execution: entry.execution ?? {
      status: entry.status,
      source: "thread",
      freshness: "unknown",
      observedAt: null,
      receivedAt: null,
      model: null,
      effort: null,
    },
    status: entry.status,
    runtimeStatus: entry.runtime.displayStatus,
    queuedWork: entry.queuedWork,
    sourceThreadId: entry.sourceThreadId,
    lifecycleOwnerThreadId: null,
    isHidden: entry.visibility !== "visible",
    archivedAt: entry.archivedAt,
    pinnedAt: entry.pinnedAt,
    pinSortKey: entry.pinSortKey,
    parentThreadId: entry.parentThreadId,
    sectionId: entry.sectionId,
    originKind: entry.originKind,
    originPluginId: entry.originPluginId,
    providerId: entry.providerId,
    hasPendingInteraction: entry.hasPendingInteraction,
    activity: {
      workflows: entry.activity.activeWorkflowCount,
      backgroundAgents: entry.activity.activeBackgroundAgentCount,
      backgroundCommands: entry.activity.activeBackgroundCommandCount,
      planMode: entry.activity.activePlanModeCount,
      goals: entry.activity.activeGoalCount,
    },
    indicator,
    indicatorLabel: getThreadListIndicatorLabel(indicator),
    isUnread: !isThreadRead(entry),
    isPinned: entry.pinnedAt !== null,
    isArchived: entry.archivedAt !== null,
    environment:
      entry.environmentId === null
        ? null
        : {
            id: entry.environmentId,
            name: entry.environmentName,
            branchName: entry.environmentBranchName,
            providerId: entry.environmentProviderId,
            workspaceDisplayKind: entry.environmentWorkspaceDisplayKind,
            path: entry.environmentPath,
            isWorktree: entry.environmentIsWorktree,
          },
    host:
      entry.environmentHostId === null
        ? null
        : {
            id: entry.environmentHostId,
            name:
              hostNamesById.get(entry.environmentHostId) ??
              entry.environmentHostId,
          },
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lastReadAt: entry.lastReadAt,
    latestAttentionAt: entry.latestAttentionAt,
  };
}

export function groupPluginSidebarChildren(
  threads: readonly PluginSidebarThread[],
): Readonly<Record<string, readonly PluginSidebarThread[]>> {
  const groups = new Map<string, PluginSidebarThread[]>();
  for (const thread of threads) {
    if (thread.parentThreadId === null) continue;
    const group = groups.get(thread.parentThreadId) ?? [];
    group.push(thread);
    groups.set(thread.parentThreadId, group);
  }
  return Object.fromEntries(groups);
}
