import type {
  SystemExecutionOptionsResponse,
  SystemProviderInfo,
  SystemProvidersQuery,
} from "@cloudroom/server-contract";
import {
  readExecutionOptions,
  signalRequestArgs,
  type CreateSdkAreaArgs,
} from "./common.js";

export type ProviderHostRoutingArgs =
  | { environmentId: string; hostId?: never }
  | { environmentId?: never; hostId: string }
  | { environmentId?: never; hostId?: never };

export type ProviderListArgs = ProviderHostRoutingArgs & {
  capability?: SystemProvidersQuery["capability"];
  signal?: AbortSignal;
};
export type ProviderInstallableArgs = ProviderHostRoutingArgs & {
  signal?: AbortSignal;
};
export type ProviderModelsArgs = ProviderHostRoutingArgs & {
  providerId?: string;
  signal?: AbortSignal;
};

export type ProviderRestartModelDiscoveryArgs = ProviderHostRoutingArgs & {
  providerId: string;
  signal?: AbortSignal;
};

export type ProviderListResult = SystemProviderInfo[];
export type ProviderModelsResult = SystemExecutionOptionsResponse;

export interface ProvidersArea {
  list(args?: ProviderListArgs): Promise<ProviderListResult>;
  installable(args?: ProviderInstallableArgs): Promise<ProviderListResult>;
  models(args?: ProviderModelsArgs): Promise<ProviderModelsResult>;
  restartModelDiscovery(
    args: ProviderRestartModelDiscoveryArgs,
  ): Promise<ProviderModelsResult>;
}

export function createProvidersArea(args: CreateSdkAreaArgs): ProvidersArea {
  const { transport } = args;
  return {
    async list(input = {}) {
      return transport.readJson(
        transport.api.v1.system.providers.$get(
          {
            query: {
              capability: input.capability,
              environmentId: input.environmentId,
              hostId: input.hostId,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async installable(input = {}) {
      return transport.readJson(
        transport.api.v1.system.providers.installable.$get(
          {
            query: {
              environmentId: input.environmentId,
              hostId: input.hostId,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async models(input = {}) {
      return readExecutionOptions(transport, input);
    },
    async restartModelDiscovery(input) {
      return transport.readJson(
        transport.api.v1.system["execution-options"].restart.$post(
          {
            json: {
              providerId: input.providerId,
              hostId: input.hostId,
              environmentId: input.environmentId,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
  };
}
