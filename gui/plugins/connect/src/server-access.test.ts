import { COMPUTER } from "@cloudroom/domain/computer-name";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import {
  createServerAccessRecheck,
  registerServerAccess,
  type RelayAccess,
} from "./server-access.js";

const SERVER_URL = "https://test.cloudroom.run";
const request = {
  key: "launch-key",
  hostId: "host-air",
  signal: new AbortController().signal,
};
const key = "server-access-grant:host-air";
const hosts: FakePluginHost[] = [];

function fakeRelay() {
  const machines = new Set<string>();
  let failRevoke = false;
  let created = 0;
  const relay: RelayAccess & { machines: Set<string>; failRevoke(value: boolean): void } = {
    machines,
    failRevoke: (value) => {
      failRevoke = value;
    },
    status: () => ({ paired: true, url: SERVER_URL }),
    call: vi.fn(async (path: string, body: unknown) => {
      if (path === "/api/machines") {
        created += 1;
        const machineId = `machine-${created}`;
        machines.add(machineId);
        return { machineId, credential: `secret-${created}`, serverUrl: SERVER_URL };
      }
      expect(path).toBe("/api/machines/revoke");
      if (failRevoke) throw new Error("Cloudroom Connect returned HTTP 503.");
      machines.delete((body as { machineId: string }).machineId);
      return { ok: true };
    }),
  };
  return relay;
}

async function setup(relay: RelayAccess) {
  const host = createFakePluginHost({ pluginId: "connect" });
  hosts.push(host);
  await registerServerAccess(host.bb, relay);
  return host;
}

function provider(host: FakePluginHost) {
  const found = host.harness.registrations.serverAccessProviders.get("connect");
  if (!found) throw new Error("Missing provider");
  return found;
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

describe("Connect remote host access", () => {
  it("adds one remote host per machine on our relay, keeps it across restarts, and revokes it on release", async () => {
    const relay = fakeRelay();
    const original = await setup(relay);
    expect(provider(original).description).toBe(`Use this ${COMPUTER}'s private cloudroom.run address.`);
    const grant = await provider(original).acquire(request);
    expect(grant).toEqual({
      id: request.hostId,
      serverUrl: SERVER_URL,
      headers: { "x-bb-connect-machine": "secret-1" },
    });
    const restarted = await original.harness.lifecycle.reload((bb) => registerServerAccess(bb, relay));
    hosts.push(restarted);
    expect(await provider(restarted).acquire(request)).toEqual(grant);
    expect(relay.machines).toEqual(new Set(["machine-1"]));

    await provider(restarted).release({ key: request.key, hostId: request.hostId, grantId: request.hostId });
    expect(relay.machines.size).toBe(0);
    expect(await restarted.bb.storage.kv.get(key)).toBeUndefined();
  });

  it("replaces a grant for an old address, such as a getbb.app pairing", async () => {
    const relay = fakeRelay();
    const host = await setup(relay);
    await host.bb.storage.kv.set(key, {
      result: {
        connectMachineId: "bb-machine",
        grant: { id: request.hostId, serverUrl: "https://david-room.getbb.app", headers: {} },
      },
    });
    const grant = await provider(host).acquire(request);
    expect(grant).toMatchObject({ serverUrl: SERVER_URL });
    expect(relay.machines).toEqual(new Set(["machine-1"]));
  });

  it("keeps the record when the relay can't revoke yet, so removal retries", async () => {
    const relay = fakeRelay();
    const host = await setup(relay);
    await provider(host).acquire(request);
    relay.failRevoke(true);
    await expect(
      provider(host).release({ key: request.key, hostId: request.hostId, grantId: request.hostId }),
    ).rejects.toThrow("HTTP 503");
    expect(await host.bb.storage.kv.get(key)).toMatchObject({ result: { connectMachineId: "machine-1" } });
    relay.failRevoke(false);
    await provider(host).release({ key: request.key, hostId: request.hostId, grantId: request.hostId });
    expect(relay.machines.size).toBe(0);
  });
});

describe("server access recheck", () => {
  it("tells core only when signed-in state or address changes", async () => {
    const host = await setup(fakeRelay());
    const recheck = createServerAccessRecheck(host.bb);
    recheck({ paired: false, url: null });
    recheck({ paired: false, url: null });
    expect(host.harness.recheckCount).toBe(0);
    recheck({ paired: true, url: SERVER_URL });
    recheck({ paired: true, url: SERVER_URL });
    expect(host.harness.recheckCount).toBe(1);
    recheck({ paired: false, url: null });
    expect(host.harness.recheckCount).toBe(2);
  });
});
