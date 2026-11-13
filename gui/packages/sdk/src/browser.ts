import {
  createRoomSdk,
  createBuiltinPlanCommandTextInput,
  type RoomSdk,
  type RoomSdkAreas,
} from "./core.js";
import { createHttpTransport } from "./transport-http.js";
import type {
  RoomRealtimeSocketFactory,
  RoomSdkContext,
  RoomSdkTransport,
} from "./transport.js";

export interface CreateBrowserTransportArgs {
  baseUrl?: string;
  fetch?: typeof fetch;
  realtimeUrl?: string;
  websocket?: RoomRealtimeSocketFactory;
}

export interface CreateBrowserRoomSdkArgs extends CreateBrowserTransportArgs {
  context?: RoomSdkContext;
}

export type BrowserRoomSdk = RoomSdkAreas;

export function createBrowserTransport(
  args: CreateBrowserTransportArgs = {},
): RoomSdkTransport {
  return createHttpTransport({
    baseUrl: args.baseUrl,
    fetch: args.fetch,
    realtimeUrl: args.realtimeUrl,
    runtime: "browser",
    websocket: args.websocket,
  });
}

export function createBrowserRoomSdk(
  args: CreateBrowserRoomSdkArgs = {},
): BrowserRoomSdk {
  return createRoomSdk({
    context: args.context,
    transport: createBrowserTransport(args),
  });
}

export { RoomHttpError as BbHttpError, RoomRequestTimeoutError as BbRequestTimeoutError } from "./response.js";
export type { RoomHttpErrorArgs as BbHttpErrorArgs } from "./response.js";
export { createRoomSdk as createBbSdk, createBuiltinPlanCommandTextInput, createHttpTransport };
export type { RoomSdk as BbSdk, RoomSdkAreas as BbSdkAreas, RoomSdkContext as BbSdkContext, RoomSdkTransport as BbSdkTransport };
export type * from "./areas/skills.js";
export type * from "./public-types.js";
