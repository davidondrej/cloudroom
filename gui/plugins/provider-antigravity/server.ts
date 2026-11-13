import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  ANTIGRAVITY_PROVIDER_ID,
  antigravityProviderDeclaration,
} from "./src/declaration.js";
import {
  antigravityLoginHostContract,
  antigravityLoginRpcContract,
} from "./src/login-contract.js";
import { registerUsageSource } from "./src/usage-source.js";

export default function plugin(room: BbPluginApi): void {
  registerUsageSource(room);
  // The provider skill is only useful in this provider's own threads.
  room.agents.configure(({ provider }) => ({
    tools: [],
    skills:
      provider.id === ANTIGRAVITY_PROVIDER_ID ? ["antigravity-provider"] : [],
  }));
  const host = room.hosts.experimental_client({
    contract: antigravityLoginHostContract,
  });
  // Google sign-in and sign-out for the CLI on one machine, for the app's Connect button.
  room.rpc.register(antigravityLoginRpcContract, {
    async antigravityAccount({ hostId, environmentId, ...input }) {
      const target = environmentId
        ? (await room.sdk.environments.get({ environmentId })).hostId
        : (hostId ?? (await room.sdk.system.config()).primaryHostId);
      if (!target) throw new Error("No local machine is connected.");
      return {
        ...(await host.call("account", input, { hostId: target })),
        host_id: target,
      };
    },
  });
  const registered = room.providers.register(antigravityProviderDeclaration());
  room.onDispose(() => {
    registered.dispose();
  });
}
