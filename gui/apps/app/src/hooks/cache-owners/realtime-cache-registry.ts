import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  EnvironmentChangeKind,
  HostChangeKind,
  ProjectChangeKind,
  SystemChangeKind,
  ThreadChangeKind,
  ThreadEventType,
  ThreadStatusChangeMetadata,
  ThreadWithRuntime,
} from "@cloudroom/domain";
import {
  getCachedEnvironmentRefWorkspaceStateInvalidationQueryKeys,
  getCachedGlobalThreadListInvalidationQueryKeys,
  getCachedProjectThreadListInvalidationQueryKeys,
  getCachedRootOrderThreadListInvalidationQueryKeys,
  getCachedSidebarNavigationThreads,
  getCachedThreadListPlaceholder,
  getCachedThreadListQueryKeys,
  getEnvironmentBranchListInvalidationQueryKeys,
  getEnvironmentRecordInvalidationQueryKeys,
  getEnvironmentWorkspaceStateInvalidationQueryKeys,
  getFetchingThreadListQueries,
  isArchivedThreadListQueryKey,
  updateCachedThreadListPendingInteractionState,
  updateCachedThreadListStatusState,
} from "./query-cache";
import { bumpDiffPatchFreshnessGeneration } from "./environment-diff-patch-cache-owner";
import { invalidateSystemExecutionOptions } from "./system-cache-effects";
import {
  getCachedThreadLists,
  iterateThreadListCacheEntries,
} from "./thread-list-cache-data";
import {
  allHostQueryKeyPrefix,
  allPluginCatalogSearchQueryKeyPrefix,
  allPluginContributionsQueryKeyPrefix,
  allPluginListQueryKeyPrefix,
  pluginSafeModeQueryKey,
  allPluginSettingsQueryKeyPrefix,
  allPluginSettingsViewQueryKeyPrefix,
  allPluginSourceQueryKeyPrefix,
  allProjectCommandsQueryKeyPrefix,
  allThreadStorageFilePreviewQueryKeyPrefix,
  allThreadStorageFilesQueryKeyPrefix,
  allThreadStorageLocationsQueryKeyPrefix,
  allThreadStoragePathsQueryKeyPrefix,
  allSystemExecutionOptionsQueryKeyPrefix,
  allSystemThemesQueryKeyPrefix,
  allThreadQueryKeyPrefix,
  allTerminalsQueryKeyPrefix,
  environmentDiffFilesQueryKeyPrefix,
  environmentFilePreviewQueryKeyPrefix,
  environmentPullRequestQueryKey,
  threadFileExistenceQueryKeyPrefix,
  environmentWorkStatusQueryKeyPrefix,
  hostProviderCliStatusQueryKey,
  hostsQueryKey,
  projectsQueryKey,
  sidebarNavigationQueryKey,
  systemConfigQueryKey,
  uiPreferencesQueryKey,
  allSystemInstallableProvidersQueryKeyPrefix,
  allSystemProvidersQueryKeyPrefix,
  threadDefaultExecutionOptionsQueryKey,
  threadQueryKey,
  threadTabsQueryKey,
  threadSearchQueryKeyPrefix,
  terminalsQueryKey,
  threadsQueryKey,
  threadStorageFilePreviewQueryKeyPrefix,
  threadStorageFilesForThreadQueryKeyPrefix,
  threadStorageLocationQueryKey,
  threadStoragePathsForThreadQueryKeyPrefix,
  threadTimelineQueryKeyPrefix,
} from "../queries/query-keys";
import { systemEnvironmentProvidersQueryKey } from "../queries/environment-provider-queries";
import { schedulePluginFrontendReconcile } from "../../lib/plugin-frontend-lazy";
import {
  getProjectListInvalidationQueryKeys,
  getProjectPromptHistoryInvalidationQueryKeys,
  getProjectSourceDependentInvalidationQueryKeys,
  getThreadConversationOutlineInvalidationQueryKeys,
  getThreadDetailInvalidationQueryKeys,
  getThreadListInvalidationQueryKeys,
  getThreadPendingInteractionInvalidationQueryKeys,
  getThreadPromptHistoryInvalidationQueryKeys,
  getThreadQueueContentInvalidationQueryKeys,
  getThreadTimelineInvalidationQueryKeys,
  getThreadTimelineWindowInvalidationQueryKeys,
} from "./cache-invalidation-groups";

interface CollectCachedThreadIdsForEnvironmentArgs {
  environmentId: string;
  queryClient: QueryClient;
}

interface TimelineInvalidationQueryKeysArgs {
  queryClient: QueryClient;
  queryKeys: readonly QueryKey[];
}

interface ScheduleTrailingActiveRefetchArgs {
  exact: boolean;
  queryClient: QueryClient;
  queryKey: QueryKey;
}

interface CancelTrailingActiveRefetchArgs {
  queryClient: QueryClient;
  queryKey: QueryKey;
}

const trailingActiveRefetchUnsubscribers = new WeakMap<
  QueryClient,
  Map<string, () => void>
>();

interface ThrottledActiveRefetchEntry {
  lastRunAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  unsubscribe: (() => void) | null;
}

const throttledActiveRefetchEntries = new WeakMap<
  QueryClient,
  Map<string, ThrottledActiveRefetchEntry>
>();

interface ThrottledActiveRefetchArgs {
  exact: boolean;
  minIntervalMs: number;
  queryClient: QueryClient;
  queryKey: QueryKey;
}

const WORK_STATUS_REFETCH_MIN_INTERVAL_MS = 1_000;

const LIST_REFETCH_MIN_INTERVAL_MS = 1_000;

const THROTTLED_LIST_QUERY_ROOTS = new Set<unknown>([
  sidebarNavigationQueryKey()[0],
  projectsQueryKey()[0],
  threadsQueryKey()[0],
  threadSearchQueryKeyPrefix()[0],
]);

const statusPatchesByFetchingQuery = new WeakMap<
  QueryClient,
  Map<string, Map<string, ThreadStatusChangeMetadata>>
>();

const statusPatchUnsubscribers = new WeakMap<QueryClient, () => void>();

const TRAILING_REFETCH_MIN_INTERVAL_MS = 50;
const TRAILING_REFETCH_MAX_INTERVAL_MS = 1_000;

export function resolveTrailingRefetchDelayMs(
  observedFetchDurationMs: number,
): number {
  return Math.min(
    TRAILING_REFETCH_MAX_INTERVAL_MS,
    Math.max(TRAILING_REFETCH_MIN_INTERVAL_MS, observedFetchDurationMs),
  );
}

function timelineInvalidationKey(queryKey: QueryKey): string {
  return JSON.stringify(queryKey);
}

function hasActiveFetchingQueries(
  queryClient: QueryClient,
  queryKey: QueryKey,
  exact: boolean,
): boolean {
  return queryClient
    .getQueryCache()
    .findAll({ exact, queryKey, type: "active" })
    .some((query) => query.state.fetchStatus !== "idle");
}

function hasActiveQueries(
  queryClient: QueryClient,
  queryKey: QueryKey,
): boolean {
  return (
    queryClient.getQueryCache().findAll({ queryKey, type: "active" }).length > 0
  );
}

function invalidateQueryKeyWithThrottledActiveRefetch({
  exact,
  minIntervalMs,
  queryClient,
  queryKey,
}: ThrottledActiveRefetchArgs): void {
  queryClient.invalidateQueries({ exact, queryKey, refetchType: "none" });

  let entries = throttledActiveRefetchEntries.get(queryClient);
  if (!entries) {
    entries = new Map();
    throttledActiveRefetchEntries.set(queryClient, entries);
  }
  const scheduleKey = `${exact}:${timelineInvalidationKey(queryKey)}`;
  const entry = entries.get(scheduleKey) ?? {
    lastRunAt: Number.NEGATIVE_INFINITY,
    timer: null,
    unsubscribe: null,
  };
  entries.set(scheduleKey, entry);
  if (entry.timer || entry.unsubscribe) {
    return;
  }
  const schedule = (): void => {
    if (hasActiveFetchingQueries(queryClient, queryKey, exact)) {
      const unsubscribe = queryClient.getQueryCache().subscribe(() => {
        if (hasActiveFetchingQueries(queryClient, queryKey, exact)) {
          return;
        }
        unsubscribe();
        entry.unsubscribe = null;
        schedule();
      });
      entry.unsubscribe = unsubscribe;
      return;
    }
    const delayMs = entry.lastRunAt + minIntervalMs - Date.now();
    if (delayMs > 0) {
      entry.timer = setTimeout(() => {
        entry.timer = null;
        schedule();
      }, delayMs);
      return;
    }
    entry.lastRunAt = Date.now();
    void queryClient
      .refetchQueries(
        { exact, queryKey, type: "active" },
        { cancelRefetch: false },
      )
      .catch(() => {});
  };
  schedule();
}

function invalidateListQueryKey(
  queryClient: QueryClient,
  queryKey: QueryKey,
  exact: boolean,
): void {
  invalidateQueryKeyWithThrottledActiveRefetch({
    exact,
    minIntervalMs: LIST_REFETCH_MIN_INTERVAL_MS,
    queryClient,
    queryKey,
  });
}

function keepStatusPatchOverInFlightLists(
  queryClient: QueryClient,
  threadId: string,
  statusChange: ThreadStatusChangeMetadata,
): void {
  const queries = getFetchingThreadListQueries(queryClient);
  if (queries.length === 0) {
    return;
  }
  let patchesByQuery = statusPatchesByFetchingQuery.get(queryClient);
  if (!patchesByQuery) {
    patchesByQuery = new Map();
    statusPatchesByFetchingQuery.set(queryClient, patchesByQuery);
  }
  for (const query of queries) {
    const patches = patchesByQuery.get(query.queryHash) ?? new Map();
    patches.set(threadId, statusChange);
    patchesByQuery.set(query.queryHash, patches);
  }
  if (statusPatchUnsubscribers.has(queryClient)) {
    return;
  }
  const pending = patchesByQuery;
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated") {
      return;
    }
    const { action, query } = event;
    if (action.type === "success" ? action.manual : action.type !== "error") {
      return;
    }
    const patches = pending.get(query.queryHash);
    if (!patches) {
      return;
    }
    pending.delete(query.queryHash);
    if (pending.size === 0) {
      unsubscribe();
      statusPatchUnsubscribers.delete(queryClient);
    }
    if (action.type !== "success") {
      return;
    }
    for (const [patchedThreadId, patch] of patches) {
      updateCachedThreadListStatusState(queryClient, patchedThreadId, patch, {
        keepNewer: true,
      });
    }
  });
  statusPatchUnsubscribers.set(queryClient, unsubscribe);
}

function scheduleTrailingActiveRefetch({
  exact,
  queryClient,
  queryKey,
}: ScheduleTrailingActiveRefetchArgs): void {
  const scheduleKey = timelineInvalidationKey(queryKey);
  let unsubscribers = trailingActiveRefetchUnsubscribers.get(queryClient);
  if (!unsubscribers) {
    unsubscribers = new Map();
    trailingActiveRefetchUnsubscribers.set(queryClient, unsubscribers);
  }
  if (unsubscribers.has(scheduleKey)) {
    return;
  }

  const waitingSince = Date.now();

  const unsubscribe = queryClient.getQueryCache().subscribe(() => {
    if (hasActiveFetchingQueries(queryClient, queryKey, exact)) {
      return;
    }

    unsubscribe();
    unsubscribers.delete(scheduleKey);
    const delayMs = resolveTrailingRefetchDelayMs(Date.now() - waitingSince);
    const timer = setTimeout(() => {
      unsubscribers.delete(scheduleKey);
      void queryClient
        .refetchQueries(
          { exact, queryKey, type: "active" },
          { cancelRefetch: false },
        )
        .catch(() => {});
    }, delayMs);
    unsubscribers.set(scheduleKey, () => {
      clearTimeout(timer);
    });
  });
  unsubscribers.set(scheduleKey, unsubscribe);
}

function cancelTrailingActiveRefetch({
  queryClient,
  queryKey,
}: CancelTrailingActiveRefetchArgs): void {
  const unsubscribers = trailingActiveRefetchUnsubscribers.get(queryClient);
  if (!unsubscribers) {
    return;
  }
  const scheduleKey = timelineInvalidationKey(queryKey);
  unsubscribers.get(scheduleKey)?.();
  unsubscribers.delete(scheduleKey);
  if (unsubscribers.size === 0) {
    trailingActiveRefetchUnsubscribers.delete(queryClient);
  }
}

function invalidateQueryKeysWithoutCancelingActiveFetches({
  queryClient,
  queryKeys,
}: TimelineInvalidationQueryKeysArgs): void {
  for (const queryKey of queryKeys) {
    const hadActiveFetch = hasActiveFetchingQueries(
      queryClient,
      queryKey,
      false,
    );
    queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
    if (hadActiveFetch) {
      scheduleTrailingActiveRefetch({ exact: false, queryClient, queryKey });
    }
  }
}

function invalidateTerminalTimelineQueryKeys({
  queryClient,
  queryKeys,
}: TimelineInvalidationQueryKeysArgs): void {
  for (const queryKey of queryKeys) {
    cancelTrailingActiveRefetch({ queryClient, queryKey });
    void queryClient.cancelQueries({ queryKey });
    queryClient.invalidateQueries({ queryKey });
  }
}

export function disposeTrailingActiveRefetches(queryClient: QueryClient): void {
  const throttled = throttledActiveRefetchEntries.get(queryClient);
  if (throttled) {
    for (const entry of throttled.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      entry.unsubscribe?.();
    }
    throttledActiveRefetchEntries.delete(queryClient);
  }
  statusPatchUnsubscribers.get(queryClient)?.();
  statusPatchUnsubscribers.delete(queryClient);
  statusPatchesByFetchingQuery.delete(queryClient);
  const unsubscribers = trailingActiveRefetchUnsubscribers.get(queryClient);
  if (!unsubscribers) {
    return;
  }
  for (const unsubscribe of unsubscribers.values()) {
    unsubscribe();
  }
  trailingActiveRefetchUnsubscribers.delete(queryClient);
}

export const REALTIME_THREAD_CHANGE_REGISTRY = {
  "thread-created": {
    flush: "debounced",
    dirty: [
      dirtyThreadListQueries,
      dirtyThreadDetailQueries,
      dirtyThreadTimelineQueries,
      dirtyProjectPromptHistoryQueries,
    ],
  },
  "thread-deleted": {
    flush: "debounced",
    dirty: [
      dirtyThreadListQueries,
      dirtyThreadDetailQueries,
      dirtyThreadTimelineQueries,
      dirtyProjectPromptHistoryQueries,
    ],
  },
  "events-appended": {
    flush: "debounced",
    dirty: [
      dirtyThreadListQueriesForBackgroundActivity,
      dirtyThreadDetailQueriesForBackgroundActivity,
      dirtyThreadSearchQueriesForCompletedTurn,
      dirtyThreadTimelineQueries,
      dirtyThreadPullRequestQueryForCompletedTurn,
      dirtyThreadFileExistenceQueries,
      dirtyThreadTurnRequestQueries,
    ],
  },
  "history-rewritten": {
    flush: "immediate",
    dirty: [
      dirtyThreadListQueries,
      dirtyThreadDetailQueries,
      dirtyThreadSearchQueries,
      getThreadTimelineInvalidationQueryKeys,
      getThreadQueueContentInvalidationQueryKeys,
      dirtyProjectPromptHistoryQueries,
      getThreadPendingInteractionInvalidationQueryKeys,
    ],
  },
  "interactions-changed": {
    flush: "debounced",
    dirty: [
      dirtyThreadSearchQueries,
      getThreadPendingInteractionInvalidationQueryKeys,
      patchThreadListPendingInteractionState,
    ],
  },
  "status-changed": {
    flush: "immediate",
    dirty: [
      patchThreadListStatusState,
      dirtyThreadDetailQueries,
      dirtyThreadFileExistenceQueries,
    ],
  },
  "title-changed": {
    flush: "debounced",
    dirty: [dirtyActiveThreadListQueries, dirtyThreadDetailQueries],
  },
  "purpose-changed": {
    flush: "debounced",
    dirty: [dirtyActiveThreadListQueries, dirtyThreadDetailQueries],
  },
  "queue-changed": {
    flush: "debounced",
    dirty: [
      getThreadQueueContentInvalidationQueryKeys,
      dirtyActiveThreadListQueries,
    ],
  },
  "archived-changed": {
    flush: "debounced",
    dirty: [
      dirtyThreadListQueries,
      dirtyThreadDetailQueries,
      dirtyProjectPromptHistoryQueries,
    ],
  },
  "pin-state-changed": {
    flush: "debounced",
    dirty: [dirtyThreadListQueries, dirtyThreadDetailQueries],
  },
  "parent-changed": {
    flush: "debounced",
    dirty: [dirtyThreadListQueries, dirtyThreadDetailQueries],
  },
  "environment-changed": {
    flush: "immediate",
    dirty: [
      dirtyActiveThreadListQueries,
      dirtyThreadDetailQueries,
      dirtyThreadDefaultExecutionOptionsQueries,
      dirtyThreadStorageQueriesForThread,
    ],
  },
  "execution-options-changed": {
    flush: "immediate",
    dirty: [
      dirtyThreadDetailQueries,
      dirtyThreadDefaultExecutionOptionsQueries,
    ],
  },
  "read-state-changed": {
    flush: "debounced",
    dirty: [markThreadDetailQueryStale, markThreadListQueriesStale],
  },
  "order-changed": {
    flush: "debounced",
    dirty: [dirtyRootOrderThreadListQueries],
  },
  "tabs-changed": {
    flush: "immediate",
    dirty: [dirtyThreadTabsQueries],
  },
  "terminals-changed": {
    flush: "debounced",
    dirty: [dirtyThreadTerminalQueries],
  },
} satisfies ThreadChangeRegistry;

export const REALTIME_ENVIRONMENT_CHANGE_REGISTRY = {
  "environment-created": {
    dirty: [
      dirtyEnvironmentRecordQueries,
      dirtyEnvironmentWorkspaceStateQueries,
      dirtyEnvironmentBranchListQueries,
    ],
  },
  "environment-deleted": {
    dirty: [
      dirtyEnvironmentRecordQueries,
      dirtyEnvironmentWorkspaceStateQueries,
      dirtyEnvironmentBranchListQueries,
    ],
  },
  "metadata-changed": {
    dirty: [
      dirtyEnvironmentRecordQueries,
      dirtyEnvironmentWorkspaceStateQueries,
      dirtyEnvironmentBranchListQueries,
      dirtyEnvironmentThreadListQueries,
      dirtyThreadSearchQueries,
    ],
  },
  "status-changed": {
    dirty: [
      dirtyEnvironmentRecordQueries,
      dirtyEnvironmentWorkspaceStateQueries,
      dirtyEnvironmentBranchListQueries,
    ],
  },
  "work-status-changed": {
    dirty: [dirtyEnvironmentLiveWorkspaceStateQueries],
  },
  "git-refs-changed": {
    dirty: [
      dirtyEnvironmentRefDerivedWorkspaceStateQueries,
      dirtyEnvironmentBranchListQueries,
    ],
  },
  "thread-storage-changed": {
    dirty: [dirtyThreadStorageQueriesForEnvironment],
  },
} satisfies EnvironmentChangeRegistry;

export const REALTIME_PROJECT_CHANGE_REGISTRY = {
  "project-created": {
    dirty: [getProjectListInvalidationQueryKeys],
  },
  "project-updated": {
    dirty: [getProjectListInvalidationQueryKeys],
  },
  "project-deleted": {
    dirty: [getProjectListInvalidationQueryKeys],
  },
  "project-sources-changed": {
    dirty: [getProjectSourceDependentInvalidationQueryKeys],
  },
  "threads-changed": {
    dirty: [
      getProjectListInvalidationQueryKeys,
      dirtyProjectPromptHistoryQueries,
    ],
  },
  "project-order-changed": {
    dirty: [getProjectListInvalidationQueryKeys],
  },
} satisfies ProjectChangeRegistry;

const HOST_CONNECTION_DIRTY_HANDLERS = [
  dirtyHostAvailabilityQueries,
  getProjectListInvalidationQueryKeys,
  dirtySystemProviderQueries,
] satisfies readonly RealtimeDirtyHandler<HostRealtimeDirtyContext>[];

export const REALTIME_HOST_CHANGE_REGISTRY = {
  "host-connected": {
    dirty: [
      ...HOST_CONNECTION_DIRTY_HANDLERS,
      dirtyHostSystemExecutionOptionQueries,
      dirtyAllThreadStorageQueries,
    ],
  },
  "host-disconnected": {
    dirty: HOST_CONNECTION_DIRTY_HANDLERS,
  },
  "provider-model-catalog-changed": {
    dirty: [dirtyHostSystemExecutionOptionQueries],
  },
  "provider-cli-status-changed": {
    dirty: [
      dirtyHostProviderCliStatusQueries,
      dirtySystemProviderQueries,
      dirtySystemInstallableProviderQueries,
    ],
  },
} satisfies HostChangeRegistry;

export const REALTIME_SYSTEM_CHANGE_REGISTRY = {
  "config-changed": {
    dirty: [
      dirtySystemConfigQueries,
      dirtyAllThreadTimelineQueries,
      dirtySystemProviderQueries,
      dirtySystemExecutionOptionQueries,
      dirtyEnvironmentProviderQueries,
    ],
  },
  "plugins-changed": {
    dirty: [
      dirtySystemConfigQueries,
      dirtyPluginContributionQueries,
      dirtyProjectCommandCatalogQueries,
      dirtyPluginManagementQueries,
      dirtyEnvironmentProviderQueries,
      reconcilePluginFrontendBundles,
    ],
  },
  "provider-registrations-changed": {
    dirty: [
      dirtySystemProviderQueries,
      dirtySystemInstallableProviderQueries,
      dirtySystemExecutionOptionQueries,
    ],
  },
  "environment-availability-changed": {
    dirty: [dirtyEnvironmentProviderQueries],
  },
  "ui-preferences-changed": {
    dirty: [dirtyUiPreferencesQueries],
  },
} satisfies SystemChangeRegistry;

type ThreadChangeFlushPriority = "debounced" | "immediate";

interface RealtimeDirtyContext {
  queryClient: QueryClient;
}

interface ThreadRealtimeDirtyContext extends RealtimeDirtyContext {
  backgroundActivityChanged: boolean | undefined;
  eventTypes: readonly ThreadEventType[] | undefined;
  flushOnce: (key: string) => boolean;
  hasPendingInteraction: boolean | undefined;
  projectId: string | undefined;
  statusChange: ThreadStatusChangeMetadata | undefined;
  threadId: string | undefined;
}

export function createFlushOncePredicate(): (key: string) => boolean {
  const seen = new Set<string>();
  return (key) => {
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  };
}

interface EnvironmentRealtimeDirtyContext extends RealtimeDirtyContext {
  environmentId: string;
  getCachedThreadIdsForEnvironment: () => string[];
}

interface ProjectRealtimeDirtyContext extends RealtimeDirtyContext {
  projectId: string | undefined;
}

interface HostRealtimeDirtyContext extends RealtimeDirtyContext {
  hostId: string | undefined;
}

type RealtimeDirtyHandler<Context extends RealtimeDirtyContext> = (
  context: Context,
) => readonly QueryKey[] | void;

interface ExecuteRealtimeDirtyHandlersArgs<
  Context extends RealtimeDirtyContext,
> {
  context: Context;
  handlers: readonly RealtimeDirtyHandler<Context>[];
}

interface ThreadChangeRule {
  dirty: readonly RealtimeDirtyHandler<ThreadRealtimeDirtyContext>[];
  flush: ThreadChangeFlushPriority;
}

type ThreadChangeRegistry = Record<ThreadChangeKind, ThreadChangeRule>;

interface EnvironmentChangeRule {
  dirty: readonly RealtimeDirtyHandler<EnvironmentRealtimeDirtyContext>[];
}

type EnvironmentChangeRegistry = Record<
  EnvironmentChangeKind,
  EnvironmentChangeRule
>;

interface ProjectChangeRule {
  dirty: readonly RealtimeDirtyHandler<ProjectRealtimeDirtyContext>[];
}

type ProjectChangeRegistry = Record<ProjectChangeKind, ProjectChangeRule>;

interface HostChangeRule {
  dirty: readonly RealtimeDirtyHandler<HostRealtimeDirtyContext>[];
}

type HostChangeRegistry = Record<HostChangeKind, HostChangeRule>;

interface SystemChangeRule {
  dirty: readonly RealtimeDirtyHandler<RealtimeDirtyContext>[];
}

type SystemChangeRegistry = Partial<Record<SystemChangeKind, SystemChangeRule>>;

export function executeRealtimeDirtyHandlers<
  Context extends RealtimeDirtyContext,
>({ context, handlers }: ExecuteRealtimeDirtyHandlersArgs<Context>): void {
  for (const handler of handlers) {
    const queryKeys = handler(context);
    if (!queryKeys) {
      continue;
    }
    for (const queryKey of queryKeys) {
      if (THROTTLED_LIST_QUERY_ROOTS.has(queryKey[0])) {
        invalidateListQueryKey(context.queryClient, queryKey, false);
        continue;
      }
      context.queryClient.invalidateQueries({ queryKey });
    }
  }
}

export interface ThreadChangesByFlushPriority {
  debounced: ThreadChangeKind[] | null;
  immediate: ThreadChangeKind[] | null;
}

export function partitionThreadChangesByFlushPriority(
  changes: readonly ThreadChangeKind[],
): ThreadChangesByFlushPriority {
  let debounced: ThreadChangeKind[] | null = null;
  let immediate: ThreadChangeKind[] | null = null;
  for (const change of changes) {
    if (REALTIME_THREAD_CHANGE_REGISTRY[change].flush === "immediate") {
      (immediate ??= []).push(change);
    } else {
      (debounced ??= []).push(change);
    }
  }
  return { debounced, immediate };
}

export function collectCachedThreadIdsForEnvironment({
  environmentId,
  queryClient,
}: CollectCachedThreadIdsForEnvironmentArgs): string[] {
  const threadIds = new Set<string>();
  for (const [, thread] of queryClient.getQueriesData<ThreadWithRuntime>({
    queryKey: allThreadQueryKeyPrefix(),
  })) {
    if (thread?.environmentId === environmentId) {
      threadIds.add(thread.id);
    }
  }
  for (const { data } of getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  })) {
    for (const thread of iterateThreadListCacheEntries(data)) {
      if (thread.environmentId === environmentId) {
        threadIds.add(thread.id);
      }
    }
  }
  return Array.from(threadIds);
}

function dirtyThreadListQueries({
  projectId,
  queryClient,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  if (projectId) {
    for (const queryKey of getCachedGlobalThreadListInvalidationQueryKeys({
      queryClient,
    })) {
      invalidateListQueryKey(queryClient, queryKey, true);
    }
  }
  return getThreadListInvalidationQueryKeys({ projectId, queryClient });
}

function dirtyActiveThreadListQueries({
  projectId,
  queryClient,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  const listQueryKeys = projectId
    ? [
        ...getCachedProjectThreadListInvalidationQueryKeys({
          projectId,
          queryClient,
        }),
        ...getCachedGlobalThreadListInvalidationQueryKeys({ queryClient }),
      ]
    : getCachedThreadListQueryKeys(queryClient);
  for (const queryKey of listQueryKeys) {
    if (isArchivedThreadListQueryKey(queryKey)) {
      queryClient.invalidateQueries({
        exact: true,
        queryKey,
        refetchType: "none",
      });
      continue;
    }
    invalidateListQueryKey(queryClient, queryKey, true);
  }
  return [sidebarNavigationQueryKey(), threadSearchQueryKeyPrefix()];
}

function dirtyThreadListQueriesForBackgroundActivity(
  context: ThreadRealtimeDirtyContext,
): QueryKey[] {
  if (context.backgroundActivityChanged !== true) {
    return [];
  }
  return dirtyActiveThreadListQueries(context);
}

function dirtyThreadDetailQueriesForBackgroundActivity(
  context: ThreadRealtimeDirtyContext,
): QueryKey[] {
  if (context.backgroundActivityChanged !== true) {
    return [];
  }
  return dirtyThreadDetailQueries(context);
}

function dirtyRootOrderThreadListQueries({
  projectId,
  queryClient,
}: ThreadRealtimeDirtyContext): void {
  invalidateListQueryKey(queryClient, sidebarNavigationQueryKey(), false);
  for (const queryKey of getCachedRootOrderThreadListInvalidationQueryKeys({
    projectId,
    queryClient,
  })) {
    invalidateListQueryKey(queryClient, queryKey, true);
  }
  if (!projectId) return;
  for (const queryKey of getCachedRootOrderThreadListInvalidationQueryKeys({
    queryClient,
  })) {
    invalidateListQueryKey(queryClient, queryKey, true);
  }
}

function dirtyThreadDetailQueries({
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  return getThreadDetailInvalidationQueryKeys({ threadId });
}

function dirtyThreadDefaultExecutionOptionsQueries({
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  return threadId
    ? [
        threadDefaultExecutionOptionsQueryKey(threadId),
        ["cloudroom-thread", threadId],
      ]
    : [];
}

function dirtyThreadTabsQueries({
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  return threadId ? [threadTabsQueryKey(threadId)] : [];
}

function dirtyThreadSearchQueries(): QueryKey[] {
  return [threadSearchQueryKeyPrefix()];
}

function dirtyThreadSearchQueriesForCompletedTurn({
  eventTypes,
  flushOnce,
  queryClient,
}: ThreadRealtimeDirtyContext): void {
  if (!eventTypes?.includes("turn/completed")) {
    return;
  }
  if (!flushOnce("thread-search:turn-completed")) {
    return;
  }
  invalidateQueryKeysWithoutCancelingActiveFetches({
    queryClient,
    queryKeys: [threadSearchQueryKeyPrefix()],
  });
}

function dirtyThreadTimelineQueries({
  eventTypes,
  queryClient,
  threadId,
}: ThreadRealtimeDirtyContext): void {
  const timelineQueryKeys = getThreadTimelineWindowInvalidationQueryKeys({
    threadId,
  });
  const outlineQueryKeys = getThreadConversationOutlineInvalidationQueryKeys({
    threadId,
  });
  const outlineMayHaveChanged =
    eventTypes === undefined || eventTypes.includes("turn/completed");
  if (
    threadId !== undefined &&
    !hasActiveQueries(queryClient, threadTimelineQueryKeyPrefix(threadId))
  ) {
    for (const queryKey of [...timelineQueryKeys, ...outlineQueryKeys]) {
      queryClient.invalidateQueries({ queryKey, refetchType: "none" });
    }
    return;
  }
  if (eventTypes?.includes("turn/completed")) {
    invalidateTerminalTimelineQueryKeys({
      queryClient,
      queryKeys: [...timelineQueryKeys, ...outlineQueryKeys],
    });
    return;
  }
  invalidateQueryKeysWithoutCancelingActiveFetches({
    queryClient,
    queryKeys: timelineQueryKeys,
  });
  if (outlineMayHaveChanged) {
    invalidateQueryKeysWithoutCancelingActiveFetches({
      queryClient,
      queryKeys: outlineQueryKeys,
    });
  }
}

function dirtyThreadTurnRequestQueries({
  eventTypes,
  projectId,
  queryClient,
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  if (!threadId || !eventTypes?.includes("client/turn/requested")) return [];
  const queryKey = threadDefaultExecutionOptionsQueryKey(threadId);
  void queryClient.cancelQueries({ queryKey });
  return [
    queryKey,
    ...getThreadPromptHistoryInvalidationQueryKeys({ threadId }),
    ...getProjectPromptHistoryInvalidationQueryKeys({ projectId }),
  ];
}

function dirtyThreadPullRequestQueryForCompletedTurn({
  eventTypes,
  queryClient,
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  if (!threadId || !eventTypes?.includes("turn/completed")) {
    return [];
  }
  const cachedThread =
    queryClient.getQueryData<ThreadWithRuntime>(threadQueryKey(threadId)) ??
    getCachedThreadListPlaceholder(queryClient, threadId) ??
    getCachedSidebarNavigationThreads(queryClient).find(
      (thread) => thread.id === threadId,
    );
  const environmentId = cachedThread?.environmentId;
  return environmentId ? [environmentPullRequestQueryKey(environmentId)] : [];
}

function dirtyThreadTerminalQueries({
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  return threadId
    ? [terminalsQueryKey({ kind: "thread", threadId })]
    : [allTerminalsQueryKeyPrefix()];
}

function dirtyThreadFileExistenceQueries({
  eventTypes,
  statusChange,
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  if (!threadId) return [];
  if (!statusChange && !eventTypes?.includes("turn/completed")) return [];
  return [threadFileExistenceQueryKeyPrefix(threadId)];
}

function dirtyThreadStorageQueriesForThread({
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  if (!threadId) {
    return dirtyAllThreadStorageQueries();
  }
  return [
    threadStorageFilesForThreadQueryKeyPrefix(threadId),
    threadStorageLocationQueryKey(threadId),
    threadStoragePathsForThreadQueryKeyPrefix(threadId),
    threadStorageFilePreviewQueryKeyPrefix(threadId),
  ];
}

function dirtyProjectPromptHistoryQueries({
  projectId,
}: ProjectRealtimeDirtyContext | ThreadRealtimeDirtyContext): QueryKey[] {
  return getProjectPromptHistoryInvalidationQueryKeys({ projectId });
}

function markThreadDetailQueryStale({
  queryClient,
  threadId,
}: ThreadRealtimeDirtyContext): void {
  if (!threadId) {
    return;
  }
  queryClient.invalidateQueries({
    queryKey: threadQueryKey(threadId),
    refetchType: "none",
  });
}

function markThreadListQueriesStale({
  projectId,
  queryClient,
}: ThreadRealtimeDirtyContext): void {
  queryClient.invalidateQueries({
    queryKey: sidebarNavigationQueryKey(),
    refetchType: "none",
  });
  if (!projectId) {
    queryClient.invalidateQueries({
      queryKey: threadsQueryKey(),
      refetchType: "none",
    });
    return;
  }
  for (const queryKey of getCachedProjectThreadListInvalidationQueryKeys({
    projectId,
    queryClient,
  })) {
    queryClient.invalidateQueries({
      queryKey,
      refetchType: "none",
    });
  }
  for (const queryKey of getCachedGlobalThreadListInvalidationQueryKeys({
    queryClient,
  })) {
    queryClient.invalidateQueries({
      exact: true,
      queryKey,
      refetchType: "none",
    });
  }
}

function patchThreadListPendingInteractionState({
  hasPendingInteraction,
  queryClient,
  threadId,
}: ThreadRealtimeDirtyContext): void {
  if (!threadId || hasPendingInteraction === undefined) {
    return;
  }
  updateCachedThreadListPendingInteractionState(
    queryClient,
    threadId,
    hasPendingInteraction,
  );
}

function patchThreadListStatusState(
  context: ThreadRealtimeDirtyContext,
): QueryKey[] {
  const { queryClient, statusChange, threadId } = context;
  if (!threadId || !statusChange) {
    return dirtyActiveThreadListQueries(context);
  }
  updateCachedThreadListStatusState(queryClient, threadId, statusChange);
  keepStatusPatchOverInFlightLists(queryClient, threadId, statusChange);
  return [threadSearchQueryKeyPrefix()];
}

function dirtyEnvironmentRecordQueries(
  context: EnvironmentRealtimeDirtyContext,
): QueryKey[] {
  return getEnvironmentRecordInvalidationQueryKeys(context);
}

function dirtyEnvironmentWorkspaceStateQueries(
  context: EnvironmentRealtimeDirtyContext,
): void {
  bumpDiffPatchFreshnessGeneration(context.environmentId);
  for (const queryKey of getEnvironmentWorkspaceStateInvalidationQueryKeys(
    context,
  )) {
    context.queryClient.invalidateQueries({ queryKey });
  }
}

function dirtyEnvironmentLiveWorkspaceStateQueries({
  environmentId,
  queryClient,
}: EnvironmentRealtimeDirtyContext): void {
  bumpDiffPatchFreshnessGeneration(environmentId);
  invalidateQueryKeyWithThrottledActiveRefetch({
    exact: false,
    minIntervalMs: WORK_STATUS_REFETCH_MIN_INTERVAL_MS,
    queryClient,
    queryKey: environmentWorkStatusQueryKeyPrefix(environmentId),
  });
  queryClient.invalidateQueries({
    queryKey: environmentFilePreviewQueryKeyPrefix(environmentId),
  });
  queryClient.invalidateQueries({
    queryKey: environmentDiffFilesQueryKeyPrefix(environmentId),
  });
}

function dirtyEnvironmentRefDerivedWorkspaceStateQueries({
  environmentId,
  queryClient,
}: EnvironmentRealtimeDirtyContext): void {
  bumpDiffPatchFreshnessGeneration(environmentId);
  for (const queryKey of getCachedEnvironmentRefWorkspaceStateInvalidationQueryKeys(
    queryClient,
    { environmentId },
  )) {
    queryClient.invalidateQueries({ queryKey });
  }
}

function dirtyEnvironmentBranchListQueries(
  context: EnvironmentRealtimeDirtyContext,
): QueryKey[] {
  return getEnvironmentBranchListInvalidationQueryKeys(context);
}

function dirtyEnvironmentThreadListQueries({
  environmentId,
  queryClient,
}: EnvironmentRealtimeDirtyContext): QueryKey[] {
  const queryKeys: QueryKey[] = [];
  for (const { data, queryKey } of getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  })) {
    for (const thread of iterateThreadListCacheEntries(data)) {
      if (thread.environmentId !== environmentId) {
        continue;
      }
      queryKeys.push(queryKey);
      break;
    }
  }

  const sidebarContainsEnvironment = getCachedSidebarNavigationThreads(
    queryClient,
  ).some((thread) => thread.environmentId === environmentId);
  if (sidebarContainsEnvironment) {
    queryKeys.push(sidebarNavigationQueryKey());
  }

  return queryKeys;
}

function dirtyThreadStorageQueriesForEnvironment({
  getCachedThreadIdsForEnvironment,
}: EnvironmentRealtimeDirtyContext): QueryKey[] {
  const queryKeys: QueryKey[] = [];
  for (const threadId of getCachedThreadIdsForEnvironment()) {
    queryKeys.push(threadStorageFilesForThreadQueryKeyPrefix(threadId));
    queryKeys.push(threadStoragePathsForThreadQueryKeyPrefix(threadId));
    queryKeys.push(threadStorageFilePreviewQueryKeyPrefix(threadId));
  }
  return queryKeys;
}

function dirtyAllThreadStorageQueries(): QueryKey[] {
  return [
    allThreadStorageFilesQueryKeyPrefix(),
    allThreadStorageLocationsQueryKeyPrefix(),
    allThreadStoragePathsQueryKeyPrefix(),
    allThreadStorageFilePreviewQueryKeyPrefix(),
  ];
}

function dirtyHostAvailabilityQueries(): QueryKey[] {
  return [hostsQueryKey(), allHostQueryKeyPrefix()];
}

function dirtySystemConfigQueries({ queryClient }: RealtimeDirtyContext): void {
  invalidateQueryKeysWithoutCancelingActiveFetches({
    queryClient,
    queryKeys: [systemConfigQueryKey(), allSystemThemesQueryKeyPrefix()],
  });
}

function dirtyUiPreferencesQueries({
  queryClient,
}: RealtimeDirtyContext): void {
  invalidateQueryKeysWithoutCancelingActiveFetches({
    queryClient,
    queryKeys: [uiPreferencesQueryKey()],
  });
}

function dirtyAllThreadTimelineQueries(): QueryKey[] {
  return getThreadTimelineInvalidationQueryKeys({ threadId: undefined });
}

function dirtySystemProviderQueries(): QueryKey[] {
  return [allSystemProvidersQueryKeyPrefix()];
}

function dirtySystemInstallableProviderQueries(): QueryKey[] {
  return [allSystemInstallableProvidersQueryKeyPrefix()];
}

function dirtySystemExecutionOptionQueries(): QueryKey[] {
  return [allSystemExecutionOptionsQueryKeyPrefix()];
}

function dirtyHostSystemExecutionOptionQueries({
  hostId,
  queryClient,
}: HostRealtimeDirtyContext): QueryKey[] | void {
  if (hostId === undefined) return [allSystemExecutionOptionsQueryKeyPrefix()];
  void invalidateSystemExecutionOptions({ hostId, queryClient });
}

function dirtyHostProviderCliStatusQueries({
  hostId,
}: HostRealtimeDirtyContext): QueryKey[] {
  return hostId === undefined ? [] : [hostProviderCliStatusQueryKey(hostId)];
}

function dirtyPluginContributionQueries(): QueryKey[] {
  return [allPluginContributionsQueryKeyPrefix()];
}

function dirtyProjectCommandCatalogQueries(): QueryKey[] {
  return [allProjectCommandsQueryKeyPrefix()];
}

function dirtyPluginManagementQueries(): QueryKey[] {
  return [
    allPluginListQueryKeyPrefix(),
    allPluginSettingsViewQueryKeyPrefix(),
    allPluginSettingsQueryKeyPrefix(),
    allPluginSourceQueryKeyPrefix(),
    allPluginCatalogSearchQueryKeyPrefix(),
    pluginSafeModeQueryKey(),
  ];
}

function dirtyEnvironmentProviderQueries(): QueryKey[] {
  return [systemEnvironmentProvidersQueryKey()];
}

function reconcilePluginFrontendBundles(): void {
  schedulePluginFrontendReconcile();
}
