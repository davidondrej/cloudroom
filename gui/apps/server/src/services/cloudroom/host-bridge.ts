// Single adapter isolating Cloudroom's server logic from host thread/plugin/system internals.
// No other module in the Cloudroom command stack may import from ../threads/, ../plugins/, or ../system/.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq, gt, isNull, max, notInArray, sql } from "drizzle-orm";
import {
  createThread,
  events,
  findLastCompletedRootStoredTurn,
  getAppSettings,
  getProject,
  getThread,
  getThreadExecutionOverride,
  pinThread,
  setThreadExecutionOverride,
  threads,
  updateThread,
  type DbQueryConnection,
  type DbTransaction,
} from "@cloudroom/db";
import type { PromptInput, ReasoningLevel, Thread, ThreadChangeKind, ThreadEventTurnStatus, ThreadEventType } from "@cloudroom/domain";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import type { AppDeps, LoggedWorkSessionDeps } from "../../types.js";
import { createKeyedLock } from "../lib/async-deduper.js";
import { cloudTurnsElsewhere, emitPluginThreadCreated } from "../plugins/plugin-thread-events.js";
import { pruneThreadEventHistory } from "../system/event-pruning.js";
import { firstAgentThreadId } from "../system/first-agent.js";
import type { createThreadFromRequest } from "../threads/thread-create.js";
import {
  cloudPluginInstructions,
  cloudroomSystemPrompt,
  dueCustomInstructions,
  markCustomInstructionsLost,
  prepareCloudInstructionInput,
  resolveCustomInstructions,
} from "../threads/custom-instructions.js";
import { getLeadingAgentOnlyInput, resolveDeferredFirstTurnContext } from "../threads/deferred-first-turn-context.js";
import { buildSuggestedBranchName } from "../threads/thread-create-helpers.js";
import { getLastThreadOutput } from "../threads/thread-data.js";
import { appendClientTurnEvent, getLastExecutionOptions } from "../threads/thread-events.js";
import { copyForkSourceHistory } from "../threads/thread-fork-history.js";
import { inferThreadMetadata, queueThreadTitle } from "../threads/thread-metadata-inference.js";
import { assertValidParentThread, isParentNotifiableChildThread } from "../threads/thread-parent.js";
import { buildThreadStatusChangeMetadata } from "../threads/thread-runtime-display.js";
import { deriveTitleFallback, shouldGenerateThreadTitle } from "../threads/title-generation.js";
import { cloudPromptLimit, hashedRequestId } from "./protocol.js";
import { binding, type Command } from "./store.js";

export type CloudHostDeps = Pick<AppDeps, "db" | "hub" | "config" | "providerRegistry">
  & Partial<LoggedWorkSessionDeps>
  & Partial<Pick<AppDeps, "pendingInteractions">>;

export interface HostHooks {
  teleportRecovery?: () => void;
  /** Main's archive of a thread and its idle children; `websiteHasIt`: the website already has this thread archived. */
  archiveRequest?: (threadId: string, liveThreadIds?: string[], websiteHasIt?: boolean) => void;
  childTurnEnded?: (child: Thread & { parentThreadId: string }, status: ThreadEventTurnStatus) => void;
  moveRequest?: (threadId: string, project: string) => void;
}

export { createKeyedLock };

/** Threads made by importing old chats. They are not agents the user started (ADR 20261102-073449). */
export const importedThreadIds = async (deps: Pick<AppDeps, "config">): Promise<string[]> => [
  ...new Set(
    (
      await Promise.all(
        ["session-imports.json", "bb-imports.json"].map((name) =>
          readFile(join(deps.config.dataDir, name), "utf8").then(
            (text) => Object.values(JSON.parse(text) as Record<string, string>),
            () => [],
          ),
        ),
      )
    ).flat(),
  ),
];

export class CloudHostBridge {
  readonly hooks: HostHooks = {};
  /** Threads whose change being applied came from Core or the website, so it isn't sent back. */
  private readonly quiet = new Set<string>();
  private recent: { at: number; local: number; cloud: number } | null = null;

  constructor(readonly deps: CloudHostDeps) {}

  get db() { return this.deps.db; }
  get config() { return this.deps.config; }
  get logger() { return this.deps.logger; }

  /** Background sandbox work never blocks the user, but its failures must reach the log. */
  warn(message: string, error: unknown, fields: Record<string, unknown> = {}): void {
    this.deps.logger?.warn({ ...fields, error: error instanceof Error ? error.message : String(error) }, message);
  }

  getThread(threadId: string, db: DbQueryConnection = this.deps.db) { return getThread(db, threadId); }
  getProject(projectId: string) { return getProject(this.deps.db, projectId); }
  getAppSettings() { return getAppSettings(this.deps.db); }
  getExecutionOverride(threadId: string) { return getThreadExecutionOverride(this.deps.db, threadId); }

  setExecutionOverride(input: Parameters<typeof setThreadExecutionOverride>[1], db: DbQueryConnection = this.deps.db) {
    return setThreadExecutionOverride(db, input);
  }

  createThread(tx: DbTransaction, input: Parameters<typeof createThread>[2]) {
    return createThread(tx, this.deps.hub, input);
  }

  updateThread(db: DbQueryConnection, threadId: string, patch: Parameters<typeof updateThread>[3]) {
    return updateThread(db, this.deps.hub, threadId, patch);
  }

  pinThread(threadId: string) {
    return pinThread(this.deps.db, this.deps.hub, { threadId });
  }

  onThreadWatched(listener: (threadId: string) => void): () => void {
    return this.deps.hub.onThreadWatched(listener);
  }

  /** Whether any of the thread's history is shown here yet. */
  hasShownEvents(threadId: string): boolean {
    return Boolean(this.deps.db.select({ id: events.id }).from(events).where(eq(events.threadId, threadId)).limit(1).get());
  }

  hasCompletedRootTurn(threadId: string): boolean {
    return Boolean(findLastCompletedRootStoredTurn(this.deps.db, { threadId }));
  }

  lastCloudUpdatedAt(): number | null {
    return this.deps.db.select({ updated: max(threads.updatedAt) }).from(threads).where(eq(threads.executionTarget, "cloud")).get()?.updated ?? null;
  }

  findRunningChild(parentId: string) {
    return this.deps.db.select({ id: threads.id }).from(threads).where(and(
      eq(threads.parentThreadId, parentId),
      isNull(threads.archivedAt),
      isNull(threads.deletedAt),
      notInArray(threads.status, ["idle", "error"]),
    )).get();
  }

  /** Threads the user started in the last 30 days, by where they run: it tells who mostly uses Local (ADR 20261111-222458).
   *  Imports, subagents, hidden threads, and plugin runs don't count. Counted at most every 5 minutes. */
  async recentThreads(): Promise<{ local: number; cloud: number }> {
    if (!this.recent || Date.now() - this.recent.at >= 5 * 60_000) {
      // The first agent is a thread Cloudroom started, not the user (ADR 20261111-220912).
      const skipped = [...await importedThreadIds(this.deps), firstAgentThreadId(this.deps.db) ?? []].flat();
      const rows = this.deps.db.select({ target: threads.executionTarget, n: sql<number>`count(*)` }).from(threads)
        .where(and(
          isNull(threads.parentThreadId),
          isNull(threads.originPluginId),
          eq(threads.visibility, "visible"),
          gt(threads.createdAt, Date.now() - 30 * 86_400_000),
          skipped.length ? notInArray(threads.id, skipped) : undefined,
        ))
        .groupBy(threads.executionTarget).all();
      const count = (target: "local" | "cloud") => rows.find((row) => row.target === target)?.n ?? 0;
      this.recent = { at: Date.now(), local: count("local"), cloud: count("cloud") };
    }
    return { local: this.recent.local, cloud: this.recent.cloud };
  }

  nativeRewindBefore(threadId: string, expectedRequestSequence?: number): string | undefined {
    const row = this.deps.db.select({ data: events.data }).from(events)
      .where(and(eq(events.threadId, threadId), eq(events.type, "client/turn/requested"), expectedRequestSequence === undefined ? undefined : eq(events.sequence, expectedRequestSequence)))
      .orderBy(desc(events.sequence)).get();
    if (!row) throw new ApiError(409, "invalid_request", "The selected message is no longer available");
    const requestId = JSON.parse(row.data).requestId;
    if (typeof requestId !== "string") throw new ApiError(409, "invalid_request", "The selected message is not an editable user turn");
    const checkpoints = this.deps.db.select({ data: events.data }).from(events)
      .where(and(eq(events.threadId, threadId), eq(events.type, "system/operation"))).all();
    for (const checkpoint of checkpoints.reverse()) {
      try {
        const data = JSON.parse(checkpoint.data) as { operation?: string; metadata?: { id?: string; request_id?: string | null } };
        if (data.operation !== "checkpoint" || typeof data.metadata?.id !== "string" || typeof data.metadata.request_id !== "string") continue;
        if (hashedRequestId(data.metadata.request_id) === requestId) return data.metadata.id;
      } catch { /* ignore malformed checkpoint rows */ }
    }
    throw new ApiError(409, "invalid_request", "A native rewind checkpoint is not available for this message");
  }

  quietly<T>(threadId: string | null, apply: () => T): T {
    const key = threadId ?? "*", held = this.quiet.has(key);
    this.quiet.add(key);
    try { return apply(); } finally { if (!held) this.quiet.delete(key); }
  }

  onThreadChanged(handler: (threadId: string, changes: readonly ThreadChangeKind[]) => void): void {
    this.deps.hub.onThreadChanged((threadId, changes) => {
      if (this.quiet.has(threadId) || this.quiet.has("*")) return;
      handler(threadId, changes);
    });
  }

  watching(threadId: string): boolean { return this.deps.hub.watching(threadId); }

  notifyThread(threadId: string, changes: ThreadChangeKind[], meta?: Record<string, unknown>): void {
    this.deps.hub.notifyThread(threadId, changes, meta);
  }

  notifyStatus(threadId: string, eventTypes: ThreadEventType[], stateChanged: boolean, queueChanged: boolean): void {
    const thread = getThread(this.deps.db, threadId);
    if (!thread) return;
    const changes: ThreadChangeKind[] = [
      ...(eventTypes.length ? ["events-appended" as const] : []),
      ...(stateChanged ? ["status-changed" as const] : []),
      ...(stateChanged && queueChanged ? ["queue-changed" as const] : []),
    ];
    if (!changes.length) return;
    this.deps.hub.notifyThread(threadId, changes, {
      ...(stateChanged ? buildThreadStatusChangeMetadata(this.deps, thread) : {}),
      ...(eventTypes.length ? { eventTypes } : {}),
    });
  }

  async waitUntil(threadId: string, done: () => boolean, ms: number): Promise<boolean> {
    for (const deadline = Date.now() + ms; !done();) {
      if (deadline <= Date.now()) return false;
      const waiter = this.deps.hub.registerThreadEventWaiter(threadId, deadline - Date.now());
      if (done()) waiter.cancel();
      else await waiter.promise;
    }
    return true;
  }

  pruneEvents(mode: "idle" | "archived", threadId: string): void {
    pruneThreadEventHistory(this.deps, { mode, threadId });
  }

  emitThreadCreated(thread: Thread): void { emitPluginThreadCreated(thread); }

  markTurnElsewhere(threadId: string, elsewhere: boolean): void {
    if (elsewhere) cloudTurnsElsewhere.add(threadId);
    else cloudTurnsElsewhere.delete(threadId);
  }

  buildSystemPrompt(threadId: string, projectId: string, vps: boolean, projectNote?: string): string | undefined {
    return [
      cloudroomSystemPrompt(this.deps.db, "cloud", { vps }),
      cloudPluginInstructions({ threadId, projectId }),
      projectNote,
    ].filter(Boolean).join("\n\n") || undefined;
  }

  prepareInstructionInput(prompt: { text: string; content?: unknown }, customInstructions: string, limit: number) {
    return prepareCloudInstructionInput(prompt, customInstructions, limit);
  }

  snapshotInstructions(db: DbQueryConnection, thread: Pick<Thread, "id" | "projectId" | "providerId">, action: Command["command"], input: object): object {
    if (!["prompt", "edit", "steer", "rewind"].includes(action)) return input;
    const prompt = z.object({ text: z.string(), content: z.unknown().optional() }).parse(
      action === "rewind" && "replacement" in input ? input.replacement : input,
    );
    const context = { threadId: thread.id, projectId: thread.projectId, experimental_execution: { providerId: thread.providerId, model: binding(db, thread.id)?.model ?? null } };
    // Checked with the instructions even when this message won't carry them. The core's real limit is checked again on send.
    prepareCloudInstructionInput(prompt, resolveCustomInstructions(context), cloudPromptLimit(null));
    // An edit replaces a queued message and a rewind drops later ones, either of which may have carried them.
    return { ...input, customInstructions: dueCustomInstructions(db, context, action === "edit" || action === "rewind") };
  }

  markInstructionsLost(db: DbQueryConnection, threadId: string): void { markCustomInstructionsLost(db, threadId); }

  assertValidParent(parentThreadId: string, cloudChild: boolean): void {
    assertValidParentThread(this.deps, { parentThreadId, cloudChild });
  }

  isParentNotifiableChild(thread: Thread): thread is Thread & { parentThreadId: string } {
    return isParentNotifiableChildThread(thread);
  }

  deriveTitleFallback(input: PromptInput[]) { return deriveTitleFallback(input); }
  shouldGenerateTitle(input: PromptInput[]) { return shouldGenerateThreadTitle(input); }
  queueTitle(tx: DbTransaction, threadId: string, input: PromptInput[]) { queueThreadTitle(tx, threadId, input); }
  suggestedBranchName(title: string | null, threadId: string) { return buildSuggestedBranchName({ branchPrefix: "room/", title, threadId }); }
  getLastOutput(threadId: string) { return getLastThreadOutput(this.deps.db, threadId); }
  getLastExecutionOptions(threadId: string) { return getLastExecutionOptions(this.deps, threadId); }
  leadingAgentOnlyInput(content: PromptInput[]) { return getLeadingAgentOnlyInput(content); }
  deferredFirstTurnContext(thread: Thread) { return resolveDeferredFirstTurnContext(this.deps.db, thread); }

  copyForkHistory(fork: Thread, sourceThreadId: string, endSequence: number): void {
    copyForkSourceHistory(this.deps, { fork, history: { kind: "thread", sourceThreadId, endSequence } });
  }

  seedSideChatTurn(args: { threadId: string; senderThreadId: string; input: PromptInput[]; model: string; reasoningLevel: ReasoningLevel }): void {
    appendClientTurnEvent(this.deps, {
      type: "client/turn/requested",
      threadId: args.threadId,
      environmentId: null,
      input: args.input,
      initiator: "agent",
      senderThreadId: args.senderThreadId,
      requestMethod: "thread/start",
      source: "spawn",
      target: { kind: "thread-start" },
      execution: {
        source: "client/turn/requested",
        model: args.model,
        reasoningLevel: args.reasoningLevel,
        permissionMode: "full",
        serviceTier: "default",
      },
    });
  }

  canInferMetadata(): boolean { return Boolean(this.deps.logger && this.deps.aiServices); }

  inferMetadata(args: { input: PromptInput[]; provisioningId: string; threadId: string }): Promise<unknown> {
    return inferThreadMetadata(this.deps as LoggedWorkSessionDeps, { ...args, writeTranscript: false });
  }

  async createAgentForkThread(request: Parameters<typeof createThreadFromRequest>[1]): Promise<Thread> {
    const { createThreadFromRequest } = await import("../threads/thread-create.js");
    return createThreadFromRequest(this.deps as Parameters<typeof createThreadFromRequest>[0], request);
  }
}
