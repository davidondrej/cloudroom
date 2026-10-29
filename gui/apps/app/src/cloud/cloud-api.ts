import type { CloudRecord } from "./cloud-timeline";

export interface CloudThreadSummary {
  thread_id: string;
  title: string | null;
  project_id: string | null;
  project_name: string | null;
  state: string;
  woke_at: string | null;
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
  history(threadId: string, after: number): Promise<CloudHistory>;
  send(threadId: string, text: string, requestId?: string): Promise<void>;
  stop(threadId: string): Promise<void>;
  listen(
    threadId: string,
    after: number,
    listeners: CloudListeners,
  ): () => void;
}

export class SignedOutError extends Error {}

const HISTORY_TIMEOUT_MS = 120_000;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/__cloud/${path}`, {
    cache: "no-store",
    ...init,
  });
  if (response.status === 401) throw new SignedOutError("Sign in again.");
  const value = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!response.ok || value === null)
    throw new Error(value?.error ?? "Cloudroom is unreachable. Try again.");
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
  history: (threadId, after) =>
    request<CloudHistory>(`threads/${threadId}?after=${after}`, {
      signal: AbortSignal.timeout(HISTORY_TIMEOUT_MS),
    }),
  send: async (threadId, text, requestId) =>
    void (await post(threadId, {
      action: "send",
      text,
      request_id: requestId,
    })),
  stop: async (threadId) => void (await post(threadId, { action: "stop" })),
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
};
