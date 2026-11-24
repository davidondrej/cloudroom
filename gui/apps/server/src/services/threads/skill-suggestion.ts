import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getThread, type DbConnection } from "@cloudroom/db";
import { renderTemplate } from "@cloudroom/templates";
import { Type } from "@earendil-works/pi-ai";
import { sql } from "drizzle-orm";
import type { AppDeps } from "../../types.js";
import { INFERENCE_POLICY, inferenceCompleteWithFallback } from "../ai/inference.js";
import { cloudroom } from "../cloudroom/commands.js";
import { readUiPreferences } from "../system/ui-preferences.js";
import { lastTurn } from "./prompt-suggestion.js";
import { similarThreads, type StartedThread } from "./skill-repeats.js";
import { clip, purposeModels } from "./thread-purpose.js";

// Skill suggestions (docs/scopes/skill-suggestions.md): when a thread finishes a job the user keeps asking for by hand,
// the app offers to save it as a skill. Only for accounts in the bottom 20% by skills run per agent. A text match on
// this computer picks the look-alike threads for free; one small-model call, at most once a day, confirms them.

const DAY = 86_400_000;
const WINDOW_DAYS = 14;
const RANK_EVERY_MS = 7 * DAY, RANK_RETRY_MS = 60 * 60_000, CARD_EVERY_MS = 7 * DAY;
const MAX_ANSWERED = 300, MAX_CACHED_THREADS = 200;
const NAME = /^[a-z0-9]+(-[a-z0-9]+){0,2}$/u;
const FILE = "cloudroom-skill-suggestions.json";
const HAND_STARTED = /^(phone_|[0-9a-f]{8}-[0-9a-f]{4}-)/u;

export interface SkillSuggestion {
  /** The skill's name, like `release`. */
  name: string;
  /** What it does, like "Cut a release". */
  what: string;
  /** How many threads asked for this job, with this one. */
  count: number;
  /** The message that asks this thread's agent to write the skill. */
  prompt: string;
}
type Kept = { threadId: string; seq: number; suggestion: SkillSuggestion; threads: string[] };
/** Saved on this computer. `rank`: the website's last answer. `checkedAt`: the last model call. `shownAt`: the last card. `answered`: threads of
 *  suggestions the user took or closed, which never count again. `kept`: the suggestion on screen, so a reload keeps it. */
type State = { rank: { userId: string; bottom: boolean; at: number } | null; checkedAt: number; shownAt: number; answered: string[]; kept: Kept | null };

const answerSchema = Type.Object({ repeat: Type.Boolean(), same: Type.Array(Type.Number()), name: Type.String(), what: Type.String() });
const cache = new Map<string, { seq: number; value: Promise<SkillSuggestion | null> }>();
const shown = new Set<string>();
let rankAskedAt = 0;

const file = (deps: AppDeps) => join(deps.config.dataDir, FILE);
async function readState(deps: AppDeps): Promise<State> {
  const saved = await readFile(file(deps), "utf8").then((text) => JSON.parse(text) as Partial<State>, () => ({}) as Partial<State>);
  return { rank: saved.rank ?? null, checkedAt: Number(saved.checkedAt) || 0, shownAt: Number(saved.shownAt) || 0, answered: Array.isArray(saved.answered) ? saved.answered : [], kept: saved.kept ?? null };
}
const writeState = (deps: AppDeps, state: State) => writeFile(file(deps), JSON.stringify(state), { mode: 0o600 });

/** Whether the website ranks this account in the bottom 20%. Asked once a week; a failed ask waits an hour. */
async function inBottom(deps: AppDeps, state: State, now: number): Promise<boolean> {
  const account = await cloudroom(deps).sandboxes.account().catch(() => null);
  if (!account) return false;
  if (state.rank?.userId === account.userId && now - state.rank.at < RANK_EVERY_MS) return state.rank.bottom;
  if (now - rankAskedAt < RANK_RETRY_MS) return false;
  rankAskedAt = now;
  const bottom = await cloudroom(deps).sandboxes.skillBottom().catch(() => null);
  if (bottom === null) return false;
  state.rank = { userId: account.userId, bottom, at: now };
  await writeState(deps, state);
  return bottom;
}

/** Top-level threads a person started in the app since `since` and never ran a skill in, newest first. Loop runs, forks and threads agents or scripts started are left out. */
export function startedThreads(db: DbConnection, since: number): StartedThread[] {
  const rows = db.all<{ id: string; title: string | null; data: string | null; skill: number; cloudStart: string | null }>(sql`
    SELECT t.id AS id, coalesce(t.title, t.title_fallback) AS title,
      (SELECT c.start_request_id FROM cloudroom_threads AS c WHERE c.thread_id = t.id) AS cloudStart,
      (SELECT e.data FROM events AS e WHERE e.thread_id = t.id AND e.type = 'client/turn/requested' ORDER BY e.sequence LIMIT 1) AS data,
      EXISTS (SELECT 1 FROM events AS e, json_each(e.data, '$.input') AS item, json_each(item.value, '$.mentions') AS mention
        WHERE e.thread_id = t.id AND e.type = 'client/turn/requested' AND json_extract(mention.value, '$.resource.source') = 'skill') AS skill
    FROM threads AS t
    WHERE t.created_at >= ${since} AND t.parent_thread_id IS NULL AND t.deleted_at IS NULL AND t.visibility = 'visible'
      AND t.origin_kind IS NULL AND t.origin_plugin_id IS NULL
    ORDER BY t.created_at DESC
  `);
  return rows.flatMap((row) => {
    if (row.skill || !row.data) return [];
    const request = JSON.parse(row.data) as { initiator?: string; senderThreadId?: string | null; appSurface?: string; input?: { type?: string; text?: string; visibility?: string }[] };
    // Only a thread a person started counts. Cloud: the app and the phone start it with a plain or `phone_` ID; loops,
    // subagents and teleports use their own prefixes. Local: scripts and the CLI send "api", and older apps recorded no surface.
    const typed = row.cloudStart !== null ? HAND_STARTED.test(row.cloudStart) : Boolean(request.appSurface) && request.appSurface !== "api";
    if (!typed || request.initiator !== "user" || request.senderThreadId || !Array.isArray(request.input)) return [];
    const prompt = request.input.map((part) => part.type === "text" && part.visibility !== "agent-only" ? part.text ?? "" : "").join(" ").trim();
    // "/name" runs a skill.
    return !prompt || prompt.startsWith("/") ? [] : [{ id: row.id, title: row.title ?? "", prompt }];
  });
}

export function skillSuggestion(deps: AppDeps, threadId: string): Promise<SkillSuggestion | null> {
  if (!readUiPreferences(deps)["skillSuggestions.enabled"].value) return Promise.resolve(null);
  const thread = getThread(deps.db, threadId);
  if (!thread || thread.status !== "idle" || thread.parentThreadId) return Promise.resolve(null);
  const turn = lastTurn(deps.db, threadId);
  if (!turn || turn.status !== "completed") return Promise.resolve(null);
  const cached = cache.get(threadId);
  if (cached?.seq === turn.seq) return cached.value;
  const value = suggest(deps, threadId, turn.seq).catch((error: unknown) => {
    deps.logger.debug({ error, threadId }, "Skill suggestion failed");
    return null;
  });
  cache.delete(threadId);
  cache.set(threadId, { seq: turn.seq, value });
  if (cache.size > MAX_CACHED_THREADS) cache.delete(cache.keys().next().value!);
  return value;
}

async function suggest(deps: AppDeps, threadId: string, seq: number, now = Date.now()): Promise<SkillSuggestion | null> {
  const state = await readState(deps);
  if (state.kept?.threadId === threadId) return state.kept.suggestion;
  // At most one card a week and one model call a day.
  if (now - state.shownAt < CARD_EVERY_MS || now - state.checkedAt < DAY || !(await inBottom(deps, state, now))) return null;
  const answered = new Set(state.answered);
  const started = startedThreads(deps.db, now - WINDOW_DAYS * DAY).filter((thread) => !answered.has(thread.id));
  const mine = started.find((thread) => thread.id === threadId);
  if (!mine) return null;
  const alike = similarThreads(mine, started.filter((thread) => thread !== mine));
  if (alike.length < 2) return null;
  const models = await purposeModels(deps, null);
  if (!models) return null;
  // Saved before the call, so a slow or failed call still spends today's one check.
  state.checkedAt = now;
  await writeState(deps, state);
  const threads = [mine, ...alike];
  const answer = await inferenceCompleteWithFallback(deps, {
    fallbackOnAnyError: true,
    label: "Skill suggestion inference",
    logContext: { threadId },
    maxAttempts: INFERENCE_POLICY.skillSuggestion.maxAttempts,
    primaryModel: models.primary,
    fallbackModel: models.fallback,
    prompt: renderTemplate("detectRepeatWorkflow", {
      threads: threads.map((thread, index) => `${index + 1}. Title: ${clip(thread.title, 120)}\n   First message: ${clip(thread.prompt, 500)}`).join("\n"),
    }),
    reasoningEffort: "low",
    retryDelayMs: INFERENCE_POLICY.skillSuggestion.retryDelayMs,
    schema: answerSchema,
    timeoutMs: INFERENCE_POLICY.skillSuggestion.timeoutMs,
  });
  const same = [...new Set(answer?.same ?? [])].filter((number) => Number.isInteger(number) && number >= 1 && number <= threads.length).map((number) => threads[number - 1]!);
  const name = answer?.name.trim().replace(/^\//u, "") ?? "", what = clip(answer?.what ?? "", 60).replace(/[.!]+$/u, "");
  if (!answer?.repeat || same[0] !== mine || same.length < 3 || !NAME.test(name) || !what) return null;
  const suggestion: SkillSuggestion = {
    name, what, count: same.length,
    prompt: renderTemplate("createSkillFromRepeats", { name, what, threads: same.slice(1).map((thread) => `- ${thread.id}: ${clip(thread.title, 80)}`).join("\n") }),
  };
  state.kept = { threadId, seq, suggestion, threads: same.map((thread) => thread.id) };
  await writeState(deps, state);
  return suggestion;
}

/** What the user did with the card. `accepted` and `dismissed` retire its threads, so the same job needs 3 new threads to come back. */
export async function skillSuggestionEvent(deps: AppDeps, threadId: string, action: "shown" | "accepted" | "dismissed"): Promise<void> {
  const state = await readState(deps);
  if (state.kept?.threadId !== threadId) return;
  if (action === "shown") {
    if (shown.has(threadId)) return;
    shown.add(threadId);
    state.shownAt = Date.now();
    await writeState(deps, state);
  } else {
    state.answered = [...new Set([...state.answered, ...state.kept.threads])].slice(-MAX_ANSWERED);
    state.kept = null;
    cache.delete(threadId);
    await writeState(deps, state);
  }
  deps.telemetry.capture({ name: "skill_suggestion", properties: { action } });
}
