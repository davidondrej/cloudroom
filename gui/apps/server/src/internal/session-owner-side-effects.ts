import os from "node:os";
import { and, eq, isNull } from "drizzle-orm";
import {
  closeSession,
  environments,
  hostDaemonSessions,
  listActiveHostThreads,
  listHostThreadIds,
  threads,
  type HostDaemonSessionRow,
} from "@cloudroom/db";
import type { HostDaemonActiveThread } from "@cloudroom/host-daemon-contract";
import {
  DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS,
  DAEMON_DISCONNECT_GRACE_MS,
  DAEMON_SETUP_DISCONNECT_GRACE_MS,
} from "../constants.js";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../types.js";
import {
  interruptActiveThreadsForHost,
  reconcileDaemonReportedThreads,
} from "../services/threads/thread-lifecycle.js";
import { buildThreadStatusChangeMetadataByThreadId } from "../services/threads/thread-runtime-display.js";
import {
  settleDanglingBackgroundTasks,
  type LostBackgroundTasks,
} from "../services/threads/background-task-reconciliation.js";
import { queueChildThreadLostBackgroundWorkNotifications } from "../services/threads/child-thread-notifications.js";
import { interruptEnvironmentProvisioningForHost } from "../services/environments/environment-engine.js";

const DAEMON_RESTARTED_PENDING_INTERACTION_REASON =
  "Host daemon restarted while awaiting user interaction; retry the thread to continue";
const DAEMON_DISCONNECTED_PENDING_INTERACTION_REASON =
  "Host daemon disconnected while awaiting user interaction; retry the thread to continue";
const DAEMON_RESTARTED_ENVIRONMENT_PROVISIONING_REASON =
  "Host daemon restarted while preparing the workspace. Retry provisioning to continue.";
const DAEMON_DISCONNECTED_ENVIRONMENT_PROVISIONING_REASON =
  "The connection to the host was lost while preparing the workspace. Retry provisioning to continue.";

type HostSessionOpenedDeps = LoggedPendingInteractionWorkSessionDeps;
type DaemonSocketClosedDeps = LoggedPendingInteractionWorkSessionDeps &
  Pick<AppDeps, "sharedPorts">;
type DaemonDisconnectGraceDeps = LoggedPendingInteractionWorkSessionDeps;

/**
 * Background tasks settled while a host's daemon was away. A temporary
 * disconnect keeps them running, so only a new daemon proves them lost.
 * Kept in memory: a server restart forgets them (#1026).
 */
const lostBackgroundTasksByHostId = new Map<string, LostBackgroundTasks>();

function rememberLostBackgroundTasks(
  hostId: string,
  lost: LostBackgroundTasks,
  interrupted?: { threads: { threadId: string }[] },
): LostBackgroundTasks {
  const kept = lostBackgroundTasksByHostId.get(hostId) ?? new Map();
  for (const [threadId, tasks] of lost) {
    kept.set(threadId, [...(kept.get(threadId) ?? []), ...tasks]);
  }
  // An interrupted turn resumes by itself, and Claude tells it what ended.
  for (const { threadId } of interrupted?.threads ?? []) kept.delete(threadId);
  lostBackgroundTasksByHostId.set(hostId, kept);
  return kept;
}

/** A job settled while its daemon was away finished after all. */
export function forgetLostBackgroundTask(threadId: string, itemId: string) {
  for (const lost of lostBackgroundTasksByHostId.values()) {
    const tasks = lost.get(threadId);
    if (!tasks) continue;
    lost.set(
      threadId,
      tasks.filter((task) => task.itemId !== itemId),
    );
  }
}

interface HandleHostSessionOpenedArgs {
  activeThreads: HostDaemonActiveThread[];
  hostId: string;
  openedSession: HostDaemonSessionRow;
  previousSession: HostDaemonSessionRow | null;
}

interface HandleDaemonSocketClosedArgs {
  sessionId: string;
}

interface HandleHostRemovedArgs {
  hostId: string;
  sessionId: string;
}

interface CompleteDaemonDisconnectGraceArgs {
  hostId: string;
}

interface CompleteDaemonActiveWorkDisconnectGraceArgs {
  hostId: string;
}

export async function handleHostSessionOpened(
  deps: HostSessionOpenedDeps,
  args: HandleHostSessionOpenedArgs,
): Promise<void> {
  deps.logger.info(
    {
      sessionId: args.openedSession.id,
      hostId: args.hostId,
      replacedSessionId: args.previousSession?.id ?? null,
    },
    "Session opened",
  );

  const sameDaemonInstance =
    args.previousSession?.instanceId === args.openedSession.instanceId;
  let lost: LostBackgroundTasks | undefined;
  if (
    args.previousSession &&
    args.previousSession.id !== args.openedSession.id
  ) {
    deps.hub.cancelPendingDaemonDisconnect(args.previousSession.id);

    if (args.previousSession.status === "active") {
      if (sameDaemonInstance) {
        deps.hub.closeDaemonSessionSocket(args.previousSession.id, "replaced");
      } else {
        deps.hub.closeDaemonSession(args.previousSession.id, "replaced");
      }
      deps.terminalSessions.handleDaemonSessionClosed({
        sessionId: args.previousSession.id,
      });
    }

    if (!sameDaemonInstance) {
      interruptEnvironmentProvisioningForHost(deps, {
        hostId: args.hostId,
        reason: DAEMON_RESTARTED_ENVIRONMENT_PROVISIONING_REASON,
      });
      interruptPendingInteractionsForHostThreads(deps, {
        hostId: args.hostId,
        reason: DAEMON_RESTARTED_PENDING_INTERACTION_REASON,
      });
      const interrupted = interruptActiveThreadsForHost(deps, {
        hostId: args.hostId,
        reason: "host-daemon-restarted",
      });
      lost = rememberLostBackgroundTasks(
        args.hostId,
        settleDanglingBackgroundTasks(deps, { hostId: args.hostId }),
        interrupted,
      );
      lostBackgroundTasksByHostId.delete(args.hostId);
      // Work from before a reboot wakes nothing (ADR 20261103-233411).
      if (args.previousSession.updatedAt < Date.now() - os.uptime() * 1_000) {
        lost = undefined;
      }
    }
  }

  if (!deps.hub.hasDaemonForHost(args.hostId)) {
    startHostDisconnectDeadlines(deps, args.hostId);
  }

  await reconcileDaemonReportedThreads(deps, {
    activeThreadIds: args.activeThreads.map((thread) => thread.threadId),
    hostId: args.hostId,
    sameDaemonInstance,
  });
  if (lost) {
    void queueChildThreadLostBackgroundWorkNotifications(deps, lost).catch(
      () => undefined,
    );
  }
}

export function handleDaemonSocketClosed(
  deps: DaemonSocketClosedDeps,
  args: HandleDaemonSocketClosedArgs,
): void {
  deps.logger.info({ sessionId: args.sessionId }, "Daemon WebSocket closed");
  deps.hub.unregisterDaemon(args.sessionId);
  deps.sharedPorts.clearHostConnectCapability(args.sessionId);

  const session = deps.db
    .select()
    .from(hostDaemonSessions)
    .where(eq(hostDaemonSessions.id, args.sessionId))
    .get();
  if (!session || session.status !== "active") {
    return;
  }
  deps.terminalSessions.handleDaemonSessionClosed({
    sessionId: args.sessionId,
  });

  closeSession(deps.db, deps.hub, args.sessionId, "daemon-disconnect");

  notifyHostThreadRuntimeStatusChanged(deps, session.hostId);
  deps.hub.scheduleDaemonDisconnect(
    args.sessionId,
    DAEMON_DISCONNECT_GRACE_MS,
    () =>
      completeDaemonDisconnectGrace(deps, {
        hostId: session.hostId,
      }),
  );
  startHostDisconnectDeadlines(deps, session.hostId);
}

type HostDisconnectDeadlineDeps = LoggedPendingInteractionWorkSessionDeps;

// Starts (or keeps) the host's setup and running-turn deadlines. Only a
// registered daemon socket cancels them, so they run from whichever comes
// first: the socket's close or a session open that replaced it (#1956).
function startHostDisconnectDeadlines(
  deps: HostDisconnectDeadlineDeps,
  hostId: string,
): void {
  deps.hub.scheduleHostDisconnectDeadline(
    hostId,
    "setup",
    DAEMON_SETUP_DISCONNECT_GRACE_MS,
    () => {
      if (deps.hub.hasDaemonForHost(hostId)) return;
      interruptEnvironmentProvisioningForHost(deps, {
        hostId,
        reason: DAEMON_DISCONNECTED_ENVIRONMENT_PROVISIONING_REASON,
      });
    },
  );
  startRunningTurnDeadline(deps, hostId);
}

function startRunningTurnDeadline(
  deps: HostDisconnectDeadlineDeps,
  hostId: string,
): void {
  deps.hub.scheduleHostDisconnectDeadline(
    hostId,
    "work",
    DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS,
    () => completeDaemonActiveWorkDisconnectGrace(deps, { hostId }),
  );
}

/**
 * A restart forgets running deadlines. Each host with running turns and no
 * socket gets the full grace again from startup. Not from the stored close
 * time: shutdown closes every socket too, so that time can be the shutdown.
 */
export function startRunningTurnDeadlinesAfterRestart(
  deps: HostDisconnectDeadlineDeps,
): void {
  const hosts = deps.db
    .selectDistinct({ hostId: environments.hostId })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(and(eq(threads.status, "active"), isNull(threads.deletedAt)))
    .all();
  for (const { hostId } of hosts) {
    if (hostId !== null && !deps.hub.hasDaemonForHost(hostId)) {
      startRunningTurnDeadline(deps, hostId);
    }
  }
}

export function handleHostRemoved(
  deps: Omit<DaemonSocketClosedDeps, "sharedPorts">,
  args: HandleHostRemovedArgs,
): void {
  const session = deps.db
    .select()
    .from(hostDaemonSessions)
    .where(eq(hostDaemonSessions.id, args.sessionId))
    .get();
  if (
    !session ||
    session.status !== "active" ||
    session.hostId !== args.hostId
  ) {
    return;
  }

  closeSession(deps.db, deps.hub, args.sessionId, "expired");
  deps.hub.closeDaemonSession(args.sessionId, "expired");
  deps.terminalSessions.handleDaemonSessionClosed({
    sessionId: args.sessionId,
  });
  interruptPendingInteractionsForHostThreads(deps, {
    hostId: args.hostId,
    reason: DAEMON_DISCONNECTED_PENDING_INTERACTION_REASON,
  });
  interruptEnvironmentProvisioningForHost(deps, {
    hostId: args.hostId,
    reason: DAEMON_RESTARTED_ENVIRONMENT_PROVISIONING_REASON,
  });
  interruptActiveThreadsForHost(deps, {
    hostId: args.hostId,
    reason: "host-daemon-restarted",
  });
  settleDanglingBackgroundTasks(deps, { hostId: args.hostId });
  lostBackgroundTasksByHostId.delete(args.hostId);
  notifyHostThreadRuntimeStatusChanged(deps, args.hostId);
}

function completeDaemonDisconnectGrace(
  deps: DaemonDisconnectGraceDeps,
  args: CompleteDaemonDisconnectGraceArgs,
): void {
  if (deps.hub.hasDaemonForHost(args.hostId)) {
    return;
  }

  interruptPendingInteractionsForHostThreads(deps, {
    hostId: args.hostId,
    reason: DAEMON_DISCONNECTED_PENDING_INTERACTION_REASON,
  });
  rememberLostBackgroundTasks(
    args.hostId,
    settleDanglingBackgroundTasks(deps, args),
  );
  notifyHostThreadRuntimeStatusChanged(deps, args.hostId);
}

function completeDaemonActiveWorkDisconnectGrace(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: CompleteDaemonActiveWorkDisconnectGraceArgs,
): void {
  if (deps.hub.hasDaemonForHost(args.hostId)) {
    return;
  }

  const interrupted = interruptActiveThreadsForHost(deps, {
    hostId: args.hostId,
    reason: "host-daemon-restarted",
    cause: "host-connection-lost",
  });
  rememberLostBackgroundTasks(args.hostId, new Map(), interrupted);
}

function notifyHostThreadRuntimeStatusChanged(
  deps: Pick<AppDeps, "db" | "hub" | "providerRegistry">,
  hostId: string,
): void {
  const metadataByThreadId = buildThreadStatusChangeMetadataByThreadId(deps, {
    environmentHostId: hostId,
    threads: listActiveHostThreads(deps.db, { hostId }),
  });
  for (const threadId of listHostThreadIds(deps.db, { hostId })) {
    deps.hub.notifyThread(
      threadId,
      ["status-changed"],
      metadataByThreadId.get(threadId),
    );
  }
}

function interruptPendingInteractionsForHostThreads(
  deps: Pick<AppDeps, "db" | "pendingInteractions">,
  args: { hostId: string; reason: string },
): void {
  deps.pendingInteractions.interruptPendingInteractionsForThreadIds({
    threadIds: listHostThreadIds(deps.db, { hostId: args.hostId }),
    reason: args.reason,
  });
}
