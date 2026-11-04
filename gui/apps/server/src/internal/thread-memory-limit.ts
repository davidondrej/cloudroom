import {
  hostDaemonThreadMemoryLimitRequestSchema,
  typedRoutes,
  type HostDaemonInternalSchema,
} from "@cloudroom/host-daemon-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { getLatestThreadInterruptedReason, getThread } from "@cloudroom/db";
import { requireThreadEnvironment } from "../services/lib/entity-lookup.js";
import { appendThreadInterruptedEventInTransaction } from "../services/threads/thread-events.js";
import { requestThreadStopForCurrentState } from "../services/threads/thread-lifecycle.js";
import { cancelInterruptedThreadStartInput } from "../services/threads/thread-startup-store.js";
import { cancelRetriesForExplicitStop } from "../services/threads/turn-retry.js";
import { requireAuthenticatedDaemonSession } from "./session-state.js";

/**
 * The daemon's memory guard is about to kill a thread that used over half of
 * the computer's memory. Stop it the way the Stop button does, so it settles
 * as a stop that never auto-retries, with its own reason on the timeline.
 * Answers at once: the daemon kills right after, without waiting.
 *
 * The daemon resends a report the server missed, so a late one can find the
 * thread already failed or idle. It still records the reason, which pauses
 * the queue, and cancels retries, so the thread never auto-resumes.
 */
export function registerInternalThreadMemoryLimitRoutes(
  app: Hono,
  deps: AppDeps,
): void {
  const { post } = typedRoutes<HostDaemonInternalSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  post(
    "/session/thread-memory-limit",
    hostDaemonThreadMemoryLimitRequestSchema,
    (context, payload) => {
      const session = requireAuthenticatedDaemonSession({
        context,
        db: deps.db,
        sessionId: payload.sessionId,
      });
      const { thread, environment } = requireThreadEnvironment(
        deps.db,
        payload.threadId,
      );
      if (environment.hostId !== session.hostId) {
        throw new ApiError(
          403,
          "invalid_request",
          "Thread does not belong to the session host",
        );
      }
      deps.logger.warn(
        {
          threadId: thread.id,
          usedBytes: payload.usedBytes,
          totalBytes: payload.totalBytes,
        },
        "Stopping a thread that used too much memory",
      );
      cancelRetriesForExplicitStop(deps, thread.id);
      cancelInterruptedThreadStartInput(deps.db, thread.id);
      requestThreadStopForCurrentState(
        deps,
        thread,
        environment,
        "memory-limit",
      );
      if (
        getThread(deps.db, thread.id)?.status !== "stopping" &&
        getLatestThreadInterruptedReason(deps.db, { threadId: thread.id }) !==
          "memory-limit"
      ) {
        deps.db.transaction((tx) =>
          appendThreadInterruptedEventInTransaction(tx, {
            threadId: thread.id,
            reason: "memory-limit",
          }),
        );
        deps.hub.notifyThread(thread.id, ["events-appended"], {
          eventTypes: ["system/thread/interrupted"],
        });
      }
      return context.json({ ok: true as const });
    },
  );
}
