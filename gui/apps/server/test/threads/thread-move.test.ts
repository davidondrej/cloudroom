import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import {
  cloudroomThreads,
  createThread,
  environments,
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
import { resolveDeferredFirstTurnContext } from "../../src/services/threads/deferred-first-turn-context.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { moveThreadToProject } from "../../src/services/threads/thread-move.js";
import {
  hasPendingWorktreeAutoContinue,
  requestThreadWorktreeMove,
} from "../../src/services/threads/thread-worktree-move.js";
import {
  registerTestHostRpcCapture,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { installFakeGitWorktreeProvider } from "../helpers/environment-provider.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
  seedQueuedMessage,
  seedStoredEvent,
  seedThread,
  seedTurnStarted,
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

  it.each([
    ["personal-workspace", null],
    ["git-worktree", "git-worktree"],
  ])(
    "moves off a %s folder shared only by an archived thread still stopping; its provider becomes %s (#1955)",
    async (providerId, after) => {
    await withTestHarness(async (harness) => {
      const { thread, oldEnvironment } = seedTwoProjects(harness, "idle");
      harness.db
        .update(environments)
        .set({ environmentProviderId: providerId })
        .where(eq(environments.id, oldEnvironment.id))
        .run();
      const sibling = seedThread(harness.deps, {
        projectId: thread.projectId,
        environmentId: oldEnvironment.id,
      });
      harness.db
        .update(threads)
        .set({ archivedAt: Date.now(), status: "stopping" })
        .where(eq(threads.id, sibling.id))
        .run();

      const pending = move(harness, thread.id, "Cloudroom");
      await releaseOldRuntime(harness, thread.id);
      expect((await pending).status).toBe(200);
      // A detached Personal folder is never removed; a worktree stays with
      // its provider, so main's save-and-park cleanup runs once it stops.
      expect(
        getEnvironment(harness.db, oldEnvironment.id)?.environmentProviderId,
      ).toBe(after);
    });
  },
  );

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

  it("refuses a busy Local thread's move to Personal at once", async () => {
    await withTestHarness(async (harness) => {
      const { thread, oldEnvironment } = seedTwoProjects(harness, "active");

      const response = await move(harness, thread.id, "Personal");

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        message:
          "Local threads can't be moved to Personal yet. Start a new thread there.",
      });
      // A user's own project named Personal wins over the built-in one.
      seedProjectWithSource(harness.deps, {
        hostId: oldEnvironment.hostId!,
        name: "Personal",
        path: "/tmp/move-own-personal",
      });
      const own = await move(harness, thread.id, "personal");
      expect(await own.json()).toMatchObject({ moved: false });
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

  it("tells the agent's next turn when its worktree move failed", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/not-a-checkout",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/not-a-checkout",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "claude-code",
        status: "active",
      });

      requestThreadWorktreeMove(harness.deps, thread.id, []);
      expect(resolveDeferredFirstTurnContext(harness.db, thread)).toBeNull();
      harness.db
        .update(threads)
        .set({ status: "idle" })
        .where(eq(threads.id, thread.id))
        .run();
      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });

      expect(getThread(harness.db, thread.id)?.environmentId).toBe(
        environment.id,
      );
      // A turn that never carried the note, like one the harness starts itself, leaves it pending.
      seedTurnStarted(harness.deps, { threadId: thread.id, turnId: "bg-turn" });
      const [note] = resolveDeferredFirstTurnContext(harness.db, thread)!.input;
      expect(note).toMatchObject({ visibility: "agent-only" });
      expect(note?.type === "text" && note.text).toContain(
        "could not move this thread to a new worktree, so it still runs in /tmp/not-a-checkout",
      );
    });
  });
});

describe("thread worktree", () => {
  it("reads the new worktree's hooks from the source's base, not from the thread's own commit", async () => {
    await withTestHarness(async (harness) => {
      seedPrimaryHost(harness.deps, seedHostSession(harness.deps, { id: "host-primary" }).host.id);
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-move-hooks",
      });
      // Like the real daemon: setup never runs as a hook operation, so it can't cancel one (#2216).
      registerTestHostRpcCapture(harness.deps, {
        hostId: host.id,
        sessionId: session.id,
        onEnvironmentHookCancel: async () => ({ status: "unknown" }),
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id, path: "/tmp/move-hooks-checkout" });
      const folder = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/move-hooks-checkout",
        mergeBaseBranch: "origin/main",
      });
      const thread = seedThread(harness.deps, { projectId: project.id, environmentId: folder.id });
      // The moved worktree starts from (and compares against) the thread's own commit, which its agent may have made.
      installFakeGitWorktreeProvider(() => ({
        action: "ready",
        environment: { type: "host", hostId: host.id, path: "/tmp/move-hooks-worktree", ownsPath: true, mergeBaseBranch: "abc123" },
      }));
      expect(
        (
          await harness.app.request(`/api/v1/threads/${thread.id}/worktree`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ carry: [] }),
          })
        ).status,
      ).toBe(200);
      const status = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "workspace.status" && command.environmentId === folder.id,
      );
      await reportQueuedCommandSuccess(harness, status, {
        outcome: "available",
        workspaceStatus: {
          workingTree: { insertions: 0, deletions: 0, lineStatsComplete: true, files: [], hasUncommittedChanges: false, state: "clean" },
          branch: { currentBranch: "room/t", defaultBranch: "main" },
          checkout: { kind: "branch", branchName: "room/t", headSha: "abc123" },
          mergeBase: null,
        },
      });
      const attach = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "environment.attach" && command.path === "/tmp/move-hooks-worktree",
        5_000,
      );
      expect(attach.command).toMatchObject({ setupScriptTimeoutMs: 15 * 60 * 1000, hookBaseBranch: "origin/main" });
      // An older daemon answers a reused environment ID with its cached runtime's old, deleted folder (#2216).
      await reportQueuedCommandSuccess(harness, attach, {
        path: "/tmp/move-hooks-old",
        isGitRepo: true,
        isWorktree: true,
        branchName: "room/t",
        defaultBranch: "main",
      });
      // The move fails, the thread stays put, and its new worktree is removed instead of blocking cleanup forever.
      const { environmentId } = attach.command as { environmentId: string };
      await vi.waitFor(
        () =>
          expect(
            listEvents(harness.db, { threadId: thread.id })
              .map((event) => JSON.parse(event.data).message)
              .at(-1),
          ).toContain("old folder open (/tmp/move-hooks-old)"),
        { timeout: 3000 },
      );
      expect(
        getEnvironment(harness.db, environmentId)?.teardownStatus,
      ).toBe("removed");
      expect(getThread(harness.db, thread.id)?.environmentId).toBe(folder.id);
    });
  });

  it("moves a thread on another computer only without --carry, reading HEAD on that computer (#1572)", async () => {
    await withTestHarness(async (harness) => {
      const worktrees = installFakeGitWorktreeProvider(() => ({ action: "reject", message: "stop here" }));
      seedPrimaryHost(harness.deps, seedHostSession(harness.deps, { id: "host-primary" }).host.id);
      const { host } = seedHostSession(harness.deps, { id: "host-enrolled" });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id, path: "/tmp/enrolled-checkout" });
      const folder = seedEnvironment(harness.deps, { hostId: host.id, projectId: project.id, path: "/tmp/enrolled-checkout" });
      const thread = seedThread(harness.deps, { projectId: project.id, environmentId: folder.id });
      const request = (carry: string[]) =>
        harness.app.request(`/api/v1/threads/${thread.id}/worktree`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ carry }),
        });

      expect((await request(["notes.md"])).status).toBe(409);
      expect((await request([])).status).toBe(200);
      const status = await waitForQueuedCommand(
        harness,
        ({ row, command }) => row.hostId === host.id && command.type === "workspace.status" && command.environmentId === folder.id,
      );
      await reportQueuedCommandSuccess(harness, status, {
        outcome: "available",
        workspaceStatus: {
          workingTree: { insertions: 0, deletions: 0, lineStatsComplete: true, files: [], hasUncommittedChanges: false, state: "clean" },
          branch: { currentBranch: "main", defaultBranch: "main" },
          checkout: { kind: "branch", branchName: "main", headSha: "abc123" },
          mergeBase: null,
        },
      });
      // The worktree starts from the enrolled host's HEAD; the move then fails and the thread stays put.
      expect((await worktrees.waitForProvision()).inputs).toMatchObject({ branch: { kind: "named", name: "abc123" } });
      await vi.waitFor(() =>
        expect(listEvents(harness.db, { threadId: thread.id }).map((event) => JSON.parse(event.data))).toContainEqual(
          expect.objectContaining({ operation: "thread_worktree_move", status: "failed" }),
        ), { timeout: 5000 });
      expect(getThread(harness.db, thread.id)?.environmentId).toBe(folder.id);
    });
  });

  async function answerRemoteWorktreeMove(
    harness: TestAppHarness,
    hostId: string,
    threadId: string,
    folderId: string,
    worktreePath: string,
  ): Promise<void> {
    const status = await waitForQueuedCommand(
      harness,
      ({ row, command }) =>
        row.hostId === hostId &&
        command.type === "workspace.status" &&
        command.environmentId === folderId,
    );
    await reportQueuedCommandSuccess(harness, status, {
      outcome: "available",
      workspaceStatus: {
        workingTree: {
          insertions: 0,
          deletions: 0,
          lineStatsComplete: true,
          files: [],
          hasUncommittedChanges: false,
          state: "clean",
        },
        branch: { currentBranch: "main", defaultBranch: "main" },
        checkout: { kind: "branch", branchName: "main", headSha: "abc123" },
        mergeBase: null,
      },
    });
    const attach = await waitForQueuedCommand(
      harness,
      ({ row, command }) =>
        row.hostId === hostId &&
        command.type === "environment.attach" &&
        command.path === worktreePath,
      5_000,
    );
    await reportQueuedCommandSuccess(harness, attach, {
      path: worktreePath,
      isGitRepo: true,
      isWorktree: true,
      branchName: "room/t",
      defaultBranch: "main",
    });
    await releaseOldRuntime(harness, threadId);
  }

  function turnRequests(harness: TestAppHarness, threadId: string) {
    return listEvents(harness.db, { threadId })
      .filter((event) => event.type === "client/turn/requested")
      .map((event) => JSON.parse(event.data) as { input: PromptInput[] });
  }

  it("resumes an active thread automatically once its worktree move completes", async () => {
    await withTestHarness(async (harness) => {
      seedPrimaryHost(
        harness.deps,
        seedHostSession(harness.deps, { id: "host-primary-resume" }).host.id,
      );
      const { host } = seedHostSession(harness.deps, { id: "host-resume" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/move-resume-checkout",
      });
      const folder = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/move-resume-checkout",
        mergeBaseBranch: "origin/main",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: folder.id,
        providerId: "claude-code",
        status: "active",
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
          input: [{ type: "text", text: "Move to a worktree and redesign the chart", mentions: [] }],
          target: { kind: "thread-start" },
          execution: {
            model: "claude-opus-4-6",
            serviceTier: "default",
            reasoningLevel: "high",
            permissionMode: "full",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
          request: { method: "turn/start", params: {} },
          source: "tell",
        },
      });
      installFakeGitWorktreeProvider(() => ({
        action: "ready",
        environment: {
          type: "host",
          hostId: host.id,
          path: "/tmp/move-resume-worktree",
          ownsPath: true,
          mergeBaseBranch: "abc123",
        },
      }));

      const moveResult = requestThreadWorktreeMove(harness.deps, thread.id, []);
      expect(moveResult.deferred).toBe(true);
      expect(hasPendingWorktreeAutoContinue(thread.id)).toBe(true);
      harness.db
        .update(threads)
        .set({ status: "idle" })
        .where(eq(threads.id, thread.id))
        .run();

      const dispatch = runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });
      await answerRemoteWorktreeMove(
        harness,
        host.id,
        thread.id,
        folder.id,
        "/tmp/move-resume-worktree",
      );
      await dispatch;
      expect(hasPendingWorktreeAutoContinue(thread.id)).toBe(false);

      const updated = getThread(harness.db, thread.id)!;
      expect(getEnvironment(harness.db, updated.environmentId!)?.path).toBe(
        "/tmp/move-resume-worktree",
      );
      const requests = turnRequests(harness, thread.id);
      expect(requests).toHaveLength(2);
      expect(requests[1]!.input).toEqual([
        expect.objectContaining({
          type: "text",
          visibility: "agent-only",
          text: expect.stringContaining("/tmp/move-resume-worktree"),
        }),
        expect.objectContaining({
          type: "text",
          visibility: "agent-only",
          text: expect.stringContaining("Continue the user's request in the new worktree"),
        }),
      ]);
    });
  });

  it("resumes fresh-session providers with history seed and preserves path note if continuation fails", async () => {
    await withTestHarness(async (harness) => {
      seedPrimaryHost(
        harness.deps,
        seedHostSession(harness.deps, { id: "host-primary-extra" }).host.id,
      );
      const { host } = seedHostSession(harness.deps, { id: "host-extra" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/move-extra-checkout",
      });
      const folder = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/move-extra-checkout",
        mergeBaseBranch: "origin/main",
      });
      let worktreePath = "/tmp/move-extra-pi";
      installFakeGitWorktreeProvider(() => ({
        action: "ready",
        environment: {
          type: "host",
          hostId: host.id,
          path: worktreePath,
          ownsPath: true,
          mergeBaseBranch: "abc123",
        },
      }));

      // 1. Fresh-session provider (resumesInNewFolder: false) auto-resumes with historySeed + nudge.
      const piThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: folder.id,
        providerId: "pi",
        status: "active",
      });
      seedStoredEvent(harness.deps, {
        threadId: piThread.id,
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
          input: [{ type: "text", text: "Move to a worktree and fix the bug", mentions: [] }],
          target: { kind: "thread-start" },
          execution: {
            model: "anthropic/claude-sonnet-4-5",
            serviceTier: "default",
            reasoningLevel: "high",
            permissionMode: "full",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
          request: { method: "turn/start", params: {} },
          source: "tell",
        },
      });
      requestThreadWorktreeMove(harness.deps, piThread.id, []);
      harness.db.update(threads).set({ status: "idle" }).where(eq(threads.id, piThread.id)).run();
      const piDispatch = runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: piThread.id,
      });
      await answerRemoteWorktreeMove(harness, host.id, piThread.id, folder.id, worktreePath);
      await piDispatch;
      const piRequests = turnRequests(harness, piThread.id);
      expect(piRequests).toHaveLength(2);
      expect(piRequests[1]!.input.some((block) => block.type === "text" && block.text.includes(worktreePath))).toBe(true);
      expect(piRequests[1]!.input.at(-1)).toMatchObject({
        type: "text",
        visibility: "agent-only",
        text: expect.stringContaining("Continue the user's request in the new worktree"),
      });

      // 2. If auto-resume dispatch fails (e.g. missing model), the path note still waits for the next turn.
      worktreePath = "/tmp/move-extra-failed-resume";
      const failedResumeThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: folder.id,
        providerId: "claude-code",
        status: "active",
      });
      requestThreadWorktreeMove(harness.deps, failedResumeThread.id, []);
      harness.db.update(threads).set({ status: "idle" }).where(eq(threads.id, failedResumeThread.id)).run();
      const failedDispatch = runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: failedResumeThread.id,
      });
      await answerRemoteWorktreeMove(harness, host.id, failedResumeThread.id, folder.id, worktreePath);
      await failedDispatch;
      expect(turnRequests(harness, failedResumeThread.id)).toHaveLength(0);
      expect(resolveDeferredFirstTurnContext(harness.db, failedResumeThread)?.input[0]).toMatchObject({
        visibility: "agent-only",
        text: expect.stringContaining(worktreePath),
      });
    });
  });

  it("skips auto-resume for idle moves, external moves, manual stops, and when a user message is queued", async () => {
    await withTestHarness(async (harness) => {
      seedPrimaryHost(
        harness.deps,
        seedHostSession(harness.deps, { id: "host-primary-skip" }).host.id,
      );
      const { host } = seedHostSession(harness.deps, { id: "host-skip" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/move-skip-checkout",
      });
      const folder = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/move-skip-checkout",
        mergeBaseBranch: "origin/main",
      });
      let worktreePath = "/tmp/move-skip-idle";
      installFakeGitWorktreeProvider(() => ({
        action: "ready",
        environment: {
          type: "host",
          hostId: host.id,
          path: worktreePath,
          ownsPath: true,
          mergeBaseBranch: "abc123",
        },
      }));

      // 1. Idle thread moved externally: never wakes up, returns deferred: false, next turn gets the path note.
      const idleThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: folder.id,
        providerId: "claude-code",
        status: "idle",
      });
      expect(requestThreadWorktreeMove(harness.deps, idleThread.id, [], { self: false }).deferred).toBe(false);
      await answerRemoteWorktreeMove(
        harness,
        host.id,
        idleThread.id,
        folder.id,
        worktreePath,
      );
      await vi.waitFor(() =>
        expect(
          getEnvironment(
            harness.db,
            getThread(harness.db, idleThread.id)!.environmentId!,
          )?.path,
        ).toBe(worktreePath),
      );
      expect(turnRequests(harness, idleThread.id)).toHaveLength(0);
      expect(
        resolveDeferredFirstTurnContext(harness.db, idleThread)?.input[0],
      ).toMatchObject({
        visibility: "agent-only",
        text: expect.stringContaining(worktreePath),
      });

      // 2. Active thread moved by another caller (self: false): never auto-resumes or suppresses parent notifications.
      worktreePath = "/tmp/move-skip-external";
      const externalThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: folder.id,
        providerId: "claude-code",
        status: "active",
      });
      expect(
        requestThreadWorktreeMove(harness.deps, externalThread.id, [], { self: false }).deferred,
      ).toBe(true);
      expect(hasPendingWorktreeAutoContinue(externalThread.id)).toBe(false);
      harness.db.update(threads).set({ status: "idle" }).where(eq(threads.id, externalThread.id)).run();
      const externalDispatch = runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: externalThread.id,
      });
      await answerRemoteWorktreeMove(harness, host.id, externalThread.id, folder.id, worktreePath);
      await externalDispatch;
      expect(turnRequests(harness, externalThread.id)).toHaveLength(0);
      expect(resolveDeferredFirstTurnContext(harness.db, externalThread)?.input[0]).toMatchObject({
        visibility: "agent-only",
        text: expect.stringContaining(worktreePath),
      });

      // 2. Active thread manually stopped before move completes: never wakes up.
      worktreePath = "/tmp/move-skip-stopped";
      const stoppedThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: folder.id,
        providerId: "claude-code",
        status: "active",
      });
      requestThreadWorktreeMove(harness.deps, stoppedThread.id, []);
      seedEvent(harness.deps, {
        threadId: stoppedThread.id,
        sequence: 99,
        type: "system/thread/interrupted",
        scope: threadScope(),
        data: { reason: "manual-stop" },
      });
      harness.db
        .update(threads)
        .set({ status: "idle" })
        .where(eq(threads.id, stoppedThread.id))
        .run();
      const stoppedDispatch = runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: stoppedThread.id,
      });
      await answerRemoteWorktreeMove(
        harness,
        host.id,
        stoppedThread.id,
        folder.id,
        worktreePath,
      );
      await stoppedDispatch;
      expect(turnRequests(harness, stoppedThread.id)).toHaveLength(0);

      // 3. Queued user message wins over synthetic auto-resume and receives the new path note.
      worktreePath = "/tmp/move-skip-queued";
      const queuedThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: folder.id,
        providerId: "claude-code",
        status: "active",
      });
      requestThreadWorktreeMove(harness.deps, queuedThread.id, []);
      seedQueuedMessage(harness.deps, {
        threadId: queuedThread.id,
        content: [{ type: "text", text: "Now build it", mentions: [] }],
      });
      harness.db
        .update(threads)
        .set({ status: "idle" })
        .where(eq(threads.id, queuedThread.id))
        .run();
      const queuedDispatch = runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: queuedThread.id,
      });
      await answerRemoteWorktreeMove(
        harness,
        host.id,
        queuedThread.id,
        folder.id,
        worktreePath,
      );
      await queuedDispatch;
      const requests = turnRequests(harness, queuedThread.id);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.input).toEqual([
        expect.objectContaining({
          type: "text",
          visibility: "agent-only",
          text: expect.stringContaining(worktreePath),
        }),
        expect.objectContaining({ type: "text", text: "Now build it" }),
      ]);
    });
  });
});
