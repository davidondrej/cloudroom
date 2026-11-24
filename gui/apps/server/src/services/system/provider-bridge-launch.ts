import { getAppSettings, getHost } from "@cloudroom/db";
import { type HostDaemonBridgeLaunch } from "@cloudroom/host-daemon-contract";
import { ApiError } from "../../errors.js";
import { readPrimaryHostIdFromDataDir } from "../hosts/primary-host.js";
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
  deps: Pick<AppDeps, "config" | "providerRegistry" | "pluginHostArtifacts"> &
    Partial<Pick<AppDeps, "db">>,
  providerId: string,
  hostId?: string,
): HostDaemonBridgeLaunch {
  const bridgeLaunch = resolveBridgeLaunchForProviderId(deps, providerId);
  if (bridgeLaunch === null) {
    throw new ApiError(
      409,
      "provider_bridge_unavailable",
      `Provider "${providerId}" has no bridge to run on. Its plugin may be disabled or still building.`,
    );
  }
  if (hostId !== undefined) assertLaunchRunsOnHost(deps, providerId, hostId);
  return bridgeLaunch;
}

function launchesServerBinary(registration: ProviderRegistration): boolean {
  const spec = registration.bridgeOptions.acpLaunchSpec;
  return (
    typeof spec === "object" &&
    spec !== null &&
    !Array.isArray(spec) &&
    spec.command === process.execPath
  );
}

/**
 * A plugin may start its ACP agent with this server's own executable (the
 * community Devin plugin does). That path exists only on this computer, so on
 * another machine the agent failed with a bare `spawn ... ENOENT` (#1884).
 */
function assertLaunchRunsOnHost(
  deps: Pick<AppDeps, "config" | "providerRegistry"> &
    Partial<Pick<AppDeps, "db">>,
  providerId: string,
  hostId: string,
): void {
  const registration = deps.providerRegistry.get(providerId);
  if (registration === null || !launchesServerBinary(registration)) return;
  const thisComputer = readPrimaryHostIdFromDataDir({
    dataDir: deps.config.dataDir,
  });
  if (thisComputer === null || thisComputer === hostId) return;
  const { displayName } = registration.info;
  const machine = (deps.db && getHost(deps.db, hostId)?.name) || hostId;
  const other = deps.providerRegistry
    .list()
    .find(
      (candidate) =>
        candidate.info.displayName === displayName &&
        candidate.info.id !== providerId &&
        !launchesServerBinary(candidate),
    );
  throw new ApiError(
    409,
    "provider_unavailable_on_host",
    `${displayName} (provider "${providerId}") can't start on ${machine}: its plugin (${registration.pluginId}) runs the agent with this computer's Cloudroom app (${process.execPath}), which only exists here. ` +
      (other
        ? `Use provider "${other.info.id}" there instead.`
        : "Start it on this computer, or pick a provider that runs on that machine."),
  );
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
