import { hostCommandMayWake } from "./wake-policy.js";
import { isHostCleanupAllowed } from "./cleanup-context.js";
import { assertMachineLifecycleAdmission } from "../machines/lifecycle.js";
import { getHost, getSessionById, getThread } from "@cloudroom/db";
import { stripTextGitUrlCredentials } from "@cloudroom/domain";
import { randomUUID } from "node:crypto";
import {
  type HostDaemonOnlineRpcResponseMessage,
  type HostDaemonOnlineRpcResultForCommand,
  type HostDaemonRetryableOnlineRpcCommand,
  parseHostDaemonRpcResultForCommand,
  type HostDaemonRpcCommand,
  type HostDaemonRpcResultForCommand,
} from "@cloudroom/host-daemon-contract";
import { ApiError } from "../../errors.js";
import type { WorkSessionDeps } from "../../types.js";
import {
  HostOnlineRpcTimeoutError,
  HostOnlineRpcUnavailableError,
} from "../../ws/hub.js";
import { ensureHostSessionReadyForWork } from "./host-lifecycle.js";
import { inactiveHostUnavailableDetails } from "../lib/lifecycle-api-errors.js";
import { DAEMON_SETUP_DISCONNECT_GRACE_MS } from "../../constants.js";

const HOST_DAEMON_REGISTRATION_WAIT_MS = 1_000;
// A Local thread start rides out a daemon or relay blip instead of failing
// with "Host is not connected" (#879).
const THREAD_START_HOST_WAIT_MS = DAEMON_SETUP_DISCONNECT_GRACE_MS;
export const HOST_CONNECTION_INTERRUPTED = "host_connection_interrupted";

interface CallHostOnlineRpcArgs<TCommand extends HostDaemonRpcCommand> {
  command: TCommand;
  hostId: string;
  timeoutMs: number;
}

interface CallHostRetryableOnlineRpcArgs<
  TCommand extends HostDaemonRetryableOnlineRpcCommand,
> {
  command: TCommand;
  hostId: string;
  timeoutMs: number;
}

export function callHostOnlineRpc<TCommand extends HostDaemonRpcCommand>(
  deps: WorkSessionDeps,
  args: CallHostOnlineRpcArgs<TCommand>,
): Promise<HostDaemonRpcResultForCommand<TCommand>>;
export async function callHostOnlineRpc(
  deps: WorkSessionDeps,
  args: CallHostOnlineRpcArgs<HostDaemonRpcCommand>,
): Promise<HostDaemonRpcResultForCommand> {
  assertHostActiveForRead(deps, args);
  return callHostOnlineRpcWithRetry(deps, args, {
    retryOnTransportFailure: false,
    waitForTransportFailure: false,
  });
}

export function callHostOnlineRpcForWork<TCommand extends HostDaemonRpcCommand>(
  deps: WorkSessionDeps,
  args: CallHostOnlineRpcArgs<TCommand>,
): Promise<HostDaemonRpcResultForCommand<TCommand>>;
export async function callHostOnlineRpcForWork(
  deps: WorkSessionDeps,
  args: CallHostOnlineRpcArgs<HostDaemonRpcCommand>,
): Promise<HostDaemonRpcResultForCommand> {
  await prepareHostForWork(deps, args, false);
  return callHostOnlineRpcWithRetry(deps, args, {
    retryOnTransportFailure: false,
    waitForTransportFailure: false,
  });
}

export function callHostRetryableOnlineRpc<
  TCommand extends HostDaemonRetryableOnlineRpcCommand,
>(
  deps: WorkSessionDeps,
  args: CallHostRetryableOnlineRpcArgs<TCommand>,
): Promise<HostDaemonOnlineRpcResultForCommand<TCommand>>;
export async function callHostRetryableOnlineRpc(
  deps: WorkSessionDeps,
  args: CallHostRetryableOnlineRpcArgs<HostDaemonRetryableOnlineRpcCommand>,
): Promise<HostDaemonOnlineRpcResultForCommand> {
  assertHostActiveForRead(deps, args);
  return callHostOnlineRpcWithRetry(deps, args, {
    retryOnTransportFailure: true,
    waitForTransportFailure: false,
  });
}

export function callHostRetryableOnlineRpcForWork<
  TCommand extends HostDaemonRetryableOnlineRpcCommand,
>(
  deps: WorkSessionDeps,
  args: CallHostRetryableOnlineRpcArgs<TCommand>,
): Promise<HostDaemonOnlineRpcResultForCommand<TCommand>>;
export async function callHostRetryableOnlineRpcForWork(
  deps: WorkSessionDeps,
  args: CallHostRetryableOnlineRpcArgs<HostDaemonRetryableOnlineRpcCommand>,
): Promise<HostDaemonOnlineRpcResultForCommand> {
  await prepareHostForWork(deps, args, true);
  return callHostOnlineRpcWithRetry(deps, args, {
    retryOnTransportFailure: true,
    waitForTransportFailure: true,
  });
}

function isCleanupRpc(
  deps: WorkSessionDeps,
  args: CallHostOnlineRpcArgs<HostDaemonRpcCommand>,
): boolean {
  return (
    getHost(deps.db, args.hostId)?.phase === "removing" &&
    isHostCleanupAllowed(deps, args.hostId) &&
    (args.command.type === "plugin.host.call" ||
      (args.command.type === "environment.hook.run" &&
        args.command.kind === "teardown"))
  );
}

function assertHostActiveForRead(
  deps: WorkSessionDeps,
  args: CallHostOnlineRpcArgs<HostDaemonRpcCommand>,
): void {
  if (
    isCleanupRpc(deps, args) ||
    args.command.type === "thread.stop" ||
    args.command.type === "thread.storage.delete" ||
    args.command.type === "environment.hook.cancel" ||
    args.command.type === "plugin.host.cancel" ||
    args.command.type === "plugin.host.dispose"
  ) {
    return;
  }
  const host = getHost(deps.db, args.hostId);
  if (host !== null && host.phase !== "active") {
    const details = inactiveHostUnavailableDetails("disconnected", host);
    throw new ApiError(
      502,
      "host_unavailable",
      details.reason === "suspended"
        ? "Host is suspended"
        : "Host is not connected",
      { details, retryable: false },
    );
  }
}

async function prepareHostForWork(
  deps: WorkSessionDeps,
  args: CallHostOnlineRpcArgs<HostDaemonRpcCommand>,
  retryOnTransportFailure: boolean,
): Promise<void> {
  if (isCleanupRpc(deps, args)) return;
  if (!hostCommandMayWake(args.command)) {
    assertHostActiveForRead(deps, args);
    return;
  }
  const host = getHost(deps.db, args.hostId);
  if (host?.phase === "suspended" || host?.phase === "resuming") {
    deps.logger.info(
      {
        hostId: args.hostId,
        commandType: args.command.type,
        ...("threadId" in args.command
          ? { threadId: args.command.threadId }
          : {}),
      },
      "Host command requested machine wake",
    );
  }
  await ensureHostSessionReadyForWork(deps, { hostId: args.hostId }).catch(
    async (error) => {
      if (!retryOnTransportFailure || !isHostUnavailableApiError(error)) {
        throw error;
      }
      await waitForRetryableHostRpcTransport(deps, args);
    },
  );
  assertMachineLifecycleAdmission(deps, args.hostId);
  if (
    (args.command.type === "thread.start" ||
      args.command.type === "turn.submit") &&
    getHost(deps.db, args.hostId)?.machineOperationId !== null &&
    !["active", "starting"].includes(
      getThread(deps.db, args.command.threadId)?.status ?? "",
    )
  ) {
    throw new ApiError(
      409,
      "machine_dispatch_interrupted",
      "This turn was interrupted while waiting for machine preservation; submit a new continuation turn",
    );
  }
}

async function callHostOnlineRpcWithRetry(
  deps: WorkSessionDeps,
  args: CallHostOnlineRpcArgs<HostDaemonRpcCommand>,
  options: {
    retryOnTransportFailure: false;
    waitForTransportFailure: false;
  },
): Promise<HostDaemonRpcResultForCommand>;
async function callHostOnlineRpcWithRetry(
  deps: WorkSessionDeps,
  args: CallHostRetryableOnlineRpcArgs<HostDaemonRetryableOnlineRpcCommand>,
  options: {
    retryOnTransportFailure: true;
    waitForTransportFailure: boolean;
  },
): Promise<HostDaemonOnlineRpcResultForCommand>;
async function callHostOnlineRpcWithRetry(
  deps: WorkSessionDeps,
  args: CallHostOnlineRpcArgs<HostDaemonRpcCommand>,
  options: {
    retryOnTransportFailure: boolean;
    waitForTransportFailure: boolean;
  },
): Promise<HostDaemonRpcResultForCommand> {
  const timeoutRetryDeadline =
    options.retryOnTransportFailure && args.timeoutMs > 1
      ? Date.now() + args.timeoutMs
      : null;
  const firstAttemptArgs =
    timeoutRetryDeadline === null
      ? args
      : {
          ...args,
          timeoutMs: Math.max(1, Math.floor(args.timeoutMs / 2)),
        };
  // Read before sending: a reconnect can mark the thread active before the
  // dropped request's rejection arrives.
  const startsNewThread =
    args.command.type === "thread.start" &&
    getThread(deps.db, args.command.threadId)?.status === "starting";
  const response = await requestHostOnlineRpcResponse(
    deps,
    firstAttemptArgs,
  ).catch(async (error) => {
    if (!options.retryOnTransportFailure) {
      // The start may have reached the daemon, so never resend it. Wait for
      // the host: once back, its reconnect has already marked the thread
      // active if the start arrived.
      if (error instanceof HostOnlineRpcUnavailableError && startsNewThread) {
        // Already true when a reconnect replaced the dropped socket.
        const waitMs = threadStartHostWaitMs(deps.hub, args.hostId) ?? 0;
        if (await deps.hub.waitForDaemonForHost(args.hostId, waitMs)) {
          throw new ApiError(
            502,
            HOST_CONNECTION_INTERRUPTED,
            "The connection to the host dropped while the thread was starting, so it may still start. Wait a minute, then retry the thread if it hasn't.",
            false,
          );
        }
        throw threadStartHostOfflineError();
      }
      throwOnlineRpcError(error);
    }
    if (error instanceof HostOnlineRpcUnavailableError) {
      if (!options.waitForTransportFailure) throwOnlineRpcError(error);
      await waitForRetryableHostRpcTransport(deps, args);
      return requestHostOnlineRpcResponse(deps, args).catch((retryError) => {
        throwOnlineRpcError(retryError);
      });
    }
    if (!(error instanceof HostOnlineRpcTimeoutError)) {
      throwOnlineRpcError(error);
    }
    const retryTimeoutMs =
      timeoutRetryDeadline === null ? 0 : timeoutRetryDeadline - Date.now();
    if (retryTimeoutMs <= 0) {
      throwOnlineRpcError(error);
    }
    return requestHostOnlineRpcResponse(deps, {
      ...args,
      timeoutMs: retryTimeoutMs,
    }).catch((retryError) => {
      throwOnlineRpcError(retryError);
    });
  });

  if (!response.ok) {
    // Older daemons send clone errors with the remote's token (#2190).
    throw new ApiError(
      502,
      response.errorCode,
      stripTextGitUrlCredentials(response.errorMessage),
      false,
    );
  }

  if (response.commandType !== args.command.type) {
    throw new ApiError(
      500,
      "command_result_type_mismatch",
      `Host RPC ${response.requestId} completed with unexpected type ${response.commandType}`,
    );
  }

  return parseHostDaemonRpcResultForCommand(args.command, response.result);
}

async function waitForRetryableHostRpcTransport(
  deps: WorkSessionDeps,
  args: CallHostOnlineRpcArgs<HostDaemonRpcCommand>,
): Promise<void> {
  if (!deps.hub.hasDaemonForHost(args.hostId)) {
    await deps.hub.waitForDaemonForHost(
      args.hostId,
      HOST_DAEMON_REGISTRATION_WAIT_MS,
    );
  }
  await prepareHostForWork(deps, args, false);
}

/**
 * How much longer a thread start waits for a host whose daemon dropped.
 * Null when it hasn't dropped since this server started, so nothing waits.
 */
export function threadStartHostWaitMs(
  hub: Pick<WorkSessionDeps["hub"], "getDaemonDisconnectedAt">,
  hostId: string,
): number | null {
  const droppedAt = hub.getDaemonDisconnectedAt(hostId);
  return droppedAt === null
    ? null
    : Math.max(0, droppedAt + THREAD_START_HOST_WAIT_MS - Date.now());
}

export function threadStartHostOfflineError(): ApiError {
  return new ApiError(
    502,
    "host_unavailable",
    `Host is offline. It did not reconnect within ${THREAD_START_HOST_WAIT_MS / 1000} seconds. Retry the thread once it is back online.`,
    false,
  );
}

export function isHostUnavailableApiError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 502 &&
    error.body.code === "host_unavailable"
  );
}

// Commands to a host leave in the order they were made, also after a wait,
// so a cancel never overtakes the command it cancels (#2171).
const hostSendQueues = new WeakMap<object, Map<string, Promise<void>>>();

function requestHostOnlineRpcResponse(
  deps: Pick<WorkSessionDeps, "db" | "hub">,
  args: CallHostOnlineRpcArgs<HostDaemonRpcCommand>,
): Promise<HostDaemonOnlineRpcResponseMessage> {
  const send = () =>
    deps.hub.requestHostOnlineRpc({
      hostId: args.hostId,
      message: {
        type: "host-rpc.request",
        requestId: randomUUID(),
        command: args.command,
      },
      timeoutMs: args.timeoutMs,
    });
  const queue =
    hostSendQueues.get(deps.hub) ?? new Map<string, Promise<void>>();
  hostSendQueues.set(deps.hub, queue);
  const ahead = queue.get(args.hostId);
  if (ahead === undefined && silentDaemonSession(deps, args.hostId) === null) {
    return send();
  }
  const startedAt = Date.now();
  // Resolves once sent, not once answered, so the next command can follow.
  const sending = (ahead ?? Promise.resolve()).then(async () => {
    await waitForAnsweringDaemon(deps, args, startedAt);
    return { response: send() };
  });
  const released = sending.then(
    () => undefined,
    () => undefined,
  );
  queue.set(args.hostId, released);
  void released.then(() => {
    if (queue.get(args.hostId) === released) queue.delete(args.hostId);
  });
  return sending.then(({ response }) => response);
}

function silentDaemonSession(
  deps: Pick<WorkSessionDeps, "db" | "hub">,
  hostId: string,
) {
  const sessionId = deps.hub.getDaemonSessionIdForHost(hostId);
  const session = sessionId && getSessionById(deps.db, { sessionId });
  return session &&
    session.status === "active" &&
    session.leaseExpiresAt <= Date.now()
    ? session
    : null;
}

// Every daemon message renews its lease, and the daemon drops a socket after
// that much silence, but the server keeps it until a close arrives, so the
// machine still lists as connected. A command sent into it waits out its
// timeout with its delivery unknown (#2171). Wait up to one more lease for the
// daemon to speak, and send nothing if it stays silent, as terminals do (#1631).
async function waitForAnsweringDaemon(
  deps: Pick<WorkSessionDeps, "db" | "hub">,
  args: CallHostOnlineRpcArgs<HostDaemonRpcCommand>,
  startedAt: number,
): Promise<void> {
  for (;;) {
    const session = silentDaemonSession(deps, args.hostId);
    if (session === null) return;
    const now = Date.now();
    if (now - startedAt >= Math.min(args.timeoutMs, session.leaseTimeoutMs)) {
      const host = getHost(deps.db, args.hostId);
      const silentS = Math.round(
        (now - session.leaseExpiresAt + session.leaseTimeoutMs) / 1000,
      );
      throw new ApiError(
        502,
        "host_unavailable",
        `${host?.name ?? "The machine"} has sent nothing for ${silentS} s, so its connection is stale. Nothing was sent to it (step: ${args.command.type}). Check that it is awake and online, then try again.`,
        {
          details: inactiveHostUnavailableDetails(
            "disconnected",
            host ?? undefined,
          ),
          retryable: false,
        },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export function hostCommandTimeoutError(): ApiError {
  return new ApiError(
    504,
    "command_timeout",
    "Timed out waiting for command result",
  );
}

function throwOnlineRpcError(error: unknown): never {
  if (error instanceof HostOnlineRpcTimeoutError) {
    throw hostCommandTimeoutError();
  }

  if (error instanceof HostOnlineRpcUnavailableError) {
    throw new ApiError(502, "host_unavailable", "Host is not connected", false);
  }

  throw error;
}
