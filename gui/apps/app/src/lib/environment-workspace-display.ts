import type { Host } from "@cloudroom/domain";
import type {
  EnvironmentDisplayInfo,
  EnvironmentDisplayProviderLookup,
} from "@cloudroom/core-ui";
import { resolveEnvironmentDisplayProvider } from "@cloudroom/core-ui";
import type { SystemEnvironmentProvider } from "@cloudroom/server-contract";
import type { IconName } from "@cloudroom/shared-ui/icon";
import { cloudroomEnvironmentPresentation } from "@/lib/cloudroom-environment-label";
import { pluginIconName } from "@/components/plugin/PluginIcon";
import { PersistentHostIconName } from "@/lib/host-display";
import type { MachineLabelHost } from "@/components/machines/MachineLabel";
import type { MachineProviderPresentation } from "@/components/plugin/MachineProviderIcon";

export type EnvironmentWorkspaceDisplayProviderLookup =
  | { status: "loading" }
  | {
      status: "loaded";
      provider: SystemEnvironmentProvider | null;
      environmentProviderId: string | null;
    };

export type EnvironmentSummaryChromeHost = MachineLabelHost;

export const UNNAMED_ENVIRONMENT_LABEL = "Environment";
export const REUSE_ENVIRONMENT_ICON_NAME: IconName = "Folder02";

export function isHostAmbiguous(
  hasMultipleMachines: boolean,
  hostType: Host["type"] | null,
): boolean {
  return hasMultipleMachines || hostType !== "persistent";
}

interface EnvironmentWorkspaceLabelArgs {
  display: EnvironmentDisplayInfo;
  providerLookup: EnvironmentWorkspaceDisplayProviderLookup;
  environmentName: string | null;
}

interface EnvironmentWorkspaceSummaryDisplayArgs extends EnvironmentWorkspaceLabelArgs {
  hostType: Host["type"] | null;
  hasMultipleMachines: boolean;
  hostName: string | null;
}

interface EnvironmentWorkspaceSummaryDisplay {
  label: string;
  compactLabel: string;
  icon: IconName;
  providerName: string | null;
}

interface EnvironmentWorkspaceInfoDisplayArgs extends EnvironmentWorkspaceLabelArgs {
  hostName: string | null;
}

interface EnvironmentWorkspaceInfoDisplay {
  label: string;
  icon: IconName;
  machineName: string | null;
}

export function findEnvironmentDisplayProvider(
  providers: readonly SystemEnvironmentProvider[] | undefined,
  environmentProviderId: string | null,
): EnvironmentWorkspaceDisplayProviderLookup {
  if (environmentProviderId === null) {
    return { status: "loaded", provider: null, environmentProviderId: null };
  }
  if (providers === undefined) {
    return { status: "loading" };
  }
  return {
    status: "loaded",
    environmentProviderId,
    provider:
      providers.find((candidate) => candidate.id === environmentProviderId) ??
      null,
  };
}

export function getEnvironmentProviderDisplayName(
  providerLookup: EnvironmentWorkspaceDisplayProviderLookup,
): string | null {
  if (providerLookup.status === "loading") return null;
  if (providerLookup.provider !== null) {
    return providerLookup.provider.displayName;
  }
  return providerLookup.environmentProviderId === null
    ? null
    : `${providerLookup.environmentProviderId} (not installed)`;
}

function localCloudroomPresentation(
  providerLookup: EnvironmentWorkspaceDisplayProviderLookup,
) {
  if (providerLookup.status !== "loaded" || providerLookup.provider === null) {
    return null;
  }
  return cloudroomEnvironmentPresentation(providerLookup.provider.id, "local");
}

function getEnvironmentWorkspaceLabel({
  display,
  providerLookup,
  environmentName,
}: EnvironmentWorkspaceLabelArgs): string {
  if (display.lifecycle === "provisioning") return "Provisioning";
  if (display.lifecycle === "destroyed") return "Destroyed";
  if (environmentName !== null) return environmentName;
  return (
    localCloudroomPresentation(providerLookup)?.label ??
    getEnvironmentProviderDisplayName(providerLookup) ??
    display.compactModeLabel
  );
}

export function getEnvironmentWorkspaceSummaryDisplay({
  display,
  providerLookup,
  environmentName,
  hasMultipleMachines,
  hostType,
  hostName,
}: EnvironmentWorkspaceSummaryDisplayArgs): EnvironmentWorkspaceSummaryDisplay | null {
  if (display.lifecycle === "provisioning") {
    return {
      label: "Provisioning",
      compactLabel: "Provisioning",
      icon: "Loading",
      providerName: null,
    };
  }
  if (display.lifecycle === "destroyed") {
    return {
      label: "Destroyed",
      compactLabel: "Destroyed",
      icon: getEnvironmentLabelIconName(providerLookup),
      providerName: getEnvironmentProviderDisplayName(providerLookup),
    };
  }
  if (environmentName !== null) {
    return {
      label: environmentName,
      compactLabel: environmentName,
      icon: getEnvironmentLabelIconName(providerLookup),
      providerName: getEnvironmentProviderDisplayName(providerLookup),
    };
  }
  if (providerLookup.status === "loading") {
    return null;
  }
  if (isHostAmbiguous(hasMultipleMachines, hostType) && hostName !== null) {
    return {
      label: hostName,
      compactLabel: hostName,
      icon: getEnvironmentLabelIconName(providerLookup),
      providerName: getEnvironmentProviderDisplayName(providerLookup),
    };
  }
  const providerDisplayName = getEnvironmentProviderDisplayName(providerLookup);
  const canonical = localCloudroomPresentation(providerLookup);
  const label = canonical?.label ?? providerDisplayName;
  return label === null
    ? null
    : {
        label,
        compactLabel: label,
        icon: canonical?.icon ?? getEnvironmentLabelIconName(providerLookup),
        providerName: label,
      };
}

export function getEnvironmentWorkspaceInfoDisplay({
  display,
  providerLookup,
  environmentName,
  hostName,
}: EnvironmentWorkspaceInfoDisplayArgs): EnvironmentWorkspaceInfoDisplay {
  return {
    label: getEnvironmentWorkspaceLabel({
      display,
      providerLookup,
      environmentName,
    }),
    icon:
      localCloudroomPresentation(providerLookup)?.icon ??
      getEnvironmentLabelIconName(providerLookup),
    machineName: hostName,
  };
}

export function getEnvironmentDisplayIconName(
  providerLookup: EnvironmentDisplayProviderLookup,
): IconName | null {
  const provider = resolveEnvironmentDisplayProvider(providerLookup);
  return provider === null ? null : pluginIconName(provider.icon);
}

export function getEnvironmentLabelIconName(
  providerLookup: EnvironmentDisplayProviderLookup,
): IconName {
  return (
    getEnvironmentDisplayIconName(providerLookup) ?? PersistentHostIconName
  );
}

interface EnvironmentSummaryChromeArgs extends EnvironmentWorkspaceLabelArgs {
  hasMultipleMachines: boolean;
  host: EnvironmentSummaryChromeHost | null;
  machineProviders: readonly MachineProviderPresentation[] | undefined;
}

interface EnvironmentSummaryChrome {
  environmentLabel: string | undefined;
  environmentCompactLabel: string | undefined;
  environmentIcon: IconName | undefined;
  environmentProviderName: string | undefined;
  environmentHost: EnvironmentSummaryChromeHost | undefined;
  environmentMachineProvider: MachineProviderPresentation | undefined;
}

export function getEnvironmentSummaryChrome({
  display,
  providerLookup,
  environmentName,
  hasMultipleMachines,
  host,
  machineProviders,
}: EnvironmentSummaryChromeArgs): EnvironmentSummaryChrome {
  const summary = getEnvironmentWorkspaceSummaryDisplay({
    display,
    providerLookup,
    environmentName,
    hasMultipleMachines,
    hostName: host?.name ?? null,
    hostType: host?.type ?? null,
  });
  const summaryHost =
    host !== null && environmentName === null && summary?.label === host.name
      ? host
      : undefined;
  return {
    environmentLabel: summary?.label,
    environmentCompactLabel: summary?.compactLabel,
    environmentIcon: summary?.icon,
    environmentProviderName: summary?.providerName ?? undefined,
    environmentHost: summaryHost,
    environmentMachineProvider: machineProviders?.find(
      (provider) => provider.id === summaryHost?.machineProviderId,
    ),
  };
}
