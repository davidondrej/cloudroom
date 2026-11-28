import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { PERSONAL_PROJECT_ID, type ThreadEventType } from "@cloudroom/domain";
import { ApiError } from "../../errors.js";
import { macClaudeSignedIn } from "./claude-token.js";
import { CloudroomClient, CloudroomConnectionError, CloudroomError, UPLOAD_PART, type VmRun, type VmRunResult } from "./client.js";
import { CloudSync, type SyncHost } from "./cloud-sync.js";
import { appRequestId, CloudThreadStates, installTag, tagOf, type CloudThreadState } from "./cloud-threads.js";
import { CodexAccounts } from "./codex-accounts.js";
import { uploadInParts } from "./fork.js";
import { CloudGitError, savedWorkspacePath } from "./git.js";
import { GpuApprovals } from "./gpu.js";
import { CloudHostBridge, createKeyedLock } from "./host-bridge.js";
import { noteWake } from "./previews.js";
import { cloudRepository, workspaceName, type ProjectCopyJob } from "./project-copy.js";
import {
  assertThreadOwner,
  capabilitiesSchema,
  CHECKOUT_READ_TIMEOUT_MS,
  CLEAR_DISK,
  connectionSchema,
  HOSTED_WEBSITE,
  keySourceOf,
  publicError,
  retiredVmMessage,
  sandboxAccountOf,
  sandboxTransition,
  savedConnectionSchema,
  staleSandboxAddress,
  storageMessage,
  storageSchema,
  WEBSITE_CHILD,
  connectionFailure,
  type Capabilities,
  type Connection,
  type ConnectionIssue,
  type ConnectionPhase,
  type DiskState,
  type LabelChange,
  type Landed,
  type SavedConnection,
  type Storage,
} from "./protocol.js";
import {
  cloudPausedError,
  hasMacCodexLogin,
  SANDBOX_PREFIX,
  SandboxAsleep,
  SandboxDirectory,
  sandboxThread,
  type AutomationRun,
  type SandboxProject,
  type SandboxWakeTrigger,
} from "./sandboxes.js";
import { CloudSecrets } from "./secrets.js";
import { binding, command, coreInUse, saveBinding, type Binding } from "./store.js";
import { copyMacLogin, loginMarkers, markLogin, stopSync } from "./sync.js";

/** Unified per-thread ephemeral runtime state. */
export interface ThreadState {
  stream?: AbortController;
  streamError?: string;
  connectionIssues?: Partial<Record<ConnectionPhase, ConnectionIssue>>;
  sleptAtCheck?: number;
  /** True when local status was forced `idle` (via asleep/readHistory) past records, so next connect syncs Core's state. */
  needsStatusSync?: boolean;
  /** Threads whose running turn this app saw cut off when their sandbox stopped, with the lookups made since. */
  cutOffTries?: number;
  delivery?: Promise<void>;
  switching?: boolean;
  activeSends: number;
  /** The last Stop receipt seen per thread, for the queue's "paused by Stop" label only (#967). */
  stopReceipt?: { session: string; at: number };
  /** Threads whose cloud disk is full or low, from Core's storage records. The composer shows one live card for it. */
  disk?: DiskState;
  outOfMemory?: boolean;
  /** Failed tries to mark a new thread's files status, so a lasting failure fails its start (#816). */
  prepTries: number;
  /** When Core began refusing a thread's start with a retryable 409, until another outcome (#865). */
  refusedSince?: number;
  catchUpTries: number;
  /** How often each thread's sandbox address answered as stale (404 or 410) and was woken again since its last
   *  delivery went through (feedback #596, #1076). */
  rewoken: number;
  /** The Cloud Credits level (80 or 95 %) each Cloud thread's agent was last told, so each note comes once (#610). */
  creditsTold: number;
  leftParent?: number | string;
  /** Session and cursor each opened thread's history was last read to, "reading" while one read runs, or when a
   *  failed read may be tried again. */
  historyState?: string;
  /** The read running per thread, so an archive's prune can wait for one already in flight. */
  historyRead?: Promise<void>;
  /** One load of earlier sessions per thread at a time: a wake while it reads joins it instead of adding them twice. */
  earlierLoad?: Promise<void>;
  labelKey?: string;
  labelSave?: Promise<void>;
  /** Read once per thread and run (the 1.5 s tick asks for every open binding without state). */
  firstState?: Pick<CloudThreadState, "home" | "from">;
  sentQueue?: string;
  // Kept per thread: teleports run at the same time, and one shared value gave threads each other's sandboxes.
  teleportUrl?: string;
  pausedCopy?: { job: ProjectCopyJob; landed: Landed; tries: number };
  // Threads whose cut copy resumeCutCopy is planning, so a reconnect meanwhile can't plan a second.
  retryingCopy?: boolean;
  /** An Undo here whose restore hasn't landed, by sandbox: the thread restored. A wake that finds the sandbox archived
   *  sends it again; nothing else may restore an archive. */
  undo?: string;
  /** Restores sent from here, by sandbox: when the website took each, `Infinity` until it does. */
  restore?: { at: number };
}

export interface RuntimeHooks {
  beforeWake?: () => Promise<void>;
  onWakeNoted?: () => void;
  adoptRun?: (run: AutomationRun) => Promise<void>;
  disconnectRefused?: (token: string) => Promise<void>;
  restartAwake?: (providerId: "claude-code" | "codex") => void;
  syncLabel?: (threadId: string, change: LabelChange, tries?: number, resend?: boolean) => void;
  renameShared?: (threadId: string) => Promise<void>;
  queueSnapshot?: (threadId: string) => unknown[];
  measureDisk?: (threadId: string, client: CloudroomClient) => void;
  restore?: (threadId: string, retry?: boolean) => Promise<void>;
}

const emptyThreadState = (): ThreadState => ({ activeSends: 0, prepTries: 0, catchUpTries: 0, rewoken: 0, creditsTold: 0 });

export class CloudRuntime implements SyncHost {
  readonly threads = new Map<string, ThreadState>();
  // Renderers get a local acknowledgement first. A fast Undo must reach Cloud after its archive.
  readonly inArchiveOrder = createKeyedLock<string>();
  /** Runs an awake answer named, so each asks for a list once (#237). */
  readonly runsSeen = new Set<string>();
  /** Runs an older website's awake answer named that this computer can't show, warned about once (#1072). */
  readonly runsSkipped = new Set<string>();
  /** Cores whose harness switches models in its session (`set_model`), by Core and harness. A Core never loses it. */
  readonly modelSwitchers = new Set<string>();
  readonly hooks: RuntimeHooks = {};

  readonly secrets: CloudSecrets;
  readonly gpuApprovals: GpuApprovals;
  readonly sandboxes: SandboxDirectory;
  readonly codexAccounts: CodexAccounts;
  readonly threadStates: CloudThreadStates;
  readonly sync: CloudSync;

  stopped = false;
  epoch = 0;
  lastCapabilities: Capabilities | null = null;
  /** What sandboxes run, kept apart from a VM's: an account with both starts new threads in sandboxes. */
  sandboxCapabilities: Capabilities | null = null;
  private nextCapabilitiesAsk = 0;
  private configurationWrite: Promise<void> = Promise.resolve();
  private readonly recordWrites = new Map<string, Promise<void>>();
  private savedCache: { key: string; value: z.infer<typeof savedConnectionSchema> } | null = null;
  private tag = "";

  constructor(readonly host: CloudHostBridge) {
    // One computer answers a form left open until it times out: the turn's owner, or home (#237).
    this.secrets = new CloudSecrets(host.deps, (threadId) => this.ownsTurn(threadId, binding(host.db, threadId)?.turnId ?? ""));
    this.threadStates = new CloudThreadStates(join(host.config.dataDir, "cloudroom-thread-state.json"));
    this.sync = new CloudSync(host.deps, this);
    this.sandboxes = new SandboxDirectory(async () => sandboxAccountOf(await this.savedConnection()), (thread) => {
      void noteWake(host.deps, thread).catch(() => {});
      this.hooks.onWakeNoted?.();
    }, join(host.config.dataDir, "cloudroom-skills-copied.json"));
    // A website that lists threads brings runs through the one adoption path (cloud-sync.ts); an older one, as before.
    // The minute's awake answer repeats the last week's runs, so only a run new here, once per app run, asks for a list.
    this.sandboxes.onRuns = (runs) => void this.sandboxes.followsThreads().catch(() => null).then((follows) => {
      if (follows === null) return;
      if (!follows) {
        for (const run of runs) void this.hooks.adoptRun?.(run).catch((error: unknown) => this.host.warn("A Cloud thread could not be shown", error, { threadId: run.thread }));
        return;
      }
      const fresh = runs.filter((run) => !this.runsSeen.has(run.thread) && !this.host.getThread(run.thread));
      for (const run of runs) this.runsSeen.add(run.thread);
      if (fresh.length) this.sync.changed();
    });
    this.sandboxes.onSignedOut = (token) => void this.hooks.disconnectRefused?.(token).catch((error: unknown) => this.host.warn("The sign-out the website asked for was not saved", error));
    this.sandboxes.keySource = (thread) => keySourceOf(command(host.db, `first_${thread}`)?.input);
    this.sandboxes.skipLogins = async () => {
      const markers = await loginMarkers(host.deps);
      // Disconnect signed these CLIs out, so a login on this Mac now is a new sign-in (ADR 0327).
      const signedInAgain = { codex: hasMacCodexLogin, claude: async () => await macClaudeSignedIn() === true };
      for (const [name, signedIn] of Object.entries(signedInAgain)) {
        if (markers[name] === "signed-out" && await signedIn()) {
          await markLogin(host.deps, name, null);
          delete markers[name];
        }
      }
      const skip = new Set(Object.keys(markers));
      if (!await copyMacLogin(host.deps, "cursor")) skip.add("cursor");
      return skip;
    };
    this.gpuApprovals = new GpuApprovals(host.deps, (body) => this.sandboxes.gpu(body));
    this.codexAccounts = new CodexAccounts(
      (body, account) => this.sandboxes.codexAccounts(body, account),
      () => this.sandboxes.account(),
      join(host.config.dataDir, "cloudroom-codex-accounts.json"),
      () => this.hooks.restartAwake?.("codex"),
    );
    // Renames, generated titles, agent renames, and new parents (a promoted subagent loses its parent's access) all
    // reach the website. Read after the change's transaction ends. A change that came from Core or the website goes nowhere.
    host.onThreadChanged((threadId, changes) => {
      if (changes.includes("title-changed")) setImmediate(() => { this.hooks.syncLabel?.(threadId, "title"); void this.hooks.renameShared?.(threadId); });
      if (changes.includes("execution-options-changed")) setImmediate(() => this.hooks.syncLabel?.(threadId, "model"));
      if (changes.includes("parent-changed")) setImmediate(() => this.hooks.syncLabel?.(threadId, "parent"));
    });
  }

  get archiveRequest() { return this.host.hooks.archiveRequest; }

  state(threadId: string): ThreadState {
    let entry = this.threads.get(threadId);
    if (!entry) { entry = emptyThreadState(); this.threads.set(threadId, entry); }
    return entry;
  }

  peek(threadId: string): ThreadState | undefined { return this.threads.get(threadId); }

  detach(threadId: string): void {
    const s = this.threads.get(threadId);
    if (!s) return;
    s.stream?.abort();
    s.stream = undefined;
    s.streamError = undefined;
    s.connectionIssues = undefined;
  }

  clearAllStreamsAndIssues(): void {
    for (const s of this.threads.values()) {
      s.stream?.abort();
      s.stream = undefined;
      s.connectionIssues = undefined;
      s.sleptAtCheck = undefined;
    }
  }

  quietly<T>(threadId: string | null, apply: () => T): T { return this.host.quietly(threadId, apply); }

  /** A thread the website's list brought here (cloud-sync.ts): an asleep one waits for its sandbox's wake. */
  adopted(threadId: string, awake: boolean): void {
    if (!awake) this.state(threadId).sleptAtCheck = this.sandboxes.awakeChecks;
    void this.sync.arrived(threadId).catch(() => {});
  }

  resendLabel(threadId: string, change: string): void { this.hooks.syncLabel?.(threadId, change as LabelChange, 0, true); }
  /** A list asked `at` is older than this computer's restore of the thread: its archived row is the past. */
  restoredSince(threadId: string, at: number): boolean { return (this.peek(threadId)?.restore?.at ?? 0) > at; }

  /** This install's tag, on every prompt, steer, edit and rewind it sends (#237, cloud-threads.ts). */
  async me(): Promise<string> { return this.tag ||= await installTag(this.host.config.dataDir); }

  /** A send's request ID, tagged; a retry of one an older app version saved keeps its own. */
  async requestId(threadId: string, raw: string = randomUUID()): Promise<string> {
    return command(this.host.db, raw)?.threadId === threadId ? raw : appRequestId(await this.me(), raw);
  }

  /** The computer that acts for a thread (docs/scopes/cloud-threads.md "Who acts"): the one whose tag is on its latest
   *  app prompt. Until there is one, the starter (saved as home when its state is made, so it survives a restart); for
   *  a website child or a shared session, the home of its parent; for a loop run or launch, each computer with its
   *  project ID. A computer that adopted another's start has `ELSEWHERE`, which is never home. */
  isHome(threadId: string, depth = 0): boolean {
    const state = this.threadStates.get(threadId) ?? this.firstState(threadId);
    if (state.home) return state.home === this.tag;
    return Boolean(state.from) && depth < 8 && this.isHome(state.from!, depth + 1);
  }

  /** Who acts for a thread with no state yet: one started here or brought here by an older path, which on main acted. */
  firstState(threadId: string): Pick<CloudThreadState, "home" | "from"> {
    const remembered = this.peek(threadId)?.firstState;
    if (remembered && this.tag) return remembered;
    const saved = binding(this.host.db, threadId);
    const sandbox = saved ? sandboxThread(saved.coreUrl) : null;
    const child = Boolean(saved && ((sandbox && sandbox !== threadId) || saved.startRequestId?.startsWith(WEBSITE_CHILD)));
    const found: Pick<CloudThreadState, "home" | "from"> = child
      ? { home: null, from: this.host.getThread(threadId)?.parentThreadId ?? null }
      : { home: this.tag || null, from: null };
    if (this.tag) this.state(threadId).firstState = found;
    return found;
  }

  /** A turn belongs to the install whose tag is on its prompt; an untagged one (loop, phone, `tell`, Core's) to home. */
  ownsTurn(threadId: string, requestId: string): boolean {
    const tag = tagOf(requestId);
    return tag ? tag === this.tag : this.isHome(threadId);
  }

  get connectionPath(): string { return join(this.host.config.dataDir, "cloudroom.json"); }
  private get capabilitiesPath(): string { return join(this.host.config.dataDir, "cloudroom-capability-cache.json"); }

  async savedConnection(): Promise<SavedConnection> {
    try {
      const info = await stat(this.connectionPath);
      // win32: NTFS has no POSIX mode bits; stat.mode reports group/other bits
      // on every file, so the 0o077 check rejects all files. ACLs govern there.
      if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("permissions");
      const key = `${info.ino}:${info.size}:${info.mtimeMs}`;
      if (this.savedCache?.key === key) return this.savedCache.value;
      const value = savedConnectionSchema.parse(JSON.parse(await readFile(this.connectionPath, "utf8")));
      this.savedCache = { key, value };
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new ApiError(503, "cloudroom_config_invalid", "The private Cloudroom connection could not be read safely.");
    }
  }

  async saveConnection(value: unknown): Promise<void> {
    this.savedCache = null;
    await mkdir(this.host.config.dataDir, { recursive: true });
    const temporary = `${this.connectionPath}.${randomUUID()}`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.connectionPath);
    } finally { await rm(temporary, { force: true }); }
  }

  changeConnection(action: () => Promise<void>): Promise<void> {
    const work = this.configurationWrite.then(action);
    this.configurationWrite = work.catch(() => {});
    return work;
  }

  async connection(snapshot?: SavedConnection): Promise<Connection> {
    const saved = snapshot === undefined ? await this.savedConnection() : snapshot;
    if (saved?.sandboxToken && (!saved.token || !saved.url)) {
      throw new ApiError(409, "cloudroom_sandbox_only", "This action needs a cloud thread. Each cloud thread has its own sandbox, not one shared VM.");
    }
    if (!saved?.token) throw new ApiError(503, "cloudroom_not_configured", "Cloud needs a free Cloudroom account. Sign in to use it.");
    const { account: _account, websiteUrl: _website, onboarding: _onboarding, sandboxToken: _sandboxToken, ...connection } = saved;
    return connectionSchema.parse(connection);
  }

  /** Every hosted VM is retired (docs/scopes/sandboxes.md), but a Mac that signed in before keeps its dead address, which
   *  stalls cloud previews and sync. Only hosted accounts with sandboxes have all three fields; self-hosted VMs have no account.
   *  Returns the saved connection. */
  async dropRetiredVm(): Promise<SavedConnection> {
    const retired = (saved: SavedConnection) => Boolean(saved?.url && saved.account && saved.sandboxToken && (saved.websiteUrl ?? HOSTED_WEBSITE) === HOSTED_WEBSITE);
    const saved = await this.savedConnection();
    if (!retired(saved)) return saved;
    await this.changeConnection(async () => {
      const current = await this.savedConnection();
      if (!current || !retired(current)) return;
      const { url: _url, token: _token, gateToken: _gateToken, ...rest } = current;
      await this.saveConnection(rest);
      await stopSync(this.host.deps);
    }).catch(() => {});
    return this.savedConnection();
  }

  /** New cloud threads get their own sandbox when the account has sandboxes (docs/scopes/sandboxes.md). */
  async sandboxMode(): Promise<boolean> {
    const saved = await this.savedConnection();
    return Boolean(saved?.sandboxToken && saved.account);
  }

  /** Where new cloud threads go. An account that moved back to its VM starts them there; its sandbox threads carry on. */
  async newThreadsInSandboxes(): Promise<boolean> {
    const saved = await this.savedConnection();
    if (!saved?.sandboxToken || !saved.account) return false;
    return !saved.token || await this.sandboxes.forNewThreads();
  }

  /** Sandboxes sleep, so remember the latest sandbox capabilities for the model picker. */
  async rememberCapabilities(capabilities: Capabilities, sandbox: boolean): Promise<void> {
    this.lastCapabilities = capabilities;
    if (!sandbox) return;
    const changed = JSON.stringify(this.sandboxCapabilities) !== JSON.stringify(capabilities);
    this.sandboxCapabilities = capabilities;
    if (changed) await writeFile(this.capabilitiesPath, JSON.stringify(capabilities), { mode: 0o600 }).catch(() => {});
  }

  /** Asks the website what the cloud offers, so a new account knows before its first sandbox runs. The saved copy is
   *  only a fallback: ask every minute, or every 15 s until a spare can answer. */
  async learnSandboxCapabilities(): Promise<void> {
    if (Date.now() < this.nextCapabilitiesAsk) return;
    this.nextCapabilitiesAsk = Date.now() + 15_000;
    const raw = await this.sandboxes.capabilities();
    if (!raw) return;
    await this.rememberCapabilities(capabilitiesSchema.parse(raw), true);
    this.nextCapabilitiesAsk = Date.now() + 60_000;
  }

  async savedCapabilities(): Promise<Capabilities | null> {
    if (this.sandboxCapabilities) return this.sandboxCapabilities;
    try { this.sandboxCapabilities = capabilitiesSchema.parse(JSON.parse(await readFile(this.capabilitiesPath, "utf8"))); }
    catch { return null; }
    return this.sandboxCapabilities;
  }

  sandboxProject(projectId = PERSONAL_PROJECT_ID): SandboxProject {
    const project = this.host.getProject(projectId);
    return {
      id: project?.id ?? PERSONAL_PROJECT_ID,
      repository: project && project.id !== PERSONAL_PROJECT_ID ? cloudRepository(project.gitRemoteUrl) : null,
      folder: workspaceName(project?.name ?? "project"),
    };
  }

  /** Cloud threads stamped with another account stay locked until that account signs in again (docs/scopes/sandboxes.md). */
  async otherAccountThread(saved: Binding): Promise<boolean> {
    return Boolean(saved.accountId) && saved.accountId !== (await this.savedConnection())?.account?.id;
  }

  /** The only API keys the sandbox a thread runs in gets (ADR 0342): null for every key and for threads without a
   *  sandbox, like a VM's, and undefined when the website has no row for it or doesn't confirm one. `saved`: its
   *  binding, if this app's copy is gone. A sandbox with a list gets nothing from this Mac at its agent's request, and
   *  reaches no thread outside its tree (ADR 0286). */
  async keyList(threadId: string, saved?: Binding): Promise<string[] | null | undefined> {
    const sandbox = sandboxThread((binding(this.host.db, threadId) ?? saved)?.coreUrl ?? "");
    return sandbox ? this.sandboxes.loopSecrets(sandbox, true) : null;
  }

  /** Capture the signed-in account once; check the entire family before changing any thread. */
  async threadOwnerCheck() {
    const accountId = (await this.savedConnection())?.account?.id;
    return (owner: string | null | undefined) => assertThreadOwner(owner, accountId);
  }

  async requireOwnThread(saved: Binding): Promise<void> {
    if (saved.accountId) (await this.threadOwnerCheck())(saved.accountId);
  }

  async coreConnection(saved?: Binding, wakeFor: boolean | (() => boolean) = true, trigger?: SandboxWakeTrigger, fresh = false): Promise<{ url: string; token: string; gateToken?: string }> {
    if (saved) await this.requireOwnThread(saved);
    const sandbox = saved ? sandboxThread(saved.coreUrl) : null;
    if (sandbox) {
      const wakes = () => typeof wakeFor === "function" ? wakeFor() : wakeFor;
      if (wakes()) await this.hooks.beforeWake?.();
      const wake = wakes();
      const thread = this.host.getThread(sandbox);
      const project = this.sandboxProject(thread?.projectId), parent = thread?.parentThreadId ?? undefined;
      // A sandbox archived while one of its threads is active comes back only for an Undo here whose restore didn't land.
      // Any other archive (its agent's, another computer's, one the list is still applying) wins, and the list brings it
      // here (#2246).
      const found = await this.sandboxes.connection(sandbox, project, wake, trigger, fresh, parent).catch(async (error: unknown) => {
        if (!(error instanceof CloudroomError && error.code === "sandbox_archived") || !coreInUse(this.host.db, SANDBOX_PREFIX + sandbox)) throw error;
        const undo = this.peek(sandbox)?.undo;
        if (!undo || this.host.getThread(undo)?.archivedAt !== null) { this.sync.changed(); throw error; }
        await this.hooks.restore?.(undo, true);
        return this.sandboxes.connection(sandbox, project, wake, trigger, fresh, parent);
      });
      if (!found) throw new SandboxAsleep();
      return found;
    }
    const connection = await this.connection();
    if (saved && connection.url !== saved.coreUrl) {
      throw new ApiError(409, "cloudroom_connection_changed", "This thread belongs to a different core connection. Restore its connection before continuing.");
    }
    return connection;
  }

  /** A thread's Core. Sandbox threads wake only when `wake` is true, for work that must be sent; a function is asked
   *  again right before the wake, since an offline Stop (#553) can cancel the work while logins sync. */
  async client(saved?: Binding, wake: boolean | (() => boolean) = true, trigger?: SandboxWakeTrigger, fresh = false): Promise<CloudroomClient> {
    return new CloudroomClient(await this.coreConnection(saved, wake, trigger, fresh));
  }

  async threadClient(threadId: string, wake = true, trigger?: SandboxWakeTrigger): Promise<CloudroomClient> {
    const saved = binding(this.host.db, threadId);
    if (!saved) throw new ApiError(409, "cloudroom_thread_unstarted", "This cloud thread has not started yet.");
    return this.client(saved, wake, trigger);
  }

  /** Where a cloud thread's terminal runs: its Core, woken first, and the session whose folder the shell opens in. */
  async terminalConnection(threadId: string): Promise<{ url: string; token: string; gateToken?: string; session: string | null }> {
    const saved = binding(this.host.db, threadId);
    if (!saved) throw new ApiError(409, "cloudroom_missing_binding", "This cloud thread has no cloud sandbox yet. Send it a message, then open the terminal.");
    const { url, token, gateToken } = await this.coreConnection(saved, true, "thread_view");
    return { url, token, ...(gateToken ? { gateToken } : {}), session: saved.sessionId ?? null };
  }

  async storage(client: CloudroomClient): Promise<Storage | null> {
    let health: Record<string, unknown>;
    try { health = await client.health(AbortSignal.timeout(5000)); }
    catch (error) {
      if (error instanceof CloudroomError && error.status === 404) return null;
      if (error instanceof DOMException && error.name === "AbortError") throw new CloudroomConnectionError("Cloud storage health request timed out. Available disk space is unknown.", error);
      throw error;
    }
    if (health.storage === undefined) return null;
    const parsed = storageSchema.safeParse(health.storage);
    if (!parsed.success) throw new ApiError(503, "cloudroom_storage_unknown", "Cloud storage status is invalid. Available disk space is unknown.");
    const storage = parsed.data;
    // Core never reports a reading older than 5 s on its own clock (`Guard::snapshot`). A sandbox clock that drifts from
    // the Mac's can make a 30 s age check here fail with ample space (#1463).
    if (storage.enabled && storage.reason === "measurement_unavailable") {
      return { ...storage, level: "blocked", reason: "measurement_unavailable", workspace_available_bytes: null, history_available_bytes: null, workspace_total_bytes: null, history_total_bytes: null };
    }
    return storage;
  }

  async capabilities(client: CloudroomClient, storage?: Storage | null): Promise<Capabilities> {
    const message = storageMessage(storage === undefined ? await this.storage(client) : storage);
    if (message) throw new ApiError(503, "storage_blocked", message, { retryable: true });
    return capabilitiesSchema.parse(await client.capabilities());
  }

  async liveCapabilities(saved: Binding): Promise<Capabilities> {
    try { return await this.capabilities(await this.client(saved)); }
    catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, error instanceof CloudroomError ? error.code ?? "cloudroom_unavailable" : "cloudroom_unavailable", publicError(error));
    }
  }

  async queueCapabilities(saved: Binding): Promise<Capabilities> {
    await this.requireOwnThread(saved);
    const known = sandboxThread(saved.coreUrl) ? await this.savedCapabilities() : this.lastCapabilities;
    return known ?? await this.liveCapabilities(saved);
  }

  /** Runs `CLEAR_DISK` through Core's emergency access, which still works while a full disk pauses the agent.
   *  Once space is back, Core resumes work and the waiting message sends by itself. */
  async clearDisk(threadId: string): Promise<{ freedBytes: number }> {
    const result = await this.runOnVm({ command: CLEAR_DISK }, threadId, AbortSignal.timeout(10 * 60_000));
    const output = Buffer.from(result.stdout, "hex").toString().trim();
    const freed = Number(output.split("\n").at(-1));
    if (result.code !== 0 || result.truncated || !output || !Number.isFinite(freed)) {
      throw new ApiError(503, "cloud_disk_clear", "Caches and builds could not be cleared. Try again.");
    }
    const saved = binding(this.host.db, threadId);
    if (saved) void this.client(saved).then((client) => this.hooks.measureDisk?.(threadId, client), () => {});
    return { freedBytes: Math.max(0, freed) };
  }

  /** Mac → cloud access (ADR 0113). Local agents reach this through `room-cli vm`.
   *  `threadId` picks a Cloud thread's sandbox and wakes it; without one, only the account's VM can run it. */
  async runOnVm(input: VmRun, threadId?: string, signal?: AbortSignal): Promise<VmRunResult> {
    const saved = threadId ? binding(this.host.db, threadId) ?? undefined : undefined;
    if (threadId && !saved) throw new ApiError(404, "cloudroom_vm_run", "This is not a Cloud thread. Pass the ID of a Cloud thread.");
    try {
      const client = await this.client(saved);
      if (!input.stdin || input.stdin.length <= UPLOAD_PART * 2) return await client.runOnVm(input, signal);
      // Bigger input goes ahead in pieces, then becomes the command's stdin (feedback #442).
      const file = `.cache/cloudroom/stdin-${randomUUID()}`;
      try {
        await uploadInParts(client, file, Buffer.from(input.stdin, "hex"), signal);
        return await client.runOnVm({ command: `exec < ~/${file} && rm -f ~/${file}\n${input.command}`, cwd: input.cwd }, signal);
      } finally {
        await client.runOnVm({ command: `rm -f ~/${file}` }).catch(() => {});
      }
    } catch (error) {
      if (error instanceof ApiError && error.body.code === "cloudroom_sandbox_only") {
        throw new ApiError(409, "cloudroom_vm_run", "Pass --thread <id> to pick which Cloud thread's sandbox runs this.");
      }
      throw new ApiError(error instanceof CloudroomError && (error.status === 409 || error.status === 429) ? error.status : 503, "cloudroom_vm_run", publicError(error));
    }
  }

  async threadWorkspace(threadId: string, signal?: AbortSignal) {
    const saved = binding(this.host.db, threadId);
    if (!saved?.sessionId) return null;
    try {
      const workspace = await (await this.client(saved, false)).sessionWorkspace(saved.sessionId, signal);
      const lastWorkspace = JSON.stringify(workspace);
      if (lastWorkspace !== saved.lastWorkspace) saveBinding(this.host.db, threadId, { lastWorkspace });
      return workspace;
    } catch (error) {
      // A sleeping sandbox can't change its checkout, so the last one read is still right.
      if (error instanceof SandboxAsleep) return saved.lastWorkspace ? JSON.parse(saved.lastWorkspace) as unknown : null;
      throw error;
    }
  }

  /** Runs a read-only Git script in a cloud thread's checkout. Never wakes the sandbox: a sleeping one throws SandboxAsleep. */
  async runInCheckout(threadId: string, script: string, stdin?: Buffer, signal?: AbortSignal): Promise<Buffer> {
    const saved = binding(this.host.db, threadId);
    if (!saved?.sessionId) throw new CloudGitError("The cloud thread has not started yet.", null);
    const client = await this.client(saved, false);
    const path = savedWorkspacePath(saved.lastWorkspace) ?? (await client.sessionWorkspace(saved.sessionId, signal)).path;
    // A start mark skips anything the login shell prints before the script runs.
    const limit = AbortSignal.timeout(CHECKOUT_READ_TIMEOUT_MS);
    const result = await client.runOnVm(
      { command: `printf '\\035'\n${script}`, cwd: path, stdin: stdin?.toString("hex") ?? "" },
      signal ? AbortSignal.any([signal, limit]) : limit,
    );
    if (result.code !== 0 || result.truncated) {
      throw new CloudGitError(Buffer.from(result.stderr, "hex").toString().trim() || "Git failed in the cloud sandbox.", result.code);
    }
    const stdout = Buffer.from(result.stdout, "hex");
    return stdout.subarray(stdout.indexOf(0x1d) + 1);
  }

  /** Wakes a sleeping cloud thread before work is sent, when the user opens it or starts typing (ADR 0176). */
  async wakeAhead(threadId: string, trigger: SandboxWakeTrigger): Promise<void> {
    const saved = binding(this.host.db, threadId);
    const thread = this.host.getThread(threadId);
    if (!saved?.sessionId || !sandboxThread(saved.coreUrl) || !thread || thread.archivedAt || thread.deletedAt) return;
    await this.client(saved, true, trigger);
  }

  async preload(threadIds: string[]): Promise<void> {
    const due = new Map<string, SandboxProject>();
    for (const threadId of threadIds) {
      const saved = binding(this.host.db, threadId);
      const thread = this.host.getThread(threadId);
      const sandbox = saved?.sessionId ? sandboxThread(saved.coreUrl) : null;
      if (!saved || !sandbox || due.has(sandbox) || !thread || thread.archivedAt || thread.deletedAt || await this.otherAccountThread(saved)) continue;
      due.set(sandbox, this.sandboxProject(this.host.getThread(sandbox)?.projectId));
    }
    if (due.size) await this.sandboxes.preload([...due].map(([thread, project]) => ({ thread, project })), () => this.hooks.beforeWake?.() ?? Promise.resolve());
  }

  async records<T>(name: string, schema: z.ZodType<T>): Promise<Record<string, T>> {
    try { return z.record(z.string(), schema).parse(JSON.parse(await readFile(join(this.host.config.dataDir, name), "utf8"))); }
    catch { return {}; }
  }

  updateRecords<T>(name: string, schema: z.ZodType<T>, update: (records: Record<string, T>) => Record<string, T>): Promise<void> {
    const path = join(this.host.config.dataDir, name);
    const work = (this.recordWrites.get(path) ?? Promise.resolve()).then(async () => {
      const next = update(await this.records(name, schema));
      const temporary = `${path}.${randomUUID()}`;
      try {
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
    });
    this.recordWrites.set(path, work.catch(() => {}));
    return work;
  }

  setConnectionIssue(threadId: string, phase: ConnectionPhase, error?: unknown): void {
    const entry = this.state(threadId);
    const issues = entry.connectionIssues ?? {};
    const previous = issues[phase];
    const vmShutDown = (error instanceof CloudroomConnectionError && error.message.includes("unexpected redirect") || error instanceof ApiError && error.body.code === "cloudroom_sandbox_only")
      && !sandboxThread(binding(this.host.db, threadId)?.coreUrl ?? "");
    const issue = error === undefined ? undefined : vmShutDown ? { message: retiredVmMessage, reconnecting: false } : {
      message: phase === "replay" && !(error instanceof CloudroomError) ? `Cloudroom history could not be restored: ${error instanceof Error ? error.message : String(error)}` : publicError(error),
      // A stale sandbox address is looked up again on the next try, so it reconnects instead of showing a dead thread.
      reconnecting: phase !== "replay" && (connectionFailure(error) || sandboxTransition(error) || Boolean(sandboxThread(binding(this.host.db, threadId)?.coreUrl ?? "")) && staleSandboxAddress(error)),
    };
    // A paused Cloud is the one calm answer that replaces an earlier red error: that error came from the same outage.
    if (previous && !previous.reconnecting && issue?.reconnecting && !cloudPausedError(error)) return;
    if (previous?.message === issue?.message && previous?.reconnecting === issue?.reconnecting) return;
    if (issue) issues[phase] = issue;
    else delete issues[phase];
    entry.connectionIssues = Object.keys(issues).length ? issues : undefined;
    if (issue) {
      const saved = binding(this.host.db, threadId);
      this.host.logger?.warn({
        threadId, sessionId: saved?.sessionId, cursor: saved?.cursor, phase, ...issue,
        errorType: error instanceof CloudroomError ? error.name : error instanceof z.ZodError ? "ZodError" : error instanceof ApiError ? "ApiError" : error instanceof DOMException && error.name === "AbortError" ? "AbortError" : "Error",
        status: error instanceof CloudroomError ? error.status : null,
        code: error instanceof CloudroomError ? error.code : null,
        networkCode: error instanceof CloudroomConnectionError ? error.networkCode : null,
      }, "Cloudroom connection state changed");
    }
    this.notify(threadId);
  }

  // Status patches one sidebar row. Queue and list refreshes go out only when the queue really changed.
  notify(threadId: string, eventTypes: ThreadEventType[] = [], stateChanged = true): void {
    const queueChanged = stateChanged ? this.queueChanged(threadId) : false;
    this.host.notifyStatus(threadId, eventTypes, stateChanged, queueChanged);
  }

  private queueChanged(threadId: string): boolean {
    let queue: string;
    try { queue = JSON.stringify(this.hooks.queueSnapshot?.(threadId) ?? []); } catch { return true; }
    const entry = this.state(threadId);
    if (entry.sentQueue === queue) return false;
    entry.sentQueue = queue;
    return true;
  }
}
