import {
  experimental_findCliExecutable as findCliExecutable,
  experimental_isClaudeNpmPlaceholder as isClaudeNpmPlaceholder,
  type InstructionMode,
  type ReasoningLevel,
  type RuntimePermissionScope,
} from "@get-bb/plugin-sdk/provider-bridge";
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Options, Settings } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudePermissionMode } from "../interactive-contract.js";
import type {
  ClaudeMutableFlagSettings,
  ClaudeSdkReasoningEffort,
  SdkSessionOptions,
} from "./sdk-session.js";

export interface BuildSessionOptionsArgs {
  additionalWorkspaceWriteRoots?: readonly string[];
  baseInstructions?: string;
  cwd: string;
  disallowedTools?: readonly string[];
  instructionMode: InstructionMode;
  model?: string;
  permissionMode: ClaudePermissionMode;
  permissionScope: RuntimePermissionScope;
  plugins?: Options["plugins"];
  reasoningLevel?: ReasoningLevel;
  workflowsEnabled: boolean;
  chromeEnabled: boolean;
  claudeAiConnectorsEnabled?: boolean;
  memoryEnabled?: boolean;
}

export interface PermissionEscalationWorkContext {
  agentId?: string;
  promptId?: string;
  toolUseId?: string;
}

interface ResolveClaudeCodeExecutableArgs {
  env: NodeJS.ProcessEnv;
}

const SUMMARIZED_ADAPTIVE_THINKING = {
  type: "adaptive",
  display: "summarized",
} satisfies Exclude<Options["thinking"], undefined>;
const CLAUDE_CODE_EXECUTABLE_ENV = "BB_CLAUDE_CODE_EXECUTABLE";

export function toSdkEffort(
  reasoningLevel: ReasoningLevel,
): ClaudeSdkReasoningEffort {
  if (reasoningLevel === "ultracode") return "xhigh";
  if (reasoningLevel === "none") return "low";
  if (reasoningLevel === "ultra") return "max";
  return reasoningLevel;
}

function buildFlagSettings(params: BuildSessionOptionsArgs): Settings {
  return {
    autoMemoryEnabled: params.memoryEnabled ?? true,
    disableClaudeAiConnectors: params.claudeAiConnectorsEnabled !== true,
    enableWorkflows: params.workflowsEnabled,
    ultracode: params.reasoningLevel === "ultracode",
  };
}

export function buildChromeExtraArgs(
  chromeEnabled: boolean,
): Options["extraArgs"] | undefined {
  return chromeEnabled ? { chrome: null } : undefined;
}

export function buildMutableFlagSettings(args: {
  memoryEnabled: boolean;
  reasoningLevel: ReasoningLevel | undefined;
  workflowsEnabled: boolean;
}): ClaudeMutableFlagSettings {
  return {
    autoMemoryEnabled: args.memoryEnabled,
    enableWorkflows: args.workflowsEnabled,
    ...(args.reasoningLevel !== undefined
      ? { effortLevel: toSdkEffort(args.reasoningLevel) }
      : {}),
    ultracode: args.reasoningLevel === "ultracode",
  };
}

export function buildReadonlyDenialMessage(): string {
  return "bb readonly mode allows reading and analysis only. Continue with a read-only answer; do not modify files, run mutating shell commands, use network, or use mutating tools.";
}

export function buildWorkspaceWriteDenialMessage(): string {
  return "Cloudroom's workspace sandbox allows work inside the current workspace only. Stay inside the workspace or explain why extra access is needed.";
}

type PermissionSessionOptionsArgs = Pick<
  BuildSessionOptionsArgs,
  "additionalWorkspaceWriteRoots" | "cwd" | "permissionMode" | "permissionScope"
>;

function usesWorkspaceSandbox(params: PermissionSessionOptionsArgs): boolean {
  return (
    params.permissionScope === "workspace" &&
    (params.permissionMode === "acceptEdits" ||
      params.permissionMode === "auto")
  );
}

const LINUX_SANDBOX_PROBE_ARGS = (
  "--ro-bind / / --dev /dev --unshare-pid --unshare-user --cap-drop ALL " +
  "--proc /proc -- unshare -Urpm --fork true"
).split(" ");
let linuxSandboxWorks: boolean | undefined;

// Ubuntu's user-namespace limits stop Claude's bubblewrap sandbox, so every
// command fails and its unsandboxed retry is refused. Mirror Claude's bwrap
// call plus the nested namespace its seccomp helper makes, once per process.
// If it fails, skip the sandbox; Claude then asks before commands instead.
function claudeSandboxCanStart(): boolean {
  if (process.platform !== "linux" || process.env.VITEST) return true;
  linuxSandboxWorks ??=
    spawnSync("bwrap", LINUX_SANDBOX_PROBE_ARGS, {
      stdio: "ignore",
      timeout: 5_000,
    }).status === 0;
  return linuxSandboxWorks;
}

const MAC_USER_TEMP_DIR = /^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/u;

// macOS APIs (Swift, NSTemporaryDirectory, Vision) ignore the sandbox's
// TMPDIR and write to the user's /var/folders/.../T, which Codex's workspace
// sandbox already allows (#1117). TMPDIR can point anywhere, even $HOME, so ask
// macOS for the dir and grant it only in its canonical form.
export function macUserTempDirs(
  getconf: () => string | null | undefined = () =>
    spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
      encoding: "utf8",
      timeout: 5_000,
    }).stdout,
): string[] {
  if (process.platform !== "darwin") return [];
  try {
    const reported = getconf()?.trim();
    const dir = reported ? realpathSync(reported) : "";
    return MAC_USER_TEMP_DIR.test(dir) ? [dir] : [];
  } catch {
    return [];
  }
}

// Claude reads project settings from cwd and the local file from the repo root
// (the main checkout's root in a worktree), so check all three. null = unsure.
function claudeProjectDirs(cwd: string): string[] | null {
  const git = spawnSync(
    "git",
    [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ],
    { cwd, encoding: "utf8", timeout: 5_000 },
  );
  const [toplevel, commonDir] =
    git.status === 0 ? git.stdout.trim().split("\n") : [];
  if (!toplevel || !commonDir || basename(commonDir) !== ".git") return null;
  return [cwd, toplevel, dirname(commonDir)];
}

// Our --settings outrank the user's own Claude settings. Add the trustd flag
// only when every settings file Claude may read is absent or valid JSON and
// none sets sandbox.enableWeakerNetworkIsolation: false. Any doubt leaves it off.
export function claudeSettingsAllowTrustd(
  cwd: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const projectDirs = claudeProjectDirs(cwd);
  if (!projectDirs) return false;
  const userDir =
    env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
  return [
    join(userDir, "settings.json"),
    ...projectDirs.flatMap((dir) => [
      join(dir, ".claude", "settings.json"),
      join(dir, ".claude", "settings.local.json"),
    ]),
  ].every((path) => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    try {
      return JSON.parse(text)?.sandbox?.enableWeakerNetworkIsolation !== false;
    } catch {
      return false;
    }
  });
}

function buildWorkspaceWriteSandbox(
  params: PermissionSessionOptionsArgs,
  env: NodeJS.ProcessEnv,
): Options["sandbox"] | undefined {
  if (!usesWorkspaceSandbox(params) || !claudeSandboxCanStart()) {
    return undefined;
  }

  const allowWrite = [
    ...(params.additionalWorkspaceWriteRoots ?? []),
    ...macUserTempDirs(),
  ];
  return {
    enabled: true,
    failIfUnavailable: false,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: true,
    // macOS only: lets curl, gh, and Go tools reach the system trust service
    // (com.apple.trustd.agent) to verify TLS certificates (#1117).
    ...(claudeSettingsAllowTrustd(params.cwd, env)
      ? { enableWeakerNetworkIsolation: true }
      : {}),
    network: { allowLocalBinding: true },
    ...(allowWrite.length > 0 ? { filesystem: { allowWrite } } : {}),
  };
}

export function buildPermissionSessionOptions(
  params: PermissionSessionOptionsArgs,
  env: NodeJS.ProcessEnv,
): Pick<
  SdkSessionOptions,
  "additionalDirectories" | "permissionMode" | "sandbox"
> {
  const sandbox = buildWorkspaceWriteSandbox(params, env);
  const additionalDirectories = usesWorkspaceSandbox(params)
    ? (params.additionalWorkspaceWriteRoots ?? [])
    : [];
  return {
    permissionMode: params.permissionMode,
    ...(sandbox ? { sandbox } : {}),
    ...(additionalDirectories.length > 0
      ? { additionalDirectories: [...additionalDirectories] }
      : {}),
  };
}

export function resolveClaudeCodeExecutable(
  args: ResolveClaudeCodeExecutableArgs,
): string | null {
  const explicitPath = args.env[CLAUDE_CODE_EXECUTABLE_ENV];
  const trimmedExplicitPath = explicitPath?.trim();
  if (trimmedExplicitPath && trimmedExplicitPath.length > 0) {
    try {
      accessSync(trimmedExplicitPath, constants.X_OK);
    } catch {
      throw new Error(
        `${CLAUDE_CODE_EXECUTABLE_ENV} must point to an executable Claude CLI path: ${trimmedExplicitPath}`,
      );
    }
    // npm's unfinished stub can't run Claude (#1148); say so at start.
    if (isClaudeNpmPlaceholder(trimmedExplicitPath)) {
      throw new Error(
        `${CLAUDE_CODE_EXECUTABLE_ENV} points to npm's unfinished Claude Code placeholder, not the Claude CLI: ${trimmedExplicitPath}. Reinstall Claude Code there, or point ${CLAUDE_CODE_EXECUTABLE_ENV} at a working claude.`,
      );
    }
    return trimmedExplicitPath;
  }

  return findCliExecutable("claude", args.env);
}

export function buildSessionOptions(
  params: BuildSessionOptionsArgs,
  env: NodeJS.ProcessEnv,
): SdkSessionOptions {
  const systemPrompt: Exclude<Options["systemPrompt"], undefined> =
    params.instructionMode === "replace"
      ? (params.baseInstructions ?? "You are a helpful coding assistant.")
      : {
          type: "preset",
          preset: "claude_code",
          ...(params.baseInstructions && params.baseInstructions.length > 0
            ? { append: params.baseInstructions }
            : {}),
        };
  const model = params.model;
  const pathToClaudeCodeExecutable = resolveClaudeCodeExecutable({ env });
  const flagSettings = buildFlagSettings(params);
  const extraArgs = buildChromeExtraArgs(params.chromeEnabled);

  return {
    cwd: params.cwd,
    systemPrompt,
    model,
    env,
    ...buildPermissionSessionOptions(params, env),
    ...(params.reasoningLevel
      ? { effort: toSdkEffort(params.reasoningLevel) }
      : {}),
    ...(params.reasoningLevel
      ? { thinking: SUMMARIZED_ADAPTIVE_THINKING }
      : {}),
    settings: flagSettings,
    ...(extraArgs ? { extraArgs } : {}),
    ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
    ...(params.plugins ? { plugins: params.plugins } : {}),
    ...(params.disallowedTools && params.disallowedTools.length > 0
      ? { disallowedTools: [...params.disallowedTools] }
      : {}),
  };
}
