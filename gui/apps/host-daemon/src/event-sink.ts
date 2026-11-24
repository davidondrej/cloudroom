import {
  isStreamDeltaEvent,
  joinStreamDeltas,
  type ThreadEvent,
} from "@cloudroom/domain";
import type {
  HostDaemonEventBatchResponse,
  HostDaemonEventEnvelope,
  HostDaemonRejectedEvent,
} from "@cloudroom/host-daemon-contract";
import { normalizeCaughtError, runtimeErrorLogFields } from "./error-utils.js";
import type { HostDaemonLogger } from "./logger.js";
import { ServerResponseError } from "./server-client.js";

const DEFAULT_DEBOUNCE_MS = 100;
// Streamed text waits longer: every save costs the same disk write however little it holds (#1248), and the app
// shows streamed text a whole line at a time. Any other event still goes within DEFAULT_DEBOUNCE_MS, or at once.
const STREAM_DELTA_DEBOUNCE_MS = 250;

const QUEUE_DEPTH_WARN_THRESHOLD = 512;
const QUEUE_DEPTH_WARN_MIN_AGE_MS = 5_000;
const QUEUE_AGE_WARN_THRESHOLD_MS = 30_000;

export interface EventSinkInput {
  event: ThreadEvent;
  threadId: string;
}

export interface EventPostResult {
  acceptedEvents: HostDaemonEventBatchResponse["acceptedEvents"];
  rejectedEvents: HostDaemonEventBatchResponse["rejectedEvents"];
}

export interface CreateEventSinkOptions {
  isSessionOpen: () => boolean;
  logger: Pick<HostDaemonLogger, "debug" | "error" | "warn">;
  now?: () => number;
  postEvents: (events: HostDaemonEventEnvelope[]) => Promise<EventPostResult>;
}

export interface EventSink {
  emit(event: EventSinkInput): void;
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

interface RejectedEventSummary {
  eventIndex: number;
  reason: HostDaemonRejectedEvent["reason"];
  threadId: string;
}

export class EventSinkDisposedError extends Error {
  constructor() {
    super("Cannot emit to disposed event sink");
    this.name = "EventSinkDisposedError";
  }
}

function isWaitingForApprovalItemEvent(event: ThreadEvent): boolean {
  if (event.type !== "item/started" && event.type !== "item/completed") {
    return false;
  }

  if (
    event.item.type !== "commandExecution" &&
    event.item.type !== "fileChange"
  ) {
    return false;
  }

  return event.item.approvalStatus === "waiting_for_approval";
}

function shouldFlushThreadEventImmediately(event: ThreadEvent): boolean {
  if (event.type === "turn/started" || event.type === "item/completed") {
    return true;
  }

  if (
    event.type === "turn/completed" ||
    event.type === "system/error" ||
    event.type === "system/thread/interrupted"
  ) {
    return true;
  }

  if (event.type === "provider/error") {
    return event.willRetry !== true;
  }

  return isWaitingForApprovalItemEvent(event);
}

function isPermanentPostRejection(error: Error): boolean {
  return (
    error instanceof ServerResponseError &&
    !error.retryable &&
    error.code === "invalid_request"
  );
}

function summarizeRejectedEvents(
  events: readonly HostDaemonRejectedEvent[],
): RejectedEventSummary[] {
  return events.map((event) => ({
    eventIndex: event.eventIndex,
    reason: event.reason,
    threadId: event.threadId,
  }));
}

export function createEventSink(options: CreateEventSinkOptions): EventSink {
  const now = options.now ?? (() => Date.now());
  const queue: HostDaemonEventEnvelope[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushTimerDueAtMs = 0;
  // When the earliest event that no POST has taken wants to go. Infinity when no event waits.
  let waitingDueAtMs = Infinity;
  // The first events in the queue that a POST in flight has already taken.
  let postingCount = 0;
  let flushPromise: Promise<void> | null = null;
  // A caller of flush() wants every event sent now, not only the ones that are due.
  let flushAll = false;
  // The last drain left events that are not due yet for the timer.
  let leftWaiting = false;
  let disposed = false;
  let backedUpSinceMs: number | null = null;
  let backpressureLogged = false;

  function maybeLogQueuePressure(): void {
    if (backpressureLogged || backedUpSinceMs === null) {
      return;
    }
    const queueDepth = queue.length;
    const queueAgeMs = now() - backedUpSinceMs;
    if (
      queueAgeMs < QUEUE_AGE_WARN_THRESHOLD_MS &&
      (queueDepth < QUEUE_DEPTH_WARN_THRESHOLD ||
        queueAgeMs < QUEUE_DEPTH_WARN_MIN_AGE_MS)
    ) {
      return;
    }
    backpressureLogged = true;
    options.logger.warn(
      { queueDepth, queueAgeMs },
      "Daemon event queue is backing up; delivery may be stalled",
    );
  }

  function clearScheduledFlush(): void {
    if (flushTimer === null) {
      return;
    }
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  function scheduleFlush(): void {
    if (disposed || flushPromise !== null || waitingDueAtMs === Infinity) {
      return;
    }
    if (flushTimer !== null) {
      if (waitingDueAtMs >= flushTimerDueAtMs) {
        return;
      }
      clearScheduledFlush();
    }
    flushTimerDueAtMs = waitingDueAtMs;
    flushTimer = setTimeout(
      () => {
        flushTimer = null;
        void deliverDue().catch((error) => {
          options.logger.error(
            runtimeErrorLogFields(normalizeCaughtError(error)),
            "Daemon event delivery failed",
          );
        });
      },
      Math.max(0, waitingDueAtMs - now()),
    );
  }

  async function deliverBatch(
    batch: readonly HostDaemonEventEnvelope[],
  ): Promise<number> {
    let response: EventPostResult;
    try {
      response = await options.postEvents([...batch]);
    } catch (error) {
      const normalized = normalizeCaughtError(error);
      if (!isPermanentPostRejection(normalized)) {
        options.logger.error(
          runtimeErrorLogFields(normalized),
          "Failed to post daemon events; will retry on the next flush",
        );
        return 0;
      }

      const [offending] = batch;
      if (batch.length === 1 && offending !== undefined) {
        options.logger.error(
          {
            ...runtimeErrorLogFields(normalized),
            eventType: offending.event.type,
            threadId: offending.threadId,
          },
          "Dropped a daemon event the server will never accept",
        );
        return 1;
      }

      const midpoint = Math.floor(batch.length / 2);
      const deliveredFromFirstHalf = await deliverBatch(
        batch.slice(0, midpoint),
      );
      if (deliveredFromFirstHalf < midpoint) {
        return deliveredFromFirstHalf;
      }
      return midpoint + (await deliverBatch(batch.slice(midpoint)));
    }

    if (response.rejectedEvents.length > 0) {
      options.logger.warn(
        {
          rejectedEvents: summarizeRejectedEvents(response.rejectedEvents),
        },
        "Server rejected daemon events",
      );
    }
    return batch.length;
  }

  async function drainQueue(): Promise<void> {
    leftWaiting = false;
    waitingDueAtMs = Infinity;
    while (queue.length > 0 && !disposed && options.isSessionOpen()) {
      const batch = queue.slice();
      postingCount = batch.length;
      waitingDueAtMs = Infinity;
      let delivered = 0;
      try {
        delivered = await deliverBatch(batch);
      } finally {
        postingCount = 0;
      }
      queue.splice(0, delivered);
      if (queue.length === 0) {
        backedUpSinceMs = null;
        backpressureLogged = false;
      }
      if (delivered < batch.length) {
        return;
      }
      // Events that arrived during the POST wait as long as they would have without it. Sent at once, they made
      // a busy daemon post back to back, and every POST is one more disk write on the server (#1248).
      if (queue.length > 0 && !flushAll && waitingDueAtMs > now()) {
        leftWaiting = true;
        return;
      }
    }
  }

  // Sends the events that are due. Events that arrive meanwhile and are not due get their own timer afterwards.
  async function deliverDue(): Promise<void> {
    clearScheduledFlush();
    if (flushPromise !== null) {
      await flushPromise;
      return;
    }

    flushPromise = drainQueue();
    try {
      await flushPromise;
    } finally {
      flushPromise = null;
      flushAll = false;
      scheduleFlush();
    }
  }

  async function flush(): Promise<void> {
    do {
      flushAll = true;
      await deliverDue();
      // A drain that was already ending when this was called may have left events for the timer.
    } while (leftWaiting && !disposed);
  }

  // Joins a streamed piece onto the piece before it, so a burst of tokens is saved as one row, not one each.
  // Only the thread's newest waiting event qualifies: joining across another event would move text past it.
  function joinOntoWaitingDelta(input: EventSinkInput): boolean {
    for (let index = queue.length - 1; index >= postingCount; index -= 1) {
      const waiting = queue[index];
      if (waiting === undefined || waiting.threadId !== input.threadId) {
        continue;
      }
      const joined = joinStreamDeltas(waiting.event, input.event);
      if (joined === null) {
        return false;
      }
      queue[index] = { threadId: waiting.threadId, event: joined };
      return true;
    }
    return false;
  }

  return {
    emit(input): void {
      if (disposed) {
        throw new EventSinkDisposedError();
      }
      if (backedUpSinceMs === null) {
        backedUpSinceMs = now();
      }
      if (!joinOntoWaitingDelta(input)) {
        queue.push({
          threadId: input.threadId,
          event: input.event,
        });
      }
      maybeLogQueuePressure();
      const delayMs = shouldFlushThreadEventImmediately(input.event)
        ? 0
        : isStreamDeltaEvent(input.event)
          ? STREAM_DELTA_DEBOUNCE_MS
          : DEFAULT_DEBOUNCE_MS;
      waitingDueAtMs = Math.min(waitingDueAtMs, now() + delayMs);
      scheduleFlush();
    },
    flush,
    async dispose(): Promise<void> {
      disposed = true;
      clearScheduledFlush();
      if (flushPromise !== null) {
        await flushPromise.catch(() => undefined);
      }
      queue.length = 0;
    },
  };
}
