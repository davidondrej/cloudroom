import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { z } from "zod";
import type { DbQueryConnection } from "@cloudroom/db";
import {
  encodeClientTurnRequestIdNumber,
  promptInputSchema,
  reasoningLevelSchema,
  type PromptInput,
  type Thread,
} from "@cloudroom/domain";
import type { SendMessageRequest } from "@cloudroom/server-contract";
import { ApiError } from "../../errors.js";
import { CloudroomConnectionError, CloudroomError, type CloudroomClient, type SessionRecord } from "./client.js";
import { CLOUD_HARNESSES, HARNESS_NAMES, isAcpProvider, isCloudProvider, type CloudProvider, type StartStep } from "./events.js";
import { cloudPausedError, type SandboxAccount } from "./sandboxes.js";
import { commands, type Binding, type Command } from "./store.js";

export const HOSTED_WEBSITE = "https://www.cloudroom.dev";
export const ROOT_WORKSPACE = "root";
export const CHECKOUT_READ_TIMEOUT_MS = 60_000;
/** How often a stale address is forgotten and its sandbox woken again before the command fails (#596, #1076). */
export const STALE_REWAKES = 3;
export const COPY_DEADLINE = 9 * 60_000;
export const AGENT_FORK_WAIT = 90_000;
export const AGENT_FORKS = "cloudroom-agent-forks.json";
export const CHILD_REPORTS = "cloudroom-child-reports.json";
/** How a child the website started names its first request: `sub_` and a hash (web/lib/cloud-start.ts spawnChild).
 *  An agent switch or project move keeps the prefix on the new session's request (restartSession). */
export const WEBSITE_CHILD = "sub_";
/** Prompts Core or a loop queues for itself, which a Teleport may leave behind: loop runs, Core's child notices and
 *  tasks, its own continue after a usage limit, and Teleport's handoff (core/src/session, web/lib/automations.ts). */
export const CORE_OWN = /^(auto_|notice_|task_|continue_|teleport_)/;
/** Core session states that mean an agent is working or about to (core/src/session/state.rs). */
export const WORKING = ["pending", "waiting_for_files", "starting", "resuming", "starting_turn", "running", "interrupting", "rewinding"];
export const connectionOrReplayFailed = "Cloudroom connection or replay failed";
/** Plain words for a sandbox that stayed stale: never the vendor's own 404 text (#317, ADR 0146). */
export const unreachableSandbox = "Its cloud sandbox could not be reached, even after waking it again.";
export const retiredVmMessage = "This thread ran on the old shared cloud VM, which was shut down on October 2. Start a new Cloud thread to keep going.";
export const CUT_SHORT = "The project copy was cut short, so some files may be missing.";
export const STALLED = `The project copy did not finish in ${COPY_DEADLINE / 60_000} minutes, so some files may be missing.`;

/** "Clear caches & builds" on a full Cloud disk: moves caches/builds to a single trash folder first, then deletes last. */
export const CLEAR_DISK = String.raw`avail() { df -B1 --output=avail "$HOME" | tail -1; }
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

const asOrigin = (value: string) => URL.canParse(value) && new URL(value).origin === value ? new URL(value) : null;
const isLoopback = (url: URL) => url.protocol === "http:" && url.hostname === "127.0.0.1" && Boolean(url.port);

export function configuredWebsite(): string {
  const value = process.env.CLOUDROOM_WEBSITE_URL?.trim().replace(/\/$/, "") || HOSTED_WEBSITE;
  const url = asOrigin(value);
  if (!url || (url.protocol !== "https:" && !isLoopback(url))) {
    throw new ApiError(503, "cloudroom_website_invalid", "CLOUDROOM_WEBSITE_URL must be a website address, like https://cloudroom.example.com.");
  }
  return value;
}

export function trustedWebsite(value: string): boolean {
  const url = asOrigin(value);
  return url !== null && (value === HOSTED_WEBSITE || isLoopback(url) || value === configuredWebsite());
}

export const accountSchema = z.object({ id: z.string().uuid(), email: z.string().email() }).strict();
export const connectionSchema = z.object({
  url: z.string().url(),
  token: z.string().min(32),
  gateToken: z.string().regex(/^[a-zA-Z0-9._~-]{1,4096}$/).optional(),
  projectId: z.string().min(1).optional(),
}).strict();
export const websiteSchema = z.string().url().refine(trustedWebsite);
export const savedConnectionSchema = connectionSchema.extend({
  url: connectionSchema.shape.url.optional(),
  token: connectionSchema.shape.token.optional(),
  account: accountSchema.optional(),
  websiteUrl: websiteSchema.optional(),
  sandboxToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  onboarding: z.object({
    projectSelected: z.boolean().default(false),
    reported: z.array(z.enum(["connected", "project", "message"])).default([]),
    firstMessage: z.object({ sessionId: z.string(), requestId: z.string() }).optional(),
  }).optional(),
});

export type CloudroomAccount = z.infer<typeof accountSchema>;
export type Connection = z.infer<typeof connectionSchema>;
export type SavedConnection = z.infer<typeof savedConnectionSchema> | null;

export const capabilitiesSchema = z.object({
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
  mac_device: z.boolean().default(false),
  steer: z.boolean().default(false),
  rewind: z.boolean().default(false),
  fork: z.boolean().default(false),
  side_chat: z.boolean().default(false),
  side_chat_fresh: z.boolean().default(false),
  attachments: z.boolean().default(false),
  upload_parts: z.boolean().default(false),
  compact: z.boolean().default(false),
  compact_after_turn: z.boolean().default(false),
  goal: z.boolean().default(false),
  usage: z.boolean().default(false),
  credits_usage: z.boolean().default(false),
  subagents: z.boolean().default(false),
  long_prompts: z.boolean().default(false),
  cloud_threads: z.boolean().default(false),
  room_ids: z.boolean().default(false),
  harnesses: z.array(z.object({
    id: z.string(),
    model: z.string(),
    provider: z.string().nullable().optional(),
    provider_selection: z.boolean().default(false),
    reasoning_levels: z.array(z.string()).default(["none", "minimal", "low", "medium", "high", "xhigh"]),
    models: z.array(z.object({
      model: z.string(),
      reasoning_levels: z.array(z.string()),
      service_tiers: z.array(z.string()).optional(),
    })).nullable().optional(),
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
    idle_set_model: z.boolean().default(false),
  })),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

/** A queued model pick (changeModel), with what the thread ran before it for when Core doesn't take it. */
export const modelPickSchema = z.object({
  idleSessionId: z.string().optional(),
  model: z.string(),
  reasoning: z.string(),
  before: z.object({ model: z.string(), reasoning: z.string(), override: reasoningLevelSchema.nullable() }),
});

const storageBytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().default(null);
export const storageSchema = z.object({
  enabled: z.boolean(),
  level: z.enum(["normal", "low_space", "blocked"]),
  reason: z.enum(["disk_capacity", "measurement_unavailable", "unprotected_test_mode"]),
  workspace_available_bytes: storageBytes,
  history_available_bytes: storageBytes,
  workspace_total_bytes: storageBytes,
  history_total_bytes: storageBytes,
  sampled_at: storageBytes,
});
export type Storage = z.infer<typeof storageSchema>;

export const childReportSchema = z.object({ child: z.string(), status: z.string(), turn: z.string(), error: z.string().optional() });

export type ConnectionPhase = "delivery" | "stream" | "replay";
export type ConnectionIssue = { message: string; reconnecting: boolean };
export type DiskState = { paused: boolean; reason: "disk_capacity" | "measurement_unavailable"; usedBytes: number | null; totalBytes: number | null };
export type PromptAttachment = { name: string; kind: "image" | "file"; localPath: string; id?: string; path?: string };
/** Runs when a project copy ends, with the client that ran it: a sandbox that slept mid-copy has a new address.
 *  `partial` says why only `.env` files arrived. It resolves once everything after the copy is done. */
export type Landed = (error?: string, client?: CloudroomClient, partial?: string) => Promise<void>;
/** What a label sends to a website that follows threads (#237): only the change made here. A new session's first
 *  stream sends all of it once, and every later run only fills the session. `switch` is an older Core's switch. */
export type LabelChange = "start" | "backfill" | "title" | "model" | "parent" | "project" | "switch";

export const LABEL_FIELDS: Record<LabelChange, string[]> = {
  start: ["title", "project_name", "project", "session", "harness", "model", "parent"],
  backfill: ["session"],
  title: ["title"],
  model: ["harness", "model"],
  parent: ["parent"],
  project: ["project", "project_name"],
  switch: [],
};

export const sandboxAccountOf = (saved: SavedConnection): SandboxAccount | null =>
  saved?.sandboxToken && saved.account ? { website: saved.websiteUrl ?? HOSTED_WEBSITE, userId: saved.account.id, token: saved.sandboxToken } : null;

/** Who a Connect Claude token belongs to (#1924): the account, website and Core, or an accountless Core's token. Null when signed out.
 *  Rotating tokens are left out, so signing in again to the same account keeps it. */
export const ownerOf = (saved: SavedConnection): string | null => !saved?.account && !saved?.token ? null
  : createHash("sha256").update(JSON.stringify(saved.account ? [saved.account.id, saved.websiteUrl ?? HOSTED_WEBSITE, saved.url] : [saved.url, saved.token])).digest("hex");

export const cloudStep = (sandbox: boolean, status: StartStep["status"] = "started"): StartStep => ({
  key: "cloud",
  text: sandbox ? "Starting cloud sandbox" : "Connecting to cloud VM",
  status,
});

export function assertThreadOwner(owner: string | null | undefined, accountId: string | undefined) {
  if (owner && owner !== accountId) throw new ApiError(409, "cloudroom_other_account", "Sign in to the account that owns this thread.");
}

export function isCloudThread(thread: Pick<Thread, "executionTarget">): boolean {
  return thread.executionTarget === "cloud";
}

export function requireNativeThread(thread: Pick<Thread, "executionTarget">): void {
  if (isCloudThread(thread)) throw new ApiError(409, "cloudroom_unsupported", "This action is not supported for Cloud threads. Native execution is blocked.");
}

export function storageMessage(storage: Storage | null): string | null {
  if (!storage?.enabled || storage.level !== "blocked") return null;
  if (storage.reason === "measurement_unavailable") return "Cloud disk space could not be measured. Work is paused until storage can be verified.";
  const bytes = storage.workspace_available_bytes === null || storage.history_available_bytes === null ? null : Math.min(storage.workspace_available_bytes, storage.history_available_bytes);
  return `The cloud disk is almost full${bytes === null ? "" : ` (${(bytes / 1e9).toFixed(1)} GB free)`}. Within 30 seconds Cloudroom stops the command filling it, and work resumes. Saved messages are kept.`;
}

/** The project folder a thread's first message copies into, if it has one. */
export function copyWorkspace(input: string | undefined): string | null {
  const workspace = input && z.object({ workspace: z.string().optional() }).parse(JSON.parse(input)).workspace;
  return workspace && workspace !== ROOT_WORKSPACE ? workspace : null;
}

export function cloudTextContent(content: unknown): unknown {
  return Array.isArray(content) ? content.filter(part => part?.type === "text") : content;
}

export function feature(capabilities: Capabilities | null | undefined, name: keyof Capabilities): boolean {
  return capabilities?.[name] === true;
}

export function harnessProfile(capabilities: Capabilities, harness: string) {
  const id = isCloudProvider(harness) ? CLOUD_HARNESSES[harness] : harness;
  return capabilities.harnesses.find((item) => item.id === id);
}

export function requireClaudeSkillSupport(content: unknown, capabilities: Capabilities, harness: string | undefined): void {
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

function cloudLimitText(limit: number): string {
  return `Cloud messages can be up to ${limit / 1024} KB.${limit < 256 * 1024 ? " Update the cloud core to send up to 256 KB." : ""}`;
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

export function coreModel(harness: CloudProvider, model: string, capabilities: Capabilities): { model: string; provider?: string } {
  const profile = harnessProfile(capabilities, harness);
  if (!profile) throw new ApiError(400, "cloudroom_harness", `Configure ${harness} on the cloud VM first.`);
  if (harness !== "pi") return { model };
  const separator = model.indexOf("/");
  const provider = model.slice(0, separator);
  if (separator <= 0 || separator === model.length - 1) throw new ApiError(400, "cloudroom_model", "Select a Pi provider and model.");
  if (!profile.provider_selection && provider !== profile.provider) throw new ApiError(400, "cloudroom_model", "Update the cloud core to use another Pi provider.");
  return { model: model.slice(separator + 1), ...(profile.provider_selection ? { provider } : {}) };
}

export function reasoningLevels(harness: string, model: string, capabilities: Capabilities): string[] | undefined {
  const profile = harnessProfile(capabilities, harness);
  if (harness === "acp-opencode" && (model === "default" || profile?.models === null)) return profile?.reasoning_levels;
  if (harness === "acp-antigravity") return profile?.models?.find((item) => item.model === model)?.reasoning_levels ?? profile?.reasoning_levels;
  // Claude runs exact models its catalog omits, such as claude-opus-5-5[1m]; core allows any VM level (ADR 0133),
  // and `none`, which runs any model without an effort override (#1059).
  const anyLevel = harness === "claude-code"
    ? [...new Set(["none", ...(profile?.models ?? []).flatMap((item) => item.reasoning_levels)])]
    : undefined;
  return profile?.models ? (profile.models.find((item) => item.model === model)?.reasoning_levels ?? anyLevel) : profile?.reasoning_levels;
}

/** The model's own catalog row takes no effort, such as Claude's Haiku (#1059). */
export function takesNoEffort(capabilities: Capabilities | null, harness: string, model: string | null | undefined): boolean {
  const row = capabilities && model ? harnessProfile(capabilities, harness)?.models?.find((item) => item.model === model) : undefined;
  return row?.reasoning_levels.join() === "none";
}

export function validateReasoning(harness: string, model: string, reasoning: string, capabilities: Capabilities): void {
  const profile = harnessProfile(capabilities, harness);
  if (profile?.models === null && harness !== "acp-opencode" && harness !== "acp-antigravity") throw new ApiError(503, "model_catalog_unavailable", "Cloud model discovery is unavailable. Try again when the cloud harness is ready.");
  const levels = reasoningLevels(harness, model, capabilities);
  if (profile?.models && !levels) {
    const slash = harness === "acp-opencode" ? model.indexOf("/") : -1;
    const suffix = slash > 0 ? model.slice(slash + 1) : "";
    const sameModel = suffix
      ? profile.models.map((item) => item.model).filter((candidate) => {
          const at = candidate.indexOf("/");
          return at > 0 && candidate.slice(at + 1) === suffix;
        }).slice(0, 4)
      : [];
    if (sameModel.length > 0) {
      throw new ApiError(400, "invalid_model", `${model} is not available in Cloud. Available under another provider: ${sameModel.join(", ")}.`);
    }
    const name = HARNESS_NAMES[harness as CloudProvider] ?? harness;
    const offers = profile.models.slice(0, 4).map((item) => item.model).join(", ");
    const claudeHint = harness !== "claude-code" && model.startsWith("claude") ? " Use the claude-code provider for Claude." : "";
    throw new ApiError(400, "invalid_model", `${model} is not a ${name} model on Cloud.${offers ? ` ${name} offers ${offers}.` : ""}${claudeHint}`);
  }
  if (!levels?.includes(reasoning)) {
    throw new ApiError(400, "invalid_reasoning_effort", `This reasoning level is unavailable for the cloud model.${levels?.length ? ` ${model} supports: ${levels.join(", ")}.` : ""} Select a supported level.`);
  }
}

/** Whether Cloud runs `tier` for this model. Ultra Fast needs a Core that lists it on the model; older ones reject it. */
export function cloudOffersTier(profile: ReturnType<typeof harnessProfile>, tier: string | undefined, model: string | undefined): boolean {
  if (!tier || tier === "default") return true;
  if (!profile?.service_tier) return false;
  return tier === "fast" || profile.models?.find((item) => item.model === model)?.service_tiers?.includes(tier) === true;
}

export function validateFollowUpReasoning(harness: string, saved: Binding, reasoning: string, capabilities: Capabilities): void {
  if (reasoning === saved.reasoning) return;
  if (isAcpProvider(harness)) {
    if (!harnessProfile(capabilities, harness)?.prompt_reasoning) {
      throw new ApiError(409, "cloudroom_launch_settings", `${HARNESS_NAMES[harness]} reasoning is fixed for this cloud session. Start a new thread to change it.`);
    }
  } else if (harness !== "codex" && harness !== "pi" && harness !== "claude-code") {
    throw new ApiError(400, "cloudroom_harness", "Unsupported cloud harness.");
  }
  if (!capabilities.prompt_reasoning) throw new ApiError(409, "cloudroom_update", "Update the cloud core before changing reasoning on a follow-up.");
  validateReasoning(harness, coreModel(harness, saved.model, capabilities).model, reasoning, capabilities);
}

export function followUpPayload(harness: string, saved: Binding, payload: SendMessageRequest, reasoning: string | null, capabilities: Capabilities) {
  const profile = harnessProfile(capabilities, harness);
  if ((payload.mode === "steer" || payload.mode === "steer-if-active") && (!feature(capabilities, "steer") || profile?.steer === false)) {
    throw new ApiError(409, "cloudroom_unsupported", "Cloud steering is not enabled. Use --mode queue.");
  }
  if (!cloudOffersTier(profile, payload.serviceTier, saved.model)) {
    throw new ApiError(409, "cloudroom_launch_settings", "Model is fixed for this cloud session. Start a new thread to change it.");
  }
  if (reasoning !== null) validateFollowUpReasoning(harness, saved, reasoning, capabilities);
  return promptPayload(payload.input, harness, capabilities.attachments && (profile?.attachments ?? true), cloudPromptLimit(capabilities));
}

export function sameStoredPrompt(previous: Command, threadId: string, payload: object, requested: string, launch: string): boolean {
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

/** The thread's own IDs, which Core gives its agent's shells as ROOM_THREAD_ID and ROOM_PROJECT_ID, like Local (#199). */
export function roomIds(capabilities: Capabilities, threadId: string, projectId: string | undefined) {
  return feature(capabilities, "room_ids") ? { thread_id: threadId, ...(projectId ? { project_id: projectId } : {}) } : {};
}

export function hashedRequestId(id: string): string {
  return encodeClientTurnRequestIdNumber({ value: createHash("sha256").update(id).digest().readUIntBE(0, 6) });
}

export function commandReasoning(input: string): string | undefined {
  try {
    const value = JSON.parse(input).reasoning;
    return reasoningLevelSchema.safeParse(value).success ? value : undefined;
  } catch {
    return undefined;
  }
}

export function publicError(error: unknown): string {
  if (error instanceof CloudroomError || error instanceof ApiError) return error.message;
  return error instanceof Error ? `${connectionOrReplayFailed}: ${error.message}` : connectionOrReplayFailed;
}

/** Why Cloud refused a prompt, for its `turn_failed` event: Core's code, or the HTTP status when the app knows no code. */
export function refusal(error: unknown): { code: string | null; message: string } {
  const code = error instanceof CloudroomError ? error.code ?? (error.status === null ? null : `http_${error.status}`) : error instanceof ApiError ? error.body.code : null;
  return { code, message: publicError(error) };
}

/** A sandbox put to sleep or stopped answers at its saved address with a 404 (Upstash, Vercel removed) or 410 (Vercel
 *  stopped) and no Cloudroom code: the address is stale, not a refusal (feedback #596). A codeless 401 is the same: every
 *  wake starts Core with a new token, so after a sleep (say, the dashboard's Restart) the saved token is stale. */
export function staleSandboxAddress(error: unknown): boolean {
  return error instanceof CloudroomError && (error.status === 404 || error.status === 410 || error.status === 401) && !error.code;
}

export function connectionFailure(error: unknown): boolean {
  return error instanceof CloudroomConnectionError
    || (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof CloudroomError && error.status !== null && (error.status >= 500 || error.status === 408 || error.status === 429))
    // A paused Cloud (the website's database is down or being upgraded) comes back by itself: wait, never a red error.
    || cloudPausedError(error);
}

/** Nothing answered (#1699): a lost connection, a time-out, a 5xx without a refusal code, or a paused Cloud (its database
 *  is down, so nothing reached the sandbox). Any other code, a 429 or a storage block is an answer, and keeps a held Stop
 *  from cancelling work. */
export function noAnswer(error: unknown): boolean {
  if (cloudPausedError(error)) return true;
  return error instanceof CloudroomError ? !error.code && (error.status === null || error.status >= 500) : error instanceof DOMException && error.name === "AbortError";
}

/** Core refuses work for a few seconds while its sandbox goes to sleep, restarts, or wakes. The next try gets through,
 *  so the thread shows "Reconnecting…" after the usual wait, never a red error (a Metal sandbox sleeps a minute after
 *  work stops, so a message often lands mid-sleep). */
export function sandboxTransition(error: unknown): boolean {
  return error instanceof CloudroomError && ["service_stopping", "service_draining", "session_waking"].includes(error.code ?? "");
}

/** Whether a command can never succeed. Such a command fails at once, so it cannot block every command behind it.
 *  Retry only a lost connection, a busy or restarting core, or an answer that never arrived (the core ignores a
 *  repeated request ID). Errors from the app's own checks and code fail. A command aimed at another message (steer,
 *  edit, cancel, reorder) fails on any refusal: that message moved on, usually because its turn just started or ended. */
export function refused(error: unknown, targeted: boolean, isAsleep: boolean): boolean {
  if (connectionFailure(error) || isAsleep) return false;
  if (error instanceof CloudroomError) return error.status !== null && error.status < 500 && (targeted || !(error.code && error.retryable));
  return !(error instanceof ApiError && error.status >= 500);
}

// A request its sandbox did not answer in time, or turned away for now.
export const slowSandbox = (error: unknown, timedOut: string) =>
  error instanceof Error && error.message === timedOut || error instanceof CloudroomError && error.retryable;

/** The session a session continues (Core's `continued` record, an agent switch or move elsewhere). */
export const continuedFrom = (records: SessionRecord[]) =>
  z.object({ from: z.string().regex(/^cr_[A-Za-z0-9_-]{1,80}$/) }).safeParse(records.find((record) => record.kind === "continued")?.data).data?.from;

/** A record Core made within the last 90 s: an agent waits that long for its fork's or child's answer. */
export const young = (record: SessionRecord) => record.timestamp_ms === undefined || Date.now() - record.timestamp_ms <= AGENT_FORK_WAIT;

/** The sandbox whose API keys a new Cloud child or fork gets, saved with its first message (keyFields). */
export const keySourceOf = (input: string | undefined) =>
  input ? z.object({ key_source: z.string().optional() }).safeParse(JSON.parse(input)).data?.key_source : undefined;

/** Commands that make the agent run. A goal's pause or clear doesn't. */
export const startsWork = (item: Command) => ["prompt", "steer", "resume", "compact", "rewind"].includes(item.command)
  || (item.command === "goal" && JSON.parse(item.input).status !== "paused" && !JSON.parse(item.input).clear);

/** Unsent commands that need Core now. A stop left for a sleeping sandbox (#553) waits for its next wake, and until then
 *  only work that runs the agent wakes it: queue edits, reorders and the like wait with the stop. */
export const unsentWork = (db: DbQueryConnection, threadId: string) => {
  const unsent = commands(db, threadId, "sending");
  const stopped = unsent.some(c => c.command === "stop");
  return unsent.some(c => c.command !== "stop" && c.command !== "model" && c.command !== "unarchive_session" && (!stopped || startsWork(c)));
};
