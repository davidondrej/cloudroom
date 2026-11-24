import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { cloudroomCommands, cloudroomThreads, type DbTransaction } from "@cloudroom/db";
import { defaultReasoningLevel, PERSONAL_PROJECT_ID, reasoningLevelSchema, reconcileReasoningLevel, type ReasoningLevel, type Thread } from "@cloudroom/domain";
import type { CreateThreadRequest, ForkThreadRequest } from "@cloudroom/server-contract";
import { ApiError } from "../../errors.js";
import { CloudroomClient, CloudroomConnectionError, CloudroomError } from "./client.js";
import type { CloudChildren } from "./children.js";
import { appendStartProgress, CLOUD_HARNESSES, HARNESS_NAMES, isCloudProvider, projectInitialPrompt, type CloudProvider } from "./events.js";
import { cloudForkPoint, FORK_HARNESSES, localForkPoint } from "./fork.js";
import { copyKey, localProjectNote, planProjectCopy, workspaceId, workspaceName } from "./project-copy.js";
import {
  assertThreadOwner,
  cloudPromptLimit,
  cloudStep,
  coreModel,
  feature,
  harnessProfile,
  promptPayload,
  publicError,
  reasoningLevels,
  roomIds,
  ROOT_WORKSPACE,
  takesNoEffort,
  validateReasoning,
  WEBSITE_CHILD,
  WORKING,
  type Capabilities,
} from "./protocol.js";
import type { CloudRuntime } from "./runtime.js";
import { SANDBOX_PREFIX, SandboxAsleep, sandboxThread } from "./sandboxes.js";
import { binding, command, commands, coreInUse, isDead, saveBinding, saveCommandState, saveStatus, statusOf, teleportBlocked, type Binding, type Command } from "./store.js";
import { importCodexLogin } from "./sync.js";
import type { CloudTransfers } from "./transfers.js";

export interface LifecycleHooks {
  start: () => void;
  deliver: (threadId: string) => Promise<void>;
  follow: (saved: Binding, client: CloudroomClient) => void;
  readHistory: (threadId: string, again?: boolean) => Promise<void>;
  enqueue: (threadId: string, id: string, action: Command["command"], input: object, at?: number) => void;
  currentReasoning: (threadId: string, saved: Binding) => string;
  keyFields: (source: string | undefined) => Promise<{ key_source?: string; no_env?: true }>;
  copyPiSetup: (client: CloudroomClient, sandbox: boolean) => Promise<void>;
}

/** Manages Cloud thread lifecycle: archive, restore, delete, forks, side chats, harness switch, and project move. */
export class CloudLifecycle {
  private readonly archiveLanes = [Promise.resolve(), Promise.resolve(), Promise.resolve()];
  private archiveLane = 0;
  private archiving: Promise<void> = Promise.resolve();

  constructor(
    private readonly rt: CloudRuntime,
    private readonly children: CloudChildren,
    private readonly transfers: CloudTransfers,
    private readonly hooks: LifecycleHooks,
  ) {}

  /** Archived here, or on the website (by another computer, its parent or its agent): the stream stops, maybe behind
   *  (#1687), so a turn shown running ends, and the rest of its own sandbox's session is shown from the website's saved
   *  history, where Core saves a child's last turn before its report reaches the parent (#1410). Never woken or acted on. */
  archived(threadId: string): void {
    // Only a turn still shown running is behind: one shown ended (idle, error) was seen to its end here.
    const status = this.rt.host.getThread(threadId)?.status, behind = status === "active" || status === "stopping";
    this.rt.detach(threadId);
    if (behind) saveStatus(this.rt.host.db, threadId, "idle");
    const saved = binding(this.rt.host.db, threadId), sandbox = saved && sandboxThread(saved.coreUrl);
    // An archive here or from the list ends an Undo still pending: no later wake sends its restore (#2246).
    if (sandbox && this.rt.peek(sandbox)?.undo === threadId) this.rt.peek(sandbox)!.undo = undefined;
    if (!behind || !saved?.cursor || sandbox !== threadId) return;
    // At most 3 reads at once, so archiving many threads never sends a burst to the website.
    const lane = this.archiveLane++ % this.archiveLanes.length;
    this.archiveLanes[lane] = this.archiveLanes[lane]!.then(() => this.hooks.readHistory(threadId, true)).then(() => {
      try { this.rt.host.pruneEvents("archived", threadId); }
      catch (error) { this.rt.host.warn("An archived Cloud thread's streamed pieces could not be cleared", error, { threadId }); }
    });
  }

  archive(threadId: string): void {
    const entry = this.rt.peek(threadId);
    if (entry) entry.refusedSince = undefined;
    const saved = binding(this.rt.host.db, threadId);
    if (!saved) return;
    const sandbox = sandboxThread(saved.coreUrl);
    if (sandbox) {
      // Archive always wins (ADR 0112): the website stops the sandbox even mid-task, once no other thread runs in it.
      this.archived(threadId);
      const archivedAt = this.rt.host.getThread(threadId)?.archivedAt;
      if (archivedAt == null) return;
      const stillArchived = () => this.rt.host.getThread(threadId)?.archivedAt === archivedAt;
      for (const pending of commands(this.rt.host.db, threadId, "sending")) {
        if (pending.command === "unarchive_session") saveCommandState(this.rt.host.db, threadId, pending.id, "cancelled");
      }
      const last = !coreInUse(this.rt.host.db, saved.coreUrl);
      const session = saved.sessionId;
      if (!last && session) {
        const stop = randomUUID(), sleep = randomUUID();
        this.hooks.enqueue(threadId, stop, "stop", { archivedAt });
        this.hooks.enqueue(threadId, sleep, "sleep", { archivedAt });
        // Let the synchronous family archive finish first. Individual stop retries never hold up the whole sandbox.
        void Promise.resolve().then(() => this.stopArchived(threadId, session, stop, sleep, archivedAt))
          .catch((error) => this.rt.host.warn("The archived thread's agent could not be stopped", error, { threadId }));
      }
      void this.rt.inArchiveOrder(sandbox, async () => {
        await this.rt.requireOwnThread(saved);
        if (!stillArchived()) return;
        const effects: Promise<unknown>[] = [];
        if (last && !coreInUse(this.rt.host.db, saved.coreUrl)) {
          effects.push(this.rt.sandboxes.archive(sandbox).then(() => this.rt.sync.archivedOnWebsite(sandbox, true))
            .catch((error) => this.rt.host.warn("The thread's sandbox could not be archived; it sleeps on its own", error, { threadId })));
        } else if (sandbox !== threadId && session) {
          effects.push(this.archiveShared(saved, true));
        }
        if (session) {
          effects.push(this.rt.sandboxes.automations({ action: "archived", thread: sandbox, session })
            .catch((error) => this.rt.host.warn("The thread's cloud automations could not be paused", error, { threadId })));
        }
        await Promise.all(effects);
      }).catch((error) => this.rt.host.warn("Cloud archive failed", error, { threadId }));
      return;
    }
    this.hooks.enqueue(threadId, randomUUID(), "stop", {});
    this.hooks.enqueue(threadId, randomUUID(), "sleep", {});
    void this.hooks.deliver(threadId).catch(() => {});
  }

  /** Sends an archived thread's saved stop and sleep straight to its Core, without following its stream. An asleep
   *  sandbox runs nothing, so it is never woken for this. Unsent ones are dropped, so an unarchived thread never gets them. */
  private async stopArchived(threadId: string, sessionId: string, stop: string, sleep: string, archivedAt: number): Promise<void> {
    try {
      const saved = binding(this.rt.host.db, threadId);
      if (!saved) return;
      const sandbox = sandboxThread(saved.coreUrl)!;
      const needed = () => this.rt.host.getThread(threadId)?.archivedAt === archivedAt && coreInUse(this.rt.host.db, saved.coreUrl);
      for (let tries = 1; ; tries++) {
        try {
          await this.rt.inArchiveOrder(sandbox, async () => {
            if (!needed()) return;
            const client = await this.rt.client(saved, false);
            for (const [id, action] of [[stop, "stop"], [sleep, "sleep"]] as const) {
              if (!needed()) return;
              if (command(this.rt.host.db, id)?.state !== "sending") continue;
              const receipt = (await client[action](sessionId, id)).receipt;
              saveCommandState(this.rt.host.db, threadId, id, receipt.state);
              if (action === "stop") saveBinding(this.rt.host.db, threadId, { queuePaused: true });
            }
          });
          return;
        } catch (error) {
          if (error instanceof SandboxAsleep || !needed()) return;
          if (!(error instanceof CloudroomConnectionError) || tries >= 3) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    } finally {
      for (const id of [stop, sleep]) if (command(this.rt.host.db, id)?.state === "sending") saveCommandState(this.rt.host.db, threadId, id, "failed");
    }
  }

  /** A shared child's archive lives in Core, so every computer sees it (#237). An asleep sandbox isn't woken for it. */
  private async archiveShared(saved: Binding, archived: boolean): Promise<void> {
    if (!saved.sessionId) return;
    try {
      const client = await this.rt.client(saved, false);
      if (feature(await this.rt.capabilities(client), "cloud_threads")) await client.archiveSession(saved.sessionId, randomUUID(), archived);
    } catch (error) {
      if (!(error instanceof SandboxAsleep)) this.rt.host.warn("A shared child's archive could not be saved in Cloud", error, { threadId: saved.threadId });
    }
  }

  /** Restores the sandbox the thread runs in, which may be another thread's: an unarchived child keeps its parent's.
   *  `retry`: a wake sends a pending Undo's restore again, only while it is still pending. */
  async restore(threadId: string, retry = false): Promise<void> {
    const saved = binding(this.rt.host.db, threadId), sandbox = sandboxThread(saved?.coreUrl ?? "");
    if (!saved || !sandbox) return;
    const shared = sandbox !== threadId && saved.sessionId;
    const sending = commands(this.rt.host.db, threadId, "sending");
    if (shared && !retry && !sending.some((c) => c.command === "unarchive_session" && JSON.parse(c.input).session === shared)) {
      this.hooks.enqueue(threadId, randomUUID(), "unarchive_session", { session: shared });
    }
    for (const pending of retry ? [] : sending) {
      if ((pending.command === "stop" || pending.command === "sleep") && JSON.parse(pending.input).archivedAt != null) {
        saveCommandState(this.rt.host.db, threadId, pending.id, "cancelled");
      }
    }
    // The website lists the thread archived until it takes this, up to ~90 s after a fresh archive.
    const restore = { at: Infinity }, entry = this.rt.state(sandbox), before = entry.restore;
    entry.restore = restore;
    if (!retry) entry.undo = threadId;
    let skipped = false;
    try {
      await this.rt.inArchiveOrder(sandbox, async () => {
        // Naming the session resumes only the loops its archive paused (#237).
        await this.rt.requireOwnThread(saved);
        if (this.rt.host.getThread(threadId)?.archivedAt !== null) return;
        // A retry checks under the lock: another wake's retry may have landed while it waited.
        if (retry && this.rt.peek(sandbox)?.undo !== threadId) { skipped = true; return; }
        await this.rt.sandboxes.restore(sandbox, saved.sessionId ?? undefined);
        await this.rt.sync.archivedOnWebsite(sandbox, false);
        if (this.rt.peek(sandbox)?.undo === threadId) this.rt.peek(sandbox)!.undo = undefined;
      });
      // A skipped retry sent nothing: the list keeps the restore that did land, not this one.
      if (skipped) { if (this.rt.peek(sandbox)?.restore === restore) this.rt.peek(sandbox)!.restore = before; return; }
      restore.at = Date.now();
      if (shared) void this.hooks.deliver(threadId).catch((error) => this.rt.host.warn("Shared thread restore will retry", error, { threadId }));
    } catch (error) {
      if (this.rt.peek(sandbox)?.restore === restore) this.rt.peek(sandbox)!.restore = undefined;
      throw error;
    }
  }

  /** A user's archive record can replay after Undo. Read current state in order with our own
   *  archive writes, and leave a restore queued during the read in charge. */
  currentUserArchive(saved: Binding, client: CloudroomClient, sessionId: string, signal: AbortSignal): Promise<Thread | null> {
    return this.rt.inArchiveOrder(sandboxThread(saved.coreUrl) ?? saved.threadId, async () => {
      if (signal.aborted || !(await client.isSessionArchived(sessionId, signal))) return null;
      const thread = this.rt.host.getThread(saved.threadId);
      if (!thread || thread.archivedAt !== null || thread.deletedAt !== null) return null;
      return commands(this.rt.host.db, thread.id, "sending").some((c) => c.command === "unarchive_session") ? null : thread;
    });
  }

  /** Delete: the website erases the thread's own sandbox, snapshots, saved copy, and chat history. Children share it. */
  remove(threadId: string): void {
    const entry = this.rt.peek(threadId);
    if (entry) entry.refusedSince = undefined;
    const saved = binding(this.rt.host.db, threadId);
    if (!saved) return;
    this.rt.detach(threadId);
    this.rt.threadStates.set(threadId, null);
    void this.rt.sync.deletedHere(threadId);
    const sandbox = sandboxThread(saved.coreUrl);
    if (sandbox === threadId) {
      void this.rt.sandboxes.remove(sandbox).catch((error) => this.rt.host.warn("The thread's sandbox could not be deleted; it sleeps on its own", error, { threadId }));
    }
  }

  /** Archives a deleted project's Cloud threads on the website one after another, a second apart, not in one burst.
   *  Their sandboxes and sessions are read now: the delete removes the threads' records here meanwhile. */
  archiveInTurn(threadIds: string[]): void {
    const own = threadIds.flatMap((id) => {
      const saved = binding(this.rt.host.db, id);
      return saved && sandboxThread(saved.coreUrl) === id ? [{ id, session: saved.sessionId }] : [];
    });
    for (const id of threadIds) if (!own.some((item) => item.id === id)) this.archive(id);
    for (const { id } of own) this.rt.detach(id);
    this.archiving = this.archiving.then(async () => {
      for (const { id, session } of own) {
        await this.rt.sandboxes.archive(id).catch((error: unknown) => this.rt.host.warn("A deleted project's Cloud thread could not be archived", error, { threadId: id }));
        if (session) await this.rt.sandboxes.automations({ action: "archived", thread: id, session }).catch((error: unknown) => this.rt.host.warn("The thread's cloud automations could not be paused", error, { threadId: id }));
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    });
  }

  /** A project deleted here: its new-thread Cloud loops, homed under this computer's ID for it, pause (#1673), never
   *  deleted. Archiving its threads pauses only same-thread loops, so these kept running with nothing to run in. */
  async pauseProjectLoops(projectId: string): Promise<void> {
    try {
      const listed = z.object({
        automations: z.array(z.object({ id: z.string(), enabled: z.boolean(), new_thread: z.boolean().optional(), project_id: z.string().nullable().optional() }).passthrough()),
      }).safeParse(await this.rt.sandboxes.automations({ action: "list" }));
      if (!listed.success) return;
      for (const loop of listed.data.automations) {
        if (loop.enabled && loop.new_thread === true && loop.project_id === projectId) {
          await this.rt.sandboxes.automations({ action: "update", id: loop.id, enabled: false });
        }
      }
    } catch (error) {
      this.rt.host.warn("A deleted project's Cloud loops could not be paused", error, { projectId });
    }
  }

  /** Which of these Cloud threads Core says are working now (#237, App 8): one cached idle here may run on another
   *  computer. One session list per awake sandbox, which holds its own session and the ones sharing it; an asleep
   *  sandbox runs nothing and is never woken for this. */
  async runningInCloud(threadIds: string[], signal: AbortSignal): Promise<string[] | null> {
    const bySandbox = new Map<string, Binding[]>();
    for (const id of threadIds) {
      const saved = binding(this.rt.host.db, id);
      const sandbox = saved && sandboxThread(saved.coreUrl);
      if (!sandbox || !saved?.sessionId) continue;
      const group = bySandbox.get(sandbox);
      if (group) group.push(saved);
      else bySandbox.set(sandbox, [saved]);
    }
    if (!bySandbox.size) return [];
    try {
      const awake = await this.rt.sandboxes.awakeForArchive(signal);
      for (const group of bySandbox.values()) for (const saved of group) assertThreadOwner(saved.accountId, awake.accountId);
      const running: string[] = [];
      let complete = true;
      await Promise.all([...bySandbox].map(async ([sandbox, group]) => {
        const connection = awake.connections.get(sandbox);
        if (!connection) return;
        try {
          const listed = await new CloudroomClient(connection).listSessions(awake.signal);
          const sessions = new Map(listed.sessions.map((session) => [session.session_id, session]));
          for (const saved of group) {
            const session = sessions.get(saved.sessionId!);
            if (!session) { if (listed.total > listed.sessions.length) complete = false; continue; }
            const waking = session.state === "resuming" && !session.current_request && !session.queued;
            if (!waking && (session.current_request || WORKING.includes(session.state))) running.push(saved.threadId);
          }
        } catch { complete = false; }
      }));
      if (awake.signal.aborted && !signal.aborted) throw new ApiError(409, "cloudroom_other_account", "The Cloudroom account changed. Try again.");
      return complete || running.length > 0 ? running : null;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof CloudroomError && (error.status === 401 || error.status === 403)) {
        throw new ApiError(error.status, "cloudroom_archive_forbidden", "Sign in to the account that owns this thread.");
      }
      return null;
    }
  }

  /** A Cloud fork (fork.ts): the source's harness and model in a new sandbox, with the history up to the fork point. */
  async createFork(request: CreateThreadRequest, sourceId: string): Promise<Thread> {
    const source = this.rt.host.getThread(sourceId);
    const saved = binding(this.rt.host.db, sourceId);
    if (!source || source.archivedAt || source.deletedAt || (source.executionTarget === "cloud" ? !saved?.sessionId : !source.environmentId)) {
      throw new ApiError(409, "fork_source_unavailable", "Only a started, unarchived thread can be forked.");
    }
    if (!FORK_HARNESSES.includes(source.providerId)) throw new ApiError(400, "cloudroom_unsupported", "Cloud forks support Claude Code and Codex.");
    const last = saved ? null : this.rt.host.getLastExecutionOptions(source.id);
    const model = saved?.model ?? last?.model;
    if (!model) throw new ApiError(409, "fork_source_unavailable", "The source thread has no model to fork with yet.");
    if ((request.providerId && request.providerId !== source.providerId) || (request.model && request.model !== model)) {
      throw new ApiError(400, "cloudroom_unsupported", "A Cloud fork keeps its source's harness and model.");
    }
    if (request.sendAt || request.pluginSubmission) throw new ApiError(400, "cloudroom_unsupported", "Cloud forks can't be scheduled.");
    const startRequestId = request.requestId ?? randomUUID();
    const previous = this.rt.host.db.select().from(cloudroomThreads).where(eq(cloudroomThreads.startRequestId, startRequestId)).get();
    if (previous) return this.rt.host.getThread(previous.threadId)!;
    if (!(await this.rt.newThreadsInSandboxes())) throw new ApiError(409, "cloudroom_unsupported", "Cloud forks need cloud sandboxes.");
    const capabilities = await this.rt.savedCapabilities();
    if (capabilities && !capabilities.fork) throw new ApiError(409, "cloudroom_update", "Update the cloud core to fork Cloud threads.");
    const keys = await this.hooks.keyFields(source.id);
    const fork = saved ? await cloudForkPoint(this.rt.host.deps, source, request.sourceSeqEnd) : localForkPoint(this.rt.host.deps, source, request.sourceSeqEnd);
    const project = this.rt.host.getProject(source.projectId);
    if (!project) throw new ApiError(404, "project_not_found", "Project not found");
    const profile = capabilities ? harnessProfile(capabilities, source.providerId) : null;
    const payload = promptPayload(request.input, source.providerId, capabilities?.attachments === false ? false : profile?.attachments ?? true, cloudPromptLimit(capabilities));
    const reasoning = request.reasoningLevel ?? (saved ? this.hooks.currentReasoning(source.id, saved) : last?.reasoningLevel ?? "none");
    const workspace = project.id === PERSONAL_PROJECT_ID ? { workspace: ROOT_WORKSPACE } : { workspace: workspaceId(project.id), workspace_name: workspaceName(project.name) };
    const projectNote = project.id === PERSONAL_PROJECT_ID ? undefined : await localProjectNote(this.rt.host.deps, project.id);
    const thread = this.rt.host.db.transaction((tx) => {
      const created = this.rt.host.createThread(tx, {
        executionTarget: "cloud", projectId: source.projectId, providerId: source.providerId, status: "pending", originKind: "fork", sourceThreadId: source.id,
        title: request.title, titleFallback: this.rt.host.deriveTitleFallback(request.input), sectionId: request.sectionId, visibility: request.visibility,
      });
      tx.insert(cloudroomThreads).values({ threadId: created.id, coreUrl: SANDBOX_PREFIX + created.id, startRequestId, model, reasoning }).run();
      tx.insert(cloudroomCommands).values({
        id: `first_${created.id}`, threadId: created.id, command: "prompt",
        input: JSON.stringify(this.rt.host.snapshotInstructions(tx, created, "prompt", {
          ...payload, ...workspace, fork, ...keys,
          command_guard_enabled: this.rt.host.getAppSettings().commandGuardEnabled,
          strip_ai_co_authors: this.rt.host.getAppSettings().stripAiCoAuthorsEnabled,
          system_prompt: this.rt.host.buildSystemPrompt(created.id, created.projectId, this.rt.sandboxes.vpsConnected, projectNote),
          ...(request.serviceTier && request.serviceTier !== "default" ? { service_tier: request.serviceTier } : {}),
          ...(this.children.isHeldStart(startRequestId) ? { awaiting_core: true } : {}),
        })),
        createdAt: Date.now(),
      }).run();
      this.rt.host.queueTitle(tx, created.id, request.input);
      if (!request.title && this.rt.host.shouldGenerateTitle(request.input)) {
        tx.insert(cloudroomCommands).values({ id: `title_${created.id}`, threadId: created.id, command: "title", input: JSON.stringify({ input: request.input }), createdAt: Date.now() }).run();
      }
      return created;
    });
    // The inherited history goes first, so the fork's first message shows after it.
    this.rt.host.copyForkHistory(thread, source.id, fork.end_sequence);
    this.rt.host.db.transaction((tx) => {
      projectInitialPrompt(tx, thread.id);
      appendStartProgress(tx, thread.id, [cloudStep(true)], "active", true);
    });
    this.rt.notify(thread.id, ["client/turn/requested", "system/thread-provisioning"]);
    this.hooks.start();
    void this.hooks.deliver(thread.id).catch(() => {});
    return this.rt.host.getThread(thread.id)!;
  }

  /** A fresh side chat starts lazily on its first message so any harness or model can be picked first. */
  async sideChat(source: Thread, request: ForkThreadRequest): Promise<Thread> {
    const saved = binding(this.rt.host.db, source.id);
    if (!saved?.sessionId || source.archivedAt || source.deletedAt) throw new ApiError(409, "fork_source_unavailable", "Only a started, unarchived Cloud thread can have a side chat.");
    if (!request.fresh) return this.copiedSideChat(source, request);
    const providerId = request.providerId ?? source.providerId;
    if (!isCloudProvider(providerId)) throw new ApiError(400, "cloudroom_unsupported", "This agent can't run in Cloud.");
    await this.rt.requireOwnThread(saved);
    const known = sandboxThread(saved.coreUrl) ? await this.rt.savedCapabilities() : this.rt.lastCapabilities;
    const sameProvider = providerId === source.providerId;
    const model = request.model ?? (sameProvider ? saved.model : (known ? harnessProfile(known, providerId)?.model : undefined) ?? "");
    if (!model) throw new ApiError(400, "model_required", `Select a ${HARNESS_NAMES[providerId]} model.`);
    const levels = known ? reasoningLevels(providerId, model, known) as ReasoningLevel[] | undefined : undefined;
    const fallback = sameProvider ? saved.reasoning : (takesNoEffort(known, providerId, model) ? "none" : defaultReasoningLevel(undefined));
    const reasoning = request.reasoningLevel ?? (levels?.length ? reconcileReasoningLevel(fallback as ReasoningLevel, levels) : fallback);
    const thread = this.rt.host.db.transaction((tx) => {
      const created = this.sideChatThread(tx, source, request, providerId, "idle");
      tx.insert(cloudroomThreads).values({ threadId: created.id, coreUrl: saved.coreUrl, startRequestId: randomUUID(), model, reasoning }).run();
      tx.insert(cloudroomCommands).values({ id: `first_${created.id}`, threadId: created.id, command: "side_chat", state: "completed", input: JSON.stringify({ side_chat: saved.sessionId }), createdAt: Date.now() }).run();
      return created;
    });
    this.seedSideChat(thread.id, source.id, request, model, reasoning);
    this.rt.notify(thread.id);
    this.hooks.start();
    return this.rt.host.getThread(thread.id)!;
  }

  private sideChatThread(tx: DbTransaction, source: Thread, request: ForkThreadRequest, providerId = source.providerId, status: Thread["status"] = "starting") {
    return this.rt.host.createThread(tx, {
      executionTarget: "cloud", projectId: source.projectId, providerId, status, originKind: "fork", sourceThreadId: source.id,
      title: request.title ?? null, titleFallback: source.title ?? source.titleFallback, visibility: request.visibility, originPluginId: request.originPluginId,
      pluginMetadata: request.pluginMetadata && request.originPluginId ? { pluginId: request.originPluginId, metadata: request.pluginMetadata } : null,
    });
  }

  private seedSideChat(threadId: string, sourceId: string, request: ForkThreadRequest, model: string, reasoning: string): void {
    if (request.agentContextSeed) {
      this.rt.host.seedSideChatTurn({ threadId, senderThreadId: sourceId, input: request.agentContextSeed, model, reasoningLevel: reasoningLevelSchema.parse(reasoning) });
    }
  }

  /** A side chat on a sandbox whose Core predates fresh ones (ADR 0189): a copy of the conversation. */
  private async copiedSideChat(source: Thread, request: ForkThreadRequest): Promise<Thread> {
    const saved = binding(this.rt.host.db, source.id)!;
    const providerId = source.providerId;
    if (!isCloudProvider(providerId) || !FORK_HARNESSES.includes(providerId) || !saved.sessionId) {
      throw new ApiError(409, "cloudroom_update", "This Cloud thread's sandbox runs an older Cloudroom version. Side chats for this agent work after its next restart.");
    }
    const client = await this.rt.client(saved);
    const capabilities = await this.rt.capabilities(client);
    if (!capabilities.side_chat) throw new ApiError(409, "cloudroom_update", "This Cloud thread's sandbox runs an older Cloudroom version. Side chats work after its next restart.");
    const { end_sequence, before, through, last_turn_id } = await cloudForkPoint(this.rt.host.deps, source, request.sourceSeqEnd);
    const startRequestId = randomUUID();
    let sessionId: string;
    try {
      sessionId = (await client.start(startRequestId, CLOUD_HARNESSES[providerId], { fork: { session: saved.sessionId, before, through, last_turn_id } })).session_id;
    } catch (error) {
      throw new ApiError(error instanceof CloudroomError && error.status === 409 ? 409 : 503, "cloudroom_fork_rejected", publicError(error));
    }
    const thread = this.rt.host.db.transaction((tx) => {
      const created = this.sideChatThread(tx, source, request);
      tx.insert(cloudroomThreads).values({ threadId: created.id, coreUrl: saved.coreUrl, sessionId, startRequestId, model: saved.model, reasoning: saved.reasoning }).run();
      return created;
    });
    this.rt.host.copyForkHistory(thread, source.id, end_sequence);
    this.seedSideChat(thread.id, source.id, request, saved.model, saved.reasoning);
    this.hooks.follow(binding(this.rt.host.db, thread.id)!, client);
    return this.rt.host.getThread(thread.id)!;
  }

  /** Starts a fresh side chat on any harness in its source's folder; falls back to direct `start` on older Cores. */
  async startSideChat(client: CloudroomClient, threadId: string, saved: Binding, capabilities: Capabilities, harness: CloudProvider, sourceSessionId: string) {
    if (!harnessProfile(capabilities, harness)) throw new ApiError(400, "cloudroom_unsupported", `${HARNESS_NAMES[harness]} isn't set up in Cloud yet.`);
    const thread = this.rt.host.getThread(threadId);
    const source = thread?.sourceThreadId ? this.rt.host.getThread(thread.sourceThreadId) : null;
    const sourceSaved = source ? binding(this.rt.host.db, source.id) : null;
    const liveSource = sourceSaved?.sessionId ?? sourceSessionId;
    const { model, provider } = coreModel(harness, saved.model, capabilities);
    const current = this.hooks.currentReasoning(threadId, saved);
    const levels = reasoningLevels(harness, model, capabilities) as ReasoningLevel[] | undefined;
    const reasoning = levels?.length ? reconcileReasoningLevel(current as ReasoningLevel, levels) : current;
    const ids = roomIds(capabilities, threadId, thread?.projectId);
    const direct = async () => {
      const from = await client.session(liveSource).catch(() => liveSource !== sourceSessionId ? client.session(sourceSessionId).catch(() => null) : null);
      const start = from ? Object.values(from.receipts).find((r) => r.command === "start") : undefined;
      const startInput = start ? z.object({ command_guard_enabled: z.boolean().nullish(), strip_ai_co_authors: z.boolean().nullish(), system_prompt: z.string().nullish() }).passthrough().parse(start.input) : null;
      const project = thread ? this.rt.host.getProject(thread.projectId) : null;
      const workspace = start?.workspace
        ? (start.workspace.id !== "legacy" ? { workspace: start.workspace.id } : start.workspace.path === capabilities.repository ? {} : { workspace: ROOT_WORKSPACE })
        : project?.id === PERSONAL_PROJECT_ID ? { workspace: ROOT_WORKSPACE } : project ? { workspace: workspaceId(project.id), workspace_name: workspaceName(project.name) } : {};
      return client.start(saved.startRequestId, CLOUD_HARNESSES[harness], {
        model, reasoning, ...(provider ? { provider } : {}), ...workspace, ...ids,
        ...(capabilities.command_guard && typeof startInput?.command_guard_enabled === "boolean" ? { command_guard_enabled: startInput.command_guard_enabled } : {}),
        ...(capabilities.strip_ai_co_authors && typeof startInput?.strip_ai_co_authors === "boolean" ? { strip_ai_co_authors: startInput.strip_ai_co_authors } : {}),
        ...(capabilities.system_prompt && startInput?.system_prompt ? { system_prompt: startInput.system_prompt } : {}),
      });
    };
    const sameAsSource = source?.providerId === harness && sourceSaved?.model === saved.model && sourceSaved?.reasoning === reasoning;
    const accepted = capabilities.side_chat_any_harness
      ? await client.start(saved.startRequestId, CLOUD_HARNESSES[harness], { fork: { session: liveSource, fresh: true }, model, reasoning, ...(provider ? { provider } : {}), ...ids })
          .catch((error: unknown) => error instanceof CloudroomError && [400, 409, 422].includes(error.status ?? 0) ? direct() : Promise.reject(error))
      : capabilities.side_chat_fresh && sameAsSource
        ? await client.start(saved.startRequestId, CLOUD_HARNESSES[harness], { fork: { session: liveSource, fresh: true } })
            .catch((error: unknown) => error instanceof CloudroomError && [400, 409, 422].includes(error.status ?? 0) ? direct() : Promise.reject(error))
        : await direct();
    return { sessionId: accepted.session_id, transfer: `child_${saved.startRequestId}`, code: null };
  }

  /** ADR 0211: a new Core session in the old session's folder. Unstarted side chats switch right in SQLite. */
  async switchHarness(thread: Thread, target: { providerId: string; model: string; reasoningLevel: ReasoningLevel | null }, prepare: (seed: boolean) => Promise<(tx: DbTransaction) => void>): Promise<void> {
    const saved = binding(this.rt.host.db, thread.id);
    const initial = command(this.rt.host.db, `first_${thread.id}`);
    if (saved && !saved.sessionId && initial?.command === "side_chat") {
      await this.switchUnstartedSideChat(thread, saved, initial, target);
      return;
    }
    await this.restartSession(thread, { ...target, refusal: "Agents started by another agent keep their agent." }, prepare, (tx, started) => {
      this.rt.host.updateThread(tx, thread.id, { providerId: target.providerId });
      saveBinding(tx, thread.id, { ...started, model: target.model, cursor: 0, nativeId: null, turnId: null, error: null });
      this.rt.host.setExecutionOverride({ threadId: thread.id, modelOverride: null, reasoningLevelOverride: reasoningLevelSchema.safeParse(started.reasoning).data ?? null }, tx);
    });
  }

  private async switchUnstartedSideChat(thread: Thread, saved: Binding, initial: Command, target: { providerId: string; model: string; reasoningLevel: ReasoningLevel | null }): Promise<void> {
    const entry = this.rt.state(thread.id);
    if (entry.switching || entry.activeSends > 0) throw new ApiError(409, "thread_busy", "Wait until the message is sent, then switch.");
    entry.switching = true;
    try {
      await this.rt.requireOwnThread(saved);
      if (teleportBlocked(this.rt.host.db, thread.id)) throw new ApiError(409, "teleport_in_progress", "Wait for Teleport to finish, then switch.");
      if (!isCloudProvider(target.providerId)) throw new ApiError(400, "cloudroom_unsupported", "This agent can't run in Cloud.");
      const known = sandboxThread(saved.coreUrl) ? await this.rt.savedCapabilities() : this.rt.lastCapabilities;
      const profile = known ? harnessProfile(known, target.providerId) : null;
      if (known && !profile) throw new ApiError(400, "cloudroom_unsupported", `${HARNESS_NAMES[target.providerId]} isn't set up in Cloud yet.`);
      const remote = known ? coreModel(target.providerId, target.model, known) : null;
      const current = this.hooks.currentReasoning(thread.id, saved);
      const levels = known && remote ? reasoningLevels(target.providerId, remote.model, known) as ReasoningLevel[] | undefined : undefined;
      const reasoning = target.reasoningLevel ?? (levels?.length ? reconcileReasoningLevel(current as ReasoningLevel, levels) : current);
      if (known && remote && !(sandboxThread(saved.coreUrl) && (profile?.models === null || target.providerId === "acp-opencode"))) validateReasoning(target.providerId, remote.model, reasoning, known);
      this.rt.host.db.transaction((tx) => {
        if (binding(tx, thread.id)?.sessionId) throw new ApiError(409, "thread_busy", "The agent started while switching. Try again.");
        this.rt.host.updateThread(tx, thread.id, { providerId: target.providerId });
        saveBinding(tx, thread.id, { model: target.model, reasoning, error: null, ...(initial.state === "failed" ? { startRequestId: randomUUID() } : {}) });
        if (initial.state === "failed") { saveCommandState(tx, thread.id, initial.id, "completed"); saveStatus(tx, thread.id, "idle"); }
        this.rt.host.setExecutionOverride({ threadId: thread.id, modelOverride: null, reasoningLevelOverride: reasoningLevelSchema.safeParse(reasoning).data ?? null }, tx);
      });
      this.rt.notify(thread.id);
    } finally { entry.switching = false; }
  }

  /** ADR 0281: a new Core session in the new project's folder, in the same sandbox. The old folder stays as it is. */
  async moveProject(thread: Thread, projectId: string, prepare: (seed: boolean) => Promise<(tx: DbTransaction) => void>): Promise<string | null> {
    const saved = binding(this.rt.host.db, thread.id);
    const project = this.rt.host.getProject(projectId);
    if (!saved || !project) throw new ApiError(404, "project_not_found", "Project not found");
    const workspace = project.id === PERSONAL_PROJECT_ID ? { workspace: ROOT_WORKSPACE } : { workspace: workspaceId(project.id), workspace_name: workspaceName(project.name) };
    const client = await this.rt.client(saved);
    const previousPath = saved.sessionId ? await client.sessionWorkspace(saved.sessionId).then(({ path }) => path, () => null) : null;
    const continued = await this.restartSession(thread, { providerId: thread.providerId, model: saved.model, reasoningLevel: null, workspace, projectId: project.id, refusal: "Agents started by another agent stay in its project." }, prepare, (tx, started) => {
      this.rt.host.updateThread(tx, thread.id, { projectId: project.id });
      saveBinding(tx, thread.id, { ...started, cursor: 0, nativeId: null, turnId: null, error: null });
      const first = command(tx, `first_${thread.id}`);
      if (first) tx.update(cloudroomCommands).set({ input: JSON.stringify({ ...JSON.parse(first.input), ...workspace, base_branch: undefined }) }).where(eq(cloudroomCommands.id, first.id)).run();
    });
    // Core's switch moved the row's session and agent; the project is this computer's change.
    if (continued) this.children.syncLabel(thread.id, "project");
    if (workspace.workspace === ROOT_WORKSPACE) return previousPath;
    const moved = binding(this.rt.host.db, thread.id)!;
    const sandbox = sandboxThread(moved.coreUrl);
    const job = await planProjectCopy(this.rt.host.deps, client, thread.id, workspace.workspace, { key: copyKey(sandbox, workspace.workspace) });
    if (job) this.transfers.copyInto(client, job, () => void this.transfers.ensureBranch(thread.id, true));
    else void this.transfers.ensureBranch(thread.id, true);
    return previousPath;
  }

  /** True when Core switched the conversation itself (`continue_from`, #237): it builds the history, moves the row and
   *  its loops, and closes the old session. Older Cores start a new session here, and the app sends its own history. */
  private async restartSession(
    thread: Thread,
    target: { providerId: string; model: string; reasoningLevel: ReasoningLevel | null; workspace?: { workspace: string; workspace_name?: string }; projectId?: string; refusal: string },
    prepare: (seed: boolean) => Promise<(tx: DbTransaction) => void>,
    apply: (tx: DbTransaction, started: { sessionId: string; startRequestId: string; reasoning: string }) => void,
  ): Promise<boolean> {
    const continues = { value: false, done: false };
    const entry = this.rt.state(thread.id);
    if (entry.switching || entry.activeSends > 0) throw new ApiError(409, "thread_busy", "Wait until the message is sent, then switch.");
    entry.switching = true;
    try {
      const saved = binding(this.rt.host.db, thread.id);
      if (!saved?.sessionId) throw new ApiError(409, "cloudroom_not_started", "Wait for the cloud agent to start, then switch.");
      await this.rt.requireOwnThread(saved);
      if (teleportBlocked(this.rt.host.db, thread.id)) throw new ApiError(409, "teleport_in_progress", "Wait for Teleport to finish, then switch.");
      if (!isCloudProvider(target.providerId)) throw new ApiError(400, "cloudroom_unsupported", "This agent can't run in Cloud.");
      const oldSession = saved.sessionId;
      const resumeLoops = await this.requireNoSessionDependents(thread.id, saved);
      const client = await this.rt.client(saved);
      const capabilities = await this.rt.capabilities(client);
      if (!harnessProfile(capabilities, target.providerId)) throw new ApiError(400, "cloudroom_unsupported", `${HARNESS_NAMES[target.providerId]} isn't set up in Cloud yet.`);
      const { model, provider } = coreModel(target.providerId, target.model, capabilities);
      const current = this.hooks.currentReasoning(thread.id, saved);
      const levels = reasoningLevels(target.providerId, model, capabilities) as ReasoningLevel[] | undefined;
      const reasoning = target.reasoningLevel ?? (levels?.length ? reconcileReasoningLevel(current as ReasoningLevel, levels) : current);
      validateReasoning(target.providerId, model, reasoning, capabilities);
      const before = await this.quietSession(client, saved);
      const start = Object.values(before.receipts).find((receipt) => receipt.command === "start");
      if (!start?.workspace) throw new ApiError(409, "cloudroom_switch", "This thread's cloud folder is unknown, so it can't switch.");
      const startInput = z.object({ parent_session: z.string().nullish(), parent_thread: z.string().nullish(), command_guard_enabled: z.boolean().nullish(), strip_ai_co_authors: z.boolean().nullish(), system_prompt: z.string().nullish() }).passthrough().parse(start.input);
      if (startInput.parent_session) throw new ApiError(409, "cloudroom_switch", target.refusal);
      const workspace = target.workspace ?? (start.workspace.id !== "legacy" ? { workspace: start.workspace.id } : start.workspace.path === capabilities.repository ? {} : { workspace: ROOT_WORKSPACE });
      if (target.providerId === "codex" && capabilities.codex_auth_import && !sandboxThread(saved.coreUrl)) await importCodexLogin(this.rt.host.deps);
      if (target.providerId === "pi") await this.hooks.copyPiSetup(client, Boolean(sandboxThread(saved.coreUrl)));
      const sharedSandbox = Boolean(sandboxThread(saved.coreUrl) && sandboxThread(saved.coreUrl) !== thread.id);
      continues.value = !sharedSandbox && feature(capabilities, "cloud_threads");
      const record = await prepare(!continues.value);
      // A child the website started stays one, so its Core alone reports its turns, as before the switch (#1579).
      const startRequestId = `${saved.startRequestId?.startsWith(WEBSITE_CHILD) ? WEBSITE_CHILD : ""}${randomUUID()}`;
      const saveSwitch = (session: string) => {
        this.rt.detach(thread.id);
        this.rt.host.db.transaction((tx) => {
          apply(tx, { sessionId: session, startRequestId, reasoning });
          record(tx);
          // The new session's copied chat leaves out agent-only text, so it has no custom instructions yet.
          this.rt.host.markInstructionsLost(tx, thread.id);
        });
        // Switched here: the new session's records are this computer's to act on, and the list never takes it back.
        const known = this.rt.threadStates.get(thread.id);
        this.rt.threadStates.set(thread.id, { home: null, from: null, ...known, session, actFrom: 0, before: [oldSession, ...known?.before ?? []].slice(0, 5) });
      };
      const ids = roomIds(capabilities, thread.id, target.projectId ?? thread.projectId);
      if (continues.value) {
        const started = await client.continueSession(startRequestId, CLOUD_HARNESSES[target.providerId], oldSession, { model, reasoning, ...(provider ? { provider } : {}), ...workspace, ...ids }).catch((error: unknown) => {
          throw new ApiError(error instanceof CloudroomError && error.status === 409 ? 409 : 503, "cloudroom_switch", `${HARNESS_NAMES[target.providerId as CloudProvider]} couldn't take over in Cloud, so this thread wasn't changed. ${publicError(error)}`);
        });
        if (started.pending) throw new ApiError(409, "cloudroom_switch_pending", "The switch is still finishing in Cloud. This thread shows the new agent once it's done.");
        // Core saved the new agent on the website, so the change goes nowhere from here.
        this.rt.quietly(thread.id, () => saveSwitch(started.session_id));
        continues.done = true;
        return true;
      }
      const started = await client.start(startRequestId, CLOUD_HARNESSES[target.providerId], {
        model, reasoning, ...(provider ? { provider } : {}), ...workspace,
        ...(capabilities.command_guard && typeof startInput.command_guard_enabled === "boolean" ? { command_guard_enabled: startInput.command_guard_enabled } : {}),
        ...(capabilities.strip_ai_co_authors && typeof startInput.strip_ai_co_authors === "boolean" ? { strip_ai_co_authors: startInput.strip_ai_co_authors } : {}),
        ...(capabilities.system_prompt && startInput.system_prompt ? { system_prompt: startInput.system_prompt } : {}),
        ...(startInput.parent_thread ? { parent_thread: startInput.parent_thread } : {}),
        ...ids,
      });
      const failure = await this.startFailure(client, started.session_id);
      if (failure) {
        void client.close(started.session_id, randomUUID()).catch(() => {});
        throw new ApiError(409, "cloudroom_switch", `${HARNESS_NAMES[target.providerId]} couldn't start in Cloud, so this thread wasn't changed. ${failure}`);
      }
      const after = await client.session(oldSession).catch(() => null);
      if (after?.last_sequence !== before.last_sequence || !["idle", "error"].includes(this.rt.host.getThread(thread.id)?.status ?? "")) {
        void client.close(started.session_id, randomUUID()).catch(() => {});
        throw new ApiError(409, "thread_busy", "The agent got a new message while switching. Try again.");
      }
      saveSwitch(started.session_id);
      // A website that follows threads takes a new session only from Core, or from this older label after Core's list.
      this.children.syncLabel(thread.id, "switch");
      void client.close(oldSession, randomUUID()).catch((error: unknown) => this.rt.host.warn("The previous Cloud session could not be closed", error, { threadId: thread.id }));
      for (const id of resumeLoops) void this.rt.sandboxes.automations({ action: "delete", id }).catch((error: unknown) => this.rt.host.warn("The old session's resume loop could not be deleted", error, { threadId: thread.id }));
    } finally {
      entry.switching = false;
      if (continues.done) {
        this.rt.notify(thread.id);
        void this.hooks.deliver(thread.id).catch(() => {});
      }
    }
    this.rt.notify(thread.id);
    void this.hooks.deliver(thread.id).catch(() => {});
    return false;
  }

  async startFailure(client: CloudroomClient, sessionId: string, requireReady = false): Promise<string | null> {
    const signal = AbortSignal.timeout(30_000);
    while (!signal.aborted) {
      const session = await client.session(sessionId, signal).catch(() => null);
      if (session?.state === "idle" || (session && Object.values(session.receipts).some((r) => r.command === "start" && r.state === "completed"))) return null;
      if (session && isDead(session.state)) {
        const receipt = Object.values(session.receipts).find((r) => r.command === "start" && r.error);
        if (receipt?.error) return receipt.error;
        const reasons = (await client.events(sessionId).catch(() => [])).map((record) => record.kind === "state" ? z.object({ reason: z.string() }).safeParse(record.data).data?.reason : undefined);
        return reasons.filter(Boolean).at(-1) ?? `The new agent stopped (${session.state}).`;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (requireReady) throw new CloudroomError("Antigravity is still starting.", 409, "session_waking");
    return null;
  }

  /**
   * Running child agents and Cloud automations stay tied to the old session, which a switch closes.
   * Core's own "Resume after … plan limit" loops don't block; their ids come back to delete after the switch.
   */
  private async requireNoSessionDependents(threadId: string, saved: Binding): Promise<string[]> {
    if (this.rt.host.findRunningChild(threadId)) throw new ApiError(409, "thread_busy", "Wait until this thread's child agents finish, then switch.");
    const sandbox = sandboxThread(saved.coreUrl);
    if (!sandbox) return [];
    const listed = z.object({
      automations: z.array(z.object({ id: z.string().catch(""), name: z.string().catch(""), session_id: z.string().nullable(), enabled: z.boolean() }).passthrough()),
    }).safeParse(await this.rt.sandboxes.automations({ action: "list", thread: sandbox }).catch(() => null));
    if (!listed.success) throw new ApiError(503, "cloudroom_switch", "Couldn't check this thread's loops. Try again in a moment.");
    const own = listed.data.automations.filter((automation) => automation.enabled && automation.session_id === saved.sessionId);
    const resume = own.filter((automation) => automation.id && /^Resume after (Claude |Codex )?plan limit · /.test(automation.name));
    if (own.length > resume.length) throw new ApiError(409, "cloudroom_switch", "This thread has a Cloud loop. Pause or delete it, then switch.");
    return resume.map((automation) => automation.id);
  }

  /** The old session must be idle, with nothing queued, and fully shown here, so the new agent's history is complete. */
  private async quietSession(client: CloudroomClient, saved: Binding) {
    this.hooks.follow(saved, client);
    for (let attempt = 0; ; attempt++) {
      const session = await client.session(saved.sessionId!);
      const caughtUp = (binding(this.rt.host.db, saved.threadId)?.cursor ?? 0) >= session.last_sequence && !["pending", "starting"].includes(statusOf(session.state) ?? "");
      const busy = ["active", "stopping"].includes(statusOf(session.state) ?? "") || session.current_request !== null || session.queue.length > 0 || commands(this.rt.host.db, saved.threadId).some((c) => c.state === "sending");
      if (busy) throw new ApiError(409, "thread_busy", "Wait until the agent and its queued messages finish, then switch.");
      if (caughtUp) return session;
      if (attempt >= 20) throw new ApiError(503, "cloudroom_switch", "This thread is still syncing with the cloud. Try again in a moment.");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
