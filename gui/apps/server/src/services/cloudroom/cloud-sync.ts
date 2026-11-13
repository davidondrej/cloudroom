// Cloud threads on every computer (#237, docs/scopes/cloud-threads.md App 1–3). The website lists the account's Cloud
// threads by change. This computer follows that list: it adopts the open ones it lacks and applies each change through
// the same local functions as a click, quietly, so nothing goes back. It never writes shared state from this copy.
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Thread } from "@cloudroom/domain";
import { cloudroomThreads, createRemoteProject, createThread, getProject, getThread, projects, setThreadExecutionOverride, threads, updateThread } from "@cloudroom/db";
import { reasoningLevelSchema } from "@cloudroom/domain";
import type { AppDeps } from "../../types.js";
import { emitPluginThreadCreated } from "../plugins/plugin-thread-events.js";
import { NotificationBuffer } from "../lib/notification-buffer.js";
import { ELSEWHERE, type CloudThreadStates } from "./cloud-threads.js";
import { isCloudProvider } from "./events.js";
import { githubRepository } from "./project-copy.js";
import { SANDBOX_PREFIX, type SandboxDirectory, type ThreadChange } from "./sandboxes.js";
import { binding, bindings, commands, coreInUse, saveBinding } from "./store.js";

/** What the sync needs from the Cloud service (commands.ts). */
export interface SyncHost {
  readonly sandboxes: SandboxDirectory;
  readonly threadStates: CloudThreadStates;
  /** This install's tag. */
  me(): Promise<string>;
  quietly<T>(threadId: string | null, apply: () => T): T;
  isHome(threadId: string): boolean;
  detach(threadId: string): void;
  adopted(threadId: string, awake: boolean): void;
  resendLabel(threadId: string, change: string): void;
  archiveRequest?: (threadId: string, liveThreadIds?: string[], websiteHasIt?: boolean) => void;
}

const syncSchema = z.object({
  /** The account this state belongs to: another account starts over. */
  account: z.string().nullable().default(null),
  /** The list's cursor after the last page applied; a failed page is asked again. */
  cursor: z.string().nullable().default(null),
  /** The first sync hasn't finished: it repairs archives older apps made only here. */
  first: z.boolean().default(true),
  /** Rows waiting for their parent, by parent (at most 2,000, oldest dropped). */
  deferred: z.record(z.string(), z.array(z.unknown())).default({}),
  /** Threads deleted here that the website hasn't listed as deleted yet: never adopted back. */
  deleted: z.array(z.string()).default([]),
  /** The website's project ID → this computer's, for projects found by repo or name. */
  projects: z.record(z.string(), z.string()).default({}),
  /** A Cloud thread's sandbox went to sleep: the row's `updated_at` when this computer first saw it asleep. */
  asleep: z.record(z.string(), z.string()).default({}),
  /** Label changes the website didn't take yet, sent again for an hour from the change (the last to arrive wins). */
  labels: z.record(z.string(), z.object({ at: z.number(), changes: z.array(z.string()) })).default({}),
  /** Threads this computer saw archived on the website, or archived through it: only those come back from an open row. */
  archived: z.array(z.string()).default([]),
  /** A row that failed to apply: the list stops before it and tries again, 3 times. */
  failing: z.object({ thread: z.string(), tries: z.number() }).nullable().default(null),
  /** The first sync found no thread here: only then may it make projects (a new computer). */
  newInstall: z.boolean().nullable().default(null),
  /** Rows an updated install's first sync didn't make a project for, with their `updated_at`: the same row listed
   *  again (the list's overlap) still doesn't; one made or changed since may. */
  declined: z.record(z.string(), z.string()).default({}),
  /** The website's project IDs of projects deleted here (`cloudDeletedProjects`): their rows are never adopted. */
  deletedProjects: z.array(z.string()).default([]),
  /** The row's effort each thread last took (or saw, for one already here): only a change from it applies. */
  efforts: z.record(z.string(), z.string()).default({}),
});
type SyncState = z.infer<typeof syncSchema>;

const PAUSE_MS = 5_000, FRESH_MS = 10 * 60_000, DEFERRED_MAX = 2_000, LABEL_MS = 3_600_000, RETRY_MS = 30_000;
/** The week the website's awake answer names launches for (web `RUNS_WINDOW_MS`). */
const LAUNCH_WINDOW_MS = 7 * 86_400_000;
const repo = (url: string | null | undefined) => url?.toLowerCase().replace(/\.git$/, "").replace(/\/$/, "") ?? null;
const asleep = (row: ThreadChange) => row.state === "open" && (row.sandbox === "asleep" || row.sandbox === "cold");
/** Asleep or cold since, per thread, for the Thread cleanup loop (`room-cli thread list --json`). */
export const asleepSince = new Map<string, string>();

export class CloudSync {
  /** The local parts of a user's archive, restore and delete, set by routes.ts; none of them calls the website. */
  local?: { archive(thread: Thread): void; unarchive(thread: Thread): void; remove(thread: Thread): void };
  private loaded?: Promise<SyncState>;
  private writing: Promise<void> = Promise.resolve();
  private running: Promise<void> | null = null;
  private queued = false;
  private lastRun = 0;
  private soon: ReturnType<typeof setTimeout> | null = null;
  private recheck: ReturnType<typeof setInterval> | null = null;
  private tunnel = false;
  private every = { up: 3_600_000, down: 600_000 };
  private repairs: string[] = [];
  private tag = "";
  constructor(private readonly deps: Pick<AppDeps, "db" | "hub" | "config"> & Partial<Pick<AppDeps, "logger">>, private readonly host: SyncHost) {}

  private loadedFor: string | null = null;
  /** The state for the signed-in account; another account's is dropped, with its cursor (it lists from the start).
   *  Signed out, or the connection unreadable for a moment: none, and nothing is loaded, reset or saved. */
  private async state(): Promise<SyncState | null> {
    const account = (await this.host.sandboxes.account().catch(() => null))?.userId ?? null;
    if (!account) return null;
    if (this.loaded && this.loadedFor !== account) this.loaded = undefined;
    this.loadedFor = account;
    return this.loaded ??= readFile(join(this.deps.config.dataDir, "cloudroom-thread-sync.json"), "utf8")
      .then((text) => syncSchema.parse(JSON.parse(text)), () => syncSchema.parse({}))
      .then((saved) => {
        const state = saved.account === account ? saved : syncSchema.parse({ account });
        asleepSince.clear();
        for (const [id, at] of Object.entries(state.asleep)) asleepSince.set(id, at);
        return state;
      });
  }
  private save(): Promise<void> {
    const path = join(this.deps.config.dataDir, "cloudroom-thread-sync.json"), loaded = this.loaded;
    if (!loaded) return this.writing;
    this.writing = this.writing.then(async () => {
      const temporary = `${path}.${randomUUID()}`;
      try {
        await writeFile(temporary, JSON.stringify(await loaded), { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
    }).catch((error: unknown) => this.deps.logger?.warn({ error: String(error) }, "Cloud thread list state not saved"));
    return this.writing;
  }

  start(): void {
    this.schedule();
    void this.run();
  }
  stop(): void {
    if (this.soon) clearTimeout(this.soon);
    if (this.recheck) clearInterval(this.recheck);
    this.soon = this.recheck = null;
  }
  /** The relay's signal, a reconnect (`tunnel` says which way), or a change Core reported: at most one list every 5 s. */
  changed(tunnel?: boolean): void {
    if (tunnel !== undefined && tunnel !== this.tunnel) { this.tunnel = tunnel; this.schedule(); }
    if (this.soon) return;
    this.soon = setTimeout(() => { this.soon = null; void this.run(); }, Math.max(0, this.lastRun + PAUSE_MS - Date.now()));
    this.soon.unref?.();
  }
  /** Every `recheck_ms` with the tunnel up, `recheck_offline_ms` without: signals may have been missed. */
  private schedule(): void {
    if (this.recheck) clearInterval(this.recheck);
    this.recheck = setInterval(() => void this.run(), this.tunnel ? this.every.up : this.every.down);
    this.recheck.unref?.();
  }
  /** One list in flight, one queued. */
  run(): Promise<void> {
    if (this.running) { this.queued = true; return this.running; }
    this.running = (async () => {
      try {
        do { this.queued = false; this.lastRun = Date.now(); await this.once(); } while (this.queued);
      } catch (error) { this.deps.logger?.warn({ error: error instanceof Error ? error.message : String(error) }, "Cloud threads could not be listed"); }
      finally { this.running = null; }
    })();
    return this.running;
  }

  private async once(): Promise<void> {
    const account = (await this.host.sandboxes.account().catch(() => null))?.userId;
    if (!account || await this.host.sandboxes.followsThreads() !== true) return;
    this.tag = await this.host.me();
    const state = await this.state();
    if (!state) return;
    // Only a computer with no thread at all when its first sync starts makes projects on it (#237, a new computer).
    if (state.first && state.newInstall === null) state.newInstall = !this.deps.db.select({ id: threads.id }).from(threads).limit(1).get();
    for (const [threadId, unsent] of Object.entries(state.labels)) {
      if (Date.now() - unsent.at > LABEL_MS) delete state.labels[threadId];
      else for (const change of unsent.changes) this.host.resendLabel(threadId, change);
    }
    for (let more = true; more;) {
      const page = await this.host.sandboxes.threads(state.cursor), buffer = new NotificationBuffer(), first = state.first;
      // Another account signed in meanwhile: this page is the old account's.
      if ((await this.host.sandboxes.account().catch(() => null))?.userId !== account || state !== await this.state()) return;
      if (page.recheck_ms !== this.every.up || page.recheck_offline_ms !== this.every.down) { this.every = { up: page.recheck_ms, down: page.recheck_offline_ms }; this.schedule(); }
      let stopAt: string | null | undefined;
      this.host.quietly(null, () => {
        for (const [index, row] of page.threads.entries()) {
          try {
            this.apply(row, state, buffer, first);
            if (state.failing?.thread === row.thread) state.failing = null;
          } catch (error) {
            this.deps.logger?.warn({ threadId: row.thread, error: error instanceof Error ? error.message : String(error) }, "A Cloud thread could not be applied");
            // The list stops before a row that failed and asks for it again next time, 3 times at most.
            const tries = state.failing?.thread === row.thread ? state.failing.tries + 1 : 1;
            if (tries < 3) {
              state.failing = { thread: row.thread, tries };
              const before = page.threads[index - 1];
              stopAt = before ? `${before.updated_at}~${before.thread}` : state.cursor;
              break;
            }
            state.failing = null;
          }
        }
        buffer.flushInto(this.deps.hub);
      });
      if (stopAt !== undefined) {
        state.cursor = stopAt;
        await this.save();
        // Tried again by itself shortly, not only at the next signal or recheck.
        setTimeout(() => void this.run(), RETRY_MS).unref?.();
        return;
      }
      state.cursor = page.next;
      more = page.more;
      if (!more) state.first = false;
      await this.save();
    }
    await this.cascadeMissed();
    void this.repair();
  }

  /** One row, by itself: adopt it, or bring this computer's copy in line. */
  private apply(row: ThreadChange, state: SyncState, buffer: NotificationBuffer, first: boolean): void {
    if (row.state === "deleted") state.deleted = state.deleted.filter((id) => id !== row.thread);
    if (asleep(row)) { state.asleep[row.thread] ??= row.updated_at; asleepSince.set(row.thread, state.asleep[row.thread]!); }
    else { delete state.asleep[row.thread]; asleepSince.delete(row.thread); }
    const thread = getThread(this.deps.db, row.thread);
    if (!thread) {
      // A top-level launch (from a Cloud thread or the phone) archived before this computer saw it shows archived, from
      // the last week (#1072). Loop runs and other archived rows stay out.
      const late = row.state === "archived" && /^cr_(launch|phone)_/.test(row.session) && !row.loop && !row.parent && Date.now() - Date.parse(row.created_at) < LAUNCH_WINDOW_MS;
      if ((row.state === "open" || late) && !state.deleted.includes(row.thread)) this.adopt(row, state, buffer);
      // Then archived here only: no cascade and nothing sent, so a child that waited for it stays open, at the top level.
      const adopted = late ? getThread(this.deps.db, row.thread) : null;
      if (adopted) {
        if (!state.archived.includes(adopted.id)) state.archived.push(adopted.id);
        this.local?.archive(adopted);
      }
      return;
    }
    const saved = binding(this.deps.db, thread.id), known = this.host.threadStates.get(thread.id);
    // A Local thread under this ID moved here (Teleport to Local); a deleted one stays deleted.
    if (thread.executionTarget !== "cloud" || !saved || thread.deletedAt) return;
    // A row on a session this thread left (an answer that crossed a switch made here) is old in every field.
    if (known?.before?.includes(row.session)) return;
    // Moved to a computer, or deleted, on the session this thread is on: a later session (Teleport back to Cloud) isn't.
    if (row.state === "deleted" || row.state === "local") {
      if (row.session !== saved.sessionId) return;
      this.host.detach(thread.id);
      this.local?.remove(thread);
      this.host.threadStates.set(thread.id, null);
      return;
    }
    if (row.state === "archived") {
      if (!state.archived.includes(thread.id)) state.archived.push(thread.id);
      const pending = this.host.threadStates.get(thread.id);
      // An agent archived it on home: main's archive from the parent, so idle children go with it and working ones stay.
      if (pending?.cascade && this.host.isHome(thread.id) && !thread.archivedAt) {
        this.host.threadStates.set(thread.id, { ...pending, cascade: undefined });
        this.host.archiveRequest?.(thread.id, pending.cascade, true);
      } else if (!thread.archivedAt && this.host.isHome(thread.id) && this.openChildren(thread.id)) {
        // Archived while home was off: its agent may have archived it, a record home never streamed. After this page,
        // home reads that record and runs main's archive from the parent (cascadeMissed).
        this.missed.add(thread.id);
      } else if (!thread.archivedAt) this.local?.archive(thread);
    }
    if (row.state === "open" && thread.archivedAt) {
      // Only an archive the website had is undone by an open row: a restore. One it never got (busy, or a side chat
      // kept the sandbox) stays archived, and on the first sync an older app's archive made here goes to the website,
      // unless another open thread here still uses the sandbox (main never archived the row then).
      if (state.archived.includes(thread.id)) {
        state.archived = state.archived.filter((id) => id !== thread.id);
        this.local?.unarchive(thread);
      } else if (first && asleep(row) && Date.parse(row.updated_at) < thread.archivedAt - FRESH_MS && !coreInUse(this.deps.db, saved.coreUrl)) this.repairs.push(thread.id);
    }
    // A change made here that the website hasn't taken yet wins over the row.
    const unsent = state.labels[thread.id]?.changes ?? [];
    if (row.title && row.title !== thread.title && !unsent.includes("title")) updateThread(this.deps.db, buffer, thread.id, { title: row.title });
    const parent = unsent.includes("parent") ? undefined : this.parentOf(row, thread);
    if (parent !== undefined && parent !== thread.parentThreadId) updateThread(this.deps.db, buffer, thread.id, { parentThreadId: parent });
    const project = unsent.includes("project") ? null : this.project(row, state);
    if (project && project !== thread.projectId) updateThread(this.deps.db, buffer, thread.id, { projectId: project });
    // Another computer's switch: follow the new session from here on, never back to one this thread left.
    if (row.session !== saved.sessionId) {
      this.host.detach(thread.id);
      saveBinding(this.deps.db, thread.id, { sessionId: row.session, startRequestId: row.session.replace(/^cr_/, ""), cursor: 0, nativeId: null, turnId: null, error: null });
      this.host.threadStates.set(thread.id, { home: null, from: null, ...known, session: row.session, actFrom: null, before: [saved.sessionId, ...known?.before ?? []].filter((id): id is string => Boolean(id)).slice(0, 5) });
    }
    if (row.harness && isCloudProvider(row.harness) && row.harness !== thread.providerId) updateThread(this.deps.db, buffer, thread.id, { providerId: row.harness });
    // A model picked here (changeModel) wins over the row until Core and the website have it; a new session always wins.
    const pickedHere = () => unsent.includes("model") || commands(this.deps.db, thread.id).some((item) => item.command === "model" && item.state === "sending");
    if (row.model && row.model !== saved.model && (row.session !== saved.sessionId || !pickedHere())) saveBinding(this.deps.db, thread.id, { model: row.model });
    // The agent's effort change (Core reports it): what main's record handler did, so the next prompt uses it. Only a
    // change in the row since this computer last saw it: the row is as old as its last writer, and a thread already
    // here takes nothing on first sight.
    const seen = row.reasoning ?? "", last = state.efforts[thread.id], effort = reasoningLevelSchema.safeParse(row.reasoning);
    if (seen !== last) {
      state.efforts[thread.id] = seen;
      if (last !== undefined && effort.success && effort.data !== saved.reasoning) {
        saveBinding(this.deps.db, thread.id, { reasoning: effort.data });
        setThreadExecutionOverride(this.deps.db, { threadId: thread.id, reasoningLevelOverride: effort.data });
      }
    }
  }

  /** The parent the row asks for here: null for none or a closed one, undefined to keep the current one. A child the
   *  website started stays under a session sharing its linked parent's sandbox. */
  private parentOf(row: ThreadChange, thread?: Thread): string | null | undefined {
    if (!row.parent) return null;
    const parent = getThread(this.deps.db, row.parent);
    // A closed parent still open here gets its own archive from the list (and its cascade) first: until then the child
    // stays under it, and main's archive then takes it or moves it to the top level, working or not.
    if (row.parent_state === "closed") return thread && parent && !parent.archivedAt && !parent.deletedAt && thread.parentThreadId === parent.id ? undefined : null;
    if (!parent || parent.deletedAt) return undefined;
    const current = thread?.parentThreadId ? binding(this.deps.db, thread.parentThreadId) : null;
    return current && current.coreUrl === SANDBOX_PREFIX + row.parent ? thread!.parentThreadId : parent.id;
  }

  /** `homeProject`: same ID, then the GitHub repo, then the same name without another repo; otherwise a new project
   *  by name and repo. Never one deleted here, and never a folder project this computer lacks. */
  private project(row: ThreadChange, state: SyncState): string | null {
    if (state.deletedProjects.includes(row.project)) return null;
    const mapped = state.projects[row.project] ? getProject(this.deps.db, state.projects[row.project]!) : null;
    if (mapped && !mapped.deletedAt) return mapped.id;
    const same = getProject(this.deps.db, row.project);
    if (same) return same.deletedAt ? null : same.id;
    const all = this.deps.db.select().from(projects).where(isNull(projects.deletedAt)).all(), wanted = repo(row.repository);
    const found = (wanted && all.find((project) => repo(githubRepository(project.gitRemoteUrl)) === wanted))
      || all.find((project) => project.name === row.project_name && !githubRepository(project.gitRemoteUrl));
    // A project is made only for a thread an app started: on a new computer's first sync, or from a row made or changed
    // since a computer with threads first listed (main's deletes left their rows open, with no record of the delete).
    // A loop run or launch shows only where its project is, as on main.
    const allowed = state.newInstall === true || (!state.first && state.declined[row.thread] !== row.updated_at);
    if (!found && !allowed) state.declined[row.thread] = row.updated_at;
    const creates = !row.loop && !row.session.startsWith("cr_launch_") && allowed;
    const project = found || (creates && row.repository && row.project_name ? createRemoteProject(this.deps.db, this.deps.hub, { name: row.project_name, gitRemoteUrl: row.repository }) : null);
    if (project) delete state.declined[row.thread];
    if (project) state.projects[row.project] = project.id;
    return project ? project.id : null;
  }

  /** `adoptThread`, the one path a Cloud thread from elsewhere takes: idle and read, with the row's title and dates,
   *  no local commands and no title job. A child whose parent isn't here yet waits for it. */
  private adopt(row: ThreadChange, state: SyncState, buffer: NotificationBuffer): void {
    // A launch (ADR 0267) this computer can't show says why, once per thread and app run (#1072).
    const skip = (why: string) => {
      if (!row.session.startsWith("cr_launch_") || this.skipped.has(row.thread)) return;
      this.skipped.add(row.thread);
      this.deps.logger?.warn({ threadId: row.thread, projectId: row.project, error: why }, "A launched Cloud thread isn't shown here");
    };
    if (!row.harness || !isCloudProvider(row.harness) || !row.model) return skip("it names no agent or model");
    if (state.deletedProjects.includes(row.project)) return;
    if (this.deps.db.select().from(cloudroomThreads).where(eq(cloudroomThreads.sessionId, row.session)).get()) return;
    const parent = this.parentOf(row);
    if (parent === undefined) { this.defer(row, state); return; }
    const projectId = this.project(row, state);
    if (!projectId) return skip("its project isn't on this computer");
    const adopted = this.deps.db.transaction((tx) => {
      if (getThread(tx, row.thread)) return null;
      const thread = createThread(tx, buffer, { id: row.thread, executionTarget: "cloud", projectId, providerId: row.harness!, ...(parent ? { parentThreadId: parent } : {}), title: row.title, titleFallback: row.loop ? "Loop run" : null, status: "idle", createdAt: Date.parse(row.created_at), latestAttentionAt: Date.parse(row.updated_at) });
      tx.insert(cloudroomThreads).values({ threadId: row.thread, coreUrl: SANDBOX_PREFIX + row.thread, sessionId: row.session, startRequestId: row.session.replace(/^cr_/, ""), model: row.model!, reasoning: row.reasoning ?? "medium" }).run();
      return thread;
    });
    if (!adopted) return;
    state.efforts[row.thread] = row.reasoning ?? "";
    // A thread made in the last 10 minutes is live: its records are acted on from the start, as on main. An older
    // one's, or one adopted archived (a Restore must not replay its archive), are shown only, from Core's
    // `last_sequence` on. Who acts until a tagged prompt says (Who acts): a website child's parent's home; for a loop
    // run or launch, each computer with its project ID (main's rule); else not here.
    const child = row.session.startsWith("cr_sub_"), byId = (row.loop || row.session.startsWith("cr_launch_")) && projectId === row.project;
    this.host.threadStates.set(row.thread, { session: row.session, actFrom: row.state === "open" && Date.now() - Date.parse(row.created_at) < FRESH_MS ? 0 : null, home: child ? null : byId && this.tag ? this.tag : ELSEWHERE, from: child ? parent : null, adopted: true });
    this.host.adopted(row.thread, row.sandbox === "awake");
    emitPluginThreadCreated(adopted);
    const waiting = state.deferred[row.thread];
    delete state.deferred[row.thread];
    for (const child of waiting ?? []) this.apply(child as ThreadChange, state, buffer, false);
  }

  private defer(row: ThreadChange, state: SyncState): void {
    const list = (state.deferred[row.parent!] ??= []);
    const at = list.findIndex((item) => (item as ThreadChange).thread === row.thread);
    if (at >= 0) list.splice(at, 1);
    list.push(row);
    const all = Object.entries(state.deferred).flatMap(([parent, rows]) => rows.map((item) => ({ parent, row: item as ThreadChange })));
    if (all.length <= DEFERRED_MAX) return;
    for (const { parent, row: old } of all.sort((a, b) => a.row.updated_at.localeCompare(b.row.updated_at)).slice(0, all.length - DEFERRED_MAX)) {
      state.deferred[parent] = state.deferred[parent]!.filter((item) => item !== old);
      if (!state.deferred[parent]!.length) delete state.deferred[parent];
    }
  }

  private readonly missed = new Set<string>();
  /** Launches already warned about as not shown here (`adopt`). */
  private readonly skipped = new Set<string>();
  private openChildren(threadId: string): boolean {
    return Boolean(this.deps.db.select({ id: threads.id }).from(threads).where(and(eq(threads.parentThreadId, threadId), isNull(threads.archivedAt), isNull(threads.deletedAt))).limit(1).get());
  }
  /** Home's own thread archived on the website while it was off (`missed`): when its agent archived it, home reads
   *  that `archive` record (it names the sessions it kept live) from the website's saved history and runs main's archive
   *  from the parent, so its idle children go and working ones stay, as main did on the replayed record. A user's
   *  archive elsewhere has no such record: this thread only. If the history can't be read: main's rule, nothing kept. */
  private async cascadeMissed(): Promise<void> {
    for (const threadId of [...this.missed]) {
      this.missed.delete(threadId);
      const thread = getThread(this.deps.db, threadId), saved = binding(this.deps.db, threadId);
      if (!thread || thread.archivedAt || !saved?.sessionId) continue;
      let kept: string[] | null = null;
      try {
        for (let after = saved.cursor, pages = 0; pages < 5; pages++) {
          const page = await this.host.sandboxes.records(threadId, saved.sessionId, after);
          const archive = page.records.filter((record) => record.kind === "archive" && typeof (record.data as { wake?: unknown } | null)?.wake === "string").at(-1);
          if (archive) kept = z.object({ kept_live: z.array(z.string()) }).catch({ kept_live: [] }).parse(archive.data).kept_live;
          if (!page.more || !page.records.length) break;
          after = page.records.at(-1)!.sequence;
        }
      } catch (error) {
        this.deps.logger?.warn({ threadId, error: error instanceof Error ? error.message : String(error) }, "A missed agent archive could not be read");
        kept = [];
      }
      const live = kept && bindings(this.deps.db).filter((item) => item.coreUrl === saved.coreUrl && item.sessionId !== null && kept!.includes(item.sessionId)).map((item) => item.threadId);
      this.host.quietly(null, () => live ? this.host.archiveRequest?.(threadId, live, true) : this.local?.archive(thread));
    }
  }

  /** A project deleted here: its rows, under its own ID and the website IDs mapped to it, are never adopted. */
  async projectDeleted(projectId: string): Promise<void> {
    const state = await this.state();
    if (!state) return;
    const ids = [projectId, ...Object.entries(state.projects).filter(([, local]) => local === projectId).map(([website]) => website)];
    state.deletedProjects = [...new Set([...state.deletedProjects, ...ids])];
    await this.save();
  }

  /** A thread made here whose parent now exists: its waiting children follow it. */
  async arrived(threadId: string): Promise<void> {
    this.tag ||= await this.host.me();
    const state = await this.state();
    if (!state?.deferred[threadId]) return;
    const buffer = new NotificationBuffer();
    this.host.quietly(null, () => {
      const waiting = state.deferred[threadId] ?? [];
      delete state.deferred[threadId];
      for (const child of waiting) this.apply(child as ThreadChange, state, buffer, false);
      buffer.flushInto(this.deps.hub);
    });
    await this.save();
  }

  /** First sync: the archives sent to the website, 5 s apart. */
  private async repair(): Promise<void> {
    for (let threadId = this.repairs.shift(); threadId; threadId = this.repairs.shift()) {
      if (getThread(this.deps.db, threadId)?.archivedAt) await this.host.sandboxes.archive(threadId).catch((error: unknown) => this.deps.logger?.warn({ threadId, error: String(error) }, "An archive made here could not reach the website"));
      await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    }
  }

  /** A delete made here: never adopted back before the website lists it deleted. */
  async deletedHere(threadId: string): Promise<void> {
    const state = await this.state();
    if (!state) return;
    if (!state.deleted.includes(threadId)) state.deleted.push(threadId);
    state.archived = state.archived.filter((id) => id !== threadId);
    delete state.labels[threadId];
    delete state.efforts[threadId];
    await this.save();
  }

  /** A label change the website didn't take (`sent`: it did now, or refused it for good). The hour counts from the
   *  change: a new one starts it, a resend that fails again (`resend`) doesn't renew it. */
  async unsentLabel(threadId: string, change: string, sent: boolean, resend = false): Promise<void> {
    const state = await this.state(), unsent = state?.labels[threadId];
    if (!state) return;
    if (sent) { if (unsent?.changes.includes(change)) { unsent.changes = unsent.changes.filter((item) => item !== change); if (!unsent.changes.length) delete state.labels[threadId]; } else return; }
    else if (resend && (!unsent || unsent.changes.includes(change))) return;
    else state.labels[threadId] = { at: resend ? unsent!.at : Date.now(), changes: [...new Set([...unsent?.changes ?? [], change])] };
    await this.save();
  }

  /** This computer archived a thread through the website (`true`), or restored it here (`false`). */
  async archivedOnWebsite(threadId: string, archived: boolean): Promise<void> {
    const state = await this.state();
    if (!state) return;
    const had = state.archived.includes(threadId);
    if (archived === had) return;
    state.archived = archived ? [...state.archived, threadId] : state.archived.filter((id) => id !== threadId);
    await this.save();
  }
}
