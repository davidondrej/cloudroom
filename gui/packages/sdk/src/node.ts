import {
  CALLER_TOKEN_HEADER,
  createCallerProofFetch,
} from "@cloudroom/config/caller-proof";
import { loadCliConfig, type CliConfig } from "@cloudroom/config/cli";
import {
  createHostDaemonLocalClient,
  DEFAULT_HOST_DAEMON_LOCAL_BIND_HOST,
} from "@cloudroom/host-daemon-contract";
import { createGuideArea } from "./areas/guide.js";
import { createRoomSdk, type RoomSdk, type RoomSdkAreas } from "./core.js";
import { createNodeWebsocketFactory } from "./node-websocket.js";
import {
  createRequestTimeoutFetch,
  DEFAULT_ROOM_REQUEST_TIMEOUT_MS,
  type FetchImplementation,
} from "./response.js";
import { createHttpTransport } from "./transport-http.js";
import type {
  RoomRealtimeSocketFactory,
  RoomSdkContext,
  RoomSdkTransport,
} from "./transport.js";

export interface CreateNodeTransportArgs {
  baseUrl?: string;
  callerToken?: string;
  cliConfig?: CliConfig;
  fetch?: FetchImplementation;
  realtimeUrl?: string;
  timeoutMs?: number;
  websocket?: RoomRealtimeSocketFactory;
}

export interface CreateNodeRoomSdkArgs extends CreateNodeTransportArgs {
  context?: RoomSdkContext;
}

export interface FetchLocalHostIdArgs {
  cliConfig?: CliConfig;
  hostDaemonUrl?: string;
}

function resolveCliConfig(cliConfig?: CliConfig): CliConfig {
  return cliConfig ?? loadCliConfig();
}

function resolveHostDaemonUrl(cliConfig?: CliConfig): string {
  const config = resolveCliConfig(cliConfig);
  return `http://${DEFAULT_HOST_DAEMON_LOCAL_BIND_HOST}:${config.ROOM_HOST_DAEMON_PORT}`;
}

function withCallerToken(
  fetchImpl: FetchImplementation,
  callerToken: string,
): FetchImplementation {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set(CALLER_TOKEN_HEADER, callerToken);
    return fetchImpl(input, { ...init, headers });
  };
}

export function createNodeTransport(
  args: CreateNodeTransportArgs = {},
): RoomSdkTransport {
  const fetchImpl =
    args.fetch ??
    createRequestTimeoutFetch({
      timeoutMs: args.timeoutMs ?? DEFAULT_ROOM_REQUEST_TIMEOUT_MS,
    });
  return createHttpTransport({
    baseUrl: args.baseUrl ?? resolveCliConfig(args.cliConfig).ROOM_SERVER_URL,
    fetch:
      args.callerToken === undefined
        ? createCallerProofFetch(fetchImpl)
        : withCallerToken(fetchImpl, args.callerToken),
    realtimeUrl: args.realtimeUrl,
    runtime: "node",
    websocket:
      args.websocket ??
      createNodeWebsocketFactory({ callerToken: args.callerToken }),
  });
}

export function createNodeRoomSdk(args: CreateNodeRoomSdkArgs = {}): RoomSdk {
  return createRoomSdk({
    context: args.context,
    guide: createGuideArea(),
    transport: createNodeTransport(args),
  });
}

export async function fetchLocalHostId(
  args: FetchLocalHostIdArgs = {},
): Promise<string | null> {
  try {
    const client = createHostDaemonLocalClient(
      args.hostDaemonUrl ?? resolveHostDaemonUrl(args.cliConfig),
    );
    const response = await client.status.$get();
    if (!response.ok) {
      return null;
    }
    const body = await response.json();
    return body.hostId;
  } catch {
    return null;
  }
}

export {
  createRoomSdk as createBbSdk,
  createHttpTransport,
  createRequestTimeoutFetch,
  DEFAULT_ROOM_REQUEST_TIMEOUT_MS as DEFAULT_BB_REQUEST_TIMEOUT_MS,
};
export { RoomHttpError as BbHttpError, RoomRequestTimeoutError as BbRequestTimeoutError } from "./response.js";
export {
  pluginMutationResponseSchema,
  type PluginMutationResponse,
} from "./areas/plugins.js";
export { createBuiltinPlanCommandTextInput } from "./core.js";
export { createGuideArea } from "./areas/guide.js";
export {
  DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS,
  DEFAULT_THREAD_WAIT_TIMEOUT_MS,
  ThreadWaitTimeoutError,
  ThreadWaitUnreachableError,
} from "./areas/threads.js";
export type {
  RoomSdk as BbSdk,
  RoomSdkAreas as BbSdkAreas,
  RoomSdkContext as BbSdkContext,
  RoomSdkTransport as BbSdkTransport,
  FetchImplementation,
};
export type * from "./areas/skills.js";
export type {
  RoomRealtimeSocket as BbRealtimeSocket,
  RoomRealtimeSocketFactory as BbRealtimeSocketFactory,
  RoomRealtimeSocketMessageEvent as BbRealtimeSocketMessageEvent,
} from "./transport.js";
export type { RoomHttpErrorArgs as BbHttpErrorArgs } from "./response.js";
export type * from "./public-types.js";
