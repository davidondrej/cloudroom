import {
  CALLER_PROOF_STATUS_HEADER,
  CALLER_TOKEN_HEADER,
  callerTokenFor,
  createCallerProofFetch,
  DAEMON_CALLER_PROOF_PATH,
  renewCallerToken,
} from "@cloudroom/config/caller-proof";
import { isLoopbackHostname } from "@cloudroom/config/loopback";
import { DEFAULT_HOST_DAEMON_LOCAL_BIND_HOST } from "@cloudroom/host-daemon-contract";

const PROOF_TIMEOUT_MS = 5_000;
const RELOAD_COOLDOWN_MS = 10_000;
const DAEMON_REFRESH_COOLDOWN_MS = 5_000;

export interface LocalCallerOrigins {
  app: string | null;
  daemons: ReadonlySet<string>;
  server: string | null;
}

export interface CallerTokenTarget {
  origin: string;
  proofPath?: string;
}

interface HeaderDetails {
  requestHeaders: Record<string, string>;
  url: string;
  webContentsId?: number;
}

interface CompletedDetails {
  frame?: { parent: unknown } | null;
  responseHeaders?: Record<string, string[]>;
  statusCode: number;
  url: string;
  webContentsId?: number;
}

export const localServerFetch = createCallerProofFetch((input, init) =>
  fetch(input, init),
);

function httpOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "ws:") parsed.protocol = "http:";
    if (parsed.protocol === "wss:") parsed.protocol = "https:";
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

export function callerTokenTarget(
  url: string,
  origins: LocalCallerOrigins,
): CallerTokenTarget | null {
  const origin = httpOrigin(url);
  if (origin === null) return null;
  if (origins.daemons.has(origin)) {
    return { origin, proofPath: DAEMON_CALLER_PROOF_PATH };
  }
  if (
    origins.server !== null &&
    (origin === origins.server || origin === origins.app)
  ) {
    return { origin: origins.server };
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(fallback), PROOF_TIMEOUT_MS).unref?.();
    }),
  ]);
}

function headerValue(
  headers: Record<string, string[]> | undefined,
  name: string,
): string | undefined {
  for (const [key, values] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name) return values[0];
  }
  return undefined;
}

async function readLocalHelperPorts(serverUrl: string): Promise<number[]> {
  const response = await fetch(new URL("/api/v1/system/config", serverUrl), {
    signal: AbortSignal.timeout(PROOF_TIMEOUT_MS),
  });
  if (!response.ok) return [];
  const body: unknown = await response.json();
  const ports =
    typeof body === "object" && body !== null
      ? (body as { localHelperPorts?: unknown }).localHelperPorts
      : undefined;
  return Array.isArray(ports)
    ? ports.filter(
        (port): port is number =>
          Number.isInteger(port) && port > 0 && port <= 65_535,
      )
    : [];
}

export function createLocalCallerAuth(args: {
  isAppWebContents(id: number): boolean;
  localServerUrl(): string;
  reloadAppWindows(): void;
}) {
  let origins: LocalCallerOrigins = {
    app: null,
    daemons: new Set(),
    server: null,
  };
  let lastReloadAt = 0;
  let lastDaemonRefreshAt = 0;

  async function refreshDaemons(): Promise<void> {
    const ports = await readLocalHelperPorts(args.localServerUrl()).catch(
      () => null,
    );
    if (ports === null) return;
    origins = {
      ...origins,
      daemons: new Set(
        ports.map(
          (port) => `http://${DEFAULT_HOST_DAEMON_LOCAL_BIND_HOST}:${port}`,
        ),
      ),
    };
  }

  function tokenFor(
    target: CallerTokenTarget,
    force = false,
  ): Promise<string | null> {
    return withTimeout(
      callerTokenFor(target.origin, { force, proofPath: target.proofPath }),
      null,
    );
  }

  return {
    async prepare(serverUrl: string, appUrl: string): Promise<void> {
      origins = {
        ...origins,
        app: httpOrigin(appUrl),
        server: httpOrigin(serverUrl),
      };
      await tokenFor({ origin: serverUrl }, true);
      await refreshDaemons();
    },
    clear(): void {
      origins = { ...origins, app: null, server: null };
    },
    refreshDaemons,
    beforeSendHeaders(
      details: HeaderDetails,
      callback: (response: { requestHeaders: Record<string, string> }) => void,
    ): void {
      const target =
        details.webContentsId !== undefined &&
        args.isAppWebContents(details.webContentsId)
          ? callerTokenTarget(details.url, origins)
          : null;
      if (target === null) {
        callback({ requestHeaders: details.requestHeaders });
        return;
      }
      void tokenFor(target).then((token) => {
        const requestHeaders: Record<string, string> = {};
        for (const [name, value] of Object.entries(details.requestHeaders)) {
          if (name.toLowerCase() !== CALLER_TOKEN_HEADER) {
            requestHeaders[name] = value;
          }
        }
        if (token !== null) requestHeaders[CALLER_TOKEN_HEADER] = token;
        callback({ requestHeaders });
      });
    },
    completed(details: CompletedDetails): void {
      const status = headerValue(
        details.responseHeaders,
        CALLER_PROOF_STATUS_HEADER,
      );
      if (
        details.statusCode !== 401 ||
        (status !== "invalid" && status !== "required") ||
        details.webContentsId === undefined ||
        !args.isAppWebContents(details.webContentsId) ||
        (details.frame !== undefined &&
          details.frame !== null &&
          details.frame.parent !== null)
      ) {
        return;
      }
      const target = callerTokenTarget(details.url, origins);
      if (target === null) {
        if (
          isLoopbackHostname(new URL(details.url).hostname) &&
          Date.now() - lastDaemonRefreshAt > DAEMON_REFRESH_COOLDOWN_MS
        ) {
          lastDaemonRefreshAt = Date.now();
          void refreshDaemons();
        }
        return;
      }
      void (async () => {
        const previous = await tokenFor(target);
        if (status === "required" && previous !== null) return;
        const renewed = await withTimeout(
          renewCallerToken(target.origin, previous, target.proofPath),
          null,
        );
        if (
          target.proofPath === undefined &&
          renewed !== null &&
          renewed !== previous &&
          Date.now() - lastReloadAt > RELOAD_COOLDOWN_MS
        ) {
          lastReloadAt = Date.now();
          args.reloadAppWindows();
        }
      })();
    },
  };
}
