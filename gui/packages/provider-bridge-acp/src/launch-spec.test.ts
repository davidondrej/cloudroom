import { describe, expect, it } from "vitest";
import { acpLaunchSpecSchema, normalizeAcpLaunchSpec } from "./launch-spec.js";

describe("normalizeAcpLaunchSpec", () => {
  it("drops a model CLI that lists nothing, mode-less permission CLI and env, and every absent field", () => {
    expect(
      normalizeAcpLaunchSpec({
        displayName: "Custom ACP",
        command: "custom-agent",
        args: [],
        env: {},
        modelCli: {
          listArgs: [],
          selectFlag: "--model",
          primaryModels: ["model-a"],
        },
        reasoningCli: {
          flag: "--reasoning-effort",
          supportedLevels: ["low", "medium", "high"],
          levelValues: { max: "high" },
          defaultLevel: "high",
        },
        permissionCli: {},
        permissionEnv: {},
      }),
    ).toEqual({
      displayName: "Custom ACP",
      command: "custom-agent",
      args: [],
      env: {},
      reasoningCli: {
        flag: "--reasoning-effort",
        supportedLevels: ["low", "medium", "high"],
        levelValues: { max: "high" },
        defaultLevel: "high",
      },
    });
  });

  it("keeps every part that carries something, and is idempotent over a parsed spec", () => {
    const spec = acpLaunchSpecSchema.parse({
      displayName: "Cursor",
      command: "cursor-agent",
      args: ["acp"],
      env: { CURSOR_API_KEY: "k" },
      cwd: "/repo",
      modelCli: {
        listArgs: ["models"],
        selectFlag: "--model",
        primaryModels: ["composer"],
      },
      permissionCli: { full: ["--force"] },
      permissionEnv: {
        full: { AGENT_MODE: "full-access" },
        workspaceWrite: { AGENT_MODE: "ask" },
      },
      nativeSkillRoots: { user: [".cursor/skills"], project: [] },
    });
    const normalized = normalizeAcpLaunchSpec(spec);
    expect(normalized).toEqual(spec);
    expect(normalizeAcpLaunchSpec(normalized)).toEqual(normalized);
  });
});

describe("acpLaunchSpecSchema permissionEnv", () => {
  const base = {
    displayName: "Custom ACP",
    command: "custom-agent",
    args: [],
    env: {},
  };

  it.each([
    ["no mode", {}],
    ["a mode that sets nothing", { workspaceWrite: {} }],
    ["an invalid variable name", { full: { "BAD-NAME": "1" } }],
    ["an unknown mode", { auto: { AGENT_MODE: "auto" } }],
  ])("rejects %s", (_label, permissionEnv) => {
    expect(
      acpLaunchSpecSchema.safeParse({ ...base, permissionEnv }).success,
    ).toBe(false);
  });
});
