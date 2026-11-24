import type { ApiClient } from "@cloudroom/server-contract";
import type {
  FetchImplementation,
  JsonBodyOf,
  SdkResponseLike,
} from "./response.js";

export type RoomSdkRuntime = "node" | "browser";

export interface RoomSdkTransport {
  api: ApiClient["api"];
  baseUrl: string;
  fetch: FetchImplementation;
  realtimeUrl?: string;
  runtime: RoomSdkRuntime;
  readJson<TResponse extends SdkResponseLike>(
    response: Promise<TResponse>,
  ): Promise<JsonBodyOf<TResponse>>;
  readVoid<TResponse extends SdkResponseLike>(
    response: Promise<TResponse>,
  ): Promise<void>;
  resolve<TResponse extends SdkResponseLike>(
    response: Promise<TResponse>,
  ): Promise<TResponse>;
  websocket?: RoomRealtimeSocketFactory;
}

export interface RoomRealtimeSocketMessageEvent {
  data: unknown;
}

export interface RoomRealtimeSocket {
  close(): void;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: RoomRealtimeSocketMessageEvent) => void) | null;
  onopen: (() => void) | null;
  readyState: number;
  send(data: string): void;
}

export type RoomRealtimeSocketFactory = (url: string) => RoomRealtimeSocket;

export interface RoomSdkContext {}

export interface CreateHttpTransportArgs {
  baseUrl?: string;
  fetch?: FetchImplementation;
  realtimeUrl?: string;
  runtime: RoomSdkRuntime;
  websocket?: RoomRealtimeSocketFactory;
}
