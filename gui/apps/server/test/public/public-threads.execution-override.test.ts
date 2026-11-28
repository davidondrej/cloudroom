import { describe, expect, it, vi } from "vitest";
import {
  getThread,
  getThreadExecutionOverride,
  listEvents,
  setThreadExecutionOverride,
} from "@cloudroom/db";
import { turnScope } from "@cloudroom/domain";
import {
  registerHostRpcResponder,
  registerProviderHostRpcResponder,
  type HostRpcHandlerResult,
} from "../helpers/host-rpc.js";
import { readJson } from "../helpers/json.js";
import {
  catalogAnswer,
  healthAnswer,
  modelList,
} from "../helpers/provider-model-catalogs.js";
import { availableModelFixture } from "../helpers/available-models.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedStoredEvent,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import type { TestAppHarness } from "../helpers/test-app.js";

function stubProviderCatalog(
  harness: TestAppHarness,
  hostId: string,
  sessionId: string,
  providerId: string,
  model: string,
): void {
  registerProviderHostRpcResponder(harness, {
    hostId,
    sessionId,
    modelsByProviderId: {
      [providerId]: {
        models: [
          {
            id: model,
            model,
            displayName: model,
            description: "",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "" },
              { reasoningEffort: "medium", description: "" },
              { reasoningEffort: "high", description: "" },
              { reasoningEffort: "xhigh", description: "" },
              { reasoningEffort: "max", description: "" },
            ],
            defaultReasoningEffort: "medium",
            isDefault: true,
          },
        ],
        selectedOnlyModels: [],
      },
    },
  });
}

function seedProviderThread(
  harness: TestAppHarness,
  providerId = "claude-code",
) {
  const { host, session } = seedHostSession(harness.deps, {
    id: `host-override-${providerId}`,
  });
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    providerId,
  });
  return { host, session, thread };
}

function patchThread(harness: TestAppHarness, threadId: string, body: unknown) {
  return harness.app.request(`/api/v1/threads/${threadId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /threads/:id execution override", () => {
  for (const provider of [
    { id: "codex", model: "gpt-5.6-sol" },
    { id: "claude-code", model: "claude-opus-4-8" },
    { id: "pi", model: "openai/gpt-5.4" },
    { id: "acp-cursor", model: "gpt-5.3-codex" },
  ]) {
    it(`persists a catalog-scoped model + reasoning override for ${provider.id}`, async () => {
      await withTestHarness(async (harness) => {
        const { host, session, thread } = seedProviderThread(
          harness,
          provider.id,
        );
        stubProviderCatalog(
          harness,
          host.id,
          session.id,
          provider.id,
          provider.model,
        );

        const rejected = await patchThread(harness, thread.id, { idleSessionOnly: true, providerId: "other", model: provider.model });
        expect(rejected.status).toBe(409);
        const response = await patchThread(harness, thread.id, {
          idleSessionOnly: true,
          providerId: provider.id,
          model: provider.model,
          reasoningLevel: "high",
        });

        expect(response.status).toBe(200);
        const reopened = await harness.app.request(`/api/v1/threads/${thread.id}/default-execution-options`);
        expect(await reopened.json()).toMatchObject({ model: provider.model, reasoningLevel: "high" });
        expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
          modelOverride: provider.model,
          reasoningLevelOverride: "high",
        });
      });
    });
  }

  it("rejects a model that is not in the provider's catalog", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedProviderThread(harness);
      stubProviderCatalog(
        harness,
        host.id,
        session.id,
        "claude-code",
        "claude-opus-4-8",
      );

      const response = await patchThread(harness, thread.id, {
        model: "gpt-5",
      });

      expect(response.status).toBe(400);
      const body = await readJson(response);
      expect(JSON.stringify(body)).toContain(
        "not available in this thread's claude-code model catalog",
      );
      expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
        modelOverride: null,
        reasoningLevelOverride: null,
      });
    });
  });

  // #856: a failed turn can leave the host running one, which refuses the new agent.
  function registerSwitchHost(
    harness: TestAppHarness,
    ids: { host: { id: string }; session: { id: string } },
    options: {
      refusesStart?: boolean;
      stop?: () => Promise<HostRpcHandlerResult>;
    } = {},
  ): void {
    let staleTurn = true;
    registerHostRpcResponder(harness, {
      hostId: ids.host.id,
      sessionId: ids.session.id,
      handle: ({ command }) => {
        if (command.type === "provider.health") return healthAnswer("ready");
        if (command.type === "provider.list_models")
          return catalogAnswer(modelList("gpt-5"));
        if (command.type === "host.list_files")
          return { ok: true, result: { files: [], truncated: false } };
        if (command.type === "thread.stop") {
          if (options.stop) return options.stop();
          // Like the host, a plain release keeps a running turn.
          if (command.intent !== "release" || command.immediate)
            staleTurn = false;
          return { ok: true, result: { providerCheckpointId: null } };
        }
        if (
          command.type === "thread.start" &&
          !staleTurn &&
          !options.refusesStart
        )
          return { ok: true, result: { providerThreadId: "codex-1" } };
        if (command.type === "thread.start")
          return { ok: false, errorCode: "busy", errorMessage: "turn busy" };
        return { ok: false, errorCode: "ENOENT", errorMessage: "missing" };
      },
    });
  }
  const resendToCodex = { providerId: "codex", model: "gpt-5", resend: true };

  for (const refusesStart of [false, true]) {
    it(
      refusesStart
        ? "fails a resend whose new agent the host refuses to start"
        : "releases a turn the host still runs, then starts the new agent",
      async () => {
        await withTestHarness(async (harness) => {
          const seeded = seedProviderThread(harness);
          registerSwitchHost(harness, seeded, { refusesStart });

          const response = await patchThread(
            harness,
            seeded.thread.id,
            resendToCodex,
          );

          expect(response.status).toBe(refusesStart ? 502 : 200);
          expect(await readJson(response)).toMatchObject(
            refusesStart
              ? {
                  code: "resend_failed",
                  message: expect.stringContaining("turn busy"),
                }
              : { resend: "started", status: "active" },
          );
          expect(getThread(harness.db, seeded.thread.id)?.providerId).toBe(
            "codex",
          );
        });
      },
    );
  }

  it("answers before the relay's 30 s when the old agent is slow to stop, and never switches later", async () => {
    await withTestHarness(async (harness) => {
      const seeded = seedProviderThread(harness);
      let stopped: (() => void) | undefined;
      registerSwitchHost(harness, seeded, {
        stop: () =>
          new Promise((resolve) => {
            stopped = () =>
              resolve({ ok: true, result: { providerCheckpointId: null } });
          }),
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        const response = patchThread(harness, seeded.thread.id, resendToCodex);
        await vi.waitFor(() => expect(stopped).toBeDefined());
        await vi.advanceTimersByTimeAsync(20_000);

        expect((await response).status).toBe(504);
        stopped!();
        await vi.advanceTimersByTimeAsync(0);
        expect(getThread(harness.db, seeded.thread.id)?.providerId).toBe(
          "claude-code",
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("reconciles xhigh effort on a Local switch to Grok so ordinary and automated sends succeed (#2692)", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedProviderThread(
        harness,
        "claude-code",
      );
      const sender = seedThread(harness.deps, {
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        providerId: "claude-code",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: thread.environmentId!,
        model: "claude-opus-4-8",
        reasoningLevel: "xhigh",
        providerThreadId: "claude-1",
        threadId: thread.id,
      });
      const startedLevels: string[] = [];
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: ({ command }) => {
          if (command.type === "provider.health") return healthAnswer("ready");
          if (command.type === "provider.list_models") {
            return catalogAnswer([
              availableModelFixture({
                model: "grok-4.5",
                reasoningLevels: ["low", "medium", "high"],
                defaultReasoningLevel: "medium",
              }),
            ]);
          }
          if (command.type === "host.list_files")
            return { ok: true, result: { files: [], truncated: false } };
          if (command.type === "thread.stop") {
            // Stopping saves the old agent's last reply, which the new agent's seed must include.
            seedStoredEvent(harness.deps, {
              threadId: thread.id,
              sequence: 10,
              type: "item/completed",
              scope: turnScope("turn-1"),
              itemKind: "agentMessage",
              data: {
                item: {
                  id: "reply",
                  type: "agentMessage",
                  text: "Saved on stop",
                },
              },
            });
            return { ok: true, result: { providerCheckpointId: null } };
          }
          if (command.type === "thread.start") {
            startedLevels.push(command.options.reasoningLevel);
            return { ok: true, result: { providerThreadId: "grok-1" } };
          }
          return { ok: false, errorCode: "ENOENT", errorMessage: "missing" };
        },
      });

      const prepareSpy = vi.spyOn(harness.db.$client, "prepare");
      const switched = await patchThread(harness, thread.id, {
        providerId: "acp-grok",
        model: "grok-4.5",
      });
      expect(switched.status).toBe(200);
      expect(
        prepareSpy.mock.calls.filter(
          ([source]) =>
            typeof source === "string" &&
            (source.startsWith(
              'select "model_override", "reasoning_level_override" from "threads"',
            ) ||
              // The inherited effort comes from the history read, not a latest-turn read.
              source.startsWith(
                'select "created_at", "data", "sequence", "thread_id", "type" from "events"',
              )),
        ),
      ).toHaveLength(0);
      prepareSpy.mockRestore();
      expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
        modelOverride: "grok-4.5",
        reasoningLevelOverride: "high",
      });
      const switchEvent = listEvents(harness.db, { threadId: thread.id }).find(
        (event) => JSON.parse(event.data).operation === "harness_switch",
      );
      expect(switchEvent?.data).toContain("Saved on stop");

      const send = (body: Record<string, unknown>) =>
        harness.app.request(`/api/v1/threads/${thread.id}/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "steer-if-active",
            input: [{ type: "text", text: "follow-up", mentions: [] }],
            ...body,
          }),
        });

      expect((await send({})).status).toBe(200);
      expect(startedLevels).toEqual(["high"]);
      const tell = await send({ senderThreadId: sender.id });
      expect(tell.status).toBe(200);
      expect(await readJson(tell)).toMatchObject({
        queuedMessage: { reasoningLevel: "high" },
      });
      expect((await send({ reasoningLevel: "xhigh" })).status).toBe(400);
    });
  });

  it("preserves explicit null, model-catalog levels, and saved effort on model-only sends (#2692)", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedProviderThread(
        harness,
        "acp-cursor",
      );
      seedThreadRuntimeState(harness.deps, {
        environmentId: thread.environmentId!,
        model: "glm-5",
        reasoningLevel: "max",
        providerThreadId: "cursor-1",
        threadId: thread.id,
      });
      setThreadExecutionOverride(harness.db, {
        threadId: thread.id,
        modelOverride: null,
        reasoningLevelOverride: "max",
      });
      const sentOptions: Array<{ model: string; reasoningLevel: string }> = [];
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: ({ command }) => {
          if (command.type === "provider.health") return healthAnswer("ready");
          if (command.type === "provider.list_models") {
            return catalogAnswer(
              command.providerId === "acp-grok"
                ? [
                    availableModelFixture({
                      model: "grok-4.5",
                      reasoningLevels: ["low", "medium", "high"],
                      defaultReasoningLevel: "medium",
                    }),
                  ]
                : [
                    availableModelFixture({
                      model: "glm-5",
                      reasoningLevels: ["high", "max"],
                      defaultReasoningLevel: "high",
                    }),
                    availableModelFixture({
                      model: "gpt-5.6-sol",
                      reasoningLevels: [
                        "none",
                        "low",
                        "medium",
                        "high",
                        "xhigh",
                        "max",
                      ],
                      defaultReasoningLevel: "high",
                    }),
                    availableModelFixture({
                      model: "claude-opus-5",
                      reasoningLevels: [
                        "none",
                        "low",
                        "medium",
                        "high",
                        "xhigh",
                        "max",
                      ],
                      defaultReasoningLevel: "high",
                    }),
                    availableModelFixture({
                      model: "composer-2.5",
                      reasoningLevels: ["medium"],
                      defaultReasoningLevel: "medium",
                    }),
                  ],
            );
          }
          if (command.type === "host.list_files")
            return { ok: true, result: { files: [], truncated: false } };
          if (command.type === "thread.stop")
            return { ok: true, result: { providerCheckpointId: null } };
          if (
            command.type === "turn.submit" ||
            command.type === "thread.start"
          ) {
            sentOptions.push({
              model: command.options.model,
              reasoningLevel: command.options.reasoningLevel,
            });
            return {
              ok: true,
              result: { turnId: "t2", providerThreadId: "cursor-1" },
            };
          }
          return { ok: false, errorCode: "ENOENT", errorMessage: "missing" };
        },
      });
      await harness.deps.lifecycleDedupers.providerModelCatalogs.read(
        harness.deps,
        {
          cwd: null,
          hostId: host.id,
          provider: harness.deps.providerRegistry.get("acp-cursor")!.info,
          access: { kind: "picker" },
        },
      );

      // Model-only send runs composer-2.5 at medium without failing against glm-5 or overwriting saved max.
      const tellRes = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "steer-if-active",
            model: "composer-2.5",
            input: [{ type: "text", text: "one-off", mentions: [] }],
          }),
        },
      );
      expect(tellRes.status).toBe(200);
      expect(sentOptions).toEqual([
        { model: "composer-2.5", reasoningLevel: "medium" },
      ]);
      expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
        modelOverride: null,
        reasoningLevelOverride: "max",
      });

      // Explicit reasoningLevel: null clears the override on harness switch.
      const clearSwitch = await patchThread(harness, thread.id, {
        providerId: "acp-grok",
        model: "grok-4.5",
        reasoningLevel: null,
      });
      expect(clearSwitch.status).toBe(200);
      expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
        modelOverride: "grok-4.5",
        reasoningLevelOverride: null,
      });

      // Switching to a model catalog offering `none` succeeds even when the provider ladder omits `none`,
      // stays `none` on flagless send, and stays `none` when changing only the model to another `none`-capable model.
      const noneSwitch = await patchThread(harness, thread.id, {
        providerId: "acp-cursor",
        model: "gpt-5.6-sol",
        reasoningLevel: "none",
      });
      expect(noneSwitch.status).toBe(200);
      expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
        modelOverride: "gpt-5.6-sol",
        reasoningLevelOverride: "none",
      });
      const noneDefaults = await harness.app.request(
        `/api/v1/threads/${thread.id}/default-execution-options`,
      );
      expect(await readJson(noneDefaults)).toMatchObject({
        model: "gpt-5.6-sol",
        reasoningLevel: "none",
      });

      const noneSend = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "steer-if-active",
            input: [{ type: "text", text: "flagless", mentions: [] }],
          }),
        },
      );
      expect(noneSend.status).toBe(200);
      expect(sentOptions).toEqual([
        { model: "composer-2.5", reasoningLevel: "medium" },
        { model: "gpt-5.6-sol", reasoningLevel: "none" },
      ]);

      const modelOnlySwitch = await patchThread(harness, thread.id, {
        model: "claude-opus-5",
      });
      expect(modelOnlySwitch.status).toBe(200);
      expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
        modelOverride: "claude-opus-5",
        reasoningLevelOverride: "none",
      });

      const opusDefaults = await harness.app.request(
        `/api/v1/threads/${thread.id}/default-execution-options`,
      );
      expect(await readJson(opusDefaults)).toMatchObject({
        model: "claude-opus-5",
        reasoningLevel: "none",
      });
    });
  });
});
