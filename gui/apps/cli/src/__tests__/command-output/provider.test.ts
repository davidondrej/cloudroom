import { describe, expect, it, vi } from "vitest";
import {
  setupCommandOutputTestEnvironment,
  collectLogPayloads,
  getHelpOutput,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerProviderCommands } from "../../commands/provider.js";

describe("room-cli provider command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerProviderCommands(program, () => "http://server");

  it("room-cli provider list renders the shared borderless table", async () => {
    const get = vi.fn(async () => [{ id: "openai", displayName: "OpenAI" }]);
    stubServerApi({ "v1.system.providers.$get": get });

    await runCommand(["provider", "list"], register);

    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "",
      "ID      Name  \n------  ------\nopenai  OpenAI",
      "",
    ]);
  });

  it("discovers provider routing selectors in command help", async () => {
    const help = await getHelpOutput(["provider", "list"], register);
    expect(help).toContain("--machine <id-or-name>");
    expect(help).toContain("--host <id-or-name>");
    expect(help).toContain("--environment <id>");
  });

  it("room-cli provider list resolves a machine and preserves portable JSON output", async () => {
    const getProviders = vi.fn(async () => [
      { id: "acp-remote", displayName: "Remote ACP" },
    ]);
    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => [
        {
          id: "host-remote",
          name: "builder",
          status: "connected",
          lastSeenAt: 1,
          lastRejectedProtocolVersion: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      "v1.system.providers.$get": getProviders,
    });

    await runCommand(
      ["provider", "list", "--machine", "builder", "--json"],
      register,
    );

    expect(getProviders).toHaveBeenCalledWith({
      query: { hostId: "host-remote" },
    });
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      JSON.stringify(
        [{ id: "acp-remote", displayName: "Remote ACP" }],
        null,
        2,
      ),
    ]);
  });

  it("room-cli provider models renders the shared borderless table", async () => {
    const get = vi.fn(async () => [
      { model: "gpt-5", displayName: "GPT-5", isDefault: true },
    ]);
    stubServerApi({
      "v1.system.execution-options.$get": vi.fn(async () => ({
        providers: [],
        models: await get(),
        selectedOnlyModels: [],
      })),
    });

    await runCommand(["provider", "models", "openai"], register);

    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "Models for openai:",
      "",
      "Model  Name   Default\n-----  -----  -------\ngpt-5  GPT-5  *",
      "",
    ]);
  });

  it("room-cli provider models includes a matching selected-only model", async () => {
    const get = vi.fn(async () => ({
      providers: [],
      models: [
        {
          model: "claude-haiku-4-5",
          displayName: "Claude Haiku 4.5",
          isDefault: true,
        },
      ],
      selectedOnlyModels: [
        {
          model: "claude-opus-4-6",
          displayName: "Claude Opus 4.6",
          isDefault: false,
        },
      ],
    }));
    stubServerApi({ "v1.system.execution-options.$get": get });

    await runCommand(
      [
        "provider",
        "models",
        "claude-code",
        "--selected-model",
        "claude-opus-4-6",
      ],
      register,
    );

    expect(get).toHaveBeenCalledWith({
      query: {
        providerId: "claude-code",
      },
    });
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "Models for claude-code:",
      "",
      "Model             Name              Default\n----------------  ----------------  -------\nclaude-opus-4-6   Claude Opus 4.6\nclaude-haiku-4-5  Claude Haiku 4.5  *",
      "",
    ]);
  });

  it("room-cli provider models says how to sign in when a provider has no models", async () => {
    stubServerApi({
      "v1.system.execution-options.$get": vi.fn(async () => ({
        providers: [
          {
            id: "pi",
            strings: {
              signInHint: "Run `pi`, type /login, and pick a provider.",
            },
          },
        ],
        models: [],
        selectedOnlyModels: [],
        modelLoadError: null,
      })),
    });

    await runCommand(["provider", "models", "pi"], register);

    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "No models available. Run `pi`, type /login, and pick a provider.",
    ]);
  });

  it("room-cli provider models routes through an environment", async () => {
    const get = vi.fn(async () => ({
      providers: [],
      models: [],
      selectedOnlyModels: [],
      modelLoadError: null,
    }));
    stubServerApi({ "v1.system.execution-options.$get": get });

    await runCommand(
      ["provider", "models", "codex", "--environment", "env-remote", "--json"],
      register,
    );

    expect(get).toHaveBeenCalledWith({
      query: { environmentId: "env-remote", providerId: "codex" },
    });
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual(["[]"]);
  });

  it("room-cli provider models lists the calling thread's project, or --project (#1236)", async () => {
    // A project whose folder moved lists nothing; the machine lists gpt-5.
    const get = vi.fn(async (args: { query: { projectId?: string } }) => ({
      providers: [],
      models: args.query.projectId
        ? []
        : [{ model: "gpt-5", displayName: "GPT-5", isDefault: true }],
      selectedOnlyModels: [],
      modelLoadError: null,
    }));
    stubServerApi({ "v1.system.execution-options.$get": get });
    vi.stubEnv("ROOM_PROJECT_ID", "proj-env");

    await runCommand(
      ["provider", "models", "acp-opencode", "--json"],
      register,
    );
    await runCommand(
      [
        "provider",
        "models",
        "acp-opencode",
        "--project",
        "proj-flag",
        "--json",
      ],
      register,
    );

    expect(get).toHaveBeenNthCalledWith(1, {
      query: { providerId: "acp-opencode", projectId: "proj-env" },
    });
    expect(get).toHaveBeenNthCalledWith(2, {
      query: { providerId: "acp-opencode" },
    });
    expect(get).toHaveBeenNthCalledWith(3, {
      query: { providerId: "acp-opencode", projectId: "proj-flag" },
    });
    expect(get).toHaveBeenCalledTimes(3);
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      JSON.stringify(
        [{ model: "gpt-5", displayName: "GPT-5", isDefault: true }],
        null,
        2,
      ),
      "[]",
    ]);
  });

  it("rejects simultaneous machine and environment selectors", async () => {
    await expect(
      runCommand(
        [
          "provider",
          "list",
          "--host",
          "builder",
          "--environment",
          "env-remote",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    expect(console.error).toHaveBeenCalledWith(
      "Error: Cannot combine --machine or --host with --environment; the environment already selects its machine.",
    );
  });
});
