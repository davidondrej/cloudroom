// Hono WebSockets on Node's HTTP server through `ws`. Ported from @hono/node-ws
// 1.3.0 (MIT, see gui/NOTICE) with the same API and order of events.
// An upgrade request runs through the whole Hono app first, so its guards
// (origin checks, daemon and plugin auth) decide it. Only a request whose route
// reached upgradeWebSocket gets a socket; any other answer closes it.
import { STATUS_CODES, type IncomingMessage, type Server } from "node:http";
import type { Http2SecureServer, Http2Server } from "node:http2";
import type { Duplex } from "node:stream";
import type { Hono } from "hono";
import {
  defineWebSocketHelper,
  WSContext,
  type UpgradeWebSocket,
  type WSReadyState,
} from "hono/ws";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

interface Waiter {
  connection: symbol;
  resolve: (socket: WebSocket) => void;
}

// The route stores its connection symbol on the request env under this key.
const CONNECTION = Symbol("CONNECTION_SYMBOL_KEY");

function closeEvent(code: number, reason: string): CloseEvent {
  return typeof CloseEvent === "function"
    ? new CloseEvent("close", { code, reason })
    : Object.assign(new Event("close"), { code, reason, wasClean: false });
}

function binary(data: Buffer | ArrayBuffer): ArrayBufferLike {
  return data instanceof ArrayBuffer
    ? data
    : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

function refuse(socket: Duplex, status: number): void {
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

export function createNodeWebSocket(init: { app: Hono }): {
  wss: WebSocketServer;
  injectWebSocket: (server: Server | Http2Server | Http2SecureServer) => void;
  upgradeWebSocket: UpgradeWebSocket<
    WebSocket,
    { onError: (error: unknown) => void }
  >;
} {
  const wss = new WebSocketServer({ noServer: true });
  const waiters = new Map<IncomingMessage, Waiter>();

  const upgrade = async (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const headers = new Headers();
    for (const key in request.headers) {
      const value = request.headers[key];
      if (!value) continue;
      headers.append(key, Array.isArray(value) ? value[0] : value);
    }
    const env: {
      incoming: IncomingMessage;
      outgoing: undefined;
      [CONNECTION]?: symbol;
    } = { incoming: request, outgoing: undefined };
    const response = await init.app.request(url, { headers }, env);
    const waiter = waiters.get(request);
    if (!waiter || waiter.connection !== env[CONNECTION]) {
      refuse(socket, response.status);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
      waiter.resolve(ws);
    });
  };

  return {
    wss,
    injectWebSocket(server) {
      server.on(
        "upgrade",
        (request: IncomingMessage, socket: Duplex, head: Buffer) => {
          // @hono/node-ws let a bad target such as "//" crash the server, and
          // kept the waiter of every handshake ws refused. Neither happens here.
          void upgrade(request, socket, head)
            .catch(() => refuse(socket, 400))
            .finally(() => waiters.delete(request));
        },
      );
    },
    upgradeWebSocket: defineWebSocketHelper<
      WebSocket,
      { onError: (error: unknown) => void }
    >((c, events, options) => {
      if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return;
      const connection = Symbol("connection");
      c.env[CONNECTION] = connection;
      // Set synchronously, so the waiter exists once the app answers.
      const opened = new Promise<WebSocket>((resolve) => {
        waiters.set(c.env.incoming, { connection, resolve });
      });
      void opened.then((ws) => {
        const run = (fire: () => void) => {
          try {
            fire();
          } catch (error) {
            (options?.onError ?? console.error)(error);
          }
        };
        const early: [RawData, boolean][] = [];
        const buffer = (data: RawData, isBinary: boolean) => {
          early.push([data, isBinary]);
        };
        ws.on("message", buffer);
        const socket = new WSContext<WebSocket>({
          close: (code, reason) => ws.close(code, reason),
          protocol: ws.protocol,
          raw: ws,
          get readyState(): WSReadyState {
            return ws.readyState;
          },
          send: (source, sendOptions) =>
            ws.send(source, { compress: sendOptions.compress }),
          url: new URL(c.req.url),
        });
        run(() => events.onOpen?.(new Event("open"), socket));
        const message = (data: RawData, isBinary: boolean) => {
          for (const part of Array.isArray(data) ? data : [data]) {
            run(() =>
              events.onMessage?.(
                new MessageEvent("message", {
                  data: isBinary ? binary(part) : part.toString(),
                }),
                socket,
              ),
            );
          }
        };
        ws.off("message", buffer);
        for (const [data, isBinary] of early) message(data, isBinary);
        ws.on("message", message);
        ws.on("close", (code, reason) => {
          run(() =>
            events.onClose?.(closeEvent(code, reason.toString()), socket),
          );
        });
        // Node has no ErrorEvent; @hono/node-ws threw here, so handlers never ran.
        ws.on("error", (error) => {
          run(() =>
            events.onError?.(
              Object.assign(new Event("error"), { error }),
              socket,
            ),
          );
        });
      });
      return new Response();
    }),
  };
}
