import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import antigravityPlugin from "./server.js";

function registeredDeclaration() {
  const host = createFakePluginHost({ pluginId: "provider-antigravity" });
  antigravityPlugin(host.bb);
  const declaration = host.harness.registrations.providerRegistrations.find(
    (entry) => entry.id === "antigravity",
  );
  if (declaration === undefined)
    throw new Error("expected antigravity to be registered");
  return declaration;
}

describe("the Antigravity plugin's provider", () => {
  it("is a provider of its own, always listed, on the ACP bridge's Antigravity dialect", () => {
    const declaration = registeredDeclaration();
    expect(declaration.displayName).toBe("Antigravity");
    // Like Codex and Claude Code: listed whether or not the CLI is installed yet.
    expect(declaration.experimental_visibility).toBe("always");
    expect(declaration.family).toBeUndefined();
    expect(declaration.experimental_bridgeOptions).toEqual({
      acpDialect: "antigravity",
      acpLaunchSpec: {
        displayName: "Antigravity",
        command: "agy",
        args: ["acp"],
        env: {},
      },
    });
  });

  it("offers Google sign-in, plan usage and its installer", () => {
    const declaration = registeredDeclaration();
    expect(declaration.strings?.signInCommand).toBe("agy acp --login");
    expect(declaration.experimental_modelDiscoveryRestart).toBe(true);
    expect(declaration.maintenance).toEqual({
      health: true,
      usage: true,
      installation: true,
    });
  });

  it("declares what the CLI supports over ACP", () => {
    expect(registeredDeclaration().capabilities).toEqual({
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      fork: "none",
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: ["low", "medium", "high", "xhigh"],
    });
  });

  it("declares the folders Antigravity reads skills from", () => {
    const roots = registeredDeclaration().experimental_nativeSkillRoots;
    expect(roots?.user).toMatchObject([
      { path: ".gemini/config/skills", ancestors: false },
      { path: ".gemini/antigravity-cli/skills", ancestors: false },
      { path: ".gemini/skills", ancestors: false },
    ]);
    expect(roots?.project).toMatchObject([
      { path: ".agents/skills", ancestors: true },
      { path: ".agent/skills", ancestors: true },
    ]);
  });
});
