import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { cloudroomCommands, cloudroomThreads } from "@cloudroom/db";
import {
  COMPUTER,
  rawThreadIdSchema,
  reasoningLevelSchema,
  serviceTierSchema,
  type PromptInput,
  type Thread,
  type ThreadEventTurnStatus,
} from "@cloudroom/domain";
import type { CreateThreadRequest } from "@cloudroom/server-contract";
import { ApiError } from "../../errors.js";
import { CloudroomClient, CloudroomError, type SessionRecord } from "./client.js";
import { sharedChildId } from "./cloud-threads.js";
import { CLOUD_HARNESSES, HARNESS_NAMES, isCloudProvider, projectFollowUp, type CloudProvider } from "./events.js";
import {
  AGENT_FORK_WAIT,
  AGENT_FORKS,
  CHILD_REPORTS,
  childReportSchema,
  feature,
  harnessProfile,
  isCloudThread,
  LABEL_FIELDS,
  publicError,
  takesNoEffort,
  WEBSITE_CHILD,
  type Capabilities,
  type LabelChange,
} from "./protocol.js";
import type { CloudRuntime } from "./runtime.js";
import { SANDBOX_PREFIX, SandboxAsleep, sandboxThread, type AutomationRun } from "./sandboxes.js";
import { binding, command, commands, localTeleports, teleportBlocked, type Binding, type Command } from "./store.js";

export interface ChildrenHooks {
  deliver: (threadId: string) => Promise<void>;
  follow: (saved: Binding, client: CloudroomClient) => void;
  create: (request: CreateThreadRequest, awaitingCore?: boolean) => Promise<Thread>;
  enqueue: (threadId: string, id: string, action: Command["command"], input: object, at?: number) => void;
  currentReasoning: (threadId: string, saved: Binding) => string;
}

/** Coordinates Cloud subagents, child adoption, parent labels, agent forks, and child turn reports. */
export class CloudChildren {
  private readonly heldStarts = new Set<string>();
  private delivering?: Promise<void>;

  constructor(private readonly rt: CloudRuntime, private readonly hooks: ChildrenHooks) {}

  isHeldStart(requestId: string): boolean { return this.heldStarts.has(requestId); }

  /** A top-level thread in another thread's sandbox was a child there. As soon as that sandbox is awake, Core stops
   *  reporting it to that former parent, which may be archived. Repeats are harmless, so a failure retries a minute
   *  later or before its next work. Once Core detaches the session, or answers that it has no such session (a stale
   *  sandbox address answers 404 too, without saying so), that session is done. */
  async leaveFormerParent(saved: Binding, client: CloudroomClient): Promise<void> {
    const sandbox = sandboxThread(saved.coreUrl);
    const mark = this.rt.peek(saved.threadId)?.leftParent ?? 0;
    if (
      !saved.sessionId || !sandbox || sandbox === saved.threadId || mark === saved.sessionId
      || (typeof mark === "number" && mark > Date.now() && !commands(this.rt.host.db, saved.threadId).some((c) => c.state === "sending"))
      || this.rt.host.getThread(saved.threadId)?.parentThreadId
    ) return;
    try {
      await client.detach(saved.sessionId);
      this.rt.state(saved.threadId).leftParent = saved.sessionId;
    } catch (error) {
      this.rt.state(saved.threadId).leftParent = error instanceof CloudroomError && error.status === 404 && error.message.endsWith(": session not found")
        ? saved.sessionId
        : Date.now() + 60_000;
      this.rt.host.warn("A Cloud thread could not leave its former parent", error, { threadId: saved.threadId });
    }
  }

  /** A shared child's name lives in Core, which keeps it for every computer (#237). */
  async renameShared(threadId: string): Promise<void> {
    const saved = binding(this.rt.host.db, threadId), title = this.rt.host.getThread(threadId)?.title;
    if (!saved?.sessionId || !title || !sandboxThread(saved.coreUrl) || sandboxThread(saved.coreUrl) === threadId) return;
    try {
      const client = await this.rt.client(saved, false);
      if (feature(await this.rt.capabilities(client), "cloud_threads")) await client.renameSession(saved.sessionId, randomUUID(), title);
    } catch (error) {
      if (!(error instanceof SandboxAsleep)) this.rt.host.warn("A shared child's name could not be saved in Cloud", error, { threadId });
    }
  }

  /** Keeps the website's copy of a sandbox thread's title, project name, harness, model, Core session, and parent
   *  current, so the web can list it and read its history, and the thread that started it can too (ADR 0182, 0239,
   *  0256). Subagents sharing their parent's sandbox are found through its history. A thread's saves run one at a
   *  time, so an older label can't land after a newer one. The website routes the thread's turn reports, and its
   *  parent's tell, stop and archive, by the label's parent (ADR 0259), so `changeParent` saves a new parent there
   *  first, then runs `apply` (the Mac's change), then saves the parent the Mac ended up with: a no-op unless the
   *  change failed. Nothing changes if the first save fails. */
  /** `resend`: a change kept from earlier; failing again doesn't restart its hour. */
  syncLabel(threadId: string, change: LabelChange, tries = 0, resend = false): void {
    void this.oneLabelSave(threadId, () => this.saveLabel(threadId, change)).then((stored) => {
      if (stored !== null) void this.rt.sync.unsentLabel(threadId, change, true);
    }, (error: unknown) => {
      this.rt.host.warn("Cloud thread label not saved", error, { threadId });
      // Refused for good (not sign-in, a timeout or a busy website): it's dropped, never sent again.
      if (error instanceof CloudroomError && error.status !== null && error.status < 500 && ![401, 403, 408, 409, 429].includes(error.status)) {
        return void this.rt.sync.unsentLabel(threadId, change, true);
      }
      // Kept for an hour from the change and sent again on each list (#237).
      if (change !== "start" && change !== "backfill") void this.rt.sync.unsentLabel(threadId, change, false, resend);
      // A missed label keeps the website on the old session after an agent switch, so its children's reports retry
      // until it lands. A few spaced tries, then the next change or app start sends it.
      if (tries < 3 && !this.rt.stopped) setTimeout(() => this.syncLabel(threadId, change, tries + 1, resend), 60_000 * (tries + 1)).unref();
    });
  }

  private oneLabelSave<T>(threadId: string, save: () => Promise<T>): Promise<T> {
    const entry = this.rt.state(threadId);
    const result = (entry.labelSave ?? Promise.resolve()).then(save);
    const settled = result.then(() => {}, () => {});
    entry.labelSave = settled;
    void settled.then(() => { if (this.rt.peek(threadId)?.labelSave === settled) this.rt.peek(threadId)!.labelSave = undefined; });
    return result;
  }

  private async saveLabel(threadId: string, change: LabelChange, parent?: string | null): Promise<boolean | null> {
    const saved = binding(this.rt.host.db, threadId), thread = this.rt.host.getThread(threadId);
    if (!saved?.sessionId || !thread || sandboxThread(saved.coreUrl) !== threadId) return null;
    const full = {
      title: thread.title ?? thread.titleFallback ?? null,
      project_name: this.rt.host.getProject(thread.projectId)?.name ?? null,
      project: thread.projectId,
      session: saved.sessionId,
      harness: thread.providerId,
      model: thread.modelOverride ?? saved.model,
      // The website's link is the truth for a child it started: only a move changes it (ADR 20261104-015709).
      ...(parent === undefined && saved.startRequestId?.startsWith(WEBSITE_CHILD) ? {} : { parent: this.linkParent(saved, parent === undefined ? thread.parentThreadId ?? null : parent) }),
    };
    // Unknown (a website blip) never means an older website: a whole label would undo newer changes made elsewhere.
    const lists = change === "switch" ? false : await this.rt.sandboxes.followsThreads();
    if (lists === null) throw new CloudroomError("Cloudroom didn't answer. The change is sent again later.");
    const label = lists ? { v: 2 as const, ...Object.fromEntries(Object.entries(full).filter(([field]) => LABEL_FIELDS[change].includes(field))) } : full;
    if (Object.keys(label).length === 1) return null;
    const key = JSON.stringify(label);
    const entry = this.rt.state(threadId);
    if (entry.labelKey === key) return null;
    entry.labelKey = undefined;
    // A move is the only label that may take a child the website started out from under its parent (ADR 20261104-015709).
    const stored = await this.rt.sandboxes.label(threadId, parent === undefined ? label : { ...label, moved: true });
    entry.labelKey = key;
    return stored;
  }

  /** The parent the website links: for a child it started, the thread whose sandbox runs that parent, since one
   *  sharing another thread's sandbox has none of its own (ADR 20261104-015709). The app still shows the real one. */
  private linkParent(child: Binding, parent: string | null): string | null {
    if (!parent || !child.startRequestId?.startsWith(WEBSITE_CHILD)) return parent;
    return sandboxThread(binding(this.rt.host.db, parent)?.coreUrl ?? "") ?? parent;
  }

  async changeParent(threadId: string, parent: string | null, apply: () => Promise<void>): Promise<void> {
    await this.oneLabelSave(threadId, async () => {
      const saved = binding(this.rt.host.db, threadId);
      if (saved && sandboxThread(saved.coreUrl) === threadId && !saved.sessionId) {
        throw new ApiError(503, "cloudroom_parent_unsaved", "This Cloud thread is still starting. Change its parent once it has started.");
      }
      try {
        if (await this.saveLabel(threadId, "parent", parent) === false) {
          const entry = this.rt.peek(threadId);
          if (entry) entry.labelKey = undefined;
          throw new CloudroomError("Cloud has no record of this thread's sandbox yet");
        }
      } catch (error) {
        this.rt.host.warn("A Cloud thread's new parent was not saved", error, { threadId });
        const signIn = error instanceof CloudroomError && (error.status === 401 || error.status === 403);
        if (error instanceof CloudroomError && !error.retryable && error.status !== null && !signIn) throw new ApiError(400, "cloudroom_parent_unsaved", publicError(error));
        throw new ApiError(503, "cloudroom_parent_unsaved", `Couldn't save the new parent to Cloud: ${(signIn ? "Sign in to Cloudroom to use cloud sandboxes" : publicError(error)).replace(/\.?$/, ".")} Try again.`);
      }
      try { await apply(); }
      finally { await this.saveLabel(threadId, "parent").catch((error: unknown) => this.rt.host.warn("Cloud thread label not saved", error, { threadId })); }
    });
  }

  /** A thread the website started, say while this Mac was off: an automation's run (ADR 0239) or a top-level thread
   *  another Cloud thread launched (ADR 0267). It shows like any Cloud thread; its history streams in once its
   *  sandbox is awake or opened. Only the Mac that has its project shows it, and a thread this app already has is
   *  left alone. */
  async adoptRun(run: AutomationRun): Promise<void> {
    // The run's own label names its agent (a launch may pick another); older runs fall back to the source thread's (ADR 0250).
    const source = this.rt.host.getThread(run.source), home = binding(this.rt.host.db, run.source);
    const own = isCloudProvider(run.harness ?? undefined) && run.model;
    const providerId = own ? run.harness : source && home ? source.providerId : run.harness;
    const model = own ? run.model : home?.model ?? run.model;
    // A child the website started goes under the parent the website links (ADR 20261104-015709), so a move made on
    // any Mac stays, and one an older app showed top-level gets its parent. A website too old to say: who started it.
    const child = run.session.startsWith(`cr_${WEBSITE_CHILD}`), linked = !child ? null : run.parent === undefined ? run.source : run.parent;
    const found = linked ? this.rt.host.getThread(linked) : null, parent = found?.projectId === run.project ? found : null;
    const existing = this.rt.host.getThread(run.thread);
    if (existing) {
      const shown = binding(this.rt.host.db, existing.id);
      // Shown under a session that shares the linked thread's sandbox counts as linked.
      if (child && run.parent !== undefined && shown && this.linkParent(shown, existing.parentThreadId) !== run.parent) {
        this.rt.host.updateThread(this.rt.host.db, existing.id, { parentThreadId: parent?.id ?? null });
      }
      return;
    }
    // Not shown here: said once per thread and app run, not on each minute's list (#1072).
    const skip = (why: string) => {
      if (!this.rt.runsSkipped.has(run.thread)) this.rt.host.warn("A Cloud thread the website started isn't shown here", why, { threadId: run.thread, projectId: run.project });
      this.rt.runsSkipped.add(run.thread);
    };
    if (!providerId || !model) return skip("it names no agent or model");
    if (source && source.projectId !== run.project) return skip("the thread that started it is in another project here");
    if (!this.rt.host.getProject(run.project)) return skip("its project isn't on this computer");
    const adopted = this.rt.host.db.transaction((tx) => {
      if (this.rt.host.getThread(run.thread, tx) || tx.select().from(cloudroomThreads).where(eq(cloudroomThreads.sessionId, run.session)).get()) return null;
      const thread = this.rt.host.createThread(tx, {
        id: run.thread, executionTarget: "cloud", projectId: run.project, providerId,
        ...(parent ? { parentThreadId: parent.id } : {}),
        title: run.title, titleFallback: parent ? `${HARNESS_NAMES[providerId as CloudProvider] ?? "Cloud"} child` : "Loop run", status: "pending",
      });
      tx.insert(cloudroomThreads).values({
        threadId: run.thread, coreUrl: SANDBOX_PREFIX + run.thread, sessionId: run.session,
        startRequestId: run.session.replace(/^cr_/, ""), model, reasoning: run.reasoning ?? home?.reasoning ?? "medium",
      }).run();
      return thread;
    });
    if (!adopted) return;
    this.rt.host.emitThreadCreated(adopted);
    this.rt.notify(run.thread);
    void this.hooks.deliver(run.thread).catch(() => {});
  }

  /** A child this Cloud thread started in a sandbox of its own through the website (ADR 20261104-015709), from Core's
   *  `own_child` record, so it shows under its parent even if it started while this Mac was off. A thread already
   *  shown as a Loop-style run moves under its parent. */
  async adoptChild(parent: Binding, data: unknown): Promise<void> {
    const child = z.object({
      id: rawThreadIdSchema, session: z.string().regex(/^cr_[A-Za-z0-9_-]{1,80}$/),
      title: z.string().nullish(), harness: z.string().nullish(), model: z.string().nullish(), reasoning: reasoningLevelSchema.nullish().catch(null),
    }).parse(data);
    const parentThread = this.rt.host.getThread(parent.threadId), existing = this.rt.host.getThread(child.id);
    if (!parentThread) return;
    if (existing) {
      if (existing.parentThreadId === parentThread.id || existing.projectId !== parentThread.projectId) return;
      // The website links the sandbox's thread; a session sharing it is the closer parent. Anything else is the
      // website's to say (adoptRun), so a move stays.
      if (existing.parentThreadId && existing.parentThreadId === sandboxThread(parent.coreUrl)) {
        this.rt.host.updateThread(this.rt.host.db, child.id, { parentThreadId: parentThread.id });
      }
      return;
    }
    const providerId = isCloudProvider(child.harness ?? undefined) ? child.harness as CloudProvider : parentThread.providerId;
    const model = child.model ?? parent.model;
    if (!isCloudProvider(providerId) || !model) return;
    const adopted = this.rt.host.db.transaction((tx) => {
      if (this.rt.host.getThread(child.id, tx) || tx.select().from(cloudroomThreads).where(eq(cloudroomThreads.sessionId, child.session)).get()) return null;
      const thread = this.rt.host.createThread(tx, {
        id: child.id, executionTarget: "cloud", projectId: parentThread.projectId, providerId, parentThreadId: parentThread.id,
        title: child.title ?? null, titleFallback: `${HARNESS_NAMES[providerId]} child`, status: "pending",
      });
      tx.insert(cloudroomThreads).values({
        threadId: child.id, coreUrl: SANDBOX_PREFIX + child.id, sessionId: child.session,
        startRequestId: child.session.replace(/^cr_/, ""), model, reasoning: child.reasoning ?? parent.reasoning ?? "medium",
      }).run();
      return thread;
    });
    if (!adopted) return;
    this.rt.host.emitThreadCreated(adopted);
    this.rt.notify(child.id);
    void this.hooks.deliver(child.id).catch(() => {});
  }

  /** A session sharing this thread's sandbox, from the parent's `child` record or Core's session list (#237). Every
   *  computer gives it the same thread ID; home names it. `live`: its records so far are this computer's to act on. */
  async followChild(parent: Binding, client: CloudroomClient, childId: string, live: boolean, parentSessions = [parent.sessionId!]): Promise<void> {
    const parentThread = this.rt.host.getThread(parent.threadId);
    if (!parentThread) return;
    const existing = this.rt.host.db.select().from(cloudroomThreads).where(and(eq(cloudroomThreads.coreUrl, parent.coreUrl), eq(cloudroomThreads.sessionId, childId))).get();
    if (existing) { this.hooks.follow(existing, client); return; }
    const session = await client.session(childId);
    const start = Object.values(session.receipts).find((receipt) => receipt.command === "start");
    const input = z.object({
      parent_session: z.string().refine((id) => parentSessions.includes(id)),
      reasoning: z.string().nullable().optional(), title: z.string().optional(), prompt: z.string().optional(),
    }).parse(start?.input);
    const providerId = (Object.keys(CLOUD_HARNESSES) as CloudProvider[]).find((id) => CLOUD_HARNESSES[id] === session.harness);
    if (!providerId || !start) throw new CloudroomError("Invalid Cloudroom child session");
    const id = sharedChildId(parent.coreUrl, childId), title = session.title ?? input.title ?? null;
    const child = this.rt.host.db.transaction((tx) => {
      const saved = tx.select().from(cloudroomThreads).where(and(eq(cloudroomThreads.coreUrl, parent.coreUrl), eq(cloudroomThreads.sessionId, childId))).get();
      if (saved || this.rt.host.getThread(id, tx)) return saved ?? null;
      const prompt: PromptInput[] = [{ type: "text", text: input.prompt ?? "", mentions: [] }];
      const thread = this.rt.host.createThread(tx, {
        id, executionTarget: "cloud", projectId: parentThread.projectId, providerId, parentThreadId: parent.threadId,
        title, titleFallback: this.rt.host.deriveTitleFallback(prompt) ?? `${HARNESS_NAMES[providerId]} child`, status: "pending",
      });
      if (!title && this.rt.isHome(parent.threadId)) this.rt.host.queueTitle(tx, thread.id, prompt);
      tx.insert(cloudroomThreads).values({
        threadId: thread.id, coreUrl: parent.coreUrl, sessionId: childId, startRequestId: start.request_id,
        model: start.model ?? parent.model, reasoning: input.reasoning ?? parent.reasoning,
      }).run();
      for (const receipt of Object.values(session.receipts).filter((receipt) => receipt.command === "prompt")) {
        tx.insert(cloudroomCommands).values({ id: receipt.request_id, threadId: thread.id, command: "prompt", input: JSON.stringify(receipt.input), state: "accepted", createdAt: Date.now() }).run();
      }
      return binding(tx, thread.id)!;
    });
    if (!child) return;
    if (session.pinned) this.rt.host.pinThread(child.threadId);
    if (!this.rt.threadStates.get(child.threadId)) this.rt.threadStates.set(child.threadId, { session: childId, actFrom: live ? 0 : null, home: null, from: parent.threadId });
    this.hooks.follow(child, client);
    this.rt.notify(child.threadId);
  }

  /** A session this computer never streamed shows the shared children Core lists under it, and under the session it
   *  continues: their `child` records may be older than the stream it reads (#237). */
  async listChildren(parent: Binding, client: CloudroomClient, from: string | undefined): Promise<void> {
    const parents = [parent.sessionId!, ...(from ? [from] : [])];
    for (const summary of (await client.listSessions()).sessions) {
      if (summary.parent_session && parents.includes(summary.parent_session) && !summary.archived && summary.state !== "closed") {
        await this.followChild(parent, client, summary.session_id, false, parents).catch((error: unknown) => this.rt.host.warn("A Cloud child thread could not be shown", error, { threadId: parent.threadId }));
      }
    }
  }

  /** The parent the app reports this child's turns to: a Local parent, or a Cloud parent whose child runs in a
   *  sandbox of its own (ADR 0228). Core reports the children in a Cloud parent's own sandbox. */
  reportedParent(thread: Thread | null): Thread | null {
    const parent = thread && this.rt.host.isParentNotifiableChild(thread) ? this.rt.host.getThread(thread.parentThreadId) : null;
    if (!parent || !isCloudThread(parent)) return parent;
    return binding(this.rt.host.db, thread!.id)?.coreUrl !== binding(this.rt.host.db, parent.id)?.coreUrl ? parent : null;
  }

  /** Reports a finished child turn to a Local parent (after the record is shown, as before). */
  tellLocalParent(threadId: string, status: ThreadEventTurnStatus, turn: string): void {
    const thread = this.rt.host.getThread(threadId);
    const parent = this.reportedParent(thread);
    if (!thread?.parentThreadId || !parent || isCloudThread(parent)) return;
    if (teleportBlocked(this.rt.host.db, parent.id)) {
      void this.holdChildReport(threadId, status, turn).then(() => this.deliverChildReports(), (error: unknown) => this.rt.host.warn("A child report could not be saved", error, { threadId }));
      return;
    }
    this.rt.host.hooks.childTurnEnded?.({ ...thread, parentThreadId: thread.parentThreadId }, status);
  }

  /** A parent moving either way holds its children's reports until it lands. Teleport to Local closes the Cloud session
   *  that Core's reports go to, so without the hold a turn ending meanwhile reaches neither copy. */
  teleportingParent(threadId: string): boolean {
    const parent = this.reportedParent(this.rt.host.getThread(threadId));
    return Boolean(parent && this.moving(parent.id));
  }

  private moving(threadId: string): boolean {
    return teleportBlocked(this.rt.host.db, threadId) || localTeleports.has(threadId);
  }

  holdChildReport(child: string, status: ThreadEventTurnStatus, turn: string): Promise<void> {
    return this.rt.updateRecords(CHILD_REPORTS, childReportSchema, (reports) => ({ ...reports, [`${child}:${turn}`]: { child, status, turn } }));
  }

  deliverChildReports(): Promise<void> {
    this.delivering ??= (async () => {
      try {
        for (;;) {
          const reports = Object.entries(await this.rt.records(CHILD_REPORTS, childReportSchema));
          if (!reports.length || this.rt.stopped) return;
          let waiting = false, failed = false;
          for (const [key, report] of reports) {
            const thread = this.rt.host.getThread(report.child);
            const parent = this.reportedParent(thread);
            if (parent && this.moving(parent.id)) { waiting = true; continue; }
            const status = report.status as ThreadEventTurnStatus;
            if (parent && isCloudThread(parent)) {
              const sent = await this.noticeCloudParent(report.child, status, report.turn).then(() => true, (error: unknown) => { this.rt.host.warn("A child report could not be sent", error, { threadId: report.child }); return false; });
              if (!sent) { failed = true; continue; }
            } else if (parent && thread?.parentThreadId) {
              this.rt.host.hooks.childTurnEnded?.({ ...thread, parentThreadId: thread.parentThreadId }, status);
            }
            await this.rt.updateRecords(CHILD_REPORTS, childReportSchema, ({ [key]: _done, ...rest }) => rest);
          }
          if (failed && !waiting) return;
          if (waiting) await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      } finally { this.delivering = undefined; }
    })();
    return this.delivering;
  }

  /** Reports a child in a sandbox of its own to its Cloud parent, in the words of Core's own child notices, so the
   *  app shows it as a child report. Called before the child's record counts as read, so a crash can't lose it.
   *  Core reports a child whose start named its parent instead (ADR 0259), Mac on or off, when its current parent has
   *  a sandbox of its own: a child a Cloud parent started, or a loop run the website started under its manager. This
   *  covers every other child. A parent in another Cloudroom account never hears from it. */
  async noticeCloudParent(threadId: string, status: ThreadEventTurnStatus | "not_started" | "refused" | "blocked", turn: string, cause?: string): Promise<void> {
    const child = this.rt.host.getThread(threadId);
    const parent = this.reportedParent(child);
    if (!child || !parent || !isCloudThread(parent)) return;
    const parentSaved = binding(this.rt.host.db, parent.id);
    if (parentSaved && await this.rt.otherAccountThread(parentSaved)) return;
    // A start notice is stale once the child was archived, removed or started meanwhile (#865).
    const now = this.rt.host.getThread(threadId);
    if ((status === "refused" || status === "blocked") && (!now || now.archivedAt || now.deletedAt || binding(this.rt.host.db, threadId)?.sessionId)) return;
    const first = command(this.rt.host.db, `first_${child.id}`), own = parentSaved?.coreUrl === SANDBOX_PREFIX + parent.id;
    if (status !== "not_started" && status !== "refused" && status !== "blocked" && first && JSON.parse(first.input).parent_thread && own) return;
    // One this app didn't start (a website child or loop run, ADR 20261104-015709, #1239) has Core report its turns
    // when its start named a parent, so the parent hears of each turn once (#1579).
    if (!first && await this.coreReports(child.id, own)) return;
    const name = child.title ? `"${child.title}" (${child.id})` : child.id;
    const reply = this.rt.host.getLastOutput(child.id)?.trim();
    const text = status === "refused" || status === "blocked"
      ? `[Cloudroom] Child thread ${name} has not started: ${cause} ${status === "refused" ? "It starts by itself once that clears, so don't spawn a replacement. If it can't wait, ask" : "That may not change soon, so ask"} the user to archive it, then spawn it again with --shared-sandbox.`
      : status === "completed"
        ? `[Cloudroom] Child thread ${name} completed:\n\n${reply ? reply.length > 4000 ? `${reply.slice(0, 4000)}\n\n[... reply truncated. Read all of it with \`room-cli thread output ${child.id}\` ...]` : reply : "No final output was recorded."}`
        : status === "interrupted"
          ? `[Cloudroom] Child thread ${name} was interrupted. If the user stopped it, do not restart or replace its work unless they ask.`
          : `[Cloudroom] Child thread ${name} failed or its outcome is uncertain.${cause ? ` Cause: ${cause.trim().replace(/\.$/, "")}.` : ""} ${status === "not_started" ? "It did not start." : "Its turn did not finish; resend the task if it still matters."}`;
    this.queuePrompt(parent.id, `notice_${createHash("sha256").update(`${child.id}:${turn}`).digest("hex").slice(0, 40)}`, text);
  }

  /** Whether a child's Core reports its turns itself: its session's start named a parent thread, which an agent switch
   *  keeps, and the website can reach the parent (`own`: a sandbox's own thread). Read once per session from Core's
   *  list (0.1.108+), without waking it. A child the website started always does; for any other, when Core can't say,
   *  the app reports it, as before (#1579). */
  private readonly coreReporting = new Map<string, boolean>();
  private async coreReports(threadId: string, own: boolean): Promise<boolean> {
    const saved = binding(this.rt.host.db, threadId), session = saved?.sessionId;
    if (saved?.startRequestId?.startsWith(WEBSITE_CHILD)) return true;
    if (!own || !saved || !session) return false;
    const known = this.coreReporting.get(session);
    if (known !== undefined) return known;
    const listed = await this.rt.client(saved, false).then((client) => client.listSessions(AbortSignal.timeout(10_000))).catch(() => null);
    const parent = listed?.sessions.find((item) => item.session_id === session)?.parent_thread;
    if (parent === undefined) return false;
    this.coreReporting.set(session, Boolean(parent));
    return Boolean(parent);
  }

  /** Saves a message from a parent or child thread and delivers it. Saving the same ID again does nothing. Unlike
   *  a user's message it never resumes a thread the user stopped: like Core's own notices, it waits in the queue. */
  private queuePrompt(threadId: string, id: string, text: string): void {
    const thread = this.rt.host.getThread(threadId);
    if (!thread || thread.archivedAt || thread.deletedAt || command(this.rt.host.db, id)) return;
    try { this.hooks.enqueue(threadId, id, "prompt", { text }); }
    catch (error) { this.rt.host.warn("A message between parent and child threads was not saved", error, { threadId }); return; }
    if (this.rt.host.db.transaction((tx) => projectFollowUp(tx, threadId, id))) this.rt.notify(threadId, ["client/turn/requested"]);
    void this.hooks.deliver(threadId).catch(() => {});
  }

  /** ADR 0229: a Cloud agent's `room-cli thread spawn` asks the app to start the child in a sandbox of its own
   *  (Core waits briefly for the answer). Cores older than ADR 0259 also send `tell`, `stop` and `archive` on that
   *  child here; newer ones go through the website. Both are handled before the parent's record counts as read, so
   *  a crash replays them instead of losing them. */
  async ownSandboxChild(parent: Binding, client: CloudroomClient, record: SessionRecord): Promise<void> {
    const parentThread = this.rt.host.getThread(parent.threadId);
    if (!parentThread || parentThread.archivedAt || parentThread.deletedAt) return;
    const once = (kind: string) => `${kind}_${createHash("sha256").update(`${parent.sessionId}:${record.sequence}`).digest("hex").slice(0, 40)}`;
    if (record.kind === "child_command") {
      const input = z.object({ id: z.string(), action: z.enum(["tell", "stop", "archive"]), text: z.string().min(1).optional() }).parse(record.data);
      const child = this.rt.host.getThread(input.id);
      if (!child || child.parentThreadId !== parentThread.id || this.reportedParent(child)?.id !== parentThread.id) return;
      if (input.action === "archive") this.rt.host.hooks.archiveRequest?.(child.id);
      else if (input.action === "tell" && input.text) this.queuePrompt(child.id, once("tell"), input.text);
      else if (input.action === "stop" && !command(this.rt.host.db, once("stop"))) {
        this.hooks.enqueue(child.id, once("stop"), "stop", {});
        void this.hooks.deliver(child.id).catch(() => {});
      }
      return;
    }
    const input = z.object({ id: z.string().min(1).max(80), prompt: z.string().min(1), provider: z.string().optional(), model: z.string().optional(), reasoning: z.string().optional(), title: z.string().optional(), service_tier: serviceTierSchema.optional() }).parse(record.data);
    // One start per request, even when the parent's stream replays it.
    const requestId = `child_${createHash("sha256").update(`${parent.threadId}:${input.id}`).digest("hex").slice(0, 40)}`;
    let child = this.rt.host.db.select().from(cloudroomThreads).where(eq(cloudroomThreads.startRequestId, requestId)).get()?.threadId ?? null;
    let answer: { thread: string } | { error: string };
    try {
      if (!child) {
        const refusal = await this.rt.sandboxes.startRefusal();
        if (refusal) throw new ApiError(429, "cloud_start_refused", refusal.replace(/\.$/, ""));
        const providerId = input.provider ? (Object.keys(CLOUD_HARNESSES) as CloudProvider[]).find((id) => CLOUD_HARNESSES[id] === input.provider) : parentThread.providerId;
        if (!providerId) throw new ApiError(400, "cloudroom_unsupported", `Cloud has no ${input.provider} agent.`);
        const same = providerId === parentThread.providerId;
        let loadedCaps: Capabilities | undefined;
        const caps = async () => loadedCaps ??= (await this.rt.savedCapabilities() ?? await this.rt.capabilities(client));
        const profile = input.model || same ? null : harnessProfile(await caps(), providerId);
        const model = input.model ?? (same ? parent.model : profile && (providerId === "pi" && profile.provider ? `${profile.provider}/${profile.model}` : profile.model));
        const piDefault = providerId === "pi" && (model !== parent.model || (JSON.parse(command(this.rt.host.db, `first_${parent.threadId}`)?.input ?? "{}").default_reasoning && !this.rt.host.getExecutionOverride(parent.threadId)?.reasoningLevelOverride));
        // With no effort given, a model without effort starts without one, never at the parent's level (#1059).
        const inherit = same && !piDefault && !input.reasoning && !takesNoEffort(await caps(), providerId, model);
        const reasoning = reasoningLevelSchema.safeParse(input.reasoning ?? (inherit ? binding(this.rt.host.db, parent.threadId)?.reasoning : undefined));
        if (input.reasoning && !reasoning.success) throw new ApiError(400, "cloudroom_reasoning", `Unknown effort level ${input.reasoning}.`);
        child = (await this.hooks.create({
          projectId: parentThread.projectId, providerId, ...(model ? { model } : {}), ...(reasoning.success ? { reasoningLevel: reasoning.data } : {}), ...(input.title ? { title: input.title } : {}), ...(input.service_tier ? { serviceTier: input.service_tier } : {}),
          input: [{ type: "text", text: input.prompt, mentions: [] }], parentThreadId: parentThread.id, requestId,
          origin: "cli", environment: { type: "project-default" }, startedOnBehalfOf: null, originKind: null,
        }, true)).id;
      }
      answer = { thread: child };
    } catch (error) { answer = { error: publicError(error) }; }
    // Core decides once. The child starts only after Core confirms it; otherwise Core runs it in the parent's
    // sandbox (or nowhere), so this one is archived before it starts and the task never runs twice.
    const confirmed = await this.answerChild(client, parent, input.id, answer);
    if (!child) return;
    if (!confirmed) {
      if (!this.rt.host.getThread(child)?.archivedAt) this.rt.host.hooks.archiveRequest?.(child);
      return;
    }
    const first = command(this.rt.host.db, `first_${child}`);
    if (first) this.rt.host.db.update(cloudroomCommands).set({ input: JSON.stringify({ ...JSON.parse(first.input), awaiting_core: undefined }) }).where(eq(cloudroomCommands.id, first.id)).run();
    void this.hooks.deliver(child).catch(() => {});
  }

  async agentFork(parent: Binding, client: CloudroomClient, record: SessionRecord): Promise<void> {
    const parentThread = this.rt.host.getThread(parent.threadId);
    if (!parentThread || parentThread.archivedAt || parentThread.deletedAt) return;
    const input = z.object({ id: z.string().min(1).max(80), prompt: z.string().min(1), machine: z.enum(["local", "cloud"]).optional(), provider: z.string().optional(), model: z.string().optional(), reasoning: z.string().optional(), title: z.string().optional() }).parse(record.data);
    const requestId = `fork_${createHash("sha256").update(`${parent.threadId}:${input.id}`).digest("hex").slice(0, 40)}`;
    const forks = await this.rt.records(AGENT_FORKS, z.string());
    let fork = forks[requestId] ?? this.rt.host.db.select().from(cloudroomThreads).where(eq(cloudroomThreads.startRequestId, requestId)).get()?.threadId ?? null;
    const held = (id: string) => { const first = command(this.rt.host.db, `first_${id}`); return Boolean(first && JSON.parse(first.input).awaiting_core === true); };
    if (fork) {
      const made = this.rt.host.getThread(fork);
      if (!made || made.archivedAt || made.deletedAt) { await this.answerChild(client, parent, input.id, { error: "This fork was cancelled." }); return; }
      if (!held(fork)) { await this.answerChild(client, parent, input.id, { thread: fork }); return; }
    }
    if (!fork && (this.heldStarts.has(requestId) || (record.timestamp_ms !== undefined && Date.now() - record.timestamp_ms > AGENT_FORK_WAIT))) return;
    const creating = !fork;
    if (creating) this.heldStarts.add(requestId);
    let answer: { thread: string } | { error: string };
    try {
      if (!fork) {
        const providerId = input.provider ? (Object.keys(CLOUD_HARNESSES) as CloudProvider[]).find((id) => CLOUD_HARNESSES[id] === input.provider) : parentThread.providerId;
        if (!providerId) throw new ApiError(400, "cloudroom_unsupported", `Cloud has no ${input.provider} agent.`);
        const same = providerId === parentThread.providerId;
        if (input.machine === "local") throw new ApiError(403, "cloudroom_unsupported", `Cloud agents fork only to Cloud. Omit --machine; only the user can fork to their ${COMPUTER}, from the Cloudroom app.`);
        if (!this.rt.host.hasCompletedRootTurn(parentThread.id)) throw new ApiError(409, "fork_source_session_unavailable", "This thread has no finished turn to fork yet: a fork starts at the last finished turn, and this is the first one. Fork in a later turn.");
        const profile = input.model || same ? null : harnessProfile(await this.rt.savedCapabilities() ?? await this.rt.capabilities(client), providerId);
        const model = input.model ?? (same ? parent.model : profile && (providerId === "pi" && profile.provider ? `${profile.provider}/${profile.model}` : profile.model));
        const reasoning = reasoningLevelSchema.safeParse(input.reasoning ?? (same ? this.hooks.currentReasoning(parent.threadId, parent) : undefined));
        if (input.reasoning && !reasoning.success) throw new ApiError(400, "cloudroom_reasoning", `Unknown effort level ${input.reasoning}.`);
        fork = (await this.rt.host.createAgentForkThread({
          projectId: parentThread.projectId, providerId, ...(model ? { model } : {}), ...(reasoning.success ? { reasoningLevel: reasoning.data } : {}), ...(input.title ? { title: input.title } : {}),
          input: [{ type: "text", text: input.prompt, mentions: [] }], originKind: "fork", sourceThreadId: parentThread.id, executionTarget: "cloud",
          environment: { type: "project-default" }, origin: "cli", startedOnBehalfOf: null, visibility: "visible", requestId,
        })).id;
        await this.saveAgentFork(requestId, fork!)
          .catch((error: unknown) => this.rt.host.warn("A Cloud fork request could not be saved", error, { threadId: parent.threadId }));
      }
      answer = { thread: fork };
    } catch (error) {
      answer = { error: publicError(error) };
      const made = creating ? this.rt.host.db.select().from(cloudroomThreads).where(eq(cloudroomThreads.startRequestId, requestId)).get()?.threadId : undefined;
      if (made && held(made)) this.rt.host.hooks.archiveRequest?.(made);
    } finally { if (creating) this.heldStarts.delete(requestId); }
    const confirmed = await this.answerChild(client, parent, input.id, answer);
    if (!fork) return;
    if (!confirmed) {
      if (!this.rt.host.getThread(fork)?.archivedAt) this.rt.host.hooks.archiveRequest?.(fork);
      return;
    }
    const first = command(this.rt.host.db, `first_${fork}`);
    if (first && held(fork)) {
      this.rt.host.db.update(cloudroomCommands).set({ input: JSON.stringify({ ...JSON.parse(first.input), awaiting_core: undefined }) }).where(eq(cloudroomCommands.id, first.id)).run();
      void this.hooks.deliver(fork).catch(() => {});
    }
  }

  saveAgentFork(requestId: string, threadId: string): Promise<void> {
    return this.rt.updateRecords(AGENT_FORKS, z.string(), (forks) => ({ ...forks, [requestId]: threadId }));
  }

  /** True when Core confirmed the child. A refusal is final; a network error is retried briefly. */
  private async answerChild(client: CloudroomClient, parent: Binding, id: string, answer: { thread: string } | { error: string }): Promise<boolean> {
    for (let tries = 1; ; tries++) {
      try { await client.answerChild(parent.sessionId!, id, answer); return "thread" in answer; }
      catch (error) {
        if ((error instanceof CloudroomError && (error.status === 404 || error.status === 409)) || tries === 3) {
          this.rt.host.warn(id.startsWith("fork_") ? "Core did not take a Cloud fork's answer" : "Core did not take a Cloud child's start", error, { threadId: parent.threadId });
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, tries * 1000));
      }
    }
  }

  catchUpForParent(saved: Binding): boolean {
    const thread = this.rt.host.getThread(saved.threadId);
    const busy = thread !== null && ["pending", "starting", "active", "stopping"].includes(thread.status);
    const entry = this.rt.state(saved.threadId);
    if (!busy || entry.catchUpTries >= 5 || entry.stream || !this.reportedParent(thread) || !this.rt.isHome(saved.threadId)) return false;
    if (!this.rt.sandboxes.coolingDown(sandboxThread(saved.coreUrl))) entry.catchUpTries += 1;
    return true;
  }
}
