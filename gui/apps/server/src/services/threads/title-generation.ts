import { renderTemplate } from "@cloudroom/templates";
import { getThread, threads, updateThread } from "@cloudroom/db";
import {
  RAW_THREAD_ID_PATTERN_SOURCE,
  type PromptInput,
  type PromptTextMention,
} from "@cloudroom/domain";
import { and, desc, eq, isNotNull, isNull, ne } from "drizzle-orm";
import type { AppDeps, LoggedWorkSessionDeps } from "../../types.js";
import { Type } from "@earendil-works/pi-ai";
import {
  INFERENCE_POLICY,
  InferenceTimeoutError,
  inferenceCompleteWithFallback,
} from "../ai/inference.js";
import { readUiPreferences } from "../system/ui-preferences.js";

const MAX_GENERATED_TITLE_LENGTH = 80;
const MAX_BRANCH_SLUG_LENGTH = 40;
const OTHER_TITLES_LIMIT = 20;
const CLAUDE_NAMING_MODEL = "claude-code/claude-haiku-5-5";

interface ApplyGeneratedThreadTitleArgs {
  threadId: string;
  title: string;
  /** Replace only this earlier generated title. Without it, only an untitled thread is named. */
  replaces?: string;
}

interface ThreadMetadataGenerationArgs {
  /** The agent's first reply, when renaming a vague title after the first turn. */
  agentReply?: string;
  input: PromptInput[];
  threadId: string;
  timeoutMaxAttempts?: number;
  timeoutMs?: number;
}

interface GeneratedThreadMetadata {
  title?: string;
}

type ThreadMetadataGenerationOutcomeReason =
  | "empty-input"
  | "failed"
  | "inference-unavailable"
  | "timeout";

export interface ThreadMetadataGenerationOutcome {
  durationMs: number;
  metadata: GeneratedThreadMetadata | null;
  reason?: ThreadMetadataGenerationOutcomeReason;
}

interface RawGeneratedThreadMetadata {
  title: string;
}

const SERIALIZED_MENTION_TOKEN_PATTERN =
  /@(?:thread|project|section|folder):[A-Za-z0-9_-]+/gu;
const STANDALONE_RAW_THREAD_ID_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}_.+\\-/\\\\])${RAW_THREAD_ID_PATTERN_SOURCE}(?![\\p{L}\\p{N}_+\\-/\\\\]|\\.(?=[\\p{L}\\p{N}_]))`,
  "gu",
);
const THREAD_MENTION_LOOKUP_PATTERN = new RegExp(
  `@thread:([A-Za-z0-9_-]+)|(?<![\\p{L}\\p{N}_.+\\-/\\\\])(${RAW_THREAD_ID_PATTERN_SOURCE})(?![\\p{L}\\p{N}_+\\-/\\\\]|\\.(?=[\\p{L}\\p{N}_]))`,
  "gu",
);

function replacePromptTextMentions(
  text: string,
  mentions: readonly PromptTextMention[] | undefined,
): string {
  if (!mentions || mentions.length === 0) return text;
  const sorted = [...mentions].sort((left, right) => left.start - right.start);
  let out = "";
  let cursor = 0;
  for (const mention of sorted) {
    if (
      mention.start < cursor ||
      mention.end <= mention.start ||
      mention.end > text.length
    ) {
      continue;
    }
    out += text.slice(cursor, mention.start);
    out += mention.resource.label.trim();
    cursor = mention.end;
  }
  return out + text.slice(cursor);
}

function stripMentionTokens(value: string): string {
  return value
    .replace(SERIALIZED_MENTION_TOKEN_PATTERN, "")
    .replace(STANDALONE_RAW_THREAD_ID_PATTERN, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function resolveThreadMentionsForNaming(
  db: AppDeps["db"],
  value: string,
): string {
  if (!value) return "";
  const resolved = value.replace(
    THREAD_MENTION_LOOKUP_PATTERN,
    (_match, serializedId?: string, rawId?: string) => {
      const id = serializedId ?? rawId;
      if (!id) return "";
      const thread = getThread(db, id);
      const title = thread?.title ?? thread?.titleFallback;
      return title ? stripMentionTokens(title) : "";
    },
  );
  return stripMentionTokens(resolved);
}

export function cleanPromptText(input: PromptInput[]): string {
  return (
    input
      .filter((part) => part.type === "text")
      // Hidden notes for the agent (like a fork's "[Local fork]" note) never name a thread.
      .filter((part) => part.visibility !== "agent-only")
      .map((part) => replacePromptTextMentions(part.text, part.mentions).trim())
      .join(" ")
      .replace(/\s+/gu, " ")
      .trim()
  );
}

function clampTitleText(text: string): string {
  return text.length <= MAX_GENERATED_TITLE_LENGTH
    ? text
    : `${text.slice(0, MAX_GENERATED_TITLE_LENGTH - 3)}...`;
}

export function deriveTitleFallback(input: PromptInput[]): string | null {
  const text = cleanPromptText(input);
  if (text.length === 0) {
    return null;
  }
  return clampTitleText(text);
}

export function shouldGenerateThreadTitle(input: PromptInput[]): boolean {
  return cleanPromptText(input).length > 0;
}

export function sanitizeGeneratedTitle(value: string): string | null {
  const title = stripMentionTokens(value)
    .replace(/^["'`]+|["'`.]+$/gu, "")
    .trim()
    .slice(0, MAX_GENERATED_TITLE_LENGTH)
    .trim();
  return title.length > 0 ? title : null;
}

export function sanitizeGeneratedBranchSlug(value: string): string | null {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_BRANCH_SLUG_LENGTH)
    .replace(/-+$/u, "");

  return slug.length > 0 ? slug : null;
}

const threadMetadataSchema = Type.Object({
  title: Type.String(),
});

function normalizeGeneratedThreadMetadata(
  parsed: RawGeneratedThreadMetadata | null,
): GeneratedThreadMetadata | null {
  if (!parsed) {
    return null;
  }

  const title = parsed.title ? sanitizeGeneratedTitle(parsed.title) : null;
  if (!title) {
    return null;
  }

  return { title };
}

/** A configured BB_INFERENCE_FALLBACK wins. Otherwise naming falls back to the other harness, so one signed-out
 *  harness never blocks it; the primary still gets a final retry. */
export function namingFallbackModel(
  config: AppDeps["config"],
  model: string,
): string {
  if (config.inferenceFallbackModel !== config.inferenceModel) {
    return config.inferenceFallbackModel;
  }
  return model.startsWith("claude-code/")
    ? config.inferenceModel
    : CLAUDE_NAMING_MODEL;
}

/** Titles of the project's latest open threads, so a new title can stand out from them. */
function otherThreadTitles(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): string[] {
  const projectId = getThread(deps.db, threadId)?.projectId;
  if (!projectId) return [];
  return deps.db
    .select({ title: threads.title })
    .from(threads)
    .where(
      and(
        eq(threads.projectId, projectId),
        ne(threads.id, threadId),
        eq(threads.visibility, "visible"),
        isNull(threads.archivedAt),
        isNull(threads.deletedAt),
        isNotNull(threads.title),
      ),
    )
    .orderBy(desc(threads.updatedAt))
    .limit(OTHER_TITLES_LIMIT)
    .all()
    .map((row) =>
      resolveThreadMentionsForNaming(deps.db, row.title ?? "").slice(
        0,
        MAX_GENERATED_TITLE_LENGTH,
      ),
    )
    .filter((title) => title.length > 0);
}

export async function generateThreadMetadataWithOutcome(
  deps: LoggedWorkSessionDeps,
  args: ThreadMetadataGenerationArgs,
): Promise<ThreadMetadataGenerationOutcome> {
  const startedAt = Date.now();
  const rawPrompt = cleanPromptText(args.input);
  const complete = (
    metadata: GeneratedThreadMetadata | null,
    reason?: ThreadMetadataGenerationOutcomeReason,
  ): ThreadMetadataGenerationOutcome => ({
    durationMs: Date.now() - startedAt,
    metadata,
    ...(reason ? { reason } : {}),
  });

  if (rawPrompt.length === 0) {
    return complete(null, "empty-input");
  }

  const cleanedPrompt = clampTitleText(
    resolveThreadMentionsForNaming(deps.db, rawPrompt),
  );
  const agentReply = resolveThreadMentionsForNaming(
    deps.db,
    args.agentReply ?? "",
  );
  if (cleanedPrompt.length === 0 && agentReply.length === 0) {
    return complete(null, "empty-input");
  }

  const preferences = readUiPreferences(deps);
  const model =
    preferences["threadNaming.model"].value ?? deps.config.inferenceModel;
  const prompt = renderTemplate("generateThreadMetadata", {
    agentReply,
    cleanedPrompt,
    otherTitles: otherThreadTitles(deps, args.threadId)
      .map((title) => `- ${title}`)
      .join("\n"),
    rules: preferences["threadNaming.rules"].value,
  });
  const maxAttempts = Math.max(1, args.timeoutMaxAttempts ?? 1);

  try {
    const inference = await inferenceCompleteWithFallback(deps, {
      fallbackOnAnyError: true,
      label: "Thread metadata inference",
      logContext: { threadId: args.threadId },
      maxAttempts,
      primaryModel: model,
      fallbackModel: namingFallbackModel(deps.config, model),
      prompt,
      retryDelayMs: INFERENCE_POLICY.threadMetadata.retryDelayMs,
      schema: threadMetadataSchema,
      timeoutMs: args.timeoutMs ?? INFERENCE_POLICY.threadMetadata.timeoutMs,
    });
    const metadata = normalizeGeneratedThreadMetadata(inference);
    return complete(metadata, metadata ? undefined : "inference-unavailable");
  } catch (error) {
    return complete(
      null,
      error instanceof InferenceTimeoutError ? "timeout" : "failed",
    );
  }
}

export function applyGeneratedThreadTitle(
  deps: Pick<AppDeps, "db" | "hub">,
  args: ApplyGeneratedThreadTitleArgs,
): boolean {
  const title = args.title.trim();
  if (title.length === 0) {
    return false;
  }

  const currentThread = getThread(deps.db, args.threadId);
  const current = currentThread?.title ?? null;
  if (
    !currentThread ||
    currentThread.archivedAt !== null ||
    currentThread.deletedAt !== null ||
    title === current ||
    (args.replaces === undefined ? current : current !== args.replaces)
  ) {
    return false;
  }

  updateThread(deps.db, deps.hub, args.threadId, {
    title,
  });

  return true;
}
