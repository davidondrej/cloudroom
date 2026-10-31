import {
  CALLER_TOKEN_HEADER,
  callerTokenFor,
  renewCallerToken,
} from "@cloudroom/config/caller-proof";
import { WebSocket as NodeWsWebSocket, type RawData } from "ws";
import { createRealtimeSocketAdapter } from "./realtime-client.js";
import type { BbRealtimeSocket, BbRealtimeSocketFactory } from "./transport.js";

const SOCKET_CONNECTING = 0;
const SOCKET_CLOSED = 3;

function decodeWsMessageData(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  return Buffer.from(new Uint8Array(data)).toString("utf8");
}

function callerHeaders(
  token: string | null | undefined,
): Record<string, string> {
  return token ? { [CALLER_TOKEN_HEADER]: token } : {};
}

function bindNodeWsEvents(
  socket: NodeWsWebSocket,
  adapter: BbRealtimeSocket,
): void {
  socket.on("open", () => adapter.onopen?.());
  socket.on("message", (data) =>
    adapter.onmessage?.({ data: decodeWsMessageData(data) }),
  );
  socket.on("close", () => adapter.onclose?.());
  socket.on("error", () => adapter.onerror?.());
}

export function wrapNodeWsWebsocket(
  url: string,
  headers: Record<string, string> = {},
): BbRealtimeSocket {
  const socket = new NodeWsWebSocket(url, { headers });
  const adapter = createRealtimeSocketAdapter(socket);
  bindNodeWsEvents(socket, adapter);
  return adapter;
}

function httpOrigin(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  return parsed.origin;
}

function wrapProvenNodeWsWebsocket(url: string): BbRealtimeSocket {
  let socket: NodeWsWebSocket | null = null;
  let closedEarly = false;
  const adapter: BbRealtimeSocket = {
    close: () => {
      if (socket !== null) {
        socket.close();
        return;
      }
      if (!closedEarly) {
        closedEarly = true;
        adapter.onclose?.();
      }
    },
    onclose: null,
    onerror: null,
    onmessage: null,
    onopen: null,
    get readyState() {
      if (socket !== null) return socket.readyState;
      return closedEarly ? SOCKET_CLOSED : SOCKET_CONNECTING;
    },
    send: (data) => {
      if (socket === null) throw new Error("WebSocket is not open");
      socket.send(data);
    },
  };
  const origin = httpOrigin(url);
  void callerTokenFor(origin).then((token) => {
    if (closedEarly) return;
    socket = new NodeWsWebSocket(url, { headers: callerHeaders(token) });
    socket.on("error", (error) => {
      if (/Unexpected server response: 401/u.test(error.message)) {
        void renewCallerToken(origin, token);
      }
    });
    bindNodeWsEvents(socket, adapter);
  });
  return adapter;
}

export function createNodeWebsocketFactory(
  options: { callerToken?: string } = {},
): BbRealtimeSocketFactory {
  return (url) =>
    options.callerToken === undefined
      ? wrapProvenNodeWsWebsocket(url)
      : wrapNodeWsWebsocket(url, callerHeaders(options.callerToken));
}
