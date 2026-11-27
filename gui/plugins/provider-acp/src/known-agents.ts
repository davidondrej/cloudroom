import type { AcpAgentDefinition } from "./agents.js";
import { resolveCursorNativeRoots } from "./native-roots/cursor.js";
import { resolveGrokNativeRoots } from "./native-roots/grok.js";
import { resolveHermesNativeRoots } from "./native-roots/hermes.js";
import { resolveOmpNativeRoots } from "./native-roots/omp.js";
import { resolveOpenCodeNativeRoots } from "./native-roots/opencode.js";

const PLUGIN_ID = "provider-acp";

function declaredIcon(name: string): string {
  return `${PLUGIN_ID}/${name}`;
}

const CLAUDE_SKILLS_ROOT = {
  path: ".claude/skills",
  skipIfManifest: ".claude-plugin/plugin.json",
} as const;
type RootEntry =
  | string
  | { readonly path: string; readonly skipIfManifest?: string };
function entryOf(entry: RootEntry) {
  return typeof entry === "string" ? { path: entry } : entry;
}
function plainRoots(entries: readonly RootEntry[]) {
  return entries.map(entryOf);
}

function recursiveRoots(entries: readonly RootEntry[]) {
  return entries.map((entry) => ({ ...entryOf(entry), recursive: true }));
}

function ancestorRoots(entries: readonly RootEntry[]) {
  return entries.map((entry) => ({ ...entryOf(entry), ancestors: true }));
}

export const KNOWN_ACP_AGENTS: readonly AcpAgentDefinition[] = [
  {
    id: "acp-antigravity",
    displayName: "Antigravity",
    icon: declaredIcon("antigravity"),
    // Signs in by pasting a code from Google's page, so it also works in a terminal with no browser.
    signInCommand: "agy acp --login",
    installUrl: "https://antigravity.google/docs/getting-started",
    installer: {
      scriptUrl: "https://antigravity.google/cli/install.sh",
      powershellUrl: "https://antigravity.google/cli/install.ps1",
    },
    // `agy acp` was added in 1.5.0.
    minimumVersion: "1.5.0",
    // Shown before it's installed: the picker offers Install, then Sign in (ADR 20261121-142131).
    dialect: "antigravity",
    providerUsage: true,
    // Antigravity has no fast mode; its old /fast only skipped planning and was removed in 1.1.0.
    supportsServiceTier: false,
    // agy 1.5.14 doesn't advertise session/fork; Cloudroom forks it as text (ADR 20261121-141157).
    fork: "none",
    launch: {
      displayName: "Antigravity",
      command: "agy",
      args: ["acp"],
      env: {},
      permissionCli: {
        full: ["--dangerously-skip-permissions"],
        insertAfterArgs: 1,
      },
      // The CLI reads ~/.gemini/config/skills plus its own two, and the bridge adds ~/.agents/skills and ~/.claude/skills
      // to its skills.json at launch (antigravity.ts); projects use .agents/skills up to the repository root.
      nativeSkillRoots: {
        user: plainRoots([
          ".gemini/config/skills",
          ".gemini/antigravity-cli/skills",
          ".gemini/skills",
          ".agents/skills",
          CLAUDE_SKILLS_ROOT,
        ]),
        project: ancestorRoots([".agents/skills"]),
      },
    },
  },
  {
    id: "acp-cursor",
    displayName: "Cursor",
    icon: declaredIcon("cursor"),
    iconTint: { light: "#111827", dark: "#F5F5F5" },
    signInCommand: "cursor-agent login",
    installUrl: "https://cursor.com/docs/cli/installation",
    dialect: "cursor",
    providerUsage: true,
    providerInstallation: true,
    parameterizedModelPicker: true,
    primaryModels: [
      "default",
      "grok-4.6",
      "gpt-5.6-sol",
      "claude-opus-5-5",
      "claude-fable-5-2",
      "claude-fable-5",
      "composer-2.5",
    ],
    reasoningProbePriorityModelIds: ["grok-4.6", "grok-4.5"],
    fork: "none",
    launch: {
      displayName: "Cursor",
      command: "cursor-agent",
      // Cursor merges every .cursor/cli.json from the repo root down into its permission rules, so a cloned repo could
      // pre-approve commands and Manual would never ask. This root option keeps only the user's own rules
      // (security sweep 9, 2026-11-17).
      args: ["--disable-project-configs", "acp"],
      env: {},
      modelCli: {
        listArgs: ["--list-models"],
        primaryModels: [],
      },
      nativeSkillRoots: {
        user: recursiveRoots([
          ".cursor/skills",
          ".agents/skills",
          CLAUDE_SKILLS_ROOT,
          ".codex/skills",
        ]),
        project: ancestorRoots(
          recursiveRoots([
            ".cursor/skills",
            ".agents/skills",
            CLAUDE_SKILLS_ROOT,
            ".codex/skills",
          ]),
        ),
      },
    },
    nativeRootsResolver: resolveCursorNativeRoots,
  },
  {
    id: "acp-opencode",
    displayName: "opencode",
    icon: declaredIcon("opencode"),
    iconTint: { light: "#2563EB", dark: "#2563EB" },
    signInCommand: "opencode auth login",
    installUrl: "https://opencode.ai/docs",
    installer: { scriptUrl: "https://opencode.ai/install" },
    visibility: "installed",
    dialect: "opencode",
    // A repo's opencode.json and plugins outrank any ceiling we set, so Manual
    // would not hold (security sweep 9, 2026-11-16).
    permissionModes: ["full"],
    supportsManualCompaction: true,
    fork: "tip",
    launch: {
      displayName: "opencode",
      command: "opencode",
      args: ["acp"],
      env: {},
      nativeSkillRoots: {
        user: [CLAUDE_SKILLS_ROOT, ".agents/skills"],
        project: ancestorRoots([
          ".opencode/skills",
          CLAUDE_SKILLS_ROOT,
          ".agents/skills",
        ]),
      },
    },
    nativeRootsResolver: resolveOpenCodeNativeRoots,
  },
  {
    id: "acp-omp",
    displayName: "omp",
    icon: declaredIcon("omp"),
    iconTint: { light: "#9333EA", dark: "#9333EA" },
    signInCommand: "omp login",
    installUrl: "https://omp.sh",
    installer: { scriptUrl: "https://omp.sh/install" },
    visibility: "installed",
    supportsManualCompaction: true,
    fork: "tip",
    launch: {
      displayName: "omp",
      command: "omp",
      args: ["acp"],
      env: { OMP_MCP_TIMEOUT_MS: "900000" },
      nativeSkillRoots: {
        user: plainRoots([
          ".agent/skills",
          ".agents/skills",
          CLAUDE_SKILLS_ROOT,
        ]),
        project: ancestorRoots([
          ".omp/skills",
          ".pi/skills",
          ".agent/skills",
          ".agents/skills",
          CLAUDE_SKILLS_ROOT,
          ".codex/skills",
          ".opencode/skills",
        ]),
      },
    },
    nativeRootsResolver: resolveOmpNativeRoots,
  },
  {
    id: "acp-grok",
    displayName: "Grok Build",
    icon: declaredIcon("grok"),
    signInCommand: "grok login",
    installUrl: "https://docs.x.ai/build/overview",
    installer: { scriptUrl: "https://x.ai/cli/install.sh" },
    visibility: "installed",
    dialect: "grok",
    fork: "none",
    reasoningLevels: ["low", "medium", "high"],
    launch: {
      displayName: "Grok Build",
      command: "grok",
      args: ["agent", "stdio"],
      env: {},
      modelCli: {
        listArgs: ["models"],
        selectFlag: "--model",
        primaryModels: ["grok-4.5", "grok-composer-2.5-fast"],
      },
      permissionCli: {
        full: ["--always-approve"],
        insertAfterArgs: 1,
      },
      reasoningCli: {
        flag: "--reasoning-effort",
        supportedLevels: ["low", "medium", "high"],
        levelValues: {
          none: "low",
          xhigh: "high",
          ultracode: "high",
          max: "high",
        },
        defaultLevel: "high",
      },
      nativeSkillRoots: {
        user: recursiveRoots([".agents/skills"]),
        project: [
          { path: ".grok/skills", recursive: true, ancestors: true },
          { path: ".agents/skills", recursive: true, ancestors: true },
        ],
      },
    },
    nativeRootsResolver: resolveGrokNativeRoots,
  },
  {
    id: "acp-fx",
    displayName: "fx",
    icon: declaredIcon("fx"),
    signInCommand: "fx login",
    installUrl: "https://fx.sh",
    installer: { scriptUrl: "https://fx.sh/setup.sh" },
    visibility: "installed",
    dialect: "fx",
    fork: "none",
    primaryModels: [
      "anthropic/claude-opus-5.5",
      "anthropic/claude-fable-5.2",
      "anthropic/claude-sonnet-5",
      "openai/gpt-6-sol",
      "spacexai/grok-4.7",
    ],
    launch: {
      displayName: "fx",
      command: "fx",
      args: ["acp"],
      env: {},
      permissionEnv: {
        full: { FX_PERMISSION_MODE: "full-access" },
        workspaceWrite: { FX_PERMISSION_MODE: "ask" },
      },
    },
  },
  {
    id: "acp-hermes-agent",
    displayName: "Hermes Agent",
    icon: declaredIcon("hermes-agent"),
    signInCommand: "hermes login",
    installUrl: "https://hermes-agent.nousresearch.com",
    installer: {
      scriptUrl: "https://hermes-agent.nousresearch.com/install.sh",
      powershellUrl: "https://hermes-agent.nousresearch.com/install.ps1",
      args: ["--non-interactive"],
      powershellArgs: ["-NonInteractive"],
    },
    visibility: "installed",
    fork: "tip",
    reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    launch: {
      displayName: "Hermes Agent",
      command: "hermes",
      args: ["acp"],
      env: {},
      nativeReasoning: {
        configId: "reasoning_effort",
        supportedLevels: ["none", "low", "medium", "high", "xhigh", "max"],
        defaultLevel: "medium",
      },
    },
    nativeRootsResolver: resolveHermesNativeRoots,
  },
  {
    id: "acp-openclaw",
    displayName: "OpenClaw",
    icon: declaredIcon("openclaw"),
    signInCommand: "openclaw onboard --install-daemon",
    installUrl: "https://openclaw.ai",
    installer: {
      scriptUrl: "https://openclaw.ai/install.sh",
      args: ["--no-onboard"],
    },
    visibility: "installed",
    dialect: "openclaw",
    fork: "none",
    reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    launch: {
      displayName: "OpenClaw",
      command: "openclaw",
      args: ["acp", "--no-prefix-cwd"],
      env: { OPENCLAW_HIDE_BANNER: "1", OPENCLAW_SUPPRESS_NOTES: "1" },
      modelCli: { listArgs: ["models", "list", "--plain"], primaryModels: [] },
      nativeReasoning: {
        configId: "thought_level",
        supportedLevels: ["low", "medium", "high", "xhigh", "max"],
        defaultLevel: "medium",
      },
      nativeSkillRoots: {
        user: plainRoots([".agents/skills", ".openclaw/skills"]),
        project: ancestorRoots([".agents/skills"]),
      },
    },
  },
  {
    id: "acp-devin",
    displayName: "Devin",
    icon: declaredIcon("devin"),
    signInCommand: "devin auth login",
    installUrl: "https://devin.ai",
    visibility: "installed",
    fork: "none",
    launch: {
      displayName: "Devin",
      command: "devin",
      args: ["acp"],
      env: {},
    },
  },
  {
    id: "acp-droid",
    displayName: "Droid",
    icon: declaredIcon("droid"),
    signInCommand: "droid",
    installUrl: "https://docs.factory.com/droid-cli/quickstart",
    installer: { scriptUrl: "https://app.factory.ai/cli" },
    visibility: "installed",
    primaryModels: [
      "claude-opus-5-5",
      "gpt-6.1-sol",
      "claude-fable-5.1",
      "kimi-k3",
      "auto",
    ],
    fork: "tip",
    launch: {
      displayName: "Droid",
      command: "droid",
      args: ["exec", "--output-format", "acp"],
      env: {},
      nativeSkillRoots: {
        user: recursiveRoots([".factory/skills", ".agents/skills"]),
        project: ancestorRoots(
          recursiveRoots([".factory/skills", ".agents/skills"]),
        ),
      },
    },
  },
  {
    id: "acp-kilo",
    displayName: "Kilo Code",
    icon: declaredIcon("kilo"),
    signInCommand: "kilo auth login",
    installUrl: "https://kilo.ai/docs/cli",
    installer: { scriptUrl: "https://kilo.ai/cli/install" },
    // Kilo 0.x (the old npm CLI) has no `acp` command (#1156).
    minimumVersion: "1.0.0",
    visibility: "installed",
    dialect: "opencode",
    primaryModels: [
      "kilo/kilo-auto/free",
      "kilo/kilo-auto/frontier",
      "kilo/kilo-auto/balanced",
      "kilo/kilo-auto/efficient",
    ],
    fork: "tip",
    launch: {
      displayName: "Kilo Code",
      command: "kilo",
      args: ["acp"],
      env: {},
    },
  },
  {
    id: "acp-cline",
    displayName: "Cline",
    icon: declaredIcon("cline"),
    signInCommand: "cline auth",
    installUrl: "https://docs.cline.bot/cline-cli/installation",
    installer: { npmPackage: "cline" },
    visibility: "installed",
    launch: {
      displayName: "Cline",
      command: "cline",
      args: ["--acp"],
      env: {},
    },
  },
  {
    id: "acp-kimi",
    displayName: "Kimi Code",
    icon: declaredIcon("kimi"),
    signInCommand: "kimi login",
    installUrl: "https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started",
    installer: {
      scriptUrl: "https://code.kimi.com/kimi-code/install.sh",
      powershellUrl: "https://code.kimi.com/kimi-code/install.ps1",
    },
    visibility: "installed",
    dialect: "kimi",
    fork: "tip",
    launch: {
      displayName: "Kimi Code",
      command: "kimi",
      args: ["acp"],
      env: {},
      // Kimi reads ~/.kimi-code/skills (KIMI_CODE_HOME) and ~/.agents/skills; projects add the same two at their root.
      nativeSkillRoots: {
        user: plainRoots([".kimi-code/skills", ".agents/skills"]),
        project: ancestorRoots([".kimi-code/skills", ".agents/skills"]),
      },
    },
  },
  {
    // Agent Zero itself runs on its own server, usually Docker; `a0 acp` bridges to it and runs its file edits and
    // commands in the thread's folder (ADR 20261116-153548). Its model is the server's own setting.
    id: "acp-agent-zero",
    displayName: "Agent Zero",
    icon: declaredIcon("agent-zero"),
    signInCommand: "a0",
    installUrl: "https://github.com/agent0ai/a0-connector",
    installer: {
      scriptUrl: "https://raw.githubusercontent.com/agent0ai/a0-connector/main/install.sh",
      powershellUrl: "https://raw.githubusercontent.com/agent0ai/a0-connector/main/install.ps1",
    },
    visibility: "installed",
    dialect: "agent-zero",
    fork: "none",
    // `a0` runs commands without asking, so only Full is honest.
    permissionModes: ["full"],
    launch: {
      displayName: "Agent Zero",
      command: "a0",
      args: ["acp"],
      env: {},
    },
  },
];

export const RESERVED_ACP_PROVIDER_IDS: ReadonlySet<string> = new Set(
  KNOWN_ACP_AGENTS.filter(
    (agent) => (agent.visibility ?? "always") === "always",
  ).map((agent) => agent.id),
);
