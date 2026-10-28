import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ProviderInfo } from "@cloudroom/domain";
import type { ProviderCliKey } from "@cloudroom/host-daemon-contract";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@cloudroom/shared-ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cloudroom/shared-ui/tooltip";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  hasProviderCliAction,
  useProviderCliInstallRunner,
  type ProviderCliIssue,
} from "@/components/provider-cli/provider-cli-install";
import { providerCliJobKey } from "@/components/provider-cli/provider-cli-install-store";
import { SidebarMenuItem } from "@/components/ui/sidebar.js";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { useUpdateInventory } from "@/hooks/useUpdateInventory";
import { ProviderIconMark } from "@/components/settings/ProviderIconMark";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { getSettingsRoutePath } from "@/lib/route-paths";

interface SidebarUpdatesBadgeProps {
  onNavigate?: () => void;
}

const CHIP_CLASS = cn(
  "flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-sidebar-border px-2",
  "text-xs font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent",
);

function joinNames(names: string[]): string {
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

interface ProviderUpdateEntry {
  hostId: string;
  hostName: string;
  issue: ProviderCliIssue;
}

function ProviderMark({
  providerId,
  providers,
  className,
}: {
  providerId: ProviderCliKey;
  providers: ProviderInfo[] | undefined;
  className: string;
}) {
  const provider = providers?.find((candidate) => candidate.id === providerId);
  const iconInfo = getProviderIconInfo("agent", providerId, provider ?? null);
  if (iconInfo === undefined) {
    return null;
  }
  return (
    <span
      data-provider-icon={providerId}
      aria-hidden
      className={cn("flex shrink-0 items-center justify-center", className)}
    >
      {provider === undefined ? (
        <iconInfo.icon className={className} />
      ) : (
        <ProviderIconMark
          provider={provider}
          icon={iconInfo.icon}
          className={className}
        />
      )}
    </span>
  );
}

export function SidebarUpdatesBadge({ onNavigate }: SidebarUpdatesBadgeProps) {
  const inventory = useUpdateInventory();
  const providers = useSystemProviders().data;
  const { failuresByJobKey, queuedJobKeys, runningJobKey, startInstall } =
    useProviderCliInstallRunner();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const stuckDaemonCount = inventory.machines.filter(
    (machine) => machine.canRetryDaemonUpdate,
  ).length;
  const bbUpdateCount =
    (inventory.appUpdateAvailable ? 1 : 0) +
    (inventory.desktopUpdateReady || inventory.desktopInfo?.updateAvailable
      ? 1
      : 0) +
    stuckDaemonCount;

  const entries: ProviderUpdateEntry[] = inventory.machines.flatMap((machine) =>
    machine.issues
      .filter((issue) => issue.status.installed)
      .map((issue) => ({
        hostId: machine.host.id,
        hostName: machine.host.name,
        issue,
      })),
  );
  const staleProviders = [
    ...new Map(
      entries.map(({ issue }) => [issue.provider, issue.status.displayName]),
    ),
  ].map(([provider, displayName]) => ({ provider, displayName }));
  const isBusy = (entry: ProviderUpdateEntry) => {
    const jobKey = providerCliJobKey(entry.hostId, entry.issue.provider);
    return runningJobKey === jobKey || queuedJobKeys.has(jobKey);
  };
  const providerUpdateRunning = entries.some(
    (entry) =>
      runningJobKey === providerCliJobKey(entry.hostId, entry.issue.provider),
  );
  const idleActionable = entries.filter(
    (entry) => hasProviderCliAction(entry.issue) && !isBusy(entry),
  );
  const showHostNames = new Set(entries.map((entry) => entry.hostId)).size > 1;

  if (bbUpdateCount === 0 && staleProviders.length === 0) {
    return null;
  }

  const updatesRoutePath = getSettingsRoutePath("updates");
  const bbLabel =
    bbUpdateCount === 1 ? "Cloudroom update available" : "Cloudroom updates available";
  const providerLabel = `${joinNames(
    staleProviders.map((stale) => stale.displayName),
  )} ${staleProviders.length === 1 ? "update" : "updates"} available`;

  function updateEntry(entry: ProviderUpdateEntry): void {
    if (hasProviderCliAction(entry.issue)) {
      startInstall({ hostId: entry.hostId, issue: entry.issue });
    }
  }

  function openSettings(): void {
    setOpen(false);
    onNavigate?.();
    void navigate(getSettingsRoutePath("providers"));
  }

  return (
    <SidebarMenuItem className="flex min-w-0 items-center gap-1">
      {bbUpdateCount > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to={updatesRoutePath}
              onClick={onNavigate}
              aria-label={bbLabel}
              data-testid="sidebar-updates-badge-bb"
              className={CHIP_CLASS}
            >
              <Icon name="Download" className="size-3 text-muted-foreground" />
              Cloudroom
            </Link>
          </TooltipTrigger>
          <TooltipContent side="top">{bbLabel}</TooltipContent>
        </Tooltip>
      ) : null}
      {staleProviders.length > 0 ? (
        <Popover open={open} onOpenChange={setOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={providerLabel}
                  data-testid="sidebar-updates-badge-providers"
                  className={cn(CHIP_CLASS, "data-[state=open]:bg-sidebar-accent")}
                >
                  <Icon
                    name={providerUpdateRunning ? "Loading" : "Download"}
                    className={cn(
                      "size-3 text-muted-foreground",
                      providerUpdateRunning && "animate-spin",
                    )}
                  />
                  <span className="flex items-center gap-1">
                    {staleProviders.map((stale) => (
                      <ProviderMark
                        key={stale.provider}
                        providerId={stale.provider}
                        providers={providers}
                        className="size-3"
                      />
                    ))}
                  </span>
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">{providerLabel}</TooltipContent>
          </Tooltip>
          <PopoverContent
            side="top"
            align="start"
            sideOffset={6}
            mobileTitle="Provider updates"
            aria-label="Provider updates"
            className="w-72 p-0"
          >
            <p className="px-3 pt-3 pb-1 text-sm font-medium">
              Provider updates
            </p>
            <ul className="px-1 pb-1">
              {entries.map((entry) => {
                const { issue } = entry;
                const jobKey = providerCliJobKey(entry.hostId, issue.provider);
                const failed =
                  failuresByJobKey.get(jobKey)?.issueFingerprint ===
                  issue.fingerprint;
                return (
                  <li
                    key={jobKey}
                    data-testid="sidebar-provider-update-row"
                    className="flex items-center gap-2.5 rounded-md px-2 py-2"
                  >
                    <ProviderMark
                      providerId={issue.provider}
                      providers={providers}
                      className="size-4"
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">
                        {issue.status.displayName}
                        {showHostNames ? (
                          <span className="text-muted-foreground">
                            {" "}
                            · {entry.hostName}
                          </span>
                        ) : null}
                      </span>
                      <span className="truncate text-2xs text-muted-foreground">
                        {issue.status.currentVersion ?? "unknown"}
                        {issue.status.latestVersion === null ? null : (
                          <>
                            <span className="px-1">→</span>
                            <span className="font-semibold text-version-upgrade">
                              {issue.status.latestVersion}
                            </span>
                          </>
                        )}
                      </span>
                    </span>
                    {isBusy(entry) ? (
                      <Icon
                        name="Loading"
                        aria-label={`Updating ${issue.status.displayName}`}
                        className="size-4 animate-spin text-muted-foreground"
                      />
                    ) : hasProviderCliAction(issue) ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-xs"
                        onClick={() => updateEntry(entry)}
                      >
                        {failed ? "Retry" : issue.action.label}
                      </Button>
                    ) : (
                      <span className="text-2xs text-muted-foreground">
                        Update manually
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="flex items-center justify-between border-t px-2 py-2">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
                onClick={openSettings}
              >
                <Icon name="Settings" className="size-3.5" />
                Settings
              </Button>
              {idleActionable.length > 1 ? (
                <Button
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  onClick={() => idleActionable.forEach(updateEntry)}
                >
                  Update all
                </Button>
              ) : null}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </SidebarMenuItem>
  );
}
