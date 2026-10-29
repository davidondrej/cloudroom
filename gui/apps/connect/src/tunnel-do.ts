import {
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  TUNNEL_PROTOCOL_QUERY_PARAM,
  decodeFrame,
  encodeFrame,
  type Frame,
  type HeaderPair,
} from "@cloudroom/tunnel-contract";
import { relayedResponse } from "./response-encoding.js";
import { TUNNEL_MACHINE_HEADER, TUNNEL_SESSION_HEADER, TUNNEL_TARGET_HEADER, TUNNEL_VPS_HEADER } from "./protocol-headers.js";
import { machineOwner, markServerSeen, sessionByToken } from "./store.js";

export interface Env {
  TUNNEL_DO: DurableObjectNamespace;
  DB: D1Database;
  BASE_DOMAIN: string;
  WEBSITE_URL: string;
  ASSETS?: Fetcher;
}

const TUNNEL_TAG = "tunnel";
const RESP_HEAD_TIMEOUT_MS = 30_000;
/** The Mac pings every 10s. A sleeping Mac's socket can still look open for minutes, so a silent one is gone. */
const HEARTBEAT_STALE_MS = 30_000;

const WS_READY_STATE_OPEN = 1;

/** Saved on the Mac's tunnel socket, never in Durable Object storage: a storage hiccup resets the object and drops the Mac. */
type TunnelInfo = { connectedAt?: number; mac?: string; serverId?: string; protocolVersion?: number };

function tunnelInfo(ws: WebSocket): TunnelInfo {
  return (ws.deserializeAttachment() as TunnelInfo | null) ?? {};
}

export const TUNNEL_OFFLINE_HEADER = "x-bb-tunnel-offline";

const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "expect",
  "host",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  TUNNEL_TARGET_HEADER,
  TUNNEL_SESSION_HEADER,
  TUNNEL_MACHINE_HEADER,
]);

function forwardableHeaders(headers: Headers): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  headers.forEach((value, name) => {
    if (!HOP_HEADERS.has(name.toLowerCase())) pairs.push([name, value]);
  });
  return pairs;
}

function readTunnelTarget(headers: Headers): string | undefined {
  const value = headers.get(TUNNEL_TARGET_HEADER);
  return value !== null && value !== "" ? value : undefined;
}

export function parseClientProtocolVersion(raw: string | null): number {
  if (raw === null || raw === "") return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

const PORT_SHARE_TOO_OLD =
  "this Mac's Cloudroom is too old for port sharing — update Cloudroom";

interface PendingHttp {
  resolve: (response: Response) => void;
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
  writeChain: Promise<void>;
  timeout: ReturnType<typeof setTimeout>;
}

export class TunnelDO {
  private readonly pendingHttp = new Map<number, PendingHttp>();
  private nextStreamId: number;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    let maxSeen = 0;
    for (const ws of this.state.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as {
        streamId?: number;
      } | null;
      if (attachment?.streamId && attachment.streamId > maxSeen)
        maxSeen = attachment.streamId;
    }
    this.nextStreamId = maxSeen + 1;
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(HEARTBEAT_REQUEST, HEARTBEAT_RESPONSE),
    );
  }

  fetch(request: Request): Response | Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__tunnel") {
      return this.acceptTunnel(
        request,
        url.searchParams.get("serverId"),
        parseClientProtocolVersion(
          url.searchParams.get(TUNNEL_PROTOCOL_QUERY_PARAM),
        ),
      );
    }
    if (url.pathname === "/__control/close") {
      for (const ws of this.state.getWebSockets(TUNNEL_TAG))
        ws.close(1000, "revoked by owner");
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__control/status") {
      return Response.json({ online: this.tunnelSocket() !== null });
    }
    if (
      request.method === "POST" &&
      url.pathname === "/__control/revoke-visitors"
    ) {
      this.abandonStreams("phone access revoked", "phone access revoked");
      return new Response(null, { status: 204 });
    }

    const tunnel = this.tunnelSocket();
    if (!tunnel) {
      return this.offlineResponse();
    }

    const target = readTunnelTarget(request.headers);
    if (target !== undefined && (tunnelInfo(tunnel).protocolVersion ?? 0) < 1) {
      return new Response(`cloudroom: ${PORT_SHARE_TOO_OLD}\n`, {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.state.blockConcurrencyWhile(async () => {
        // Only the Worker sets this, for a VPS's ports: its Cores check their own tokens (ADR 0319).
        if (request.headers.get(TUNNEL_VPS_HEADER) === "1" && target !== undefined) {
          return this.openVisitorWebSocket(request, url, tunnel, target);
        }
        const machineId = request.headers.get(TUNNEL_MACHINE_HEADER);
        const token = request.headers.get(TUNNEL_SESSION_HEADER);
        if (!machineId && (!token || !/^[a-f0-9]{64}$/.test(token))) {
          return new Response("Sign in required\n", { status: 401 });
        }
        try {
          const { serverId } = tunnelInfo(tunnel);
          if (machineId) {
            if (target !== undefined || (await machineOwner(this.env.DB, machineId)) !== serverId) {
              return new Response("Machine not authorized\n", { status: 403 });
            }
            return this.openVisitorWebSocket(request, url, tunnel, target);
          }
          const session = await sessionByToken(this.env.DB, token!);
          if (
            !session ||
            session.serverId !== serverId ||
            session.target !== (target ?? null)
          ) {
            return new Response("Sign in required\n", { status: 401 });
          }
        } catch {
          return new Response("Could not verify phone sign-in\n", { status: 503 });
        }
        return this.openVisitorWebSocket(request, url, tunnel, target);
      });
    }
    return this.proxyHttp(request, url, tunnel, target);
  }

  private tunnelSocket(): WebSocket | null {
    const sockets = this.state.getWebSockets(TUNNEL_TAG);
    for (let i = sockets.length - 1; i >= 0; i--) {
      const ws = sockets[i];
      if (ws.readyState !== WS_READY_STATE_OPEN) continue;
      const { connectedAt = 0, mac } = tunnelInfo(ws);
      const lastPing = this.state.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      const silentMs = Date.now() - Math.max(connectedAt, lastPing);
      if (silentMs <= HEARTBEAT_STALE_MS) return ws;
      console.log({ event: "tunnel_silent_dropped", mac, silentSeconds: Math.round(silentMs / 1000) });
      try {
        ws.close(1011, "heartbeat timed out");
      } catch {}
    }
    return null;
  }

  private trySend(
    tunnel: WebSocket,
    data: ArrayBuffer | ArrayBufferView | string,
  ): boolean {
    try {
      tunnel.send(data);
      return true;
    } catch {
      return false;
    }
  }

  private offlineResponse(): Response {
    return new Response(
      "cloudroom: this Mac is offline\n",
      {
        status: 503,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          [TUNNEL_OFFLINE_HEADER]: "1",
        },
      },
    );
  }

  /** "Last online" for the offline page, written when the Mac connects and when it drops. */
  private async markPresence(serverId: string | undefined): Promise<void> {
    if (!serverId) return;
    try {
      await markServerSeen(this.env.DB, serverId);
    } catch {}
  }

  /** Older relays set a 50 s presence alarm. One may still fire once after a deploy; let it end without rescheduling. */
  async alarm(): Promise<void> {}

  private acceptTunnel(
    request: Request,
    serverId: string | null,
    protocolVersion: number,
  ): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    for (const existing of this.state.getWebSockets(TUNNEL_TAG)) {
      try {
        existing.close(1000, "replaced by a new tunnel connection");
      } catch {}
    }
    this.abandonStreams("tunnel reconnected mid-request", "tunnel reconnected");
    void this.markPresence(serverId ?? undefined);
    const mac = new URL(request.url).hostname.split(".")[0];
    console.log({ event: "tunnel_connected", mac });
    const pair = new WebSocketPair();
    pair[1].serializeAttachment({
      connectedAt: Date.now(),
      mac,
      ...(serverId ? { serverId } : {}),
      protocolVersion,
    } satisfies TunnelInfo);
    this.state.acceptWebSocket(pair[1], [TUNNEL_TAG]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private openVisitorWebSocket(
    request: Request,
    url: URL,
    tunnel: WebSocket,
    target: string | undefined,
  ): Response {
    const streamId = this.nextStreamId++;
    const protocols =
      request.headers
        .get("sec-websocket-protocol")
        ?.split(",")
        .map((p) => p.trim())
        .filter(Boolean) ?? [];

    const opened = this.trySend(
      tunnel,
      encodeFrame({
        type: "open-ws",
        streamId,
        path: url.pathname + url.search,
        headers: forwardableHeaders(request.headers),
        protocols,
        ...(target !== undefined ? { target } : {}),
      }),
    );
    if (!opened) return this.offlineResponse();

    const pair = new WebSocketPair();
    pair[1].serializeAttachment({ streamId });
    this.state.acceptWebSocket(pair[1], [`visitor:${streamId}`]);

    const responseHeaders = new Headers();
    if (protocols.length > 0) {
      responseHeaders.set("sec-websocket-protocol", protocols[0]);
    }
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: responseHeaders,
    });
  }

  private async proxyHttp(
    request: Request,
    url: URL,
    tunnel: WebSocket,
    target: string | undefined,
  ): Promise<Response> {
    const streamId = this.nextStreamId++;
    const hasBody = request.body !== null;

    const responsePromise = new Promise<Response>((resolve) => {
      const timeout = setTimeout(() => {
        this.failHttpStream(
          streamId,
          504,
          "timed out waiting for the tunnel client",
        );
      }, RESP_HEAD_TIMEOUT_MS);
      this.pendingHttp.set(streamId, {
        resolve,
        writer: null,
        writeChain: Promise.resolve(),
        timeout,
      });
    });

    const opened = this.trySend(
      tunnel,
      encodeFrame({
        type: "open-http",
        streamId,
        method: request.method,
        path: url.pathname + url.search,
        headers: forwardableHeaders(request.headers),
        hasBody,
        ...(target !== undefined ? { target } : {}),
      }),
    );
    if (!opened) {
      const entry = this.pendingHttp.get(streamId);
      if (entry) {
        this.pendingHttp.delete(streamId);
        clearTimeout(entry.timeout);
      }
      return this.offlineResponse();
    }

    if (hasBody) {
      void this.pumpRequestBody(streamId, request.body!, tunnel);
    }
    return responsePromise;
  }

  private async pumpRequestBody(
    streamId: number,
    body: ReadableStream<Uint8Array>,
    tunnel: WebSocket,
  ): Promise<void> {
    try {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let offset = 0; offset < value.length; offset += 1024 * 1024) {
          const sent = this.trySend(
            tunnel,
            encodeFrame({
              type: "body-chunk",
              streamId,
              data: value.subarray(offset, offset + 1024 * 1024),
            }),
          );
          if (!sent) return;
        }
      }
      this.trySend(tunnel, encodeFrame({ type: "body-end", streamId }));
    } catch {
      this.trySend(
        tunnel,
        encodeFrame({
          type: "close-stream",
          streamId,
          code: 1011,
          reason: "request body error",
        }),
      );
    }
  }

  private abandonStreams(httpReason: string, wsReason: string): void {
    const tunnel = this.tunnelSocket();
    for (const streamId of [...this.pendingHttp.keys()]) {
      if (tunnel) {
        this.trySend(tunnel, encodeFrame({
          type: "close-stream", streamId, code: 1000, reason: httpReason,
        }));
      }
      this.failHttpStream(streamId, 502, httpReason);
    }
    for (const visitor of this.state.getWebSockets()) {
      if (!this.state.getTags(visitor).includes(TUNNEL_TAG)) {
        if (tunnel) {
          const { streamId } = visitor.deserializeAttachment() as { streamId: number };
          this.trySend(tunnel, encodeFrame({
            type: "close-stream", streamId, code: 1000, reason: wsReason,
          }));
        }
        try {
          visitor.close(1001, wsReason);
        } catch {}
      }
    }
  }

  private failHttpStream(
    streamId: number,
    status: number,
    message: string,
  ): void {
    const entry = this.pendingHttp.get(streamId);
    if (!entry) return;
    this.pendingHttp.delete(streamId);
    clearTimeout(entry.timeout);
    if (entry.writer) {
      void entry.writeChain
        .then(() => entry.writer?.abort(message))
        .catch(() => {});
    } else {
      entry.resolve(
        new Response(`cloudroom: ${message}\n`, {
          status,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      );
    }
  }

  private cancelHttpStream(streamId: number, message: string): void {
    const entry = this.pendingHttp.get(streamId);
    if (!entry) return;
    this.pendingHttp.delete(streamId);
    clearTimeout(entry.timeout);
    const tunnel = this.tunnelSocket();
    if (!tunnel) return;
    this.trySend(
      tunnel,
      encodeFrame({
        type: "close-stream",
        streamId,
        code: 1000,
        reason: message,
      }),
    );
  }

  webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): void {
    if (ws.readyState !== WS_READY_STATE_OPEN) return;
    const tags = this.state.getTags(ws);
    if (tags.includes(TUNNEL_TAG)) {
      if (typeof message === "string") return;
      this.onTunnelFrame(decodeFrame(message));
      return;
    }
    const attachment = ws.deserializeAttachment() as { streamId: number };
    const tunnel = this.tunnelSocket();
    if (!tunnel) {
      ws.close(1011, "tunnel disconnected");
      return;
    }
    const isBinary = typeof message !== "string";
    const sent = this.trySend(
      tunnel,
      encodeFrame({
        type: "ws-data",
        streamId: attachment.streamId,
        isBinary,
        data: isBinary
          ? new Uint8Array(message)
          : new TextEncoder().encode(message),
      }),
    );
    if (!sent) ws.close(1011, "tunnel disconnected");
  }

  private onTunnelFrame(frame: Frame): void {
    switch (frame.type) {
      case "resp-head": {
        const entry = this.pendingHttp.get(frame.streamId);
        if (!entry) return;
        clearTimeout(entry.timeout);
        const headers = frame.headers.filter(
          ([name]) => !HOP_HEADERS.has(name.toLowerCase()),
        );
        if (
          frame.status === 204 ||
          frame.status === 205 ||
          frame.status === 304
        ) {
          entry.resolve(new Response(null, { status: frame.status, headers }));
          return;
        }
        const { readable, writable } = new TransformStream<
          Uint8Array,
          Uint8Array
        >();
        let response: Response;
        try {
          response = relayedResponse(readable, frame.status, headers);
        } catch {
          this.pendingHttp.delete(frame.streamId);
          entry.resolve(
            new Response(
              `cloudroom: unrelayable origin response (status ${frame.status})\n`,
              {
                status: 502,
                headers: { "content-type": "text/plain; charset=utf-8" },
              },
            ),
          );
          return;
        }
        entry.writer = writable.getWriter();
        void entry.writer.closed.catch(() => {
          this.cancelHttpStream(
            frame.streamId,
            "visitor canceled response body",
          );
        });
        entry.resolve(response);
        return;
      }
      case "body-chunk": {
        const entry = this.pendingHttp.get(frame.streamId);
        if (!entry?.writer) return;
        const copy = frame.data.slice();
        entry.writeChain = entry.writeChain
          .then(() => entry.writer!.write(copy))
          .catch(() => {});
        return;
      }
      case "body-end": {
        const entry = this.pendingHttp.get(frame.streamId);
        if (!entry) return;
        this.pendingHttp.delete(frame.streamId);
        entry.writeChain = entry.writeChain
          .then(() => entry.writer?.close())
          .catch(() => {});
        return;
      }
      case "close-stream": {
        if (this.pendingHttp.has(frame.streamId)) {
          this.failHttpStream(
            frame.streamId,
            502,
            `tunnel client aborted: ${frame.reason}`,
          );
        } else {
          try {
            this.visitorSocket(frame.streamId)?.close(
              safeCloseCode(frame.code),
              frame.reason,
            );
          } catch {}
        }
        return;
      }
      case "ws-data": {
        const visitor = this.visitorSocket(frame.streamId);
        if (!visitor) return;
        try {
          visitor.send(
            frame.isBinary ? frame.data : new TextDecoder().decode(frame.data),
          );
        } catch {}
        return;
      }
      case "ws-open-ack":
        return;
      case "open-http":
      case "open-ws":
        return;
    }
  }

  private visitorSocket(streamId: number): WebSocket | null {
    return this.state.getWebSockets(`visitor:${streamId}`)[0] ?? null;
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    const tags = this.state.getTags(ws);
    if (tags.includes(TUNNEL_TAG)) {
      const { connectedAt, mac, serverId } = tunnelInfo(ws);
      const connectedSeconds = connectedAt ? Math.round((Date.now() - connectedAt) / 1000) : null;
      console.log({ event: "tunnel_closed", mac, code, reason, connectedSeconds });
      if (this.tunnelSocket() !== null) return;
      void this.markPresence(serverId);
      this.abandonStreams(
        "tunnel disconnected mid-request",
        "tunnel disconnected",
      );
      return;
    }
    const attachment = ws.deserializeAttachment() as { streamId: number };
    const tunnel = this.tunnelSocket();
    if (tunnel) {
      this.trySend(
        tunnel,
        encodeFrame({
          type: "close-stream",
          streamId: attachment.streamId,
          code: safeCloseCode(code),
          reason,
        }),
      );
    }
    try {
      ws.close(safeCloseCode(code), reason);
    } catch {}
  }

  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws, 1011, "socket error");
  }
}

function safeCloseCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
}
