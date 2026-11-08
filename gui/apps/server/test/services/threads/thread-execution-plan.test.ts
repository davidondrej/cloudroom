import { updateHost, upsertProjectExecutionDefaults } from "@cloudroom/db";
import type { PermissionMode, ServiceTier } from "@cloudroom/domain";
import { describe, expect, it } from "vitest";
import {
  buildExistingThreadExecutionInput,
  resolveExistingThreadExecutionPlan,
  resolveExistingThreadPermissionMode,
  tryResolveExistingThreadExecutionPlan,
} from "../../../src/services/threads/thread-execution-plan.js";
import { resolveProjectExecutionDefaultsForCreate } from "../../../src/services/threads/project-execution-defaults.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

describe("thread execution plan input sources", () => {
  it("treats supplied execution fields as explicit when legacy callers omit sources", () => {
    expect(
      buildExistingThreadExecutionInput({
        model: "gpt-5",
        permissionMode: "accept-edits",
        reasoningLevel: "high",
        serviceTier: "fast",
      }),
    ).toEqual({
      model: { source: "explicit", value: "gpt-5" },
      permissionMode: { source: "explicit", value: "accept-edits" },
      reasoningLevel: { source: "explicit", value: "high" },
      serviceTier: { source: "explicit", value: "fast" },
    });
  });

  it("ignores displayed-only values when new callers provide empty source metadata", () => {
    expect(
      buildExistingThreadExecutionInput({
        model: "gpt-5",
        permissionMode: "accept-edits",
        reasoningLevel: "high",
        serviceTier: "fast",
        executionInputSources: {},
      }),
    ).toEqual({});
  });

  it("keeps caller-owned source metadata on supplied execution fields", () => {
    expect(
      buildExistingThreadExecutionInput({
        model: "gpt-5",
        permissionMode: "accept-edits",
        reasoningLevel: "high",
        serviceTier: "fast",
        executionInputSources: {
          model: "client-preference",
          permissionMode: "explicit",
          reasoningLevel: "client-preference",
          serviceTier: "explicit",
        },
      }),
    ).toEqual({
      model: { source: "client-preference", value: "gpt-5" },
      permissionMode: { source: "explicit", value: "accept-edits" },
      reasoningLevel: { source: "client-preference", value: "high" },
      serviceTier: { source: "explicit", value: "fast" },
    });
  });

  it("uses source metadata before resolving create provider defaults", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-source-aware-create-defaults",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      upsertProjectExecutionDefaults(harness.deps.db, {
        projectId: project.id,
        providerId: "codex",
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "auto",
        serviceTier: "default",
      });

      const ignoredDisplayedValue = resolveProjectExecutionDefaultsForCreate(
        harness.deps,
        {
          executionInputSources: {},
          model: "openai-codex/gpt-5.4",
          projectId: project.id,
          providerId: "pi",
        },
      );
      const legacyExplicitValue = resolveProjectExecutionDefaultsForCreate(
        harness.deps,
        {
          model: "openai-codex/gpt-5.4",
          projectId: project.id,
          providerId: "pi",
        },
      );
      const clientPreferredProvider = resolveProjectExecutionDefaultsForCreate(
        harness.deps,
        {
          executionInputSources: { providerId: "client-preference" },
          model: "openai-codex/gpt-5.4",
          projectId: project.id,
          providerId: "pi",
        },
      );

      expect(ignoredDisplayedValue.providerId).toBe("codex");
      expect(ignoredDisplayedValue.executionDefaults?.model).toBe("gpt-5");
      expect(legacyExplicitValue.providerId).toBe("pi");
      expect(legacyExplicitValue.executionDefaults).toBeNull();
      expect(clientPreferredProvider.providerId).toBe("pi");
      expect(clientPreferredProvider.executionDefaults).toBeNull();
      expect(clientPreferredProvider.requestedModel).toBeNull();
    });
  });

  it("uses the product provider when create metadata has no caller-owned provider or model", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-source-aware-standard-product-defaults",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      const resolution = resolveProjectExecutionDefaultsForCreate(
        harness.deps,
        {
          executionInputSources: {},
          model: "openai-codex/gpt-5.4",
          projectId: project.id,
          providerId: "pi",
        },
      );

      expect(resolution.providerId).toBe("codex");
      expect(resolution.executionDefaults).toBeNull();
      expect(resolution.requestedModel).toBeNull();
    });
  });
});
describe("provider service tiers", () => {
  async function seedServiceTierThread(
    harness: TestAppHarness,
    args: {
      declaredTiers?: ServiceTier[];
      supportsServiceTier?: boolean;
      lastTier?: ServiceTier;
      projectTier?: ServiceTier;
    },
  ) {
    const codex = harness.deps.providerRegistry.get("codex");
    if (!codex) throw new Error("Expected the bundled Codex provider");
    const providerId = "tier-test-provider";
    harness.deps.providerRegistry.register({
      ...codex,
      pluginId: "tier-test-plugin",
      info: {
        ...codex.info,
        id: providerId,
        serviceTiers: args.declaredTiers?.map((id) => ({ id, label: id })),
        capabilities: {
          ...codex.info.capabilities,
          supportsServiceTier: args.supportsServiceTier ?? true,
        },
      },
    });
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const thread = seedThread(harness.deps, {
      projectId: project.id,
      providerId,
    });
    if (args.lastTier !== undefined) {
      seedThreadRuntimeState(harness.deps, {
        environmentId: null,
        providerThreadId: "tier-test-thread",
        threadId: thread.id,
        serviceTier: args.lastTier,
      });
    }
    if (args.projectTier !== undefined) {
      upsertProjectExecutionDefaults(harness.deps.db, {
        projectId: project.id,
        providerId,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: args.projectTier,
      });
    }
    return thread;
  }

  it("rejects an explicit Ultrafast the provider doesn't declare with a clear 400", async () => {
    await withTestHarness(async (harness) => {
      const thread = await seedServiceTierThread(harness, {
        declaredTiers: ["default", "fast"],
        lastTier: "default",
      });
      await expect(
        resolveExistingThreadExecutionPlan(harness.deps, {
          executionSource: "client/turn/requested",
          threadId: thread.id,
          input: { serviceTier: { source: "explicit", value: "ultrafast" } },
        }),
      ).rejects.toMatchObject({
        status: 400,
        body: {
          code: "invalid_request",
          message:
            "Provider tier-test-provider does not support the ultrafast service tier.",
        },
      });
    });
  });

  it.each([
    ["ultrafast", undefined, "default"],
    [undefined, "ultrafast", "default"],
    ["ultrafast", "fast", "fast"],
    ["ultrafast", "ultrafast", "default"],
    ["fast", "ultrafast", "fast"],
  ] as const)(
    "filters inherited last=%s and project=%s to %s",
    async (lastTier, projectTier, expected) => {
      await withTestHarness(async (harness) => {
        const thread = await seedServiceTierThread(harness, {
          declaredTiers: ["default", "fast"],
          lastTier,
          projectTier,
        });
        const plan = await resolveExistingThreadExecutionPlan(harness.deps, {
          executionSource: "client/turn/requested",
          threadId: thread.id,
          input: { model: { source: "explicit", value: "gpt-5" } },
        });
        expect(plan.resolvedExecution.serviceTier).toBe(expected);
      });
    },
  );

  it.each(["default", "fast", "ultrafast"] as const)(
    "accepts declared %s",
    async (tier) => {
      await withTestHarness(async (harness) => {
        const thread = await seedServiceTierThread(harness, {
          declaredTiers: ["default", "fast", "ultrafast"],
          lastTier: "ultrafast",
        });
        const input = {
          serviceTier: { source: "explicit" as const, value: tier },
        };
        const plan = await resolveExistingThreadExecutionPlan(harness.deps, {
          executionSource: "client/turn/requested",
          threadId: thread.id,
          input,
        });
        expect(plan.resolvedExecution.serviceTier).toBe(tier);
        const inherited = await resolveExistingThreadExecutionPlan(
          harness.deps,
          {
            executionSource: "client/turn/requested",
            threadId: thread.id,
            input: {},
          },
        );
        expect(inherited.resolvedExecution.serviceTier).toBe("ultrafast");
      });
    },
  );

  it("retains legacy Fast support without allowing undeclared Ultrafast", async () => {
    await withTestHarness(async (harness) => {
      const thread = await seedServiceTierThread(harness, {
        lastTier: "ultrafast",
      });
      const plan = await resolveExistingThreadExecutionPlan(harness.deps, {
        executionSource: "client/turn/requested",
        threadId: thread.id,
        input: { serviceTier: { source: "explicit", value: "fast" } },
      });
      expect(plan.resolvedExecution.serviceTier).toBe("fast");
      await expect(
        resolveExistingThreadExecutionPlan(harness.deps, {
          executionSource: "client/turn/requested",
          threadId: thread.id,
          input: { serviceTier: { source: "explicit", value: "ultrafast" } },
        }),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  it("keeps Standard and Fast handling unchanged when a provider declares fewer tiers", async () => {
    await withTestHarness(async (harness) => {
      const thread = await seedServiceTierThread(harness, {
        declaredTiers: ["default"],
        lastTier: "fast",
      });
      const inherited = await resolveExistingThreadExecutionPlan(harness.deps, {
        executionSource: "client/turn/requested",
        threadId: thread.id,
        input: {},
      });
      expect(inherited.resolvedExecution.serviceTier).toBe("fast");
      const explicit = await resolveExistingThreadExecutionPlan(harness.deps, {
        executionSource: "client/turn/requested",
        threadId: thread.id,
        input: { serviceTier: { source: "explicit", value: "fast" } },
      });
      expect(explicit.resolvedExecution.serviceTier).toBe("fast");
    });
  });
});

describe("machine permission ceiling", () => {
  async function seedCappedThread(
    harness: TestAppHarness,
    args: { maxPermissionMode: PermissionMode; providerId: string; id: string },
  ) {
    const { host } = seedHostSession(harness.deps, { id: args.id });
    updateHost(harness.db, harness.hub, host.id, {
      maxPermissionMode: args.maxPermissionMode,
    });
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
    });
    const thread = seedThread(harness.deps, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: args.providerId,
    });
    seedThreadRuntimeState(harness.deps, {
      environmentId: environment.id,
      permissionMode: "full",
      providerThreadId: `provider-${args.id}`,
      threadId: thread.id,
    });
    return thread;
  }

  it("clamps an explicitly requested mode down to the machine's ceiling", async () => {
    await withTestHarness(async (harness) => {
      const thread = await seedCappedThread(harness, {
        id: "host-ceiling-explicit",
        maxPermissionMode: "auto",
        providerId: "codex",
      });

      const plan = await resolveExistingThreadExecutionPlan(harness.deps, {
        executionSource: "client/turn/requested",
        input: { permissionMode: { source: "explicit", value: "full" } },
        threadId: thread.id,
      });

      expect(plan.resolvedExecution.permissionMode).toBe("auto");
      expect(resolveExistingThreadPermissionMode(harness.deps, thread.id)).toBe(
        "auto",
      );
    });
  });

  it("falls back to the highest supported mode under the ceiling", async () => {
    await withTestHarness(async (harness) => {
      const thread = await seedCappedThread(harness, {
        id: "host-ceiling-acp",
        maxPermissionMode: "auto",
        providerId: "acp-cursor",
      });

      const plan = await resolveExistingThreadExecutionPlan(harness.deps, {
        executionSource: "client/turn/requested",
        input: { permissionMode: { source: "explicit", value: "full" } },
        threadId: thread.id,
      });

      expect(plan.resolvedExecution.permissionMode).toBe("accept-edits");
    });
  });

  it("reads as no default execution options instead of failing the page", async () => {
    await withTestHarness(async (harness) => {
      const thread = await seedCappedThread(harness, {
        id: "host-ceiling-pi-read",
        maxPermissionMode: "accept-edits",
        providerId: "pi",
      });

      await expect(
        tryResolveExistingThreadExecutionPlan(harness.deps, {
          executionSource: "client/turn/requested",
          input: {},
          threadId: thread.id,
        }),
      ).resolves.toBeNull();
    });
  });

  it("refuses a provider that cannot run under the ceiling", async () => {
    await withTestHarness(async (harness) => {
      const thread = await seedCappedThread(harness, {
        id: "host-ceiling-pi",
        maxPermissionMode: "accept-edits",
        providerId: "pi",
      });

      await expect(
        resolveExistingThreadExecutionPlan(harness.deps, {
          executionSource: "client/turn/requested",
          input: {},
          threadId: thread.id,
        }),
      ).rejects.toMatchObject({
        body: { code: "host_permission_ceiling_conflict" },
      });
    });
  });

  it("leaves work alone on an uncapped machine", async () => {
    await withTestHarness(async (harness) => {
      const thread = await seedCappedThread(harness, {
        id: "host-ceiling-none",
        maxPermissionMode: "full",
        providerId: "codex",
      });

      const plan = await resolveExistingThreadExecutionPlan(harness.deps, {
        executionSource: "client/turn/requested",
        input: {},
        threadId: thread.id,
      });

      expect(plan.resolvedExecution.permissionMode).toBe("full");
    });
  });
});
