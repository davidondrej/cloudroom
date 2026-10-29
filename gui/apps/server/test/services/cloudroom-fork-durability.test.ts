import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createThread, getThread } from "@cloudroom/db";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import { saveTeleportProgress } from "../../src/services/cloudroom/store.js";
import { withTestHarness } from "../helpers/test-app.js";
import { seedHostSession, seedProjectWithSource, seedThread } from "../helpers/seed.js";

type Internals = {
  holdChildReport(child: string, status: string, turn: string): Promise<void>;
  deliverChildReports(): Promise<void>;
  saveAgentFork(requestId: string, threadId: string): Promise<void>;
  agentFork(parent: unknown, client: unknown, record: unknown): Promise<void>;
  stop(): void;
  childTurnEnded?: (child: { id: string }, status: string) => void;
};

it("delivers a child report held during Teleport once, after the app restarts", async () => {
  await withTestHarness(async (harness) => {
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
    const parent = seedThread(harness.deps, { projectId: project.id });
    const child = createThread(harness.db, harness.hub, { projectId: project.id, parentThreadId: parent.id, executionTarget: "cloud", providerId: "codex", status: "idle" });
    const progress = { id: "teleport-1", owner: "test", completed: 0, total: 1 };
    saveTeleportProgress(harness.db, parent.id, { ...progress, phase: "uploading" });

    const before = cloudroom(harness.deps) as unknown as Internals;
    const lost = vi.fn();
    before.childTurnEnded = lost;
    await before.holdChildReport(child.id, "completed", "turn-1");
    before.stop();

    const after = new (before.constructor as new (deps: unknown) => Internals)(harness.deps);
    const reports = vi.fn();
    after.childTurnEnded = reports;
    saveTeleportProgress(harness.db, parent.id, { ...progress, phase: "complete" });
    await after.deliverChildReports();
    await after.deliverChildReports();

    expect(lost).not.toHaveBeenCalled();
    expect(reports).toHaveBeenCalledTimes(1);
    expect(reports.mock.calls[0]![0]).toMatchObject({ id: child.id, parentThreadId: parent.id });
    expect(reports.mock.calls[0]![1]).toBe("completed");
  });
});

it("answers a retried agent fork with its first thread after Teleport and 200 later requests", async () => {
  await withTestHarness(async (harness) => {
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
    const parent = seedThread(harness.deps, { projectId: project.id });
    const fork = seedThread(harness.deps, { projectId: project.id });
    const service = cloudroom(harness.deps) as unknown as Internals;
    const requestId = `fork_${createHash("sha256").update(`${parent.id}:fork_first`).digest("hex").slice(0, 40)}`;
    await service.saveAgentFork(requestId, fork.id);
    for (let i = 0; i < 205; i++) await service.saveAgentFork(`fork_later_${i}`, `thr_later_${i}`);

    const answerChild = vi.fn(async () => ({}));
    await service.agentFork(
      { threadId: parent.id, sessionId: "cr_parent", model: "gpt-6-luna", reasoning: "low" },
      { answerChild },
      { kind: "fork_request", sequence: 1, timestamp_ms: Date.now(), data: { id: "fork_first", prompt: "continue" } },
    );

    expect(answerChild).toHaveBeenCalledTimes(1);
    expect(answerChild).toHaveBeenCalledWith("cr_parent", "fork_first", { thread: fork.id });
    expect(getThread(harness.db, fork.id)?.archivedAt).toBeNull();
  });
});
