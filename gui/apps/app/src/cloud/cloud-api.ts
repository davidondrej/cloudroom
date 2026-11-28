import type { CloudRecord } from "./cloud-timeline";

export type CloudTurnState = "working" | "waiting" | "error" | "idle";

export interface CloudThreadSummary {
  thread_id: string;
  title: string | null;
  project_id: string | null;
  project_name: string | null;
  state: string;
  woke_at: string | null;
  /** Missing from older websites and from create replies. */
  parent_thread_id?: string | null;
  harness?: string | null;
  model?: string | null;
  reasoning?: string | null;
  pinned_at?: string | null;
  turn_state?: CloudTurnState | null;
  last_turn_at?: string | null;
}

export interface CloudProjectSummary {
  project_id: string;
  name: string;
  repository: string | null;
  folder: string | null;
  workspace?: string | null;
  default_harness: string | null;
  default_model: string | null;
  default_reasoning: string | null;
}

export interface CloudHistory {
  records: CloudRecord[];
  truncated: boolean;
  awake: boolean;
}

export interface CloudListeners {
  records: (records: CloudRecord[]) => void;
  asleep: () => void;
  error: () => void;
  open: () => void;
}

export interface CloudApi {
  threads(): Promise<CloudThreadSummary[]>;
  projects(): Promise<CloudProjectSummary[]>;
  history(threadId: string, after: number): Promise<CloudHistory>;
  send(
    threadId: string,
    text: string,
    requestId?: string,
    surface?: string,
  ): Promise<void>;
  stop(threadId: string): Promise<void>;
  archive(
    threadId: string,
    includeLive?: boolean,
  ): Promise<{ archivedThreadIds?: string[]; keptLiveThreadIds?: string[] }>;
  unarchive(threadId: string): Promise<void>;
  rename(threadId: string, title: string): Promise<void>;
  pin(threadId: string, pinned: boolean): Promise<void>;
  delete(threadId: string): Promise<void>;
  setModel(
    threadId: string,
    input: { model?: string; reasoning?: string },
  ): Promise<void>;
  create(body: CloudCreate): Promise<CloudThreadSummary>;
  warm(): Promise<void>;
  listen(
    threadId: string,
    after: number,
    listeners: CloudListeners,
  ): () => void;
  subscribeEvents(onChanged: () => void): () => void;
}

export interface CloudCreate {
  project: string;
  request_id?: string;
  text: string;
  title?: string;
  harness?: string;
  model?: string;
  reasoning?: string;
  service_tier?: string;
  target?: string;
  base_branch?: string;
  /** Set only while usage data is on: the website then counts the message as sent from this surface. */
  surface?: string;
}

export class SignedOutError extends Error {}

export class CloudError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
  }
}

const HISTORY_TIMEOUT_MS = 120_000;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/__cloud/${path}`, {
    cache: "no-store",
    ...init,
  });
  if (response.status === 401) throw new SignedOutError("Sign in again.");
  const value = (await response.json().catch(() => null)) as
    | (T & { error?: string; code?: string })
    | null;
  if (!response.ok || value === null)
    throw new CloudError(
      value?.error ?? "Cloudroom is unreachable. Try again.",
      response.ok ? 502 : response.status,
      value?.code ?? null,
    );
  return value;
}

const post = (threadId: string, body: unknown) =>
  request<{ ok: true }>(`threads/${threadId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export const cloudApi: CloudApi = {
  threads: async () =>
    (await request<{ threads: CloudThreadSummary[] }>("threads")).threads,
  projects: async () =>
    (
      await request<{ projects: CloudProjectSummary[] }>("projects").catch(
        () => ({ projects: [] }),
      )
    ).projects,
  history: (threadId, after) =>
    request<CloudHistory>(`threads/${threadId}?after=${after}`, {
      signal: AbortSignal.timeout(HISTORY_TIMEOUT_MS),
    }),
  send: async (threadId, text, requestId, surface) =>
    void (await post(threadId, {
      action: "send",
      text,
      request_id: requestId,
      surface,
    })),
  stop: async (threadId) => void (await post(threadId, { action: "stop" })),
  archive: (threadId, includeLive = true) =>
    request<{
      ok: true;
      archivedThreadIds?: string[];
      keptLiveThreadIds?: string[];
    }>(`threads/${threadId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "archive", include_live: includeLive }),
    }),
  unarchive: async (threadId) =>
    void (await post(threadId, { action: "unarchive" })),
  rename: async (threadId, title) =>
    void (await post(threadId, { action: "rename", title })),
  pin: async (threadId, pinned) =>
    void (await post(threadId, { action: pinned ? "pin" : "unpin" })),
  delete: async (threadId) =>
    void (await post(threadId, { action: "delete" })),
  setModel: async (threadId, input) =>
    void (await post(threadId, { action: "set_model", ...input })),
  create: async (body) =>
    (
      await request<{ thread: CloudThreadSummary }>("threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).thread,
  warm: async () =>
    void (await request<{ ok: true }>("warm", { method: "POST" })),
  listen(threadId, after, listeners) {
    const source = new EventSource(
      `/__cloud/threads/${threadId}/stream?after=${after}`,
    );
    source.onopen = listeners.open;
    source.onmessage = (event) =>
      listeners.records(JSON.parse(event.data) as CloudRecord[]);
    source.addEventListener("asleep", () => {
      source.close();
      listeners.asleep();
    });
    source.onerror = () => {
      source.close();
      listeners.error();
    };
    return () => source.close();
  },
  subscribeEvents(onChanged) {
    if (typeof WebSocket === "undefined") return () => undefined;
    let closed = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let delay = 2000;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const connect = () => {
      if (closed || document.visibilityState !== "visible") return;
      try {
        socket = new WebSocket(`${protocol}//${window.location.host}/__cloud/events`);
      } catch {
        return;
      }
      socket.onopen = () => {
        delay = 2000;
        // One initial client frame arms hibernatable DO close propagation immediately on session revoke.
        try {
          socket?.send("hello");
        } catch {
          // Ignore if closing.
        }
      };
      socket.onmessage = (event) => {
        if (typeof event.data === "string" && event.data.includes("threads-changed")) {
          onChanged();
        }
      };
      socket.onclose = () => {
        socket = null;
        if (closed || document.visibilityState !== "visible") return;
        retryTimer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30_000);
      };
      socket.onerror = () => {
        socket?.close();
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retryTimer);
      socket?.close();
      socket = null;
    };
  },
};
