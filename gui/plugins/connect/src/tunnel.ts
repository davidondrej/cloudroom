import { WebSocket as NodeWebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  TUNNEL_PROTOCOL_QUERY_PARAM,
} from "@cloudroom/tunnel-contract";
import {
  humanizeTransportError,
  ReconnectBackoff,
  TunnelSession,
  type StreamOriginResult,
} from "@cloudroom/tunnel-client";
import type { PluginLogger } from "@get-bb/plugin-sdk";
import {
  deriveConnectBaseUrl,
  type ConnectCredential,
} from "@cloudroom/connect-client";
import type { CredentialStore } from "./credential.js";
import {
  ShareRegistry,
  shareLoopbackHost,
  shareLoopbackOrigin,
  sharePublicUrl,
  type ShareRemoval,
} from "./shares.js";
import type { ShareHost } from "./hosts.js";
import type { ConnectStateName, ShareListing, TunnelStatus } from "./types.js";

const TUNNEL_HANDSHAKE_TIMEOUT_MS = 15_000;

interface ConnectTunnelOptions {
  store: CredentialStore;
  shares: ShareRegistry;
  getLoopbackBaseUrl: () => string;
  getLoopbackHeaders: () => Readonly<Record<string, string>>;
  log: PluginLogger;
  onStatusChange?: (status: TunnelStatus) => void;
  onCredentialRejected: () => void;
}

export class ConnectTunnel {
  private credential: ConnectCredential | null = null;
  private tunnel: NodeWebSocket | undefined;
  private session: TunnelSession | undefined;
  private connected = false;
  private lastError: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly backoff = new ReconnectBackoff();
  private stopped = false;
  private lastState: ConnectStateName = "disconnected";
  private stateSince = Date.now();
  private lastRemoteActivityAt: number | null = null;
  private remoteClients = 0;
  private nextRetryAt: number | null = null;
  private shareRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private shareActivationEpoch = 0;

  constructor(private readonly options: ConnectTunnelOptions) {}

  getCredential(): ConnectCredential | null {
    return this.credential;
  }

  async start(): Promise<void> {
    const stored = await this.options.store.read();
    if (stored) {
      this.credential = stored;
      this.stopped = false;
      this.openTunnel();
    }
    this.startShareActivation();
    this.publish();
  }

  async useCredential(credential: ConnectCredential): Promise<void> {
    await this.options.store.write(credential);
    this.credential = credential;
    this.lastError = null;
    this.reconnect();
    this.startShareActivation();
    this.publish();
  }

  async forget(): Promise<void> {
    this.teardown();
    await this.options.store.clear();
    this.options.shares.clearMachineDeclarations();
    this.credential = null;
    this.lastError = null;
    this.publish();
  }

  async expose(port: number, host: ShareHost): Promise<ShareListing> {
    const listing = await this.options.shares.add(port, host);
    this.publish();
    return listing;
  }

  async unexpose(
    port: number,
    hostSelector: string,
  ): Promise<ShareRemoval & { port: number }> {
    const result = await this.options.shares.remove(port, hostSelector);
    this.publish();
    return { ...result, port };
  }

  async listShares(hostId?: string): Promise<ShareListing[]> {
    return this.options.shares.list(hostId);
  }

  status(): TunnelStatus {
    return this.statusWithShares(this.options.shares.snapshot());
  }

  async refreshStatus(): Promise<TunnelStatus> {
    return this.statusWithShares(await this.listShares());
  }

  private statusWithShares(shares: TunnelStatus["shares"]): TunnelStatus {
    const state = this.computeState();
    return {
      state,
      paired: this.credential !== null,
      handle: this.credential?.handle ?? null,
      url: this.credential?.serverUrl ?? null,
      lastError: this.lastError,
      nextRetryAt: state === "reconnecting" ? this.nextRetryAt : null,
      since: this.stateSince,
      remoteClients: this.remoteClients,
      lastRemoteActivityAt: this.lastRemoteActivityAt,
      shares,
    };
  }

  stop(): void {
    this.teardown();
    this.publish();
  }

  private computeState(): ConnectStateName {
    if (this.credential === null) return "disconnected";
    return this.connected ? "connected" : "reconnecting";
  }

  private publish(): void {
    const state = this.computeState();
    if (state !== this.lastState) {
      this.lastState = state;
      this.stateSince = Date.now();
    }
    this.options.onStatusChange?.(this.status());
  }

  private teardown(): void {
    this.shareActivationEpoch += 1;
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.shareRetryTimer) {
      clearTimeout(this.shareRetryTimer);
      this.shareRetryTimer = undefined;
    }
    this.session?.dispose();
    this.session = undefined;
    this.remoteClients = 0;
    this.tunnel?.terminate();
    this.tunnel = undefined;
    this.connected = false;
    this.backoff.reset();
    this.nextRetryAt = null;
  }

  private reconnect(): void {
    this.teardown();
    this.stopped = false;
    this.openTunnel();
  }

  private startShareActivation(): void {
    const epoch = ++this.shareActivationEpoch;
    void this.activateShares(epoch);
  }

  private isShareActivationCurrent(epoch: number): boolean {
    return !this.stopped && epoch === this.shareActivationEpoch;
  }

  private async activateShares(epoch: number): Promise<void> {
    try {
      await this.options.shares.load();
      if (!this.isShareActivationCurrent(epoch)) return;
      await this.options.shares.declareMachineShares(() =>
        this.isShareActivationCurrent(epoch),
      );
      if (!this.isShareActivationCurrent(epoch)) return;
      if (this.credential !== null) {
        await this.options.shares.list();
        if (!this.isShareActivationCurrent(epoch)) return;
      }
      this.publish();
    } catch (error) {
      this.options.log.warn(
        `shared-port activation failed; retrying: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (
        this.credential !== null &&
        this.isShareActivationCurrent(epoch) &&
        this.shareRetryTimer === undefined
      ) {
        this.shareRetryTimer = setTimeout(() => {
          this.shareRetryTimer = undefined;
          this.startShareActivation();
        }, 5_000);
      }
    }
  }

  private credentialRejected(statusCode: number): void {
    this.lastError = `Cloudroom Connect rejected this Mac's credential (HTTP ${statusCode}); registering again`;
    this.options.log.warn(this.lastError);
    this.credential = null;
    this.teardown();
    this.publish();
    void this.options.store
      .clear()
      .catch((error: unknown) => {
        this.options.log.warn(
          `failed to clear the rejected credential: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .then(() => this.options.onCredentialRejected());
  }

  private resolveStreamOrigin(target: string | undefined): StreamOriginResult {
    if (target === undefined) {
      return {
        kind: "ok",
        resolved: {
          origin: this.options.getLoopbackBaseUrl().replace(/\/$/, ""),
          publicOrigin: this.credential
            ? new URL(this.credential.serverUrl).origin
            : this.options.getLoopbackBaseUrl(),
          headers: this.options.getLoopbackHeaders(),
        },
      };
    }
    const port = Number(target);
    if (!Number.isInteger(port) || !this.options.shares.hasServerPort(port)) {
      return { kind: "unregistered" };
    }
    const credential = this.credential;
    if (credential === null) {
      return { kind: "unregistered" };
    }
    return {
      kind: "ok",
      resolved: {
        origin: shareLoopbackOrigin(port),
        publicOrigin: new URL(sharePublicUrl(credential, port)).origin,
        host: shareLoopbackHost(port),
      },
    };
  }

  private openTunnel(): void {
    const credential = this.credential;
    if (!credential || this.stopped) return;

    const tunnelUrl = tunnelUrlForServer(credential.serverUrl);
    this.options.log.info(
      `tunnel connecting to ${tunnelUrl} (origin ${this.options.getLoopbackBaseUrl()})`,
    );
    let tunnel: NodeWebSocket;
    try {
      tunnel = new NodeWebSocket(tunnelUrl, {
        headers: { authorization: `Bearer ${credential.credential}` },
        handshakeTimeout: TUNNEL_HANDSHAKE_TIMEOUT_MS,
      });
    } catch (error) {
      this.lastError = `cannot dial ${tunnelUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.options.log.warn(this.lastError);
      this.publish();
      return;
    }
    this.tunnel = tunnel;
    let connectedAt = 0;
    let retryScheduled = false;
    let handshakeDeadline: ReturnType<typeof setTimeout> | undefined;

    const scheduleReconnect = (detail: string): void => {
      if (retryScheduled || this.stopped || this.tunnel !== tunnel) {
        return;
      }
      retryScheduled = true;
      clearTimeout(handshakeDeadline);
      this.connected = false;
      this.session?.dispose();
      this.session = undefined;
      this.remoteClients = 0;
      const stable = connectedAt ? Date.now() - connectedAt : 0;
      const delay = this.backoff.nextDelayAfterClose(stable);
      if (this.lastError === null) {
        this.lastError = `can't reach ${connectApexHost(credential.serverUrl)} — connection closed`;
      }
      this.nextRetryAt = Date.now() + delay;
      this.options.log.warn(`${detail}; reconnecting in ${delay}ms`);
      this.reconnectTimer = setTimeout(() => {
        if (this.stopped || this.tunnel !== tunnel) return;
        this.reconnectTimer = undefined;
        this.nextRetryAt = null;
        this.publish();
        this.openTunnel();
      }, delay);
      this.publish();
    };

    handshakeDeadline = setTimeout(() => {
      if (retryScheduled || this.stopped || this.tunnel !== tunnel) return;
      this.lastError = `can't reach ${connectApexHost(credential.serverUrl)} — handshake timed out`;
      scheduleReconnect(this.lastError);
      tunnel.terminate();
    }, TUNNEL_HANDSHAKE_TIMEOUT_MS);
    handshakeDeadline.unref?.();

    tunnel.on("open", () => {
      if (retryScheduled || this.stopped || this.tunnel !== tunnel) {
        return;
      }
      clearTimeout(handshakeDeadline);
      connectedAt = Date.now();
      this.connected = true;
      this.lastError = null;
      this.nextRetryAt = null;
      this.options.log.info("tunnel connected");
      this.session = new TunnelSession({
        tunnel,
        log: this.options.log,
        resolveOrigin: (target) => this.resolveStreamOrigin(target),
        onRemoteClientsChange: (count) => {
          this.remoteClients = count;
          this.publish();
        },
        onActivity: (at) => {
          this.lastRemoteActivityAt = at;
        },
        onHeartbeatMissed: () => {
          this.lastError = `can't reach ${connectApexHost(credential.serverUrl)} — heartbeat missed`;
          scheduleReconnect(this.lastError);
        },
      });
      this.session.start();
      this.publish();
    });
    tunnel.on("unexpected-response", (_req, res) => {
      if (this.stopped || this.tunnel !== tunnel) return;
      res.resume();
      const statusCode = res.statusCode ?? 0;
      if (statusCode === 401 || statusCode === 403) {
        this.credentialRejected(statusCode);
        return;
      }
      this.lastError = `tunnel rejected: HTTP ${statusCode}`;
      scheduleReconnect(this.lastError);
      tunnel.terminate();
    });
    tunnel.on("error", (e: Error) => {
      if (retryScheduled || this.stopped || this.tunnel !== tunnel) {
        return;
      }
      this.lastError = humanizeTransportError(
        e,
        connectApexHost(credential.serverUrl),
      );
    });
    tunnel.on("close", (code: number, reason: Buffer) => {
      scheduleReconnect(
        `tunnel closed (code ${code}${reason.length > 0 ? `, ${reason.toString()}` : ""})`,
      );
    });
  }
}

function connectApexHost(serverUrl: string): string {
  try {
    return new URL(deriveConnectBaseUrl(serverUrl)).host;
  } catch {
    return "cloudroom.run";
  }
}

function tunnelUrlForServer(serverUrl: string): string {
  const base =
    serverUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/__tunnel";
  const url = new URL(base);
  url.searchParams.set(TUNNEL_PROTOCOL_QUERY_PARAM, String(PROTOCOL_VERSION));
  return url.toString();
}
