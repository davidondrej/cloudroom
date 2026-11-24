import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { experimental_createHostUsageSource } from "@get-bb/plugin-sdk/provider-usage";
import * as contract from "./usage-contract.js";

export function registerUsageSource(room: BbPluginApi) {
  const source = experimental_createHostUsageSource(
    room,
    { pluginId: "provider-codex", providerId: "codex" },
    contract,
  );
  room.rpc.register(
    contract.usageSourceRpcContract,
    {
      [contract.usageListMethod]: source.listResources,
      [contract.usageFetchMethod]: source.getResource,
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Host-local usage owned by the codex provider plugin. Inventory reads metadata only. Independent of display plugins.",
    },
  );
}
