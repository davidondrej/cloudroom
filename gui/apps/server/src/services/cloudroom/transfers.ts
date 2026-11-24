import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import { CloudroomClient, CloudroomConnectionError, CloudroomError } from "./client.js";
import { startStepRunning, type StartStep } from "./events.js";
import { landForkCode } from "./fork.js";
import {
  copyKey,
  copyProject,
  copyRunning,
  keyCopying,
  localProjectPath,
  planProjectCopy,
  planProjectCopyOrThrow,
  reportProjectCopy,
  retry,
  writeFilesState,
  type ProjectCopyJob,
} from "./project-copy.js";
import {
  COPY_DEADLINE,
  copyWorkspace,
  CORE_OWN,
  CUT_SHORT,
  feature,
  noAnswer,
  staleSandboxAddress,
  STALLED,
  type Landed,
} from "./protocol.js";
import type { CloudRuntime } from "./runtime.js";
import { SANDBOX_PREFIX, sandboxThread, type SandboxWakeTrigger } from "./sandboxes.js";
import { baseBranch, binding, command, commands, localTeleports, projectCopyProgress, teleportBlocked, teleportProgress, type Binding } from "./store.js";

export interface TransferHooks {
  deliver: (threadId: string) => Promise<void>;
  progress: (threadId: string, steps: StartStep[], block?: "completed" | "failed") => void;
}

/** Coordinates Teleport sandboxes/freezes, project copies, cut-copy recovery, and branch setup. */
export class CloudTransfers {
  constructor(private readonly rt: CloudRuntime, private readonly hooks: TransferHooks) {}

  /** The core a thread's teleport picked, saved as its binding. */
  teleportUrl(threadId: string): string { return this.rt.peek(threadId)?.teleportUrl ?? ""; }

  /** A teleport's sandbox that slept or lost its Core keeps its saved address here: a hosted one then answers 404 or
   *  410, a VPS one a relay 502 (#1840). Forgets that address so the next client asks the website, which wakes it and
   *  restarts its Core. False when the error isn't one of those, or the teleport isn't going to a sandbox. */
  forgetTeleportSandbox(threadId: string, error: unknown): boolean {
    const sandbox = sandboxThread(this.teleportUrl(threadId));
    if (!sandbox || !(staleSandboxAddress(error) || (error instanceof CloudroomError && noAnswer(error)))) return false;
    this.rt.sandboxes.forget(sandbox);
    return true;
  }

  async teleportClient(threadId?: string, trigger?: SandboxWakeTrigger): Promise<CloudroomClient> {
    const existing = threadId ? binding(this.rt.host.db, threadId) : null;
    const sandbox = existing ? sandboxThread(existing.coreUrl) : threadId && await this.rt.newThreadsInSandboxes() ? threadId : null;
    if (sandbox) {
      // Teleported threads get their own sandbox too; this wakes it for the transfer.
      const coreUrl = SANDBOX_PREFIX + sandbox;
      if (threadId) this.rt.state(threadId).teleportUrl = coreUrl;
      return this.rt.client({ coreUrl } as Binding, true, trigger);
    }
    const connection = await this.rt.connection();
    const saved = threadId ? binding(this.rt.host.db, threadId) : null;
    if (saved && saved.coreUrl !== connection.url) {
      throw new ApiError(409, "cloudroom_connection_changed", "Restore this transfer's original cloud connection before continuing.");
    }
    if (threadId) this.rt.state(threadId).teleportUrl = connection.url;
    return new CloudroomClient(connection);
  }

  followTeleport(threadId: string): void { void this.hooks.deliver(threadId).catch(() => {}); }

  /** Teleport to Local holds Core's freeze (#237), renewed every 2 minutes: other computers' sends get 409 `moving`
   *  until it lands or lets go. `check` renews it and fails when Core queued a message this computer hasn't seen, which
   *  the move would lose. Older Cores have no freeze: null. */
  async freezeForTeleport(threadId: string, client: CloudroomClient, session: string): Promise<{ id: string; check: () => Promise<void>; end: (release: boolean) => void } | null> {
    if (!feature(await this.rt.capabilities(client), "cloud_threads")) return null;
    const id = randomUUID();
    await client.freeze(session, id).catch((error: unknown) => {
      // Core may have applied it before the reply failed: let go now, or every try is `moving` for 5 minutes (#1554).
      void client.freeze(session, id, true).catch(() => {});
      throw error;
    });
    const renew = setInterval(() => void client.freeze(session, id).catch((error: unknown) => this.rt.host.warn("Teleport's freeze could not be renewed", error, { threadId })), 120_000);
    renew.unref();
    const check = async () => {
      await client.freeze(session, id);
      // Only another computer's message would be lost; a loop's or Core's own prompt queued there is Core's.
      const queued = (await client.session(session)).queue;
      const here = new Set(commands(this.rt.host.db, threadId).map((item) => item.id));
      if (queued.some((request) => !here.has(request) && !CORE_OWN.test(request))) {
        throw new ApiError(409, "teleport_unavailable", "A message for this thread is still waiting in Cloud (sent from another computer, the phone or another agent). Teleport again once it has run. The thread stays in Cloud.");
      }
    };
    return {
      id,
      check,
      end: (release) => {
        clearInterval(renew);
        if (release) void client.freeze(session, id, true).catch(() => {});
      },
    };
  }

  /** Each sandbox works on its own branch, named after the thread: room/<name>-<id> (docs/scopes/sandboxes.md).
   *  `create` switches a fresh checkout to it, and says why if it could not; later calls only rename it to match a new
   *  title, before its first push. `onKept` hears of a branch the agent made, which `create` leaves as it is. Once a
   *  read timeout was asked again, a retry starts only until `retries` aborts, before the copy deadline (#2023). */
  async ensureBranch(threadId: string, create: boolean, onKept?: (branch: string) => void, retries?: AbortSignal): Promise<string | null> {
    const saved = binding(this.rt.host.db, threadId);
    const thread = this.rt.host.getThread(threadId);
    if (!saved?.sessionId || !thread || sandboxThread(saved.coreUrl) !== threadId) return null;
    const name = this.rt.host.suggestedBranchName(thread.title ?? thread.titleFallback ?? null, threadId);
    try {
      const client = await this.rt.client(saved, false), sessionId = saved.sessionId;
      // A new thread's lost answer (a dropped connection, a proxy's 504) is asked again (#1524). A try this app gave up
      // waiting for, such as a stuck fetch, is not run again.
      let late = false;
      const again = <T>(attempt: (signal: AbortSignal) => Promise<T>) => {
        let tries = 0, last: unknown;
        const once = () => {
          // Too close to the copy deadline, it fails at once with the last error, as main does.
          if (tries++ && late && retries?.aborted) return Promise.reject(new Error(last instanceof Error ? last.message : String(last)));
          const signal = AbortSignal.timeout(5 * 60_000);
          return attempt(signal).catch((error: unknown) => { last = error; throw signal.aborted && error instanceof Error ? new Error(error.message) : error; });
        };
        return create ? retry(once) : once();
      };
      // A read that outlasts the client's own 30-second deadline is a lost answer too, while a full Git switch still fits
      // before the copy deadline (#2023).
      const workspace = await again((signal) => client.sessionWorkspace(sessionId, signal).catch((error: unknown) => {
        if (signal.aborted || retries?.aborted || !(error instanceof DOMException && error.name === "AbortError")) throw error;
        late = true;
        throw new CloudroomConnectionError(error.message, error);
      }));
      if (create) this.hooks.progress(threadId, [{ key: "workspace", text: `Using workspace: ${workspace.path}`, status: "completed" }]);
      if (!workspace.head) return null;
      const quoted = `'${name}'`;
      // A warm project snapshot skips the clone, so switch to the chosen base branch here.
      const base = baseBranch(command(this.rt.host.db, `first_${threadId}`)?.input);
      const switchBase = base ? `[ "$current" = '${base}' ] || { git fetch -q origin '${base}' && git checkout -q -B '${base}' 'origin/${base}'; } 2>/dev/null; ` : "";
      // Only the branch Cloudroom's clone or snapshot checked out moves. One the agent made or checked out itself stays,
      // with its commits and any merge in progress (#1370, #1377). With no known default branch, it moves as before.
      const kept = 3;
      const own = `default=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null); [ -z "$default" ] || [ "$current" = "\${default#origin/}" ]${base ? ` || [ "$current" = '${base}' ]` : ""} || { printf '%s\\n' "$current"; exit ${kept}; }; `;
      const script = create
        ? `current=$(git symbolic-ref --quiet --short HEAD) || exit 0; case "$current" in room/*|cloudroom/*) ;; *) ${own}${switchBase}git pull -q --ff-only 2>/dev/null; git checkout -q -b ${quoted} ;; esac`
        : `current=$(git symbolic-ref --quiet --short HEAD) || exit 0; case "$current" in room/*|cloudroom/*) [ "$current" = ${quoted} ] || git rev-parse -q --verify "$current@{upstream}" >/dev/null || git branch -m ${quoted} ;; esac`;
      // One switch at a time per checkout: a retry waits for the try whose answer was lost, then finds its branch and
      // changes nothing, so the late try can't move the folder back to the base branch (#1524).
      const lock = `exec 9>>"$(git rev-parse --git-path cloudroom-branch.lock)" && flock 9; `;
      const result = await again((signal) => client.runOnVm({ command: `${lock}${script}\ngit symbolic-ref --quiet --short HEAD`, cwd: workspace.path }, signal));
      const branch = Buffer.from(result.stdout, "hex").toString().trim().split("\n").at(-1);
      if (branch) this.hooks.progress(threadId, [{ key: "branch", text: `Using branch: ${branch}`, status: "completed" }]);
      if (create && result.code === kept && branch) { onKept?.(branch); return null; }
      // A detached checkout exits 0 with no branch to switch. A failed or killed command, or any other branch, means the
      // switch failed (#816).
      if (!create || (result.code === 0 && (!branch || /^(room|cloudroom)\//.test(branch)))) return null;
      return `Cloudroom could not switch the folder to the thread's branch ${name}${branch ? `, so it is still on ${branch}` : ""}. Git said: ${Buffer.from(result.stderr, "hex").toString().trim().slice(-300) || `exit code ${result.code}`}`;
    } catch (error) {
      // A rename that fails never blocks the agent; the next title change retries.
      return create ? `Cloudroom could not set up the thread's branch ${name}: ${error instanceof Error ? error.message : String(error)}` : null;
    }
  }

  /** What a new thread's project copy does once it lands: the thread's own branch, a fork's or child's code, its start
   *  steps, and the status `room-cli files wait` reads (ADR 0209). A copy an app restart cut off lands the same way. */
  landing(threadId: string, client: CloudroomClient, started: Parameters<typeof landForkCode>[1] | null, files: boolean, workspace: string | null, marked: Promise<void> | null): Landed {
    // A status that could not be written is written again here, so the agent never waits on a stale `copying`.
    let final: string | undefined, last = client;
    const stop = new AbortController();
    // Branch setup retries only while its read and a full Git switch still fit before the deadline (#2023).
    const retries = marked && workspace ? AbortSignal.timeout(COPY_DEADLINE - 5.5 * 60_000) : undefined;
    const deadline = marked && workspace ? setTimeout(() => void (stop.abort(), marked).then(() => {
      // A copy still paused because its plan never ran (#1040) fails with its own error, card included.
      const parked = projectCopyProgress(this.rt.host.db, threadId);
      if (final === undefined && parked?.phase === "waiting" && parked.error) return this.unplannedFailed(last, threadId, workspace, parked.error);
      return this.filesState(last, threadId, workspace, final ?? `failed: ${STALLED}`, true);
    }), COPY_DEADLINE).unref() : undefined;
    const land = async (error?: string, current = client, partial?: string) => {
      if (files) this.hooks.progress(threadId, [{ key: "files", status: error ? "failed" : "completed" }]);
      const finish = async (failure?: string | null) => {
        // Past the deadline `files wait` may already have said failed, so `ready` only replaces a `copying` the deadline's
        // write missed, say while the sandbox slept.
        const late = !failure && stop.signal.aborted;
        final = failure ? `failed: ${failure}` : "ready"; last = current;
        if (!marked || !workspace) return clearTimeout(deadline);
        await marked.then(() => writeFilesState(current, workspace, final!, late)).then(() => clearTimeout(deadline),
          (err: unknown) => this.rt.host.warn("Could not save the project copy state for `room-cli files wait`", err, { threadId }));
      };
      const missing = error ?? partial;
      // `ready` comes after the branch, so the agent never starts work on the default branch.
      if (!started?.code) {
        const branch = await this.ensureBranch(threadId, true, undefined, retries);
        await finish(missing ?? branch);
        return;
      }
      // A fork's branch then moves to its source's code, so the agent sees what the source saw.
      let own: string | undefined;
      const branch = await this.ensureBranch(threadId, true, (kept) => { own = kept; }, retries);
      // Its hard reset would drop the commits on a branch the agent made itself, so that branch keeps its work (#1377).
      const failure = own
        ? `The folder was already on the agent's own branch ${own}, so it was kept and the source thread's code was not copied in.`
        : await landForkCode(current, started, stop.signal);
      // A child folder with no Git gets its repository only now, on a cloudroom/ branch: rename it to its room/ one
      // before the agent goes on.
      if (!failure) await this.ensureBranch(threadId, false);
      this.hooks.progress(threadId, [{ key: "fork", status: failure ? "failed" : "completed" }]);
      await finish(failure ?? missing ?? branch);
    };
    return (error, current, partial) => land(error, current, partial).catch((failure) => this.rt.host.warn("Cloud project copy did not land", failure, { threadId }));
  }

  /** Copies a new thread's project. If its sandbox sleeps or drops mid-copy (say, the usage cap paused it), the copy waits
   *  and restarts on the thread's next connection, up to 3 times, instead of failing. */
  copy(client: CloudroomClient, job: ProjectCopyJob, landed: Landed, after?: Promise<void>, tries = 0): void {
    copyProject(this.rt.host.deps, client, job, (error, partial) => {
      // A copy that falls short shows no error card, so the log is where we see how often it happens.
      if (error ?? partial) this.rt.host.warn("Cloud project copy fell short", error ?? partial, { threadId: job.threadId });
      return landed(error, client, partial);
    }, after, tries < 3 ? () => {
      this.rt.state(job.threadId).pausedCopy = { job, landed, tries: tries + 1 };
      // Reconnecting finds the sandbox's new address, or that it sleeps; the copy resumes once a stream connects.
      this.rt.detach(job.threadId);
    } : undefined);
  }

  /** During an outage, continues a Cloud thread from its older copy instead of waiting (ADR 20261113-202742). */
  async continueFromCopy(threadId: string): Promise<void> {
    const sandbox = sandboxThread(binding(this.rt.host.db, threadId)?.coreUrl ?? "");
    if (!sandbox) throw new ApiError(409, "cloudroom_unsupported", "Only Cloud threads have a copy.");
    await this.rt.sandboxes.continueFromCopy(sandbox);
  }

  /** Moves a VPS thread to Cloud (ADR 0319), when its VPS runs low. */
  async moveToCloud(threadId: string): Promise<void> {
    const sandbox = sandboxThread(binding(this.rt.host.db, threadId)?.coreUrl ?? "");
    if (!sandbox) throw new ApiError(409, "cloudroom_unsupported", "Only Cloud threads can move to Cloud.");
    await this.rt.sandboxes.move(sandbox);
  }

  /** "Try again" on a failed project copy: plans it again from the thread's first message, so it also works after a restart. */
  async retryCopy(threadId: string): Promise<void> {
    const saved = binding(this.rt.host.db, threadId);
    const input = command(this.rt.host.db, `first_${threadId}`)?.input;
    const workspace = copyWorkspace(input);
    if (!saved?.sessionId || !workspace) throw new ApiError(409, "cloudroom_no_project_copy", "This thread has no project to copy.");
    const client = await this.rt.client(saved);
    const job = await planProjectCopy(this.rt.host.deps, client, threadId, workspace, { key: copyKey(sandboxThread(saved.coreUrl), workspace), branch: baseBranch(input) });
    if (!job) throw new ApiError(409, "cloudroom_no_project_copy", "Nothing is left to copy, or a copy is already running.");
    // A full copy lands like a new thread's, on the thread's own branch, which a copy that never ran never made.
    if (job.clone || job.copyAll) this.copy(client, job, this.landing(threadId, client, null, true, workspace, this.filesState(client, threadId, workspace, "copying")));
    else this.copyInto(client, job);
  }

  /** A folder that already has files gets only its `.env` files again, so a copy cut short stays failed, never ready.
   *  A moved thread's copy (Teleport's, into an empty folder) is full too: `room-cli files wait` waits for it and says if
   *  it failed, and one a dropped request or a sleeping sandbox cut off resumes on the next connection (#1970). */
  copyInto(client: CloudroomClient, job: ProjectCopyJob, done?: () => void): void {
    const full = job.clone || job.copyAll || job.teleport;
    const marked = full ? this.filesState(client, job.threadId, job.workspace, "copying") : Promise.resolve();
    this.copy(client, job, (error, current = client, partial) => marked.then(() => this.filesState(
      current, job.threadId, job.workspace, error ?? partial ? `failed: ${error ?? partial}` : full ? "ready" : `failed: ${CUT_SHORT}`, !full,
    )).then(done));
  }

  /** Goes on with a paused copy: when the thread's stream connects, and when a move finishes, since a restarted app's copy
   *  of a move still running waits for it, while the stream may stay connected (#1970). */
  resumeCopy(threadId: string, client: CloudroomClient): void {
    const entry = this.rt.peek(threadId);
    const paused = entry?.pausedCopy;
    // After an app restart only the saved phase is left (`pauseCutCopy`), so the copy is planned again.
    if (!paused) {
      if (projectCopyProgress(this.rt.host.db, threadId)?.phase === "waiting" && !entry?.retryingCopy && !this.copyBusy(threadId)) {
        void this.resumeCutCopy(threadId, client).catch((error) => this.rt.host.warn("Cloud project copy did not resume", error, { threadId }));
      }
      return;
    }
    entry.pausedCopy = undefined;
    // The agent may have started meanwhile, so a move's edits go aside (#1970).
    this.copy(client, { ...paused.job, resumed: true }, paused.landed, undefined, paused.tries);
  }

  /** A copy the last app run cut off before it landed waits as paused, and resumeCopy plans it again once the thread's
   *  stream connects (#106), a move's too (#1970). A copy still running in this app is left alone. */
  pauseCutCopy(threadId: string): void {
    const phase = projectCopyProgress(this.rt.host.db, threadId)?.phase;
    if ((phase === "cloning" || phase === "uploading") && !copyRunning(threadId) && this.copyTarget(threadId)) {
      reportProjectCopy(this.rt.host.deps, threadId, { phase: "waiting", completed: 0, total: 0 });
    }
  }

  /** Plans a copy the last app run cut off again, once the thread's stream connects (#106). An empty folder gets the copy
   *  and branch a new thread gets, but no fork's or child's code, which would replace whatever the agent did meanwhile:
   *  the agent is told. A folder that already has files may hold the agent's work, so it only gets missing `.env` files,
   *  and the copy ends as cut short. */
  private async resumeCutCopy(threadId: string, client: CloudroomClient): Promise<void> {
    const saved = binding(this.rt.host.db, threadId);
    const target = this.copyTarget(threadId);
    const input = target?.input, workspace = target?.workspace;
    if (!saved?.sessionId || !workspace) {
      reportProjectCopy(this.rt.host.deps, threadId, { phase: "complete", completed: 0, total: 0 });
      if (workspace) void this.filesState(client, threadId, workspace, `failed: ${CUT_SHORT}`, true);
      return;
    }
    // Set for a new thread's copy that was never planned (#1040): it fails instead, as it would have at once.
    const unplanned = projectCopyProgress(this.rt.host.db, threadId)?.error;
    // Stopping the service, or archiving or deleting the thread, while the plan runs leaves its folder alone.
    const epoch = this.rt.epoch;
    const ended = () => { const thread = this.rt.host.getThread(threadId); return epoch !== this.rt.epoch || !thread || Boolean(thread.archivedAt || thread.deletedAt); };
    this.rt.state(threadId).retryingCopy = true;
    try {
      // A sandbox that can't be reached, or a folder another copy is filling, throws, so the copy waits for the next connection.
      const key = copyKey(sandboxThread(saved.coreUrl), workspace);
      const plan = target.moved ? { localPath: target.moved, teleport: true, resumed: true } : { branch: baseBranch(input) };
      const job = await planProjectCopyOrThrow(this.rt.host.deps, client, threadId, workspace, {
        key, ...plan, ...(unplanned ? { signal: AbortSignal.timeout(30_000) } : {}),
      }).catch((error: unknown) => {
        if (!unplanned || keyCopying(key) || this.copyBusy(threadId) || ended()) throw error;
        this.unplannedFailed(client, threadId, workspace, unplanned);
        return undefined;
      });
      if (job === undefined || ended()) return;
      // A move, or another copy, that started meanwhile brings its own.
      if (this.copyBusy(threadId) || this.copyTarget(threadId)?.workspace !== workspace) return;
      // A move's copy still marked `copying` goes on: a clone that landed isn't repeated, and its edits go aside (#1970).
      if (target.moved) {
        if (job) return this.copyInto(client, job);
        reportProjectCopy(this.rt.host.deps, threadId, { phase: "complete", completed: 0, total: 0 });
        return void this.filesState(client, threadId, workspace, `failed: ${CUT_SHORT}`, true);
      }
      if (job && (job.clone || job.copyAll)) {
        // Only a first copy cut off before its fork's or child's code landed lost that code; a move's or a retry's never had it.
        const lost = startStepRunning(this.rt.host.db, threadId, "fork") ? "The app restarted while copying the source thread's code, so it was not copied." : undefined;
        if (lost) this.hooks.progress(threadId, [{ key: "fork", status: "failed" }]);
        const landed = this.landing(threadId, client, null, true, workspace, this.filesState(client, threadId, workspace, "copying"));
        this.copy(client, job, (error, current, partial) => landed(error, current, lost ?? partial));
        return;
      }
      reportProjectCopy(this.rt.host.deps, threadId, { phase: "complete", completed: 0, total: 0 });
      this.hooks.progress(threadId, [], "failed");
      if (job) this.copyInto(client, job);
      else void this.filesState(client, threadId, workspace, `failed: ${unplanned ?? CUT_SHORT}`, true);
    } finally {
      const entry = this.rt.peek(threadId);
      if (entry) entry.retryingCopy = false;
    }
  }

  /** A new thread's copy that could not be planned (#1040) fails like any failed copy: the card shows only for a project
   *  with no folder on the Mac, and `room-cli files wait` stops waiting. */
  private unplannedFailed(client: CloudroomClient, threadId: string, workspace: string, error: string): Promise<void> {
    const local = localProjectPath(this.rt.host.deps, this.rt.host.getThread(threadId)?.projectId ?? "");
    reportProjectCopy(this.rt.host.deps, threadId, local ? { phase: "complete", completed: 0, total: 0 } : { phase: "error", completed: 0, total: 0, error });
    return this.filesState(client, threadId, workspace, `failed: ${error}`, true);
  }

  /** A copy runs, or a move or Teleport brings its own, so no other may start. */
  private copyBusy(threadId: string): boolean {
    return copyRunning(threadId) || Boolean(this.rt.peek(threadId)?.switching) || teleportBlocked(this.rt.host.db, threadId) || localTeleports.has(threadId);
  }

  private filesState(client: CloudroomClient, threadId: string, workspace: string, state: string, onlyIfCopying = false): Promise<void> {
    return writeFilesState(client, workspace, state, onlyIfCopying)
      .catch((error) => this.rt.host.warn("Could not save the project copy state for `room-cli files wait`", error, { threadId }));
  }

  /** The folder a thread's project copy fills: its first message's, or, for a moved thread, which has none, the one in
   *  Teleport's saved transfer, with the Mac folder it left (`moved`), so an app restart can resume it (#1970). */
  private copyTarget(threadId: string): { workspace: string; input?: string; moved?: string } | null {
    const input = command(this.rt.host.db, `first_${threadId}`)?.input;
    if (input) { const workspace = copyWorkspace(input); return workspace ? { workspace, input } : null; }
    const id = teleportProgress(this.rt.host.db, threadId)?.id;
    const state = z.object({ workspacePath: z.string(), manifest: z.object({ workspace: z.string() }) }).safeParse(JSON.parse((id && command(this.rt.host.db, id)?.input) || "{}")).data;
    return state ? { workspace: state.manifest.workspace, moved: state.workspacePath } : null;
  }
}
