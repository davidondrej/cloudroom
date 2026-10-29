import { COMPUTER, PERSONAL_PROJECT_ID } from "@cloudroom/domain";
import { appToast } from "@/components/ui/app-toast";
import { wsManager } from "@/lib/ws";
import { cloudApi, SignedOutError, type CloudThreadSummary } from "./cloud-api";
import { macOnline, markMacOff, SAVED_API, startupMac } from "./cloud-mode";
import {
  CloudThreadEvents,
  cloudTimelineRows,
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
const WAKE_MS = 90_000;
const FIRST_ROWS_MS = 1500;
const SAVED_TIMEOUT_MS = 700;
const SAVED_REUSE_MS = 30_000;
const OUTBOX_MS = 10 * 60_000;
const MAC_CHECK_MS = 60_000;
const MATCH_CHARS = 3000;
const MAC_CHECK_MAX_MS = 5 * 60_000;
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

const newProject = (id: string | null, name: string | null): Project => ({
  id: id ?? PERSONAL_PROJECT_ID,
  kind: id === null ? "personal" : "standard",
  name: name ?? "Personal",
  gitRemoteUrl: null,
  createdAt: 0,
  updatedAt: 0,
  sources: [],
  defaultExecutionOptions: null,
  threads: [],
});

const cloudEntry = (
  thread: CloudThreadSummary,
  projectId: string,
): ThreadEntry => {
  const at = thread.woke_at ? Date.parse(thread.woke_at) : 0;
  return {
    id: thread.thread_id,
    projectId,
    environmentId: null,
    executionTarget: "cloud",
    providerId: "claude-code",
    title: thread.title,
    titleFallback: null,
    sectionId: null,
    status: "idle",
    parentThreadId: null,
    sourceThreadId: null,
    originKind: null,
    originPluginId: null,
    visibility: "visible",
    archivedAt: null,
    pinnedAt: null,
    deletedAt: null,
    lastReadAt: Date.now(),
    latestAttentionAt: at,
    createdAt: at,
    updatedAt: at,
    queuedWork: "none",
    pinSortKey: null,
    hasPendingInteraction: false,
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

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
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

  async send(text: string, requestId: string | undefined) {
    const outgoing: Outgoing | null =
      requestId && this.historyLoaded
        ? {
            requestId,
            text: text.trim(),
            at: Date.now(),
            after: this.events.promptLog.length,
          }
        : null;
    await cloudApi.send(this.id, text, requestId);
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
  private readonly readAt = new Map<string, number>();
  private readonly tabs = new Map<string, Json>();
  private busy = 0;
  private readonly preferences: Json = {};
  private readonly savedCopies = new Map<
    string,
    { at: number; value: Promise<Json | null> }
  >();
  private list: { at: number; value: Promise<CloudThreadSummary[]> } | null =
    null;

  constructor(private readonly network: typeof fetch) {}

  install() {
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
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") {
        for (const thread of this.threads.values()) thread.pause();
        return;
      }
      reloadIfMacBack();
      this.list = null;
      for (const thread of this.threads.values()) thread.refresh();
    });
  }

  private async handle(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const thread = THREAD.exec(path);
    const cloudThread = CLOUD_THREAD.exec(path);
    if (request.method === "GET") {
      if (path === "/api/v1/sidebar-bootstrap")
        return json(await this.sidebar());
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
      thread && (thread[2] === "/send" || thread[2] === "/stop")
        ? await this.onMac(thread[1])
        : null;
    if (onMac) return onMac;
    if (thread && thread[2] === "/send") {
      const body = object(await request.json().catch(() => null));
      const parts = (Array.isArray(body.input) ? body.input : []).map(object);
      if (parts.some((part) => part.type !== "text"))
        return needsMac(`Photos and files need your ${COMPUTER} for now.`);
      const text = parts
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n")
        .trim();
      if (!text)
        return json(
          { message: `Only text messages work while your ${COMPUTER} is off.` },
          400,
        );
      const requestId =
        typeof body.requestId === "string" && REQUEST_ID.test(body.requestId)
          ? body.requestId
          : undefined;
      const queuedMessage = await this.thread(thread[1]).send(text, requestId);
      return json(
        queuedMessage
          ? { ok: true, delivery: "queued", queuedMessage }
          : { ok: true, delivery: "sent" },
      );
    }
    if (thread && (thread[2] === "/read" || thread[2] === "/unread")) {
      this.readAt.set(thread[1], thread[2] === "/read" ? Date.now() : 0);
      return this.threadGet(thread[1], "", url);
    }
    if (thread && thread[2] === "/stop") {
      await cloudApi.stop(thread[1]);
      this.thread(thread[1]).listenIfLoaded();
      return json({ ok: true, cancelledRetries: 0 });
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
      return needsMac(`Starting a new thread needs your ${COMPUTER} for now.`);
    if (/^\/api\/v1\/projects\/[^/]+\/attachments/.test(path))
      return needsMac(`Photos and files need your ${COMPUTER} for now.`);
    if (path === "/api/v1/cloudroom/account/activity") return empty();
    return needsMac();
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
    const status = this.status(entry.id);
    const readAt = this.readAt.get(entry.id);
    return {
      ...entry,
      status,
      runtime: { displayStatus: status, hostReconnectGraceExpiresAt: null },
      ...(readAt === undefined ? {} : { lastReadAt: readAt }),
    };
  }

  private status(id: string): "active" | "idle" {
    return this.threads.get(id)?.events.working ? "active" : "idle";
  }

  private cloudThreads(): Promise<CloudThreadSummary[]> {
    if (!this.list || Date.now() - this.list.at > LIST_TTL_MS) {
      const value = cloudApi.threads();
      this.list = { at: Date.now(), value };
      value.catch(() => {
        this.list = null;
      });
    }
    return this.list.value;
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
    const [saved, cloud] = await Promise.all([
      this.saved("/api/v1/sidebar-bootstrap"),
      this.cloudThreads(),
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
      project.threads.push(this.live(cloudEntry(thread, project.id)));
    }
    return {
      ...sidebar,
      sections: [],
      projects: [...projects.values()],
      personalProject: personal,
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
      const rows = cloudTimelineRows(thread.events, title, display);
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
        activeBackgroundCommands: [],
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
    const saved = await this.saved(`/api/v1/cloudroom/threads/${id}${rest}`);
    if (rest === "") {
      const model = this.threads.get(id)?.events.model;
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
