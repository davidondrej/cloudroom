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

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
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
  let phone!: PhoneRelay;
  const credential = () => relay.getCredential();
  const hostResolver = new ShareHostResolver(() => bb.sdk);
  const getLoopbackBaseUrl = () =>
    resolveLocalCloudLoopbackUrl(
      credential()?.serverUrl,
      process.env.BB_DEV_APP_PORT,
    ) ?? bb.server.loopbackBaseUrl;

  const status = (base: TunnelStatus = relay.status()): ConnectStatus => ({
    ...base,
    lastError: base.lastError ?? phone?.error ?? null,
    signedIn: phone?.signedIn ?? false,
  });
  const publish = () => bb.realtime.publish(CONNECT_REALTIME_CHANNEL, status());

  const shares = new ShareRegistry({
    kv: bb.storage.kv,
    hosts: bb.hosts,
    hostResolver,
    getLoopbackBaseUrl,
    getCredential: credential,
    log: bb.log,
    onChange: publish,
  });

  const recheckServerAccess = createServerAccessRecheck(bb);
  relay = new ConnectTunnel({
    store: createKvCredentialStore(bb.storage.kv, RELAY_CREDENTIAL_KV_KEY),
    shares,
    getLoopbackBaseUrl,
    log: bb.log,
    onStatusChange: (relayStatus) => {
      publish();
      recheckServerAccess(relayStatus);
    },
    onCredentialRejected: () => void phone.check(true),
  });
  phone = new PhoneRelay(bb, relay, publish);
  void bb.storage.kv.delete(LEGACY_CREDENTIAL_KV_KEY).catch(() => {});

  const macs = registerMacs(bb, phone);
  await registerServerAccess(bb, {
    call: (path, body) => phone.call(path, body),
    status: () => relay.status(),
  });

  bb.rpc.register(
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
  registerConnectCli({ bb, relay, phone, status, hostResolver });

  bb.agents.contributeInstructions(() => {
    if (!currentSettings.sendRemoteInstructions) return null;
    const viewing = relay.status();
    if (!viewing.paired || viewing.url === null || !recentlyRemote(viewing)) return null;
    return (
      `The user is currently viewing this Cloudroom remotely at ${viewing.url}. ` +
      "Port shares work from a thread on any enrolled host: when you start an HTTP server they should see, run `room-cli connect expose <port>` from that thread. " +
      "The command returns the correct public URL for the thread's host; give it to them as a markdown link because a localhost URL will not work remotely."
    );
  });

  bb.background.service("tunnel", {
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
