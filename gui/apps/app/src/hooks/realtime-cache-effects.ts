import { notifyManager, type QueryClient } from "@tanstack/react-query";
import { assertNever } from "@cloudroom/core-ui";
import {
  createDebouncedCallbackScheduler,
  type ChangedMessage,
  type EnvironmentChangeKind,
  type HostChangeKind,
  type ProjectChangeKind,
  type SystemChangeKind,
  type ThreadEventType,
  type ThreadChangeMetadata,
  type ThreadChangeKind,
  type ThreadStatusChangeMetadata,
} from "@cloudroom/domain";
import {
  invalidateRealtimeQueriesAfterServerReconnect,
  invalidateRealtimeQueriesFetchedBeforeInitialConnect,
  refetchErroredRealtimeQueriesOnInitialConnect,
} from "./cache-owners/system-cache-effects";
import { createBufferedEnvironmentInvalidator } from "./buffered-environment-invalidator";
import {
  isDocumentVisible,
  subscribeToDocumentVisibility,
} from "@/lib/document-visibility";
import {
  applyBatchedThreadListStatusPatches,
  collectCachedThreadIdsForEnvironment,
  createFlushOncePredicate,
  disposeTrailingActiveRefetches,
  executeRealtimeDirtyHandlers,
  REALTIME_ENVIRONMENT_CHANGE_REGISTRY,
  REALTIME_HOST_CHANGE_REGISTRY,
  REALTIME_PROJECT_CHANGE_REGISTRY,
  REALTIME_SYSTEM_CHANGE_REGISTRY,
  REALTIME_THREAD_CHANGE_REGISTRY,
  REALTIME_THREAD_LIST_STATUS_PATCH_HANDLER,
  partitionThreadChangesByFlushPriority,
} from "./cache-owners/realtime-cache-registry";
import { threadSearchQueryKeyPrefix } from "./queries/query-keys";

interface ThreadInvalidationDebounce {
  debounceMs: number;
  maxWaitMs: number;
}

export function resolveThreadInvalidationDebounce(
  isCoarsePointer: boolean,
): ThreadInvalidationDebounce {
  return isCoarsePointer
    ? { debounceMs: 150, maxWaitMs: 400 }
    : { debounceMs: 50, maxWaitMs: 200 };
}

function detectCoarsePointer(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

const {
  debounceMs: INVALIDATION_DEBOUNCE_MS,
  maxWaitMs: INVALIDATION_MAX_WAIT_MS,
} = resolveThreadInvalidationDebounce(detectCoarsePointer());
const ENVIRONMENT_INVALIDATION_DEBOUNCE_MS = 250;
const ENVIRONMENT_INVALIDATION_MAX_WAIT_MS = 500;
const STATUS_CHANGE_BURST_WINDOW_MS = 32;

type RealtimeConnectedEvent =
  | { reconnected: false }
  | { reconnected: true; disconnectedAt: number };

interface RealtimeCacheEffects {
  dispose: () => void;
  handleChanged: (message: ChangedMessage) => void;
  handleConnected: (event: RealtimeConnectedEvent) => void;
}

export interface RealtimeCacheEffectsVisibility {
  isDocumentVisible: () => boolean;
  subscribe: (listener: () => void) => () => void;
}

interface RealtimeCacheEffectsOptions {
  queryClient: QueryClient;
  visibility?: RealtimeCacheEffectsVisibility;
}

interface DeferredNonThreadChanges {
  environmentKindsById: Map<string, Set<EnvironmentChangeKind>>;
  hostKinds: Set<HostChangeKind>;
  projectKindsById: Map<string | undefined, Set<ProjectChangeKind>>;
  systemKinds: Set<SystemChangeKind>;
}

interface ThreadChangeState {
  changedThreadKinds: Map<string, Set<ThreadChangeKind>>;
  globalChangeKinds: Set<ThreadChangeKind>;
  metadataByThreadId: Map<string, ThreadChangeMetadata>;
}

interface MergeThreadChangesArg {
  changes: readonly ThreadChangeKind[];
  state: ThreadChangeState;
  threadId: string;
}

interface EnvironmentArg {
  environmentId: string;
  queryClient: QueryClient;
}

interface RealtimeEnvironmentChangedArg extends EnvironmentArg {
  changeKinds: readonly EnvironmentChangeKind[];
}

function mergeEventTypes(
  current: readonly ThreadEventType[] | undefined,
  next: readonly ThreadEventType[] | undefined,
): readonly ThreadEventType[] | undefined {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  return Array.from(new Set([...current, ...next]));
}

interface MergeThreadChangeMetadataArgs {
  archivedChanged: boolean;
  current: ThreadChangeMetadata | undefined;
  next: ThreadChangeMetadata;
  statusChanged: boolean;
}

function mergeThreadChangeMetadata({
  archivedChanged,
  current,
  next,
  statusChanged,
}: MergeThreadChangeMetadataArgs): ThreadChangeMetadata {
  const archived = archivedChanged
    ? next.archived
    : (next.archived ?? current?.archived);
  const eventTypes = mergeEventTypes(current?.eventTypes, next.eventTypes);
  const backgroundActivityChanged =
    next.backgroundActivityChanged ?? current?.backgroundActivityChanged;
  const hasPendingInteraction =
    next.hasPendingInteraction ?? current?.hasPendingInteraction;
  const projectId = next.projectId ?? current?.projectId;
  const statusChange = statusChanged
    ? next.statusChange
    : (next.statusChange ?? current?.statusChange);
  const metadata: ThreadChangeMetadata = {};
  if (archived !== undefined) {
    metadata.archived = archived;
  }
  if (eventTypes) {
    metadata.eventTypes = eventTypes;
  }
  if (backgroundActivityChanged !== undefined) {
    metadata.backgroundActivityChanged = backgroundActivityChanged;
  }
  if (hasPendingInteraction !== undefined) {
    metadata.hasPendingInteraction = hasPendingInteraction;
  }
  if (projectId !== undefined) {
    metadata.projectId = projectId;
  }
  if (statusChange !== undefined) {
    metadata.statusChange = statusChange;
  }
  return metadata;
}

function createThreadChangeState(): ThreadChangeState {
  return {
    changedThreadKinds: new Map<string, Set<ThreadChangeKind>>(),
    globalChangeKinds: new Set<ThreadChangeKind>(),
    metadataByThreadId: new Map<string, ThreadChangeMetadata>(),
  };
}

function resetThreadChangeState(state: ThreadChangeState): void {
  state.changedThreadKinds.clear();
  state.globalChangeKinds.clear();
  state.metadataByThreadId.clear();
}

function mergeThreadChanges({
  changes,
  state,
  threadId,
}: MergeThreadChangesArg): void {
  let entry = state.changedThreadKinds.get(threadId);
  if (!entry) {
    entry = new Set<ThreadChangeKind>();
    state.changedThreadKinds.set(threadId, entry);
  }
  for (const change of changes) {
    entry.add(change);
  }
}

function flushThreadInvalidations(
  queryClient: QueryClient,
  state: ThreadChangeState,
): void {
  notifyManager.batch(() => {
    const flushOnce = createFlushOncePredicate();
    const batchedStatusPatches = new Map<string, ThreadStatusChangeMetadata>();
    for (const [threadId, changeKinds] of state.changedThreadKinds) {
      if (!changeKinds.has("status-changed")) {
        continue;
      }
      const statusChange = state.metadataByThreadId.get(threadId)?.statusChange;
      if (statusChange) {
        batchedStatusPatches.set(threadId, statusChange);
      }
    }
    if (batchedStatusPatches.size > 0) {
      applyBatchedThreadListStatusPatches(queryClient, batchedStatusPatches);
      executeRealtimeDirtyHandlers({
        context: {
          archived: undefined,
          backgroundActivityChanged: undefined,
          eventTypes: undefined,
          flushOnce,
          hasPendingInteraction: undefined,
          projectId: undefined,
          queryClient,
          statusChange: undefined,
          threadId: undefined,
        },
        handlers: [() => [threadSearchQueryKeyPrefix()]],
      });
    }

    for (const changeKind of state.globalChangeKinds) {
      executeRealtimeDirtyHandlers({
        context: {
          archived: undefined,
          backgroundActivityChanged: undefined,
          eventTypes: undefined,
          flushOnce,
          hasPendingInteraction: undefined,
          projectId: undefined,
          queryClient,
          statusChange: undefined,
          threadId: undefined,
        },
        handlers: REALTIME_THREAD_CHANGE_REGISTRY[changeKind].dirty,
      });
    }

    for (const [threadId, changeKinds] of state.changedThreadKinds) {
      const metadata = state.metadataByThreadId.get(threadId);
      const patchedInBatch = batchedStatusPatches.has(threadId);
      for (const changeKind of changeKinds) {
        const handlers =
          changeKind === "status-changed" && patchedInBatch
            ? REALTIME_THREAD_CHANGE_REGISTRY[changeKind].dirty.filter(
                (handler) =>
                  handler !== REALTIME_THREAD_LIST_STATUS_PATCH_HANDLER,
              )
            : REALTIME_THREAD_CHANGE_REGISTRY[changeKind].dirty;
        executeRealtimeDirtyHandlers({
          context: {
            archived: metadata?.archived,
            backgroundActivityChanged: metadata?.backgroundActivityChanged,
            eventTypes: metadata?.eventTypes,
            flushOnce,
            hasPendingInteraction: metadata?.hasPendingInteraction,
            projectId: metadata?.projectId,
            queryClient,
            statusChange: metadata?.statusChange,
            threadId,
          },
          handlers,
        });
      }
    }
  });

  resetThreadChangeState(state);
}

interface ApplyImmediateThreadChangesArgs {
  changes: readonly ThreadChangeKind[];
  id: string | undefined;
  metadata: ThreadChangeMetadata | undefined;
  queryClient: QueryClient;
}

function applyImmediateThreadChanges({
  changes,
  id,
  metadata,
  queryClient,
}: ApplyImmediateThreadChangesArgs): void {
  const merged = metadata
    ? mergeThreadChangeMetadata({
        archivedChanged: changes.includes("archived-changed"),
        current: undefined,
        next: metadata,
        statusChanged: changes.includes("status-changed"),
      })
    : undefined;
  const flushOnce = createFlushOncePredicate();
  for (const changeKind of changes) {
    executeRealtimeDirtyHandlers({
      context: {
        archived: merged?.archived,
        backgroundActivityChanged: merged?.backgroundActivityChanged,
        eventTypes: merged?.eventTypes,
        flushOnce,
        hasPendingInteraction: merged?.hasPendingInteraction,
        projectId: merged?.projectId,
        queryClient,
        statusChange: merged?.statusChange,
        threadId: id,
      },
      handlers: REALTIME_THREAD_CHANGE_REGISTRY[changeKind].dirty,
    });
  }
}

function recordThreadChange(
  state: ThreadChangeState,
  message: ChangedMessage,
): void {
  if (message.entity !== "thread") {
    return;
  }

  if (message.id) {
    mergeThreadChanges({
      changes: message.changes,
      state,
      threadId: message.id,
    });
    const archivedChanged = message.changes.includes("archived-changed");
    const statusChanged = message.changes.includes("status-changed");
    if (message.metadata || archivedChanged || statusChanged) {
      state.metadataByThreadId.set(
        message.id,
        mergeThreadChangeMetadata({
          archivedChanged,
          current: state.metadataByThreadId.get(message.id),
          next: message.metadata ?? {},
          statusChanged,
        }),
      );
    }
    return;
  }

  for (const change of message.changes) {
    state.globalChangeKinds.add(change);
  }
}

function invalidateRealtimeEnvironmentChange({
  changeKinds,
  environmentId,
  queryClient,
}: RealtimeEnvironmentChangedArg): void {
  for (const changeKind of changeKinds) {
    executeRealtimeDirtyHandlers({
      context: {
        environmentId,
        getCachedThreadIdsForEnvironment: () =>
          collectCachedThreadIdsForEnvironment({ environmentId, queryClient }),
        queryClient,
      },
      handlers: REALTIME_ENVIRONMENT_CHANGE_REGISTRY[changeKind].dirty,
    });
  }
}

function createDeferredNonThreadChanges(): DeferredNonThreadChanges {
  return {
    environmentKindsById: new Map(),
    hostKinds: new Set(),
    projectKindsById: new Map(),
    systemKinds: new Set(),
  };
}

function addAll<T>(target: Set<T>, values: readonly T[]): void {
  for (const value of values) {
    target.add(value);
  }
}

function mergeInto<K, V>(
  target: Map<K, Set<V>>,
  key: K,
  values: readonly V[],
): void {
  let entry = target.get(key);
  if (!entry) {
    entry = new Set<V>();
    target.set(key, entry);
  }
  addAll(entry, values);
}

function hasDeferredNonThreadChanges(
  deferred: DeferredNonThreadChanges,
): boolean {
  return (
    deferred.environmentKindsById.size > 0 ||
    deferred.hostKinds.size > 0 ||
    deferred.projectKindsById.size > 0 ||
    deferred.systemKinds.size > 0
  );
}

const DEFAULT_VISIBILITY: RealtimeCacheEffectsVisibility = {
  isDocumentVisible,
  subscribe: subscribeToDocumentVisibility,
};

export function createRealtimeCacheEffects({
  queryClient,
  visibility = DEFAULT_VISIBILITY,
}: RealtimeCacheEffectsOptions): RealtimeCacheEffects {
  const threadChangeState = createThreadChangeState();
  const statusBurstState = createThreadChangeState();
  let statusBurstUntil = 0;
  let statusBurstTimer: ReturnType<typeof setTimeout> | null = null;
  let hasDeferredThreadChanges = false;
  const deferredNonThreadChanges = createDeferredNonThreadChanges();
  const clearStatusBurstTimer = (): void => {
    if (statusBurstTimer !== null) {
      clearTimeout(statusBurstTimer);
      statusBurstTimer = null;
    }
  };
  const flushStatusBurst = (): void => {
    clearStatusBurstTimer();
    if (
      statusBurstState.changedThreadKinds.size === 0 &&
      statusBurstState.globalChangeKinds.size === 0
    ) {
      return;
    }
    if (!visibility.isDocumentVisible()) {
      for (const [threadId, changeKinds] of statusBurstState.changedThreadKinds) {
        mergeThreadChanges({
          changes: Array.from(changeKinds),
          state: threadChangeState,
          threadId,
        });
        const metadata = statusBurstState.metadataByThreadId.get(threadId);
        if (metadata) {
          threadChangeState.metadataByThreadId.set(
            threadId,
            mergeThreadChangeMetadata({
              archivedChanged: false,
              current: threadChangeState.metadataByThreadId.get(threadId),
              next: metadata,
              statusChanged: true,
            }),
          );
        }
      }
      resetThreadChangeState(statusBurstState);
      hasDeferredThreadChanges = true;
      return;
    }
    flushThreadInvalidations(queryClient, statusBurstState);
    statusBurstUntil = Date.now() + STATUS_CHANGE_BURST_WINDOW_MS;
  };
  const invalidationScheduler = createDebouncedCallbackScheduler({
    debounceMs: INVALIDATION_DEBOUNCE_MS,
    maxWaitMs: INVALIDATION_MAX_WAIT_MS,
    onFlush: () => {
      if (!visibility.isDocumentVisible()) {
        hasDeferredThreadChanges = true;
        return;
      }
      hasDeferredThreadChanges = false;
      flushThreadInvalidations(queryClient, threadChangeState);
    },
  });
  const environmentInvalidator = createBufferedEnvironmentInvalidator({
    debounceMs: ENVIRONMENT_INVALIDATION_DEBOUNCE_MS,
    flushChangedEnvironmentIds: (changedEnvironments) => {
      if (!visibility.isDocumentVisible()) {
        for (const { changeKinds, environmentId } of changedEnvironments) {
          mergeInto(
            deferredNonThreadChanges.environmentKindsById,
            environmentId,
            changeKinds,
          );
        }
        return;
      }
      for (const { changeKinds, environmentId } of changedEnvironments) {
        invalidateRealtimeEnvironmentChange({
          changeKinds,
          environmentId,
          queryClient,
        });
      }
    },
    maxWaitMs: ENVIRONMENT_INVALIDATION_MAX_WAIT_MS,
  });

  const applyHostChanges = (
    hostId: string | undefined,
    changeKinds: Iterable<HostChangeKind>,
  ): void => {
    for (const changeKind of changeKinds) {
      executeRealtimeDirtyHandlers({
        context: { hostId, queryClient },
        handlers: REALTIME_HOST_CHANGE_REGISTRY[changeKind].dirty,
      });
    }
  };
  const applyProjectChanges = (
    projectId: string | undefined,
    changeKinds: Iterable<ProjectChangeKind>,
  ): void => {
    for (const changeKind of changeKinds) {
      executeRealtimeDirtyHandlers({
        context: { projectId, queryClient },
        handlers: REALTIME_PROJECT_CHANGE_REGISTRY[changeKind].dirty,
      });
    }
  };
  const applySystemChanges = (
    changeKinds: Iterable<SystemChangeKind>,
  ): void => {
    for (const changeKind of changeKinds) {
      const rule = REALTIME_SYSTEM_CHANGE_REGISTRY[changeKind];
      if (!rule) {
        continue;
      }
      executeRealtimeDirtyHandlers({
        context: { queryClient },
        handlers: rule.dirty,
      });
    }
  };

  const flushDeferredChanges = (): void => {
    flushStatusBurst();
    if (hasDeferredNonThreadChanges(deferredNonThreadChanges)) {
      const { environmentKindsById, hostKinds, projectKindsById, systemKinds } =
        deferredNonThreadChanges;
      for (const [environmentId, changeKinds] of environmentKindsById) {
        environmentInvalidator.markChanged(
          environmentId,
          Array.from(changeKinds),
        );
      }
      applyHostChanges(undefined, hostKinds);
      for (const [projectId, changeKinds] of projectKindsById) {
        applyProjectChanges(projectId, changeKinds);
      }
      applySystemChanges(systemKinds);
      environmentKindsById.clear();
      hostKinds.clear();
      projectKindsById.clear();
      systemKinds.clear();
    }
    if (hasDeferredThreadChanges) {
      invalidationScheduler.flush();
    }
  };

  const unsubscribeVisibility = visibility.subscribe(() => {
    if (visibility.isDocumentVisible()) {
      flushDeferredChanges();
    }
  });

  return {
    dispose: () => {
      unsubscribeVisibility();
      clearStatusBurstTimer();
      resetThreadChangeState(statusBurstState);
      invalidationScheduler.dispose();
      environmentInvalidator.dispose();
      disposeTrailingActiveRefetches(queryClient);
      resetThreadChangeState(threadChangeState);
    },
    handleChanged: (message) => {
      const documentVisible = visibility.isDocumentVisible();
      switch (message.entity) {
        case "thread": {
          if (!documentVisible) {
            recordThreadChange(threadChangeState, message);
            hasDeferredThreadChanges = true;
            break;
          }
          if (message.metadata?.eventTypes?.includes("turn/completed")) {
            flushStatusBurst();
            recordThreadChange(threadChangeState, message);
            invalidationScheduler.flush();
            break;
          }
          const { debounced, immediate } =
            partitionThreadChangesByFlushPriority(message.changes);
          if (debounced) {
            recordThreadChange(threadChangeState, {
              ...message,
              changes: debounced,
            });
            invalidationScheduler.schedule();
          }
          if (immediate) {
            const isPatchedStatusOnly =
              immediate.length === 1 &&
              immediate[0] === "status-changed" &&
              Boolean(message.id) &&
              Boolean(message.metadata?.statusChange);
            const now = Date.now();
            if (isPatchedStatusOnly && now < statusBurstUntil) {
              recordThreadChange(statusBurstState, {
                ...message,
                changes: immediate,
              });
              if (statusBurstTimer === null) {
                statusBurstTimer = setTimeout(
                  flushStatusBurst,
                  STATUS_CHANGE_BURST_WINDOW_MS,
                );
              }
            } else {
              flushStatusBurst();
              applyImmediateThreadChanges({
                changes: immediate,
                id: message.id,
                metadata: message.id ? message.metadata : undefined,
                queryClient,
              });
              if (isPatchedStatusOnly) {
                statusBurstUntil = now + STATUS_CHANGE_BURST_WINDOW_MS;
              }
            }
          }
          break;
        }
        case "environment":
          if (!message.id) {
            break;
          }
          if (!documentVisible) {
            mergeInto(
              deferredNonThreadChanges.environmentKindsById,
              message.id,
              message.changes,
            );
            break;
          }
          environmentInvalidator.markChanged(message.id, message.changes);
          break;
        case "host":
          if (!documentVisible) {
            addAll(deferredNonThreadChanges.hostKinds, message.changes);
            break;
          }
          applyHostChanges(message.id, message.changes);
          break;
        case "project":
          if (!documentVisible) {
            mergeInto(
              deferredNonThreadChanges.projectKindsById,
              message.id,
              message.changes,
            );
            break;
          }
          applyProjectChanges(message.id, message.changes);
          break;
        case "system":
          if (!documentVisible) {
            addAll(deferredNonThreadChanges.systemKinds, message.changes);
            break;
          }
          applySystemChanges(message.changes);
          break;
        default:
          assertNever(message);
      }
    },
    handleConnected: (event) => {
      applySystemChanges(["plugins-changed"]);
      if (event.reconnected) {
        invalidateRealtimeQueriesAfterServerReconnect({
          disconnectedAt: event.disconnectedAt,
          queryClient,
        });
        return;
      }
      refetchErroredRealtimeQueriesOnInitialConnect({ queryClient });
      invalidateRealtimeQueriesFetchedBeforeInitialConnect({
        connectedAt: Date.now(),
        queryClient,
      });
    },
  };
}
