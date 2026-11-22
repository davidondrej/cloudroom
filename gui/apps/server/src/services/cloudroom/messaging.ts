import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { cloudroomCommands, cloudroomThreads, type DbQueryConnection } from "@cloudroom/db";
import {
  cloudLoginProvider,
  defaultReasoningLevel,
  isStandaloneBuiltinCompactCommand,
  PERSONAL_PROJECT_ID,
  promptInputSchema,
  reasoningLevelSchema,
  reconcileReasoningLevel,
  serviceTierSchema,
  type ReasoningLevel,
  type Thread,
} from "@cloudroom/domain";
import type { CreateThreadRequest, EditMessageRequest, EditMessageResponse, SendMessageRequest, SendMessageResponse } from "@cloudroom/server-contract";
import { ApiError } from "../../errors.js";
import type { CloudAccountAuth } from "./account-auth.js";
import { authRequiredMessages, CloudroomError } from "./client.js";
import type { CloudChildren } from "./children.js";
import { appRequestId } from "./cloud-threads.js";
import { appendStartProgress, isCloudProvider, projectFollowUp, projectInitialPrompt, retractStillQueuedPrompts, type StartStep } from "./events.js";
import type { CloudLifecycle } from "./lifecycle.js";
import { localProjectNote, workspaceId, workspaceName } from "./project-copy.js";
import {
  cloudOffersTier,
  cloudPromptLimit,
  cloudStep,
  commandReasoning,
  connectionFailure,
  coreModel,
  feature,
  followUpPayload,
  harnessProfile,
  isCloudThread,
  modelPickSchema,
  noAnswer,
  promptPayload,
  publicError,
  reasoningLevels,
  refusal,
  ROOT_WORKSPACE,
  sameStoredPrompt,
  startsWork,
  takesNoEffort,
  unsentWork,
  validateFollowUpReasoning,
  validateReasoning,
  type Capabilities,
} from "./protocol.js";
import type { CloudQueue } from "./queue.js";
import type { CloudRuntime } from "./runtime.js";
import { BUDGET_LIMIT, SANDBOX_PREFIX, SandboxAsleep, sandboxThread, startRefused } from "./sandboxes.js";
import type { CloudStatusPreviews } from "./status-previews.js";
import { binding, command, commands, effectivePrompt, queuedPrompts, saveBinding, saveCommandState, saveStatus, teleportBlocked, unstartedTurn, type Command } from "./store.js";

export interface MessagingHooks {
  start: () => void;
  deliver: (threadId: string) => Promise<void>;
  deliverWhenAwake: (threadId: string) => Promise<void>;
  asleep: (threadId: string) => void;
}

/** Handles Cloud thread creation, turn submission, stop/resume, model switches, compact, goal, and rewind edits. */
export class CloudMessaging {
  constructor(
    private readonly rt: CloudRuntime,
    private readonly auth: CloudAccountAuth,
    private readonly statusPreviews: CloudStatusPreviews,
    private readonly children: CloudChildren,
    private readonly lifecycle: CloudLifecycle,
    private readonly queue: CloudQueue,
    private readonly hooks: MessagingHooks,
  ) {}

  /** A new Cloud child or fork gets only the API keys of the sandbox its source runs in (ADR 0342), so a run with
   *  some keys never hands out more: a --shared-sandbox source runs in its parent's. Without `.env` in that list, it
   *  gets no `.env` files from this Mac either. Decided once, before it starts, and saved with its first message. */
  async keyFields(source: string | undefined): Promise<{ key_source?: string; no_env?: true }> {
    const sandbox = source ? sandboxThread(binding(this.rt.host.db, source)?.coreUrl ?? "") : null;
    if (!sandbox) return {};
    const keys = await this.rt.sandboxes.loopSecrets(sandbox);
    return { key_source: sandbox, ...(keys && !keys.includes(".env") ? { no_env: true as const } : {}) };
  }

  /** The only API keys the sandbox a thread runs in gets (ADR 0342): null for every key and for threads without a
   *  sandbox, like a VM's, and undefined when the website has no row for it. A sandbox with a list gets nothing from
   *  this Mac at its agent's request. */
  async keyList(threadId: string): Promise<string[] | null | undefined> {
    const sandbox = sandboxThread(binding(this.rt.host.db, threadId)?.coreUrl ?? "");
    return sandbox ? this.rt.sandboxes.loopSecrets(sandbox) : null;
  }

  threadStatus(threadId: string) {
    const saved = binding(this.rt.host.db, threadId);
    if (!saved) return null;
    const allCommands = commands(this.rt.host.db, threadId);
    const prompts: Command[] = [];
    let transfer: Command | undefined;
    let pendingDelivery = 0;
    for (const item of allCommands) {
      if (item.state === "sending") pendingDelivery++;
      if (item.command === "prompt" && !JSON.parse(item.input).teleport_handoff) prompts.push(item);
      else if (transfer === undefined && item.command === "teleport") transfer = item;
    }
    const latestPrompt = prompts.at(-1);
    const reasoning = this.queue.currentReasoning(threadId, saved, prompts);
    const input = latestPrompt ? effectivePrompt(this.rt.host.db, threadId, latestPrompt.id, false, allCommands) : transfer ? JSON.parse(transfer.input).manifest ?? {} : {};
    const serviceTier = serviceTierSchema.catch("default").parse(input.service_tier);
    const initial = prompts.find((item) => item.id === `first_${threadId}`);
    const entry = this.rt.peek(threadId);
    const issues = Object.values(entry?.connectionIssues ?? {});
    const sandbox = sandboxThread(saved.coreUrl);
    return {
      authRequired: !saved.sessionId && authRequiredMessages.has(saved.error ?? ""),
      starting: !saved.queuePaused && Boolean(initial && ["sending", "accepted"].includes(initial.state)),
      sessionId: saved.sessionId,
      paused: saved.queuePaused,
      failedStart: !saved.sessionId && initial?.state === "failed",
      model: saved.model,
      reasoning,
      serviceTier,
      error: saved.error ?? issues.find((issue) => !issue.reconnecting)?.message ?? null,
      reconnecting: issues.some((issue) => issue.reconnecting),
      usageLimit: Boolean(sandbox) && (this.rt.sandboxes.usageLimited() || this.rt.sandboxes.agentLimited(sandbox ?? "")),
      launchCap: !this.rt.sandboxes.usageLimited() && this.rt.sandboxes.agentLimited(sandbox ?? ""),
      disk: entry?.disk ?? null,
      awake: !sandbox || this.rt.sandboxes.isAwake(sandbox ?? ""),
      vps: this.rt.sandboxes.onVps(sandbox ?? ""),
      move: this.rt.sandboxes.moveState(sandbox ?? ""),
      waiting: this.rt.sandboxes.waitNotice(sandbox ?? ""),
      fromCopy: this.rt.sandboxes.copyChoice(sandbox ?? ""),
      outOfMemory: Boolean(entry?.outOfMemory),
      pendingDelivery,
    };
  }

  async create(request: CreateThreadRequest, awaitingCore = false, fork?: { sourceThreadId: string; endSequence: number }): Promise<Thread> {
    if (request.originKind === "fork" && request.sourceThreadId && !fork) return this.lifecycle.createFork(request, request.sourceThreadId);
    const parentId = request.originKind || request.sourceThreadId ? undefined : request.parentThreadId;
    const parent = parentId ? this.rt.host.getThread(parentId) : null;
    // A Cloud parent's child gets a sandbox of its own with a copy of the parent's code (ADR 0229).
    const codeFrom = parent && isCloudThread(parent) ? parent.id : fork?.sourceThreadId;
    if (parent && codeFrom && request.projectId !== parent.projectId) throw new ApiError(400, "cloudroom_unsupported", "A child thread belongs to its parent's project.");
    if (parentId) this.rt.host.assertValidParent(parentId, Boolean(codeFrom));
    const sandbox = await this.rt.newThreadsInSandboxes();
    const connection = sandbox ? null : await this.rt.connection();
    const keys = await this.keyFields(codeFrom);
    const project = this.rt.host.getProject(request.projectId);
    if (!project) throw new ApiError(404, "project_not_found", "Project not found");
    if (!isCloudProvider(request.providerId) || (!fork && (request.originKind || request.sourceThreadId)) || request.sendAt || request.pluginSubmission || (request.environment.type !== "project-default" && !codeFrom)) {
      throw new ApiError(400, "cloudroom_unsupported", "Cloud supports new Codex, Pi, Cursor, fx, opencode, Hermes Agent, Devin, Droid, Kimi Code, Antigravity, OpenClaw, Agent Zero and Claude Code threads in a cloud folder. Forks, scheduling and native machine targets are not supported.");
    }
    if (request.permissionMode && request.permissionMode !== "full") throw new ApiError(400, "cloudroom_unsupported", "Cloud uses the full permission mode; restricted modes are not supported.");
    if (request.startedOnBehalfOf || request.sourceSeqEnd !== undefined) throw new ApiError(400, "cloudroom_unsupported", "Cloud continuation and delegated starts are not enabled.");
    // A new sandbox starts on first delivery, so check against the last known capabilities.
    let capabilities = sandbox ? await this.rt.savedCapabilities() : this.rt.lastCapabilities;
    if (!sandbox) {
      try { capabilities = await this.rt.capabilities(await this.rt.client()); this.rt.lastCapabilities = capabilities; }
      catch (error) {
        if (error instanceof ApiError) throw error;
        if (!connectionFailure(error) || (error instanceof CloudroomError && error.code === "storage_blocked")) throw new ApiError(503, "cloudroom_unavailable", publicError(error));
        capabilities = null;
      }
    }
    const profile = capabilities ? harnessProfile(capabilities, request.providerId) : null;
    if (capabilities && !cloudOffersTier(profile ?? undefined, request.serviceTier, request.model)) throw new ApiError(400, "cloudroom_unsupported", "Cloud does not offer this speed for the model");
    const payload = promptPayload(request.input, request.providerId, capabilities?.attachments === false ? false : profile?.attachments ?? true, cloudPromptLimit(capabilities));
    const model = request.model;
    const piDefault = request.providerId === "pi" && !request.reasoningLevel;
    // A model whose own row takes no effort, such as Claude's Haiku, starts without one; others keep medium (#1059).
    const reasoning = request.reasoningLevel ?? (takesNoEffort(capabilities, request.providerId, model) ? "none" : defaultReasoningLevel(undefined));
    if (!model) throw new ApiError(400, "model_required", "Select a Codex model");
    const startRequestId = request.requestId ?? randomUUID();
    const existingThread = (db: DbQueryConnection) => {
      const previous = db.select().from(cloudroomThreads).where(eq(cloudroomThreads.startRequestId, startRequestId)).get();
      if (!previous) return null;
      const initial = command(db, `first_${previous.threadId}`);
      const thread = this.rt.host.getThread(previous.threadId, db);
      if (thread?.projectId !== request.projectId || thread?.providerId !== request.providerId || previous.model !== model || (initial && JSON.parse(initial.input).default_reasoning ? !piDefault : previous.reasoning !== reasoning) || (initial ? JSON.parse(initial.input).text : null) !== payload.text) {
        throw new ApiError(409, "request_conflict", "Request ID was already used with different content");
      }
      return thread;
    };
    const previous = existingThread(this.rt.host.db);
    if (previous) {
      this.holdRejectedStart(previous.id);
      if (command(this.rt.host.db, `first_${previous.id}`)?.state === "failed" && !binding(this.rt.host.db, previous.id)?.sessionId) await this.retryStart(previous.id);
      else await this.hooks.deliver(previous.id);
      return this.rt.host.getThread(previous.id)!;
    }
    const remoteModel = capabilities ? coreModel(request.providerId, model, capabilities) : null;
    // A sleeping sandbox's saved catalog may predate a login or OpenCode config edit; its Core checks the model at start.
    if (capabilities && remoteModel && !piDefault && !(sandbox && (profile?.models === null || request.providerId === "acp-opencode"))) validateReasoning(request.providerId, remoteModel.model, reasoning, capabilities);
    const workspace = project.id === PERSONAL_PROJECT_ID ? { workspace: ROOT_WORKSPACE } : { workspace: workspaceId(project.id), workspace_name: workspaceName(project.name) };
    const providerId = request.providerId;
    const projectNote = project.id === PERSONAL_PROJECT_ID ? undefined : await localProjectNote(this.rt.host.deps, project.id);
    let created = false;
    const titleInput = request.input.filter((part) => part.visibility !== "agent-only");
    const thread = this.rt.host.db.transaction((tx) => {
      const existing = existingThread(tx);
      if (existing) return existing;
      if (parentId) this.rt.host.assertValidParent(parentId, Boolean(codeFrom));
      created = true;
      const made = this.rt.host.createThread(tx, {
        executionTarget: "cloud", projectId: request.projectId, providerId, status: "pending", parentThreadId: parentId ?? null,
        ...(fork ? { originKind: "fork" as const, sourceThreadId: fork.sourceThreadId } : {}),
        title: request.title, titleFallback: this.rt.host.deriveTitleFallback(titleInput), sectionId: request.sectionId, visibility: request.visibility,
        originPluginId: request.originPluginId,
        pluginMetadata: request.pluginMetadata && request.originPluginId ? { pluginId: request.originPluginId, metadata: request.pluginMetadata } : null,
      });
      tx.insert(cloudroomThreads).values({ threadId: made.id, coreUrl: connection ? connection.url : SANDBOX_PREFIX + made.id, startRequestId, model, reasoning }).run();
      tx.insert(cloudroomCommands).values({
        id: `first_${made.id}`, threadId: made.id, command: "prompt",
        input: JSON.stringify(this.rt.host.snapshotInstructions(tx, made, "prompt", {
          ...payload, ...workspace, provider: remoteModel?.provider,
          command_guard_enabled: this.rt.host.getAppSettings().commandGuardEnabled,
          strip_ai_co_authors: this.rt.host.getAppSettings().stripAiCoAuthorsEnabled,
          system_prompt: this.rt.host.buildSystemPrompt(made.id, made.projectId, this.rt.sandboxes.vpsConnected, projectNote),
          ...(request.serviceTier && request.serviceTier !== "default" ? { service_tier: request.serviceTier } : {}),
          ...(request.baseBranch ? { base_branch: request.baseBranch } : {}),
          ...(codeFrom ? { code_from: codeFrom } : {}), ...keys,
          ...(piDefault ? { default_reasoning: true } : {}),
          ...(awaitingCore || this.children.isHeldStart(request.requestId ?? "") ? { awaiting_core: true } : {}),
        })),
        createdAt: Date.now(),
      }).run();
      if (!fork) {
        projectInitialPrompt(tx, made.id);
        appendStartProgress(tx, made.id, [cloudStep(Boolean(sandbox))], "active", true);
      }
      this.rt.host.queueTitle(tx, made.id, titleInput);
      if (!request.title && this.rt.host.shouldGenerateTitle(titleInput)) {
        tx.insert(cloudroomCommands).values({ id: `title_${made.id}`, threadId: made.id, command: "title", input: JSON.stringify({ input: titleInput }), createdAt: Date.now() }).run();
      }
      return made;
    });
    if (fork && created) {
      this.rt.host.copyForkHistory(thread, fork.sourceThreadId, fork.endSequence);
      this.rt.host.db.transaction((tx) => {
        projectInitialPrompt(tx, thread.id);
        appendStartProgress(tx, thread.id, [cloudStep(Boolean(sandbox))], "active", true);
      });
    }
    if (created && sandbox) {
      this.rt.sandboxes.firstWakeHints(thread.id, { ...(request.cloudTarget ? { target: request.cloudTarget } : {}), launch: request.origin, ...(request.launcherThreadId ? { launcher: request.launcherThreadId } : {}) });
    }
    this.rt.notify(thread.id, ["client/turn/requested", "system/thread-provisioning"]);
    void this.statusPreviews.selectOnboardingProject(project.id).catch(() => {});
    this.hooks.start();
    void this.hooks.deliver(thread.id).catch(() => {});
    return this.rt.host.getThread(thread.id)!;
  }

  async updateReasoningOverride(thread: Thread, reasoningLevel: ReasoningLevel | null): Promise<void> {
    const saved = binding(this.rt.host.db, thread.id);
    if (!saved) throw new ApiError(409, "cloudroom_missing_binding", "Cloud thread has no core binding; native execution is blocked");
    if (thread.archivedAt || thread.deletedAt) throw new ApiError(409, "thread_not_writable", "Thread is archived or deleted");
    await this.rt.requireOwnThread(saved);
    if (reasoningLevel !== null) {
      const known = sandboxThread(saved.coreUrl) ? await this.rt.savedCapabilities() : this.rt.lastCapabilities;
      try { validateFollowUpReasoning(thread.providerId, saved, reasoningLevel, known ?? await this.rt.liveCapabilities(saved)); }
      catch (error) {
        if (!known || !(error instanceof ApiError)) throw error;
        validateFollowUpReasoning(thread.providerId, saved, reasoningLevel, await this.rt.liveCapabilities(saved));
      }
    }
    this.rt.host.setExecutionOverride({ threadId: thread.id, reasoningLevelOverride: reasoningLevel });
  }

  async switchesModels(coreUrl: string, harness: string, ask: () => Promise<Capabilities>): Promise<boolean> {
    const key = `${coreUrl} ${harness}`;
    if (this.rt.modelSwitchers.has(key)) return true;
    const takes = Boolean(harnessProfile(await ask(), harness)?.set_model);
    if (takes) this.rt.modelSwitchers.add(key);
    return takes;
  }

  /** A model pick in the same Claude session, as on Local: saved here at once, then Core gets it as a queued `model`
   *  command, ahead of the next work. Core owns it, so every turn runs it, whoever sends it. False when this thread's
   *  Core can't, so the caller starts a new session instead (ADR 0211). Never wakes the sandbox: an asleep one wakes
   *  with the pinned Core, which the saved capabilities describe. */
  async changeModel(thread: Thread, model: string, reasoningLevel: ReasoningLevel | null, checkIdleSession?: () => void): Promise<boolean> {
    const saved = binding(this.rt.host.db, thread.id);
    if (!saved?.sessionId || thread.archivedAt || thread.deletedAt || this.rt.peek(thread.id)?.switching) return false;
    await this.rt.requireOwnThread(saved);
    const sandbox = sandboxThread(saved.coreUrl);
    const known = sandbox ? await this.rt.savedCapabilities() : this.rt.lastCapabilities;
    const asleep = sandbox !== null && !this.rt.sandboxes.isAwake(sandbox);
    const live = async () => this.rt.capabilities(await this.rt.client(saved, false));
    const catalog = checkIdleSession && !asleep ? await live() : known;
    if (!catalog) return false;
    const profile = harnessProfile(catalog, thread.providerId);
    if (!profile?.set_model) return false;
    if (checkIdleSession) {
      if (!profile.idle_set_model) return false;
      if (!profile.models?.some((item) => item.model === model)) throw new ApiError(409, "model_unavailable", "That model is unavailable in this Cloud session.");
      checkIdleSession();
      const current = binding(this.rt.host.db, thread.id);
      const entry = this.rt.peek(thread.id);
      if (current?.sessionId !== saved.sessionId || entry?.switching || (entry?.activeSends ?? 0) > 0) {
        throw new ApiError(409, "thread_changed", "The thread changed while checking the model. Try again when it is idle.");
      }
      if (current.model === model) return true;
      if (current.model !== saved.model) throw new ApiError(409, "thread_changed", "Another model was selected. Try again.");
    } else if (!asleep && !await this.switchesModels(saved.coreUrl, thread.providerId, live).catch(() => false)) return false;
    const current = this.queue.currentReasoning(thread.id, saved);
    const levels = reasoningLevels(thread.providerId, model, catalog) as ReasoningLevel[] | undefined;
    const reasoning = reasoningLevelSchema.parse(reasoningLevel ?? (levels?.length ? reconcileReasoningLevel(current as ReasoningLevel, levels) : current));
    validateReasoning(thread.providerId, model, reasoning, catalog);
    // Core records the effort with the model, so a wake resumes on a level the model takes; edits send it too. A newer
    // pick replaces an unsent one, and keeps what the thread ran before both.
    const waiting = commands(this.rt.host.db, thread.id).filter((item) => item.command === "model" && item.state === "sending");
    const before = waiting[0] ? JSON.parse(waiting[0].input).before : { model: saved.model, reasoning: saved.reasoning, override: this.rt.host.getExecutionOverride(thread.id)?.reasoningLevelOverride ?? null };
    const id = randomUUID();
    this.rt.host.db.transaction((tx) => {
      for (const item of waiting) saveCommandState(tx, thread.id, item.id, "cancelled");
      saveBinding(tx, thread.id, { model, reasoning });
      this.rt.host.setExecutionOverride({ threadId: thread.id, modelOverride: null, reasoningLevelOverride: reasoning }, tx);
      this.queue.insertCommand(tx, thread, id, "model", { model, reasoning, before, ...(checkIdleSession ? { idleSessionId: saved.sessionId } : {}) });
    });
    this.rt.notify(thread.id);
    if (checkIdleSession && !asleep) {
      // A dropped connection leaves a durable pick ahead of its prompt. A definitive refusal restores the previous model.
      await this.hooks.deliver(thread.id).catch(() => {});
      const state = command(this.rt.host.db, id)?.state;
      if (!state || !["sending", "accepted", "completed"].includes(state)) throw new ApiError(409, "model_unavailable", "Core declined the model switch. Choose another model.");
    } else if (!asleep) void this.hooks.deliver(thread.id).catch(() => {});
    return true;
  }

  /** Core didn't take a model pick (`model` command): the thread shows the model it still runs. */
  keepModel(threadId: string, pick: Command): void {
    const { before, idleSessionId } = modelPickSchema.parse(JSON.parse(pick.input));
    if (command(this.rt.host.db, pick.id)?.state !== "sending") return;
    this.rt.host.db.transaction((tx) => {
      saveCommandState(tx, threadId, pick.id, "failed");
      if (idleSessionId && binding(tx, threadId)?.sessionId !== idleSessionId) return;
      saveBinding(tx, threadId, { model: before.model, reasoning: before.reasoning });
      this.rt.host.setExecutionOverride({ threadId, reasoningLevelOverride: before.override }, tx);
    });
    this.rt.host.logger?.warn({ threadId }, "Cloud model pick not taken; the thread keeps its model");
    this.rt.host.notifyThread(threadId, ["execution-options-changed"], { projectId: this.rt.host.getThread(threadId)?.projectId });
  }

  /** Check the Mac's saved command before replaying a send whose reply was lost. */
  async messageDelivery(threadId: string, rawId: string): Promise<SendMessageResponse | null> {
    const saved = binding(this.rt.host.db, threadId);
    const thread = this.rt.host.getThread(threadId);
    if (!saved || !thread || !isCloudThread(thread)) throw new ApiError(404, "cloudroom_missing_binding", "Cloud thread unavailable.");
    await this.rt.requireOwnThread(saved);
    const id = await this.rt.requestId(threadId, rawId);
    const stored = command(this.rt.host.db, id);
    if (!stored) return null;
    if (stored.threadId !== threadId || (stored.command !== "prompt" && stored.command !== "steer")) throw new ApiError(409, "request_conflict", "This request ID belongs to a different command.");
    if (!["sending", "accepted", "running", "delivered", "completed", "interrupted"].includes(stored.state)) {
      throw new ApiError(409, "cloudroom_command_failed", "Check the conversation before sending this message again.");
    }
    const queued = this.queue.queue(threadId).find((item) => item.id === id);
    return queued ? { ok: true, delivery: "queued", queuedMessage: queued } : { ok: true, delivery: "sent" };
  }

  async send(thread: Thread, payload: SendMessageRequest): Promise<SendMessageResponse> {
    const entry = this.rt.state(thread.id);
    if (entry.switching) throw new ApiError(409, "thread_busy", "This thread is switching agents. Send again in a moment.");
    entry.activeSends += 1;
    try { return await this.sendNow(thread, payload); }
    finally { entry.activeSends = Math.max(0, entry.activeSends - 1); }
  }

  private async sendNow(thread: Thread, payload: SendMessageRequest): Promise<SendMessageResponse> {
    if (teleportBlocked(this.rt.host.db, thread.id)) throw new ApiError(409, "teleport_in_progress", "Messages are disabled until Teleport finishes.");
    const saved = binding(this.rt.host.db, thread.id);
    if (!saved) throw new ApiError(409, "cloudroom_missing_binding", "Cloud thread has no core binding; native execution is blocked");
    await this.rt.requireOwnThread(saved);
    if (!saved.sessionId && command(this.rt.host.db, `first_${thread.id}`)?.state === "failed") {
      throw new ApiError(409, "cloudroom_start_failed", "Retry the rejected cloud start before sending more messages. Your original prompt is saved.");
    }
    if (thread.archivedAt || thread.deletedAt) throw new ApiError(409, "thread_not_writable", "Thread is archived or deleted");
    if (payload.sendAt || payload.pluginSubmission) throw new ApiError(409, "cloudroom_unsupported", "Cloud follow-ups use the core queue. Scheduling is not enabled.");
    if (isStandaloneBuiltinCompactCommand(payload.input)) { await this.compact(thread); return { ok: true, delivery: "sent" }; }
    if (payload.model && payload.model !== saved.model) {
      throw new ApiError(409, "cloudroom_launch_settings", `This Cloud thread now runs ${saved.model}. Send again with that model, or to use ${payload.model}, switch first in the model picker or with \`room-cli thread update ${thread.id} --model ${payload.model}\`.`);
    }
    const pendingModel = this.rt.host.db.select({ id: cloudroomCommands.id, input: cloudroomCommands.input }).from(cloudroomCommands)
      .where(and(eq(cloudroomCommands.threadId, thread.id), eq(cloudroomCommands.command, "model"), eq(cloudroomCommands.state, "sending"))).get();
    const id = await this.rt.requestId(thread.id, payload.requestId);
    const steer = (payload.mode === "steer" || payload.mode === "steer-if-active") && thread.status === "active" && saved.turnId && !unstartedTurn(this.rt.host.db, thread.id);
    const previous = command(this.rt.host.db, id);
    // A side chat's first message carries its quoted message, as on Local; a retry repeats what was sent.
    const seed = steer ? [] : previous?.command === "prompt"
      ? this.rt.host.leadingAgentOnlyInput(z.array(promptInputSchema).catch([]).parse(JSON.parse(previous.input).content))
      : this.rt.host.deferredFirstTurnContext(thread)?.input ?? [];
    if (seed.length && payload.input[0]?.visibility !== "agent-only") payload = { ...payload, input: [...seed, ...payload.input] };
    const reasoning = payload.reasoningLevel ?? (previous ? commandReasoning(previous.input) ?? saved.reasoning : this.queue.currentReasoning(thread.id, saved));
    // live() runs before this send saves anything: say whether the message is saved (maybe by an overlapping attempt
    // with the same request ID while this one waited), so it isn't sent twice.
    const live = () => this.rt.liveCapabilities(saved).catch((error: unknown) => {
      if (!(error instanceof ApiError) || error.status !== 503) throw error;
      const stored = command(this.rt.host.db, id);
      throw stored?.threadId === thread.id
        ? new ApiError(503, error.body.code, `${error.body.message} This message is already saved (${stored.state}). Retry with the same request ID; don't send it as a new message.`, { details: { requestId: id, state: stored.state } })
        : new ApiError(503, error.body.code, `${error.body.message} Your message was not sent. Send it again in a moment.`);
    });
    const starting = !saved.sessionId && ["pending", "starting"].includes(thread.status);
    // A stopped thread uses the saved capabilities too, so its message is saved before any wake (#534).
    const fast = starting || (saved.sessionId && ["idle", "error", "active"].includes(thread.status));
    const known = fast ? (sandboxThread(saved.coreUrl) ? await this.rt.savedCapabilities() : this.rt.lastCapabilities) : null;
    const validated = steer || previous ? null : reasoning;
    let capabilities = known ?? await live();
    let parsed: ReturnType<typeof promptPayload>;
    try { parsed = followUpPayload(thread.providerId, saved, payload, validated, capabilities); }
    catch (error) {
      if (!known || !(error instanceof ApiError)) throw error;
      parsed = followUpPayload(thread.providerId, saved, payload, validated, capabilities = await live());
    }
    if (steer) {
      this.queue.enqueue(thread.id, id, "steer", { target_request_id: saved.turnId, text: parsed.text, content: parsed.content, attachments: parsed.attachments });
      await this.hooks.deliver(thread.id);
      return { ok: true, delivery: "sent" };
    }
    const stored = {
      ...parsed,
      ...(pendingModel && JSON.parse(pendingModel.input).idleSessionId ? { modelPickId: pendingModel.id } : {}),
      ...(reasoning !== saved.reasoning ? { reasoning } : {}),
      ...(payload.serviceTier && payload.serviceTier !== "default" ? { service_tier: payload.serviceTier } : {}),
      ...(payload.senderThreadId ? { sender_thread_id: payload.senderThreadId } : {}),
    };
    if (previous) {
      if (!sameStoredPrompt(previous, thread.id, stored, reasoning, saved.reasoning)) throw new ApiError(409, "request_conflict", "Request ID was already used with different content");
    } else {
      const jumpQueue = saved.queuePaused && this.queue.queue(thread.id).length > 0 && feature(capabilities, "queue_reorder");
      if (thread.status === "error" && saved.sessionId) this.queue.enqueue(thread.id, randomUUID(), "resume", saved.queuePaused ? { keep_paused: true } : {});
      this.queue.enqueue(thread.id, id, "prompt", stored);
      if (jumpQueue) this.queue.enqueue(thread.id, randomUUID(), "reorder", { order: [id] });
      if (saved.queuePaused) this.queue.enqueue(thread.id, randomUUID(), "resume", {});
      const sticky = this.rt.host.getExecutionOverride(thread.id)?.reasoningLevelOverride;
      if (payload.reasoningLevel && sticky && sticky !== payload.reasoningLevel) this.rt.host.setExecutionOverride({ threadId: thread.id, reasoningLevelOverride: payload.reasoningLevel });
      if (this.rt.host.db.transaction((tx) => projectFollowUp(tx, thread.id, id))) this.rt.notify(thread.id, ["client/turn/requested"]);
    }
    const delivery = this.hooks.deliver(thread.id);
    const shown = this.queue.queue(thread.id).find((item) => item.id === id);
    if (shown || (thread.status !== "error" && (!previous || binding(this.rt.host.db, thread.id)?.turnId === id))) {
      void delivery.catch(() => {});
      return shown ? { ok: true, delivery: "queued", queuedMessage: shown } : { ok: true, delivery: "sent" };
    }
    await delivery;
    const state = command(this.rt.host.db, id)?.state;
    if (state && ["failed", "unknown", "unknown_after_restart"].includes(state)) {
      throw new ApiError(409, "cloudroom_command_failed", "The core reports failed or uncertain execution. Check the conversation before submitting again.");
    }
    const queued = this.queue.queue(thread.id).find((item) => item.id === id);
    return queued ? { ok: true, delivery: "queued", queuedMessage: queued } : { ok: true, delivery: "sent" };
  }

  /** `offline`: a stop the website refuses to wake the sandbox for still stops, without it (#553). One that can't reach
   *  the sandbox (no answer, a time-out, a website 5xx) is saved and goes out once it can, only for its turn (#1699). */
  async control(threadId: string, action: "stop" | "resume", offline = true): Promise<void> {
    const saved = binding(this.rt.host.db, threadId);
    if (!saved) throw new ApiError(409, "cloudroom_missing_binding", "Cloud session is unavailable");
    if (action === "stop" && this.rt.host.getThread(threadId)?.archivedAt) return;
    const wake = action === "resume" || unsentWork(this.rt.host.db, threadId) || (!saved.queuePaused && queuedPrompts(this.rt.host.db, threadId).length > 0);
    const holds = action === "stop" && offline && Boolean(saved.sessionId);
    // Work saved before this Stop that never reached Core is cancelled, so it can't run once the sandbox is back, and the
    // queue shows paused. A message sent while Stop waits is kept. Unreachable, Core may have taken the current turn's
    // prompt: it stays, so the thread isn't shown idle while its agent may run.
    const before = new Set(commands(this.rt.host.db, threadId).filter((c) => c.state === "sending").map((c) => c.id));
    const hold = (idle: boolean) => this.rt.host.db.transaction((tx) => {
      const cancelled = new Set<string>(), turn = idle ? null : binding(tx, threadId)?.turnId;
      for (const item of commands(tx, threadId)) {
        if (item.state === "sending" && ((startsWork(item) && before.has(item.id) && item.id !== turn) || cancelled.has(JSON.parse(item.input).target_request_id))) {
          saveCommandState(tx, threadId, item.id, "cancelled");
          cancelled.add(item.id);
        }
      }
      saveBinding(tx, threadId, { queuePaused: true });
      if (idle) saveStatus(tx, threadId, "idle");
    });
    // The sandbox may still run the agent, so this says the stop is saved, never that it stopped.
    const pending = () => new ApiError(503, "cloudroom_stop_pending", "Couldn't reach this thread's cloud sandbox, so its agent may still be running. Stop is saved and goes out once the sandbox is reachable; messages it hadn't received yet won't be sent.");
    try { await this.rt.client(saved, wake, undefined, true); }
    catch (error) {
      if (error instanceof SandboxAsleep) return this.hooks.asleep(threadId);
      // The website refused the wake before starting the sandbox (out of credits, a plan limit, Free's daily budget), so
      // nothing runs there. The stop waits for the next wake, ahead of later work.
      const refusedWake = startRefused(error) || (error instanceof CloudroomError && error.code === BUDGET_LIMIT);
      // A repair's 429 still fails: the sandbox may be running there. A restore's is held like no answer: its sandbox
      // waits in the server's restore line, often for many minutes (Metal, 2026-11-17), and Stop failed all that time.
      const restoring = error instanceof CloudroomError && error.code === "sandbox_restoring";
      if (holds && (refusedWake || ((noAnswer(error) || restoring) && saved.turnId))) {
        hold(refusedWake);
        // Held for the next wake, it stops only the turn it was clicked for: another computer may start one meanwhile.
        this.queue.enqueue(threadId, randomUUID(), "stop", saved.turnId ? { after: saved.turnId, ...(refusedWake ? {} : { guarded: true }) } : {});
        this.rt.notify(threadId);
        if (refusedWake) return this.hooks.asleep(threadId);
        throw pending();
      }
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, error instanceof CloudroomError ? error.code ?? "cloudroom_unavailable" : "cloudroom_unavailable", publicError(error));
    }
    const id = randomUUID();
    this.queue.enqueue(threadId, id, action, {});
    await this.hooks.deliver(threadId).catch((error: unknown) => {
      // Core didn't answer: the saved stop is retried as before.
      if (!holds || !(error instanceof ApiError) || !noAnswer(error.cause) || command(this.rt.host.db, id)?.state !== "sending") throw error;
      hold(false);
      throw pending();
    });
  }

  /** A newer Core (`compact_after_turn`) compacts a busy thread once its turn ends, then sends `then`, saying how it went. */
  async compact(thread: Thread, then?: string) {
    if (teleportBlocked(this.rt.host.db, thread.id)) throw new ApiError(409, "teleport_in_progress", "Compaction is disabled until Teleport finishes.");
    const saved = binding(this.rt.host.db, thread.id);
    if (!saved?.sessionId) throw new ApiError(409, "cloudroom_missing_binding", "Cloud session is unavailable");
    await this.rt.requireOwnThread(saved);
    if (!["idle", "error", "active"].includes(thread.status)) throw new ApiError(409, "invalid_request", `Context can't be compacted while the thread is ${thread.status}.`);
    const capabilities = await this.rt.capabilities(await this.rt.client(saved));
    if (!feature(capabilities, "compact") || harnessProfile(capabilities, thread.providerId)?.compact === false) throw new ApiError(409, "cloudroom_unsupported", "Cloud compaction is not enabled for this harness.");
    if (!feature(capabilities, "compact_after_turn")) {
      if (thread.status === "active") throw new ApiError(409, "cloudroom_update", "Update the cloud core to compact a thread while it works. Until then, compact it once it is idle.");
      if (then) throw new ApiError(409, "cloudroom_update", "Update the cloud core to send a follow-up after compaction, or use --no-then.");
    }
    this.queue.enqueue(thread.id, randomUUID(), "compact", then ? { then } : {});
    await this.hooks.deliverWhenAwake(thread.id);
  }

  /** Goal controls work the same as Local (ADR 0137): pause, resume, replace the objective, or clear. */
  async goal(thread: Thread, goal: { status?: "active" | "paused"; objective?: string; clear?: boolean }) {
    const saved = binding(this.rt.host.db, thread.id);
    if (!saved?.sessionId) throw new ApiError(409, "cloudroom_missing_binding", "Cloud session is unavailable");
    const capabilities = await this.rt.capabilities(await this.rt.client(saved));
    if (!feature(capabilities, "goal") || harnessProfile(capabilities, thread.providerId)?.goal !== true) {
      throw new ApiError(409, "cloudroom_unsupported", `Cloud Goal controls need a Codex thread and an updated cloud core (this thread runs ${thread.providerId}).`);
    }
    this.queue.enqueue(thread.id, randomUUID(), "goal", goal);
    await this.hooks.deliverWhenAwake(thread.id);
  }

  async editMessage(thread: Thread, payload: EditMessageRequest): Promise<EditMessageResponse> {
    let saved = binding(this.rt.host.db, thread.id);
    if (!saved?.sessionId) throw new ApiError(409, "cloudroom_missing_binding", "Cloud session is unavailable");
    const editable = (capabilities: Capabilities) => feature(capabilities, "rewind") && harnessProfile(capabilities, thread.providerId)?.rewind !== false;
    const known = sandboxThread(saved.coreUrl) ? await this.rt.savedCapabilities() : this.rt.lastCapabilities;
    const capabilities = known && harnessProfile(known, thread.providerId) && editable(known) ? known : await this.rt.liveCapabilities(saved);
    if (!editable(capabilities)) throw new ApiError(409, "cloudroom_unsupported", "Cloud message editing is not enabled for this harness.");
    const parsed = promptPayload(payload.input, thread.providerId, capabilities.attachments && (harnessProfile(capabilities, thread.providerId)?.attachments ?? true), cloudPromptLimit(capabilities));
    const tag = await this.rt.me(), rewindId = appRequestId(tag, `rewind_${payload.operationId}`), promptId = appRequestId(tag, `edit_${payload.operationId}`);
    const replacement = { request_id: promptId, ...parsed, reasoning: payload.reasoningLevel ?? saved.reasoning, service_tier: payload.serviceTier ?? "default" };
    const previous = command(this.rt.host.db, rewindId);
    if (previous) {
      const original = JSON.parse(previous.input);
      if (previous.threadId !== thread.id || original.expected_request_sequence !== payload.expectedRequestSequence || JSON.stringify(original.replacement) !== JSON.stringify(replacement)) {
        throw new ApiError(409, "request_conflict", "This edit operation ID belongs to another edit");
      }
    } else {
      if (this.queue.queue(thread.id).length) throw new ApiError(409, "invalid_request", "Send or remove queued messages before editing a message");
      const status = () => this.rt.host.getThread(thread.id)?.status;
      const quiet = () => status() === "idle" || status() === "error";
      if (status() === "active" || status() === "stopping") {
        await this.control(thread.id, "stop");
        if (!await this.rt.host.waitUntil(thread.id, quiet, 60_000)) throw new ApiError(409, "invalid_request", "The thread did not stop before the message edit timed out");
        saved = binding(this.rt.host.db, thread.id) ?? saved;
      }
      if (!quiet()) throw new ApiError(409, "invalid_request", "Wait for the active turn to finish before editing a sent message");
      const before = this.rt.host.nativeRewindBefore(thread.id, payload.expectedRequestSequence);
      // An edit is an explicit send, so it lifts the pause left by Stop. Core rejects resume mid-rewind, so it goes first.
      if (saved.queuePaused) this.queue.enqueue(thread.id, `resume_${payload.operationId}`, "resume", {});
      this.queue.enqueue(thread.id, rewindId, "rewind", { before, expected_request_sequence: payload.expectedRequestSequence, replacement });
    }
    try { await this.hooks.deliverWhenAwake(thread.id); }
    catch (error) {
      for (const id of [`resume_${payload.operationId}`, rewindId]) {
        if (command(this.rt.host.db, id)?.state === "sending") saveCommandState(this.rt.host.db, thread.id, id, "failed");
      }
      throw error;
    }
    const state = () => command(this.rt.host.db, rewindId)?.state ?? "";
    await this.rt.host.waitUntil(thread.id, () => !["sending", "accepted", "running"].includes(state()), 30_000);
    if (["failed", "unknown", "unknown_after_restart"].includes(state())) {
      throw new ApiError(409, "cloudroom_command_failed", "The rewind failed or its outcome is uncertain. Your original history is preserved.");
    }
    return { ok: true, operationId: payload.operationId, requestSequence: payload.expectedRequestSequence ?? 0 };
  }

  async retryStart(threadId: string): Promise<void> {
    await this.rt.peek(threadId)?.delivery?.catch(() => {});
    this.holdRejectedStart(threadId);
    const saved = binding(this.rt.host.db, threadId);
    const thread = this.rt.host.getThread(threadId);
    const first = command(this.rt.host.db, `first_${threadId}`)?.state;
    if (saved && !saved.sessionId && (first === "sending" || first === "accepted")) return;
    if (!saved || !thread || thread.archivedAt || thread.deletedAt || saved.sessionId || first !== "failed") {
      throw new ApiError(409, "cloudroom_retry", "Only a rejected cloud start can be retried here.");
    }
    const client = await this.rt.client(saved);
    const capabilities = await this.rt.capabilities(client);
    const harness = thread.providerId;
    if (!isCloudProvider(harness)) throw new ApiError(400, "cloudroom_harness", "Unsupported cloud harness.");
    validateReasoning(harness, coreModel(harness, saved.model, capabilities).model, saved.reasoning, capabilities);
    if (harness === "codex" && sandboxThread(saved.coreUrl) && authRequiredMessages.has(saved.error ?? "")) {
      await this.rt.sandboxes.refreshCodex(threadId).catch((error) => this.rt.host.warn("Cloud Codex login could not be refreshed before the retry", error, { threadId }));
    }
    // A retry can start from the sign-in resume and a click at once; only the first one past the awaits sends.
    if (command(this.rt.host.db, `first_${threadId}`)?.state !== "failed") return;
    this.rt.host.db.transaction((tx) => {
      saveCommandState(tx, threadId, `first_${threadId}`, "sending");
      saveBinding(tx, threadId, { error: null });
      saveStatus(tx, threadId, "pending");
      appendStartProgress(tx, threadId, [cloudStep(Boolean(sandboxThread(saved.coreUrl)))], "active", true);
    });
    this.rt.notify(threadId, ["system/thread-provisioning"]);
    this.hooks.start();
    await this.hooks.deliver(threadId);
  }

  failStart(threadId: string, message: string, cause?: unknown, step = "start"): void {
    // The raw cause (say, a vendor's 404 text) and how long after its creation the start failed, for late notices (#1076).
    this.rt.host.warn("A cloud start failed", cause ?? message, { threadId, ageMs: Date.now() - (this.rt.host.getThread(threadId)?.createdAt ?? Date.now()) });
    // Cloud refused Codex's login: resend this Mac's working one before anyone has to click.
    if (cloudLoginProvider(message) === "codex" && authRequiredMessages.has(message)) this.auth.healCodex();
    this.rt.host.db.transaction((tx) => {
      saveCommandState(tx, threadId, `first_${threadId}`, "failed", { code: refusal(cause).code, message, step });
      saveBinding(tx, threadId, { error: message });
      saveStatus(tx, threadId, "error");
      appendStartProgress(tx, threadId, [{ key: "error", text: message, status: "failed" }], "failed");
    });
    this.rt.notify(threadId, ["system/thread-provisioning"]);
    void this.children.noticeCloudParent(threadId, "not_started", "start", message).catch((error: unknown) => this.rt.host.warn("A child report could not be sent", error, { threadId }));
  }

  progress(threadId: string, steps: StartStep[], block?: "completed" | "failed"): void {
    if (this.rt.host.db.transaction((tx) => appendStartProgress(tx, threadId, steps, block))) this.rt.notify(threadId, ["system/thread-provisioning"], false);
  }

  retractQueuedHistory(threadId: string): void {
    const queued = queuedPrompts(this.rt.host.db, threadId).map((c) => c.id);
    if (retractStillQueuedPrompts(this.rt.host.db, threadId, queued)) this.rt.host.notifyThread(threadId, ["history-rewritten"]);
  }

  holdRejectedStart(threadId: string): void {
    const saved = binding(this.rt.host.db, threadId);
    const initial = command(this.rt.host.db, `first_${threadId}`);
    const backgroundPreparation = initial && z.object({ backgroundPreparation: z.boolean().optional() }).parse(JSON.parse(initial.input)).backgroundPreparation;
    if (saved && !saved.sessionId && !backgroundPreparation && saved.error?.startsWith("Cloudroom rejected the request (HTTP 409)")) {
      this.failStart(threadId, "This cloud start was rejected before the app update. Your prompt is saved. Retry explicitly when ready.", undefined, "update");
    }
  }

  /** An archived thread never starts, even when archived while its sandbox wakes, and a Cloud parent's child
   *  waits until the parent's Core confirms it (ADR 0229). */
  mustNotStart(threadId: string): boolean {
    const thread = this.rt.host.getThread(threadId);
    const initial = command(this.rt.host.db, `first_${threadId}`);
    return !thread || Boolean(thread.archivedAt || thread.deletedAt) || (initial !== null && JSON.parse(initial.input).awaiting_core === true);
  }
}
