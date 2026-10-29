import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { AgentEnvironment, PermissionMode } from "./rpc-types.js";

type ProviderPermissionApi = {
  sdk: {
    providers: Pick<BbPluginApi["sdk"]["providers"], "list">;
  };
};

type ProviderRouting = NonNullable<
  Parameters<ProviderPermissionApi["sdk"]["providers"]["list"]>[0]
>;

export function providerRoutingForEnvironment(
  environment: AgentEnvironment,
): ProviderRouting {
  if (environment.type === "reuse") {
    return { environmentId: environment.environmentId };
  }
  if (environment.type === "host" && environment.hostId !== undefined) {
    return { hostId: environment.hostId };
  }
  return {};
}

export async function resolvePermissionMode(
  bb: ProviderPermissionApi,
  providerId: string,
  requested: PermissionMode | undefined,
  routing: ProviderRouting = {},
): Promise<PermissionMode> {
  const providers = await bb.sdk.providers.list(routing);
  const provider = providers.find((candidate) => candidate.id === providerId);
  if (provider === undefined || provider.available === false) {
    throw new Error(`Provider ${providerId} is not available.`);
  }
  if (
    requested !== undefined &&
    !provider.capabilities.permissionModes.includes(requested)
  ) {
    throw new Error(
      `Permission mode ${requested} is not supported by provider ${providerId}.`,
    );
  }
  if (requested !== undefined) return requested;
  if (provider.capabilities.permissionModes.includes("auto")) {
    return "auto";
  }
  if (provider.capabilities.permissionModes.includes("full")) {
    return "full";
  }
  throw new Error(
    `Provider ${providerId} has no supported default permission mode.`,
  );
}

export async function requireReasoningLevel(
  bb: ProviderPermissionApi,
  providerId: string,
  reasoningLevel: string,
  routing: ProviderRouting = {},
): Promise<void> {
  const providers = await bb.sdk.providers.list(routing);
  const supported =
    providers
      .find((candidate) => candidate.id === providerId)
      ?.reasoningLevels?.map(({ id }) => id) ?? [];
  if (supported.length > 0 && !supported.includes(reasoningLevel)) {
    throw new Error(
      `Reasoning level ${reasoningLevel} is not supported by provider ${providerId}. Supported: ${supported.join(", ")}.`,
    );
  }
}

export async function requireServiceTier(
  bb: ProviderPermissionApi,
  providerId: string,
  serviceTier: string | undefined,
  routing: ProviderRouting = {},
): Promise<void> {
  if (serviceTier === undefined || serviceTier === "default") return;
  const providers = await bb.sdk.providers.list(routing);
  const provider = providers.find((candidate) => candidate.id === providerId);
  if (provider?.capabilities.supportsServiceTier === false) {
    throw new Error(
      `Service tier ${serviceTier} is not supported by provider ${providerId}. Clear it with --service-tier none.`,
    );
  }
}
