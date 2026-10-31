import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import {
  cloudroomThreads,
  createThread,
  getEnvironment,
  getThread,
  listEvents,
  threads,
} from "@cloudroom/db";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  type PromptInput,
} from "@cloudroom/domain";
import { describe, expect, it, vi } from "vitest";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import { setMacAccess } from "../../src/services/cloudroom/previews.js";
import { validatePromptAttachmentReferences } from "../../src/services/projects/attachments.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { moveThreadToProject } from "../../src/services/threads/thread-move.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedStoredEvent,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function seedTwoProjects(harness: TestAppHarness, status: "idle" | "active") {
  const { host } = seedHostSession(harness.deps);
  const { project: from } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    name: "legal",
    path: "/tmp/move-from",
  });
  const { project: to } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    name: "cloudroom",
    path: "/tmp/move-to",
  });
  const oldEnvironment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: from.id,
    path: "/tmp/move-from",
    environmentProviderId: "git-worktree",
    providerOwnsPath: true,
  });
  const newEnvironment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: to.id,
    path: "/tmp/move-to",
  });
  const thread = seedThread(harness.deps, {
    projectId: from.id,
    environmentId: oldEnvironment.id,
    status,
  });
  seedStoredEvent(harness.deps, {
    threadId: thread.id,
    sequence: 1,
    type: "client/turn/requested",
    scope: threadScope(),
    data: {
      direction: "outbound",
      requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
      input: [{ type: "text", text: "Draft the contract", mentions: [] }],
      target: { kind: "thread-start" },
      execution: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
        source: "client/turn/requested",
      },
      initiator: "user",
      senderThreadId: null,
      request: { method: "turn/start", params: {} },
      source: "tell",
    },
  });
  return { thread, to, oldEnvironment, newEnvironment };
}

function move(harness: TestAppHarness, threadId: string, projectId: string) {
  return harness.app.request(`/api/v1/threads/${threadId}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId }),
  });
}

function seedCloudThread(harness: TestAppHarness, status: "idle" | "active") {
  const { host } = seedHostSession(harness.deps);
  const { project: from } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    name: "app",
    path: "/tmp/move-from",
  });
  const { project: to } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    name: "keys",
    path: "/tmp/move-to",
  });
  const thread = createThread(harness.db, harness.hub, {
    projectId: from.id,
    executionTarget: "cloud",
    providerId: "codex",
    status,
  });
  const moveProject = vi
    .spyOn(cloudroom(harness.deps), "moveProject")
    .mockResolvedValue(null);
  return { thread, from, to, moveProject };
}

function refusedMoves(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId }).filter((event) => {
    const data = JSON.parse(event.data) as {
      operation?: string;
      status?: string;
    };
    return (
      event.type === "system/operation" &&
      data.operation === "thread_move" &&
      data.status === "failed"
    );
  });
}

async function releaseOldRuntime(harness: TestAppHarness, threadId: string) {
  const stop = await waitForQueuedCommand(
    harness,
    ({ command }) =>
      command.type === "thread.stop" && command.threadId === threadId,
  );
  await reportQueuedCommandSuccess(harness, stop, {
    providerCheckpointId: null,
  });
}

describe("thread move", () => {
  it("moves the label and folder together, keeps the old worktree, and seeds the new project", async () => {
    await withTestHarness(async (harness) => {
      const { thread, to, oldEnvironment, newEnvironment } = seedTwoProjects(
        harness,
        "idle",
      );

      const pending = move(harness, thread.id, "Cloudroom");
      await releaseOldRuntime(harness, thread.id);
      const response = await pending;

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        moved: true,
        previousPath: "/tmp/move-from",
      });
      const moved = getThread(harness.db, thread.id);
      expect(moved?.projectId).toBe(to.id);
      expect(moved?.environmentId).toBe(newEnvironment.id);
      const switches = listEvents(harness.db, { threadId: thread.id }).filter(
        (event) =>
          event.type === "system/operation" &&
          JSON.parse(event.data).operation === "harness_switch",
      );
      expect(switches).toHaveLength(1);
      const seed = (
        JSON.parse(switches[0]!.data) as { metadata: { seed: PromptInput[] } }
      ).metadata.seed;
      expect(seed).toHaveLength(2);
      await validatePromptAttachmentReferences({
        dataDir: harness.config.dataDir,
        projectId: to.id,
        input: seed,
      });
      expect(getEnvironment(harness.db, oldEnvironment.id)).toMatchObject({
        environmentProviderId: null,
        retireAt: null,
      });
    });
  });

  it("waits for a running turn to end, then moves", async () => {
    await withTestHarness(async (harness) => {
      const { thread, to } = seedTwoProjects(harness, "active");

      const response = await move(harness, thread.id, to.id);

      expect(await response.json()).toMatchObject({ moved: false });
      expect(getThread(harness.db, thread.id)?.projectId).not.toBe(to.id);
      harness.db
        .update(threads)
        .set({ status: "idle" })
        .where(eq(threads.id, thread.id))
        .run();
      const ready = runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });
      await releaseOldRuntime(harness, thread.id);
      await ready;
      expect(getThread(harness.db, thread.id)?.projectId).toBe(to.id);
    });
  });

  it("runs a Cloud agent's own move only while Mac access is Full", async () => {
    await withTestHarness(async (harness) => {
      const { thread, from, to, moveProject } = seedCloudThread(
        harness,
        "idle",
      );
      const moveRequest = cloudroom(harness.deps).moveRequest!;

      moveRequest(thread.id, to.id);
      await vi.waitFor(() =>
        expect(refusedMoves(harness, thread.id)).toHaveLength(1),
      );
      expect(moveProject).not.toHaveBeenCalled();
      expect(getThread(harness.db, thread.id)?.projectId).toBe(from.id);

      await setMacAccess(harness.deps, "full");
      moveRequest(thread.id, to.id);
      await vi.waitFor(() => expect(moveProject).toHaveBeenCalledTimes(1));
      expect(moveProject.mock.calls[0]![1]).toBe(to.id);
    });
  });

  it("never runs a Cloud agent's own move from a sandbox with a key list, even with Full Mac access", async () => {
    const answers: [number, object][] = [
      [200, { secrets: [".env"], found: true }],
      [503, { error: "Sandbox records are unavailable." }],
      [200, { secrets: null, found: false }],
      [200, { secrets: null, found: true }],
    ];
    const asked: unknown[] = [];
    const website = createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      const input = JSON.parse(text || "{}") as { action?: string };
      const [status, body] =
        input.action === "secrets" ? answers.shift()! : [404, {}];
      if (input.action === "secrets") asked.push(input);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    website.listen(0, "127.0.0.1");
    await once(website, "listening");
    const { port } = website.address() as AddressInfo;
    try {
      await withTestHarness(async (harness) => {
        const { thread, from, to, moveProject } = seedCloudThread(
          harness,
          "idle",
        );
        harness.db
          .insert(cloudroomThreads)
          .values({
            threadId: thread.id,
            coreUrl: "sandbox:thr_lead",
            sessionId: "cr_run",
            startRequestId: "start_run",
            model: "gpt-5",
            reasoning: "medium",
          })
          .run();
        await setMacAccess(harness.deps, "full");
        const service = cloudroom(harness.deps);
        (service.sandboxes as { account: () => Promise<unknown> }).account =
          async () => ({
            website: `http://127.0.0.1:${port}`,
            userId: "11111111-1111-4111-8111-111111111111",
            token: "a".repeat(64),
          });

        for (const refused of [1, 2, 3]) {
          service.moveRequest!(thread.id, to.id);
          await vi.waitFor(() =>
            expect(refusedMoves(harness, thread.id)).toHaveLength(refused),
          );
        }
        expect(
          refusedMoves(harness, thread.id).map(
            (event) => (JSON.parse(event.data) as { message: string }).message,
          ),
        ).toEqual([
          expect.stringContaining(
            "only the API keys picked for its Cloud loop",
          ),
          expect.stringContaining("couldn't confirm this sandbox's API keys"),
          expect.stringContaining("couldn't confirm this sandbox's API keys"),
        ]);
        expect(moveProject).not.toHaveBeenCalled();
        expect(getThread(harness.db, thread.id)?.projectId).toBe(from.id);

        service.moveRequest!(thread.id, to.id);
        await vi.waitFor(() => expect(moveProject).toHaveBeenCalledTimes(1));
        expect(asked).toEqual(
          Array(4).fill({ action: "secrets", thread: "thr_lead" }),
        );
      });
    } finally {
      website.closeAllConnections();
      website.close();
    }
  });

  it("checks a queued Cloud agent move again when its turn ends", async () => {
    await withTestHarness(async (harness) => {
      const { thread, to, moveProject } = seedCloudThread(harness, "active");
      await setMacAccess(harness.deps, "full");

      const queued = await moveThreadToProject(
        harness.deps,
        thread.id,
        to.id,
        "cloud-agent",
      );
      expect(queued.moved).toBe(false);
      await setMacAccess(harness.deps, "off");
      harness.db
        .update(threads)
        .set({ status: "idle" })
        .where(eq(threads.id, thread.id))
        .run();
      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });

      expect(moveProject).not.toHaveBeenCalled();
      expect(refusedMoves(harness, thread.id)).toHaveLength(1);
    });
  });
});
