import { createHash, randomBytes } from "node:crypto";
import {
  createNodeRoomSdk,
  createRequestTimeoutFetch,
  DEFAULT_BB_REQUEST_TIMEOUT_MS,
  type BbSdk,
  type FetchImplementation,
} from "@cloudroom/sdk";
import type { ExperimentalPluginRpcCaller } from "@get-bb/plugin-sdk";

export const PLUGIN_RPC_CALLER_HEADER = "x-bb-plugin-caller";

export interface PluginRpcCallerCredential {
  readonly token: string;
  revoke(): void;
}

export type PluginRpcCallerResolution =
  | { ok: true; caller: ExperimentalPluginRpcCaller }
  | { ok: false };

export interface PluginRpcCallerRegistry {
  issue(pluginId: string): PluginRpcCallerCredential;
  resolve(token: string | undefined): PluginRpcCallerResolution;
}

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createPluginRpcCallerRegistry(): PluginRpcCallerRegistry {
  const callers = new Map<string, string>();
  return {
    issue(pluginId) {
      const token = randomBytes(32).toString("base64url");
      const key = tokenKey(token);
      callers.set(key, pluginId);
      return {
        token,
        revoke() {
          callers.delete(key);
        },
      };
    },
    resolve(token) {
      if (token === undefined) return { ok: true, caller: { kind: "client" } };
      const pluginId = callers.get(tokenKey(token));
      return pluginId === undefined
        ? { ok: false }
        : { ok: true, caller: { kind: "plugin", pluginId } };
    },
  };
}

const PLUGIN_SDK_CALLS_AT_ONCE = 16;
// A call this old (a long poll, or one whose handler calls a plugin that
// calls back in) stops holding its slot, so waiting calls can't deadlock.
const LONG_PLUGIN_SDK_CALL_MS = 1_000;
let countedPluginSdkCalls = 0;
const waitingPluginSdkCalls: Array<() => void> = [];
const requestTimeoutFetch = createRequestTimeoutFetch({
  timeoutMs: DEFAULT_BB_REQUEST_TIMEOUT_MS,
});

function admitWaitingPluginSdkCalls(): void {
  while (countedPluginSdkCalls < PLUGIN_SDK_CALLS_AT_ONCE) {
    const admit = waitingPluginSdkCalls.shift();
    if (admit === undefined) return;
    countedPluginSdkCalls += 1;
    admit();
  }
}

// Plugins call this server over loopback, one socket per call in flight. A
// plugin reading every thread at once opened ~1,000 sockets to the server,
// filled its listen queue, and locked the CLI and app out (#1032).
export const pluginSdkFetch: FetchImplementation = async (input, init) => {
  if (countedPluginSdkCalls < PLUGIN_SDK_CALLS_AT_ONCE) {
    countedPluginSdkCalls += 1;
  } else {
    await new Promise<void>((resolve) => waitingPluginSdkCalls.push(resolve));
  }
  let counted = true;
  const release = () => {
    if (!counted) return;
    counted = false;
    countedPluginSdkCalls -= 1;
    admitWaitingPluginSdkCalls();
  };
  const timer = setTimeout(release, LONG_PLUGIN_SDK_CALL_MS);
  try {
    return await requestTimeoutFetch(input, init);
  } finally {
    clearTimeout(timer);
    release();
  }
};

export function createPluginRpcCallerSdk(args: {
  baseUrl: string;
  callerToken?: string;
  token: string;
}): BbSdk {
  return createNodeRoomSdk({
    baseUrl: args.baseUrl,
    callerToken: args.callerToken,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set(PLUGIN_RPC_CALLER_HEADER, args.token);
      return pluginSdkFetch(input, { ...init, headers });
    },
  });
}
