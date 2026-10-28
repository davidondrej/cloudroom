import {
  cancelProviderEnvironmentCreation,
  sweepProviderEnvironment,
} from "../environments/environment-engine.js";
import {
  removeCreatingMachine,
  sweepProviderMachine,
} from "../machines/provider-orchestration.js";
import {
  listLiveThreadsInEnvironment,
  listNonDeletedChildThreads,
  listUnarchivedHiddenSourceThreads,
} from "@cloudroom/db";
import type { EnvironmentRow } from "@cloudroom/db";
import type { Thread } from "@cloudroom/domain";
import type { AppDeps } from "../../types.js";
import {
  threadEnvironmentUnavailableDetails,
  throwThreadEnvironmentUnavailable,
} from "../lib/lifecycle-api-errors.js";
import {
  pruneThreadEventHistoryBestEffort,
  resetActiveThreadEventPruningState,
} from "../system/event-pruning.js";
import { emitPluginThreadArchived } from "../plugins/plugin-thread-events.js";
import {
  dispatchSettledArchivedThreadProviderArchiveCommand,
  releaseFailedThreadRuntimeThenArchive,
  requestActiveRuntimeThreadStopIfNeeded,
} from "./thread-lifecycle.js";
import { archiveThreadAndReleaseChildren } from "./thread-ownership.js";
import { requireThreadHostCommandEnvironment } from "./thread-command-environment.js";
import { getThreadProvisionContext } from "./thread-startup-store.js";
import { isPreStartThreadStatus } from "./thread-status.js";
import { cloudroom, isCloudThread } from "../cloudroom/commands.js";
import { teleports } from "../cloudroom/teleport.js";

type ThreadRow = ReturnType<typeof listNonDeletedChildThreads>[number];

interface ArchiveThreadEnvironment {
  hostId: string;
  id: string;
}

interface ArchiveThreadWithLifecycleEffectsArgs {
  environment: ArchiveThreadEnvironment | null;
  thread: Pick<Thread, "environmentId" | "id" | "status" | "executionTarget">;
}

interface ResolveArchiveThreadEnvironmentArgs {
  thread: ArchiveThreadWithLifecycleEffectsArgs["thread"];
}

interface ArchiveEnvironmentThreadsArgs {
  environment: EnvironmentRow;
}

interface ArchiveThreadAndChildrenArgs {
  parentThread: Thread;
}

export function resolveArchiveThreadEnvironment(
  deps: Pick<AppDeps, "db">,
  args: ResolveArchiveThreadEnvironmentArgs,
): ArchiveThreadEnvironment | null {
  if (isCloudThread(args.thread)) return null;
  if (args.thread.environmentId !== null) {
    return requireThreadHostCommandEnvironment({
      db: deps.db,
      thread: args.thread,
    });
  }
  if (
    isPreStartThreadStatus(args.thread.status) ||
    args.thread.status === "stopping" ||
    getThreadProvisionContext(deps.db, args.thread.id) !== null
  ) {
    throwThreadEnvironmentUnavailable(
      threadEnvironmentUnavailableDetails("never_attached", null),
    );
  }
  return null;
}

function archiveThreadWithLifecycleEffects(
  deps: AppDeps,
  args: ArchiveThreadWithLifecycleEffectsArgs,
): Thread | null {
  const archivedThread = archiveThreadAndReleaseChildren(deps, {
    threadId: args.thread.id,
  });
  if (!archivedThread) {
    return null;
  }
  teleports(deps).abandon(archivedThread.id);

  deps.terminalSessions.closeArchivedThreadTerminals({
    threadId: archivedThread.id,
  });
  if (isCloudThread(archivedThread)) {
    cloudroom(deps).archive(archivedThread.id);
    emitPluginThreadArchived(archivedThread);
    return archivedThread;
  }
  if (args.environment !== null && archivedThread.status === "error") {
    releaseFailedThreadRuntimeThenArchive(
      deps,
      archivedThread.id,
      args.environment,
    );
  } else {
    if (args.environment !== null) {
      requestActiveRuntimeThreadStopIfNeeded(
        deps,
        archivedThread,
        args.environment,
      );
    }
    dispatchSettledArchivedThreadProviderArchiveCommand(deps, {
      threadId: archivedThread.id,
    });
  }
  resetActiveThreadEventPruningState(archivedThread.id);
  pruneThreadEventHistoryBestEffort(deps, {
    mode: "archived",
    threadId: archivedThread.id,
  });
  void cancelProviderEnvironmentCreation(deps, archivedThread.id).catch(
    (error) =>
      deps.logger.warn({ error }, "Environment launch cancellation failed"),
  );
  void removeCreatingMachine(deps, archivedThread.id).catch((error) =>
    deps.logger.warn({ error }, "Machine launch cancellation failed"),
  );
  if (archivedThread.environmentId !== null)
    void sweepProviderEnvironment(deps, archivedThread.environmentId).catch(
      (error) => deps.logger.warn({ error }, "Environment retirement failed"),
    );
  if (args.environment !== null) {
    void sweepProviderMachine(deps, args.environment.hostId).catch((error) =>
      deps.logger.warn({ error }, "Machine retirement failed"),
    );
  }
  emitPluginThreadArchived(archivedThread);

  return archivedThread;
}

export function archiveEnvironmentThreads(
  deps: AppDeps,
  args: ArchiveEnvironmentThreadsArgs,
): string[] {
  const threads = listLiveThreadsInEnvironment(deps.db, {
    environmentId: args.environment.id,
  });
  const archivedThreadIds: string[] = [];

  for (const thread of threads) {
    const result = archiveThreadWithLifecycleEffects(deps, {
      environment: args.environment,
      thread,
    });
    if (!result) {
      continue;
    }
    archivedThreadIds.push(result.id);
  }

  return archivedThreadIds;
}

/** Lists a thread plus its child threads and hidden forks, children first. */
export function listThreadWithDescendants<T extends Pick<Thread, "id">>(
  deps: Pick<AppDeps, "db">,
  root: T,
): (T | ThreadRow)[] {
  const pending: { thread: T | ThreadRow; expanded: boolean }[] = [
    { thread: root, expanded: false },
  ];
  const visited = new Set<string>();
  const threads: (T | ThreadRow)[] = [];

  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry) {
      break;
    }
    const { thread, expanded } = entry;
    if (expanded) {
      threads.push(thread);
      continue;
    }
    if (visited.has(thread.id)) {
      continue;
    }
    visited.add(thread.id);
    pending.push({ thread, expanded: true });
    const descendants = [
      ...listNonDeletedChildThreads(deps.db, {
        parentThreadId: thread.id,
      }),
      ...listUnarchivedHiddenSourceThreads(deps.db, {
        sourceThreadId: thread.id,
      }),
    ];
    for (const descendant of descendants.reverse()) {
      pending.push({ thread: descendant, expanded: false });
    }
  }
  return threads;
}

export function archiveThreadAndChildren(
  deps: AppDeps,
  args: ArchiveThreadAndChildrenArgs,
): string[] {
  const threads = listThreadWithDescendants(deps, args.parentThread).filter(
    (thread) => thread.archivedAt === null,
  );
  const archivedThreadIds: string[] = [];

  for (const thread of threads) {
    const environment = resolveArchiveThreadEnvironment(deps, { thread });
    const result = archiveThreadWithLifecycleEffects(deps, {
      environment,
      thread,
    });
    if (!result) {
      continue;
    }
    archivedThreadIds.push(result.id);
  }

  return archivedThreadIds;
}
