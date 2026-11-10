import { threadScope, turnScope } from "@cloudroom/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAppSettings, setAppSettings, updateHost } from "@cloudroom/db";
import { setPluginAgentContributions } from "../../src/services/plugins/plugin-agent-contributions.js";
import {
  dueCustomInstructions,
  markCustomInstructionsLost,
  cloudroomSystemPrompt,
  prepareCustomInstructionInput,
  prepareCloudInstructionInput,
} from "../../src/services/threads/custom-instructions.js";
import { seedHostSession, seedStoredEvent, seedThreadFixture } from "../helpers/seed.js";
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

describe("agent machine context", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["linux", "Linux"],
    ["darwin", "macOS"],
    ["win32", "Windows"],
    ["wsl", "Linux (WSL)"],
    ["unknown", "unknown"],
  ] as const)("identifies a Local %s host separately from the paired computer", (platform, label) =>
    withTestHarness(async ({ deps }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      const prompt = cloudroomSystemPrompt(deps.db, "local", { executionPlatform: platform });
      expect(prompt).toContain(`Thread execution: Local; execution OS: ${label}; paired computer OS: Linux.`);
      if (platform === "win32") expect(prompt).not.toContain("read the `computer-use` skill");
    }));

  it("identifies Linux Cloud execution even when the paired computer is a Mac", () =>
    withTestHarness(async ({ deps }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      expect(cloudroomSystemPrompt(deps.db, "cloud")).toContain(
        "Thread execution: Cloud; execution OS: Linux; paired computer OS: macOS.",
      );
    }));

  it("refreshes ordinary Local messages from the current host without losing their content", () =>
    withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      const { host } = seedHostSession(harness.deps, { platform: "linux" });
      updateHost(harness.db, harness.hub, host.id, { platform: "linux" });
      const context = { threadId: thread.id, projectId: thread.projectId, hostId: host.id };
      const input = [{ type: "text" as const, text: "Continue.", mentions: [] }];
      const prepare = () => prepareCustomInstructionInput(harness.db, context, { input, inputGroups: [input] });
      const first = prepare();
      expect(first.input[0]).toEqual(input[0]);
      expect(first.input.at(-1)).toMatchObject({ visibility: "agent-only", text: expect.stringContaining("execution OS: Linux;") });
      expect(first.inputGroups).toEqual([first.input]);
      updateHost(harness.db, harness.hub, host.id, { platform: "darwin" });
      expect(prepare().input.at(-1)).toMatchObject({ text: expect.stringContaining("execution OS: macOS;") });
      const compact = [{ type: "text" as const, text: "/compact", mentions: [{ start: 0, end: 8, resource: { kind: "command" as const, trigger: "/" as const, name: "compact", source: "command" as const, origin: "builtin" as const, label: "compact", argumentHint: null } }] }];
      expect(prepareCustomInstructionInput(harness.db, context, { input: compact }).input).toEqual(compact);
      setAppSettings(harness.db, { ...getAppSettings(harness.db), systemPromptEnabled: false });
      expect(prepare().input).toEqual(input);
    }));

  it("refreshes Cloud text and structured content, counts its bytes, and honors the setting", () =>
    withTestHarness(async ({ db }) => {
      const input = { text: "Continue.", content: [{ type: "text", text: "Continue." }] };
      const prepare = (limit = 10_000) => prepareCloudInstructionInput(input, "", limit, db);
      const result = prepare();
      expect(result.text).toContain("Thread execution: Cloud; execution OS: Linux;");
      expect(result.content).toEqual([input.content[0], { type: "text", text: expect.stringContaining("Thread execution: Cloud;") }]);
      expect(() => prepare(Buffer.byteLength(result.text, "utf8") - 1)).toThrow("too long");
      setAppSettings(db, { ...getAppSettings(db), systemPromptEnabled: false });
      expect(prepare().text).toBe(input.text);
      expect(prepare().content).toEqual(input.content);
    }));
});
