import { describe, expect, it, vi } from "vitest";
import { getThread, getThreadExecutionOverride } from "@cloudroom/db";
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
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
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

        const response = await patchThread(harness, thread.id, {
          model: provider.model,
          reasoningLevel: "high",
        });

        expect(response.status).toBe(200);
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
});
