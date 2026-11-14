import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";

export const ANTIGRAVITY_PROVIDER_ID = "antigravity";
export const ANTIGRAVITY_SIGN_IN_COMMAND = "agy acp --login";

// Antigravity reads ~/.gemini/config/skills (and two CLI-only folders); projects add .agents/skills up to the repository root.
const USER_SKILL_ROOTS = [
  ".gemini/config/skills",
  ".gemini/antigravity-cli/skills",
  ".gemini/skills",
];
const PROJECT_SKILL_ROOTS = [".agents/skills", ".agent/skills"];

/**
 * Antigravity's CLI speaks ACP (`agy acp`), so its threads run on the SDK's ACP
 * bridge with the bridge's Antigravity dialect: Google sign-in state, plan
 * usage, and the installer all come from the CLI itself.
 */
export function antigravityProviderDeclaration(): PluginProviderDeclaration {
  return {
    id: ANTIGRAVITY_PROVIDER_ID,
    displayName: "Antigravity",
    icon: "./icons/antigravity.svg",
    strings: {
      signInHint: `Run \`${ANTIGRAVITY_SIGN_IN_COMMAND}\` on the machine to sign in with Google.`,
      expiredHint: `Your Antigravity session expired. Run \`${ANTIGRAVITY_SIGN_IN_COMMAND}\`, then reload.`,
      installUrl: "https://antigravity.google/docs/install",
      signInCommand: ANTIGRAVITY_SIGN_IN_COMMAND,
    },
    experimental_modelDiscoveryRestart: true,
    experimental_nativeSkillRoots: {
      user: USER_SKILL_ROOTS.map((path) => ({ path })),
      project: PROJECT_SKILL_ROOTS.map((path) => ({ path, ancestors: true })),
    },
    experimental_bridgeOptions: {
      acpDialect: "antigravity",
      acpLaunchSpec: {
        displayName: "Antigravity",
        command: "agy",
        args: ["acp"],
        env: {},
      },
    },
    models: { scope: "host" },
    maintenance: { health: true, usage: true, installation: true },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      // Sent as a prompt, `/compact` is answered by the model, not run by the CLI.
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      fork: "none",
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: ["low", "medium", "high", "xhigh"],
    },
    reasoningLevels: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
    ],
    composerActions: [],
  };
}
