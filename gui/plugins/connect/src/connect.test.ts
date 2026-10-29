import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { decodeFrame, encodeFrame, type Frame } from "@cloudroom/tunnel-contract";
import {
  headersForLoopbackRequest,
  isBareBbRealtimeWs,
  TunnelSession,
} from "@cloudroom/tunnel-client";
import { deriveConnectBaseUrl } from "@cloudroom/connect-client";
import {
  parseSharePort,
  machineSharePublicUrl,
  SharePortError,
  ShareRegistry,
  sharePublicUrl,
  SHARES_KV_KEY,
  serverOwnPort,
} from "./shares.js";
import plugin from "./server.js";
import { ConnectTunnel } from "./tunnel.js";
import type { ConnectStatus } from "./types.js";
import { ShareHostResolver } from "./hosts.js";

const SERVER_HOST_ID = "host-server";
const SERVER_HOST_NAME = "Server";
const REMOTE_HOST_ID = "host-air";
const REMOTE_HOST_NAME = "Sawyer Air";

function createConnectFakeHost(options?: {
  remoteIdentity?: { label: string; baseDomain: string };
  account?: () => string | null;
  cloudroom?: {
    connectAccount: () => Promise<{ accountId: string | null }>;
    connectRegister: () => Promise<{ handle: string; credential: string; serverUrl: string; accountId: string }>;
  };
}): FakePluginHost {
  return createFakePluginHost({
    pluginId: "connect",
    sdk: {
      cloudroom: options?.cloudroom ?? {
        connectAccount: async () => ({ accountId: options?.account?.() ?? null }),
        connectRegister: async () => {
          throw new Error("signed out");
        },
      },
      system: {
        config: async () =>
          ({
            primaryHostId: SERVER_HOST_ID,
          }) as never,
      },
      hosts: {
        get: async ({ hostId }: { hostId: string }) => {
          const host =
            hostId === SERVER_HOST_ID
              ? { id: SERVER_HOST_ID, name: SERVER_HOST_NAME }
              : hostId === REMOTE_HOST_ID
                ? { id: REMOTE_HOST_ID, name: REMOTE_HOST_NAME }
                : null;
          if (!host) {
            throw Object.assign(new Error(`host ${hostId} not found`), {
              status: 404,
            });
          }
          return host as never;
        },
        list: async () =>
          [
            { id: SERVER_HOST_ID, name: SERVER_HOST_NAME },
            { id: REMOTE_HOST_ID, name: REMOTE_HOST_NAME },
          ] as never,
      },
    },
    ...(options?.remoteIdentity
      ? {
          sharedPortTunnelIdentities: {
            [REMOTE_HOST_ID]: options.remoteIdentity,
          },
        }
      : {}),
  });
}

/** Loads the plugin signed in to Cloudroom, with this Mac already registered at serverUrl. */
async function loadSignedIn(
  serverUrl: string,
  options: {
    remoteIdentity?: { label: string; baseDomain: string };
    account?: () => string | null;
    beforeLoad?: (host: FakePluginHost) => void;
  } = {},
): Promise<FakePluginHost> {
  const host = createConnectFakeHost({ account: () => "acc-1", ...options });
  options.beforeLoad?.(host);
  await host.bb.storage.kv.set("relay-account", "acc-1");
  await host.bb.storage.kv.set("relay-credential", {
    serverUrl,
    handle: new URL(serverUrl).hostname.split(".")[0],
    credential: "bbcred_live",
  });
  await plugin(host.bb as unknown as Parameters<typeof plugin>[0]);
  const { controller, done } = host.harness.runService("tunnel");
  await vi.waitFor(async () => {
    expect(((await host.harness.callRpc("status")) as ConnectStatus).paired).toBe(true);
  });
  controller.abort();
  await done;
  return host;
}

describe("deriveConnectBaseUrl", () => {
  it("drops the handle label to reach the apex", () => {
    expect(deriveConnectBaseUrl("https://sawyer.cloudroom.run")).toBe(
      "https://cloudroom.run",
    );
    expect(deriveConnectBaseUrl("https://my-box.vibecodethis.site/")).toBe(
      "https://vibecodethis.site",
    );
  });
});

describe("headersForLoopbackRequest", () => {
  it("rewrites the paired connect origin to the loopback app origin only", () => {
    expect(
      headersForLoopbackRequest(
        [
          ["Origin", "https://sawyer.cloudroom.run"],
          ["Content-Type", "application/json"],
          ["Host", "sawyer.cloudroom.run"],
        ],
        {
          publicOrigin: "https://sawyer.cloudroom.run",
          loopbackOrigin: "http://127.0.0.1:38886",
        },
      ),
    ).toEqual({
      Origin: "http://127.0.0.1:38886",
      "Content-Type": "application/json",
    });

    expect(
      headersForLoopbackRequest([["Origin", "https://evil.example"]], {
        publicOrigin: "https://sawyer.cloudroom.run",
        loopbackOrigin: "http://127.0.0.1:38886",
      }),
    ).toEqual({ Origin: "https://evil.example" });
  });

  it("injects Host and rewrites share Origin for share streams", () => {
    expect(
      headersForLoopbackRequest(
        [
          ["Origin", "https://sawyer--8000.cloudroom.run"],
          ["Content-Type", "text/plain"],
          ["Host", "sawyer--8000.cloudroom.run"],
        ],
        {
          publicOrigin: "https://sawyer--8000.cloudroom.run",
          loopbackOrigin: "http://127.0.0.1:8000",
          host: "127.0.0.1:8000",
        },
      ),
    ).toEqual({
      Origin: "http://127.0.0.1:8000",
      "Content-Type": "text/plain",
      Host: "127.0.0.1:8000",
    });
  });
});

describe("sharePublicUrl", () => {
  it("builds https://handle--port.base from the credential serverUrl", () => {
    expect(
      sharePublicUrl(
        { serverUrl: "https://sawyer.cloudroom.run", handle: "sawyer" },
        8000,
      ),
    ).toBe("https://sawyer--8000.cloudroom.run");
  });

  it("uses a non-primary routing label when multi-server pairing stored one", () => {
    expect(
      sharePublicUrl(
        {
          serverUrl: "https://sawyer-desktop.cloudroom.run",
          handle: "sawyer-desktop",
        },
        8000,
      ),
    ).toBe("https://sawyer-desktop--8000.cloudroom.run");
  });

  it("uses HTTP and the local port for machine shares in local Cloud", () => {
    expect(
      machineSharePublicUrl(
        { label: "sawyer-air", baseDomain: "bb.localhost:42745" },
        8000,
      ),
    ).toBe("http://sawyer-air--8000.bb.localhost:42745");
  });
});

describe("parseSharePort / serverOwnPort", () => {
  it("accepts integers 1–65535 and rejects the rest", () => {
    expect(parseSharePort(80)).toBe(80);
    expect(parseSharePort("5173")).toBe(5173);
    expect(() => parseSharePort(0)).toThrow(SharePortError);
    expect(() => parseSharePort(65536)).toThrow(SharePortError);
    expect(() => parseSharePort(3.5)).toThrow(SharePortError);
    expect(() => parseSharePort("nope")).toThrow(SharePortError);
  });

  it("reads the bb server port from the loopback base URL", () => {
    expect(serverOwnPort("http://127.0.0.1:38886")).toBe(38886);
    expect(serverOwnPort("http://127.0.0.1")).toBe(80);
  });
});

describe("ShareRegistry", () => {
  it("persists shares in kv and refuses the server's own port", async () => {
    const kv = new Map<string, unknown>();
    const store = {
      async get<T>(key: string) {
        return kv.get(key) as T | undefined;
      },
      async set(key: string, value: unknown) {
        kv.set(key, value);
      },
      async delete(key: string) {
        kv.delete(key);
      },
    };
    const credential = {
      serverUrl: "https://sawyer.cloudroom.run",
      handle: "sawyer",
      credential: "bbcred_x",
    };
    const fakeHost = createFakePluginHost({
      sdk: {
        system: {
          config: async () => ({ primaryHostId: "host-server" }) as never,
        },
        hosts: {
          get: async () => ({ id: "host-server", name: "Server" }) as never,
        },
      },
    });
    const pluginBb = fakeHost.bb as unknown as Parameters<typeof plugin>[0];
    const hostResolver = new ShareHostResolver(() => pluginBb.sdk);
    const serverHost = {
      id: "host-server",
      name: "Server",
      isServer: true,
    };
    const registry = new ShareRegistry({
      kv: store,
      hosts: pluginBb.hosts,
      hostResolver,
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      getCredential: () => credential,
      log: pluginBb.log,
    });
    await registry.load();

    await expect(registry.add(38886, serverHost)).rejects.toThrow(/own port/);

    const added = await registry.add(8000, serverHost);
    expect(added.url).toBe("https://sawyer--8000.cloudroom.run");
    expect(registry.hasServerPort(8000)).toBe(true);
    expect(kv.get(SHARES_KV_KEY)).toMatchObject({
      "host-server:8000": { hostId: "host-server", port: 8000 },
    });

    const reloaded = new ShareRegistry({
      kv: store,
      hosts: pluginBb.hosts,
      hostResolver,
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      getCredential: () => credential,
      log: pluginBb.log,
    });
    await reloaded.load();
    expect(await reloaded.list()).toEqual([
      {
        hostId: "host-server",
        hostName: "Server",
        port: 8000,
        url: "https://sawyer--8000.cloudroom.run",
        createdAt: expect.any(Number),
      },
    ]);

    expect(await reloaded.remove(8000, "host-server")).toMatchObject({
      removed: true,
      hostId: "host-server",
    });
    expect(await reloaded.remove(8000, "host-server")).toMatchObject({
      removed: false,
      hostId: "host-server",
    });
    expect(kv.has(SHARES_KV_KEY)).toBe(false);
    await fakeHost.harness.dispose();
  });

  it("loads legacy entries without hostId as server-host shares", async () => {
    const kv = new Map<string, unknown>([
      [SHARES_KV_KEY, { "3000": { port: 3000, createdAt: 123 } }],
    ]);
    const fakeHost = createConnectFakeHost();
    const pluginBb = fakeHost.bb as unknown as Parameters<typeof plugin>[0];
    const registry = new ShareRegistry({
      kv: {
        async get<T>(key: string) {
          return kv.get(key) as T | undefined;
        },
        async set(key: string, value: unknown) {
          kv.set(key, value);
        },
        async delete(key: string) {
          kv.delete(key);
        },
      },
      hosts: pluginBb.hosts,
      hostResolver: new ShareHostResolver(() => pluginBb.sdk),
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      getCredential: () => ({
        serverUrl: "https://sawyer.cloudroom.run",
        handle: "sawyer",
        credential: "bbcred_x",
      }),
      log: pluginBb.log,
    });

    await registry.load();
    expect(await registry.list()).toEqual([
      {
        hostId: SERVER_HOST_ID,
        hostName: SERVER_HOST_NAME,
        port: 3000,
        createdAt: 123,
        url: "https://sawyer--3000.cloudroom.run",
      },
    ]);
    expect(kv.get(SHARES_KV_KEY)).toEqual({
      "3000": { port: 3000, createdAt: 123 },
    });
    await fakeHost.harness.dispose();
  });

  it("lists persisted shares in the sync snapshot before any resolution, including unpaired", async () => {
    const kv = new Map<string, unknown>([
      [
        SHARES_KV_KEY,
        {
          "3000": { port: 3000, createdAt: 1 },
          [`${REMOTE_HOST_ID}:4000`]: {
            hostId: REMOTE_HOST_ID,
            port: 4000,
            createdAt: 2,
          },
        },
      ],
    ]);
    const fakeHost = createConnectFakeHost();
    const pluginBb = fakeHost.bb as unknown as Parameters<typeof plugin>[0];
    const registry = new ShareRegistry({
      kv: {
        async get<T>(key: string) {
          return kv.get(key) as T | undefined;
        },
        async set(key: string, value: unknown) {
          kv.set(key, value);
        },
        async delete(key: string) {
          kv.delete(key);
        },
      },
      hosts: pluginBb.hosts,
      hostResolver: new ShareHostResolver(() => pluginBb.sdk),
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      getCredential: () => null,
      log: pluginBb.log,
    });

    await registry.load();
    expect(registry.snapshot()).toEqual([
      {
        hostId: REMOTE_HOST_ID,
        hostName: REMOTE_HOST_ID,
        port: 4000,
        createdAt: 2,
        url: "",
        unavailableReason: "Share URL has not been resolved yet.",
      },
      {
        hostId: "server",
        hostName: "server host",
        port: 3000,
        createdAt: 1,
        url: "",
        unavailableReason: "Share URL has not been resolved yet.",
      },
    ]);
    await fakeHost.harness.dispose();
  });

  it("collapses the placeholder snapshot row when a legacy share resolves", async () => {
    const kv = new Map<string, unknown>([
      [SHARES_KV_KEY, { "3000": { port: 3000, createdAt: 123 } }],
    ]);
    const fakeHost = createConnectFakeHost();
    const pluginBb = fakeHost.bb as unknown as Parameters<typeof plugin>[0];
    const registry = new ShareRegistry({
      kv: {
        async get<T>(key: string) {
          return kv.get(key) as T | undefined;
        },
        async set(key: string, value: unknown) {
          kv.set(key, value);
        },
        async delete(key: string) {
          kv.delete(key);
        },
      },
      hosts: pluginBb.hosts,
      hostResolver: new ShareHostResolver(() => pluginBb.sdk),
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      getCredential: () => ({
        serverUrl: "https://sawyer.cloudroom.run",
        handle: "sawyer",
        credential: "bbcred_x",
      }),
      log: pluginBb.log,
    });

    await registry.load();
    expect(registry.snapshot()).toEqual([
      expect.objectContaining({ hostId: "server", port: 3000 }),
    ]);
    await registry.add(3000, {
      id: SERVER_HOST_ID,
      name: SERVER_HOST_NAME,
      isServer: true,
    });
    expect(registry.snapshot()).toEqual([
      {
        hostId: SERVER_HOST_ID,
        hostName: SERVER_HOST_NAME,
        port: 3000,
        createdAt: 123,
        url: "https://sawyer--3000.cloudroom.run",
      },
    ]);
    await fakeHost.harness.dispose();
  });

  it("normalizes legacy entries to the server host id at activation", async () => {
    const kv = new Map<string, unknown>([
      [SHARES_KV_KEY, { "3000": { port: 3000, createdAt: 123 } }],
    ]);
    const fakeHost = createConnectFakeHost();
    const pluginBb = fakeHost.bb as unknown as Parameters<typeof plugin>[0];
    const registry = new ShareRegistry({
      kv: {
        async get<T>(key: string) {
          return kv.get(key) as T | undefined;
        },
        async set(key: string, value: unknown) {
          kv.set(key, value);
        },
        async delete(key: string) {
          kv.delete(key);
        },
      },
      hosts: pluginBb.hosts,
      hostResolver: new ShareHostResolver(() => pluginBb.sdk),
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      getCredential: () => ({
        serverUrl: "https://sawyer.cloudroom.run",
        handle: "sawyer",
        credential: "bbcred_x",
      }),
      log: pluginBb.log,
    });

    await registry.load();
    expect(registry.hasServerPort(3000)).toBe(true);
    await registry.declareMachineShares(() => true);
    expect(kv.get(SHARES_KV_KEY)).toEqual({
      [`${SERVER_HOST_ID}:3000`]: {
        hostId: SERVER_HOST_ID,
        port: 3000,
        createdAt: 123,
      },
    });
    expect(registry.hasServerPort(3000)).toBe(true);
    expect(await registry.remove(3000, SERVER_HOST_ID)).toMatchObject({
      removed: true,
      hostId: SERVER_HOST_ID,
    });
    await fakeHost.harness.dispose();
  });

  it("loads valid entries when another kv entry is malformed", async () => {
    const kv = new Map<string, unknown>([
      [
        SHARES_KV_KEY,
        {
          [`${SERVER_HOST_ID}:8000`]: {
            hostId: SERVER_HOST_ID,
            port: 8000,
            createdAt: 1,
          },
          malformed: { hostId: REMOTE_HOST_ID, port: "nope", createdAt: 2 },
        },
      ],
    ]);
    const fakeHost = createConnectFakeHost();
    const pluginBb = fakeHost.bb as unknown as Parameters<typeof plugin>[0];
    const registry = new ShareRegistry({
      kv: {
        async get<T>(key: string) {
          return kv.get(key) as T | undefined;
        },
        async set(key: string, value: unknown) {
          kv.set(key, value);
        },
        async delete(key: string) {
          kv.delete(key);
        },
      },
      hosts: pluginBb.hosts,
      hostResolver: new ShareHostResolver(() => pluginBb.sdk),
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      getCredential: () => ({
        serverUrl: "https://sawyer.cloudroom.run",
        handle: "sawyer",
        credential: "bbcred_x",
      }),
      log: pluginBb.log,
    });

    await registry.load();
    expect(fakeHost.harness.sdk.callsTo("hosts.get")).toEqual([]);
    expect(fakeHost.harness.sdk.callsTo("system.config")).toEqual([]);
    expect(await registry.list()).toEqual([
      {
        hostId: SERVER_HOST_ID,
        hostName: SERVER_HOST_NAME,
        port: 8000,
        createdAt: 1,
        url: "https://sawyer--8000.cloudroom.run",
      },
    ]);
    expect(fakeHost.harness.logEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: expect.stringContaining(
            'malformed shared-port entry "malformed"',
          ),
        }),
      ]),
    );
    await fakeHost.harness.dispose();
  });

  it("hydrates offline machine shares without resolving their URLs", async () => {
    const kv = new Map<string, unknown>([
      [
        SHARES_KV_KEY,
        {
          [`${SERVER_HOST_ID}:8000`]: {
            hostId: SERVER_HOST_ID,
            port: 8000,
            createdAt: 1,
          },
          [`${REMOTE_HOST_ID}:3000`]: {
            hostId: REMOTE_HOST_ID,
            port: 3000,
            createdAt: 2,
          },
        },
      ],
    ]);
    const fakeHost = createConnectFakeHost();
    const pluginBb = fakeHost.bb as unknown as Parameters<typeof plugin>[0];
    const ensureIdentity = vi.fn(async () => {
      throw Object.assign(new Error("host is offline"), {
        body: { code: "connect_host_offline" },
      });
    });
    const registry = new ShareRegistry({
      kv: {
        async get<T>(key: string) {
          return kv.get(key) as T | undefined;
        },
        async set(key: string, value: unknown) {
          kv.set(key, value);
        },
        async delete(key: string) {
          kv.delete(key);
        },
      },
      hosts: {
        ensureSharedPortTunnel: ensureIdentity,
        declareSharedPorts: pluginBb.hosts.declareSharedPorts,
      },
      hostResolver: new ShareHostResolver(() => pluginBb.sdk),
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      getCredential: () => ({
        serverUrl: "https://sawyer.cloudroom.run",
        handle: "sawyer",
        credential: "bbcred_x",
      }),
      log: pluginBb.log,
    });

    await registry.load();
    expect(ensureIdentity).not.toHaveBeenCalled();
    expect(fakeHost.harness.sdk.callsTo("hosts.get")).toEqual([]);
    expect(await registry.list()).toEqual([
      {
        hostId: REMOTE_HOST_ID,
        hostName: REMOTE_HOST_NAME,
        port: 3000,
        createdAt: 2,
        url: "",
        unavailableReason: expect.stringMatching(
          /not connected right now.*Bring the host online/,
        ),
      },
      {
        hostId: SERVER_HOST_ID,
        hostName: SERVER_HOST_NAME,
        port: 8000,
        createdAt: 1,
        url: "https://sawyer--8000.cloudroom.run",
      },
    ]);
    expect(ensureIdentity).toHaveBeenCalledTimes(1);
    await fakeHost.harness.dispose();
  });
});

describe("ConnectTunnel share activation", () => {
  it("does not declare non-empty ports when serverHostId resolves after stop", async () => {
    let resolveServerHostId!: (hostId: string) => void;
    const serverHostId = new Promise<string>((resolve) => {
      resolveServerHostId = resolve;
    });
    let markLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    const fakeHost = createFakePluginHost({
      pluginId: "connect",
      sdk: {
        system: {
          config: async () => {
            markLookupStarted();
            return { primaryHostId: await serverHostId } as never;
          },
        },
        hosts: {
          get: async ({ hostId }: { hostId: string }) =>
            ({ id: hostId, name: hostId }) as never,
        },
      },
    });
    const pluginBb = fakeHost.bb as unknown as Parameters<typeof plugin>[0];
    const credential = {
      serverUrl: "http://127.0.0.1:1",
      handle: "sawyer",
      credential: "bbcred_x",
    };
    const kv = new Map<string, unknown>([
      [
        SHARES_KV_KEY,
        {
          [`${REMOTE_HOST_ID}:3000`]: {
            hostId: REMOTE_HOST_ID,
            port: 3000,
            createdAt: 1,
          },
        },
      ],
    ]);
    const shares = new ShareRegistry({
      kv: {
        async get<T>(key: string) {
          return kv.get(key) as T | undefined;
        },
        async set(key: string, value: unknown) {
          kv.set(key, value);
        },
        async delete(key: string) {
          kv.delete(key);
        },
      },
      hosts: pluginBb.hosts,
      hostResolver: new ShareHostResolver(() => pluginBb.sdk),
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      getCredential: () => credential,
      log: pluginBb.log,
    });
    const tunnel = new ConnectTunnel({
      store: {
        read: async () => credential,
        write: async () => {},
        clear: async () => {},
      },
      shares,
      onCredentialRejected: () => {},
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      log: pluginBb.log,
    });

    await tunnel.start();
    await lookupStarted;
    tunnel.stop();
    resolveServerHostId(SERVER_HOST_ID);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(
      fakeHost.harness.sharedPortDeclarations.filter(
        (declaration) => declaration.ports.length > 0,
      ),
    ).toEqual([]);
    await fakeHost.harness.dispose();
  });

  it("keeps persisted shares visible in status after an unpaired restart", async () => {
    const fakeHost = createConnectFakeHost();
    const pluginBb = fakeHost.bb as unknown as Parameters<typeof plugin>[0];
    const kv = new Map<string, unknown>([
      [
        SHARES_KV_KEY,
        {
          "3000": { port: 3000, createdAt: 1 },
          [`${REMOTE_HOST_ID}:4000`]: {
            hostId: REMOTE_HOST_ID,
            port: 4000,
            createdAt: 2,
          },
        },
      ],
    ]);
    const shares = new ShareRegistry({
      kv: {
        async get<T>(key: string) {
          return kv.get(key) as T | undefined;
        },
        async set(key: string, value: unknown) {
          kv.set(key, value);
        },
        async delete(key: string) {
          kv.delete(key);
        },
      },
      hosts: pluginBb.hosts,
      hostResolver: new ShareHostResolver(() => pluginBb.sdk),
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      getCredential: () => null,
      log: pluginBb.log,
    });
    const tunnel = new ConnectTunnel({
      store: {
        read: async () => null,
        write: async () => {},
        clear: async () => {},
      },
      shares,
      onCredentialRejected: () => {},
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      log: pluginBb.log,
    });

    await tunnel.start();
    await waitFor(() => tunnel.status().shares.length === 2);
    expect(tunnel.status().shares).toEqual([
      expect.objectContaining({
        hostId: REMOTE_HOST_ID,
        port: 4000,
        url: "",
        unavailableReason: "Share URL has not been resolved yet.",
      }),
      expect.objectContaining({
        hostId: "server",
        port: 3000,
        url: "",
        unavailableReason: "Share URL has not been resolved yet.",
      }),
    ]);
    tunnel.stop();
    await fakeHost.harness.dispose();
  });
});

describe("isBareBbRealtimeWs", () => {
  it("matches bare-handle /ws paths only", () => {
    expect(isBareBbRealtimeWs("/ws", undefined)).toBe(true);
    expect(isBareBbRealtimeWs("/ws?x=1", undefined)).toBe(true);
    expect(isBareBbRealtimeWs("/ws/nested", undefined)).toBe(true);
    expect(isBareBbRealtimeWs("/ws", "8000")).toBe(false);
    expect(isBareBbRealtimeWs("/api", undefined)).toBe(false);
  });
});

async function listen(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<{ server: Server; origin: string; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("expected TCP address");
  }
  return {
    server,
    origin: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
  };
}

async function waitForOpen(ws: NodeWebSocket): Promise<void> {
  if (ws.readyState === NodeWebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function collectFrames(ws: NodeWebSocket): Frame[] {
  const frames: Frame[] = [];
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) frames.push(decodeFrame(data));
  });
  return frames;
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("TunnelSession routing", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("routes no-target to primary origin, target to a shared port, unregistered → 404", async () => {
    const primaryHits: string[] = [];
    const shareHits: string[] = [];
    const primary = await listen((req, res) => {
      primaryHits.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("primary");
    });
    const share = await listen((req, res) => {
      shareHits.push(
        `${req.method} ${req.url} host=${req.headers.host} origin=${req.headers.origin ?? ""}`,
      );
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("shared");
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => primary.server.close(() => resolve())),
      () => new Promise<void>((resolve) => share.server.close(() => resolve())),
    );

    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) =>
      wss.once("listening", () => resolve()),
    );
    const wssAddr = wss.address();
    if (wssAddr === null || typeof wssAddr === "string") {
      throw new Error("expected TCP address");
    }
    const relayReady = new Promise<NodeWebSocket>((resolve) => {
      wss.on("connection", (socket) => resolve(socket));
    });
    const client = new NodeWebSocket(`ws://127.0.0.1:${wssAddr.port}`);
    cleanups.push(async () => {
      client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    });
    await waitForOpen(client);
    const relay = await relayReady;
    const frames = collectFrames(relay);

    const sharedPorts = new Set([share.port]);
    const session = new TunnelSession({
      tunnel: client,
      log: {
        info: () => {},
        warn: () => {},
      },
      resolveOrigin: (target) => {
        if (target === undefined) {
          return {
            kind: "ok",
            resolved: {
              origin: primary.origin,
              publicOrigin: "https://sawyer.cloudroom.run",
            },
          };
        }
        const port = Number(target);
        if (!sharedPorts.has(port)) return { kind: "unregistered" };
        return {
          kind: "ok",
          resolved: {
            origin: `http://127.0.0.1:${port}`,
            publicOrigin: `https://sawyer--${port}.cloudroom.run`,
            host: `127.0.0.1:${port}`,
          },
        };
      },
    });
    session.start();
    cleanups.push(() => session.dispose());

    const inject = (frame: Frame) => {
      relay.send(Buffer.from(encodeFrame(frame)));
    };

    inject({
      type: "open-http",
      streamId: 1,
      method: "GET",
      path: "/hello",
      headers: [["Origin", "https://sawyer.cloudroom.run"]],
      hasBody: false,
    });
    await waitFor(() =>
      frames.some((f) => f.type === "body-end" && f.streamId === 1),
    );
    expect(primaryHits).toEqual(["GET /hello"]);
    expect(shareHits).toEqual([]);

    frames.length = 0;
    inject({
      type: "open-http",
      streamId: 2,
      method: "GET",
      path: "/app",
      headers: [
        ["Origin", `https://sawyer--${share.port}.cloudroom.run`],
        ["Host", `sawyer--${share.port}.cloudroom.run`],
      ],
      hasBody: false,
      target: String(share.port),
    });
    await waitFor(() =>
      frames.some((f) => f.type === "body-end" && f.streamId === 2),
    );
    expect(shareHits).toHaveLength(1);
    expect(shareHits[0]).toContain("GET /app");
    expect(shareHits[0]).toContain(`host=127.0.0.1:${share.port}`);
    expect(shareHits[0]).toContain(`origin=http://127.0.0.1:${share.port}`);
    expect(primaryHits).toEqual(["GET /hello"]);

    frames.length = 0;
    inject({
      type: "open-http",
      streamId: 3,
      method: "GET",
      path: "/nope",
      headers: [],
      hasBody: false,
      target: "59999",
    });
    await waitFor(() =>
      frames.some((f) => f.type === "resp-head" && f.streamId === 3),
    );
    const head = frames.find((f) => f.type === "resp-head" && f.streamId === 3);
    expect(head).toMatchObject({ type: "resp-head", status: 404 });
    const bodyChunks = frames.filter(
      (f) => f.type === "body-chunk" && f.streamId === 3,
    );
    const body = Buffer.concat(
      bodyChunks.map((f) =>
        f.type === "body-chunk" ? Buffer.from(f.data) : Buffer.alloc(0),
      ),
    ).toString();
    expect(body).toBe("this port is not shared");
    expect(frames.some((f) => f.type === "body-end" && f.streamId === 3)).toBe(
      true,
    );
  });

  it("aborts the origin request when the relay closes an HTTP stream", async () => {
    let originStarted = false;
    let originClosed = false;
    const origin = await listen((request, response) => {
      originStarted = true;
      request.once("aborted", () => {
        originClosed = true;
      });
      response.once("close", () => {
        originClosed = true;
      });
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => origin.server.close(() => resolve())),
    );

    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) =>
      wss.once("listening", () => resolve()),
    );
    const wssAddr = wss.address();
    if (wssAddr === null || typeof wssAddr === "string") {
      throw new Error("expected TCP address");
    }
    const relayReady = new Promise<NodeWebSocket>((resolve) => {
      wss.on("connection", (socket) => resolve(socket));
    });
    const client = new NodeWebSocket(`ws://127.0.0.1:${wssAddr.port}`);
    cleanups.push(async () => {
      client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    });
    await waitForOpen(client);
    const relay = await relayReady;

    const session = new TunnelSession({
      tunnel: client,
      log: {
        info: () => {},
        warn: () => {},
      },
      resolveOrigin: () => ({
        kind: "ok",
        resolved: {
          origin: origin.origin,
          publicOrigin: "https://sawyer.cloudroom.run",
        },
      }),
    });
    session.start();
    cleanups.push(() => session.dispose());

    relay.send(
      Buffer.from(
        encodeFrame({
          type: "open-http",
          streamId: 41,
          method: "GET",
          path: "/slow",
          headers: [],
          hasBody: false,
        }),
      ),
    );
    await waitFor(() => originStarted);

    relay.send(
      Buffer.from(
        encodeFrame({
          type: "close-stream",
          streamId: 41,
          code: 1000,
          reason: "visitor canceled response body",
        }),
      ),
    );
    await waitFor(() => originClosed);
  });

  it("preserves negotiated origin compression across the tunnel and relays 304 bodiless", async () => {
    const plainBody = "hello ".repeat(200);
    const gzippedBody = gzipSync(Buffer.from(plainBody));
    const acceptEncodings: Array<string | undefined> = [];
    const origin = await listen((req, res) => {
      acceptEncodings.push(req.headers["accept-encoding"]);
      if (req.headers["if-none-match"] === 'W/"v1"') {
        res.writeHead(304, { etag: 'W/"v1"' });
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-encoding": "gzip",
        "content-length": String(gzippedBody.length),
        etag: 'W/"v1"',
      });
      res.end(gzippedBody);
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => origin.server.close(() => resolve())),
    );

    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) =>
      wss.once("listening", () => resolve()),
    );
    const wssAddr = wss.address();
    if (wssAddr === null || typeof wssAddr === "string") {
      throw new Error("expected TCP address");
    }
    const relayReady = new Promise<NodeWebSocket>((resolve) => {
      wss.on("connection", (socket) => resolve(socket));
    });
    const client = new NodeWebSocket(`ws://127.0.0.1:${wssAddr.port}`);
    cleanups.push(async () => {
      client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    });
    await waitForOpen(client);
    const relay = await relayReady;
    const frames = collectFrames(relay);
    const infoMessages: string[] = [];

    const session = new TunnelSession({
      tunnel: client,
      log: {
        info: (message) => infoMessages.push(message),
        warn: () => {},
      },
      resolveOrigin: () => ({
        kind: "ok",
        resolved: {
          origin: origin.origin,
          publicOrigin: "https://sawyer.cloudroom.run",
        },
      }),
    });
    session.start();
    cleanups.push(() => session.dispose());

    const inject = (frame: Frame) => {
      relay.send(Buffer.from(encodeFrame(frame)));
    };

    inject({
      type: "open-http",
      streamId: 21,
      method: "GET",
      path: "/api/v1/threads/thr_test/timeline",
      headers: [["accept-encoding", "gzip"]],
      hasBody: false,
    });
    await waitFor(() =>
      frames.some((f) => f.type === "body-end" && f.streamId === 21),
    );
    const head = frames.find(
      (f) => f.type === "resp-head" && f.streamId === 21,
    );
    if (head?.type !== "resp-head") throw new Error("missing resp-head");
    expect(head.status).toBe(200);
    const headerNames = head.headers.map(([name]) => name.toLowerCase());
    expect(headerNames).toContain("content-encoding");
    expect(headerNames).toContain("content-length");
    expect(headerNames).toContain("etag");
    expect(head.headers).toContainEqual([
      "server-timing",
      expect.stringMatching(/^bb_connect_origin;dur=\d+(?:\.\d+)?$/),
    ]);
    const relayedBody = Buffer.concat(
      frames
        .filter((f) => f.type === "body-chunk" && f.streamId === 21)
        .map((f) =>
          f.type === "body-chunk" ? Buffer.from(f.data) : Buffer.alloc(0),
        ),
    );
    expect(relayedBody).toEqual(gzippedBody);
    expect(acceptEncodings).toEqual(["gzip"]);
    expect(infoMessages).toEqual([
      expect.stringContaining(
        `responseBytes=${gzippedBody.length} contentEncoding=gzip`,
      ),
    ]);

    frames.length = 0;
    inject({
      type: "open-http",
      streamId: 22,
      method: "GET",
      path: "/api/v1/threads/thr_test/timeline",
      headers: [["If-None-Match", 'W/"v1"']],
      hasBody: false,
    });
    await waitFor(() =>
      frames.some((f) => f.type === "body-end" && f.streamId === 22),
    );
    const revalidated = frames.find(
      (f) => f.type === "resp-head" && f.streamId === 22,
    );
    expect(revalidated).toMatchObject({ type: "resp-head", status: 304 });
    expect(
      frames.some((f) => f.type === "body-chunk" && f.streamId === 22),
    ).toBe(false);
  });

  it("tracks remoteClients for bare-handle /ws streams", async () => {
    const origin = await listen((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const originWss = new WebSocketServer({ server: origin.server });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          originWss.close(() => origin.server.close(() => resolve()));
        }),
    );

    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) =>
      wss.once("listening", () => resolve()),
    );
    const wssAddr = wss.address();
    if (wssAddr === null || typeof wssAddr === "string") {
      throw new Error("expected TCP address");
    }
    const relayReady = new Promise<NodeWebSocket>((resolve) => {
      wss.on("connection", (socket) => resolve(socket));
    });
    const client = new NodeWebSocket(`ws://127.0.0.1:${wssAddr.port}`);
    cleanups.push(async () => {
      client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    });
    await waitForOpen(client);
    const relay = await relayReady;
    const frames = collectFrames(relay);

    const remoteClientsSeen: number[] = [];
    const session = new TunnelSession({
      tunnel: client,
      log: {
        info: () => {},
        warn: () => {},
      },
      resolveOrigin: () => ({
        kind: "ok",
        resolved: {
          origin: origin.origin,
          publicOrigin: "https://sawyer.cloudroom.run",
        },
      }),
      onRemoteClientsChange: (n) => {
        remoteClientsSeen.push(n);
      },
    });
    session.start();
    cleanups.push(() => session.dispose());

    expect(session.remoteClients).toBe(0);

    const inject = (frame: Frame) => {
      relay.send(Buffer.from(encodeFrame(frame)));
    };

    inject({
      type: "open-ws",
      streamId: 10,
      path: "/ws",
      headers: [],
      protocols: [],
    });
    await waitFor(() =>
      frames.some((f) => f.type === "ws-open-ack" && f.streamId === 10),
    );
    expect(session.remoteClients).toBe(1);
    expect(remoteClientsSeen).toContain(1);

    inject({
      type: "close-stream",
      streamId: 10,
      code: 1000,
      reason: "bye",
    });
    await waitFor(() => session.remoteClients === 0);
    expect(remoteClientsSeen).toContain(0);
  });
});

describe("connect plugin", () => {
  let host: FakePluginHost | undefined;

  async function loadPlugin(): Promise<FakePluginHost> {
    host = createConnectFakeHost();
    await plugin(host.bb as unknown as Parameters<typeof plugin>[0]);
    return host;
  }

  async function stopTunnel(current: FakePluginHost): Promise<void> {
    const { controller, done } = current.harness.runService("tunnel");
    controller.abort();
    await done;
  }

  afterEach(async () => {
    if (host) {
      await stopTunnel(host);
      await host.harness.dispose();
      host = undefined;
    }
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("starts unpaired — a healthy state, not needs-configuration", async () => {
    const { harness } = await loadPlugin();
    const status = (await harness.callRpc("status")) as ConnectStatus;
    expect(status).toMatchObject({
      state: "disconnected",
      paired: false,
      handle: null,
      url: null,
      lastError: null,
      remoteClients: 0,
      lastRemoteActivityAt: null,
      shares: [],
    });
    expect(status.nextRetryAt).toBeNull();
    expect(harness.needsConfigurationMessages).toEqual([]);
  });

  it("toggles remote instructions while preserving active and recent usage conditions", async () => {
    const status: ConnectStatus = {
      state: "connected",
      paired: true,
      handle: "test",
      url: "https://test.cloudroom.run",
      lastError: null,
      nextRetryAt: null,
      since: Date.now(),
      remoteClients: 1,
      lastRemoteActivityAt: null,
      shares: [],
      signedIn: true,
    };
    const statusSpy = vi
      .spyOn(ConnectTunnel.prototype, "status")
      .mockReturnValue(status);
    try {
      const { harness } = await loadPlugin();
      const instructions = () =>
        harness.registrations.instructionProvider?.({
          threadId: "thr_test",
          projectId: "proj_test",
        });
      expect(instructions()).toContain("room-cli connect expose");
      await harness.behavior.setSettings({ sendRemoteInstructions: false });
      expect(instructions()).toBeNull();
      await harness.behavior.setSettings({ sendRemoteInstructions: true });
      expect(instructions()).toContain("https://test.cloudroom.run");
      statusSpy.mockReturnValue({ ...status, remoteClients: 0 });
      expect(instructions()).toBeNull();
      statusSpy.mockReturnValue({
        ...status,
        remoteClients: 0,
        lastRemoteActivityAt: Date.now(),
      });
      expect(instructions()).toContain("room-cli connect expose");
    } finally {
      statusSpy.mockRestore();
    }
  });

  it("registers contributeInstructions", async () => {
    const { harness } = await loadPlugin();
    expect(harness.registrations.instructionProvider).not.toBeNull();
    expect(
      harness.registrations.instructionProvider?.({
        threadId: "th_1",
        projectId: "proj_1",
      }),
    ).toBeNull();
  });

  it("registers this Mac with Cloudroom Connect once the user is signed in", async () => {
    const connectRegister = vi.fn(async () => ({
      handle: "k3x9m2p7qa",
      credential: "a".repeat(64),
      serverUrl: "http://k3x9m2p7qa.localhost:59340",
      accountId: "acc-1",
    }));
    host = createConnectFakeHost({
      cloudroom: { connectAccount: async () => ({ accountId: "acc-1" }), connectRegister },
    });
    await plugin(host.bb as unknown as Parameters<typeof plugin>[0]);
    const { bb, harness } = host;
    const { controller, done } = harness.runService("tunnel");
    await vi.waitFor(async () => {
      const status = (await harness.callRpc("status")) as ConnectStatus;
      expect(status).toMatchObject({
        signedIn: true,
        paired: true,
        handle: "k3x9m2p7qa",
        url: "http://k3x9m2p7qa.localhost:59340",
      });
    });
    expect(await bb.storage.kv.get("relay-credential")).toEqual({
      serverUrl: "http://k3x9m2p7qa.localhost:59340",
      handle: "k3x9m2p7qa",
      credential: "a".repeat(64),
    });
    expect(await bb.storage.kv.get("relay-account")).toBe("acc-1");
    const exposed = (await harness.callRpc("expose", { port: 8000 })) as { url: string };
    expect(exposed.url).toBe("http://k3x9m2p7qa--8000.localhost:59340");

    const fetchMock = vi.fn(async () => Response.json({ revoked: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = (await harness.callRpc("signOutPhones")) as { revoked: number };
    expect(result.revoked).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://localhost:59340/api/phone-sessions/revoke"),
      expect.objectContaining({
        method: "POST",
        headers: { authorization: `Bearer ${"a".repeat(64)}` },
      }),
    );
    controller.abort();
    await done;
    expect(connectRegister).toHaveBeenCalledTimes(1);
  });

  it("does not register again for the same account, and forgets the Mac when signed out", async () => {
    let accountId: string | null = "acc-1";
    const connectRegister = vi.fn(async () => ({
      handle: "k3x9m2p7qa",
      credential: "b".repeat(64),
      serverUrl: "http://k3x9m2p7qa.localhost:59341",
      accountId: "acc-1",
    }));
    host = createConnectFakeHost({
      cloudroom: { connectAccount: async () => ({ accountId }), connectRegister },
    });
    const { bb, harness } = host;
    await bb.storage.kv.set("relay-account", "acc-1");
    await bb.storage.kv.set("relay-credential", {
      serverUrl: "http://k3x9m2p7qa.localhost:59341",
      handle: "k3x9m2p7qa",
      credential: "c".repeat(64),
    });
    await plugin(bb as unknown as Parameters<typeof plugin>[0]);
    const first = harness.runService("tunnel");
    await vi.waitFor(async () => {
      expect(((await harness.callRpc("status")) as ConnectStatus).paired).toBe(true);
    });
    first.controller.abort();
    await first.done;
    expect(connectRegister).not.toHaveBeenCalled();

    accountId = null;
    const second = harness.runService("tunnel");
    await vi.waitFor(async () => {
      const status = (await harness.callRpc("status")) as ConnectStatus;
      expect(status).toMatchObject({ signedIn: false, paired: false });
    });
    expect(await bb.storage.kv.get("relay-credential")).toBeUndefined();
    await expect(harness.callRpc("signOutPhones")).rejects.toThrow(/Sign in to Cloudroom/);
    second.controller.abort();
    await second.done;
  });

  it("expose / listShares / unexpose rpc round-trip when paired", async () => {
    host = await loadSignedIn("http://sawyer.localhost:59330");
    const { harness } = host;

    const shareUrl = "http://sawyer--8000.localhost:59330";
    const exposed = (await harness.callRpc("expose", { port: 8000 })) as {
      port: number;
      url: string;
    };
    expect(exposed).toEqual({
      hostId: SERVER_HOST_ID,
      hostName: SERVER_HOST_NAME,
      port: 8000,
      url: shareUrl,
      createdAt: expect.any(Number),
    });

    const listed = (await harness.callRpc("listShares")) as Array<{
      port: number;
      url: string;
    }>;
    expect(listed).toEqual([
      {
        hostId: SERVER_HOST_ID,
        hostName: SERVER_HOST_NAME,
        port: 8000,
        url: shareUrl,
        createdAt: expect.any(Number),
      },
    ]);

    const status = (await harness.callRpc("status")) as ConnectStatus;
    expect(status.shares).toEqual([
      {
        hostId: SERVER_HOST_ID,
        hostName: SERVER_HOST_NAME,
        port: 8000,
        url: shareUrl,
        createdAt: expect.any(Number),
      },
    ]);

    const removed = (await harness.callRpc("unexpose", { port: 8000 })) as {
      removed: boolean;
      port: number;
    };
    expect(removed).toEqual({
      removed: true,
      hostId: SERVER_HOST_ID,
      hostName: SERVER_HOST_NAME,
      port: 8000,
    });
    expect(await harness.callRpc("listShares")).toEqual([]);
  });

  it("rejects tunnel identity fields on expose and unexpose rpc inputs", async () => {
    const { harness } = await loadPlugin();
    const redirected = {
      port: 3000,
      hostId: REMOTE_HOST_ID,
      label: "attacker",
      baseDomain: "attacker.example",
    };

    await expect(harness.callRpc("expose", redirected)).rejects.toMatchObject({
      code: "invalid_input",
      issues: expect.any(Array),
    });
    await expect(harness.callRpc("unexpose", redirected)).rejects.toMatchObject(
      {
        code: "invalid_input",
        issues: expect.any(Array),
      },
    );
  });

  it("keeps valid shares loaded when a host was removed and prunes orphaned shares without a host lookup", async () => {
    const { bb, harness } = await loadPlugin();
    await bb.storage.kv.set(SHARES_KV_KEY, {
      [`${SERVER_HOST_ID}:8000`]: {
        hostId: SERVER_HOST_ID,
        port: 8000,
        createdAt: 1,
      },
      "host-deleted:3000": {
        hostId: "host-deleted",
        port: 3000,
        createdAt: 2,
      },
      "host-deleted:4000": {
        hostId: "host-deleted",
        port: 4000,
        createdAt: 3,
      },
    });

    await expect(
      harness.callRpc("unexpose", { hostId: "host-deleted", port: 3000 }),
    ).resolves.toEqual({
      removed: true,
      hostId: "host-deleted",
      hostName: "removed host",
      port: 3000,
    });
    expect(await harness.callRpc("listShares")).toEqual(
      expect.arrayContaining([
        {
          hostId: SERVER_HOST_ID,
          hostName: SERVER_HOST_NAME,
          port: 8000,
          url: "http://127.0.0.1:8000",
          createdAt: 1,
        },
        expect.objectContaining({
          hostId: "host-deleted",
          hostName: "removed host",
          port: 4000,
          url: "",
          unavailableReason: expect.stringContaining("was removed"),
        }),
      ]),
    );
    const cliRemoval = await harness.runCli([
      "unexpose",
      "4000",
      "--host",
      "host-deleted",
    ]);
    expect(cliRemoval).toMatchObject({
      exitCode: 0,
      stdout: "Stopped sharing port 4000 on removed host (host-deleted)\n",
    });
    expect(await bb.storage.kv.get(SHARES_KV_KEY)).toEqual({
      [`${SERVER_HOST_ID}:8000`]: {
        hostId: SERVER_HOST_ID,
        port: 8000,
        createdAt: 1,
      },
    });
    expect(harness.sharedPortDeclarations).toEqual([
      { hostId: "host-deleted", ports: [] },
    ]);
  });

  it("unexposes a persisted machine share when its declaration update fails", async () => {
    host = createConnectFakeHost();
    const declarations = vi.fn((_hostId: string, _ports: readonly number[]) => {
      throw new Error("temporary declaration failure");
    });
    Object.defineProperty(host.bb.hosts, "declareSharedPorts", {
      value: declarations,
    });
    await plugin(host.bb as unknown as Parameters<typeof plugin>[0]);
    await host.bb.storage.kv.set(SHARES_KV_KEY, {
      [`${REMOTE_HOST_ID}:3000`]: {
        hostId: REMOTE_HOST_ID,
        port: 3000,
        createdAt: 1,
      },
    });

    await expect(
      host.harness.callRpc("unexpose", {
        hostId: REMOTE_HOST_ID,
        port: 3000,
      }),
    ).resolves.toEqual({
      removed: true,
      hostId: REMOTE_HOST_ID,
      hostName: REMOTE_HOST_NAME,
      port: 3000,
    });
    expect(declarations).toHaveBeenCalledWith(REMOTE_HOST_ID, []);
    expect(await host.bb.storage.kv.get(SHARES_KV_KEY)).toBeUndefined();
    expect(await host.harness.callRpc("listShares")).toEqual([]);
    expect(host.harness.sdk.callsTo("hosts.get")).toEqual(
      expect.arrayContaining([
        [expect.objectContaining({ hostId: REMOTE_HOST_ID })],
      ]),
    );
    expect(host.harness.logEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: expect.stringContaining(
            "failed to update shared ports after removing port 3000",
          ),
        }),
      ]),
    );
  });

  it("uses machine tunnel identity and declares per-host port sets", async () => {
    host = await loadSignedIn("http://sawyer.localhost:59333", {
      remoteIdentity: { label: "sawyer-air", baseDomain: "cloudroom.run" },
    });

    await expect(
      host.harness.callRpc("expose", { hostId: REMOTE_HOST_ID, port: 3000 }),
    ).resolves.toEqual({
      hostId: REMOTE_HOST_ID,
      hostName: REMOTE_HOST_NAME,
      port: 3000,
      url: "https://sawyer-air--3000.cloudroom.run",
      createdAt: expect.any(Number),
    });
    expect(host.harness.sharedPortDeclarations).toEqual([
      { hostId: REMOTE_HOST_ID, ports: [3000] },
    ]);

    await host.harness.callRpc("expose", {
      hostId: REMOTE_HOST_ID,
      port: 4000,
    });
    expect(host.harness.sharedPortDeclarations).toEqual([
      { hostId: REMOTE_HOST_ID, ports: [3000, 4000] },
    ]);

    await host.harness.callRpc("expose", { port: 3000 });
    expect(host.harness.sharedPortDeclarations).toEqual([
      { hostId: REMOTE_HOST_ID, ports: [3000, 4000] },
    ]);
    expect(
      ((await host.harness.callRpc("status")) as ConnectStatus).shares,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hostId: SERVER_HOST_ID, port: 3000 }),
        expect.objectContaining({ hostId: REMOTE_HOST_ID, port: 3000 }),
      ]),
    );

    await host.harness.callRpc("unexpose", {
      hostId: REMOTE_HOST_ID,
      port: 3000,
    });
    expect(host.harness.sharedPortDeclarations).toEqual([
      { hostId: REMOTE_HOST_ID, ports: [4000] },
    ]);
    await host.harness.callRpc("unexpose", {
      hostId: REMOTE_HOST_ID,
      port: 4000,
    });
    expect(host.harness.sharedPortDeclarations).toEqual([
      { hostId: REMOTE_HOST_ID, ports: [] },
    ]);
  });

  it("tells users to enroll a genuinely credentialless machine", async () => {
    host = await loadSignedIn("http://sawyer.localhost:59334", {
      beforeLoad: (current) =>
        Object.defineProperty(current.bb.hosts, "ensureSharedPortTunnel", {
          value: async () => {
            throw Object.assign(new Error("machine credential missing"), {
              body: { code: "connect_host_unenrolled" },
            });
          },
        }),
    });

    await expect(
      host.harness.callRpc("expose", {
        hostId: REMOTE_HOST_ID,
        port: 3000,
      }),
    ).rejects.toThrow(
      /Sawyer Air.*host-air.*Enroll it via Connect.*Settings > Machines/,
    );
    expect(await host.harness.callRpc("listShares")).toEqual([]);
    expect(host.harness.sharedPortDeclarations).toEqual([]);
  });

  it("tells users to bring an enrolled but offline machine online", async () => {
    host = await loadSignedIn("http://sawyer.localhost:59335", {
      beforeLoad: (current) =>
        Object.defineProperty(current.bb.hosts, "ensureSharedPortTunnel", {
          value: async () => {
            throw Object.assign(new Error("host is offline"), {
              body: { code: "connect_host_offline" },
            });
          },
        }),
    });

    let message = "";
    try {
      await host.harness.callRpc("expose", {
        hostId: REMOTE_HOST_ID,
        port: 3000,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(
      /Sawyer Air.*host-air.*not connected right now.*Bring the host online/,
    );
    expect(message).not.toMatch(/Enroll|remove and re-add/);
  });

  it("empties machine declarations when the user signs out", async () => {
    let accountId: string | null = "acc-1";
    host = await loadSignedIn("http://sawyer.localhost:59335", {
      remoteIdentity: { label: "sawyer-air", baseDomain: "cloudroom.run" },
      account: () => accountId,
    });
    await host.harness.callRpc("expose", {
      hostId: REMOTE_HOST_ID,
      port: 5173,
    });
    expect(host.harness.sharedPortDeclarations).toEqual([
      { hostId: REMOTE_HOST_ID, ports: [5173] },
    ]);

    accountId = null;
    const { controller, done } = host.harness.runService("tunnel");
    await vi.waitFor(() => {
      expect(host?.harness.sharedPortDeclarations).toEqual([
        { hostId: REMOTE_HOST_ID, ports: [] },
      ]);
    });
    controller.abort();
    await done;
    await stopTunnel(host);
    await host.harness.dispose();
    host = undefined;
  });

});

describe("connect CLI", () => {
  let host: FakePluginHost | undefined;

  afterEach(async () => {
    if (host) {
      const { controller, done } = host.harness.runService("tunnel");
      controller.abort();
      await done;
      await host.harness.dispose();
      host = undefined;
    }
    vi.unstubAllGlobals();
  });

  async function loadCli(): Promise<FakePluginHost> {
    host = createConnectFakeHost();
    await plugin(host.bb as unknown as Parameters<typeof plugin>[0]);
    return host;
  }

  it("bare `bb connect` prints a how-to, not an argument error", async () => {
    const { harness } = await loadCli();
    const result = await harness.runCli([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cloudroom.dev/m");
    expect(result.stdout).toContain("room-cli connect phone");
    expect(result.stdout).toContain("room-cli connect status");
    expect(result.stdout).toContain("room-cli connect expose");
  });

  it("`bb connect status` asks a signed-out user to sign in", async () => {
    const { harness } = await loadCli();
    const before = await harness.runCli(["status"]);
    expect(before.exitCode).toBe(0);
    expect(before.stdout).toContain("Sign in to Cloudroom to use it on your phone.");
  });

  it("unknown subcommands fail with help", async () => {
    const { harness } = await loadCli();
    const result = await harness.runCli(["bogus"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown connect command 'bogus'");
  });

  it("expose when unpaired errors clearly", async () => {
    const { harness } = await loadCli();
    const result = await harness.runCli(["expose", "8000"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Cloudroom Connect is not set up yet");
  });

  it("expose / shares / unexpose happy path", async () => {
    host = await loadSignedIn("http://sawyer.localhost:59331");
    const { harness } = host;

    const shareUrl = "http://sawyer--8000.localhost:59331";
    const exposed = await harness.runCli(["expose", "8000"]);
    expect(exposed.exitCode).toBe(0);
    expect(exposed.stdout).toContain(shareUrl);

    const shares = await harness.runCli(["shares"]);
    expect(shares.exitCode).toBe(0);
    expect(shares.stdout).toContain("8000");
    expect(shares.stdout).toContain(shareUrl);

    const status = await harness.runCli(["status"]);
    expect(status.stdout).toContain("shares:");
    expect(status.stdout).toContain("8000");

    const unexpose = await harness.runCli(["unexpose", "8000"]);
    expect(unexpose.exitCode).toBe(0);
    expect(unexpose.stdout).toContain("Stopped sharing port 8000");

    const again = await harness.runCli(["unexpose", "8000"]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("was not shared");

    const empty = await harness.runCli(["shares"]);
    expect(empty.stdout).toContain("No shared ports");
  });

  it("resolves the thread host, honors --host, and defaults no-context calls to the server host", async () => {
    host = await loadSignedIn("http://sawyer.localhost:59336", {
      remoteIdentity: { label: "sawyer-air", baseDomain: "cloudroom.run" },
    });
    host.harness.sdk.stub(
      "threads.get",
      async () => ({ environment: { hostId: REMOTE_HOST_ID } }) as never,
    );

    const fromThread = await host.harness.runCli(["expose", "3000"], {
      threadId: "thread-air",
    });
    expect(fromThread).toMatchObject({
      exitCode: 0,
      stdout: "https://sawyer-air--3000.cloudroom.run\n",
    });

    const overridden = await host.harness.runCli(
      ["expose", "3000", "--host", SERVER_HOST_NAME],
      { threadId: "thread-air" },
    );
    expect(overridden).toMatchObject({
      exitCode: 0,
      stdout: "http://sawyer--3000.localhost:59336\n",
    });

    const noContext = await host.harness.runCli(["expose", "3001"]);
    expect(noContext).toMatchObject({
      exitCode: 0,
      stdout: "http://sawyer--3001.localhost:59336\n",
    });

    const threadShares = await host.harness.runCli(["shares", "--json"], {
      threadId: "thread-air",
    });
    expect(JSON.parse(threadShares.stdout ?? "")).toEqual({
      host: {
        id: REMOTE_HOST_ID,
        name: REMOTE_HOST_NAME,
        isServer: false,
      },
      shares: [
        {
          hostId: REMOTE_HOST_ID,
          hostName: REMOTE_HOST_NAME,
          port: 3000,
          url: "https://sawyer-air--3000.cloudroom.run",
          createdAt: expect.any(Number),
        },
      ],
    });
    const serverShares = await host.harness.runCli(["shares"]);
    expect(serverShares.stdout).toContain(
      `${SERVER_HOST_NAME} (${SERVER_HOST_ID})  3000`,
    );
    expect(serverShares.stdout).toContain(
      `${SERVER_HOST_NAME} (${SERVER_HOST_ID})  3001`,
    );
    const status = await host.harness.runCli(["status"]);
    expect(status.stdout).toContain(
      `${REMOTE_HOST_NAME} (${REMOTE_HOST_ID})  3000  https://sawyer-air--3000.cloudroom.run`,
    );

    const removed = await host.harness.runCli(["unexpose", "3000"], {
      threadId: "thread-air",
    });
    expect(removed.stdout).toContain(
      `Stopped sharing port 3000 on ${REMOTE_HOST_NAME} (${REMOTE_HOST_ID})`,
    );
    expect(host.harness.sharedPortDeclarations).toEqual([
      { hostId: REMOTE_HOST_ID, ports: [] },
    ]);
  });
});
