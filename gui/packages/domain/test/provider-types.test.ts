import { describe, expect, it } from "vitest";
import { usesTextFork } from "../src/provider-fork.js";
import { providerInfoSchema } from "../src/provider-types.js";

describe("usesTextFork", () => {
  it("clones a session only when the same harness can clone it there", () => {
    // Local: native when the session can be cloned at that point.
    expect(usesTextFork("acp-opencode", undefined, undefined, undefined, false, true)).toBe(false);
    expect(usesTextFork("acp-antigravity", undefined, undefined, undefined, false, false)).toBe(true);
    // Cloud: Claude Code or Codex on the same model, and only with a session to clone.
    expect(usesTextFork("claude-code", "opus", "claude-code", "opus", true, true)).toBe(false);
    expect(usesTextFork("claude-code", "opus", "claude-code", "opus", true, false)).toBe(true);
    expect(usesTextFork("claude-code", "opus", "claude-code", "fable", true, true)).toBe(true);
    expect(usesTextFork("acp-opencode", undefined, undefined, undefined, true, true)).toBe(true);
    // Another harness always gets text.
    expect(usesTextFork("claude-code", undefined, "codex", undefined, false, true)).toBe(true);
  });
});

describe("provider info schema", () => {
  const baseProviderInfo = {
    id: "codex",
    pluginId: "provider-codex",
    displayName: "Codex",
    logoUrl: null,
    maintenance: { health: true, usage: true, installation: false },
    capabilities: {
      supportsThreadArchive: true,
      supportsThreadRename: true,
      supportsServiceTier: true,
      supportsNativeUserQuestion: false,
      supportsFork: true,
      supportsSessionRewind: true,
      modelCatalogScope: "workspace",
      permissionModes: ["accept-edits", "auto", "full"],
    },
    completedTurnDisplay: "collapse",
    available: true,
  };

  it("requires provider-declared composer actions", () => {
    expect(() => providerInfoSchema.parse(baseProviderInfo)).toThrow();
  });

  it("accepts each composer action kind", () => {
    expect(
      providerInfoSchema.parse({
        ...baseProviderInfo,
        composerActions: [
          { kind: "skills", trigger: "/" },
          {
            kind: "plan",
            command: { trigger: "/", name: "plan", trailingText: " " },
          },
          {
            kind: "goal",
            command: { trigger: "/", name: "goal", trailingText: " " },
          },
        ],
      }).composerActions,
    ).toEqual([
      { kind: "skills", trigger: "/" },
      {
        kind: "plan",
        command: { trigger: "/", name: "plan", trailingText: " " },
      },
      {
        kind: "goal",
        command: { trigger: "/", name: "goal", trailingText: " " },
      },
    ]);
  });

  it("validates action-specific fields", () => {
    expect(() =>
      providerInfoSchema.parse({
        ...baseProviderInfo,
        composerActions: [{ kind: "skills", trigger: "$" }],
      }),
    ).toThrow();
    expect(() =>
      providerInfoSchema.parse({
        ...baseProviderInfo,
        composerActions: [
          {
            kind: "plan",
            command: { trigger: "/", name: "", trailingText: " " },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      providerInfoSchema.parse({
        ...baseProviderInfo,
        composerActions: [
          {
            kind: "goal",
            command: { trigger: "/", name: "goal now", trailingText: " " },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      providerInfoSchema.parse({
        ...baseProviderInfo,
        composerActions: [
          {
            kind: "goal",
            command: { trigger: "/", name: "goal", trailingText: " now" },
          },
        ],
      }),
    ).toThrow();
  });
});
