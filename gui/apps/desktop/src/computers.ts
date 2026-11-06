// Your Macs on cloudroom.run: list them and open one in this window (ADR 0184 relay).
import { localServerFetch } from "./local-caller-auth.js";
import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { z } from "zod";
import {
  connectCredentialSchema,
  deriveConnectBaseUrl,
  type ConnectCredential,
} from "@cloudroom/connect-client";

export const RELAY_CREDENTIAL_FILE_NAME = "relay-credential.bin";
const RELAY_HOST = new URL(
  process.env.CLOUDROOM_CONNECT_URL ?? "https://cloudroom.run",
).hostname;
// One try to open another Mac waits up to 5 seconds.
const OPEN_TIMEOUT_MS = 5_000;
// A Mac that blinks offline (a relay hiccup, a reconnect) is still the one you picked, so keep trying this long before
// opening this Mac instead.
export const OPEN_RETRY_MS = 30_000;
const LIST_TIMEOUT_MS = 10_000;

const computerSchema = z.object({
  handle: z.string().min(1),
  name: z.string().min(1),
  live: z.boolean(),
  url: z.string().url(),
});
export type Computer = z.infer<typeof computerSchema>;

const listSchema = z.object({
  selfHandle: z.string().min(1),
  computers: z.array(computerSchema),
});
const openSchema = z.object({
  url: z.string().url(),
  cookie: z.object({
    name: z.string().min(1),
    value: z.string().min(1),
    expiresAt: z.number().positive(),
  }),
});

export type ComputersFailure =
  | "no-credential"
  | "unauthorized"
  | "offline"
  | "unavailable";
export type ComputersResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: ComputersFailure };

interface CookieStore {
  set(details: {
    url: string;
    name: string;
    value: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite: "lax";
    expirationDate: number;
  }): Promise<void>;
}

export function isRelayUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(`.${RELAY_HOST}`);
  } catch {
    return false;
  }
}

/** The name people see in Finder, like "David's MacBook Pro". */
export async function computerName(): Promise<string> {
  if (process.platform === "darwin") {
    const name = await promisify(execFile)(
      "scutil",
      ["--get", "ComputerName"],
      { timeout: 2_000 },
    )
      .then(({ stdout }) => stdout.trim())
      .catch(() => "");
    if (name) return name;
  }
  return hostname().replace(/\.local$/u, "");
}

/** This Mac's cloudroom.run key, from the Connect plugin on the local server: null when it has none (signed out),
 *  undefined when the server didn't answer. */
export async function fetchRelayCredential(
  localServerUrl: string,
): Promise<ConnectCredential | null | undefined> {
  const response = await localServerFetch(
    new URL("/api/v1/plugins/connect/rpc/relayCredential", localServerUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
      // A stuck local server must not hold up opening another Mac or falling back.
      signal: AbortSignal.timeout(5_000),
    },
  ).catch(() => null);
  const body: unknown = await response?.json().catch(() => null);
  const parsed = z
    .object({ ok: z.literal(true), result: connectCredentialSchema.nullable() })
    .safeParse(body);
  return parsed.success ? parsed.data.result : undefined;
}

/** Every cloudroom.run address this app has a cookie for: other Macs it opened and their port shares. */
export async function relayCookieOrigins(cookies: {
  get(filter: Record<string, never>): Promise<{ domain?: string }[]>;
}): Promise<string[]> {
  const origins = (await cookies.get({}).catch(() => [])).map(
    ({ domain }) => `https://${(domain ?? "").replace(/^\./u, "")}`,
  );
  return [...new Set(origins.filter(isRelayUrl))];
}

async function callRelay(
  credential: ConnectCredential,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<ComputersResult<unknown>> {
  try {
    const response = await fetch(
      new URL(path, deriveConnectBaseUrl(credential.serverUrl)),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (response.status === 401) return { ok: false, reason: "unauthorized" };
    if (response.status === 409) return { ok: false, reason: "offline" };
    if (!response.ok) return { ok: false, reason: "unavailable" };
    return { ok: true, value: await response.json() };
  } catch {
    // A timeout means the relay or the Mac is too slow to use right now.
    return { ok: false, reason: "offline" };
  }
}

export async function listComputers(
  credential: ConnectCredential,
  name: string,
): Promise<ComputersResult<z.infer<typeof listSchema>>> {
  const result = await callRelay(
    credential,
    "/api/computers",
    { name },
    LIST_TIMEOUT_MS,
  );
  if (!result.ok)
    return result.reason === "offline"
      ? { ok: false, reason: "unavailable" }
      : result;
  const parsed = listSchema.safeParse(result.value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: "unavailable" };
}

export interface OpenedComputer {
  url: string;
  expiresAt: number;
}

/** Signs this app in to another of your Macs and returns the address to load. */
export async function openComputer(
  credential: ConnectCredential,
  handle: string,
  cookies: CookieStore,
): Promise<ComputersResult<OpenedComputer>> {
  const result = await callRelay(
    credential,
    "/api/computers/open",
    { handle },
    OPEN_TIMEOUT_MS,
  );
  if (!result.ok) return result;
  const parsed = openSchema.safeParse(result.value);
  if (!parsed.success) return { ok: false, reason: "unavailable" };
  const { url, cookie } = parsed.data;
  // The relay's __Host- cookie must have no domain, so it stays on that one Mac's address.
  try {
    await cookies.set({
      url,
      name: cookie.name,
      value: cookie.value,
      path: "/",
      secure: url.startsWith("https:"),
      httpOnly: true,
      sameSite: "lax",
      expirationDate: cookie.expiresAt / 1000,
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  return { ok: true, value: { url, expiresAt: cookie.expiresAt } };
}

const RENEW_CHECK_MS = 60 * 60_000;
// The relay's sign-in lasts 30 days. Renew with a week to spare, so a sleeping Mac never wakes up signed out.
const RENEW_BEFORE_MS = 7 * 24 * 60 * 60_000;
// After a recovery, the reloaded page answering "Sign in required" this soon means a new sign-in doesn't help.
// Other requests in that window are the old page's stragglers.
const RECOVERY_WINDOW_MS = 60_000;

export interface RelaySessionKeeper {
  track(handle: string, opened: OpenedComputer): void;
  clear(): void;
  renewIfExpiring(): Promise<void>;
  onSignInRequired(url: string, page: boolean): Promise<void>;
}

/**
 * Keeps this app signed in to the Mac on screen. It renews the sign-in before it expires, and gets a new one
 * when the Mac answers "Sign in required" (after "Sign out all phones"). If that fails, `onLost` reopens it.
 */
export function createRelaySessionKeeper(args: {
  renew: (handle: string) => Promise<ComputersResult<OpenedComputer>>;
  onRecovered: () => void;
  onLost: () => void;
  now?: () => number;
}): RelaySessionKeeper {
  const now = args.now ?? Date.now;
  let current: { handle: string; origin: string; expiresAt: number } | null =
    null;
  let recoveredAt = Number.NEGATIVE_INFINITY;
  let renewing: Promise<boolean> | null = null;

  // True when a new sign-in is in place. Calls made while one is running share it.
  function renew(): Promise<boolean> {
    const target = current;
    if (target === null) return Promise.resolve(false);
    renewing ??= args
      .renew(target.handle)
      .then((result) => {
        if (!result.ok || current !== target) return false;
        target.expiresAt = result.value.expiresAt;
        return true;
      })
      .finally(() => {
        renewing = null;
      });
    return renewing;
  }

  const keeper: RelaySessionKeeper = {
    track(handle, opened) {
      current = {
        handle,
        origin: new URL(opened.url).origin,
        expiresAt: opened.expiresAt,
      };
      recoveredAt = Number.NEGATIVE_INFINITY;
    },
    clear() {
      current = null;
    },
    async renewIfExpiring() {
      if (current !== null && current.expiresAt - now() < RENEW_BEFORE_MS)
        await renew();
    },
    async onSignInRequired(url, page) {
      const target = current;
      if (
        target === null ||
        renewing !== null ||
        new URL(url).origin !== target.origin
      )
        return;
      if (now() - recoveredAt < RECOVERY_WINDOW_MS) {
        if (!page) return;
        keeper.clear();
        args.onLost();
        return;
      }
      recoveredAt = now();
      if (!(await renew())) {
        if (current === target) {
          keeper.clear();
          args.onLost();
        }
        return;
      }
      if (current === target) args.onRecovered();
    },
  };
  setInterval(() => void keeper.renewIfExpiring(), RENEW_CHECK_MS).unref();
  return keeper;
}

export type ComputerList = z.infer<typeof listSchema>;

const SYNC_INTERVAL_MS = 10 * 60_000;
// While this Mac stands in for an offline one, check every minute so "Switch back" shows up soon.
const FALLBACK_SYNC_INTERVAL_MS = 60_000;
const MIN_LIST_INTERVAL_MS = 60_000;
// The Connect plugin registers this Mac a few seconds after the server starts.
const STARTUP_RETRY_MS = 5_000;
const STARTUP_RETRIES = 6;

export interface ComputersSync {
  syncNow(): Promise<void>;
  onListRequested(): void;
  onRuntimeReady(): void;
  setFallback(on: boolean): void;
}

export function createComputersSync(args: {
  fetchList: () => Promise<ComputersResult<ComputerList>>;
  onResult: (result: ComputersResult<ComputerList>) => void;
}): ComputersSync {
  let inFlight: Promise<void> | null = null;
  let lastAttemptAt = 0;
  let retries = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const schedule = (ms: number) => {
    clearInterval(timer);
    timer = setInterval(() => void syncNow(), ms);
    timer.unref();
  };

  function syncNow(): Promise<void> {
    inFlight ??= (async () => {
      lastAttemptAt = Date.now();
      const result = await args.fetchList();
      args.onResult(result);
      if (
        result.ok ||
        result.reason === "unauthorized" ||
        retries >= STARTUP_RETRIES
      )
        return;
      retries += 1;
      setTimeout(() => void syncNow(), STARTUP_RETRY_MS).unref();
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  schedule(SYNC_INTERVAL_MS);
  return {
    syncNow,
    onListRequested() {
      if (Date.now() - lastAttemptAt >= MIN_LIST_INTERVAL_MS) void syncNow();
    },
    onRuntimeReady() {
      retries = 0;
      void syncNow();
    },
    setFallback(on) {
      schedule(on ? FALLBACK_SYNC_INTERVAL_MS : SYNC_INTERVAL_MS);
    },
  };
}

// The relay marks answers from a Mac that dropped off: 503 plus one of these headers set to "1".
const OFFLINE_MARKS = ["x-bb-tunnel-offline", "x-cloudroom-offline"];

export function hasOfflineMark(status: number, header: (name: string) => string | null | undefined): boolean {
  return status === 503 && OFFLINE_MARKS.some((name) => header(name) === "1");
}

// While this window shows another Mac, ask it every 10 seconds if it's still there.
export const OTHER_MAC_PING_MS = 10_000;
const OTHER_MAC_PING_TIMEOUT_MS = 15_000;
/** Marks the ping, so a 401 on it never counts as "your sign-in to that Mac expired". */
export const OTHER_MAC_PING_PATH = "/health?from=desktop-ping";

export function watchOtherMac(args: {
  /** The other Mac's address while this window shows it, else null. */
  viewing: () => string | null;
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  onOffline: () => void;
}): () => void {
  let busy = false;
  const timer = setInterval(() => {
    const url = args.viewing();
    if (url === null || busy) return;
    busy = true;
    void args
      .fetch(new URL(OTHER_MAC_PING_PATH, url).href, { signal: AbortSignal.timeout(OTHER_MAC_PING_TIMEOUT_MS) })
      .then((response) => {
        if (args.viewing() === url && hasOfflineMark(response.status, (name) => response.headers.get(name))) args.onOffline();
      })
      .catch(() => {})
      .finally(() => {
        busy = false;
      });
  }, OTHER_MAC_PING_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Keeps trying a Mac that dropped while this Mac shows the "Lost MacBook Air" dialog. True once its page is on screen.
 * `deadline` is null once the user picked "Use this Mac now". `current` is false once something newer owns the window.
 */
export async function reconnectOtherMac<Opened>(args: {
  current: () => boolean;
  deadline: () => number | null;
  /** One try to open the Mac on the relay. */
  open: () => Promise<Opened | null>;
  /** Loads its page in the window. False when the page didn't load. */
  load: (opened: Opened) => Promise<boolean>;
  /** Puts this Mac's own app back on screen. */
  showThisMac: () => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const sleep = args.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const trying = () => args.current() && args.deadline() !== null;
  let retryDelayMs = 1_000;
  for (;;) {
    if (!trying()) return false;
    const opened = await args.open();
    if (opened !== null && trying()) {
      const loaded = await args.load(opened);
      if (!args.current()) return false;
      if (loaded && args.deadline() !== null) return true;
      // The page failed, or the user stopped while it loaded: this Mac goes back on screen.
      await args.showThisMac();
    }
    const until = args.deadline();
    if (!args.current() || until === null || Date.now() + retryDelayMs > until) return false;
    await sleep(retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, 8_000);
  }
}
