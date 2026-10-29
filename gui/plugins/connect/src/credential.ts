import { connectCredentialSchema } from "@cloudroom/connect-client";
import type { ConnectCredential } from "@cloudroom/connect-client";
import type { PluginKvStorage } from "@get-bb/plugin-sdk";

export interface CredentialStore {
  read(): Promise<ConnectCredential | null>;
  write(value: ConnectCredential): Promise<void>;
  clear(): Promise<void>;
}

export function createKvCredentialStore(
  kv: Pick<PluginKvStorage, "get" | "set" | "delete">,
  key: string,
): CredentialStore {
  return {
    async read() {
      const raw = await kv.get<unknown>(key);
      if (raw === undefined) return null;
      const parsed = connectCredentialSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    },
    async write(value) {
      await kv.set(key, value);
    },
    async clear() {
      await kv.delete(key);
    },
  };
}
