import { isAbsolute, resolve } from "node:path";
import type {
  BbPluginApi,
  PluginCliContext,
  PluginCliResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { AutomationService } from "./service.js";
import { LOOP_TEMPLATES } from "../templates.js";
import { cloudTemplateHost } from "./rpc.js";
import type {
  AgentEnvironment,
  AgentExecutionUpdate,
  AutomationReadProblem,
  AutomationReadResult,
  AutomationResponse,
  AutomationRunResponse,
  AutomationScriptInterpreter,
  CreateAutomationInput,
  LoopPriority,
  PermissionMode,
  ReasoningLevel,
  ResolvedCreateAutomationInput,
  ReviewItem,
  ServiceTier,
  UpdateAutomationInput,
} from "./rpc-types.js";
import {
  providerRoutingForEnvironment,
  resolvePermissionMode,
} from "./provider-permissions.js";
import {
  AUTOMATION_SCRIPT_TIMEOUT_DEFAULT_MS,
  DEFAULT_LOOP_PRIORITY,
  automationScriptInterpreterSchema,
  permissionModeSchema,
  reasoningLevelSchema,
  serviceTierSchema,
} from "./rpc-types.js";
import { interpreterForPath } from "./script-files.js";

const DURATION_PATTERN =
  /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/iu;
const hostListSchema = z.array(
  z
    .object({
      id: z.string().optional(),
      status: z.string().optional(),
      connected: z.boolean().optional(),
    })
    .passthrough(),
);

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg.startsWith("--")) {
      const [rawName, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
      if (!rawName) throw new Error(`Invalid flag ${arg}`);
      if (inlineValue !== undefined) {
        flags.set(rawName, inlineValue);
        continue;
      }
      const next = rest[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(rawName, next);
        index += 1;
      } else {
        flags.set(rawName, true);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command, positionals, flags };
}

function flag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === undefined || value === true) return undefined;
  return value;
}

function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

function requireFlag(args: ParsedArgs, name: string): string {
  const value = flag(args, name);
  if (!value) throw new Error(`Missing required option --${name} <value>.`);
  return value;
}

function optionalFlag(args: ParsedArgs, name: string): string | undefined {
  return args.flags.has(name) ? requireFlag(args, name) : undefined;
}

function optionalJson(args: ParsedArgs, value: unknown): string | null {
  return boolFlag(args, "json") ? `${JSON.stringify(value, null, 2)}\n` : null;
}

function parseRunAt(value: string): number {
  const runAt = Date.parse(value);
  if (!Number.isFinite(runAt)) {
    throw new Error("--at must be a valid date/time, preferably ISO 8601.");
  }
  if (runAt <= Date.now()) throw new Error("--at must be in the future.");
  return runAt;
}

function parseRunIn(value: string): number {
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match)
    throw new Error("--in must be a duration like 30s, 5m, 2h, or 1d.");
  const amount = Number.parseInt(match[1] ?? "", 10);
  if (amount <= 0) throw new Error("--in must be greater than zero.");
  const unit = (match[2] ?? "").toLowerCase();
  const multiplier = unit.startsWith("s")
    ? 1_000
    : unit.startsWith("m")
      ? 60_000
      : unit.startsWith("h")
        ? 60 * 60_000
        : 24 * 60 * 60_000;
  return Date.now() + amount * multiplier;
}

function buildTrigger(args: ParsedArgs): CreateAutomationInput["trigger"] {
  const cron = flag(args, "cron");
  const at = flag(args, "at");
  const runIn = flag(args, "in");
  const webhook = boolFlag(args, "webhook");
  const triggerFlags = [
    cron !== undefined,
    at !== undefined,
    runIn !== undefined,
    webhook,
  ].filter(Boolean).length;
  if (triggerFlags !== 1) {
    throw new Error(
      "Provide exactly one trigger flag: --cron, --at, --in, or --webhook.",
    );
  }
  if (webhook) {
    if (flag(args, "timezone") !== undefined) {
      throw new Error("--timezone is only used with --cron.");
    }
    return { triggerType: "webhook" };
  }
  if (cron !== undefined) {
    const timezone = flag(args, "timezone");
    if (!timezone) throw new Error("--cron requires --timezone.");
    return { triggerType: "schedule", cron, timezone };
  }
  if (flag(args, "timezone") !== undefined) {
    throw new Error("--timezone is only used with --cron.");
  }
  if (at !== undefined) return { triggerType: "once", runAt: parseRunAt(at) };
  if (runIn !== undefined)
    return { triggerType: "once", runAt: parseRunIn(runIn) };
  throw new Error(
    "Provide exactly one trigger flag: --cron, --at, --in, or --webhook.",
  );
}

function parsePermissionMode(
  value: string | undefined,
): PermissionMode | undefined {
  if (value === undefined) return undefined;
  const parsed = permissionModeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(
    "Invalid --permission-mode. Expected accept-edits, auto, or full.",
  );
}

function parseReasoningLevel(value: string): ReasoningLevel {
  const parsed = reasoningLevelSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(
    "Invalid --reasoning. Expected none, low, medium, high, xhigh, ultracode, max, or ultra.",
  );
}

function parsePriority(args: ParsedArgs): { priority?: LoopPriority } {
  if (!args.flags.has("priority")) return {};
  const value = /^p?([1-4])$/iu.exec(requireFlag(args, "priority"))?.[1];
  if (!value) throw new Error("Invalid --priority. Expected 1, 2, 3, or 4.");
  return { priority: Number(value) as LoopPriority };
}

function parseLimit(args: ParsedArgs, fallback: number): number {
  const text = flag(args, "limit");
  if (text === undefined) return fallback;
  const limit = Number.parseInt(text, 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("--limit must be a positive integer.");
  }
  return limit;
}

/** Templates are for paid plans, like the Templates tab; unknown plans (signed out, billing off) stay open. */
async function requireTemplatesPlan(bb: Pick<BbPluginApi, "sdk">): Promise<void> {
  const status = await bb.sdk.cloudroom.status().catch(() => null);
  if (status?.plan === "free") {
    throw new Error("Loop templates need a paid plan. Upgrade at https://www.cloudroom.dev/billing");
  }
}

/** `create --template ID`: the template fills every setting the flags leave out, like the Templates tab: a Cloud loop
 *  unless --local, and the template's agent when it is set up here, else the project's default agent. */
async function applyTemplate(bb: Pick<BbPluginApi, "sdk">, args: ParsedArgs): Promise<void> {
  if (!args.flags.has("template")) return;
  const id = requireFlag(args, "template");
  const template = LOOP_TEMPLATES.find((candidate) => candidate.id === id);
  if (!template) {
    throw new Error(`Unknown template '${id}'. Run room-cli loop templates.`);
  }
  await requireTemplatesPlan(bb);
  if (args.flags.has("cloud") && args.flags.has("local")) {
    throw new Error("Use --cloud or --local, not both.");
  }
  const local = args.flags.has("local");
  if (!local) args.flags.set("cloud", true);
  const projectId = requireFlag(args, "project");
  const [providers, defaults] = await Promise.all([
    bb.sdk.providers.list().catch(() => []),
    bb.sdk.projects.defaultExecutionOptions({ projectId }).catch(() => null),
  ]);
  const ownAgent = providers.some(
    (provider) => provider.id === template.providerId && provider.available,
  );
  const agent = ownAgent || defaults === null ? template : defaults;
  const scheduled = ["cron", "at", "in", "webhook"].some((name) =>
    args.flags.has(name),
  );
  const filled: Record<string, string> = {
    name: template.name,
    prompt: template.prompt,
    provider: agent.providerId,
    model: agent.model,
    reasoning: agent.reasoningLevel,
    priority: String(template.priority),
    ...(local ? { "permission-mode": defaults?.permissionMode ?? "auto" } : {}),
    ...(scheduled
      ? {}
      : {
          cron: template.cron,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
  };
  for (const [name, value] of Object.entries(filled)) {
    if (!args.flags.has(name)) args.flags.set(name, value);
  }
}

function printTemplates(): string {
  return table(
    ["ID", "P", "Schedule", "Agent", "Name"],
    LOOP_TEMPLATES.map((template) => [
      template.id,
      `P${template.priority}`,
      template.cron,
      `${template.providerId} · ${template.model} · ${template.reasoningLevel}`,
      template.name,
    ]),
  );
}

function parseServiceTier(value: string): ServiceTier | null {
  if (value === "none") return null;
  const parsed = serviceTierSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error("Invalid --service-tier. Expected default, fast, or none.");
}

const AGENT_TARGET_FLAG_NAMES = [
  "target-thread",
  "environment",
  "new-environment",
] as const;

function validateAgentTargetOptions(args: ParsedArgs): void {
  const providedTargetOptions = AGENT_TARGET_FLAG_NAMES.filter((name) =>
    args.flags.has(name),
  );
  for (const name of providedTargetOptions) {
    if (!flag(args, name)) {
      throw new Error(`Missing required option --${name} <value>.`);
    }
  }
  if (providedTargetOptions.length > 1) {
    throw new Error(
      "Cannot combine target options: --target-thread, --environment, and --new-environment.",
    );
  }
  if (args.flags.has("base-branch") && !args.flags.has("new-environment")) {
    throw new Error("--base-branch requires --new-environment worktree.");
  }
}

function parseScriptInterpreter(
  value: string | undefined,
): AutomationScriptInterpreter | undefined {
  if (value === undefined) return undefined;
  const parsed = automationScriptInterpreterSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(
    "Invalid --interpreter. Expected bash, sh, node, or python3.",
  );
}

function parseTimeoutMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      "--timeout must be a positive integer number of milliseconds.",
    );
  }
  return parsed;
}

function parseScriptEnv(
  value: string | undefined,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error("--env-json must be a JSON object of string values.");
  }
  const parsed = z.record(z.string(), z.string()).safeParse(decoded);
  if (!parsed.success) {
    throw new Error("--env-json must be a JSON object of string values.");
  }
  return parsed.data;
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || value.startsWith(".") || value.startsWith("~");
}

async function resolveConnectedHostId(
  bb: Pick<BbPluginApi, "sdk">,
): Promise<string> {
  const hosts = hostListSchema.parse(await bb.sdk.hosts.list());
  const host =
    hosts.find((candidate) => candidate.connected === true) ??
    hosts.find((candidate) => candidate.status === "connected") ??
    hosts[0];
  if (!host?.id) throw new Error("No connected host is available.");
  return host.id;
}

async function buildAgentEnvironment(
  bb: Pick<BbPluginApi, "sdk">,
  args: ParsedArgs,
): Promise<AgentEnvironment> {
  const environment = flag(args, "environment")?.trim();
  const newEnvironment = flag(args, "new-environment")?.trim();
  const baseBranch = flag(args, "base-branch")?.trim();
  if (environment && newEnvironment) {
    throw new Error("Cannot combine --environment with --new-environment.");
  }
  if (newEnvironment) {
    if (newEnvironment !== "worktree") {
      throw new Error(
        `Unknown environment kind '${newEnvironment}'. Supported: worktree.`,
      );
    }
    return {
      type: "host",
      hostId: await resolveConnectedHostId(bb),
      workspace: {
        type: "managed-worktree",
        baseBranch: baseBranch
          ? { kind: "named", name: baseBranch }
          : { kind: "default" },
      },
    };
  }
  if (!environment) return { type: "project-default" };
  if (looksLikePath(environment)) {
    return {
      type: "host",
      hostId: await resolveConnectedHostId(bb),
      workspace: { type: "unmanaged", path: environment },
    };
  }
  return { type: "reuse", environmentId: environment };
}

const scriptFileHostListSchema = z.array(
  z.object({ id: z.string().min(1), name: z.string().min(1) }).passthrough(),
);
const threadEnvironmentHostSchema = z
  .object({
    environment: z
      .object({ hostId: z.string().min(1) })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

async function resolveScriptFileHostId(
  bb: Pick<BbPluginApi, "sdk">,
  ctx: Pick<PluginCliContext, "threadId">,
  override: string | undefined,
): Promise<string | undefined> {
  if (override !== undefined) {
    const query = override.trim();
    if (query.length === 0) throw new Error("--host requires a name or id.");
    const hosts = scriptFileHostListSchema.parse(await bb.sdk.hosts.list());
    const idMatch = hosts.find((host) => host.id === query);
    if (idMatch) return idMatch.id;
    const nameMatches = hosts.filter(
      (host) => host.name.toLocaleLowerCase() === query.toLocaleLowerCase(),
    );
    if (nameMatches.length === 1) return nameMatches[0]!.id;
    if (nameMatches.length > 1) {
      throw new Error(
        `Host name "${query}" is ambiguous; pass one of these ids: ${nameMatches
          .map((host) => host.id)
          .join(", ")}`,
      );
    }
    throw new Error(
      `Unknown host "${query}"; run \`room-cli machine list\` to list hosts.`,
    );
  }
  if (ctx.threadId === undefined) return undefined;
  const thread = threadEnvironmentHostSchema.parse(
    await bb.sdk.threads.get({
      threadId: ctx.threadId,
      include: "environment",
    }),
  );
  if (!thread.environment) {
    throw new Error(
      `Thread ${ctx.threadId} has no environment, so the --script-file host cannot be resolved; pass --host <name-or-id>.`,
    );
  }
  return thread.environment.hostId;
}

// Agents copy the short Claude ID from their system prompt (claude-opus-5-5),
// which silently picks the 200K model. Keep the caller's exact 1M variant.
async function preferCallerModel(
  bb: Pick<BbPluginApi, "sdk">,
  ctx: Pick<PluginCliContext, "threadId">,
  model: string,
): Promise<string> {
  if (ctx.threadId === undefined) return model;
  try {
    const own = await bb.sdk.threads.defaultExecutionOptions({
      threadId: ctx.threadId,
    });
    return own?.model === `${model}[1m]` ? own.model : model;
  } catch {
    return model;
  }
}

type ScriptFileSource = {
  path: string;
  hostId: string | undefined;
  content: string;
};

async function loadScriptFileSource(
  bb: Pick<BbPluginApi, "sdk">,
  args: ParsedArgs,
  ctx: Pick<PluginCliContext, "cwd" | "threadId">,
): Promise<ScriptFileSource | undefined> {
  const scriptFile = flag(args, "script-file");
  const hostOverride = flag(args, "host");
  if (scriptFile === undefined) {
    if (hostOverride !== undefined) {
      throw new Error("--host requires --script-file.");
    }
    return undefined;
  }
  let path: string;
  if (isAbsolute(scriptFile)) {
    path = scriptFile;
  } else {
    if (ctx.cwd === undefined || !isAbsolute(ctx.cwd)) {
      throw new Error(
        "Relative --script-file paths need the invoking CLI cwd; pass an absolute path.",
      );
    }
    path = resolve(ctx.cwd, scriptFile);
  }
  const hostId = await resolveScriptFileHostId(bb, ctx, hostOverride);
  const file = await bb.sdk.files.read({
    ...(hostId !== undefined ? { hostId } : {}),
    path,
  });
  if (file.contentEncoding !== "utf8") {
    throw new Error(`--script-file is not UTF-8 text: ${path}`);
  }
  return { path, hostId, content: file.content };
}

type BuiltExecution = {
  execution: ResolvedCreateAutomationInput["execution"];
  scriptSource?: ScriptFileSource;
};

type ScriptExecution = Extract<
  AutomationResponse["execution"],
  { mode: "script" }
>;

async function buildExecution(
  bb: Pick<BbPluginApi, "sdk">,
  args: ParsedArgs,
  ctx: Pick<PluginCliContext, "cwd" | "threadId">,
  current?: ScriptExecution,
): Promise<BuiltExecution> {
  const prompt = flag(args, "prompt");
  const script = optionalFlag(args, "script");
  const scriptFile = optionalFlag(args, "script-file");
  const hasAgent = prompt !== undefined;
  const hasScript = script !== undefined || scriptFile !== undefined;
  if (hasAgent && hasScript) {
    throw new Error(
      "Provide either agent flags (--prompt) or script flags (--script/--script-file), not both.",
    );
  }
  if (
    hasAgent &&
    (args.flags.has("interpreter") ||
      args.flags.has("timeout") ||
      args.flags.has("env-json"))
  ) {
    throw new Error(
      "Agent loops do not accept --interpreter, --timeout, or --env-json.",
    );
  }
  if (!hasAgent && !hasScript && current === undefined) {
    throw new Error(
      "Provide an execution mode: agent (--prompt --provider --model) or script (--script-file <path> or --script <inline>).",
    );
  }
  if (hasAgent) {
    const provider = flag(args, "provider");
    const model = flag(args, "model");
    if (!provider || !model) {
      throw new Error(
        "Agent loops require --provider and --model alongside --prompt.",
      );
    }
    validateAgentTargetOptions(args);
    const environment = await buildAgentEnvironment(bb, args);
    const targetThreadId = flag(args, "target-thread");
    const reasoning = flag(args, "reasoning");
    const serviceTier = flag(args, "service-tier");
    const parsedServiceTier =
      serviceTier === undefined ? undefined : parseServiceTier(serviceTier);
    return {
      execution: {
        mode: "agent",
        prompt,
        providerId: provider,
        model: await preferCallerModel(bb, ctx, model),
        reasoningLevel:
          reasoning === undefined ? "medium" : parseReasoningLevel(reasoning),
        ...(parsedServiceTier === null || parsedServiceTier === undefined
          ? {}
          : { serviceTier: parsedServiceTier }),
        permissionMode: await resolvePermissionMode(
          bb,
          provider,
          parsePermissionMode(flag(args, "permission-mode")),
          providerRoutingForEnvironment(environment),
        ),
        environment,
        ...(targetThreadId ? { targetThreadId } : {}),
      },
    };
  }
  if (
    args.flags.has("provider") ||
    args.flags.has("model") ||
    args.flags.has("reasoning") ||
    args.flags.has("service-tier") ||
    args.flags.has("permission-mode") ||
    args.flags.has("target-thread") ||
    args.flags.has("environment") ||
    args.flags.has("new-environment") ||
    args.flags.has("base-branch")
  ) {
    throw new Error("Script loops do not accept agent execution flags.");
  }
  if (script !== undefined && scriptFile !== undefined) {
    throw new Error("Provide exactly one of --script or --script-file.");
  }
  const explicitInterpreter = parseScriptInterpreter(
    optionalFlag(args, "interpreter"),
  );
  const timeoutMs = parseTimeoutMs(optionalFlag(args, "timeout"));
  const env = parseScriptEnv(optionalFlag(args, "env-json")) ?? current?.env;
  const scriptSource = await loadScriptFileSource(bb, args, ctx);
  const content = scriptSource ? scriptSource.content : script;
  const keptScript =
    content !== undefined || current === undefined
      ? undefined
      : current.scriptFile !== undefined
        ? { scriptFile: current.scriptFile }
        : current.script !== undefined
          ? { script: current.script }
          : undefined;
  if (!content && keptScript === undefined) {
    throw new Error("Missing script content.");
  }
  const interpreter =
    explicitInterpreter ??
    current?.interpreter ??
    (scriptSource ? interpreterForPath(scriptSource.path) : undefined);
  return {
    execution: {
      mode: "script",
      ...(keptScript ?? {
        script: content,
        ...(scriptSource ? { scriptFile: scriptSource.path } : {}),
      }),
      ...(interpreter ? { interpreter } : {}),
      timeoutMs:
        timeoutMs ?? current?.timeoutMs ?? AUTOMATION_SCRIPT_TIMEOUT_DEFAULT_MS,
      ...(env ? { env } : {}),
    },
    ...(scriptSource ? { scriptSource } : {}),
  };
}

const SCRIPT_EXECUTION_FLAG_NAMES = [
  "script",
  "script-file",
  "interpreter",
  "timeout",
  "env-json",
] as const;

async function buildAgentExecutionUpdate(
  bb: Pick<BbPluginApi, "sdk">,
  args: ParsedArgs,
  ctx: Pick<PluginCliContext, "threadId">,
): Promise<AgentExecutionUpdate | undefined> {
  const agentOptionNames = [
    "prompt",
    "provider",
    "model",
    "reasoning",
    "service-tier",
    "permission-mode",
    "target-thread",
    "environment",
    "new-environment",
    "base-branch",
  ] as const;
  if (!agentOptionNames.some((name) => args.flags.has(name))) return undefined;

  validateAgentTargetOptions(args);
  const update: AgentExecutionUpdate = {};
  if (args.flags.has("prompt")) update.prompt = requireFlag(args, "prompt");
  if (args.flags.has("provider")) {
    update.providerId = requireFlag(args, "provider");
  }
  if (args.flags.has("model")) {
    update.model = await preferCallerModel(bb, ctx, requireFlag(args, "model"));
  }
  if (args.flags.has("reasoning")) {
    update.reasoningLevel = parseReasoningLevel(requireFlag(args, "reasoning"));
  }
  if (args.flags.has("service-tier")) {
    update.serviceTier = parseServiceTier(requireFlag(args, "service-tier"));
  }
  if (args.flags.has("permission-mode")) {
    update.permissionMode = parsePermissionMode(
      requireFlag(args, "permission-mode"),
    );
  }
  if (args.flags.has("target-thread")) {
    update.target = {
      type: "target-thread",
      threadId: requireFlag(args, "target-thread"),
    };
  } else if (
    args.flags.has("environment") ||
    args.flags.has("new-environment")
  ) {
    update.target = {
      type: "environment",
      environment: await buildAgentEnvironment(bb, args),
    };
  }
  return update;
}

async function buildUpdateRequest(
  bb: Pick<BbPluginApi, "sdk">,
  service: Pick<AutomationService, "list">,
  args: ParsedArgs,
  ctx: Pick<PluginCliContext, "cwd" | "threadId">,
): Promise<{
  request: UpdateAutomationInput;
  scriptSource?: ScriptFileSource;
}> {
  const projectId = requireFlag(args, "project");
  const automationId = args.positionals[0];
  if (!automationId) throw new Error("Missing automationId.");
  const request: UpdateAutomationInput = { projectId, automationId };
  const name = flag(args, "name");
  if (name !== undefined) request.name = name;
  Object.assign(request, parsePriority(args));
  if (
    flag(args, "cron") !== undefined ||
    flag(args, "timezone") !== undefined ||
    flag(args, "at") !== undefined ||
    flag(args, "in") !== undefined
  ) {
    request.trigger = buildTrigger(args);
  }
  let scriptSource: ScriptFileSource | undefined;
  const hasScriptFlag = SCRIPT_EXECUTION_FLAG_NAMES.some((name) =>
    args.flags.has(name),
  );
  const hasAgentExecution =
    args.flags.has("prompt") &&
    args.flags.has("provider") &&
    args.flags.has("model");
  const current =
    hasScriptFlag || hasAgentExecution
      ? service.list({ projectId }).find(({ id }) => id === automationId)
      : undefined;
  if ((hasScriptFlag || hasAgentExecution) && current === undefined) {
    throw new Error("Loop not found");
  }
  const currentExecution =
    current !== undefined && "execution" in current
      ? current.execution
      : undefined;
  if (
    hasScriptFlag ||
    (hasAgentExecution && currentExecution?.mode !== "agent")
  ) {
    const built = await buildExecution(
      bb,
      args,
      ctx,
      currentExecution?.mode === "script" ? currentExecution : undefined,
    );
    request.execution = built.execution;
    scriptSource = built.scriptSource;
  } else {
    const agentUpdate = await buildAgentExecutionUpdate(bb, args, ctx);
    if (agentUpdate !== undefined) {
      request.agent = agentUpdate;
    }
  }
  if (
    request.name === undefined &&
    request.priority === undefined &&
    request.trigger === undefined &&
    request.execution === undefined &&
    request.agent === undefined
  ) {
    throw new Error(
      "No changes requested. Provide --name, --priority, schedule flags, or agent or script execution flags.",
    );
  }
  return { request, ...(scriptSource ? { scriptSource } : {}) };
}

function formatTimestamp(value: number | null): string {
  return value === null ? "-" : new Date(value).toLocaleString();
}

function formatAutomationTrigger(automation: AutomationResponse): string {
  if (automation.trigger.triggerType === "webhook") return "on webhook";
  if (automation.trigger.triggerType === "once") {
    return `once at ${formatTimestamp(automation.trigger.runAt)}`;
  }
  return `${automation.trigger.cron} (${automation.trigger.timezone})`;
}

type PrintableAutomation =
  | AutomationResponse
  | Extract<AutomationReadProblem, { problem: "missing-agent-prompt" }>;

function printAutomation(
  automation: PrintableAutomation,
  status?: string,
): string {
  const lines = [
    "",
    `  ID:        ${automation.id}`,
    `  Name:      ${automation.name}`,
    ...(status === undefined ? [] : [`  Status:    ${status}`]),
    `  Enabled:   ${automation.enabled ? "yes" : "no"}`,
    `  Priority:  P${automation.priority}`,
    `  Mode:      ${automation.execution.mode}`,
    `  Schedule:  ${formatAutomationTrigger(automation)}`,
    `  Next run:  ${formatTimestamp(automation.nextRunAt)}`,
    `  Last run:  ${formatTimestamp(automation.lastRunAt)}`,
    `  Runs:      ${automation.runCount}`,
    `  Origin:    ${automation.origin}`,
  ];
  if (
    automation.execution.mode === "script" &&
    automation.execution.storedScriptPath !== undefined
  ) {
    lines.push(`  Script:    ${automation.execution.storedScriptPath}`);
  }
  if (automation.execution.mode === "script") {
    lines.push(
      `  Interpreter: ${automation.execution.interpreter ?? "default"}`,
      `  Timeout:   ${automation.execution.timeoutMs} ms`,
      `  Env:       ${Object.keys(automation.execution.env ?? {}).join(", ") || "-"}`,
    );
  }
  if (automation.execution.mode === "agent") {
    lines.push(
      `  Provider:  ${automation.execution.providerId}`,
      `  Model:     ${automation.execution.model}`,
      `  Reasoning: ${automation.execution.reasoningLevel}`,
      `  Tier:      ${automation.execution.serviceTier ?? "-"}`,
      `  Permission: ${automation.execution.permissionMode}`,
      `  Target:    ${automation.execution.targetThreadId ?? "new thread each run"}`,
    );
  }
  if (automation.lastError) lines.push(`  Error:     ${automation.lastError}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

function refreshScriptFileCommand(
  automation: AutomationResponse,
  source: ScriptFileSource,
): string {
  if (automation.execution.mode !== "script") return "";
  const argv = [
    "room-cli",
    "loop",
    "update",
    automation.id,
    "--project",
    automation.projectId,
    "--script-file",
    source.path,
  ];
  if (source.hostId !== undefined) argv.push("--host", source.hostId);
  if (automation.execution.interpreter !== undefined) {
    argv.push("--interpreter", automation.execution.interpreter);
  }
  return argv.map(shellQuote).join(" ");
}

function printScriptFileSnapshotNote(
  automation: AutomationResponse,
  source: ScriptFileSource | undefined,
): string {
  if (
    source === undefined ||
    automation.execution.mode !== "script" ||
    automation.execution.storedScriptPath === undefined
  ) {
    return "";
  }
  return [
    `Copied ${source.path}${source.hostId !== undefined ? ` (host ${source.hostId})` : ""}`,
    `    to ${automation.execution.storedScriptPath}`,
    "The loop runs this stored copy, a snapshot of the source file.",
    "Edits to the source file do not apply until you run:",
    `  ${refreshScriptFileCommand(automation, source)}`,
    "",
  ].join("\n");
}

function table(head: string[], rows: string[][]): string {
  const widths = head.map((label, index) =>
    Math.max(label.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const format = (row: string[]) =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  return ["", format(head), ...rows.map(format), ""].join("\n") + "\n";
}

function printAutomationProblem(automation: AutomationReadProblem): string {
  if (automation.problem === "missing-agent-prompt") {
    return printAutomation(automation, "Prompt required");
  }
  return (
    [
      "",
      `  ID:        ${automation.id}`,
      `  Name:      ${automation.name}`,
      "  Status:    Invalid data",
      "",
    ].join("\n") + "\n"
  );
}

function printAutomationTable(automations: AutomationReadResult[]): string {
  return table(
    ["ID", "Name", "P", "Status", "On", "Schedule", "Next run", "Runs", "Origin"],
    automations.map((automation) =>
      "problem" in automation
        ? automation.problem === "missing-agent-prompt"
          ? [
              automation.id,
              automation.name,
              `P${automation.priority}`,
              "Prompt required",
              automation.enabled ? "yes" : "no",
              formatAutomationTrigger(automation),
              formatTimestamp(automation.nextRunAt),
              String(automation.runCount),
              automation.origin,
            ]
          : [
              automation.id,
              automation.name,
              "-",
              "Invalid data",
              "-",
              "-",
              "-",
              "-",
              "-",
            ]
        : [
            automation.id,
            automation.name,
            `P${automation.priority}`,
            "-",
            automation.enabled ? "yes" : "no",
            formatAutomationTrigger(automation),
            formatTimestamp(automation.nextRunAt),
            String(automation.runCount),
            automation.origin,
          ],
    ),
  );
}

function printRunTable(runs: AutomationRunResponse[]): string {
  return table(
    ["ID", "Status", "Started", "Thread/Exit", "Detail"],
    runs.map((run) => [
      run.id,
      run.status,
      formatTimestamp(run.startedAt),
      run.threadId ?? (run.exitCode === null ? "-" : `exit ${run.exitCode}`),
      run.skipReason ?? run.error ?? "-",
    ]),
  );
}

function helpText(): string {
  return `Loop commands (room-cli automation is the same command)

room-cli loop list --project <id>          Also lists the Cloud loops whose thread is in that project
room-cli loop create --project <id> --name <name> (--cron <expr> --timezone <tz> | --at <datetime> | --in <duration> | --webhook) (--prompt <text> --provider <id> --model <model> [--reasoning <level>] [--service-tier default|fast] [--permission-mode accept-edits|auto|full] | --script <inline> | --script-file <path> [--host <name-or-id>]) [--priority 1-4]
room-cli loop create --template <id> --project <id> [--local] [any flag above]   A Cloud loop unless --local; the template fills in the rest (paid plans)
room-cli loop templates                    Ready-made loops, with their priority, schedule, and agent (paid plans)
room-cli loop show <loopId> --project <id>
room-cli loop update <loopId> --project <id> [--name <name>] [--priority 1-4] [schedule flags] [--prompt <text>] [--provider <id>] [--model <model>] [--reasoning <level>] [--service-tier default|fast|none] [--permission-mode accept-edits|auto|full] [--target-thread <id> | --environment <id-or-path> | --new-environment worktree] [--script <inline> | --script-file <path>] [--interpreter <name>] [--timeout <ms>] [--env-json <json>] (omitted settings are kept; switching between agent and script replaces them)
room-cli loop pause <loopId> --project <id>
room-cli loop resume <loopId> --project <id>
room-cli loop run <loopId> --project <id> [--idempotency-key <key>]
room-cli loop runs <loopId> --project <id> [--limit <count>] [--output <runId>]
room-cli loop delete <loopId> --project <id> --yes
room-cli loop hook <loopId> --project <id>   Replace a webhook loop's secret URL
room-cli loop review [--all]                List what loops did in the last 7 days (threads they started, script output, failures)
room-cli loop review mark <itemId...> [--undo]
room-cli loop report --outcome done|acted|needs-you|failed --confidence high|medium|low --reason TEXT [--action TEXT]...   Inside a loop run: record what it did and why
room-cli loop scan-progress --data JSON   Inside a Workflow scan: save its progress for the progress card
room-cli loop settings [--stop-at-limit on|off] [--fallback on|off]   Cloud loops wait while their agent is at its plan limit; loops at a Claude or Codex limit switch to the other (both on by default)

Priority is P1 (essential) to P4 (niche); loops start at P3, or at their template's.
Cloud loops run on Cloudroom's servers, even while this Mac is off: every minute with a script, else at most every
15 minutes. A --cron run starts a fresh Cloud thread in its own sandbox from that thread's project and agent;
--same-thread re-prompts the thread instead.
A one-time --at/--in run re-prompts the thread; --new-thread gives it a fresh one.
A fresh-thread loop saves the thread's settings, so it keeps running after that thread is archived. Its runs use
the thread's agent unless --provider, --model, or --reasoning picks another; update changes it.
A --script/--script-file runs first (60 s), in the loop's own sandbox with fresh threads, else in the thread's:
no output skips the run (exit 0 or 1; other exit codes fail it, 3 in a row pause it), output is added to the prompt.
A --webhook loop, Local or Cloud, runs when its secret URL gets a POST: create prints the URL once, and each run gets
the requests that arrived as data. Cloud runs start within seconds; this Mac checks for Local ones about once a minute,
and they wait while it is off. A Local webhook loop an agent creates starts paused: a person turns it on in Loops.
room-cli loop create --cloud --thread <cloudThreadId> --name <name> --prompt <text> (--cron <expr> --timezone <tz> | --at <datetime> | --in <duration> | --webhook) [--new-thread | --same-thread] [--script <inline> | --script-file <path>] [--provider <id>] [--model <model>] [--reasoning <level>] [--priority 1-4] [--secrets <KEY,.env|none|all>]
--secrets picks the only API keys (Settings → Cloud environment) a fresh-thread Cloud loop's runs and script get, plus
.env for the project's .env files: pick just what it needs, like --secrets SENTRY_TOKEN,.env, or none. Without it, all.
A Cloud template loop runs from the project's newest Cloud thread, else a new one titled "<template> loop".
room-cli loop list --cloud [--thread <cloudThreadId>]   All Cloud loops, in every project
room-cli loop show|pause|resume|run|hook <cloudLoopId>
room-cli loop runs <cloudLoopId> [--limit <count>]   What each run did, from its loop report
room-cli loop update <cloudLoopId> [--name <name>] [--priority 1-4] [--prompt <text>] [schedule flags] [--script <inline> | --script-file <path> | --no-script] [--provider <id>] [--model <model>] [--reasoning <level>] [--secrets <KEY,.env|none|all>]
room-cli loop delete <cloudLoopId> --yes
`;
}

// Cloud automations (ADR 0212) live on the website, so the Mac can be off. Their IDs are UUIDs; local ones start with auto_.
const CLOUD_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
type Cloud = Pick<BbPluginApi, "sdk">["sdk"]["cloudroom"];
type CloudAutomation = NonNullable<Awaited<ReturnType<Cloud["automations"]>>["automation"]>;

function isCloudCommand(args: ParsedArgs): boolean {
  return boolFlag(args, "cloud") || CLOUD_ID.test(args.positionals[0] ?? "");
}

function cloudSchedule(args: ParsedArgs): { cron: string | null; timezone?: string; run_at: string | null } | null {
  if (!["cron", "at", "in"].some((name) => args.flags.has(name))) return null;
  const trigger = buildTrigger(args);
  if (trigger.triggerType === "webhook") throw new Error("A webhook loop has no schedule.");
  return trigger.triggerType === "schedule"
    ? { cron: trigger.cron, timezone: trigger.timezone, run_at: null }
    : { cron: null, run_at: new Date(trigger.runAt).toISOString() };
}

type CloudLoopRun = NonNullable<Awaited<ReturnType<Cloud["automations"]>>["history"]>[number];

function printCloudRuns(runs: CloudLoopRun[]): string {
  return table(
    ["Started", "Outcome", "Thread", "Reason"],
    runs.map((run) => [
      formatTimestamp(Date.parse(run.started_at)),
      run.outcome === null
        ? run.ended_at === null
          ? "running or unreported"
          : "-"
        : `${run.outcome}${run.confidence ? ` (${run.confidence})` : ""}`,
      run.thread_id,
      `${run.reason ?? "-"}${run.actions?.length ? ` [${run.actions.join("; ")}]` : ""}`,
    ]),
  );
}

function printCloudAutomation(a: CloudAutomation): string {
  const webhook = !a.cron && !a.run_at;
  const schedule = a.cron ? `${a.cron} (${a.timezone})` : webhook ? "on webhook" : `once at ${a.run_at}`;
  const state = !a.enabled ? "paused" : webhook ? (a.next_run_at ? "running its webhooks" : "waiting for a webhook") : `next run ${a.next_run_at ?? "within a minute"}`;
  const mode = `${a.new_thread ? "new thread per run" : "re-prompts"}${a.script ? " · script" : ""}`;
  const agent = a.agent ? `\n  Agent: ${a.agent.provider} · ${a.agent.model ?? "default model"}${a.agent.reasoning ? ` · ${a.agent.reasoning}` : ""}` : "";
  const secrets = a.new_thread && a.secrets !== undefined ? `\n  Secrets: ${a.secrets === null ? "all API keys and .env files" : a.secrets.join(", ") || "none"}` : "";
  return `${a.id}  ${a.name}  P${a.priority ?? DEFAULT_LOOP_PRIORITY}\n  Cloud thread ${a.thread_id} · ${mode} · ${schedule} · ${state} · ${a.runs} runs${agent}${secrets}${a.last_error ? `\n  Last error: ${a.last_error}` : ""}\n${a.url ? webhookNote(a.url) : ""}`;
}

async function projectCloudAutomations(bb: Pick<BbPluginApi, "sdk">, projectId: string): Promise<CloudAutomation[]> {
  const { automations = [] } = await bb.sdk.cloudroom.automations({ action: "list" });
  const threadIds = [...new Set(automations.map((a) => a.thread_id))];
  const projects = new Map(await Promise.all(threadIds.map(async (threadId) => {
    const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
    return [threadId, thread && "projectId" in thread ? thread.projectId : null] as const;
  })));
  return automations.filter((a) => projects.get(a.thread_id) === projectId);
}

/** The agent a fresh-thread cloud loop runs, when --provider, --model, or --reasoning picks one. */
function cloudAgent(args: ParsedArgs): { harness?: string; model?: string; reasoning?: string } {
  const harness = flag(args, "provider"), model = flag(args, "model"), reasoning = flag(args, "reasoning");
  return { ...(harness ? { harness } : {}), ...(model ? { model } : {}), ...(reasoning ? { reasoning: parseReasoningLevel(reasoning) } : {}) };
}

/** The API keys and .env files a fresh-thread cloud loop's runs get (ADR 0342): names and .env, none, or all. */
function cloudSecrets(args: ParsedArgs): { secrets?: string[] | null } {
  const value = flag(args, "secrets");
  if (value === undefined) return {};
  return { secrets: value === "all" ? null : value === "none" ? [] : value.split(",").map((name) => name.trim()).filter(Boolean) };
}

/** A webhook loop's URL, printed only when it is created or replaced. */
function webhookNote(url: string): string {
  return `\n  Webhook URL: ${url}\n  POST anything to it to run the loop; the request reaches the agent as data. This URL is shown only now:\n  \`room-cli loop hook ID\` replaces it. Keep it secret: anyone with it can start this loop.\n`;
}

/** The script a cloud automation runs first, from --script or a --script-file read on this Mac; null for --no-script. */
async function cloudScript(bb: Pick<BbPluginApi, "sdk">, args: ParsedArgs, ctx: PluginCliContext): Promise<{ script?: string | null }> {
  const inline = flag(args, "script");
  if ([inline !== undefined, args.flags.has("script-file"), boolFlag(args, "no-script")].filter(Boolean).length > 1) throw new Error("Use one of --script, --script-file, or --no-script.");
  if (boolFlag(args, "no-script")) return { script: null };
  if (inline !== undefined) return { script: inline };
  const file = await loadScriptFileSource(bb, args, ctx);
  return file ? { script: file.content } : {};
}

async function runCloudCommand(bb: Pick<BbPluginApi, "sdk">, args: ParsedArgs, ctx: PluginCliContext): Promise<PluginCliResult> {
  const cloud = bb.sdk.cloudroom;
  const id = args.positionals[0];
  const one = async (request: Parameters<Cloud["automations"]>[0], verb: string) => {
    const { automation } = await cloud.automations(request);
    if (!automation) throw new Error("The website returned no loop.");
    return { exitCode: 0, stdout: optionalJson(args, automation) ?? `Cloud loop ${verb}\n${printCloudAutomation(automation)}` };
  };
  const requireId = () => {
    if (!id || !CLOUD_ID.test(id)) throw new Error("Missing cloud loop ID.");
    return id;
  };
  if (args.command === "list") {
    const { automations = [] } = await cloud.automations({ action: "list", ...(flag(args, "thread") ? { thread: flag(args, "thread")! } : {}) });
    return { exitCode: 0, stdout: optionalJson(args, automations) ?? (automations.length ? automations.map(printCloudAutomation).join("") : "No cloud loops found\n") };
  }
  if (args.command === "show") {
    const { automations = [] } = await cloud.automations({ action: "list" });
    const found = automations.find((a) => a.id === requireId());
    if (!found) throw new Error(`Cloud loop ${id} not found.`);
    return { exitCode: 0, stdout: optionalJson(args, found) ?? printCloudAutomation(found) };
  }
  if (args.command === "create") {
    if (args.flags.has("environment")) throw new Error("Cloud loops run in their Cloud thread's project. Drop --environment.");
    const project = flag(args, "project");
    const thread = flag(args, "thread") ?? (args.flags.has("template") && project
      ? await cloudTemplateHost(bb.sdk, { projectId: project, name: requireFlag(args, "name"), providerId: requireFlag(args, "provider"), model: requireFlag(args, "model") })
      : ctx.threadId);
    if (!thread) throw new Error("Missing required option --thread <cloudThreadId>.");
    const schedule = boolFlag(args, "webhook") && buildTrigger(args).triggerType === "webhook" ? { webhook: true as const } : cloudSchedule(args);
    if (!schedule) throw new Error("Provide exactly one trigger flag: --cron, --at, --in, or --webhook.");
    return one({ action: "create", thread, name: requireFlag(args, "name"), prompt: requireFlag(args, "prompt"), ...schedule, enabled: !boolFlag(args, "disabled"),
      ...(boolFlag(args, "new-thread") ? { new_thread: true } : boolFlag(args, "same-thread") ? { new_thread: false } : {}), ...await cloudScript(bb, args, ctx), ...cloudAgent(args), ...parsePriority(args), ...cloudSecrets(args) }, "created");
  }
  if (args.command === "update") {
    const fields = { ...(flag(args, "name") ? { name: flag(args, "name") } : {}), ...(flag(args, "prompt") ? { prompt: flag(args, "prompt") } : {}), ...cloudSchedule(args), ...await cloudScript(bb, args, ctx), ...cloudAgent(args), ...parsePriority(args), ...cloudSecrets(args) };
    return one({ action: "update", id: requireId(), ...fields }, "updated");
  }
  if (args.command === "pause" || args.command === "resume") return one({ action: "update", id: requireId(), enabled: args.command === "resume" }, args.command === "pause" ? "paused" : "resumed");
  if (args.command === "run") return one({ action: "run", id: requireId() }, "will run within a minute");
  if (args.command === "hook") {
    const { url } = await cloud.automations({ action: "hook", id: requireId() });
    if (!url) throw new Error("The website returned no webhook URL.");
    return { exitCode: 0, stdout: optionalJson(args, { id, url }) ?? `New URL for cloud loop ${id}; the old one no longer works.\n${webhookNote(url)}` };
  }
  if (args.command === "delete") {
    if (!boolFlag(args, "yes")) throw new Error("Deletion requires --yes when run through the plugin CLI.");
    await cloud.automations({ action: "delete", id: requireId() });
    return { exitCode: 0, stdout: optionalJson(args, { ok: true, id }) ?? `Cloud loop ${id} deleted\n` };
  }
  if (args.command === "runs") {
    const { history = [] } = await cloud.automations({ action: "history", id: requireId(), limit: Math.min(parseLimit(args, 20), 100) });
    return { exitCode: 0, stdout: optionalJson(args, history) ?? (history.length ? printCloudRuns(history) : "No runs recorded yet\n") };
  }
  throw new Error(`Unknown loop command: ${args.command}`);
}

/** Stop at plan limit (ADR 0292) and Switch provider at a limit (ADR 0345): account settings for loops. */
async function runSettingsCommand(bb: Pick<BbPluginApi, "sdk">, args: ParsedArgs): Promise<PluginCliResult> {
  const value = optionalFlag(args, "stop-at-limit");
  if (value !== undefined && value !== "on" && value !== "off") throw new Error("Use --stop-at-limit on or off.");
  const fallbackValue = optionalFlag(args, "fallback");
  if (fallbackValue !== undefined && fallbackValue !== "on" && fallbackValue !== "off") throw new Error("Use --fallback on or off.");
  const { stop_at_limit: stop, fallback } = await bb.sdk.cloudroom.automations({
    action: "settings",
    ...(value ? { stop_at_limit: value === "on" } : {}),
    ...(fallbackValue ? { fallback: fallbackValue === "on" } : {}),
  });
  return {
    exitCode: 0,
    stdout: optionalJson(args, { stop_at_limit: stop, fallback }) ?? `Stop at plan limit: ${stop === false ? "off" : "on"}\n  On: Cloud loops wait while their agent is at its plan limit or would spend extra credits.\nSwitch provider at a limit: ${fallback === false ? "off" : "on"}\n  On: a loop that hits a Claude or Codex limit runs on the other one, with the model of the same level.\n`,
  };
}

function printReview(items: readonly ReviewItem[]): string {
  if (items.length === 0) return "Nothing to review\n";
  return table(
    ["When", "Status", "Loop", "Title", "Item"],
    items.map((item) => [
      formatTimestamp(item.at),
      item.reviewedAt === null ? item.status : `${item.status} (reviewed)`,
      `${item.loop.name}${item.loop.cloud ? " (cloud)" : ""}`,
      item.title.length > 60 ? `${item.title.slice(0, 59)}…` : item.title,
      item.id,
    ]),
  );
}

async function runReviewCommand(
  service: AutomationService,
  args: ParsedArgs,
): Promise<PluginCliResult> {
  const [subcommand, ...itemIds] = args.positionals;
  if (subcommand === "mark") {
    if (itemIds.length === 0) throw new Error("Give one or more review item IDs.");
    const reviewed = !boolFlag(args, "undo");
    service.markReviewed({ itemIds, reviewed });
    return {
      exitCode: 0,
      stdout:
        optionalJson(args, { ok: true, itemIds, reviewed }) ??
        `${reviewed ? "Marked" : "Unmarked"} ${itemIds.length} reviewed\n`,
    };
  }
  if (subcommand !== undefined) throw new Error(`Unknown review command '${subcommand}'.`);
  const review = await service.review();
  const items = boolFlag(args, "all")
    ? review.items
    : review.items.filter((item) => item.reviewedAt === null);
  return {
    exitCode: 0,
    stdout: optionalJson(args, { toReview: review.toReview, items }) ?? printReview(items),
  };
}

const scanProgressSchema = z
  .object({
    stage: z.enum(["finding", "reading", "patterns"]),
    chats: z.number().int().nonnegative(),
    days: z.array(z.number().int().nonnegative()).max(91),
    read: z.array(z.number().int().nonnegative()).max(91),
    readers: z.number().int().nonnegative(),
    readersDone: z.number().int().nonnegative(),
    secrets: z.number().int().nonnegative(),
  })
  .partial()
  .strict();

/** `room-cli loop scan-progress --data JSON`: the Workflow scan skill saves its progress on its own thread for the progress card. */
async function runScanProgressCommand(
  bb: Pick<BbPluginApi, "sdk">,
  args: ParsedArgs,
  ctx: PluginCliContext,
): Promise<PluginCliResult> {
  if (!ctx.threadId) throw new Error("Run room-cli loop scan-progress from inside a Workflow scan thread.");
  const update = scanProgressSchema.parse(JSON.parse(requireFlag(args, "data")));
  const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: ctx.threadId });
  const current = metadata.workflowScan;
  if (current === null || typeof current !== "object" || Array.isArray(current)) {
    throw new Error("This thread is not a Workflow scan.");
  }
  await bb.sdk.threads.updatePluginMetadata({
    threadId: ctx.threadId,
    set: { workflowScan: { ...current, ...update } },
  });
  return { exitCode: 0, stdout: optionalJson(args, { saved: true }) ?? "Scan progress saved\n" };
}

/** `room-cli loop report` (ADR 0298). Each `--action` counts, so the raw arguments are read for them. */
async function runReportCommand(
  service: AutomationService,
  argv: string[],
  args: ParsedArgs,
  ctx: PluginCliContext,
): Promise<PluginCliResult> {
  if (!ctx.threadId) throw new Error("Run room-cli loop report from inside a loop run's thread.");
  const actions = argv.flatMap((arg, index) => (arg === "--action" && argv[index + 1] !== undefined ? [argv[index + 1]!] : []));
  await service.report({
    threadId: ctx.threadId,
    outcome: requireFlag(args, "outcome"),
    confidence: requireFlag(args, "confidence"),
    reason: requireFlag(args, "reason"),
    actions,
  });
  return { exitCode: 0, stdout: optionalJson(args, { reported: true }) ?? "Loop run reported\n" };
}

export function registerAutomationCli(args: {
  bb: Pick<BbPluginApi, "cli" | "sdk">;
  service: AutomationService;
}): void {
  const { bb, service } = args;
  bb.cli.register({
    name: "loop",
    summary: "Create and manage loops: scheduled agent and script runs, Local and Cloud (`room-cli automation` works too)",
    commands: [
      {
        name: "list",
        summary: "List a project's Local and Cloud loops",
        usage: "room-cli loop list --project <id> [--json]",
      },
      {
        name: "create",
        summary: "Create a loop, or add one from a template",
        usage:
          "room-cli loop create --project <id> --name <name> [schedule flags] [mode flags] [--priority 1-4] | room-cli loop create --template <id> --project <id> [--local]",
      },
      {
        name: "templates",
        summary: "List ready-made loops",
        usage: "room-cli loop templates [--json]",
      },
      {
        name: "show",
        summary: "Show loop details",
        usage: "room-cli loop show <loopId> --project <id> [--json]",
      },
      {
        name: "update",
        summary: "Update loop configuration",
        usage:
          "room-cli loop update <loopId> --project <id> [--priority 1-4] [flags] [--target-thread <id> | --environment <id-or-path> | --new-environment worktree] (omitted settings are kept)",
      },
      {
        name: "pause",
        summary: "Pause a loop",
        usage: "room-cli loop pause <loopId> --project <id> [--json]",
      },
      {
        name: "resume",
        summary: "Resume a loop",
        usage: "room-cli loop resume <loopId> --project <id> [--json]",
      },
      {
        name: "run",
        summary: "Run a loop now",
        usage:
          "room-cli loop run <loopId> --project <id> [--idempotency-key <key>] [--json]",
      },
      {
        name: "hook",
        summary: "Replace a webhook loop's secret URL",
        usage: "room-cli loop hook <loopId> --project <id> [--json]",
      },
      {
        name: "runs",
        summary: "List loop runs",
        usage:
          "room-cli loop runs <loopId> --project <id> [--limit <count>] [--output <runId>] [--json]",
      },
      {
        name: "review",
        summary: "List what loops did on their own, and mark items reviewed",
        usage:
          "room-cli loop review [--all] [--json] | room-cli loop review mark <itemId...> [--undo]",
      },
      {
        name: "report",
        summary: "Inside a loop run: record what it did, why, and how sure it was",
        usage:
          'room-cli loop report --outcome done|acted|needs-you|failed --confidence high|medium|low --reason "..." [--action "..."]...',
      },
      {
        name: "scan-progress",
        summary: "Inside a Workflow scan: save its progress for the progress card",
        usage: "room-cli loop scan-progress --data '{\"stage\":\"reading\",\"readersDone\":3}'",
      },
      {
        name: "delete",
        summary: "Delete a loop",
        usage:
          "room-cli loop delete <loopId> --project <id> --yes [--json]",
      },
      {
        name: "settings",
        summary: "Read or set whether loops stop or switch provider at plan limits",
        usage: "room-cli loop settings [--stop-at-limit on|off] [--fallback on|off] [--json]",
      },
    ],
    async run(argv: string[], ctx: PluginCliContext): Promise<PluginCliResult> {
      try {
        const parsed = parseArgs(argv);
        const command = parsed.command;
        if (command === "help" || command === "--help" || command === "-h") {
          return { exitCode: 0, stdout: helpText() };
        }
        if (command === "templates") {
          await requireTemplatesPlan(bb);
          return { exitCode: 0, stdout: optionalJson(parsed, LOOP_TEMPLATES) ?? printTemplates() };
        }
        if (command === "settings") return await runSettingsCommand(bb, parsed);
        if (command === "create") await applyTemplate(bb, parsed);
        if (isCloudCommand(parsed)) return await runCloudCommand(bb, parsed, ctx);
        if (command === "review") return await runReviewCommand(service, parsed);
        if (command === "report") return await runReportCommand(service, argv, parsed, ctx);
        if (command === "scan-progress") return await runScanProgressCommand(bb, parsed, ctx);
        if (command === "list") {
          const projectId = requireFlag(parsed, "project");
          const result = service.list({ projectId });
          const cloud = await projectCloudAutomations(bb, projectId).then(
            (automations) => ({ automations, error: "" }),
            (error: unknown) => ({
              automations: [],
              error: `Cloud loops unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
            }),
          );
          const json = optionalJson(parsed, [
            ...result,
            ...cloud.automations.map((automation) => ({ ...automation, cloud: true })),
          ]);
          const text =
            (result.length === 0 ? "" : printAutomationTable(result)) +
            (cloud.automations.length === 0
              ? ""
              : `Cloud loops\n${cloud.automations.map(printCloudAutomation).join("")}`);
          return {
            exitCode: 0,
            stdout: json ?? (text || (cloud.error ? "" : "No loops found\n")),
            ...(cloud.error ? { stderr: cloud.error } : {}),
          };
        }
        if (command === "create") {
          const projectId = requireFlag(parsed, "project");
          const { execution, scriptSource } = await buildExecution(
            bb,
            parsed,
            ctx,
          );
          const request: ResolvedCreateAutomationInput = {
            projectId,
            name: requireFlag(parsed, "name"),
            enabled: !boolFlag(parsed, "disabled"),
            trigger: buildTrigger(parsed),
            execution,
            origin: ctx.threadId ? "agent" : "human",
            ...(ctx.threadId ? { createdByThreadId: ctx.threadId } : {}),
            ...parsePriority(parsed),
          };
          const created = await service.create(request);
          const json = optionalJson(parsed, created);
          const paused =
            created.trigger.triggerType === "webhook" &&
            !created.enabled &&
            request.enabled
              ? "  It starts paused, because an agent made it: a person turns it on in the Loops panel.\n"
              : "";
          return {
            exitCode: 0,
            stdout:
              json ??
              `Loop created: ${created.id}\n${printAutomation(created)}${created.webhookUrl ? webhookNote(created.webhookUrl) : ""}${paused}${printScriptFileSnapshotNote(created, scriptSource)}`,
          };
        }
        if (command === "show") {
          const automationId = parsed.positionals[0];
          if (!automationId) throw new Error("Missing automationId.");
          const found = await service.get({
            projectId: requireFlag(parsed, "project"),
            automationId,
          });
          const json = optionalJson(parsed, found);
          return {
            exitCode: 0,
            stdout:
              json ??
              ("problem" in found
                ? printAutomationProblem(found)
                : printAutomation(found)),
          };
        }
        if (command === "update") {
          const { request, scriptSource } = await buildUpdateRequest(
            bb,
            service,
            parsed,
            ctx,
          );
          const updated = await service.update(request);
          const json = optionalJson(parsed, updated);
          return {
            exitCode: 0,
            stdout:
              json ??
              `Loop ${updated.id} updated\n${printAutomation(updated)}${printScriptFileSnapshotNote(updated, scriptSource)}`,
          };
        }
        if (command === "pause" || command === "resume") {
          const automationId = parsed.positionals[0];
          if (!automationId) throw new Error("Missing automationId.");
          const input = {
            projectId: requireFlag(parsed, "project"),
            automationId,
          };
          // Anyone with a Local webhook loop's URL can prompt an agent on this Mac, so a person turns it on (ADR 0260).
          if (command === "resume" && ctx.threadId) {
            const found = await service.get(input);
            if ("trigger" in found && found.trigger.triggerType === "webhook") {
              throw new Error(
                "A person must turn on a Local webhook loop in the Loops panel. Ask the user to.",
              );
            }
          }
          const updated =
            command === "pause" ? service.pause(input) : service.resume(input);
          const json = optionalJson(parsed, updated);
          return {
            exitCode: 0,
            stdout:
              json ??
              `Loop ${updated.id} ${command === "pause" ? "paused" : "resumed"}\n`,
          };
        }
        if (command === "run") {
          const automationId = parsed.positionals[0];
          if (!automationId) throw new Error("Missing automationId.");
          const result = await service.run({
            projectId: requireFlag(parsed, "project"),
            automationId,
            ...(flag(parsed, "idempotency-key")
              ? { idempotencyKey: flag(parsed, "idempotency-key") }
              : {}),
          });
          const json = optionalJson(parsed, result);
          const threadLine = result.run.threadId
            ? `Thread: ${result.run.threadId}\n`
            : "";
          return {
            exitCode: 0,
            stdout: json ?? `Run started: ${result.run.id}\n${threadLine}`,
          };
        }
        if (command === "hook") {
          const automationId = parsed.positionals[0];
          if (!automationId) throw new Error("Missing automationId.");
          const updated = await service.newWebhookUrl({
            projectId: requireFlag(parsed, "project"),
            automationId,
          });
          const json = optionalJson(parsed, updated);
          return {
            exitCode: 0,
            stdout:
              json ??
              `New URL for loop ${updated.id}; the old one no longer works.\n${webhookNote(updated.webhookUrl!)}`,
          };
        }
        if (command === "runs") {
          const automationId = parsed.positionals[0];
          if (!automationId) throw new Error("Missing automationId.");
          const result = service.runs({
            projectId: requireFlag(parsed, "project"),
            automationId,
            limit: parseLimit(parsed, 50),
          });
          const outputRunId = flag(parsed, "output");
          if (outputRunId) {
            const run = result.runs.find(
              (candidate) => candidate.id === outputRunId,
            );
            if (!run)
              throw new Error(
                `Run ${outputRunId} not found in returned runs. Increase --limit if it is older.`,
              );
            const json = optionalJson(parsed, run);
            return { exitCode: 0, stdout: json ?? `${run.output ?? ""}\n` };
          }
          const json = optionalJson(parsed, result);
          return {
            exitCode: 0,
            stdout:
              json ??
              (result.runs.length === 0
                ? "No runs found\n"
                : printRunTable(result.runs)),
          };
        }
        if (command === "delete") {
          const automationId = parsed.positionals[0];
          if (!automationId) throw new Error("Missing automationId.");
          if (!boolFlag(parsed, "yes")) {
            throw new Error(
              "Deletion requires --yes when run through the plugin CLI.",
            );
          }
          await service.delete({
            projectId: requireFlag(parsed, "project"),
            automationId,
          });
          const value = { ok: true, id: automationId };
          const json = optionalJson(parsed, value);
          return {
            exitCode: 0,
            stdout: json ?? `Loop ${automationId} deleted\n`,
          };
        }
        throw new Error(
          `Unknown loop command '${command}'.\n\n${helpText()}`,
        );
      } catch (error) {
        return {
          exitCode: 1,
          stderr: `${error instanceof Error ? error.message : String(error)}\n`,
        };
      }
    },
  });
}
