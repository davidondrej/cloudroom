import { cloudroomCommands, cloudroomThreads, environments, events, getThread, threads, type DbConnection } from "@cloudroom/db";
import type { ThreadEventType } from "@cloudroom/domain";
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { NotificationHub } from "../../ws/hub.js";
import type { TelemetryEvent, TelemetryExecution, TelemetryService } from "./telemetry.js";
import type { SandboxDirectory } from "../cloudroom/sandboxes.js";
import { secondsSinceFirstLaunch } from "../cloudroom/setup-telemetry.js";
import { firstAgentTag } from "./first-agent.js";
import { turnStarterAfter } from "../threads/turn-failed.js";

const OUTPUT_TYPES: ThreadEventType[] = [
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
];
const TURN_TYPES: ThreadEventType[] = ["turn/started", "turn/completed"];
const MAX_WAIT_MS = 10 * 60_000;
const SWEEP_MS = 60_000;

interface SentMessage {
  afterSequence: number;
  execution: TelemetryExecution;
  isChildThread: boolean;
  messageSource: Extract<TelemetryEvent, { name: "first_response" }>["properties"]["message_source"];
  provider: string;
  sentAt: number;
  model?: string | null;
  reasoningLevel?: string | null;
  serviceTier?: string | null;
  /** `first_response` already fired, e.g. on an empty reasoning start; kept only until real output or `turn/completed`. */
  firstResponseSent?: boolean;
  /** The computer slept during the wait, so a missing reply may not be ours. */
  slept?: boolean;
}

interface Tracker {
  db: DbConnection;
  pending: Map<string, SentMessage>;
  telemetry: TelemetryService;
  wokeSince: (threadId: string, at: number) => boolean;
  startupSince: (threadId: string, at: number) => ReturnType<SandboxDirectory["startupSince"]> | null;
}

let tracker: Tracker | null = null;
/** How long each thread's workspace took to create, kept until its first reply. */
const workspaceCreates = new Map<string, { ms: number; at: number }>();

/** Records how long an environment provider took to create a thread's workspace, such as a worktree. */
export function noteWorkspaceCreated(threadId: string, ms: number): void {
  const now = Date.now();
  for (const [id, entry] of workspaceCreates) if (now - entry.at > MAX_WAIT_MS) workspaceCreates.delete(id);
  workspaceCreates.set(threadId, { ms, at: now });
}

export function installFirstResponseTelemetry(
  deps: { db: DbConnection; hub: NotificationHub; telemetry: TelemetryService },
  wokeSince: Tracker["wokeSince"],
  startupSince: Tracker["startupSince"] = () => null,
): () => void {
  const current: Tracker = { db: deps.db, pending: new Map(), telemetry: deps.telemetry, wokeSince, startupSince };
  tracker = current;
  const unsubscribe = deps.hub.onChangedMessage((message) => {
    if (message.entity !== "thread" || !message.changes.includes("events-appended")) return;
    const sent = current.pending.get(message.id);
    if (!sent) return;
    const types = message.metadata?.eventTypes;
    const mayHaveOutput = !types || types.some((type) => OUTPUT_TYPES.includes(type));
    if (!sent.firstResponseSent && mayHaveOutput && hasOutputAfter(current.db, message.id, sent.afterSequence)) {
      sent.firstResponseSent = true;
      const ms = Date.now() - sent.sentAt;
      if (ms <= MAX_WAIT_MS) {
        const startup = sent.execution === "cloud_sandbox" ? current.startupSince(message.id, sent.sentAt) : null;
        const turn = sent.execution === "local" ? latestTurnExecution(current.db, message.id) : undefined;
        // Only a workspace created after this message was sent counts toward it.
        const created = workspaceCreates.get(message.id);
        workspaceCreates.delete(message.id);
        current.telemetry.capture({
          name: "first_response",
          properties: {
            execution: sent.execution,
            is_child_thread: sent.isChildThread,
            message_source: sent.messageSource,
            ms,
            provider: sent.provider,
            sandbox_woke: sent.execution === "cloud_sandbox" ? current.wokeSince(message.id, sent.sentAt) : null,
            startup_source: startup?.startup_source ?? null,
            sandbox_start_ms: startup?.sandbox_start_ms ?? null,
            model: turn?.model ?? sent.model ?? null,
            reasoning_level: turn?.reasoning ?? sent.reasoningLevel ?? null,
            service_tier: sent.serviceTier ?? null,
            harness_version: sent.provider === "codex" ? startup?.versions?.codex ?? null : sent.provider === "claude-code" ? startup?.versions?.claude ?? null : null,
            environment_provider: sent.execution === "local" ? environmentProviderOf(current.db, message.id) : null,
            workspace_create_ms: created !== undefined && created.at >= sent.sentAt ? created.ms : null,
            seconds_since_first_launch: secondsSinceFirstLaunch(),
            ...firstAgentTag(current.db, message.id),
          },
        });
      }
      if (hasSubstantiveOutputAfter(current.db, message.id, sent.afterSequence)) {
        current.pending.delete(message.id);
        return;
      }
    } else if (sent.firstResponseSent && mayHaveOutput && hasSubstantiveOutputAfter(current.db, message.id, sent.afterSequence)) {
      current.pending.delete(message.id);
      return;
    }
    if (types?.includes("turn/completed")) {
      current.pending.delete(message.id);
      if (
        lastTurnStatus(current.db, message.id, sent.afterSequence) === "completed" &&
        !hasSubstantiveOutputAfter(current.db, message.id, sent.afterSequence)
      ) {
        captureSilent(current, message.id, sent, "empty");
      }
    }
  });
  // A message with no reply and no error after 10 minutes is a silent failure. A long gap between sweeps means the
  // computer slept, which pauses Local agents and the app's view of Cloud, so those waits don't count.
  let lastSweep = Date.now();
  const sweep = setInterval(() => {
    const now = Date.now();
    const slept = now - lastSweep > 3 * SWEEP_MS;
    lastSweep = now;
    for (const [threadId, sent] of current.pending) {
      if (slept) sent.slept = true;
      if (now - sent.sentAt < MAX_WAIT_MS) continue;
      current.pending.delete(threadId);
      if (!sent.slept && !sent.firstResponseSent) captureSilent(current, threadId, sent, "no_reply");
    }
  }, SWEEP_MS);
  sweep.unref();
  return () => {
    unsubscribe();
    clearInterval(sweep);
    if (tracker === current) tracker = null;
  };
}

/** A stop ends the wait: stops are not failures, so no `turn_silent` and no late `first_response`. */
export function forgetSentMessage(threadId: string): void {
  tracker?.pending.delete(threadId);
}

export function noteMessageSent(
  threadId: string,
  message: Omit<SentMessage, "afterSequence" | "sentAt">,
  sentAt = Date.now(),
): void {
  if (!tracker) return;
  const latest = tracker.db
    .select({ sequence: events.sequence })
    .from(events)
    .where(eq(events.threadId, threadId))
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  const lastTurn = tracker.db
    .select({ type: events.type })
    .from(events)
    .where(and(eq(events.threadId, threadId), inArray(events.type, TURN_TYPES)))
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  if (lastTurn?.type === "turn/started") {
    tracker.pending.delete(threadId);
    return;
  }
  const local = tracker.db.select({ model: threads.modelOverride, reasoning: threads.reasoningLevelOverride }).from(threads).where(eq(threads.id, threadId)).get();
  const cloud = message.execution === "local" ? undefined : tracker.db.select({ model: cloudroomThreads.model, reasoning: cloudroomThreads.reasoning }).from(cloudroomThreads).where(eq(cloudroomThreads.threadId, threadId)).get();
  let serviceTier: string | null = null;
  if (cloud) {
    const initial = tracker.db.select({ input: cloudroomCommands.input }).from(cloudroomCommands).where(eq(cloudroomCommands.id, `first_${threadId}`)).get();
    try { serviceTier = initial ? JSON.parse(initial.input).service_tier ?? "default" : null; } catch { serviceTier = null; }
  }
  tracker.pending.set(threadId, { ...message, model: cloud?.model ?? local?.model ?? null, reasoningLevel: cloud?.reasoning ?? local?.reasoning ?? null,
    serviceTier, afterSequence: latest?.sequence ?? 0, sentAt });
}

/** `no_reply`: nothing 10 minutes after the send. `empty`: the turn ended as completed with no output. A thread in
 *  `error` already sent `turn_failed`, and stops are not failures. */
function captureSilent(current: Tracker, threadId: string, sent: SentMessage, reason: "no_reply" | "empty"): void {
  const thread = getThread(current.db, threadId);
  if (!thread || thread.deletedAt !== null || thread.status === "error") return;
  const startedBy = turnStarterAfter(current.db, threadId, sent.afterSequence);
  current.telemetry.capture({
    name: "turn_silent",
    properties: {
      reason,
      ms: Date.now() - sent.sentAt,
      execution: sent.execution,
      is_child_thread: sent.isChildThread,
      message_source: sent.messageSource,
      provider: sent.provider,
      model: sent.model ?? null,
      thread_status: thread.status,
      turn_started: hasEventAfter(current.db, threadId, sent.afterSequence, "turn/started"),
      ...(startedBy ? { started_by: startedBy } : {}),
      ...firstAgentTag(current.db, threadId),
    },
  });
}

function lastTurnStatus(db: DbConnection, threadId: string, afterSequence: number): string | null {
  return db
    .select({ status: sql<string | null>`json_extract(${events.data}, '$.status')` })
    .from(events)
    .where(and(eq(events.threadId, threadId), gt(events.sequence, afterSequence), eq(events.type, "turn/completed")))
    .orderBy(desc(events.sequence))
    .limit(1)
    .get()?.status ?? null;
}

function hasEventAfter(db: DbConnection, threadId: string, afterSequence: number, type: ThreadEventType): boolean {
  return db
    .select({ sequence: events.sequence })
    .from(events)
    .where(and(eq(events.threadId, threadId), gt(events.sequence, afterSequence), eq(events.type, type)))
    .limit(1)
    .get() !== undefined;
}

function environmentProviderOf(db: DbConnection, threadId: string): string | null {
  return db
    .select({ provider: environments.environmentProviderId })
    .from(threads)
    .innerJoin(environments, eq(environments.id, threads.environmentId))
    .where(eq(threads.id, threadId))
    .get()?.provider ?? null;
}

function latestTurnExecution(db: DbConnection, threadId: string): { model: string | null; reasoning: string | null } | undefined {
  return db
    .select({
      model: sql<string | null>`json_extract(${events.data}, '$.execution.model')`,
      reasoning: sql<string | null>`json_extract(${events.data}, '$.execution.reasoningLevel')`,
    })
    .from(events)
    .where(and(eq(events.threadId, threadId), eq(events.type, "client/turn/requested"), sql`json_extract(${events.data}, '$.initiator') = 'user'`))
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
}

function hasOutputAfter(db: DbConnection, threadId: string, afterSequence: number): boolean {
  return db
    .select({ sequence: events.sequence })
    .from(events)
    .where(and(
      eq(events.threadId, threadId),
      gt(events.sequence, afterSequence),
      inArray(events.type, OUTPUT_TYPES),
      or(isNull(events.itemKind), ne(events.itemKind, "userMessage")),
    ))
    .limit(1)
    .get() !== undefined;
}

/** Output beyond an empty reasoning start/close, so an empty thinking block alone does not hide `turn_silent` (`empty`). */
function hasSubstantiveOutputAfter(db: DbConnection, threadId: string, afterSequence: number): boolean {
  return db
    .select({ sequence: events.sequence })
    .from(events)
    .where(and(
      eq(events.threadId, threadId),
      gt(events.sequence, afterSequence),
      inArray(events.type, OUTPUT_TYPES),
      or(isNull(events.itemKind), ne(events.itemKind, "userMessage")),
      or(
        ne(events.itemKind, "reasoning"),
        isNull(events.itemKind),
        and(
          eq(events.type, "item/completed"),
          or(
            sql`json_array_length(json_extract(${events.data}, '$.item.content')) > 0`,
            sql`json_array_length(json_extract(${events.data}, '$.item.summary')) > 0`,
          ),
        ),
      ),
    ))
    .limit(1)
    .get() !== undefined;
}
