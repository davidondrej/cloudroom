import { useMemo } from "react";
import type {
  Environment,
  GitBranchRefClassification,
  Thread,
  ThreadPullRequest,
  WorkspaceStatus,
} from "@cloudroom/domain";
import type { WorkspaceResolutionFailure } from "@cloudroom/host-daemon-contract";
import {
  formatEnvironmentDisplay,
  type EnvironmentDisplayHostContext,
} from "@cloudroom/core-ui";
import { CHROME_SECTION_LABEL_CLASS } from "@cloudroom/shared-ui/chrome-style-tokens";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@cloudroom/shared-ui/tooltip";
import { MachineLabel } from "@/components/machines/MachineLabel";
import {
  BranchPicker,
  getMergeBaseBranchCandidateGroups,
} from "@/components/pickers/BranchPicker";
import { EnvironmentProviderIcon } from "@/components/plugin/EnvironmentProviderIcon";
import { GithubFaviconIcon } from "@/components/pull-request/GithubFaviconIcon";
import { PullRequestStateIcon } from "@/components/pull-request/PullRequestStatusPill";
import { CopyableInlineLabel } from "@/components/ui/copy-button.js";
import { DetailRow, DetailRowIconLabel } from "@/components/ui/detail-card.js";
import { TruncatedList } from "@/components/ui/truncated-list.js";
import { ChangedFilesDetailRow } from "@/components/workspace/ChangedFilesDetailRow";
import {
  selectWorkspaceAheadCommits,
  selectWorkspaceChangedFilesSections,
  type WorkspaceChangedFileSelection,
} from "@/components/workspace/workspace-change-summary";
import { getGitStatusDisplay } from "@/components/workspace/workspace-status";
import { useSystemEnvironmentProviders } from "@/hooks/queries/environment-provider-queries";
import { useHosts } from "@/hooks/queries/host-queries";
import { useSystemMachineProviders } from "@/hooks/queries/machine-provider-queries";
import { useCreateThreadInEnvironment } from "@/hooks/useCreateThreadInEnvironment";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import {
  CLOUDROOM_CLOUD_PRIMARY,
  cloudroomEnvironmentPresentation,
} from "@/lib/cloudroom-environment-label";
import {
  findEnvironmentDisplayProvider,
  getEnvironmentWorkspaceInfoDisplay,
} from "@/lib/environment-workspace-display";
import {
  PULL_REQUEST_STATE_DISPLAY,
  getPullRequestAttentionDisplay,
  getPullRequestChecksDisplay,
  getPullRequestGithubCheckStatus,
  getPullRequestMergeabilityDisplay,
  getPullRequestReviewDisplay,
} from "@/lib/pull-request-display";
import { useUrlAnchorClickHandler } from "@/lib/url-open-routing";
import { formatWorkspaceCheckoutDisplay } from "@/lib/workspace-checkout-display";

export function pickMergeBaseBranch(
  selected: string | undefined,
  status: WorkspaceStatus | undefined,
): string | undefined {
  return (
    selected ??
    status?.mergeBase?.mergeBaseBranch ??
    status?.branch.defaultBranch
  );
}

export function isWorkspaceStatusVisible(args: {
  thread: Thread;
  environment: Environment | null;
  workspaceStatus: WorkspaceStatus | undefined;
  workspaceStatusError: Error | null;
  workspaceUnavailable?: WorkspaceResolutionFailure;
}): boolean {
  if (args.thread.archivedAt != null && args.environment?.managed !== true)
    return false;
  return Boolean(
    args.workspaceStatus ||
    args.workspaceStatusError ||
    args.workspaceUnavailable ||
    args.environment?.status === "destroyed",
  );
}

function CopyDirectoryRow({ dir }: { dir: string }) {
  return (
    <DetailRow
      label={<DetailRowIconLabel icon="Folder">Directory</DetailRowIconLabel>}
      valueClassName="min-w-0"
    >
      <CopyableInlineLabel
        text={dir}
        label="Copy directory"
        title={dir}
        successMessage="Directory copied"
        errorMessage="Failed to copy directory"
      />
    </DetailRow>
  );
}

export function WorkspacePathRow({
  environment,
}: {
  environment: Environment | null;
}) {
  return environment?.path ? <CopyDirectoryRow dir={environment.path} /> : null;
}

export function CloudWorkspaceRows({
  path,
}: {
  path: string | null | undefined;
}) {
  if (path === undefined) return null;
  return (
    <>
      <DetailRow
        label={
          <DetailRowIconLabel icon="Cloud">Environment</DetailRowIconLabel>
        }
        valueClassName="min-w-0 truncate"
      >
        {CLOUDROOM_CLOUD_PRIMARY}
      </DetailRow>
      {path ? <CopyDirectoryRow dir={path} /> : null}
    </>
  );
}

export function EnvironmentProvisioningFailureRow({
  failed,
}: {
  failed: boolean;
}) {
  if (!failed) return null;
  return (
    <DetailRow
      label={
        <DetailRowIconLabel icon="AlertTriangle">
          Environment
        </DetailRowIconLabel>
      }
      valueClassName="min-w-0"
    >
      <span className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 truncate">Not created</span>
        <span className="shrink-0 text-muted-foreground">
          · provisioning failed
        </span>
      </span>
    </DetailRow>
  );
}

export function EnvironmentRow({
  thread,
  environment,
  environmentDisplayHost,
}: {
  thread: Thread;
  environment: Environment | null;
  environmentDisplayHost: EnvironmentDisplayHostContext;
}) {
  const spawnThread = useCreateThreadInEnvironment({
    projectId: thread.projectId,
    environmentId: environment?.id ?? "",
  });
  const { providers } = useSystemEnvironmentProviders();
  const { providers: machineProviders } = useSystemMachineProviders();
  const hosts = useHosts();
  if (!environment) return null;

  const hostRecord = hosts.data?.find((h) => h.id === environment.hostId);
  const machineProv = machineProviders?.find(
    (p) => p.id === hostRecord?.machineProviderId,
  );
  const provLookup = findEnvironmentDisplayProvider(
    providers,
    environment.environmentProviderId,
  );
  const formatted = formatEnvironmentDisplay({
    environment,
    host: environmentDisplayHost,
    providerLookup: provLookup,
  });
  const brandPres =
    provLookup.status === "loaded"
      ? cloudroomEnvironmentPresentation(
          provLookup.environmentProviderId,
          "local",
        )
      : null;
  const workspaceInfo = getEnvironmentWorkspaceInfoDisplay({
    display: formatted,
    providerLookup: provLookup,
    environmentName: environment.name,
    hostName: environmentDisplayHost.identity?.name ?? null,
  });
  const machineHost = hostRecord ?? {
    name:
      environmentDisplayHost.identity?.name ?? workspaceInfo.machineName ?? "",
    type: "persistent" as const,
    machineProviderId: null,
  };

  const labelNode = brandPres ? (
    <DetailRowIconLabel icon={brandPres.icon}>Environment</DetailRowIconLabel>
  ) : provLookup.status === "loaded" && provLookup.provider ? (
    <span className="flex items-center gap-1.5">
      <EnvironmentProviderIcon
        provider={provLookup.provider}
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <span className="min-w-0 truncate">Environment</span>
    </span>
  ) : (
    <DetailRowIconLabel icon={workspaceInfo.icon}>
      Environment
    </DetailRowIconLabel>
  );

  const identity = environmentDisplayHost.identity;
  const reusable = environment.status === "ready" && environment.path !== null;

  return (
    <DetailRow label={labelNode} valueClassName="min-w-0">
      <span className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 truncate" title={workspaceInfo.label}>
          {workspaceInfo.label}
        </span>
        {workspaceInfo.machineName !== null && identity ? (
          <span
            className="inline-flex min-w-0 shrink-0 items-center gap-1.5 text-muted-foreground"
            title={`On ${identity.name} (${identity.connected ? "connected" : "offline"})`}
          >
            <span>·</span>
            <MachineLabel host={machineHost} machineProvider={machineProv} />
            {!identity.connected ? <span>(offline)</span> : null}
          </span>
        ) : null}
        {reusable ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="New thread in this environment"
                onClick={spawnThread}
                className="inline-flex shrink-0 items-center justify-center rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
              >
                <Icon name="MessageSquarePlus" className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>New thread in this environment</TooltipContent>
          </Tooltip>
        ) : null}
      </span>
    </DetailRow>
  );
}

export function BranchRow({
  workspaceStatus,
}: {
  workspaceStatus: WorkspaceStatus | undefined;
}) {
  const display = workspaceStatus
    ? formatWorkspaceCheckoutDisplay({ checkout: workspaceStatus.checkout })
    : null;
  if (!display) return null;

  return (
    <DetailRow
      label={
        <DetailRowIconLabel icon="GitBranch">
          {display.rowLabel}
        </DetailRowIconLabel>
      }
      valueClassName="min-w-0 truncate"
    >
      {display.copyValue !== null ? (
        <CopyableInlineLabel
          text={display.copyValue}
          label={display.copyLabel ?? "Copy checkout value"}
          title={display.title}
          successMessage={display.copySuccessMessage ?? "Value copied"}
          errorMessage={display.copyErrorMessage ?? "Failed to copy value"}
        >
          {display.label}
        </CopyableInlineLabel>
      ) : (
        <span className="block truncate" title={display.title}>
          {display.label}
        </span>
      )}
    </DetailRow>
  );
}

export function MergeBaseRow({
  workspaceStatus,
  selectedMergeBaseBranch,
  mergeBaseBranchRef,
  mergeBaseBranchOptions,
  mergeBaseRemoteBranchOptions,
  isLoadingMergeBaseBranchOptions,
  onMergeBaseBranchChange,
  onMergeBasePickerOpenChange,
  onMergeBaseBranchSearchQueryChange,
  defaultOpen,
}: {
  workspaceStatus: WorkspaceStatus | undefined;
  selectedMergeBaseBranch: string | undefined;
  mergeBaseBranchRef?: GitBranchRefClassification | null;
  mergeBaseBranchOptions: readonly string[] | undefined;
  mergeBaseRemoteBranchOptions?: readonly string[];
  isLoadingMergeBaseBranchOptions: boolean;
  onMergeBaseBranchChange: (branch: string) => void;
  onMergeBasePickerOpenChange?: (open: boolean) => void;
  onMergeBaseBranchSearchQueryChange?: (query: string) => void;
  defaultOpen?: boolean;
}) {
  const baseBranch = pickMergeBaseBranch(
    selectedMergeBaseBranch,
    workspaceStatus,
  );
  const candidates = useMemo(
    () =>
      getMergeBaseBranchCandidateGroups({
        mergeBaseBranch: baseBranch,
        mergeBaseBranchRef,
        mergeBaseBranchOptions,
        remoteMergeBaseBranchOptions: mergeBaseRemoteBranchOptions,
      }),
    [
      baseBranch,
      mergeBaseBranchOptions,
      mergeBaseBranchRef,
      mergeBaseRemoteBranchOptions,
    ],
  );

  const onDefault =
    workspaceStatus?.branch.currentBranch != null &&
    workspaceStatus.branch.currentBranch ===
      workspaceStatus.branch.defaultBranch;
  if (!baseBranch || onDefault) return null;

  const lazy =
    mergeBaseBranchOptions === undefined &&
    onMergeBasePickerOpenChange !== undefined;
  const interactive =
    lazy ||
    isLoadingMergeBaseBranchOptions ||
    candidates.options.length > 0 ||
    candidates.remoteOptions.length > 0;

  return (
    <DetailRow
      label={
        <DetailRowIconLabel icon="GitMerge">Merge base</DetailRowIconLabel>
      }
      valueClassName="min-w-0"
    >
      {interactive ? (
        <BranchPicker
          value={baseBranch}
          options={candidates.options}
          remoteOptions={candidates.remoteOptions}
          variant="minimal"
          emphasizeTriggerValue={false}
          loading={isLoadingMergeBaseBranchOptions || lazy}
          onChange={onMergeBaseBranchChange}
          onOpenChange={onMergeBasePickerOpenChange}
          onSearchQueryChange={onMergeBaseBranchSearchQueryChange}
          className="max-w-full"
          defaultOpen={defaultOpen}
        />
      ) : (
        baseBranch
      )}
    </DetailRow>
  );
}

export function GitStatusRow(props: {
  thread: Thread;
  environment: Environment | null;
  workspaceStatus: WorkspaceStatus | undefined;
  workspaceStatusError: Error | null;
  workspaceUnavailable?: WorkspaceResolutionFailure;
  selectedMergeBaseBranch: string | undefined;
}) {
  if (!isWorkspaceStatusVisible(props)) return null;
  const mergeBase = pickMergeBaseBranch(
    props.selectedMergeBaseBranch,
    props.workspaceStatus,
  );
  const status = getGitStatusDisplay(props.workspaceStatus, {
    mergeBaseBranch: mergeBase,
    showBranchComparison: Boolean(
      mergeBase || props.workspaceStatus?.branch.defaultBranch,
    ),
    error: props.workspaceStatusError,
    workspaceUnavailable: props.workspaceUnavailable,
    workspaceDeleted: props.environment?.status === "destroyed",
    workspaceParked: props.environment?.lifecycle.phase === "parked",
  });

  return (
    <DetailRow
      label={
        <DetailRowIconLabel icon="FileDiff">Git status</DetailRowIconLabel>
      }
      align="start"
      valueClassName="min-w-0"
    >
      <div
        className="flex min-w-0 items-end gap-2 whitespace-nowrap"
        title={`${status.label} ${status.summary}`}
      >
        <span
          className={cn(
            "shrink-0 font-medium",
            status.label === "Dirty" ? "text-destructive" : "text-foreground",
          )}
        >
          {status.label}
        </span>
        <span className="min-w-0 truncate text-muted-foreground">
          {status.summary}
        </span>
      </div>
    </DetailRow>
  );
}

export function PullRequestRow({
  pullRequest,
}: {
  pullRequest: ThreadPullRequest | null;
}) {
  const onLinkClick = useUrlAnchorClickHandler(pullRequest?.url);
  if (!pullRequest) return null;

  const stateInfo = PULL_REQUEST_STATE_DISPLAY[pullRequest.state];
  const attention = getPullRequestAttentionDisplay(pullRequest);
  const checkIconStatus = getPullRequestGithubCheckStatus(pullRequest);

  let badge = null as { label: string; className?: string } | null;
  if (
    pullRequest.attention === "changes_requested" ||
    pullRequest.attention === "review_requested"
  ) {
    badge = getPullRequestReviewDisplay(pullRequest);
  } else if (
    pullRequest.attention === "conflicts" ||
    pullRequest.attention === "blocked"
  ) {
    badge = getPullRequestMergeabilityDisplay(pullRequest);
  } else if (attention.label !== stateInfo.label) {
    badge = attention;
  } else if (checkIconStatus !== null) {
    badge = getPullRequestChecksDisplay(pullRequest);
  }

  const neutral =
    pullRequest.attention === "ready_to_merge" ||
    pullRequest.attention === "checks_pending" ||
    ((pullRequest.state === "open" || pullRequest.state === "draft") &&
      (pullRequest.checks.state === "passing" ||
        pullRequest.checks.state === "pending") &&
      (pullRequest.attention === "none" || pullRequest.attention === "draft"));

  return (
    <DetailRow
      label={
        <DetailRowIconLabel icon="GitPullRequestArrow">
          Pull request
        </DetailRowIconLabel>
      }
      valueClassName="min-w-0"
    >
      <a
        href={pullRequest.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onLinkClick}
        aria-label={`Pull request ${pullRequest.number}: ${attention.label}`}
        className="flex h-5 max-w-full min-w-0 items-center gap-2 text-xs text-foreground no-underline transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <GithubFaviconIcon status={checkIconStatus} />
        <span className="shrink-0 text-muted-foreground">
          #{pullRequest.number}
        </span>
        <span className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border border-border bg-background px-1.5 text-muted-foreground">
          <PullRequestStateIcon
            state={pullRequest.state}
            className="size-3.5"
          />
          <span>{stateInfo.label}</span>
        </span>
        {badge ? (
          <span
            className={cn(
              "min-w-0 truncate",
              neutral ? "text-foreground" : badge.className,
            )}
          >
            {badge.label}
          </span>
        ) : null}
      </a>
    </DetailRow>
  );
}

export function ThreadCommitsRow({
  workspaceStatus,
  onCommitClick,
}: {
  workspaceStatus: WorkspaceStatus | undefined;
  onCommitClick?: (sha: string) => void;
}) {
  const ahead = selectWorkspaceAheadCommits(workspaceStatus);
  if (ahead.length === 0) return null;

  return (
    <>
      <div className="mb-1 mt-3 border-t border-border" aria-hidden />
      <DetailRow
        label="Commits"
        orientation="vertical"
        labelClassName={CHROME_SECTION_LABEL_CLASS}
        valueClassName="min-w-0"
      >
        <TruncatedList
          items={ahead}
          getKey={(c) => c.sha}
          renderItem={(c) => (
            <div className="flex min-w-0 items-center justify-between gap-2">
              {onCommitClick ? (
                <button
                  type="button"
                  onClick={() => onCommitClick(c.sha)}
                  title={c.subject}
                  className="group min-w-0 flex-1 text-left"
                >
                  <span className="block min-w-0 truncate text-readback-foreground underline-offset-2 group-hover:underline">
                    {c.subject}
                  </span>
                </button>
              ) : (
                <span className="min-w-0 flex-1 truncate text-readback-foreground">
                  {c.subject}
                </span>
              )}
              <button
                type="button"
                aria-label={`Copy commit ${c.shortSha} SHA`}
                className="inline-flex max-w-[45%] shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-subtle-foreground transition-colors hover:bg-state-hover hover:text-foreground"
                onClick={() =>
                  void copyToClipboardWithToast(c.sha, {
                    successMessage: "Commit SHA copied",
                    errorMessage: "Failed to copy commit SHA",
                  })
                }
              >
                <span className="truncate">{c.shortSha}</span>
              </button>
            </div>
          )}
        />
      </DetailRow>
    </>
  );
}

export function ChangedFilesRow({
  workspaceStatus,
  onChangedFileClick,
}: {
  workspaceStatus: WorkspaceStatus | undefined;
  onChangedFileClick?: (selection: WorkspaceChangedFileSelection) => void;
}) {
  return (
    <ChangedFilesDetailRow
      sections={selectWorkspaceChangedFilesSections(workspaceStatus)}
      onFileClick={onChangedFileClick}
      labelClassName={CHROME_SECTION_LABEL_CLASS}
      rowClassName="mt-3"
      limit={5}
    />
  );
}
