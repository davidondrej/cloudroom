import {
  cancelProviderEnvironmentCreation,
  sweepProviderEnvironment,
} from "../environments/environment-engine.js";
import {
  removeCreatingMachine,
  sweepProviderMachine,
} from "../machines/provider-orchestration.js";
import {
  isThreadQueueAutoSendPaused,
  listLiveThreadsInEnvironment,
  listNonDeletedChildThreads,
  listQueuedThreadMessages,
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
import { revokeThreadDesktopBrowserControl } from "../desktop-browsers.js";
import { emitPluginThreadArchived } from "../plugins/plugin-thread-events.js";
import {
  dispatchSettledArchivedThreadProviderArchiveCommand,
  releaseFailedThreadRuntimeThenArchive,
  requestActiveRuntimeThreadStopIfNeeded,
} from "./thread-lifecycle.js";
import { archiveThreadAndReleaseChildren } from "./thread-ownership.js";
import { requireThreadHostCommandEnvironment } from "./thread-command-environment.js";
import { scheduleArchivedThreadProcessStop } from "./thread-commands.js";
import { getThreadProvisionContext } from "./thread-startup-store.js";
import { isPreStartThreadStatus } from "./thread-status.js";
import { cloudroom, isCloudThread } from "../cloudroom/commands.js";
import { teleports } from "../cloudroom/teleport.js";
import { binding, commands, queuedPrompts } from "../cloudroom/store.js";

type ThreadRow = ReturnType<typeof listNonDeletedChildThreads>[number];

interface ArchiveThreadEnvironment {
  hostId: string;
  id: string;
}

interface ArchiveThreadWithLifecycleEffectsArgs {
  environment: ArchiveThreadEnvironment | null;
  thread: Pick<Thread, "environmentId" | "id" | "status" | "executionTarget">;
  /** The website already has it archived (#237): only this computer's copy changes. */
  fromWebsite?: boolean;
}

interface ResolveArchiveThreadEnvironmentArgs {
  thread: ArchiveThreadWithLifecycleEffectsArgs["thread"];
}

interface ArchiveEnvironmentThreadsArgs {
  environment: EnvironmentRow;
}

interface ArchiveThreadAndChildrenArgs {
  parentThread: Thread;
  includeLive?: boolean;
  liveThreadIds?: readonly string[];
  /** The website already has the parent archived (an agent's own archive, #237): only its children go out. */
  websiteHasRoot?: boolean;
}

interface ArchiveThreadAndChildrenResult {
  archivedThreadIds: string[];
  keptLiveThreadIds: string[];
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
  // Archived threads give up browser control; the release closes pages the lease opened (#1383).
  void revokeThreadDesktopBrowserControl(deps, archivedThread.id, true);

  deps.terminalSessions.closeArchivedThreadTerminals({
    threadId: archivedThread.id,
  });
  if (isCloudThread(archivedThread)) {
    if (args.fromWebsite) cloudroom(deps).detach(archivedThread.id);
    else cloudroom(deps).archive(archivedThread.id);
    // The stream stops here, so a turn still running never reaches the prune at its end.
    pruneThreadEventHistoryBestEffort(deps, {
      mode: "archived",
      threadId: archivedThread.id,
    });
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
  if (args.environment !== null && archivedThread.archivedAt !== null) {
    scheduleArchivedThreadProcessStop(deps, {
      threadId: archivedThread.id,
      archivedAt: archivedThread.archivedAt,
      environment: args.environment,
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

/** A Cloud thread another computer or Core archived: this thread only, no cascade, and nothing goes back (#237). */
export function archiveFromWebsite(deps: AppDeps, thread: Thread): void {
  archiveThreadWithLifecycleEffects(deps, { environment: null, thread, fromWebsite: true });
}

export function archiveThreadAndChildren(
  deps: AppDeps,
  args: ArchiveThreadAndChildrenArgs,
): ArchiveThreadAndChildrenResult {
  const kept = args.includeLive
    ? new Set<string>()
    : listKeptLiveThreads(deps, args.parentThread, new Set(args.liveThreadIds));
  const archivedThreadIds: string[] = [];

  for (const thread of listThreadWithDescendants(deps, args.parentThread)) {
    // A kept thread keeps its side chats too.
    if (thread.archivedAt !== null || kept.has(thread.id) || kept.has(thread.sourceThreadId ?? "")) continue;
    const environment = resolveArchiveThreadEnvironment(deps, { thread });
    const result = archiveThreadWithLifecycleEffects(deps, {
      environment,
      thread,
      fromWebsite: args.websiteHasRoot === true && thread.id === args.parentThread.id,
    });
    if (!result) {
      continue;
    }
    archivedThreadIds.push(result.id);
  }

  return { archivedThreadIds, keptLiveThreadIds: [...kept] };
}

function listKeptLiveThreads(
  deps: Pick<AppDeps, "db">,
  root: Pick<Thread, "id">,
  liveThreadIds: ReadonlySet<string>,
): Set<string> {
  const kept = new Set<string>();
  const visited = new Set<string>();
  const walk = (thread: Pick<Thread, "id" | "status" | "archivedAt">, underLive: boolean): boolean => {
    if (visited.has(thread.id)) return false;
    visited.add(thread.id);
    const live =
      thread.archivedAt === null &&
      (liveThreadIds.has(thread.id) || isLiveThread(deps, thread));
    let liveBelow = false;
    for (const child of listNonDeletedChildThreads(deps.db, { parentThreadId: thread.id })) {
      if (walk(child, underLive || live)) liveBelow = true;
    }
    if (
      thread.id !== root.id &&
      thread.archivedAt === null &&
      (underLive || live || liveBelow)
    )
      kept.add(thread.id);
    return live || liveBelow;
  };
  for (const child of listNonDeletedChildThreads(deps.db, { parentThreadId: root.id })) walk(child, false);
  return kept;
}

function isLiveThread(
  deps: Pick<AppDeps, "db">,
  thread: Pick<Thread, "id" | "status">,
): boolean {
  return (
    thread.status === "pending" ||
    thread.status === "starting" ||
    thread.status === "active" ||
    thread.status === "stopping" ||
    (!isThreadQueueAutoSendPaused(deps.db, thread.id) &&
      listQueuedThreadMessages(deps.db, thread.id).some((message) => message.failureReason === null)) ||
    (!binding(deps.db, thread.id)?.queuePaused &&
      queuedPrompts(deps.db, thread.id).length > 0) ||
    commands(deps.db, thread.id).some((command) => command.state === "sending")
  );
}
