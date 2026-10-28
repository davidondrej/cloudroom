import { COMPUTER } from "@cloudroom/domain/computer-name";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const MACHINE_CREDENTIAL_HEADER = "x-bb-connect-machine";

const storedSchema = z.object({
  result: z.object({
    connectMachineId: z.string().min(1),
    grant: z.object({
      id: z.string().min(1),
      serverUrl: z.string().url(),
      headers: z.record(z.string(), z.string()),
    }),
  }),
});

const machineSchema = z.object({
  machineId: z.string().min(1),
  credential: z.string().min(1),
  serverUrl: z.string().url(),
});

export interface RelayAccess {
  call(path: string, body: unknown): Promise<unknown>;
  status(): { paired: boolean; url: string | null };
}

export function createServerAccessRecheck(
  bb: BbPluginApi,
): (status: { paired: boolean; url: string | null }) => void {
  let last: string | null = null;
  return (status) => {
    const signature = `${status.paired}:${status.url ?? ""}`;
    const changed = last !== null && last !== signature;
    last = signature;
    if (changed) bb.experimental_serverAccess.recheck();
  };
}

function grantKey(hostId: string): string {
  return `server-access-grant:${hostId}`;
}

export async function registerServerAccess(bb: BbPluginApi, relay: RelayAccess) {
  let queue = Promise.resolve();
  function serialized<T>(action: () => Promise<T>): Promise<T> {
    const result = queue.then(action);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async function load(hostId: string) {
    const parsed = storedSchema.safeParse(await bb.storage.kv.get<unknown>(grantKey(hostId)));
    return parsed.success ? parsed.data.result : undefined;
  }
  bb.experimental_serverAccess.register({
    id: "connect",
    displayName: "Cloudroom Connect",
    description: `Use this ${COMPUTER}'s private cloudroom.run address.`,
    availability: () => {
      const status = relay.status();
      return status.paired
        ? {
            status: "available",
            ...(status.url ? { serverUrl: status.url } : {}),
          }
        : {
            status: "setup-required",
            message: `Sign in to Cloudroom so other machines can reach this ${COMPUTER}`,
          };
    },
    acquire({ hostId, signal }) {
      return serialized(async () => {
        signal.throwIfAborted();
        const existing = await load(hostId);
        if (existing && existing.grant.serverUrl === relay.status().url) return existing.grant;
        const machine = machineSchema.parse(await relay.call("/api/machines", {}));
        const grant = {
          id: hostId,
          serverUrl: machine.serverUrl,
          headers: { [MACHINE_CREDENTIAL_HEADER]: machine.credential },
        };
        await bb.storage.kv.set(grantKey(hostId), {
          result: { connectMachineId: machine.machineId, grant },
        });
        return grant;
      });
    },
    release({ hostId }) {
      return serialized(async () => {
        const stored = await load(hostId);
        if (stored) {
          await relay.call("/api/machines/revoke", { machineId: stored.connectMachineId });
        }
        await bb.storage.kv.delete(grantKey(hostId));
      });
    },
  });
}
