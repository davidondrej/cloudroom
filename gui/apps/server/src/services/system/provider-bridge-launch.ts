import { getAppSettings } from "@cloudroom/db";
import { type HostDaemonBridgeLaunch } from "@cloudroom/host-daemon-contract";
import { ApiError } from "../../errors.js";
import type { ProviderRegistration } from "../providers/provider-registry.js";
import type { AppDeps } from "../../types.js";

export function resolveBridgeLaunchForProviderId(
  deps: Pick<AppDeps, "providerRegistry" | "pluginHostArtifacts"> & Partial<Pick<AppDeps, "db">>,
  providerId: string,
): HostDaemonBridgeLaunch | null {
  const registration = deps.providerRegistry.get(providerId);
  if (registration === null) {
    return null;
  }
  const source = resolveBridgeSource(deps, registration);
  if (source === null) {
    return null;
  }
  const pluginId = registration.pluginId;
  const {
    supportsServiceTier,
    supportsThreadArchive,
    supportsThreadRename,
    permissionModes,
  } = registration.info.capabilities;
  const fork = registration.serverCapabilities.fork;
  return {
    pluginId,
    source,
    providerOptions: {
      ...registration.bridgeOptions,
      commandGuardEnabled: deps.db ? getAppSettings(deps.db).commandGuardEnabled : true,
      stripAiCoAuthorsEnabled: deps.db ? getAppSettings(deps.db).stripAiCoAuthorsEnabled : true,
    },
    envPassthrough: [...registration.envPassthrough],
    capabilities: {
      providerInstallation: registration.info.maintenance.installation,
      supportsServiceTier,
      supportsThreadArchive,
      supportsThreadRename,
      permissionModes: [...permissionModes],
      fork,
    },
  };
}

export function requireBridgeLaunchForProviderId(
  deps: Pick<AppDeps, "providerRegistry" | "pluginHostArtifacts"> & Partial<Pick<AppDeps, "db">>,
  providerId: string,
): HostDaemonBridgeLaunch {
  const bridgeLaunch = resolveBridgeLaunchForProviderId(deps, providerId);
  if (bridgeLaunch === null) {
    throw new ApiError(
      409,
      "provider_bridge_unavailable",
      `Provider "${providerId}" has no bridge to run on. Its plugin may be disabled or still building.`,
    );
  }
  return bridgeLaunch;
}

function resolveBridgeSource(
  deps: Pick<AppDeps, "pluginHostArtifacts">,
  registration: ProviderRegistration,
): HostDaemonBridgeLaunch["source"] | null {
  const artifact = deps.pluginHostArtifacts.get(registration.pluginId);
  if (artifact === undefined) {
    return null;
  }
  return {
    kind: "artifact",
    digest: artifact.digest,
    byteLength: artifact.byteLength,
  };
}
