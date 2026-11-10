import { threadScope, turnScope } from "@cloudroom/domain";
import { afterEach, describe, expect, it } from "vitest";
import { setPluginAgentContributions } from "../../src/services/plugins/plugin-agent-contributions.js";
import {
  dueCustomInstructions,
  markCustomInstructionsLost,
} from "../../src/services/threads/custom-instructions.js";
import { seedStoredEvent, seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const REMOVED = /^None now\./u;

/** A thread whose user has `text` as custom instructions; `set` changes them. */
function setup(harness: TestAppHarness, text: string) {
  const { thread } = seedThreadFixture(harness);
  let current = text;
  setPluginAgentContributions({
    listInstructionContributions: () => [
      { pluginId: "custom-instructions", provider: () => current },
    ],
  } as never);
  const context = { threadId: thread.id, projectId: thread.projectId };
  return {
    thread,
    due: (fresh = false) => dueCustomInstructions(harness.deps.db, context, fresh),
    lost: () => markCustomInstructionsLost(harness.deps.db, thread.id),
    set: (next: string) => void (current = next),
  };
}

describe("custom instructions go out once per thread", () => {
  afterEach(() => setPluginAgentContributions(undefined));

  it("sends them on the first message, after a change, and every 20 messages", () =>
    withTestHarness(async (harness) => {
      const { due, set } = setup(harness, "Be concise.");
      expect(due()).toBe("Be concise.");
      expect(due()).toBe("");
      set("Be very concise.");
      expect(due()).toBe("Be very concise.");
      const next = Array.from({ length: 20 }, () => due());
      expect(next.filter(Boolean)).toEqual(["Be very concise."]);
      expect(next[19]).toBe("Be very concise.");
    }));

  it("sends them again after a compaction, however the harness reports it", () =>
    withTestHarness(async (harness) => {
      const { thread, due } = setup(harness, "Be concise.");
      due();
      seedStoredEvent(harness.deps, { threadId: thread.id, sequence: 1, scope: threadScope(), type: "thread/compacted", data: {} });
      expect(due()).toBe("Be concise.");
      expect(due()).toBe("");
      // Codex reports a compaction as a finished item.
      seedStoredEvent(harness.deps, { threadId: thread.id, sequence: 2, scope: turnScope("turn_1"), type: "item/completed", itemKind: "contextCompaction", data: {} });
      expect(due()).toBe("Be concise.");
      expect(due()).toBe("");
    }));

  it("sends them again when the copy may be lost, and for a new session", () =>
    withTestHarness(async (harness) => {
      const { due, lost } = setup(harness, "Be concise.");
      due();
      lost();
      expect(due()).toBe("Be concise.");
      expect(due()).toBe("");
      expect(due(true)).toBe("Be concise.");
    }));

  it("tells a thread once that they were removed, and again if that may be lost", () =>
    withTestHarness(async (harness) => {
      const { due, lost, set } = setup(harness, "Be concise.");
      due();
      set("");
      expect(due()).toMatch(REMOVED);
      expect(Array.from({ length: 25 }, () => due()).filter(Boolean)).toEqual([]);
      lost();
      expect(due()).toMatch(REMOVED);
      expect(due(true)).toMatch(REMOVED);
    }));

  it("sends nothing to a thread that never had any", () =>
    withTestHarness(async (harness) => {
      const { due, lost } = setup(harness, "");
      lost();
      expect(due()).toBe("");
      expect(due(true)).toBe("");
    }));
});
