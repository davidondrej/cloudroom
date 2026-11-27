import {
  experimental_findCliExecutable as findCliExecutable,
  experimental_isClaudeNpmPlaceholder as isClaudeNpmPlaceholder,
  experimental_privateDataPaths as privateDataPaths,
  type InstructionMode,
  type ReasoningLevel,
  type RuntimePermissionScope,
} from "@get-bb/plugin-sdk/provider-bridge";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Options, Settings } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudePermissionMode } from "../interactive-contract.js";
import type {
  ClaudeMutableFlagSettings,
  ClaudeSdkReasoningEffort,
  SdkSessionOptions,
} from "./sdk-session.js";

export interface BuildSessionOptionsArgs {
  additionalWorkspaceWriteRoots?: readonly string[];
  /** The mode the user chose; `permissionMode` is "plan" while Plan mode is on. */
  approvedPlanPermissionMode?: ClaudePermissionMode;
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
// Claude's own timers and schedules. Cloudroom can't see them, so a reply they wake can get lost: `room-cli wake` and
// loops replace them. The `/loop` and `/schedule` skills run on these tools, so they go too.
const CLAUDE_TIMER_TOOLS = [
  "ScheduleWakeup",
  "CronCreate",
  "CronDelete",
  "CronList",
  "RemoteTrigger",
];

export function toSdkEffort(
  reasoningLevel: ReasoningLevel,
): ClaudeSdkReasoningEffort {
  if (reasoningLevel === "ultracode") return "xhigh";
  if (reasoningLevel === "none") return "low";
  if (reasoningLevel === "ultra") return "max";
  return reasoningLevel;
}

function buildFlagSettings(
  params: BuildSessionOptionsArgs,
  env: NodeJS.ProcessEnv,
): Settings {
  const deny = privateDataReadDenyRules(env);
  return {
    autoMemoryEnabled: params.memoryEnabled ?? true,
    disableClaudeAiConnectors: params.claudeAiConnectorsEnabled !== true,
    enableWorkflows: params.workflowsEnabled,
    ultracode: params.reasoningLevel === "ultracode",
    skillOverrides: { loop: "off", schedule: "off" },
    ...(deny.length > 0 ? { permissions: { deny } } : {}),
  };
}

/**
 * `Read(//path)` deny rules for Cloudroom's credential files (#2191). Claude
 * applies them to its Read, Grep, and Glob tools in every mode, and adds them
 * to the sandbox's denyRead, so sandboxed shell commands can't read them.
 */
export function privateDataReadDenyRules(env: NodeJS.ProcessEnv): string[] {
  return privateDataPaths(env.ROOM_DATA_DIR)
    .filter((path) => path.startsWith("/"))
    .map((path) => `Read(/${path})`);
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
  | "additionalWorkspaceWriteRoots"
  | "approvedPlanPermissionMode"
  | "cwd"
  | "permissionMode"
  | "permissionScope"
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

// Our --settings outrank the user's own Claude settings. Add the trustd flag
// only when the user's settings file is absent or valid JSON and doesn't set
// sandbox.enableWeakerNetworkIsolation: false. Any doubt leaves it off. The
// sandbox runs only outside Full access, where Claude skips the folder's own
// settings, so only the user's file counts.
export function claudeSettingsAllowTrustd(env: NodeJS.ProcessEnv): boolean {
  let text: string;
  try {
    text = readFileSync(join(claudeConfigDir(env), "settings.json"), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  try {
    return JSON.parse(text)?.sandbox?.enableWeakerNetworkIsolation !== false;
  } catch {
    return false;
  }
}

const claudeConfigDir = (env: NodeJS.ProcessEnv): string =>
  env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");

const INSTRUCTION_FILE_MAX_BYTES = 200_000;

function safeRealpath(target: string): string | null {
  try {
    return realpathSync.native(target);
  } catch {
    return null;
  }
}

function isPathWithin(parentDir: string, childPath: string): boolean {
  const rel = relative(parentDir, childPath);
  return (
    rel.length > 0 &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

function readBoundedRegularFile(realPath: string): string | null {
  const flags =
    constants.O_RDONLY |
    (constants.O_NOFOLLOW ?? 0) |
    (constants.O_NONBLOCK ?? 0);
  let fd: number;
  try {
    fd = openSync(realPath, flags);
  } catch {
    return null;
  }
  try {
    const info = fstatSync(fd, { bigint: true });
    if (!info.isFile() || info.size > BigInt(INSTRUCTION_FILE_MAX_BYTES)) {
      return null;
    }
    // A hard link can point anywhere, including Cloudroom private data files
    // that a path check cannot see, so instruction files must have one link.
    if (info.nlink !== 1n) return null;
    const buffer = Buffer.alloc(INSTRUCTION_FILE_MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const bytesRead = readSync(
        fd,
        buffer,
        total,
        buffer.length - total,
        null,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > INSTRUCTION_FILE_MAX_BYTES) return null;
    return buffer.subarray(0, total).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Outside Full access Claude skips the folder's own settings, which also
 * skips its CLAUDE.md. This hands Claude those instructions as plain text,
 * found the way Claude finds them: CLAUDE.md, .claude/CLAUDE.md and
 * CLAUDE.local.md in the folder and each parent, and AGENTS.md where a folder
 * has no CLAUDE.md. Imports (`@file`) and .claude/rules are not followed.
 * Each file must resolve to a regular file inside its own directory and never
 * to a Cloudroom private data path (#2191).
 */
export function readProjectInstructions(
  cwd: string,
  env: NodeJS.ProcessEnv,
): string {
  const userFiles = new Set<string>();
  for (const candidate of [
    join(claudeConfigDir(env), "CLAUDE.md"),
    join(env.HOME || homedir(), ".claude", "CLAUDE.md"),
  ]) {
    const resolved = resolve(candidate);
    userFiles.add(resolved);
    const real = safeRealpath(resolved);
    if (real !== null) userFiles.add(real);
  }
  const deniedPaths = new Set<string>();
  for (const rawPath of privateDataPaths(env.ROOM_DATA_DIR)) {
    const resolved = resolve(rawPath);
    deniedPaths.add(resolved);
    const real = safeRealpath(resolved);
    if (real !== null) deniedPaths.add(real);
  }
  const isDeniedPath = (realPath: string): boolean => {
    if (deniedPaths.has(realPath)) return true;
    for (const denied of deniedPaths) {
      if (isPathWithin(denied, realPath)) return true;
    }
    return false;
  };
  const dirs: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    dirs.unshift(dir);
    if (dirname(dir) === dir) break;
  }
  const found: string[] = [];
  const shared = "project instructions, checked into the codebase";
  for (const dir of dirs) {
    const realDir = safeRealpath(dir);
    if (realDir === null) continue;
    const read = (name: string, label: string): string | null => {
      const path = join(dir, name);
      if (userFiles.has(path)) return null;
      const realPath = safeRealpath(path);
      if (
        realPath === null ||
        userFiles.has(realPath) ||
        !isPathWithin(realDir, realPath) ||
        isDeniedPath(realPath)
      ) {
        return null;
      }
      const raw = readBoundedRegularFile(realPath);
      if (raw === null) return null;
      const text = raw.trim();
      return text ? `Contents of ${path} (${label}):\n\n${text}` : null;
    };
    const claudeMd = [
      read("CLAUDE.md", shared),
      read(join(".claude", "CLAUDE.md"), shared),
    ];
    for (const text of [
      ...(claudeMd.some(Boolean) ? claudeMd : [read("AGENTS.md", shared)]),
      read("CLAUDE.local.md", "user's private project instructions, not checked in"),
    ]) {
      if (text) found.push(text);
    }
  }
  return found.length === 0
    ? ""
    : [
        "Codebase instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.",
        ...found,
      ].join("\n\n");
}

export function withProjectInstructions(
  systemPrompt: SdkSessionOptions["systemPrompt"],
  instructions: string,
): SdkSessionOptions["systemPrompt"] {
  if (!instructions) return systemPrompt;
  if (typeof systemPrompt === "string") {
    return `${systemPrompt}\n\n${instructions}`;
  }
  if (Array.isArray(systemPrompt)) return [...systemPrompt, instructions];
  return {
    ...systemPrompt,
    append: systemPrompt.append
      ? `${systemPrompt.append}\n\n${instructions}`
      : instructions,
  };
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
    ...(claudeSettingsAllowTrustd(env)
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
  | "additionalDirectories"
  | "approvedPlanPermissionMode"
  | "permissionMode"
  | "projectSettings"
  | "sandbox"
> {
  const sandbox = buildWorkspaceWriteSandbox(params, env);
  const additionalDirectories = usesWorkspaceSandbox(params)
    ? (params.additionalWorkspaceWriteRoots ?? [])
    : [];
  return {
    permissionMode: params.permissionMode,
    approvedPlanPermissionMode:
      params.approvedPlanPermissionMode ?? params.permissionMode,
    // A folder's .claude settings can run hooks, helper commands and MCP
    // servers as the user, outside the sandbox and before any approval. Only
    // Full access, where the agent may run anything anyway, loads them.
    projectSettings:
      (params.approvedPlanPermissionMode ?? params.permissionMode) ===
      "bypassPermissions",
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
  const flagSettings = buildFlagSettings(params, env);
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
    disallowedTools: [...(params.disallowedTools ?? []), ...CLAUDE_TIMER_TOOLS],
  };
}
