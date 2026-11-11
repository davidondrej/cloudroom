import { renderTemplate } from "@cloudroom/templates";
import {
  events,
  getThread,
  threads,
  type DbConnection,
} from "@cloudroom/db";
import { Type } from "@earendil-works/pi-ai";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { CommandResultSideEffectsDeps } from "../../internal/command-result-side-effects.js";
import type { AppDeps } from "../../types.js";
import {
  INFERENCE_POLICY,
  inferenceCompleteWithFallback,
} from "../ai/inference.js";
import { readUiPreferences } from "../system/ui-preferences.js";
import { getLastThreadOutput } from "./thread-data.js";
import { clip, purposeModels } from "./thread-purpose.js";

const MAX_MESSAGE_LENGTH = 600;
const MAX_REPLY_LENGTH = 3_000;
const RECENT_REQUESTS = 20;
const MACHINE_PREFIXES = [
  "[room-cli automation due:",
  "[Cloudroom]",
  "Automatic Cloudroom note",
];
const MAX_SAMPLE_LENGTH = 200;
const STYLE_THREADS = 15;
const STYLE_CANDIDATES = 45;
const MAX_SUGGESTION_LENGTH = 120;
const MAX_CACHED_THREADS = 200;

const suggestionSchema = Type.Object({ suggestion: Type.String() });
const cache = new Map<string, { seq: number; value: Promise<string | null> }>();
const reported = new Set<string>();

export function promptSuggestion(
  deps: CommandResultSideEffectsDeps,
  threadId: string,
): Promise<string | null> {
  if (!readUiPreferences(deps)["promptSuggestions.enabled"].value)
    return Promise.resolve(null);
  const thread = getThread(deps.db, threadId);
  if (!thread || thread.status !== "idle") return Promise.resolve(null);
  const turn = lastTurn(deps.db, threadId);
  if (!turn?.turnId || turn.status !== "completed") return Promise.resolve(null);
  const { seq, turnId } = turn;
  const cached = cache.get(threadId);
  if (cached?.seq === seq) return cached.value;
  const value = suggest(deps, threadId, turnId).catch((error: unknown) => {
    deps.logger.debug({ error, threadId }, "Prompt suggestion failed");
    return null;
  });
  cache.delete(threadId);
  cache.set(threadId, { seq, value });
  if (cache.size > MAX_CACHED_THREADS)
    cache.delete(cache.keys().next().value!);
  return value;
}

function lastTurn(db: DbConnection, threadId: string) {
  const row = db
    .select({
      seq: events.sequence,
      turnId: events.turnId,
      status: sql<string | null>`json_extract(${events.data}, '$.status')`,
    })
    .from(events)
    .where(
      and(eq(events.threadId, threadId), eq(events.type, "turn/completed")),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  return row ?? null;
}

export async function promptSuggestionEvent(
  deps: Pick<AppDeps, "db" | "telemetry">,
  threadId: string,
  action: "shown" | "accepted",
): Promise<void> {
  const cached = cache.get(threadId);
  const thread = getThread(deps.db, threadId);
  if (!cached || !thread || !(await cached.value)) return;
  const key = `${threadId}:${cached.seq}:${action}`;
  if (reported.has(key)) return;
  reported.add(key);
  if (reported.size > 1_000) reported.delete(reported.values().next().value!);
  deps.telemetry.capture({
    name: "prompt_suggestion",
    properties: { action, provider: thread.providerId },
  });
}

async function suggest(
  deps: CommandResultSideEffectsDeps,
  threadId: string,
  turnId: string,
): Promise<string | null> {
  const userMessage = lastUserMessage(deps.db, threadId);
  const reply = getLastThreadOutput(deps.db, threadId, turnId);
  if (!userMessage || !reply) return null;
  const models = await purposeModels(null);
  if (!models) return null;
  const result = await inferenceCompleteWithFallback(deps, {
    fallbackOnAnyError: true,
    label: "Prompt suggestion inference",
    logContext: { threadId },
    maxAttempts: INFERENCE_POLICY.promptSuggestion.maxAttempts,
    primaryModel: models.primary,
    fallbackModel: models.fallback,
    prompt: renderTemplate("generatePromptSuggestion", {
      instructions: readUiPreferences(deps)["promptSuggestions.prompt"].value,
      userMessage,
      agentReply: tail(reply, MAX_REPLY_LENGTH),
      purpose: getThread(deps.db, threadId)?.purpose?.text ?? "",
      styleSamples: styleSamples(deps, threadId),
    }),
    reasoningEffort: "low",
    retryDelayMs: INFERENCE_POLICY.promptSuggestion.retryDelayMs,
    schema: suggestionSchema,
    timeoutMs: INFERENCE_POLICY.promptSuggestion.timeoutMs,
  });
  const text = result ? cleanSuggestion(result.suggestion) : null;
  return text && !repeats(text, userMessage) ? text : null;
}

function repeats(suggestion: string, userMessage: string): boolean {
  const words = (text: string) =>
    text.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";
  const said = words(suggestion);
  return said.split(" ").length > 2 && said === words(userMessage);
}

function styleSamples(
  deps: CommandResultSideEffectsDeps,
  threadId: string,
): string {
  const recent = deps.db
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        ne(threads.id, threadId),
        isNull(threads.deletedAt),
        isNull(threads.parentThreadId),
      ),
    )
    .orderBy(desc(threads.updatedAt))
    .limit(STYLE_CANDIDATES)
    .all();
  const lines: string[] = [];
  for (const { id } of recent) {
    const text = lastUserMessage(deps.db, id, MAX_SAMPLE_LENGTH);
    if (text) lines.push(`- ${text}`);
    if (lines.length === STYLE_THREADS) break;
  }
  return lines.join("\n");
}

function lastUserMessage(
  db: DbConnection,
  threadId: string,
  max = MAX_MESSAGE_LENGTH,
): string | null {
  const rows = db
    .select({ data: events.data })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.type, "client/turn/requested"),
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(RECENT_REQUESTS)
    .all();
  for (const row of rows) {
    const text = requestUserText(row.data, max);
    if (text) return text;
  }
  return null;
}

function requestUserText(data: string, max: number): string | null {
  try {
    const request = JSON.parse(data) as {
      initiator?: string;
      input?: unknown;
      retryOfRequestId?: string | null;
      senderThreadId?: string | null;
    };
    if (
      request.initiator !== "user" ||
      request.senderThreadId ||
      request.retryOfRequestId ||
      !Array.isArray(request.input)
    )
      return null;
    const text = request.input
      .map((part: { type?: string; text?: string; visibility?: string }) =>
        part.type === "text" && part.visibility !== "agent-only"
          ? (part.text ?? "")
          : "",
      )
      .join(" ");
    const clean = clip(text, max);
    return clean && !MACHINE_PREFIXES.some((prefix) => clean.startsWith(prefix))
      ? clean
      : null;
  } catch {
    return null;
  }
}

function tail(text: string, max: number): string {
  const clean = clip(text, Number.MAX_SAFE_INTEGER);
  return clean.length <= max ? clean : `...${clean.slice(-(max - 3))}`;
}

export function cleanSuggestion(raw: string): string | null {
  const text = raw
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/gu, "");
  if (!text || text.length > MAX_SUGGESTION_LENGTH) return null;
  if (text.split(" ").length > 12) return null;
  if (text.endsWith("?")) return null;
  if (/[.!?]\s+\S/u.test(text)) return null;
  if (
    /^(let me|i'll|i will|i've|here's|here is|sure|great|thanks|thank you|looks good|perfect|awesome|nice)\b/iu.test(
      text,
    )
  )
    return null;
  return text;
}
