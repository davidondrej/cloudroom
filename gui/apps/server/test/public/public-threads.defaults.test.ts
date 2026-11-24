import {
  provisionHostMock,
  resumeHostMock,
} from "./public-thread-test-harness.js";

import {
  createProjectSource,
  getProjectExecutionDefaults,
  listThreadsWithPendingInteractionState,
  replaceStoredProviderModelCatalog,
  setExperiments,
  upsertProjectExecutionDefaults,
} from "@cloudroom/db";
import { defaultExperiments, threadSchema } from "@cloudroom/domain";
import { sidebarBootstrapResponseSchema } from "@cloudroom/server-contract";
import { registerTestHostRpcCapture, waitForQueuedCommand } from "../helpers/commands.js";
import { availableModelFixture } from "../helpers/available-models.js";
import { registerHostRpcResponder, registerProviderHostRpcResponder } from "../helpers/host-rpc.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
  seedThreadRuntimeState,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import { installFakeGitWorktreeProvider } from "../helpers/environment-provider.js";
import { beforeEach, describe, expect, it } from "vitest";

describe("public thread default routes", () => {
  beforeEach(() => {
    provisionHostMock.mockReset();
    resumeHostMock.mockReset();
  });

  it("remembers resolved execution options after thread creation", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-create",
      });
      seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-create",
      });

      const create = (text = "Create with explicit execution options") =>
        harness.app.request("/api/v1/threads", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            origin: "app",
            requestId: "create-once",
            projectId: project.id,
            providerId: "codex",
            model: "gpt-5-mini",
            serviceTier: "fast",
            reasoningLevel: "high",
            permissionMode: "workspace-write",
            input: [{ type: "text", text }],
            environment: {
              type: "host",
              hostId: host.id,
              workspace: {
                type: "unmanaged",
                path: null,
              },
            },
          }),
        });
      const response = await create();

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      // A retry with the same request ID gets that thread, not a duplicate (#860).
      const retried = threadSchema.parse(await readJson(await create()));
      expect(retried.id).toBe(createdThread.id);
      expect((await create("Create with other options")).status).toBe(409);
      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === createdThread.id,
      );
      expect(queuedStart.command).toMatchObject({
        options: {
          model: "gpt-5-mini",
          serviceTier: "fast",
          reasoningLevel: "high",
          permissionMode: "accept-edits",
          permissionEscalation: "ask",
        },
      });
      expect(
        getProjectExecutionDefaults(harness.db, {
          projectId: project.id,
        }),
      ).toEqual({
        providerId: "codex",
        model: "gpt-5-mini",
        serviceTier: "fast",
        reasoningLevel: "high",
        permissionMode: "accept-edits",
      });
    });
  });

  it("allows managed-worktree threads on a secondary host", async () => {
    await withTestHarness(async (harness) => {
      const provider = installFakeGitWorktreeProvider();
      const { host: localHost } = seedHostSession(harness.deps, {
        id: "host-managed-default",
      });
      seedPrimaryHost(harness.deps, localHost.id);
      const { host: secondaryHost } = seedHostSession(harness.deps, {
        id: "host-managed-secondary",
      });
      setExperiments(harness.db, {
        ...defaultExperiments,
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: localHost.id,
        path: "/tmp/default-managed-source",
      });
      const secondarySource = createProjectSource(harness.db, harness.hub, {
        projectId: project.id,
        type: "local_path",
        hostId: secondaryHost.id,
        path: "/tmp/secondary-managed-source",
      });
      if (secondarySource.type !== "local_path") {
        throw new Error("Expected local_path project source");
      }

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          origin: "app",
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          title: "Secondary host thread",
          input: [{ type: "text", text: "Build it on the secondary host" }],
          environment: {
            type: "host",
            hostId: secondaryHost.id,
            workspace: {
              type: "managed-worktree",
              baseBranch: { kind: "default" },
            },
          },
        }),
      });

      expect(response.status).toBe(201);
      const thread = threadSchema.parse(await readJson(response));
      const context = await provider.waitForProvision();
      expect(context.thread.id).toBe(thread.id);
      expect(context.host?.id).toBe(secondaryHost.id);
      expect(context.inputs).toEqual({ branch: { kind: "default" } });
      expect(secondarySource.path).toBe("/tmp/secondary-managed-source");
    });
  });

  it("does not remember project defaults after CLI-origin thread creation", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-cli-origin",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-cli-origin",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          origin: "cli",
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5-mini",
          serviceTier: "fast",
          reasoningLevel: "high",
          permissionMode: "workspace-write",
          input: [
            { type: "text", text: "Create without mutating project defaults" },
          ],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(201);
      expect(
        getProjectExecutionDefaults(harness.db, {
          projectId: project.id,
        }),
      ).toBeNull();
    });
  });

  it("inherits the remembered provider and execution defaults when thread creation omits them", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-inherit",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-inherit",
      });

      upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: "codex",
        model: "gpt-5",
        serviceTier: "fast",
        reasoningLevel: "high",
        permissionMode: "accept-edits",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          origin: "app",
          projectId: project.id,
          input: [{ type: "text", text: "Create with inherited defaults" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === createdThread.id,
      );
      expect(queuedStart.command).toMatchObject({
        options: {
          model: "gpt-5",
          serviceTier: "fast",
          reasoningLevel: "high",
          permissionMode: "accept-edits",
          permissionEscalation: "ask",
        },
      });
    });
  });

  // A failed listing still returns fallback entries; they must not rewrite the model. A stalled one must not delay the start.
  it.each([
    ["claude-opus-5.5", "claude-opus-5-5", "listed"],
    ["claude-opus-5.5[1m]", "claude-opus-5-5[1m]", "listed"],
    ["claude-opus-5.5[1m]", "claude-opus-5.5[1m]", "fails"],
    ["claude-opus-5.5", "claude-opus-5.5", "stalls"],
  ])("starts remembered %s as %s when the listing %s (#2202)", async (stored, expected, listing) => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const ids = { hostId: host.id, sessionId: session.id };
      const models = [availableModelFixture({ model: stored.replace(".", "-") })];
      if (listing === "stalls") {
        registerHostRpcResponder(harness, { ...ids, handle: () => (registerTestHostRpcCapture(harness, ids), new Promise(() => {})) });
      } else {
        registerProviderHostRpcResponder(harness, {
          ...ids, restoreCommandCaptureAfterResponse: true,
          modelsByProviderId: { "claude-code": { models, selectedOnlyModels: [] } },
          ...(listing === "fails" ? { modelErrorsByProviderId: { "claude-code": { errorCode: "command_timeout", errorMessage: "slow" } } } : {}),
        });
      }
      const startedAt = Date.now();
      const path = "/tmp/thread-defaults-dotted-model";
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id, path });
      const environment = seedEnvironment(harness.deps, { hostId: host.id, projectId: project.id, path });
      upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id, providerId: "claude-code", model: stored,
        serviceTier: "default", reasoningLevel: "high", permissionMode: "accept-edits",
      });
      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin: "cli", projectId: project.id, input: [{ type: "text", text: "Spawn without --model" }],
          environment: { type: "reuse", environmentId: environment.id },
        }),
      });
      const { id } = threadSchema.parse(await readJson(response));
      const { command } = await waitForQueuedCommand(harness, ({ command }) => command.type === "thread.start" && command.threadId === id);
      expect(command).toMatchObject({ options: { model: expected, reasoningLevel: "high" } });
      expect(Date.now() - startedAt).toBeLessThan(3_500);
    });
  }, 10_000);

  it("uses the explicit provider catalog default when stored defaults belong to another provider", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      registerProviderHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        restoreCommandCaptureAfterResponse: true,
        modelsByProviderId: {
          "claude-code": {
            models: [
              availableModelFixture({
                model: "claude-opus-catalog-default",
                isDefault: true,
              }),
            ],
            selectedOnlyModels: [],
          },
        },
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-provider-mismatch",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-provider-mismatch",
      });

      upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: "codex",
        model: "gpt-5",
        serviceTier: "fast",
        reasoningLevel: "high",
        permissionMode: "accept-edits",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          origin: "app",
          projectId: project.id,
          providerId: "claude-code",
          input: [
            { type: "text", text: "Create with mismatched provider defaults" },
          ],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === createdThread.id,
      );
      expect(queuedStart.command).toMatchObject({
        options: { model: "claude-opus-catalog-default" },
      });
    });
  });

  it("uses the catalog isDefault model when provider and project defaults are omitted", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const providerResponder = registerProviderHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        restoreCommandCaptureAfterResponse: true,
        modelsByProviderId: {
          "claude-code": {
            models: [
              availableModelFixture({ model: "claude-first" }),
              availableModelFixture({
                model: "claude-provider-default",
                isDefault: true,
              }),
            ],
            selectedOnlyModels: [],
          },
        },
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-missing",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-missing",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          origin: "app",
          projectId: project.id,
          input: [{ type: "text", text: "Create without defaults" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === createdThread.id,
      );
      expect(queuedStart.command).toMatchObject({
        providerId: "claude-code",
        options: { model: "claude-provider-default" },
      });
      expect(
        providerResponder.requests.map((request) => request.command),
      ).toMatchObject([
        {
          type: "provider.list_models",
          providerId: "claude-code",
        },
      ]);
      expect(providerResponder.requests[0].command).not.toHaveProperty("cwd");
    });
  });

  it("starts a model given without a level at that model's default (#656)", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      registerProviderHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        restoreCommandCaptureAfterResponse: true,
        modelsByProviderId: {
          codex: {
            models: [
              availableModelFixture({ model: "gpt-first", isDefault: true }),
              availableModelFixture({
                model: "gpt-xhigh",
                reasoningLevels: ["high", "xhigh"],
                defaultReasoningLevel: "xhigh",
              }),
            ],
            selectedOnlyModels: [],
          },
        },
      });
      const path = "/tmp/thread-defaults-model-only";
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path,
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin: "cli",
          projectId: project.id,
          providerId: "codex",
          model: "gpt-xhigh",
          input: [{ type: "text", text: "Spawn with --model only" }],
          environment: { type: "reuse", environmentId: environment.id },
        }),
      });

      const { id } = threadSchema.parse(await readJson(response));
      const { command } = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === id,
      );
      expect(command).toMatchObject({ options: { reasoningLevel: "xhigh" } });
    });
  });

  it("starts opencode at a level it accepts when the default or saved level is none (#2239)", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const model = "opencode-go/no-think";
      registerProviderHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        restoreCommandCaptureAfterResponse: true,
        modelsByProviderId: {
          "acp-opencode": {
            models: [
              availableModelFixture({
                model,
                reasoningLevels: ["none", "high", "max"],
                defaultReasoningLevel: "none",
              }),
              availableModelFixture({
                model: "opencode-go/none-only",
                reasoningLevels: ["none"],
              }),
            ],
            selectedOnlyModels: [],
          },
        },
      });
      const path = "/tmp/thread-defaults-opencode-none";
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path,
      });
      const start = async (
        reasoningLevel?: string,
        origin = "cli",
        startModel = model,
      ) => {
        const response = await harness.app.request("/api/v1/threads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            origin,
            projectId: project.id,
            providerId: "acp-opencode",
            model: startModel,
            ...(reasoningLevel ? { reasoningLevel } : {}),
            input: [{ type: "text", text: "Spawn" }],
            environment:
              origin === "cli"
                ? { type: "reuse", environmentId: environment.id }
                : {
                    type: "host",
                    hostId: host.id,
                    workspace: { type: "unmanaged", path: null },
                  },
          }),
        });
        if (response.status !== 201) return response.status;
        const { id } = threadSchema.parse(await readJson(response));
        const { command } = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.start" && command.threadId === id,
        );
        return command.type === "thread.start"
          ? command.options.reasoningLevel
          : null;
      };

      expect(await start()).toBe("high");
      // A model sharing no level with the provider fails as on main.
      expect(await start(undefined, "cli", "opencode-go/none-only")).toBe(400);
      // An app start is saved as the project default, so it reconciles nothing, as on main.
      expect(await start(undefined, "app")).toBe(400);
      expect(
        getProjectExecutionDefaults(harness.deps.db, { projectId: project.id }),
      ).toBeNull();
      upsertProjectExecutionDefaults(harness.deps.db, {
        projectId: project.id,
        providerId: "acp-opencode",
        model,
        reasoningLevel: "none",
        permissionMode: "full",
        serviceTier: "default",
      });
      expect(await start()).toBe("high");
      // A start saved as the project default keeps main's behavior, so the saved level stays.
      expect(await start(undefined, "app")).toBe(400);
      expect(
        getProjectExecutionDefaults(harness.deps.db, { projectId: project.id })
          ?.reasoningLevel,
      ).toBe("none");
      expect(await start("none")).toBe(400);
    });
  });

  it("creates from displayed execution values when only the provider has a client source", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      registerProviderHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        restoreCommandCaptureAfterResponse: true,
        modelsByProviderId: {
          codex: {
            models: [
              availableModelFixture({
                model: "gpt-provider-default",
                reasoningLevels: ["medium", "high"],
                defaultReasoningLevel: "high",
                isDefault: true,
              }),
            ],
            selectedOnlyModels: [],
          },
        },
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-client-provider",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-client-provider",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          origin: "app",
          projectId: project.id,
          providerId: "codex",
          model: "gpt-provider-default",
          reasoningLevel: "high",
          permissionMode: "full",
          executionInputSources: {
            providerId: "client-preference",
          },
          input: [
            { type: "text", text: "Create from the new thread composer" },
          ],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === createdThread.id,
      );
      expect(queuedStart.command).toMatchObject({
        providerId: "codex",
        options: {
          model: "gpt-provider-default",
          reasoningLevel: "high",
          permissionMode: "full",
        },
      });
    });
  });

  it.each([
    {
      errorCode: "command_failed",
      status: 503,
      body: {
        code: "model_catalog_unavailable",
        message: expect.stringContaining("Unable to load codex models"),
        details: { providerId: "codex", code: "failed", canRestart: true },
        retryable: true,
      },
    },
    // A broken install needs a reinstall, not a retry (#907).
    {
      errorCode: "missing_executable",
      status: 409,
      body: {
        code: "provider_cli_missing",
        message: expect.stringContaining("Reinstall"),
        details: { providerId: "codex", code: "missing_executable" },
        retryable: false,
      },
    },
    // An explicit model can't start a missing CLI either (#2226).
    {
      errorCode: "missing_executable",
      model: "gpt-5",
      status: 409,
      body: expect.objectContaining({ code: "provider_cli_missing" }),
    },
    // A signed-out Grok needs its login, not a wait for the host (#1160).
    {
      providerId: "acp-grok",
      errorCode: "auth_required",
      status: 409,
      body: {
        code: "provider_auth_required",
        message:
          "Grok Build is not signed in on this host. Run `grok login` on the machine to sign in. Then try again.",
        details: { providerId: "acp-grok", code: "auth_required" },
        retryable: false,
      },
    },
    // So does every agent with a sign-in command, like Cursor and Antigravity.
    {
      providerId: "acp-cursor",
      errorCode: "auth_required",
      status: 409,
      body: {
        code: "provider_auth_required",
        message:
          "Cursor is not signed in on this host. Run `cursor-agent login` on the machine to sign in. Then try again.",
        details: { providerId: "acp-cursor", code: "auth_required" },
        retryable: false,
      },
    },
  ])("returns an actionable catalog error ($errorCode)", async (failure) => {
    const providerId = failure.providerId ?? "codex";
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      registerProviderHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        modelErrorsByProviderId: {
          [providerId]: {
            errorCode: failure.errorCode,
            errorMessage: "Codex model discovery failed",
          },
        },
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-catalog-error",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-catalog-error",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin: "cli",
          projectId: project.id,
          providerId,
          ...(failure.model ? { model: failure.model } : {}),
          input: [{ type: "text", text: "Create without defaults" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(failure.status);
      await expect(readJson(response)).resolves.toEqual(failure.body);
      expect(
        listThreadsWithPendingInteractionState(harness.db, {
          projectId: project.id,
        }),
      ).toHaveLength(0);
    });
  });

  // Codex works, but the first listing after an app update failed or timed out (#1399).
  it.each(["command_failed", "command_timeout"])(
    "starts Codex on the default this host listed last when listing fails (%s)",
    async (errorCode) => {
      await withTestHarness(async (harness) => {
        const { host, session } = seedHostSession(harness.deps);
        replaceStoredProviderModelCatalog(harness.db, {
          row: {
            hostId: host.id,
            providerId: "codex",
            scopeKey: "",
            fingerprint: "previous-app-version",
            modelsJson: JSON.stringify([
              availableModelFixture({ model: "gpt-older" }),
              availableModelFixture({
                model: "gpt-listed-default",
                reasoningLevels: ["low", "high"],
                defaultReasoningLevel: "high",
                isDefault: true,
              }),
            ]),
            selectedOnlyModelsJson: "[]",
            fetchedAt: 1,
          },
          pruneWorkspaceRowsFetchedBefore: null,
        });
        registerProviderHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
          restoreCommandCaptureAfterResponse: true,
          modelErrorsByProviderId: {
            codex: { errorCode, errorMessage: "Codex model discovery failed" },
          },
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/thread-defaults-codex-last-listed",
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: "/tmp/thread-defaults-codex-last-listed",
        });

        const response = await harness.app.request("/api/v1/threads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            origin: "cli",
            projectId: project.id,
            providerId: "codex",
            input: [{ type: "text", text: "Spawn without a model" }],
            environment: { type: "reuse", environmentId: environment.id },
          }),
        });

        expect(response.status).toBe(201);
        const createdThread = threadSchema.parse(await readJson(response));
        const queuedStart = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.start" &&
            command.threadId === createdThread.id,
        );
        expect(queuedStart.command).toMatchObject({
          providerId: "codex",
          options: { model: "gpt-listed-default", reasoningLevel: "high" },
        });
      });
    },
  );

  it.each(["failed", "empty"])(
    "falls back to another available provider when the product default's model catalog is %s",
    async (catalogState) => {
      await withTestHarness(async (harness) => {
        const { host, session } = seedHostSession(harness.deps);
        registerProviderHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
          restoreCommandCaptureAfterResponse: true,
          modelsByProviderId:
            catalogState === "empty"
              ? { "claude-code": { models: [], selectedOnlyModels: [] } }
              : {},
          modelErrorsByProviderId:
            catalogState === "failed"
              ? {
                  "claude-code": {
                    errorCode: "command_failed",
                    errorMessage: "Claude Code model discovery failed",
                  },
                }
              : {},
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/thread-defaults-catalog-fallback",
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: "/tmp/thread-defaults-catalog-fallback",
        });

        const response = await harness.app.request("/api/v1/threads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            origin: "cli",
            projectId: project.id,
            input: [{ type: "text", text: "Create without defaults" }],
            environment: {
              type: "reuse",
              environmentId: environment.id,
            },
          }),
        });

        expect(response.status).toBe(201);
        const createdThread = threadSchema.parse(await readJson(response));
        expect(createdThread.providerId).toBe("codex");
        const queuedStart = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.start" &&
            command.threadId === createdThread.id,
        );
        expect(queuedStart.command).toMatchObject({
          providerId: "codex",
          options: { model: "test-provider-default" },
        });
      });
    },
  );

  it("rejects thread creation without an origin at the public API boundary", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-missing-origin",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-missing-origin",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5-mini",
          input: [{ type: "text", text: "Create without origin" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining('expected one of "app"|"cli"'),
      });
    });
  });

  it("does not overwrite project execution defaults after a thread send", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-send-defaults",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-send-defaults",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-send-defaults",
        model: "gpt-5",
      });
      upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: thread.providerId,
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "auto",
            input: [{ type: "text", text: "Use explicit send defaults" }],
            model: "gpt-5-mini",
            serviceTier: "fast",
            reasoningLevel: "high",
            permissionMode: "workspace-write",
          }),
        },
      );

      expect(response.status).toBe(200);
      const queuedRun = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      expect(queuedRun.command).toMatchObject({
        options: {
          model: "gpt-5-mini",
          serviceTier: "fast",
          reasoningLevel: "high",
          permissionMode: "accept-edits",
          permissionEscalation: "ask",
        },
      });
      expect(
        getProjectExecutionDefaults(harness.db, {
          projectId: project.id,
        }),
      ).toEqual({
        providerId: "codex",
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
      });
    });
  });

  it("does not synthesize project defaults in sidebar bootstrap", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-sidebar",
      });

      const response = await harness.app.request("/api/v1/sidebar-bootstrap");

      expect(response.status).toBe(200);
      const bootstrap = sidebarBootstrapResponseSchema.parse(
        await readJson(response),
      );
      const sidebarProject = bootstrap.projects.find(
        (candidate) => candidate.id === project.id,
      );
      expect(sidebarProject?.defaultExecutionOptions).toBeNull();
      expect(
        getProjectExecutionDefaults(harness.db, {
          projectId: project.id,
        }),
      ).toBeNull();
    });
  });

  it("excludes side-chat threads from sidebar bootstrap", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-sidebar-side-chat",
      });
      const parentThread = seedThread(harness.deps, {
        projectId: project.id,
        title: "Parent",
      });
      const sideChatThread = seedThread(harness.deps, {
        projectId: project.id,
        sourceThreadId: parentThread.id,
        originKind: "fork",
        originPluginId: "side-chat",
        visibility: "hidden",
        title: "Side chat",
      });

      const response = await harness.app.request("/api/v1/sidebar-bootstrap");

      expect(response.status).toBe(200);
      const bootstrap = sidebarBootstrapResponseSchema.parse(
        await readJson(response),
      );
      const sidebarProject = bootstrap.projects.find(
        (candidate) => candidate.id === project.id,
      );
      expect(sidebarProject?.threads.map((thread) => thread.id)).toContain(
        parentThread.id,
      );
      expect(sidebarProject?.threads.map((thread) => thread.id)).not.toContain(
        sideChatThread.id,
      );
    });
  });

  it("excludes hidden threads from sidebar bootstrap", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-sidebar-hidden",
      });
      const visibleThread = seedThread(harness.deps, {
        projectId: project.id,
        title: "Visible thread",
      });
      const hiddenThread = seedThread(harness.deps, {
        projectId: project.id,
        title: "Hidden worker",
        visibility: "hidden",
      });

      const response = await harness.app.request("/api/v1/sidebar-bootstrap");

      expect(response.status).toBe(200);
      const bootstrap = sidebarBootstrapResponseSchema.parse(
        await readJson(response),
      );
      const sidebarProject = bootstrap.projects.find(
        (candidate) => candidate.id === project.id,
      );
      expect(sidebarProject?.threads.map((thread) => thread.id)).toContain(
        visibleThread.id,
      );
      expect(sidebarProject?.threads.map((thread) => thread.id)).not.toContain(
        hiddenThread.id,
      );
    });
  });
});
