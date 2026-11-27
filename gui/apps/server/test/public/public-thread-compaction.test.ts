import { describe, expect, it } from "vitest";
import { getLatestThreadSequence, listQueuedThreadMessages } from "@cloudroom/db";
import {
  createStandaloneBuiltinCompactCommandInput,
  turnScope,
} from "@cloudroom/domain";
import type { ClientTurnRequestId } from "@cloudroom/domain";
import { applyTurnCompletedEvent } from "../../src/internal/turn-completed-events.js";
import { sendNextQueuedMessageIfPresent } from "../../src/services/threads/queued-messages.js";
import {
  registerHostRpcResponder,
  type HostRpcHandlerResult,
} from "../helpers/host-rpc.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";
import { createTestDaemonEventEnvelope, internalAuthHeaders } from "../helpers/commands.js";
import { groupHostDaemonEvents } from "@cloudroom/host-daemon-contract";

function seedCompactableThread(
  harness: TestAppHarness,
  args: { providerId: string; providerThreadId: string; status?: "active" },
) {
  const { host, session } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    providerId: args.providerId,
    status: args.status ?? "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: args.providerThreadId,
    threadId: thread.id,
  });
  return { host, session, thread };
}

function registerSuccessfulTurnResponder(
  harness: TestAppHarness,
  args: { hostId: string; sessionId: string },
) {
  return registerHostRpcResponder(harness, {
    ...args,
    handle: ({ command }): HostRpcHandlerResult => {
      if (command.type === "host.list_files") {
        return { ok: true, result: { files: [], truncated: false } };
      }
      if (command.type === "host.read_file") {
        return {
          ok: false,
          errorCode: "ENOENT",
          errorMessage: `Path does not exist: ${command.path}`,
        };
      }
      return { ok: true, result: { appliedAs: "new-turn" } };
    },
  });
}

function seedAcceptedProviderTurn(
  harness: TestAppHarness,
  args: {
    clientRequestId: ClientTurnRequestId;
    environmentId: string;
    providerThreadId: string;
    threadId: string;
    turnId: string;
  },
): void {
  seedTurnStarted(harness.deps, {
    environmentId: args.environmentId,
    providerThreadId: args.providerThreadId,
    threadId: args.threadId,
    turnId: args.turnId,
  });
  seedEvent(harness.deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    providerThreadId: args.providerThreadId,
    sequence:
      getLatestThreadSequence(harness.db, { threadId: args.threadId }) + 1,
    type: "turn/input/accepted",
    scope: turnScope(args.turnId),
    data: {
      providerThreadId: args.providerThreadId,
      clientRequestId: args.clientRequestId,
    },
  });
}

describe("public thread compaction", () => {
  it("dispatches the same structured /compact turn as the composer", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedCompactableThread(harness, {
        providerId: "pi",
        providerThreadId: "provider-thread-1",
      });
      const responder = registerSuccessfulTurnResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/compact`,
        { method: "POST" },
      );
      expect(
        response.status,
        JSON.stringify(await readJson(response.clone())),
      ).toBe(200);
      const turnSubmitRequests = responder.requests.filter(
        ({ command }) => command.type === "turn.submit",
      );
      expect(turnSubmitRequests).toHaveLength(1);
      expect(turnSubmitRequests[0]?.command).toMatchObject({
        type: "turn.submit",
        threadId: thread.id,
        input: createStandaloneBuiltinCompactCommandInput(),
        resumeContext: {
          providerId: "pi",
          providerThreadId: "provider-thread-1",
        },
      });
    });
  });

  it("compacts a literal /compact sent without the command chip (#913)", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedCompactableThread(harness, {
        providerId: "codex",
        providerThreadId: "provider-thread-literal",
      });
      const responder = registerSuccessfulTurnResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "steer-if-active",
            input: [{ type: "text", text: " /compact\n", mentions: [] }],
          }),
        },
      );
      expect(response.status).toBe(200);
      expect(
        responder.requests.find(({ command }) => command.type === "turn.submit")
          ?.command,
      ).toMatchObject({ input: createStandaloneBuiltinCompactCommandInput() });
    });
  });

  it("routes ACP agent compaction onto the bridge's /compact turn", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedCompactableThread(harness, {
        providerId: "acp-omp",
        providerThreadId: "provider-thread-acp",
      });
      const responder = registerSuccessfulTurnResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/compact`,
        { method: "POST" },
      );
      expect(
        response.status,
        JSON.stringify(await readJson(response.clone())),
      ).toBe(200);
      const turnSubmitRequests = responder.requests.filter(
        ({ command }) => command.type === "turn.submit",
      );
      expect(turnSubmitRequests).toHaveLength(1);
      expect(turnSubmitRequests[0]?.command).toMatchObject({
        type: "turn.submit",
        threadId: thread.id,
        input: createStandaloneBuiltinCompactCommandInput(),
        resumeContext: {
          providerId: "acp-omp",
          providerThreadId: "provider-thread-acp",
        },
      });
    });
  });

  it("queues sends and defers send-now while manual compaction is active", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedCompactableThread(harness, {
        providerId: "pi",
        providerThreadId: "provider-thread-queue",
      });
      const responder = registerSuccessfulTurnResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
      });

      const compactResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/compact`,
        { method: "POST" },
      );
      expect(compactResponse.status).toBe(200);
      const compactRequest = responder.requests.find(
        ({ command }) => command.type === "turn.submit",
      );
      if (!compactRequest || compactRequest.command.type !== "turn.submit") {
        throw new Error("Expected compaction turn.submit request");
      }
      if (!thread.environmentId) {
        throw new Error("Expected compactable thread environment");
      }
      const compactionTurnId = "turn-manual-compaction";
      seedAcceptedProviderTurn(harness, {
        clientRequestId: compactRequest.command.requestId,
        environmentId: thread.environmentId,
        providerThreadId: "provider-thread-queue",
        threadId: thread.id,
        turnId: compactionTurnId,
      });

      const sendResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "steer",
            input: [{ type: "text", text: "Send after compaction" }],
          }),
        },
      );
      expect(sendResponse.status).toBe(200);
      const [queuedMessage] = listQueuedThreadMessages(harness.db, thread.id);
      if (!queuedMessage) {
        throw new Error("Expected the send to remain queued");
      }

      const sendNowResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${queuedMessage.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "steer" }),
        },
      );
      expect(sendNowResponse.status).toBe(200);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);
      expect(
        responder.requests.filter(
          ({ command }) => command.type === "turn.submit",
        ),
      ).toHaveLength(1);

      expect(
        await sendNextQueuedMessageIfPresent(harness.deps, {
          threadId: thread.id,
        }),
      ).toBe(false);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: thread.environmentId,
        providerThreadId: "provider-thread-queue",
        sequence:
          getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
        type: "turn/completed",
        scope: turnScope(compactionTurnId),
        data: {
          providerThreadId: "provider-thread-queue",
          status: "completed",
        },
      });
      const completion = applyTurnCompletedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "provider-thread-queue",
        type: "turn/completed",
        scope: turnScope(compactionTurnId),
        status: "completed",
      });
      expect(completion.nextStatus).toBe("idle");
      expect(
        await sendNextQueuedMessageIfPresent(harness.deps, {
          threadId: thread.id,
        }),
      ).toBe(true);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
      await expect
        .poll(
          () =>
            responder.requests.filter(
              ({ command }) => command.type === "turn.submit",
            ).length,
        )
        .toBe(2);
    });
  });

  it("queues a busy thread's compaction, then its follow-up (`room-cli thread compact --self`)", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedCompactableThread(harness, {
        providerId: "pi",
        providerThreadId: "provider-thread-busy",
        status: "active",
      });
      // A running turn, such as a Goal's, that a send-now could steer into.
      seedTurnStarted(harness.deps, { threadId: thread.id, turnId: "turn-1" });
      const responder = registerSuccessfulTurnResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
      });

      const post = (path: string, body: object) =>
        harness.app.request(`/api/v1/threads/${thread.id}/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      await post("send", { mode: "queue-if-active", input: [{ type: "text", text: "Older message" }] });

      const response = await post("compact", { then: "Keep going" });
      expect(
        response.status,
        JSON.stringify(await readJson(response.clone())),
      ).toBe(200);
      // Send-now can't steer the compaction in, where it arrives as text (#2640).
      const [compaction] = listQueuedThreadMessages(harness.db, thread.id);
      const sendNow = await post(`queued-messages/${compaction?.id}/send`, {
        mode: "auto",
      });
      expect(sendNow.status).toBe(409);
      expect(
        responder.requests.filter(({ command }) => command.type === "turn.submit"),
      ).toHaveLength(0);
      // Compaction and its follow-up go before older messages.
      expect(
        listQueuedThreadMessages(harness.db, thread.id).map((row) => JSON.parse(row.content)),
      ).toMatchObject([
        createStandaloneBuiltinCompactCommandInput(),
        [{ type: "text", text: "Keep going" }],
        [{ type: "text", text: "Older message" }],
      ]);
      expect((await post("compact", {})).status).toBe(409);
    });
  });

  it("tells the follow-up how compaction went once its turn ends", async () => {
    await withTestHarness(async (harness) => {
      const providerThreadId = "provider-thread-follow-up";
      const { host, session, thread } = seedCompactableThread(harness, { providerId: "pi", providerThreadId });
      const responder = registerSuccessfulTurnResponder(harness, { hostId: host.id, sessionId: session.id });
      const submits = () => responder.requests.filter(({ command }) => command.type === "turn.submit");

      const response = await harness.app.request(`/api/v1/threads/${thread.id}/compact`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ then: "Keep going" }),
      });
      expect(response.status).toBe(200);
      const compact = submits()[0]?.command;
      if (compact?.type !== "turn.submit" || !thread.environmentId) throw new Error("Expected the compaction turn");
      seedAcceptedProviderTurn(harness, {
        clientRequestId: compact.requestId,
        environmentId: thread.environmentId,
        providerThreadId,
        threadId: thread.id,
        turnId: "turn-compact",
      });
      const scope = turnScope("turn-compact");
      const events = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: host.id }),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents([
            createTestDaemonEventEnvelope({ event: { type: "thread/compacted", threadId: thread.id, providerThreadId, scope } }),
            createTestDaemonEventEnvelope({
              event: { type: "turn/completed", threadId: thread.id, providerThreadId, scope, status: "completed" },
            }),
          ]),
        }),
      });
      expect(events.status).toBe(200);
      await expect.poll(() => submits().length).toBe(2);
      expect(JSON.stringify(submits()[1]?.command)).toContain("Your context was compacted.\\n\\nKeep going");
    });
  });

  it("rejects manual compaction for unsupported providers", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const unsupportedThread = seedThread(harness.deps, {
        projectId: project.id,
        providerId: "acp-cursor",
        status: "idle",
      });

      const unsupportedResponse = await harness.app.request(
        `/api/v1/threads/${unsupportedThread.id}/compact`,
        { method: "POST" },
      );
      expect(unsupportedResponse.status).toBe(409);
      await expect(readJson(unsupportedResponse)).resolves.toMatchObject({
        message: expect.stringContaining(
          "does not support manual context compaction",
        ),
      });
    });
  });
});
