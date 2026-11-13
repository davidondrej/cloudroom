import { threadScope, turnScope } from "@cloudroom/domain";
import { describe, expect, it, vi } from "vitest";
import { createEventSink, type CreateEventSinkOptions } from "./event-sink.js";
import { ServerResponseError } from "./server-client.js";

function permanentRejection(bodyMessage: string): ServerResponseError {
  return new ServerResponseError({
    action: "post events",
    bodyMessage,
    code: "invalid_request",
    retryable: false,
    status: 409,
    statusText: "Conflict",
  });
}

function createLogger(): CreateEventSinkOptions["logger"] {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
}

function acceptingPostEvents() {
  return vi.fn<CreateEventSinkOptions["postEvents"]>(async (events) => ({
    acceptedEvents: events.map((event, eventIndex) => ({
      eventIndex,
      sequence: eventIndex + 1,
      threadId: event.threadId,
    })),
    rejectedEvents: [],
  }));
}

function systemErrorEvent(threadId: string) {
  return {
    type: "system/error",
    threadId,
    scope: threadScope(),
    message: "boom",
  } as const;
}

describe("event sink", () => {
  it("posts emitted events", async () => {
    const postEvents = acceptingPostEvents();
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    await sink.flush();

    expect(postEvents).toHaveBeenCalledWith([
      { threadId: "thr_1", event: systemErrorEvent("thr_1") },
    ]);
  });

  it("holds events while the session is closed and delivers them once it reopens", async () => {
    let sessionOpen = false;
    const postEvents = acceptingPostEvents();
    const sink = createEventSink({
      isSessionOpen: () => sessionOpen,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    await sink.flush();
    expect(postEvents).not.toHaveBeenCalled();

    sessionOpen = true;
    await sink.flush();

    expect(postEvents).toHaveBeenCalledTimes(1);
    expect(postEvents).toHaveBeenCalledWith([
      { threadId: "thr_1", event: systemErrorEvent("thr_1") },
    ]);
  });

  it("keeps events queued after a post failure and redelivers them on the next flush", async () => {
    const postEvents = vi
      .fn<CreateEventSinkOptions["postEvents"]>()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockImplementation(async (events) => ({
        acceptedEvents: events.map((event, eventIndex) => ({
          eventIndex,
          sequence: eventIndex + 1,
          threadId: event.threadId,
        })),
        rejectedEvents: [],
      }));
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    await expect(sink.flush()).resolves.toBeUndefined();

    await sink.flush();

    expect(postEvents).toHaveBeenCalledTimes(2);
    expect(postEvents).toHaveBeenLastCalledWith([
      { threadId: "thr_1", event: systemErrorEvent("thr_1") },
    ]);
  });

  it("drops rejected events with a warning without throwing", async () => {
    const logger = createLogger();
    const postEvents = vi.fn<CreateEventSinkOptions["postEvents"]>(
      async () => ({
        acceptedEvents: [],
        rejectedEvents: [
          {
            eventIndex: 0,
            reason: "thread_not_owned_by_host",
            threadId: "thr_1",
          },
        ],
      }),
    );
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger,
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    await expect(sink.flush()).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);

    await sink.flush();
    expect(postEvents).toHaveBeenCalledTimes(1);
  });

  it("warns once when a large queue remains undelivered", () => {
    const logger = createLogger();
    let now = 0;
    const sink = createEventSink({
      isSessionOpen: () => false,
      logger,
      now: () => now,
      postEvents: acceptingPostEvents(),
    });

    for (let index = 0; index < 511; index += 1) {
      sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    }
    expect(logger.warn).not.toHaveBeenCalled();

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    expect(logger.warn).not.toHaveBeenCalled();

    now = 5_000;
    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ queueAgeMs: 5_000, queueDepth: 513 }),
      expect.any(String),
    );
  });

  it("warns when even a small queue is stalled for thirty seconds", () => {
    const logger = createLogger();
    let now = 0;
    const sink = createEventSink({
      isSessionOpen: () => false,
      logger,
      now: () => now,
      postEvents: acceptingPostEvents(),
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    now = 30_000;
    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ queueAgeMs: 30_000, queueDepth: 2 }),
      expect.any(String),
    );
  });

  it("drops a permanently rejected event instead of retrying it forever", async () => {
    const logger = createLogger();
    const postEvents = vi.fn<CreateEventSinkOptions["postEvents"]>(
      async (events) => {
        if (events.some((event) => event.threadId === "thr_poison")) {
          throw permanentRejection(
            "Cannot append provider/unhandled for turn auto-compact-1 before turn/started is stored",
          );
        }
        return {
          acceptedEvents: events.map((event, eventIndex) => ({
            eventIndex,
            sequence: eventIndex + 1,
            threadId: event.threadId,
          })),
          rejectedEvents: [],
        };
      },
    );
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger,
      postEvents,
    });

    sink.emit({
      threadId: "thr_poison",
      event: systemErrorEvent("thr_poison"),
    });
    await sink.flush();

    postEvents.mockClear();
    await sink.flush();
    expect(postEvents).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("delivers events queued behind a permanently rejected event", async () => {
    const delivered: string[] = [];
    const postEvents = vi.fn<CreateEventSinkOptions["postEvents"]>(
      async (events) => {
        if (events.some((event) => event.threadId === "thr_poison")) {
          throw permanentRejection(
            "Cannot append provider/unhandled for turn auto-compact-1 before turn/started is stored",
          );
        }
        delivered.push(...events.map((event) => event.threadId));
        return {
          acceptedEvents: events.map((event, eventIndex) => ({
            eventIndex,
            sequence: eventIndex + 1,
            threadId: event.threadId,
          })),
          rejectedEvents: [],
        };
      },
    );
    let sessionOpen = false;
    const sink = createEventSink({
      isSessionOpen: () => sessionOpen,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({
      threadId: "thr_poison",
      event: systemErrorEvent("thr_poison"),
    });
    sink.emit({ threadId: "thr_a", event: systemErrorEvent("thr_a") });
    sink.emit({ threadId: "thr_b", event: systemErrorEvent("thr_b") });
    sink.emit({ threadId: "thr_a", event: systemErrorEvent("thr_a") });

    await sink.flush();
    expect(postEvents).not.toHaveBeenCalled();

    sessionOpen = true;
    await sink.flush();

    expect(delivered).toEqual(["thr_a", "thr_b", "thr_a"]);

    postEvents.mockClear();
    await sink.flush();
    expect(postEvents).not.toHaveBeenCalled();
  });

  it("keeps retrying a batch that fails for a retryable reason", async () => {
    const postEvents = vi
      .fn<CreateEventSinkOptions["postEvents"]>()
      .mockRejectedValueOnce(
        new ServerResponseError({
          action: "post events",
          bodyMessage: "database is locked",
          code: "internal_error",
          retryable: true,
          status: 500,
          statusText: "Internal Server Error",
        }),
      )
      .mockImplementation(async (events) => ({
        acceptedEvents: events.map((event, eventIndex) => ({
          eventIndex,
          sequence: eventIndex + 1,
          threadId: event.threadId,
        })),
        rejectedEvents: [],
      }));
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    await sink.flush();
    await sink.flush();

    expect(postEvents).toHaveBeenCalledTimes(2);
    expect(postEvents).toHaveBeenLastCalledWith([
      { threadId: "thr_1", event: systemErrorEvent("thr_1") },
    ]);
  });

  it("keeps events queued when the session, not the batch, is rejected", async () => {
    const postEvents = vi
      .fn<CreateEventSinkOptions["postEvents"]>()
      .mockRejectedValueOnce(
        new ServerResponseError({
          action: "post events",
          bodyMessage: "Session is not active",
          code: "inactive_session",
          retryable: false,
          status: 401,
          statusText: "Unauthorized",
        }),
      )
      .mockImplementation(async (events) => ({
        acceptedEvents: events.map((event, eventIndex) => ({
          eventIndex,
          sequence: eventIndex + 1,
          threadId: event.threadId,
        })),
        rejectedEvents: [],
      }));
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    sink.emit({ threadId: "thr_2", event: systemErrorEvent("thr_2") });
    await sink.flush();

    expect(postEvents).toHaveBeenCalledTimes(1);

    await sink.flush();
    expect(postEvents).toHaveBeenLastCalledWith([
      { threadId: "thr_1", event: systemErrorEvent("thr_1") },
      { threadId: "thr_2", event: systemErrorEvent("thr_2") },
    ]);
  });

  it("never throws from emit regardless of how many events queue up", () => {
    const sink = createEventSink({
      isSessionOpen: () => false,
      logger: createLogger(),
      postEvents: acceptingPostEvents(),
    });

    expect(() => {
      for (let index = 0; index < 1000; index += 1) {
        sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
      }
    }).not.toThrow();
  });
});

function messageDelta(threadId: string, delta: string, itemId = "msg_1") {
  return {
    type: "item/agentMessage/delta",
    threadId,
    providerThreadId: "provider-1",
    scope: turnScope("turn_1"),
    itemId,
    delta,
  } as const;
}

function outputDelta(threadId: string, delta: string, reset?: boolean) {
  return {
    type: "item/commandExecution/outputDelta",
    threadId,
    providerThreadId: "provider-1",
    scope: turnScope("turn_1"),
    itemId: "cmd_1",
    delta,
    ...(reset ? { reset } : {}),
  } as const;
}

describe("event sink streamed text (#1248)", () => {
  function createSink(postEvents = acceptingPostEvents()) {
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger: createLogger(),
      postEvents,
    });
    return { postEvents, sink };
  }

  it("posts the pieces of one item as one event, also when other threads stream between them", async () => {
    const { postEvents, sink } = createSink();

    sink.emit({ threadId: "thr_1", event: messageDelta("thr_1", "Hel") });
    sink.emit({ threadId: "thr_2", event: messageDelta("thr_2", "Good") });
    sink.emit({ threadId: "thr_1", event: messageDelta("thr_1", "lo ") });
    sink.emit({ threadId: "thr_2", event: messageDelta("thr_2", "bye") });
    sink.emit({ threadId: "thr_1", event: messageDelta("thr_1", "world") });
    await sink.flush();

    expect(postEvents).toHaveBeenCalledTimes(1);
    expect(postEvents).toHaveBeenCalledWith([
      { threadId: "thr_1", event: messageDelta("thr_1", "Hello world") },
      { threadId: "thr_2", event: messageDelta("thr_2", "Goodbye") },
    ]);
  });

  it("keeps pieces apart across another event, another item, and a reset", async () => {
    const { postEvents, sink } = createSink();
    const events = [
      messageDelta("thr_1", "a"),
      // Another item's piece comes between two pieces of msg_1.
      messageDelta("thr_1", "b", "msg_2"),
      messageDelta("thr_1", "c"),
      outputDelta("thr_1", "old\n"),
      // A reset replaces the output so far. The piece after it adds to the reset.
      outputDelta("thr_1", "new\n", true),
      outputDelta("thr_1", "more\n"),
    ];

    for (const event of events) sink.emit({ threadId: "thr_1", event });
    await sink.flush();

    expect(postEvents.mock.calls[0]?.[0].map((posted) => posted.event)).toEqual(
      [
        messageDelta("thr_1", "a"),
        messageDelta("thr_1", "b", "msg_2"),
        messageDelta("thr_1", "c"),
        outputDelta("thr_1", "old\n"),
        outputDelta("thr_1", "new\nmore\n", true),
      ],
    );
  });

  it("does not change the events it was given", async () => {
    const { sink } = createSink();
    const first = messageDelta("thr_1", "Hel");

    sink.emit({ threadId: "thr_1", event: first });
    sink.emit({ threadId: "thr_1", event: messageDelta("thr_1", "lo") });
    await sink.flush();

    expect(first.delta).toBe("Hel");
  });

  it("never adds to an event that a POST in flight has already taken", async () => {
    const posted: string[][] = [];
    let finishFirstPost = (): void => {};
    const postEvents = vi.fn<CreateEventSinkOptions["postEvents"]>(
      async (events) => {
        posted.push(
          events.map((event) => ("delta" in event.event ? event.event.delta : "")),
        );
        if (posted.length === 1) {
          await new Promise<void>((resolve) => {
            finishFirstPost = resolve;
          });
        }
        return { acceptedEvents: [], rejectedEvents: [] };
      },
    );
    const { sink } = createSink(postEvents);

    sink.emit({ threadId: "thr_1", event: messageDelta("thr_1", "sent ") });
    const flushing = sink.flush();
    // The first POST has "sent " on the wire. A piece joined onto it now would be lost.
    sink.emit({ threadId: "thr_1", event: messageDelta("thr_1", "late ") });
    sink.emit({ threadId: "thr_1", event: messageDelta("thr_1", "later") });
    finishFirstPost();
    await flushing;

    expect(posted).toEqual([["sent "], ["late later"]]);
  });

  it("lets streamed text wait 250 ms, other events 100 ms, and sends urgent events at once", async () => {
    vi.useFakeTimers();
    try {
      const { postEvents, sink } = createSink();
      const progress = {
        type: "item/toolCall/progress",
        threadId: "thr_1",
        providerThreadId: "provider-1",
        scope: turnScope("turn_1"),
        itemId: "tool_1",
        message: "working",
      } as const;

      sink.emit({ threadId: "thr_1", event: messageDelta("thr_1", "a") });
      await vi.advanceTimersByTimeAsync(249);
      expect(postEvents).toHaveBeenCalledTimes(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(postEvents).toHaveBeenCalledTimes(1);

      // Another event does not wait for the streamed text's later deadline, and takes the text with it.
      sink.emit({ threadId: "thr_1", event: messageDelta("thr_1", "b") });
      await vi.advanceTimersByTimeAsync(50);
      sink.emit({ threadId: "thr_1", event: progress });
      await vi.advanceTimersByTimeAsync(99);
      expect(postEvents).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(postEvents).toHaveBeenCalledTimes(2);
      expect(postEvents.mock.calls[1]?.[0]).toHaveLength(2);

      sink.emit({ threadId: "thr_1", event: messageDelta("thr_1", "c") });
      sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
      await vi.advanceTimersByTimeAsync(0);
      expect(postEvents).toHaveBeenCalledTimes(3);
      expect(postEvents.mock.calls[2]?.[0]).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("lets events that arrive during a POST wait their time, unless one is urgent or flush() is called", async () => {
    vi.useFakeTimers();
    try {
      const posted: string[][] = [];
      // A POST that takes 20 ms, as on a busy machine.
      const postEvents = vi.fn<CreateEventSinkOptions["postEvents"]>(
        async (events) => {
          posted.push(
            events.map((event) =>
              "delta" in event.event ? event.event.delta : event.event.type,
            ),
          );
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { acceptedEvents: [], rejectedEvents: [] };
        },
      );
      const { sink } = createSink(postEvents);
      const emit = (delta: string) =>
        sink.emit({ threadId: "thr_1", event: messageDelta("thr_1", delta) });

      emit("a");
      await vi.advanceTimersByTimeAsync(250);
      // The first POST is in flight until 270 ms. These arrive at 255 and 260 ms.
      await vi.advanceTimersByTimeAsync(5);
      emit("b");
      await vi.advanceTimersByTimeAsync(5);
      emit("c");
      await vi.advanceTimersByTimeAsync(100);
      // Before #1248 they went out at 270 ms, straight after the first POST.
      expect(posted).toEqual([["a"]]);
      await vi.advanceTimersByTimeAsync(145);
      expect(posted).toEqual([["a"], ["bc"]]);
      await vi.advanceTimersByTimeAsync(20);

      // An urgent event that arrives during a POST still goes straight after it.
      emit("d");
      await vi.advanceTimersByTimeAsync(250);
      emit("e");
      sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
      await vi.advanceTimersByTimeAsync(20);
      expect(posted.slice(2)).toEqual([["d"], ["e", "system/error"]]);
      await vi.advanceTimersByTimeAsync(20);

      // flush() sends everything, also what arrived during the POST in flight.
      emit("f");
      await vi.advanceTimersByTimeAsync(250);
      emit("g");
      const flushed = sink.flush();
      await vi.advanceTimersByTimeAsync(40);
      await flushed;
      expect(posted.slice(4)).toEqual([["f"], ["g"]]);
    } finally {
      vi.useRealTimers();
    }
  });
});
