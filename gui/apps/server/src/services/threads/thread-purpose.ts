import { renderTemplate } from "@cloudroom/templates";
import {
  THREAD_PURPOSE_CLAUDE_MODEL,
  THREAD_PURPOSE_CODEX_MODEL,
} from "@cloudroom/domain";
import {
  events,
  getThread,
  setThreadPurpose,
  type DbConnection,
} from "@cloudroom/db";
import { Type } from "@earendil-works/pi-ai";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { CommandResultSideEffectsDeps } from "../../internal/command-result-side-effects.js";
import {
  INFERENCE_POLICY,
  inferenceCompleteWithFallback,
} from "../ai/inference.js";
import { macClaudeSignedIn } from "../cloudroom/claude-token.js";
import { hasMacCodexLogin } from "../cloudroom/sandboxes.js";
import { runtimeErrorLogFields } from "../lib/error-log-fields.js";
import { readUiPreferences } from "../system/ui-preferences.js";
import { getLastThreadOutput } from "./thread-data.js";

const MAX_MESSAGE_LENGTH = 600;
const MAX_REPLY_LENGTH = 2_000;
const RECENT_MESSAGES = 4;
const MAX_PURPOSE_LENGTH = 110;
const LOGIN_CHECK_MS = 5 * 60_000;
const PERCENT_STAGES = [10, 25, 50, 75, 90, 100];

const purposeSchema = Type.Object({
  purpose: Type.String(),
  percent: Type.Number(),
});

interface Tracker {
  deps: CommandResultSideEffectsDeps;
  running: Map<string, { again: boolean }>;
}

let tracker: Tracker | null = null;
let logins: {
  at: number;
  value: Promise<{ claude: boolean; codex: boolean }>;
} | null = null;

function signedInHarnesses(): Promise<{ claude: boolean; codex: boolean }> {
  if (!logins || Date.now() - logins.at > LOGIN_CHECK_MS) {
    logins = {
      at: Date.now(),
      value: Promise.all([macClaudeSignedIn(), hasMacCodexLogin()]).then(
        ([claude, codex]) => ({ claude: claude === true, codex }),
      ),
    };
  }
  return logins.value;
}

async function purposeModels(
  chosen: string | null,
): Promise<{ primary: string; fallback: string } | null> {
  if (chosen) return { primary: chosen, fallback: chosen };
  const { claude, codex } = await signedInHarnesses();
  if (claude) {
    return {
      primary: THREAD_PURPOSE_CLAUDE_MODEL,
      fallback: codex
        ? THREAD_PURPOSE_CODEX_MODEL
        : THREAD_PURPOSE_CLAUDE_MODEL,
    };
  }
  return codex
    ? {
        primary: THREAD_PURPOSE_CODEX_MODEL,
        fallback: THREAD_PURPOSE_CODEX_MODEL,
      }
    : null;
}

export function installThreadPurpose(
  deps: CommandResultSideEffectsDeps,
): () => void {
  const current: Tracker = { deps, running: new Map() };
  tracker = current;
  const unsubscribe = deps.hub.onChangedMessage((message) => {
    if (
      message.entity === "thread" &&
      message.changes.includes("status-changed")
    ) {
      refresh(current, message.id);
    }
  });
  return () => {
    unsubscribe();
    if (tracker === current) tracker = null;
  };
}

export function noteFirstThreadMessage(
  threadId: string,
  firstMessage: string,
): void {
  if (tracker) refresh(tracker, threadId, firstMessage);
}

function refresh(
  current: Tracker,
  threadId: string,
  firstMessage?: string,
): void {
  const running = current.running.get(threadId);
  if (running) {
    running.again = true;
    return;
  }
  if (!isDue(current.deps.db, threadId, firstMessage !== undefined)) return;
  const state = { again: false };
  current.running.set(threadId, state);
  void writePurpose(current.deps, threadId, firstMessage)
    .catch((error: unknown) => {
      current.deps.logger.warn(
        { threadId, ...runtimeErrorLogFields(current.deps.config, error) },
        "Thread purpose update failed",
      );
    })
    .finally(() => {
      current.running.delete(threadId);
      if (state.again && tracker === current) refresh(current, threadId);
    });
}

function isDue(
  db: DbConnection,
  threadId: string,
  hasFirstMessage: boolean,
): boolean {
  const thread = getThread(db, threadId);
  if (!thread || thread.archivedAt !== null || thread.deletedAt !== null)
    return false;
  if (!thread.purpose) return hasFirstMessage || thread.status === "idle";
  return (
    thread.status === "idle" &&
    lastTurnSequence(db, threadId) > thread.purpose.sourceSeq
  );
}

function lastTurnSequence(db: DbConnection, threadId: string): number {
  return (
    db
      .select({ sequence: events.sequence })
      .from(events)
      .where(
        and(eq(events.threadId, threadId), eq(events.type, "turn/completed")),
      )
      .orderBy(desc(events.sequence))
      .limit(1)
      .get()?.sequence ?? 0
  );
}

function clip(text: string, max: number): string {
  const clean = text
    .replace(/<cloudroom_[a-z_]+>[\s\S]*?<\/cloudroom_[a-z_]+>/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 3)}...`;
}

function requestText(data: string): string {
  try {
    const input: unknown = JSON.parse(data)?.input;
    if (!Array.isArray(input)) return "";
    return input
      .map((part: { type?: string; text?: string; visibility?: string }) =>
        part.type === "text" && part.visibility !== "agent-only"
          ? (part.text ?? "")
          : "",
      )
      .join(" ");
  } catch {
    return "";
  }
}

function userMessages(
  db: DbConnection,
  threadId: string,
  order: "first" | "last",
): string[] {
  const rows = db
    .select({ data: events.data })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.type, "client/turn/requested"),
        sql`json_extract(${events.data}, '$.initiator') IS NOT 'system'`,
        sql`json_extract(${events.data}, '$.retryOfRequestId') IS NULL`,
      ),
    )
    .orderBy(order === "first" ? asc(events.sequence) : desc(events.sequence))
    .limit(order === "first" ? 1 : RECENT_MESSAGES)
    .all();
  return rows
    .map((row) => clip(requestText(row.data), MAX_MESSAGE_LENGTH))
    .filter(Boolean)
    .reverse();
}

async function writePurpose(
  deps: CommandResultSideEffectsDeps,
  threadId: string,
  firstMessage?: string,
): Promise<void> {
  const preferences = readUiPreferences(deps);
  if (!preferences["threadPurpose.enabled"].value) return;
  const thread = getThread(deps.db, threadId);
  if (!thread) return;
  const sourceSeq = lastTurnSequence(deps.db, threadId);

  const recent = userMessages(deps.db, threadId, "last");
  const first =
    userMessages(deps.db, threadId, "first")[0] ??
    (firstMessage ? clip(firstMessage, MAX_MESSAGE_LENGTH) : undefined) ??
    thread.titleFallback;
  if (!first) return;
  const agentReply =
    sourceSeq > 0 ? getLastThreadOutput(deps.db, threadId) : null;
  const models = await purposeModels(preferences["threadPurpose.model"].value);
  if (!models) return;
  const previous = thread.purpose;
  const prompt = renderTemplate("generateThreadPurpose", {
    agentReply: agentReply ? clip(agentReply, MAX_REPLY_LENGTH) : "",
    firstMessage: first,
    previousPurpose: previous
      ? `${previous.text} (${previous.percent}% done)`
      : "",
    recentMessages: (recent.length > 0 ? recent : [first])
      .map((text) => `- ${text}`)
      .join("\n"),
    title: thread.title ?? thread.titleFallback ?? "Untitled thread",
  });

  const result = await inferenceCompleteWithFallback(deps, {
    fallbackOnAnyError: true,
    label: "Thread purpose inference",
    logContext: { threadId },
    maxAttempts: INFERENCE_POLICY.threadPurpose.maxAttempts,
    primaryModel: models.primary,
    fallbackModel: models.fallback,
    prompt,
    reasoningEffort: preferences["threadPurpose.reasoningEffort"].value,
    retryDelayMs: INFERENCE_POLICY.threadPurpose.retryDelayMs,
    schema: purposeSchema,
    timeoutMs: INFERENCE_POLICY.threadPurpose.timeoutMs,
  });
  const text = result
    ? clip(
        result.purpose
          .replace(/^["'`]+|["'`]+$/gu, "")
          .replace(/\btriag(?:e|ed|ing)\b/giu, (word) =>
            word[0] === "T" ? "Looking into" : "looking into",
          ),
        MAX_PURPOSE_LENGTH,
      )
    : "";
  if (
    !result ||
    !text ||
    !readUiPreferences(deps)["threadPurpose.enabled"].value
  )
    return;
  const latest = getThread(deps.db, threadId);
  if (!latest || latest.archivedAt !== null || latest.deletedAt !== null)
    return;
  if (latest.purpose && latest.purpose.sourceSeq > sourceSeq) return;
  setThreadPurpose(deps.db, deps.hub, threadId, {
    text,
    percent: PERCENT_STAGES.reduce((best, stage) =>
      Math.abs(stage - result.percent) < Math.abs(best - result.percent)
        ? stage
        : best,
    ),
    sourceSeq,
    updatedAt: Date.now(),
  });
}
