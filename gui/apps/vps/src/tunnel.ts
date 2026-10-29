// Connects this VPS out to the Cloudroom relay, so the website and apps reach its sandboxes at
// https://<handle>--<port>.cloudroom.run with no open port, domain, or certificate here (ADR 0319).
import { WebSocket } from "ws";
import { PROTOCOL_VERSION, TUNNEL_PROTOCOL_QUERY_PARAM } from "@cloudroom/tunnel-contract";
import { ReconnectBackoff, TunnelSession } from "@cloudroom/tunnel-client";
import type { Config } from "./main.js";

type Relay = { handle: string; credential: string; baseDomain: string };

/** Keeps the tunnel open. `allowed` says which loopback ports the relay may reach: the API and the sandboxes' Cores. */
export function startTunnel(config: Config, save: (patch: Partial<Config>) => Promise<void>, allowed: (port: number) => boolean): void {
  const backoff = new ReconnectBackoff({ maxDelayMs: 30_000 });
  const again = (connectedForMs: number) => setTimeout(() => void connect(), backoff.nextDelayAfterClose(connectedForMs)).unref();

  async function relay(): Promise<Relay | null> {
    if (config.handle && config.credential && config.baseDomain) return { handle: config.handle, credential: config.credential, baseDomain: config.baseDomain };
    const response = await fetch(new URL("/api/vps/register", config.relay), {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: config.name }),
    });
    if (response.status === 401) {
      console.error(JSON.stringify({ tunnel: "This VPS was disconnected from Cloudroom. Run the install command again to connect it." }));
      return null;
    }
    if (!response.ok) throw new Error(`Relay registration failed: HTTP ${response.status}`);
    const body = (await response.json()) as Relay;
    await save(body);
    return body;
  }

  async function connect(): Promise<void> {
    let target: Relay | null;
    try { target = await relay(); }
    catch (error) {
      console.error(JSON.stringify({ tunnel: String(error) }));
      again(0);
      return;
    }
    if (!target) return;
    const { handle, credential, baseDomain } = target;
    const url = new URL(`wss://${handle}.${baseDomain}/__tunnel`);
    url.searchParams.set(TUNNEL_PROTOCOL_QUERY_PARAM, String(PROTOCOL_VERSION));
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${credential}` } });
    let openedAt = 0;
    let session: TunnelSession | undefined;
    socket.on("open", () => {
      openedAt = Date.now();
      console.log(JSON.stringify({ tunnel: "connected", handle }));
      session = new TunnelSession({
        tunnel: socket,
        log: { warn: (message) => console.error(JSON.stringify({ tunnel: message })) },
        resolveOrigin: (port) => {
          const number = Number(port);
          if (port === undefined || !Number.isInteger(number) || !allowed(number)) return { kind: "unregistered" };
          return { kind: "ok", resolved: { origin: `http://127.0.0.1:${number}`, publicOrigin: `https://${handle}--${number}.${baseDomain}`, host: `127.0.0.1:${number}` } };
        },
        onHeartbeatMissed: () => socket.terminate(),
      });
      session.start();
    });
    socket.on("unexpected-response", (_request, response) => {
      // A rejected relay credential (say, the relay row was revoked): register again with the VPS token.
      // `save` updates the config at once, so the reconnect below already registers again.
      if (response.statusCode === 401 || response.statusCode === 403) void save({ handle: undefined, credential: undefined, baseDomain: undefined });
      response.resume();
      socket.terminate();
    });
    socket.on("error", (error) => console.error(JSON.stringify({ tunnel: error.message })));
    socket.on("close", () => {
      session?.dispose();
      again(openedAt ? Date.now() - openedAt : 0);
    });
  }

  void connect();
}
