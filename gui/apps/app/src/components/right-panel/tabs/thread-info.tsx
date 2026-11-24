import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type UIEvent,
} from "react";
import { Link } from "react-router";
import type {
  Environment,
  GitBranchRefClassification,
  Thread,
  ThreadListEntry,
  ThreadPullRequest,
  WorkspaceStatus,
} from "@cloudroom/domain";
import type { WorkspaceResolutionFailure } from "@cloudroom/host-daemon-contract";
import type { EnvironmentDisplayHostContext } from "@cloudroom/core-ui";
import { Button } from "@cloudroom/shared-ui/button";
import {
  COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
  COARSE_POINTER_TEXT_SM_CLASS,
} from "@cloudroom/shared-ui/coarse-pointer-sizing";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { ParentThreadPicker } from "@/components/pickers/ParentThreadPicker";
import { ThreadUnarchiveButton } from "@/components/thread/ThreadUnarchiveButton";
import {
  DetailCard,
  DetailRow,
  DetailRowIconLabel,
} from "@/components/ui/detail-card.js";
import { TruncatedList } from "@/components/ui/truncated-list.js";
import {
  selectWorkspaceChangedFilesSections,
  type WorkspaceChangedFileSelection,
} from "@/components/workspace/workspace-change-summary";
import { useUnarchiveThread } from "@/hooks/mutations/thread-state-mutations";
import { useThreads } from "@/hooks/queries/thread-queries";
import type { AppFixedTabDestination } from "@/lib/app-fixed-tab-navigation";
import type { AppFixedTabReference } from "@/lib/app-navigation-host";
import { getThreadRoutePath } from "@/lib/route-paths";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { buildParentSelectorOptions } from "@/views/thread-detail/threadParentSelectorOptions";
import {
  BranchRow,
  ChangedFilesRow,
  CloudWorkspaceRows,
  EnvironmentProvisioningFailureRow,
  EnvironmentRow,
  GitStatusRow,
  MergeBaseRow,
  PullRequestRow,
  ThreadCommitsRow,
  WorkspacePathRow,
  isWorkspaceStatusVisible,
} from "./thread-info-git-rows";
import {
  ThreadStorageBrowser,
  type ThreadStorageBrowserController,
} from "./thread-storage";

export {
  BranchRow,
  ChangedFilesRow,
  CloudWorkspaceRows,
  EnvironmentProvisioningFailureRow,
  EnvironmentRow,
  GitStatusRow,
  MergeBaseRow,
  PullRequestRow,
  ThreadCommitsRow,
  WorkspacePathRow,
};

export const THREAD_INFO_FIXED_TAB_REFERENCE: AppFixedTabReference = {
  ownerId: "core:thread-info",
  tabId: "info",
};

export function createThreadInfoFixedTabDestination(
  open: () => void,
): AppFixedTabDestination {
  return {
    tab: THREAD_INFO_FIXED_TAB_REFERENCE,
    open(target) {
      if (target !== undefined) return false;
      open();
      return true;
    },
  };
}

export interface ThreadMetadataContentProps {
  thread: Thread;
  projectId: string;
  parentThreadProjectId: string | null;
  parentThreadDisplayName: string | null;
  parentThreads: readonly ThreadListEntry[];
  canAssignToParent: boolean;
  canTakeOverThread: boolean;
  isLoadingParentThreads: boolean;
  isParentThreadsError: boolean;
  environment: Environment | null;
  environmentProvisioningFailure: boolean;
  environmentDisplayHost: EnvironmentDisplayHostContext;
  cloudWorkspacePath?: string | null;
  workspaceStatus: WorkspaceStatus | undefined;
  workspaceStatusError: Error | null;
  workspaceUnavailable?: WorkspaceResolutionFailure;
  pullRequest: ThreadPullRequest | null;
  selectedMergeBaseBranch: string | undefined;
  mergeBaseBranchRef?: GitBranchRefClassification | null;
  mergeBaseBranchOptions: readonly string[] | undefined;
  mergeBaseRemoteBranchOptions?: readonly string[];
  isLoadingMergeBaseBranchOptions: boolean;
  updateThreadPending: boolean;
  storage?: {
    controller: ThreadStorageBrowserController;
    filesError?: Error | null;
    isFilesLoading: boolean;
  };
  onAssignParent: (parentThreadId: string | null) => void;
  onParentSelectorOpenChange: (open: boolean) => void;
  onRetryParentThreads: () => void;
  onMergeBaseBranchChange: (branch: string) => void;
  onMergeBasePickerOpenChange?: (open: boolean) => void;
  onMergeBaseBranchSearchQueryChange?: (query: string) => void;
  onChangedFileClick?: (selection: WorkspaceChangedFileSelection) => void;
  onCommitClick?: (sha: string) => void;
}

export function hasAnyThreadMetadata(
  args: Pick<
    ThreadMetadataContentProps,
    | "thread"
    | "environment"
    | "environmentProvisioningFailure"
    | "cloudWorkspacePath"
    | "workspaceStatus"
    | "workspaceStatusError"
    | "workspaceUnavailable"
    | "pullRequest"
  >,
  hasForks: boolean,
): boolean {
  return Boolean(
    args.thread.parentThreadId ||
    args.environment ||
    args.environmentProvisioningFailure ||
    args.cloudWorkspacePath !== undefined ||
    args.workspaceStatus?.branch.currentBranch ||
    args.pullRequest ||
    isWorkspaceStatusVisible(args) ||
    selectWorkspaceChangedFilesSections(args.workspaceStatus).length > 0 ||
    args.thread.archivedAt != null ||
    hasForks,
  );
}

export function ParentSelectorRow({
  thread,
  projectId,
  parentThreadProjectId,
  parentThreadDisplayName,
  parentThreads,
  canAssignToParent,
  canTakeOverThread,
  isLoadingParentThreads,
  isParentThreadsError,
  updateThreadPending,
  onAssignParent,
  onParentSelectorOpenChange,
  onRetryParentThreads,
  defaultOpen,
}: {
  thread: Thread;
  projectId: string;
  parentThreadProjectId: string | null;
  parentThreadDisplayName: string | null;
  parentThreads: readonly ThreadListEntry[];
  canAssignToParent: boolean;
  canTakeOverThread: boolean;
  isLoadingParentThreads: boolean;
  isParentThreadsError: boolean;
  updateThreadPending: boolean;
  onAssignParent: (parentThreadId: string | null) => void;
  onParentSelectorOpenChange: (open: boolean) => void;
  onRetryParentThreads: () => void;
  defaultOpen?: boolean;
}) {
  const parentId = thread.parentThreadId ?? undefined;
  const options = useMemo(
    () =>
      buildParentSelectorOptions({
        currentThreadId: thread.id,
        parentThreads,
        parentThreadDisplayName,
        parentThreadId: parentId,
      }),
    [parentId, parentThreadDisplayName, parentThreads, thread.id],
  );
  if (!parentId && !canAssignToParent && !canTakeOverThread) return null;

  return (
    <DetailRow
      label={<DetailRowIconLabel icon="UserRound">Parent</DetailRowIconLabel>}
      valueClassName="min-w-0"
    >
      {parentId ? (
        <div
          className={cn(
            "inline-flex max-w-full min-w-0 items-center gap-1 text-foreground",
            COARSE_POINTER_TEXT_SM_CLASS,
          )}
        >
          <Link
            to={getThreadRoutePath({
              projectId: parentThreadProjectId ?? projectId,
              threadId: parentId,
            })}
            className={cn(
              "min-w-0 truncate text-foreground no-underline transition-[text-decoration-color] duration-150 hover:underline hover:underline-offset-2",
              COARSE_POINTER_TEXT_SM_CLASS,
            )}
          >
            {options.find((o) => o.value === parentId)?.label ??
              "Parent thread"}
          </Link>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-3.5 shrink-0 rounded-full p-0 text-muted-foreground hover:bg-transparent hover:text-foreground [&_[data-icon-root]]:size-3 max-md:pointer-coarse:h-9 max-md:pointer-coarse:w-9 max-md:pointer-coarse:[&_[data-icon-root]]:size-5"
            disabled={updateThreadPending}
            onClick={() => onAssignParent(null)}
            aria-label="Clear parent thread"
          >
            <Icon name="X" />
          </Button>
        </div>
      ) : (
        <ParentThreadPicker
          value="none"
          options={options}
          isLoading={isLoadingParentThreads}
          isError={isParentThreadsError}
          disabled={updateThreadPending}
          onChange={(v) => onAssignParent(v === "none" ? null : v)}
          onOpenChange={onParentSelectorOpenChange}
          onRetry={onRetryParentThreads}
          defaultOpen={defaultOpen}
        />
      )}
    </DetailRow>
  );
}

function ForksRow({
  thread,
  projectId,
}: {
  thread: Thread;
  projectId: string;
}) {
  const { data: forks = [] } = useThreads({
    projectId: thread.projectId,
    sourceThreadId: thread.id,
    originKind: "fork",
    archived: false,
  });
  if (forks.length === 0) return null;

  return (
    <DetailRow label="Forks" align="start" valueClassName="min-w-0">
      <TruncatedList
        items={forks}
        getKey={(f) => f.id}
        renderItem={(f) => (
          <Link
            to={getThreadRoutePath({ projectId, threadId: f.id })}
            className="block min-w-0 truncate text-xs text-foreground no-underline transition-[text-decoration-color] duration-150 hover:underline hover:underline-offset-2"
            title={getThreadDisplayTitle(f)}
          >
            {getThreadDisplayTitle(f)}
          </Link>
        )}
      />
    </DetailRow>
  );
}

export function ArchivedRow({ thread }: { thread: Thread }) {
  const unarchive = useUnarchiveThread();
  const pending = unarchive.isPending && unarchive.variables?.id === thread.id;
  const handleUnarchive = useCallback(
    () => unarchive.mutate({ id: thread.id }),
    [thread.id, unarchive],
  );
  if (thread.archivedAt == null) return null;
  return (
    <DetailRow label="Archived" valueClassName="min-w-0 truncate">
      <ThreadUnarchiveButton
        isPending={pending}
        onUnarchive={handleUnarchive}
      />
    </DetailRow>
  );
}

export function ThreadStorageRow({
  controller,
  filesError,
  isFilesLoading,
}: {
  controller: ThreadStorageBrowserController;
  filesError?: Error | null;
  isFilesLoading: boolean;
}) {
  if (controller.loadedFiles.length === 0 && filesError == null) return null;
  return (
    <DetailRow
      orientation="vertical"
      className="mt-3 min-h-32 flex-1"
      valueClassName="min-h-0 flex-1 overflow-hidden"
      labelClassName="flex items-center justify-between gap-2"
      label={
        <>
          <span>Thread storage</span>
          {!controller.isSearchOpen ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
                "shrink-0 text-muted-foreground",
              )}
              aria-label="Search files"
              onClick={controller.openSearch}
            >
              <Icon name="Search" />
            </Button>
          ) : null}
        </>
      }
    >
      <ThreadStorageBrowser
        controller={controller}
        filesError={filesError}
        isFilesLoading={isFilesLoading}
      />
    </DetailRow>
  );
}

export function ThreadMetadataCard({ children }: { children: ReactNode }) {
  const idleTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    },
    [],
  );
  const handleScroll = useCallback((ev: UIEvent<HTMLDListElement>) => {
    const node = ev.currentTarget;
    if (node.dataset.scrollbarScrolling !== "true") {
      node.dataset.scrollbarScrolling = "true";
    }
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => {
      idleTimer.current = null;
      node.removeAttribute("data-scrollbar-scrolling");
    }, 600);
  }, []);

  return (
    <DetailCard
      appearance="flat"
      className="transient-scrollbar min-h-0 flex-1 gap-1.5 overflow-x-hidden overflow-y-auto px-4 py-3"
      onScroll={handleScroll}
    >
      {children}
    </DetailCard>
  );
}

export function ThreadMetadataContent(p: ThreadMetadataContentProps) {
  return (
    <ThreadMetadataCard>
      <ParentSelectorRow
        thread={p.thread}
        projectId={p.projectId}
        parentThreadProjectId={p.parentThreadProjectId}
        parentThreadDisplayName={p.parentThreadDisplayName}
        parentThreads={p.parentThreads}
        canAssignToParent={p.canAssignToParent}
        canTakeOverThread={p.canTakeOverThread}
        isLoadingParentThreads={p.isLoadingParentThreads}
        isParentThreadsError={p.isParentThreadsError}
        updateThreadPending={p.updateThreadPending}
        onAssignParent={p.onAssignParent}
        onParentSelectorOpenChange={p.onParentSelectorOpenChange}
        onRetryParentThreads={p.onRetryParentThreads}
      />
      <ForksRow thread={p.thread} projectId={p.projectId} />
      <EnvironmentRow
        thread={p.thread}
        environment={p.environment}
        environmentDisplayHost={p.environmentDisplayHost}
      />
      <EnvironmentProvisioningFailureRow
        failed={p.environmentProvisioningFailure}
      />
      <WorkspacePathRow environment={p.environment} />
      <CloudWorkspaceRows path={p.cloudWorkspacePath} />
      <BranchRow workspaceStatus={p.workspaceStatus} />
      <MergeBaseRow
        workspaceStatus={p.workspaceStatus}
        selectedMergeBaseBranch={p.selectedMergeBaseBranch}
        mergeBaseBranchRef={p.mergeBaseBranchRef}
        mergeBaseBranchOptions={p.mergeBaseBranchOptions}
        mergeBaseRemoteBranchOptions={p.mergeBaseRemoteBranchOptions}
        isLoadingMergeBaseBranchOptions={p.isLoadingMergeBaseBranchOptions}
        onMergeBaseBranchChange={p.onMergeBaseBranchChange}
        onMergeBasePickerOpenChange={p.onMergeBasePickerOpenChange}
        onMergeBaseBranchSearchQueryChange={
          p.onMergeBaseBranchSearchQueryChange
        }
      />
      <GitStatusRow
        thread={p.thread}
        environment={p.environment}
        workspaceStatus={p.workspaceStatus}
        workspaceStatusError={p.workspaceStatusError}
        workspaceUnavailable={p.workspaceUnavailable}
        selectedMergeBaseBranch={p.selectedMergeBaseBranch}
      />
      <PullRequestRow pullRequest={p.pullRequest} />
      <ArchivedRow thread={p.thread} />
      <ThreadCommitsRow
        workspaceStatus={p.workspaceStatus}
        onCommitClick={p.onCommitClick}
      />
      <ChangedFilesRow
        workspaceStatus={p.workspaceStatus}
        onChangedFileClick={p.onChangedFileClick}
      />
      {p.storage ? <ThreadStorageRow {...p.storage} /> : null}
    </ThreadMetadataCard>
  );
}
