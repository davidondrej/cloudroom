import { describe, expect, it } from "vitest";
import { experimental_createDeltaAssembler as createDeltaAssembler } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { createCodexEventTranslator } from "./translator.js";

function createHarness() {
  const translator = createCodexEventTranslator({
    additionalWorkspaceWriteRoots: [],
  });
  const assembler = createDeltaAssembler({
    providerId: "codex",
    entropyPrefix: "hooks",
    textDeltaFlushMs: 0,
  });
  return (method: string, params: Record<string, unknown>) =>
    assembler.assemble({
      threadId: "thread-test",
      deltas: translator.translateEvent({ jsonrpc: "2.0", method, params }),
    });
}

describe("Codex lifecycle notification diagnostics", () => {
  it.each([
    {
      method: "item/reasoning/summaryPartAdded",
      params: {
        threadId: "thread-test",
        turnId: "turn-test",
        itemId: "reasoning-test",
        summaryIndex: 0,
      },
    },
    {
      method: "thread/readState/changed",
      params: {
        threadId: "thread-test",
        readState: {
          firstUnread: { type: "turn", turnId: "turn-test" },
          revision: "revision-test",
        },
      },
    },
    {
      method: "thread/readState/changed",
      params: {
        threadId: "thread-test",
        readState: { firstUnread: null, revision: "revision-test" },
      },
    },
  ])("suppresses routine $method notifications", ({ method, params }) => {
    const translate = createHarness();
    expect(translate(method, params)).toEqual([]);
  });

  it("keeps streaming reasoning text after a summary part is added", () => {
    const translator = createCodexEventTranslator({
      additionalWorkspaceWriteRoots: [],
    });
    const params = {
      threadId: "thread-test",
      turnId: "turn-test",
      itemId: "reasoning-test",
      summaryIndex: 0,
    };
    expect(
      translator.translateEvent({
        jsonrpc: "2.0",
        method: "item/reasoning/summaryPartAdded",
        params,
      }),
    ).toEqual([]);
    expect(
      translator.translateEvent({
        jsonrpc: "2.0",
        method: "item/reasoning/summaryTextDelta",
        params: { ...params, delta: "Checking Windows shortcuts" },
      }),
    ).toContainEqual(
      expect.objectContaining({
        kind: "item.textDelta",
        channel: "reasoningSummary",
        text: "Checking Windows shortcuts",
      }),
    );
  });

  it.each(["hook/started", "hook/completed"])(
    "suppresses routine %s notifications",
    (method) => {
      const translate = createHarness();
      const events = translate(method, {
        threadId: "thread-test",
        turnId: null,
        run: {
          id: "hook-test",
          eventName: "sessionStart",
          handlerType: "command",
          executionMode: "sync",
          scope: "thread",
          sourcePath: "/tmp/hooks.json",
          source: "user",
          displayOrder: 0,
          status: method === "hook/started" ? "running" : "completed",
          statusMessage: null,
          startedAt: 1,
          completedAt: method === "hook/completed" ? 2 : null,
          durationMs: method === "hook/completed" ? 1 : null,
          entries: [],
        },
      });
      expect(events).toEqual([]);
    },
  );

  it.each(["thread-test", null])(
    "normalizes a warning with threadId %s exactly once",
    (threadId) => {
      const translate = createHarness();
      const events = translate("warning", {
        threadId,
        message: "Provider context budget notice",
      });
      expect(events).toEqual([
        expect.objectContaining({
          type: "provider/warning",
          category: "general",
          summary: "Provider context budget notice",
        }),
      ]);
    },
  );

  it.each(["failed", "blocked", "stopped"])(
    "shows a %s hook as one warning with its raw notification",
    (status) => {
      const translate = createHarness();
      const run = {
        status,
        eventName: "preToolUse",
        sourcePath: "/tmp/hooks.json",
        statusMessage: null,
        entries: [{ kind: "error", text: "lint-guard: not found\nstack" }],
      };
      const timing = { id: "r1", startedAt: 1, completedAt: 2, durationMs: 1 };
      const [event] = translate("hook/completed", {
        run: { ...run, ...timing },
      });
      expect(event).toMatchObject({
        type: "provider/warning",
        summary: `preToolUse hook in hooks.json ${status}: lint-guard: not found`,
      });
      expect(
        JSON.parse(event?.type === "provider/warning" ? event.details! : ""),
      ).toEqual({
        method: "hook/completed",
        params: { run },
      });
    },
  );

  it("suppresses routine account/updated notifications", () => {
    const translate = createHarness();
    expect(
      translate("account/updated", { authMode: "chatgpt", planType: "pro" }),
    ).toEqual([]);
  });

  it.each([
    "future/notification",
    "item/reasoning/future",
    "thread/readState/future",
  ])("preserves unknown %s notifications as diagnostics", (method) => {
    const translate = createHarness();
    expect(translate(method, { value: 1 })).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        rawType: method,
      }),
    ]);
  });

  it("preserves malformed warnings as diagnostics", () => {
    const translate = createHarness();
    expect(translate("warning", { threadId: null, message: 42 })).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        rawType: "warning",
      }),
    ]);
  });
});
