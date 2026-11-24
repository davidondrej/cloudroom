import {
  createServerAccessRecheck,
  registerServerAccess,
} from "./server-access.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerConnectCli } from "./cli.js";
import { createKvCredentialStore } from "./credential.js";
import { connectRpcContract, createRpcHandlers } from "./rpc.js";
import { ShareRegistry } from "./shares.js";
import { ConnectTunnel } from "./tunnel.js";
import { ShareHostResolver } from "./hosts.js";
import { resolveLocalCloudLoopbackUrl } from "./local-loopback.js";
import { PhoneRelay } from "./phone.js";
import { registerMacs, SetupJobs } from "./macs.js";
import {
  CONNECT_REALTIME_CHANNEL,
  REMOTE_ACTIVITY_INSTRUCTIONS_MS,
  type ConnectStatus,
  type TunnelStatus,
} from "./types.js";

const RELAY_CREDENTIAL_KV_KEY = "relay-credential";
const LEGACY_CREDENTIAL_KV_KEY = "credential";

function recentlyRemote(status: TunnelStatus): boolean {
  return (
    status.remoteClients > 0 ||
    (status.lastRemoteActivityAt !== null &&
      Date.now() - status.lastRemoteActivityAt < REMOTE_ACTIVITY_INSTRUCTIONS_MS)
  );
}

export default async function plugin(room: BbPluginApi) {
  const settings = room.settings.define({
    sendRemoteInstructions: {
      type: "boolean",
      label: "Tell agents about remote access",
      description:
        "When you use Cloudroom remotely, tell agents to share servers through Cloudroom Connect. Applies to new agent sessions.",
      default: true,
    },
  });
  let currentSettings = await settings.get();
  settings.onChange((next) => {
    currentSettings = next;
  });
  let relay!: ConnectTunnel;
  let tunnelUp = false;
  let phone!: PhoneRelay;
  const credential = () => relay.getCredential();
  const hostResolver = new ShareHostResolver(() => room.sdk);
  const getLoopbackBaseUrl = () =>
    resolveLocalCloudLoopbackUrl(
      credential()?.serverUrl,
      process.env.BB_DEV_APP_PORT,
    ) ?? room.server.loopbackBaseUrl;

  const status = (base: TunnelStatus = relay.status()): ConnectStatus => ({
    ...base,
    lastError: base.lastError ?? phone?.error ?? null,
    signedIn: phone?.signedIn ?? false,
  });
  const publish = () => room.realtime.publish(CONNECT_REALTIME_CHANNEL, status());

  const shares = new ShareRegistry({
    kv: room.storage.kv,
    hosts: room.hosts,
    hostResolver,
    getLoopbackBaseUrl,
    getCredential: credential,
    log: room.log,
    onChange: publish,
  });

  const recheckServerAccess = createServerAccessRecheck(room);
  relay = new ConnectTunnel({
    store: createKvCredentialStore(room.storage.kv, RELAY_CREDENTIAL_KV_KEY),
    shares,
    getLoopbackBaseUrl,
    getLoopbackHeaders: () => room.server.experimental_loopbackHeaders,
    log: room.log,
    onStatusChange: (relayStatus) => {
      publish();
      recheckServerAccess(relayStatus);
      // Signals sent while the tunnel was down are lost, so the app lists its Cloud threads again (#237).
      const up = relayStatus.state === "connected";
      if (up !== tunnelUp) {
        tunnelUp = up;
        // Before the server listens, its address throws; the app lists at its own start anyway.
        void Promise.resolve().then(() => fetch(`${room.server.loopbackBaseUrl}/api/v1/cloudroom/threads-changed`, {
          method: "POST",
          headers: { ...room.server.experimental_loopbackHeaders, "content-type": "application/json", "x-cloudroom-relay": "threads" },
          body: JSON.stringify({ tunnel: up }),
        })).catch(() => {});
      }
    },
    onCredentialRejected: () => void phone.check(true),
  });
  phone = new PhoneRelay(room, relay, publish);
  void room.storage.kv.delete(LEGACY_CREDENTIAL_KV_KEY).catch(() => {});

  const macs = registerMacs(room, phone);
  await registerServerAccess(room, {
    call: (path, body) => phone.call(path, body),
    status: () => relay.status(),
  });

  room.rpc.register(
    connectRpcContract,
    createRpcHandlers({
      relay,
      phone,
      status,
      hostResolver,
      listMacs: macs.list,
      setupJobs: new SetupJobs(),
      remoteInstructions: async (enabled) =>
        enabled === undefined
          ? currentSettings.sendRemoteInstructions
          : (await settings.experimental_set({ sendRemoteInstructions: enabled }))
              .sendRemoteInstructions,
    }),
  );
  registerConnectCli({ bb: room, relay, phone, status, hostResolver });

  room.agents.contributeInstructions(() => {
    if (!currentSettings.sendRemoteInstructions) return null;
    const viewing = relay.status();
    if (!viewing.paired || viewing.url === null || !recentlyRemote(viewing)) return null;
    return (
      `The user is currently viewing this Cloudroom remotely at ${viewing.url}. ` +
      "Port shares work from a thread on any enrolled host: when you start an HTTP server they should see, run `room-cli connect expose <port>` from that thread. " +
      "The command returns the correct public URL for the thread's host; give it to them as a markdown link because a localhost URL will not work remotely."
    );
  });

  room.background.service("tunnel", {
    async start(signal) {
      await phone.start();
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      phone.stop();
    },
  });
}
