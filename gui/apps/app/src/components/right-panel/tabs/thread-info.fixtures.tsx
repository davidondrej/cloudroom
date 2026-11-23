import type { ReactNode } from "react";
import type { ThreadListEntry, ThreadPullRequest } from "@cloudroom/domain";
import type { EnvironmentDisplayHostContext } from "@cloudroom/core-ui";
import {
  makeEnvironment,
  makeThread,
  makeThreadListEntry,
  makeWorkspaceStatus,
} from "../../../../.ladle/story-fixtures";
import type { ThreadMetadataContentProps } from "./thread-info";

export { makeEnvironment, makeThread, makeWorkspaceStatus };

const idle = () => {};

export const localEnvironmentDisplayHost: EnvironmentDisplayHostContext = {
  locality: "local",
  identity: null,
};

export const parentThreads: ThreadListEntry[] = [
  { id: "thr_codex_parent", title: "Codex Parent" },
  { id: "thr_frontend_parent", title: "Frontend Parent" },
].map(({ id, title }) =>
  makeThreadListEntry({ id, title, titleFallback: title }),
);

export const PanelStage = ({ children }: { children: ReactNode }) => (
  <div className="w-full max-w-[480px] min-w-0 rounded-md border border-border bg-background px-4 py-3">
    {children}
  </div>
);

export const makePullRequest = (
  overrides: Partial<ThreadPullRequest> = {},
): ThreadPullRequest => ({
  number: 128,
  title: "Display branch PR status in thread details",
  state: "open",
  url: "https://github.com/acme/cloudroom/pull/128",
  baseRefName: "main",
  headRefName: "room/pr-details",
  updatedAt: "2026-06-16T12:30:00Z",
  checks: {
    state: "passing",
    totalCount: 3,
    passedCount: 3,
    failedCount: 0,
    pendingCount: 0,
  },
  review: { state: "approved", reviewRequestCount: 0 },
  mergeability: {
    state: "mergeable",
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
  },
  attention: "ready_to_merge",
  ...overrides,
});

export const baseProps: ThreadMetadataContentProps = {
  thread: makeThread(),
  projectId: "proj_room",
  parentThreadProjectId: null,
  parentThreadDisplayName: null,
  parentThreads,
  canAssignToParent: true,
  canTakeOverThread: false,
  isLoadingParentThreads: false,
  isParentThreadsError: false,
  environment: makeEnvironment(),
  environmentProvisioningFailure: false,
  environmentDisplayHost: localEnvironmentDisplayHost,
  workspaceStatus: makeWorkspaceStatus(),
  workspaceStatusError: null,
  pullRequest: null,
  selectedMergeBaseBranch: undefined,
  mergeBaseBranchOptions: ["main", "develop", "release/2026-04"],
  isLoadingMergeBaseBranchOptions: false,
  updateThreadPending: false,
  onAssignParent: idle,
  onParentSelectorOpenChange: idle,
  onRetryParentThreads: idle,
  onMergeBaseBranchChange: idle,
  onChangedFileClick: idle,
};
