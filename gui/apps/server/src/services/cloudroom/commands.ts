import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, stat, rename, rm } from "node:fs/promises";
import { join, win32 } from "node:path";
import { and, desc, eq, gt, inArray, isNull, max, notInArray, sql } from "drizzle-orm";
import { createThread, findLastCompletedRootStoredTurn, getAppSettings, getProject, getThread, getThreadExecutionOverride, setThreadExecutionOverride, updateThread, cloudroomThreads, cloudroomCommands, events, threads, type DbConnection, type DbQueryConnection, type DbTransaction } from "@cloudroom/db";
import { PERSONAL_PROJECT_ID, cloudLoginName, cloudLoginProvider, type CloudLoginProvider, rawThreadIdSchema, encodeClientTurnRequestIdNumber, isStandaloneBuiltinCompactCommand, promptInputSchema, reasoningLevelSchema, reconcileReasoningLevel, defaultReasoningLevel, threadQueuedMessageSchema, type Thread, type PromptInput, type ThreadEventType, type ThreadEventTurnStatus, type ThreadChangeKind, type ReasoningLevel, COMPUTER, COMPUTER_TITLE } from "@cloudroom/domain";
import type { CreateThreadRequest, ForkThreadRequest, SendMessageRequest, SendMessageResponse } from "@cloudroom/server-contract";
import { z } from "zod";
import { findCliExecutable } from "@cloudroom/process-utils";
import { ApiError } from "../../errors.js";
import { firstAgentThreadId } from "../system/first-agent.js";
import { CloudroomClient, CloudroomConnectionError, CloudroomError, UPLOAD_PART, authRequiredMessages, type CodexAuthStatus, type SessionRecord, type VmRun, type VmRunResult } from "./client.js";
import { CLOUD_HARNESSES, HARNESS_NAMES, appendStartProgress, endedTurn, projectShown, sessionHarness, type EarlierSession, isAcpProvider, isCloudProvider, projectFollowUp, projectInitialPrompt, projectRecord, projectRecords, recordSaving, retractStillQueuedPrompts, STREAM_BATCH_MAX_RECORDS, STREAM_BATCH_MS, startStepRunning, type CloudProvider, type StartStep } from "./events.js";
import { mentionsOpenAISide401 } from "./codex-errors.js";
import { codexOutage } from "./openai-status.js";
import { buildThreadStatusChangeMetadata } from "../threads/thread-runtime-display.js";
import { cloudPluginInstructions, cloudroomSystemPrompt, dueCustomInstructions, markCustomInstructionsLost, prepareCloudInstructionInput, resolveCustomInstructions } from "../threads/custom-instructions.js";
import { TIMED_OUT, baseBranch, binding, bindings, command, commands, coreInUse, localTeleports, openBindings, queuedPrompts, saveBinding, saveCommandState, saveStatus, effectivePrompt, projectCopyProgress, stampBindings, teleportBlocked, unstartedTurn, type Binding, type Command, type OpenBinding, isDead, statusOf } from "./store.js";
import { syncLoopEnv } from "./project-loops.js";
import { copyProject, copyRunning, keyCopying, githubRepository, localFilesNote, localProjectNote, localProjectPath, planNewProjectCopy, workspaceId, workspaceName, planProjectCopy, planProjectCopyOrThrow, reportProjectCopy, retry, writeFilesState, type ProjectCopyJob } from "./project-copy.js";
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
import { pruneThreadEventHistory } from "../system/event-pruning.js";
import { saveCloudImages } from "./teleport-local.js";
import { cliPlace, reportAgentConnect, reportMacHelperDown, reportMacHelperProblem } from "./setup-telemetry.js";
import { cloudSkills, copyLogins, copyMacGithub, copyMacLogin, importCodexLogin, importPiLogin, loginMarkers, macPiSetup, markLogin, setCopyMacLogin, setupSync, skillInCloud, stopSync, syncStatus } from "./sync.js";
import { macClaudeSignedIn } from "./claude-token.js";
import { helperRunning, macAccess, macAccessSupported, noteWake, previewsSetUp, setupPreviews, stopPreviews, previewStatus } from "./previews.js";
import { GpuApprovals } from "./gpu.js";
import { CloudSecrets } from "./secrets.js";
import { CodexAccounts } from "./codex-accounts.js";
import { BUDGET_LIMIT, cancelMacCodexLogin, hasMacCodexLogin, macCodexDigest, macCodexLogin, macCodexLoginExpired, cursorKeyRejected, macCursorLogin, revokeDesktopToken, startMacCodexLogin, CLOUD_REGION, SANDBOX_PREFIX, SandboxAsleep, SandboxDirectory, sandboxThread, startRefused, type AutomationRun, type SandboxProject, type SandboxTrigger, type SandboxWakeTrigger } from "./sandboxes.js";
import type { AppDeps, LoggedWorkSessionDeps } from "../../types.js";
import { markMinutesSent, unsentMinutes } from "./time-in-app.js";
import { cloudTurnsElsewhere, emitPluginThreadCreated } from "../plugins/plugin-thread-events.js";
import { appRequestId, CloudThreadStates, installTag, sharedChildId, tagOf, type CloudThreadState } from "./cloud-threads.js";
import { CloudSync } from "./cloud-sync.js";
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
  resume_keep_paused: z.boolean().default(false),
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
  credits_usage: z.boolean().default(false),
  subagents: z.boolean().default(false),
  long_prompts: z.boolean().default(false),
  cloud_threads: z.boolean().default(false),
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
    /** Claude switches models in its session (`POST …/model`), as on Local; the others start a new session (ADR 0211). */
    set_model: z.boolean().default(false),
  })),
});
/** A queued model pick (changeModel), with what the thread ran before it for when Core doesn't take it. */
const modelPickSchema = z.object({ model: z.string(), reasoning: z.string(), before: z.object({ model: z.string(), reasoning: z.string(), override: reasoningLevelSchema.nullable() }) });
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
/** "Clear caches & builds" on a full Cloud disk: package-manager caches (Core's npm cache too, never `_npx`, which holds
 *  running tools), plus Git-ignored dependency and build folders in each repository. Build folders holding a `.env*` file
 *  or another repository are skipped. Everything moves to one trash folder first, an instant rename, and is deleted last,
 *  so a resuming agent never sees a half-deleted folder. Prints the bytes freed. */
const CLEAR_DISK = String.raw`avail() { df -B1 --output=avail "$HOME" | tail -1; }
before=$(avail)
trash="$HOME/.cache/cloudroom-trash"
rm -rf "$trash" && mkdir -p "$trash" || exit 1
dev=$(stat -c %d "$trash")
bin() {
  [ -e "$1" ] || return 0
  if [ "$(stat -c %d -- "$1")" = "$dev" ] && d=$(mktemp -d "$trash/XXXXXX") && mv -- "$1" "$d/x"; then :; else rm -rf -- "$1"; fi
}
cache=$(sed -n 's/.*"cache_dir":"\([^"]*\)".*/\1/p' /etc/cloudroom/storage.json 2>/dev/null)
[ -n "$cache" ] && bin "$cache/npm/_cacache"
for c in ~/.npm/_cacache ~/.cache/pip ~/.cache/uv ~/.cache/yarn ~/.cache/pnpm ~/.cache/go-build ~/.cache/node-gyp ~/.local/share/pnpm/store ~/.bun/install/cache; do bin "$c"; done
for repo in /code/*/ /repos/*/; do
  [ -e "$repo.git" ] || continue
  git -C "$repo" ls-files -z --others --ignored --exclude-standard --directory 2>/dev/null | while IFS= read -r -d '' path; do
    case "$path" in */) ;; *) continue ;; esac
    dir="$repo$path"
    case "$(basename "$path")" in
      node_modules) bin "$dir" ;;
      .next|.nuxt|.svelte-kit|.turbo|.parcel-cache|.vite|dist|build|target|__pycache__|.pytest_cache|.mypy_cache|.ruff_cache|coverage|.gradle)
        [ -z "$(find "$dir" \( -name '.env*' -o -name .git \) -print -quit 2>/dev/null)" ] && bin "$dir" ;;
    esac
  done
done
rm -rf "$trash"
sync -f "$HOME" 2>/dev/null
echo $(( $(avail) - before ))`;
const ROOT_WORKSPACE = "root";
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
// A request its sandbox did not answer in time, or turned away for now.
const slowSandbox = (error: unknown) => error instanceof Error && error.message === TIMED_OUT || error instanceof CloudroomError && error.retryable;
const CUT_SHORT = "The project copy was cut short, so some files may be missing.";
const COPY_DEADLINE = 9 * 60_000;
const STALLED = `The project copy did not finish in ${COPY_DEADLINE / 60_000} minutes, so some files may be missing.`;
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
        // Project and folder tags stay as plain text too, like local threads; workspace paths are relative to the sandbox's project copy (#1253).
        if (resource.kind === "project" || (resource.kind === "path" && resource.source === "workspace")) continue;
        // `/context` stays plain text; Claude Code runs it as its own command.
        if (harness === "claude-code" && resource.kind === "command" && resource.source === "command" && resource.origin === "builtin" && resource.name === "context") continue;
        if (resource.kind !== "command" || resource.source !== "skill") throw new ApiError(400, "cloudroom_unsupported", "Cloud supports skill, thread, project, and folder tags, but other mentions and commands are not enabled.");
        if (!resource.name || /\s/.test(resource.name) || start >= end || end > part.text.length || part.text.slice(start, end) !== `/${resource.name}`) throw new ApiError(400, "invalid_request", "The selected skill tag is invalid. Remove it and select the skill again.");
        skills.push({ name: resource.name, chunk, start, end });
      }
      continue;
    }
    if (!attachmentsEnabled) throw new ApiError(400, "cloudroom_unsupported", "Cloud attachments are not enabled.");
    if (part.type !== "localImage" && part.type !== "localFile") throw new ApiError(400, "cloudroom_unsupported", "Cloud attachments must be uploaded files.");
    if (typeof attachmentsEnabled === "object" && !(part.type === "localImage" ? attachmentsEnabled.images : attachmentsEnabled.files)) throw new ApiError(400, "cloudroom_unsupported", "This attachment type is not enabled for the cloud harness.");
    attachments.push({
      name: (process.platform === "win32" ? win32.basename(part.path) : part.path.split("/").pop()) || "attachment",
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

function reasoningLevels(harness: string, model: string, capabilities: Capabilities): string[] | undefined {
  const profile = harnessProfile(capabilities, harness);
  // Claude runs exact models its catalog omits, such as claude-opus-5-5[1m]; core allows any VM level (ADR 0133),
  // and `none`, which runs any model without an effort override (#1059).
  const anyLevel =
    harness === "claude-code"
      ? [
          ...new Set([
            "none",
            ...(profile?.models ?? []).flatMap((item) => item.reasoning_levels),
          ]),
        ]
      : undefined;
  return profile?.models ? (profile.models.find((item) => item.model === model)?.reasoning_levels ?? anyLevel) : profile?.reasoning_levels;
}

/** The model's own catalog row takes no effort, such as Claude's Haiku (#1059). */
function takesNoEffort(
  capabilities: Capabilities | null,
  harness: string,
  model: string | null | undefined,
): boolean {
  const row =
    capabilities && model
      ? harnessProfile(capabilities, harness)?.models?.find(
          (item) => item.model === model,
        )
      : undefined;
  return row?.reasoning_levels.join() === "none";
}

function validateReasoning(harness: string, model: string, reasoning: string, capabilities: z.infer<typeof capabilitiesSchema>): void {
  const profile = harnessProfile(capabilities, harness);
  if (profile?.models === null) throw new ApiError(503, "model_catalog_unavailable", "Cloud model discovery is unavailable. Try again when the cloud harness is ready.");
  const levels = reasoningLevels(harness, model, capabilities);
  if (profile?.models && !levels) {
    const name = HARNESS_NAMES[harness as CloudProvider] ?? harness;
    const offers = profile.models.slice(0, 4).map((item) => item.model).join(", ");
    const claudeHint = harness !== "claude-code" && model.startsWith("claude") ? " Use the claude-code provider for Claude." : "";
    throw new ApiError(400, "invalid_model", `${model} is not a ${name} model on Cloud.${offers ? ` ${name} offers ${offers}.` : ""}${claudeHint}`);
  }
  if (!levels?.includes(reasoning))
    throw new ApiError(
      400,
      "invalid_reasoning_effort",
      `This reasoning level is unavailable for the cloud model.${levels?.length ? ` ${model} supports: ${levels.join(", ")}.` : ""} Select a supported level.`,
    );
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

/** Why Cloud refused a prompt, for its `turn_failed` event: Core's code, or the HTTP status when the app knows no code. */
function refusal(error: unknown): { code: string | null; message: string } {
  const code = error instanceof CloudroomError ? error.code ?? (error.status === null ? null : `http_${error.status}`) : error instanceof ApiError ? error.body.code : null;
  return { code, message: publicError(error) };
}

/** A sandbox put to sleep or stopped answers at its saved address with a 404 (Upstash, Vercel removed) or 410 (Vercel
 *  stopped) and no Cloudroom code: the address is stale, not a refusal (feedback #596). */
function staleSandboxAddress(error: unknown): boolean {
  return error instanceof CloudroomError && (error.status === 404 || error.status === 410) && !error.code;
}
/** How often a stale address is forgotten and its sandbox woken again before the command fails (#596, #1076). */
const STALE_REWAKES = 3;
/** Plain words for a sandbox that stayed stale: never the vendor's own 404 text (#317, ADR 0146). */
const unreachableSandbox = "Its cloud sandbox could not be reached, even after waking it again.";

function connectionFailure(error: unknown): boolean {
  return error instanceof CloudroomConnectionError
    || (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof CloudroomError && error.status !== null && (error.status >= 500 || error.status === 408 || error.status === 429));
}

/** Core refuses work for a few seconds while its sandbox goes to sleep, restarts, or wakes. The next try gets through,
 *  so the thread shows "Reconnecting…" after the usual wait, never a red error (a Metal sandbox sleeps a minute after
 *  work stops, so a message often lands mid-sleep). */
function sandboxTransition(error: unknown): boolean {
  return error instanceof CloudroomError && ["service_stopping", "service_draining", "session_waking"].includes(error.code ?? "");
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
/** How a child the website started names its first request: `sub_` and a hash (web/lib/cloud-start.ts spawnChild). */
const WEBSITE_CHILD = "sub_";
const childReportSchema = z.object({ child: z.string(), status: z.string(), turn: z.string() });
const AGENT_FORK_WAIT = 90_000;
/** A record Core made within the last 90 s: an agent waits that long for its fork's or child's answer. */
/** Prompts Core or a loop queues for itself, which a Teleport may leave behind: loop runs, Core's child notices and
 *  tasks, its own continue after a usage limit, and Teleport's handoff (core/src/session, web/lib/automations.ts). */
const CORE_OWN = /^(auto_|notice_|task_|continue_|teleport_)/;
/** Core session states that mean an agent is working or about to (core/src/session/state.rs). */
const WORKING = ["pending", "waiting_for_files", "starting", "resuming", "starting_turn", "running", "interrupting", "rewinding"];
/** The session a session continues (Core's `continued` record, an agent switch or move elsewhere). */
const continuedFrom = (records: SessionRecord[]) => z.object({ from: z.string().regex(/^cr_[A-Za-z0-9_-]{1,80}$/) }).safeParse(records.find((record) => record.kind === "continued")?.data).data?.from;
const young = (record: SessionRecord) => record.timestamp_ms === undefined || Date.now() - record.timestamp_ms <= AGENT_FORK_WAIT;
/** What a label sends to a website that follows threads (#237): only the change made here. A new session's first
 *  stream sends all of it once, and every later run only fills the session. `switch` is an older Core's switch. */
type LabelChange = "start" | "backfill" | "title" | "model" | "parent" | "project" | "switch";
const LABEL_FIELDS: Record<LabelChange, string[]> = {
  start: ["title", "project_name", "project", "session", "harness", "model", "parent"], backfill: ["session"], title: ["title"],
  model: ["harness", "model"], parent: ["parent"], project: ["project", "project_name"], switch: [],
};

/** The sandbox whose API keys a new Cloud child or fork gets, saved with its first message (keyFields). */
const keySourceOf = (input: string | undefined) => input ? z.object({ key_source: z.string().optional() }).safeParse(JSON.parse(input)).data?.key_source : undefined;

/** Commands that make the agent run. A goal's pause or clear doesn't. */
const startsWork = (item: Command) => ["prompt", "steer", "resume", "compact", "rewind"].includes(item.command)
  || (item.command === "goal" && JSON.parse(item.input).status !== "paused" && !JSON.parse(item.input).clear);
/** Unsent commands that need Core now. A stop left for a sleeping sandbox (#553) waits for its next wake, and until then
 *  only work that runs the agent wakes it: queue edits, reorders and the like wait with the stop. */
const unsentWork = (db: DbQueryConnection, threadId: string) => {
  const unsent = commands(db, threadId).filter(c => c.state === "sending");
  const stopped = unsent.some(c => c.command === "stop");
  return unsent.some(c => c.command !== "stop" && c.command !== "model" && (!stopped || startsWork(c)));
};

/** Threads made by importing old chats. They are not agents the user started (ADR 20261102-073449). */
export const importedThreadIds = async (deps: Pick<AppDeps, "config">): Promise<string[]> => [...new Set((await Promise.all(["session-imports.json", "bb-imports.json"].map((name) =>
  readFile(join(deps.config.dataDir, name), "utf8").then((text) => Object.values(JSON.parse(text) as Record<string, string>), () => [])))).flat())];

class CloudroomService {
  teleportRecovery?: () => void;
  /** Main's archive of a thread and its idle children; `websiteHasIt`: the website already has this thread archived. */
  archiveRequest?: (threadId: string, liveThreadIds?: string[], websiteHasIt?: boolean) => void;
  private readonly heldStarts = new Set<string>();
  childTurnEnded?: (child: Thread & { parentThreadId: string }, status: ThreadEventTurnStatus) => void;
  moveRequest?: (threadId: string, project: string) => void;
  // Kept per thread: teleports run at the same time, and one shared value gave threads each other's sandboxes.
  private readonly teleportUrls = new Map<string, string>();
  /** The core a thread's teleport picked, saved as its binding. */
  teleportUrl(threadId: string): string { return this.teleportUrls.get(threadId) ?? ""; }
  async teleportClient(threadId?: string, trigger?: SandboxWakeTrigger): Promise<CloudroomClient> {
    const existing = threadId ? binding(this.deps.db, threadId) : null;
    const sandbox = existing ? sandboxThread(existing.coreUrl) : threadId && await this.newThreadsInSandboxes() ? threadId : null;
    if (sandbox) {
      // Teleported threads get their own sandbox too; this wakes it for the transfer.
      const coreUrl = SANDBOX_PREFIX + sandbox;
      if (threadId) this.teleportUrls.set(threadId, coreUrl);
      return this.client({ coreUrl } as Binding, true, trigger);
    }
    const connection = await this.connection();
    const saved = threadId ? binding(this.deps.db, threadId) : null;
    if (saved && saved.coreUrl !== connection.url) throw new ApiError(409, "cloudroom_connection_changed", "Restore this transfer's original cloud connection before continuing.");
    if (threadId) this.teleportUrls.set(threadId, connection.url);
    return new CloudroomClient(connection);
  }
  async threadClient(threadId: string, wake = true, trigger?: SandboxWakeTrigger): Promise<CloudroomClient> {
    const saved = binding(this.deps.db, threadId);
    if (!saved) throw new ApiError(409, "cloudroom_thread_unstarted", "This cloud thread has not started yet.");
    return this.client(saved, wake, trigger);
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
    // A Cloud thread streams here only while it's open on a screen here, a turn this computer sent runs, or this
    // computer acts for it (home). A computer is home for every thread only it prompts (docs/scopes/cloud-threads.md App 4).
    // A thread shown running streams until its turn ends, so no computer is left showing it running for good.
    if (!this.deps.hub.watching(row.threadId) && !this.isHome(row.threadId) && !["pending", "starting", "active", "stopping"].includes(row.status)) {
      if (live) this.detach(row.threadId);
      return false;
    }
    if (!live && ["pending", "starting", "active", "stopping"].includes(row.status)) return true;
    const sandbox = sandboxThread(row.coreUrl);
    if (!live && sandbox && this.slept.get(row.threadId) === this.sandboxes.awakeChecks && !this.sandboxes.isAwake(sandbox)) {
      if (sandbox === row.threadId && this.deps.hub.watching(row.threadId)) this.readHistory(row.threadId);
      return false;
    }
    if (sandbox && sandbox !== row.threadId && !row.parentThreadId && this.leftParent.get(row.threadId) !== row.sessionId) return true;
    return !live;
  }
  /** Session and cursor each opened thread's history was last read to, "reading" while one read runs, or when a
   *  failed read may be tried again. */
  private readonly histories = new Map<string, string>();
  /** An opened thread whose sandbox sleeps reads its history from the website, never waking it (#237). It's shown only:
   *  the thread's state notes where its jobs stood, and the stream that follows starts there and acts on it. */
  private readHistory(threadId: string): void {
    const saved = binding(this.deps.db, threadId), session = saved?.sessionId, at = `${session}:${saved?.cursor}`, last = this.histories.get(threadId);
    if (!saved || !session || last === at || last === "reading" || (last?.startsWith("retry:") && Date.now() < Number(last.slice(6)))) return;
    this.histories.set(threadId, "reading");
    void (async () => {
      let reached = at;
      try {
        if (!await this.sandboxes.followsThreads().catch(() => false)) return;
        for (let page = await this.sandboxes.records(threadId, session, saved.cursor), first = true; ; first = false) {
          if (first && saved.cursor === 0 && !this.shown(threadId)) await this.earlierSessions(threadId, continuedFrom(page.records));
          const current = binding(this.deps.db, threadId);
          if (!current || current.sessionId !== session || this.streams.has(threadId)) return;
          const state: CloudThreadState = this.threadStates.get(threadId) ?? { ...this.firstState(threadId), session, actFrom: 0 };
          // The last shown record a job may act on (deltas, usage and items have none): the stream owes up to it.
          const until = Math.max(-1, ...page.records.filter((record) => recordSaving(record) === "alone").map((record) => record.sequence));
          const history = state.history?.session === session ? state.history : until >= 0 ? { session, from: current.cursor } : undefined;
          if (history && until >= (history.until ?? -1)) this.threadStates.set(threadId, { ...state, history: { ...history, until } });
          const eventTypes = page.records.length ? projectShown(this.deps.db, threadId, page.records).types : [];
          if (eventTypes.length) this.notify(threadId, [...new Set(eventTypes)], false);
          reached = `${session}:${binding(this.deps.db, threadId)?.cursor}`;
          if (!page.more || !page.records.length) break;
          page = await this.sandboxes.records(threadId, session, binding(this.deps.db, threadId)!.cursor);
        }
      } catch (error) {
        this.warn("A Cloud thread's history could not be read", error, { threadId });
        reached = `retry:${Date.now() + 10_000}`;
      } finally { this.histories.set(threadId, reached); }
    })();
  }
  /** Whether any of the thread's history is shown here yet. */
  private shown(threadId: string): boolean {
    return Boolean(this.deps.db.select({ id: events.id }).from(events).where(eq(events.threadId, threadId)).limit(1).get());
  }
  /** One load of earlier sessions per thread at a time: a wake while it reads joins it instead of adding them twice. */
  private readonly earlier = new Map<string, Promise<void>>();
  /** A thread nothing is shown of here yet, whose session continues earlier ones (a switch or move made elsewhere),
   *  shows their history first: up to 5 sessions, oldest first, from the website's saved records (#237, App 4). */
  private earlierSessions(threadId: string, from: string | undefined): Promise<void> {
    if (!from) return Promise.resolve();
    let load = this.earlier.get(threadId);
    if (!load) {
      load = this.loadEarlier(threadId, from).finally(() => this.earlier.delete(threadId));
      this.earlier.set(threadId, load);
    }
    return load;
  }
  private async loadEarlier(threadId: string, from: string): Promise<void> {
    if (this.shown(threadId)) return;
    const chain: { session: string; first: { records: SessionRecord[]; more: boolean } }[] = [];
    for (let session: string | undefined = from; session && chain.length < 5 && !chain.some((item) => item.session === session);) {
      const first = await this.sandboxes.records(threadId, session, 0);
      chain.unshift({ session, first });
      session = continuedFrom(first.records);
    }
    if (this.shown(threadId)) return;
    for (const { session, first } of chain) {
      // Each session with its own agent, and where its last page left off.
      let earlier: EarlierSession = { session, after: 0, nativeId: null, turnId: null, harness: sessionHarness(first.records) };
      for (let page = first; page.records.length;) {
        const shown = projectShown(this.deps.db, threadId, page.records.filter((record) => record.session_id === session && record.sequence > earlier.after), earlier);
        if (shown.types.length) this.notify(threadId, [...new Set(shown.types)], false);
        earlier = { ...shown.earlier ?? earlier, after: Math.max(shown.earlier?.after ?? 0, page.records.at(-1)!.sequence) };
        if (!page.more) break;
        page = await this.sandboxes.records(threadId, session, earlier.after);
      }
    }
  }
  private readonly slept = new Map<string, number>();
  private asleep(threadId: string): void {
    this.slept.set(threadId, this.sandboxes.awakeChecks);
    this.detach(threadId);
    const thread = getThread(this.deps.db, threadId), status = thread?.status;
    if (thread && status && status !== "idle" && status !== "error" && !commands(this.deps.db, threadId).some(c => c.state === "sending")) {
      // Last heard from over 6 days ago: the website may have archived the sandbox as an old run, not as a finished one.
      if (Date.now() - thread.updatedAt < 6 * 86_400_000) this.cutOff.set(threadId, 0);
      saveStatus(this.deps.db, threadId, "idle");
      this.notify(threadId);
    }
    if (this.cutOff.has(threadId)) void this.endedElsewhere(threadId);
  }
  /** Threads whose running turn this app saw cut off when their sandbox stopped, with the lookups made since. */
  private readonly cutOff = new Map<string, number>();
  /** A turn was running here, then its sandbox was gone: this computer slept or was offline while the thread ended, so
   *  the rest of its stream never came, and with it the agent's own `room-cli thread archive --self`. The website
   *  archives the sandbox of a Loop run whose agent archived it, so an archived sandbox means the thread is done, here
   *  or on another device: archive it here too, instead of leaving it open and idle for good. One lookup per cut-off
   *  turn, and again after each awake-list check while the sandbox is still stopping, 5 at most. */
  private async endedElsewhere(threadId: string): Promise<void> {
    const tries = (this.cutOff.get(threadId) ?? 0) + 1;
    this.cutOff.set(threadId, tries);
    const state = sandboxThread(binding(this.deps.db, threadId)?.coreUrl ?? "") === threadId ? await this.sandboxes.state(threadId).catch(() => "awake" as const) : null;
    if (state === "archived") this.archiveRequest?.(threadId);
    if (state !== "awake" || tries >= 5) this.cutOff.delete(threadId);
  }
  private readonly switching = new Set<string>();
  private readonly sends = new Map<string, number>();
  private readonly streams = new Map<string, AbortController>();
  private readonly streamErrors = new Map<string, string>();
  private readonly connectionIssues = new Map<string, Partial<Record<ConnectionPhase, ConnectionIssue>>>();
  private readonly sentQueues = new Map<string, string>();
  /** The last Stop receipt seen per thread, for the queue's "paused by Stop" label only (#967). */
  private readonly stops = new Map<string, { session: string; at: number }>();
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
  private previewFailures = 0;
  private onboardingDue = 0;
  private reportingOnboarding = false;
  private lastCapabilities: Capabilities | null = null;
  private claudeConnected: boolean | null = null;
  private readonly resumingStarts = new Set<string>();
  private readonly pausedCopies = new Map<string, { job: ProjectCopyJob; landed: Landed; tries: number }>();
  // Threads whose cut copy resumeCutCopy is planning, so a reconnect meanwhile can't plan a second.
  private readonly retrying = new Set<string>();
  /** Failed tries to mark a new thread's files status, so a lasting failure fails its start (#816). */
  private readonly prepTries = new Map<string, number>();
  /** When Core began refusing a thread's start with a retryable 409, until another outcome (#865). */
  private readonly refusedSince = new Map<string, number>();
  private readonly catchUps = new Map<string, number>();
  /** How often each thread's sandbox address answered as stale (404 or 410) and was woken again since its last
   *  delivery went through (feedback #596, #1076). */
  private readonly rewoken = new Map<string, number>();
  /** The Cloud Credits level (80 or 95 %) each Cloud thread's agent was last told, so each note comes once (#610). */
  private readonly creditsTold = new Map<string, number>();
  /** What sandboxes run, kept apart from a VM's: an account with both starts new threads in sandboxes. */
  private sandboxCapabilities: Capabilities | null = null;
  private readonly secrets: CloudSecrets;
  readonly gpuApprovals: GpuApprovals;
  readonly sandboxes: SandboxDirectory;
  readonly codexAccounts: CodexAccounts;
  readonly threadStates: CloudThreadStates;
  readonly sync: CloudSync;
  constructor(private readonly deps: Deps) {
    // One computer answers a form left open until it times out: the turn's owner, or home (#237).
    this.secrets = new CloudSecrets(deps, (threadId) => this.ownsTurn(threadId, binding(deps.db, threadId)?.turnId ?? ""));
    this.threadStates = new CloudThreadStates(join(deps.config.dataDir, "cloudroom-thread-state.json"));
    this.sync = new CloudSync(deps, this);
    this.sandboxes = new SandboxDirectory(async () => {
      const saved = await this.savedConnection();
      return saved?.sandboxToken && saved.account ? { website: saved.websiteUrl ?? HOSTED_WEBSITE, userId: saved.account.id, token: saved.sandboxToken } : null;
    }, thread => {
      void noteWake(deps, thread).catch(() => {});
      this.macReportDue = 0;
    });
    // A website that lists threads brings runs through the one adoption path (cloud-sync.ts); an older one, as before.
    // The minute's awake answer repeats the last week's runs, so only a run new here, once per app run, asks for a list.
    this.sandboxes.onRuns = runs => void this.sandboxes.followsThreads().catch(() => null).then(follows => {
      if (follows === null) return;
      if (!follows) {
        for (const run of runs) void this.adoptRun(run).catch((error: unknown) => this.warn("A Cloud thread could not be shown", error, { threadId: run.thread }));
        return;
      }
      const fresh = runs.filter((run) => !this.runsSeen.has(run.thread) && !getThread(this.deps.db, run.thread));
      for (const run of runs) this.runsSeen.add(run.thread);
      if (fresh.length) this.sync.changed();
    });
    this.sandboxes.onSignedOut = token => void this.disconnect(token).catch((error: unknown) => this.warn("The sign-out the website asked for was not saved", error));
    this.sandboxes.keySource = thread => keySourceOf(command(deps.db, `first_${thread}`)?.input);
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
      if (!await copyMacLogin(deps, "cursor")) skip.add("cursor");
      return skip;
    };
    this.gpuApprovals = new GpuApprovals(deps, body => this.sandboxes.gpu(body));
    this.codexAccounts = new CodexAccounts(body => this.sandboxes.codexAccounts(body), async () => (await this.sandboxes.account())?.userId ?? null,
      join(deps.config.dataDir, "cloudroom-codex-accounts.json"), () => this.restartAwake("codex"));
    // Renames, generated titles, agent renames, and new parents (a promoted subagent loses its parent's access) all
    // reach the website. Read after the change's transaction ends. A change that came from Core or the website goes nowhere.
    deps.hub.onThreadChanged((threadId, changes) => {
      if (this.quiet.has(threadId) || this.quiet.has("*")) return;
      if (changes.includes("title-changed")) setImmediate(() => { this.syncLabel(threadId, "title"); void this.renameShared(threadId); });
      if (changes.includes("execution-options-changed")) setImmediate(() => this.syncLabel(threadId, "model"));
      if (changes.includes("parent-changed")) setImmediate(() => this.syncLabel(threadId, "parent"));
    });
  }

  /** Runs an awake answer named, so each asks for a list once (#237). */
  private readonly runsSeen = new Set<string>();
  /** Runs an older website's awake answer named that this computer can't show, warned about once (#1072). */
  private readonly runsSkipped = new Set<string>();
  private tag = "";
  /** This install's tag, on every prompt, steer, edit and rewind it sends (#237, cloud-threads.ts). */
  async me(): Promise<string> { return this.tag ||= await installTag(this.deps.config.dataDir); }
  /** A send's request ID, tagged; a retry of one an older app version saved keeps its own. */
  private async requestId(threadId: string, raw: string = randomUUID()): Promise<string> {
    return command(this.deps.db, raw)?.threadId === threadId ? raw : appRequestId(await this.me(), raw);
  }
  /** Threads whose change being applied came from Core or the website, so it isn't sent back. */
  private readonly quiet = new Set<string>();
  quietly<T>(threadId: string | null, apply: () => T): T {
    const key = threadId ?? "*", held = this.quiet.has(key);
    this.quiet.add(key);
    try { return apply(); } finally { if (!held) this.quiet.delete(key); }
  }
  /** A thread the website's list brought here (cloud-sync.ts): an asleep one waits for its sandbox's wake. */
  adopted(threadId: string, awake: boolean): void {
    if (!awake) this.slept.set(threadId, this.sandboxes.awakeChecks);
    void this.sync.arrived(threadId).catch(() => {});
  }
  resendLabel(threadId: string, change: string): void { this.syncLabel(threadId, change as LabelChange, 0, true); }
  /** The computer that acts for a thread (docs/scopes/cloud-threads.md "Who acts"): the one whose tag is on its latest
   *  app prompt. Until there is one, the starter (saved as home when its state is made, so it survives a restart); for
   *  a website child or a shared session, the home of its parent; for a loop run or launch, each computer with its
   *  project ID. A computer that adopted another's start has `ELSEWHERE`, which is never home. */
  isHome(threadId: string, depth = 0): boolean {
    const state = this.threadStates.get(threadId) ?? this.firstState(threadId);
    if (state.home) return state.home === this.tag;
    return Boolean(state.from) && depth < 8 && this.isHome(state.from!, depth + 1);
  }
  /** Who acts for a thread with no state yet: one started here or brought here by an older path, which on main acted. */
  private firstState(threadId: string): Pick<CloudThreadState, "home" | "from"> {
    const remembered = this.firstStates.get(threadId);
    if (remembered && this.tag) return remembered;
    const found = this.readFirstState(threadId);
    if (this.tag) this.firstStates.set(threadId, found);
    return found;
  }
  /** Read once per thread and run (the 1.5 s tick asks for every open binding without state). */
  private readonly firstStates = new Map<string, Pick<CloudThreadState, "home" | "from">>();
  private readFirstState(threadId: string): Pick<CloudThreadState, "home" | "from"> {
    const saved = binding(this.deps.db, threadId);
    const sandbox = saved ? sandboxThread(saved.coreUrl) : null;
    const child = Boolean(saved && ((sandbox && sandbox !== threadId) || saved.startRequestId?.startsWith(WEBSITE_CHILD)));
    return child ? { home: null, from: getThread(this.deps.db, threadId)?.parentThreadId ?? null } : { home: this.tag || null, from: null };
  }
  /** A turn belongs to the install whose tag is on its prompt; an untagged one (loop, phone, `tell`, Core's) to home. */
  private ownsTurn(threadId: string, requestId: string): boolean {
    const tag = tagOf(requestId);
    return tag ? tag === this.tag : this.isHome(threadId);
  }

  /** A shared child's name lives in Core, which keeps it for every computer (#237). */
  private async renameShared(threadId: string): Promise<void> {
    const saved = binding(this.deps.db, threadId), title = getThread(this.deps.db, threadId)?.title;
    if (!saved?.sessionId || !title || !sandboxThread(saved.coreUrl) || sandboxThread(saved.coreUrl) === threadId) return;
    try {
      const client = await this.client(saved, false);
      if (feature(await this.capabilities(client), "cloud_threads")) await client.renameSession(saved.sessionId, randomUUID(), title);
    } catch (error) { if (!(error instanceof SandboxAsleep)) this.warn("A shared child's name could not be saved in Cloud", error, { threadId }); }
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
  /** `resend`: a change kept from earlier; failing again doesn't restart its hour. */
  private syncLabel(threadId: string, change: LabelChange, tries = 0, resend = false): void {
    void this.oneLabelSave(threadId, () => this.saveLabel(threadId, change)).then((stored) => {
      if (stored !== null) void this.sync.unsentLabel(threadId, change, true);
    }, (error: unknown) => {
      this.warn("Cloud thread label not saved", error, { threadId });
      // Refused for good (not sign-in, a timeout or a busy website): it's dropped, never sent again.
      if (error instanceof CloudroomError && error.status !== null && error.status < 500 && ![401, 403, 408, 409, 429].includes(error.status)) return void this.sync.unsentLabel(threadId, change, true);
      // Kept for an hour from the change and sent again on each list (#237).
      if (change !== "start" && change !== "backfill") void this.sync.unsentLabel(threadId, change, false, resend);
      // A missed label keeps the website on the old session after an agent switch, so its children's reports retry
      // until it lands. A few spaced tries, then the next change or app start sends it.
      if (tries < 3 && !this.stopped) setTimeout(() => this.syncLabel(threadId, change, tries + 1, resend), 60_000 * (tries + 1)).unref();
    });
  }

  private oneLabelSave<T>(threadId: string, save: () => Promise<T>): Promise<T> {
    const result = (this.labelSaves.get(threadId) ?? Promise.resolve()).then(save);
    const settled = result.then(() => {}, () => {});
    this.labelSaves.set(threadId, settled);
    void settled.then(() => { if (this.labelSaves.get(threadId) === settled) this.labelSaves.delete(threadId); });
    return result;
  }

  private async saveLabel(threadId: string, change: LabelChange, parent?: string | null): Promise<boolean | null> {
    const saved = binding(this.deps.db, threadId), thread = getThread(this.deps.db, threadId);
    if (!saved?.sessionId || !thread || sandboxThread(saved.coreUrl) !== threadId) return null;
    const full = { title: thread.title ?? thread.titleFallback ?? null, project_name: getProject(this.deps.db, thread.projectId)?.name ?? null, project: thread.projectId, session: saved.sessionId, harness: thread.providerId, model: thread.modelOverride ?? saved.model,
      // The website's link is the truth for a child it started: only a move changes it (ADR 20261104-015709).
      ...(parent === undefined && saved.startRequestId?.startsWith(WEBSITE_CHILD) ? {} : { parent: this.linkParent(saved, parent === undefined ? thread.parentThreadId ?? null : parent) }) };
    // Unknown (a website blip) never means an older website: a whole label would undo newer changes made elsewhere.
    const lists = change === "switch" ? false : await this.sandboxes.followsThreads();
    if (lists === null) throw new CloudroomError("Cloudroom didn't answer. The change is sent again later.");
    const v2 = lists;
    const label = v2 ? { v: 2 as const, ...Object.fromEntries(Object.entries(full).filter(([field]) => LABEL_FIELDS[change].includes(field))) } : full;
    if (Object.keys(label).length === 1) return null;
    const key = JSON.stringify(label);
    if (this.labels.get(threadId) === key) return null;
    this.labels.delete(threadId);
    // A move is the only label that may take a child the website started out from under its parent (ADR 20261104-015709).
    const stored = await this.sandboxes.label(threadId, parent === undefined ? label : { ...label, moved: true });
    this.labels.set(threadId, key);
    return stored;
  }

  /** The parent the website links: for a child it started, the thread whose sandbox runs that parent, since one
   *  sharing another thread's sandbox has none of its own (ADR 20261104-015709). The app still shows the real one. */
  private linkParent(child: Binding, parent: string | null): string | null {
    if (!parent || !child.startRequestId?.startsWith(WEBSITE_CHILD)) return parent;
    return sandboxThread(binding(this.deps.db, parent)?.coreUrl ?? "") ?? parent;
  }

  async changeParent(threadId: string, parent: string | null, apply: () => Promise<void>): Promise<void> {
    await this.oneLabelSave(threadId, async () => {
      const saved = binding(this.deps.db, threadId);
      if (saved && sandboxThread(saved.coreUrl) === threadId && !saved.sessionId) throw new ApiError(503, "cloudroom_parent_unsaved", "This Cloud thread is still starting. Change its parent once it has started.");
      try {
        if (await this.saveLabel(threadId, "parent", parent) === false) {
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
      finally { await this.saveLabel(threadId, "parent").catch((error: unknown) => this.warn("Cloud thread label not saved", error, { threadId })); }
    });
  }

  /** A thread the website started, say while this Mac was off: an automation's run (ADR 0239) or a top-level thread
   *  another Cloud thread launched (ADR 0267). It shows like any Cloud thread; its history streams in once its
   *  sandbox is awake or opened. Only the Mac that has its project shows it, and a thread this app already has is
   *  left alone. */
  private async adoptRun(run: AutomationRun): Promise<void> {
    // The run's own label names its agent (a launch may pick another); older runs fall back to the source thread's (ADR 0250).
    const source = getThread(this.deps.db, run.source), home = binding(this.deps.db, run.source), own = isCloudProvider(run.harness ?? undefined) && run.model;
    const providerId = own ? run.harness : source && home ? source.providerId : run.harness, model = own ? run.model : home?.model ?? run.model;
    // A child the website started goes under the parent the website links (ADR 20261104-015709), so a move made on
    // any Mac stays, and one an older app showed top-level gets its parent. A website too old to say: who started it.
    const child = run.session.startsWith(`cr_${WEBSITE_CHILD}`), linked = !child ? null : run.parent === undefined ? run.source : run.parent;
    const found = linked ? getThread(this.deps.db, linked) : null, parent = found?.projectId === run.project ? found : null, existing = getThread(this.deps.db, run.thread);
    if (existing) {
      const shown = binding(this.deps.db, existing.id);
      // Shown under a session that shares the linked thread's sandbox counts as linked.
      if (child && run.parent !== undefined && shown && this.linkParent(shown, existing.parentThreadId) !== run.parent) updateThread(this.deps.db, this.deps.hub, existing.id, { parentThreadId: parent?.id ?? null });
      return;
    }
    // Not shown here: said once per thread and app run, not on each minute's list (#1072).
    const skip = (why: string) => {
      if (!this.runsSkipped.has(run.thread)) this.warn("A Cloud thread the website started isn't shown here", why, { threadId: run.thread, projectId: run.project });
      this.runsSkipped.add(run.thread);
    };
    if (!providerId || !model) return skip("it names no agent or model");
    if (source && source.projectId !== run.project) return skip("the thread that started it is in another project here");
    if (!getProject(this.deps.db, run.project)) return skip("its project isn't on this computer");
    const adopted = this.deps.db.transaction(tx => {
      if (getThread(tx, run.thread) || tx.select().from(cloudroomThreads).where(eq(cloudroomThreads.sessionId, run.session)).get()) return null;
      const thread = createThread(tx, this.deps.hub, { id: run.thread, executionTarget: "cloud", projectId: run.project, providerId, ...(parent ? { parentThreadId: parent.id } : {}), title: run.title, titleFallback: parent ? `${HARNESS_NAMES[providerId as CloudProvider] ?? "Cloud"} child` : "Loop run", status: "pending" });
      tx.insert(cloudroomThreads).values({ threadId: run.thread, coreUrl: SANDBOX_PREFIX + run.thread, sessionId: run.session, startRequestId: run.session.replace(/^cr_/, ""), model, reasoning: run.reasoning ?? home?.reasoning ?? "medium" }).run();
      return thread;
    });
    if (!adopted) return;
    emitPluginThreadCreated(adopted);
    this.notify(run.thread);
    void this.deliver(run.thread).catch(() => {});
  }


  /** A child this Cloud thread started in a sandbox of its own through the website (ADR 20261104-015709), from Core's
   *  `own_child` record, so it shows under its parent even if it started while this Mac was off. A thread already
   *  shown as a Loop-style run moves under its parent. */
  private async adoptChild(parent: Binding, data: unknown): Promise<void> {
    const child = z.object({ id: rawThreadIdSchema, session: z.string().regex(/^cr_[A-Za-z0-9_-]{1,80}$/), title: z.string().nullish(), harness: z.string().nullish(), model: z.string().nullish(), reasoning: reasoningLevelSchema.nullish().catch(null) }).parse(data);
    const parentThread = getThread(this.deps.db, parent.threadId), existing = getThread(this.deps.db, child.id);
    if (!parentThread) return;
    if (existing) {
      if (existing.parentThreadId === parentThread.id || existing.projectId !== parentThread.projectId) return;
      // The website links the sandbox's thread; a session sharing it is the closer parent. Anything else is the
      // website's to say (adoptRun), so a move stays.
      if (existing.parentThreadId && existing.parentThreadId === sandboxThread(parent.coreUrl)) updateThread(this.deps.db, this.deps.hub, child.id, { parentThreadId: parentThread.id });
      return;
    }
    const providerId = isCloudProvider(child.harness ?? undefined) ? child.harness as CloudProvider : parentThread.providerId, model = child.model ?? parent.model;
    if (!isCloudProvider(providerId) || !model) return;
    const adopted = this.deps.db.transaction(tx => {
      if (getThread(tx, child.id) || tx.select().from(cloudroomThreads).where(eq(cloudroomThreads.sessionId, child.session)).get()) return null;
      const thread = createThread(tx, this.deps.hub, { id: child.id, executionTarget: "cloud", projectId: parentThread.projectId, providerId, parentThreadId: parentThread.id, title: child.title ?? null, titleFallback: `${HARNESS_NAMES[providerId]} child`, status: "pending" });
      tx.insert(cloudroomThreads).values({ threadId: child.id, coreUrl: SANDBOX_PREFIX + child.id, sessionId: child.session, startRequestId: child.session.replace(/^cr_/, ""), model, reasoning: child.reasoning ?? parent.reasoning ?? "medium" }).run();
      return thread;
    });
    if (!adopted) return;
    emitPluginThreadCreated(adopted);
    this.notify(child.id);
    void this.deliver(child.id).catch(() => {});
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

  /** A thread's Core. Sandbox threads wake only when `wake` is true, for work that must be sent; a function is asked
   *  again right before the wake, since an offline Stop (#553) can cancel the work while logins sync. */
  private async client(saved?: Binding, wake: boolean | (() => boolean) = true, trigger?: SandboxWakeTrigger, fresh = false): Promise<CloudroomClient> {
    return new CloudroomClient(await this.coreConnection(saved, wake, trigger, fresh));
  }

  private async coreConnection(saved?: Binding, wakeFor: boolean | (() => boolean) = true, trigger?: SandboxWakeTrigger, fresh = false): Promise<{ url: string; token: string; gateToken?: string }> {
    if (saved) await this.requireOwnThread(saved);
    const sandbox = saved ? sandboxThread(saved.coreUrl) : null;
    if (sandbox) {
      const wakes = () => typeof wakeFor === "function" ? wakeFor() : wakeFor;
      if (wakes()) await this.beforeWake();
      const wake = wakes();
      const thread = getThread(this.deps.db, sandbox);
      const project = this.sandboxProject(thread?.projectId), parent = thread?.parentThreadId ?? undefined;
      // A sandbox archived while one of its threads is active (a missed or racing restore) comes back for it.
      const found = await this.sandboxes.connection(sandbox, project, wake, trigger, fresh, parent).catch(async (error: unknown) => {
        if (!(error instanceof CloudroomError && error.code === "sandbox_archived") || !coreInUse(this.deps.db, SANDBOX_PREFIX + sandbox)) throw error;
        await this.sandboxes.restore(sandbox);
        return this.sandboxes.connection(sandbox, project, wake, trigger, fresh, parent);
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
    // Core never reports a reading older than 5 s on its own clock (`Guard::snapshot`). A sandbox clock that drifts from
    // the Mac's can make a 30 s age check here fail with ample space (#1463).
    if (storage.enabled && storage.reason === "measurement_unavailable") {
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
        // Its sign-out revoked this Mac's helper; if it never signed out, revoke now, while its login is still saved (#109).
        await stopPreviews(this.deps).catch(() => {});
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

  /** Signs out. `refused` is a token the website just refused as signed out (a password reset, say): the app then
   *  signs out only if that is still the saved token, so a late answer never ends a newer sign-in. */
  disconnect(refused?: string): Promise<void> {
    if (!refused) this.stop();
    return this.changeConnection(async () => {
      const saved = await this.savedConnection();
      if (refused && saved?.sandboxToken !== refused) return;
      this.stop();
      // The website already ended a refused sign-in: a failed preview stop is logged, never left half signed out.
      await stopPreviews(this.deps).catch((error: unknown) => {
        if (!refused) throw error;
        this.warn("Previews could not be stopped after the website ended the sign-in", error);
      });
      if (saved) {
        const { token: _token, gateToken: _gateToken, sandboxToken, ...binding } = saved;
        await this.saveConnection(binding);
        // A refused token is already gone from the website.
        if (!refused && sandboxToken && saved.account) revokeDesktopToken({ website: saved.websiteUrl ?? HOSTED_WEBSITE, userId: saved.account.id, token: sandboxToken });
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
    const problem = status.state === "offline" && status.detail ? status.message : null;
    // Windows hides Mac access: "off" keeps older Cores' answer, `unsupported` tells newer ones there is no setting (#871).
    const report = macAccessSupported ? { access: await macAccess(this.deps) ?? "off", problem } : { access: "off", problem, unsupported: true };
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

  /** Check now: a helper that couldn't start tries again at the next status check, not after its wait. */
  retryPreviews(): void { this.previewRetryAt = 0; }

  /** A new Mac access level reaches the helper in the background, queued like every other setup so two never overlap.
   *  Saving it never waits on the helper or fails because of it; Settings shows why the helper can't start (#109). */
  applyMacAccess(): void {
    const epoch = this.epoch;
    void this.changeConnection(async () => {
      if (this.stopped || epoch !== this.epoch || !await previewsSetUp(this.deps)) return;
      await setupPreviews(this.deps);
      if (epoch === this.epoch) { this.previewIssue = null; this.previewFailures = 0; }
    }).catch((error: unknown) => { if (epoch === this.epoch) this.previewIssue = publicError(error); });
  }

  private ensurePreviews(capabilities: Capabilities): Promise<void> | undefined {
    if (!capabilities.previews || this.stopped || this.previewSetupEpoch === this.epoch || Date.now() < this.previewRetryAt) return;
    const epoch = this.epoch;
    this.previewSetupEpoch = epoch;
    this.previewRetryAt = Date.now() + 30_000;
    return this.changeConnection(async () => {
      if (this.stopped || epoch !== this.epoch) return;
      await setupPreviews(this.deps);
      if (epoch === this.epoch) { this.previewIssue = null; this.previewFailures = 0; }
    }).catch(async (error: unknown) => {
      if (epoch !== this.epoch) return;
      // Retry after 1, 2, 4, then every 5 minutes: a helper that can't start never restarts in a tight loop (#109).
      this.previewRetryAt = Date.now() + Math.min(30_000 * 2 ** ++this.previewFailures, 300_000);
      this.previewIssue = publicError(error);
      // Twice in a row, so a slow start at login never counts.
      const level = macAccessSupported ? await macAccess(this.deps).catch(() => null) : null;
      if (this.previewFailures >= 2 && level && level !== "off" && !await helperRunning(this.deps)) reportMacHelperDown(this.previewIssue);
    }).finally(() => { if (this.previewSetupEpoch === epoch) this.previewSetupEpoch = -1; });
  }

  private recent: { at: number; local: number; cloud: number } | null = null;
  /** Threads the user started in the last 30 days, by where they run: it tells who mostly uses Local (ADR 20261111-222458).
   *  Imports, subagents, hidden threads, and plugin runs don't count. Counted at most every 5 minutes. */
  private async recentThreads(): Promise<{ local: number; cloud: number }> {
    if (!this.recent || Date.now() - this.recent.at >= 5 * 60_000) {
      // The first agent is a thread Cloudroom started, not the user (ADR 20261111-220912).
      const skipped = [...await importedThreadIds(this.deps), firstAgentThreadId(this.deps.db) ?? []].flat();
      const rows = this.deps.db.select({ target: threads.executionTarget, n: sql<number>`count(*)` }).from(threads)
        .where(and(isNull(threads.parentThreadId), isNull(threads.originPluginId), eq(threads.visibility, "visible"),
          gt(threads.createdAt, Date.now() - 30 * 86_400_000), skipped.length ? notInArray(threads.id, skipped) : undefined))
        .groupBy(threads.executionTarget).all();
      const count = (target: "local" | "cloud") => rows.find((row) => row.target === target)?.n ?? 0;
      this.recent = { at: Date.now(), local: count("local"), cloud: count("cloud") };
    }
    return { local: this.recent.local, cloud: this.recent.cloud };
  }

  async status() {
    const lastCloudAt = this.deps.db.select({ updated: max(threads.updatedAt) }).from(threads).where(eq(threads.executionTarget, "cloud")).get()?.updated ?? null;
    const recentThreads = await this.recentThreads();
    let account: CloudroomAccount | null = null;
    let projectId: string | null = null;
    let storage: Storage | null = null;
    // A core connected by URL and token, with no Cloudroom account: the user hosts it (docs/cloudroom.md).
    let selfHosted = false;
    let signedOut = false;
    try {
      const saved = await this.savedConnection();
      signedOut = !saved?.account || !(saved.token || saved.sandboxToken);
      account = saved?.token ? saved.account ?? null : null;
      selfHosted = Boolean(saved?.token && !saved.account);
      projectId = saved?.projectId ?? null;
      if (saved?.sandboxToken && saved.account && await this.newThreadsInSandboxes()) {
        // Without a VM, nothing above asked the website's mode, which carries the plan and queue (#864): ask in the
        // background, at most once a minute, so status never waits on it.
        if (!saved.token) this.sandboxes.usageLimited();
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
          queue_reorder: capabilities?.queue_reorder ?? false, error: null, cloudQueue: this.sandboxes.cloudQueue(), usedCloud: lastCloudAt !== null, lastCloudAt, recentThreads,
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
        ready: true, account, signedOut, selfHosted, projectId, storage, harnesses: capabilities.harnesses,
        sync: capabilities.sync ? { ...await syncStatus(this.deps), issue: this.syncIssue } : null,
        previews: capabilities.previews ? await this.previews() : null,
        workspaces: capabilities.workspaces, teleport: capabilities.teleport, repository: capabilities.repository,
        model: capabilities.harnesses.find((h) => h.id === "codex")?.model ?? null,
        steer: capabilities.steer, rewind: capabilities.rewind, attachments: capabilities.attachments,
        compact: capabilities.compact, queue_edit: capabilities.queue_edit, queue_cancel: capabilities.queue_cancel,
        queue_reorder: capabilities.queue_reorder, error: null, usedCloud: lastCloudAt !== null, lastCloudAt, recentThreads,
      };
    } catch (error) { return { ready: false, account, signedOut, selfHosted, projectId, storage, workspaces: false, repository: null, model: null, error: publicError(error) }; }
  }

  /** Runs `CLEAR_DISK` through Core's emergency access, which still works while a full disk pauses the agent.
   *  Once space is back, Core resumes work and the waiting message sends by itself. */
  async clearDisk(threadId: string): Promise<{ freedBytes: number }> {
    const result = await this.runOnVm({ command: CLEAR_DISK }, threadId, AbortSignal.timeout(10 * 60_000));
    const output = Buffer.from(result.stdout, "hex").toString().trim();
    const freed = Number(output.split("\n").at(-1));
    if (result.code !== 0 || result.truncated || !output || !Number.isFinite(freed)) throw new ApiError(503, "cloud_disk_clear", "Caches and builds could not be cleared. Try again.");
    const saved = binding(this.deps.db, threadId);
    if (saved) void this.client(saved).then(client => this.measureDisk(threadId, client), () => {});
    return { freedBytes: Math.max(0, freed) };
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
      throw new ApiError(error instanceof CloudroomError && (error.status === 409 || error.status === 429) ? error.status : 503, "cloudroom_vm_run", publicError(error));
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
    if (connected && (action || !this.claudeConnected)) this.resumeStarts("claude-code");
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

  /** Starts that waited for this agent's sign-in continue on their own. Later tries cover a login still reaching an awake sandbox. */
  private resumeStarts(providerId: CloudLoginProvider): void {
    const waiting = (threadId: string) => {
      const saved = binding(this.deps.db, threadId);
      const thread = getThread(this.deps.db, threadId);
      return Boolean(saved && !saved.sessionId && authRequiredMessages.has(saved.error ?? "") && thread?.providerId === providerId && !thread.archivedAt && !thread.deletedAt);
    };
    for (const { threadId } of bindings(this.deps.db)) {
      if (this.resumingStarts.has(threadId) || !waiting(threadId)) continue;
      this.resumingStarts.add(threadId);
      void (async () => {
        for (const wait of [0, 3_000, 10_000]) {
          await new Promise(resolve => setTimeout(resolve, wait).unref());
          if (this.stopped || !waiting(threadId)) return;
          await this.retryStart(threadId).catch(error => this.warn(`Cloud start could not continue after ${cloudLoginName(providerId)} sign-in`, error, { threadId }));
        }
      })().finally(() => this.resumingStarts.delete(threadId));
    }
  }

  /** The Mac Codex login last resent after a Cloud refusal: each one is tried once, then only a new sign-in helps. */
  private codexTried: string | null = null;
  private healingCodex = false;
  /** A Codex sign-in started here on the cloud VM (not a sandbox), so the status that sees it connected resumes. */
  private codexSigningIn = false;

  /** Cloud refused Codex, but this Mac's login may still work: send it again, once per Mac login (cheap checks first, so
   *  the banner's poll costs nothing once tried). Answers whether it was sent. */
  private async resendMacCodex(): Promise<boolean> {
    const digest = await macCodexDigest();
    if (!digest || digest === this.codexTried) return false;
    if (!await this.newThreadsInSandboxes() || await copyLogins(this.deps) !== true) return false;
    this.codexTried = digest;
    if (await macCodexLoginExpired()) return false;
    const sent = await this.sandboxes.resendMacCodexLogin();
    if (sent) this.codexTried = sent;
    return Boolean(sent);
  }

  /** Self-heal: when Cloud refuses Codex, resend this Mac's working login and continue the waiting starts, with no click.
   *  Skipped while Cloud uses a website Codex account: only the website renews those (ADR 0195). */
  private healCodex(): void {
    if (this.healingCodex) return;
    this.healingCodex = true;
    void (async () => {
      const digest = await macCodexDigest();
      if (!digest || digest === this.codexTried || await this.codexAccounts.selected()) return;
      if (await this.resendMacCodex()) this.codexFixed();
    })().catch(error => this.warn("This Mac's Codex login could not be resent to Cloud", error)).finally(() => { this.healingCodex = false; });
  }

  /** Codex works in Cloud again: waiting starts continue, and the banner asks the website about paused loops again. */
  private codexFixed(): void {
    this.loopLogins = null;
    this.resumeStarts("codex");
  }

  private loopLogins: { at: number; counts: Partial<Record<CloudLoginProvider, number>> } | null = null;
  /** Cloud loops the website paused because an agent's Cloud login was refused. Read at most every 15 minutes. */
  private async loopLoginIssues(): Promise<Partial<Record<CloudLoginProvider, number>>> {
    const now = Date.now();
    if (this.loopLogins && now - this.loopLogins.at < 15 * 60_000) return this.loopLogins.counts;
    const last = this.loopLogins?.counts ?? {};
    this.loopLogins = { at: now, counts: last };
    const listed = z.object({ automations: z.array(z.object({ enabled: z.boolean(), last_error: z.string().nullable().catch(null), last_run_at: z.string().nullable().catch(null), created_at: z.string().catch("") }).passthrough()) })
      .safeParse(await this.sandboxes.automations({ action: "list" }).catch(() => null));
    if (!listed.success) return last;
    const counts: Partial<Record<CloudLoginProvider, number>> = {};
    for (const loop of listed.data.automations) {
      const paused = !loop.enabled && /^Paused after \d+ failed runs\./.test(loop.last_error ?? "");
      // Like the sidebar's paused label: pauses older than a week stay quiet.
      const recent = now - Date.parse(loop.last_run_at ?? loop.created_at) < 7 * 86_400_000;
      const provider = paused && recent ? cloudLoginProvider((loop.last_error ?? "").replace(/^Paused after \d+ failed runs\.\s*(?:Last error: |The last run failed: )?/, "")) : null;
      if (provider) counts[provider] = (counts[provider] ?? 0) + 1;
    }
    if (this.loopLogins.at === now) this.loopLogins = { at: now, counts };
    return counts;
  }

  /** Agents Cloud refused for a missing or dead login: their threads waiting here and the Cloud loops paused (the banner).
   *  Seeing Codex refused also tries the self-heal. */
  async cloudLogins(): Promise<{ provider: CloudLoginProvider; threads: number; loops: number }[]> {
    const issues = new Map<CloudLoginProvider, { provider: CloudLoginProvider; threads: number; loops: number }>();
    const issue = (provider: CloudLoginProvider) => issues.get(provider) ?? issues.set(provider, { provider, threads: 0, loops: 0 }).get(provider)!;
    for (const saved of bindings(this.deps.db)) {
      if (saved.sessionId || !authRequiredMessages.has(saved.error ?? "")) continue;
      const thread = getThread(this.deps.db, saved.threadId);
      const provider = cloudLoginProvider(saved.error);
      if (thread && provider && !thread.archivedAt && !thread.deletedAt) issue(provider).threads += 1;
    }
    for (const [provider, loops] of Object.entries(await this.loopLoginIssues()) as [CloudLoginProvider, number][]) issue(provider).loops += loops;
    if (issues.has("codex")) this.healCodex();
    return [...issues.values()];
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
    const status = await this.cursorAuthStatus(action, requestId, apiKey);
    // A new Cursor login: the starts that waited for it continue by themselves.
    if (status.state === "connected" && (action === "login" || action === "key")) {
      this.loopLogins = null;
      this.resumeStarts("acp-cursor");
    }
    return status;
  }

  private async cursorAuthStatus(action?: "login" | "cancel" | "key", requestId?: string, apiKey?: string) {
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

  /** The Accounts plugin's Cursor account in use: its key becomes the Cloud login, and this Mac's own Cursor login stops
   *  copying over it. `null` (This Mac) copies this Mac's login again, and fails when it has none. */
  cursorAccount(requestId: string, apiKey: string | null) {
    return this.sandboxes.withLogins(async () => {
      if (apiKey === null) {
        if (!await macCursorLogin()) throw new ApiError(409, "cursor_auth_required", `Cursor is not signed in on this ${COMPUTER}. Run \`cursor-agent login\`, then pick This ${COMPUTER_TITLE} again.`);
        await setCopyMacLogin(this.deps, "cursor", true);
        return this.cursorAuth("login", requestId);
      }
      const status = await this.cursorAuth("key", requestId, apiKey);
      await setCopyMacLogin(this.deps, "cursor", false);
      return status;
    });
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
        // Cloud lacks the login or refused it: resend this Mac's working one (once per login). Otherwise sign in on this
        // Mac first, then the next status check copies the new login.
        if (await this.resendMacCodex()) copied = true;
        else startMacCodexLogin(this.deps as LoggedWorkSessionDeps);
      }
      const run = macCodexLogin();
      if (run?.done && !run.error) {
        await this.sandboxes.copyMacLogins(true);
        copied = true;
      }
      const status = copied ? (await this.sandboxLogin("codex"))! : sandbox;
      if (run?.installingSince) return { ...status, state: "waiting" as const, login_id: "mac", verification_url: null, message: null, installing_since: run.installingSince };
      if (run && !run.done) return { ...status, state: "waiting" as const, login_id: "mac", verification_url: run.url, message: "Finish signing in to ChatGPT in your browser." };
      if (run?.error) {
        reportAgentConnect("codex", "failed", { code: "login_failed", message: run.error, cliPlace: cliPlace(findCliExecutable("codex")) });
        return { ...status, state: "error" as const, message: run.error };
      }
      if (status.state === "connected" && (action === "login" || run?.done)) reportAgentConnect("codex", "ok", { cliPlace: cliPlace(findCliExecutable("codex")) });
      // A new login reached Cloud: the starts that waited for it continue by themselves, with no "Continue to task".
      if (copied && status.state === "connected") this.codexFixed();
      return status;
    }
    try {
      const client = await this.client();
      const capabilities = await this.capabilities(client);
      if (!capabilities.codex_auth) throw new ApiError(409, "codex_auth_unsupported", "Update the cloud core to connect Codex from this app.");
      if (capabilities.codex_auth_import && action !== "cancel") await importCodexLogin(this.deps);
      const status = await client.codexAuth(action, requestId);
      if (action) this.codexSigningIn = action === "login" && status.state === "waiting";
      if (status.state === "connected" && (action === "login" || this.codexSigningIn)) {
        this.codexSigningIn = false;
        this.codexFixed();
      }
      return status;
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

  /** Cores whose harness switches models in its session (`set_model`), by Core and harness. A Core never loses it. */
  private readonly modelSwitchers = new Set<string>();
  private async switchesModels(coreUrl: string, harness: string, ask: () => Promise<Capabilities>): Promise<boolean> {
    const key = `${coreUrl} ${harness}`;
    if (this.modelSwitchers.has(key)) return true;
    const takes = Boolean(harnessProfile(await ask(), harness)?.set_model);
    if (takes) this.modelSwitchers.add(key);
    return takes;
  }

  /** A model pick in the same Claude session, as on Local: saved here at once, then Core gets it as a queued `model`
   *  command, ahead of the next work. Core owns it, so every turn runs it, whoever sends it. False when this thread's
   *  Core can't, so the caller starts a new session instead (ADR 0211). Never wakes the sandbox: an asleep one wakes
   *  with the pinned Core, which the saved capabilities describe. */
  async changeModel(thread: Thread, model: string, reasoningLevel: ReasoningLevel | null): Promise<boolean> {
    const saved = binding(this.deps.db, thread.id);
    if (!saved?.sessionId || thread.archivedAt || thread.deletedAt || this.switching.has(thread.id)) return false;
    await this.requireOwnThread(saved);
    const sandbox = sandboxThread(saved.coreUrl);
    const known = sandbox ? await this.savedCapabilities() : this.lastCapabilities;
    if (!known || !harnessProfile(known, thread.providerId)?.set_model) return false;
    const asleep = sandbox !== null && !this.sandboxes.isAwake(sandbox);
    const live = async () => this.capabilities(await this.client(saved, false));
    if (!asleep && !await this.switchesModels(saved.coreUrl, thread.providerId, live).catch(() => false)) return false;
    const current = this.currentReasoning(thread.id, saved);
    const levels = reasoningLevels(thread.providerId, model, known) as ReasoningLevel[] | undefined;
    const reasoning = reasoningLevelSchema.parse(reasoningLevel ?? (levels?.length ? reconcileReasoningLevel(current as ReasoningLevel, levels) : current));
    validateReasoning(thread.providerId, model, reasoning, known);
    // Core records the effort with the model, so a wake resumes on a level the model takes; edits send it too. A newer
    // pick replaces an unsent one, and keeps what the thread ran before both.
    const waiting = commands(this.deps.db, thread.id).filter((item) => item.command === "model" && item.state === "sending");
    const before = waiting[0] ? JSON.parse(waiting[0].input).before : { model: saved.model, reasoning: saved.reasoning, override: getThreadExecutionOverride(this.deps.db, thread.id)?.reasoningLevelOverride ?? null };
    this.deps.db.transaction((tx) => {
      for (const item of waiting) saveCommandState(tx, thread.id, item.id, "cancelled");
      saveBinding(tx, thread.id, { model, reasoning });
      setThreadExecutionOverride(tx, { threadId: thread.id, modelOverride: null, reasoningLevelOverride: reasoning });
    });
    this.enqueue(thread.id, randomUUID(), "model", { model, reasoning, before });
    void this.deliver(thread.id).catch(() => {});
    return true;
  }

  /** Core didn't take a model pick (`model` command): the thread shows the model it still runs. */
  private keepModel(threadId: string, pick: Command): void {
    const { before } = modelPickSchema.parse(JSON.parse(pick.input));
    this.deps.db.transaction((tx) => {
      saveCommandState(tx, threadId, pick.id, "failed");
      saveBinding(tx, threadId, { model: before.model, reasoning: before.reasoning });
      setThreadExecutionOverride(tx, { threadId, reasoningLevelOverride: before.override });
    });
    this.deps.logger?.warn({ threadId }, "Cloud model pick not taken; the thread keeps its model");
    this.deps.hub.notifyThread(threadId, ["execution-options-changed"], { projectId: getThread(this.deps.db, threadId)?.projectId });
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
  /** The disk pill from Core's own measurement: a full disk shows it, a disk with space clears it. A refusal alone never
   *  does, because older Cores also refuse uploads as "storage unsafe" while a sandbox stops. */
  private measureDisk(threadId: string, client: CloudroomClient): void {
    this.storage(client).then((storage) => {
      if (!storage?.enabled) return;
      if (storage.level === "normal") this.disk.delete(threadId);
      else if (storage.level === "blocked" && storage.reason === "disk_capacity" && storage.workspace_total_bytes !== null && storage.workspace_available_bytes !== null) {
        this.disk.set(threadId, { paused: true, reason: "disk_capacity", usedBytes: storage.workspace_total_bytes - storage.workspace_available_bytes, totalBytes: storage.workspace_total_bytes });
      } else return;
      this.notify(threadId);
    }, () => {});
  }

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
    return { authRequired: !saved.sessionId && authRequiredMessages.has(saved.error ?? ""), starting: !saved.queuePaused && Boolean(initial && ["sending", "accepted"].includes(initial.state)), sessionId: saved.sessionId, paused: saved.queuePaused, failedStart: !saved.sessionId && initial?.state === "failed", model: saved.model, reasoning, serviceTier, error: saved.error ?? issues.find(issue => !issue.reconnecting)?.message ?? null, reconnecting: issues.some(issue => issue.reconnecting), usageLimit: Boolean(sandboxThread(saved.coreUrl)) && (this.sandboxes.usageLimited() || this.sandboxes.agentLimited(sandboxThread(saved.coreUrl) ?? "")), disk: this.disk.get(threadId) ?? null, awake: !sandboxThread(saved.coreUrl) || this.sandboxes.isAwake(sandboxThread(saved.coreUrl) ?? ""), vps: this.sandboxes.onVps(sandboxThread(saved.coreUrl) ?? ""), move: this.sandboxes.moveState(sandboxThread(saved.coreUrl) ?? ""), waiting: this.sandboxes.waitNotice(sandboxThread(saved.coreUrl) ?? ""), fromCopy: this.sandboxes.copyChoice(sandboxThread(saved.coreUrl) ?? ""), outOfMemory: this.outOfMemory.has(threadId), pendingDelivery: commands(this.deps.db, threadId).filter((c) => c.state === "sending").length };
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
    const keys = await this.keyFields(codeFrom);
    const project = getProject(this.deps.db, request.projectId);
    if (!project) throw new ApiError(404, "project_not_found", "Project not found");
    if (!isCloudProvider(request.providerId) || (!fork && (request.originKind || request.sourceThreadId)) || request.sendAt || request.pluginSubmission || (request.environment.type !== "project-default" && !codeFrom))
      throw new ApiError(400, "cloudroom_unsupported", "Cloud supports new Codex, Pi, Cursor, fx, opencode, Hermes Agent, Devin, Droid, Kimi Code, OpenClaw and Claude Code threads in a cloud folder. Forks, scheduling and native machine targets are not supported.");
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
    const piDefault = request.providerId === "pi" && !request.reasoningLevel;
    // A model whose own row takes no effort, such as Claude's Haiku, starts without one; others keep medium (#1059).
    const reasoning =
      request.reasoningLevel ??
      (takesNoEffort(capabilities, request.providerId, model)
        ? "none"
        : defaultReasoningLevel(undefined));
    if (!model) throw new ApiError(400, "model_required", "Select a Codex model");
    const startRequestId = request.requestId ?? randomUUID();
    const existingThread = (db: DbQueryConnection) => {
      const previous = db.select().from(cloudroomThreads).where(eq(cloudroomThreads.startRequestId, startRequestId)).get();
      if (!previous) return null;
      const initial = command(db, `first_${previous.threadId}`);
      const thread = getThread(db, previous.threadId);
      if (thread?.projectId !== request.projectId || thread?.providerId !== request.providerId || previous.model !== model || (initial && JSON.parse(initial.input).default_reasoning ? !piDefault : previous.reasoning !== reasoning) || (initial ? JSON.parse(initial.input).text : null) !== payload.text) throw new ApiError(409, "request_conflict", "Request ID was already used with different content");
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
    if (capabilities && remoteModel && !piDefault && !(sandbox && profile?.models === null)) validateReasoning(request.providerId, remoteModel.model, reasoning, capabilities);
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
        input: JSON.stringify(this.snapshotInstructions(tx, thread, "prompt", {
          ...payload, ...workspace, provider: remoteModel?.provider,
          command_guard_enabled: getAppSettings(this.deps.db).commandGuardEnabled,
          strip_ai_co_authors: getAppSettings(this.deps.db).stripAiCoAuthorsEnabled,
          system_prompt: [cloudroomSystemPrompt(this.deps.db, "cloud", { vps: this.sandboxes.vpsConnected }), cloudPluginInstructions({ threadId: thread.id, projectId: thread.projectId }), projectNote].filter(Boolean).join("\n\n") || undefined,
          ...(request.serviceTier && request.serviceTier !== "default" ? { service_tier: request.serviceTier } : {}),
          ...(request.baseBranch ? { base_branch: request.baseBranch } : {}),
          ...(codeFrom ? { code_from: codeFrom } : {}), ...keys,
          ...(piDefault ? { default_reasoning: true } : {}),
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
    if (created && sandbox) this.sandboxes.firstWakeHints(thread.id, { ...(request.cloudTarget ? { target: request.cloudTarget } : {}), launch: request.origin, ...(request.launcherThreadId ? { launcher: request.launcherThreadId } : {}) });
    this.notify(thread.id, ["client/turn/requested", "system/thread-provisioning"]);
    void this.selectOnboardingProject(project.id).catch(() => {});
    this.start();
    void this.deliver(thread.id).catch(() => {});
    return getThread(this.deps.db, thread.id)!;
  }

  /** A new Cloud child or fork gets only the API keys of the sandbox its source runs in (ADR 0342), so a run with
   *  some keys never hands out more: a --shared-sandbox source runs in its parent's. Without `.env` in that list, it
   *  gets no `.env` files from this Mac either. Decided once, before it starts, and saved with its first message. */
  private async keyFields(source: string | undefined): Promise<{ key_source?: string; no_env?: true }> {
    const sandbox = source ? sandboxThread(binding(this.deps.db, source)?.coreUrl ?? "") : null;
    if (!sandbox) return {};
    const keys = await this.sandboxes.loopSecrets(sandbox);
    return { key_source: sandbox, ...(keys && !keys.includes(".env") ? { no_env: true as const } : {}) };
  }

  /** The only API keys the sandbox a thread runs in gets (ADR 0342): null for every key and for threads without a
   *  sandbox, like a VM's, and undefined when the website has no row for it. A sandbox with a list gets nothing from
   *  this Mac at its agent's request. */
  async keyList(threadId: string): Promise<string[] | null | undefined> {
    const sandbox = sandboxThread(binding(this.deps.db, threadId)?.coreUrl ?? "");
    return sandbox ? this.sandboxes.loopSecrets(sandbox) : null;
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
    const keys = await this.keyFields(source.id);
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
        input: JSON.stringify(this.snapshotInstructions(tx, thread, "prompt", {
          ...payload, ...workspace, fork, ...keys,
          command_guard_enabled: getAppSettings(this.deps.db).commandGuardEnabled,
          strip_ai_co_authors: getAppSettings(this.deps.db).stripAiCoAuthorsEnabled,
          system_prompt: [cloudroomSystemPrompt(this.deps.db, "cloud", { vps: this.sandboxes.vpsConnected }), cloudPluginInstructions({ threadId: thread.id, projectId: thread.projectId }), projectNote].filter(Boolean).join("\n\n") || undefined,
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
  async switchHarness(thread: Thread, target: { providerId: string; model: string; reasoningLevel: ReasoningLevel | null }, prepare: (seed: boolean) => Promise<(tx: DbTransaction) => void>): Promise<void> {
    await this.restartSession(thread, { ...target, refusal: "Agents started by another agent keep their agent." }, prepare, (tx, started) => {
      updateThread(tx, this.deps.hub, thread.id, { providerId: target.providerId });
      saveBinding(tx, thread.id, { ...started, model: target.model, cursor: 0, nativeId: null, turnId: null, error: null });
      setThreadExecutionOverride(tx, { threadId: thread.id, modelOverride: null, reasoningLevelOverride: reasoningLevelSchema.safeParse(started.reasoning).data ?? null });
    });
  }

  /** ADR 0281: a new Core session in the new project's folder, in the same sandbox. The old folder stays as it is. */
  async moveProject(thread: Thread, projectId: string, prepare: (seed: boolean) => Promise<(tx: DbTransaction) => void>): Promise<string | null> {
    const saved = binding(this.deps.db, thread.id);
    const project = getProject(this.deps.db, projectId);
    if (!saved || !project) throw new ApiError(404, "project_not_found", "Project not found");
    const workspace = project.id === PERSONAL_PROJECT_ID ? { workspace: ROOT_WORKSPACE } : { workspace: workspaceId(project.id), workspace_name: workspaceName(project.name) };
    const client = await this.client(saved);
    const previousPath = saved.sessionId ? await client.sessionWorkspace(saved.sessionId).then(({ path }) => path, () => null) : null;
    const continued = await this.restartSession(thread, { providerId: thread.providerId, model: saved.model, reasoningLevel: null, workspace, refusal: "Agents started by another agent stay in its project." }, prepare, (tx, started) => {
      updateThread(tx, this.deps.hub, thread.id, { projectId: project.id });
      saveBinding(tx, thread.id, { ...started, cursor: 0, nativeId: null, turnId: null, error: null });
      const first = command(tx, `first_${thread.id}`);
      if (first) tx.update(cloudroomCommands).set({ input: JSON.stringify({ ...JSON.parse(first.input), ...workspace, base_branch: undefined }) }).where(eq(cloudroomCommands.id, first.id)).run();
    });
    // Core's switch moved the row's session and agent; the project is this computer's change.
    if (continued) this.syncLabel(thread.id, "project");
    if (workspace.workspace === ROOT_WORKSPACE) return previousPath;
    const moved = binding(this.deps.db, thread.id)!;
    const sandbox = sandboxThread(moved.coreUrl);
    const job = await planProjectCopy(this.deps, client, thread.id, workspace.workspace, { key: copyKey(sandbox, workspace.workspace) });
    if (job) this.copyInto(client, job, () => void this.ensureBranch(thread.id, true));
    else void this.ensureBranch(thread.id, true);
    return previousPath;
  }

  /** True when Core switched the conversation itself (`continue_from`, #237): it builds the history, moves the row and
   *  its loops, and closes the old session. Older Cores start a new session here, and the app sends its own history. */
  private async restartSession(thread: Thread, target: { providerId: string; model: string; reasoningLevel: ReasoningLevel | null; workspace?: { workspace: string; workspace_name?: string }; refusal: string }, prepare: (seed: boolean) => Promise<(tx: DbTransaction) => void>, apply: (tx: DbTransaction, started: { sessionId: string; startRequestId: string; reasoning: string }) => void): Promise<boolean> {
    const continues = { value: false, done: false };
    if (this.switching.has(thread.id) || this.sends.has(thread.id)) throw new ApiError(409, "thread_busy", "Wait until the message is sent, then switch.");
    this.switching.add(thread.id);
    try {
      const saved = binding(this.deps.db, thread.id);
      if (!saved?.sessionId) throw new ApiError(409, "cloudroom_not_started", "Wait for the cloud agent to start, then switch.");
      await this.requireOwnThread(saved);
      if (teleportBlocked(this.deps.db, thread.id)) throw new ApiError(409, "teleport_in_progress", "Wait for Teleport to finish, then switch.");
      if (!isCloudProvider(target.providerId)) throw new ApiError(400, "cloudroom_unsupported", "This agent can't run in Cloud.");
      const oldSession = saved.sessionId;
      const resumeLoops = await this.requireNoSessionDependents(thread.id, saved);
      const client = await this.client(saved);
      const capabilities = await this.capabilities(client);
      if (!harnessProfile(capabilities, target.providerId)) throw new ApiError(400, "cloudroom_unsupported", `${HARNESS_NAMES[target.providerId]} isn't set up in Cloud yet.`);
      const { model, provider } = coreModel(target.providerId, target.model, capabilities);
      const current = this.currentReasoning(thread.id, saved);
      const levels = reasoningLevels(target.providerId, model, capabilities) as ReasoningLevel[] | undefined;
      const reasoning = target.reasoningLevel ?? (levels?.length ? reconcileReasoningLevel(current as ReasoningLevel, levels) : current);
      validateReasoning(target.providerId, model, reasoning, capabilities);
      const before = await this.quietSession(client, saved);
      const start = Object.values(before.receipts).find((receipt) => receipt.command === "start");
      if (!start?.workspace) throw new ApiError(409, "cloudroom_switch", "This thread's cloud folder is unknown, so it can't switch.");
      const startInput = z.object({ parent_session: z.string().nullish(), parent_thread: z.string().nullish(), command_guard_enabled: z.boolean().nullish(), strip_ai_co_authors: z.boolean().nullish(), system_prompt: z.string().nullish() }).passthrough().parse(start.input);
      if (startInput.parent_session) throw new ApiError(409, "cloudroom_switch", target.refusal);
      const workspace = target.workspace ?? (start.workspace.id !== "legacy" ? { workspace: start.workspace.id } : start.workspace.path === capabilities.repository ? {} : { workspace: ROOT_WORKSPACE });
      if (target.providerId === "codex" && capabilities.codex_auth_import && !sandboxThread(saved.coreUrl)) await importCodexLogin(this.deps);
      if (target.providerId === "pi") await this.copyPiSetup(client, Boolean(sandboxThread(saved.coreUrl)));
      continues.value = feature(capabilities, "cloud_threads");
      const record = await prepare(!continues.value);
      const startRequestId = randomUUID();
      const saveSwitch = (session: string) => {
        this.detach(thread.id);
        this.deps.db.transaction((tx) => {
          apply(tx, { sessionId: session, startRequestId, reasoning });
          record(tx);
          // The new session's copied chat leaves out agent-only text, so it has no custom instructions yet.
          markCustomInstructionsLost(tx, thread.id);
        });
        // Switched here: the new session's records are this computer's to act on, and the list never takes it back.
        const known = this.threadStates.get(thread.id);
        this.threadStates.set(thread.id, { home: null, from: null, ...known, session, actFrom: 0, before: [oldSession, ...known?.before ?? []].slice(0, 5) });
      };
      if (continues.value) {
        const started = await client.continueSession(startRequestId, CLOUD_HARNESSES[target.providerId], oldSession, { model, reasoning, ...(provider ? { provider } : {}), ...workspace }).catch((error: unknown) => {
          throw new ApiError(error instanceof CloudroomError && error.status === 409 ? 409 : 503, "cloudroom_switch", `${HARNESS_NAMES[target.providerId as CloudProvider]} couldn't take over in Cloud, so this thread wasn't changed. ${publicError(error)}`);
        });
        if (started.pending) throw new ApiError(409, "cloudroom_switch_pending", "The switch is still finishing in Cloud. This thread shows the new agent once it's done.");
        // Core saved the new agent on the website, so the change goes nowhere from here.
        this.quietly(thread.id, () => saveSwitch(started.session_id));
        continues.done = true;
        return true;
      }
      const started = await client.start(startRequestId, CLOUD_HARNESSES[target.providerId], {
        model, reasoning, ...(provider ? { provider } : {}), ...workspace,
        ...(capabilities.command_guard && typeof startInput.command_guard_enabled === "boolean" ? { command_guard_enabled: startInput.command_guard_enabled } : {}),
        ...(capabilities.strip_ai_co_authors && typeof startInput.strip_ai_co_authors === "boolean" ? { strip_ai_co_authors: startInput.strip_ai_co_authors } : {}),
        ...(capabilities.system_prompt && startInput.system_prompt ? { system_prompt: startInput.system_prompt } : {}),
        ...(startInput.parent_thread ? { parent_thread: startInput.parent_thread } : {}),
      });
      const failure = await this.startFailure(client, started.session_id);
      if (failure) {
        void client.close(started.session_id, randomUUID()).catch(() => {});
        throw new ApiError(409, "cloudroom_switch", `${HARNESS_NAMES[target.providerId]} couldn't start in Cloud, so this thread wasn't changed. ${failure}`);
      }
      const after = await client.session(oldSession).catch(() => null);
      if (after?.last_sequence !== before.last_sequence || !["idle", "error"].includes(getThread(this.deps.db, thread.id)?.status ?? "")) {
        void client.close(started.session_id, randomUUID()).catch(() => {});
        throw new ApiError(409, "thread_busy", "The agent got a new message while switching. Try again.");
      }
      saveSwitch(started.session_id);
      // A website that follows threads takes a new session only from Core, or from this older label after Core's list.
      this.syncLabel(thread.id, "switch");
      void client.close(oldSession, randomUUID()).catch((error: unknown) => this.warn("The previous Cloud session could not be closed", error, { threadId: thread.id }));
      for (const id of resumeLoops) void this.sandboxes.automations({ action: "delete", id }).catch((error: unknown) => this.warn("The old session's resume loop could not be deleted", error, { threadId: thread.id }));
    } finally {
      this.switching.delete(thread.id);
      if (continues.done) {
        this.notify(thread.id);
        void this.deliver(thread.id).catch(() => {});
      }
    }
    this.notify(thread.id);
    void this.deliver(thread.id).catch(() => {});
    return false;
  }

  private async startFailure(client: CloudroomClient, sessionId: string): Promise<string | null> {
    const signal = AbortSignal.timeout(30_000);
    while (!signal.aborted) {
      const session = await client.session(sessionId, signal).catch(() => null);
      if (session?.state === "idle") return null;
      if (session && isDead(session.state)) {
        const reasons = (await client.events(sessionId).catch(() => [])).map((record) => record.kind === "state" ? z.object({ reason: z.string() }).safeParse(record.data).data?.reason : undefined);
        return reasons.filter(Boolean).at(-1) ?? `The new agent stopped (${session.state}).`;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
  }

  /**
   * Running child agents and Cloud automations stay tied to the old session, which a switch closes.
   * Core's own "Resume after … plan limit" loops don't block; their ids come back to delete after the switch.
   */
  private async requireNoSessionDependents(threadId: string, saved: Binding): Promise<string[]> {
    const runningChild = this.deps.db.select({ id: threads.id }).from(threads).where(and(eq(threads.parentThreadId, threadId), isNull(threads.archivedAt), isNull(threads.deletedAt), notInArray(threads.status, ["idle", "error"]))).get();
    if (runningChild) throw new ApiError(409, "thread_busy", "Wait until this thread's child agents finish, then switch.");
    const sandbox = sandboxThread(saved.coreUrl);
    if (!sandbox) return [];
    const listed = z.object({ automations: z.array(z.object({ id: z.string().catch(""), name: z.string().catch(""), session_id: z.string().nullable(), enabled: z.boolean() }).passthrough()) }).safeParse(await this.sandboxes.automations({ action: "list", thread: sandbox }).catch(() => null));
    if (!listed.success) throw new ApiError(503, "cloudroom_switch", "Couldn't check this thread's loops. Try again in a moment.");
    const own = listed.data.automations.filter((automation) => automation.enabled && automation.session_id === saved.sessionId);
    const resume = own.filter((automation) => automation.id && /^Resume after (Claude |Codex )?plan limit · /.test(automation.name));
    if (own.length > resume.length) throw new ApiError(409, "cloudroom_switch", "This thread has a Cloud loop. Pause or delete it, then switch.");
    return resume.map((automation) => automation.id);
  }

  /** The old session must be idle, with nothing queued, and fully shown here, so the new agent's history is complete. */
  private async quietSession(client: CloudroomClient, saved: Binding) {
    this.follow(saved, client);
    for (let attempt = 0; ; attempt++) {
      const session = await client.session(saved.sessionId!);
      const caughtUp = (binding(this.deps.db, saved.threadId)?.cursor ?? 0) >= session.last_sequence && !["pending", "starting"].includes(statusOf(session.state) ?? "");
      const busy = ["active", "stopping"].includes(statusOf(session.state) ?? "") || session.current_request !== null || session.queue.length > 0 || commands(this.deps.db, saved.threadId).some((c) => c.state === "sending");
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
    if (payload.model && payload.model !== saved.model) throw new ApiError(409, "cloudroom_launch_settings", `This Cloud thread now runs ${saved.model}. Send again with that model, or to use ${payload.model}, switch first in the model picker or with \`room-cli thread update ${thread.id} --model ${payload.model}\`.`);
    const id = await this.requestId(thread.id, payload.requestId);
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
    // live() runs before this send saves anything: say whether the message is saved (maybe by an overlapping attempt
    // with the same request ID while this one waited), so it isn't sent twice.
    const live = () => this.liveCapabilities(saved).catch((error: unknown) => {
      if (!(error instanceof ApiError) || error.status !== 503) throw error;
      const stored = command(this.deps.db, id);
      throw stored?.threadId === thread.id
        ? new ApiError(503, error.body.code, `${error.body.message} This message is already saved (${stored.state}). Retry with the same request ID; don't send it as a new message.`, { details: { requestId: id, state: stored.state } })
        : new ApiError(503, error.body.code, `${error.body.message} Your message was not sent. Send it again in a moment.`);
    });
    const starting = !saved.sessionId && ["pending", "starting"].includes(thread.status);
    // A stopped thread uses the saved capabilities too, so its message is saved before any wake (#534).
    const fast = starting || (saved.sessionId && ["idle", "error", "active"].includes(thread.status));
    const known = fast ? sandboxThread(saved.coreUrl) ? await this.savedCapabilities() : this.lastCapabilities : null;
    const validated = steer || previous ? null : reasoning;
    let capabilities = known ?? await live();
    let parsed: ReturnType<typeof promptPayload>;
    try { parsed = followUpPayload(thread.providerId, saved, payload, validated, capabilities); }
    catch (error) {
      if (!known || !(error instanceof ApiError)) throw error;
      parsed = followUpPayload(thread.providerId, saved, payload, validated, capabilities = await live());
    }
    if (steer) {
      this.enqueue(thread.id, id, "steer", { target_request_id: saved.turnId, text: parsed.text, content: parsed.content, attachments: parsed.attachments });
      await this.deliver(thread.id);
      return { ok: true, delivery: "sent" };
    }
    const stored = {
      ...parsed,
      ...(reasoning !== saved.reasoning ? { reasoning } : {}),
      ...(payload.serviceTier && payload.serviceTier !== "default" ? { service_tier: payload.serviceTier } : {}),
      ...(payload.senderThreadId ? { sender_thread_id: payload.senderThreadId } : {}),
    };
    if (previous) {
      if (!sameStoredPrompt(previous, thread.id, stored, reasoning, saved.reasoning)) throw new ApiError(409, "request_conflict", "Request ID was already used with different content");
    } else {
      const jumpQueue = saved.queuePaused && this.queue(thread.id).length > 0 && feature(capabilities, "queue_reorder");
      if (thread.status === "error" && saved.sessionId) this.enqueue(thread.id, randomUUID(), "resume", saved.queuePaused ? { keep_paused: true } : {});
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

  /** `offline`: a stop the website refuses to wake the sandbox for still stops, without it (#553). */
  async control(threadId: string, action: "stop" | "resume", offline = true): Promise<void> {
    const saved = binding(this.deps.db, threadId);
    if (!saved) throw new ApiError(409, "cloudroom_missing_binding", "Cloud session is unavailable");
    if (action === "stop" && getThread(this.deps.db, threadId)?.archivedAt) return;
    const wake = action === "resume" || unsentWork(this.deps.db, threadId) || (!saved.queuePaused && queuedPrompts(this.deps.db, threadId).length > 0);
    try { await this.client(saved, wake, undefined, true); }
    catch (error) {
      if (error instanceof SandboxAsleep) return this.asleep(threadId);
      // The website refused the wake before starting the sandbox (out of credits, a plan limit, Free's daily budget), so
      // nothing runs there. Work that never reached Core is cancelled, and the stop waits for the next wake, ahead of later work.
      if (action === "stop" && offline && saved.sessionId && (startRefused(error) || (error instanceof CloudroomError && error.code === BUDGET_LIMIT))) {
        this.deps.db.transaction(tx => {
          const cancelled = new Set<string>();
          for (const item of commands(tx, threadId)) if (item.state === "sending" && (startsWork(item) || cancelled.has(JSON.parse(item.input).target_request_id))) {
            saveCommandState(tx, threadId, item.id, "cancelled");
            cancelled.add(item.id);
          }
          saveBinding(tx, threadId, { queuePaused: true });
          saveStatus(tx, threadId, "idle");
        });
        // Held for the next wake, it stops only the turn it was clicked for: another computer may start one meanwhile.
        this.enqueue(threadId, randomUUID(), "stop", saved.turnId ? { after: saved.turnId } : {});
        this.notify(threadId);
        return this.asleep(threadId);
      }
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, error instanceof CloudroomError ? error.code ?? "cloudroom_unavailable" : "cloudroom_unavailable", publicError(error));
    }
    this.enqueue(threadId, randomUUID(), action, {});
    await this.deliver(threadId);
  }

  archive(threadId: string): void {
    this.refusedSince.delete(threadId);
    const saved = binding(this.deps.db, threadId);
    if (!saved) return;
    const sandbox = sandboxThread(saved.coreUrl);
    if (sandbox) {
      // Archive always wins (ADR 0112): the website stops the sandbox even mid-task, once no other thread runs in it.
      this.detach(threadId);
      if (["active", "stopping"].includes(getThread(this.deps.db, threadId)?.status ?? "")) saveStatus(this.deps.db, threadId, "idle");
      // Only an archive the website took can later be undone through it (cloud-sync.ts).
      if (!coreInUse(this.deps.db, saved.coreUrl)) void this.sandboxes.archive(sandbox).then(() => this.sync.archivedOnWebsite(sandbox, true), error => this.warn("The thread's sandbox could not be archived; it sleeps on its own", error, { threadId }));
      // Its other threads keep the sandbox open, so stop this thread's own agent: a stop, then a sleep, as on a VM.
      else if (saved.sessionId) {
        if (sandbox !== threadId) void this.archiveShared(saved, true);
        const stop = randomUUID(), sleep = randomUUID();
        this.enqueue(threadId, stop, "stop", {});
        this.enqueue(threadId, sleep, "sleep", {});
        void this.stopArchived(threadId, saved.sessionId, stop, sleep).catch(error => this.warn("The archived thread's agent could not be stopped", error, { threadId }));
      }
      // Cloud automations (ADR 0212) stop prompting it. A child shares its parent's sandbox, which stays open.
      if (saved.sessionId) void this.sandboxes.automations({ action: "archived", thread: sandbox, session: saved.sessionId }).catch(error => this.warn("The thread's cloud automations could not be paused", error, { threadId }));
      return;
    }
    this.enqueue(threadId, randomUUID(), "stop", {});
    this.enqueue(threadId, randomUUID(), "sleep", {});
    void this.deliver(threadId).catch(() => {});
  }

  /** Which of these Cloud threads Core says are working now (#237, App 8): one cached idle here may run on another
   *  computer. One session list per awake sandbox, which holds its own session and the ones sharing it; an asleep
   *  sandbox runs nothing and is never woken for this. */
  async runningInCloud(threadIds: string[]): Promise<string[]> {
    const bySandbox = new Map<string, Binding[]>();
    for (const id of threadIds) {
      const saved = binding(this.deps.db, id);
      if (saved?.sessionId && sandboxThread(saved.coreUrl)) bySandbox.set(saved.coreUrl, [...bySandbox.get(saved.coreUrl) ?? [], saved]);
    }
    const running: string[] = [];
    let fresh = true;
    for (const saved of bySandbox.values()) {
      try {
        const client = await this.client(saved[0], false, undefined, fresh);
        fresh = false;
        const sessions = new Map((await client.listSessions()).sessions.map((session) => [session.session_id, session]));
        for (const item of saved) {
          const session = sessions.get(item.sessionId!);
          if (session && (session.current_request || WORKING.includes(session.state))) running.push(item.threadId);
        }
      } catch (error) { fresh = false; if (!(error instanceof SandboxAsleep)) this.warn("A Cloud thread's state could not be read", error, { threadId: saved[0]!.threadId }); }
    }
    return running;
  }

  /** Teleport to Local holds Core's freeze (#237), renewed every 2 minutes: other computers' sends get 409 `moving`
   *  until it lands or lets go. `check` renews it and fails when Core queued a message this computer hasn't seen, which
   *  the move would lose. Older Cores have no freeze: null. */
  async freezeForTeleport(threadId: string, client: CloudroomClient, session: string): Promise<{ id: string; check: () => Promise<void>; end: (release: boolean) => void } | null> {
    if (!feature(await this.capabilities(client), "cloud_threads")) return null;
    const id = randomUUID();
    await client.freeze(session, id).catch((error: unknown) => {
      // Core may have applied it before the reply failed: let go now, or every try is `moving` for 5 minutes (#1554).
      void client.freeze(session, id, true).catch(() => {});
      throw error;
    });
    const renew = setInterval(() => void client.freeze(session, id).catch((error: unknown) => this.warn("Teleport's freeze could not be renewed", error, { threadId })), 120_000);
    renew.unref();
    const check = async () => {
      await client.freeze(session, id);
      // Only another computer's message would be lost; a loop's or Core's own prompt queued there is Core's.
      const queued = (await client.session(session)).queue, here = new Set(commands(this.deps.db, threadId).map((item) => item.id));
      if (queued.some((request) => !here.has(request) && !CORE_OWN.test(request))) throw new ApiError(409, "teleport_unavailable", `A message for this thread is still waiting in Cloud (sent from another computer, the phone or another agent). Teleport again once it has run. The thread stays in Cloud.`);
    };
    return { id, check, end: (release) => {
      clearInterval(renew);
      if (release) void client.freeze(session, id, true).catch(() => {});
    } };
  }

  /** Archives a deleted project's Cloud threads on the website one after another, a second apart, not in one burst.
   *  Their sandboxes and sessions are read now: the delete removes the threads' records here meanwhile. */
  archiveInTurn(threadIds: string[]): void {
    const own = threadIds.flatMap((id) => {
      const saved = binding(this.deps.db, id);
      return saved && sandboxThread(saved.coreUrl) === id ? [{ id, session: saved.sessionId }] : [];
    });
    for (const id of threadIds) if (!own.some((item) => item.id === id)) this.archive(id);
    for (const { id } of own) this.detach(id);
    this.archiving = this.archiving.then(async () => {
      for (const { id, session } of own) {
        await this.sandboxes.archive(id).catch((error: unknown) => this.warn("A deleted project's Cloud thread could not be archived", error, { threadId: id }));
        if (session) await this.sandboxes.automations({ action: "archived", thread: id, session }).catch((error: unknown) => this.warn("The thread's cloud automations could not be paused", error, { threadId: id }));
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    });
  }
  private archiving: Promise<void> = Promise.resolve();

  /** Sends an archived thread's saved stop and sleep straight to its Core, without following its stream. An asleep
   *  sandbox runs nothing, so it is never woken for this. Unsent ones are dropped, so an unarchived thread never gets them. */
  private async stopArchived(threadId: string, sessionId: string, stop: string, sleep: string): Promise<void> {
    try {
      for (let tries = 1; ; tries++) {
        const saved = binding(this.deps.db, threadId);
        if (!saved || !getThread(this.deps.db, threadId)?.archivedAt) return;
        try {
          const client = await this.client(saved, false);
          for (const [id, action] of [[stop, "stop"], [sleep, "sleep"]] as const) {
            if (command(this.deps.db, id)?.state !== "sending") continue;
            saveCommandState(this.deps.db, threadId, id, (await client[action](sessionId, id)).receipt.state);
            // So a message sent after an unarchive resumes the queue first, as after the user's own Stop.
            if (action === "stop") saveBinding(this.deps.db, threadId, { queuePaused: true });
          }
          return;
        } catch (error) {
          if (error instanceof SandboxAsleep) return;
          if (!(error instanceof CloudroomConnectionError) || tries >= 3) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 2_000));
      }
    } finally {
      for (const id of [stop, sleep]) if (command(this.deps.db, id)?.state === "sending") saveCommandState(this.deps.db, threadId, id, "failed");
    }
  }

  /** Delete: the website erases the thread's own sandbox, snapshots, saved copy, and chat history. Children share it. */
  remove(threadId: string): void {
    this.refusedSince.delete(threadId);
    const saved = binding(this.deps.db, threadId);
    if (!saved) return;
    this.detach(threadId);
    this.threadStates.set(threadId, null);
    void this.sync.deletedHere(threadId);
    const sandbox = sandboxThread(saved.coreUrl);
    if (sandbox === threadId) void this.sandboxes.remove(sandbox).catch(error => this.warn("The thread's sandbox could not be deleted; it sleeps on its own", error, { threadId }));
  }

  /** Each sandbox works on its own branch, named after the thread: room/<name>-<id> (docs/scopes/sandboxes.md).
   *  `create` switches a fresh checkout to it, and says why if it could not; later calls only rename it to match a new
   *  title, before its first push. `onKept` hears of a branch the agent made, which `create` leaves as it is. */
  private async ensureBranch(threadId: string, create: boolean, onKept?: (branch: string) => void): Promise<string | null> {
    const saved = binding(this.deps.db, threadId);
    const thread = getThread(this.deps.db, threadId);
    if (!saved?.sessionId || !thread || sandboxThread(saved.coreUrl) !== threadId) return null;
    const name = buildSuggestedBranchName({ branchPrefix: "room/", title: thread.title ?? thread.titleFallback ?? null, threadId });
    try {
      const client = await this.client(saved, false), sessionId = saved.sessionId;
      // A new thread's lost answer (a dropped connection, a proxy's 504) is asked again (#1524). A try this app gave up
      // waiting for, such as a stuck fetch, is not run again.
      const again = <T>(attempt: (signal: AbortSignal) => Promise<T>) => {
        const once = () => {
          const signal = AbortSignal.timeout(5 * 60_000);
          return attempt(signal).catch((error: unknown) => { throw signal.aborted && error instanceof Error ? new Error(error.message) : error; });
        };
        return create ? retry(once) : once();
      };
      const workspace = await again(signal => client.sessionWorkspace(sessionId, signal));
      if (create) this.progress(threadId, [{ key: "workspace", text: `Using workspace: ${workspace.path}`, status: "completed" }]);
      if (!workspace.head) return null;
      const quoted = `'${name}'`;
      // A warm project snapshot skips the clone, so switch to the chosen base branch here.
      const base = baseBranch(command(this.deps.db, `first_${threadId}`)?.input);
      const switchBase = base ? `[ "$current" = '${base}' ] || { git fetch -q origin '${base}' && git checkout -q -B '${base}' 'origin/${base}'; } 2>/dev/null; ` : "";
      // Only the branch Cloudroom's clone or snapshot checked out moves. One the agent made or checked out itself stays,
      // with its commits and any merge in progress (#1370, #1377). With no known default branch, it moves as before.
      const kept = 3;
      const own = `default=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null); [ -z "$default" ] || [ "$current" = "\${default#origin/}" ]${base ? ` || [ "$current" = '${base}' ]` : ""} || { printf '%s\\n' "$current"; exit ${kept}; }; `;
      const script = create
        ? `current=$(git symbolic-ref --quiet --short HEAD) || exit 0; case "$current" in room/*|cloudroom/*) ;; *) ${own}${switchBase}git pull -q --ff-only 2>/dev/null; git checkout -q -b ${quoted} ;; esac`
        : `current=$(git symbolic-ref --quiet --short HEAD) || exit 0; case "$current" in room/*|cloudroom/*) [ "$current" = ${quoted} ] || git rev-parse -q --verify "$current@{upstream}" >/dev/null || git branch -m ${quoted} ;; esac`;
      // One switch at a time per checkout: a retry waits for the try whose answer was lost, then finds its branch and
      // changes nothing, so the late try can't move the folder back to the base branch (#1524).
      const lock = `exec 9>>"$(git rev-parse --git-path cloudroom-branch.lock)" && flock 9; `;
      const result = await again(signal => client.runOnVm({ command: `${lock}${script}\ngit symbolic-ref --quiet --short HEAD`, cwd: workspace.path }, signal));
      const branch = Buffer.from(result.stdout, "hex").toString().trim().split("\n").at(-1);
      if (branch) this.progress(threadId, [{ key: "branch", text: `Using branch: ${branch}`, status: "completed" }]);
      if (create && result.code === kept && branch) { onKept?.(branch); return null; }
      // A detached checkout exits 0 with no branch to switch. A failed or killed command, or any other branch, means the
      // switch failed (#816).
      if (!create || result.code === 0 && (!branch || /^(room|cloudroom)\//.test(branch))) return null;
      return `Cloudroom could not switch the folder to the thread's branch ${name}${branch ? `, so it is still on ${branch}` : ""}. Git said: ${Buffer.from(result.stderr, "hex").toString().trim().slice(-300) || `exit code ${result.code}`}`;
    } catch (error) {
      // A rename that fails never blocks the agent; the next title change retries.
      return create ? `Cloudroom could not set up the thread's branch ${name}: ${error instanceof Error ? error.message : String(error)}` : null;
    }
  }

  /** Restores the sandbox the thread runs in, which may be another thread's: an unarchived child keeps its parent's. */
  async restore(threadId: string): Promise<void> {
    const saved = binding(this.deps.db, threadId), sandbox = sandboxThread(saved?.coreUrl ?? "");
    if (!saved || !sandbox) return;
    // Naming the session resumes only the loops its archive paused (#237); older websites take no session.
    const session = sandbox === threadId && saved.sessionId && await this.sandboxes.followsThreads().catch(() => false) ? saved.sessionId : undefined;
    await this.sandboxes.restore(sandbox, session);
    await this.sync.archivedOnWebsite(sandbox, false);
    if (sandbox !== threadId) void this.archiveShared(saved, false);
  }

  /** A shared child's archive lives in Core, so every computer sees it (#237). An asleep sandbox isn't woken for it. */
  private async archiveShared(saved: Binding, archived: boolean): Promise<void> {
    if (!saved.sessionId) return;
    try {
      const client = await this.client(saved, false);
      if (feature(await this.capabilities(client), "cloud_threads")) await client.archiveSession(saved.sessionId, randomUUID(), archived);
    } catch (error) { if (!(error instanceof SandboxAsleep)) this.warn("A shared child's archive could not be saved in Cloud", error, { threadId: saved.threadId }); }
  }

  private snapshotInstructions(db: DbQueryConnection, thread: Pick<Thread, "id" | "projectId">, action: Command["command"], input: object): object {
    if (!["prompt", "edit", "steer", "rewind"].includes(action)) return input;
    const prompt = z.object({ text: z.string(), content: z.unknown().optional() }).parse(
      action === "rewind" && "replacement" in input ? input.replacement : input,
    );
    const context = { threadId: thread.id, projectId: thread.projectId };
    // Checked with the instructions even when this message won't carry them. The core's real limit is checked again on send.
    prepareCloudInstructionInput(prompt, resolveCustomInstructions(context), cloudPromptLimit(null));
    // An edit replaces a queued message and a rewind drops later ones, either of which may have carried them.
    return { ...input, customInstructions: dueCustomInstructions(db, context, action === "edit" || action === "rewind") };
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
    this.deps.db.insert(cloudroomCommands).values({ id, threadId, command: action, input: JSON.stringify(this.snapshotInstructions(this.deps.db, thread, action, input)), createdAt }).run();
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
      const candidate = attachment.localPath.startsWith("/") || (process.platform === "win32" && win32.isAbsolute(attachment.localPath)) ? attachment.localPath : join(root, attachment.localPath);
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
    const id = await this.requestId(thread.id, payload.requestId);
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
      pausedByStop: this.stopHeld(saved), createdAt: c.createdAt, updatedAt: c.createdAt + revision - 1,
    });
  }

  /** Stop pauses Core's queue until a resume, even across turns Core starts itself (#967). Only the session that Stop
   *  paused shows it, and a resume sent after that Stop, still on its way, already lifts it. Delivery never reads this. */
  private stopHeld(saved: Binding): boolean {
    const stop = this.stops.get(saved.threadId);
    return saved.queuePaused && stop?.session === saved.sessionId && !commands(this.deps.db, saved.threadId).some(c => c.command === "resume" && c.createdAt >= stop.at && ["sending", "accepted"].includes(c.state) && !JSON.parse(c.input).keep_paused);
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
    const id = appRequestId(await this.me(), `qe_${createHash("sha256").update(JSON.stringify([thread.id, input])).digest("hex").slice(0, 60)}`);
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
    await this.requireOwnThread(saved);
    // Before its session starts, Core has never seen a follow-up, so it is removed here without waking anything (#866).
    // Read from saved state, whatever the thread's status: a failed start hides its queue but a retry still sends it.
    // Check and write with no await between: delivery saves the session before it reads which prompts to send.
    const target = command(this.deps.db, queuedMessageId);
    if (!binding(this.deps.db, thread.id)?.sessionId && target?.command === "prompt" && target.state === "sending" && target.id !== `first_${thread.id}` && !JSON.parse(target.input).teleport_handoff) {
      saveCommandState(this.deps.db, thread.id, queuedMessageId, "cancelled");
      return this.notify(thread.id);
    }
    if (!feature(await this.queueCapabilities(saved), "queue_cancel")) throw new ApiError(409, "cloudroom_unsupported", "Cloud queue cancellation is not enabled.");
    const id = randomUUID();
    this.enqueue(thread.id, id, "cancel", { target_request_id: queuedMessageId });
    await this.deliver(thread.id).catch((error: unknown) => {
      if (!(error instanceof ApiError && error.status === 503) || command(this.deps.db, id)?.state !== "sending") throw error;
      throw new ApiError(503, error.body.code, `${error.body.message} The delete is saved and is sent once the cloud thread can take it, unless the agent starts this message first.`);
    });
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
    if (!saved || !queued) {
      // Core may deliver a queued prompt before its send arrives (#1203). Say so, and never send it again. `running`
      // only means the turn is starting: preparing it can still fail before the harness gets the prompt.
      const sent = command(this.deps.db, queuedMessageId);
      if (saved && sent?.threadId === thread.id && sent.command === "prompt" && ["delivered", "completed", "interrupted"].includes(sent.state)) return { ok: true, delivery: "sent" };
      throw new ApiError(404, "invalid_request", "Queued message not found");
    }
    const active = thread.status === "active" && saved.turnId !== null && !unstartedTurn(this.deps.db, thread.id);
    if (active) {
      const capabilities = await this.queueCapabilities(saved);
      if (feature(capabilities, "steer") && feature(capabilities, "queue_cancel") && harnessProfile(capabilities, thread.providerId)?.steer !== false) {
        await this.send(thread, { mode: "steer", input: queued.content });
        await this.cancelQueued(thread, queuedMessageId).catch(() => {});
        return { ok: true, delivery: "sent" };
      }
    }
    if (queue[0]!.id !== queuedMessageId) throw new ApiError(409, "invalid_request", "This Cloud agent sends queued messages in order. Send or delete the earlier messages first.");
    // Over a plan limit this fails as a whole, never cancelling the message to send.
    if (active) await this.control(thread.id, "stop", false);
    await this.control(thread.id, "resume");
    return { ok: true, delivery: "queued", queuedMessage: { ...queued, pausedByStop: false } };
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
    let saved = binding(this.deps.db, thread.id);
    if (!saved?.sessionId) throw new ApiError(409, "cloudroom_missing_binding", "Cloud session is unavailable");
    const editable = (capabilities: Capabilities) => feature(capabilities, "rewind") && harnessProfile(capabilities, thread.providerId)?.rewind !== false;
    const known = sandboxThread(saved.coreUrl) ? await this.savedCapabilities() : this.lastCapabilities;
    const capabilities = known && harnessProfile(known, thread.providerId) && editable(known) ? known : await this.liveCapabilities(saved);
    if (!editable(capabilities)) throw new ApiError(409, "cloudroom_unsupported", "Cloud message editing is not enabled for this harness.");
    const parsed = promptPayload(payload.input, thread.providerId, capabilities.attachments && (harnessProfile(capabilities, thread.providerId)?.attachments ?? true), cloudPromptLimit(capabilities));
    const tag = await this.me(), rewindId = appRequestId(tag, `rewind_${payload.operationId}`);
    const promptId = appRequestId(tag, `edit_${payload.operationId}`);
    const replacement = { request_id: promptId, ...parsed, reasoning: payload.reasoningLevel ?? saved.reasoning, service_tier: payload.serviceTier ?? "default" };
    const previous = command(this.deps.db, rewindId);
    if (previous) {
      const original = JSON.parse(previous.input);
      if (previous.threadId !== thread.id || original.expected_request_sequence !== payload.expectedRequestSequence || JSON.stringify(original.replacement) !== JSON.stringify(replacement)) throw new ApiError(409, "request_conflict", "This edit operation ID belongs to another edit");
    } else {
      if (this.queue(thread.id).length) throw new ApiError(409, "invalid_request", "Send or remove queued messages before editing a message");
      const status = () => getThread(this.deps.db, thread.id)?.status;
      const quiet = () => status() === "idle" || status() === "error";
      if (status() === "active" || status() === "stopping") {
        await this.control(thread.id, "stop");
        if (!await this.until(thread.id, quiet, 60_000)) throw new ApiError(409, "invalid_request", "The thread did not stop before the message edit timed out");
        saved = binding(this.deps.db, thread.id) ?? saved;
      }
      if (!quiet()) throw new ApiError(409, "invalid_request", "Wait for the active turn to finish before editing a sent message");
      const before = nativeRewindBefore(this.deps.db, thread.id, payload.expectedRequestSequence);
      // An edit is an explicit send, so it lifts the pause left by Stop. Core rejects resume mid-rewind, so it goes first.
      if (saved.queuePaused) this.enqueue(thread.id, `resume_${payload.operationId}`, "resume", {});
      this.enqueue(thread.id, rewindId, "rewind", { before, expected_request_sequence: payload.expectedRequestSequence, replacement });
    }
    try { await this.deliverWhenAwake(thread.id); }
    catch (error) {
      for (const id of [`resume_${payload.operationId}`, rewindId]) {
        if (command(this.deps.db, id)?.state === "sending") saveCommandState(this.deps.db, thread.id, id, "failed");
      }
      throw error;
    }
    const state = () => command(this.deps.db, rewindId)?.state ?? "";
    await this.until(thread.id, () => !["sending", "accepted", "running"].includes(state()), 30_000);
    if (["failed", "unknown", "unknown_after_restart"].includes(state())) throw new ApiError(409, "cloudroom_command_failed", "The rewind failed or its outcome is uncertain. Your original history is preserved.");
    return { ok: true, operationId: payload.operationId, requestSequence: payload.expectedRequestSequence ?? 0 };
  }

  private async until(threadId: string, done: () => boolean, ms: number): Promise<boolean> {
    for (const deadline = Date.now() + ms; !done();) {
      if (deadline <= Date.now()) return false;
      const waiter = this.deps.hub.registerThreadEventWaiter(threadId, deadline - Date.now());
      if (done()) waiter.cancel();
      else await waiter.promise;
    }
    return true;
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

  private failStart(threadId: string, message: string, cause?: unknown): void {
    // The raw cause (say, a vendor's 404 text) and how long after its creation the start failed, for late notices (#1076).
    this.warn("A cloud start failed", cause ?? message, { threadId, ageMs: Date.now() - (getThread(this.deps.db, threadId)?.createdAt ?? Date.now()) });
    // Cloud refused Codex's login: resend this Mac's working one before anyone has to click.
    if (cloudLoginProvider(message) === "codex" && authRequiredMessages.has(message)) this.healCodex();
    this.deps.db.transaction((tx) => {
      saveCommandState(tx, threadId, `first_${threadId}`, "failed", { code: refusal(cause).code, message });
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
    void this.me().catch(() => {});
    this.sync.start();
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
    this.previewFailures = 0;
    this.previewIssue = null;
    this.claudeConnected = null;
    this.stopped = true;
    this.sync.stop();
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

  /** A note for a sandbox agent's next prompt once the account has used 80 %, then 95 %, of its Cloud Credits, plan
   *  and packs together (#610). Reads only the usage the app already caches, never asking the website. It sits in the
   *  agent-only custom instructions envelope, which every app and the phone already hide from the user. */
  private creditsNote(threadId: string, coreUrl: string, capabilities: Capabilities): { note: string; level: number } | null {
    const sandbox = sandboxThread(coreUrl), usage = sandbox ? this.sandboxes.planUsage(false) : null;
    if (!sandbox || !usage || usage.credits === null) return null;
    const total = usage.creditsLimit + usage.extraCreditsTotal;
    const left = Math.max(0, usage.creditsLimit - usage.credits) + usage.extraCredits;
    const used = total > 0 ? 1 - left / total : 1, level = used >= 0.95 ? 95 : used >= 0.8 ? 80 : 0;
    const told = this.creditsTold.get(threadId) ?? 0;
    // Usage that falls back (old usage ages out, a pack) lowers the level, so a later climb tells again.
    if (level < told) this.creditsTold.set(threadId, level);
    // A VPS thread uses no credits; placement the app hasn't heard from the website gets no note, and no lookup.
    if (level <= told || !this.sandboxes.knownInCloud(sandbox)) return null;
    const check = feature(capabilities, "credits_usage") ? " Run `room-cli usage` before a big fan-out." : "";
    return { level, note: `<cloudroom_custom_instructions>\n[Cloud Credits] This account has used ${Math.floor(used * 100)}% of its Cloud Credits (${Math.floor(left).toLocaleString("en-US")} left). When none are left, its Cloud sandboxes stop, even mid-turn. Don't start sandboxes it doesn't need.${check}\n</cloudroom_custom_instructions>` };
  }

  /** The agent-only text after a prompt: its workspace hint if it fits, then the Cloud Credits note if that fits too.
   *  A level counts as told only once its note goes out. A built-in command typed alone (`/clear`) gets no note: the
   *  four that skip custom instructions. Cloud refuses them as picked commands, so only their text can tell. */
  private promptContext(threadId: string, coreUrl: string, capabilities: Capabilities, typed: string, text: string, hint: string | null): string | null {
    const fits = (context: string) => Buffer.byteLength(`${text}\n\n${context}`, "utf8") <= cloudPromptLimit(capabilities);
    const context = hint && fits(hint) ? hint : null;
    const credits = /^\/(?:compact|clear|teleport|context)$/.test(typed.trim()) ? null : this.creditsNote(threadId, coreUrl, capabilities);
    const noted = credits && [context, credits.note].filter(Boolean).join("\n\n");
    if (!credits || !noted || !fits(noted)) return context;
    this.creditsTold.set(threadId, credits.level);
    return noted;
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
    let delivering: CloudroomClient | undefined;
    try {
      const bound = saved;
      let catchUp = false;
      const work = () => !bound.sessionId || unsentWork(this.deps.db, threadId) || (catchUp ||= this.catchUpForParent(bound));
      const client = await this.client(saved, work);
      delivering = client;
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
        const plan = { key: copyKey(sandbox, target ?? ""), branch: baseBranch(initial?.input) };
        // The project's loops get its current .env files (ADR 20261101-004659).
        if (target) syncLoopEnv(this.deps, this.sandboxes, getThread(this.deps.db, threadId)?.projectId);
        const failure = (error: unknown) => error instanceof Error ? error : new Error(String(error));
        // A copy that can't be planned fails where the user and `room-cli files wait` see it, never as nothing to copy (#337).
        const [planned, started] = await Promise.all([
          target ? planNewProjectCopy(this.deps, client, threadId, target, plan).catch(failure) : null,
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
            : client.start(saved.startRequestId, CLOUD_HARNESSES[harness], { model, reasoning: initial && JSON.parse(initial.input).default_reasoning ? undefined : saved.reasoning, ...options, ...parentThread, ...(provider ? { provider } : {}) }).then((accepted) => {
              const transfer = `child_${threadId}`;
              return { sessionId: accepted.session_id, transfer, code: codeFrom ? threadCode(this.deps, codeFrom, transfer) : null };
            }),
        ]);
        const copy = planned instanceof Error ? null : planned;
        // Like any failed copy, the card shows only for a project with no folder on the Mac; otherwise only the agent
        // is told, and pulls what it needs (docs/scopes/sandboxes.md, David, 2026-10-13).
        const macPath = planned instanceof Error ? localProjectPath(this.deps, getThread(this.deps.db, threadId)?.projectId ?? "") : undefined;
        const unplanned = planned instanceof Error ? `The copy could not start: ${planned.message}`.slice(0, 500)
          + (macPath ? ` ${localFilesNote(macPath)}` : "") : undefined;
        // A sandbox too slow to answer in time gets one more try when the thread's stream connects, like a copy the app
        // cut off (#1040). The error is kept, so that try fails as this one would have. A fork's code can't wait for it.
        const replan = planned instanceof Error && !started.code && slowSandbox(planned);
        if (unplanned) this.warn("Cloud project copy could not be planned", planned, { threadId });
        if (unplanned && !replan && !macPath) reportProjectCopy(this.deps, threadId, { phase: "error", completed: 0, total: 0, error: unplanned });
        const copying = copy?.clone && copy.repository ? `Cloning ${copy.repository.replace("https://github.com/", "")}` : copy?.copyAll ? `Copying project from your ${COMPUTER}` : null;
        const files: StartStep[] = copying ? [{ key: "files", text: copying, status: "started" }] : [];
        const forkCode: StartStep[] = started.code ? [{ key: "fork", text: "Copying the source thread's code", status: "started" }] : [];
        this.progress(threadId, [{ key: "agent", status: "completed" }, ...files, ...forkCode], "completed");
        const firstSent = new Promise<void>(resolve => { releaseCopy = resolve; });
        // `room-cli files wait` holds the agent until the files, a fork's code, and its own sandbox's branch are ready
        // (ADR 0209). The mark lands before the first message: an unmarked folder with files reads as done, so an agent
        // could start mid-checkout (#816). A Git checkout already there (a project template) still gets its branch.
        // A child in a Personal project has no workspace of its own, so its status file sits next to the sandbox root.
        // The session is saved only after the status, so a failed check or write starts it again on the next try (Core
        // keeps the same session) instead of sending the first message with setup unmarked.
        // After 3 failed tries the start fails where the user sees it; a permanent error fails it at once.
        const workspace = await (async () => {
          // Core's 404 means no workspace, like `client.workspace`; any other error tries again.
          const lookup = () => client.sessionWorkspace(started.sessionId).catch((error: unknown) => {
            if (error instanceof CloudroomError && error.status === 404) return null;
            throw error;
          });
          const folder = target && (files.length || started.code || unplanned || sandbox === threadId && (await lookup())?.head) ? target
            : started.code ? (await lookup())?.path ?? null : null;
          if (folder) await writeFilesState(client, folder, "copying");
          this.prepTries.delete(threadId);
          return folder;
        })().catch((error: unknown) => {
          const tries = (this.prepTries.get(threadId) ?? 0) + 1;
          this.prepTries.set(threadId, tries);
          if (tries < 3) throw error;
          this.prepTries.delete(threadId);
          throw new ApiError(400, "cloudroom_files", `Cloudroom could not prepare the project folder: ${error instanceof Error ? error.message : String(error)}`);
        });
        saveBinding(this.deps.db, threadId, { sessionId: started.sessionId, error: null });
        this.refusedSince.delete(threadId);
        saved = binding(this.deps.db, threadId)!;
        const marked = workspace ? Promise.resolve() : null;
        const landed = this.landing(threadId, client, started, files.length > 0, workspace, marked);
        if (copy) this.copy(client, copy, landed, firstSent);
        else if (replan && workspace) reportProjectCopy(this.deps, threadId, { phase: "waiting", completed: 0, total: 0, error: unplanned });
        else if (workspace || started.code) void landed(unplanned);
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
              context = this.promptContext(threadId, saved.coreUrl, capabilities, parsed.text, enriched.text, hint);
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
          } else if (pending.command === "model") {
            const parsed = modelPickSchema.parse(JSON.parse(pending.input));
            // A Core that predates the switch (still awake from before a release) keeps its model, and so does the thread.
            if (!harness || !await this.switchesModels(saved.coreUrl, harness, () => this.capabilities(client))) {
              this.keepModel(threadId, pending);
              continue;
            }
            accepted = await client.setModel(sessionId, pending.id, parsed.model, parsed.reasoning);
          } else if (pending.command === "cancel") {
            accepted = await client.cancel(sessionId, pending.id, JSON.parse(pending.input).target_request_id);
          } else if (pending.command === "reorder") {
            accepted = await client.reorder(sessionId, pending.id, z.object({ order: z.array(z.string()) }).parse(JSON.parse(pending.input)).order);
          } else if (pending.command === "steer") {
            const parsed = z.object({ target_request_id: z.string(), text: z.string(), customInstructions: z.string().default(""), attachments: z.array(z.object({ name: z.string(), kind: z.enum(["image", "file"]), localPath: z.string().optional(), path: z.string().optional(), id: z.string().optional() })).default([]) }).parse(JSON.parse(pending.input));
            if (parsed.attachments.length && !capabilities.attachments) throw new ApiError(400, "cloudroom_unsupported", "Update the cloud core to use attachments. Your message is saved.");
            // Core steers text only, so files go up first and the agent gets their paths, as Core does for prompt files.
            const uploaded = await this.uploadAttachments(client, sessionId, pending.id, parsed.attachments, getThread(this.deps.db, threadId)?.projectId ?? "", capabilities.upload_parts);
            const text = [prepareCloudInstructionInput(parsed, parsed.customInstructions, cloudPromptLimit(capabilities)).text, ...uploaded.map((file) => `[Attached ${file.kind}: ${file.path}]`)].join("\n");
            accepted = await client.steer(sessionId, pending.id, parsed.target_request_id, text);
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
          } else if (pending.command === "resume") {
            const keepPaused = JSON.parse(pending.input).keep_paused === true;
            // Cached capabilities can describe another sandbox or an older Core; never fall back to releasing Stop.
            if (keepPaused && !feature(await this.capabilities(client), "resume_keep_paused")) throw new ApiError(503, "cloudroom_update", "Update the cloud core to restart this stopped agent safely. Your message is saved.");
            accepted = await client.resume(sessionId, pending.id, keepPaused);
          } else if (pending.command === "stop" || pending.command === "sleep") {
            const after = pending.command === "stop" ? z.object({ after: z.string().optional() }).catch({}).parse(JSON.parse(pending.input)).after : undefined;
            accepted = after && feature(await this.capabilities(client), "cloud_threads") ? await client.stop(sessionId, pending.id, after) : await client[pending.command](sessionId, pending.id);
          } else {
            throw new CloudroomError(`Unsupported cloud command ${pending.command}`, 400);
          }
          if (command(this.deps.db, pending.id)?.state === "sending") saveCommandState(this.deps.db, threadId, pending.id, accepted.receipt.state);
          if (pending.command === "prompt") void this.rememberCloudMessage(sessionId, pending.id, epoch).catch(() => {});
        } catch (error) {
          // A stale sandbox address: the catch below wakes it again, so keep the command unsent.
          const stale = sandboxThread(saved.coreUrl) && staleSandboxAddress(error) && (this.rewoken.get(threadId) ?? 0) < STALE_REWAKES;
          if (!stale && refused(error, ["steer", "edit", "cancel", "reorder"].includes(pending.command))) {
            if (pending.command === "steer") {
              // Usually its turn just ended. It queues ahead of anything sent after it; the same ID makes a repeat harmless.
              const { text, content, attachments } = z.object({ text: z.string(), content: z.unknown().optional(), attachments: z.array(z.unknown()).optional() }).parse(JSON.parse(pending.input));
              const id = appRequestId(await this.me(), `queued-${createHash("sha256").update(pending.id).digest("hex").slice(0, 32)}`);
              this.enqueue(threadId, id, "prompt", { text, ...(content === undefined ? {} : { content }), ...(attachments?.length ? { attachments } : {}) }, pending.createdAt);
              saveCommandState(this.deps.db, threadId, pending.id, "failed");
              if (this.deps.db.transaction(tx => projectFollowUp(tx, threadId, id))) this.notify(threadId, ["client/turn/requested"]);
              void this.deliver(threadId).catch(() => {});
              return;
            }
            if (pending.command === "model") {
              this.keepModel(threadId, pending);
              continue;
            }
            saveCommandState(this.deps.db, threadId, pending.id, "failed", refusal(error));
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
      // A stale sandbox address: forget it and wake it again, a few times, before failing the thread's start
      // (feedback #596, #1076). The 1.5 s delivery timer makes the next try.
      const sandbox = sandboxThread(saved.coreUrl), stale = Boolean(sandbox) && staleSandboxAddress(error), rewakes = this.rewoken.get(threadId) ?? 0;
      if (sandbox && stale && rewakes < STALE_REWAKES) {
        this.rewoken.set(threadId, rewakes + 1);
        this.sandboxes.forget(sandbox);
        return;
      }
      if (error instanceof SandboxAsleep) return this.asleep(threadId);
      if (delivering && error instanceof CloudroomError && error.code === "storage_blocked") this.measureDisk(threadId, delivering);
      // Core's own 404 (a codeless "session not found") keeps its words; only a stale address gets the plain ones.
      const message = stale && !(error as Error).message.endsWith("session not found") ? unreachableSandbox : publicError(error);
      const permanent = error instanceof CloudroomError ? !error.retryable : error instanceof ApiError && error.status === 400;
      if (!binding(this.deps.db, threadId)?.sessionId && permanent) this.failStart(threadId, message, error);
      else if (((connectionFailure(error) || sandboxTransition(error)) && !rejectedCommand) || !deliveringCommand) this.setConnectionIssue(threadId, "delivery", error);
      else {
        saveBinding(this.deps.db, threadId, { error: message });
        this.setConnectionIssue(threadId, "delivery");
        this.notify(threadId);
      }
      // A start Core refuses "for now" (a failing login or model check) retries forever. After 2 minutes of that, its
      // Cloud parent hears why, once, so it doesn't wait blind or spawn a twin (#865).
      const unstarted = !binding(this.deps.db, threadId)?.sessionId, live = getThread(this.deps.db, threadId);
      // A refusal that lands after an archive or removal starts no clock: it would outlive an unarchive.
      const refusing = unstarted && Boolean(live && !live.archivedAt && !live.deletedAt) && error instanceof CloudroomError && error.status === 409 && error.retryable;
      if (!refusing) this.refusedSince.delete(threadId);
      else if (!this.refusedSince.has(threadId)) this.refusedSince.set(threadId, Date.now());
      const stuck = refusing && Date.now() - this.refusedSince.get(threadId)! >= 120_000;
      if ((startRefused(error) || stuck) && unstarted) void this.noticeCloudParent(threadId, error instanceof CloudroomError && error.code === CLOUD_REGION ? "blocked" : "refused", "refused", message).catch((error: unknown) => this.warn("A child report could not be sent", error, { threadId }));
      throw new ApiError(permanent ? 400 : 503, error instanceof CloudroomError ? error.code ?? "cloudroom_unavailable" : "cloudroom_unavailable", message);
    } finally { releaseCopy?.(); }
  }

  /** A session sharing this thread's sandbox, from the parent's `child` record or Core's session list (#237). Every
   *  computer gives it the same thread ID; home names it. `live`: its records so far are this computer's to act on. */
  private async followChild(parent: Binding, client: CloudroomClient, childId: string, live: boolean, parentSessions = [parent.sessionId!]): Promise<void> {
    const parentThread = getThread(this.deps.db, parent.threadId);
    if (!parentThread) return;
    const existing = this.deps.db.select().from(cloudroomThreads).where(and(eq(cloudroomThreads.coreUrl, parent.coreUrl), eq(cloudroomThreads.sessionId, childId))).get();
    if (existing) { this.follow(existing, client); return; }
    const session = await client.session(childId);
    const start = Object.values(session.receipts).find(receipt => receipt.command === "start");
    const input = z.object({ parent_session: z.string().refine(id => parentSessions.includes(id)), reasoning: z.string().nullable().optional(), title: z.string().optional(), prompt: z.string().optional() }).parse(start?.input);
    const providerId = (Object.keys(CLOUD_HARNESSES) as CloudProvider[]).find(id => CLOUD_HARNESSES[id] === session.harness);
    if (!providerId || !start) throw new CloudroomError("Invalid Cloudroom child session");
    const id = sharedChildId(parent.coreUrl, childId), title = session.title ?? input.title ?? null;
    const child = this.deps.db.transaction(tx => {
      const saved = tx.select().from(cloudroomThreads).where(and(eq(cloudroomThreads.coreUrl, parent.coreUrl), eq(cloudroomThreads.sessionId, childId))).get();
      if (saved || getThread(tx, id)) return saved ?? null;
      const prompt: PromptInput[] = [{ type: "text", text: input.prompt ?? "", mentions: [] }];
      const thread = createThread(tx, this.deps.hub, { id, executionTarget: "cloud", projectId: parentThread.projectId, providerId, parentThreadId: parent.threadId, title, titleFallback: deriveTitleFallback(prompt) ?? `${HARNESS_NAMES[providerId]} child`, status: "pending" });
      if (!title && this.isHome(parent.threadId)) queueThreadTitle(tx, thread.id, prompt);
      tx.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: parent.coreUrl, sessionId: childId, startRequestId: start.request_id, model: start.model ?? parent.model, reasoning: input.reasoning ?? parent.reasoning }).run();
      for (const receipt of Object.values(session.receipts).filter(receipt => receipt.command === "prompt")) {
        tx.insert(cloudroomCommands).values({ id: receipt.request_id, threadId: thread.id, command: "prompt", input: JSON.stringify(receipt.input), state: "accepted", createdAt: Date.now() }).run();
      }
      return binding(tx, thread.id)!;
    });
    if (!child) return;
    if (!this.threadStates.get(child.threadId)) this.threadStates.set(child.threadId, { session: childId, actFrom: live ? 0 : null, home: null, from: parent.threadId });
    this.follow(child, client);
    this.notify(child.threadId);
  }

  /** A session this computer never streamed shows the shared children Core lists under it, and under the session it
   *  continues: their `child` records may be older than the stream it reads (#237). */
  private async listChildren(parent: Binding, client: CloudroomClient, from: string | undefined): Promise<void> {
    const parents = [parent.sessionId!, ...(from ? [from] : [])];
    for (const summary of (await client.listSessions()).sessions) {
      if (summary.parent_session && parents.includes(summary.parent_session) && !summary.archived && summary.state !== "closed") await this.followChild(parent, client, summary.session_id, false, parents).catch((error: unknown) => this.warn("A Cloud child thread could not be shown", error, { threadId: parent.threadId }));
    }
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

  /** A parent moving either way holds its children's reports until it lands. Teleport to Local closes the Cloud session
   *  that Core's reports go to, so without the hold a turn ending meanwhile reaches neither copy. */
  private teleportingParent(threadId: string): boolean {
    const parent = this.reportedParent(getThread(this.deps.db, threadId));
    return Boolean(parent && this.moving(parent.id));
  }

  private moving(threadId: string): boolean {
    return teleportBlocked(this.deps.db, threadId) || localTeleports.has(threadId);
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
            if (parent && this.moving(parent.id)) { waiting = true; continue; }
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
    // A start notice is stale once the child was archived, removed or started meanwhile (#865).
    const now = getThread(this.deps.db, threadId);
    if ((status === "refused" || status === "blocked") && (!now || now.archivedAt || now.deletedAt || binding(this.deps.db, threadId)?.sessionId)) return;
    const first = command(this.deps.db, `first_${child.id}`);
    if (status !== "not_started" && status !== "refused" && status !== "blocked" && first && JSON.parse(first.input).parent_thread && parentSaved?.coreUrl === SANDBOX_PREFIX + parent.id) return;
    // A child the website started has Core report its turns (ADR 20261104-015709).
    if (binding(this.deps.db, child.id)?.startRequestId?.startsWith(WEBSITE_CHILD)) return;
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
        const piDefault = providerId === "pi" && (model !== parent.model || (JSON.parse(command(this.deps.db, `first_${parent.threadId}`)?.input ?? "{}").default_reasoning && !getThreadExecutionOverride(this.deps.db, parent.threadId)?.reasoningLevelOverride));
        // With no effort given, a model without effort starts without one, never at the parent's level (#1059).
        const inherit =
          same &&
          !piDefault &&
          !input.reasoning &&
          !takesNoEffort(
            (await this.savedCapabilities()) ??
              (await this.capabilities(client)),
            providerId,
            model,
          );
        const reasoning = reasoningLevelSchema.safeParse(
          input.reasoning ??
            (inherit
              ? binding(this.deps.db, parent.threadId)?.reasoning
              : undefined),
        );
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
    if (!busy || tries >= 5 || this.streams.has(saved.threadId) || !this.reportedParent(thread) || !this.isHome(saved.threadId)) return false;
    if (!this.sandboxes.coolingDown(sandboxThread(saved.coreUrl))) this.catchUps.set(saved.threadId, tries + 1);
    return true;
  }

  private follow(saved: Binding, client: CloudroomClient): void {
    if (this.streams.has(saved.threadId) || !saved.sessionId || this.stopped) return;
    const controller = new AbortController();
    this.streams.set(saved.threadId, controller);
    void (async () => {
      let projecting = false;
      await Promise.all([this.me(), this.threadStates.ready]);
      const known = this.threadStates.get(saved.threadId);
      // A session this computer never streamed (another computer's switch): what it holds is shown, never acted on.
      if (!known || known.session !== saved.sessionId) this.threadStates.set(saved.threadId, { ...this.firstState(saved.threadId), ...known, session: saved.sessionId!, actFrom: known ? null : 0, history: undefined });
      const state = () => this.threadStates.get(saved.threadId)!;
      const acts = (record: SessionRecord) => record.sequence > (state().actFrom ?? Infinity);
      // Once per app run and thread: a new session's label, then only its session for a session started here.
      // A thread Teleported to Cloud may come back to a row on its old session (marked moved to a computer). Only an
      // older app's label replaces a session (web `labelSandbox`, when Core lists it running), clearing that mark.
      const teleported = !known && Boolean(saved.startRequestId?.startsWith("teleport_"));
      if (!known || (known.actFrom === 0 && !known.adopted)) this.syncLabel(saved.threadId, teleported ? "switch" : known ? "backfill" : "start");
      const shared = sandboxThread(saved.coreUrl) !== saved.threadId, listing = !shared && await this.sandboxes.followsThreads().catch(() => false) === true;
      // Core reports a record of its own thread that names its wake (Core 1): that Core and website take it from here.
      const owed = (record: SessionRecord) => listing && typeof (record.data as { wake?: unknown } | null)?.wake === "string" && (record.data as { user?: unknown }).user !== true;
      // History read from the website while the sandbox slept is shown up to `saved.cursor`; jobs start where they were.
      const marker = state().history?.session === saved.sessionId ? state().history!.from : null;
      const shownTo = marker !== null ? state().history!.until ?? saved.cursor : saved.cursor;
      let handled = marker ?? saved.cursor;
      let connected = false;
      // One commit per record wrote ~55 KB each. Records that can wait are saved together, in the order they came,
      // and the cursor only moves with them, so a broken stream replays them. recordSaving says which can wait.
      const waiting: SessionRecord[] = [];
      let saveTimer: ReturnType<typeof setTimeout> | undefined;
      const saveWaiting = (last?: SessionRecord) => {
        clearTimeout(saveTimer);
        saveTimer = undefined;
        if (controller.signal.aborted) return;
        const records = [...waiting.splice(0), ...(last ? [last] : [])];
        if (!records.length) return;
        let eventTypes: ThreadEventType[];
        try {
          eventTypes = projectRecords(this.deps.db, saved.threadId, records);
        } catch (error) {
          if (records.length === 1) throw error;
          // One record cannot be saved. Save the ones before it, as if each had come alone, then fail on it.
          eventTypes = [];
          let failure: unknown;
          for (const record of records) {
            try { eventTypes.push(...projectRecord(this.deps.db, saved.threadId, record)); }
            catch (inner) { failure = inner; break; }
          }
          if (eventTypes.length) this.notify(saved.threadId, [...new Set(eventTypes)], false);
          throw failure ?? error;
        }
        this.catchUps.delete(saved.threadId);
        this.setConnectionIssue(saved.threadId, "replay");
        this.notify(saved.threadId, [...new Set(eventTypes)], false);
      };
      try {
        for await (const record of client.stream(saved.sessionId!, {
          after: handled, signal: controller.signal,
          onConnected: async () => {
            connected = true;
            if (controller.signal.aborted) return;
            // Earlier sessions come from a website that lists threads (its saved records); a Core without `continued` has none.
            const empty = !shared && saved.cursor === 0 && !this.shown(saved.threadId) && await this.sandboxes.followsThreads().catch(() => false);
            if (state().actFrom === null || empty) {
              const snapshot = await client.session(saved.sessionId!, controller.signal);
              if (state().actFrom === null) {
                this.threadStates.set(saved.threadId, { ...state(), actFrom: snapshot.last_sequence, home: tagOf(snapshot.last_app_prompt?.request_id) ?? state().home });
                if (!shared) void this.listChildren(saved, client, snapshot.continued?.from).catch((error: unknown) => this.warn("Cloud child threads could not be listed", error, { threadId: saved.threadId }));
              }
              // Before this session's records, which the stream holds until this returns.
              if (empty) await this.earlierSessions(saved.threadId, snapshot.continued?.from ?? undefined).catch((error: unknown) => this.warn("A Cloud thread's earlier history could not be read", error, { threadId: saved.threadId }));
            }
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
          const saving = recordSaving(record);
          if (saving === "wait") {
            waiting.push(record);
            saveTimer ??= setTimeout(() => {
              try {
                saveWaiting();
              } catch (error) {
                this.streamBroke(saved.threadId, error);
                this.setConnectionIssue(saved.threadId, "replay", error);
                controller.abort();
              }
            }, STREAM_BATCH_MS);
            // A replay after time offline sends thousands of records at once. One save for all would block too long.
            if (waiting.length >= STREAM_BATCH_MAX_RECORDS) {
              projecting = true;
              saveWaiting();
              projecting = false;
            }
            continue;
          }
          projecting = true;
          saveWaiting(saving === "now" ? record : undefined);
          projecting = false;
          if (saving === "now") continue;
          if ((record.kind === "child" || record.kind === "child_thread") && record.data && typeof record.data === "object" && "id" in record.data && typeof record.data.id === "string") {
            await this.followChild(saved, client, record.data.id, acts(record)).catch((error: unknown) => this.warn("A Cloud child thread could not be shown", error, { threadId: saved.threadId }));
            if (controller.signal.aborted) return;
          }
          // Records past what this computer's jobs handled; ones the website's history only showed count too.
          const fresh = record.sequence > handled;
          if ((record.kind === "child_request" || record.kind === "child_command") && fresh && acts(record) && young(record) && this.isHome(saved.threadId)) {
            await this.ownSandboxChild(saved, client, record).catch((error: unknown) => this.warn("A Cloud child request failed", error, { threadId: saved.threadId }));
            if (controller.signal.aborted) return;
          }
          // Core wrote its thread's change to the website: list it now, signal or not.
          if (record.kind === "thread_report" && listing && acts(record)) this.sync.changed();
          const lists = record.kind === "own_child" ? await this.sandboxes.followsThreads().catch(() => null) : null;
          if (lists) this.sync.changed();
          else if (lists === false) {
            await this.adoptChild(saved, record.data).catch((error: unknown) => this.warn("A Cloud child thread could not be shown", error, { threadId: saved.threadId }));
          }
          if (record.kind === "fork_request" && fresh && acts(record) && this.isHome(saved.threadId)) {
            await this.agentFork(saved, client, record).catch((error: unknown) => this.warn("A Cloud fork request failed", error, { threadId: saved.threadId }));
            if (controller.signal.aborted) return;
          }
          const outage = mentionsOpenAISide401(record) && await codexOutage();
          if (controller.signal.aborted) return;
          projecting = true;
          // The stream replays from the saved cursor, so renames made while the app was offline apply on reconnect. With
          // a Core and website that follow threads, Core reports its thread's own rename, effort and archive, and the
          // website's list brings them (#237). Otherwise home applies and labels them; other computers only show them.
          const labels = !shared && !owed(record) && acts(record) && this.isHome(saved.threadId);
          const show = (apply: () => void) => labels ? apply() : this.quietly(saved.threadId, apply);
          if (record.kind === "title" && !owed(record)) show(() => updateThread(this.deps.db, this.deps.hub, saved.threadId, { title: z.object({ title: z.string().min(1) }).parse(record.data).title }));
          const effort = (record.kind === "launch_reasoning" || (record.kind === "reasoning" && !owed(record))) && z.object({ reasoning: reasoningLevelSchema }).safeParse(record.data);
          if (effort && effort.success) show(() => {
            saveBinding(this.deps.db, saved.threadId, { reasoning: effort.data.reasoning });
            if (record.kind === "reasoning") setThreadExecutionOverride(this.deps.db, { threadId: saved.threadId, reasoningLevelOverride: effort.data.reasoning });
          });
          // Home runs an agent's move it missed while asleep, as on main: the agent was told it would happen.
          const move = fresh && acts(record) && record.kind === "move" && this.isHome(saved.threadId) && z.object({ project: z.string().min(1) }).safeParse(record.data);
          const ended = fresh ? endedTurn(record) : null;
          const turn = ended ? z.object({ request_id: z.string() }).catch({ request_id: String(record.sequence) }).parse(record.data).request_id : "";
          // The computer that owns a turn reports it to a Cloud parent; one that only shows it doesn't.
          const owned = ended && acts(record) && this.ownsTurn(saved.threadId, turn) ? ended : null;
          if (owned) await this.noticeCloudParent(saved.threadId, owned, turn);
          const held = owned && this.teleportingParent(saved.threadId) ? owned : null;
          if (held) await this.holdChildReport(saved.threadId, held, turn);
          const receipt = fresh && record.kind === "receipt" ? record.data as { command?: string; state?: string; input?: { keep_paused?: boolean } } : null;
          if (receipt?.state === "accepted" && receipt.command === "stop") this.stops.set(saved.threadId, { session: record.session_id, at: Date.now() });
          if (receipt?.state === "accepted" && receipt.command === "resume" && !receipt.input?.keep_paused) this.stops.delete(saved.threadId);
          const turnReceipt = record.kind === "receipt" ? z.object({ request_id: z.string(), command: z.string(), state: z.string() }).safeParse(record.data) : null;
          if (turnReceipt?.success) {
            // Home is the computer whose tag is on the latest app prompt; the turn's own tag says who notifies for it.
            const { request_id: request, command: kind, state: step } = turnReceipt.data, tag = tagOf(request);
            if (tag && step === "accepted" && ["prompt", "steer", "edit", "rewind"].includes(kind) && tag !== state().home) this.threadStates.set(saved.threadId, { ...state(), home: tag });
            if (["prompt", "auto", "rewind", "compact"].includes(kind) && !["accepted", "cancelled"].includes(step)) {
              if (this.ownsTurn(saved.threadId, request)) cloudTurnsElsewhere.delete(saved.threadId);
              else cloudTurnsElsewhere.add(saved.threadId);
            }
          }
          const eventTypes = projectRecord(this.deps.db, saved.threadId, record, outage);
          // Past history the website only showed, progress is saved as each record is handled (projectRecord saves the
          // cursor otherwise), so a detach right after an action (an archive) never repeats it on the next connect.
          handled = Math.max(handled, record.sequence);
          if (marker !== null && state().history) this.threadStates.set(saved.threadId, { ...state(), history: handled >= shownTo ? undefined : { ...state().history!, from: handled } });
          projecting = false;
          this.catchUps.delete(saved.threadId);
          // Like a Local turn's end (turn-completed-events.ts): the finished messages hold their full text, so their
          // streamed pieces go. Cloud never did this, and its threads kept every piece.
          if (ended) try { pruneThreadEventHistory(this.deps, { mode: "idle", threadId: saved.threadId }); } catch (error) { this.warn("A finished Cloud turn's streamed pieces could not be cleared", error, { threadId: saved.threadId }); }
          if (held) void this.deliverChildReports();
          else if (owned) this.tellLocalParent(saved.threadId, owned, turn);
          const reply = ended ? getLastThreadOutput(this.deps.db, saved.threadId) : null;
          if (reply) void saveCloudImages(this.deps, saved.threadId, reply).catch((error: unknown) => this.warn("Chat images could not be saved", error, { threadId: saved.threadId }));
          // Agents archive their own thread with `room-cli thread archive --self`; like renames, this applies on reconnect,
          // on home. With Core reporting it, the website archives the thread, and home archives its children once the
          // website's list shows that (cascade). One that kept live sessions never reaches the website: home shows it.
          // Core holds the report while any other session in the sandbox is open (a side chat, a kept child), so then
          // home shows it here at once, as on main.
          if (record.kind === "archive" && fresh && acts(record) && this.isHome(saved.threadId)) {
            const kept = z.object({ kept_live: z.array(z.string()) }).catch({ kept_live: [] }).parse(record.data).kept_live;
            const live = bindings(this.deps.db).filter((b) => b.coreUrl === saved.coreUrl && b.sessionId !== null && kept.includes(b.sessionId)).map((b) => b.threadId);
            const others = bindings(this.deps.db).some((b) => b.coreUrl === saved.coreUrl && b.threadId !== saved.threadId && !getThread(this.deps.db, b.threadId)?.archivedAt && !getThread(this.deps.db, b.threadId)?.deletedAt);
            if (owed(record) && !kept.length && !others) this.threadStates.set(saved.threadId, { ...state(), cascade: live });
            else this.archiveRequest?.(saved.threadId, live);
          }
          if (move && move.success) this.moveRequest?.(saved.threadId, move.data.project);
          if (record.kind === "secret_request") this.secrets.follow(client, saved.threadId, record);
          if (record.kind === "gpu_request" && fresh && acts(record)) this.gpuApprovals.follow(saved.threadId, record);

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
        projecting = true;
        saveWaiting();
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
      } finally {
        clearTimeout(saveTimer);
        if (this.streams.get(saved.threadId) === controller)
          this.streams.delete(saved.threadId);
      }
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
    // A status that could not be written is written again here, so the agent never waits on a stale `copying`.
    let final: string | undefined, last = client;
    const deadline = marked && workspace ? setTimeout(() => void marked.then(() => {
      // A copy still paused because its plan never ran (#1040) fails with its own error, card included.
      const parked = projectCopyProgress(this.deps.db, threadId);
      if (final === undefined && parked?.phase === "waiting" && parked.error) return this.unplannedFailed(last, threadId, workspace, parked.error);
      return this.filesState(last, threadId, workspace, final ?? `failed: ${STALLED}`, true);
    }), COPY_DEADLINE).unref() : undefined;
    const land = async (error?: string, current = client, partial?: string) => {
      if (files) this.progress(threadId, [{ key: "files", status: error ? "failed" : "completed" }]);
      const finish = async (failure?: string | null) => {
        final = failure ? `failed: ${failure}` : "ready"; last = current;
        if (!marked || !workspace) return clearTimeout(deadline);
        await marked.then(() => writeFilesState(current, workspace, final!)).then(() => clearTimeout(deadline),
          (error: unknown) => this.warn("Could not save the project copy state for `room-cli files wait`", error, { threadId }));
      };
      const missing = error ?? partial;
      // `ready` comes after the branch, so the agent never starts work on the default branch.
      if (!started?.code) {
        const branch = await this.ensureBranch(threadId, true);
        await finish(missing ?? branch);
        return;
      }
      // A fork's branch then moves to its source's code, so the agent sees what the source saw.
      let own: string | undefined;
      const branch = await this.ensureBranch(threadId, true, kept => { own = kept; });
      // Its hard reset would drop the commits on a branch the agent made itself, so that branch keeps its work (#1377).
      const failure = own ? `The folder was already on the agent's own branch ${own}, so it was kept and the source thread's code was not copied in.` : await landForkCode(current, started);
      // A child folder with no Git gets its repository only now, on a cloudroom/ branch: rename it to its room/ one
      // before the agent goes on.
      if (!failure) await this.ensureBranch(threadId, false);
      this.progress(threadId, [{ key: "fork", status: failure ? "failed" : "completed" }]);
      await finish(failure ?? missing ?? branch);
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
  /** During an outage, continues a Cloud thread from its older copy instead of waiting (ADR 20261113-202742). */
  async continueFromCopy(threadId: string): Promise<void> {
    const sandbox = sandboxThread(binding(this.deps.db, threadId)?.coreUrl ?? "");
    if (!sandbox) throw new ApiError(409, "cloudroom_unsupported", "Only Cloud threads have a copy.");
    await this.sandboxes.continueFromCopy(sandbox);
  }

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
    // A full copy lands like a new thread's, on the thread's own branch, which a copy that never ran never made.
    if (job.clone || job.copyAll) this.copy(client, job, this.landing(threadId, client, null, true, workspace, this.filesState(client, threadId, workspace, "copying")));
    else this.copyInto(client, job);
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
    // Set for a new thread's copy that was never planned (#1040): it fails instead, as it would have at once.
    const unplanned = projectCopyProgress(this.deps.db, threadId)?.error;
    // Stopping the service, or archiving or deleting the thread, while the plan runs leaves its folder alone.
    const epoch = this.epoch;
    const ended = () => { const thread = getThread(this.deps.db, threadId); return epoch !== this.epoch || !thread || Boolean(thread.archivedAt || thread.deletedAt); };
    this.retrying.add(threadId);
    try {
      // A sandbox that can't be reached, or a folder another copy is filling, throws, so the copy waits for the next connection.
      const key = copyKey(sandboxThread(saved.coreUrl), workspace);
      const job = await planProjectCopyOrThrow(this.deps, client, threadId, workspace, { key, branch: baseBranch(input), ...(unplanned ? { signal: AbortSignal.timeout(30_000) } : {}) }).catch((error: unknown) => {
        if (!unplanned || keyCopying(key) || this.copyBusy(threadId) || ended()) throw error;
        this.unplannedFailed(client, threadId, workspace, unplanned);
        return undefined;
      });
      if (job === undefined || ended()) return;
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
      else void this.filesState(client, threadId, workspace, `failed: ${unplanned ?? CUT_SHORT}`, true);
    } finally { this.retrying.delete(threadId); }
  }

  /** A new thread's copy that could not be planned (#1040) fails like any failed copy: the card shows only for a project
   *  with no folder on the Mac, and `room-cli files wait` stops waiting. */
  private unplannedFailed(client: CloudroomClient, threadId: string, workspace: string, error: string): Promise<void> {
    const local = localProjectPath(this.deps, getThread(this.deps.db, threadId)?.projectId ?? "");
    reportProjectCopy(this.deps, threadId, local ? { phase: "complete", completed: 0, total: 0 } : { phase: "error", completed: 0, total: 0, error });
    return this.filesState(client, threadId, workspace, `failed: ${error}`, true);
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
      reconnecting: phase !== "replay" && (connectionFailure(error) || sandboxTransition(error)),
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
