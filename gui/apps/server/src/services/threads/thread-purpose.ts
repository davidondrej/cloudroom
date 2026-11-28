import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GIT_NO_FETCH_ENV, gitSafetyArgs } from "@cloudroom/host-workspace";
import { renderTemplate } from "@cloudroom/templates";
import {
  THREAD_PURPOSE_CLAUDE_MODEL,
  THREAD_PURPOSE_CODEX_MODEL,
} from "@cloudroom/domain";
import {
  events,
  getEnvironment,
  getLatestThreadOutputEventRow,
  getThread,
  hasRootStoredTurnStarted,
  setThreadPurpose,
  type DbConnection,
} from "@cloudroom/db";
import type { ThreadPurpose } from "@cloudroom/domain";
import { Type } from "@earendil-works/pi-ai";
import { and, asc, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import type { CommandResultSideEffectsDeps } from "../../internal/command-result-side-effects.js";
import {
  INFERENCE_POLICY,
  inferenceCompleteWithFallback,
} from "../ai/inference.js";
import { macClaudeSignedIn } from "../cloudroom/claude-token.js";
import { hasMacCodexLogin } from "../cloudroom/sandboxes.js";
import { providerLoginEnvironment } from "../hosts/host-environment.js";
import {
  readPrimaryHostIdFromDataDir,
  resolvePrimaryHostId,
} from "../hosts/primary-host.js";
import { runtimeErrorLogFields } from "../lib/error-log-fields.js";
import { readUiPreferences } from "../system/ui-preferences.js";
import { threadOutputText } from "./thread-data.js";
import { cloudTurnsElsewhere } from "../plugins/plugin-thread-events.js";

const MAX_MESSAGE_LENGTH = 600;
const MAX_REPLY_LENGTH = 2_000;
const RECENT_MESSAGES = 4;
const MAX_GOAL_LENGTH = 60;
const GIT_FACTS_TIMEOUT_MS = 10_000;
const exec = promisify(execFile);
const MAX_PURPOSE_LENGTH = 110;
const LOGIN_CHECK_MS = 5 * 60_000;
const PERCENT_STAGES = [10, 25, 50, 75, 90, 100];
const EARLIER_REPLIES = 3;
const MAX_TURNS_SCANNED = 20;
const BLANK = /^[\s\u0085]*$/u;

const purposeSchema = Type.Object({
  goal: Type.String(),
  state: Type.String(),
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

type LoginDeps = Pick<CommandResultSideEffectsDeps, "config">;

/** Claude Code can answer on the Mac's own login, or on one Cloudroom passes in: a picked account or the cloud login. */
async function claudeSignedIn(deps: LoginDeps): Promise<boolean> {
  const hostId = readPrimaryHostIdFromDataDir({ dataDir: deps.config.dataDir });
  const passedIn = hostId
    ? await providerLoginEnvironment(deps, { hostId, providerId: "claude-code" })
    : [];
  return (
    passedIn.some((entry) => entry.value !== "") ||
    (await macClaudeSignedIn()) === true
  );
}

function signedInHarnesses(
  deps: LoginDeps,
): Promise<{ claude: boolean; codex: boolean }> {
  if (!logins || Date.now() - logins.at > LOGIN_CHECK_MS) {
    logins = {
      at: Date.now(),
      value: Promise.all([claudeSignedIn(deps), hasMacCodexLogin()]).then(
        ([claude, codex]) => ({ claude, codex }),
      ),
    };
  }
  return logins.value;
}

export async function purposeModels(
  deps: LoginDeps,
  chosen: string | null,
): Promise<{ primary: string; fallback: string } | null> {
  if (chosen) return { primary: chosen, fallback: chosen };
  const { claude, codex } = await signedInHarnesses(deps);
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
      message.changes.includes("status-changed") &&
      !cloudTurnsElsewhere.has(message.id)
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

/** Non-blank root-turn replies that ended after the previous note, up to this one, oldest first, without the latest
 *  reply: a refresh that failed, or ran while another turn ended, must not lose a reply to a later quiet one (#2437). */
function earlierReplies(
  db: DbConnection,
  threadId: string,
  range: { after: number; upTo: number; latestId: string | undefined },
): string[] {
  const turns = db
    .select({ turnId: events.turnId })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.type, "turn/completed"),
        gt(events.sequence, range.after),
        lte(events.sequence, range.upTo),
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(MAX_TURNS_SCANNED)
    .all();
  const replies: string[] = [];
  for (const { turnId } of turns) {
    if (replies.length === EARLIER_REPLIES) break;
    if (!turnId || !hasRootStoredTurnStarted(db, { threadId, turnId }))
      continue;
    // The turn's own last main-thread reply: a newer nested item can't hide it, and blank replies don't count.
    const row = db
      .select({
        id: events.id,
        text: sql<string>`json_extract(${events.data}, '$.item.text')`,
      })
      .from(events)
      .where(
        and(
          eq(events.threadId, threadId),
          eq(events.turnId, turnId),
          eq(events.type, "item/completed"),
          eq(events.itemKind, "agentMessage"),
          isNull(events.parentToolCallId),
          sql`TRIM(COALESCE(json_extract(${events.data}, '$.item.text'), ''), ' ' || char(9, 10, 13)) <> ''`,
        ),
      )
      .orderBy(desc(events.sequence))
      .limit(5)
      .all()
      // Unicode blanks (a lone NBSP or U+0085) slip past SQLite's TRIM.
      .find((reply) => !BLANK.test(reply.text));
    if (row && row.id !== range.latestId) replies.unshift(row.text);
  }
  return replies;
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

export function clip(text: string, max: number): string {
  const clean = text
    .replace(/<cloudroom_[a-z_]+>[\s\S]*?<\/cloudroom_[a-z_]+>/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 3)}...`;
}

/** A long reply keeps its start and its end, where the question to the user usually sits. */
export function clipEnds(text: string, max: number): string {
  const clean = clip(text, Number.MAX_SAFE_INTEGER);
  if (clean.length <= max) return clean;
  const head = Math.floor(max * 0.4);
  return `${clean.slice(0, head)} ... ${clean.slice(head + 5 - max)}`;
}

function previousNote(previous: ThreadPurpose): string {
  const note = previous.goal
    ? [
        `Goal: ${previous.goal}`,
        `State: ${previous.text.slice(previous.goal.length).trim()}`,
      ]
    : [`Note: ${previous.text}`];
  return [...note, `Percent: ${previous.percent}`].join("\n");
}

/**
 * Uncommitted changes, and commits no remote branch has. Pushed to main or to the thread's own branch
 * both count as pushed. Without a remote, the commit count says nothing, so it is left out.
 */
export async function readGitFacts(path: string): Promise<string> {
  // --no-optional-locks: never take the index lock the agent's own Git may need.
  const git = (...args: string[]) =>
    exec(
      "git",
      [...gitSafetyArgs(), "--no-optional-locks", "-C", path, ...args],
      {
        timeout: GIT_FACTS_TIMEOUT_MS,
        env: { ...process.env, ...GIT_NO_FETCH_ENV },
        windowsHide: true,
      },
    ).then(({ stdout }) => stdout.trim());
  const [status, remotes] = await Promise.all([
    git("status", "--porcelain", "--no-renames"),
    git("remote"),
  ]);
  const unpushed = remotes
    ? await git("rev-list", "--count", "HEAD", "--not", "--remotes")
    : null;
  return [
    `- Uncommitted changes: ${status ? "yes" : "no"}`,
    ...(unpushed === null ? [] : [`- Commits not on GitHub yet: ${unpushed}`]),
  ].join("\n");
}

/** The real Git state of the thread's folder, so the percent is not guessed from the reply. */
async function gitFacts(
  deps: CommandResultSideEffectsDeps,
  environmentId: string | null,
): Promise<string> {
  const environment = environmentId
    ? getEnvironment(deps.db, environmentId)
    : null;
  // Only the thread's own worktree on this computer: a shared checkout also holds other threads'
  // changes, and another computer's folders are out of reach.
  if (
    !environment?.isWorktree ||
    environment.status !== "ready" ||
    !environment.path ||
    environment.hostId !== resolvePrimaryHostId(deps)
  ) {
    return "";
  }
  try {
    return await readGitFacts(environment.path);
  } catch (error) {
    deps.logger.warn(
      { environmentId, ...runtimeErrorLogFields(deps.config, error) },
      "Thread purpose Git facts failed",
    );
    return "";
  }
}

const cleanPart = (part: string) =>
  part
    .trim()
    // Only quotes around the whole text go: a note may end on a quoted word.
    .replace(/^(["'`])([\s\S]*)\1$/u, "$2")
    .replace(/\btriag(?:e|ed|ing)\b/giu, (word) =>
      word[0] === "T" ? "Looking into" : "looking into",
    );

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

export function userMessages(
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
  const latestRow =
    sourceSeq > 0 ? getLatestThreadOutputEventRow(deps.db, { threadId }) : null;
  const agentReply = threadOutputText(latestRow);
  const models = await purposeModels(
    deps,
    preferences["threadPurpose.model"].value,
  );
  if (!models) return;
  const previous = thread.purpose;
  const earlier = previous
    ? earlierReplies(deps.db, threadId, {
        after: previous.sourceSeq,
        upTo: sourceSeq,
        latestId: latestRow?.id,
      })
    : [];
  const prompt = renderTemplate("generateThreadPurpose", {
    agentReply: agentReply ? clipEnds(agentReply, MAX_REPLY_LENGTH) : "",
    earlierReplies: earlier
      .map((reply) => `- ${clipEnds(reply, MAX_MESSAGE_LENGTH)}`)
      .join("\n"),
    firstMessage: first,
    gitFacts: sourceSeq > 0 ? await gitFacts(deps, thread.environmentId) : "",
    previousPurpose: previous ? previousNote(previous) : "",
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
  const said = result ? clip(cleanPart(result.goal), MAX_GOAL_LENGTH) : "";
  const goal = said && !/[.!?]$/u.test(said) ? `${said}.` : said;
  const text = result
    ? clip(`${goal} ${cleanPart(result.state)}`, MAX_PURPOSE_LENGTH)
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
    ...(goal && text.startsWith(goal) ? { goal } : {}),
    percent: PERCENT_STAGES.reduce((best, stage) =>
      Math.abs(stage - result.percent) < Math.abs(best - result.percent)
        ? stage
        : best,
    ),
    sourceSeq,
    updatedAt: Date.now(),
  });
}
