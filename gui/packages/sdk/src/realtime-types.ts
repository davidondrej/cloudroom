import type { ChangedMessage } from "@cloudroom/domain";

export type RoomRealtimeUnsubscribe = () => void;

export type RoomRealtimeEventName =
  | "thread:changed"
  | "project:changed"
  | "environment:changed"
  | "host:changed"
  | "system:changed"
  | "system:config-changed"
  | "realtime:connection";

export type ThreadRealtimeEvent = Extract<ChangedMessage, { entity: "thread" }>;
export type ProjectRealtimeEvent = Extract<
  ChangedMessage,
  { entity: "project" }
>;
export type EnvironmentRealtimeEvent = Extract<
  ChangedMessage,
  { entity: "environment" }
>;
export type HostRealtimeEvent = Extract<ChangedMessage, { entity: "host" }>;
export type SystemRealtimeEvent = Extract<ChangedMessage, { entity: "system" }>;

export type RoomRealtimeConnectionState =
  | "connecting"
  | "connected"
  | "disconnected";

export interface RoomRealtimeConnectionEvent {
  reconnectDelayMs: number | null;
  reconnected: boolean;
  state: RoomRealtimeConnectionState;
}

export interface RoomRealtimeEventMap {
  "thread:changed": ThreadRealtimeEvent;
  "project:changed": ProjectRealtimeEvent;
  "environment:changed": EnvironmentRealtimeEvent;
  "host:changed": HostRealtimeEvent;
  "system:changed": SystemRealtimeEvent;
  "system:config-changed": SystemRealtimeEvent;
  "realtime:connection": RoomRealtimeConnectionEvent;
}

export type RoomRealtimeCallback<TEventName extends RoomRealtimeEventName> = (
  event: RoomRealtimeEventMap[TEventName],
) => void;

export interface ThreadRealtimeSubscribeArgs {
  callback: RoomRealtimeCallback<"thread:changed">;
  event: "thread:changed";
  threadId?: string;
}

export interface ProjectRealtimeSubscribeArgs {
  callback: RoomRealtimeCallback<"project:changed">;
  event: "project:changed";
  projectId?: string;
}

export interface EnvironmentRealtimeSubscribeArgs {
  callback: RoomRealtimeCallback<"environment:changed">;
  environmentId?: string;
  event: "environment:changed";
}

export interface HostRealtimeSubscribeArgs {
  callback: RoomRealtimeCallback<"host:changed">;
  event: "host:changed";
  hostId?: string;
}

export interface SystemRealtimeSubscribeArgs {
  callback: RoomRealtimeCallback<"system:changed">;
  event: "system:changed";
}

export interface SystemConfigRealtimeSubscribeArgs {
  callback: RoomRealtimeCallback<"system:config-changed">;
  event: "system:config-changed";
}

export interface RealtimeConnectionSubscribeArgs {
  callback: RoomRealtimeCallback<"realtime:connection">;
  event: "realtime:connection";
}

export type RoomRealtimeSubscribeArgsUnion =
  | ThreadRealtimeSubscribeArgs
  | ProjectRealtimeSubscribeArgs
  | EnvironmentRealtimeSubscribeArgs
  | HostRealtimeSubscribeArgs
  | SystemRealtimeSubscribeArgs
  | SystemConfigRealtimeSubscribeArgs
  | RealtimeConnectionSubscribeArgs;

export type RoomRealtimeSubscribeArgs<
  TEventName extends RoomRealtimeEventName = RoomRealtimeEventName,
> = Extract<RoomRealtimeSubscribeArgsUnion, { event: TEventName }>;

export interface RoomRealtime {
  subscribe<TEventName extends RoomRealtimeEventName>(
    args: RoomRealtimeSubscribeArgs<TEventName>,
  ): RoomRealtimeUnsubscribe;
}
