import { createHash } from "node:crypto";
import { commandGuardBlockReason } from "@get-bb/plugin-sdk/internal/command-guard";
import { cloudroomCommands, cloudroomThreads, deleteThreadEventSuffixInTransaction, events, threadConversationOutlines, threadSearchSegments, getThread, type DbConnection, type DbQueryConnection, type DbTransaction, type AppendStoredThreadEventArgs } from "@cloudroom/db";
import { and, desc, eq } from "drizzle-orm";
import { appendThreadEventsInTransaction, appendThreadProvisioningEventInTransaction } from "../threads/thread-events.js";
import { LEGACY_CODEX_GOAL_EXTENSION_KIND, THREAD_ACCOUNT_SWITCH_OPERATION, cloudDeltaEvent, cloudItemEvent, codexItemEvent, reasoningLevelSchema, threadEventSchema, threadScope, turnScope, encodeClientTurnRequestIdNumber, type ProvisioningTranscriptEntry, type SystemThreadProvisioningStatus, type ThreadEvent, type ThreadEventTurnStatus } from "@cloudroom/domain";
import { z } from "zod";
import { cloudAccountSwitch } from "./account-switches.js";
import { CloudroomError, type SessionRecord } from "./client.js";
import { codexErrorFields, codexErrorFrameFields } from "./codex-errors.js";
import { binding, command, coreFailure, queuedPrompts, saveBinding, saveCommandState, saveStatus, effectivePrompt, statusOf, unstartedTurn, type Binding, type Command } from "./store.js";

const object = z.record(z.string(), z.unknown());
const nativeFrame = z.object({ method: z.string(), params: object.optional() });
// GUI provider ID → cloud core harness ID.
export const CLOUD_HARNESSES = { codex: "codex", pi: "pi", "claude-code": "claude-code", "acp-cursor": "cursor", "acp-fx": "fx", "acp-opencode": "opencode", "acp-hermes-agent": "hermes", "acp-devin": "devin", "acp-droid": "droid", "acp-kimi": "kimi", "acp-openclaw": "openclaw" } as const;
export type CloudProvider = keyof typeof CLOUD_HARNESSES;
export const isCloudProvider = (id: string | undefined): id is CloudProvider => id !== undefined && Object.hasOwn(CLOUD_HARNESSES, id);
export const HARNESS_NAMES: Record<CloudProvider, string> = { codex: "Codex", pi: "Pi", "claude-code": "Claude Code", "acp-cursor": "Cursor", "acp-fx": "fx", "acp-opencode": "opencode", "acp-hermes-agent": "Hermes Agent", "acp-devin": "Devin", "acp-droid": "Droid", "acp-kimi": "Kimi Code", "acp-openclaw": "OpenClaw" };
export const isAcpProvider = (id: string | undefined): id is Extract<CloudProvider, `acp-${string}`> => isCloudProvider(id) && id.startsWith("acp-");
const FINISHED = ["completed", "failed", "interrupted", "unknown", "unknown_after_restart"];
const turnStatus = (state: string): ThreadEventTurnStatus => state === "completed" ? "completed" : state === "interrupted" ? "interrupted" : "failed";
export function endedTurn(record: SessionRecord): ThreadEventTurnStatus | null {
  const receipt = record.kind === "receipt" ? z.object({ command: z.string(), state: z.string() }).safeParse(record.data) : null;
  if (!receipt?.success || !["prompt", "auto"].includes(receipt.data.command) || !FINISHED.includes(receipt.data.state)) return null;
  return turnStatus(receipt.data.state);
}
// The last error already says this: same title, or a Codex message moved to the start of its detail.
const sameError = (last: { message?: unknown; detail?: unknown }, message: string) => last.message === message || (typeof last.detail === "string" && `${last.detail}\n\n`.startsWith(`${message}\n\n`));
// A lost or failed agent: its stderr tail and Core's diagnostic ID (#949), which finds the exit record.
const exitDetail = (data: Record<string, unknown>) => {
  const detail = [typeof data.stderr === "string" && `Harness stderr (last lines):\n${data.stderr.trimEnd()}`, typeof data.diagnostic_id === "string" && `Cloudroom diagnostic ID: ${data.diagnostic_id}`].filter(Boolean).join("\n\n");
  return detail ? { detail } : {};
};
const bbRequestId = (id: string) => encodeClientTurnRequestIdNumber({ value: createHash("sha256").update(id).digest().readUIntBE(0, 6) });

function messageReasoning(input: string, fallback: string): string {
  try {
    const value = JSON.parse(input).reasoning;
    return reasoningLevelSchema.safeParse(value).success ? value : fallback;
  } catch {
    return fallback;
  }
}

function requestedTurns(db: DbQueryConnection, threadId: string) {
  const found = new Map<string, { id: string; sequence: number }>();
  for (const row of db.select({ id: events.id, data: events.data, sequence: events.sequence }).from(events).where(and(eq(events.threadId, threadId), eq(events.type, "client/turn/requested"))).all()) {
    try {
      const requestId = JSON.parse(row.data).requestId;
      if (typeof requestId === "string") found.set(requestId, { id: row.id, sequence: row.sequence });
    } catch { /* a malformed row cannot match a live cloud request */ }
  }
  return found;
}

function turnStarted(db: DbQueryConnection, threadId: string, turnId: string): boolean {
  return Boolean(db.select({ id: events.id }).from(events).where(and(eq(events.threadId, threadId), eq(events.turnId, turnId), eq(events.type, "turn/started"))).get());
}

const CHILD_NOTICE = /^\[Cloudroom\] Child thread (?:"(.*)" \((\S+)\)|(\S+)) (completed:|was interrupted\.|failed or)/;

function childNotice(db: DbQueryConnection, saved: Binding, request: Command, text: unknown) {
  const match = request.id.startsWith("notice_") && typeof text === "string" ? CHILD_NOTICE.exec(text) : null;
  if (!match) return { initiator: "user" };
  const [, title, titledId, untitledId, state] = match;
  const sessionId = (titledId ?? untitledId)!;
  // A child in a sandbox of its own (ADR 0229) is named by its thread ID.
  const child = sessionId.startsWith("thr_") ? { threadId: sessionId } : db.select({ threadId: cloudroomThreads.threadId }).from(cloudroomThreads)
    .where(and(eq(cloudroomThreads.coreUrl, saved.coreUrl), eq(cloudroomThreads.sessionId, sessionId))).get();
  return {
    initiator: "system",
    systemMessageKind: state === "completed:" ? "child-completed" : state === "failed or" ? "child-failed" : "child-interrupted",
    systemMessageSubject: child ? { kind: "thread", threadId: child.threadId, threadName: title ?? (getThread(db, child.threadId)?.title || sessionId) } : null,
  };
}

// Core's plan-limit error (PLAN_LIMIT in core/src/runtime/mod.rs), and the website loop that resumes after one.
const CORE_PLAN_LIMIT = "plan limit (not Cloudroom's)";
const LIMIT_RESUME = /^\[Cloudroom automation "Resume after .+ plan limit/;

/** A plan-limit continuation after a Cloud account switch (ADR 0117): the limit row then shows the switch in one line
 *  (ADR 20261107-082837). Core sends its own "keep working" only after a switch, even for a limit hit later on the old
 *  login; the website's resume loop counts only when the switch came after the limit. */
function switchContinuation(db: DbQueryConnection, threadId: string, provider: string | undefined, request: Command) {
  const text = effectivePrompt(db, threadId, request.id).text;
  const core = request.id.startsWith("continue_");
  if (!provider || !(core || (typeof text === "string" && LIMIT_RESUME.test(text)))) return null;
  const switched = cloudAccountSwitch(provider);
  const limit = db.select({ data: events.data, createdAt: events.createdAt }).from(events)
    .where(and(eq(events.threadId, threadId), eq(events.type, "system/error"))).orderBy(desc(events.sequence)).limit(1).get();
  if (!switched || !limit?.data.includes(CORE_PLAN_LIMIT) || (!core && limit.createdAt > switched.at)) return null;
  return { provider, from: switched.from, to: switched.to };
}

function promptRequestedEvent(db: DbQueryConnection, saved: Binding, request: Command, steeredTurnId?: string, hidden = false): ThreadEvent {
  const stored = effectivePrompt(db, saved.threadId, request.id);
  const input = Array.isArray(stored.content) ? stored.content : [{ type: "text", text: stored.text ?? "", mentions: [] }];
  const initial = request.id === `first_${saved.threadId}`;
  const sender = typeof stored.sender_thread_id === "string" ? stored.sender_thread_id : null;
  return threadEventSchema.parse({
    type: "client/turn/requested", scope: threadScope(), threadId: saved.threadId,
    direction: "outbound", requestId: bbRequestId(request.id), source: initial ? "spawn" : "tell", ...(sender ? { initiator: "agent" } : childNotice(db, saved, request, stored.text)), senderThreadId: sender,
    input: hidden ? input.map((block: Record<string, unknown>) => ({ ...block, visibility: "agent-only" })) : input,
    target: steeredTurnId ? { kind: "steer", expectedTurnId: steeredTurnId } : { kind: initial ? "thread-start" : "new-turn" },
    request: { method: initial ? "thread/start" : "turn/start", params: {} },
    execution: { source: "client/turn/requested", model: saved.model, reasoningLevel: messageReasoning(JSON.stringify(stored), saved.reasoning), permissionMode: "full", serviceTier: stored.service_tier === "fast" ? "fast" : "default" },
  });
}

function appendPrompt(tx: DbTransaction, saved: Binding, request: Command): void {
  const event = promptRequestedEvent(tx, saved, request);
  appendThreadEventsInTransaction(tx, [{
    threadId: saved.threadId, environmentId: null, providerThreadId: saved.nativeId, createdAt: request.createdAt,
    type: event.type, scope: event.scope, data: event,
  } as AppendStoredThreadEventArgs]);
}

export function projectInitialPrompt(tx: DbTransaction, threadId: string): boolean {
  const saved = binding(tx, threadId);
  const request = command(tx, `first_${threadId}`);
  if (!saved || !request || request.command !== "prompt" || saved.turnId ||
      !(request.state === "sending" || request.state === "accepted" || (request.state === "failed" && !saved.sessionId)) ||
      requestedTurns(tx, threadId).has(bbRequestId(request.id))) return false;
  appendPrompt(tx, saved, request);
  return true;
}

export type StartStep = { key: string; text?: string; status: "started" | "completed" | "failed" };
type StartProgress = { provisioningId: string; status: SystemThreadProvisioningStatus; entries: ProvisioningTranscriptEntry[] };

/** A cloud start writes the same event as a local one, so it gets the same "Provisioning thread" block.
 *  `open` begins a new block; other steps join the latest one, and finished steps show how long they took. */
export function appendStartProgress(tx: DbTransaction, threadId: string, steps: StartStep[], block: "active" | "completed" | "failed" = "active", open = false): boolean {
  const rows = tx.select({ data: events.data }).from(events)
    .where(and(eq(events.threadId, threadId), eq(events.type, "system/thread-provisioning"))).orderBy(events.sequence).all()
    .map((row) => JSON.parse(row.data) as StartProgress);
  const latest = open ? undefined : rows.at(-1);
  if (!open && !latest) return false;
  const provisioningId = latest?.provisioningId ?? `cloud-start:${threadId}:${Date.now()}`;
  const known = new Map(rows.filter((row) => row.provisioningId === provisioningId).flatMap((row) => row.entries).map((entry) => [entry.key, entry]));
  const now = Date.now();
  const unfinished: StartStep[] = block === "failed" ? [...known.values()].filter((entry) => entry.status === "started").map(({ key }) => ({ key, status: "failed" })) : [];
  const entries = [...unfinished, ...steps].flatMap(({ key, text, status }): ProvisioningTranscriptEntry[] => {
    const previous = known.get(key);
    const label = text ?? previous?.text;
    if (!label || (previous?.status === status && previous.text === label)) return [];
    const startedAt = previous?.startedAt ?? now;
    return [{ type: "step", key, text: label, status, startedAt, ...(previous && status !== "started" ? { metadata: { durationMs: now - startedAt } } : {}) }];
  });
  const status = latest?.status === "completed" ? "completed" : block;
  if (!entries.length && latest?.status === status) return false;
  appendThreadProvisioningEventInTransaction(tx, { threadId, environmentId: null, provisioningId, status, entries });
  return true;
}

/** Whether a step of the latest start block still runs, like a fork's code that an app restart cut off. */
export function startStepRunning(db: DbQueryConnection, threadId: string, key: string): boolean {
  const rows = db.select({ data: events.data }).from(events)
    .where(and(eq(events.threadId, threadId), eq(events.type, "system/thread-provisioning"))).orderBy(events.sequence).all()
    .map((row) => JSON.parse(row.data) as StartProgress);
  const latest = rows.at(-1)?.provisioningId;
  return rows.filter((row) => row.provisioningId === latest).flatMap((row) => row.entries).filter((entry) => entry.key === key).at(-1)?.status === "started";
}

export function projectFollowUp(tx: DbTransaction, threadId: string, id: string): boolean {
  const saved = binding(tx, threadId);
  const request = command(tx, id);
  const status = getThread(tx, threadId)?.status;
  if (!saved?.sessionId || saved.queuePaused || request?.command !== "prompt" || (status !== "idle" && status !== "error") || queuedPrompts(tx, threadId).length) return false;
  saveBinding(tx, threadId, { turnId: id, error: null });
  saveStatus(tx, threadId, "active");
  appendPrompt(tx, saved, request);
  return true;
}

export function retractStillQueuedPrompts(db: DbConnection, threadId: string, requestIds: readonly string[]): boolean {
  const wanted = new Set(requestIds.filter(id => id !== `first_${threadId}`).map(bbRequestId));
  const matches = [...requestedTurns(db, threadId)].filter(([id]) => wanted.has(id));
  if (!matches.length) return false;
  db.transaction((tx) => {
    for (const [, row] of matches) {
      tx.delete(events).where(eq(events.id, row.id)).run();
      tx.delete(threadSearchSegments).where(and(eq(threadSearchSegments.threadId, threadId), eq(threadSearchSegments.sourceKey, `event:${row.sequence}`))).run();
    }
    tx.delete(threadConversationOutlines).where(eq(threadConversationOutlines.threadId, threadId)).run();
  });
  return true;
}

export function projectRecord(db: DbConnection, threadId: string, record: SessionRecord, codexOutage = false): ThreadEvent["type"][] {
  return db.transaction((tx) => {
    const saved = binding(tx, threadId);
    if (!saved || record.sequence <= saved.cursor) return [];
    if (record.session_id !== saved.sessionId) throw new Error("Cloudroom session mismatch");
    const data = object.parse(record.data ?? {});
    const harness = getThread(tx, threadId)?.providerId;
    const projected: ThreadEvent[] = [];
    const emit = (event: unknown) => {
      const parsed = threadEventSchema.safeParse(event);
      if (!parsed.success) throw new CloudroomError(`Invalid cloud event fields: ${parsed.error.issues.map((issue) => issue.path.join(".") || issue.message).join(", ")}`);
      projected.push(parsed.data);
    };
    if (["storage_warning", "storage_pause", "storage_recovered"].includes(record.kind)) {
      emit({ type: "system/operation", scope: threadScope(), threadId, operation: record.kind,
        operationId: `cloud-storage:${record.sequence}`, status: "completed", message: z.string().parse(data.text) });
    }
    if (record.kind === "prompt_warning" && saved.nativeId) {
      emit({ type: "provider/warning", scope: threadScope(), threadId, providerThreadId: saved.nativeId, category: "general",
        summary: z.string().parse(data.message), ...(typeof data.detail === "string" ? { details: data.detail } : {}) });
    }
    if (record.kind === "teleport") {
      const imported = z.array(z.object({ request_id: z.string(), input: object, state: z.string() })).parse(data.prompts);
      for (const [index, prompt] of imported.entries()) {
        if (!command(tx, prompt.request_id)) tx.insert(cloudroomCommands).values({ id: prompt.request_id, threadId, command: "prompt", input: JSON.stringify(prompt.input), state: prompt.state, createdAt: (record.timestamp_ms ?? 0) + index }).run();
      }
      if (typeof data.native_id === "string") saveBinding(tx, threadId, { nativeId: data.native_id });
      // A Cloud fork arrives the same way, but it is a new thread, not a moved one.
      if (object.parse(object.parse(data.receipt).input).fork !== true) emit({ type: "system/operation", scope: threadScope(), threadId, operation: "teleport", operationId: `teleport:${record.sequence}`, status: "completed", message: "Conversation continued in cloud; files may still be uploading." });
    }
    if (record.kind === "receipt") {
      const receipt = z.object({ request_id: z.string(), command: z.string(), state: z.string(), error: z.string().optional() }).parse(data);
      const previous = command(tx, receipt.request_id);
      if (!previous && ["prompt", "edit", "cancel", "reorder", "steer"].includes(receipt.command) && data.input) {
        tx.insert(cloudroomCommands).values({ id: receipt.request_id, threadId, command: receipt.command as "prompt" | "edit" | "cancel" | "reorder" | "steer", input: JSON.stringify(data.input), state: receipt.state, createdAt: record.timestamp_ms ?? 0 }).run();
      }
      saveCommandState(tx, threadId, receipt.request_id, receipt.state);
      if (receipt.command === "start" && receipt.state === "accepted" && object.parse(data.input).workspace) saveStatus(tx, threadId, "pending");
      if ((harness === "pi" || isAcpProvider(harness) || harness === "claude-code") && (receipt.command === "auto" || (previous && receipt.command === "prompt")) && FINISHED.includes(receipt.state) && saved.nativeId && turnStarted(tx, threadId, receipt.request_id)) {
        emit({ threadId, providerThreadId: saved.nativeId, scope: turnScope(receipt.request_id), type: "turn/completed", status: turnStatus(receipt.state) });
      }
      const lastError = () => tx.select({ data: events.data }).from(events).where(and(eq(events.threadId, threadId), eq(events.type, "system/error"))).orderBy(desc(events.sequence)).limit(1).get();
      const error = receipt.error ? codexErrorFields(receipt.error, codexOutage) : null;
      if (["failed", "unknown", "unknown_after_restart"].includes(receipt.state) && error && !projected.some((event) => event.type === "system/error" && event.message === error.message) && !sameError(JSON.parse(lastError()?.data ?? "{}"), error.message)) {
        emit({ type: "system/error", scope: threadScope(), threadId, ...error });
      }
      // Codex reports its own compaction; other harnesses only confirm it with this receipt.
      if (receipt.command === "compact" && receipt.state === "completed" && harness !== "codex" && saved.nativeId) {
        const base = { threadId, providerThreadId: saved.nativeId, scope: turnScope(receipt.request_id) };
        emit({ ...base, type: "turn/started" });
        emit({ ...base, type: "thread/compacted" });
        emit({ ...base, type: "turn/completed", status: "completed" });
      }
      if (receipt.state === "accepted" && (receipt.command === "stop" || (receipt.command === "resume" && !(data.input && object.parse(data.input).keep_paused)))) {
        saveBinding(tx, threadId, { queuePaused: receipt.command === "stop" });
        if (receipt.command === "stop" && unstartedTurn(tx, threadId)) saveStatus(tx, threadId, "idle");
      }
      if (receipt.command === "cancel" && ["accepted", "completed"].includes(receipt.state)) {
        const stored = data.input ? object.parse(data.input) : previous ? JSON.parse(previous.input) as { target_request_id?: string } : {};
        if (typeof stored.target_request_id === "string") saveCommandState(tx, threadId, stored.target_request_id, "cancelled");
      }
      if (receipt.command === "steer" && receipt.state === "completed" && previous?.command === "steer" && saved.nativeId && !requestedTurns(tx, threadId).has(bbRequestId(previous.id))) {
        const target = z.object({ target_request_id: z.string() }).parse(JSON.parse(previous.input)).target_request_id;
        emit(promptRequestedEvent(tx, saved, previous, target));
        emit({ threadId, providerThreadId: saved.nativeId, scope: turnScope(target), type: "turn/input/accepted", clientRequestId: bbRequestId(previous.id) });
      }
    }
    if (record.kind === "receipt" && data.command === "rewind" && data.state === "accepted") saveStatus(tx, threadId, "starting");
    if (record.kind === "rewind_failed") saveStatus(tx, threadId, "idle");
    if (record.kind === "native_identity" && typeof data.id === "string") {
      saveBinding(tx, threadId, { nativeId: data.id });
    }
    if (record.kind === "rewind" && typeof data.id === "string") {
      const checkpoints = tx.select({ data: events.data }).from(events).where(and(eq(events.threadId, threadId), eq(events.type, "system/operation"))).all();
      const checkpoint = checkpoints.map((row) => JSON.parse(row.data)).find((event) => event.operation === "checkpoint" && event.metadata?.id === data.before);
      const cutoff = typeof checkpoint?.metadata?.request_id === "string" ? requestedTurns(tx, threadId).get(bbRequestId(checkpoint.metadata.request_id))?.sequence : undefined;
      if (cutoff !== undefined) {
        const last = tx.select({ sequence: events.sequence }).from(events).where(eq(events.threadId, threadId)).orderBy(desc(events.sequence)).get();
        deleteThreadEventSuffixInTransaction(tx, { threadId, cutoffSequence: cutoff, oldMaxSequence: last?.sequence ?? cutoff });
      }
      saveBinding(tx, threadId, { nativeId: data.id, turnId: null });
      if (typeof data.request_id === "string") saveCommandState(tx, threadId, data.request_id, "completed");
      if (data.replacement) {
        const replacement = z.object({ request_id: z.string(), input: object }).parse(data.replacement);
        const rewind = typeof data.request_id === "string" ? command(tx, data.request_id) : null;
        const original = rewind?.command === "rewind" ? JSON.parse(rewind.input).replacement : undefined;
        const input = original?.request_id === replacement.request_id ? original : replacement.input;
        if (!command(tx, replacement.request_id)) tx.insert(cloudroomCommands).values({ id: replacement.request_id, threadId, command: "prompt", input: JSON.stringify(input), state: "accepted", createdAt: record.timestamp_ms ?? 0 }).run();
      }
      if (data.request_id !== `fork_${threadId}`) emit({ type: "system/operation", scope: threadScope(), threadId, operation: "edit_message", status: "completed", message: "Message edited", operationId: String(data.request_id), metadata: { cutoffSequence: cutoff ?? null, replacementProviderThreadId: data.id } });
      emit({ type: "thread/contextWindowUsage/updated", scope: threadScope(), threadId, providerThreadId: data.id, contextWindowUsage: { usedTokens: null, modelContextWindow: null, estimated: false } });
    }
    if (record.kind === "checkpoint" && typeof data.id === "string" && saved.nativeId) {
      emit({
        type: "system/operation", scope: threadScope(), threadId,
        operation: "checkpoint", status: "completed", message: "Native rewind checkpoint",
        operationId: `${threadId}:${data.id}`,
        metadata: { kind: typeof data.kind === "string" ? data.kind : "turn", id: data.id, request_id: typeof data.request_id === "string" ? data.request_id : null },
      });
    }
    if (record.kind === "child" && saved.nativeId && typeof data.id === "string" && typeof data.request_id === "string") {
      const completed = data.state !== "started";
      const result = data.result && typeof data.result === "object" ? object.parse(data.result) : {};
      const child = tx.select({ threadId: cloudroomThreads.threadId }).from(cloudroomThreads).where(and(eq(cloudroomThreads.coreUrl, saved.coreUrl), eq(cloudroomThreads.sessionId, data.id))).get();
      emit({ type: completed ? "item/delegation/completed" : "item/delegation/progress", scope: threadScope(), threadId, providerThreadId: saved.nativeId,
        item: { type: "delegation", id: `child:${data.id}`, childRef: child?.threadId ?? data.id, label: "Cloud child", background: true,
          status: !completed ? "pending" : data.state === "completed" ? "completed" : "failed",
          ...(typeof result.result === "string" ? { summary: result.result } : {}) } });
    }
    if (record.kind === "usage" && saved.nativeId && (data.contextUsage !== undefined || data.used !== undefined || data.usedTokens !== undefined || data.contextWindow !== undefined)) {
      const context = data.contextUsage && typeof data.contextUsage === "object" ? object.parse(data.contextUsage) : data;
      const used = typeof context.tokens === "number" ? context.tokens : typeof context.used === "number" ? context.used : typeof context.usedTokens === "number" ? context.usedTokens : null;
      const total = typeof context.contextWindow === "number" ? context.contextWindow : typeof context.total === "number" ? context.total : typeof context.modelContextWindow === "number" ? context.modelContextWindow : null;
      emit({
        type: "thread/contextWindowUsage/updated",
        scope: threadScope(),
        threadId, providerThreadId: saved.nativeId,
        contextWindowUsage: { usedTokens: used, modelContextWindow: total, estimated: harness === "pi" },
      });
      // Core reads usage after the turn ends, so a follow-up may already own saved.turnId. Credit the last started turn.
      const usageTurn = tx.select({ turnId: events.turnId }).from(events).where(and(eq(events.threadId, threadId), eq(events.type, "turn/started"))).orderBy(desc(events.sequence)).limit(1).get()?.turnId;
      if (data.tokens && data.lastUsage && usageTurn) {
        const totals = object.parse(data.tokens);
        const last = object.parse(data.lastUsage);
        const breakdown = (value: Record<string, unknown>, total: unknown) => ({
          totalTokens: Number(total ?? 0), inputTokens: Number(value.input ?? 0), outputTokens: Number(value.output ?? 0),
          cachedInputTokens: Number(value.cacheRead ?? 0), cacheReadInputTokens: Number(value.cacheRead ?? 0), cacheWriteInputTokens: Number(value.cacheWrite ?? 0), reasoningOutputTokens: 0,
        });
        emit({ type: "thread/tokenUsage/updated", scope: turnScope(usageTurn), threadId, providerThreadId: saved.nativeId,
          tokenUsage: { total: breakdown(totals, totals.total), last: breakdown(last, last.totalTokens), modelContextWindow: total } });
      }
    }
    if (record.kind === "state") {
      const state = z.string().parse(data.state);
      if (state === "starting_turn" && typeof data.request_id === "string") {
        saveBinding(tx, threadId, { turnId: data.request_id });
        const request = command(tx, data.request_id);
        saveCommandState(tx, threadId, data.request_id, "running");
        if (request?.command === "prompt" && !JSON.parse(request.input).teleport_handoff && !requestedTurns(tx, threadId).has(bbRequestId(data.request_id))) {
          const switched = switchContinuation(tx, threadId, harness, request);
          if (switched) emit({ type: "system/operation", scope: threadScope(), threadId, operation: THREAD_ACCOUNT_SWITCH_OPERATION, operationId: `account-switch:${data.request_id}`,
            status: "completed", message: `Continued on ${switched.to}.`, metadata: switched });
          emit(promptRequestedEvent(tx, saved, request, undefined, switched !== null));
        }
        if ((harness === "pi" || isAcpProvider(harness) || harness === "claude-code") && saved.nativeId) {
          const base = { threadId, providerThreadId: saved.nativeId, scope: turnScope(data.request_id) };
          emit({ ...base, type: "turn/started" });
          if (request) emit({ ...base, type: "turn/input/accepted", clientRequestId: bbRequestId(data.request_id) });
        }
      }
      const status = statusOf(state);
      if (status === null) console.warn(`Cloud thread ${threadId}: unknown Core state "${state}"; its status stays as it was.`);
      else {
        const waiting = status !== "error" && status !== "stopping" && !saved.queuePaused && unstartedTurn(tx, threadId);
        saveStatus(tx, threadId, waiting ? "active" : status, status === "error" ? coreFailure(state, data) : undefined);
      }
      if (status === "error") emit({
        type: "system/error", scope: threadScope(), threadId,
        message: typeof data.reason === "string" ? data.reason : "Cloudroom execution failed",
        ...exitDetail(data),
      });
    }
    if (harness === "claude-code" && data.harness === "claude-code" && saved.nativeId && typeof data.request_id === "string" && turnStarted(tx, threadId, data.request_id)) {
      const base = { threadId, providerThreadId: saved.nativeId, scope: turnScope(data.request_id) };
      const id = typeof data.item_id === "string" ? `${data.request_id}:${data.item_id}` : null;
      if (id && ["text_delta", "thinking_delta", "item_started", "item_completed"].includes(record.kind)) {
        const event = cloudDeltaEvent(record.kind, data, base, id) ?? cloudItemEvent(record.kind, data, base, id);
        if (event) emit(event);
      } else if (data.type === "system" && record.native && object.parse(JSON.parse(record.native)).subtype === "compact_boundary" && command(tx, data.request_id)?.command !== "compact") {
        // Claude compacts by itself when the context fills, or for a typed "/compact <focus>". The compact command's receipt records its own.
        emit({ ...base, type: "thread/compacted" });
      }
    }
    const recordTurn = typeof data.request_id === "string" ? data.request_id : saved.turnId;
    if (harness === "pi" && record.native && record.kind !== "native_record" && saved.nativeId && recordTurn && turnStarted(tx, threadId, recordTurn)) {
      const frame = object.parse(JSON.parse(record.native));
      const base = { threadId, providerThreadId: saved.nativeId, scope: turnScope(recordTurn) };
      const latestMessage = () => tx.select({ id: events.itemId }).from(events).where(and(eq(events.threadId, threadId), eq(events.turnId, recordTurn), eq(events.type, "item/started"), eq(events.itemKind, "agentMessage"))).orderBy(desc(events.sequence)).limit(1).get()?.id;
      const contentText = (value: unknown) => {
        const content = object.parse(value).content;
        return Array.isArray(content) ? content.map((part) => { const item = object.parse(part); return item.type === "text" && typeof item.text === "string" ? item.text : ""; }).filter(Boolean).join("\n") : "";
      };
      if (frame.type === "message_start" && object.parse(frame.message).role === "assistant") {
        emit({ ...base, type: "item/started", item: { type: "agentMessage", id: `${recordTurn}:pi:${record.sequence}`, text: "" } });
      } else if (frame.type === "message_update") {
        const update = object.parse(frame.assistantMessageEvent);
        if (["text_delta", "thinking_start", "thinking_delta"].includes(String(update.type))) {
          const id = latestMessage();
          if (!id) throw new CloudroomError("Pi message update has no recorded message start");
          if (update.type === "thinking_start") emit({ ...base, type: "item/started", item: { type: "reasoning", id: `${id}:thinking`, summary: [], content: [] } });
          else emit({ ...base, type: update.type === "text_delta" ? "item/agentMessage/delta" : "item/reasoning/textDelta", itemId: update.type === "text_delta" ? id : `${id}:thinking`, delta: z.string().parse(update.delta) });
        }
      } else if (frame.type === "message_end" && object.parse(frame.message).role === "assistant") {
        const id = latestMessage();
        if (!id) throw new CloudroomError("Pi message completion has no recorded message start");
        const message = object.parse(frame.message);
        emit({ ...base, type: "item/completed", item: { type: "agentMessage", id, text: contentText(message) } });
        const thinking = Array.isArray(message.content) ? message.content.map(part => object.parse(part)).filter(part => part.type === "thinking" && typeof part.thinking === "string").map(part => part.thinking) : [];
        if (thinking.length) emit({ ...base, type: "item/completed", item: { type: "reasoning", id: `${id}:thinking`, summary: [], content: thinking } });
        if (typeof message.errorMessage === "string") emit({ type: "system/error", scope: threadScope(), threadId, message: message.errorMessage });
      } else if (frame.customType === "cloudroom_subagent" || (frame.type === "custom" && frame.customType === "cloudroom_subagent")) {
        let payload: { id?: string; state?: string; result?: string } = {};
        try { payload = JSON.parse(String(frame.content ?? "{}")); } catch { payload = {}; }
        if (typeof payload.id === "string") {
          emit({
            ...base,
            type: payload.state === "completed" ? "item/completed" : "item/started",
            item: {
              type: "delegation",
              id: `${recordTurn}:${payload.id}`,
              childRef: payload.id,
              label: "child",
              status: payload.state === "completed" ? "completed" : "pending",
              background: false,
              ...(typeof payload.result === "string" ? { summary: payload.result } : {}),
            },
          });
        }
      } else if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(String(frame.type))) {
        const id = `${recordTurn}:${z.string().parse(frame.toolCallId)}`;
        if (frame.type === "tool_execution_update") emit({ ...base, type: "item/toolCall/progress", itemId: id, message: contentText(frame.partialResult) });
        else emit({ ...base, type: frame.type === "tool_execution_start" ? "item/started" : "item/completed", item: {
          type: "toolCall", id, tool: z.string().parse(frame.toolName), status: frame.type === "tool_execution_start" ? "pending" : frame.isError ? "failed" : "completed",
          ...(frame.args ? { arguments: object.parse(frame.args) } : {}), ...(frame.result ? { result: frame.result } : {}),
        } });
      } else if (frame.type === "compaction_end" && frame.reason !== "manual" && frame.aborted !== true && !frame.errorMessage) {
        // Pi compacts by itself near or over the context limit. The compact command's receipt records a manual one.
        emit({ ...base, type: "thread/compacted" });
      }
    }
    if (isAcpProvider(harness) && saved.nativeId && recordTurn && data.harness === CLOUD_HARNESSES[harness] && turnStarted(tx, threadId, recordTurn)) {
      const base = { threadId, providerThreadId: saved.nativeId, scope: turnScope(recordTurn) };
      const itemId = `${recordTurn}:${String(data.item_id)}`;
      const event = cloudDeltaEvent(record.kind, data, base, itemId) ?? cloudItemEvent(record.kind, data, base, itemId);
      if (event) emit(event);
      else if (record.kind === "warning") emit({ ...base, type: "provider/warning", category: "general", summary: z.string().parse(data.message) });
    }
    if (harness === "codex" && record.native && record.kind !== "native_record") {
      const parsed = nativeFrame.safeParse(JSON.parse(record.native));
      if (parsed.success && saved.nativeId && saved.turnId) {
        const { method, params = {} } = parsed.data;
        const late = method !== "turn/started" && method !== "error" && !method.startsWith("thread/goal/") && !turnStarted(tx, threadId, saved.turnId);
        if ((!params.threadId || params.threadId === saved.nativeId) && !late) {
          const base = { threadId, providerThreadId: saved.nativeId, scope: turnScope(saved.turnId) };
          const itemId = (id: unknown) => `${saved.turnId}:${z.string().parse(id)}`;
          if (method === "turn/started") {
            emit({ ...base, type: method });
            const request = command(tx, saved.turnId);
            if (request?.command === "prompt") {
              emit({ ...base, type: "turn/input/accepted", clientRequestId: bbRequestId(request.id) });
            }
          } else if (method === "turn/completed") {
            const turn = object.parse(params.turn);
            emit({ ...base, type: method, status: turn.status, ...(turn.error ? { error: turn.error } : {}) });
          } else if (["item/started", "item/completed"].includes(method)) {
            const native = object.parse(params.item);
            if (native.type === "subAgentActivity" || native.type === "collabAgentToolCall") {
              const childRef = String(native.agentThreadId ?? (Array.isArray(native.receiverThreadIds) ? native.receiverThreadIds[0] : "") ?? "");
              if (childRef) {
                emit({
                  ...base,
                  type: method === "item/started" ? "item/started" : "item/completed",
                  item: {
                    type: "delegation",
                    id: itemId(native.id),
                    childRef,
                    label: String(native.agentPath ?? native.tool ?? "child"),
                    status: method === "item/started" ? "pending" : "completed",
                    background: native.type === "subAgentActivity",
                  },
                });
              }
            } else {
              const event = codexItemEvent(method, params, base, itemId);
              if (event) emit(event);
            }
          } else if (method.startsWith("item/")) {
            const event = codexItemEvent(method, params, base, itemId);
            if (event) emit(event);
          } else if (method === "thread/compacted") {
            emit({ ...base, type: "thread/compacted" });
          } else if (method === "thread/goal/updated" || method === "thread/goal/cleared") {
            // The same goal card as Local threads (ADR 0137).
            const goal = method === "thread/goal/updated" ? object.parse(params.goal) : null;
            emit({
              threadId, providerThreadId: saved.nativeId, scope: threadScope(), type: "thread/extensionState/updated", kind: LEGACY_CODEX_GOAL_EXTENSION_KIND,
              payload: goal && { objective: goal.objective, status: goal.status, tokenBudget: goal.tokenBudget ?? null, tokensUsed: goal.tokensUsed, timeUsedSeconds: goal.timeUsedSeconds },
            });
          } else if (method === "hook/completed") {
            const reason = commandGuardBlockReason(params);
            if (reason) emit({ ...base, type: "provider/warning", category: "general", summary: reason });
          } else if (method === "error") {
            const error = object.parse(params.error);
            // Like Local, a started turn owns its errors (#949): a turn that recovers folds its retries into its work, and
            // a failed one ends on its error card, not on a stale Reconnecting row.
            const scope = turnStarted(tx, threadId, saved.turnId) ? base.scope : threadScope();
            emit({ type: "system/error", scope, threadId, ...codexErrorFrameFields(z.string().parse(error.message), error, params.willRetry, codexOutage) });
          }
        }
      }
    }
    appendThreadEventsInTransaction(tx, projected.map((event) => ({
      threadId, environmentId: null, providerThreadId: saved.nativeId, createdAt: record.timestamp_ms,
      type: event.type, scope: event.scope, data: event,
    } as AppendStoredThreadEventArgs)));
    saveBinding(tx, threadId, { cursor: record.sequence, error: null });
    return projected.map((event) => event.type);
  });
}
