import { z } from "zod";
import { reasoningLevelSchema, type Thread, type ThreadEventType } from "@cloudroom/domain";
import { CloudroomClient, CloudroomConnectionError, CloudroomError, type SessionRecord } from "./client.js";
import type { CloudChildren } from "./children.js";
import { tagOf, type CloudThreadState } from "./cloud-threads.js";
import { mentionsOpenAISide401 } from "./codex-errors.js";
import {
  endedTurn,
  projectRecord,
  projectRecords,
  projectShown,
  recordSaving,
  sessionHarness,
  STREAM_BATCH_MAX_RECORDS,
  STREAM_BATCH_MS,
  type EarlierSession,
} from "./events.js";
import { codexOutage } from "./openai-status.js";
import { connectionFailure, connectionOrReplayFailed, continuedFrom, young } from "./protocol.js";
import type { CloudRuntime } from "./runtime.js";
import { sandboxThread } from "./sandboxes.js";
import { binding, bindings, commands, saveBinding, saveStatus, type Binding } from "./store.js";
import { saveCloudImages } from "./teleport-local.js";
import type { CloudTransfers } from "./transfers.js";

export interface StreamHooks {
  currentUserArchive: (saved: Binding, client: CloudroomClient, sessionId: string, signal: AbortSignal) => Promise<Thread | null>;
}

/** Manages live Core SSE streams, sleeping-sandbox history reads, sleep transitions, and disk notices. */
export class CloudStream {
  constructor(
    private readonly rt: CloudRuntime,
    private readonly transfers: CloudTransfers,
    private readonly children: CloudChildren,
    private readonly hooks: StreamHooks,
  ) {}

  /** An opened thread whose sandbox sleeps reads its history from the website, never waking it (#237). It's shown only:
   *  the thread's state notes where its jobs stood, and the stream that follows starts there and acts on it. `again`
   *  reads even past a read that reached this cursor (an archive's catch-up). */
  readHistory(threadId: string, again = false): Promise<void> {
    const saved = binding(this.rt.host.db, threadId), session = saved?.sessionId, at = `${session}:${saved?.cursor}`;
    const entry = this.rt.state(threadId), last = entry.historyState;
    if (last === "reading") return entry.historyRead ?? Promise.resolve();
    if (!saved || !session || (!again && last === at) || (last?.startsWith("retry:") && Date.now() < Number(last.slice(6)))) return Promise.resolve();
    entry.historyState = "reading";
    const read = (async () => {
      let reached = at;
      try {
        if (!await this.rt.sandboxes.followsThreads().catch(() => false)) return;
        for (let page = await this.rt.sandboxes.records(threadId, session, saved.cursor), first = true; ; first = false) {
          if (first && saved.cursor === 0 && !this.rt.host.hasShownEvents(threadId)) await this.earlierSessions(threadId, continuedFrom(page.records));
          const current = binding(this.rt.host.db, threadId);
          if (!current || current.sessionId !== session || this.rt.peek(threadId)?.stream) return;
          const state: CloudThreadState = this.rt.threadStates.get(threadId) ?? { ...this.rt.firstState(threadId), session, actFrom: 0 };
          // The last shown record a job may act on (deltas, usage and items have none): the stream owes up to it.
          const until = Math.max(-1, ...page.records.filter((record) => recordSaving(record) === "alone").map((record) => record.sequence));
          const history = state.history?.session === session ? state.history : until >= 0 ? { session, from: current.cursor } : undefined;
          if (history && until >= (history.until ?? -1)) this.rt.threadStates.set(threadId, { ...state, history: { ...history, until } });
          const eventTypes = page.records.length ? projectShown(this.rt.host.db, threadId, page.records).types : [];
          if (eventTypes.length) this.rt.notify(threadId, [...new Set(eventTypes)], false);
          reached = `${session}:${binding(this.rt.host.db, threadId)?.cursor}`;
          if (!page.more || !page.records.length) break;
          page = await this.rt.sandboxes.records(threadId, session, binding(this.rt.host.db, threadId)!.cursor);
        }
      } catch (error) {
        this.rt.host.warn("A Cloud thread's history could not be read", error, { threadId });
        reached = `retry:${Date.now() + 10_000}`;
      } finally {
        const current = this.rt.peek(threadId);
        if (current) { current.historyState = reached; current.historyRead = undefined; }
      }
    })();
    entry.historyRead = read;
    return read;
  }

  /** A thread nothing is shown of here yet, whose session continues earlier ones (a switch or move made elsewhere),
   *  shows their history first: up to 5 sessions, oldest first, from the website's saved records (#237, App 4). */
  private earlierSessions(threadId: string, from: string | undefined): Promise<void> {
    if (!from) return Promise.resolve();
    const entry = this.rt.state(threadId);
    if (!entry.earlierLoad) {
      entry.earlierLoad = this.loadEarlier(threadId, from).finally(() => { const s = this.rt.peek(threadId); if (s) s.earlierLoad = undefined; });
    }
    return entry.earlierLoad;
  }

  private async loadEarlier(threadId: string, from: string): Promise<void> {
    if (this.rt.host.hasShownEvents(threadId)) return;
    const chain: { session: string; first: { records: SessionRecord[]; more: boolean } }[] = [];
    for (let session: string | undefined = from; session && chain.length < 5 && !chain.some((item) => item.session === session);) {
      const first = await this.rt.sandboxes.records(threadId, session, 0);
      chain.unshift({ session, first });
      session = continuedFrom(first.records);
    }
    if (this.rt.host.hasShownEvents(threadId)) return;
    for (const { session, first } of chain) {
      // Each session with its own agent, and where its last page left off.
      let earlier: EarlierSession = { session, after: 0, nativeId: null, turnId: null, harness: sessionHarness(first.records) };
      for (let page = first; page.records.length;) {
        const shown = projectShown(this.rt.host.db, threadId, page.records.filter((record) => record.session_id === session && record.sequence > earlier.after), earlier);
        if (shown.types.length) this.rt.notify(threadId, [...new Set(shown.types)], false);
        earlier = { ...shown.earlier ?? earlier, after: Math.max(shown.earlier?.after ?? 0, page.records.at(-1)!.sequence) };
        if (!page.more) break;
        page = await this.rt.sandboxes.records(threadId, session, earlier.after);
      }
    }
  }

  asleep(threadId: string): void {
    const entry = this.rt.state(threadId);
    entry.sleptAtCheck = this.rt.sandboxes.awakeChecks;
    this.rt.detach(threadId);
    // An open thread shows its history now, not on the next tick (needsDelivery reads it there too, once).
    const saved = this.rt.host.watching(threadId) ? binding(this.rt.host.db, threadId) : null;
    if (saved && sandboxThread(saved.coreUrl) === threadId) void this.readHistory(threadId);
    const thread = this.rt.host.getThread(threadId), status = thread?.status;
    // A stop held for the next wake (#553, #1699) isn't work: an asleep sandbox runs nothing.
    if (thread && status && status !== "idle" && status !== "error" && !commands(this.rt.host.db, threadId).some((c) => c.state === "sending" && c.command !== "stop" && c.command !== "unarchive_session")) {
      // Last heard from over 6 days ago: the website may have archived the sandbox as an old run, not as a finished one.
      if (Date.now() - thread.updatedAt < 6 * 86_400_000) entry.cutOffTries = 0;
      saveStatus(this.rt.host.db, threadId, "idle");
      this.rt.notify(threadId);
    }
    if (entry.cutOffTries !== undefined) void this.endedElsewhere(threadId);
  }

  /** A turn was running here, then its sandbox was gone: this computer slept or was offline while the thread ended, so
   *  the rest of its stream never came, and with it the agent's own `room-cli thread archive --self`. The website
   *  archives the sandbox of a Loop run whose agent archived it, so an archived sandbox means the thread is done, here
   *  or on another device: archive it here too, instead of leaving it open and idle for good. One lookup per cut-off
   *  turn, and again after each awake-list check while the sandbox is still stopping, 5 at most. */
  private async endedElsewhere(threadId: string): Promise<void> {
    const entry = this.rt.state(threadId);
    const tries = (entry.cutOffTries ?? 0) + 1;
    entry.cutOffTries = tries;
    const asked = Date.now();
    const state = sandboxThread(binding(this.rt.host.db, threadId)?.coreUrl ?? "") === threadId ? await this.rt.sandboxes.state(threadId).catch(() => "awake" as const) : null;
    // Not while the user's own restore of it is on the way: the website still says archived until it takes that.
    if (state === "archived" && !this.rt.restoredSince(threadId, asked)) this.rt.host.hooks.archiveRequest?.(threadId);
    if (state !== "awake" || tries >= 5) { const s = this.rt.peek(threadId); if (s) s.cutOffTries = undefined; }
  }

  /** The disk pill from Core's own measurement: a full disk shows it, a disk with space clears it. A refusal alone never
   *  does, because older Cores also refuse uploads as "storage unsafe" while a sandbox stops. */
  measureDisk(threadId: string, client: CloudroomClient): void {
    this.rt.storage(client).then((storage) => {
      if (!storage?.enabled) return;
      const entry = this.rt.state(threadId);
      if (storage.level === "normal") entry.disk = undefined;
      else if (storage.level === "blocked" && storage.reason === "disk_capacity" && storage.workspace_total_bytes !== null && storage.workspace_available_bytes !== null) {
        entry.disk = { paused: true, reason: "disk_capacity", usedBytes: storage.workspace_total_bytes - storage.workspace_available_bytes, totalBytes: storage.workspace_total_bytes };
      } else return;
      this.rt.notify(threadId);
    }, () => {});
  }

  /** Records only say paused or not, so each one also reads the disk size for the card's meter. */
  private noteDisk(threadId: string, client: CloudroomClient, data: unknown): void {
    const record = z.object({ paused: z.boolean().optional(), reason: z.string().optional() }).catch({}).parse(data);
    const entry = this.rt.state(threadId), previous = entry.disk;
    entry.disk = { paused: record.paused ?? previous?.paused ?? false, reason: record.reason === "measurement_unavailable" ? "measurement_unavailable" : "disk_capacity", usedBytes: previous?.usedBytes ?? null, totalBytes: previous?.totalBytes ?? null };
    this.rt.storage(client).then((storage) => {
      const current = this.rt.peek(threadId)?.disk;
      if (!current || !storage?.enabled) return;
      // A restarted sandbox sends no "recovered" record, so a disk found fine clears the card.
      if (storage.level === "normal") this.rt.peek(threadId)!.disk = undefined;
      else if (storage.workspace_total_bytes !== null && storage.workspace_available_bytes !== null) {
        this.rt.peek(threadId)!.disk = { ...current, usedBytes: storage.workspace_total_bytes - storage.workspace_available_bytes, totalBytes: storage.workspace_total_bytes };
      }
      this.rt.notify(threadId);
    }, () => {});
  }

  follow(saved: Binding, client: CloudroomClient): void {
    const entry = this.rt.state(saved.threadId);
    if (entry.stream || !saved.sessionId || this.rt.stopped) return;
    const controller = new AbortController();
    entry.stream = controller;
    void (async () => {
      let projecting = false, connected = false;
      await Promise.all([this.rt.me(), this.rt.threadStates.ready]);
      const known = this.rt.threadStates.get(saved.threadId);
      // A session this computer never streamed (another computer's switch): what it holds is shown, never acted on.
      if (!known || known.session !== saved.sessionId) {
        this.rt.threadStates.set(saved.threadId, { ...this.rt.firstState(saved.threadId), ...known, session: saved.sessionId!, actFrom: known ? null : 0, history: undefined });
      }
      const state = () => this.rt.threadStates.get(saved.threadId)!;
      // Once per app run and thread: a new session's label, then only its session for a session started here.
      // A thread Teleported to Cloud may come back to a row on its old session (marked moved to a computer). Only an
      // older app's label replaces a session (web `labelSandbox`, when Core lists it running), clearing that mark.
      const teleported = !known && Boolean(saved.startRequestId?.startsWith("teleport_"));
      if (!known || (known.actFrom === 0 && !known.adopted)) this.children.syncLabel(saved.threadId, teleported ? "switch" : known ? "backfill" : "start");
      const shared = sandboxThread(saved.coreUrl) !== saved.threadId;
      const listing = !shared && await this.rt.sandboxes.followsThreads().catch(() => false) === true;
      // History read from the website while the sandbox slept is shown up to `saved.cursor`; jobs start where they were.
      const marker = state().history?.session === saved.sessionId ? state().history!.from : null;
      const shownTo = marker !== null ? state().history!.until ?? saved.cursor : saved.cursor;
      let handled = marker ?? saved.cursor;
      // One commit per record wrote ~55 KB each. Records that can wait are saved together, in the order they came,
      // and the cursor only moves with them, so a broken stream replays them. recordSaving says which can wait.
      const waiting: SessionRecord[] = [];
      let saveTimer: ReturnType<typeof setTimeout> | undefined;
      const saveWaiting = (last?: SessionRecord) => {
        clearTimeout(saveTimer); saveTimer = undefined;
        if (controller.signal.aborted) return;
        const records = [...waiting.splice(0), ...(last ? [last] : [])];
        if (!records.length) return;
        let eventTypes: ThreadEventType[];
        try { eventTypes = projectRecords(this.rt.host.db, saved.threadId, records); }
        catch (error) {
          if (records.length === 1) throw error;
          // One record cannot be saved. Save the ones before it, as if each had come alone, then fail on it.
          eventTypes = [];
          let failure: unknown;
          for (const record of records) {
            try { eventTypes.push(...projectRecord(this.rt.host.db, saved.threadId, record)); }
            catch (inner) { failure = inner; break; }
          }
          if (eventTypes.length) this.rt.notify(saved.threadId, [...new Set(eventTypes)], false);
          throw failure ?? error;
        }
        this.rt.state(saved.threadId).catchUpTries = 0;
        this.rt.setConnectionIssue(saved.threadId, "replay");
        this.rt.notify(saved.threadId, [...new Set(eventTypes)], false);
      };
      try {
        for await (const record of client.stream(saved.sessionId!, {
          after: handled, signal: controller.signal,
          onConnected: async () => {
            connected = true;
            await this.onStreamConnected(saved, client, controller.signal, shared, state);
          },
        })) {
          if (controller.signal.aborted) return;
          const saving = recordSaving(record);
          if (saving === "wait") {
            waiting.push(record);
            saveTimer ??= setTimeout(() => {
              try { saveWaiting(); }
              catch (error) { this.streamBroke(saved.threadId, error); this.rt.setConnectionIssue(saved.threadId, "replay", error); controller.abort(); }
            }, STREAM_BATCH_MS);
            // A replay after time offline sends thousands of records at once. One save for all would block too long.
            if (waiting.length >= STREAM_BATCH_MAX_RECORDS) { projecting = true; saveWaiting(); projecting = false; }
            continue;
          }
          projecting = true; saveWaiting(saving === "now" ? record : undefined); projecting = false;
          if (saving === "now") continue;
          const nextHandled = await this.handleStreamRecord(saved, client, record, controller.signal, shared, listing, marker, shownTo, handled, state, (p) => { projecting = p; });
          if (nextHandled === null) return;
          handled = nextHandled;
        }
        projecting = true; saveWaiting();
        if (!controller.signal.aborted) {
          const ended = new CloudroomConnectionError("Cloudroom event stream ended");
          this.streamBroke(saved.threadId, ended);
          this.rt.setConnectionIssue(saved.threadId, "stream", ended);
        }
      } catch (error) {
        const sandbox = sandboxThread(saved.coreUrl);
        // Only a stream that could not connect may mean the sandbox slept. A drop after connecting keeps its address,
        // so a sandbox's many agents keep using it instead of checking it again.
        if (sandbox && !connected) this.rt.sandboxes.forget(sandbox);
        if (!controller.signal.aborted) {
          this.streamBroke(saved.threadId, error);
          const phase = !projecting && (connectionFailure(error) || (error instanceof CloudroomError && error.status !== null)) ? "stream" : "replay";
          this.rt.setConnectionIssue(saved.threadId, phase, error);
        }
      } finally {
        clearTimeout(saveTimer);
        const current = this.rt.peek(saved.threadId);
        if (current?.stream === controller) current.stream = undefined;
      }
    })();
  }

  private async onStreamConnected(saved: Binding, client: CloudroomClient, signal: AbortSignal, shared: boolean, state: () => CloudThreadState): Promise<void> {
    if (signal.aborted) return;
    // Earlier sessions come from a website that lists threads (its saved records); a Core without `continued` has none.
    const empty = !shared && saved.cursor === 0 && !this.rt.host.hasShownEvents(saved.threadId) && await this.rt.sandboxes.followsThreads().catch(() => false);
    if (state().actFrom === null || empty) {
      const snapshot = await client.session(saved.sessionId!, signal);
      if (state().actFrom === null) {
        this.rt.threadStates.set(saved.threadId, { ...state(), actFrom: snapshot.last_sequence, home: tagOf(snapshot.last_app_prompt?.request_id) ?? state().home });
        if (!shared) void this.children.listChildren(saved, client, snapshot.continued?.from).catch((error: unknown) => this.rt.host.warn("Cloud child threads could not be listed", error, { threadId: saved.threadId }));
      }
      // Before this session's records, which the stream holds until this returns.
      if (empty) await this.earlierSessions(saved.threadId, snapshot.continued?.from ?? undefined).catch((error: unknown) => this.rt.host.warn("A Cloud thread's earlier history could not be read", error, { threadId: saved.threadId }));
    }
    this.transfers.resumeCopy(saved.threadId, client);
    this.rt.setConnectionIssue(saved.threadId, "stream");
    if (saved.error?.startsWith(connectionOrReplayFailed) && !commands(this.rt.host.db, saved.threadId).some((item) => item.state === "sending")) {
      const snapshot = await client.session(saved.sessionId!, signal);
      if (!signal.aborted && snapshot.last_sequence === saved.cursor && binding(this.rt.host.db, saved.threadId)?.error === saved.error && !commands(this.rt.host.db, saved.threadId).some((item) => item.state === "sending")) {
        saveBinding(this.rt.host.db, saved.threadId, { error: null });
        this.rt.notify(saved.threadId);
      }
    }
  }

  private async handleStreamRecord(
    saved: Binding,
    client: CloudroomClient,
    record: SessionRecord,
    signal: AbortSignal,
    shared: boolean,
    listing: boolean,
    marker: number | null,
    shownTo: number,
    handled: number,
    state: () => CloudThreadState,
    setProjecting: (v: boolean) => void,
  ): Promise<number | null> {
    const acts = (r: SessionRecord) => r.sequence > (state().actFrom ?? Infinity);
    // Core reports a record of its own thread that names its wake (Core 1): that Core and website take it from here.
    const owed = (r: SessionRecord) => listing && typeof (r.data as { wake?: unknown } | null)?.wake === "string" && (r.data as { user?: unknown }).user !== true;
    if ((record.kind === "child" || record.kind === "child_thread") && record.data && typeof record.data === "object" && "id" in record.data && typeof record.data.id === "string") {
      await this.children.followChild(saved, client, record.data.id, acts(record)).catch((error: unknown) => this.rt.host.warn("A Cloud child thread could not be shown", error, { threadId: saved.threadId }));
      if (signal.aborted) return null;
    }
    // Records past what this computer's jobs handled; ones the website's history only showed count too.
    const fresh = record.sequence > handled;
    if ((record.kind === "child_request" || record.kind === "child_command") && fresh && acts(record) && young(record) && this.rt.isHome(saved.threadId)) {
      await this.children.ownSandboxChild(saved, client, record).catch((error: unknown) => this.rt.host.warn("A Cloud child request failed", error, { threadId: saved.threadId }));
      if (signal.aborted) return null;
    }
    // Core wrote its thread's change to the website: list it now, signal or not.
    if (record.kind === "thread_report" && listing && acts(record)) this.rt.sync.changed();
    const lists = record.kind === "own_child" ? await this.rt.sandboxes.followsThreads().catch(() => null) : null;
    if (lists) this.rt.sync.changed();
    else if (lists === false) await this.children.adoptChild(saved, record.data).catch((error: unknown) => this.rt.host.warn("A Cloud child thread could not be shown", error, { threadId: saved.threadId }));
    if (record.kind === "fork_request" && fresh && acts(record) && this.rt.isHome(saved.threadId)) {
      await this.children.agentFork(saved, client, record).catch((error: unknown) => this.rt.host.warn("A Cloud fork request failed", error, { threadId: saved.threadId }));
      if (signal.aborted) return null;
    }
    const outage = mentionsOpenAISide401(record) && await codexOutage();
    if (signal.aborted) return null;
    setProjecting(true);
    // The stream replays from the saved cursor, so renames made while the app was offline apply on reconnect. With
    // a Core and website that follow threads, Core reports its thread's own rename, effort and archive, and the
    // website's list brings them (#237). Otherwise home applies and labels them; other computers only show them.
    const labels = !shared && !owed(record) && acts(record) && this.rt.isHome(saved.threadId);
    const show = (apply: () => void) => labels ? apply() : this.rt.quietly(saved.threadId, apply);
    if (record.kind === "title" && !owed(record)) show(() => this.rt.host.updateThread(this.rt.host.db, saved.threadId, { title: z.object({ title: z.string().min(1) }).parse(record.data).title }));
    if (record.kind === "pin" && fresh && acts(record) && !owed(record)) show(() => this.rt.host.pinThread(saved.threadId));
    const effort = (record.kind === "launch_reasoning" || (record.kind === "reasoning" && !owed(record))) && z.object({ reasoning: reasoningLevelSchema }).safeParse(record.data);
    if (effort && effort.success) {
      show(() => {
        saveBinding(this.rt.host.db, saved.threadId, { reasoning: effort.data.reasoning });
        if (record.kind === "reasoning") this.rt.host.setExecutionOverride({ threadId: saved.threadId, reasoningLevelOverride: effort.data.reasoning });
      });
    }
    // Home runs an agent's move it missed while asleep, as on main: the agent was told it would happen.
    const move = fresh && acts(record) && record.kind === "move" && this.rt.isHome(saved.threadId) && z.object({ project: z.string().min(1) }).safeParse(record.data);
    const ended = fresh ? endedTurn(record) : null;
    const turn = ended ? z.object({ request_id: z.string() }).catch({ request_id: String(record.sequence) }).parse(record.data).request_id : "";
    // The computer that owns a turn reports it to a Cloud parent; one that only shows it doesn't.
    const owned = ended && acts(record) && this.rt.ownsTurn(saved.threadId, turn) ? ended : null;
    if (owned) await this.children.noticeCloudParent(saved.threadId, owned, turn);
    const held = owned && this.children.teleportingParent(saved.threadId) ? owned : null;
    if (held) await this.children.holdChildReport(saved.threadId, held, turn);
    const receipt = fresh && record.kind === "receipt" ? record.data as { command?: string; state?: string; input?: { keep_paused?: boolean } } : null;
    if (receipt?.state === "accepted" && receipt.command === "stop") this.rt.state(saved.threadId).stopReceipt = { session: record.session_id, at: Date.now() };
    if (receipt?.state === "accepted" && receipt.command === "resume" && !receipt.input?.keep_paused) this.rt.state(saved.threadId).stopReceipt = undefined;
    const turnReceipt = record.kind === "receipt" ? z.object({ request_id: z.string(), command: z.string(), state: z.string() }).safeParse(record.data) : null;
    if (turnReceipt?.success) {
      // Home is the computer whose tag is on the latest app prompt; the turn's own tag says who notifies for it.
      const { request_id: request, command: kind, state: step } = turnReceipt.data, tag = tagOf(request);
      if (tag && step === "accepted" && ["prompt", "steer", "edit", "rewind"].includes(kind) && tag !== state().home) this.rt.threadStates.set(saved.threadId, { ...state(), home: tag });
      if (["prompt", "auto", "rewind", "compact"].includes(kind) && !["accepted", "cancelled"].includes(step)) {
        this.rt.host.markTurnElsewhere(saved.threadId, !this.rt.ownsTurn(saved.threadId, request));
      }
    }
    const archive = record.kind === "archive" && fresh && acts(record) && this.rt.isHome(saved.threadId);
    const userArchive = archive && (record.data as { user?: unknown } | null)?.user === true;
    // Read before saving the cursor so a failed status check can retry.
    const mirroredArchive = userArchive ? await this.hooks.currentUserArchive(saved, client, record.session_id, signal) : null;
    if (userArchive && signal.aborted) return null;
    const eventTypes = projectRecord(this.rt.host.db, saved.threadId, record, outage);
    // Past history the website only showed, progress is saved as each record is handled (projectRecord saves the
    // cursor otherwise), so a detach right after an action (an archive) never repeats it on the next connect.
    const nextHandled = Math.max(handled, record.sequence);
    if (marker !== null && state().history) this.rt.threadStates.set(saved.threadId, { ...state(), history: nextHandled >= shownTo ? undefined : { ...state().history!, from: nextHandled } });
    setProjecting(false);
    this.rt.state(saved.threadId).catchUpTries = 0;
    // Like a Local turn's end (turn-completed-events.ts): the finished messages hold their full text, so their
    // streamed pieces go. Cloud never did this, and its threads kept every piece.
    if (ended) try { this.rt.host.pruneEvents("idle", saved.threadId); } catch (error) { this.rt.host.warn("A finished Cloud turn's streamed pieces could not be cleared", error, { threadId: saved.threadId }); }
    if (held) void this.children.deliverChildReports();
    else if (owned) this.children.tellLocalParent(saved.threadId, owned, turn);
    const reply = ended ? this.rt.host.getLastOutput(saved.threadId) : null;
    if (reply) void saveCloudImages(this.rt.host.deps, saved.threadId, reply).catch((error: unknown) => this.rt.host.warn("Chat images could not be saved", error, { threadId: saved.threadId }));
    if (mirroredArchive) this.rt.sync.local?.archive(mirroredArchive);
    // Agents archive their own thread with `room-cli thread archive --self`; like renames, this applies on reconnect,
    // on home. With Core reporting it, the website archives the thread, and home archives its children once the
    // website's list shows that (cascade). One that kept live sessions never reaches the website: home shows it.
    // Core holds the report while any other session in the sandbox is open (a side chat, a kept child), so then
    // home shows it here at once, as on main.
    if (archive && !userArchive) {
      const kept = z.object({ kept_live: z.array(z.string()) }).catch({ kept_live: [] }).parse(record.data).kept_live;
      const live = bindings(this.rt.host.db).filter((b) => b.coreUrl === saved.coreUrl && b.sessionId !== null && kept.includes(b.sessionId)).map((b) => b.threadId);
      const others = bindings(this.rt.host.db).some((b) => b.coreUrl === saved.coreUrl && b.threadId !== saved.threadId && !this.rt.host.getThread(b.threadId)?.archivedAt && !this.rt.host.getThread(b.threadId)?.deletedAt);
      if (owed(record) && !kept.length && !others) this.rt.threadStates.set(saved.threadId, { ...state(), cascade: live });
      else this.rt.host.hooks.archiveRequest?.(saved.threadId, live);
    }
    if (move && move.success) this.rt.host.hooks.moveRequest?.(saved.threadId, move.data.project);
    if (record.kind === "secret_request") this.rt.secrets.follow(client, saved.threadId, record);
    if (record.kind === "gpu_request" && fresh && acts(record)) this.rt.gpuApprovals.follow(saved.threadId, record);
    this.rt.setConnectionIssue(saved.threadId, "replay");
    if (record.kind === "rewind") this.rt.host.notifyThread(saved.threadId, ["history-rewritten"]);
    if (record.kind === "storage_recovered") this.rt.state(saved.threadId).disk = undefined;
    // The agent died for lack of memory (Core sets this); its next turn clears it.
    if (record.kind === "state") {
      const data = record.data as { state?: unknown; out_of_memory?: unknown };
      if (data.out_of_memory === true) this.rt.state(saved.threadId).outOfMemory = true;
      else if (data.state === "running") this.rt.state(saved.threadId).outOfMemory = false;
    }
    if (record.kind === "storage_warning" || record.kind === "storage_pause") this.noteDisk(saved.threadId, client, record.data);
    this.rt.notify(saved.threadId, eventTypes, ["state", "receipt", "native_identity", "storage_warning", "storage_pause", "storage_recovered"].includes(record.kind));
    return nextHandled;
  }

  /** Logs why a Cloud thread's stream broke, once per distinct reason, since it reopens every delivery tick. */
  private streamBroke(threadId: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    const entry = this.rt.state(threadId);
    if (entry.streamError === reason) return;
    entry.streamError = reason;
    this.rt.host.warn("Cloud thread stream broke", error, { threadId });
  }
}
