import {
  ClaudeConnectionButton,
  useClaudeConnection,
} from "@/components/ClaudeConnection";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { arrayMove } from "@dnd-kit/sortable";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateHostProviderCliStatus } from "@/hooks/cache-owners/provider-cli-status-cache-owner";
import { COMPUTER, COMPUTER_TITLE, type AppSettings, type CompletedTurnDisplay, type ProviderInfo } from "@cloudroom/domain";
import type { ProviderCliStatus } from "@cloudroom/host-daemon-contract";
import type { SystemProviderState } from "@cloudroom/server-contract";
import { Button } from "@cloudroom/shared-ui/button";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@cloudroom/shared-ui/coarse-pointer-sizing";
import { Icon } from "@cloudroom/shared-ui/icon";
import {
  ResourceDetailConfigurationSection,
  ResourceDetailPanel,
} from "@cloudroom/shared-ui/resource-list";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { Switch } from "@cloudroom/shared-ui/switch";
import {
  SettingsBadge,
  SettingsRow,
  SettingsRowList,
  SettingsSection,
} from "@/components/ui/settings-section";
import {
  buildProviderCliIssue,
  hasProviderCliAction,
  useProviderCliInstallRunner,
  type ProviderCliInstallTarget,
} from "@/components/provider-cli/provider-cli-install";
import {
  openProviderCliInstallLog,
  providerCliJobKey,
} from "@/components/provider-cli/provider-cli-install-store";
import {
  openCodexConnection,
  useCloudLogin,
} from "@/components/CodexConnectionPanel";
import { RowStateControl, RowVersions } from "./UpdatesSettingsSection";
import {
  cloudCanRunHarness,
  useCloudroomAccount,
} from "@/hooks/queries/cloudroom-queries";
import {
  useHostProviderCliStatus,
  useInstallableProviders,
  useSystemConfig,
  useSystemProviderStates,
  useSystemProviders,
} from "@/hooks/queries/system-queries";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { ProviderIconMark } from "./ProviderIconMark";
import { ProviderLoginButton } from "./ProviderLoginButton";
import {
  SortableSettingsRowList,
  useSortableSettingsRow,
} from "./sortable-settings-rows";

interface ProvidersSettingsSectionProps {
  disabled: boolean;
  generalSettings: AppSettings;
  onGeneralSettingsChange: (next: AppSettings) => Promise<unknown> | void;
}

const CELL = {
  mac: "sm:w-20",
  cloud: "sm:w-24",
  auto: "sm:w-24",
  status: "sm:w-20",
} as const;

const TABLE_BUTTON = "h-7 px-2.5 text-xs";

function applyProviderOrder(
  providers: readonly ProviderInfo[],
  ids: readonly string[] | null,
): readonly ProviderInfo[] {
  if (
    ids === null ||
    providers.length !== ids.length ||
    providers.some((provider) => !ids.includes(provider.id))
  ) {
    return providers;
  }
  const providersById = new Map(
    providers.map((provider) => [provider.id, provider]),
  );
  return ids.flatMap((id) => {
    const provider = providersById.get(id);
    return provider === undefined ? [] : [provider];
  });
}

export function reorderProviderIds(
  ids: readonly string[],
  activeId: string,
  overId: string,
): string[] | null {
  const activeIndex = ids.indexOf(activeId);
  const overIndex = ids.indexOf(overId);
  if (activeIndex === -1 || overIndex === -1 || activeIndex === overIndex) {
    return null;
  }
  return arrayMove([...ids], activeIndex, overIndex);
}

function withProviderCompletedTurnDisplay(
  settings: AppSettings,
  provider: ProviderInfo,
  display: CompletedTurnDisplay,
): AppSettings {
  const overrides = Object.fromEntries(
    Object.entries(settings.providerCompletedTurnDisplay).filter(
      ([providerId]) => providerId !== provider.id,
    ),
  );
  return {
    ...settings,
    providerCompletedTurnDisplay:
      display === provider.completedTurnDisplay
        ? overrides
        : { ...overrides, [provider.id]: display },
  };
}

function ProviderRowIcon({ provider }: { provider: ProviderInfo }) {
  const ProviderIcon = getProviderIconInfo(
    "agent",
    provider.id,
    provider,
  )?.icon;
  return (
    <span className="flex size-5 shrink-0 items-center justify-center">
      {ProviderIcon ? (
        <ProviderIconMark
          provider={provider}
          icon={ProviderIcon}
          className={COARSE_POINTER_ICON_SIZE_CLASS}
        />
      ) : (
        <Icon name="Zap" className="text-muted-foreground" />
      )}
    </span>
  );
}

function Cell({
  label,
  className,
  children,
}: {
  label?: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 sm:justify-center",
        className,
      )}
    >
      {label === undefined ? null : (
        <span className="text-xs text-muted-foreground sm:hidden">{label}</span>
      )}
      {children}
    </span>
  );
}

function Cells({
  showCloud,
  mac,
  cloud,
  auto,
  status,
}: {
  showCloud: boolean;
  mac: ReactNode;
  cloud: ReactNode;
  auto: ReactNode;
  status: ReactNode;
}) {
  return (
    <span className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 pl-8 sm:contents">
      <Cell label={COMPUTER_TITLE} className={CELL.mac}>
        {mac}
      </Cell>
      {showCloud ? (
        <Cell label="Cloud" className={CELL.cloud}>
          {cloud}
        </Cell>
      ) : null}
      <Cell label="Auto-update" className={CELL.auto}>
        {auto}
      </Cell>
      <Cell className={cn("max-sm:ml-auto", CELL.status)}>{status}</Cell>
    </span>
  );
}

const DASH = <span className="text-muted-foreground/50">–</span>;
const MAC_ONLY = (
  <span className="text-xs text-muted-foreground">{COMPUTER_TITLE} only</span>
);

function Check({ label }: { label: string }) {
  return (
    <span className="flex items-center text-primary">
      <Icon name="Check" aria-hidden className="size-4" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function TableButton({
  children,
  label,
  primary = false,
  onClick,
}: {
  children: ReactNode;
  label: string;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant={primary ? "default" : "outline"}
      size="sm"
      aria-label={label}
      className={TABLE_BUTTON}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function MacLogin({
  hostId,
  onChange,
  provider,
  state,
}: {
  hostId: string | null;
  onChange: () => void;
  provider: ProviderInfo;
  state: SystemProviderState | undefined;
}) {
  if (state === undefined) return null;
  if (state.status !== "unauthenticated" && state.status !== "expired") {
    return state.status === "ready" ? (
      <Check label={`Signed in to ${provider.displayName} on this ${COMPUTER}`} />
    ) : (
      DASH
    );
  }
  if (hostId === null) return DASH;
  if (provider.id === "claude-code")
    return (
      <ClaudeConnectionButton
        target="local"
        hostId={hostId}
        presentation="inline"
        className={TABLE_BUTTON}
        text="Log in"
        onConnected={onChange}
      />
    );
  return state.loginCommand ? (
    <ProviderLoginButton
      className={TABLE_BUTTON}
      command={state.loginCommand}
      displayName={provider.displayName}
      hostId={hostId}
      onDone={onChange}
    />
  ) : (
    DASH
  );
}

function ClaudeCloudLogin() {
  const auth = useClaudeConnection({ target: "cloud" });
  if (auth.data?.state === "connected")
    return <Check label="Claude Code is connected in the Cloud" />;
  return (
    <ClaudeConnectionButton
      target="cloud"
      presentation="inline"
      className={TABLE_BUTTON}
      text="Connect"
    />
  );
}

function CodexCloudLogin() {
  const auth = useCloudLogin("codex");
  if (auth.isPending) return null;
  if (auth.data?.state === "connected")
    return (
      <button
        type="button"
        aria-label="Manage Codex Cloud login"
        className="flex items-center rounded-sm text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => openCodexConnection()}
      >
        <Icon name="Check" aria-hidden className="size-4" />
      </button>
    );
  return (
    <TableButton
      label="Connect Codex in the Cloud"
      onClick={() => openCodexConnection()}
    >
      Connect
    </TableButton>
  );
}

function CloudLogin({ provider }: { provider: ProviderInfo }) {
  if (provider.id === "claude-code") return <ClaudeCloudLogin />;
  if (provider.id === "codex") return <CodexCloudLogin />;
  // Pi, opencode, Hermes, fx, and Devin have no Cloud sign-in: the Cloud reuses this Mac's login (ADR 0130).
  // Cursor (ADR 0161) and the rest can't run in Cloud.
  return cloudCanRunHarness(provider.id) ? (
    <Check
      label={`${provider.displayName} runs in the Cloud with this ${COMPUTER}'s login`}
    />
  ) : (
    MAC_ONLY
  );
}

function AutoUpdateSwitch({
  disabled,
  generalSettings,
  onGeneralSettingsChange,
  provider,
  status,
}: {
  disabled: boolean;
  generalSettings: AppSettings;
  onGeneralSettingsChange: ProvidersSettingsSectionProps["onGeneralSettingsChange"];
  provider: ProviderInfo;
  status: ProviderCliStatus | undefined;
}) {
  if (status?.npmPackageName == null) return DASH;
  const autoUpdate = generalSettings.providerAutoUpdate ?? [];
  return (
    <Switch
      checked={autoUpdate.includes(provider.id)}
      disabled={disabled}
      aria-label={`Auto-update ${provider.displayName}`}
      onCheckedChange={(checked) =>
        onGeneralSettingsChange({
          ...generalSettings,
          providerAutoUpdate: checked
            ? [...autoUpdate, provider.id]
            : autoUpdate.filter((id) => id !== provider.id),
        })
      }
    />
  );
}

function useCliJob(hostId: string | null, providerId: string) {
  const { failuresByJobKey, queuedJobKeys, runningJobKey, startInstall } =
    useProviderCliInstallRunner();
  const jobKey = hostId === null ? null : providerCliJobKey(hostId, providerId);
  return {
    busy:
      jobKey !== null &&
      (runningJobKey === jobKey || queuedJobKeys.has(jobKey)),
    failure: jobKey === null ? null : (failuresByJobKey.get(jobKey) ?? null),
    startInstall,
  };
}

function UpdateStatus({
  hostId,
  provider,
  status,
}: {
  hostId: string | null;
  provider: ProviderInfo;
  status: ProviderCliStatus | undefined;
}) {
  const { busy, failure, startInstall } = useCliJob(hostId, provider.id);
  if (status === undefined) return null;
  const issue = buildProviderCliIssue({ provider: provider.id, status });
  if (busy) return <RowStateControl live state="in-progress" />;
  if (issue === null) return <RowStateControl state="up-to-date" />;
  if (hostId === null || !hasProviderCliAction(issue))
    return <RowStateControl state="update-manually" />;
  const failed = failure?.issueFingerprint === issue.fingerprint;
  return (
    <TableButton
      label={`${failed ? "Retry" : "Update"} ${provider.displayName}`}
      primary={status.versionUnsupported && !failed}
      onClick={() => startInstall({ hostId, issue })}
    >
      {failed ? "Retry" : "Update"}
    </TableButton>
  );
}

function FailedNote({
  hostId,
  provider,
  status,
}: {
  hostId: string | null;
  provider: ProviderInfo;
  status: ProviderCliStatus | undefined;
}) {
  const { busy, failure } = useCliJob(hostId, provider.id);
  const issue =
    status === undefined
      ? null
      : buildProviderCliIssue({ provider: provider.id, status });
  if (busy || failure === null || failure.issueFingerprint !== issue?.fingerprint)
    return null;
  return (
    <button
      type="button"
      aria-label={`View ${provider.displayName} update log`}
      className="shrink-0 text-xs font-semibold text-destructive hover:underline"
      onClick={() => openProviderCliInstallLog(failure.logDialogState)}
    >
      Failed
    </button>
  );
}

interface ProviderRowProps {
  disabled: boolean;
  generalSettings: AppSettings;
  hostId: string | null;
  isDefault: boolean;
  onGeneralSettingsChange: ProvidersSettingsSectionProps["onGeneralSettingsChange"];
  onLoginChange: () => void;
  provider: ProviderInfo;
  showCloud: boolean;
  state: SystemProviderState | undefined;
  status: ProviderCliStatus | undefined;
}

function SortableProviderRow({
  disabled,
  generalSettings,
  hostId,
  isDefault,
  onGeneralSettingsChange,
  onLoginChange,
  provider,
  showCloud,
  state,
  status,
}: ProviderRowProps) {
  const { setNodeRef, style, isDragging, handle } = useSortableSettingsRow({
    id: provider.id,
    disabled,
    label: provider.displayName,
  });
  const notInstalled = state?.status === "not_installed";

  return (
    <SettingsRow
      ref={setNodeRef}
      style={style}
      className={cn(
        "group/provider-row flex-wrap sm:flex-nowrap",
        isDragging && "relative z-10 rounded-md bg-card opacity-90 shadow-lift",
      )}
    >
      {handle}
      <ProviderRowIcon provider={provider} />
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate font-medium">{provider.displayName}</span>
        <RowVersions
          current={status?.currentVersion ?? null}
          latest={status?.latestVersion ?? null}
        />
        <FailedNote hostId={hostId} provider={provider} status={status} />
        {!provider.available ? <SettingsBadge>Unavailable</SettingsBadge> : null}
        {isDefault ? (
          <SettingsBadge>Default</SettingsBadge>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground opacity-0 group-hover/provider-row:opacity-100 focus-visible:opacity-100 max-sm:opacity-100"
            disabled={disabled || !provider.available}
            onClick={() =>
              onGeneralSettingsChange({
                ...generalSettings,
                defaultProviderId: provider.id,
              })
            }
          >
            Make default
          </Button>
        )}
      </span>
      <Cells
        showCloud={showCloud}
        mac={
          notInstalled ? (
            DASH
          ) : (
            <MacLogin
              hostId={hostId}
              onChange={onLoginChange}
              provider={provider}
              state={state}
            />
          )
        }
        cloud={<CloudLogin provider={provider} />}
        auto={
          <AutoUpdateSwitch
            disabled={disabled}
            generalSettings={generalSettings}
            onGeneralSettingsChange={onGeneralSettingsChange}
            provider={provider}
            status={status}
          />
        }
        status={
          notInstalled && state !== undefined && hostId !== null ? (
            <ProviderSetupButton
              hostId={hostId}
              provider={provider}
              state={state}
            />
          ) : (
            <UpdateStatus hostId={hostId} provider={provider} status={status} />
          )
        }
      />
    </SettingsRow>
  );
}

function ProviderSetupButton({
  hostId,
  provider,
  state,
}: {
  hostId: string;
  provider: ProviderInfo;
  state: SystemProviderState;
}) {
  const { busy, startInstall } = useCliJob(hostId, provider.id);
  const installUrl = provider.strings?.installUrl;
  if (!state.canInstall && !installUrl) return null;
  if (busy) return <RowStateControl live state="in-progress" />;
  return (
    <TableButton
      label={`Install ${provider.displayName}`}
      onClick={() => {
        if (state.canInstall)
          startInstall({ hostId, issue: hiddenProviderTarget(provider) });
        else if (installUrl) openUrlInExternalBrowser(installUrl);
      }}
    >
      Install
    </TableButton>
  );
}

interface InstallableProvider {
  provider: ProviderInfo;
  target: ProviderCliInstallTarget;
}

function hiddenProviderTarget(
  provider: ProviderInfo,
): ProviderCliInstallTarget {
  return {
    provider: provider.id,
    status: { displayName: provider.displayName },
    action: {
      kind: "install",
      label: "Install",
      command: `install ${provider.displayName}`,
    },
    fingerprint: `${provider.id}:missing`,
  };
}

function NotInstalledRow({
  hostId,
  installable: { provider, target },
  showCloud,
}: {
  hostId: string;
  installable: InstallableProvider;
  showCloud: boolean;
}) {
  const { busy, startInstall } = useCliJob(hostId, provider.id);
  return (
    <SettingsRow className="flex-wrap sm:flex-nowrap">
      <span className="-ml-2 w-7 shrink-0" />
      <span className="opacity-50">
        <ProviderRowIcon provider={provider} />
      </span>
      <span className="min-w-0 flex-1 truncate font-medium text-muted-foreground">
        {provider.displayName}
      </span>
      <Cells
        showCloud={showCloud}
        mac={DASH}
        cloud={<CloudLogin provider={provider} />}
        auto={DASH}
        status={
          busy ? (
            <RowStateControl live state="in-progress" />
          ) : (
            <TableButton
              label={`Install ${provider.displayName}`}
              onClick={() => startInstall({ hostId, issue: target })}
            >
              Install
            </TableButton>
          )
        }
      />
    </SettingsRow>
  );
}

function TableHeader({ showCloud }: { showCloud: boolean }) {
  return (
    <div className="mb-2.5 hidden items-center gap-3 border-b border-border pb-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground sm:flex">
      <span className="flex-1 pl-16">Agent</span>
      <span className={cn("text-center", CELL.mac)}>{COMPUTER_TITLE}</span>
      {showCloud ? (
        <span className={cn("text-center", CELL.cloud)}>Cloud</span>
      ) : null}
      <span className={cn("text-center", CELL.auto)}>Auto-update</span>
      <span className={cn("text-center", CELL.status)}>Status</span>
    </div>
  );
}

function useInstalledProviderCheck() {
  const { localDaemonHostId } = useHostDaemon();
  const primaryHostId = useSystemConfig().data?.primaryHostId ?? null;
  const hostId = localDaemonHostId ?? primaryHostId;
  const cliStatusQuery = useHostProviderCliStatus({ hostId });
  const cliStatus = cliStatusQuery.data;
  return {
    cliStatus,
    cliStatusQuery,
    hostId,
    isInstalled: (provider: ProviderInfo) =>
      cliStatus?.[provider.id]?.installed !== false,
  };
}

interface CompletedTurnDisplayRowProps {
  disabled: boolean;
  generalSettings: AppSettings;
  onGeneralSettingsChange: ProvidersSettingsSectionProps["onGeneralSettingsChange"];
  provider: ProviderInfo;
}

function CompletedTurnDisplayRow({
  disabled,
  generalSettings,
  onGeneralSettingsChange,
  provider,
}: CompletedTurnDisplayRowProps) {
  const display =
    generalSettings.providerCompletedTurnDisplay[provider.id] ??
    provider.completedTurnDisplay;
  return (
    <SettingsRow>
      <ProviderRowIcon provider={provider} />
      <span className="min-w-0 flex-1 truncate font-medium">
        {provider.displayName}
      </span>
      <Switch
        checked={display === "collapse"}
        disabled={disabled}
        aria-label={`Collapse finished ${provider.displayName} turns`}
        onCheckedChange={(checked) =>
          onGeneralSettingsChange(
            withProviderCompletedTurnDisplay(
              generalSettings,
              provider,
              checked ? "collapse" : "flat",
            ),
          )
        }
      />
    </SettingsRow>
  );
}

export function ProvidersSettingsSection({
  disabled,
  generalSettings,
  onGeneralSettingsChange,
}: ProvidersSettingsSectionProps) {
  const providersQuery = useSystemProviders();
  const { cliStatus, cliStatusQuery, hostId, isInstalled } =
    useInstalledProviderCheck();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (hostId !== null)
      void invalidateHostProviderCliStatus({ queryClient, hostId });
  }, [hostId, queryClient]);
  const hiddenInstallable = useInstallableProviders({ hostId }).data ?? [];
  const showCloud = useCloudroomAccount().data?.ready === true;
  const serverProviders: ProviderInfo[] = providersQuery.data ?? [];
  const [optimisticOrder, setOptimisticOrder] = useState<string[] | null>(null);
  const allProviders = applyProviderOrder(serverProviders, optimisticOrder);
  const allIds = allProviders.map((provider) => provider.id);
  const providers = allProviders.filter(isInstalled);
  const ids = providers.map((provider) => provider.id);
  const defaultProviderId =
    generalSettings.defaultProviderId ?? allProviders[0]?.id ?? null;
  const statesQuery = useSystemProviderStates({
    hostId: hostId ?? undefined,
    enabled: hostId !== null,
    poll: false,
  });
  const { refetch: refetchStates } = statesQuery;
  const refreshStates = useCallback(() => void refetchStates(), [refetchStates]);
  const states = new Map(
    (statesQuery.data?.providers ?? []).map((state) => [
      state.providerId,
      state.status === "not_installed" &&
      cliStatus?.[state.providerId]?.installed === true
        ? undefined
        : state,
    ]),
  );
  const staleInstall = (statesQuery.data?.providers ?? []).some(
    (state) =>
      state.status === "not_installed" &&
      cliStatus?.[state.providerId]?.installed === true,
  );
  useEffect(() => {
    if (staleInstall) refreshStates();
  }, [staleInstall, refreshStates]);
  const installable: InstallableProvider[] = [
    ...allProviders.flatMap((provider) => {
      const status = cliStatus?.[provider.id];
      if (status === undefined || status.installed) return [];
      const issue = buildProviderCliIssue({ provider: provider.id, status });
      return issue !== null && hasProviderCliAction(issue)
        ? [{ provider, target: issue }]
        : [];
    }),
    ...hiddenInstallable.map((provider) => ({
      provider,
      target: hiddenProviderTarget(provider),
    })),
  ];

  const handleReorder = (activeId: string, overId: string): void => {
    const reordered = reorderProviderIds(ids, activeId, overId);
    if (reordered === null) return;
    const next = [
      ...reordered,
      ...allIds.filter((id) => !reordered.includes(id)),
    ];
    setOptimisticOrder(next);
    let write: Promise<unknown> | void;
    try {
      write = onGeneralSettingsChange({
        ...generalSettings,
        providerOrder: next,
      });
    } catch {
      setOptimisticOrder(null);
      return;
    }
    void Promise.resolve(write)
      .catch(() => undefined)
      .finally(() => setOptimisticOrder(null));
  };

  return (
    <SettingsSection
      title="Providers"
      description="Your agents: logins, versions, updates, and the default. Provider-specific settings are in the tabs above."
    >
      {providersQuery.isPending ? (
        <p className="text-sm text-muted-foreground">Loading providers…</p>
      ) : (
        <>
          <TableHeader showCloud={showCloud} />
          {cliStatusQuery.isError ? (
            <p className="flex items-center gap-2 pb-2.5 text-xs text-destructive">
              Couldn&apos;t check agent versions.
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                disabled={cliStatusQuery.isFetching}
                onClick={() => void cliStatusQuery.refetch()}
              >
                Retry
              </Button>
            </p>
          ) : null}
          {providers.length === 0 ? (
            <p className="py-2.5 text-sm text-muted-foreground">
              No agent is installed yet. Install one below.
            </p>
          ) : (
            <SortableSettingsRowList
              ids={ids}
              disabled={disabled}
              onReorder={handleReorder}
            >
              {providers.map((provider) => (
                <SortableProviderRow
                  key={provider.id}
                  disabled={disabled}
                  generalSettings={generalSettings}
                  hostId={hostId}
                  isDefault={provider.id === defaultProviderId}
                  onGeneralSettingsChange={onGeneralSettingsChange}
                  onLoginChange={refreshStates}
                  provider={provider}
                  showCloud={showCloud}
                  state={states.get(provider.id)}
                  status={cliStatus?.[provider.id]}
                />
              ))}
            </SortableSettingsRowList>
          )}
          {hostId === null || installable.length === 0 ? null : (
            <>
              <div className="mt-2.5 border-t border-border pb-2.5 pt-3 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                Not installed
              </div>
              <SettingsRowList>
                {installable.map((entry) => (
                  <NotInstalledRow
                    key={entry.provider.id}
                    hostId={hostId}
                    installable={entry}
                    showCloud={showCloud}
                  />
                ))}
              </SettingsRowList>
            </>
          )}
        </>
      )}
    </SettingsSection>
  );
}

export function ProviderTurnDisplaySection({
  disabled,
  generalSettings,
  onGeneralSettingsChange,
  pluginId,
}: ProvidersSettingsSectionProps & { pluginId: string }) {
  const { isInstalled } = useInstalledProviderCheck();
  const providers = (useSystemProviders().data ?? []).filter(
    (provider) => provider.pluginId === pluginId && isInstalled(provider),
  );
  if (providers.length === 0) return null;
  return (
    <ResourceDetailConfigurationSection label="Collapse finished turns">
      <p className="text-xs text-muted-foreground">
        When a turn finishes, fold its work into one Worked for row and keep the
        final answer visible.
      </p>
      <ResourceDetailPanel surface="recessed" className="border-0 bg-surface-recessed px-3 py-1">
        <SettingsRowList>
          {providers.map((provider) => (
            <CompletedTurnDisplayRow
              key={provider.id}
              disabled={disabled}
              generalSettings={generalSettings}
              onGeneralSettingsChange={onGeneralSettingsChange}
              provider={provider}
            />
          ))}
        </SettingsRowList>
      </ResourceDetailPanel>
    </ResourceDetailConfigurationSection>
  );
}
