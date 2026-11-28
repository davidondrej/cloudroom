import { COMPUTER, PERSONAL_PROJECT_ID } from "@cloudroom/domain";
import { appToast } from "@/components/ui/app-toast";
import { sidebarNavigationQueryKey } from "@/hooks/queries/query-keys";
import { appQueryClient } from "@/lib/app-query-client";
import { getAppSurface } from "@/lib/app-surface";
import { wsManager } from "@/lib/ws";
import {
  cloudApi,
  CloudError,
  SignedOutError,
  type CloudCreate,
  type CloudProjectSummary,
  type CloudThreadSummary,
} from "./cloud-api";
import { macOnline, markMacOff, SAVED_API, startupMac } from "./cloud-mode";
import {
  CloudThreadEvents,
  cloudTimeline,
  cloudTurnDetails,
  type CompletedTurnDisplay,
} from "./cloud-timeline";

type Change = "events-appended" | "status-changed" | "queue-changed";
type Outgoing = { requestId: string; text: string; at: number; after: number };

type Json = Record<string, unknown>;
type ThreadEntry = Json & {
  id: string;
  projectId: string;
  title?: string | null;
  providerId?: string;
};
type Project = Json & { id: string; threads: ThreadEntry[] };
type Sidebar = Json & { projects: Project[]; personalProject: Project };

const THREAD = /^\/api\/v1\/threads\/(thr_[a-z0-9]+)(\/.*)?$/;
const UI_PREFERENCE = /^\/api\/v1\/preferences\/ui\/([^/]+)$/;
const PLUGIN_ASSET = /^\/api\/v1\/plugins\/[^/]+\/assets\//;
const CLOUD_THREAD = /^\/api\/v1\/cloudroom\/threads\/(thr_[a-z0-9]+)(\/.*)?$/;
const LIST_TTL_MS = 30_000;
const PROJECTS_TTL_MS = 60_000;
// Safety-net sidebar refresh when the live /__cloud/events socket is closed or unavailable.
const SIDEBAR_REFRESH_MS = 60_000;
const SIGNAL_DEBOUNCE_MS = 400;
const READ_STORAGE_KEY = "cloudroom:mac-off-read-v1";
const READ_MAX_ENTRIES = 500;
const WAKE_MS = 90_000;
const FIRST_ROWS_MS = 1500;
const SAVED_TIMEOUT_MS = 700;
const SAVED_REUSE_MS = 30_000;
const OUTBOX_MS = 10 * 60_000;
const MAC_CHECK_MS = 60_000;
const MATCH_CHARS = 3000;
const MAC_CHECK_MAX_MS = 5 * 60_000;
const WARM_EVERY_MS = 60_000;
const RETRY_SOON_MS = 10_000;
const RETRY_SOON_FOR_MS = 2 * 60_000;
const BUSY_RECHECK_MS = 10_000;
const RETRY_HISTORY_MS = 10_000;
const AUTO_RETRIES = 3;
const REQUEST_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const NEEDS_MAC = `This needs your ${COMPUTER} for now. Open Cloudroom on your ${COMPUTER} and try again.`;

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const empty = () => new Response(null, { status: 204 });
const needsMac = (message = NEEDS_MAC) =>
  json({ message, ok: false, error: { code: "needs_mac", message } }, 422);

const newProject = (
  id: string | null,
  name: string | null,
  cloudProject?: CloudProjectSummary,
): Project => ({
  id: id ?? PERSONAL_PROJECT_ID,
  kind: id === null ? "personal" : "standard",
  name: name ?? cloudProject?.name ?? "Personal",
  gitRemoteUrl: cloudProject?.repository ?? null,
  createdAt: 0,
  updatedAt: 0,
  sources: [],
  defaultExecutionOptions: cloudProject?.default_harness
    ? {
        providerId: cloudProject.default_harness,
        ...(cloudProject.default_model
          ? { model: cloudProject.default_model }
          : {}),
        ...(cloudProject.default_reasoning
          ? { reasoningLevel: cloudProject.default_reasoning }
          : {}),
      }
    : null,
  threads: [],
});

interface ReadState {
  baseline: number;
  read: Record<string, number>;
}

function loadReadState(): ReadState {
  const now = Date.now();
  try {
    const raw = window.localStorage.getItem(READ_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { baseline?: unknown; read?: unknown };
      const baseline =
        typeof parsed.baseline === "number" && Number.isFinite(parsed.baseline)
          ? parsed.baseline
          : now;
      const read: Record<string, number> = {};
      if (parsed.read && typeof parsed.read === "object") {
        for (const [k, v] of Object.entries(
          parsed.read as Record<string, unknown>,
        )) {
          if (typeof v === "number" && Number.isFinite(v)) read[k] = v;
        }
      }
      return { baseline, read };
    }
  } catch {
    // Ignore storage errors (private mode / tests).
  }
  const initial: ReadState = { baseline: now, read: {} };
  saveReadState(initial);
  return initial;
}

function saveReadState(state: ReadState): void {
  try {
    const entries = Object.entries(state.read);
    const trimmed =
      entries.length > READ_MAX_ENTRIES
        ? Object.fromEntries(
            entries
              .sort((a, b) => b[1] - a[1])
              .slice(0, READ_MAX_ENTRIES),
          )
        : state.read;
    window.localStorage.setItem(
      READ_STORAGE_KEY,
      JSON.stringify({ baseline: state.baseline, read: trimmed }),
    );
  } catch {
    // Ignore storage errors.
  }
}

const parseMs = (iso: string | null | undefined): number => {
  if (!iso) return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
};

const statusFromSummary = (
  summary: CloudThreadSummary | undefined,
): "active" | "error" | "idle" => {
  if (summary?.turn_state === "working") return "active";
  if (summary?.turn_state === "error") return "error";
  return "idle";
};

const cloudEntry = (
  thread: CloudThreadSummary,
  projectId: string,
  parentThreadId: string | null,
  lastReadAt: number,
): ThreadEntry => {
  const wokeAt = parseMs(thread.woke_at);
  const lastTurnAt = parseMs(thread.last_turn_at);
  // Prefer actual turn completion time for unread/attention; fall back to woke_at only for older Cores without last_turn_at.
  const attentionAt = lastTurnAt || wokeAt;
  const at = Math.max(wokeAt, lastTurnAt);
  const pinnedAt = parseMs(thread.pinned_at) || null;
  const status = statusFromSummary(thread);
  return {
    id: thread.thread_id,
    projectId,
    environmentId: null,
    executionTarget: "cloud",
    providerId: thread.harness || "claude-code",
    title: thread.title,
    titleFallback: null,
    sectionId: null,
    status,
    parentThreadId,
    sourceThreadId: null,
    originKind: null,
    originPluginId: null,
    visibility: "visible",
    archivedAt: null,
    pinnedAt,
    deletedAt: null,
    lastReadAt,
    latestAttentionAt: attentionAt,
    createdAt: wokeAt || at,
    updatedAt: at,
    queuedWork: "none",
    pinSortKey: null,
    hasPendingInteraction: thread.turn_state === "waiting",
    activity: {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activeGoalCount: 0,
      activePlanModeCount: 0,
      activeWorkflowCount: 0,
    },
    environmentBranchName: null,
    environmentHostId: null,
    environmentName: null,
    environmentPath: null,
    environmentProviderId: null,
    environmentIsWorktree: false,
    environmentWorkspaceDisplayKind: "other",
  };
};
const object = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
const textOf = (body: Json): string | Response => {
  const parts = (Array.isArray(body.input) ? body.input : []).map(object);
  if (parts.some((part) => part.type !== "text"))
    return needsMac(`Photos and files need your ${COMPUTER} for now.`);
  const text = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim();
  return (
    text ||
    json(
      { message: `Only text messages work while your ${COMPUTER} is off.` },
      400,
    )
  );
};

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function createSoon(body: CloudCreate): Promise<CloudThreadSummary> {
  const until = Date.now() + RETRY_SOON_FOR_MS;
  for (;;) {
    try {
      return await cloudApi.create(body);
    } catch (failure) {
      if (
        !(failure instanceof CloudError) ||
        failure.code !== "retry_soon" ||
        Date.now() + RETRY_SOON_MS > until
      )
        throw failure;
      await new Promise((resolve) => setTimeout(resolve, RETRY_SOON_MS));
    }
  }
}

class CloudThread {
  readonly events: CloudThreadEvents;
  private ready: Promise<void> | null = null;
  private historyLoaded = false;
  private followAfterLoad = false;
  private loading = false;
  private unlisten: (() => void) | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private delay = 2000;
  private wakeDelay = 2000;
  private wakingUntil = 0;
  private announced = 0;
  private announceTimer: ReturnType<typeof setTimeout> | undefined;
  private outbox: Outgoing[] = [];
  private started = 0;

  constructor(
    readonly id: string,
    private readonly changed: (id: string, changes: Change[]) => void,
  ) {
    this.events = new CloudThreadEvents(id);
  }

  async send(
    text: string,
    requestId: string | undefined,
    surface?: string,
  ) {
    const outgoing: Outgoing | null =
      requestId && this.historyLoaded
        ? {
            requestId,
            text: text.trim(),
            at: Date.now(),
            after: this.events.promptLog.length,
          }
        : null;
    await cloudApi.send(this.id, text, requestId, surface);
    if (outgoing && !this.logged(outgoing)) this.outbox.push(outgoing);
    if (this.historyLoaded) {
      this.keepFollowing();
      this.listen();
    } else {
      this.followAfterLoad = true;
      if (!this.loading) {
        this.autoRetries = 0;
        this.ready = null;
      }
      void this.loaded().catch(() => {
        this.keepFollowing();
        this.listen(true);
      });
    }
    if (!outgoing) return null;
    const waiting =
      this.outbox.includes(outgoing) ||
      this.events.waiting.has(outgoing.requestId);
    return waiting
      ? this.row(outgoing.requestId, outgoing.text, outgoing.at)
      : null;
  }

  queued(): Json[] {
    this.outbox = this.outbox.filter(
      (item) => Date.now() - item.at < OUTBOX_MS,
    );
    return [
      ...[...this.events.waiting].map(([id, item]) =>
        this.row(id, item.text, item.at),
      ),
      ...this.outbox
        .filter((item) => !this.known(item.requestId))
        .map((item) => this.row(item.requestId, item.text, item.at)),
    ];
  }

  private known(requestId: string | undefined) {
    return (
      requestId !== undefined &&
      this.events.promptLog.some((prompt) => prompt.requestId === requestId)
    );
  }

  private logged(item: Outgoing) {
    return this.events.promptLog.some(
      (prompt, index) =>
        prompt.requestId === item.requestId ||
        (index >= item.after &&
          prompt.text.slice(0, MATCH_CHARS) ===
            item.text.slice(0, MATCH_CHARS)),
    );
  }

  private row(id: string, text: string, at: number): Json {
    return {
      id,
      initiator: "user",
      senderThreadId: null,
      threadId: this.id,
      content: [{ type: "text", text, mentions: [] }],
      model: this.events.model || "cloud",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      sendAt: null,
      waitingOn: null,
      failureReason: null,
      payload: { kind: "inline" },
      editable: false,
      createdAt: at,
      updatedAt: at,
    };
  }

  private add(records: Parameters<CloudThreadEvents["add"]>[0]) {
    const waiting = this.events.waitingVersion;
    if (this.events.add(records)) this.announce();
    const before = this.outbox.length;
    const log = this.events.promptLog;
    for (let index = this.started; index < log.length; index++) {
      const prompt = log[index]!;
      const byId = this.outbox.findIndex(
        (item) => item.requestId === prompt.requestId,
      );
      const match =
        byId !== -1
          ? byId
          : this.outbox.findIndex(
              (item) =>
                index >= item.after &&
                item.text.slice(0, MATCH_CHARS) ===
                  prompt.text.slice(0, MATCH_CHARS),
            );
      if (match !== -1) this.outbox.splice(match, 1);
    }
    this.started = this.events.promptLog.length;
    if (this.outbox.length !== before || this.events.waitingVersion !== waiting)
      this.changed(this.id, ["queue-changed"]);
  }

  private autoRetries = 0;

  retryHistory() {
    if (this.autoRetries >= AUTO_RETRIES) {
      appToast.error("Couldn't load this thread. Open it again to retry.");
      return;
    }
    this.autoRetries++;
    setTimeout(() => this.announce(), RETRY_HISTORY_MS + 100);
  }

  loaded(): Promise<void> {
    if (this.ready) return this.ready;
    const ready: Promise<void> = this.load().catch((failure: unknown) => {
      setTimeout(() => {
        if (this.ready === ready) this.ready = null;
      }, RETRY_HISTORY_MS);
      this.retryHistory();
      throw failure;
    });
    this.ready = ready;
    return ready;
  }

  async load(): Promise<void> {
    this.loading = true;
    const history = await cloudApi
      .history(this.id, this.events.cursor)
      .catch((failure: unknown) => {
        if (failure instanceof SignedOutError) window.location.reload();
        throw failure;
      })
      .finally(() => (this.loading = false));
    this.add(history.records);
    this.historyLoaded = true;
    this.autoRetries = 0;
    this.ready = Promise.resolve();
    const sent = this.followAfterLoad;
    this.followAfterLoad = false;
    if (sent) this.keepFollowing();
    if (sent && this.streaming) return;
    if (sent || history.awake || Date.now() < this.wakingUntil)
      this.listen(true);
  }

  refresh() {
    if (!this.loading) void this.load().catch(() => undefined);
  }

  keepFollowing() {
    this.wakingUntil = Date.now() + WAKE_MS;
    this.wakeDelay = 2000;
  }

  listenIfLoaded() {
    if (this.historyLoaded) this.listen();
  }

  get streaming() {
    return this.unlisten !== null;
  }

  listen(restart = false) {
    if (this.unlisten && !restart) return;
    if (document.visibilityState !== "visible") return;
    this.pause();
    this.unlisten = cloudApi.listen(this.id, this.events.cursor, {
      open: () => {
        this.delay = 2000;
      },
      records: (records) => this.add(records),
      asleep: () => {
        this.unlisten = null;
        if (Date.now() >= this.wakingUntil) return;
        this.retryLater(this.wakeDelay);
        this.wakeDelay = Math.min(this.wakeDelay * 1.5, 15_000);
      },
      error: () => {
        this.unlisten = null;
        this.retryLater(this.delay);
        this.delay = Math.min(this.delay * 2, 30_000);
      },
    });
  }

  private retryLater(delay: number) {
    if (document.visibilityState !== "visible") return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.listen(), delay);
  }

  pause() {
    clearTimeout(this.retry);
    this.unlisten?.();
    this.unlisten = null;
  }

  private announce() {
    const now = Date.now();
    if (now - this.announced < 250) {
      clearTimeout(this.announceTimer);
      this.announceTimer = setTimeout(() => this.announce(), 250);
      return;
    }
    this.announced = now;
    this.changed(this.id, ["events-appended", "status-changed"]);
  }
}

class CloudServer {
  private readonly threads = new Map<string, CloudThread>();
  private readonly readState: ReadState = loadReadState();
  private readonly summaryById = new Map<string, CloudThreadSummary>();
  private readonly unpinnedIds = new Set<string>();
  private readonly tabs = new Map<string, Json>();
  private busy = 0;
  private warmedAt = 0;
  private unsubscribeEvents: (() => void) | null = null;
  private signalTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly preferences: Json = {};
  private readonly savedCopies = new Map<
    string,
    { at: number; value: Promise<Json | null> }
  >();
  private list: { at: number; value: Promise<CloudThreadSummary[]> } | null =
    null;
  private projectsList: {
    at: number;
    value: Promise<CloudProjectSummary[]>;
  } | null = null;

  constructor(private readonly network: typeof fetch) {}

  install() {
    document.documentElement.dataset.cloudroomCloudOnly = "true";
    const network = this.network;
    window.fetch = (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (
        url.origin !== window.location.origin ||
        !url.pathname.startsWith("/api/v1/")
      ) {
        return network(input, init);
      }
      const write = request.method !== "GET";
      if (write) this.busy++;
      return this.handle(request, url)
        .finally(() => {
          if (write) this.busy--;
        })
        .catch((failure: unknown) => {
          if (failure instanceof SignedOutError) window.location.reload();
          return json(
            {
              message:
                failure instanceof Error
                  ? failure.message
                  : "Cloudroom is unreachable.",
            },
            503,
          );
        });
    };
    wsManager.runWithoutSocket();
    const reloadIfMacBack = () =>
      void macOnline().then((online) => {
        if (!online) return;
        if (this.busy === 0) window.location.reload();
        else setTimeout(reloadIfMacBack, BUSY_RECHECK_MS);
      });
    const checkMac = (delay: number) =>
      setTimeout(() => {
        if (document.visibilityState === "visible") reloadIfMacBack();
        checkMac(Math.min(delay * 2, MAC_CHECK_MAX_MS));
      }, delay);
    checkMac(MAC_CHECK_MS);
    // Safety-net refresh if the live /__cloud/events socket drops or isn't supported yet.
    setInterval(() => {
      if (document.visibilityState === "visible") this.refreshSidebar();
    }, SIDEBAR_REFRESH_MS);
    const connectEvents = () => {
      this.unsubscribeEvents?.();
      this.unsubscribeEvents = cloudApi.subscribeEvents(() =>
        this.scheduleSidebarRefresh(),
      );
    };
    if (document.visibilityState === "visible") connectEvents();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") {
        this.unsubscribeEvents?.();
        this.unsubscribeEvents = null;
        for (const thread of this.threads.values()) thread.pause();
        return;
      }
      reloadIfMacBack();
      connectEvents();
      this.list = null;
      this.refreshSidebar();
      for (const thread of this.threads.values()) thread.refresh();
    });
  }

  private scheduleSidebarRefresh() {
    clearTimeout(this.signalTimer);
    this.signalTimer = setTimeout(() => {
      this.list = null;
      this.refreshSidebar();
    }, SIGNAL_DEBOUNCE_MS);
  }

  private readAtFor(id: string): number {
    return Object.hasOwn(this.readState.read, id)
      ? this.readState.read[id]!
      : this.readState.baseline;
  }

  private markRead(id: string, at: number): void {
    this.readState.read[id] = at;
    saveReadState(this.readState);
  }

  private refreshSidebar() {
    void appQueryClient.invalidateQueries({
      queryKey: sidebarNavigationQueryKey(),
    });
  }

  private async handle(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const thread = THREAD.exec(path);
    const cloudThread = CLOUD_THREAD.exec(path);
    if (request.method === "GET") {
      if (path === "/api/v1/sidebar-bootstrap")
        return json(await this.sidebar());
      if (path === "/api/v1/projects")
        return json(await this.projectsEndpoint(url));
      if (path === "/api/v1/cloudroom/account")
        return json(await this.account());
      if (path === "/api/v1/hosts") return json(await this.hosts(url));
      if (PLUGIN_ASSET.test(path)) return this.network(request);
      if (path === "/api/v1/preferences/ui") {
        const saved = object((await this.saved(path))?.preferences);
        return json({ preferences: { ...saved, ...this.preferences } });
      }
      if (thread) return this.threadGet(thread[1], thread[2] ?? "", url);
      if (cloudThread)
        return this.cloudThreadGet(cloudThread[1], cloudThread[2] ?? "");
      return (await this.copy(request)) ?? needsMac();
    }
    const onMac =
      thread &&
      [
        "",
        "/send",
        "/stop",
        "/archive-all",
        "/unarchive",
        "/pin",
        "/unpin",
      ].includes(thread[2] ?? "")
        ? await this.onMac(thread[1])
        : null;
    if (onMac) return onMac;
    if (thread && thread[2] === "/send") {
      const body = object(await request.json().catch(() => null));
      const text = textOf(body);
      if (text instanceof Response) return text;
      const requestId =
        typeof body.requestId === "string" && REQUEST_ID.test(body.requestId)
          ? body.requestId
          : undefined;
      const queuedMessage = await this.thread(thread[1]).send(
        text,
        requestId,
        await this.usageSurface(),
      );
      this.markRead(thread[1], Date.now());
      return json(
        queuedMessage
          ? { ok: true, delivery: "queued", queuedMessage }
          : { ok: true, delivery: "sent" },
      );
    }
    if (thread && (thread[2] === "/read" || thread[2] === "/unread")) {
      this.markRead(thread[1], thread[2] === "/read" ? Date.now() : 0);
      return this.threadGet(thread[1], "", url);
    }
    if (thread && thread[2] === "/stop") {
      await cloudApi.stop(thread[1]);
      this.thread(thread[1]).listenIfLoaded();
      return json({ ok: true, cancelledRetries: 0 });
    }
    if (thread && thread[2] === "/archive-all" && request.method === "POST") {
      const includeLive = url.searchParams.get("includeLive") !== "false";
      const result = await cloudApi.archive(thread[1], includeLive);
      const archivedThreadIds = result.archivedThreadIds?.length
        ? result.archivedThreadIds
        : [thread[1]];
      for (const id of archivedThreadIds) this.summaryById.delete(id);
      this.list = null;
      this.refreshSidebar();
      return json({
        ok: true,
        archivedThreadIds,
        ...(result.keptLiveThreadIds?.length
          ? { keptLiveThreadIds: result.keptLiveThreadIds }
          : {}),
      });
    }
    if (thread && thread[2] === "/unarchive" && request.method === "POST") {
      await cloudApi.unarchive(thread[1]);
      this.list = null;
      this.refreshSidebar();
      return json({ ok: true, unarchivedThreadIds: [thread[1]] });
    }
    if (
      thread &&
      (thread[2] === "/pin" || thread[2] === "/unpin") &&
      request.method === "POST"
    ) {
      const pinned = thread[2] === "/pin";
      await cloudApi.pin(thread[1], pinned);
      if (pinned) this.unpinnedIds.delete(thread[1]);
      else this.unpinnedIds.add(thread[1]);
      const summary = this.summaryById.get(thread[1]);
      if (summary) summary.pinned_at = pinned ? new Date().toISOString() : null;
      this.list = null;
      this.refreshSidebar();
      return this.threadGet(thread[1], "", url);
    }
    if (thread && (thread[2] ?? "") === "" && request.method === "PATCH") {
      const body = object(await request.json().catch(() => null));
      const title =
        typeof body.title === "string" && body.title.trim()
          ? body.title.trim()
          : undefined;
      const model =
        typeof body.model === "string" && body.model.trim()
          ? body.model.trim()
          : undefined;
      const reasoning =
        typeof body.reasoningLevel === "string" && body.reasoningLevel.trim()
          ? body.reasoningLevel.trim()
          : undefined;
      if (!title && !model && !reasoning) return needsMac();
      if (title) {
        await cloudApi.rename(thread[1], title);
        const summary = this.summaryById.get(thread[1]);
        if (summary) summary.title = title;
      }
      if (model || reasoning) {
        await cloudApi.setModel(thread[1], {
          ...(model ? { model } : {}),
          ...(reasoning ? { reasoning } : {}),
        });
        const summary = this.summaryById.get(thread[1]);
        if (summary) {
          if (model) summary.model = model;
          if (reasoning) summary.reasoning = reasoning;
        }
      }
      this.list = null;
      this.refreshSidebar();
      return this.threadGet(thread[1], "", url);
    }
    if (thread && (thread[2] ?? "") === "" && request.method === "DELETE") {
      await cloudApi.delete(thread[1]);
      this.summaryById.delete(thread[1]);
      this.threads.get(thread[1])?.pause();
      this.threads.delete(thread[1]);
      this.list = null;
      this.refreshSidebar();
      return json({ ok: true });
    }
    if (thread && thread[2] === "/tabs" && request.method === "PUT") {
      const body = object(await request.json().catch(() => null));
      const saved = {
        revision: Number(body.expectedRevision ?? 0) + 1,
        tabs: Array.isArray(body.tabs) ? body.tabs : [],
      };
      this.tabs.set(thread[1], saved);
      void this.savedCache()
        .then((cache) => cache?.put(path, json(saved)))
        .catch(() => undefined);
      return json(saved);
    }
    const preference = UI_PREFERENCE.exec(path);
    if (preference && request.method === "PUT") {
      const body = object(await request.json().catch(() => null));
      const key = decodeURIComponent(preference[1]!);
      const entry = {
        revision: Number(body.expectedRevision ?? 0) + 1,
        value: body.value ?? null,
      };
      this.preferences[key] = entry;
      void Promise.all([
        this.savedCache(),
        this.saved("/api/v1/preferences/ui"),
      ])
        .then(([cache, saved]) =>
          cache?.put(
            "/api/v1/preferences/ui",
            json({
              preferences: {
                ...object(saved?.preferences),
                ...this.preferences,
              },
            }),
          ),
        )
        .catch(() => undefined);
      return json({ key, ...entry });
    }
    if (path === "/api/v1/threads" && request.method === "POST")
      return this.create(object(await request.json().catch(() => null)));
    if (/^\/api\/v1\/projects\/[^/]+\/attachments/.test(path))
      return needsMac(`Photos and files need your ${COMPUTER} for now.`);
    if (path === "/api/v1/cloudroom/account/activity") {
      if (Date.now() - this.warmedAt >= WARM_EVERY_MS) {
        this.warmedAt = Date.now();
        void cloudApi.warm().catch(() => undefined);
      }
      return empty();
    }
    return needsMac();
  }

  private async create(body: Json): Promise<Response> {
    if (body.executionTarget !== "cloud")
      return needsMac(
        `Local threads need your ${COMPUTER}. Pick Cloud to start one now.`,
      );
    const prompt = textOf(body);
    if (prompt instanceof Response) return prompt;
    const optional = (value: unknown) =>
      typeof value === "string" ? value : undefined;
    const onMac = [
      "sourceThreadId",
      "parentThreadId",
      "sendAt",
      "pluginSubmission",
    ];
    const startNeedsMac = `Starting a new thread needs your ${COMPUTER} for now.`;
    if (
      typeof body.projectId !== "string" ||
      onMac.some((key) => body[key] != null)
    )
      return needsMac(startNeedsMac);
    const thread = await createSoon({
      project: body.projectId,
      request_id: optional(body.requestId) ?? crypto.randomUUID(),
      text: prompt,
      title: optional(body.title),
      harness: optional(body.providerId),
      model: optional(body.model),
      reasoning: optional(body.reasoningLevel),
      service_tier: optional(body.serviceTier),
      target: optional(body.cloudTarget),
      base_branch: optional(body.baseBranch),
      surface: await this.usageSurface(),
    }).catch((failure: unknown) => {
      if (!(failure instanceof CloudError)) throw failure;
      return failure.code === "no_cloud_thread"
        ? needsMac(startNeedsMac)
        : json({ message: failure.message }, failure.status);
    });
    if (thread instanceof Response) return thread;
    this.summaryById.set(thread.thread_id, { ...thread, turn_state: "working" });
    this.list = null;
    this.markRead(thread.thread_id, Date.now());
    return json(
      this.live({
        activeBackgroundAgentCount: 0,
        canSpawnChild: false,
        projectCopy: null,
        ...cloudEntry(
          { ...thread, turn_state: "working" },
          body.projectId,
          null,
          Date.now(),
        ),
        providerId: optional(body.providerId) ?? thread.harness ?? "claude-code",
        queuedMessageCount: 0,
      }),
      201,
    );
  }

  /** The Mac is off, so it can't count this message. The website does, but only while the Mac's saved settings
   *  and environment allow usage data. */
  private async usageSurface(): Promise<string | undefined> {
    const config = object(await this.saved("/api/v1/system/config"));
    return config.telemetryAllowed !== false &&
      object(config.generalSettings).telemetryEnabled === true
      ? getAppSurface()
      : undefined;
  }

  private async account(): Promise<Json> {
    const saved = await this.saved("/api/v1/cloudroom/account");
    if (saved?.account)
      return {
        ...saved,
        ready: true,
        error: null,
        previews: undefined,
        sync: undefined,
        macAccess: false,
        macAccessLevel: "off",
      };
    return {
      ready: true,
      account: { id: "phone", email: "" },
      projectId: null,
      repository: null,
      model: null,
      error: null,
      signingIn: false,
      signInError: null,
      macAccess: false,
      copyLogins: false,
    };
  }

  private async hosts(url: URL): Promise<unknown[]> {
    const response = await this.copy(
      url.pathname + url.search,
      SAVED_TIMEOUT_MS,
    );
    const saved: unknown = response?.ok
      ? await response.json().catch(() => null)
      : null;
    return (Array.isArray(saved) ? saved : []).map((host) => ({
      ...object(host),
      status: "disconnected",
    }));
  }

  private thread(id: string): CloudThread {
    let thread = this.threads.get(id);
    if (!thread) {
      thread = new CloudThread(id, (changed, changes) =>
        wsManager.handleIncomingMessage(
          JSON.stringify({
            type: "changed",
            entity: "thread",
            id: changed,
            changes,
          }),
        ),
      );
      this.threads.set(id, thread);
    }
    return thread;
  }

  private live(entry: ThreadEntry): ThreadEntry {
    const summary = this.summaryById.get(entry.id);
    const status = this.status(entry.id);
    const readAt = this.readAtFor(entry.id);
    const cachedPin = typeof entry.pinnedAt === "number" ? entry.pinnedAt : null;
    // Preserve Mac pins when website pinned_at is null, unless explicitly unpinned in this Mac-off session.
    const pinnedAt = this.unpinnedIds.has(entry.id)
      ? null
      : parseMs(summary?.pinned_at) || cachedPin;
    const summaryLastTurn = parseMs(summary?.last_turn_at);
    const summaryWoke = parseMs(summary?.woke_at);
    // Avoid marking threads unread on simple wakes when last_turn_at is available.
    const summaryAttention = summaryLastTurn || summaryWoke;
    const attentionAt = Math.max(
      summaryAttention,
      typeof entry.latestAttentionAt === "number" ? entry.latestAttentionAt : 0,
    );
    const hasPendingInteraction =
      summary?.turn_state !== undefined
        ? summary.turn_state === "waiting" && status !== "active"
        : Boolean(entry.hasPendingInteraction);
    return {
      ...entry,
      ...(summary?.title ? { title: summary.title } : {}),
      ...(summary?.harness ? { providerId: summary.harness } : {}),
      pinnedAt,
      status,
      hasPendingInteraction,
      latestAttentionAt: attentionAt,
      updatedAt: Math.max(
        summaryLastTurn,
        summaryWoke,
        attentionAt,
        typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
      ),
      runtime: { displayStatus: status, hostReconnectGraceExpiresAt: null },
      lastReadAt: readAt,
    };
  }

  private status(id: string): "active" | "error" | "idle" {
    const open = this.threads.get(id);
    if (open?.events.working) return "active";
    return statusFromSummary(this.summaryById.get(id));
  }

  private cloudThreads(): Promise<CloudThreadSummary[]> {
    if (!this.list || Date.now() - this.list.at > LIST_TTL_MS) {
      const value = cloudApi.threads().then((items) => {
        this.summaryById.clear();
        for (const item of items) this.summaryById.set(item.thread_id, item);
        return items;
      });
      this.list = { at: Date.now(), value };
      value.catch(() => {
        this.list = null;
      });
    }
    return this.list.value;
  }

  private cloudProjects(): Promise<CloudProjectSummary[]> {
    if (
      !this.projectsList ||
      Date.now() - this.projectsList.at > PROJECTS_TTL_MS
    ) {
      const value = cloudApi.projects();
      this.projectsList = { at: Date.now(), value };
      value.catch(() => {
        this.projectsList = null;
      });
    }
    return this.projectsList.value;
  }

  private async projectsEndpoint(url: URL): Promise<unknown[]> {
    const sidebar = await this.sidebar();
    const includeThreads = (url.searchParams.get("include") ?? "")
      .split(",")
      .includes("threads");
    const includePersonal = url.searchParams.get("includePersonal") === "true";
    const list = includePersonal
      ? [sidebar.personalProject, ...sidebar.projects]
      : sidebar.projects;
    if (includeThreads) return list;
    return list.map(({ threads: _threads, ...project }) => project);
  }

  private async copy(
    request: Request | string,
    timeoutMs?: number,
  ): Promise<Response | null> {
    const cache = await this.savedCache();
    const saved = await cache?.match(request).catch(() => undefined);
    if (saved) return saved;
    const network = this.network(request)
      .then((response) => {
        const mac = response.headers.get("x-cloudroom-mac");
        return response.ok && (mac === null || mac === startupMac())
          ? response
          : null;
      })
      .catch(() => null);
    return timeoutMs === undefined ? network : withTimeout(network, timeoutMs);
  }

  private savedCache(): Promise<Cache | null> {
    this.macCache ??= this.openSavedCache();
    return this.macCache;
  }

  private macCache: Promise<Cache | null> | null = null;

  private async openSavedCache(): Promise<Cache | null> {
    const mac = startupMac();
    if (typeof caches === "undefined" || mac === null) return null;
    return caches.open(`${SAVED_API}:${mac}`).catch(() => null);
  }

  private async cachedOnly(path: string): Promise<Json | null> {
    const response = await (
      await this.savedCache()
    )
      ?.match(path)
      .catch(() => undefined);
    const body: unknown = await response?.json().catch(() => null);
    return body !== null && typeof body === "object" ? (body as Json) : null;
  }

  private saved(path: string): Promise<Json | null> {
    const hit = this.savedCopies.get(path);
    if (hit && Date.now() - hit.at < SAVED_REUSE_MS) return hit.value;
    const value = this.copy(path, SAVED_TIMEOUT_MS).then(async (response) => {
      if (!response?.ok) return null;
      const body: unknown = await response.json().catch(() => null);
      return body !== null && typeof body === "object" ? (body as Json) : null;
    });
    this.savedCopies.set(path, { at: Date.now(), value });
    return value;
  }

  private async sidebar(): Promise<Sidebar> {
    const [saved, cloud, syncedProjects] = await Promise.all([
      this.saved("/api/v1/sidebar-bootstrap"),
      this.cloudThreads(),
      this.cloudProjects(),
    ]);
    const ids = new Set(cloud.map((thread) => thread.thread_id));
    const keep = (project: Project): Project => ({
      ...project,
      threads: project.threads
        .filter((entry) => ids.has(entry.id))
        .map((entry) => this.live({ ...entry, executionTarget: "cloud" })),
    });
    const sidebar = saved as Sidebar | undefined;
    const personal = keep(sidebar?.personalProject ?? newProject(null, null));
    const projects = new Map(
      (sidebar?.projects ?? []).map((project) => [project.id, keep(project)]),
    );
    // Merge synced Cloudroom projects so fresh Mac-off phones see every project even without a Mac cache.
    for (const synced of syncedProjects) {
      if (synced.project_id === personal.id) continue;
      const existing = projects.get(synced.project_id);
      if (!existing) {
        projects.set(
          synced.project_id,
          newProject(synced.project_id, synced.name, synced),
        );
      } else if (!existing.gitRemoteUrl && synced.repository) {
        existing.gitRemoteUrl = synced.repository;
      }
    }
    const known = new Set(
      [personal, ...projects.values()].flatMap((project) =>
        project.threads.map((entry) => entry.id),
      ),
    );
    const hidden = new Set(
      (
        await Promise.all(
          cloud
            .filter((thread) => !known.has(thread.thread_id))
            .map(async (thread) =>
              (await this.cachedOnly(`/api/v1/threads/${thread.thread_id}`))
                ?.visibility === "hidden"
                ? thread.thread_id
                : null,
            ),
        )
      ).filter((id) => id !== null),
    );
    for (const thread of cloud) {
      if (known.has(thread.thread_id) || hidden.has(thread.thread_id)) continue;
      const projectId = thread.project_id;
      let project =
        projectId === null || projectId === personal.id
          ? personal
          : projects.get(projectId);
      if (!project) {
        project = newProject(projectId, thread.project_name);
        projects.set(projectId!, project);
      }
      // A subagent sits under its parent, as on the desktop, when the parent is listed too.
      const parent = thread.parent_thread_id ?? null;
      project.threads.push(
        this.live(
          cloudEntry(
            thread,
            project.id,
            parent && ids.has(parent) ? parent : null,
            this.readAtFor(thread.thread_id),
          ),
        ),
      );
    }
    return {
      ...sidebar,
      sections: [],
      projects: [...projects.values()],
      personalProject: personal,
      mentionableHiddenThreads: [],
    };
  }

  private async entry(
    id: string,
    timeoutMs?: number,
  ): Promise<ThreadEntry | null> {
    const saved = await this.saved(`/api/v1/threads/${id}`);
    if (saved) return saved as ThreadEntry;
    const sidebar =
      timeoutMs === undefined
        ? await this.sidebar()
        : await withTimeout(this.sidebar(), timeoutMs);
    if (!sidebar) return null;
    return (
      [sidebar.personalProject, ...sidebar.projects]
        .flatMap((project) => project.threads)
        .find((entry) => entry.id === id) ?? null
    );
  }

  private async onMac(id: string): Promise<Response | null> {
    const saved =
      ((await this.saved(`/api/v1/threads/${id}`)) as
        | ThreadEntry
        | undefined) ?? (await this.savedEntry(id));
    if (!saved || saved.executionTarget === "cloud") return null;
    const cloud = await this.cloudThreads().catch(() => []);
    if (cloud.some((thread) => thread.thread_id === id)) return null;
    return needsMac(
      `This thread runs on your ${COMPUTER}. Open it again when your ${COMPUTER} is on.`,
    );
  }

  private async savedEntry(id: string): Promise<ThreadEntry | null> {
    const saved = (await this.saved("/api/v1/sidebar-bootstrap")) as
      | Sidebar
      | undefined;
    if (!saved) return null;
    return (
      [saved.personalProject, ...saved.projects]
        .flatMap((project) => project?.threads ?? [])
        .find((entry) => entry.id === id) ?? null
    );
  }

  private async turnDisplay(
    providerId: string | undefined,
  ): Promise<CompletedTurnDisplay> {
    const [config, providers] = await Promise.all([
      this.saved("/api/v1/system/config"),
      this.saved("/api/v1/system/providers"),
    ]);
    const chosen = object(
      object(object(config).generalSettings).providerCompletedTurnDisplay,
    )[providerId ?? ""];
    const list = Array.isArray(providers)
      ? providers
      : Array.isArray(object(providers).providers)
        ? (object(providers).providers as unknown[])
        : [];
    const fallback = list
      .map(object)
      .find((provider) => provider.id === providerId)?.completedTurnDisplay;
    const display = chosen ?? fallback;
    return display === "flat" || display === "collapse" ? display : "collapse";
  }

  private async threadGet(
    id: string,
    rest: string,
    url: URL,
  ): Promise<Response> {
    const onMac = await this.onMac(id);
    if (onMac) return onMac;
    if (rest === "") {
      const entry = (await this.entry(id)) ?? (await this.savedEntry(id));
      if (!entry) return json({ message: "Thread not found." }, 404);
      return json(
        this.live({
          activeBackgroundAgentCount: 0,
          canSpawnChild: false,
          projectCopy: null,
          ...entry,
          executionTarget: "cloud",
          queuedMessageCount: this.threads.get(id)?.queued().length ?? 0,
        }),
      );
    }
    if (rest === "/timeline" || rest === "/timeline/turn-summary-details") {
      const thread = this.thread(id);
      const ready = thread.loaded();
      const details = this.entry(id, SAVED_TIMEOUT_MS)
        .catch(() => null)
        .then(async (entry) => ({
          entry,
          display: await this.turnDisplay(entry?.providerId).catch(
            () => "collapse" as const,
          ),
        }));
      const loading = `cloud-history-${id}`;
      let early = false;
      let settled = false;
      void ready
        .catch(() => undefined)
        .finally(() => {
          settled = true;
          appToast.dismiss(loading);
        });
      if (rest !== "/timeline") await ready;
      early =
        (await withTimeout(
          ready.then(() => true),
          FIRST_ROWS_MS,
        )) === null;
      if (early && !settled)
        appToast.loading("Loading this thread…", {
          id: loading,
          duration: Infinity,
        });
      const { entry, display } = await details;
      const title = (entry?.title as string | null | undefined) ?? "";
      if (rest === "/timeline/turn-summary-details") {
        const rows = cloudTurnDetails(thread.events, title, display, {
          turnId: url.searchParams.get("turnId") ?? "",
          sourceSeqStart: Number(url.searchParams.get("sourceSeqStart")),
          sourceSeqEnd: Number(url.searchParams.get("sourceSeqEnd")),
        });
        return rows
          ? json({
              rows,
              olderCursor: null,
              historySnapshot: `cloud:${thread.events.cursor}`,
            })
          : json({ message: "Turn not found." }, 404);
      }
      const { rows, activeBackgroundCommands } = cloudTimeline(thread.events, title, display);
      const maxSeq = thread.events.events.length;
      const status = this.status(id);
      return json({
        maxSeq,
        rows,
        contextBoundarySeq: null,
        completedTurnDisplay: display,
        activePromptMode: null,
        activeThinking: null,
        activeWorkflows: [],
        activeBackgroundCommands,
        pendingTodos: null,
        goal: null,
        modelFallback: null,
        contextWindowUsage: null,
        timelinePage: {
          kind: "latest",
          segmentLimit: 20,
          returnedSegmentCount: rows.length,
          hasOlderRows: false,
          olderCursor: null,
          historySnapshot: JSON.stringify({
            version: 1,
            threadId: id,
            maxSeq,
            status,
          }),
          olderRowsSourceSeqEnd: null,
        },
      });
    }
    if (rest === "/default-execution-options") {
      const summary = this.summaryById.get(id);
      const saved = await this.saved(`/api/v1/threads/${id}/default-execution-options`);
      const model =
        this.threads.get(id)?.events.model ||
        summary?.model ||
        (typeof saved?.model === "string" ? saved.model : "");
      if (!model) return json(saved ?? null);
      return json({
        serviceTier: "default",
        permissionMode: "full",
        source: "override",
        ...saved,
        model,
        reasoningLevel:
          summary?.reasoning ||
          (typeof saved?.reasoningLevel === "string" ? saved.reasoningLevel : "high"),
      });
    }
    if (rest === "/queued-messages")
      return json(this.threads.get(id)?.queued() ?? []);
    if (rest === "/interactions") return json([]);
    if (rest === "/tabs")
      return json(
        this.tabs.get(id) ??
          (await this.saved(`/api/v1/threads/${id}/tabs`)) ?? {
            revision: 0,
            tabs: [],
          },
      );
    return json(
      { message: `Not available while your ${COMPUTER} is off.` },
      404,
    );
  }

  private async cloudThreadGet(id: string, rest: string): Promise<Response> {
    if (rest === "/running") {
      const running: string[] = [];
      if (this.status(id) === "active") running.push(id);
      for (const summary of this.summaryById.values()) {
        if (
          summary.parent_thread_id === id &&
          this.status(summary.thread_id) === "active"
        ) {
          running.push(summary.thread_id);
        }
      }
      return json({ running });
    }
    const saved = await this.saved(`/api/v1/cloudroom/threads/${id}${rest}`);
    if (rest === "") {
      const summary = this.summaryById.get(id);
      const model = this.threads.get(id)?.events.model || summary?.model || "";
      return json({
        authRequired: false,
        starting: false,
        sessionId: null,
        paused: false,
        failedStart: false,
        model: "",
        reasoning: "high",
        serviceTier: "default",
        error: null,
        reconnecting: false,
        usageLimit: false,
        disk: null,
        pendingDelivery: 0,
        ...saved,
        ...(model ? { model } : {}),
        ...(summary?.reasoning ? { reasoning: summary.reasoning } : {}),
      });
    }
    if (rest === "/share") return json(saved);
    return saved
      ? json(saved)
      : json({ message: `Not available while your ${COMPUTER} is off.` }, 404);
  }
}

export function installCloudServer(): void {
  markMacOff();
  new CloudServer(window.fetch.bind(window)).install();
}
