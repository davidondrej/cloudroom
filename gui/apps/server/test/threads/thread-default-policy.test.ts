import {
  defaultEnvironmentProviderRecords,
  installFakeGitWorktreeProvider,
  installFakePersonalWorkspaceProvider,
} from "../helpers/environment-provider.js";
import {
  PERSONAL_PROJECT_ID,
  type GitSourceInspection,
  type ProjectExecutionDefaults,
  type Thread,
} from "@cloudroom/domain";
import {
  createEnvironment,
  createProjectSource,
  createThread,
} from "@cloudroom/db";
import { describe, expect, it } from "vitest";
import {
  getEnvironmentProvider,
  setPluginEnvironmentProviderBridge,
} from "../../src/services/plugins/plugin-environment-provider-registry.js";
import { createCheckoutInspectionCache } from "../../src/services/environments/provider-availability.js";
import { invokePluginInline } from "../../src/services/plugins/plugin-hook-registry.js";
import {
  resolveCreateThreadEnvironment,
  resolveCreateThreadExecutionDefaults,
  resolveProjectDefaultThreadEnvironment,
  resolveThreadDefaultPermissionMode,
  resolveThreadExecutionPermissionMode,
} from "../../src/services/threads/thread-default-policy.js";
import { resolveThreadEnvironmentPlacement } from "../../src/services/threads/thread-environment-placement.js";
import { createProviderRegistryService } from "../../src/services/providers/provider-registry.js";
import {
  createTestProviderRegistry,
  registerFirstPartyProviders,
} from "../helpers/provider-registry.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import {
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const registry = await createTestProviderRegistry();

type PolicyTestThread = Pick<
  Thread,
  "originKind" | "parentThreadId" | "projectId" | "providerId"
>;
type PolicyTestParentThread = Pick<
  Thread,
  | "archivedAt"
  | "deletedAt"
  | "environmentId"
  | "id"
  | "parentThreadId"
  | "projectId"
>;

function makeThread(
  overrides: Partial<PolicyTestThread> = {},
): PolicyTestThread {
  return {
    originKind: null,
    parentThreadId: null,
    projectId: "proj-1",
    providerId: "codex",
    ...overrides,
  };
}

function makeDefaults(
  overrides: Partial<ProjectExecutionDefaults> = {},
): ProjectExecutionDefaults {
  return {
    model: "gpt-5",
    permissionMode: "full",
    providerId: "codex",
    reasoningLevel: "medium",
    serviceTier: "default",
    ...overrides,
  };
}

function makeParentThread(
  overrides: Partial<PolicyTestParentThread> = {},
): PolicyTestParentThread {
  return {
    archivedAt: null,
    deletedAt: null,
    environmentId: "env-parent-1",
    id: "thr-parent-1",
    parentThreadId: null,
    projectId: "proj-1",
    ...overrides,
  };
}

describe("resolveCreateThreadExecutionDefaults", () => {
  it("uses the picker's first provider without pinning a model", () => {
    expect(registry.list()[0]?.info.id).toBe("claude-code");

    expect(
      resolveCreateThreadExecutionDefaults(registry, {
        storedDefaults: null,
      }),
    ).toEqual({
      providerId: "claude-code",
      executionDefaults: null,
      providerFallbackCandidates: [
        "codex",
        "acp-antigravity",
        "acp-cursor",
        "pi",
        "acp-opencode",
        "acp-omp",
        "acp-grok",
        "acp-fx",
        "acp-hermes-agent",
        "acp-openclaw",
        "acp-devin",
        "acp-droid",
        "acp-kilo",
        "acp-cline",
        "acp-kimi",
        "acp-agent-zero",
      ],
    });
  });

  it("honors the user's default provider, then the most used", async () => {
    const preferences = {
      usage: new Map([
        ["pi", 2],
        ["claude-code", 1],
      ]) as ReadonlyMap<string, number>,
      defaultProviderId: null as string | null,
    };
    const userRegistry = createProviderRegistryService({
      readUserProviderPreferences: () => preferences,
    });
    await registerFirstPartyProviders(userRegistry);

    expect(userRegistry.list().map((entry) => entry.info.id)).toEqual([
      "pi",
      "claude-code",
      "codex",
      "acp-antigravity",
      "acp-cursor",
      "acp-opencode",
      "acp-omp",
      "acp-grok",
      "acp-fx",
      "acp-hermes-agent",
      "acp-openclaw",
      "acp-devin",
      "acp-droid",
      "acp-kilo",
      "acp-cline",
      "acp-kimi",
      "acp-agent-zero",
    ]);
    expect(
      resolveCreateThreadExecutionDefaults(userRegistry, {
        storedDefaults: null,
      }).providerId,
    ).toBe("pi");

    preferences.defaultProviderId = "codex";
    expect(
      resolveCreateThreadExecutionDefaults(userRegistry, {
        storedDefaults: null,
      }).providerId,
    ).toBe("codex");
    preferences.defaultProviderId = "not-installed";
    expect(
      resolveCreateThreadExecutionDefaults(userRegistry, {
        storedDefaults: null,
      }).providerId,
    ).toBe("pi");
  });

  it("orders fallback candidates behind the chosen default, preferred provider first", async () => {
    const preferences = {
      usage: new Map([
        ["pi", 2],
        ["claude-code", 1],
      ]) as ReadonlyMap<string, number>,
      defaultProviderId: "codex" as string | null,
    };
    const userRegistry = createProviderRegistryService({
      readUserProviderPreferences: () => preferences,
    });
    await registerFirstPartyProviders(userRegistry);

    expect(
      resolveCreateThreadExecutionDefaults(userRegistry, {
        storedDefaults: null,
      }).providerFallbackCandidates,
    ).toEqual([
      "pi",
      "claude-code",
      "acp-antigravity",
      "acp-cursor",
      "acp-opencode",
      "acp-omp",
      "acp-grok",
      "acp-fx",
      "acp-hermes-agent",
      "acp-openclaw",
      "acp-devin",
      "acp-droid",
      "acp-kilo",
      "acp-cline",
      "acp-kimi",
      "acp-agent-zero",
    ]);
  });

  it("has no fallback candidates when a provider was explicitly requested", () => {
    expect(
      resolveCreateThreadExecutionDefaults(registry, {
        requestedProviderId: "codex",
        storedDefaults: null,
      }).providerFallbackCandidates,
    ).toEqual([]);
  });

  it("has no fallback candidates when a stored default provider is used", () => {
    expect(
      resolveCreateThreadExecutionDefaults(registry, {
        storedDefaults: makeDefaults({ providerId: "codex" }),
      }).providerFallbackCandidates,
    ).toEqual([]);
  });

  it("discards stored defaults when the resolved provider changes", () => {
    expect(
      resolveCreateThreadExecutionDefaults(registry, {
        requestedProviderId: "pi",
        storedDefaults: makeDefaults({
          providerId: "codex",
          model: "gpt-5.5",
        }),
      }),
    ).toEqual({
      providerId: "pi",
      executionDefaults: null,
      providerFallbackCandidates: [],
    });
  });

  it("reuses matching stored defaults", () => {
    const storedDefaults = makeDefaults({
      model: "gpt-5.1",
      permissionMode: "accept-edits",
    });

    expect(
      resolveCreateThreadExecutionDefaults(registry, {
        storedDefaults,
      }),
    ).toEqual({
      providerId: "codex",
      executionDefaults: storedDefaults,
      providerFallbackCandidates: [],
    });
  });

  it("skips unavailable providers when choosing the product default", async () => {
    const degradedRegistry = createProviderRegistryService();
    await registerFirstPartyProviders(degradedRegistry, {
      unavailablePluginIds: ["provider-claude-code"],
    });

    expect(
      resolveCreateThreadExecutionDefaults(degradedRegistry, {
        storedDefaults: null,
      }),
    ).toEqual({
      providerId: "codex",
      executionDefaults: null,
      providerFallbackCandidates: [
        "acp-antigravity",
        "acp-cursor",
        "pi",
        "acp-opencode",
        "acp-omp",
        "acp-grok",
        "acp-fx",
        "acp-hermes-agent",
        "acp-openclaw",
        "acp-devin",
        "acp-droid",
        "acp-kilo",
        "acp-cline",
        "acp-kimi",
        "acp-agent-zero",
      ],
    });
  });

  it("rejects an explicitly selected unavailable provider", async () => {
    const degradedRegistry = createProviderRegistryService();
    await registerFirstPartyProviders(degradedRegistry, {
      unavailablePluginIds: ["provider-codex"],
    });

    expect(() =>
      resolveCreateThreadExecutionDefaults(degradedRegistry, {
        requestedProviderId: "codex",
        storedDefaults: null,
      }),
    ).toThrow(/Codex is unavailable because its provider plugin failed/u);
  });
});

describe("resolveCreateThreadEnvironment", () => {
  async function resolveEnvironment(
    args: Parameters<typeof resolveCreateThreadEnvironment>[1],
  ) {
    return withTestHarness((harness) => {
      installFakeGitWorktreeProvider();
      return resolveCreateThreadEnvironment(harness.deps, args);
    });
  }

  it("defaults implicit child host environments to the worktree provider", async () => {
    await expect(
      resolveEnvironment({
        parentThread: makeParentThread(),
        projectId: "proj-1",
        requestedEnvironment: {
          type: "host",
          hostId: "host-1",
          workspace: { type: "unmanaged", path: null },
        },
      }),
    ).resolves.toEqual({
      type: "provider",
      environmentProviderId: "git-worktree",
      machine: { type: "existing" as const, hostId: "host-1" },
      inputs: { branch: { kind: "default" } },
    });
  });

  it("defaults a child under a parent from another project to the worktree provider", async () => {
    await expect(
      resolveEnvironment({
        parentThread: makeParentThread({ projectId: "proj-2" }),
        projectId: "proj-1",
        requestedEnvironment: {
          type: "host",
          hostId: "host-1",
          workspace: { type: "unmanaged", path: null },
        },
      }),
    ).resolves.toEqual({
      type: "provider",
      environmentProviderId: "git-worktree",
      machine: { type: "existing" as const, hostId: "host-1" },
      inputs: { branch: { kind: "default" } },
    });
  });

  it("keeps explicit same-environment reuse for child threads", async () => {
    await expect(
      resolveEnvironment({
        parentThread: makeParentThread(),
        projectId: "proj-1",
        requestedEnvironment: {
          type: "reuse",
          environmentId: "env-1",
        },
      }),
    ).resolves.toEqual({
      type: "reuse",
      environmentId: "env-1",
    });
  });

  it("uses a fresh worktree on the parent's machine for a project child", async () => {
    await withTestHarness(async (harness) => {
      installFakeGitWorktreeProvider();
      const { host } = seedHostSession(harness.deps, {
        id: "host-project-child",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-child-source",
      });
      const parentEnvironment = createEnvironment(harness.db, harness.hub, {
        projectId: project.id,
        hostId: host.id,
        path: "/tmp/project-child-parent",
        providerOwnsPath: true,
        status: "ready",
        environmentProvider: null,
      });
      await expect(
        resolveCreateThreadEnvironment(harness.deps, {
          parentThread: makeParentThread({
            projectId: project.id,
            environmentId: parentEnvironment.id,
          }),
          projectId: project.id,
          requestedEnvironment: { type: "project-default" },
        }),
      ).resolves.toEqual({
        type: "provider",
        environmentProviderId: "git-worktree",
        machine: { type: "existing", hostId: host.id },
        inputs: { branch: { kind: "default" } },
      });
    });
  });

  it("does not reuse a personal parent environment from another project", async () => {
    const requestedEnvironment = {
      type: "host",
      workspace: { type: "personal" },
    } as const;
    await expect(
      resolveEnvironment({
        parentThread: makeParentThread({
          environmentId: "env-other-project-parent",
          projectId: "proj-other",
        }),
        projectId: PERSONAL_PROJECT_ID,
        requestedEnvironment,
      }),
    ).resolves.toEqual(requestedEnvironment);
  });

  it.each([
    {
      name: "the personal workspace sugar",
      requestedEnvironment: {
        type: "host" as const,
        workspace: { type: "personal" as const },
      },
    },
    {
      name: "a selection of the personal provider",
      requestedEnvironment: {
        type: "provider" as const,
        environmentProviderId: "personal-workspace",
        machine: { type: "existing" as const, hostId: "host-1" },
        inputs: null,
      },
    },
    {
      name: "no environment at all",
      requestedEnvironment: { type: "project-default" as const },
    },
  ])(
    "shares personal child threads from $name",
    async ({ requestedEnvironment }) => {
      await withTestHarness(async (harness) => {
        installFakeGitWorktreeProvider();
        await expect(
          resolveCreateThreadEnvironment(harness.deps, {
            parentThread: makeParentThread({
              environmentId: "env-personal-parent",
              projectId: PERSONAL_PROJECT_ID,
            }),
            projectId: PERSONAL_PROJECT_ID,
            requestedEnvironment,
          }),
        ).resolves.toEqual({
          type: "reuse",
          environmentId: "env-personal-parent",
        });
      });
    },
  );

  it("shares a personal provider selection with its parent", async () => {
    await expect(
      resolveEnvironment({
        parentThread: makeParentThread({
          environmentId: "env-personal-parent",
          projectId: PERSONAL_PROJECT_ID,
        }),
        projectId: PERSONAL_PROJECT_ID,
        requestedEnvironment: {
          type: "provider",
          environmentProviderId: "personal-workspace",
          machine: { type: "existing" as const, hostId: "host-1" },
          inputs: null,
        },
      }),
    ).resolves.toEqual({
      type: "reuse",
      environmentId: "env-personal-parent",
    });
  });

  it.each([
    {
      args: {
        parentThread: null,
        projectId: "proj-1",
        requestedEnvironment: {
          type: "host" as const,
          hostId: "host-1",
          workspace: { type: "unmanaged" as const, path: null },
        },
      },
      name: "requests without a parent thread",
    },
    {
      args: {
        parentThread: makeParentThread({
          deletedAt: 1,
        }),
        projectId: "proj-1",
        requestedEnvironment: {
          type: "host" as const,
          hostId: "host-1",
          workspace: { type: "unmanaged" as const, path: null },
        },
      },
      name: "deleted parents",
    },
    {
      args: {
        parentThread: makeParentThread(),
        projectId: "proj-1",
        requestedEnvironment: {
          type: "host" as const,
          hostId: "host-1",
          workspace: { type: "unmanaged" as const, path: "/tmp/existing" },
        },
      },
      name: "explicit unmanaged paths",
    },
    {
      args: {
        parentThread: makeParentThread(),
        projectId: "proj-1",
        requestedEnvironment: {
          type: "host" as const,
          hostId: "host-1",
          workspace: {
            type: "unmanaged" as const,
            path: null,
            branch: { kind: "existing" as const, name: "feature/x" },
          },
        },
      },
      name: "unmanaged host requests with an explicit branch",
    },
  ])("passes through $name", async ({ args }) => {
    await expect(resolveEnvironment(args)).resolves.toEqual(
      args.requestedEnvironment,
    );
  });

  it.each([
    {
      name: "is not a git repository",
      checkout: {
        kind: "unknown" as const,
        reason: "Path is not a git repository",
      },
    },
    {
      name: "has no commits",
      checkout: { kind: "unborn" as const, branchName: "main" },
    },
  ])(
    "falls back from worktree for non-Git hosts when the project $name",
    async ({ checkout }) => {
      await withTestHarness(async (harness) => {
        installFakeGitWorktreeProvider();
        const worktree = getEnvironmentProvider("git-worktree")!;
        const providers = [...defaultEnvironmentProviderRecords(), worktree];
        setPluginEnvironmentProviderBridge({
          listEnvironmentProviders: () => providers,
          getEnvironmentProvider: (id) =>
            providers.find((record) => record.provider.id === id),
          invokeProvider: (_pluginId, _label, run) => invokePluginInline(run),
          decisionTimeoutMs: 10_000,
        });
        const { host, session } = seedHostSession(harness.deps, {
          id: "host-default-order",
        });
        const { host: otherHost, session: otherSession } = seedHostSession(
          harness.deps,
          { id: "host-other-plain" },
        );
        const { host: unregisteredHost } = seedHostSession(harness.deps, {
          id: "host-unregistered",
        });
        seedPrimaryHost(harness.deps, host.id);
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/default-order-source",
        });
        createProjectSource(harness.db, harness.hub, {
          projectId: project.id,
          type: "local_path",
          hostId: otherHost.id,
          path: "/tmp/other-host-source",
        });
        const parentEnvironment = createEnvironment(harness.db, harness.hub, {
          projectId: project.id,
          hostId: host.id,
          path: "/tmp/parent-environment",
          providerOwnsPath: true,
          status: "ready",
          environmentProvider: null,
        });
        const inspection = {
          checkout,
          defaultBranch: null,
          defaultBranchRelation: null,
          isWorktree: false,
          hasUncommittedChanges: false,
          operation: { kind: "none" as const },
          originDefaultBranch: null,
        } satisfies GitSourceInspection;
        for (const [hostId, sessionId] of [
          [host.id, session.id],
          [otherHost.id, otherSession.id],
        ] as const) {
          registerHostRpcResponder(harness, {
            hostId,
            sessionId,
            handle: () => ({ ok: true, result: inspection }),
          });
        }
        const parentThread = makeParentThread({
          projectId: project.id,
          environmentId: parentEnvironment.id,
        });

        // No --machine, and --machine naming the parent's own host (#822).
        for (const requestedEnvironment of [
          { type: "project-default" as const },
          {
            type: "host" as const,
            hostId: host.id,
            workspace: { type: "unmanaged" as const, path: null },
          },
        ]) {
          await expect(
            resolveCreateThreadEnvironment(harness.deps, {
              parentThread,
              projectId: project.id,
              requestedEnvironment,
            }),
          ).resolves.toEqual({
            type: "reuse",
            environmentId: parentEnvironment.id,
          });
        }

        // Another host with a registered plain/unborn folder uses its project checkout (#2704).
        const otherResolved = await resolveCreateThreadEnvironment(
          harness.deps,
          {
            parentThread,
            projectId: project.id,
            requestedEnvironment: {
              type: "host",
              hostId: otherHost.id,
              workspace: { type: "unmanaged", path: null },
            },
          },
        );
        expect(otherResolved).toEqual({
          type: "provider",
          environmentProviderId: "project-checkout",
          machine: { type: "existing", hostId: otherHost.id },
          inputs: { path: "/tmp/other-host-source" },
        });
        await expect(
          resolveThreadEnvironmentPlacement(harness.deps, {
            projectId: project.id,
            requestedEnvironment: otherResolved,
          }),
        ).resolves.toMatchObject({
          environmentId: null,
          environmentIntent: {
            type: "provider",
            environmentProviderId: "project-checkout",
            machine: { type: "existing", hostId: otherHost.id },
            inputs: { path: "/tmp/other-host-source" },
            selectionResolved: true,
          },
        });

        // Explicit --new-environment worktree still enforces Git validation.
        const explicitWorktree = await resolveCreateThreadEnvironment(
          harness.deps,
          {
            parentThread,
            projectId: project.id,
            requestedEnvironment: {
              type: "host",
              hostId: otherHost.id,
              workspace: {
                type: "managed-worktree",
                baseBranch: { kind: "default" },
              },
            },
          },
        );
        await expect(
          resolveThreadEnvironmentPlacement(harness.deps, {
            projectId: project.id,
            requestedEnvironment: explicitWorktree,
          }),
        ).rejects.toMatchObject({
          status: 409,
          body: { code: "environment_provider_rejected" },
        });

        // Another host with no registered source points to `room-cli project source add`.
        const missingSource = await resolveCreateThreadEnvironment(
          harness.deps,
          {
            parentThread,
            projectId: project.id,
            requestedEnvironment: {
              type: "host",
              hostId: unregisteredHost.id,
              workspace: { type: "unmanaged", path: null },
            },
          },
        );
        await expect(
          resolveThreadEnvironmentPlacement(harness.deps, {
            projectId: project.id,
            requestedEnvironment: missingSource,
          }),
        ).rejects.toMatchObject({
          status: 409,
          message: expect.stringContaining(
            `room-cli project source add ${project.id} --machine ${unregisteredHost.id} --path <path>`,
          ),
        });
      });
    },
  );

  it.each([
    ["missing folder", "Path does not exist"],
    ["unreadable git repo", "Git repository is unreadable or invalid"],
  ] as const)(
    "preserves 409 rejection instead of falling back for a %s on another host",
    async (_label, reason) => {
      await withTestHarness(async (harness) => {
        installFakeGitWorktreeProvider();
        const worktree = getEnvironmentProvider("git-worktree")!;
        const providers = [...defaultEnvironmentProviderRecords(), worktree];
        setPluginEnvironmentProviderBridge({
          listEnvironmentProviders: () => providers,
          getEnvironmentProvider: (id) =>
            providers.find((record) => record.provider.id === id),
          invokeProvider: (_pluginId, _label, run) => invokePluginInline(run),
          decisionTimeoutMs: 10_000,
        });
        const { host } = seedHostSession(harness.deps, { id: "host-a" });
        const { host: otherHost, session: otherSession } = seedHostSession(
          harness.deps,
          { id: "host-b-broken" },
        );
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/host-a-source",
        });
        createProjectSource(harness.db, harness.hub, {
          projectId: project.id,
          type: "local_path",
          hostId: otherHost.id,
          path: "/tmp/host-b-broken",
        });
        const parentEnvironment = createEnvironment(harness.db, harness.hub, {
          projectId: project.id,
          hostId: host.id,
          path: "/tmp/host-a-source",
          providerOwnsPath: false,
          status: "ready",
          environmentProvider: null,
        });
        registerHostRpcResponder(harness, {
          hostId: otherHost.id,
          sessionId: otherSession.id,
          handle: () => ({
            ok: true,
            result: {
              checkout: { kind: "unknown" as const, reason },
              defaultBranch: null,
              defaultBranchRelation: null,
              isWorktree: false,
              hasUncommittedChanges: false,
              operation: { kind: "none" as const },
              originDefaultBranch: null,
            } satisfies GitSourceInspection,
          }),
        });

        const resolved = await resolveCreateThreadEnvironment(harness.deps, {
          parentThread: makeParentThread({
            projectId: project.id,
            environmentId: parentEnvironment.id,
          }),
          projectId: project.id,
          requestedEnvironment: {
            type: "host",
            hostId: otherHost.id,
            workspace: { type: "unmanaged", path: null },
          },
        });
        expect(resolved).toMatchObject({
          type: "provider",
          environmentProviderId: "git-worktree",
        });
        await expect(
          resolveThreadEnvironmentPlacement(harness.deps, {
            projectId: project.id,
            requestedEnvironment: resolved,
          }),
        ).rejects.toMatchObject({
          status: 409,
          body: { code: "environment_provider_rejected" },
          message: expect.stringContaining(reason),
        });
      });
    },
  );

  it("inspects a healthy remote Git checkout once per child thread creation request", async () => {
    await withTestHarness(async (harness) => {
      installFakeGitWorktreeProvider();
      const { host } = seedHostSession(harness.deps, { id: "host-a" });
      const { host: otherHost, session: otherSession } = seedHostSession(
        harness.deps,
        { id: "host-b-git" },
      );
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/host-a-source",
      });
      createProjectSource(harness.db, harness.hub, {
        projectId: project.id,
        type: "local_path",
        hostId: otherHost.id,
        path: "/tmp/host-b-git",
      });
      const parentEnvironment = createEnvironment(harness.db, harness.hub, {
        projectId: project.id,
        hostId: host.id,
        path: "/tmp/host-a-source",
        providerOwnsPath: false,
        status: "ready",
        environmentProvider: null,
      });
      const parentThread = createThread(harness.db, harness.hub, {
        projectId: project.id,
        environmentId: parentEnvironment.id,
        providerId: "codex",
        status: "idle",
      });
      const responder = registerHostRpcResponder(harness, {
        hostId: otherHost.id,
        sessionId: otherSession.id,
        handle: (request) => {
          if (request.command.type !== "host.inspect_git_source") {
            return {
              ok: false,
              errorCode: "unexpected_command",
              errorMessage: `Unexpected command ${request.command.type}`,
            };
          }
          return {
            ok: true,
            result: {
              checkout: {
                kind: "branch" as const,
                branchName: "main",
                headSha: "abc123",
              },
              defaultBranch: "main",
              defaultBranchRelation: null,
              isWorktree: false,
              hasUncommittedChanges: false,
              operation: { kind: "none" as const },
              originDefaultBranch: null,
            } satisfies GitSourceInspection,
          };
        },
      });

      const spawnChild = () =>
        harness.app.request("/api/v1/threads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            origin: "sdk",
            projectId: project.id,
            parentThreadId: parentThread.id,
            providerId: "codex",
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "full",
            input: [{ type: "text", text: "Spawn a child on another host" }],
            environment: {
              type: "host",
              hostId: otherHost.id,
              workspace: { type: "unmanaged", path: null },
            },
          }),
        });

      const first = await spawnChild();
      expect(first.status).toBe(201);
      expect(
        responder.requests.filter(
          (req) => req.command.type === "host.inspect_git_source",
        ),
      ).toHaveLength(1);

      const second = await spawnChild();
      expect(second.status).toBe(201);
      expect(
        responder.requests.filter(
          (req) => req.command.type === "host.inspect_git_source",
        ),
      ).toHaveLength(2);
    });
  });

  it("still reuses the parent environment on the parent's host when its registered source moved", async () => {
    await withTestHarness(async (harness) => {
      installFakeGitWorktreeProvider();
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-moved-source",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/moved-source",
      });
      const parentEnvironment = createEnvironment(harness.db, harness.hub, {
        projectId: project.id,
        hostId: host.id,
        path: "/tmp/working-parent-folder",
        providerOwnsPath: false,
        status: "ready",
        environmentProvider: null,
      });
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: () => ({
          ok: true,
          result: {
            checkout: {
              kind: "unknown" as const,
              reason: "Path does not exist",
            },
            defaultBranch: null,
            defaultBranchRelation: null,
            isWorktree: false,
            hasUncommittedChanges: false,
            operation: { kind: "none" as const },
            originDefaultBranch: null,
          } satisfies GitSourceInspection,
        }),
      });
      const parentThread = makeParentThread({
        projectId: project.id,
        environmentId: parentEnvironment.id,
      });

      await expect(
        resolveCreateThreadEnvironment(harness.deps, {
          parentThread,
          projectId: project.id,
          requestedEnvironment: { type: "project-default" },
        }),
      ).resolves.toEqual({
        type: "reuse",
        environmentId: parentEnvironment.id,
      });
      await expect(
        resolveCreateThreadEnvironment(harness.deps, {
          parentThread,
          projectId: project.id,
          requestedEnvironment: {
            type: "host",
            hostId: host.id,
            workspace: { type: "unmanaged", path: null },
          },
        }),
      ).resolves.toEqual({
        type: "reuse",
        environmentId: parentEnvironment.id,
      });
    });
  });

  it("does not cache a failed inspection RPC in the per-request cache", async () => {
    await withTestHarness(async (harness) => {
      installFakeGitWorktreeProvider();
      const { host } = seedHostSession(harness.deps, { id: "host-a" });
      const { host: otherHost, session: otherSession } = seedHostSession(
        harness.deps,
        { id: "host-b-waking" },
      );
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/host-a-source",
      });
      createProjectSource(harness.db, harness.hub, {
        projectId: project.id,
        type: "local_path",
        hostId: otherHost.id,
        path: "/tmp/host-b-missing",
      });
      const parentEnvironment = createEnvironment(harness.db, harness.hub, {
        projectId: project.id,
        hostId: host.id,
        path: "/tmp/host-a-source",
        providerOwnsPath: false,
        status: "ready",
        environmentProvider: null,
      });
      let attempts = 0;
      const responder = registerHostRpcResponder(harness, {
        hostId: otherHost.id,
        sessionId: otherSession.id,
        handle: () => {
          attempts += 1;
          if (attempts === 1) {
            return {
              ok: false,
              errorCode: "command_failed",
              errorMessage: "temporary failure",
            };
          }
          return {
            ok: true,
            result: {
              checkout: {
                kind: "unknown" as const,
                reason: "Path does not exist",
              },
              defaultBranch: null,
              defaultBranchRelation: null,
              isWorktree: false,
              hasUncommittedChanges: false,
              operation: { kind: "none" as const },
              originDefaultBranch: null,
            } satisfies GitSourceInspection,
          };
        },
      });

      const checkoutInspectionCache = createCheckoutInspectionCache();
      const resolved = await resolveCreateThreadEnvironment(harness.deps, {
        checkoutInspectionCache,
        parentThread: makeParentThread({
          projectId: project.id,
          environmentId: parentEnvironment.id,
        }),
        projectId: project.id,
        requestedEnvironment: {
          type: "host",
          hostId: otherHost.id,
          workspace: { type: "unmanaged", path: null },
        },
      });
      expect(resolved).toMatchObject({
        type: "provider",
        environmentProviderId: "git-worktree",
      });

      await expect(
        resolveThreadEnvironmentPlacement(harness.deps, {
          checkoutInspectionCache,
          projectId: project.id,
          requestedEnvironment: resolved,
        }),
      ).rejects.toMatchObject({
        status: 409,
        body: { code: "environment_provider_rejected" },
        message: expect.stringContaining("Path does not exist"),
      });
      expect(
        responder.requests.filter(
          (req) => req.command.type === "host.inspect_git_source",
        ),
      ).toHaveLength(2);
    });
  });
});

describe("resolveProjectDefaultThreadEnvironment", () => {
  it("uses a worktree for a Git project", async () => {
    await withTestHarness(async (harness) => {
      installFakeGitWorktreeProvider();
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-git-default",
      });
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/git-default-source",
      });
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: () => ({
          ok: true,
          result: {
            checkout: {
              kind: "branch" as const,
              branchName: "feature",
              headSha: "abc123",
            },
            defaultBranch: "main",
            defaultBranchRelation: null,
            isWorktree: false,
            hasUncommittedChanges: false,
            operation: { kind: "none" as const },
            originDefaultBranch: null,
          } satisfies GitSourceInspection,
        }),
      });

      await expect(
        resolveProjectDefaultThreadEnvironment(harness.deps, {
          projectId: project.id,
        }),
      ).resolves.toEqual({
        type: "provider",
        environmentProviderId: "git-worktree",
        machine: { type: "existing", hostId: host.id },
        inputs: { branch: { kind: "named", name: "main" } },
      });
    });
  });

  it("uses the project checkout for a non-Git project", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-non-git-default",
      });
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/non-git-default-source",
      });
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: () => ({
          ok: true,
          result: {
            checkout: { kind: "unborn" as const, branchName: "main" },
            defaultBranch: null,
            defaultBranchRelation: null,
            isWorktree: false,
            hasUncommittedChanges: false,
            operation: { kind: "none" as const },
            originDefaultBranch: null,
          } satisfies GitSourceInspection,
        }),
      });

      await expect(
        resolveProjectDefaultThreadEnvironment(harness.deps, {
          projectId: project.id,
        }),
      ).resolves.toEqual({
        type: "provider",
        environmentProviderId: "project-checkout",
        machine: { type: "existing", hostId: host.id },
        inputs: { path: "/tmp/non-git-default-source" },
      });
    });
  });

  it("uses the personal workspace with no project", async () => {
    await withTestHarness(async (harness) => {
      installFakePersonalWorkspaceProvider();
      const { host } = seedHostSession(harness.deps, {
        id: "host-personal-default",
      });
      seedPrimaryHost(harness.deps, host.id);

      await expect(
        resolveProjectDefaultThreadEnvironment(harness.deps, {
          projectId: PERSONAL_PROJECT_ID,
        }),
      ).resolves.toEqual({
        type: "provider",
        environmentProviderId: "personal-workspace",
        machine: { type: "existing", hostId: host.id },
        inputs: null,
      });
    });
  });
});

describe("resolveThreadDefaultPermissionMode", () => {
  it("uses the full permission default for non-agent providers", () => {
    expect(
      resolveThreadDefaultPermissionMode(registry, {
        thread: makeThread({
          parentThreadId: "thr-parent-1",
          providerId: "custom-provider",
        }),
      }),
    ).toBe("full");
  });

  it("uses full for Pi threads", () => {
    expect(
      resolveThreadDefaultPermissionMode(registry, {
        thread: makeThread({
          parentThreadId: "thr-parent-1",
          providerId: "pi",
        }),
      }),
    ).toBe("full");
  });

  it("uses full for ACP threads when the Auto default is unsupported", () => {
    expect(
      resolveThreadDefaultPermissionMode(registry, {
        thread: makeThread({
          parentThreadId: "thr-parent-1",
          providerId: "acp-cursor",
        }),
      }),
    ).toBe("full");
  });

  it("uses full for Codex threads", () => {
    expect(
      resolveThreadDefaultPermissionMode(registry, {
        thread: makeThread({
          parentThreadId: "thr-other-project-parent-1",
          providerId: "codex",
        }),
      }),
    ).toBe("full");
  });
});

describe("resolveThreadExecutionPermissionMode", () => {
  it("honors the permission snapshot requested for a side chat", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        requestedPermissionMode: "full",
        lastExecutionPermissionMode: "full",
        projectExecutionPermissionMode: "full",
        thread: makeThread({ originKind: "fork" }),
      }),
    ).toBe("full");
  });

  it("prefers requested permission modes over every fallback", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        requestedPermissionMode: "auto",
        lastExecutionPermissionMode: "workspace-write",
        projectExecutionPermissionMode: "full",
        thread: makeThread(),
      }),
    ).toBe("auto");
  });

  it("maps a legacy readonly execution to Manual for future work", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        lastExecutionPermissionMode: "readonly",
        projectExecutionPermissionMode: "full",
        thread: makeThread(),
      }),
    ).toBe("accept-edits");
  });

  it("maps a legacy readonly parent execution before inheriting it", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        parentThread: makeParentThread(),
        parentThreadExecutionPermissionMode: "readonly",
        projectExecutionPermissionMode: "full",
        thread: makeThread({
          parentThreadId: "thr-parent-1",
          providerId: "codex",
        }),
      }),
    ).toBe("accept-edits");
  });

  it("uses project permission defaults for child threads without parent execution history", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        parentThread: makeParentThread(),
        projectExecutionPermissionMode: "full",
        thread: makeThread({
          parentThreadId: "thr-parent-1",
          providerId: "codex",
        }),
      }),
    ).toBe("full");
  });

  it("never upgrades an inherited mode past the parent for provider support", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        parentThread: makeParentThread(),
        parentThreadExecutionPermissionMode: "workspace-write",
        projectExecutionPermissionMode: "accept-edits",
        thread: makeThread({
          parentThreadId: "thr-parent-1",
          providerId: "pi",
        }),
      }),
    ).toBe("accept-edits");
  });

  it("clamps an explicitly requested mode to the parent's mode", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        requestedPermissionMode: "full",
        parentThread: makeParentThread(),
        parentThreadExecutionPermissionMode: "auto",
        thread: makeThread({
          parentThreadId: "thr-parent-1",
          providerId: "codex",
        }),
      }),
    ).toBe("auto");
  });

  it("clamps the child's recorded mode to the parent's current mode", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        lastExecutionPermissionMode: "full",
        parentThread: makeParentThread(),
        parentThreadExecutionPermissionMode: "auto",
        thread: makeThread({
          parentThreadId: "thr-parent-1",
          providerId: "codex",
        }),
      }),
    ).toBe("auto");
  });

  it("clamps a child in another project to its parent's mode", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        requestedPermissionMode: "full",
        parentThread: makeParentThread({ projectId: "proj-other" }),
        parentThreadExecutionPermissionMode: "auto",
        thread: makeThread({
          parentThreadId: "thr-parent-1",
          projectId: "proj-1",
          providerId: "codex",
        }),
      }),
    ).toBe("auto");
  });

  it("keeps an explicit full request under a full parent", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        requestedPermissionMode: "full",
        parentThread: makeParentThread(),
        parentThreadExecutionPermissionMode: "full",
        thread: makeThread({
          parentThreadId: "thr-parent-1",
          providerId: "codex",
        }),
      }),
    ).toBe("full");
  });

  it("allows a child to run below its parent's mode", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        requestedPermissionMode: "accept-edits",
        parentThread: makeParentThread(),
        parentThreadExecutionPermissionMode: "full",
        thread: makeThread({
          parentThreadId: "thr-parent-1",
          providerId: "codex",
        }),
      }),
    ).toBe("accept-edits");
  });

  it("uses root-thread defaults when the parent reference is not live", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        parentThread: makeParentThread({
          deletedAt: Date.now(),
        }),
        projectExecutionPermissionMode: "accept-edits",
        thread: makeThread({
          parentThreadId: "thr-deleted-parent-1",
          providerId: "codex",
        }),
      }),
    ).toBe("accept-edits");
  });

  it("still uses project permission defaults for root threads", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        projectExecutionPermissionMode: "accept-edits",
        thread: makeThread(),
      }),
    ).toBe("accept-edits");
  });
});
