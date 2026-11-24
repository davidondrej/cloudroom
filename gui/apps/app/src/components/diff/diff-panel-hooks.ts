import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  resolveEnvironmentMergeBaseBranch,
  type Environment,
  type GitBranchRefClassification,
  type Thread,
  type WorkspaceStatus,
} from "@cloudroom/domain";
import { appToast } from "@/components/ui/app-toast";
import {
  describeLifecycleError,
  parseLifecycleError,
} from "@/lib/lifecycle-errors";
import { showMutationErrorToast } from "@/lib/mutation-errors";
import { useUpdateEnvironment } from "@/hooks/mutations/environment-mutations";
import {
  useEnvironmentMergeBaseBranches,
  useEnvironmentWorkStatus,
} from "@/hooks/queries/environment-queries";
import type {
  SecondaryFixedPanelTab,
  ThreadSecondaryPanel,
} from "@/components/right-panel/store/tab-model";
import {
  ALL_GIT_DIFF_SELECTION,
  buildGitDiffSelectionOptions,
  buildGitDiffTarget,
  shouldResetSelectedGitDiffSelection,
  type GitDiffDisplayMode,
  type GitDiffDisplayModeChangeHandler,
  type GitDiffSelectionOption,
  type GitDiffSelectionValue,
} from "./diff-store";

// --- Merge-Base Management ---

export function shouldSyncSelectedMergeBaseBranch(args: {
  hasPersistedMergeBase?: boolean;
  nextStateKey?: string;
  persistedMergeBaseBranch?: string | null;
  previousStateKey?: string;
  selectedMergeBaseBranch?: string;
  updatePending: boolean;
}): boolean {
  if (args.previousStateKey !== args.nextStateKey) return true;
  if (!(args.hasPersistedMergeBase ?? true) || args.updatePending) return false;
  return (
    args.selectedMergeBaseBranch !==
    (args.persistedMergeBaseBranch ?? undefined)
  );
}

export function resolveEffectiveMergeBaseBranch(args: {
  environment?: Environment;
  selectedMergeBaseBranch?: string;
  workspaceStatus?: WorkspaceStatus;
}): string | undefined {
  return (
    args.selectedMergeBaseBranch ??
    args.environment?.mergeBaseBranch ??
    args.environment?.baseBranch ??
    args.workspaceStatus?.mergeBase?.mergeBaseBranch ??
    args.workspaceStatus?.branch.defaultBranch ??
    resolveEnvironmentMergeBaseBranch(args.environment)
  );
}

export function resolvePersistedMergeBaseBranch(args: {
  branch: string;
  environment?: Environment;
  workspaceStatus?: WorkspaceStatus;
}): string | null {
  const trimmed = args.branch.trim();
  if (!trimmed) return null;
  const implicit =
    args.environment?.baseBranch ??
    args.workspaceStatus?.branch.defaultBranch ??
    args.environment?.defaultBranch;
  return trimmed === implicit ? null : trimmed;
}

export function useEnvironmentMergeBase({
  environment,
  selectedMergeBaseBranch,
  setSelectedMergeBaseBranch,
  thread,
  updateEnvironment,
  workspaceStatus,
}: {
  environment?: Environment;
  selectedMergeBaseBranch?: string;
  setSelectedMergeBaseBranch: (branch: string | undefined) => void;
  thread?: Thread;
  updateEnvironment: ReturnType<typeof useUpdateEnvironment>;
  workspaceStatus?: WorkspaceStatus;
}) {
  const stateKeyRef = useRef<string | undefined>(undefined);
  const stateKey = environment?.id ?? thread?.id;
  const pending =
    updateEnvironment.isPending &&
    updateEnvironment.variables?.id === environment?.id;

  useEffect(() => {
    if (
      !shouldSyncSelectedMergeBaseBranch({
        hasPersistedMergeBase: thread?.executionTarget !== "cloud",
        previousStateKey: stateKeyRef.current,
        nextStateKey: stateKey,
        persistedMergeBaseBranch: environment?.mergeBaseBranch,
        selectedMergeBaseBranch,
        updatePending: pending,
      })
    ) {
      return;
    }
    stateKeyRef.current = stateKey;
    setSelectedMergeBaseBranch(environment?.mergeBaseBranch ?? undefined);
  }, [
    environment?.mergeBaseBranch,
    pending,
    selectedMergeBaseBranch,
    setSelectedMergeBaseBranch,
    stateKey,
    thread?.executionTarget,
  ]);

  const effectiveMergeBaseBranch = resolveEffectiveMergeBaseBranch({
    environment,
    selectedMergeBaseBranch,
    workspaceStatus,
  });
  const showBranchComparisonUi = Boolean(
    effectiveMergeBaseBranch || workspaceStatus?.branch.defaultBranch,
  );
  const isOnDefault =
    workspaceStatus?.branch.currentBranch != null &&
    workspaceStatus.branch.currentBranch ===
      workspaceStatus.branch.defaultBranch;
  const showMergeBase =
    showBranchComparisonUi && Boolean(effectiveMergeBaseBranch) && !isOnDefault;

  const handleMergeBaseBranchChange = useCallback(
    (branch: string) => {
      const trimmed = branch.trim();
      if (!environment || !thread?.environmentId) {
        if (thread?.executionTarget === "cloud")
          setSelectedMergeBaseBranch(trimmed);
        return;
      }
      const persisted = resolvePersistedMergeBaseBranch({
        branch: trimmed,
        environment,
        workspaceStatus,
      });
      setSelectedMergeBaseBranch(trimmed);
      if (persisted === environment.mergeBaseBranch) return;

      updateEnvironment.mutate(
        { id: environment.id, mergeBaseBranch: persisted },
        {
          onError: (error) => {
            setSelectedMergeBaseBranch(
              environment.mergeBaseBranch ?? undefined,
            );
            const lc = parseLifecycleError(error);
            if (
              lc?.code === "environment_not_ready" &&
              lc.details.environmentStatus === "provisioning"
            )
              return;
            const desc = describeLifecycleError({
              error,
              operation: "update_merge_base",
            });
            if (desc) {
              if (desc.severity === "error")
                appToast.error(desc.title, { description: desc.body });
              else appToast.warning(desc.title, { description: desc.body });
              return;
            }
            showMutationErrorToast({
              error,
              fallbackMessage: "Failed to update merge base branch",
              lifecycleOperation: "update_merge_base",
            });
          },
        },
      );
    },
    [
      environment,
      setSelectedMergeBaseBranch,
      thread,
      updateEnvironment,
      workspaceStatus,
    ],
  );

  return {
    effectiveMergeBaseBranch,
    handleMergeBaseBranchChange,
    showBranchComparisonUi,
    showMergeBase,
  };
}

// --- Diff Panel Intent & Branch Options ---

function prependSelected(
  list: string[] | undefined,
  ref: GitBranchRefClassification | null | undefined,
  kind: "local" | "remote",
): string[] | undefined {
  if (!list) return undefined;
  return ref?.kind === kind && !list.includes(ref.name)
    ? [ref.name, ...list]
    : list;
}

export function useGitDiffPanel({
  activeSecondaryTab,
  clearActiveFileTabs,
  defaultMergeBaseBranch,
  environmentId,
  mergeBaseBranchOptionsEnabled = false,
  setThreadSecondaryPanel,
  threadId,
}: {
  activeSecondaryTab: SecondaryFixedPanelTab | null;
  clearActiveFileTabs: () => void;
  defaultMergeBaseBranch?: string;
  environmentId?: string;
  mergeBaseBranchOptionsEnabled?: boolean;
  setThreadSecondaryPanel: (panel: ThreadSecondaryPanel | null) => void;
  threadId: string;
}) {
  const [branchState, setBranchState] = useState<{
    branch?: string;
    environmentId?: string;
  }>({ environmentId });
  const selectedMergeBaseBranch =
    branchState.environmentId === environmentId
      ? branchState.branch
      : undefined;
  const setSelectedMergeBaseBranch = useCallback(
    (branch: string | undefined) => setBranchState({ branch, environmentId }),
    [environmentId],
  );

  const [intent, setIntent] = useState<
    | { environmentId?: string; kind: "commit"; sha: string; threadId: string }
    | { environmentId?: string; kind: "file"; path: string; threadId: string }
    | null
  >(null);
  const currentIntent =
    intent &&
    intent.environmentId === environmentId &&
    intent.threadId === threadId
      ? intent
      : null;

  const clearPendingGitDiffIntent = useCallback(() => {
    setIntent((cur) =>
      cur && cur.environmentId === environmentId && cur.threadId === threadId
        ? null
        : cur,
    );
  }, [environmentId, threadId]);

  const [searchQuery, setMergeBaseBranchSearchQuery] = useState("");
  const requestedMergeBaseBranch =
    selectedMergeBaseBranch ?? defaultMergeBaseBranch;
  const { data: branches, isFetching: isLoadingMergeBaseBranchOptions } =
    useEnvironmentMergeBaseBranches(environmentId ?? "", {
      enabled:
        Boolean(environmentId) &&
        (mergeBaseBranchOptionsEnabled ||
          activeSecondaryTab?.kind === "git-diff"),
      query: searchQuery,
      selectedBranch: requestedMergeBaseBranch,
    });

  const mergeBaseBranchOptions = useMemo(
    () =>
      prependSelected(branches?.branches, branches?.selectedBranch, "local"),
    [branches?.branches, branches?.selectedBranch],
  );
  const mergeBaseRemoteBranchOptions = useMemo(
    () =>
      prependSelected(
        branches?.remoteBranches,
        branches?.selectedBranch,
        "remote",
      ),
    [branches?.remoteBranches, branches?.selectedBranch],
  );

  useEffect(() => {
    setMergeBaseBranchSearchQuery("");
    setIntent(null);
  }, [environmentId, threadId]);

  const openThreadDiffPanel = useCallback(
    () => setThreadSecondaryPanel("git-diff"),
    [setThreadSecondaryPanel],
  );
  const closeThreadSecondaryPanel = useCallback(
    () => setThreadSecondaryPanel(null),
    [setThreadSecondaryPanel],
  );
  const openDiffFile = useCallback(
    (path: string) => {
      clearActiveFileTabs();
      setIntent({ environmentId, kind: "file", path, threadId });
      openThreadDiffPanel();
    },
    [clearActiveFileTabs, environmentId, openThreadDiffPanel, threadId],
  );
  const openCommitDiff = useCallback(
    (sha: string) => {
      clearActiveFileTabs();
      setIntent({ environmentId, kind: "commit", sha, threadId });
      openThreadDiffPanel();
    },
    [clearActiveFileTabs, environmentId, openThreadDiffPanel, threadId],
  );

  return {
    clearPendingGitDiffIntent,
    closeThreadSecondaryPanel,
    isLoadingMergeBaseBranchOptions,
    mergeBaseBranchOptions,
    mergeBaseRemoteBranchOptions,
    openCommitDiff,
    openDiffFile,
    openThreadDiffPanel,
    pendingGitDiffCommitSha:
      currentIntent?.kind === "commit" ? currentIntent.sha : null,
    pendingGitDiffScrollPath:
      currentIntent?.kind === "file" ? currentIntent.path : null,
    requestedMergeBaseBranch,
    selectedMergeBaseBranch,
    selectedMergeBaseBranchRef: branches?.selectedBranch,
    setMergeBaseBranchSearchQuery,
    setSelectedMergeBaseBranch,
  };
}

// --- Diff Selection State ---

export function useGitDiffPanelState({
  environmentId,
  isDiffPanelActive,
  requestedMergeBaseBranch,
  onClearPendingGitDiffIntent,
  pendingGitDiffCommitSha,
  pendingGitDiffScrollPath,
}: {
  environmentId?: string;
  isDiffPanelActive: boolean;
  onClearPendingGitDiffIntent?: () => void;
  pendingGitDiffCommitSha?: string | null;
  pendingGitDiffScrollPath?: string | null;
  requestedMergeBaseBranch?: string;
}) {
  const [selection, setSelection] = useState<GitDiffSelectionValue>(null);
  const gitDiffTarget = useMemo(
    () => buildGitDiffTarget(selection, requestedMergeBaseBranch),
    [requestedMergeBaseBranch, selection],
  );
  const { data: workStatus } = useEnvironmentWorkStatus(
    environmentId ?? "",
    requestedMergeBaseBranch,
    {
      enabled:
        Boolean(environmentId) &&
        Boolean(requestedMergeBaseBranch) &&
        isDiffPanelActive,
    },
  );
  const ws =
    workStatus?.outcome === "available" ? workStatus.workspace : undefined;

  useEffect(() => setSelection(null), [environmentId]);
  useEffect(() => {
    if (pendingGitDiffScrollPath) setSelection(null);
  }, [pendingGitDiffScrollPath]);
  useEffect(() => {
    if (pendingGitDiffCommitSha) {
      setSelection(pendingGitDiffCommitSha);
      onClearPendingGitDiffIntent?.();
    }
  }, [onClearPendingGitDiffIntent, pendingGitDiffCommitSha]);

  const hasUncommitted = (ws?.workingTree.files.length ?? 0) > 0;
  const commits = useMemo(
    () => ws?.mergeBase?.commits ?? [],
    [ws?.mergeBase?.commits],
  );
  useEffect(() => {
    if (
      shouldResetSelectedGitDiffSelection(selection, commits, {
        hasUncommittedChanges: hasUncommitted,
      })
    ) {
      setSelection(null);
    }
  }, [commits, hasUncommitted, selection]);

  const gitDiffSelectOptions: GitDiffSelectionOption[] = useMemo(
    () =>
      buildGitDiffSelectionOptions(commits, {
        hasUncommittedChanges: hasUncommitted,
      }),
    [commits, hasUncommitted],
  );
  const onGitDiffSelectionChange = useCallback(
    (val: string) => setSelection(val === ALL_GIT_DIFF_SELECTION ? null : val),
    [],
  );

  return {
    gitDiffSelectOptions,
    gitDiffSelectValue: selection ?? ALL_GIT_DIFF_SELECTION,
    gitDiffTarget,
    onGitDiffSelectionChange,
  };
}

// --- Responsive Unified vs Split Display ---

const SPLIT_MIN_WIDTH_PX = 760;

export function useResponsiveGitDiffPanelDisplay({
  isSecondaryPanelOpen,
}: {
  isSecondaryPanelOpen: boolean;
}) {
  const [gitDiffDisplayMode, setMode] = useState<GitDiffDisplayMode>("unified");
  const lastWideRef = useRef<boolean | null>(null);
  const explicitRef = useRef(false);

  const handleSecondaryPanelWidthChange = useCallback(
    (nextWidth: number | undefined) => {
      if (!isSecondaryPanelOpen || nextWidth === undefined) return;
      const wide = nextWidth >= SPLIT_MIN_WIDTH_PX;
      const crossed =
        lastWideRef.current !== null && lastWideRef.current !== wide;
      if (crossed && explicitRef.current) explicitRef.current = false;
      if (!explicitRef.current || crossed) {
        const next: GitDiffDisplayMode = wide ? "split" : "unified";
        setMode((cur) => (cur === next ? cur : next));
      }
      lastWideRef.current = wide;
    },
    [isSecondaryPanelOpen],
  );

  useEffect(() => {
    if (!isSecondaryPanelOpen) {
      explicitRef.current = false;
      lastWideRef.current = null;
    }
  }, [isSecondaryPanelOpen]);

  const handleGitDiffDisplayModeChange =
    useCallback<GitDiffDisplayModeChangeHandler>((next) => {
      explicitRef.current = true;
      setMode(next);
    }, []);

  const handleSecondaryPanelResizeStart = useCallback(() => {
    explicitRef.current = false;
  }, []);

  return {
    gitDiffDisplayMode,
    handleGitDiffDisplayModeChange,
    handleSecondaryPanelResizeStart,
    handleSecondaryPanelWidthChange,
  };
}
