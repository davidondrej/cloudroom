import { refreshProviderRetirement } from "../../services/environments/environment-engine.js";
import {
  deleteQueuedThreadMessage,
  getEnvironment,
  getQueuedThreadMessage,
  listActiveVisiblePinnedThreadRootsWithPendingInteractionState,
  pinThread,
  reorderPinnedThread,
  reorderQueuedThreadMessage,
  unpinThread,
  updateQueuedThreadMessage,
  updateThread,
  type ReorderPinnedThreadResult,
  type ReorderQueuedThreadMessageResult,
} from "@cloudroom/db";
import {
  publicApiRoutes,
  typedRoutes,
  type ThreadListResponse,
  type PublicApiSchema,
} from "@cloudroom/server-contract";
import type { Hono } from "hono";
import {
  createStandaloneBuiltinCompactCommandInput,
  isStandaloneBuiltinTeleportCommand,
  type Thread,
  type ThreadQueuedMessage,
} from "@cloudroom/domain";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  emitPluginMessageCancelled,
  emitPluginThreadUnarchived,
} from "../../services/plugins/plugin-thread-events.js";
import { toThreadQueuedMessage } from "../../services/threads/thread-queued-messages.js";
import {
  cancelRetriesForExplicitStop,
  retryFailedTurn,
} from "../../services/threads/turn-retry.js";
import { cancelInterruptedThreadStartInput } from "../../services/threads/thread-startup-store.js";
import {
  requireConnectedHostSession,
  requirePublicThread,
} from "../../services/lib/entity-lookup.js";
import { parseSafeRelativeRoutePath } from "../relative-route-path.js";
import { validatePromptAttachmentReferences } from "../../services/projects/attachments.js";
import {
  createQueuedMessageForThread,
  sendQueuedMessageNow,
} from "../../services/threads/queued-messages.js";
import {
  ensureThreadIsNotAwaitingUserInteraction,
  ensureThreadIsWritable,
  ensureThreadQueueIsWritable,
  sendThreadMessage,
} from "../../services/threads/thread-send.js";
import { acceptThreadSendRequest } from "../../services/threads/thread-send-request.js";
import { editThreadMessage } from "../../services/threads/thread-edit-message.js";
import { clearThreadContext } from "../../services/threads/thread-context-clear.js";
import {
  installThreadMoves,
  moveThreadToProject,
} from "../../services/threads/thread-move.js";
import {
  buildExecutionOptions,
  dispatchThreadUnarchiveCommand,
  prepareTurnSubmitCommandPayload,
} from "../../services/threads/thread-commands.js";
import { getLastProviderThreadId } from "../../services/threads/thread-events.js";
import { stopThreadForCurrentState } from "../../services/threads/thread-lifecycle.js";
import {
  getThreadPromptBannerActivity,
  toThreadListEntryResponses,
  toThreadResponseFromThread,
} from "../../services/threads/thread-runtime-display.js";
import { archiveThreadAndChildren } from "../../services/threads/thread-archive.js";
import { unarchiveThreadKeepingOpenParent } from "../../services/threads/thread-ownership.js";
import { cloudroom, isCloudThread } from "../../services/cloudroom/commands.js";
import { teleports } from "../../services/cloudroom/teleport.js";
import { teleportToLocal } from "../../services/cloudroom/teleport-local.js";
import {
  requireThreadCommandEnvironment,
  requireThreadHostCommandEnvironment,
  resolveThreadHostCommandEnvironment,
} from "../../services/threads/thread-command-environment.js";
import {
  LIVE_DAEMON_COMMAND_TIMEOUT_MS,
  runLiveHostCommand,
} from "../../services/hosts/live-command.js";

function toQueuedMessageOrderResponse(
  result: ReorderQueuedThreadMessageResult,
): ThreadQueuedMessage[] {
  switch (result.kind) {
    case "reordered":
    case "unchanged":
      return result.queuedMessages.map(toThreadQueuedMessage);
    case "not_found":
      throw new ApiError(404, "invalid_request", "Queued message not found");
    case "claimed":
      throw new ApiError(
        409,
        "invalid_request",
        "Queued message is already being sent",
      );
    case "stale_neighbor":
      throw new ApiError(
        409,
        "invalid_request",
        "Queued message order changed",
      );
    case "invalid_neighbor_order":
      throw new ApiError(
        409,
        "invalid_request",
        "Queued message order is invalid",
      );
  }
}

async function compactThreadContext(
  deps: AppDeps,
  thread: Thread,
): Promise<void> {
  if (isCloudThread(thread)) {
    await cloudroom(deps).compact(thread);
    return;
  }
  ensureThreadIsWritable(thread);
  if (!deps.providerRegistry.supportsManualCompaction(thread.providerId)) {
    throw new ApiError(
      409,
      "invalid_request",
      `Provider "${thread.providerId}" does not support manual context compaction`,
    );
  }
  if (thread.status !== "idle" && thread.status !== "error") {
    throw new ApiError(
      409,
      "invalid_request",
      "Context can only be compacted while the thread is idle or errored",
    );
  }

  const environment = await requireThreadCommandEnvironment(deps, { thread });
  await sendThreadMessage(deps, {
    environment,
    payload: {
      input: createStandaloneBuiltinCompactCommandInput(),
      mode: "start",
    },
    thread,
    trigger: "user",
  });
}

function buildActivePinnedThreadRootListResponse(
  deps: AppDeps,
): ThreadListResponse {
  return toThreadListEntryResponses(deps, {
    threads: listActiveVisiblePinnedThreadRootsWithPendingInteractionState(
      deps.db,
    ),
  });
}

function assertPinnedThreadOrderResult(
  result: ReorderPinnedThreadResult,
): void {
  switch (result.kind) {
    case "reordered":
    case "unchanged":
      return;
    case "not_found":
      throw new ApiError(404, "thread_not_found", "Thread not found");
    case "not_pinned":
      throw new ApiError(409, "invalid_request", "Thread is not pinned");
    case "stale_neighbor":
      throw new ApiError(409, "invalid_request", "Pinned thread order changed");
    case "invalid_neighbor_order":
      throw new ApiError(
        409,
        "invalid_request",
        "Pinned thread order is invalid",
      );
  }
}

export function registerThreadActionRoutes(app: Hono, deps: AppDeps): void {
  const { post, patch, del } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });
  const routes = publicApiRoutes.threads;
  installThreadMoves(deps);

  post(routes.send, async (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    if (isStandaloneBuiltinTeleportCommand(payload.input)) {
      if (isCloudThread(thread)) await teleportToLocal(deps, thread.id);
      else await teleports(deps).begin(thread.id);
      return context.json({ ok: true, delivery: "sent" } as const);
    }
    return context.json(
      await acceptThreadSendRequest(deps, { payload, thread }),
    );
  });

  post(routes.editMessage, async (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    if (isCloudThread(thread)) {
      return context.json(await cloudroom(deps).editMessage(thread, payload));
    }
    const environment = await requireThreadCommandEnvironment(deps, {
      thread,
    });
    const result = await editThreadMessage(deps, {
      environment,
      payload,
      thread,
    });
    return context.json(result);
  });

  post(routes.retry, async (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    ensureThreadIsWritable(thread);
    const result = await retryFailedTurn(deps, { request: payload, thread });
    return context.json(result);
  });

  post(routes.createQueuedMessage, async (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const queuedMessage = await createQueuedMessageForThread(deps, {
      payload,
      thread,
    });
    return context.json(queuedMessage, 201);
  });

  post(routes.sendQueuedMessage, async (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    ensureThreadQueueIsWritable(thread);
    ensureThreadIsNotAwaitingUserInteraction(deps, thread.id);
    const result = await sendQueuedMessageNow(deps, {
      queuedMessageId: context.req.param("queuedMessageId"),
      mode: payload.mode,
      threadId: context.req.param("id"),
    });
    return context.json({ ok: true, ...result });
  });

  patch(routes.reorderQueuedMessage, async (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    if (isCloudThread(thread)) {
      return context.json(await cloudroom(deps).reorderQueued(thread, { ...payload, queuedMessageId: context.req.param("queuedMessageId") }));
    }
    ensureThreadQueueIsWritable(thread);
    return context.json(
      toQueuedMessageOrderResponse(
        reorderQueuedThreadMessage({
          db: deps.db,
          notifier: deps.hub,
          threadId: thread.id,
          queuedMessageId: context.req.param("queuedMessageId"),
          previousQueuedMessageId: payload.previousQueuedMessageId,
          nextQueuedMessageId: payload.nextQueuedMessageId,
        }),
      ),
    );
  });

  patch(routes.updateQueuedMessage, async (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    if (isCloudThread(thread)) {
      return context.json(await cloudroom(deps).editQueued(thread, context.req.param("queuedMessageId"), payload));
    }
    ensureThreadQueueIsWritable(thread);
    await validatePromptAttachmentReferences({
      dataDir: deps.config.dataDir,
      input: payload.input,
      projectId: thread.projectId,
    });
    const result = updateQueuedThreadMessage(deps.db, deps.hub, {
      content: payload.input,
      expectedUpdatedAt: payload.expectedUpdatedAt,
      id: context.req.param("queuedMessageId"),
      threadId: thread.id,
    });
    if (result.kind === "not_found") {
      throw new ApiError(404, "invalid_request", "Queued message not found");
    }
    if (result.kind === "claimed") {
      throw new ApiError(
        409,
        "invalid_request",
        "Queued message is already being sent",
      );
    }
    if (result.kind === "stale") {
      throw new ApiError(
        409,
        "invalid_request",
        "Queued message changed since editing began",
      );
    }
    return context.json(toThreadQueuedMessage(result.queuedMessage));
  });

  del(routes.deleteQueuedMessage, async (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    if (isCloudThread(thread)) {
      await cloudroom(deps).cancelQueued(thread, context.req.param("queuedMessageId"));
      return context.json({ ok: true });
    }
    const queuedMessage = getQueuedThreadMessage(
      deps.db,
      context.req.param("queuedMessageId"),
    );
    if (!queuedMessage || queuedMessage.threadId !== context.req.param("id")) {
      throw new ApiError(404, "invalid_request", "Queued message not found");
    }
    const deleted = deleteQueuedThreadMessage(
      deps.db,
      deps.hub,
      context.req.param("queuedMessageId"),
    );
    if (!deleted) {
      throw new ApiError(404, "invalid_request", "Queued message not found");
    }
    emitPluginMessageCancelled(toThreadQueuedMessage(queuedMessage));
    return context.json({ ok: true });
  });

  post(routes.stop, async (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const environment = resolveThreadHostCommandEnvironment({
      db: deps.db,
      thread,
    });
    teleports(deps).abandon(thread.id);
    const cancelledRetries = cancelRetriesForExplicitStop(deps, thread.id);
    cancelInterruptedThreadStartInput(deps.db, thread.id);
    await stopThreadForCurrentState(deps, thread, environment);
    return context.json({ ok: true, cancelledRetries });
  });

  post(routes.compact, async (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    await compactThreadContext(deps, thread);
    return context.json({ ok: true });
  });

  post(routes.clearContext, async (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const environment = await requireThreadCommandEnvironment(deps, { thread });
    await clearThreadContext(deps, { environment, thread });
    return context.json({ ok: true });
  });

  post(routes.cancelPlan, async (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const activity = getThreadPromptBannerActivity(deps, thread);
    if (activity.activePlanModeCount === 0) {
      throw new ApiError(409, "invalid_request", "Plan mode is not active");
    }
    if (activity.activePlanTurnId === null) {
      throw new ApiError(
        409,
        "invalid_request",
        "The active Plan turn could not be identified",
      );
    }
    const environment = requireThreadHostCommandEnvironment({
      db: deps.db,
      thread,
    });
    await runLiveHostCommand(deps, {
      command: {
        type: "thread.plan.cancel",
        environmentId: environment.id,
        threadId: thread.id,
        expectedTurnId: activity.activePlanTurnId,
      },
      hostId: environment.hostId,
      timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
    });
    const updatedThread = requirePublicThread(deps.db, thread.id);
    if (
      getThreadPromptBannerActivity(deps, updatedThread).activePlanModeCount > 0
    ) {
      throw new ApiError(
        409,
        "invalid_request",
        "The provider did not confirm that Plan mode exited",
      );
    }
    return context.json({ ok: true });
  });

  post(routes.clearGoal, async (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    if (!getThreadPromptBannerActivity(deps, thread).hasGoal) {
      throw new ApiError(409, "invalid_request", "No Goal to clear");
    }
    const environment = await requireThreadCommandEnvironment(deps, {
      thread,
    });
    requireConnectedHostSession(deps, environment.hostId);
    const execution = await buildExecutionOptions(
      deps,
      {},
      { threadId: thread.id },
    );
    const preparedRuntimeCommand = await prepareTurnSubmitCommandPayload(deps, {
      environment,
      execution,
      input: [],
      permissionEscalation: "ask",
      target: { mode: "auto", expectedTurnId: null },
      thread,
    });
    const result = await runLiveHostCommand(deps, {
      command: {
        type: "thread.goal.clear",
        environmentId: environment.id,
        threadId: thread.id,
        options: preparedRuntimeCommand.options,
        resumeContext: preparedRuntimeCommand.resumeContext,
        bridgeLaunch: preparedRuntimeCommand.bridgeLaunch,
      },
      hostId: environment.hostId,
      timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
    });
    const updatedThread = requirePublicThread(deps.db, thread.id);
    const updatedActivity = getThreadPromptBannerActivity(deps, updatedThread);
    if (updatedActivity.hasGoal && !result.cleared) {
      throw new ApiError(
        409,
        "invalid_request",
        "The provider did not clear the Goal",
      );
    }
    if (updatedActivity.hasGoal) {
      throw new ApiError(
        409,
        "invalid_request",
        "The provider did not confirm that the Goal was cleared",
      );
    }
    return context.json({ ok: true });
  });

  post(routes.setGoal, async (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const environment = await requireThreadCommandEnvironment(deps, {
      thread,
    });
    requireConnectedHostSession(deps, environment.hostId);
    const execution = await buildExecutionOptions(
      deps,
      {},
      { threadId: thread.id },
    );
    const preparedRuntimeCommand = await prepareTurnSubmitCommandPayload(deps, {
      environment,
      execution,
      input: [],
      permissionEscalation: "ask",
      target: { mode: "auto", expectedTurnId: null },
      thread,
    });
    await runLiveHostCommand(deps, {
      command: {
        type: "thread.goal.set",
        environmentId: environment.id,
        threadId: thread.id,
        ...payload,
        options: preparedRuntimeCommand.options,
        resumeContext: preparedRuntimeCommand.resumeContext,
        bridgeLaunch: preparedRuntimeCommand.bridgeLaunch,
      },
      hostId: environment.hostId,
      timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
    });
    return context.json({ ok: true });
  });

  post(routes.open, (context, payload) => {
    const publicThread = requirePublicThread(deps.db, context.req.param("id"));
    if (payload.file !== null) {
      parseSafeRelativeRoutePath(payload.file.path);
    }
    const delivered = deps.hub.notifyThreadOpen(
      { projectId: publicThread.projectId, threadId: publicThread.id },
      { split: payload.split ?? "replace", file: payload.file },
    );
    return context.json({ delivered });
  });

  post(routes.paneAction, (context, payload) => {
    const publicThread = requirePublicThread(deps.db, context.req.param("id"));
    const delivered = deps.hub.notifyThreadPaneAction(
      { projectId: publicThread.projectId, threadId: publicThread.id },
      payload.action,
    );
    return context.json({ delivered });
  });

  post(routes.move, async (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const result = await moveThreadToProject(
      deps,
      thread.id,
      payload.projectId,
      "local",
    );
    return context.json({
      ...result,
      thread: toThreadResponseFromThread(deps, { thread: result.thread }),
    });
  });

  post(routes.pin, (context) => {
    const publicThread = requirePublicThread(deps.db, context.req.param("id"));
    const thread = pinThread(deps.db, deps.hub, {
      threadId: publicThread.id,
    });
    if (!thread) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }
    return context.json(toThreadResponseFromThread(deps, { thread }));
  });

  post(routes.unpin, (context) => {
    const publicThread = requirePublicThread(deps.db, context.req.param("id"));
    const thread = unpinThread(deps.db, deps.hub, {
      threadId: publicThread.id,
    });
    if (!thread) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }
    return context.json(toThreadResponseFromThread(deps, { thread }));
  });

  patch(routes.pinOrder, (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    assertPinnedThreadOrderResult(
      reorderPinnedThread({
        db: deps.db,
        notifier: deps.hub,
        threadId: thread.id,
        previousThreadId: payload.previousThreadId,
        nextThreadId: payload.nextThreadId,
      }),
    );
    return context.json(buildActivePinnedThreadRootListResponse(deps));
  });

  post(routes.archiveAll, (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const archivedThreadIds = archiveThreadAndChildren(deps, {
      parentThread: thread,
    });
    return context.json({
      ok: true,
      archivedThreadIds,
    });
  });

  post(routes.unarchive, (context, query) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const providerThreadId = getLastProviderThreadId(deps, thread.id);
    const unarchivedThread = unarchiveThreadKeepingOpenParent(
      deps,
      thread.id,
      query.keepParent === "true",
    );
    if (unarchivedThread !== null) {
      if (isCloudThread(unarchivedThread)) void cloudroom(deps).restore(unarchivedThread.id).catch((error: unknown) => deps.logger.warn({ threadId: unarchivedThread.id, error: error instanceof Error ? error.message : String(error) }, "The thread's sandbox could not be restored"));
      if (!isCloudThread(unarchivedThread) && unarchivedThread.environmentId !== null)
        refreshProviderRetirement(deps, unarchivedThread.environmentId);
      emitPluginThreadUnarchived(unarchivedThread);
    }
    const environment = thread.environmentId
      ? getEnvironment(deps.db, thread.environmentId)
      : null;
    if (!isCloudThread(thread) && providerThreadId && environment) {
      dispatchThreadUnarchiveCommand(deps, {
        environment,
        providerThreadId,
        thread,
      });
    }
    return context.json({ ok: true });
  });

  post(routes.read, (context) => {
    requirePublicThread(deps.db, context.req.param("id"));
    const thread = updateThread(deps.db, deps.hub, context.req.param("id"), {
      lastReadAt: Date.now(),
    });
    if (!thread) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }
    return context.json(toThreadResponseFromThread(deps, { thread }));
  });

  post(routes.unread, (context) => {
    requirePublicThread(deps.db, context.req.param("id"));
    const thread = updateThread(deps.db, deps.hub, context.req.param("id"), {
      lastReadAt: null,
    });
    if (!thread) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }
    return context.json(toThreadResponseFromThread(deps, { thread }));
  });
}
