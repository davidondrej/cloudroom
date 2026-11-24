import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./bridge.js";
import {
  FULL_ACCESS_SESSION_OPTIONS,
  stubFakeCodexAppServer,
} from "./fake-codex-app-server-harness.js";

const THREAD_ID = "thr_resume_hydration";
const PROVIDER_THREAD_ID = "codex-resume-hydration";
const GOAL_SOURCE_ID = "codex-with-goal";
const REWIND_THREAD_ID = `${THREAD_ID}:rewind:lease-1`;
const NEW_FORK_THREAD_ID = "thr_new_fork";

let harness: ReturnType<typeof createBridgeJsonRpcTestHarness>;
let workspaceDir: string;
let requestLogPath: string;
let goalStatePath: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-codex-resume-hydration-"));
  requestLogPath = join(workspaceDir, "requests.jsonl");
  const scriptPath = join(workspaceDir, "script.json");
  goalStatePath = join(workspaceDir, "goals.json");
  writeGoals({ [GOAL_SOURCE_ID]: goal("Ship #857", "active", 9000, 8000) });
  const script = { requestLogPath, goalStatePath };
  writeFileSync(scriptPath, JSON.stringify(script), "utf8");
  stubFakeCodexAppServer(scriptPath);
  harness = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(async () => {
  const threadIds = [THREAD_ID, REWIND_THREAD_ID, NEW_FORK_THREAD_ID];
  for (const [index, threadId] of threadIds.entries()) {
    const cleanupId = 993_001 + index;
    harness.sendRequest(cleanupId, "thread/stop", {
      threadId,
      providerThreadId: PROVIDER_THREAD_ID,
      intent: "release",
      activeTurnId: null,
    });
    await harness.waitForResponse(cleanupId).catch(() => undefined);
  }
  harness.restore();
  vi.unstubAllEnvs();
  rmSync(workspaceDir, { recursive: true, force: true });
});

it("excludes turn history when it resumes a Codex thread", async () => {
  harness.sendRequest(1, "thread/resume", {
    threadId: THREAD_ID,
    providerThreadId: PROVIDER_THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: { ...FULL_ACCESS_SESSION_OPTIONS },
  });
  expect((await harness.waitForResponse(1)).error).toBeUndefined();

  expect(readRequests()).toContainEqual({
    method: "thread/resume",
    params: expect.objectContaining({ excludeTurns: true }),
  });
});

it("keeps the current Goal and its remaining budget through repeated edits (#857)", async () => {
  let id = 2;
  const construct = async (method: string, params: object) => {
    harness.sendRequest(++id, method, {
      ...params,
      cwd: workspaceDir,
      instructionMode: "append",
      options: { ...FULL_ACCESS_SESSION_OPTIONS },
    });
    const response = await harness.waitForResponse(id);
    expect(response.error).toBeUndefined();
    return (response.result as { providerThreadId: string }).providerThreadId;
  };
  const fork = (threadId: string, source: string, replaces?: string) =>
    construct("thread/fork", {
      threadId,
      sourceProviderThreadId: source,
      ...(replaces ? { replacesProviderThreadId: replaces } : {}),
    });
  // Each edit retains history from the original native thread, while the
  // Goal lives on the thread's current one.
  const edit = async (current: string) =>
    fork(THREAD_ID, await fork(REWIND_THREAD_ID, GOAL_SOURCE_ID), current);
  const edited = await edit(GOAL_SOURCE_ID);
  const goals = readGoals();
  expect(goals[edited]).toMatchObject(goal("Ship #857", "paused", 1000, 0));
  goals[edited] = goal("Exhausted", "budgetLimited", 500, 700);
  writeGoals(goals);
  const changed = await edit(edited);
  expect(readGoals()[changed]).toMatchObject(
    goal("Exhausted", "budgetLimited", 1, 0),
  );
  // Editing the first message starts a new native thread instead of forking.
  const restarted = await construct("thread/start", {
    threadId: THREAD_ID,
    replacesProviderThreadId: changed,
  });
  expect(readGoals()[restarted]).toMatchObject(
    goal("Exhausted", "budgetLimited", 1, 0),
  );
  writeGoals({});
  await edit(restarted);
  await fork(NEW_FORK_THREAD_ID, GOAL_SOURCE_ID);

  expect(readGoals()).toEqual({});
  const goalStates = harness.messages.flatMap((message) => {
    if (!("method" in message) || message.method !== "thread/delta") return [];
    const { threadId, deltas } = message.params as GoalDeltas;
    return deltas
      .filter((delta) => delta.kind === "extension.state")
      .map((delta) => [threadId, delta.payload]);
  });
  expect(goalStates).toEqual([
    [
      THREAD_ID,
      expect.objectContaining({ objective: "Ship #857", tokenBudget: 1000 }),
    ],
    [
      THREAD_ID,
      expect.objectContaining({ objective: "Exhausted", tokenBudget: 1 }),
    ],
    [
      THREAD_ID,
      expect.objectContaining({ objective: "Exhausted", tokenBudget: 1 }),
    ],
    [THREAD_ID, null],
  ]);
});

type GoalDeltas = {
  threadId: string;
  deltas: { kind: string; payload?: unknown }[];
};

function goal(objective: string, status: string, budget: number, used: number) {
  return { objective, status, tokenBudget: budget, tokensUsed: used };
}

function readGoals(): Record<string, unknown> {
  return JSON.parse(readFileSync(goalStatePath, "utf8"));
}

function writeGoals(goals: Record<string, unknown>): void {
  writeFileSync(goalStatePath, JSON.stringify(goals));
}

function readRequests(): { method: string; params: unknown }[] {
  return readFileSync(requestLogPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
