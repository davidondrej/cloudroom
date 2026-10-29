import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { environments } from "@cloudroom/db";
import { threadSchema, type Thread } from "@cloudroom/domain";
import { createDeferredPromise } from "@cloudroom/test-helpers";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { hasLiveThreadStartInFlight } from "../../../../apps/server/src/services/threads/thread-lifecycle.js";
import {
  createHostThread,
  getEnvironment,
  getThreadEvents,
  getThreadOutput,
  sendTextMessage,
  stopThread,
} from "../../helpers/api.js";
import {
  waitForEnvironmentStatus,
  waitForThreadStatus,
} from "../../helpers/assertions.js";
import { createReadyReuseThread } from "../../helpers/fixtures.js";
import { withHarness, type IntegrationHarness } from "../../helpers/harness.js";
import { recordScriptedEchoRequests } from "../../helpers/scripted-echo.js";
import {
  createProjectFixture,
  createReadyThread,
  DEFAULT_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
} from "./shared.js";

async function visibleProvisioningStatuses(
  api: Parameters<typeof getThreadEvents>[0],
  threadId: string,
): Promise<string[]> {
  const events = await getThreadEvents(api, threadId);
  return events.flatMap((event) =>
    event.type === "system/thread-provisioning" &&
    !event.data.provisioningId.startsWith("thread-start:")
      ? [event.data.status]
      : [],
  );
}

type MissingWorkspace = { type: "unmanaged"; path: string };

async function failSetup(
  harness: IntegrationHarness,
  create?: (projectId: string, workspace: MissingWorkspace) => Promise<Thread>,
) {
  const record = await recordScriptedEchoRequests();
  onTestFinished(() => record.dispose());
  const project = await createProjectFixture(harness, "Setup Failure");
  const dir = path.join(
    path.dirname(harness.repoDir),
    `missing-${randomUUID()}`,
  );
  onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  const workspace: MissingWorkspace = { type: "unmanaged", path: dir };
  const options = { hostId: harness.hostId, projectId: project.id, workspace };
  const { id } = await (create?.(project.id, workspace) ??
    createHostThread(harness.api, options));
  const wait = (status: "error" | "idle") =>
    waitForThreadStatus(harness.api, id, status, TURN_TIMEOUT_MS);
  await wait("error");
  return {
    id,
    wait,
    fixSetup: () => fs.mkdir(dir),
    send: async (text: string, status: "error" | "idle") => {
      await sendTextMessage(harness.api, id, { text });
      await wait(status);
    },
    turnInputs: async () =>
      (await record.read()).flatMap((request) =>
        request.method === "turn/start" && request.params?.threadId === id
          ? [request.params.input]
          : [],
      ),
  };
}

const hidden = (text: string) => ({ text, visibility: "agent-only" as const });
const note = hidden(expect.stringContaining("workspace setup failed"));

describe.sequential("fake provider smoke reuse integration", () => {
  it("moves a thread to error and records failure events when environment provisioning fails", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(
        harness,
        "Provision Failure Smoke",
      );
      const missingPath = path.join(
        path.dirname(harness.repoDir),
        `missing-provision-${randomUUID()}`,
      );
      await fs.rm(missingPath, { recursive: true, force: true });

      const thread = await createHostThread(harness.api, {
        hostId: harness.hostId,
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: missingPath,
        },
      });
      const erroredThread = await waitForThreadStatus(
        harness.api,
        thread.id,
        "error",
        TURN_TIMEOUT_MS,
      );
      expect(erroredThread.environmentId).toBeNull();

      const events = await getThreadEvents(harness.api, thread.id);
      expect(
        events.some(
          (event) =>
            event.type === "system/thread-provisioning" &&
            event.data.status === "failed",
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "system/error" &&
            event.data.code === "thread_provisioning_failed",
        ),
      ).toBe(true);
    }));

  it("drops a stopped prompt, and keeps later failed ones through a retry", () =>
    withHarness(async (harness) => {
      const thread = await failSetup(harness);
      await stopThread(harness.api, thread.id);
      await thread.send("first", "error");
      await thread.send("second", "error");
      await thread.fixSetup();
      await harness.api.threads[":id"].retry.$post({
        param: { id: thread.id },
        json: { turnRequestId: null, sendAt: null, reason: "Retry" },
      });
      await thread.wait("idle");
      expect(await thread.turnInputs()).toMatchObject([
        [note, hidden("first"), hidden("second")],
      ]);
    }));

  it("cancels a scheduled retry once a follow-up carries its prompt", () =>
    withHarness(async (harness) => {
      const thread = await failSetup(harness);
      const sendAt = Date.now() + 60_000;
      await harness.api.threads[":id"].retry.$post({
        param: { id: thread.id },
        json: { turnRequestId: null, sendAt, reason: "Retry" },
      });
      await thread.fixSetup();
      await thread.send("continue", "idle");
      const queue = await harness.api.threads[":id"]["queued-messages"].$get({
        param: { id: thread.id },
      });
      expect(await queue.json()).toEqual([]);
      expect(await thread.turnInputs()).toMatchObject([
        [
          note,
          hidden("Reply with exactly READY and nothing else."),
          { text: "continue" },
        ],
      ]);
    }));

  it("sends a seed-only fork's seed once after its setup fails", () =>
    withHarness(async (harness) => {
      const seed = hidden("Work only in the new worktree.");
      const fork = await failSetup(harness, async (projectId, workspace) => {
        const { thread: source } = await createReadyThread(harness, {
          projectId,
          workspace: { type: "unmanaged", path: harness.repoDir },
        });
        const response = await harness.api.threads.fork.$post({
          json: {
            sourceThreadId: source.id,
            origin: "cli",
            visibility: "visible",
            agentContextSeed: [{ type: "text", mentions: [], ...seed }],
            environment: { type: "host", hostId: harness.hostId, workspace },
          },
        });
        return threadSchema.parse(await response.json());
      });
      await fork.fixSetup();
      await fork.send("go on", "idle");
      await fork.send("next", "idle");
      expect(await fork.turnInputs()).toMatchObject([
        [note, seed, { text: "go on" }],
        [{ text: "next" }],
      ]);
    }));

  it("reuses the same unmanaged environment when two host threads target the same path", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(
        harness,
        "Implicit Reuse Smoke",
      );
      const firstThread = await createReadyThread(harness, {
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });

      const secondThread = await createReadyThread(harness, {
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });

      expect(secondThread.thread.environmentId).toBe(
        firstThread.thread.environmentId,
      );
      expect(secondThread.environment.id).toBe(firstThread.environment.id);
    }));

  it("creates a reuse thread without provisioning a second environment", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, "Reuse Smoke");
      const { environment, thread } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });

      const reusedThread = await createReadyReuseThread(harness, {
        environmentId: environment.id,
        projectId: project.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      expect(reusedThread.thread.environmentId).toBe(thread.environmentId);
      expect(reusedThread.thread.status).toBe("idle");

      await sendTextMessage(harness.api, reusedThread.thread.id, {
        text: "reuse environment",
      });
      await waitForThreadStatus(
        harness.api,
        reusedThread.thread.id,
        "idle",
        TURN_TIMEOUT_MS,
      );

      const output = await getThreadOutput(harness.api, reusedThread.thread.id);
      const reusedEnvironment = await getEnvironment(
        harness.api,
        environment.id,
      );
      expect(reusedEnvironment.id).toBe(environment.id);
      expect(output).toContain("reuse environment");

      expect(
        await visibleProvisioningStatuses(harness.api, thread.id),
      ).not.toEqual([]);
      expect(
        await visibleProvisioningStatuses(harness.api, reusedThread.thread.id),
      ).toEqual([]);
    }));

  it.each([false, true])(
    "re-attaches a checkout whose row lost its path with delayed start acknowledgment: %s",
    (delayStartAcknowledgment) =>
      withHarness(async (harness) => {
        const acknowledgment = createDeferredPromise<void>();
        const requestRpc = harness.hub.requestHostOnlineRpc.bind(harness.hub);
        let delayedStart = false;
        const rpcSpy = vi
          .spyOn(harness.hub, "requestHostOnlineRpc")
          .mockImplementation(async (args) => {
            const response = await requestRpc(args);
            if (
              delayStartAcknowledgment &&
              !delayedStart &&
              args.message.command.type === "thread.start"
            ) {
              delayedStart = true;
              await acknowledgment.promise;
            }
            return response;
          });
        try {
          const project = await createProjectFixture(
            harness,
            "Checkout Reattach After Error",
          );
          const { environment, thread } = await createReadyThread(harness, {
            projectId: project.id,
            workspace: {
              type: "unmanaged",
              path: harness.repoDir,
            },
          });

          if (delayStartAcknowledgment) {
            expect(hasLiveThreadStartInFlight(thread.id)).toBe(true);
          }
          harness.db
            .update(environments)
            .set({
              path: null,
              status: "error",
              updatedAt: Date.now(),
            })
            .where(eq(environments.id, environment.id))
            .run();

          const response = await harness.api.threads[":id"].send.$post({
            param: { id: thread.id },
            json: {
              input: [
                { type: "text", text: "try checkout reattach", mentions: [] },
              ],
              mode: "auto",
            },
          });
          expect(response.status).toBe(200);
          acknowledgment.resolve();
          const readyThread = await waitForThreadStatus(
            harness.api,
            thread.id,
            "idle",
            TURN_TIMEOUT_MS,
          );
          const environmentId = readyThread.environmentId;
          if (environmentId === null) {
            throw new Error("Thread lost its environment after the re-attach");
          }
          expect(environmentId).not.toBe(environment.id);
          const reattached = await waitForEnvironmentStatus(
            harness.api,
            environmentId,
            "ready",
            TURN_TIMEOUT_MS,
          );
          expect(reattached.path).toBe(harness.repoDir);
          expect(reattached.environmentProviderId).toBe("project-checkout");
          expect(await getThreadOutput(harness.api, thread.id)).toContain(
            "try checkout reattach",
          );
        } finally {
          acknowledgment.resolve();
          rpcSpy.mockRestore();
        }
      }),
  );
});
