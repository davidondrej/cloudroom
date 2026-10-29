import { describe, expect, it } from "vitest";
import { threadScope } from "../src/thread-event-scope.js";
import type { ThreadEvent } from "../src/provider-event.js";
import {
  fromProviderExternalThreadName,
  normalizeProviderThreadNameEvent,
  toProviderExternalThreadName,
} from "../src/thread-name-tags.js";

describe("thread name tags", () => {
  it("round-trips user-provided literal bb-prefixed titles", () => {
    const providerName = toProviderExternalThreadName("[bb] Literal");

    expect(providerName).toBe("[cloudroom] [bb] Literal");
    expect(fromProviderExternalThreadName(providerName)).toBe("[bb] Literal");
    expect(fromProviderExternalThreadName("[bb] [bb] Literal")).toBe(
      "[bb] Literal",
    );
    expect(
      fromProviderExternalThreadName(
        toProviderExternalThreadName("[cloudroom] Literal"),
      ),
    ).toBe("[cloudroom] Literal");
    expect(fromProviderExternalThreadName("Plain title")).toBe("Plain title");
  });

  it("normalizes current and legacy provider title events by stripping one tag", () => {
    const event = {
      type: "thread/name/updated",
      threadId: "t1",
      providerThreadId: "p1",
      scope: threadScope(),
      threadName: toProviderExternalThreadName("[bb] Literal"),
    } satisfies ThreadEvent;

    for (const threadName of [
      event.threadName,
      "[room] [bb] Literal",
      "[bb] [bb] Literal",
    ]) {
      expect(
        normalizeProviderThreadNameEvent({ ...event, threadName }),
      ).toEqual({
        ...event,
        threadName: "[bb] Literal",
      });
    }
  });
});
