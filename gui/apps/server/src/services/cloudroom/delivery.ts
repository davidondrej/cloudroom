import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { cloudroomCommands } from "@cloudroom/db";
import { cloudLoginProvider, COMPUTER, PERSONAL_PROJECT_ID, type PromptInput } from "@cloudroom/domain";
import { ApiError } from "../../errors.js";
import type { CloudAccountAuth } from "./account-auth.js";
import { antigravitySignInRequired, CloudroomClient, CloudroomError } from "./client.js";
import type { CloudChildren } from "./children.js";
import { appRequestId } from "./cloud-threads.js";
import { CLOUD_HARNESSES, HARNESS_NAMES, isCloudProvider, projectFollowUp, projectInitialPrompt, type StartStep } from "./events.js";
import { CHILD_HINT, cloudForkOf, codeFromOf, FORK_HINT, startCloudFork, threadCode } from "./fork.js";
import { macHarnessVersions } from "./harness-versions.js";
import type { CloudLifecycle } from "./lifecycle.js";
import type { CloudMessaging } from "./messaging.js";
import { helperDevice } from "./previews.js";
import { copyKey, localFilesNote, localProjectNote, localProjectPath, planNewProjectCopy, reportProjectCopy, workspaceId, workspaceName, writeFilesState } from "./project-copy.js";
import { syncLoopEnv } from "./project-loops.js";
import {
  capabilitiesSchema,
  cloudPromptLimit,
  cloudStep,
  cloudTextContent,
  connectionFailure,
  coreModel,
  feature,
  harnessProfile,
  modelPickSchema,
  publicError,
  refusal,
  refused,
  requireClaudeSkillSupport,
  roomIds,
  ROOT_WORKSPACE,
  sandboxTransition,
  sessionNotFound,
  slowSandbox,
  STALE_REWAKES,
  staleSandboxAddress,
  unreachableSandbox,
  unsentWork,
  WEBSITE_CHILD,
  type Capabilities,
} from "./protocol.js";
import type { CloudQueue } from "./queue.js";
import type { CloudRuntime } from "./runtime.js";
import { CLOUD_REGION, SANDBOX_PREFIX, SandboxAsleep, sandboxThread, startRefused } from "./sandboxes.js";
import type { CloudStatusPreviews } from "./status-previews.js";
import { baseBranch, binding, bindings, command, commands, openBinding, openBindings, projectCopyProgress, saveBinding, saveCommandState, TIMED_OUT, unsentDeletes, type Binding, type Command, type OpenBinding } from "./store.js";
import type { CloudStream } from "./stream.js";
import { importCodexLogin, setupSync } from "./sync.js";
import type { CloudTransfers } from "./transfers.js";

/**
 * Outbox scheduler and delivery pipeline:
 *   wake -> ensureSession -> flushOutbox -> handleDeliveryError
 */
export class CloudDelivery {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopWatching: (() => void) | null = null;

  constructor(
    private readonly rt: CloudRuntime,
    private readonly auth: CloudAccountAuth,
    private readonly statusPreviews: CloudStatusPreviews,
    private readonly transfers: CloudTransfers,
    private readonly children: CloudChildren,
    private readonly lifecycle: CloudLifecycle,
    private readonly queue: CloudQueue,
    private readonly messaging: CloudMessaging,
    private readonly stream: CloudStream,
  ) {}

  private onThreadWatched(threadId: string): void {
    if (this.rt.stopped) return;
    const row = openBinding(this.rt.host.db, threadId);
    if (row && this.needsDelivery(row)) void this.deliver(row.threadId).catch(() => {});
  }

  start(): void {
    if (this.timer) return;
    this.rt.stopped = false;
    void macHarnessVersions(); // Warm, so the first Cloud wake does not wait on 5 CLIs.
    this.stopWatching = this.rt.host.onThreadWatched((threadId) => this.onThreadWatched(threadId));
    void this.rt.me().catch(() => {});
    this.rt.sync.start();
    void this.children.deliverChildReports();
    for (const saved of bindings(this.rt.host.db)) {
      this.messaging.holdRejectedStart(saved.threadId);
      this.transfers.pauseCutCopy(saved.threadId);
      if (this.rt.host.db.transaction((tx) => projectInitialPrompt(tx, saved.threadId))) this.rt.notify(saved.threadId, ["client/turn/requested"]);
      this.messaging.retractQueuedHistory(saved.threadId);
    }
    this.statusPreviews.resetOnboardingDue();
    void this.statusPreviews.reportOnboarding();
    void this.auth.syncLogins();
    void this.auth.uploadMacConfig();
    void this.statusPreviews.warmRecentProject().catch(() => {});
    this.timer = setInterval(() => {
      this.rt.host.hooks.teleportRecovery?.();
      void this.auth.uploadMacConfig(); // Rate-limited to once a minute; only changed skills are sent.
      void this.statusPreviews.reportOnboarding();
      if (this.rt.lastCapabilities) void this.statusPreviews.ensurePreviews(this.rt.lastCapabilities);
      void this.rt.sandboxes.discover().catch(() => {});
      void this.statusPreviews.reportMacAccess().catch(() => {});
      for (const row of openBindings(this.rt.host.db)) if (this.needsDelivery(row)) void this.deliver(row.threadId).catch(() => {});
    }, 1500);
    this.timer.unref();
    const epoch = this.rt.epoch;
    void this.rt.dropRetiredVm().then(async (saved) => {
      if (!saved?.token || this.rt.stopped || epoch !== this.rt.epoch) return;
      const capabilities = capabilitiesSchema.parse(await (await this.rt.client()).capabilities());
      if (this.rt.stopped || epoch !== this.rt.epoch) return;
      this.rt.lastCapabilities = capabilities;
      await Promise.all([
        capabilities.sync
          ? setupSync(this.rt.host.deps).then(() => { if (epoch === this.rt.epoch) this.statusPreviews.syncIssue = null; })
              .catch((error) => { if (epoch === this.rt.epoch) this.statusPreviews.syncIssue = publicError(error); })
          : Promise.resolve(),
        this.statusPreviews.ensurePreviews(capabilities),
      ]);
    }).catch((error) => {
      if (epoch === this.rt.epoch) this.statusPreviews.syncIssue = `Skills and settings sync could not start. Cloud sessions are unaffected. Cause: ${error instanceof Error ? error.message : String(error)}`;
    });
  }

  stop(): void {
    this.rt.epoch++;
    this.auth.resetOnStop();
    this.statusPreviews.resetOnStop();
    this.rt.stopped = true;
    this.rt.sync.stop();
    this.stopWatching?.();
    this.stopWatching = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.rt.clearAllStreamsAndIssues();
  }

  /** Compact, rewind and goal wait while Core wakes a sleeping agent; the 1.5 s timer keeps retrying them meanwhile. */
  async deliverWhenAwake(threadId: string): Promise<void> {
    for (const deadline = Date.now() + 60_000; ;) {
      try { return await this.deliver(threadId); }
      catch (error) { if (!(error instanceof ApiError && error.body.code === "session_waking") || Date.now() > deadline) throw error; }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  deliver(threadId: string): Promise<void> {
    const entry = this.rt.state(threadId);
    if (entry.delivery) return entry.delivery.then(() => this.deliver(threadId));
    const work = this.deliverPending(threadId).finally(() => {
      const current = this.rt.peek(threadId);
      if (current?.delivery === work) current.delivery = undefined;
    });
    entry.delivery = work;
    return work;
  }

  /** The 1.5 s tick skips threads with nothing to do: a live stream with nothing unsent, or a sandbox found asleep
   *  since the last awake-list check, failed or not, and not woken here since. Everything else goes through deliver() as before. */
  private needsDelivery(row: OpenBinding): boolean {
    const entry = this.rt.peek(row.threadId);
    // A fresh side chat stays unstarted until its first message so the user can pick any harness first.
    if (!row.sessionId && row.status === "idle" && !row.sending) return false;
    if (!row.sessionId || row.sending || entry?.connectionIssues?.delivery) return true;
    const live = Boolean(entry?.stream);
    // A Cloud thread streams here only while it's open on a screen here, a turn this computer sent runs, or this
    // computer acts for it (home). A computer is home for every thread only it prompts (docs/scopes/cloud-threads.md App 4).
    // A thread shown running streams until its turn ends, so no computer is left showing it running for good.
    if (!this.rt.host.watching(row.threadId) && !this.rt.isHome(row.threadId) && !["pending", "starting", "active", "stopping"].includes(row.status)) {
      if (live) this.rt.detach(row.threadId);
      return false;
    }
    if (!live && ["pending", "starting", "active", "stopping"].includes(row.status)) return true;
    const sandbox = sandboxThread(row.coreUrl);
    if (!live && sandbox && entry?.sleptAtCheck === this.rt.sandboxes.awakeChecks && !this.rt.sandboxes.isAwake(sandbox)) {
      if (sandbox === row.threadId && this.rt.host.watching(row.threadId)) void this.stream.readHistory(row.threadId);
      return false;
    }
    if (sandbox && sandbox !== row.threadId && !row.parentThreadId && entry?.leftParent !== row.sessionId) return true;
    return !live;
  }

  /** A note for a sandbox agent's next prompt once the account has used 80 %, then 95 %, of its Cloud Credits, plan
   *  and packs together (#610). Reads only the usage the app already caches, never asking the website. It sits in the
   *  agent-only custom instructions envelope, which every app and the phone already hide from the user. */
  private creditsNote(threadId: string, coreUrl: string, capabilities: Capabilities): { note: string; level: number } | null {
    const sandbox = sandboxThread(coreUrl), usage = sandbox ? this.rt.sandboxes.planUsage(false) : null;
    if (!sandbox || !usage || usage.credits === null) return null;
    const total = usage.creditsLimit + usage.extraCreditsTotal;
    const left = Math.max(0, usage.creditsLimit - usage.credits) + usage.extraCredits;
    const used = total > 0 ? 1 - left / total : 1, level = used >= 0.95 ? 95 : used >= 0.8 ? 80 : 0;
    const entry = this.rt.state(threadId);
    // Usage that falls back (old usage ages out, a pack) lowers the level, so a later climb tells again.
    if (level < entry.creditsTold) entry.creditsTold = level;
    // A VPS thread uses no credits; placement the app hasn't heard from the website gets no note, and no lookup.
    if (level <= entry.creditsTold || !this.rt.sandboxes.knownInCloud(sandbox)) return null;
    const check = feature(capabilities, "credits_usage") ? " Run `room-cli usage` before a big fan-out." : "";
    return { level, note: `<cloudroom_custom_instructions>\n[Cloud Credits] This account has used ${Math.floor(used * 100)}% of its Cloud Credits (${Math.floor(left).toLocaleString("en-US")} left). When none are left, its Cloud sandboxes stop, even mid-turn. Don't start sandboxes it doesn't need.${check}\n</cloudroom_custom_instructions>` };
  }

  /** The agent-only text after a prompt: its workspace hint if it fits, then the Cloud Credits note if that fits too.
   *  A level counts as told only once its note goes out. A built-in command typed alone (`/clear`) gets no note: the
   *  four that skip custom instructions. Cloud refuses them as picked commands, so only their text can tell. */
  private promptContext(threadId: string, coreUrl: string, capabilities: Capabilities, typed: string, text: string, hint: string | null): string | null {
    const fits = (context: string) => Buffer.byteLength(`${text}\n\n${context}`, "utf8") <= cloudPromptLimit(capabilities);
    const context = hint && fits(hint) ? hint : null;
    const credits = /^\/(?:compact|clear|teleport|context)$/.test(typed.trim()) ? null : this.creditsNote(threadId, coreUrl, capabilities);
    const noted = credits && [context, credits.note].filter(Boolean).join("\n\n");
    if (!credits || !noted || !fits(noted)) return context;
    this.rt.state(threadId).creditsTold = credits.level;
    return noted;
  }

  private async deliverPending(threadId: string): Promise<void> {
    this.rt.state(threadId).sleptAtCheck = undefined;
    this.messaging.holdRejectedStart(threadId);
    let saved = binding(this.rt.host.db, threadId);
    if (!saved || this.rt.stopped || await this.rt.otherAccountThread(saved)) return;
    const firstCommand = command(this.rt.host.db, `first_${threadId}`);
    if (!saved.sessionId && (commands(this.rt.host.db, threadId).some((item) => item.command === "teleport") || firstCommand?.state === "failed" || (firstCommand?.command === "side_chat" && firstCommand.state === "completed" && !commands(this.rt.host.db, threadId, "sending").length) || this.messaging.mustNotStart(threadId))) return;
    const epoch = this.rt.epoch;
    // `step` is the step that failed, sent with a never-started prompt's failure (#1398).
    // `releaseCopy`: a new thread's project copy waits until its first message is sent or fails (ADR 0160).
    const ctx = { deliveringCommand: false, rejectedCommand: false, step: "wake", releaseCopy: undefined as (() => void) | undefined, client: undefined as CloudroomClient | undefined };
    try {
      const bound = saved;
      let catchUp = false;
      const client = await this.rt.client(saved, () => !bound.sessionId || unsentWork(this.rt.host.db, threadId) || (catchUp ||= this.children.catchUpForParent(bound)));
      ctx.client = client;
      ctx.step = "capabilities";
      if (epoch !== this.rt.epoch) return;
      if (saved.sessionId) {
        this.stream.follow(saved, client);
        await this.children.leaveFormerParent(saved, client);
        if (!commands(this.rt.host.db, threadId).some((c) => c.state === "sending")) { this.rt.setConnectionIssue(threadId, "delivery"); return; }
      }
      const sandbox = sandboxThread(saved.coreUrl);
      const known = sandbox ? await this.rt.savedCapabilities() : null;
      const cached = known && harnessProfile(known, this.rt.host.getThread(threadId)?.providerId ?? "") ? known : null;
      const capabilities = cached ?? await this.rt.capabilities(client);
      if (epoch !== this.rt.epoch) return;
      if (!cached) await this.rt.rememberCapabilities(capabilities, Boolean(sandbox));
      // Tells the sandbox which Mac uses this thread, the only one a sleeping Mac's pairing may move to (#608).
      if (sandbox && capabilities.mac_device) client.macDevice = await helperDevice(this.rt.host.deps) ?? undefined;
      let recovered = false;
      if (!saved.sessionId) {
        const started = await this.ensureSession(threadId, saved, client, capabilities, sandbox, ctx);
        if (!started) return;
        saved = started;
      }
      if (epoch !== this.rt.epoch) return;
      this.stream.follow(saved, client);
      let flushed: number;
      try {
        flushed = await this.flushOutbox(threadId, saved, client, capabilities, sandbox, epoch, ctx);
      } catch (error) {
        if (sandbox !== threadId || !saved.sessionId || !sessionNotFound(error)) throw error;
        const fresh = await this.recoverMissingSession(threadId, saved, client, capabilities, sandbox, epoch, ctx);
        if (!fresh) throw error;
        saved = fresh;
        recovered = true;
        if (epoch !== this.rt.epoch) return;
        this.stream.follow(saved, client);
        flushed = await this.flushOutbox(threadId, saved, client, capabilities, sandbox, epoch, ctx, true);
      }
      if (epoch !== this.rt.epoch) return;
      this.rt.setConnectionIssue(threadId, "delivery");
      this.rt.state(threadId).rewoken = 0;
      if (flushed > 0 || recovered) this.rt.notify(threadId);
    } catch (error) {
      if (epoch !== this.rt.epoch) return;
      this.handleDeliveryError(threadId, saved, error, ctx);
    } finally { ctx.releaseCopy?.(); }
  }

  /** When a thread's own sandbox woke fresh without its old Core session (e.g. archived loop/subagent whose R2 backup
   *  was skipped or pruned), verify Core genuinely lacks that session, reset the stale binding, and start a fresh one
   *  while preserving all earlier timeline history. */
  private async recoverMissingSession(
    threadId: string,
    saved: Binding,
    client: CloudroomClient,
    capabilities: Capabilities,
    sandbox: string,
    epoch: number,
    ctx: { deliveringCommand: boolean; step: string; releaseCopy?: () => void },
  ): Promise<Binding | null> {
    const oldSession = saved.sessionId;
    if (!oldSession) return null;
    const { sessions } = await client.listSessions();
    if (epoch !== this.rt.epoch || sessions.some((item) => item.session_id === oldSession)) return null;
    this.rt.detach(threadId);
    this.rt.setConnectionIssue(threadId, "stream");
    const startRequestId = `${saved.startRequestId?.startsWith(WEBSITE_CHILD) ? WEBSITE_CHILD : ""}${randomUUID()}`;
    this.rt.host.db.transaction((tx) => {
      saveBinding(tx, threadId, { sessionId: null, startRequestId, cursor: 0, nativeId: null, turnId: null, error: null });
      this.rt.host.markInstructionsLost(tx, threadId);
    });
    const known = this.rt.threadStates.get(threadId);
    this.rt.threadStates.set(threadId, { home: null, from: null, ...known, session: "", actFrom: 0, history: undefined, before: [oldSession, ...known?.before ?? []].slice(0, 5) });
    const reset = binding(this.rt.host.db, threadId);
    if (!reset) return null;
    return this.ensureSession(threadId, reset, client, capabilities, sandbox, ctx, true);
  }

  private async ensureSession(
    threadId: string,
    saved: Binding,
    client: CloudroomClient,
    capabilities: Capabilities,
    sandbox: string | null,
    ctx: { deliveringCommand: boolean; step: string; releaseCopy?: () => void },
    recovery = false,
  ): Promise<Binding | null> {
    if (this.messaging.mustNotStart(threadId)) return null;
    ctx.deliveringCommand = true;
    ctx.step = "start";
    const thread = this.rt.host.getThread(threadId);
    const harness = thread?.providerId;
    if (!isCloudProvider(harness)) throw new ApiError(409, "cloudroom_harness", "Unsupported cloud harness; native execution is blocked.");
    const initial = command(this.rt.host.db, `first_${threadId}`);
    // Recovering a thread whose previous session vanished on a fresh sandbox: never re-run old fork/side-chat/code_from,
    // and fall back to the thread's current project & settings when there is no local first command (e.g. adopted loops).
    const recovering = recovery || !initial || (initial.command === "prompt" && initial.state !== "sending");
    if (!recovering) this.messaging.progress(threadId, [cloudStep(Boolean(sandbox), "completed"), { key: "agent", text: `Starting ${HARNESS_NAMES[harness]}`, status: "started" }]);
    const { model, provider } = coreModel(harness, saved.model, capabilities);
    const options = initial ? z.object({ workspace: z.string().optional(), workspace_name: z.string().optional(), provider: z.string().optional(), command_guard_enabled: z.boolean().optional(), strip_ai_co_authors: z.boolean().optional(), system_prompt: z.string().optional() }).parse(JSON.parse(initial.input)) : {};
    if (recovering && thread) {
      const project = this.rt.host.getProject(thread.projectId);
      if (!options.workspace && project) {
        Object.assign(options, project.id === PERSONAL_PROJECT_ID ? { workspace: ROOT_WORKSPACE } : { workspace: workspaceId(project.id), workspace_name: workspaceName(project.name) });
      }
      const settings = this.rt.host.getAppSettings();
      options.command_guard_enabled ??= settings.commandGuardEnabled;
      options.strip_ai_co_authors ??= settings.stripAiCoAuthorsEnabled;
      if (!options.system_prompt) {
        const projectNote = project && project.id !== PERSONAL_PROJECT_ID ? await localProjectNote(this.rt.host.deps, project.id) : undefined;
        options.system_prompt = this.rt.host.buildSystemPrompt(threadId, thread.projectId, this.rt.sandboxes.vpsConnected, projectNote);
      }
    }
    if (!capabilities.command_guard) delete options.command_guard_enabled;
    if (!capabilities.strip_ai_co_authors) delete options.strip_ai_co_authors;
    if (!capabilities.system_prompt) delete options.system_prompt;
    if (!capabilities.direct_workspaces) throw new ApiError(503, "cloudroom_update", "Update the cloud core to start agents without copying files. Your message is saved.");
    if (options.workspace === ROOT_WORKSPACE && !capabilities.root_workspace) throw new ApiError(503, "cloudroom_update", "Update the cloud core to start agents outside a project. Your message is saved.");
    if (harness === "codex" && capabilities.codex_auth_import && !sandbox) await importCodexLogin(this.rt.host.deps);
    if (harness === "pi") await this.auth.copyPiSetup(client, Boolean(sandbox));
    const fork = recovering ? null : cloudForkOf(initial?.input);
    const sideChat = !recovering && initial?.command === "side_chat" ? z.object({ side_chat: z.string() }).parse(JSON.parse(initial.input)).side_chat : null;
    const codeFrom = recovering ? undefined : codeFromOf(initial?.input);
    // A Cloud parent's child reports its own turns, and takes tell, stop and archive, through the website (ADR 0259).
    // Only a parent with a sandbox of its own has a link there; children of one sharing a sandbox keep the app's path.
    const relayed = Boolean(codeFrom && this.rt.host.getThread(threadId)?.parentThreadId === codeFrom && capabilities.relay && binding(this.rt.host.db, codeFrom)?.coreUrl === SANDBOX_PREFIX + codeFrom);
    if (relayed && initial && !JSON.parse(initial.input).parent_thread) {
      this.rt.host.db.update(cloudroomCommands).set({ input: JSON.stringify({ ...JSON.parse(initial.input), parent_thread: codeFrom }) }).where(eq(cloudroomCommands.id, initial.id)).run();
    }
    const parentThread = relayed ? { parent_thread: codeFrom } : {};
    const target = options.workspace && options.workspace !== ROOT_WORKSPACE ? options.workspace : null;
    if (fork && !capabilities.fork) throw new ApiError(503, "cloudroom_update", "Update the cloud core to fork Cloud threads. Your message is saved.");
    const plan = { key: copyKey(sandbox, target ?? ""), branch: recovering ? undefined : baseBranch(initial?.input) };
    // The project's loops get its current .env files (ADR 20261101-004659).
    if (target) syncLoopEnv(this.rt.host.deps, this.rt.sandboxes, thread?.projectId);
    const failure = (error: unknown) => error instanceof Error ? error : new Error(String(error));
    // A copy that can't be planned fails where the user and `room-cli files wait` see it, never as nothing to copy (#337).
    const [planned, started] = await Promise.all([
      target ? planNewProjectCopy(this.rt.host.deps, client, threadId, target, plan).catch(failure) : null,
      sideChat
        ? this.lifecycle.startSideChat(client, threadId, saved, capabilities, harness, sideChat)
        : fork
          ? startCloudFork(this.rt.host.deps, client, threadId, fork, {
              model, provider: provider ?? null, reasoning: saved.reasoning, service_tier: z.object({ service_tier: z.string().optional() }).parse(JSON.parse(initial!.input)).service_tier ?? null,
              workspace: options.workspace ?? ROOT_WORKSPACE, workspace_name: options.workspace_name ?? ROOT_WORKSPACE,
              ...(options.command_guard_enabled === undefined ? {} : { command_guard_enabled: options.command_guard_enabled }),
              ...(options.strip_ai_co_authors === undefined ? {} : { strip_ai_co_authors: options.strip_ai_co_authors }),
              ...(options.system_prompt ? { system_prompt: options.system_prompt } : {}),
              ...roomIds(capabilities, threadId, thread?.projectId),
            }, (patch) => {
              const latest = command(this.rt.host.db, `first_${threadId}`)!;
              this.rt.host.db.update(cloudroomCommands).set({ input: JSON.stringify({ ...JSON.parse(latest.input), fork: { ...fork, ...patch } }) }).where(eq(cloudroomCommands.id, latest.id)).run();
            })
          : client.start(saved.startRequestId, CLOUD_HARNESSES[harness], { model, reasoning: !recovering && initial && JSON.parse(initial.input).default_reasoning ? undefined : saved.reasoning, ...options, ...parentThread, ...roomIds(capabilities, threadId, thread?.projectId), ...(provider ? { provider } : {}) }).then((accepted) => {
              const transfer = `child_${threadId}`;
              return { sessionId: accepted.session_id, transfer, code: codeFrom ? threadCode(this.rt.host.deps, codeFrom, transfer) : null };
            }),
    ]);
    // A side chat switched agent or model while this start ran: drop the old session; the next tick starts the new one.
    const now = binding(this.rt.host.db, threadId);
    if (sideChat && (this.rt.host.getThread(threadId)?.providerId !== harness || now?.model !== saved.model || now?.startRequestId !== saved.startRequestId)) {
      void client.close(started.sessionId, randomUUID()).catch(() => {});
      return null;
    }
    if (harness === "acp-antigravity" && !fork) {
      const failure = await this.lifecycle.startFailure(client, started.sessionId, true);
      if (failure) {
        // Core stored a terminal receipt for this start. Retry with a fresh ID, preserving the first prompt.
        saveBinding(this.rt.host.db, threadId, { startRequestId: randomUUID() });
        if (cloudLoginProvider(failure) === harness)
          throw new CloudroomError(antigravitySignInRequired, 409, "antigravity_auth_required");
        if (failure.includes("Antigravity no longer offers the selected model"))
          void this.rt.sandboxes.antigravityLogin({ action: "refresh", rejectedModel: true }).catch(() => {});
        throw new ApiError(400, "cloudroom_start_failed", failure);
      }
    }
    const copy = planned instanceof Error ? null : planned;
    // Like any failed copy, the card shows only for a project with no folder on the Mac; otherwise only the agent
    // is told, and pulls what it needs (docs/scopes/sandboxes.md, David, 2026-10-13).
    const macPath = planned instanceof Error ? localProjectPath(this.rt.host.deps, thread?.projectId ?? "") : undefined;
    const unplanned = planned instanceof Error ? `The copy could not start: ${planned.message}`.slice(0, 500) + (macPath ? ` ${localFilesNote(macPath)}` : "") : undefined;
    // A sandbox too slow to answer in time gets one more try when the thread's stream connects, like a copy the app
    // cut off (#1040). The error is kept, so that try fails as this one would have. A fork's code can't wait for it.
    const replan = planned instanceof Error && !started.code && slowSandbox(planned, TIMED_OUT);
    if (unplanned) this.rt.host.warn("Cloud project copy could not be planned", planned, { threadId });
    if (unplanned && !replan && !macPath) reportProjectCopy(this.rt.host.deps, threadId, { phase: "error", completed: 0, total: 0, error: unplanned });
    const copying = copy?.clone && copy.repository ? `Cloning ${copy.repository.replace(/^https:\/\/(?:github\.com\/)?/, "")}` : copy?.copyAll ? `Copying project from your ${COMPUTER}` : null;
    const files: StartStep[] = copying ? [{ key: "files", text: copying, status: "started" }] : [];
    const forkCode: StartStep[] = started.code ? [{ key: "fork", text: "Copying the source thread's code", status: "started" }] : [];
    if (!recovering) this.messaging.progress(threadId, [{ key: "agent", status: "completed" }, ...files, ...forkCode], "completed");
    const firstSent = new Promise<void>((resolve) => { ctx.releaseCopy = resolve; });
    ctx.step = "workspace";
    const entry = this.rt.state(threadId);
    // `room-cli files wait` holds the agent until the files, a fork's code, and its own sandbox's branch are ready
    // (ADR 0209). The mark lands before the first message: an unmarked folder with files reads as done, so an agent
    // could start mid-checkout (#816). A Git checkout already there (a project template) still gets its branch.
    // A child in a Personal project has no workspace of its own, so its status file sits next to the sandbox root.
    // The session is saved only after the status, so a failed check or write starts it again on the next try (Core
    // keeps the same session) instead of sending the first message with setup unmarked.
    // After 3 failed tries the start fails where the user sees it; a permanent error fails it at once.
    const workspace = await (async () => {
      // Core's 404 means no workspace, like `client.workspace`; any other error tries again.
      const lookup = () => client.sessionWorkspace(started.sessionId).catch((error: unknown) => {
        if (error instanceof CloudroomError && error.status === 404) return null;
        throw error;
      });
      const folder = target && (files.length || started.code || unplanned || sandbox === threadId && (await lookup())?.head) ? target
        : started.code ? (await lookup())?.path ?? null : null;
      if (folder) await writeFilesState(client, folder, "copying", false, files.length > 0 && !started.code);
      entry.prepTries = 0;
      return folder;
    })().catch((error: unknown) => {
      entry.prepTries += 1;
      if (entry.prepTries < 3) throw error;
      entry.prepTries = 0;
      throw new ApiError(400, "cloudroom_files", `Cloudroom could not prepare the project folder: ${error instanceof Error ? error.message : String(error)}`);
    });
    saveBinding(this.rt.host.db, threadId, { sessionId: started.sessionId, error: null });
    if (recovering) {
      const prev = this.rt.threadStates.get(threadId);
      this.rt.threadStates.set(threadId, { home: null, from: null, ...prev, session: started.sessionId, actFrom: 0, history: undefined });
      this.children.syncLabel(threadId, "switch");
    }
    entry.refusedSince = undefined;
    const updated = binding(this.rt.host.db, threadId)!;
    const landed = this.transfers.landing(threadId, client, started, files.length > 0, workspace, workspace ? Promise.resolve() : null);
    if (copy) this.transfers.copy(client, started.code ? { ...copy, forkCode: true } : copy, landed, firstSent);
    else if (replan && workspace) reportProjectCopy(this.rt.host.deps, threadId, { phase: "waiting", completed: 0, total: 0, error: unplanned });
    else if (workspace || started.code) void landed(unplanned);
    else if (sandbox) void this.transfers.ensureBranch(threadId, true);
    return updated;
  }

  private async flushOutbox(
    threadId: string,
    saved: Binding,
    client: CloudroomClient,
    capabilities: Capabilities,
    sandbox: string | null,
    epoch: number,
    ctx: { deliveringCommand: boolean; rejectedCommand: boolean; step: string },
    recovered = false,
  ): Promise<number> {
    const sessionId = saved.sessionId!, harness = this.rt.host.getThread(threadId)?.providerId;
    // Queue deletes go first, so a message that can't be sent yet never holds one back.
    const pendingCommands = commands(this.rt.host.db, threadId).filter((c) => c.state === "sending").sort((a, b) => Number(b.command === "cancel") - Number(a.command === "cancel"));
    ctx.step = "deliver";
    for (const pending of pendingCommands) {
      if (epoch !== this.rt.epoch) return 0;
      // A Stop may cancel work after this list was read (#1699): never send it.
      if (command(this.rt.host.db, pending.id)?.state !== "sending") continue;
      // Nor a message whose delete is on its way, even one saved mid-pass: Core's answer to the delete settles it.
      if (pending.command === "prompt" && unsentDeletes(this.rt.host.db, threadId).has(pending.id)) continue;
      ctx.deliveringCommand = true;
      try {
        const result = await this.dispatchCommand(threadId, saved, sessionId, harness, client, capabilities, sandbox, pending, recovered);
        if (result && command(this.rt.host.db, pending.id)?.state === "sending") saveCommandState(this.rt.host.db, threadId, pending.id, result.receipt.state);
        if (result && pending.command === "prompt") void this.statusPreviews.rememberCloudMessage(sessionId, pending.id, epoch).catch(() => {});
      } catch (error) {
        // Keep pending prompts unsent so deliverPending can start a fresh session when a pruned sandbox lacks the old one.
        if (!recovered && sandbox === threadId && sessionNotFound(error) && commands(this.rt.host.db, threadId, "sending").some((c) => c.command === "prompt")) throw error;
        const action = await this.handleCommandRefusal(threadId, saved, pending, error, ctx);
        if (action === "return") return 0;
        if (action === "continue") continue;
        throw error;
      }
    }
    return pendingCommands.length;
  }

  private async dispatchCommand(
    threadId: string,
    saved: Binding,
    sessionId: string,
    harness: string | undefined,
    client: CloudroomClient,
    capabilities: Capabilities,
    sandbox: string | null,
    pending: Command,
    recovered = false,
  ) {
    if (pending.command === "title") {
      const thread = this.rt.host.getThread(threadId);
      if (!thread?.title && this.rt.host.canInferMetadata()) {
        try {
          const input = z.object({ input: z.array(z.unknown()) }).parse(JSON.parse(pending.input));
          void this.rt.host.inferMetadata({ input: input.input as PromptInput[], provisioningId: saved.startRequestId, threadId }).then(() => this.transfers.ensureBranch(threadId, false)).catch(() => {});
        } catch { /* keep fallback title */ }
      }
      if (command(this.rt.host.db, pending.id)?.state === "sending") saveCommandState(this.rt.host.db, threadId, pending.id, "completed");
      void this.transfers.ensureBranch(threadId, false);
      return null;
    }
    if (pending.command === "unarchive_session") {
      await this.rt.inArchiveOrder(sandbox ?? threadId, async () => {
        if (command(this.rt.host.db, pending.id)?.state !== "sending") return;
        if (this.rt.host.getThread(threadId)?.archivedAt !== null || JSON.parse(pending.input).session !== sessionId) {
          saveCommandState(this.rt.host.db, threadId, pending.id, "cancelled");
          return;
        }
        if (feature(capabilities, "cloud_threads")) await client.archiveSession(sessionId, pending.id, false);
        if (command(this.rt.host.db, pending.id)?.state === "sending") saveCommandState(this.rt.host.db, threadId, pending.id, "completed");
      });
      return null;
    }
    if (pending.command === "side_chat") { saveCommandState(this.rt.host.db, threadId, pending.id, "completed"); return null; }
    if (pending.command === "prompt") {
      const parsed = z.object({
        text: z.string(), reasoning: z.string().optional(), content: z.unknown().optional(),
        attachments: z.array(z.object({ name: z.string(), kind: z.enum(["image", "file"]), localPath: z.string().optional(), path: z.string().optional(), id: z.string().optional() })).optional(),
        service_tier: z.string().optional(), customInstructions: z.string().default(""), workspaceContext: z.string().nullable().optional(), modelPickId: z.string().optional(),
        sender_thread_id: z.string().optional(),
      }).parse(JSON.parse(pending.input));
      requireClaudeSkillSupport(parsed.content, capabilities, harness);
      if (parsed.modelPickId && !["accepted", "completed"].includes(command(this.rt.host.db, parsed.modelPickId)?.state ?? "")) {
        throw new ApiError(409, "model_unavailable", "The selected model could not be applied. Your message was not sent.");
      }
      if (parsed.attachments?.length && !capabilities.attachments) throw new ApiError(400, "cloudroom_unsupported", "Update the cloud core to use attachments. Your message is saved.");
      const attachments = capabilities.attachments ? await this.queue.uploadAttachments(client, sessionId, pending.id, parsed.attachments ?? [], this.rt.host.getThread(threadId)?.projectId ?? "", capabilities.upload_parts) : [];
      // An upload can take minutes: a delete or a Stop saved meanwhile still wins.
      if (command(this.rt.host.db, pending.id)?.state !== "sending" || unsentDeletes(this.rt.host.db, threadId).has(pending.id)) return null;
      const enriched = this.rt.host.prepareInstructionInput({ text: parsed.text, content: cloudTextContent(parsed.content) }, parsed.customInstructions, cloudPromptLimit(capabilities));
      // A fork's first message is a native fork of the copied conversation (fork.ts).
      const fork = pending.id === `first_${threadId}` ? cloudForkOf(pending.input) : null;
      const child = pending.id === `first_${threadId}` && Boolean(JSON.parse(pending.input).code_from);
      let context = parsed.workspaceContext;
      if (context === undefined || (recovered && !context)) {
        const copying = (pending.id === `first_${threadId}` || recovered) && ["cloning", "uploading", "waiting"].includes(projectCopyProgress(this.rt.host.db, threadId)?.phase ?? "");
        const hint = fork || (child && this.rt.host.getThread(threadId)?.originKind === "fork") ? FORK_HINT : child ? CHILD_HINT : copying ? `[Cloud workspace context]\nThis project is new on the VM. Cloudroom is copying its files into this folder right now: a GitHub clone or an upload from the user's ${COMPUTER}, plus uncommitted edits and .env files. Run \`room-cli files wait\` before you rely on them; it returns once they land, or says why they won't. Never recreate missing files or instructions such as AGENTS.md.` : null;
        context = this.promptContext(threadId, saved.coreUrl, capabilities, parsed.text, enriched.text, hint);
        this.rt.host.db.update(cloudroomCommands).set({ input: JSON.stringify({ ...JSON.parse(pending.input), workspaceContext: context }) }).where(eq(cloudroomCommands.id, pending.id)).run();
      }
      const text = context ? `${enriched.text}\n\n${context}` : enriched.text;
      const content = context && Array.isArray(enriched.content) ? [...enriched.content, { type: "text", text: `\n${context}` }] : enriched.content;
      const options = { ...(capabilities.structured_prompt && content !== undefined ? { content: content as never } : {}), ...(attachments.length ? { attachments: attachments as never } : {}), ...(parsed.service_tier ? { service_tier: parsed.service_tier } : {}) };
      return fork
        ? client.rewind(sessionId, `fork_${threadId}`, fork.before, fork.last_turn_id, { request_id: pending.id, text, ...(parsed.reasoning ? { reasoning: parsed.reasoning } : {}), ...options }, true)
        : client.prompt(sessionId, pending.id, text, parsed.reasoning, { ...options, ...(parsed.sender_thread_id ? { sender: parsed.sender_thread_id } : {}) });
    }
    if (pending.command === "edit") {
      const parsed = z.object({
        target_request_id: z.string(), expected_revision: z.number(), text: z.string(), reasoning: z.string().optional(), content: z.unknown().optional(),
        attachments: z.array(z.object({ name: z.string(), kind: z.enum(["image", "file"]), localPath: z.string().optional(), path: z.string().optional(), id: z.string().optional() })).optional(),
        service_tier: z.string().optional(), customInstructions: z.string().default(""),
      }).parse(JSON.parse(pending.input));
      requireClaudeSkillSupport(parsed.content, capabilities, harness);
      const enriched = this.rt.host.prepareInstructionInput({ text: parsed.text, content: cloudTextContent(parsed.content) }, parsed.customInstructions, cloudPromptLimit(capabilities));
      const attachments = await this.queue.uploadAttachments(client, sessionId, pending.id, parsed.attachments ?? [], this.rt.host.getThread(threadId)!.projectId, capabilities.upload_parts);
      return client.edit(sessionId, pending.id, parsed.target_request_id, parsed.expected_revision, enriched.text, {
        ...(enriched.content === undefined ? {} : { content: enriched.content as never }), attachments: attachments as never,
        ...(parsed.reasoning ? { reasoning: parsed.reasoning } : {}), ...(parsed.service_tier ? { service_tier: parsed.service_tier } : {}),
      });
    }
    if (pending.command === "model") {
      const parsed = modelPickSchema.parse(JSON.parse(pending.input));
      // A Core that predates the switch (still awake from before a release) keeps its model, and so does the thread.
      if (!harness || !await this.messaging.switchesModels(saved.coreUrl, harness, () => this.rt.capabilities(client)) || (parsed.idleSessionId && parsed.idleSessionId !== sessionId)) {
        this.messaging.keepModel(threadId, pending);
        return null;
      }
      return client.setModel(sessionId, pending.id, parsed.model, parsed.reasoning, Boolean(parsed.idleSessionId));
    }
    if (pending.command === "cancel") return client.cancel(sessionId, pending.id, JSON.parse(pending.input).target_request_id);
    if (pending.command === "reorder") return client.reorder(sessionId, pending.id, z.object({ order: z.array(z.string()) }).parse(JSON.parse(pending.input)).order);
    if (pending.command === "steer") {
      const parsed = z.object({ target_request_id: z.string(), text: z.string(), customInstructions: z.string().default(""), attachments: z.array(z.object({ name: z.string(), kind: z.enum(["image", "file"]), localPath: z.string().optional(), path: z.string().optional(), id: z.string().optional() })).default([]) }).parse(JSON.parse(pending.input));
      if (parsed.attachments.length && !capabilities.attachments) throw new ApiError(400, "cloudroom_unsupported", "Update the cloud core to use attachments. Your message is saved.");
      // Core steers text only, so files go up first and the agent gets their paths, as Core does for prompt files.
      const uploaded = await this.queue.uploadAttachments(client, sessionId, pending.id, parsed.attachments, this.rt.host.getThread(threadId)?.projectId ?? "", capabilities.upload_parts);
      const text = [this.rt.host.prepareInstructionInput(parsed, parsed.customInstructions, cloudPromptLimit(capabilities)).text, ...uploaded.map((file) => `[Attached ${file.kind}: ${file.path}]`)].join("\n");
      return client.steer(sessionId, pending.id, parsed.target_request_id, text);
    }
    if (pending.command === "compact") return client.compact(sessionId, pending.id, z.object({ then: z.string().optional() }).parse(JSON.parse(pending.input)).then);
    if (pending.command === "goal") return client.goal(sessionId, pending.id, JSON.parse(pending.input));
    if (pending.command === "rewind") {
      const parsed = z.object({ before: z.string(), last_turn_id: z.string().optional(), customInstructions: z.string().default(""), replacement: z.object({ request_id: z.string(), text: z.string(), content: z.unknown().optional(), attachments: z.array(z.object({ name: z.string(), kind: z.enum(["image", "file"]), localPath: z.string().optional(), path: z.string().optional(), id: z.string().optional() })).optional(), reasoning: z.string().optional(), service_tier: z.string().optional() }) }).parse(JSON.parse(pending.input));
      requireClaudeSkillSupport(parsed.replacement.content, capabilities, harness);
      const enriched = this.rt.host.prepareInstructionInput({ text: parsed.replacement.text, content: cloudTextContent(parsed.replacement.content) }, parsed.customInstructions, cloudPromptLimit(capabilities));
      const attachments = await this.queue.uploadAttachments(client, sessionId, parsed.replacement.request_id, parsed.replacement.attachments ?? [], this.rt.host.getThread(threadId)!.projectId, capabilities.upload_parts);
      return client.rewind(sessionId, pending.id, parsed.before, parsed.last_turn_id, { ...parsed.replacement, ...enriched, content: enriched.content as never, attachments: attachments as never });
    }
    if (pending.command === "resume") {
      const keepPaused = JSON.parse(pending.input).keep_paused === true;
      // Cached capabilities can describe another sandbox or an older Core; never fall back to releasing Stop.
      if (keepPaused && !feature(await this.rt.capabilities(client), "resume_keep_paused")) throw new ApiError(503, "cloudroom_update", "Update the cloud core to restart this stopped agent safely. Your message is saved.");
      return client.resume(sessionId, pending.id, keepPaused);
    }
    if (pending.command === "stop" || pending.command === "sleep") {
      const { after, guarded } = pending.command === "stop" ? z.object({ after: z.string().optional(), guarded: z.boolean().optional() }).catch({}).parse(JSON.parse(pending.input)) : {};
      const scoped = after && feature(await this.rt.capabilities(client), "cloud_threads") ? after : null;
      // A stop held while the sandbox was unreachable (#1699) never goes out without its turn: it could stop a newer one.
      if (guarded && !scoped) { saveCommandState(this.rt.host.db, threadId, pending.id, "cancelled"); return null; }
      return scoped ? client.stop(sessionId, pending.id, scoped) : client[pending.command](sessionId, pending.id);
    }
    throw new CloudroomError(`Unsupported cloud command ${pending.command}`, 400);
  }

  private async handleCommandRefusal(threadId: string, saved: Binding, pending: Command, error: unknown, ctx: { rejectedCommand: boolean; step: string }): Promise<"return" | "continue" | "throw"> {
    // A stale sandbox address: the catch below wakes it again, so keep the command unsent.
    const stale = sandboxThread(saved.coreUrl) && staleSandboxAddress(error) && (this.rt.peek(threadId)?.rewoken ?? 0) < STALE_REWAKES;
    const targeted = ["steer", "edit", "cancel", "reorder"].includes(pending.command) || (pending.command === "model" && Boolean(JSON.parse(pending.input).idleSessionId));
    if (stale || !refused(error, targeted, error instanceof SandboxAsleep)) return "throw";
    if (pending.command === "steer") {
      // Usually its turn just ended. It queues ahead of anything sent after it; the same ID makes a repeat harmless.
      const { text, content, attachments, sender_thread_id } = z.object({ text: z.string(), content: z.unknown().optional(), attachments: z.array(z.unknown()).optional(), sender_thread_id: z.string().optional() }).parse(JSON.parse(pending.input));
      const id = appRequestId(await this.rt.me(), `queued-${createHash("sha256").update(pending.id).digest("hex").slice(0, 32)}`);
      this.queue.enqueue(threadId, id, "prompt", { text, ...(content === undefined ? {} : { content }), ...(attachments?.length ? { attachments } : {}), ...(sender_thread_id ? { sender_thread_id } : {}) }, pending.createdAt);
      saveCommandState(this.rt.host.db, threadId, pending.id, "failed");
      if (this.rt.host.db.transaction((tx) => projectFollowUp(tx, threadId, id))) this.rt.notify(threadId, ["client/turn/requested"]);
      void this.deliver(threadId).catch(() => {});
      return "return";
    }
    if (pending.command === "model") { this.messaging.keepModel(threadId, pending); return "continue"; }
    if (pending.command === "cancel") {
      // A refused queue delete fails its own request, never the thread. Unless the agent already runs the
      // message, one Core never confirmed is deleted here all the same: a refusal must not get it sent.
      const started = error instanceof CloudroomError && error.message.includes("queued message is already being sent");
      if (started || !this.queue.dropUnsent(threadId, pending)) saveCommandState(this.rt.host.db, threadId, pending.id, "failed", { ...refusal(error), step: ctx.step });
      return "continue";
    }
    saveCommandState(this.rt.host.db, threadId, pending.id, "failed", { ...refusal(error), step: ctx.step });
    if (pending.command === "edit" && error instanceof CloudroomError && /queued message is (no longer pending|already being sent)/.test(error.message)) return "continue";
    ctx.rejectedCommand = true;
    return "throw";
  }

  private handleDeliveryError(threadId: string, saved: Binding, error: unknown, ctx: { deliveringCommand: boolean; rejectedCommand: boolean; step: string; client?: CloudroomClient }): void {
    // A stale sandbox address: forget it and wake it again, a few times, before failing the thread's start
    // (feedback #596, #1076). The 1.5 s delivery timer makes the next try.
    const sandbox = sandboxThread(saved.coreUrl), stale = Boolean(sandbox) && staleSandboxAddress(error);
    const entry = this.rt.state(threadId);
    if (sandbox && stale && entry.rewoken < STALE_REWAKES) {
      entry.rewoken += 1;
      this.rt.sandboxes.forget(sandbox);
      return;
    }
    if (error instanceof SandboxAsleep) { this.stream.asleep(threadId); return; }
    if (ctx.client && error instanceof CloudroomError && error.code === "storage_blocked") this.stream.measureDisk(threadId, ctx.client);
    // Core's own 404 (a codeless "session not found") keeps its words; only a stale address gets the plain ones.
    const message = stale && !(error as Error).message.endsWith("session not found") ? unreachableSandbox : publicError(error);
    const permanent = error instanceof CloudroomError ? !error.retryable : error instanceof ApiError && error.status === 400;
    if (!binding(this.rt.host.db, threadId)?.sessionId && permanent) this.messaging.failStart(threadId, message, error, ctx.step);
    else if (((connectionFailure(error) || sandboxTransition(error)) && !ctx.rejectedCommand) || !ctx.deliveringCommand) this.rt.setConnectionIssue(threadId, "delivery", error);
    else { saveBinding(this.rt.host.db, threadId, { error: message }); this.rt.setConnectionIssue(threadId, "delivery"); this.rt.notify(threadId); }
    // A start Core refuses "for now" (a failing login or model check) retries forever. After 2 minutes of that, its
    // Cloud parent hears why, once, so it doesn't wait blind or spawn a twin (#865).
    const unstarted = !binding(this.rt.host.db, threadId)?.sessionId, live = this.rt.host.getThread(threadId);
    // A refusal that lands after an archive or removal starts no clock: it would outlive an unarchive.
    const startingAntigravity = ctx.step === "start" && live?.providerId === "acp-antigravity";
    const refusing = unstarted && Boolean(live && !live.archivedAt && !live.deletedAt) && error instanceof CloudroomError && error.retryable && (error.status === 409 || startingAntigravity);
    if (!refusing) entry.refusedSince = undefined;
    else if (entry.refusedSince === undefined) entry.refusedSince = Date.now();
    const stuck = refusing && Date.now() - entry.refusedSince! >= 120_000;
    if (stuck && startingAntigravity) {
      this.messaging.failStart(threadId, "Antigravity could not start. Your prompt is saved. Retry when ready.", error, ctx.step);
      entry.refusedSince = undefined;
    } else if ((startRefused(error) || stuck) && unstarted) {
      void this.children.noticeCloudParent(threadId, error instanceof CloudroomError && error.code === CLOUD_REGION ? "blocked" : "refused", "refused", message).catch((err: unknown) => this.rt.host.warn("A child report could not be sent", err, { threadId }));
    }
    // The cause tells a Stop whether anything answered (#1699).
    throw Object.assign(new ApiError(permanent ? 400 : 503, error instanceof CloudroomError ? error.code ?? "cloudroom_unavailable" : "cloudroom_unavailable", message), { cause: error });
  }
}
