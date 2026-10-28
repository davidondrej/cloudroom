import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { COMPUTER, type Host, type PermissionMode } from "@cloudroom/domain";
import type { SystemMachineProvider } from "@cloudroom/server-contract";
import { RETRY_ACTION_ICON } from "@cloudroom/domain/update-state";
import type { HostPlatform } from "@cloudroom/host-daemon-contract";
import { Button } from "@cloudroom/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { targetsResourceAction } from "@cloudroom/shared-ui/resource-list";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@cloudroom/shared-ui/tooltip";
import { AddMachineDialog } from "@/components/dialogs/AddMachineDialog";
import { MachineAccessControls } from "@/components/settings/MachineAccessSettings";
import { VpsMachineRows } from "@/components/settings/VpsSettings";
import { appToast } from "@/components/ui/app-toast";
import { MachineLifecycleActions } from "@/components/machines/MachineLifecycleActions";
import { MachineRemoveDialog } from "@/components/machines/MachineRemoveDialog";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import {
  machineStatusLabel,
  machineStatusTone,
} from "@/components/machines/machine-status";
import { MachineRenameDialog } from "@/components/settings/MachineRenameDialog";
import { OpenMacButton, YourMacRow, useYourMacs } from "@/components/settings/YourComputers";
import { MachineIcon } from "@/components/machines/MachineLabel";
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_CARD_ROW_CLASS,
  SettingsBadge,
  SettingsSection,
} from "@/components/ui/settings-section";
import {
  useRenameHost,
  useResumeHost,
  useRetryHostCleanup,
  useRetryHostUpdate,
  useSuspendHost,
} from "@/hooks/mutations/host-mutations";
import { useHosts } from "@/hooks/queries/host-queries";
import { useSystemMachineProviders } from "@/hooks/queries/machine-provider-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { getSettingsMachineRoutePath } from "@/lib/route-paths";
import { PERMISSION_MODE_OPTIONS } from "@/lib/permission-mode-options";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import {
  formatHostUpdateStatus,
  hostCanRetryUpdate,
} from "@/lib/host-update-status";

const PERMISSION_MODE_PRESENTATION: Record<
  PermissionMode,
  (typeof PERMISSION_MODE_OPTIONS)[number]
> = Object.fromEntries(
  PERMISSION_MODE_OPTIONS.map((option) => [option.value, option]),
) as Record<PermissionMode, (typeof PERMISSION_MODE_OPTIONS)[number]>;

const PRIMARY_REMOVE_DISABLED_REASON =
  "Cloudroom's primary machine can't be removed.";

const MACHINE_MENU_ITEM_CLASS = "min-h-9 px-2.5 py-2";

const PLATFORM_LABELS: Record<HostPlatform, string | null> = {
  darwin: "macOS",
  linux: "Linux",
  wsl: "WSL",
  win32: "Windows",
  unknown: null,
};

interface MachineRowProps {
  host: Host;
  isPrimary: boolean;
  isThisMachine: boolean;
  showPrimaryBadge: boolean;
  platformLabel: string | null;
  projectCount: number;
  now: number;
  onRename: () => void;
  onRemove: () => void;
  onRetryUpdate: () => void;
  onSuspend: () => void;
  onResume: () => void;
  onRetryCleanup: () => void;
  lifecycleActionPending: boolean;
  retryUpdatePending: boolean;
  machineProvider: SystemMachineProvider | null;
  accessory?: ReactNode;
}

export function MachineRowContent({
  host,
  isPrimary,
  isThisMachine,
  showPrimaryBadge,
  platformLabel,
  projectCount,
  now,
  onRename,
  onRemove,
  onRetryUpdate,
  onSuspend,
  onResume,
  onRetryCleanup,
  lifecycleActionPending,
  retryUpdatePending,
  machineProvider,
  accessory,
}: MachineRowProps) {
  const navigate = useNavigate();
  const detailPath = getSettingsMachineRoutePath(host.id);
  const permission = PERMISSION_MODE_PRESENTATION[host.maxPermissionMode];
  const projectLabel = `${projectCount} ${projectCount === 1 ? "project" : "projects"}`;
  const connectionLabel = machineStatusLabel({ host, now });
  const updateStatus = formatHostUpdateStatus(host);
  const removeItem = (
    <DropdownMenuItem
      variant="destructive"
      aria-disabled={isPrimary || undefined}
      className={cn(
        MACHINE_MENU_ITEM_CLASS,
        isPrimary && "cursor-not-allowed focus:bg-transparent",
      )}
      onSelect={(event) => {
        if (isPrimary) {
          event.preventDefault();
          return;
        }
        onRemove();
      }}
    >
      <Icon name="Trash2" aria-hidden />
      <span className="min-w-0 truncate">Remove machine</span>
    </DropdownMenuItem>
  );

  return (
    <div
      data-machine-row
      className={cn(
        SETTINGS_CARD_ROW_CLASS,
        "group min-w-0 cursor-pointer transition-colors hover:bg-state-hover focus-within:bg-state-hover",
      )}
      onClick={(event) => {
        if (targetsResourceAction(event.target)) return;
        navigate(detailPath);
      }}
    >
      <Link
        to={detailPath}
        aria-label={`Open ${host.name}`}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
          <MachineIcon
            host={host}
            machineProvider={machineProvider}
            className="size-4"
          />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-sm text-foreground">
              {host.name}
            </span>
            {isThisMachine ? <SettingsBadge>this machine</SettingsBadge> : null}
            {showPrimaryBadge ? <SettingsBadge>primary</SettingsBadge> : null}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-subtle-foreground/75">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <MachineStatusDot tone={machineStatusTone(host)} />
              <span className="min-w-0 truncate">{connectionLabel}</span>
            </span>
            {platformLabel === null ? null : (
              <span className="truncate">{platformLabel}</span>
            )}
            <span className="shrink-0">{projectLabel}</span>
            <span
              className={cn(
                "shrink-0",
                permission.tone === "warning" && "text-warning-text",
              )}
            >
              {permission.label}
            </span>
            {updateStatus === null ? null : (
              <span className="min-w-0 text-warning-text">{updateStatus}</span>
            )}
          </div>
        </div>
      </Link>
      {accessory}
      <div className="opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100 pointer-coarse:opacity-100">
        <TooltipProvider delayDuration={250}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 data-[state=open]:bg-state-active data-[state=open]:text-foreground"
                aria-label={`${host.name} actions`}
              >
                <Icon name="MoreHorizontal" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-max min-w-0">
              <DropdownMenuItem
                className={MACHINE_MENU_ITEM_CLASS}
                onSelect={onRename}
              >
                <Icon name="Edit" aria-hidden />
                <span className="min-w-0 truncate">Rename</span>
              </DropdownMenuItem>
              {hostCanRetryUpdate(host) ? (
                <DropdownMenuItem
                  className={MACHINE_MENU_ITEM_CLASS}
                  disabled={retryUpdatePending}
                  onSelect={onRetryUpdate}
                >
                  <Icon name={RETRY_ACTION_ICON} aria-hidden />
                  <span className="min-w-0 truncate">
                    {retryUpdatePending ? "Retrying update…" : "Retry update"}
                  </span>
                </DropdownMenuItem>
              ) : null}
              <MachineLifecycleActions
                host={host}
                machineProvider={machineProvider}
                pending={lifecycleActionPending}
                presentation="menu"
                onSuspend={onSuspend}
                onResume={onResume}
                onRetryCleanup={onRetryCleanup}
              />
              {isPrimary ? (
                <Tooltip>
                  <TooltipTrigger asChild>{removeItem}</TooltipTrigger>
                  <TooltipContent side="left">
                    {PRIMARY_REMOVE_DISABLED_REASON}
                  </TooltipContent>
                </Tooltip>
              ) : (
                removeItem
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </TooltipProvider>
      </div>
      <Icon
        name="ChevronRight"
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
    </div>
  );
}

export function MachinesSettingsSection() {
  const systemConfig = useSystemConfig();
  const hostsQuery = useHosts({ includeCreating: true });
  const { providers: machineProviders } = useSystemMachineProviders();
  const { localDaemonHostId, platform: localDaemonPlatform } = useHostDaemon();
  const sidebarNavigationQuery = useSidebarNavigation();
  const renameHost = useRenameHost();
  const retryHostUpdate = useRetryHostUpdate();
  const suspendHost = useSuspendHost();
  const resumeHost = useResumeHost();
  const retryHostCleanup = useRetryHostCleanup();
  const [showAllMachines, setShowAllMachines] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Host | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Host | null>(null);

  const hosts = hostsQuery.data;
  const macs = useYourMacs().data ?? [];
  const hostIds = new Set(hosts?.map((host) => host.id));
  const macByHostId = new Map(
    macs.flatMap((mac) => (mac.hostId === null ? [] : [[mac.hostId, mac] as const])),
  );
  const otherMacs = macs.filter(
    (mac) => !mac.self && (mac.hostId === null || !hostIds.has(mac.hostId)),
  );
  const serverPrimaryHostId = systemConfig.data?.primaryHostId ?? null;
  const projects = sidebarNavigationQuery.data?.projects;
  const projectCountByHostId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of projects ?? []) {
      const hostIds = new Set(project.sources.map((source) => source.hostId));
      for (const hostId of hostIds) {
        counts.set(hostId, (counts.get(hostId) ?? 0) + 1);
      }
    }
    return counts;
  }, [projects]);

  const now = Date.now();
  const primaryHostPlatform = systemConfig.data?.primaryHostPlatform ?? null;
  const persistentHosts = hosts?.filter((host) => host.type === "persistent");
  const sandboxHosts = hosts?.filter((host) => host.type === "ephemeral");
  const visibleHosts =
    showAllMachines && sandboxHosts !== undefined
      ? [...(persistentHosts ?? []), ...sandboxHosts]
      : (persistentHosts ?? []);
  const showMachineIdentityBadges =
    (persistentHosts?.length ?? 0) > 1 || otherMacs.length > 0;
  const machineProviderById = useMemo(
    () =>
      new Map(
        (machineProviders ?? []).map((provider) => [provider.id, provider]),
      ),
    [machineProviders],
  );
  const renderMachineCards = (rows: readonly Host[]) => (
    <div className={SETTINGS_CARD_CLASS}>
      {rows.map((host) => (
        <MachineRowContent
          key={host.id}
          host={host}
          isPrimary={host.id === serverPrimaryHostId}
          isThisMachine={
            showMachineIdentityBadges && host.id === localDaemonHostId
          }
          showPrimaryBadge={
            showMachineIdentityBadges && host.id === serverPrimaryHostId
          }
          platformLabel={
            host.id === localDaemonHostId && localDaemonPlatform !== null
              ? PLATFORM_LABELS[localDaemonPlatform]
              : host.id === serverPrimaryHostId && primaryHostPlatform !== null
                ? PLATFORM_LABELS[primaryHostPlatform]
                : null
          }
          projectCount={projectCountByHostId.get(host.id) ?? 0}
          now={now}
          onRename={() => {
            renameHost.reset();
            setRenameTarget(host);
          }}
          onRemove={() => {
            setRemoveTarget(host);
          }}
          onRetryUpdate={() =>
            retryHostUpdate.mutate(host.id, {
              onSuccess: () => {
                appToast.success(`Update retry requested for ${host.name}`);
              },
            })
          }
          retryUpdatePending={
            retryHostUpdate.isPending && retryHostUpdate.variables === host.id
          }
          onSuspend={() =>
            suspendHost.mutate(host.id, {
              onSuccess: () => appToast.success(`${host.name} suspended`),
            })
          }
          onResume={() =>
            resumeHost.mutate(host.id, {
              onSuccess: () => appToast.success(`${host.name} resumed`),
            })
          }
          onRetryCleanup={() =>
            retryHostCleanup.mutate(host.id, {
              onSuccess: () =>
                appToast.success(`Cleanup retried for ${host.name}`),
            })
          }
          lifecycleActionPending={
            (suspendHost.isPending && suspendHost.variables === host.id) ||
            (resumeHost.isPending && resumeHost.variables === host.id) ||
            (retryHostCleanup.isPending &&
              retryHostCleanup.variables === host.id)
          }
          machineProvider={
            host.machineProviderId === null
              ? null
              : (machineProviderById.get(host.machineProviderId) ?? null)
          }
          accessory={
            macByHostId.has(host.id) ? (
              <OpenMacButton mac={macByHostId.get(host.id)!} />
            ) : null
          }
        />
      ))}
      {otherMacs.map((mac) => (
        <YourMacRow key={mac.handle} mac={mac} />
      ))}
      <VpsMachineRows />
    </div>
  );

  return (
    <>
      <SettingsSection
        plain
        title="Machines"
        description={
          macs.length > 1
            ? `Every ${COMPUTER} signed in to your Cloudroom account shows up here by itself.`
            : undefined
        }
        bodyClassName="flex flex-col gap-3"
      >
        {hosts === undefined ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          renderMachineCards(visibleHosts)
        )}
        {sandboxHosts !== undefined && sandboxHosts.length > 0 ? (
          <button
            type="button"
            aria-expanded={showAllMachines}
            onClick={() => setShowAllMachines((previous) => !previous)}
            className="-ml-1 inline-flex items-center gap-1.5 self-start rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
          >
            <Icon
              name="ChevronDown"
              className={cn(
                "size-3.5 transition-transform",
                showAllMachines && "rotate-180",
              )}
              aria-hidden
            />
            <span>
              {showAllMachines ? "Show fewer machines" : "Show all machines"}
            </span>
          </button>
        ) : null}
      </SettingsSection>

      <MachineRenameDialog
        target={renameTarget}
        pending={renameHost.isPending}
        errorMessage={
          renameHost.isError
            ? getMutationErrorMessage({
                error: renameHost.error,
                fallbackMessage: "Couldn't rename the machine.",
              })
            : null
        }
        onOpenChange={(open) => {
          if (!open && !renameHost.isPending) setRenameTarget(null);
        }}
        onRename={(host, name) =>
          renameHost.mutate(
            { hostId: host.id, name },
            { onSuccess: () => setRenameTarget(null) },
          )
        }
      />

      <MachineRemoveDialog
        target={removeTarget}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      />
    </>
  );
}

export function AdvancedMachineSettings() {
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-foreground">Remote hosts</p>
          <p className="text-xs text-subtle-foreground/75">Run Local threads on another computer, through this app.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setAddDialogOpen(true)}>
          Add a machine
        </Button>
      </div>
      <MachineAccessControls />
      <AddMachineDialog open={addDialogOpen} onOpenChange={setAddDialogOpen} />
    </div>
  );
}
