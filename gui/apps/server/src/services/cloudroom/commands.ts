import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, stat, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq, inArray, isNull, max, notInArray } from "drizzle-orm";
import { createThread, findLastCompletedRootStoredTurn, getAppSettings, getProject, getThread, getThreadExecutionOverride, setThreadExecutionOverride, updateThread, cloudroomThreads, cloudroomCommands, events, threads, type DbConnection, type DbQueryConnection, type DbTransaction } from "@cloudroom/db";
import { PERSONAL_PROJECT_ID, encodeClientTurnRequestIdNumber, isStandaloneBuiltinCompactCommand, promptInputSchema, reasoningLevelSchema, threadQueuedMessageSchema, type Thread, type PromptInput, type ThreadEventType, type ThreadEventTurnStatus, type ThreadChangeKind, type ReasoningLevel, COMPUTER, COMPUTER_TITLE } from "@cloudroom/domain";
import type { CreateThreadRequest, ForkThreadRequest, SendMessageRequest, SendMessageResponse } from "@cloudroom/server-contract";
import { z } from "zod";
import { findCliExecutable } from "@cloudroom/process-utils";
import { ApiError } from "../../errors.js";
import { CloudroomClient, CloudroomConnectionError, CloudroomError, UPLOAD_PART, authRequiredMessages, type CodexAuthStatus, type SessionRecord, type VmRun, type VmRunResult } from "./client.js";
import { CLOUD_HARNESSES, HARNESS_NAMES, appendStartProgress, endedTurn, isAcpProvider, isCloudProvider, projectFollowUp, projectInitialPrompt, projectRecord, retractStillQueuedPrompts, startStepRunning, type CloudProvider, type StartStep } from "./events.js";
import { mentionsOpenAISide401 } from "./codex-errors.js";
import { codexOutage } from "./openai-status.js";
import { buildThreadStatusChangeMetadata } from "../threads/thread-runtime-display.js";
import { cloudPluginInstructions, cloudroomSystemPrompt, prepareCloudInstructionInput, resolveCustomInstructions } from "../threads/custom-instructions.js";
import { baseBranch, binding, bindings, command, commands, coreInUse, localTeleports, openBindings, queuedPrompts, saveBinding, saveCommandState, saveStatus, effectivePrompt, projectCopyProgress, stampBindings, teleportBlocked, unstartedTurn, type Binding, type Command, type OpenBinding } from "./store.js";
import { copyProject, copyRunning, githubRepository, localProjectNote, planProjectCopy, planProjectCopyOrThrow, reportProjectCopy, writeFilesState, type ProjectCopyJob } from "./project-copy.js";
import { CHILD_HINT, cloudForkOf, cloudForkPoint, codeFromOf, FORK_HARNESSES, FORK_HINT, landForkCode, localForkPoint, startCloudFork, threadCode, uploadInParts } from "./fork.js";
import { copyForkSourceHistory } from "../threads/thread-fork-history.js";
import { CloudGitError, savedWorkspacePath } from "./git.js";
import { appendClientTurnEvent, getLastExecutionOptions } from "../threads/thread-events.js";
import { getLeadingAgentOnlyInput, resolveDeferredFirstTurnContext } from "../threads/deferred-first-turn-context.js";
import { deriveTitleFallback, shouldGenerateThreadTitle } from "../threads/title-generation.js";
import { buildSuggestedBranchName } from "../threads/thread-create-helpers.js";
import { assertValidParentThread, isParentNotifiableChildThread } from "../threads/thread-parent.js";
import { inferThreadMetadata, queueThreadTitle } from "../threads/thread-metadata-inference.js";
import { getLastThreadOutput } from "../threads/thread-data.js";
import { cliPlace, reportAgentConnect, reportMacHelperProblem } from "./setup-telemetry.js";
import { cloudSkills, copyLogins, copyMacGithub, importCodexLogin, importPiLogin, loginMarkers, macPiSetup, markLogin, setupSync, skillInCloud, stopSync, syncStatus } from "./sync.js";
import { macClaudeSignedIn } from "./claude-token.js";
import { macAccess, macAccessSupported, noteWake, setupPreviews, stopPreviews, previewStatus } from "./previews.js";
import { CloudSecrets } from "./secrets.js";
import { CodexAccounts } from "./codex-accounts.js";
import { cancelMacCodexLogin, hasMacCodexLogin, macCodexLogin, macCodexLoginExpired, cursorKeyRejected, macCursorLogin, revokeDesktopToken, startMacCodexLogin, CLOUD_REGION, SANDBOX_PREFIX, SandboxAsleep, SandboxDirectory, sandboxThread, startRefused, type AutomationRun, type SandboxProject, type SandboxTrigger, type SandboxWakeTrigger } from "./sandboxes.js";
import type { AppDeps, LoggedWorkSessionDeps } from "../../types.js";
import { markMinutesSent, unsentMinutes } from "./time-in-app.js";
import { emitPluginThreadCreated } from "../plugins/plugin-thread-events.js";
import type { EditMessageRequest, EditMessageResponse } from "@cloudroom/server-contract";

const accountSchema = z.object({ id: z.string().uuid(), email: z.string().email() }).strict();
const connectionSchema = z.object({ url: z.string().url(), token: z.string().min(32), gateToken: z.string().regex(/^[a-zA-Z0-9._~-]{1,4096}$/).optional(), projectId: z.string().min(1).optional() }).strict();
export const HOSTED_WEBSITE = "https://www.cloudroom.dev";
const asOrigin = (value: string) => URL.canParse(value) && new URL(value).origin === value ? new URL(value) : null;
const isLoopback = (url: URL) => url.protocol === "http:" && url.hostname === "127.0.0.1" && Boolean(url.port);
export function configuredWebsite(): string {
  const value = process.env.CLOUDROOM_WEBSITE_URL?.trim().replace(/\/$/, "") || HOSTED_WEBSITE;
  const url = asOrigin(value);
  if (!url || (url.protocol !== "https:" && !isLoopback(url))) throw new ApiError(503, "cloudroom_website_invalid", "CLOUDROOM_WEBSITE_URL must be a website address, like https://cloudroom.example.com.");
  return value;
}
export function trustedWebsite(value: string): boolean {
  const url = asOrigin(value);
  return url !== null && (value === HOSTED_WEBSITE || isLoopback(url) || value === configuredWebsite());
}
const websiteSchema = z.string().url().refine(trustedWebsite);
const savedConnectionSchema = connectionSchema.extend({
  url: connectionSchema.shape.url.optional(), token: connectionSchema.shape.token.optional(), account: accountSchema.optional(), websiteUrl: websiteSchema.optional(),
  sandboxToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  onboarding: z.object({
    projectSelected: z.boolean().default(false), reported: z.array(z.enum(["connected", "project", "message"])).default([]),
    firstMessage: z.object({ sessionId: z.string(), requestId: z.string() }).optional(),
  }).optional(),
});
export type CloudroomAccount = z.infer<typeof accountSchema>;
const capabilitiesSchema = z.object({
  version: z.literal(1),
  repository: z.string(),
  stop: z.literal(true),
  resume: z.literal(true),
  launch_settings: z.literal(true),
  prompt_reasoning: z.boolean().default(false),
  workspaces: z.boolean().default(false),
  direct_workspaces: z.boolean().default(false),
  root_workspace: z.boolean().default(false),
  teleport: z.boolean().default(false),
  command_guard: z.boolean().default(false),
  strip_ai_co_authors: z.boolean().default(false),
  system_prompt: z.boolean().default(false),
  codex_auth: z.boolean().default(false),
  cursor_auth: z.boolean().default(false),
  claude_auth: z.boolean().default(false),
  codex_auth_import: z.boolean().default(false),
  sync: z.boolean().default(false),
  previews: z.boolean().default(false),
  structured_prompt: z.boolean().default(false),
  queue_edit: z.boolean().default(false),
  child_threads: z.boolean().default(false),
  relay: z.boolean().default(false),
  queue_cancel: z.boolean().default(false),
  queue_reorder: z.boolean().default(false),
  steer: z.boolean().default(false),
  rewind: z.boolean().default(false),
  fork: z.boolean().default(false),
  side_chat: z.boolean().default(false),
  side_chat_fresh: z.boolean().default(false),
  attachments: z.boolean().default(false),
  upload_parts: z.boolean().default(false),
  compact: z.boolean().default(false),
  goal: z.boolean().default(false),
  usage: z.boolean().default(false),
  subagents: z.boolean().default(false),
  long_prompts: z.boolean().default(false),
  harnesses: z.array(z.object({
    id: z.string(),
    model: z.string(),
    provider: z.string().nullable().optional(),
    provider_selection: z.boolean().default(false),
    reasoning_levels: z.array(z.string()).default(["none", "minimal", "low", "medium", "high", "xhigh"]),
    models: z.array(z.object({ model: z.string(), reasoning_levels: z.array(z.string()) })).nullable().optional(),
    steer: z.boolean().default(false),
    compact: z.boolean().default(false),
    goal: z.boolean().default(false),
    service_tier: z.boolean().default(false),
    skill_mentions: z.boolean().default(false),
    rewind: z.boolean().default(false),
    attachments: z.object({ images: z.boolean(), files: z.boolean() }).optional(),
    subagents: z.boolean().default(false),
    usage: z.boolean().default(false),
    /** fx switches effort per turn; other ACP harnesses keep the launch level. */
    prompt_reasoning: z.boolean().default(false),
  })),
});
type Connection = z.infer<typeof connectionSchema>;
type Capabilities = z.infer<typeof capabilitiesSchema>;
const storageBytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().default(null);
const storageSchema = z.object({
  enabled: z.boolean(), level: z.enum(["normal", "low_space", "blocked"]),
  reason: z.enum(["disk_capacity", "measurement_unavailable", "unprotected_test_mode"]),
  workspace_available_bytes: storageBytes, history_available_bytes: storageBytes,
  workspace_total_bytes: storageBytes, history_total_bytes: storageBytes, sampled_at: storageBytes,
});
type Storage = z.infer<typeof storageSchema>;
function storageMessage(storage: Storage | null): string | null {
  if (!storage?.enabled || storage.level !== "blocked") return null;
  if (storage.reason === "measurement_unavailable") return "Cloud disk space could not be measured. Work is paused until storage can be verified.";
  const bytes = storage.workspace_available_bytes === null || storage.history_available_bytes === null ? null : Math.min(storage.workspace_available_bytes, storage.history_available_bytes);
  return `The cloud disk is almost full${bytes === null ? "" : ` (${(bytes / 1e9).toFixed(1)} GB free)`}. Within 30 seconds Cloudroom stops the command filling it, and work resumes. Saved messages are kept.`;
}
type Deps = Pick<AppDeps, "db" | "hub" | "config" | "providerRegistry"> & Partial<LoggedWorkSessionDeps> & Partial<Pick<AppDeps, "pendingInteractions">>;
const services = new WeakMap<DbConnection, CloudroomService>();
const workspaceId = (projectId: string) => `bb_${projectId}`;
const ROOT_WORKSPACE = "root";
const workspaceName = (name: string) => name.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^\.+/, "").slice(0, 80) || "project";
const cloudStep = (sandbox: boolean, status: StartStep["status"] = "started"): StartStep => ({ key: "cloud", text: sandbox ? "Starting cloud sandbox" : "Connecting to cloud VM", status });

export function cloudroom(deps: Deps): CloudroomService {
  let service = services.get(deps.db);
  if (!service) { service = new CloudroomService(deps); services.set(deps.db, service); }
  return service;
}

/** Where a cloud thread runs, for anonymous usage events: its own sandbox or the older shared VM. */
export function cloudExecution(deps: Pick<AppDeps, "db">, threadId: string): "cloud_sandbox" | "cloud_vm" {
  return sandboxThread(binding(deps.db, threadId)?.coreUrl ?? "") ? "cloud_sandbox" : "cloud_vm";
}

const CHECKOUT_READ_TIMEOUT_MS = 60_000;

export function isCloudThread(thread: Pick<Thread, "executionTarget">): boolean {
  return thread.executionTarget === "cloud";
}

export function requireNativeThread(thread: Pick<Thread, "executionTarget">): void {
  if (isCloudThread(thread)) throw new ApiError(409, "cloudroom_unsupported", "This action is not supported for Cloud threads. Native execution is blocked.");
}

type PromptAttachment = { name: string; kind: "image" | "file"; localPath: string; id?: string; path?: string };
/** Runs when a project copy ends, with the client that ran it: a sandbox that slept mid-copy has a new address.
 *  `partial` says why only `.env` files arrived. It resolves once everything after the copy is done. */
type Landed = (error?: string, client?: CloudroomClient, partial?: string) => Promise<void>;
const CUT_SHORT = "The project copy was cut short, so some files may be missing.";
/** A project copy's target: one folder per thread sandbox, or one shared folder on a VM. */
const copyKey = (sandbox: string | null, workspace: string) => sandbox ? `${sandbox}:${workspace}` : workspace;

/** The project folder a thread's first message copies into, if it has one. */
function copyWorkspace(input: string | undefined): string | null {
  const workspace = input && z.object({ workspace: z.string().optional() }).parse(JSON.parse(input)).workspace;
  return workspace && workspace !== ROOT_WORKSPACE ? workspace : null;
}

function cloudTextContent(content: unknown): unknown {
  return Array.isArray(content) ? content.filter(part => part?.type === "text") : content;
}

function requireClaudeSkillSupport(content: unknown, capabilities: Capabilities, harness: string | undefined): void {
  if (harness !== "claude-code" || (capabilities.structured_prompt && harnessProfile(capabilities, harness)?.skill_mentions)) return;
  const input = z.array(promptInputSchema).parse(content ?? []);
  if (input.some(part => part.type === "text" && part.mentions.some(({ resource }) => resource.kind === "command" && resource.source === "skill"))) {
    throw new ApiError(409, "cloudroom_update", "Update the cloud core to load selected Claude skills. Your message is saved.");
  }
}

/** The most text one Cloud message can carry (ADR 0269). Older cores take 32 KB; unknown cores get the new limit and are rechecked on send. */
export function cloudPromptLimit(capabilities: Pick<Capabilities, "long_prompts"> | null | undefined): number {
  return capabilities && !capabilities.long_prompts ? 32 * 1024 : 256 * 1024;
}

export function promptPayload(input: PromptInput[], harness: string, attachmentsEnabled: boolean | { images: boolean; files: boolean }, limit: number): { text: string; content: PromptInput[]; attachments: PromptAttachment[] } {
  const skills: { name: string; chunk: number; start: number; end: number }[] = [];
  const attachments: PromptAttachment[] = [];
  const chunks: string[] = [];
  for (const part of input) {
    if (part.type === "text") {
      const chunk = chunks.push(part.text) - 1;
      for (const { resource, start, end } of part.mentions) {
        // Thread tags stay as plain `@thread:thr_...` text; the cloud agent reads that thread through Mac access.
        if (resource.kind === "thread") continue;
        // `/context` stays plain text; Claude Code runs it as its own command.
        if (harness === "claude-code" && resource.kind === "command" && resource.source === "command" && resource.origin === "builtin" && resource.name === "context") continue;
        if (resource.kind !== "command" || resource.source !== "skill") throw new ApiError(400, "cloudroom_unsupported", "Cloud supports skill and thread tags, but other mentions and commands are not enabled.");
        if (!resource.name || /\s/.test(resource.name) || start >= end || end > part.text.length || part.text.slice(start, end) !== `/${resource.name}`) throw new ApiError(400, "invalid_request", "The selected skill tag is invalid. Remove it and select the skill again.");
        skills.push({ name: resource.name, chunk, start, end });
      }
      continue;
    }
    if (!attachmentsEnabled) throw new ApiError(400, "cloudroom_unsupported", "Cloud attachments are not enabled.");
    if (part.type !== "localImage" && part.type !== "localFile") throw new ApiError(400, "cloudroom_unsupported", "Cloud attachments must be uploaded files.");
    if (typeof attachmentsEnabled === "object" && !(part.type === "localImage" ? attachmentsEnabled.images : attachmentsEnabled.files)) throw new ApiError(400, "cloudroom_unsupported", "This attachment type is not enabled for the cloud harness.");
    attachments.push({
      name: part.path.split("/").pop() || "attachment",
      kind: part.type === "localImage" ? "image" : "file",
      localPath: part.path,
    });
  }
  const texts = [...chunks];
  const skill = skills.length === 1 ? skills[0] : undefined;
  if (harness === "pi" && skill) texts[skill.chunk] = texts[skill.chunk]!.slice(0, skill.start) + texts[skill.chunk]!.slice(skill.end);
  let text = texts.join("\n");
  if (harness === "pi" && skill) text = `/skill:${skill.name}${text ? `${text.startsWith(" ") ? "" : " "}${text}` : ""}`;
  if (!text.trim() && attachments.length === 0) throw new ApiError(400, "invalid_request", "Message is empty.");
  const bytes = Buffer.byteLength(text);
  if (bytes > limit) throw new ApiError(400, "invalid_request", `Message is too long (${Math.ceil(bytes / 1024)} KB). ${cloudLimitText(limit)} Shorten it or remove quoted messages.`);
  return { text, content: input, attachments };
}

function cloudLimitText(limit: number): string {
  return `Cloud messages can be up to ${limit / 1024} KB.${limit < 256 * 1024 ? " Update the cloud core to send up to 256 KB." : ""}`;
}

function coreModel(harness: CloudProvider, model: string, capabilities: z.infer<typeof capabilitiesSchema>): { model: string; provider?: string } {
  const profile = harnessProfile(capabilities, harness);
  if (!profile) throw new ApiError(400, "cloudroom_harness", `Configure ${harness} on the cloud VM first.`);
  if (harness !== "pi") return { model };
  const separator = model.indexOf("/");
  const provider = model.slice(0, separator);
  if (separator <= 0 || separator === model.length - 1) throw new ApiError(400, "cloudroom_model", "Select a Pi provider and model.");
  if (!profile.provider_selection && provider !== profile.provider) throw new ApiError(400, "cloudroom_model", "Update the cloud core to use another Pi provider.");
  return { model: model.slice(separator + 1), ...(profile.provider_selection ? { provider } : {}) };
}

function validateReasoning(harness: string, model: string, reasoning: string, capabilities: z.infer<typeof capabilitiesSchema>): void {
  const profile = harnessProfile(capabilities, harness);
  if (profile?.models === null) throw new ApiError(503, "model_catalog_unavailable", "Cloud model discovery is unavailable. Try again when the cloud harness is ready.");
  // Claude runs exact models its catalog omits, such as claude-opus-5-5[1m]; core allows any VM level (ADR 0133).
  const anyLevel = harness === "claude-code" ? [...new Set(profile?.models?.flatMap((item) => item.reasoning_levels))] : undefined;
  const levels = profile?.models ? (profile.models.find((item) => item.model === model)?.reasoning_levels ?? anyLevel) : profile?.reasoning_levels;
  if (profile?.models && !levels) {
    const name = HARNESS_NAMES[harness as CloudProvider] ?? harness;
    const offers = profile.models.slice(0, 4).map((item) => item.model).join(", ");
    const claudeHint = harness !== "claude-code" && model.startsWith("claude") ? " Use the claude-code provider for Claude." : "";
    throw new ApiError(400, "invalid_model", `${model} is not a ${name} model on Cloud.${offers ? ` ${name} offers ${offers}.` : ""}${claudeHint}`);
  }
  if (!levels?.includes(reasoning)) throw new ApiError(400, "invalid_reasoning_effort", "This reasoning level is unavailable for the cloud model. Select a supported level.");
}

function followUpPayload(harness: string, saved: Binding, payload: SendMessageRequest, reasoning: string | null, capabilities: Capabilities) {
  const profile = harnessProfile(capabilities, harness);
  if ((payload.mode === "steer" || payload.mode === "steer-if-active") && (!feature(capabilities, "steer") || profile?.steer === false)) throw new ApiError(409, "cloudroom_unsupported", "Cloud steering is not enabled. Use --mode queue.");
  if (payload.serviceTier === "fast" && !profile?.service_tier) throw new ApiError(409, "cloudroom_launch_settings", "Model is fixed for this cloud session. Start a new thread to change it.");
  if (reasoning !== null) validateFollowUpReasoning(harness, saved, reasoning, capabilities);
  return promptPayload(payload.input, harness, capabilities.attachments && (profile?.attachments ?? true), cloudPromptLimit(capabilities));
}

function validateFollowUpReasoning(harness: string, saved: Binding, reasoning: string, capabilities: Capabilities): void {
  if (reasoning === saved.reasoning) return;
  if (isAcpProvider(harness)) {
    if (!harnessProfile(capabilities, harness)?.prompt_reasoning) throw new ApiError(409, "cloudroom_launch_settings", `${HARNESS_NAMES[harness]} reasoning is fixed for this cloud session. Start a new thread to change it.`);
  } else if (harness !== "codex" && harness !== "pi" && harness !== "claude-code") throw new ApiError(400, "cloudroom_harness", "Unsupported cloud harness.");
  if (!capabilities.prompt_reasoning) throw new ApiError(409, "cloudroom_update", "Update the cloud core before changing reasoning on a follow-up.");
  validateReasoning(harness, coreModel(harness, saved.model, capabilities).model, reasoning, capabilities);
}

function sameStoredPrompt(previous: Command, threadId: string, payload: object, requested: string, launch: string): boolean {
  if (previous.threadId !== threadId || previous.command !== "prompt") return false;
  try {
    const stored = JSON.parse(previous.input);
    const storedReasoning = typeof stored.reasoning === "string" ? stored.reasoning : launch;
    const next = payload as { text?: string; service_tier?: string };
    return stored.text === next.text
      && storedReasoning === requested
      && (stored.service_tier ?? "default") === (next.service_tier ?? "default")
      && (stored.content === undefined || JSON.stringify(stored.content) === JSON.stringify((payload as { content?: unknown }).content ?? null));
  } catch {
    return false;
  }
}

function feature(capabilities: Capabilities | null | undefined, name: keyof Capabilities): boolean {
  return capabilities?.[name] === true;
}

function hashedRequestId(id: string): string {
  return encodeClientTurnRequestIdNumber({ value: createHash("sha256").update(id).digest().readUIntBE(0, 6) });
}

function nativeRewindBefore(db: DbQueryConnection, threadId: string, expectedRequestSequence?: number): string | undefined {
  const row = db.select({ data: events.data }).from(events).where(and(eq(events.threadId, threadId), eq(events.type, "client/turn/requested"), expectedRequestSequence === undefined ? undefined : eq(events.sequence, expectedRequestSequence))).orderBy(desc(events.sequence)).get();
  if (!row) throw new ApiError(409, "invalid_request", "The selected message is no longer available");
  const requestId = JSON.parse(row.data).requestId;
  if (typeof requestId !== "string") throw new ApiError(409, "invalid_request", "The selected message is not an editable user turn");
  const checkpoints = db.select({ data: events.data }).from(events).where(and(eq(events.threadId, threadId), eq(events.type, "system/operation"))).all();
  for (const checkpoint of checkpoints.reverse()) {
    try {
      const data = JSON.parse(checkpoint.data) as { operation?: string; metadata?: { id?: string; request_id?: string | null } };
      if (data.operation !== "checkpoint" || typeof data.metadata?.id !== "string" || typeof data.metadata.request_id !== "string") continue;
      if (hashedRequestId(data.metadata.request_id) === requestId) return data.metadata.id;
    } catch { /* ignore malformed checkpoint rows */ }
  }
  throw new ApiError(409, "invalid_request", "A native rewind checkpoint is not available for this message");
}

function harnessProfile(capabilities: Capabilities, harness: string) {
  const id = isCloudProvider(harness) ? CLOUD_HARNESSES[harness] : harness;
  return capabilities.harnesses.find((item) => item.id === id);
}

function commandReasoning(input: string): string | undefined {
  try {
    const value = JSON.parse(input).reasoning;
    return reasoningLevelSchema.safeParse(value).success ? value : undefined;
  } catch {
    return undefined;
  }
}

const connectionOrReplayFailed = "Cloudroom connection or replay failed";

function publicError(error: unknown): string {
  if (error instanceof CloudroomError || error instanceof ApiError) return error.message;
  return error instanceof Error ? `${connectionOrReplayFailed}: ${error.message}` : connectionOrReplayFailed;
}

function connectionFailure(error: unknown): boolean {
  return error instanceof CloudroomConnectionError
    || (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof CloudroomError && error.status !== null && (error.status >= 500 || error.status === 408 || error.status === 429));
}

/** Whether a command can never succeed. Such a command fails at once, so it cannot block every command behind it.
 *  Retry only a lost connection, a busy or restarting core, or an answer that never arrived (the core ignores a
 *  repeated request ID). Errors from the app's own checks and code fail. A command aimed at another message (steer,
 *  edit, cancel, reorder) fails on any refusal: that message moved on, usually because its turn just started or ended. */
function refused(error: unknown, targeted: boolean): boolean {
  if (connectionFailure(error) || error instanceof SandboxAsleep) return false;
  if (error instanceof CloudroomError) return error.status !== null && error.status < 500 && (targeted || !(error.code && error.retryable));
  return !(error instanceof ApiError && error.status >= 500);
}

const retiredVmMessage = "This thread ran on the old shared cloud VM, which was shut down on October 2. Start a new Cloud thread to keep going.";

type ConnectionPhase = "delivery" | "stream" | "replay";
type ConnectionIssue = { message: string; reconnecting: boolean };

const AGENT_FORKS = "cloudroom-agent-forks.json";
const CHILD_REPORTS = "cloudroom-child-reports.json";
const childReportSchema = z.object({ child: z.string(), status: z.string(), turn: z.string() });
const AGENT_FORK_WAIT = 90_000;

class CloudroomService {
  teleportRecovery?: () => void;
  archiveRequest?: (threadId: string) => void;
  private readonly heldStarts = new Set<string>();
  childTurnEnded?: (child: Thread & { parentThreadId: string }, status: ThreadEventTurnStatus) => void;
  moveRequest?: (threadId: string, project: string) => void;
  // Kept per thread: teleports run at the same time, and one shared value gave threads each other's sandboxes.
  private readonly teleportUrls = new Map<string, string>();
  /** The core a thread's teleport picked, saved as its binding. */
  teleportUrl(threadId: string): string { return this.teleportUrls.get(threadId) ?? ""; }
  async teleportClient(threadId?: string): Promise<CloudroomClient> {
    const existing = threadId ? binding(this.deps.db, threadId) : null;
    const sandbox = existing ? sandboxThread(existing.coreUrl) : threadId && await this.newThreadsInSandboxes() ? threadId : null;
    if (sandbox) {
      // Teleported threads get their own sandbox too; this wakes it for the transfer.
      const coreUrl = SANDBOX_PREFIX + sandbox;
      if (threadId) this.teleportUrls.set(threadId, coreUrl);
      return this.client({ coreUrl } as Binding);
    }
    const connection = await this.connection();
    const saved = threadId ? binding(this.deps.db, threadId) : null;
    if (saved && saved.coreUrl !== connection.url) throw new ApiError(409, "cloudroom_connection_changed", "Restore this transfer's original cloud connection before continuing.");
    if (threadId) this.teleportUrls.set(threadId, connection.url);
    return new CloudroomClient(connection);
  }
  async threadClient(threadId: string, wake = true): Promise<CloudroomClient> {
    const saved = binding(this.deps.db, threadId);
    if (!saved) throw new ApiError(409, "cloudroom_thread_unstarted", "This cloud thread has not started yet.");
    return this.client(saved, wake);
  }
  followTeleport(threadId: string): void { void this.deliver(threadId).catch(() => {}); }
  private readonly leftParent = new Map<string, number | string>();
  /** A top-level thread in another thread's sandbox was a child there. As soon as that sandbox is awake, Core stops
   *  reporting it to that former parent, which may be archived. Repeats are harmless, so a failure retries a minute
   *  later or before its next work. Once Core detaches the session, or answers that it has no such session (a stale
   *  sandbox address answers 404 too, without saying so), that session is done. */
  private async leaveFormerParent(saved: Binding, client: CloudroomClient): Promise<void> {
    const sandbox = sandboxThread(saved.coreUrl);
    const mark = this.leftParent.get(saved.threadId) ?? 0;
    if (!saved.sessionId || !sandbox || sandbox === saved.threadId || mark === saved.sessionId || (typeof mark === "number" && mark > Date.now() && !commands(this.deps.db, saved.threadId).some(c => c.state === "sending")) || getThread(this.deps.db, saved.threadId)?.parentThreadId) return;
    try { await client.detach(saved.sessionId); this.leftParent.set(saved.threadId, saved.sessionId); }
    catch (error) {
      this.leftParent.set(saved.threadId, error instanceof CloudroomError && error.status === 404 && error.message.endsWith(": session not found") ? saved.sessionId : Date.now() + 60_000);
      this.warn("A Cloud thread could not leave its former parent", error, { threadId: saved.threadId });
    }
  }
  detach(threadId: string): void {
    this.streams.get(threadId)?.abort();
    this.streams.delete(threadId);
    this.streamErrors.delete(threadId);
    this.connectionIssues.delete(threadId);
  }
  /** The 1.5 s tick skips threads with nothing to do: a live stream with nothing unsent, or a sandbox found asleep
   *  since the last awake-list check, failed or not, and not woken here since. Everything else goes through deliver() as before. */
  private needsDelivery(row: OpenBinding): boolean {
    if (!row.sessionId || row.sending || this.connectionIssues.get(row.threadId)?.delivery) return true;
    const live = this.streams.has(row.threadId);
    if (!live && ["pending", "starting", "active", "stopping"].includes(row.status)) return true;
    const sandbox = sandboxThread(row.coreUrl);
    if (!live && sandbox && this.slept.get(row.threadId) === this.sandboxes.awakeChecks && !this.sandboxes.isAwake(sandbox)) return false;
    if (sandbox && sandbox !== row.threadId && !row.parentThreadId && this.leftParent.get(row.threadId) !== row.sessionId) return true;
    return !live;
  }
  private readonly slept = new Map<string, number>();
  private asleep(threadId: string): void {
    this.slept.set(threadId, this.sandboxes.awakeChecks);
    this.detach(threadId);
    const status = getThread(this.deps.db, threadId)?.status;
    if (status && status !== "idle" && status !== "error" && !commands(this.deps.db, threadId).some(c => c.state === "sending")) {
      saveStatus(this.deps.db, threadId, "idle");
      this.notify(threadId);
    }
  }
  private readonly switching = new Set<string>();
  private readonly sends = new Map<string, number>();
  private readonly streams = new Map<string, AbortController>();
  private readonly streamErrors = new Map<string, string>();
  private readonly connectionIssues = new Map<string, Partial<Record<ConnectionPhase, ConnectionIssue>>>();
  private readonly sentQueues = new Map<string, string>();
  /** Threads whose cloud disk is full or low, from Core's storage records. The composer shows one live card for it. */
  private readonly outOfMemory = new Set<string>();
  private readonly disk = new Map<string, { paused: boolean; reason: "disk_capacity" | "measurement_unavailable"; usedBytes: number | null; totalBytes: number | null }>();
  private readonly deliveries = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private epoch = 0;
  private configurationWrite: Promise<void> = Promise.resolve();
  private readonly recordWrites = new Map<string, Promise<void>>();
  private delivering?: Promise<void>;
  private syncIssue: string | null = null;
  private previewIssue: string | null = null;
  private previewSetupEpoch = -1;
  private previewRetryAt = 0;
  private onboardingDue = 0;
  private reportingOnboarding = false;
  private lastCapabilities: Capabilities | null = null;
  private claudeConnected: boolean | null = null;
  private readonly resumingStarts = new Set<string>();
  private readonly pausedCopies = new Map<string, { job: ProjectCopyJob; landed: Landed; tries: number }>();
  // Threads whose cut copy resumeCutCopy is planning, so a reconnect meanwhile can't plan a second.
  private readonly retrying = new Set<string>();
  private readonly catchUps = new Map<string, number>();
  /** Threads whose sandbox address just answered 404 and is being woken again (feedback #596). */
  private readonly rewoken = new Set<string>();
  /** What sandboxes run, kept apart from a VM's: an account with both starts new threads in sandboxes. */
  private sandboxCapabilities: Capabilities | null = null;
  private readonly secrets: CloudSecrets;
  readonly sandboxes: SandboxDirectory;
  readonly codexAccounts: CodexAccounts;
  constructor(private readonly deps: Deps) {
    this.secrets = new CloudSecrets(deps);
    this.sandboxes = new SandboxDirectory(async () => {
      const saved = await this.savedConnection();
      return saved?.sandboxToken && saved.account ? { website: saved.websiteUrl ?? HOSTED_WEBSITE, userId: saved.account.id, token: saved.sandboxToken } : null;
    }, thread => {
      void noteWake(deps, thread).catch(() => {});
      this.macReportDue = 0;
    });
    this.sandboxes.onRuns = runs => { for (const run of runs) this.adoptRun(run); };
    this.sandboxes.skipLogins = async () => {
      const markers = await loginMarkers(deps);
      // Disconnect signed these CLIs out, so a login on this Mac now is a new sign-in (ADR 0327).
      const signedInAgain = { codex: hasMacCodexLogin, claude: async () => await macClaudeSignedIn() === true };
      for (const [name, signedIn] of Object.entries(signedInAgain)) {
        if (markers[name] === "signed-out" && await signedIn()) {
          await markLogin(deps, name, null);
          delete markers[name];
        }
      }
      const skip = new Set(Object.keys(markers));
      if (!await copyMacGithub(deps)) skip.add("github");
      return skip;
    };
    this.codexAccounts = new CodexAccounts(body => this.sandboxes.codexAccounts(body), async () => (await this.sandboxes.account())?.userId ?? null,
      join(deps.config.dataDir, "cloudroom-codex-accounts.json"), () => this.restartAwake("codex"));
    // Renames, generated titles, agent renames, and new parents (a promoted subagent loses its parent's access) all
    // reach the website. Read after the change's transaction ends.
    deps.hub.onThreadChanged((threadId, changes) => { if (changes.includes("title-changed") || changes.includes("execution-options-changed") || changes.includes("parent-changed")) setImmediate(() => this.syncLabel(threadId)); });
  }

  private readonly labels = new Map<string, string>();
  private readonly labelSaves = new Map<string, Promise<void>>();
  /** Keeps the website's copy of a sandbox thread's title, project name, harness, model, Core session, and parent
   *  current, so the web can list it and read its history, and the thread that started it can too (ADR 0182, 0239,
   *  0256). Subagents sharing their parent's sandbox are found through its history. A thread's saves run one at a
   *  time, so an older label can't land after a newer one. The website routes the thread's turn reports, and its
   *  parent's tell, stop and archive, by the label's parent (ADR 0259), so `changeParent` saves a new parent there
   *  first, then runs `apply` (the Mac's change), then saves the parent the Mac ended up with: a no-op unless the
   *  change failed. Nothing changes if the first save fails. */
  private syncLabel(threadId: string): void {
    void this.oneLabelSave(threadId, () => this.saveLabel(threadId)).catch((error: unknown) => this.warn("Cloud thread label not saved", error, { threadId }));
  }

  private oneLabelSave<T>(threadId: string, save: () => Promise<T>): Promise<T> {
    const result = (this.labelSaves.get(threadId) ?? Promise.resolve()).then(save);
    const settled = result.then(() => {}, () => {});
    this.labelSaves.set(threadId, settled);
    void settled.then(() => { if (this.labelSaves.get(threadId) === settled) this.labelSaves.delete(threadId); });
    return result;
  }

  private async saveLabel(threadId: string, parent?: string | null): Promise<boolean | null> {
    const saved = binding(this.deps.db, threadId), thread = getThread(this.deps.db, threadId);
    if (!saved?.sessionId || !thread || sandboxThread(saved.coreUrl) !== threadId) return null;
    const label = { title: thread.title ?? thread.titleFallback ?? null, project_name: getProject(this.deps.db, thread.projectId)?.name ?? null, project: thread.projectId, session: saved.sessionId, harness: thread.providerId, model: thread.modelOverride ?? saved.model, parent: parent === undefined ? thread.parentThreadId ?? null : parent };
    const key = JSON.stringify(label);
    if (this.labels.get(threadId) === key) return null;
    this.labels.delete(threadId);
    const stored = await this.sandboxes.label(threadId, label);
    this.labels.set(threadId, key);
    return stored;
  }

  async changeParent(threadId: string, parent: string | null, apply: () => Promise<void>): Promise<void> {
    await this.oneLabelSave(threadId, async () => {
      const saved = binding(this.deps.db, threadId);
      if (saved && sandboxThread(saved.coreUrl) === threadId && !saved.sessionId) throw new ApiError(503, "cloudroom_parent_unsaved", "This Cloud thread is still starting. Change its parent once it has started.");
      try {
        if (await this.saveLabel(threadId, parent) === false) {
          this.labels.delete(threadId);
          throw new CloudroomError("Cloud has no record of this thread's sandbox yet");
        }
      } catch (error) {
        this.warn("A Cloud thread's new parent was not saved", error, { threadId });
        const signIn = error instanceof CloudroomError && (error.status === 401 || error.status === 403);
        if (error instanceof CloudroomError && !error.retryable && error.status !== null && !signIn) throw new ApiError(400, "cloudroom_parent_unsaved", publicError(error));
        throw new ApiError(503, "cloudroom_parent_unsaved", `Couldn't save the new parent to Cloud: ${(signIn ? "Sign in to Cloudroom to use cloud sandboxes" : publicError(error)).replace(/\.?$/, ".")} Try again.`);
      }
      try { await apply(); }
      finally { await this.saveLabel(threadId).catch((error: unknown) => this.warn("Cloud thread label not saved", error, { threadId })); }
    });
  }

  /** A thread the website started, say while this Mac was off: an automation's run (ADR 0239) or a top-level thread
   *  another Cloud thread launched (ADR 0267). It shows like any Cloud thread; its history streams in once its
   *  sandbox is awake or opened. Only the Mac that has its project shows it, and a thread this app already has is
   *  left alone. */
  private adoptRun(run: AutomationRun): void {
    // The run's own label names its agent (a launch may pick another); older runs fall back to the source thread's (ADR 0250).
    const source = getThread(this.deps.db, run.source), home = binding(this.deps.db, run.source), own = isCloudProvider(run.harness ?? undefined) && run.model;
    const providerId = own ? run.harness : source && home ? source.providerId : run.harness, model = own ? run.model : home?.model ?? run.model;
    if (!providerId || !model || (source && source.projectId !== run.project) || !getProject(this.deps.db, run.project) || getThread(this.deps.db, run.thread)) return;
    const adopted = this.deps.db.transaction(tx => {
      if (getThread(tx, run.thread) || tx.select().from(cloudroomThreads).where(eq(cloudroomThreads.sessionId, run.session)).get()) return null;
      const thread = createThread(tx, this.deps.hub, { id: run.thread, executionTarget: "cloud", projectId: run.project, providerId, title: run.title, titleFallback: "Loop run", status: "pending" });
      tx.insert(cloudroomThreads).values({ threadId: run.thread, coreUrl: SANDBOX_PREFIX + run.thread, sessionId: run.session, startRequestId: run.session.replace(/^cr_/, ""), model, reasoning: run.reasoning ?? home?.reasoning ?? "medium" }).run();
      return thread;
    });
    if (!adopted) return;
    emitPluginThreadCreated(adopted);
    this.notify(run.thread);
    void this.deliver(run.thread).catch(() => {});
  }

  /** New cloud threads get their own sandbox when the account has sandboxes (docs/scopes/sandboxes.md). */
  /** Background sandbox work never blocks the user, but its failures must reach the log. */
  private warn(message: string, error: unknown, fields: Record<string, unknown> = {}): void {
    this.deps.logger?.warn({ ...fields, error: error instanceof Error ? error.message : String(error) }, message);
  }

  /** A sandbox's Pi gets this Mac's custom providers and packages, if the user allowed copying logins (ADR 0130).
   *  Never blocks a start: Pi reports a missing provider itself. */
  private async copyPiSetup(client: CloudroomClient, sandbox: boolean): Promise<void> {
    if (!sandbox) return importPiLogin(this.deps);
    try {
      if (await copyLogins(this.deps) !== true) return;
      const setup = await macPiSetup(this.deps);
      if (setup) await client.piSetup(setup);
    } catch (error) { this.warn("Pi providers could not be copied to the cloud", error); }
  }

  private async sandboxMode(): Promise<boolean> {
    const saved = await this.savedConnection();
    return Boolean(saved?.sandboxToken && saved.account);
  }

  /** Where new cloud threads go. An account that moved back to its VM starts them there; its sandbox threads carry on. */
  async newThreadsInSandboxes(): Promise<boolean> {
    const saved = await this.savedConnection();
    if (!saved?.sandboxToken || !saved.account) return false;
    return !saved.token || await this.sandboxes.forNewThreads();
  }

  private get capabilitiesPath() { return join(this.deps.config.dataDir, "cloudroom-capability-cache.json"); }

  /** Sandboxes sleep, so remember the latest sandbox capabilities for the model picker. */
  private async rememberCapabilities(capabilities: Capabilities, sandbox: boolean): Promise<void> {
    this.lastCapabilities = capabilities;
    if (!sandbox) return;
    const changed = JSON.stringify(this.sandboxCapabilities) !== JSON.stringify(capabilities);
    this.sandboxCapabilities = capabilities;
    if (changed) await writeFile(this.capabilitiesPath, JSON.stringify(capabilities), { mode: 0o600 }).catch(() => {});
  }

  private nextCapabilitiesAsk = 0;
  /** Asks the website what the cloud offers, so a new account knows before its first sandbox runs. The saved copy is
   *  only a fallback: ask every minute, or every 15 s until a spare can answer. */
  private async learnSandboxCapabilities(): Promise<void> {
    if (Date.now() < this.nextCapabilitiesAsk) return;
    this.nextCapabilitiesAsk = Date.now() + 15_000;
    const raw = await this.sandboxes.capabilities();
    if (!raw) return;
    await this.rememberCapabilities(capabilitiesSchema.parse(raw), true);
    this.nextCapabilitiesAsk = Date.now() + 60_000;
  }

  private async savedCapabilities(): Promise<Capabilities | null> {
    if (this.sandboxCapabilities) return this.sandboxCapabilities;
    try { this.sandboxCapabilities = capabilitiesSchema.parse(JSON.parse(await readFile(this.capabilitiesPath, "utf8"))); }
    catch { return null; }
    return this.sandboxCapabilities;
  }

  private get path() { return join(this.deps.config.dataDir, "cloudroom.json"); }

  private savedCache: { key: string; value: z.infer<typeof savedConnectionSchema> } | null = null;

  private async savedConnection() {
    try {
      const info = await stat(this.path);
      // win32: NTFS has no POSIX mode bits; stat.mode reports group/other bits
      // on every file, so the 0o077 check rejects all files. ACLs govern there.
      if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("permissions");
      const key = `${info.ino}:${info.size}:${info.mtimeMs}`;
      if (this.savedCache?.key === key) return this.savedCache.value;
      const value = savedConnectionSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
      this.savedCache = { key, value };
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new ApiError(503, "cloudroom_config_invalid", "The private Cloudroom connection could not be read safely.");
    }
  }

  private async connection(): Promise<Connection> {
    const saved = await this.savedConnection();
    if (saved?.sandboxToken && (!saved.token || !saved.url)) throw new ApiError(409, "cloudroom_sandbox_only", "This action needs a cloud thread. Each cloud thread has its own sandbox, not one shared VM.");
    if (!saved?.token) throw new ApiError(503, "cloudroom_not_configured", "Cloud needs a free Cloudroom account. Sign in to use it.");
    const { account: _account, websiteUrl: _website, onboarding: _onboarding, sandboxToken: _sandboxToken, ...connection } = saved;
    return connectionSchema.parse(connection);
  }

  private changeConnection(action: () => Promise<void>): Promise<void> {
    const work = this.configurationWrite.then(action);
    this.configurationWrite = work.catch(() => {});
    return work;
  }

  /** Every hosted VM is retired (docs/scopes/sandboxes.md), but a Mac that signed in before keeps its dead address, which
   *  stalls cloud previews and sync. Only hosted accounts with sandboxes have all three fields; self-hosted VMs have no account.
   *  Returns the saved connection. */
  private async dropRetiredVm() {
    const retired = (saved: Awaited<ReturnType<typeof this.savedConnection>>) => Boolean(saved?.url && saved.account && saved.sandboxToken && (saved.websiteUrl ?? HOSTED_WEBSITE) === HOSTED_WEBSITE);
    const saved = await this.savedConnection();
    if (!retired(saved)) return saved;
    await this.changeConnection(async () => {
      const current = await this.savedConnection();
      if (!current || !retired(current)) return;
      const { url: _url, token: _token, gateToken: _gateToken, ...rest } = current;
      await this.saveConnection(rest);
      await stopSync(this.deps);
    }).catch(() => {});
    return this.savedConnection();
  }

  private async saveConnection(value: unknown): Promise<void> {
    this.savedCache = null;
    await mkdir(this.deps.config.dataDir, { recursive: true });
    const temporary = `${this.path}.${randomUUID()}`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }

  /** A thread's Core. Sandbox threads wake only when `wake` is true, for work that must be sent. */
  private async client(saved?: Binding, wake = true, trigger?: SandboxWakeTrigger, fresh = false): Promise<CloudroomClient> {
    return new CloudroomClient(await this.coreConnection(saved, wake, trigger, fresh));
  }

  private async coreConnection(saved?: Binding, wake = true, trigger?: SandboxWakeTrigger, fresh = false): Promise<{ url: string; token: string; gateToken?: string }> {
    if (saved) await this.requireOwnThread(saved);
    const sandbox = saved ? sandboxThread(saved.coreUrl) : null;
    if (sandbox) {
      if (wake) await this.beforeWake();
      const project = this.sandboxProject(getThread(this.deps.db, sandbox)?.projectId);
      // A sandbox archived while one of its threads is active (a missed or racing restore) comes back for it.
      const found = await this.sandboxes.connection(sandbox, project, wake, trigger, fresh).catch(async (error: unknown) => {
        if (!(error instanceof CloudroomError && error.code === "sandbox_archived") || !coreInUse(this.deps.db, SANDBOX_PREFIX + sandbox)) throw error;
        await this.sandboxes.restore(sandbox);
        return this.sandboxes.connection(sandbox, project, wake, trigger, fresh);
      });
      if (!found) throw new SandboxAsleep();
      return found;
    }
    const connection = await this.connection();
    if (saved && connection.url !== saved.coreUrl) throw new ApiError(409, "cloudroom_connection_changed", "This thread belongs to a different core connection. Restore its connection before continuing.");
    return connection;
  }

  /** Where a cloud thread's terminal runs: its Core, woken first, and the session whose folder the shell opens in. */
  async terminalConnection(threadId: string): Promise<{ url: string; token: string; gateToken?: string; session: string | null }> {
    const saved = binding(this.deps.db, threadId);
    if (!saved) throw new ApiError(409, "cloudroom_missing_binding", "This cloud thread has no cloud sandbox yet. Send it a message, then open the terminal.");
    const { url, token, gateToken } = await this.coreConnection(saved, true, "thread_view");
    return { url, token, ...(gateToken ? { gateToken } : {}), session: saved.sessionId ?? null };
  }

  /** Cloud threads stamped with another account stay locked until that account signs in again (docs/scopes/sandboxes.md). */
  private async otherAccountThread(saved: Binding): Promise<boolean> {
    return Boolean(saved.accountId) && saved.accountId !== (await this.savedConnection())?.account?.id;
  }

  private async beforeWake(): Promise<void> {
    void this.uploadMacConfig();
    const logins = this.syncLogins();
    if (!this.sandboxes.loginsCopied) await logins;
  }

  async requireOwnThread(saved: Binding): Promise<void> {
    if (await this.otherAccountThread(saved)) throw new ApiError(409, "cloudroom_other_account", "This cloud thread belongs to another Cloudroom account. Sign in with that account to use it.");
  }

  private async storage(client: CloudroomClient): Promise<Storage | null> {
    let health: Record<string, unknown>;
    try { health = await client.health(AbortSignal.timeout(5000)); }
    catch (error) {
      if (error instanceof CloudroomError && error.status === 404) return null;
      if (error instanceof DOMException && error.name === "AbortError") throw new CloudroomConnectionError("Cloud storage health request timed out. Available disk space is unknown.", error);
      throw error;
    }
    if (health.storage === undefined) return null;
    const parsed = storageSchema.safeParse(health.storage);
    if (!parsed.success) throw new ApiError(503, "cloudroom_storage_unknown", "Cloud storage status is invalid. Available disk space is unknown.");
    const storage = parsed.data;
    if (storage.enabled && (storage.reason === "measurement_unavailable" || (storage.sampled_at !== null && (Date.now() - storage.sampled_at > 30_000 || storage.sampled_at > Date.now() + 60_000)))) {
      return { ...storage, level: "blocked", reason: "measurement_unavailable", workspace_available_bytes: null, history_available_bytes: null, workspace_total_bytes: null, history_total_bytes: null };
    }
    return storage;
  }

  private async capabilities(client: CloudroomClient, storage?: Storage | null): Promise<Capabilities> {
    const message = storageMessage(storage === undefined ? await this.storage(client) : storage);
    if (message) throw new ApiError(503, "storage_blocked", message, { retryable: true });
    return capabilitiesSchema.parse(await client.capabilities());
  }

  /** Saves a VM connection, the desktop token for cloud sandboxes, or both (docs/scopes/sandboxes.md). */
  configure(raw: unknown, account?: CloudroomAccount, signal?: AbortSignal, websiteUrl?: string, sandboxToken?: string): Promise<void> {
    return this.changeConnection(async () => {
      signal?.throwIfAborted();
      const connection = raw === null ? null : connectionSchema.parse(raw);
      if (!connection && !(sandboxToken && account)) throw new ApiError(400, "invalid_request", "A VM connection or cloud sandboxes are required.");
      if (connection) connection.url = new URL(connection.url).href.replace(/\/$/, "");
      if (connection?.projectId && !getProject(this.deps.db, connection.projectId)) throw new ApiError(404, "project_not_found", "Project not found");
      const existing = await this.savedConnection();
      const previousAccount = existing?.account && existing.account.id !== account?.id ? existing.account.id : null;
      const savedBindings = bindings(this.deps.db).filter((saved) => !sandboxThread(saved.coreUrl) && (saved.accountId ? saved.accountId === account?.id : !previousAccount));
      if (connection && savedBindings.some((saved) => saved.coreUrl !== connection.url)) throw new ApiError(409, "cloudroom_connection_in_use", "Existing cloud threads belong to another core. Use a separate app profile; history has not been changed.");
      if (connection && savedBindings.length && existing?.projectId && connection.projectId && existing.projectId !== connection.projectId) throw new ApiError(409, "cloudroom_project_in_use", "Existing legacy cloud threads keep their current project binding.");
      if (connection && !account) {
        const client = new CloudroomClient(connection);
        this.lastCapabilities = await this.capabilities(client);
        await client.ready();
      }
      signal?.throwIfAborted();
      this.stop();
      if (previousAccount) {
        stampBindings(this.deps.db, previousAccount);
        this.sandboxes.reset();
      }
      await this.saveConnection({
        ...(connection ?? {}), ...(account ? { account: accountSchema.parse(account) } : {}),
        ...(websiteUrl ? { websiteUrl: websiteSchema.parse(websiteUrl) } : {}),
        ...(sandboxToken ? { sandboxToken } : {}),
        ...(account && existing?.account?.id === account.id && existing.url === connection?.url ? { onboarding: existing.onboarding } : {}),
      });
      if (signal?.aborted) {
        if (existing) await this.saveConnection(existing); else await rm(this.path, { force: true });
        if (existing?.token || existing?.sandboxToken) this.start();
        signal.throwIfAborted();
      }
      this.start();
    });
  }

  disconnect(): Promise<void> {
    this.stop();
    return this.changeConnection(async () => {
      this.stop();
      const saved = await this.savedConnection();
      await stopPreviews(this.deps);
      if (saved) {
        const { token: _token, gateToken: _gateToken, sandboxToken, ...binding } = saved;
        await this.saveConnection(binding);
        if (sandboxToken && saved.account) revokeDesktopToken({ website: saved.websiteUrl ?? HOSTED_WEBSITE, userId: saved.account.id, token: sandboxToken });
      }
      this.sandboxes.reset();
      await stopSync(this.deps);
    });
  }

  private sandboxProject(projectId = PERSONAL_PROJECT_ID): SandboxProject {
    const project = getProject(this.deps.db, projectId);
    return { id: project?.id ?? PERSONAL_PROJECT_ID, repository: project && project.id !== PERSONAL_PROJECT_ID ? githubRepository(project.gitRemoteUrl) : null, folder: workspaceName(project?.name ?? "project") };
  }

  /** The project of the newest cloud thread from the last 7 days, if any. */
  private recentCloudProject(): string | undefined {
    const recent = bindings(this.deps.db).filter(saved => sandboxThread(saved.coreUrl))
      .map(saved => getThread(this.deps.db, saved.threadId))
      .filter(thread => thread && !thread.archivedAt && !thread.deletedAt)
      .sort((a, b) => b!.createdAt - a!.createdAt)[0];
    return recent && Date.now() - recent.createdAt < 7 * 86_400_000 ? recent.projectId : undefined;
  }

  private async warmRecentProject(): Promise<void> {
    const project = this.recentCloudProject();
    if (project) await this.warmSandbox(project, "app_launch");
  }

  async warmSandbox(projectId: string, trigger: SandboxTrigger = "composer"): Promise<void> {
    if (!await this.newThreadsInSandboxes()) return;
    await this.syncLogins();
    void this.uploadMacConfig();
    await this.sandboxes.warm(this.sandboxProject(projectId), trigger);
  }

  private activityAt = 0;
  /** Any app use, Local threads included, keeps the spares warm, so no cloud thread boots (ADRs 0159, 0164). */
  async noteActivity(): Promise<void> {
    if (Date.now() - this.activityAt < 30_000) return;
    this.activityAt = Date.now();
    await this.warmSandbox(this.recentCloudProject() ?? PERSONAL_PROJECT_ID, "app_activity");
  }

  private active = { day: "", at: 0 };
  /** Reports once per UTC day that this account sent a message, Local or Cloud, with past days' active minutes. Failures retry after 10 minutes. */
  noteActiveDay(): void {
    const day = new Date().toISOString().slice(0, 10);
    if (this.active.day === day || Date.now() - this.active.at < 600_000) return;
    this.active.at = Date.now();
    void (async () => {
      const minutes = await unsentMinutes(this.deps);
      const saved = await this.sandboxes.active(minutes);
      this.active.day = day;
      await markMinutesSent(this.deps, saved ? minutes : {});
    })().catch(() => {});
  }

  async selectOnboardingProject(projectId: string): Promise<void> {
    if (!getProject(this.deps.db, projectId)) throw new ApiError(404, "project_not_found", "Project not found");
    await this.changeConnection(async () => {
      const saved = await this.savedConnection();
      if (!saved?.account || !saved.token || saved.onboarding?.projectSelected) return;
      await this.saveConnection({ ...saved, onboarding: { ...saved.onboarding, projectSelected: true } });
    });
    this.onboardingDue = 0;
    void this.reportOnboarding();
  }

  private async rememberCloudMessage(sessionId: string, requestId: string, epoch: number): Promise<void> {
    await this.changeConnection(async () => {
      const saved = await this.savedConnection();
      if (!saved?.account || !saved.token || saved.onboarding?.firstMessage || this.epoch !== epoch) return;
      await this.saveConnection({ ...saved, onboarding: { ...saved.onboarding, projectSelected: true, firstMessage: { sessionId, requestId } } });
    });
    this.onboardingDue = 0;
    void this.reportOnboarding();
  }

  private async reportOnboarding(): Promise<void> {
    if (this.stopped || this.reportingOnboarding || Date.now() < this.onboardingDue) return;
    this.reportingOnboarding = true;
    this.onboardingDue = Date.now() + 30_000;
    const epoch = this.epoch;
    try {
      const saved = await this.savedConnection();
      if (!saved?.account || !saved.token || !saved.url) return;
      const reported = saved.onboarding?.reported ?? [];
      if (reported.length === 3) return;
      const website = saved.websiteUrl ?? (saved.url.startsWith("https:") ? HOSTED_WEBSITE : null);
      if (!website) return;
      const projectSelected = saved.onboarding?.projectSelected || bindings(this.deps.db).some(item => item.coreUrl === saved.url);
      const first = saved.onboarding?.firstMessage ?? this.deps.db.select({ sessionId: cloudroomThreads.sessionId, requestId: cloudroomCommands.id })
        .from(cloudroomCommands).innerJoin(cloudroomThreads, eq(cloudroomThreads.threadId, cloudroomCommands.threadId))
        .where(and(eq(cloudroomThreads.coreUrl, saved.url), eq(cloudroomCommands.command, "prompt"), inArray(cloudroomCommands.state, ["accepted", "completed"]))).limit(1).get();
      const milestones = ["connected", ...(projectSelected ? ["project"] : []), ...(first?.sessionId ? ["message"] : [])] as ("connected" | "project" | "message")[];
      if (milestones.every(item => reported.includes(item))) return;
      if (!reported.includes("connected")) await (await this.client()).ready();
      if (this.stopped || epoch !== this.epoch) return;
      const response = await fetch(`${website}/api/desktop/onboarding`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${saved.account.id}:${saved.token}`).toString("base64")}` },
        body: JSON.stringify({ connected: true, projectSelected: Boolean(projectSelected), ...(first?.sessionId ? { firstMessage: first } : {}) }),
      });
      if (!response.ok) { await response.body?.cancel(); return; }
      const confirmed = z.object({ macConnectedAt: z.string().datetime({ offset: true }), projectSelectedAt: z.string().datetime({ offset: true }).nullable(), firstMessageAt: z.string().datetime({ offset: true }).nullable() }).parse(await response.json());
      if (this.stopped || epoch !== this.epoch) return;
      await this.changeConnection(async () => {
        const current = await this.savedConnection();
        if (!current?.token || current.token !== saved.token || current.account?.id !== saved.account!.id || epoch !== this.epoch) return;
        await this.saveConnection({ ...current, onboarding: { ...current.onboarding, reported: ["connected", ...(confirmed.projectSelectedAt ? ["project"] : []), ...(confirmed.firstMessageAt ? ["message"] : [])] } });
      });
    } catch {
    } finally { this.reportingOnboarding = false; }
  }

  private async previews() {
    const { detail, ...status } = await previewStatus(this.deps);
    if (status.state === "offline" && detail) reportMacHelperProblem(detail);
    return { ...status, explained: Boolean(detail), issue: this.previewIssue };
  }

  private macReports = new Map<string, { report: string; at: number }>();
  private macReportDue = 0;
  private async reportMacAccess(): Promise<void> {
    if (Date.now() < this.macReportDue) return;
    this.macReportDue = Date.now() + 15_000;
    const sandboxes = this.sandboxes.awakeSandboxes().filter(({ thread }) => getThread(this.deps.db, thread));
    if (!sandboxes.length) return this.macReports.clear();
    const status = await previewStatus(this.deps, 60_000);
    const report = { access: macAccessSupported ? await macAccess(this.deps) ?? "off" : "off", problem: status.state === "offline" && status.detail ? status.message : null };
    const key = JSON.stringify(report), sent = this.macReports;
    this.macReports = new Map();
    for (const { url, token } of sandboxes) {
      const id = `${url} ${token}`, last = sent.get(id);
      if (last && (last.at === Infinity || (last.report === key && Date.now() - last.at < 60_000))) { this.macReports.set(id, last); continue; }
      this.macReports.set(id, { report: key, at: Date.now() });
      void new CloudroomClient({ url, token, timeoutMs: 5000 }).reportMac(report).catch((error: unknown) => {
        if (error instanceof CloudroomError && (error.status === 404 || error.status === 409)) this.macReports.set(id, { report: key, at: Infinity });
      });
    }
  }

  private ensurePreviews(capabilities: Capabilities): Promise<void> | undefined {
    if (!capabilities.previews || this.stopped || this.previewSetupEpoch === this.epoch || Date.now() < this.previewRetryAt) return;
    const epoch = this.epoch;
    this.previewSetupEpoch = epoch;
    this.previewRetryAt = Date.now() + 30_000;
    return this.changeConnection(async () => {
      if (this.stopped || epoch !== this.epoch) return;
      await setupPreviews(this.deps);
      if (epoch === this.epoch) this.previewIssue = null;
    }).catch(() => {
      if (epoch !== this.epoch) return;
      this.previewIssue = "Cloud previews could not start. Cloud sessions are unaffected.";
    }).finally(() => { if (this.previewSetupEpoch === epoch) this.previewSetupEpoch = -1; });
  }

  async status() {
    const lastCloudAt = this.deps.db.select({ at: max(threads.updatedAt) }).from(threads).where(eq(threads.executionTarget, "cloud")).get()?.at ?? null;
    let account: CloudroomAccount | null = null;
    let projectId: string | null = null;
    let storage: Storage | null = null;
    // A core connected by URL and token, with no Cloudroom account: the user hosts it (docs/cloudroom.md).
    let selfHosted = false;
    try {
      const saved = await this.savedConnection();
      account = saved?.token ? saved.account ?? null : null;
      selfHosted = Boolean(saved?.token && !saved.account);
      projectId = saved?.projectId ?? null;
      if (saved?.sandboxToken && saved.account && await this.newThreadsInSandboxes()) {
        // New threads start in sandboxes, which sleep between tasks; report their latest capabilities, never a VM's.
        // Null harnesses mean unknown: the composer then lets the sandbox decide instead of blocking.
        // Nothing to learn while in the cloud queue: no sandbox runs, so skip the website call.
        if (!this.sandboxes.cloudQueue()) void this.learnSandboxCapabilities().catch(() => {});
        const capabilities = await this.savedCapabilities();
        // The preview helper reaches every awake sandbox through the website (docs/scopes/sandboxes.md).
        if (capabilities) void this.ensurePreviews(capabilities);
        return {
          ready: true, account: saved.account, projectId, storage: null, harnesses: capabilities?.harnesses ?? null, sync: null,
          previews: capabilities?.previews ? await this.previews() : null,
          workspaces: true, teleport: capabilities?.teleport ?? false, repository: null,
          model: capabilities?.harnesses.find((h) => h.id === "codex")?.model ?? null,
          steer: capabilities?.steer ?? false, rewind: capabilities?.rewind ?? false, attachments: capabilities?.attachments ?? false,
          compact: capabilities?.compact ?? false, queue_edit: capabilities?.queue_edit ?? false, queue_cancel: capabilities?.queue_cancel ?? false,
          queue_reorder: capabilities?.queue_reorder ?? false, error: null, cloudQueue: this.sandboxes.cloudQueue(), usedCloud: lastCloudAt !== null, lastCloudAt,
          plan: this.sandboxes.currentPlan(), planUsage: this.sandboxes.planUsage(),
        };
      }
      const connection = await this.connection();
      const client = new CloudroomClient({ ...connection, timeoutMs: 5000 });
      storage = await this.storage(client);
      const capabilities = await this.capabilities(client, storage);
      this.lastCapabilities = capabilities;
      await client.ready();
      void this.ensurePreviews(capabilities);
      return {
        ready: true, account, selfHosted, projectId, storage, harnesses: capabilities.harnesses,
        sync: capabilities.sync ? { ...await syncStatus(this.deps), issue: this.syncIssue } : null,
        previews: capabilities.previews ? await this.previews() : null,
        workspaces: capabilities.workspaces, teleport: capabilities.teleport, repository: capabilities.repository,
        model: capabilities.harnesses.find((h) => h.id === "codex")?.model ?? null,
        steer: capabilities.steer, rewind: capabilities.rewind, attachments: capabilities.attachments,
        compact: capabilities.compact, queue_edit: capabilities.queue_edit, queue_cancel: capabilities.queue_cancel,
        queue_reorder: capabilities.queue_reorder, error: null, usedCloud: lastCloudAt !== null, lastCloudAt,
      };
    } catch (error) { return { ready: false, account, selfHosted, projectId, storage, workspaces: false, repository: null, model: null, error: publicError(error) }; }
  }

  /** Mac → cloud access (ADR 0113). Local agents reach this through `room-cli vm`.
   *  `threadId` picks a Cloud thread's sandbox and wakes it; without one, only the account's VM can run it. */
  async runOnVm(input: VmRun, threadId?: string, signal?: AbortSignal): Promise<VmRunResult> {
    const saved = threadId ? binding(this.deps.db, threadId) ?? undefined : undefined;
    if (threadId && !saved) throw new ApiError(404, "cloudroom_vm_run", "This is not a Cloud thread. Pass the ID of a Cloud thread.");
    try {
      const client = await this.client(saved);
      if (!input.stdin || input.stdin.length <= UPLOAD_PART * 2) return await client.runOnVm(input, signal);
      // Bigger input goes ahead in pieces, then becomes the command's stdin (feedback #442).
      const file = `.cache/cloudroom/stdin-${randomUUID()}`;
      try {
        await uploadInParts(client, file, Buffer.from(input.stdin, "hex"), signal);
        return await client.runOnVm({ command: `exec < ~/${file} && rm -f ~/${file}\n${input.command}`, cwd: input.cwd }, signal);
      } finally {
        await client.runOnVm({ command: `rm -f ~/${file}` }).catch(() => {});
      }
    } catch (error) {
      if (error instanceof ApiError && error.body.code === "cloudroom_sandbox_only") throw new ApiError(409, "cloudroom_vm_run", "Pass --thread <id> to pick which Cloud thread's sandbox runs this.");
      throw new ApiError(error instanceof CloudroomError && error.status === 409 ? 409 : 503, "cloudroom_vm_run", publicError(error));
    }
  }

  /** Sandbox accounts keep logins on the website, and every sandbox receives them when it wakes (ADR 0145).
   *  This includes accounts that still have a VM: their new threads run in sandboxes. */
  private async sandboxLogin(name: "claude" | "codex" | "cursor"): Promise<CodexAuthStatus | null> {
    if (!await this.newThreadsInSandboxes()) return null;
    const logins = await this.sandboxes.logins().catch((error: unknown) => { throw new ApiError(503, `${name}_auth_unavailable`, publicError(error)); });
    return { state: logins[name] ? "connected" : "missing", email: null, plan: null, message: null, login_id: null, verification_url: null, user_code: null };
  }

  private async uploadMacConfig(): Promise<void> {
    if (!await this.sandboxMode()) return;
    await Promise.all([
      this.sandboxes.copyMacConfig(skillInCloud(await cloudSkills(this.deps))).catch(error => this.warn("Skills could not be copied to cloud sandboxes", error)),
      this.sandboxes.refreshMacMcp().catch(error => this.warn("MCP servers could not be copied to cloud sandboxes", error)),
    ]);
  }

  /** Copies logins both ways when the user allowed it (ADRs 0130, 0175). Only the Mac → cloud copy is awaited. */
  private async syncLogins(cloudChanged = false): Promise<void> {
    if (!await this.sandboxMode() || await copyLogins(this.deps) !== true) return;
    void this.sandboxes.copyCloudLogins(cloudChanged).catch(error => this.warn("Cloud logins could not be copied to this Mac", error));
    await this.sandboxes.copyMacLogins().catch(error => this.warn("Logins could not be copied to cloud sandboxes", error));
  }

  /** `follow` marks the Accounts plugin keeping Cloud on the account in use, not the user connecting (ADR 0327). */
  async claudeAuth(action?: "login" | "cancel" | "complete" | "token" | "key", requestId?: string, code?: string, state?: string, follow = false) {
    const status = await this.claudeAuthStatus(action, requestId, code, state, follow);
    const connected = status.state === "connected";
    // The code sign-in finishes in the background, so a status check that first sees Claude connected also resumes.
    if (connected && (action || !this.claudeConnected)) this.resumeClaudeStarts();
    this.claudeConnected = connected;
    return status;
  }

  /** After an Accounts switch, the agent's awake sessions restart once idle, so their next message uses the new login (ADR 0197).
   *  Asleep sandboxes stay asleep; they read the new login when they wake. */
  restartAwake(providerId: "claude-code" | "codex"): void {
    for (const saved of bindings(this.deps.db)) {
      const thread = getThread(this.deps.db, saved.threadId);
      const sessionId = saved.sessionId;
      if (!sessionId || thread?.providerId !== providerId || thread.archivedAt || thread.deletedAt) continue;
      void this.client(saved, false).then(client => client.sleep(sessionId, randomUUID())).catch(() => {});
    }
  }

  /** Starts that waited for a Claude sign-in continue on their own. Later tries cover a login still reaching an awake sandbox. */
  private resumeClaudeStarts(): void {
    const waiting = (threadId: string) => {
      const saved = binding(this.deps.db, threadId);
      const thread = getThread(this.deps.db, threadId);
      return Boolean(saved && !saved.sessionId && authRequiredMessages.has(saved.error ?? "") && thread?.providerId === "claude-code" && !thread.archivedAt && !thread.deletedAt);
    };
    for (const { threadId } of bindings(this.deps.db)) {
      if (this.resumingStarts.has(threadId) || !waiting(threadId)) continue;
      this.resumingStarts.add(threadId);
      void (async () => {
        for (const wait of [0, 3_000, 10_000]) {
          await new Promise(resolve => setTimeout(resolve, wait).unref());
          if (this.stopped || !waiting(threadId)) return;
          await this.retryStart(threadId).catch(error => this.warn("Cloud start could not continue after Claude sign-in", error, { threadId }));
        }
      })().finally(() => this.resumingStarts.delete(threadId));
    }
  }

  private async claudeAuthStatus(action?: "login" | "cancel" | "complete" | "token" | "key", requestId?: string, code?: string, state?: string, follow = false) {
    const sandbox = await this.sandboxLogin("claude");
    if (sandbox) {
      if ((action === "token" || action === "key") && code) {
        if (!follow) await markLogin(this.deps, "claude", null);
        const value = action === "token" ? { token: code, ...(state ? { plan: state } : {}) } : { apiKey: code };
        if (!await this.sandboxes.saveLogin("claude", JSON.stringify(value), undefined, follow)) return sandbox;
      }
      if (action === "login" || action === "complete") throw new ApiError(409, "claude_auth_unsupported", `Cloud sandboxes connect Claude with a one-year token from this ${COMPUTER}. Use Connect Claude.`);
      if ((action === "token" || action === "key") && code) {
        void this.syncLogins(true);
        if ((await this.savedConnection())?.token) await this.vmClaudeAuth(action, requestId, code, state).catch(error => this.warn("Claude could not be connected on the VM", error));
      }
      return action === "token" || action === "key" ? { ...sandbox, state: "connected" as const } : sandbox;
    }
    return this.vmClaudeAuth(action, requestId, code, state);
  }

  private async vmClaudeAuth(action?: "login" | "cancel" | "complete" | "token" | "key", requestId?: string, code?: string, state?: string) {
    const client = await this.client();
    const capabilities = await this.capabilities(client);
    if (!capabilities.claude_auth) throw new ApiError(409, "claude_auth_unsupported", "Update the cloud core to connect Claude from this app.");
    try { return await client.claudeAuth(action, requestId, code, state); }
    catch (error) { throw new ApiError(error instanceof CloudroomError && error.status === 409 ? 409 : 503, "claude_auth_unavailable", `Could not reach Claude sign-in on your VM: ${publicError(error)}`); }
  }

  async cursorAuth(action?: "login" | "cancel" | "key", requestId?: string, apiKey?: string) {
    const sandbox = await this.sandboxLogin("cursor");
    if (sandbox) {
      // Signing in copies this Mac's Cursor login; clicking is the consent, even when automatic copying is off.
      if (action === "login") {
        const login = await macCursorLogin();
        if (!login) throw new ApiError(409, "cursor_auth_required", `Cursor is not signed in on this ${COMPUTER}. Run \`cursor-agent login\` in your terminal, then click Sign in with Cursor again, or use a Cursor API key.`);
        await this.sandboxes.saveLogin("cursor", login);
        return { ...sandbox, state: "connected" as const };
      }
      if (action !== "key") return sandbox.state === "connected" ? sandbox : { ...sandbox, message: `Cloud threads use this ${COMPUTER}'s Cursor login, or a Cursor user API key.` };
      const key = apiKey?.trim() ?? "";
      if (!/^[\x21-\x7e]{1,4096}$/.test(key)) throw new ApiError(400, "invalid_request", "Enter a valid Cursor API key.");
      if (await cursorKeyRejected(key)) throw new ApiError(400, "invalid_request", "Cursor says this API key is invalid. Check it and try again.");
      await this.sandboxes.saveLogin("cursor", JSON.stringify({ apiKey: key }));
      if ((await this.savedConnection())?.token) await this.vmCursorAuth(action, requestId, key).catch(error => this.warn("Cursor could not be connected on the VM", error));
      return { ...sandbox, state: "connected" as const };
    }
    return this.vmCursorAuth(action, requestId, apiKey);
  }

  private async vmCursorAuth(action?: "login" | "cancel" | "key", requestId?: string, apiKey?: string) {
    const client = await this.client();
    const capabilities = await this.capabilities(client);
    if (!capabilities.cursor_auth) throw new ApiError(409, "cursor_auth_unsupported", "Update the cloud core to connect Cursor from this app.");
    try { return await client.cursorAuth(action, requestId, apiKey); }
    catch (error) { throw new ApiError(error instanceof CloudroomError && error.status === 409 ? 409 : 503, error instanceof CloudroomError ? error.code ?? "cursor_auth_unavailable" : "cursor_auth_unavailable", publicError(error)); }
  }

  async piApiKey(provider: string, apiKey: string) {
    const client = await this.client();
    try { return await client.piApiKey(provider, apiKey); }
    catch (error) {
      if (error instanceof CloudroomError && error.status === 404) throw new ApiError(409, "pi_auth_unsupported", "Update the cloud core to set Pi keys from this app.");
      throw new ApiError(error instanceof CloudroomError && error.status === 409 ? 409 : 503, error instanceof CloudroomError ? error.code ?? "pi_auth_unavailable" : "pi_auth_unavailable", publicError(error));
    }
  }

  async codexAuth(action?: "login" | "cancel", requestId?: string) {
    const sandbox = await this.sandboxLogin("codex");
    if (sandbox) {
      let copied = false;
      if (action === "cancel") cancelMacCodexLogin();
      if (action === "login") {
        await markLogin(this.deps, "codex", null);
        const account = sandbox.state === "connected" ? await this.codexAccounts.selected() : null;
        if (account) throw new ApiError(409, "codex_account_rejected", `Cloud uses your Codex account ${account}. Sign in to it again with Add in Settings → Agents → Codex, or pick This ${COMPUTER_TITLE} there.`);
        if (await copyLogins(this.deps) !== true) {
          reportAgentConnect("codex", "failed", { code: "copy_logins_off" });
          throw new ApiError(409, "codex_auth_unsupported", `Cloud sandboxes use this ${COMPUTER}'s Codex login. Turn on "Auth my agents in the cloud automatically" in Settings → Cloud, then try again.`);
        }
        // Signed out or expired here, or the cloud rejected the saved login: sign in on this Mac first, then the next status check copies the new login.
        if (sandbox.state !== "connected" && await hasMacCodexLogin() && !await macCodexLoginExpired()) {
          await this.sandboxes.copyMacLogins(true);
          copied = true;
        } else startMacCodexLogin();
      }
      const run = macCodexLogin();
      if (run?.done && !run.error) {
        await this.sandboxes.copyMacLogins(true);
        copied = true;
      }
      const status = copied ? (await this.sandboxLogin("codex"))! : sandbox;
      if (run && !run.done) return { ...status, state: "waiting" as const, login_id: "mac", verification_url: run.url, message: "Finish signing in to ChatGPT in your browser." };
      if (run?.error) {
        reportAgentConnect("codex", "failed", { code: "login_failed", message: run.error, cliPlace: cliPlace(findCliExecutable("codex")) });
        return { ...status, state: "error" as const, message: run.error };
      }
      if (status.state === "connected" && (action === "login" || run?.done)) reportAgentConnect("codex", "ok", { cliPlace: cliPlace(findCliExecutable("codex")) });
      return status;
    }
    try {
      const client = await this.client();
      const capabilities = await this.capabilities(client);
      if (!capabilities.codex_auth) throw new ApiError(409, "codex_auth_unsupported", "Update the cloud core to connect Codex from this app.");
      if (capabilities.codex_auth_import && action !== "cancel") await importCodexLogin(this.deps);
      return await client.codexAuth(action, requestId);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(error instanceof CloudroomError && error.status === 409 ? 409 : 503, error instanceof CloudroomError ? error.code ?? "codex_auth_unavailable" : "codex_auth_unavailable", publicError(error));
    }
  }

  async threadWorkspace(threadId: string, signal?: AbortSignal) {
    const saved = binding(this.deps.db, threadId);
    if (!saved?.sessionId) return null;
    try {
      const workspace = await (await this.client(saved, false)).sessionWorkspace(saved.sessionId, signal);
      const lastWorkspace = JSON.stringify(workspace);
      if (lastWorkspace !== saved.lastWorkspace) saveBinding(this.deps.db, threadId, { lastWorkspace });
      return workspace;
    } catch (error) {
      // A sleeping sandbox can't change its checkout, so the last one read is still right.
      if (error instanceof SandboxAsleep) return saved.lastWorkspace ? JSON.parse(saved.lastWorkspace) as unknown : null;
      throw error;
    }
  }

  /** Runs a read-only Git script in a cloud thread's checkout. Never wakes the sandbox: a sleeping one throws SandboxAsleep. */
  async runInCheckout(threadId: string, script: string, stdin?: Buffer, signal?: AbortSignal): Promise<Buffer> {
    const saved = binding(this.deps.db, threadId);
    if (!saved?.sessionId) throw new CloudGitError("The cloud thread has not started yet.", null);
    const client = await this.client(saved, false);
    const path = savedWorkspacePath(saved.lastWorkspace) ?? (await client.sessionWorkspace(saved.sessionId, signal)).path;
    // A start mark skips anything the login shell prints before the script runs.
    const limit = AbortSignal.timeout(CHECKOUT_READ_TIMEOUT_MS);
    const result = await client.runOnVm({ command: `printf '\\035'\n${script}`, cwd: path, stdin: stdin?.toString("hex") ?? "" }, signal ? AbortSignal.any([signal, limit]) : limit);
    if (result.code !== 0 || result.truncated) throw new CloudGitError(Buffer.from(result.stderr, "hex").toString().trim() || "Git failed in the cloud sandbox.", result.code);
    const stdout = Buffer.from(result.stdout, "hex");
    return stdout.subarray(stdout.indexOf(0x1d) + 1);
  }

  /** Wakes a sleeping cloud thread before work is sent, when the user opens it or starts typing (ADR 0176). */
  async wakeAhead(threadId: string, trigger: SandboxWakeTrigger): Promise<void> {
    const saved = binding(this.deps.db, threadId);
    const thread = getThread(this.deps.db, threadId);
    if (!saved?.sessionId || !sandboxThread(saved.coreUrl) || !thread || thread.archivedAt || thread.deletedAt) return;
    await this.client(saved, true, trigger);
  }

  async preload(threadIds: string[]): Promise<void> {
    const due = new Map<string, SandboxProject>();
    for (const threadId of threadIds) {
      const saved = binding(this.deps.db, threadId);
      const thread = getThread(this.deps.db, threadId);
      const sandbox = saved?.sessionId ? sandboxThread(saved.coreUrl) : null;
      if (!saved || !sandbox || due.has(sandbox) || !thread || thread.archivedAt || thread.deletedAt || await this.otherAccountThread(saved)) continue;
      due.set(sandbox, this.sandboxProject(getThread(this.deps.db, sandbox)?.projectId));
    }
    if (due.size) await this.sandboxes.preload([...due].map(([thread, project]) => ({ thread, project })), () => this.beforeWake());
  }

  async updateReasoningOverride(thread: Thread, reasoningLevel: ReasoningLevel | null): Promise<void> {
    const saved = binding(this.deps.db, thread.id);
    if (!saved) throw new ApiError(409, "cloudroom_missing_binding", "Cloud thread has no core binding; native execution is blocked");
    if (thread.archivedAt || thread.deletedAt) throw new ApiError(409, "thread_not_writable", "Thread is archived or deleted");
    await this.requireOwnThread(saved);
    if (reasoningLevel !== null) {
      const known = sandboxThread(saved.coreUrl) ? await this.savedCapabilities() : this.lastCapabilities;
      try { validateFollowUpReasoning(thread.providerId, saved, reasoningLevel, known ?? await this.liveCapabilities(saved)); }
      catch (error) {
        if (!known || !(error instanceof ApiError)) throw error;
        validateFollowUpReasoning(thread.providerId, saved, reasoningLevel, await this.liveCapabilities(saved));
      }
    }
    setThreadExecutionOverride(this.deps.db, { threadId: thread.id, reasoningLevelOverride: reasoningLevel });
  }

  private async queueCapabilities(saved: Binding): Promise<Capabilities> {
    await this.requireOwnThread(saved);
    const known = sandboxThread(saved.coreUrl) ? await this.savedCapabilities() : this.lastCapabilities;
    return known ?? await this.liveCapabilities(saved);
  }

  private async liveCapabilities(saved: Binding): Promise<Capabilities> {
    try { return await this.capabilities(await this.client(saved)); }
    catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, error instanceof CloudroomError ? error.code ?? "cloudroom_unavailable" : "cloudroom_unavailable", publicError(error));
    }
  }

  private prompts(threadId: string) {
    return commands(this.deps.db, threadId).filter((item) => item.command === "prompt" && !JSON.parse(item.input).teleport_handoff);
  }

  private currentReasoning(threadId: string, saved: Binding): string {
    return getThreadExecutionOverride(this.deps.db, threadId)?.reasoningLevelOverride ?? commandReasoning(this.prompts(threadId).at(-1)?.input ?? "") ?? saved.reasoning;
  }

  /** Records only say paused or not, so each one also reads the disk size for the card's meter. */
  private noteDisk(threadId: string, client: CloudroomClient, data: unknown): void {
    const record = z.object({ paused: z.boolean().optional(), reason: z.string().optional() }).catch({}).parse(data);
    const previous = this.disk.get(threadId);
    this.disk.set(threadId, {
      paused: record.paused ?? previous?.paused ?? false,
      reason: record.reason === "measurement_unavailable" ? "measurement_unavailable" : "disk_capacity",
      usedBytes: previous?.usedBytes ?? null, totalBytes: previous?.totalBytes ?? null,
    });
    this.storage(client).then((storage) => {
      const current = this.disk.get(threadId);
      if (!current || !storage?.enabled) return;
      // A restarted sandbox sends no "recovered" record, so a disk found fine clears the card.
      if (storage.level === "normal") this.disk.delete(threadId);
      else if (storage.workspace_total_bytes !== null && storage.workspace_available_bytes !== null) {
        this.disk.set(threadId, { ...current, usedBytes: storage.workspace_total_bytes - storage.workspace_available_bytes, totalBytes: storage.workspace_total_bytes });
      }
      this.notify(threadId);
    }, () => {});
  }

  threadStatus(threadId: string) {
    const saved = binding(this.deps.db, threadId);
    if (!saved) return null;
    const prompts = this.prompts(threadId);
    const latestPrompt = prompts.at(-1);
    const reasoning = this.currentReasoning(threadId, saved);
    const transfer = commands(this.deps.db, threadId).find(item => item.command === "teleport");
    const input = latestPrompt ? effectivePrompt(this.deps.db, threadId, latestPrompt.id) : transfer ? JSON.parse(transfer.input).manifest ?? {} : {};
    const serviceTier = input.service_tier === "fast" ? "fast" : "default";
    const initial = prompts.find(item => item.id === `first_${threadId}`);
    const issues = Object.values(this.connectionIssues.get(threadId) ?? {});
    return { authRequired: !saved.sessionId && authRequiredMessages.has(saved.error ?? ""), starting: !saved.queuePaused && Boolean(initial && ["sending", "accepted"].includes(initial.state)), sessionId: saved.sessionId, paused: saved.queuePaused, failedStart: !saved.sessionId && initial?.state === "failed", model: saved.model, reasoning, serviceTier, error: saved.error ?? issues.find(issue => !issue.reconnecting)?.message ?? null, reconnecting: issues.some(issue => issue.reconnecting), usageLimit: Boolean(sandboxThread(saved.coreUrl)) && (this.sandboxes.usageLimited() || this.sandboxes.agentLimited(sandboxThread(saved.coreUrl) ?? "")), disk: this.disk.get(threadId) ?? null, awake: !sandboxThread(saved.coreUrl) || this.sandboxes.isAwake(sandboxThread(saved.coreUrl) ?? ""), vps: this.sandboxes.onVps(sandboxThread(saved.coreUrl) ?? ""), move: this.sandboxes.moveState(sandboxThread(saved.coreUrl) ?? ""), outOfMemory: this.outOfMemory.has(threadId), pendingDelivery: commands(this.deps.db, threadId).filter((c) => c.state === "sending").length };
  }

  async create(request: CreateThreadRequest, awaitingCore = false, fork?: { sourceThreadId: string; endSequence: number }): Promise<Thread> {
    if (request.originKind === "fork" && request.sourceThreadId && !fork) return this.createFork(request, request.sourceThreadId);
    const parentId = request.originKind || request.sourceThreadId ? undefined : request.parentThreadId;
    const parent = parentId ? getThread(this.deps.db, parentId) : null;
    // A Cloud parent's child gets a sandbox of its own with a copy of the parent's code (ADR 0229).
    const codeFrom = parent && isCloudThread(parent) ? parent.id : fork?.sourceThreadId;
    if (parent && codeFrom && request.projectId !== parent.projectId) throw new ApiError(400, "cloudroom_unsupported", "A child thread belongs to its parent's project.");
    if (parentId) assertValidParentThread(this.deps, { parentThreadId: parentId, cloudChild: Boolean(codeFrom) });
    const sandbox = await this.newThreadsInSandboxes();
    const connection = sandbox ? null : await this.connection();
    const project = getProject(this.deps.db, request.projectId);
    if (!project) throw new ApiError(404, "project_not_found", "Project not found");
    if (!isCloudProvider(request.providerId) || (!fork && (request.originKind || request.sourceThreadId)) || request.sendAt || request.pluginSubmission || (request.environment.type !== "project-default" && !codeFrom))
      throw new ApiError(400, "cloudroom_unsupported", "Cloud supports new Codex, Pi, Cursor, fx, opencode, Hermes Agent, Devin, OpenClaw and Claude Code threads in a cloud folder. Forks, scheduling and native machine targets are not supported.");
    if (request.permissionMode && request.permissionMode !== "full") throw new ApiError(400, "cloudroom_unsupported", "Cloud uses the full permission mode; restricted modes are not supported.");
    if (request.startedOnBehalfOf || request.sourceSeqEnd !== undefined) throw new ApiError(400, "cloudroom_unsupported", "Cloud continuation and delegated starts are not enabled.");
    // A new sandbox starts on first delivery, so check against the last known capabilities.
    let capabilities = sandbox ? await this.savedCapabilities() : this.lastCapabilities;
    if (!sandbox) {
      try { capabilities = await this.capabilities(await this.client()); this.lastCapabilities = capabilities; }
      catch (error) {
        if (error instanceof ApiError) throw error;
        if (!connectionFailure(error) || (error instanceof CloudroomError && error.code === "storage_blocked")) throw new ApiError(503, "cloudroom_unavailable", publicError(error));
        capabilities = null;
      }
    }
    const profile = capabilities ? harnessProfile(capabilities, request.providerId) : null;
    if (capabilities && request.serviceTier === "fast" && !profile?.service_tier) throw new ApiError(400, "cloudroom_unsupported", "Cloud fast service tier is not enabled");
    const payload = promptPayload(request.input, request.providerId, capabilities?.attachments === false ? false : profile?.attachments ?? true, cloudPromptLimit(capabilities));
    const model = request.model;
    const reasoning = request.reasoningLevel ?? "medium";
    if (!model) throw new ApiError(400, "model_required", "Select a Codex model");
    const startRequestId = request.requestId ?? randomUUID();
    const existingThread = (db: DbQueryConnection) => {
      const previous = db.select().from(cloudroomThreads).where(eq(cloudroomThreads.startRequestId, startRequestId)).get();
      if (!previous) return null;
      const initial = command(db, `first_${previous.threadId}`);
      const thread = getThread(db, previous.threadId);
      if (thread?.projectId !== request.projectId || thread?.providerId !== request.providerId || previous.model !== model || previous.reasoning !== reasoning || (initial ? JSON.parse(initial.input).text : null) !== payload.text) throw new ApiError(409, "request_conflict", "Request ID was already used with different content");
      return thread;
    };
    const previous = existingThread(this.deps.db);
    if (previous) {
      this.holdRejectedStart(previous.id);
      if (command(this.deps.db, `first_${previous.id}`)?.state === "failed" && !binding(this.deps.db, previous.id)?.sessionId) await this.retryStart(previous.id);
      else await this.deliver(previous.id);
      return getThread(this.deps.db, previous.id)!;
    }
    const remoteModel = capabilities ? coreModel(request.providerId, model, capabilities) : null;
    // A sleeping sandbox's saved catalog may predate a login (say, Cursor's key); its Core checks the model at start.
    if (capabilities && remoteModel && !(sandbox && profile?.models === null)) validateReasoning(request.providerId, remoteModel.model, reasoning, capabilities);
    const workspace = project.id === PERSONAL_PROJECT_ID ? { workspace: ROOT_WORKSPACE } : { workspace: workspaceId(project.id), workspace_name: workspaceName(project.name) };
    const providerId = request.providerId;
    const projectNote = project.id === PERSONAL_PROJECT_ID ? undefined : await localProjectNote(this.deps, project.id);
    let created = false;
    const titleInput = request.input.filter(part => part.visibility !== "agent-only");
    const thread = this.deps.db.transaction((tx) => {
      const previous = existingThread(tx);
      if (previous) return previous;
      if (parentId) assertValidParentThread(this.deps, { parentThreadId: parentId, cloudChild: Boolean(codeFrom) });
      created = true;
      const thread = createThread(tx, this.deps.hub, {
        executionTarget: "cloud", projectId: request.projectId, providerId, status: "pending", parentThreadId: parentId ?? null,
        ...(fork ? { originKind: "fork" as const, sourceThreadId: fork.sourceThreadId } : {}),
        title: request.title, titleFallback: deriveTitleFallback(titleInput), sectionId: request.sectionId, visibility: request.visibility,
        originPluginId: request.originPluginId,
        pluginMetadata: request.pluginMetadata && request.originPluginId ? { pluginId: request.originPluginId, metadata: request.pluginMetadata } : null,
      });
      tx.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: connection ? connection.url : SANDBOX_PREFIX + thread.id, startRequestId, model, reasoning }).run();
      tx.insert(cloudroomCommands).values({
        id: `first_${thread.id}`, threadId: thread.id, command: "prompt",
        input: JSON.stringify(this.snapshotInstructions(thread, "prompt", {
          ...payload, ...workspace, provider: remoteModel?.provider,
          command_guard_enabled: getAppSettings(this.deps.db).commandGuardEnabled,
          strip_ai_co_authors: getAppSettings(this.deps.db).stripAiCoAuthorsEnabled,
          system_prompt: [cloudroomSystemPrompt(this.deps.db, { vps: this.sandboxes.vpsConnected }), cloudPluginInstructions({ threadId: thread.id, projectId: thread.projectId }), projectNote].filter(Boolean).join("\n\n") || undefined,
          ...(request.serviceTier && request.serviceTier !== "default" ? { service_tier: request.serviceTier } : {}),
          ...(request.baseBranch ? { base_branch: request.baseBranch } : {}),
          ...(codeFrom ? { code_from: codeFrom } : {}),
          ...(awaitingCore || this.heldStarts.has(request.requestId ?? "") ? { awaiting_core: true } : {}),
        })),
        createdAt: Date.now(),
      }).run();
      if (!fork) {
        projectInitialPrompt(tx, thread.id);
        appendStartProgress(tx, thread.id, [cloudStep(Boolean(sandbox))], "active", true);
      }
      queueThreadTitle(tx, thread.id, titleInput);
      if (!request.title && shouldGenerateThreadTitle(titleInput)) {
        tx.insert(cloudroomCommands).values({
          id: `title_${thread.id}`, threadId: thread.id, command: "title",
          input: JSON.stringify({ input: titleInput }), createdAt: Date.now(),
        }).run();
      }
      return thread;
    });
    if (fork && created) {
      copyForkSourceHistory(this.deps, { fork: thread, history: { kind: "thread", sourceThreadId: fork.sourceThreadId, endSequence: fork.endSequence } });
      this.deps.db.transaction((tx) => {
        projectInitialPrompt(tx, thread.id);
        appendStartProgress(tx, thread.id, [cloudStep(Boolean(sandbox))], "active", true);
      });
    }
    if (created && request.cloudTarget) this.sandboxes.target(thread.id, request.cloudTarget);
    this.notify(thread.id, ["client/turn/requested", "system/thread-provisioning"]);
    void this.selectOnboardingProject(project.id).catch(() => {});
    this.start();
    void this.deliver(thread.id).catch(() => {});
    return getThread(this.deps.db, thread.id)!;
  }

  /** A Cloud fork (fork.ts): the source's harness and model in a new sandbox, with the history up to the fork point. */
  private async createFork(request: CreateThreadRequest, sourceId: string): Promise<Thread> {
    const source = getThread(this.deps.db, sourceId);
    const saved = binding(this.deps.db, sourceId);
    if (!source || source.archivedAt || source.deletedAt || (isCloudThread(source) ? !saved?.sessionId : !source.environmentId)) throw new ApiError(409, "fork_source_unavailable", "Only a started, unarchived thread can be forked.");
    if (!FORK_HARNESSES.includes(source.providerId)) throw new ApiError(400, "cloudroom_unsupported", "Cloud forks support Claude Code and Codex.");
    const last = saved ? null : getLastExecutionOptions(this.deps, source.id);
    const model = saved?.model ?? last?.model;
    if (!model) throw new ApiError(409, "fork_source_unavailable", "The source thread has no model to fork with yet.");
    if ((request.providerId && request.providerId !== source.providerId) || (request.model && request.model !== model)) throw new ApiError(400, "cloudroom_unsupported", "A Cloud fork keeps its source's harness and model.");
    if (request.sendAt || request.pluginSubmission) throw new ApiError(400, "cloudroom_unsupported", "Cloud forks can't be scheduled.");
    const startRequestId = request.requestId ?? randomUUID();
    const previous = this.deps.db.select().from(cloudroomThreads).where(eq(cloudroomThreads.startRequestId, startRequestId)).get();
    if (previous) return getThread(this.deps.db, previous.threadId)!;
    if (!(await this.newThreadsInSandboxes())) throw new ApiError(409, "cloudroom_unsupported", "Cloud forks need cloud sandboxes.");
    const capabilities = await this.savedCapabilities();
    if (capabilities && !capabilities.fork) throw new ApiError(409, "cloudroom_update", "Update the cloud core to fork Cloud threads.");
    const fork = saved ? cloudForkPoint(this.deps.db, source, request.sourceSeqEnd) : localForkPoint(this.deps, source, request.sourceSeqEnd);
    const project = getProject(this.deps.db, source.projectId);
    if (!project) throw new ApiError(404, "project_not_found", "Project not found");
    const profile = capabilities ? harnessProfile(capabilities, source.providerId) : null;
    const payload = promptPayload(request.input, source.providerId, capabilities?.attachments === false ? false : profile?.attachments ?? true, cloudPromptLimit(capabilities));
    const reasoning = request.reasoningLevel ?? (saved ? this.currentReasoning(source.id, saved) : last?.reasoningLevel ?? "none");
    const workspace = project.id === PERSONAL_PROJECT_ID ? { workspace: ROOT_WORKSPACE } : { workspace: workspaceId(project.id), workspace_name: workspaceName(project.name) };
    const projectNote = project.id === PERSONAL_PROJECT_ID ? undefined : await localProjectNote(this.deps, project.id);
    const thread = this.deps.db.transaction((tx) => {
      const thread = createThread(tx, this.deps.hub, {
        executionTarget: "cloud", projectId: source.projectId, providerId: source.providerId, status: "pending", originKind: "fork", sourceThreadId: source.id,
        title: request.title, titleFallback: deriveTitleFallback(request.input), sectionId: request.sectionId, visibility: request.visibility,
      });
      tx.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: SANDBOX_PREFIX + thread.id, startRequestId, model, reasoning }).run();
      tx.insert(cloudroomCommands).values({
        id: `first_${thread.id}`, threadId: thread.id, command: "prompt",
        input: JSON.stringify(this.snapshotInstructions(thread, "prompt", {
          ...payload, ...workspace, fork,
          command_guard_enabled: getAppSettings(this.deps.db).commandGuardEnabled,
          strip_ai_co_authors: getAppSettings(this.deps.db).stripAiCoAuthorsEnabled,
          system_prompt: [cloudroomSystemPrompt(this.deps.db, { vps: this.sandboxes.vpsConnected }), cloudPluginInstructions({ threadId: thread.id, projectId: thread.projectId }), projectNote].filter(Boolean).join("\n\n") || undefined,
          ...(request.serviceTier && request.serviceTier !== "default" ? { service_tier: request.serviceTier } : {}),
          ...(this.heldStarts.has(startRequestId) ? { awaiting_core: true } : {}),
        })),
        createdAt: Date.now(),
      }).run();
      queueThreadTitle(tx, thread.id, request.input);
      if (!request.title && shouldGenerateThreadTitle(request.input)) {
        tx.insert(cloudroomCommands).values({ id: `title_${thread.id}`, threadId: thread.id, command: "title", input: JSON.stringify({ input: request.input }), createdAt: Date.now() }).run();
      }
      return thread;
    });
    // The inherited history goes first, so the fork's first message shows after it.
    copyForkSourceHistory(this.deps, { fork: thread, history: { kind: "thread", sourceThreadId: source.id, endSequence: fork.end_sequence } });
    this.deps.db.transaction((tx) => {
      projectInitialPrompt(tx, thread.id);
      appendStartProgress(tx, thread.id, [cloudStep(true)], "active", true);
    });
    this.notify(thread.id, ["client/turn/requested", "system/thread-provisioning"]);
    this.start();
    void this.deliver(thread.id).catch(() => {});
    return getThread(this.deps.db, thread.id)!;
  }

  /** A side chat (ADR 0273): a fresh agent in a Cloud thread's sandbox and folder, like a Local one. It is only a
   *  database row here; delivery starts its session in the background. Its quoted message waits as hidden context. */
  async sideChat(source: Thread, request: ForkThreadRequest): Promise<Thread> {
    const saved = binding(this.deps.db, source.id);
    const providerId = source.providerId;
    if (!saved?.sessionId || source.archivedAt || source.deletedAt) throw new ApiError(409, "fork_source_unavailable", "Only a started, unarchived Cloud thread can have a side chat.");
    if (!isCloudProvider(providerId)) throw new ApiError(400, "cloudroom_unsupported", "This agent can't run in Cloud.");
    const known = sandboxThread(saved.coreUrl) ? await this.savedCapabilities() : this.lastCapabilities;
    if (!request.fresh || !known?.side_chat_fresh) return this.copiedSideChat(source, request);
    await this.requireOwnThread(saved);
    const thread = this.deps.db.transaction((tx) => {
      const thread = this.sideChatThread(tx, source, request);
      tx.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: saved.coreUrl, startRequestId: randomUUID(), model: saved.model, reasoning: saved.reasoning }).run();
      tx.insert(cloudroomCommands).values({ id: `first_${thread.id}`, threadId: thread.id, command: "side_chat", state: "completed", input: JSON.stringify({ side_chat: saved.sessionId }), createdAt: Date.now() }).run();
      return thread;
    });
    this.seedSideChat(thread.id, source.id, request, saved);
    this.notify(thread.id);
    this.start();
    void this.deliver(thread.id).catch(() => {});
    return getThread(this.deps.db, thread.id)!;
  }

  private sideChatThread(tx: DbTransaction, source: Thread, request: ForkThreadRequest) {
    return createThread(tx, this.deps.hub, {
      executionTarget: "cloud", projectId: source.projectId, providerId: source.providerId, status: "starting", originKind: "fork", sourceThreadId: source.id,
      title: request.title ?? null, titleFallback: source.title ?? source.titleFallback, visibility: request.visibility, originPluginId: request.originPluginId,
      pluginMetadata: request.pluginMetadata && request.originPluginId ? { pluginId: request.originPluginId, metadata: request.pluginMetadata } : null,
    });
  }

  private seedSideChat(threadId: string, sourceId: string, request: ForkThreadRequest, saved: Binding): void {
    if (request.agentContextSeed) appendClientTurnEvent(this.deps, {
      type: "client/turn/requested", threadId, environmentId: null, input: request.agentContextSeed, initiator: "agent", senderThreadId: sourceId,
      requestMethod: "thread/start", source: "spawn", target: { kind: "thread-start" },
      execution: { source: "client/turn/requested", model: saved.model, reasoningLevel: reasoningLevelSchema.parse(saved.reasoning), permissionMode: "full", serviceTier: "default" },
    });
  }

  /** A side chat on a sandbox whose Core predates fresh ones (ADR 0189): a copy of the conversation. */
  private async copiedSideChat(source: Thread, request: ForkThreadRequest): Promise<Thread> {
    const saved = binding(this.deps.db, source.id)!;
    const providerId = source.providerId;
    if (!isCloudProvider(providerId) || !FORK_HARNESSES.includes(providerId) || !saved.sessionId) throw new ApiError(409, "cloudroom_update", "This Cloud thread's sandbox runs an older Cloudroom version. Side chats for this agent work after its next restart.");
    const client = await this.client(saved);
    const capabilities = await this.capabilities(client);
    if (!capabilities.side_chat) throw new ApiError(409, "cloudroom_update", "This Cloud thread's sandbox runs an older Cloudroom version. Side chats work after its next restart.");
    const { end_sequence, before, last_turn_id } = cloudForkPoint(this.deps.db, source, request.sourceSeqEnd);
    const startRequestId = randomUUID();
    let sessionId: string;
    try {
      sessionId = (await client.start(startRequestId, CLOUD_HARNESSES[providerId], { fork: { session: saved.sessionId, before, last_turn_id } })).session_id;
    } catch (error) {
      throw new ApiError(error instanceof CloudroomError && error.status === 409 ? 409 : 503, "cloudroom_fork_rejected", publicError(error));
    }
    const thread = this.deps.db.transaction((tx) => {
      const thread = this.sideChatThread(tx, source, request);
      tx.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: saved.coreUrl, sessionId, startRequestId, model: saved.model, reasoning: saved.reasoning }).run();
      return thread;
    });
    copyForkSourceHistory(this.deps, { fork: thread, history: { kind: "thread", sourceThreadId: source.id, endSequence: end_sequence } });
    this.seedSideChat(thread.id, source.id, request, saved);
    this.follow(binding(this.deps.db, thread.id)!, client);
    return getThread(this.deps.db, thread.id)!;
  }

  /** A fresh side chat's session; a Core that predates `fresh` rejects the field, and copies the conversation instead. */
  private async startSideChat(client: CloudroomClient, threadId: string, requestId: string, harness: CloudProvider, session: string) {
    const accepted = await client.start(requestId, CLOUD_HARNESSES[harness], { fork: { session, fresh: true } }).catch((error: unknown) => {
      const source = getThread(this.deps.db, getThread(this.deps.db, threadId)?.sourceThreadId ?? "");
      if (!source || !(error instanceof CloudroomError && (error.status === 400 || error.status === 422))) throw error;
      const { before, last_turn_id } = cloudForkPoint(this.deps.db, source, undefined);
      return client.start(requestId, CLOUD_HARNESSES[harness], { fork: { session, before, last_turn_id } });
    });
    return { sessionId: accepted.session_id, transfer: `child_${requestId}`, code: null };
  }

  /** ADR 0211: a new Core session in the old session's folder. `prepare` runs once the old session is idle and caught up. */
  async switchHarness(thread: Thread, target: { providerId: string; model: string; reasoningLevel: ReasoningLevel | null }, prepare: () => Promise<(tx: DbTransaction) => void>): Promise<void> {
    await this.restartSession(thread, { ...target, refusal: "Agents started by another agent keep their agent." }, prepare, (tx, started) => {
      updateThread(tx, this.deps.hub, thread.id, { providerId: target.providerId });
      saveBinding(tx, thread.id, { ...started, model: target.model, cursor: 0, nativeId: null, turnId: null, error: null });
      setThreadExecutionOverride(tx, { threadId: thread.id, modelOverride: null, reasoningLevelOverride: target.reasoningLevel });
    });
  }

  /** ADR 0281: a new Core session in the new project's folder, in the same sandbox. The old folder stays as it is. */
  async moveProject(thread: Thread, projectId: string, prepare: () => Promise<(tx: DbTransaction) => void>): Promise<string | null> {
    const saved = binding(this.deps.db, thread.id);
    const project = getProject(this.deps.db, projectId);
    if (!saved || !project) throw new ApiError(404, "project_not_found", "Project not found");
    const workspace = project.id === PERSONAL_PROJECT_ID ? { workspace: ROOT_WORKSPACE } : { workspace: workspaceId(project.id), workspace_name: workspaceName(project.name) };
    const client = await this.client(saved);
    const previousPath = saved.sessionId ? await client.sessionWorkspace(saved.sessionId).then(({ path }) => path, () => null) : null;
    await this.restartSession(thread, { providerId: thread.providerId, model: saved.model, reasoningLevel: null, workspace, refusal: "Agents started by another agent stay in its project." }, prepare, (tx, started) => {
      updateThread(tx, this.deps.hub, thread.id, { projectId: project.id });
      saveBinding(tx, thread.id, { ...started, cursor: 0, nativeId: null, turnId: null, error: null });
      const first = command(tx, `first_${thread.id}`);
      if (first) tx.update(cloudroomCommands).set({ input: JSON.stringify({ ...JSON.parse(first.input), ...workspace, base_branch: undefined }) }).where(eq(cloudroomCommands.id, first.id)).run();
    });
    if (workspace.workspace === ROOT_WORKSPACE) return previousPath;
    const moved = binding(this.deps.db, thread.id)!;
    const sandbox = sandboxThread(moved.coreUrl);
    const job = await planProjectCopy(this.deps, client, thread.id, workspace.workspace, { key: copyKey(sandbox, workspace.workspace) });
    if (job) this.copyInto(client, job, () => void this.ensureBranch(thread.id, true));
    else void this.ensureBranch(thread.id, true);
    return previousPath;
  }

  private async restartSession(thread: Thread, target: { providerId: string; model: string; reasoningLevel: ReasoningLevel | null; workspace?: { workspace: string; workspace_name?: string }; refusal: string }, prepare: () => Promise<(tx: DbTransaction) => void>, apply: (tx: DbTransaction, started: { sessionId: string; startRequestId: string; reasoning: string }) => void): Promise<void> {
    if (this.switching.has(thread.id) || this.sends.has(thread.id)) throw new ApiError(409, "thread_busy", "Wait until the message is sent, then switch.");
    this.switching.add(thread.id);
    try {
      const saved = binding(this.deps.db, thread.id);
      if (!saved?.sessionId) throw new ApiError(409, "cloudroom_not_started", "Wait for the cloud agent to start, then switch.");
      await this.requireOwnThread(saved);
      if (teleportBlocked(this.deps.db, thread.id)) throw new ApiError(409, "teleport_in_progress", "Wait for Teleport to finish, then switch.");
      if (!isCloudProvider(target.providerId)) throw new ApiError(400, "cloudroom_unsupported", "This agent can't run in Cloud.");
      const oldSession = saved.sessionId;
      await this.requireNoSessionDependents(thread.id, saved);
      const client = await this.client(saved);
      const capabilities = await this.capabilities(client);
      if (!harnessProfile(capabilities, target.providerId)) throw new ApiError(400, "cloudroom_unsupported", `${HARNESS_NAMES[target.providerId]} isn't set up in Cloud yet.`);
      const reasoning = target.reasoningLevel ?? saved.reasoning;
      const { model, provider } = coreModel(target.providerId, target.model, capabilities);
      validateReasoning(target.providerId, model, reasoning, capabilities);
      const before = await this.quietSession(client, saved);
      const start = Object.values(before.receipts).find((receipt) => receipt.command === "start");
      if (!start?.workspace) throw new ApiError(409, "cloudroom_switch", "This thread's cloud folder is unknown, so it can't switch.");
      const startInput = z.object({ parent_session: z.string().nullish(), parent_thread: z.string().nullish(), command_guard_enabled: z.boolean().nullish(), strip_ai_co_authors: z.boolean().nullish(), system_prompt: z.string().nullish() }).passthrough().parse(start.input);
      if (startInput.parent_session) throw new ApiError(409, "cloudroom_switch", target.refusal);
      const workspace = target.workspace ?? (start.workspace.id !== "legacy" ? { workspace: start.workspace.id } : start.workspace.path === capabilities.repository ? {} : { workspace: ROOT_WORKSPACE });
      if (target.providerId === "codex" && capabilities.codex_auth_import && !sandboxThread(saved.coreUrl)) await importCodexLogin(this.deps);
      if (target.providerId === "pi") await this.copyPiSetup(client, Boolean(sandboxThread(saved.coreUrl)));
      const record = await prepare();
      const startRequestId = randomUUID();
      const started = await client.start(startRequestId, CLOUD_HARNESSES[target.providerId], {
        model, reasoning, ...(provider ? { provider } : {}), ...workspace,
        ...(capabilities.command_guard && typeof startInput.command_guard_enabled === "boolean" ? { command_guard_enabled: startInput.command_guard_enabled } : {}),
        ...(capabilities.strip_ai_co_authors && typeof startInput.strip_ai_co_authors === "boolean" ? { strip_ai_co_authors: startInput.strip_ai_co_authors } : {}),
        ...(capabilities.system_prompt && startInput.system_prompt ? { system_prompt: startInput.system_prompt } : {}),
        ...(startInput.parent_thread ? { parent_thread: startInput.parent_thread } : {}),
      });
      const after = await client.session(oldSession).catch(() => null);
      if (after?.last_sequence !== before.last_sequence || !["idle", "error"].includes(getThread(this.deps.db, thread.id)?.status ?? "")) {
        void client.close(started.session_id, randomUUID()).catch(() => {});
        throw new ApiError(409, "thread_busy", "The agent got a new message while switching. Try again.");
      }
      this.detach(thread.id);
      this.deps.db.transaction((tx) => {
        apply(tx, { sessionId: started.session_id, startRequestId, reasoning });
        record(tx);
      });
      void client.close(oldSession, randomUUID()).catch((error: unknown) => this.warn("The previous Cloud session could not be closed", error, { threadId: thread.id }));
    } finally {
      this.switching.delete(thread.id);
    }
    this.notify(thread.id);
    void this.deliver(thread.id).catch(() => {});
  }

  /** Running child agents and Cloud automations stay tied to the old session, which a switch closes. */
  private async requireNoSessionDependents(threadId: string, saved: Binding): Promise<void> {
    const runningChild = this.deps.db.select({ id: threads.id }).from(threads).where(and(eq(threads.parentThreadId, threadId), isNull(threads.archivedAt), isNull(threads.deletedAt), notInArray(threads.status, ["idle", "error"]))).get();
    if (runningChild) throw new ApiError(409, "thread_busy", "Wait until this thread's child agents finish, then switch.");
    const sandbox = sandboxThread(saved.coreUrl);
    if (!sandbox) return;
    const listed = z.object({ automations: z.array(z.object({ session_id: z.string().nullable(), enabled: z.boolean() }).passthrough()) }).safeParse(await this.sandboxes.automations({ action: "list", thread: sandbox }).catch(() => null));
    if (!listed.success) throw new ApiError(503, "cloudroom_switch", "Couldn't check this thread's loops. Try again in a moment.");
    if (listed.data.automations.some((automation) => automation.enabled && automation.session_id === saved.sessionId)) throw new ApiError(409, "cloudroom_switch", "This thread has a Cloud loop. Pause or delete it, then switch.");
  }

  /** The old session must be idle, with nothing queued, and fully shown here, so the new agent's history is complete. */
  private async quietSession(client: CloudroomClient, saved: Binding) {
    this.follow(saved, client);
    for (let attempt = 0; ; attempt++) {
      const session = await client.session(saved.sessionId!);
      const caughtUp = (binding(this.deps.db, saved.threadId)?.cursor ?? 0) >= session.last_sequence && !["pending", "waiting_for_files", "starting", "resuming"].includes(session.state);
      const busy = ["starting_turn", "running", "interrupting"].includes(session.state) || session.current_request !== null || session.queue.length > 0 || commands(this.deps.db, saved.threadId).some((c) => c.state === "sending");
      if (busy) throw new ApiError(409, "thread_busy", "Wait until the agent and its queued messages finish, then switch.");
      if (caughtUp) return session;
      if (attempt >= 20) throw new ApiError(503, "cloudroom_switch", "This thread is still syncing with the cloud. Try again in a moment.");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async send(thread: Thread, payload: SendMessageRequest): Promise<SendMessageResponse> {
    if (this.switching.has(thread.id)) throw new ApiError(409, "thread_busy", "This thread is switching agents. Send again in a moment.");
    this.sends.set(thread.id, (this.sends.get(thread.id) ?? 0) + 1);
    try { return await this.sendNow(thread, payload); }
    finally {
      const left = (this.sends.get(thread.id) ?? 1) - 1;
      if (left > 0) this.sends.set(thread.id, left); else this.sends.delete(thread.id);
    }
  }

  private async sendNow(thread: Thread, payload: SendMessageRequest): Promise<SendMessageResponse> {
    if (teleportBlocked(this.deps.db, thread.id)) throw new ApiError(409, "teleport_in_progress", "Messages are disabled until Teleport finishes.");
    const saved = binding(this.deps.db, thread.id);
    if (!saved) throw new ApiError(409, "cloudroom_missing_binding", "Cloud thread has no core binding; native execution is blocked");
    await this.requireOwnThread(saved);
    if (!saved.sessionId && command(this.deps.db, `first_${thread.id}`)?.state === "failed") throw new ApiError(409, "cloudroom_start_failed", "Retry the rejected cloud start before sending more messages. Your original prompt is saved.");
    if (thread.archivedAt || thread.deletedAt) throw new ApiError(409, "thread_not_writable", "Thread is archived or deleted");
    if (payload.sendAt || payload.pluginSubmission) throw new ApiError(409, "cloudroom_unsupported", "Cloud follow-ups use the core queue. Scheduling is not enabled.");
    if (isStandaloneBuiltinCompactCommand(payload.input)) {
      await this.compact(thread);
      return { ok: true, delivery: "sent" };
    }
    if (payload.model && payload.model !== saved.model) throw new ApiError(409, "cloudroom_launch_settings", "This thread's model just changed. Send your message again.");
    const id = payload.requestId ?? randomUUID();
    const steer = (payload.mode === "steer" || payload.mode === "steer-if-active") && thread.status === "active" && saved.turnId && !unstartedTurn(this.deps.db, thread.id);
    const previous = command(this.deps.db, id);
    // A side chat's first message carries its quoted message, as on Local; a retry repeats what was sent.
    const seed = steer ? [] : previous?.command === "prompt"
      ? getLeadingAgentOnlyInput(z.array(promptInputSchema).catch([]).parse(JSON.parse(previous.input).content))
      : resolveDeferredFirstTurnContext(this.deps.db, thread.id)?.input ?? [];
    if (seed.length && payload.input[0]?.visibility !== "agent-only") payload = { ...payload, input: [...seed, ...payload.input] };
    const reasoning = payload.reasoningLevel ?? (previous
      ? commandReasoning(previous.input) ?? saved.reasoning
      : this.currentReasoning(thread.id, saved));
    const live = () => this.liveCapabilities(saved);
    const starting = !saved.sessionId && ["pending", "starting"].includes(thread.status);
    const fast = starting || (saved.sessionId && !saved.queuePaused && ["idle", "error", "active"].includes(thread.status));
    const known = fast ? sandboxThread(saved.coreUrl) ? await this.savedCapabilities() : this.lastCapabilities : null;
    const validated = steer || previous ? null : reasoning;
    let parsed: ReturnType<typeof promptPayload>;
    try { parsed = followUpPayload(thread.providerId, saved, payload, validated, known ?? await live()); }
    catch (error) {
      if (!known || !(error instanceof ApiError)) throw error;
      parsed = followUpPayload(thread.providerId, saved, payload, validated, await live());
    }
    if (steer) {
      this.enqueue(thread.id, id, "steer", { target_request_id: saved.turnId, text: parsed.text, content: parsed.content });
      await this.deliver(thread.id);
      return { ok: true, delivery: "sent" };
    }
    const stored = {
      ...parsed,
      ...(reasoning !== saved.reasoning ? { reasoning } : {}),
      ...(payload.serviceTier && payload.serviceTier !== "default" ? { service_tier: payload.serviceTier } : {}),
    };
    if (previous) {
      if (!sameStoredPrompt(previous, thread.id, stored, reasoning, saved.reasoning)) throw new ApiError(409, "request_conflict", "Request ID was already used with different content");
    } else {
      const jumpQueue = saved.queuePaused && this.queue(thread.id).length > 0 && feature(await live(), "queue_reorder");
      this.enqueue(thread.id, id, "prompt", stored);
      if (jumpQueue) this.enqueue(thread.id, randomUUID(), "reorder", { order: [id] });
      if (saved.queuePaused) this.enqueue(thread.id, randomUUID(), "resume", {});
      const sticky = getThreadExecutionOverride(this.deps.db, thread.id)?.reasoningLevelOverride;
      if (payload.reasoningLevel && sticky && sticky !== payload.reasoningLevel) setThreadExecutionOverride(this.deps.db, { threadId: thread.id, reasoningLevelOverride: payload.reasoningLevel });
      if (this.deps.db.transaction(tx => projectFollowUp(tx, thread.id, id))) this.notify(thread.id, ["client/turn/requested"]);
    }
    const delivery = this.deliver(thread.id);
    const shown = this.queue(thread.id).find((item) => item.id === id);
    if (shown || (thread.status !== "error" && (!previous || binding(this.deps.db, thread.id)?.turnId === id))) {
      void delivery.catch(() => {});
      return shown ? { ok: true, delivery: "queued", queuedMessage: shown } : { ok: true, delivery: "sent" };
    }
    await delivery;
    const state = command(this.deps.db, id)?.state;
    if (state && ["failed", "unknown", "unknown_after_restart"].includes(state)) throw new ApiError(409, "cloudroom_command_failed", "The core reports failed or uncertain execution. Check the conversation before submitting again.");
    const queued = this.queue(thread.id).find((item) => item.id === id);
    return queued ? { ok: true, delivery: "queued", queuedMessage: queued } : { ok: true, delivery: "sent" };
  }

  async control(threadId: string, action: "stop" | "resume"): Promise<void> {
    const saved = binding(this.deps.db, threadId);
    if (!saved) throw new ApiError(409, "cloudroom_missing_binding", "Cloud session is unavailable");
    if (action === "stop" && getThread(this.deps.db, threadId)?.archivedAt) return;
    const wake = action === "resume" || commands(this.deps.db, threadId).some(c => c.state === "sending") || (!saved.queuePaused && queuedPrompts(this.deps.db, threadId).length > 0);
    try { await this.client(saved, wake, undefined, true); }
    catch (error) {
      if (error instanceof SandboxAsleep) return this.asleep(threadId);
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, error instanceof CloudroomError ? error.code ?? "cloudroom_unavailable" : "cloudroom_unavailable", publicError(error));
    }
    this.enqueue(threadId, randomUUID(), action, {});
    await this.deliver(threadId);
  }

  archive(threadId: string): void {
    const saved = binding(this.deps.db, threadId);
    if (!saved) return;
    const sandbox = sandboxThread(saved.coreUrl);
    if (sandbox) {
      // Archive always wins (ADR 0112): the website stops the sandbox even mid-task, once no other thread runs in it.
      this.detach(threadId);
      if (["active", "stopping"].includes(getThread(this.deps.db, threadId)?.status ?? "")) saveStatus(this.deps.db, threadId, "idle");
      if (!coreInUse(this.deps.db, saved.coreUrl)) void this.sandboxes.archive(sandbox).catch(error => this.warn("The thread's sandbox could not be archived; it sleeps on its own", error, { threadId }));
      // Cloud automations (ADR 0212) stop prompting it. A child shares its parent's sandbox, which stays open.
      if (saved.sessionId) void this.sandboxes.automations({ action: "archived", thread: sandbox, session: saved.sessionId }).catch(error => this.warn("The thread's cloud automations could not be paused", error, { threadId }));
      return;
    }
    this.enqueue(threadId, randomUUID(), "stop", {});
    this.enqueue(threadId, randomUUID(), "sleep", {});
    void this.deliver(threadId).catch(() => {});
  }

  /** Delete: the website erases the thread's own sandbox, snapshots, saved copy, and chat history. Children share it. */
  remove(threadId: string): void {
    const saved = binding(this.deps.db, threadId);
    if (!saved) return;
    this.detach(threadId);
    const sandbox = sandboxThread(saved.coreUrl);
    if (sandbox === threadId) void this.sandboxes.remove(sandbox).catch(error => this.warn("The thread's sandbox could not be deleted; it sleeps on its own", error, { threadId }));
  }

  /** Each sandbox works on its own branch, named after the thread: room/<name>-<id> (docs/scopes/sandboxes.md).
   *  `create` switches a fresh checkout to it; later calls only rename it to match a new title, before its first push. */
  private async ensureBranch(threadId: string, create: boolean): Promise<void> {
    const saved = binding(this.deps.db, threadId);
    const thread = getThread(this.deps.db, threadId);
    if (!saved?.sessionId || !thread || sandboxThread(saved.coreUrl) !== threadId) return;
    const name = buildSuggestedBranchName({ branchPrefix: "room/", title: thread.title ?? thread.titleFallback ?? null, threadId });
    try {
      const client = await this.client(saved, false);
      const workspace = await client.sessionWorkspace(saved.sessionId);
      if (create) this.progress(threadId, [{ key: "workspace", text: `Using workspace: ${workspace.path}`, status: "completed" }]);
      if (!workspace.head) return;
      const quoted = `'${name}'`;
      // A warm project snapshot skips the clone, so switch to the chosen base branch here.
      const base = baseBranch(command(this.deps.db, `first_${threadId}`)?.input);
      const switchBase = base ? `[ "$current" = '${base}' ] || { git fetch -q origin '${base}' && git checkout -q -B '${base}' 'origin/${base}'; } 2>/dev/null; ` : "";
      const script = create
        ? `current=$(git symbolic-ref --quiet --short HEAD) || exit 0; case "$current" in room/*|cloudroom/*) ;; *) ${switchBase}git pull -q --ff-only 2>/dev/null; git checkout -q -b ${quoted} ;; esac`
        : `current=$(git symbolic-ref --quiet --short HEAD) || exit 0; case "$current" in room/*|cloudroom/*) [ "$current" = ${quoted} ] || git rev-parse -q --verify "$current@{upstream}" >/dev/null || git branch -m ${quoted} ;; esac`;
      const result = await client.runOnVm({ command: `${script}\ngit symbolic-ref --quiet --short HEAD`, cwd: workspace.path });
      const branch = Buffer.from(result.stdout, "hex").toString().trim().split("\n").at(-1);
      if (branch) this.progress(threadId, [{ key: "branch", text: `Using branch: ${branch}`, status: "completed" }]);
    } catch { /* A missing branch never blocks the agent; the next title change retries. */ }
  }

  /** Restores the sandbox the thread runs in, which may be another thread's: an unarchived child keeps its parent's. */
  async restore(threadId: string): Promise<void> {
    const sandbox = sandboxThread(binding(this.deps.db, threadId)?.coreUrl ?? "");
    if (sandbox) await this.sandboxes.restore(sandbox);
  }

  private snapshotInstructions(thread: Pick<Thread, "id" | "projectId">, action: Command["command"], input: object): object {
    if (!["prompt", "edit", "steer", "rewind"].includes(action)) return input;
    const prompt = z.object({ text: z.string(), content: z.unknown().optional() }).parse(
      action === "rewind" && "replacement" in input ? input.replacement : input,
    );
    const customInstructions = resolveCustomInstructions({ threadId: thread.id, projectId: thread.projectId });
    // The core's real limit is checked again on send.
    prepareCloudInstructionInput(prompt, customInstructions, cloudPromptLimit(null));
    return { ...input, customInstructions };
  }

  private enqueue(threadId: string, id: string, action: Command["command"], input: object, at?: number): void {
    const previous = command(this.deps.db, id);
    if (previous) {
      const { customInstructions: _instructions, workspaceContext: _workspace, ...original } = JSON.parse(previous.input);
      if (previous.threadId !== threadId || previous.command !== action || JSON.stringify(original) !== JSON.stringify(input)) throw new ApiError(409, "request_conflict", "Request ID was already used with different content");
      return;
    }
    const thread = getThread(this.deps.db, threadId);
    if (!thread || !binding(this.deps.db, threadId)) throw new ApiError(409, "cloudroom_missing_binding", "Cloud session is unavailable");
    const createdAt = at ?? Math.max(Date.now(), (commands(this.deps.db, threadId).at(-1)?.createdAt ?? 0) + 1);
    this.deps.db.insert(cloudroomCommands).values({ id, threadId, command: action, input: JSON.stringify(this.snapshotInstructions(thread, action, input)), createdAt }).run();
    this.notify(threadId);
  }

  private async uploadAttachments(
    client: CloudroomClient,
    sessionId: string,
    promptId: string,
    attachments: { name: string; kind: "image" | "file"; localPath?: string; path?: string; id?: string }[],
    projectId: string,
    parts: boolean,
  ) {
    const uploaded = [];
    for (const [index, attachment] of attachments.entries()) {
      if (attachment.path) {
        uploaded.push({ id: attachment.id, name: attachment.name, kind: attachment.kind, path: attachment.path });
        continue;
      }
      if (!attachment.localPath) continue;
      const root = join(this.deps.config.dataDir, "attachments", projectId);
      const candidate = attachment.localPath.startsWith("/") ? attachment.localPath : join(root, attachment.localPath);
      const bytes = await readFile(candidate);
      const attachmentId = `${promptId}a${index}`;
      const id = attachmentId.length <= 64 ? attachmentId : createHash("sha256").update(attachmentId).digest("hex");
      const name = attachment.name.replace(/[^a-zA-Z0-9._-]+/g, "-") || "attachment";
      // Cores with upload_parts take files in pieces small enough for every sandbox proxy.
      const accepted = parts
        ? await client.attachInParts(sessionId, id, name, attachment.kind, bytes)
        : await client.attach(sessionId, id, name, attachment.kind, { body: new Blob([bytes]).stream(), length: bytes.byteLength });
      const input = accepted.receipt.input as { id?: string; path?: string };
      uploaded.push({
        id: input.id ?? accepted.receipt.request_id,
        name: attachment.name,
        kind: attachment.kind,
        path: String(input.path ?? ""),
      });
    }
    return uploaded;
  }

  async queueMessage(thread: Thread, payload: SendMessageRequest) {
    if (teleportBlocked(this.deps.db, thread.id)) throw new ApiError(409, "teleport_in_progress", "Messages are disabled until Teleport finishes.");
    const id = payload.requestId ?? randomUUID();
    await this.send(thread, { ...payload, requestId: id });
    return this.queuedMessage(binding(this.deps.db, thread.id)!, command(this.deps.db, id)!);
  }

  queue(threadId: string) {
    const saved = binding(this.deps.db, threadId);
    if (!saved) return [];
    return queuedPrompts(this.deps.db, threadId).map((c) => this.queuedMessage(saved, c));
  }

  private queuedMessage(saved: Binding, c: Command) {
    const stored = effectivePrompt(this.deps.db, saved.threadId, c.id, true) as { text?: string; content?: PromptInput[]; revision?: number; service_tier?: string };
    const revision = stored.revision ?? 1;
    const capabilities = sandboxThread(saved.coreUrl) ? this.sandboxCapabilities : this.lastCapabilities;
    return threadQueuedMessageSchema.parse({
      id: c.id, threadId: saved.threadId, initiator: "user", senderThreadId: null,
      content: Array.isArray(stored.content) ? stored.content : [{ type: "text", text: stored.text ?? "", mentions: [] }],
      model: saved.model, reasoningLevel: commandReasoning(c.input) ?? saved.reasoning, permissionMode: "full",
      serviceTier: stored.service_tier === "fast" ? "fast" : "default",
      sendAt: null, waitingOn: null, failureReason: null, payload: { kind: "inline" }, editable: (c.state === "sending" || c.state === "accepted") && capabilities?.queue_edit === true,
      createdAt: c.createdAt, updatedAt: c.createdAt + revision - 1,
    });
  }

  async editQueued(thread: Thread, queuedMessageId: string, payload: { input: PromptInput[]; expectedUpdatedAt: number }) {
    const saved = binding(this.deps.db, thread.id);
    const current = command(this.deps.db, queuedMessageId);
    if (!saved || !current || current.threadId !== thread.id || current.command !== "prompt" || (current.state !== "sending" && current.state !== "accepted")) {
      throw new ApiError(404, "invalid_request", "Queued message not found");
    }
    const capabilities = await this.queueCapabilities(saved);
    if (!feature(capabilities, "queue_edit")) throw new ApiError(409, "cloudroom_unsupported", "Cloud queue editing is not enabled.");
    const stored = effectivePrompt(this.deps.db, thread.id, current.id, true);
    const revision = Number(stored.revision ?? 1);
    const expectedRevision = payload.expectedUpdatedAt - current.createdAt + 1;
    const parsed = promptPayload(payload.input, thread.providerId, capabilities.attachments && (harnessProfile(capabilities, thread.providerId)?.attachments ?? true), cloudPromptLimit(capabilities));
    const input = { target_request_id: queuedMessageId, expected_revision: expectedRevision, ...parsed,
      reasoning: stored.reasoning ?? saved.reasoning, service_tier: stored.service_tier ?? "default" };
    const id = `qe_${createHash("sha256").update(JSON.stringify([thread.id, input])).digest("hex").slice(0, 60)}`;
    const previous = command(this.deps.db, id);
    if (expectedRevision !== revision && !previous) throw new ApiError(409, "invalid_request", "Queued message changed since editing began");
    this.enqueue(thread.id, id, "edit", input);
    const delivery = this.deliver(thread.id);
    if (current.state === "accepted") await delivery;
    else void delivery.catch(() => {});
    const outcome = command(this.deps.db, id)?.state;
    if (outcome !== "accepted" && outcome !== "completed" && !(outcome === "sending" && current.state === "sending")) throw new ApiError(409, "cloudroom_command_failed", "The queue edit was not confirmed. Refresh the queue before retrying.");
    return this.queuedMessage(binding(this.deps.db, thread.id)!, command(this.deps.db, queuedMessageId)!);
  }

  async cancelQueued(thread: Thread, queuedMessageId: string) {
    const saved = binding(this.deps.db, thread.id);
    const current = command(this.deps.db, queuedMessageId);
    if (!saved || !current || current.threadId !== thread.id) throw new ApiError(404, "invalid_request", "Queued message not found");
    if (!feature(await this.queueCapabilities(saved), "queue_cancel")) throw new ApiError(409, "cloudroom_unsupported", "Cloud queue cancellation is not enabled.");
    const id = randomUUID();
    this.enqueue(thread.id, id, "cancel", { target_request_id: queuedMessageId });
    await this.deliver(thread.id);
    if (command(this.deps.db, id)?.state === "failed") throw new ApiError(409, "queued_message_started", "Too late: the agent already started this message.");
  }

  async reorderQueued(thread: Thread, request: { queuedMessageId: string; previousQueuedMessageId: string | null; nextQueuedMessageId: string | null }) {
    const saved = binding(this.deps.db, thread.id);
    const queue = this.queue(thread.id);
    if (!saved || !queue.some((item) => item.id === request.queuedMessageId)) throw new ApiError(404, "invalid_request", "Queued message not found");
    const capabilities = await this.queueCapabilities(saved);
    if (!feature(capabilities, "queue_reorder")) throw new ApiError(409, "cloudroom_unsupported", "Update the cloud core to reorder queued messages.");
    const order = queue.map((item) => item.id).filter((id) => id !== request.queuedMessageId);
    const neighbor = request.previousQueuedMessageId ?? request.nextQueuedMessageId;
    if (neighbor !== null && !order.includes(neighbor)) throw new ApiError(409, "invalid_request", "Queued message order changed");
    order.splice(request.previousQueuedMessageId !== null ? order.indexOf(request.previousQueuedMessageId) + 1 : request.nextQueuedMessageId !== null ? order.indexOf(request.nextQueuedMessageId) : 0, 0, request.queuedMessageId);
    if (order.every((id, index) => id === queue[index]!.id)) return queue;
    const id = randomUUID();
    this.enqueue(thread.id, id, "reorder", { order });
    await this.deliver(thread.id);
    const outcome = command(this.deps.db, id)?.state;
    if (outcome !== "accepted" && outcome !== "completed") throw new ApiError(409, "cloudroom_command_failed", "The queue reorder was not confirmed. Refresh the queue before retrying.");
    return this.queue(thread.id);
  }

  async sendQueued(thread: Thread, queuedMessageId: string): Promise<SendMessageResponse> {
    const saved = binding(this.deps.db, thread.id);
    const queue = this.queue(thread.id);
    const queued = queue.find((item) => item.id === queuedMessageId);
    if (!saved || !queued) throw new ApiError(404, "invalid_request", "Queued message not found");
    const active = thread.status === "active" && saved.turnId !== null && !unstartedTurn(this.deps.db, thread.id);
    if (active && queued.content.every((part) => part.type === "text")) {
      const capabilities = await this.queueCapabilities(saved);
      if (feature(capabilities, "steer") && feature(capabilities, "queue_cancel") && harnessProfile(capabilities, thread.providerId)?.steer !== false) {
        await this.send(thread, { mode: "steer", input: queued.content });
        await this.cancelQueued(thread, queuedMessageId).catch(() => {});
        return { ok: true, delivery: "sent" };
      }
    }
    if (queue[0]!.id !== queuedMessageId) throw new ApiError(409, "invalid_request", "This Cloud agent sends queued messages in order. Send or delete the earlier messages first.");
    if (active) await this.control(thread.id, "stop");
    await this.control(thread.id, "resume");
    return { ok: true, delivery: "queued", queuedMessage: queued };
  }

  async compact(thread: Thread) {
    const saved = binding(this.deps.db, thread.id);
    if (!saved?.sessionId) throw new ApiError(409, "cloudroom_missing_binding", "Cloud session is unavailable");
    const capabilities = await this.capabilities(await this.client(saved));
    if (!feature(capabilities, "compact") || harnessProfile(capabilities, thread.providerId)?.compact === false) throw new ApiError(409, "cloudroom_unsupported", "Cloud compaction is not enabled for this harness.");
    if (thread.status !== "idle" && thread.status !== "error") throw new ApiError(409, "invalid_request", "Context can only be compacted while the thread is idle or errored");
    this.enqueue(thread.id, randomUUID(), "compact", {});
    await this.deliverWhenAwake(thread.id);
  }

  /** Goal controls work the same as Local (ADR 0137): pause, resume, replace the objective, or clear. */
  async goal(thread: Thread, goal: { status?: "active" | "paused"; objective?: string; clear?: boolean }) {
    const saved = binding(this.deps.db, thread.id);
    if (!saved?.sessionId) throw new ApiError(409, "cloudroom_missing_binding", "Cloud session is unavailable");
    const capabilities = await this.capabilities(await this.client(saved));
    if (!feature(capabilities, "goal") || harnessProfile(capabilities, thread.providerId)?.goal !== true) {
      throw new ApiError(409, "cloudroom_unsupported", `Cloud Goal controls need a Codex thread and an updated cloud core (this thread runs ${thread.providerId}).`);
    }
    this.enqueue(thread.id, randomUUID(), "goal", goal);
    await this.deliverWhenAwake(thread.id);
  }

  async editMessage(thread: Thread, payload: EditMessageRequest): Promise<EditMessageResponse> {
    const saved = binding(this.deps.db, thread.id);
    if (!saved?.sessionId) throw new ApiError(409, "cloudroom_missing_binding", "Cloud session is unavailable");
    const capabilities = await this.capabilities(await this.client(saved));
    if (!feature(capabilities, "rewind") || harnessProfile(capabilities, thread.providerId)?.rewind === false) throw new ApiError(409, "cloudroom_unsupported", "Cloud message editing is not enabled for this harness.");
    const parsed = promptPayload(payload.input, thread.providerId, capabilities.attachments && (harnessProfile(capabilities, thread.providerId)?.attachments ?? true), cloudPromptLimit(capabilities));
    const rewindId = `rewind_${payload.operationId}`;
    const promptId = `edit_${payload.operationId}`;
    const replacement = { request_id: promptId, ...parsed, reasoning: payload.reasoningLevel ?? saved.reasoning, service_tier: payload.serviceTier ?? "default" };
    const previous = command(this.deps.db, rewindId);
    if (previous) {
      const original = JSON.parse(previous.input);
      if (previous.threadId !== thread.id || original.expected_request_sequence !== payload.expectedRequestSequence || JSON.stringify(original.replacement) !== JSON.stringify(replacement)) throw new ApiError(409, "request_conflict", "This edit operation ID belongs to another edit");
    } else {
      if (this.queue(thread.id).length) throw new ApiError(409, "invalid_request", "Send or remove queued messages before editing a message");
      if (thread.status !== "idle" && thread.status !== "error") throw new ApiError(409, "invalid_request", "Wait for the active turn to finish before editing a sent message");
      const before = nativeRewindBefore(this.deps.db, thread.id, payload.expectedRequestSequence);
      // An edit is an explicit send, so it lifts the pause left by Stop. Core rejects resume mid-rewind, so it goes first.
      if (saved.queuePaused) this.enqueue(thread.id, `resume_${payload.operationId}`, "resume", {});
      this.enqueue(thread.id, rewindId, "rewind", { before, expected_request_sequence: payload.expectedRequestSequence, replacement });
    }
    await this.deliverWhenAwake(thread.id);
    if (["failed", "unknown", "unknown_after_restart"].includes(command(this.deps.db, rewindId)?.state ?? "")) throw new ApiError(409, "cloudroom_command_failed", "The rewind failed or its outcome is uncertain. Your original history is preserved.");
    return { ok: true, operationId: payload.operationId, requestSequence: payload.expectedRequestSequence ?? 0 };
  }

  async retryStart(threadId: string): Promise<void> {
    await this.deliveries.get(threadId)?.catch(() => {});
    this.holdRejectedStart(threadId);
    const saved = binding(this.deps.db, threadId);
    const thread = getThread(this.deps.db, threadId);
    const first = command(this.deps.db, `first_${threadId}`)?.state;
    if (saved && !saved.sessionId && (first === "sending" || first === "accepted")) return;
    if (!saved || !thread || thread.archivedAt || thread.deletedAt || saved.sessionId || first !== "failed") throw new ApiError(409, "cloudroom_retry", "Only a rejected cloud start can be retried here.");
    const client = await this.client(saved);
    const capabilities = await this.capabilities(client);
    const harness = thread.providerId;
    if (!isCloudProvider(harness)) throw new ApiError(400, "cloudroom_harness", "Unsupported cloud harness.");
    validateReasoning(harness, coreModel(harness, saved.model, capabilities).model, saved.reasoning, capabilities);
    if (harness === "codex" && sandboxThread(saved.coreUrl) && authRequiredMessages.has(saved.error ?? "")) await this.sandboxes.refreshCodex(threadId).catch(error => this.warn("Cloud Codex login could not be refreshed before the retry", error, { threadId }));
    // A retry can start from the sign-in resume and a click at once; only the first one past the awaits sends.
    if (command(this.deps.db, `first_${threadId}`)?.state !== "failed") return;
    this.deps.db.transaction((tx) => {
      saveCommandState(tx, threadId, `first_${threadId}`, "sending");
      saveBinding(tx, threadId, { error: null });
      saveStatus(tx, threadId, "pending");
      appendStartProgress(tx, threadId, [cloudStep(Boolean(sandboxThread(saved.coreUrl)))], "active", true);
    });
    this.notify(threadId, ["system/thread-provisioning"]);
    this.start();
    await this.deliver(threadId);
  }

  private failStart(threadId: string, message: string): void {
    this.deps.db.transaction((tx) => {
      saveCommandState(tx, threadId, `first_${threadId}`, "failed");
      saveBinding(tx, threadId, { error: message });
      saveStatus(tx, threadId, "error");
      appendStartProgress(tx, threadId, [{ key: "error", text: message, status: "failed" }], "failed");
    });
    this.notify(threadId, ["system/thread-provisioning"]);
    void this.noticeCloudParent(threadId, "not_started", "start", message).catch((error: unknown) => this.warn("A child report could not be sent", error, { threadId }));
  }

  private progress(threadId: string, steps: StartStep[], block?: "completed" | "failed"): void {
    if (this.deps.db.transaction((tx) => appendStartProgress(tx, threadId, steps, block))) this.notify(threadId, ["system/thread-provisioning"], false);
  }

  private retractQueuedHistory(threadId: string): void {
    const queued = queuedPrompts(this.deps.db, threadId).map((c) => c.id);
    if (retractStillQueuedPrompts(this.deps.db, threadId, queued)) this.deps.hub.notifyThread(threadId, ["history-rewritten"]);
  }

  private holdRejectedStart(threadId: string): void {
    const saved = binding(this.deps.db, threadId);
    const initial = command(this.deps.db, `first_${threadId}`);
    const backgroundPreparation = initial && z.object({ backgroundPreparation: z.boolean().optional() }).parse(JSON.parse(initial.input)).backgroundPreparation;
    if (saved && !saved.sessionId && !backgroundPreparation && saved.error?.startsWith("Cloudroom rejected the request (HTTP 409)")) {
      this.failStart(threadId, "This cloud start was rejected before the app update. Your prompt is saved. Retry explicitly when ready.");
    }
  }

  /** An archived thread never starts, even when archived while its sandbox wakes, and a Cloud parent's child
   *  waits until the parent's Core confirms it (ADR 0229). */
  private mustNotStart(threadId: string): boolean {
    const thread = getThread(this.deps.db, threadId);
    const initial = command(this.deps.db, `first_${threadId}`);
    return !thread || Boolean(thread.archivedAt || thread.deletedAt) || (initial !== null && JSON.parse(initial.input).awaiting_core === true);
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.deliverChildReports();
    for (const saved of bindings(this.deps.db)) {
      this.holdRejectedStart(saved.threadId);
      this.pauseCutCopy(saved.threadId);
      if (this.deps.db.transaction(tx => projectInitialPrompt(tx, saved.threadId))) this.notify(saved.threadId, ["client/turn/requested"]);
      this.retractQueuedHistory(saved.threadId);
    }
    this.onboardingDue = 0;
    void this.reportOnboarding();
    void this.syncLogins();
    void this.uploadMacConfig();
    void this.warmRecentProject().catch(() => {});
    this.timer = setInterval(() => {
      this.teleportRecovery?.();
      void this.uploadMacConfig(); // Rate-limited to once a minute; only changed skills are sent.
      void this.reportOnboarding();
      if (this.lastCapabilities) void this.ensurePreviews(this.lastCapabilities);
      void this.sandboxes.discover().catch(() => {});
      void this.reportMacAccess().catch(() => {});
      for (const row of openBindings(this.deps.db)) if (this.needsDelivery(row)) void this.deliver(row.threadId).catch(() => {});
    }, 1500);
    this.timer.unref();
    const epoch = this.epoch;
    void this.dropRetiredVm().then(async (saved) => {
      if (!saved?.token || this.stopped || epoch !== this.epoch) return;
      const capabilities = capabilitiesSchema.parse(await (await this.client()).capabilities());
      if (this.stopped || epoch !== this.epoch) return;
      this.lastCapabilities = capabilities;
      await Promise.all([
        capabilities.sync ? setupSync(this.deps).then(() => { if (epoch === this.epoch) this.syncIssue = null; }).catch((error) => { if (epoch === this.epoch) this.syncIssue = publicError(error); }) : Promise.resolve(),
        this.ensurePreviews(capabilities),
      ]);
    }).catch((error) => { if (epoch === this.epoch) this.syncIssue = `Skills and settings sync could not start. Cloud sessions are unaffected. Cause: ${error instanceof Error ? error.message : String(error)}`; });
  }

  stop(): void {
    this.epoch++;
    this.previewRetryAt = 0;
    this.claudeConnected = null;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const controller of this.streams.values()) controller.abort();
    this.streams.clear();
    this.connectionIssues.clear();
    this.slept.clear();
  }

  /** Compact, rewind and goal wait while Core wakes a sleeping agent; the 1.5 s timer keeps retrying them meanwhile. */
  private async deliverWhenAwake(threadId: string): Promise<void> {
    for (const deadline = Date.now() + 60_000; ;) {
      try { return await this.deliver(threadId); }
      catch (error) { if (!(error instanceof ApiError && error.body.code === "session_waking") || Date.now() > deadline) throw error; }
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
  }

  private deliver(threadId: string): Promise<void> {
    const pending = this.deliveries.get(threadId);
    if (pending) return pending.then(() => this.deliver(threadId));
    const work = this.deliverPending(threadId).finally(() => this.deliveries.delete(threadId));
    this.deliveries.set(threadId, work);
    return work;
  }

  private async deliverPending(threadId: string): Promise<void> {
    this.slept.delete(threadId);
    this.holdRejectedStart(threadId);
    let saved = binding(this.deps.db, threadId);
    if (!saved || this.stopped || await this.otherAccountThread(saved)) return;
    if (!saved.sessionId && commands(this.deps.db, threadId).some(item => item.command === "teleport")) return;
    if (!saved.sessionId && command(this.deps.db, `first_${threadId}`)?.state === "failed") return;
    if (!saved.sessionId && this.mustNotStart(threadId)) return;
    const epoch = this.epoch;
    let deliveringCommand = false;
    let rejectedCommand = false;
    // A new thread's project copy waits until its first message is sent or fails (ADR 0160).
    let releaseCopy: (() => void) | undefined;
    try {
      const work = !saved.sessionId || commands(this.deps.db, threadId).some(c => c.state === "sending") || this.catchUpForParent(saved);
      const client = await this.client(saved, work);
      if (epoch !== this.epoch) return;
      if (saved.sessionId) {
        this.follow(saved, client);
        await this.leaveFormerParent(saved, client);
        if (!commands(this.deps.db, threadId).some(c => c.state === "sending")) { this.setConnectionIssue(threadId, "delivery"); return; }
      }
      const sandbox = sandboxThread(saved.coreUrl);
      const known = sandbox ? await this.savedCapabilities() : null;
      const cached = known && harnessProfile(known, getThread(this.deps.db, threadId)?.providerId ?? "") ? known : null;
      const capabilities = cached ?? await this.capabilities(client);
      if (epoch !== this.epoch) return;
      if (!cached) await this.rememberCapabilities(capabilities, Boolean(sandbox));
      if (!saved.sessionId) {
        if (this.mustNotStart(threadId)) return;
        deliveringCommand = true;
        const harness = getThread(this.deps.db, threadId)?.providerId;
        if (!isCloudProvider(harness)) throw new ApiError(409, "cloudroom_harness", "Unsupported cloud harness; native execution is blocked.");
        this.progress(threadId, [cloudStep(Boolean(sandbox), "completed"), { key: "agent", text: `Starting ${HARNESS_NAMES[harness]}`, status: "started" }]);
        const { model, provider } = coreModel(harness, saved.model, capabilities);
        const initial = command(this.deps.db, `first_${threadId}`);
        const options = initial ? z.object({ workspace: z.string().optional(), workspace_name: z.string().optional(), provider: z.string().optional(), command_guard_enabled: z.boolean().optional(), strip_ai_co_authors: z.boolean().optional(), system_prompt: z.string().optional() }).parse(JSON.parse(initial.input)) : {};
        if (!capabilities.command_guard) delete options.command_guard_enabled;
        if (!capabilities.strip_ai_co_authors) delete options.strip_ai_co_authors;
        if (!capabilities.system_prompt) delete options.system_prompt;
        if (!capabilities.direct_workspaces) throw new ApiError(503, "cloudroom_update", "Update the cloud core to start agents without copying files. Your message is saved.");
        if (options.workspace === ROOT_WORKSPACE && !capabilities.root_workspace) throw new ApiError(503, "cloudroom_update", "Update the cloud core to start agents outside a project. Your message is saved.");
        if (harness === "codex" && capabilities.codex_auth_import && !sandbox) await importCodexLogin(this.deps);
        if (harness === "pi") await this.copyPiSetup(client, Boolean(sandbox));
        const fork = cloudForkOf(initial?.input);
        const sideChat = initial?.command === "side_chat" ? z.object({ side_chat: z.string() }).parse(JSON.parse(initial.input)).side_chat : null;
        const codeFrom = codeFromOf(initial?.input);
        // A Cloud parent's child reports its own turns, and takes tell, stop and archive, through the website (ADR 0259).
        // Only a parent with a sandbox of its own has a link there; children of one sharing a sandbox keep the app's path.
        const relayed = Boolean(codeFrom && getThread(this.deps.db, threadId)?.parentThreadId === codeFrom && capabilities.relay && binding(this.deps.db, codeFrom)?.coreUrl === SANDBOX_PREFIX + codeFrom);
        if (relayed && initial && !JSON.parse(initial.input).parent_thread) {
          this.deps.db.update(cloudroomCommands).set({ input: JSON.stringify({ ...JSON.parse(initial.input), parent_thread: codeFrom }) }).where(eq(cloudroomCommands.id, initial.id)).run();
        }
        const parentThread = relayed ? { parent_thread: codeFrom } : {};
        const target = options.workspace && options.workspace !== ROOT_WORKSPACE ? options.workspace : null;
        if (fork && !capabilities.fork) throw new ApiError(503, "cloudroom_update", "Update the cloud core to fork Cloud threads. Your message is saved.");
        const [copy, started] = await Promise.all([
          target ? planProjectCopy(this.deps, client, threadId, target, { key: copyKey(sandbox, target), branch: baseBranch(initial?.input) }) : null,
          sideChat
            ? this.startSideChat(client, threadId, saved.startRequestId, harness, sideChat)
            : fork
            ? startCloudFork(this.deps, client, threadId, fork, {
              model, provider: provider ?? null, reasoning: saved.reasoning, service_tier: z.object({ service_tier: z.string().optional() }).parse(JSON.parse(initial!.input)).service_tier ?? null,
              workspace: options.workspace ?? ROOT_WORKSPACE, workspace_name: options.workspace_name ?? ROOT_WORKSPACE,
              ...(options.command_guard_enabled === undefined ? {} : { command_guard_enabled: options.command_guard_enabled }),
              ...(options.strip_ai_co_authors === undefined ? {} : { strip_ai_co_authors: options.strip_ai_co_authors }),
              ...(options.system_prompt ? { system_prompt: options.system_prompt } : {}),
            }, (patch) => {
              const latest = command(this.deps.db, `first_${threadId}`)!;
              this.deps.db.update(cloudroomCommands).set({ input: JSON.stringify({ ...JSON.parse(latest.input), fork: { ...fork, ...patch } }) }).where(eq(cloudroomCommands.id, latest.id)).run();
            })
            : client.start(saved.startRequestId, CLOUD_HARNESSES[harness], { model, reasoning: saved.reasoning, ...options, ...parentThread, ...(provider ? { provider } : {}) }).then((accepted) => {
              const transfer = `child_${threadId}`;
              return { sessionId: accepted.session_id, transfer, code: codeFrom ? threadCode(this.deps, codeFrom, transfer) : null };
            }),
        ]);
        saveBinding(this.deps.db, threadId, { sessionId: started.sessionId, error: null });
        saved = binding(this.deps.db, threadId)!;
        const copying = copy?.clone && copy.repository ? `Cloning ${copy.repository.replace("https://github.com/", "")}` : copy?.copyAll ? `Copying project from your ${COMPUTER}` : null;
        const files: StartStep[] = copying ? [{ key: "files", text: copying, status: "started" }] : [];
        const forkCode: StartStep[] = started.code ? [{ key: "fork", text: "Copying the source thread's code", status: "started" }] : [];
        this.progress(threadId, [{ key: "agent", status: "completed" }, ...files, ...forkCode], "completed");
        const firstSent = new Promise<void>(resolve => { releaseCopy = resolve; });
        // `room-cli files wait` holds the agent until the files, and a fork's code, have landed (ADR 0209).
        // A child in a Personal project has no workspace of its own, so its status file sits next to the sandbox root.
        const workspace = target && (files.length || started.code) ? target
          : started.code ? await client.sessionWorkspace(started.sessionId).then(({ path }) => path, () => null) : null;
        // Code from another thread replaces the folder's files, so the agent must wait for it from its first command.
        const marked = workspace ? started.code ? this.filesState(client, threadId, workspace, "copying") : firstSent.then(() => this.filesState(client, threadId, workspace, "copying")) : null;
        if (started.code) await marked;
        const landed = this.landing(threadId, client, started, files.length > 0, workspace, marked);
        if (copy) this.copy(client, copy, landed, firstSent);
        else if (started.code) void landed();
        else if (sandbox) void this.ensureBranch(threadId, true);
      }
      if (epoch !== this.epoch) return;
      const sessionId = saved.sessionId!;
      this.follow(saved, client);
      const harness = getThread(this.deps.db, threadId)?.providerId;
      const pendingCommands = commands(this.deps.db, threadId).filter((c) => c.state === "sending");
      for (const pending of pendingCommands) {
        if (epoch !== this.epoch) return;
        deliveringCommand = true;
        try {
          if (pending.command === "title") {
            const thread = getThread(this.deps.db, threadId);
            if (!thread?.title && this.deps.logger && this.deps.aiServices) {
              try {
                const input = z.object({ input: z.array(z.unknown()) }).parse(JSON.parse(pending.input));
                void inferThreadMetadata(this.deps as LoggedWorkSessionDeps, {
                  input: input.input as PromptInput[],
                  provisioningId: saved.startRequestId,
                  threadId,
                  writeTranscript: false,
                }).then(() => this.ensureBranch(threadId, false)).catch(() => {});
              } catch { /* keep the existing fallback title */ }
            }
            if (command(this.deps.db, pending.id)?.state === "sending") saveCommandState(this.deps.db, threadId, pending.id, "completed");
            void this.ensureBranch(threadId, false);
            continue;
          }
          if (pending.command === "side_chat") {
            saveCommandState(this.deps.db, threadId, pending.id, "completed");
            continue;
          }
          let accepted;
          if (pending.command === "prompt") {
            const parsed = z.object({
              text: z.string(),
              reasoning: z.string().optional(),
              content: z.unknown().optional(),
              attachments: z.array(z.object({
                name: z.string(), kind: z.enum(["image", "file"]), localPath: z.string().optional(),
                path: z.string().optional(), id: z.string().optional(),
              })).optional(),
              service_tier: z.string().optional(),
              customInstructions: z.string().default(""),
              workspaceContext: z.string().nullable().optional(),
            }).parse(JSON.parse(pending.input));
            requireClaudeSkillSupport(parsed.content, capabilities, harness);
            if (parsed.attachments?.length) {
              if (!capabilities.attachments) throw new ApiError(400, "cloudroom_unsupported", "Update the cloud core to use attachments. Your message is saved.");
            }
            const attachments = capabilities.attachments
              ? await this.uploadAttachments(client, sessionId, pending.id, parsed.attachments ?? [], getThread(this.deps.db, threadId)?.projectId ?? "", capabilities.upload_parts)
              : [];
            const enriched = prepareCloudInstructionInput({ text: parsed.text, content: cloudTextContent(parsed.content) }, parsed.customInstructions, cloudPromptLimit(capabilities));
            // A fork's first message is a native fork of the copied conversation (fork.ts).
            const fork = pending.id === `first_${threadId}` ? cloudForkOf(pending.input) : null;
            const child = pending.id === `first_${threadId}` && Boolean(JSON.parse(pending.input).code_from);
            let context = parsed.workspaceContext;
            if (context === undefined) {
              const copying = pending.id === `first_${threadId}` && ["cloning", "uploading", "waiting"].includes(projectCopyProgress(this.deps.db, threadId)?.phase ?? "");
              const hint = fork || (child && getThread(this.deps.db, threadId)?.originKind === "fork") ? FORK_HINT : child ? CHILD_HINT : copying ? `[Cloud workspace context]\nThis project is new on the VM. Cloudroom is copying its files into this folder right now: a GitHub clone or an upload from the user's ${COMPUTER}, plus uncommitted edits and .env files. Run \`room-cli files wait\` before you rely on them; it returns once they land, or says why they won't. Never recreate missing files or instructions such as AGENTS.md.` : null;
              context = hint && Buffer.byteLength(`${enriched.text}\n\n${hint}`, "utf8") <= cloudPromptLimit(capabilities) ? hint : null;
              this.deps.db.update(cloudroomCommands).set({ input: JSON.stringify({ ...JSON.parse(pending.input), workspaceContext: context }) }).where(eq(cloudroomCommands.id, pending.id)).run();
            }
            const text = context ? `${enriched.text}\n\n${context}` : enriched.text;
            const content = context && Array.isArray(enriched.content) ? [...enriched.content, { type: "text", text: `\n${context}` }] : enriched.content;
            const options = {
              ...(capabilities.structured_prompt && content !== undefined ? { content: content as never } : {}),
              ...(attachments.length ? { attachments: attachments as never } : {}),
              ...(parsed.service_tier ? { service_tier: parsed.service_tier } : {}),
            };
            accepted = fork
              ? await client.rewind(sessionId, `fork_${threadId}`, fork.before, fork.last_turn_id, { request_id: pending.id, text, ...(parsed.reasoning ? { reasoning: parsed.reasoning } : {}), ...options }, true)
              : await client.prompt(sessionId, pending.id, text, parsed.reasoning, options);
          } else if (pending.command === "edit") {
            const parsed = z.object({
              target_request_id: z.string(), expected_revision: z.number(), text: z.string(),
              reasoning: z.string().optional(), content: z.unknown().optional(),
              attachments: z.array(z.object({ name: z.string(), kind: z.enum(["image", "file"]), localPath: z.string().optional(), path: z.string().optional(), id: z.string().optional() })).optional(), service_tier: z.string().optional(),
              customInstructions: z.string().default(""),
            }).parse(JSON.parse(pending.input));
            requireClaudeSkillSupport(parsed.content, capabilities, harness);
            const enriched = prepareCloudInstructionInput({ text: parsed.text, content: cloudTextContent(parsed.content) }, parsed.customInstructions, cloudPromptLimit(capabilities));
            const attachments = await this.uploadAttachments(client, sessionId, pending.id, parsed.attachments ?? [], getThread(this.deps.db, threadId)!.projectId, capabilities.upload_parts);
            accepted = await client.edit(sessionId, pending.id, parsed.target_request_id, parsed.expected_revision, enriched.text, {
              ...(enriched.content === undefined ? {} : { content: enriched.content as never }),
              attachments: attachments as never,
              ...(parsed.reasoning ? { reasoning: parsed.reasoning } : {}),
              ...(parsed.service_tier ? { service_tier: parsed.service_tier } : {}),
            });
          } else if (pending.command === "cancel") {
            accepted = await client.cancel(sessionId, pending.id, JSON.parse(pending.input).target_request_id);
          } else if (pending.command === "reorder") {
            accepted = await client.reorder(sessionId, pending.id, z.object({ order: z.array(z.string()) }).parse(JSON.parse(pending.input)).order);
          } else if (pending.command === "steer") {
            const parsed = z.object({ target_request_id: z.string(), text: z.string(), customInstructions: z.string().default("") }).parse(JSON.parse(pending.input));
            accepted = await client.steer(sessionId, pending.id, parsed.target_request_id, prepareCloudInstructionInput(parsed, parsed.customInstructions, cloudPromptLimit(capabilities)).text);
          } else if (pending.command === "compact") {
            accepted = await client.compact(sessionId, pending.id);
          } else if (pending.command === "goal") {
            accepted = await client.goal(sessionId, pending.id, JSON.parse(pending.input));
          } else if (pending.command === "rewind") {
            const parsed = z.object({ before: z.string(), last_turn_id: z.string().optional(), customInstructions: z.string().default(""), replacement: z.object({ request_id: z.string(), text: z.string(), content: z.unknown().optional(), attachments: z.array(z.object({ name: z.string(), kind: z.enum(["image", "file"]), localPath: z.string().optional(), path: z.string().optional(), id: z.string().optional() })).optional(), reasoning: z.string().optional(), service_tier: z.string().optional() }) }).parse(JSON.parse(pending.input));
            requireClaudeSkillSupport(parsed.replacement.content, capabilities, harness);
            const enriched = prepareCloudInstructionInput({ text: parsed.replacement.text, content: cloudTextContent(parsed.replacement.content) }, parsed.customInstructions, cloudPromptLimit(capabilities));
            const attachments = await this.uploadAttachments(client, sessionId, parsed.replacement.request_id, parsed.replacement.attachments ?? [], getThread(this.deps.db, threadId)!.projectId, capabilities.upload_parts);
            accepted = await client.rewind(sessionId, pending.id, parsed.before, parsed.last_turn_id, { ...parsed.replacement, ...enriched, content: enriched.content as never, attachments: attachments as never });
          } else if (pending.command === "stop" || pending.command === "resume" || pending.command === "sleep") {
            accepted = await client[pending.command](sessionId, pending.id);
          } else {
            throw new CloudroomError(`Unsupported cloud command ${pending.command}`, 400);
          }
          if (command(this.deps.db, pending.id)?.state === "sending") saveCommandState(this.deps.db, threadId, pending.id, accepted.receipt.state);
          if (pending.command === "prompt") void this.rememberCloudMessage(sessionId, pending.id, epoch).catch(() => {});
        } catch (error) {
          if (refused(error, ["steer", "edit", "cancel", "reorder"].includes(pending.command))) {
            if (pending.command === "steer") {
              // Usually its turn just ended. It queues ahead of anything sent after it; the same ID makes a repeat harmless.
              const { text, content } = z.object({ text: z.string(), content: z.unknown().optional() }).parse(JSON.parse(pending.input));
              const id = `queued-${createHash("sha256").update(pending.id).digest("hex").slice(0, 32)}`;
              this.enqueue(threadId, id, "prompt", { text, ...(content === undefined ? {} : { content }) }, pending.createdAt);
              saveCommandState(this.deps.db, threadId, pending.id, "failed");
              if (this.deps.db.transaction(tx => projectFollowUp(tx, threadId, id))) this.notify(threadId, ["client/turn/requested"]);
              void this.deliver(threadId).catch(() => {});
              return;
            }
            saveCommandState(this.deps.db, threadId, pending.id, "failed");
            if (["edit", "cancel"].includes(pending.command) && error instanceof CloudroomError && /queued message is (no longer pending|already being sent)/.test(error.message)) continue;
            rejectedCommand = true;
          }
          throw error;
        }
      }
      if (epoch !== this.epoch) return;
      this.setConnectionIssue(threadId, "delivery");
      this.rewoken.delete(threadId);
      if (pendingCommands.length > 0) this.notify(threadId);
    } catch (error) {
      if (epoch !== this.epoch) return;
      // A sandbox put to sleep loses its address, so a 404 there means a stale one: forget it and wake it again, once,
      // instead of failing the thread's start (feedback #596).
      const sandbox = sandboxThread(saved.coreUrl);
      if (sandbox && error instanceof CloudroomError && error.status === 404 && !error.code && !this.rewoken.has(threadId)) {
        this.rewoken.add(threadId);
        this.sandboxes.forget(sandbox);
        return;
      }
      if (error instanceof SandboxAsleep) return this.asleep(threadId);
      const message = publicError(error);
      const permanent = error instanceof CloudroomError ? !error.retryable : error instanceof ApiError && error.status === 400;
      if (!binding(this.deps.db, threadId)?.sessionId && permanent) this.failStart(threadId, message);
      else if ((connectionFailure(error) && !rejectedCommand) || !deliveringCommand) this.setConnectionIssue(threadId, "delivery", error);
      else {
        saveBinding(this.deps.db, threadId, { error: message });
        this.setConnectionIssue(threadId, "delivery");
        this.notify(threadId);
      }
      if (startRefused(error) && !binding(this.deps.db, threadId)?.sessionId) void this.noticeCloudParent(threadId, error.code === CLOUD_REGION ? "blocked" : "refused", "refused", message).catch((error: unknown) => this.warn("A child report could not be sent", error, { threadId }));
      throw new ApiError(permanent ? 400 : 503, error instanceof CloudroomError ? error.code ?? "cloudroom_unavailable" : "cloudroom_unavailable", message);
    } finally { releaseCopy?.(); }
  }

  private async followChild(parent: Binding, client: CloudroomClient, childId: string): Promise<void> {
    const parentThread = getThread(this.deps.db, parent.threadId);
    if (!parentThread) return;
    const existing = this.deps.db.select().from(cloudroomThreads).where(and(eq(cloudroomThreads.coreUrl, parent.coreUrl), eq(cloudroomThreads.sessionId, childId))).get();
    if (existing) { this.follow(existing, client); return; }
    const session = await client.session(childId);
    const start = Object.values(session.receipts).find(receipt => receipt.command === "start");
    const input = z.object({ parent_session: z.literal(parent.sessionId!), reasoning: z.string().nullable().optional(), title: z.string().optional(), prompt: z.string().optional() }).parse(start?.input);
    const providerId = (Object.keys(CLOUD_HARNESSES) as CloudProvider[]).find(id => CLOUD_HARNESSES[id] === session.harness);
    if (!providerId || !start) throw new CloudroomError("Invalid Cloudroom child session");
    const child = this.deps.db.transaction(tx => {
      const saved = tx.select().from(cloudroomThreads).where(and(eq(cloudroomThreads.coreUrl, parent.coreUrl), eq(cloudroomThreads.sessionId, childId))).get();
      if (saved) return saved;
      const prompt: PromptInput[] = [{ type: "text", text: input.prompt ?? "", mentions: [] }];
      const thread = createThread(tx, this.deps.hub, { executionTarget: "cloud", projectId: parentThread.projectId, providerId, parentThreadId: parent.threadId, title: input.title ?? null, titleFallback: deriveTitleFallback(prompt) ?? `${HARNESS_NAMES[providerId]} child`, status: "pending" });
      if (!input.title) queueThreadTitle(tx, thread.id, prompt);
      tx.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: parent.coreUrl, sessionId: childId, startRequestId: start.request_id, model: start.model ?? parent.model, reasoning: input.reasoning ?? parent.reasoning }).run();
      for (const receipt of Object.values(session.receipts).filter(receipt => receipt.command === "prompt")) {
        tx.insert(cloudroomCommands).values({ id: receipt.request_id, threadId: thread.id, command: "prompt", input: JSON.stringify(receipt.input), state: "accepted", createdAt: Date.now() }).run();
      }
      return binding(tx, thread.id)!;
    });
    this.follow(child, client);
    this.notify(child.threadId);
  }

  /** The parent the app reports this child's turns to: a Local parent, or a Cloud parent whose child runs in a
   *  sandbox of its own (ADR 0228). Core reports the children in a Cloud parent's own sandbox. */
  private reportedParent(thread: Thread | null): Thread | null {
    const parent = thread && isParentNotifiableChildThread(thread) ? getThread(this.deps.db, thread.parentThreadId) : null;
    if (!parent || !isCloudThread(parent)) return parent;
    return binding(this.deps.db, thread!.id)?.coreUrl !== binding(this.deps.db, parent.id)?.coreUrl ? parent : null;
  }

  /** Reports a finished child turn to a Local parent (after the record is shown, as before). */
  private tellLocalParent(threadId: string, status: ThreadEventTurnStatus, turn: string): void {
    const thread = getThread(this.deps.db, threadId);
    const parent = this.reportedParent(thread);
    if (!thread?.parentThreadId || !parent || isCloudThread(parent)) return;
    if (teleportBlocked(this.deps.db, parent.id)) {
      void this.holdChildReport(threadId, status, turn).then(() => this.deliverChildReports(), (error: unknown) => this.warn("A child report could not be saved", error, { threadId }));
      return;
    }
    this.childTurnEnded?.({ ...thread, parentThreadId: thread.parentThreadId }, status);
  }

  private teleportingParent(threadId: string): boolean {
    const parent = this.reportedParent(getThread(this.deps.db, threadId));
    return Boolean(parent && !isCloudThread(parent) && teleportBlocked(this.deps.db, parent.id));
  }

  private holdChildReport(child: string, status: ThreadEventTurnStatus, turn: string): Promise<void> {
    return this.updateRecords(CHILD_REPORTS, childReportSchema, (reports) => ({ ...reports, [`${child}:${turn}`]: { child, status, turn } }));
  }

  private deliverChildReports(): Promise<void> {
    this.delivering ??= (async () => {
      try {
        for (;;) {
          const reports = Object.entries(await this.records(CHILD_REPORTS, childReportSchema));
          if (!reports.length || this.stopped) return;
          let waiting = false, failed = false;
          for (const [key, report] of reports) {
            const thread = getThread(this.deps.db, report.child);
            const parent = this.reportedParent(thread);
            if (parent && teleportBlocked(this.deps.db, parent.id)) { waiting = true; continue; }
            const status = report.status as ThreadEventTurnStatus;
            if (parent && isCloudThread(parent)) {
              const sent = await this.noticeCloudParent(report.child, status, report.turn).then(() => true, (error: unknown) => { this.warn("A child report could not be sent", error, { threadId: report.child }); return false; });
              if (!sent) { failed = true; continue; }
            }
            else if (parent && thread?.parentThreadId) this.childTurnEnded?.({ ...thread, parentThreadId: thread.parentThreadId }, status);
            await this.updateRecords(CHILD_REPORTS, childReportSchema, ({ [key]: _done, ...rest }) => rest);
          }
          if (failed && !waiting) return;
          if (waiting) await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      } finally { this.delivering = undefined; }
    })();
    return this.delivering;
  }

  /** Reports a child in a sandbox of its own to its Cloud parent, in the words of Core's own child notices, so the
   *  app shows it as a child report. Called before the child's record counts as read, so a crash can't lose it.
   *  Core reports a child a Cloud parent started through the website instead (ADR 0259), Mac on or off, when its
   *  current parent has a sandbox of its own; this covers every other child.
   *  A parent in another Cloudroom account never hears from it. */
  private async noticeCloudParent(threadId: string, status: ThreadEventTurnStatus | "not_started" | "refused" | "blocked", turn: string, cause?: string): Promise<void> {
    const child = getThread(this.deps.db, threadId);
    const parent = this.reportedParent(child);
    if (!child || !parent || !isCloudThread(parent)) return;
    const parentSaved = binding(this.deps.db, parent.id);
    if (parentSaved && await this.otherAccountThread(parentSaved)) return;
    const first = command(this.deps.db, `first_${child.id}`);
    if (status !== "not_started" && status !== "refused" && status !== "blocked" && first && JSON.parse(first.input).parent_thread && parentSaved?.coreUrl === SANDBOX_PREFIX + parent.id) return;
    const name = child.title ? `"${child.title}" (${child.id})` : child.id;
    const reply = getLastThreadOutput(this.deps.db, child.id)?.trim();
    const text = status === "refused" || status === "blocked"
      ? `[Cloudroom] Child thread ${name} has not started: ${cause} ${status === "refused" ? "It starts by itself once that clears, so don't spawn a replacement. If it can't wait, ask" : "That may not change soon, so ask"} the user to archive it, then spawn it again with --shared-sandbox.`
      : status === "completed"
      ? `[Cloudroom] Child thread ${name} completed:\n\n${reply ? reply.length > 4000 ? `${reply.slice(0, 4000)}\n\n[... reply truncated. Read all of it with \`room-cli thread output ${child.id}\` ...]` : reply : "No final output was recorded."}`
      : status === "interrupted"
        ? `[Cloudroom] Child thread ${name} was interrupted. If the user stopped it, do not restart or replace its work unless they ask.`
        : `[Cloudroom] Child thread ${name} failed or its outcome is uncertain.${cause ? ` Cause: ${cause.trim().replace(/\.$/, "")}.` : ""} ${status === "not_started" ? "It did not start." : "Its turn did not finish; resend the task if it still matters."}`;
    this.queuePrompt(parent.id, `notice_${createHash("sha256").update(`${child.id}:${turn}`).digest("hex").slice(0, 40)}`, text);
  }

  /** Saves a message from a parent or child thread and delivers it. Saving the same ID again does nothing. Unlike
   *  a user's message it never resumes a thread the user stopped: like Core's own notices, it waits in the queue. */
  private queuePrompt(threadId: string, id: string, text: string): void {
    const thread = getThread(this.deps.db, threadId);
    if (!thread || thread.archivedAt || thread.deletedAt || command(this.deps.db, id)) return;
    try { this.enqueue(threadId, id, "prompt", { text }); }
    catch (error) { this.warn("A message between parent and child threads was not saved", error, { threadId }); return; }
    if (this.deps.db.transaction(tx => projectFollowUp(tx, threadId, id))) this.notify(threadId, ["client/turn/requested"]);
    void this.deliver(threadId).catch(() => {});
  }

  /** ADR 0229: a Cloud agent's `room-cli thread spawn` asks the app to start the child in a sandbox of its own
   *  (Core waits briefly for the answer). Cores older than ADR 0259 also send `tell`, `stop` and `archive` on that
   *  child here; newer ones go through the website. Both are handled before the parent's record counts as read, so
   *  a crash replays them instead of losing them. */
  private async ownSandboxChild(parent: Binding, client: CloudroomClient, record: SessionRecord): Promise<void> {
    const parentThread = getThread(this.deps.db, parent.threadId);
    if (!parentThread || parentThread.archivedAt || parentThread.deletedAt) return;
    const once = (kind: string) => `${kind}_${createHash("sha256").update(`${parent.sessionId}:${record.sequence}`).digest("hex").slice(0, 40)}`;
    if (record.kind === "child_command") {
      const input = z.object({ id: z.string(), action: z.enum(["tell", "stop", "archive"]), text: z.string().min(1).optional() }).parse(record.data);
      const child = getThread(this.deps.db, input.id);
      if (!child || child.parentThreadId !== parentThread.id || this.reportedParent(child)?.id !== parentThread.id) return;
      if (input.action === "archive") this.archiveRequest?.(child.id);
      else if (input.action === "tell" && input.text) this.queuePrompt(child.id, once("tell"), input.text);
      else if (input.action === "stop" && !command(this.deps.db, once("stop"))) {
        this.enqueue(child.id, once("stop"), "stop", {});
        void this.deliver(child.id).catch(() => {});
      }
      return;
    }
    const input = z.object({ id: z.string().min(1).max(80), prompt: z.string().min(1), provider: z.string().optional(), model: z.string().optional(), reasoning: z.string().optional(), title: z.string().optional(), service_tier: z.enum(["fast", "default"]).optional() }).parse(record.data);
    // One start per request, even when the parent's stream replays it.
    const requestId = `child_${createHash("sha256").update(`${parent.threadId}:${input.id}`).digest("hex").slice(0, 40)}`;
    let child = this.deps.db.select().from(cloudroomThreads).where(eq(cloudroomThreads.startRequestId, requestId)).get()?.threadId ?? null;
    let answer: { thread: string } | { error: string };
    try {
      if (!child) {
        const refusal = await this.sandboxes.startRefusal();
        if (refusal) throw new ApiError(429, "cloud_start_refused", refusal.replace(/\.$/, ""));
        const providerId = input.provider ? (Object.keys(CLOUD_HARNESSES) as CloudProvider[]).find(id => CLOUD_HARNESSES[id] === input.provider) : parentThread.providerId;
        if (!providerId) throw new ApiError(400, "cloudroom_unsupported", `Cloud has no ${input.provider} agent.`);
        const same = providerId === parentThread.providerId;
        const profile = input.model || same ? null : harnessProfile(await this.savedCapabilities() ?? await this.capabilities(client), providerId);
        const model = input.model ?? (same ? parent.model : profile && (providerId === "pi" && profile.provider ? `${profile.provider}/${profile.model}` : profile.model));
        const reasoning = reasoningLevelSchema.safeParse(input.reasoning ?? (same ? parent.reasoning : undefined));
        if (input.reasoning && !reasoning.success) throw new ApiError(400, "cloudroom_reasoning", `Unknown effort level ${input.reasoning}.`);
        child = (await this.create({
          projectId: parentThread.projectId, providerId, ...(model ? { model } : {}), ...(reasoning.success ? { reasoningLevel: reasoning.data } : {}), ...(input.title ? { title: input.title } : {}), ...(input.service_tier ? { serviceTier: input.service_tier } : {}),
          input: [{ type: "text", text: input.prompt, mentions: [] }], parentThreadId: parentThread.id, requestId,
          origin: "cli", environment: { type: "project-default" }, startedOnBehalfOf: null, originKind: null,
        }, true)).id;
      }
      answer = { thread: child };
    } catch (error) { answer = { error: publicError(error) }; }
    // Core decides once. The child starts only after Core confirms it; otherwise Core runs it in the parent's
    // sandbox (or nowhere), so this one is archived before it starts and the task never runs twice.
    const confirmed = await this.answerChild(client, parent, input.id, answer);
    if (!child) return;
    if (!confirmed) {
      if (!getThread(this.deps.db, child)?.archivedAt) this.archiveRequest?.(child);
      return;
    }
    const first = command(this.deps.db, `first_${child}`);
    if (first) this.deps.db.update(cloudroomCommands).set({ input: JSON.stringify({ ...JSON.parse(first.input), awaiting_core: undefined }) }).where(eq(cloudroomCommands.id, first.id)).run();
    void this.deliver(child).catch(() => {});
  }

  private async agentFork(parent: Binding, client: CloudroomClient, record: SessionRecord): Promise<void> {
    const parentThread = getThread(this.deps.db, parent.threadId);
    if (!parentThread || parentThread.archivedAt || parentThread.deletedAt) return;
    const input = z.object({ id: z.string().min(1).max(80), prompt: z.string().min(1), machine: z.enum(["local", "cloud"]).optional(), provider: z.string().optional(), model: z.string().optional(), reasoning: z.string().optional(), title: z.string().optional() }).parse(record.data);
    const requestId = `fork_${createHash("sha256").update(`${parent.threadId}:${input.id}`).digest("hex").slice(0, 40)}`;
    const forks = await this.agentForks();
    let fork = forks[requestId] ?? this.deps.db.select().from(cloudroomThreads).where(eq(cloudroomThreads.startRequestId, requestId)).get()?.threadId ?? null;
    const held = (id: string) => { const first = command(this.deps.db, `first_${id}`); return Boolean(first && JSON.parse(first.input).awaiting_core === true); };
    if (fork) {
      const made = getThread(this.deps.db, fork);
      if (!made || made.archivedAt || made.deletedAt) { await this.answerChild(client, parent, input.id, { error: "This fork was cancelled." }); return; }
      if (!held(fork)) { await this.answerChild(client, parent, input.id, { thread: fork }); return; }
    }
    if (!fork && (this.heldStarts.has(requestId) || (record.timestamp_ms !== undefined && Date.now() - record.timestamp_ms > AGENT_FORK_WAIT))) return;
    const creating = !fork;
    if (creating) this.heldStarts.add(requestId);
    let answer: { thread: string } | { error: string };
    try {
      if (!fork) {
        const providerId = input.provider ? (Object.keys(CLOUD_HARNESSES) as CloudProvider[]).find(id => CLOUD_HARNESSES[id] === input.provider) : parentThread.providerId;
        if (!providerId) throw new ApiError(400, "cloudroom_unsupported", `Cloud has no ${input.provider} agent.`);
        const same = providerId === parentThread.providerId;
        if (input.machine === "local") throw new ApiError(403, "cloudroom_unsupported", `Cloud agents fork only to Cloud. Omit --machine; only the user can fork to their ${COMPUTER}, from the Cloudroom app.`);
        if (!findLastCompletedRootStoredTurn(this.deps.db, { threadId: parentThread.id })) throw new ApiError(409, "fork_source_session_unavailable", "This thread has no finished turn to fork yet: a fork starts at the last finished turn, and this is the first one. Fork in a later turn.");
        const profile = input.model || same ? null : harnessProfile(await this.savedCapabilities() ?? await this.capabilities(client), providerId);
        const model = input.model ?? (same ? parent.model : profile && (providerId === "pi" && profile.provider ? `${profile.provider}/${profile.model}` : profile.model));
        const reasoning = reasoningLevelSchema.safeParse(input.reasoning ?? (same ? this.currentReasoning(parent.threadId, parent) : undefined));
        if (input.reasoning && !reasoning.success) throw new ApiError(400, "cloudroom_reasoning", `Unknown effort level ${input.reasoning}.`);
        const { createThreadFromRequest } = await import("../threads/thread-create.js");
        fork = (await createThreadFromRequest(this.deps as Parameters<typeof createThreadFromRequest>[0], {
          projectId: parentThread.projectId, providerId, ...(model ? { model } : {}), ...(reasoning.success ? { reasoningLevel: reasoning.data } : {}), ...(input.title ? { title: input.title } : {}),
          input: [{ type: "text", text: input.prompt, mentions: [] }], originKind: "fork", sourceThreadId: parentThread.id, executionTarget: "cloud",
          environment: { type: "project-default" }, origin: "cli", startedOnBehalfOf: null, visibility: "visible", requestId,
        })).id;
        await this.saveAgentFork(requestId, fork).catch((error: unknown) => this.warn("A Cloud fork request could not be saved", error, { threadId: parent.threadId }));
      }
      answer = { thread: fork };
    } catch (error) {
      answer = { error: publicError(error) };
      const made = creating ? this.deps.db.select().from(cloudroomThreads).where(eq(cloudroomThreads.startRequestId, requestId)).get()?.threadId : undefined;
      if (made && held(made)) this.archiveRequest?.(made);
    }
    finally { if (creating) this.heldStarts.delete(requestId); }
    const confirmed = await this.answerChild(client, parent, input.id, answer);
    if (!fork) return;
    if (!confirmed) {
      if (!getThread(this.deps.db, fork)?.archivedAt) this.archiveRequest?.(fork);
      return;
    }
    const first = command(this.deps.db, `first_${fork}`);
    if (first && held(fork)) {
      this.deps.db.update(cloudroomCommands).set({ input: JSON.stringify({ ...JSON.parse(first.input), awaiting_core: undefined }) }).where(eq(cloudroomCommands.id, first.id)).run();
      void this.deliver(fork).catch(() => {});
    }
  }

  private async records<T>(name: string, schema: z.ZodType<T>): Promise<Record<string, T>> {
    try { return z.record(z.string(), schema).parse(JSON.parse(await readFile(join(this.deps.config.dataDir, name), "utf8"))); } catch { return {}; }
  }

  private updateRecords<T>(name: string, schema: z.ZodType<T>, update: (records: Record<string, T>) => Record<string, T>): Promise<void> {
    const path = join(this.deps.config.dataDir, name);
    const work = (this.recordWrites.get(path) ?? Promise.resolve()).then(async () => {
      const next = update(await this.records(name, schema));
      const temporary = `${path}.${randomUUID()}`;
      try {
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
    });
    this.recordWrites.set(path, work.catch(() => {}));
    return work;
  }

  private agentForks(): Promise<Record<string, string>> {
    return this.records(AGENT_FORKS, z.string());
  }

  private saveAgentFork(requestId: string, threadId: string): Promise<void> {
    return this.updateRecords(AGENT_FORKS, z.string(), (forks) => ({ ...forks, [requestId]: threadId }));
  }

  /** True when Core confirmed the child. A refusal is final; a network error is retried briefly. */
  private async answerChild(client: CloudroomClient, parent: Binding, id: string, answer: { thread: string } | { error: string }): Promise<boolean> {
    for (let tries = 1; ; tries++) {
      try { await client.answerChild(parent.sessionId!, id, answer); return "thread" in answer; }
      catch (error) {
        if ((error instanceof CloudroomError && (error.status === 404 || error.status === 409)) || tries === 3) {
          this.warn(id.startsWith("fork_") ? "Core did not take a Cloud fork's answer" : "Core did not take a Cloud child's start", error, { threadId: parent.threadId });
          return false;
        }
        await new Promise(resolve => setTimeout(resolve, tries * 1000));
      }
    }
  }

  private catchUpForParent(saved: Binding): boolean {
    const thread = getThread(this.deps.db, saved.threadId);
    const busy = thread !== null && ["pending", "starting", "active", "stopping"].includes(thread.status);
    const tries = this.catchUps.get(saved.threadId) ?? 0;
    if (!busy || tries >= 5 || this.streams.has(saved.threadId) || !this.reportedParent(thread)) return false;
    if (!this.sandboxes.coolingDown(sandboxThread(saved.coreUrl))) this.catchUps.set(saved.threadId, tries + 1);
    return true;
  }

  private follow(saved: Binding, client: CloudroomClient): void {
    if (this.streams.has(saved.threadId) || !saved.sessionId || this.stopped) return;
    // Once per app run and thread: backfills older threads and saves a new thread's session.
    this.syncLabel(saved.threadId);
    const controller = new AbortController();
    this.streams.set(saved.threadId, controller);
    void (async () => {
      let projecting = false;
      let connected = false;
      try {
        for await (const record of client.stream(saved.sessionId!, {
          after: saved.cursor, signal: controller.signal,
          onConnected: async () => {
            connected = true;
            if (controller.signal.aborted) return;
            this.resumeCopy(saved.threadId, client);
            this.setConnectionIssue(saved.threadId, "stream");
            if (saved.error?.startsWith(connectionOrReplayFailed) && !commands(this.deps.db, saved.threadId).some(item => item.state === "sending")) {
              const snapshot = await client.session(saved.sessionId!, controller.signal);
              if (!controller.signal.aborted && snapshot.last_sequence === saved.cursor && binding(this.deps.db, saved.threadId)?.error === saved.error && !commands(this.deps.db, saved.threadId).some(item => item.state === "sending")) {
                saveBinding(this.deps.db, saved.threadId, { error: null });
                this.notify(saved.threadId);
              }
            }
          },
        })) {
          if (controller.signal.aborted) return;
          if ((record.kind === "child" || record.kind === "child_thread") && record.data && typeof record.data === "object" && "id" in record.data && typeof record.data.id === "string") {
            await this.followChild(saved, client, record.data.id).catch((error: unknown) => this.warn("A Cloud child thread could not be shown", error, { threadId: saved.threadId }));
            if (controller.signal.aborted) return;
          }
          if ((record.kind === "child_request" || record.kind === "child_command") && record.sequence > (binding(this.deps.db, saved.threadId)?.cursor ?? 0)) {
            await this.ownSandboxChild(saved, client, record).catch((error: unknown) => this.warn("A Cloud child request failed", error, { threadId: saved.threadId }));
            if (controller.signal.aborted) return;
          }
          if (record.kind === "fork_request" && record.sequence > (binding(this.deps.db, saved.threadId)?.cursor ?? 0)) {
            await this.agentFork(saved, client, record).catch((error: unknown) => this.warn("A Cloud fork request failed", error, { threadId: saved.threadId }));
            if (controller.signal.aborted) return;
          }
          const outage = mentionsOpenAISide401(record) && await codexOutage();
          if (controller.signal.aborted) return;
          projecting = true;
          // The stream replays from the saved cursor, so renames made while the app was offline apply on reconnect.
          if (record.kind === "title") updateThread(this.deps.db, this.deps.hub, saved.threadId, { title: z.object({ title: z.string().min(1) }).parse(record.data).title });
          const effort = record.kind === "reasoning" && z.object({ reasoning: reasoningLevelSchema }).safeParse(record.data);
          if (effort && effort.success) {
            saveBinding(this.deps.db, saved.threadId, { reasoning: effort.data.reasoning });
            setThreadExecutionOverride(this.deps.db, { threadId: saved.threadId, reasoningLevelOverride: effort.data.reasoning });
          }
          const fresh = record.sequence > (binding(this.deps.db, saved.threadId)?.cursor ?? 0);
          const move = fresh && record.kind === "move" && z.object({ project: z.string().min(1) }).safeParse(record.data);
          const ended = fresh ? endedTurn(record) : null;
          const turn = ended ? z.object({ request_id: z.string() }).catch({ request_id: String(record.sequence) }).parse(record.data).request_id : "";
          if (ended) await this.noticeCloudParent(saved.threadId, ended, turn);
          const held = ended && this.teleportingParent(saved.threadId) ? ended : null;
          if (held) await this.holdChildReport(saved.threadId, held, turn);
          const eventTypes = projectRecord(this.deps.db, saved.threadId, record, outage);
          projecting = false;
          this.catchUps.delete(saved.threadId);
          if (held) void this.deliverChildReports();
          else if (ended) this.tellLocalParent(saved.threadId, ended, turn);
          // Agents archive their own thread with `room-cli thread archive --self`; like renames, this applies on reconnect.
          if (record.kind === "archive") this.archiveRequest?.(saved.threadId);
          if (move && move.success) this.moveRequest?.(saved.threadId, move.data.project);
          if (record.kind === "secret_request") this.secrets.follow(client, saved.threadId, record);
          this.setConnectionIssue(saved.threadId, "replay");
          if (record.kind === "rewind") this.deps.hub.notifyThread(saved.threadId, ["history-rewritten"]);
          if (record.kind === "storage_recovered") this.disk.delete(saved.threadId);
          // The agent died for lack of memory (Core sets this); its next turn clears it.
          if (record.kind === "state") {
            const data = record.data as { state?: unknown; out_of_memory?: unknown };
            if (data.out_of_memory === true) this.outOfMemory.add(saved.threadId);
            else if (data.state === "running") this.outOfMemory.delete(saved.threadId);
          }
          if (record.kind === "storage_warning" || record.kind === "storage_pause") this.noteDisk(saved.threadId, client, record.data);
          this.notify(saved.threadId, eventTypes, ["state", "receipt", "native_identity", "storage_warning", "storage_pause", "storage_recovered"].includes(record.kind));
        }
        if (!controller.signal.aborted) {
          const ended = new CloudroomConnectionError("Cloudroom event stream ended");
          this.streamBroke(saved.threadId, ended);
          this.setConnectionIssue(saved.threadId, "stream", ended);
        }
      } catch (error) {
        const sandbox = sandboxThread(saved.coreUrl);
        // Only a stream that could not connect may mean the sandbox slept. A drop after connecting keeps its address,
        // so a sandbox's many agents keep using it instead of checking it again.
        if (sandbox && !connected) this.sandboxes.forget(sandbox);
        if (!controller.signal.aborted) {
          this.streamBroke(saved.threadId, error);
          const phase = !projecting && (connectionFailure(error) || (error instanceof CloudroomError && error.status !== null)) ? "stream" : "replay";
          this.setConnectionIssue(saved.threadId, phase, error);
        }
      } finally { if (this.streams.get(saved.threadId) === controller) this.streams.delete(saved.threadId); }
    })();
  }

  /** Logs why a Cloud thread's stream broke, once per distinct reason, since it reopens every delivery tick. */
  private streamBroke(threadId: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    if (this.streamErrors.get(threadId) === reason) return;
    this.streamErrors.set(threadId, reason);
    this.warn("Cloud thread stream broke", error, { threadId });
  }

  /** What a new thread's project copy does once it lands: the thread's own branch, a fork's or child's code, its start
   *  steps, and the status `room-cli files wait` reads (ADR 0209). A copy an app restart cut off lands the same way. */
  private landing(threadId: string, client: CloudroomClient, started: Parameters<typeof landForkCode>[1] | null, files: boolean, workspace: string | null, marked: Promise<void> | null): Landed {
    const land = async (error?: string, current = client, partial?: string) => {
      if (files) this.progress(threadId, [{ key: "files", status: error ? "failed" : "completed" }]);
      const finish = async (failure?: string | null) => {
        if (marked && workspace) await marked.then(() => this.filesState(current, threadId, workspace, failure ? `failed: ${failure}` : "ready"));
      };
      const missing = error ?? partial;
      if (!started?.code) {
        await Promise.all([this.ensureBranch(threadId, true), finish(missing)]);
        return;
      }
      // A fork's branch then moves to its source's code, so the agent sees what the source saw.
      await this.ensureBranch(threadId, true);
      const failure = await landForkCode(current, started);
      // A child folder with no Git gets its repository only now, on a cloudroom/ branch: rename it to its room/ one
      // before the agent goes on.
      if (!failure) await this.ensureBranch(threadId, false);
      this.progress(threadId, [{ key: "fork", status: failure ? "failed" : "completed" }]);
      await finish(failure ?? missing);
    };
    return (error, current, partial) => land(error, current, partial).catch(failure => this.warn("Cloud project copy did not land", failure, { threadId }));
  }

  /** Copies a new thread's project. If its sandbox sleeps or drops mid-copy (say, the usage cap paused it), the copy waits
   *  and restarts on the thread's next connection, up to 3 times, instead of failing. */
  private copy(client: CloudroomClient, job: ProjectCopyJob, landed: Landed, after?: Promise<void>, tries = 0): void {
    copyProject(this.deps, client, job, (error, partial) => {
      // A copy that falls short shows no error card, so the log is where we see how often it happens.
      if (error ?? partial) this.warn("Cloud project copy fell short", error ?? partial, { threadId: job.threadId });
      return landed(error, client, partial);
    }, after, tries < 3 ? () => {
      this.pausedCopies.set(job.threadId, { job, landed, tries: tries + 1 });
      // Reconnecting finds the sandbox's new address, or that it sleeps; the copy resumes once a stream connects.
      this.detach(job.threadId);
    } : undefined);
  }

  /** "Try again" on a failed project copy: plans it again from the thread's first message, so it also works after a restart. */
  /** Moves a VPS thread to Cloud (ADR 0319), when its VPS runs low. */
  async moveToCloud(threadId: string): Promise<void> {
    const sandbox = sandboxThread(binding(this.deps.db, threadId)?.coreUrl ?? "");
    if (!sandbox) throw new ApiError(409, "cloudroom_unsupported", "Only Cloud threads can move to Cloud.");
    await this.sandboxes.move(sandbox);
  }

  async retryCopy(threadId: string): Promise<void> {
    const saved = binding(this.deps.db, threadId);
    const input = command(this.deps.db, `first_${threadId}`)?.input;
    const workspace = copyWorkspace(input);
    if (!saved?.sessionId || !workspace) throw new ApiError(409, "cloudroom_no_project_copy", "This thread has no project to copy.");
    const client = await this.client(saved);
    const job = await planProjectCopy(this.deps, client, threadId, workspace, { key: copyKey(sandboxThread(saved.coreUrl), workspace), branch: baseBranch(input) });
    if (!job) throw new ApiError(409, "cloudroom_no_project_copy", "Nothing is left to copy, or a copy is already running.");
    this.copyInto(client, job);
  }

  /** Plans a copy the last app run cut off again, once the thread's stream connects (#106). An empty folder gets the copy
   *  and branch a new thread gets, but no fork's or child's code, which would replace whatever the agent did meanwhile:
   *  the agent is told. A folder that already has files may hold the agent's work, so it only gets missing `.env` files,
   *  and the copy ends as cut short. */
  private async resumeCutCopy(threadId: string, client: CloudroomClient): Promise<void> {
    const saved = binding(this.deps.db, threadId);
    const input = command(this.deps.db, `first_${threadId}`)?.input;
    const workspace = copyWorkspace(input);
    if (!saved?.sessionId || !workspace) {
      reportProjectCopy(this.deps, threadId, { phase: "complete", completed: 0, total: 0 });
      return;
    }
    this.retrying.add(threadId);
    try {
      // A sandbox that can't be reached, or a folder another copy is filling, throws, so the copy waits for the next connection.
      const job = await planProjectCopyOrThrow(this.deps, client, threadId, workspace, { key: copyKey(sandboxThread(saved.coreUrl), workspace), branch: baseBranch(input) });
      // A move, or another copy, that started meanwhile brings its own.
      if (this.copyBusy(threadId) || copyWorkspace(command(this.deps.db, `first_${threadId}`)?.input) !== workspace) return;
      if (job && (job.clone || job.copyAll)) {
        // Only a first copy cut off before its fork's or child's code landed lost that code; a move's or a retry's never had it.
        const lost = startStepRunning(this.deps.db, threadId, "fork") ? "The app restarted while copying the source thread's code, so it was not copied." : undefined;
        if (lost) this.progress(threadId, [{ key: "fork", status: "failed" }]);
        const landed = this.landing(threadId, client, null, true, workspace, this.filesState(client, threadId, workspace, "copying"));
        this.copy(client, job, (error, current, partial) => landed(error, current, lost ?? partial));
        return;
      }
      reportProjectCopy(this.deps, threadId, { phase: "complete", completed: 0, total: 0 });
      this.progress(threadId, [], "failed");
      if (job) this.copyInto(client, job);
      else void this.filesState(client, threadId, workspace, `failed: ${CUT_SHORT}`, true);
    } finally { this.retrying.delete(threadId); }
  }

  /** A copy runs, or a move or Teleport brings its own, so no other may start. */
  private copyBusy(threadId: string): boolean {
    return copyRunning(threadId) || this.switching.has(threadId) || teleportBlocked(this.deps.db, threadId) || localTeleports.has(threadId);
  }

  /** A folder that already has files gets only its `.env` files again, so a copy cut short stays failed, never ready. */
  private copyInto(client: CloudroomClient, job: ProjectCopyJob, done?: () => void): void {
    const full = job.clone || job.copyAll;
    const marked = full ? this.filesState(client, job.threadId, job.workspace, "copying") : Promise.resolve();
    this.copy(client, job, (error, current = client, partial) => marked.then(() => this.filesState(current, job.threadId, job.workspace,
      error ?? partial ? `failed: ${error ?? partial}` : full ? "ready" : `failed: ${CUT_SHORT}`, !full)).then(done));
  }

  private filesState(client: CloudroomClient, threadId: string, workspace: string, state: string, onlyIfCopying = false): Promise<void> {
    return writeFilesState(client, workspace, state, onlyIfCopying)
      .catch(error => this.warn("Could not save the project copy state for `room-cli files wait`", error, { threadId }));
  }

  private resumeCopy(threadId: string, client: CloudroomClient): void {
    const paused = this.pausedCopies.get(threadId);
    // After an app restart only the saved phase is left (`pauseCutCopy`), so the copy is planned again.
    if (!paused) {
      if (projectCopyProgress(this.deps.db, threadId)?.phase === "waiting" && !this.retrying.has(threadId) && !this.copyBusy(threadId))
        void this.resumeCutCopy(threadId, client).catch(error => this.warn("Cloud project copy did not resume", error, { threadId }));
      return;
    }
    this.pausedCopies.delete(threadId);
    this.copy(client, paused.job, paused.landed, undefined, paused.tries);
  }

  /** A copy the last app run cut off before it landed waits as paused, and resumeCopy plans it again once the thread's
   *  stream connects (#106). A copy still running in this app, or Teleport's own, is left alone. */
  private pauseCutCopy(threadId: string): void {
    const phase = projectCopyProgress(this.deps.db, threadId)?.phase;
    if ((phase === "cloning" || phase === "uploading") && !copyRunning(threadId) && copyWorkspace(command(this.deps.db, `first_${threadId}`)?.input))
      reportProjectCopy(this.deps, threadId, { phase: "waiting", completed: 0, total: 0 });
  }

  private setConnectionIssue(threadId: string, phase: ConnectionPhase, error?: unknown): void {
    const issues = this.connectionIssues.get(threadId) ?? {};
    const previous = issues[phase];
    const vmShutDown = (error instanceof CloudroomConnectionError && error.message.includes("unexpected redirect") || error instanceof ApiError && error.body.code === "cloudroom_sandbox_only") && !sandboxThread(binding(this.deps.db, threadId)?.coreUrl ?? "");
    const issue = error === undefined ? undefined : vmShutDown ? { message: retiredVmMessage, reconnecting: false } : {
      message: phase === "replay" && !(error instanceof CloudroomError) ? `Cloudroom history could not be restored: ${error instanceof Error ? error.message : String(error)}` : publicError(error),
      reconnecting: phase !== "replay" && connectionFailure(error),
    };
    if (previous && !previous.reconnecting && issue?.reconnecting) return;
    if (previous?.message === issue?.message && previous?.reconnecting === issue?.reconnecting) return;
    if (issue) issues[phase] = issue;
    else delete issues[phase];
    if (Object.keys(issues).length) this.connectionIssues.set(threadId, issues);
    else this.connectionIssues.delete(threadId);
    if (issue) {
      const saved = binding(this.deps.db, threadId);
      this.deps.logger?.warn({
        threadId, sessionId: saved?.sessionId, cursor: saved?.cursor, phase, ...issue,
        errorType: error instanceof CloudroomError ? error.name : error instanceof z.ZodError ? "ZodError" : error instanceof ApiError ? "ApiError" : error instanceof DOMException && error.name === "AbortError" ? "AbortError" : "Error",
        status: error instanceof CloudroomError ? error.status : null,
        code: error instanceof CloudroomError ? error.code : null,
        networkCode: error instanceof CloudroomConnectionError ? error.networkCode : null,
      }, "Cloudroom connection state changed");
    }
    this.notify(threadId);
  }

  // Status patches one sidebar row. Queue and list refreshes go out only when the queue really changed.
  private notify(threadId: string, eventTypes: ThreadEventType[] = [], stateChanged = true): void {
    const thread = getThread(this.deps.db, threadId);
    if (!thread) return;
    const changes: ThreadChangeKind[] = [
      ...(eventTypes.length ? ["events-appended" as const] : []),
      ...(stateChanged ? ["status-changed" as const] : []),
      ...(stateChanged && this.queueChanged(threadId) ? ["queue-changed" as const] : []),
    ];
    if (!changes.length) return;
    this.deps.hub.notifyThread(threadId, changes, {
      ...(stateChanged ? buildThreadStatusChangeMetadata(this.deps, thread) : {}),
      ...(eventTypes.length ? { eventTypes } : {}),
    });
  }

  private queueChanged(threadId: string): boolean {
    let queue: string;
    try { queue = JSON.stringify(this.queue(threadId)); } catch { return true; }
    if (this.sentQueues.get(threadId) === queue) return false;
    this.sentQueues.set(threadId, queue);
    return true;
  }
}
