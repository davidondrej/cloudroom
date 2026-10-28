import { ThreadMachineStatus } from "@/components/promptbox/banner/ThreadMachineStatus";
import { TeleportLocalNotice, TeleportNotice } from "@/components/thread/TeleportNotice";
import { TeleportCheckCard } from "@/components/thread/TeleportCheckCard";
import { TryCloudCard } from "@/components/thread/TryCloudCard";
import { ProjectCopyNotice } from "@/components/thread/ProjectCopyNotice";
import { CopyButton } from "@/components/ui/copy-button";
import { cloudThreadFixPrompt } from "@/lib/fix-prompts";
import { canTeleportLocalThread, canTeleportThread } from "@/components/thread/ThreadActionsMenu";
import { ClaudeSignIn } from "@/components/ClaudeConnection";
import { LocalSignInNotice } from "@/components/LocalSignInNotice";
import { CloudMcpSignInNotice } from "@/components/CloudMcpSignIn";
import { openCodexConnection, openCursorConnection, openTeleportLogin } from "@/components/CodexConnectionPanel";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useIsMutating, useQueryClient } from "@tanstack/react-query";
import { Icon, type IconName } from "@cloudroom/shared-ui/icon";
import { Button } from "@cloudroom/shared-ui/button";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { CloudDiskNotice, CloudUsageLimitNotice } from "@/components/CloudUsageLimitNotice";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import {
  getFollowUpPromptPlaceholder,
  getCompactFollowUpPromptPlaceholder,
  getFollowUpPromptPlaceholderHint,
} from "@/components/promptbox/follow-up-placeholder";
import { PERSONAL_PROJECT_ID } from "@cloudroom/domain";
import type {
  ReasoningLevel,
  PendingInteraction,
  PromptInput,
  ThreadQueuedMessage,
  ThreadPullRequest,
  ThreadTimelineActivePromptMode,
  ThreadTimelineGoal,
  ThreadTimelineModelFallback,
  ThreadTimelinePendingTodos,
  ThreadWithRuntime,
} from "@cloudroom/domain";
import type {
  PullRequestMergeMethod,
  SendMessageRequest,
  ThreadTimelineResponse,
  TimelineWorkflowWorkRow,
} from "@cloudroom/server-contract";
import type { ExperimentalComposerSubmitOptions } from "@get-bb/plugin-sdk";
import type { ChildThreadPendingAttention } from "@/hooks/queries/child-thread-pending-interactions";
import { ThreadPendingInteractionBanner } from "@/components/thread/pending-interactions/ThreadPendingInteractionBanner";
import {
  type PluginComposerHost,
  useComposerHostDraftNotifier,
  usePublishPluginComposerHost,
} from "@/components/plugin/plugin-composer-host";
import {
  ThreadPromptContextBanner,
  type ContextBannerMergeBaseConfig,
  type ThreadPromptContextBannerExpandedSection,
  type ThreadPromptParentThreadSection,
  type ThreadPromptPullRequestSection,
} from "@/components/promptbox/banner/ThreadPromptContextBanner";
import { ThreadGoalCard } from "@/components/promptbox/banner/ThreadGoalCard";
import { ThreadTodoCard } from "@/components/promptbox/banner/ThreadTodoCard";
import { ThreadPromptModeCard } from "@/components/promptbox/banner/ThreadPromptModeCard";
import { ThreadWorkflowCard } from "@/components/promptbox/banner/ThreadWorkflowCard";
import { ThreadBackgroundCommandsCard } from "@/components/promptbox/banner/ThreadBackgroundCommandsCard";
import { ThreadModelFallbackCard } from "@/components/promptbox/banner/ThreadModelFallbackCard";
import { InlineMessageEditorFrame } from "@/components/promptbox/InlineMessageEditorFrame";
import type { ModelReasoningPickerSelection } from "@/components/pickers/ModelReasoningPicker";
import type {
  WorkspaceChangedFileSelection,
  WorkspaceChangedFilesSection,
} from "@/components/workspace/workspace-change-summary";
import {
  QueuedMessagesList,
  QueuedMessagesPendingCard,
  type QueuedMessageInlineEditor,
} from "@/components/promptbox/banner/QueuedMessagesList";
import { ThreadEnvironmentSummary } from "@/components/promptbox/ThreadEnvironmentSummary";
import type { MachineLabelHost } from "@/components/machines/MachineLabel";
import type { MachineProviderPresentation } from "@/components/plugin/MachineProviderIcon";
import {
  formatWorkspaceCheckoutDisplay,
  type WorkspaceCheckoutDisplay,
} from "@/lib/workspace-checkout-display";
import { CLOUDROOM_CLOUD_PRIMARY } from "@/lib/cloudroom-environment-label";
import { useComposerTextEffects } from "@/lib/composer-text-effects";
import { useCloudThreadWake } from "@/hooks/useCloudThreadWake";
import { useLatestRef } from "@/hooks/useLatestRef";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import { resolveModelReasoningLevel } from "@/hooks/thread-creation-options/model-catalog-selection";
import { useProjectDisplayName } from "@/hooks/queries/sidebar-navigation-query";
import {
  useActiveComposerDraft,
  useComposerAttachmentUploads,
  useDraftAttachmentUploads,
  useComposerTypeahead,
  useInlineQueuedMessageEditing,
  useQueuedMessageActions,
  type InlineQueuedMessageEditState,
} from "@/components/thread/embedded-chat";
import {
  useCreateThreadQueuedMessage,
  useCancelThreadPlan,
  useClearThreadGoal,
  useSetThreadGoalStatus,
  useStopThread,
} from "@/hooks/mutations/thread-runtime-mutations";
import {
  useUnarchiveThread,
  useUpdateThread,
} from "@/hooks/mutations/thread-state-mutations";
import {
  getLatestPendingInteraction,
  useThreadQueuedMessages,
  useThreadPromptHistory,
} from "@/hooks/queries/thread-queries";
import { useThreadDefaultExecutionOptions } from "@/hooks/queries/thread-default-execution-options-query";
import {
  getMutationErrorMessage,
  showMutationErrorToast,
} from "@/lib/mutation-errors";
import { promptHistoryEntriesToDrafts } from "@/lib/prompt-history";
import { usePromptHistoryEnabled } from "@/hooks/usePromptHistoryEnabled";
import {
  emptyPromptDraftState,
  promptDraftToInput,
  type PromptDraftAttachment,
  type PromptDraftState,
} from "@cloudroom/client-core";
import {
  FollowUpPromptBox,
  type FollowUpComposerProps,
  type FollowUpPromptBoxProps,
  type FollowUpSubmitMode,
} from "@/components/promptbox/FollowUpPromptBox";
import type { SendMessageMutationLike } from "./threadDetailMutationTypes";
import {
  buildAutoFollowUpRequest,
  buildCreateQueuedFollowUpRequest,
  buildFollowUpSubmitMode,
  buildFollowUpShortcutRequest,
  canSubmitFollowUpShortcut,
  resolveDefaultExecutionOptionsState,
  shouldQueueFollowUpMessage,
  type FollowUpExecutionSelection,
} from "@cloudroom/client-core";

const ignorePromptBannerFileClick = () => {};

export interface ThreadDetailSentMessageEdit {
  draft: PromptDraftState;
  hostElement: HTMLDivElement | null;
  isSubmitting: boolean;
  operationId: string;
  onCancel: () => void;
  onSubmit: (target: {
    execution: FollowUpExecutionSelection;
    input: PromptInput[];
  }) => void;
  updateDraft: (
    update: (current: PromptDraftState) => PromptDraftState,
  ) => void;
}

const THREAD_DETAIL_COMPOSER_TEXTAREA_ID = "thread-detail-follow-up-composer";
const EMPTY_QUEUED_MESSAGES: readonly ThreadQueuedMessage[] = [];

interface ThreadDetailPromptAreaProps {
  activeBackgroundAgentCount: number;
  canUseGitUi: boolean;
  contextWindowUsage?: ThreadTimelineResponse["contextWindowUsage"];
  environmentCheckout?: WorkspaceCheckoutDisplay;
  environmentCompactLabel?: string;
  environmentGoneStatus: "destroyed" | null;
  environmentHostId?: string;
  environmentHost?: MachineLabelHost;
  environmentMachineProvider?: MachineProviderPresentation | null;
  environmentIcon?: IconName;
  environmentLabel?: string;
  environmentProviderName?: string;
  onCreateNewThreadInEnvironment?: () => void;
  onPullRequestDraft?: () => void;
  onPullRequestMerge?: (method: PullRequestMergeMethod) => void;
  onPullRequestReady?: () => void;
  pullRequestMergeMethod: PullRequestMergeMethod;
  isEnvironmentActionPending: boolean;
  pendingInteractions: readonly PendingInteraction[];
  pendingInteractionsInitialLoading: boolean;
  providerAuthFailed?: boolean;
  queuedMessageCount: number;
  onChangedFileClick: (selection: WorkspaceChangedFileSelection) => void;
  projectId: string;
  resolveMentionLink: PromptMentionLinkResolver;
  workspaceChangedFilesSection: WorkspaceChangedFilesSection | null;
  workspaceStatusPending: boolean;
  contextBannerMergeBase: ContextBannerMergeBaseConfig | null;
  pendingTodos: ThreadTimelinePendingTodos | null;
  activePromptMode: ThreadTimelineActivePromptMode | null;
  goal: ThreadTimelineGoal | null;
  modelFallback: ThreadTimelineModelFallback | null;
  activeWorkflows: TimelineWorkflowWorkRow[];
  activeBackgroundCommands: TimelineWorkflowWorkRow[];
  parentThreadSection: ThreadPromptParentThreadSection | null;
  childPendingInteractions: readonly ChildThreadPendingAttention[];
  pullRequest: ThreadPullRequest | null;
  sendMessage: SendMessageMutationLike;
  sentMessageEdit?: ThreadDetailSentMessageEdit;
  steerActiveThreadOnEnter: boolean;
  composerFocusRequestNonce: number;
  thread: ThreadWithRuntime;
}

interface InlineDraftComposerOptions {
  attachments: FollowUpPromptBoxProps["attachments"];
  canModifierSubmit: boolean;
  compactPromptPlaceholder: string;
  composerId: string;
  draft: PromptDraftState;
  editFocusNonce: number;
  execution: FollowUpPromptBoxProps["execution"];
  executionReadOnly?: boolean;
  focusSessionKey: string | number;
  historyResetKey: string;
  isSubmitting: boolean;
  onChangeMessage: FollowUpComposerProps["onChangeMessage"];
  onEscape?: FollowUpComposerProps["onEscape"];
  onSelectHistoryEntry: (draft: PromptDraftState) => void;
  permission: FollowUpPromptBoxProps["permission"];
  pluginComposerHost: PluginComposerHost;
  promptActions: FollowUpPromptBoxProps["promptActions"];
  promptPlaceholder: string;
  submit: () => void;
  submitMode: FollowUpSubmitMode;
  submitTitle?: string;
  suppressPluginComposerCustomizations?: boolean;
  textEffects: FollowUpPromptBoxProps["textEffects"];
  threadRuntimeDisplayStatus: FollowUpComposerProps["threadRuntimeDisplayStatus"];
  typeahead: FollowUpPromptBoxProps["typeahead"];
  collapseResetKey: string;
}

function buildInlineDraftComposer(options: InlineDraftComposerOptions) {
  return (
    <FollowUpPromptBox
      id={options.composerId}
      attachments={options.attachments}
      stack={null}
      composer={{
        history: {
          currentDraft: options.draft,
          entries: [],
          onSelectEntry: options.onSelectHistoryEntry,
          resetKey: options.historyResetKey,
        },
        isFollowUpSubmitting: options.isSubmitting,
        message: options.draft.text,
        mentionRanges: options.draft.mentions,
        onChangeMessage: options.onChangeMessage,
        onModifierSubmit: options.submit,
        onSubmit: options.submit,
        onEscape: options.onEscape,
        submitTitle: options.submitTitle,
        compactPromptPlaceholder: options.compactPromptPlaceholder,
        promptPlaceholder: options.promptPlaceholder,
        canModifierSubmit: options.canModifierSubmit,
        steerActiveThreadOnEnter: false,
        submitMode: options.submitMode,
        threadRuntimeDisplayStatus: options.threadRuntimeDisplayStatus,
      }}
      pluginComposerHost={options.pluginComposerHost}
      pluginComposerScope={options.pluginComposerHost.scope}
      suppressPluginComposerCustomizations={
        options.suppressPluginComposerCustomizations
      }
      textEffects={options.textEffects}
      environmentSummary={null}
      contextWindowUsage={null}
      execution={options.execution}
      executionReadOnly={options.executionReadOnly ?? true}
      permission={options.permission}
      permissionReadOnly
      typeahead={options.typeahead}
      promptActions={options.promptActions}
      collapseResetKey={options.collapseResetKey}
      focusEndKey={`${options.focusSessionKey}:${options.editFocusNonce}`}
      isPrimaryComposer={false}
      showScrollToBottomButton={false}
    />
  );
}

type InlineQueuedMessageEditSession = Pick<
  InlineQueuedMessageEditState,
  "editSessionId" | "queuedMessageId"
>;

function isInlineQueuedMessageEditSession(
  current: InlineQueuedMessageEditState | null,
  session: InlineQueuedMessageEditSession,
): current is InlineQueuedMessageEditState {
  return (
    current?.editSessionId === session.editSessionId &&
    current.queuedMessageId === session.queuedMessageId
  );
}

const ENDED_EDIT_SESSION_DRAFT = emptyPromptDraftState();

function readInlineQueuedMessageDraft(
  editStateRef: RefObject<InlineQueuedMessageEditState | null>,
  session: InlineQueuedMessageEditSession,
  fallback: PromptDraftState,
): PromptDraftState {
  const current = editStateRef.current;
  return isInlineQueuedMessageEditSession(current, session)
    ? current.draft
    : fallback;
}

function writeInlineQueuedMessageDraft(
  editStateRef: RefObject<InlineQueuedMessageEditState | null>,
  session: InlineQueuedMessageEditSession,
  draft: PromptDraftState,
  commit: (next: InlineQueuedMessageEditState) => void,
): void {
  const current = editStateRef.current;
  if (isInlineQueuedMessageEditSession(current, session)) {
    commit({ ...current, draft });
  }
}

function readSentMessageEditDraft(
  sentMessageEditRef: RefObject<ThreadDetailSentMessageEdit | undefined>,
  operationId: string,
  fallback: PromptDraftState,
): PromptDraftState {
  const current = sentMessageEditRef.current;
  return current?.operationId === operationId ? current.draft : fallback;
}

function writeSentMessageEditDraft(
  sentMessageEditRef: RefObject<ThreadDetailSentMessageEdit | undefined>,
  operationId: string,
  nextDraft: PromptDraftState,
): void {
  const current = sentMessageEditRef.current;
  if (current?.operationId === operationId) {
    current.updateDraft(() => nextDraft);
  }
}

async function runWhileFollowUpShortcutSending(
  setSending: (sending: boolean) => void,
  task: () => Promise<void>,
): Promise<void> {
  setSending(true);
  try {
    await task();
  } finally {
    setSending(false);
  }
}

import { showCloudSignIn, useCloudLocked } from "@/hooks/useCloudLocked";
import { useCloudroomThread, useSetCloudReasoning, useCloudroomThreadWorkspace, useCloudroomConnection, useRetryCloudStart, useTeleportThread, useTeleportLocal, useTeleportDirection, cloudroomRequestId, clearCloudroomRequestId, cloudReasoningLevels, cloudServiceTierSupported, cloudFeatureSupported, cloudCanRunHarness, cloudHarness } from "@/hooks/queries/cloudroom-queries";
import { reasoningLevelSchema } from "@cloudroom/domain";
import { reasoningLevelLabel } from "@/lib/reasoning-labels";
import { useCopyCommand } from "@/hooks/useCopyCommand";

const plainCloudError = (error: string) =>
  error.includes("storage unsafe") ? "Cloud disk is full" : error.replace(/^Cloudroom rejected the request \(HTTP \d+\): /, "");

export function ThreadDetailPromptArea({
  activeBackgroundAgentCount,
  canUseGitUi,
  contextWindowUsage,
  environmentCheckout,
  environmentCompactLabel,
  environmentGoneStatus,
  environmentHostId,
  environmentHost,
  environmentMachineProvider,
  environmentIcon,
  environmentLabel,
  environmentProviderName,
  onCreateNewThreadInEnvironment,
  onPullRequestDraft,
  onPullRequestMerge,
  onPullRequestReady,
  pullRequestMergeMethod,
  isEnvironmentActionPending,
  pendingInteractions,
  pendingInteractionsInitialLoading,
  providerAuthFailed = false,
  queuedMessageCount,
  onChangedFileClick,
  projectId,
  resolveMentionLink,
  workspaceChangedFilesSection,
  workspaceStatusPending,
  contextBannerMergeBase,
  pendingTodos,
  activePromptMode,
  goal,
  modelFallback,
  activeWorkflows,
  activeBackgroundCommands,
  parentThreadSection,
  childPendingInteractions,
  pullRequest,
  sendMessage,
  sentMessageEdit,
  steerActiveThreadOnEnter,
  composerFocusRequestNonce,
  thread,
}: ThreadDetailPromptAreaProps) {
  const isCloud = thread.executionTarget === "cloud";
  const teleporting = Boolean(thread.teleport && !["complete", "cancelled"].includes(thread.teleport.phase));
  const transferredChild = Boolean(thread.teleport?.phase === "complete" && thread.teleport.owner !== thread.id);
  const cloudState = useCloudroomThread(thread.id, isCloud);
  const teleport = useTeleportThread(thread.id);
  const canTeleport = canTeleportThread(thread);
  const cloudLocked = useCloudLocked();
  const startTeleport = useCallback(() => cloudLocked ? showCloudSignIn() : teleport.mutate("start"), [cloudLocked, teleport.mutate]);
  const teleportLocal = useTeleportLocal(thread.id);
  const movingToLocal = useTeleportDirection(thread) === "local";
  const canTeleportLocal = canTeleportLocalThread(thread) && !movingToLocal;
  const startTeleportLocal = useCallback(() => teleportLocal.mutate(), [teleportLocal.mutate]);
  const authThreadId = thread.id;
  const claudeThread = thread.providerId === "claude-code";
  const openCloudConnection = thread.providerId === "acp-cursor" ? openCursorConnection : openCodexConnection;
  useEffect(() => {
    // Claude connects through its own sign-in card in the cloud notice below.
    if (cloudState.data?.authRequired && !claudeThread) openCloudConnection(authThreadId);
  }, [cloudState.data?.authRequired, claudeThread, authThreadId, openCloudConnection]);
  useEffect(() => { if (teleport.error) openTeleportLogin(teleport.error, thread.providerId); }, [teleport.error, thread.providerId]);
  const cloudWorkspace = useCloudroomThreadWorkspace(
    thread.id,
    isCloud && Boolean(cloudState.data?.sessionId),
  );
  const cloudCheckout = useMemo(() => {
    // Hide the chip until the branch is known; after a failed refresh keep the last one, marked stale.
    const workspace = cloudWorkspace.data;
    if (!workspace) return undefined;
    const display = workspace.branch
      ? formatWorkspaceCheckoutDisplay({
          checkout: workspace.head
            ? { kind: "branch", branchName: workspace.branch, headSha: workspace.head }
            : { kind: "unborn", branchName: workspace.branch },
        })
      : workspace.head
        ? formatWorkspaceCheckoutDisplay({ checkout: { kind: "detached", headSha: workspace.head } })
        : {
            ...formatWorkspaceCheckoutDisplay({
              checkout: { kind: "unknown", reason: "No Git branch information is available for this cloud folder." },
            }),
            label: "No Git repository",
          };
    return cloudWorkspace.isError
      ? { ...display, stale: true, title: `${display.title} (last known, cloud not reachable right now)` }
      : display;
  }, [cloudWorkspace.data, cloudWorkspace.isError]);
  const cloudConnection = useCloudroomConnection();
  const setCloudReasoning = useSetCloudReasoning(thread.id);
  const cloudReasoning = (setCloudReasoning.isPending ? setCloudReasoning.variables : undefined) ?? cloudState.data?.reasoning ?? "medium";
  const { mutate: updateExecution } = useUpdateThread({
    threadId: thread.id,
    errorMessage: "Failed to save thread execution settings.",
  });
  const saveReasoning = useUpdateThread({
    threadId: thread.id,
    errorMessage: "Failed to save thread execution settings.",
    reasoning: true,
  });
  const isExecutionUpdatePending =
    useIsMutating({ mutationKey: ["thread-update", thread.id] }) > 0;
  const retryCloudStart = useRetryCloudStart(thread.id);
  const defaultExecutionOptionsQuery = useThreadDefaultExecutionOptions(
    thread.id,
    {
      enabled: !isCloud,
    },
  );
  const defaultExecutionOptions = isCloud && cloudState.data
    ? { providerId: thread.providerId, model: cloudState.data.model, reasoningLevel: cloudState.data.reasoning, permissionMode: "full" as const, serviceTier: cloudState.data.serviceTier }
    : defaultExecutionOptionsQuery.data;
  const verifiedDefaultExecutionOptions =
    !isCloud && defaultExecutionOptionsQuery.isPlaceholderData
      ? undefined
      : defaultExecutionOptions;
  const hasResolvedDefaultExecutionOptions =
    verifiedDefaultExecutionOptions !== undefined;
  const hasConcreteDefaultExecutionOptions =
    verifiedDefaultExecutionOptions !== undefined &&
    verifiedDefaultExecutionOptions !== null;
  const defaultExecutionOptionsState = resolveDefaultExecutionOptionsState({
    hasConcreteDefaultExecutionOptions,
    hasResolvedDefaultExecutionOptions,
    isError: defaultExecutionOptionsQuery.isError,
  });
  const isDefaultExecutionOptionsLoading =
    defaultExecutionOptionsState === "loading";
  const queuedMessagesQuery = useThreadQueuedMessages(thread.id, {
    enabled: true,
  });
  const queuedMessages = queuedMessagesQuery.data ?? EMPTY_QUEUED_MESSAGES;
  const queuedMessagesPending =
    queuedMessagesQuery.data === undefined && queuedMessageCount > 0;
  const queuedMessagesRef =
    useLatestRef<readonly ThreadQueuedMessage[]>(queuedMessages);
  const [bottomPluginFocusNonce, setBottomPluginFocusNonce] = useState(0);
  const [editFocusNonce, setEditFocusNonce] = useState(0);
  const [dismissedCloudStatus, setDismissedCloudStatus] = useState<string | null>(null);
  const focusBottomPluginComposer = useCallback(() => {
    setBottomPluginFocusNonce((nonce) => nonce + 1);
  }, []);
  const focusInlinePluginComposer = useCallback(() => {
    setEditFocusNonce((nonce) => nonce + 1);
  }, []);
  const sentMessageEditRef = useLatestRef(sentMessageEdit);
  const clearInlineAttachmentErrorRef = useRef<() => void>(() => {});
  const {
    inlineEditingQueuedMessage,
    inlineEditingQueuedMessageRef,
    commitInlineQueuedMessage,
    dismissInlineQueuedMessageEditor,
    beginEditQueuedMessage,
    queuedMessageDraftSession,
  } = useInlineQueuedMessageEditing({
    ownerThreadId: thread.id,
    queuedMessages,
    onBeginEdit: () => {
      clearInlineAttachmentErrorRef.current();
      setEditFocusNonce((nonce) => nonce + 1);
    },
  });
  const inlineDraftSession = queuedMessageDraftSession;
  const inlineDraftSessionRef = useLatestRef(inlineDraftSession);
  const promptHistoryEnabled = usePromptHistoryEnabled();
  const { data: promptHistoryEntries = [] } = useThreadPromptHistory(
    thread.id,
    {
      enabled: promptHistoryEnabled,
    },
  );
  const createQueuedMessage = useCreateThreadQueuedMessage();
  const stopThread = useStopThread();
  const cancelThreadPlan = useCancelThreadPlan();
  const clearThreadGoal = useClearThreadGoal();
  const setThreadGoalStatus = useSetThreadGoalStatus();
  const unarchiveThread = useUnarchiveThread();
  const projectName = useProjectDisplayName(
    thread.projectId === PERSONAL_PROJECT_ID ? undefined : thread.projectId,
  );
  const {
    promptDraft,
    currentPromptDraft,
    currentPromptDraftInput,
    activeComposerDraft,
    activeComposerDraftInput,
    setActiveComposerDraft,
    handleChangeMessage: handleComposerMessageChange,
    removeActiveComposerAttachment,
  } = useActiveComposerDraft({
    draftScope: {
      kind: "thread",
      projectId,
      threadId: thread.id,
    },
    inlineDraft: inlineEditingQueuedMessage?.draft ?? null,
    inlineSessionRef: inlineDraftSessionRef,
  });
  const subscribeInlineQueuedDraft = useComposerHostDraftNotifier(
    inlineEditingQueuedMessage?.draft ?? null,
  );
  const subscribeSentMessageEditDraft = useComposerHostDraftNotifier(
    sentMessageEdit?.draft ?? null,
  );
  const updateSentMessageEditDraft = sentMessageEdit?.updateDraft;
  const addSentMessageEditAttachment = useCallback(
    (attachment: PromptDraftAttachment) => {
      updateSentMessageEditDraft?.((current) =>
        current.attachments.some(
          (existing) => existing.path === attachment.path,
        )
          ? current
          : {
              ...current,
              attachments: [...current.attachments, attachment],
            },
      );
    },
    [updateSentMessageEditDraft],
  );
  const {
    bottomAttachmentError,
    setBottomAttachmentError,
    handleAttachBottomFiles,
    isAttachingBottomFiles,
    inlineAttachmentError,
    setInlineAttachmentError,
    handleAttachInlineFiles,
    isAttachingInlineFiles,
  } = useComposerAttachmentUploads({
    projectId,
    addDraftAttachment: promptDraft.addAttachment,
    inlineEditSessionId: inlineDraftSession?.editSessionId ?? null,
    inlineSessionRef: inlineDraftSessionRef,
  });
  const {
    attachmentError: sentMessageAttachmentError,
    handleAttachFiles: handleAttachSentMessageFiles,
    isAttachingFiles: isAttachingSentMessageFiles,
  } = useDraftAttachmentUploads({
    projectId,
    target: sentMessageEdit
      ? {
          key: sentMessageEdit.operationId,
          addAttachment: addSentMessageEditAttachment,
        }
      : null,
  });
  useLayoutEffect(() => {
    clearInlineAttachmentErrorRef.current = () =>
      setInlineAttachmentError(null);
  }, [setInlineAttachmentError]);
  const promptTextEffects = useComposerTextEffects(promptDraft.storageKey);
  const queuedComposerTextEffects = useComposerTextEffects(
    inlineEditingQueuedMessage
      ? `queued-message:${thread.id}:${inlineEditingQueuedMessage.queuedMessageId}:${inlineEditingQueuedMessage.editSessionId}`
      : null,
  );
  const sentMessageComposerTextEffects = useComposerTextEffects(
    sentMessageEdit
      ? `sent-message:${thread.id}:${sentMessageEdit.operationId}`
      : null,
  );
  const [expandedBannerSection, setExpandedBannerSection] =
    useState<ThreadPromptContextBannerExpandedSection | null>(null);
  const pullRequestSection =
    useMemo<ThreadPromptPullRequestSection | null>(() => {
      if (!pullRequest) {
        return null;
      }
      const actions =
        onPullRequestReady ||
        onPullRequestMerge ||
        onPullRequestDraft ||
        isEnvironmentActionPending
          ? {
              isPending: isEnvironmentActionPending,
              ...(onPullRequestReady
                ? { onMarkReady: onPullRequestReady }
                : {}),
              ...(onPullRequestMerge ? { onMerge: onPullRequestMerge } : {}),
              ...(onPullRequestDraft
                ? { onConvertToDraft: onPullRequestDraft }
                : {}),
              ...(onPullRequestMerge
                ? { selectedMergeMethod: pullRequestMergeMethod }
                : {}),
            }
          : undefined;
      return actions ? { pullRequest, actions } : { pullRequest };
    }, [
      isEnvironmentActionPending,
      onPullRequestDraft,
      onPullRequestMerge,
      onPullRequestReady,
      pullRequest,
      pullRequestMergeMethod,
    ]);
  const [isGoalExpanded, setIsGoalExpanded] = useState(false);
  const [isTodoExpanded, setIsTodoExpanded] = useState(false);
  const [isPromptModeExpanded, setIsPromptModeExpanded] = useState(false);
  const [expandedWorkflowIds, setExpandedWorkflowIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const toggleWorkflowExpanded = useCallback((workflowId: string) => {
    setExpandedWorkflowIds((current) => {
      const next = new Set(current);
      if (!next.delete(workflowId)) {
        next.add(workflowId);
      }
      return next;
    });
  }, []);
  const [isBackgroundCommandsExpanded, setIsBackgroundCommandsExpanded] =
    useState(false);
  const [isFollowUpShortcutSending, setIsFollowUpShortcutSending] =
    useState(false);
  const promptHistoryDrafts = useMemo(
    () => promptHistoryEntriesToDrafts(promptHistoryEntries),
    [promptHistoryEntries],
  );
  const {
    executionOptionsRouting,
    selectedProviderId,
    setProviderModelReasoning,
    providers,
    providerOptions,
    hasMultipleProviders,
    selectedProviderComposerActions,
    selectedModel,
    setSelectedModel,
    serviceTier,
    setServiceTier,
    reasoningLevel,
    permissionMode,
    setPermissionMode,
    activeModel,
    modelOptions,
    moreModelOptions,
    isLoadingModels,
    modelLoadFailed,
    modelLoadError,
    reasoningOptions,
    permissionModeOptions,
    supportsPermissionModeSelection,
    supportsServiceTier,
    serviceTierSupportByProvider,
    serviceTierFastLabel,
    executionInputSources,
  } = useThreadCreationOptions({
    enabled: thread.archivedAt === null,
    environmentId: thread.environmentId ?? undefined,
    environmentHostId,
    scope: "component-local",
    resetKey: thread.id,
    initialProviderId: thread.providerId,
    initialModel:
      modelFallback?.fallbackModel ?? defaultExecutionOptions?.model,
    initialServiceTier: defaultExecutionOptions?.serviceTier,
    initialReasoningLevel: defaultExecutionOptions?.reasoningLevel,
    initialPermissionMode: defaultExecutionOptions?.permissionMode,
    initialEnvironmentSelectionValue: thread.environmentId ?? undefined,
  });
  const cloudFollowUpReasoningOptions = useMemo(() => {
    // ACP harnesses keep their launch level, unless Cloud can switch it per turn (fx).
    const fixed = thread.providerId.startsWith("acp-") && !cloudHarness(cloudConnection.data, thread.providerId)?.prompt_reasoning;
    const levels = fixed ? [cloudReasoning] : cloudReasoningLevels(cloudConnection.data, thread.providerId, cloudState.data?.model);
    return [...new Set([cloudReasoning, ...levels])].flatMap((level) => {
      const parsed = reasoningLevelSchema.safeParse(level);
      return parsed.success ? [{ value: parsed.data, label: reasoningLevelLabel(parsed.data, undefined) }] : [];
    }).sort((a, b) => reasoningLevelSchema.options.indexOf(a.value) - reasoningLevelSchema.options.indexOf(b.value));
  }, [cloudConnection.data, cloudReasoning, cloudState.data?.model, thread.providerId]);
  const cloudFastSupported = isCloud && cloudServiceTierSupported(cloudConnection.data, thread.providerId);
  const cloudProviderOptions = useMemo(() => providerOptions.filter((option) => cloudCanRunHarness(option.value)), [providerOptions]);
  const cloudSteerSupported = isCloud && cloudFeatureSupported(cloudConnection.data, thread.providerId, "steer");
  const fallbackIdentity = modelFallback
    ? `${thread.id}:${modelFallback.sourceSeq}`
    : null;
  const [overriddenFallbackIdentity, setOverriddenFallbackIdentity] = useState<
    string | null
  >(null);
  const isFallbackModelActive =
    selectedProviderId === thread.providerId &&
    modelFallback !== null &&
    overriddenFallbackIdentity !== fallbackIdentity;
  const effectiveSelectedModel = isFallbackModelActive
    ? modelFallback.fallbackModel
    : (activeModel?.model ?? selectedModel);
  const followUpReasoningLevel = isCloud
    ? cloudReasoning
    : resolveModelReasoningLevel(
        activeModel,
        (saveReasoning.isPending
          ? saveReasoning.variables?.reasoningLevel
          : undefined) ??
          defaultExecutionOptions?.reasoningLevel ??
          reasoningLevel,
      );
  const handleReasoningChange = useCallback(
    (level: ReasoningLevel) => {
      if (isCloud) {
        setCloudReasoning.mutate(level);
        return;
      }
      saveReasoning.mutate({
        id: thread.id,
        reasoningLevel: level,
        ...(effectiveSelectedModel !== defaultExecutionOptions?.model
          ? { model: effectiveSelectedModel }
          : {}),
      });
    },
    [
      setCloudReasoning.mutate,
      saveReasoning.mutate,
      thread.id,
      isCloud,
      effectiveSelectedModel,
      defaultExecutionOptions?.model,
    ],
  );
  const handleModelChange = useCallback(
    (model: string) => {
      if (fallbackIdentity !== null) {
        setOverriddenFallbackIdentity(fallbackIdentity);
      }
      setSelectedModel(model);
    },
    [fallbackIdentity, setSelectedModel],
  );
  const queryClient = useQueryClient();
  // Another harness, or any model change in Cloud, switches this thread in place (ADR 0211).
  const handleSelectModel = useCallback(
    (selection: { providerId: string; model: string } & Partial<ModelReasoningPickerSelection>) => {
      if (selection.providerId === thread.providerId) {
        if (!isCloud) {
          handleModelChange(selection.model);
          return;
        }
        if (selection.model === cloudState.data?.model) return;
      }
      const next = { ...selection, reasoningLevel: selection.reasoningLevel ?? followUpReasoningLevel };
      updateExecution(
        { id: thread.id, ...next },
        {
          onSuccess: () => {
            if (fallbackIdentity !== null) setOverriddenFallbackIdentity(fallbackIdentity);
            setProviderModelReasoning(next);
            void queryClient.invalidateQueries({ queryKey: ["cloudroom-thread", thread.id] });
          },
        },
      );
    },
    [cloudState.data?.model, fallbackIdentity, followUpReasoningLevel, handleModelChange, isCloud, queryClient, setProviderModelReasoning, thread.id, thread.providerId, updateExecution],
  );
  const { typeaheadConfig, promptActions } = useComposerTypeahead({
    projectId: thread.projectId,
    mentionsProjectId: projectId,
    providerId: selectedProviderId,
    commandScope: "thread",
    environmentId: thread.environmentId,
    currentThreadId: thread.id,
    selectedProviderComposerActions,
    resolveMentionLink,
  });
  const {
    typeaheadConfig: inlineTypeaheadConfig,
    promptActions: inlinePromptActions,
  } = useComposerTypeahead({
    projectId: thread.projectId,
    mentionsProjectId: projectId,
    providerId: thread.providerId,
    environmentId: thread.environmentId,
    currentThreadId: thread.id,
    selectedProviderComposerActions: providers.find(
      (provider) => provider.id === thread.providerId,
    )?.composerActions,
    resolveMentionLink,
  });
  const runtimeDisplayStatus = thread.runtime.displayStatus;
  const shouldSteerWhenReady =
    runtimeDisplayStatus === "provisioning" ||
    runtimeDisplayStatus === "starting";
  const isStopRequested =
    thread.status === "stopping" ||
    (stopThread.isPending && stopThread.variables === thread.id);
  const activePendingInteraction =
    getLatestPendingInteraction(pendingInteractions);
  const hasPendingInteraction = activePendingInteraction !== null;
  const shouldHideComposer =
    environmentGoneStatus !== null || thread.archivedAt !== null;
  const {
    processingQueuedMessage: displayedProcessingQueuedMessage,
    queuedMessageActionPending,
    isUpdateQueuedMessagePending,
    sendQueuedMessageById,
    handleSaveInlineQueuedMessage,
    handleDeleteQueuedMessage,
    handleReorderQueuedMessage,
  } = useQueuedMessageActions({
    threadId: thread.id,
    queuedMessages,
    sendProcessingPersistence: "until-left-queue",
    onSendSuccess: () => setInlineAttachmentError(null),
    onSaveSuccess: () => setInlineAttachmentError(null),
    inlineEditingQueuedMessage,
    dismissInlineQueuedMessageEditor,
    activeComposerDraftInput,
  });
  const isQueueMutationPending =
    createQueuedMessage.isPending ||
    queuedMessageActionPending ||
    isFollowUpShortcutSending;
  const isFollowUpSubmitting =
    isExecutionUpdatePending ||
    sendMessage.isPending ||
    createQueuedMessage.isPending ||
    isFollowUpShortcutSending;
  const handleStopThread = useCallback(() => {
    stopThread.mutate(thread.id);
  }, [stopThread, thread.id]);
  const handleCancelPlan = useCallback(() => {
    cancelThreadPlan.mutate(thread.id);
  }, [cancelThreadPlan, thread.id]);
  const handleClearGoal = useCallback(() => {
    clearThreadGoal.mutate(thread.id);
  }, [clearThreadGoal, thread.id]);
  const handleSetGoalStatus = useCallback(
    (status: "active" | "paused") => {
      setThreadGoalStatus.mutate({ threadId: thread.id, status });
    },
    [setThreadGoalStatus, thread.id],
  );
  const submitMode = useMemo<FollowUpSubmitMode>(() => {
    return buildFollowUpSubmitMode({
      hasPendingInteraction,
      isDefaultExecutionOptionsLoading,
      isPendingInteractionsInitialLoading: pendingInteractionsInitialLoading,
      isStopRequested,
      onStop: handleStopThread,
      runtimeDisplayStatus,
    });
  }, [
    handleStopThread,
    hasPendingInteraction,
    isDefaultExecutionOptionsLoading,
    pendingInteractionsInitialLoading,
    isStopRequested,
    runtimeDisplayStatus,
  ]);
  const promptPlaceholder = getFollowUpPromptPlaceholder(
    isStopRequested ? "stopping" : runtimeDisplayStatus,
  );
  const compactPromptPlaceholder = getCompactFollowUpPromptPlaceholder(
    isStopRequested ? "stopping" : runtimeDisplayStatus,
  );
  const promptPlaceholderHint = getFollowUpPromptPlaceholderHint(
    isStopRequested ? "stopping" : runtimeDisplayStatus,
  );
  const submitProgrammaticallyRef = useRef<
    (
      options: ExperimentalComposerSubmitOptions,
      pluginSubmission: SendMessageRequest["pluginSubmission"],
    ) => Promise<void>
  >(async () => {});
  const submitProgrammaticallyThroughRef = useCallback(
    (
      options: ExperimentalComposerSubmitOptions,
      pluginSubmission: SendMessageRequest["pluginSubmission"],
    ) => submitProgrammaticallyRef.current(options, pluginSubmission),
    [],
  );
  const normalPluginComposerHost = useMemo<PluginComposerHost>(
    () => ({
      scope: { kind: "thread", threadId: thread.id },
      textEffectKey: promptDraft.storageKey,
      getCurrent: promptDraft.getCurrent,
      subscribeDraft: promptDraft.subscribe,
      setDraft: promptDraft.setDraft,
      focus: focusBottomPluginComposer,
      submit: submitProgrammaticallyThroughRef,
    }),
    [
      focusBottomPluginComposer,
      promptDraft.getCurrent,
      promptDraft.setDraft,
      promptDraft.storageKey,
      promptDraft.subscribe,
      submitProgrammaticallyThroughRef,
      thread.id,
    ],
  );
  const hasPromptDraftInput = currentPromptDraftInput.length > 0;
  const canSubmitModifierShortcut = canSubmitFollowUpShortcut({
    hasPromptDraftInput,
    isFollowUpSubmitting,
    isQueueMutationPending,
    queuedMessageCount: queuedMessages.length,
    runtimeDisplayStatus,
    submitModeKind: submitMode.kind,
  });
  const followUpExecutionSelection = useMemo<FollowUpExecutionSelection>(() => {
    if (!hasConcreteDefaultExecutionOptions) {
      return null;
    }
    return {
      model: effectiveSelectedModel,
      supportsServiceTier,
      serviceTier,
      reasoningLevel: followUpReasoningLevel,
      permissionMode,
      executionInputSources,
    };
  }, [
    effectiveSelectedModel,
    executionInputSources,
    hasConcreteDefaultExecutionOptions,
    permissionMode,
    followUpReasoningLevel,
    serviceTier,
    supportsServiceTier,
  ]);

  const sendCloudDraft = useCallback(async (steer: boolean) => {
    const submittedDraft = currentPromptDraft;
    const submittedInput = currentPromptDraftInput;
    if (!cloudState.data || submittedInput.length === 0 || movingToLocal) return;
    const request = {
      id: thread.id,
      input: submittedInput,
      model: cloudState.data.model,
      reasoningLevel: cloudReasoning,
      permissionMode: "full" as const,
      serviceTier: cloudFastSupported && serviceTier ? serviceTier : "default" as const,
      mode: steer && thread.status === "active" ? "steer-if-active" as const : "queue-if-active" as const,
    };
    promptDraft.clearIfCurrentMatches(submittedDraft);
    try {
      await sendMessage.mutateAsync({ ...request, requestId: await cloudroomRequestId(thread.id, request) });
      clearCloudroomRequestId(thread.id);
    } catch (error) {
      promptDraft.restoreIfEmpty(submittedDraft);
      showMutationErrorToast({ error, fallbackMessage: "Cloud message was not confirmed", lifecycleOperation: "send_message" });
    }
  }, [cloudFastSupported, cloudReasoning, cloudState.data, currentPromptDraft, currentPromptDraftInput, movingToLocal, promptDraft, sendMessage, serviceTier, thread.id, thread.status]);

  const handleSend = useCallback(async () => {
    if (isExecutionUpdatePending) return;
    const submittedDraft = currentPromptDraft;
    const submittedInput = currentPromptDraftInput;
    if (isCloud) {
      await sendCloudDraft(false);
      return;
    }
    const isQueuingMessage = shouldQueueFollowUpMessage(runtimeDisplayStatus);
    if (
      submittedInput.length === 0 ||
      (!isQueuingMessage && isDefaultExecutionOptionsLoading)
    ) {
      return;
    }

    promptDraft.clearIfCurrentMatches(submittedDraft);
    setBottomAttachmentError(null);

    try {
      if (isQueuingMessage) {
        const request = buildCreateQueuedFollowUpRequest({
          threadId: thread.id,
          input: submittedInput,
          execution: followUpExecutionSelection,
        });
        if (request) {
          await createQueuedMessage.mutateAsync(request);
        }
      } else {
        const request = buildAutoFollowUpRequest({
          threadId: thread.id,
          input: submittedInput,
          execution: followUpExecutionSelection,
        });
        if (request) {
          await sendMessage.mutateAsync(request);
        }
      }
    } catch (nextError) {
      promptDraft.restoreIfEmpty(submittedDraft);
      showMutationErrorToast({
        error: nextError,
        fallbackMessage: isQueuingMessage
          ? "Failed to queue message"
          : "Failed to send message",
        lifecycleOperation: isQueuingMessage ? "queue_message" : "send_message",
      });
    }
  }, [
    isExecutionUpdatePending,
    isCloud,
    sendCloudDraft,
    createQueuedMessage,
    currentPromptDraft,
    currentPromptDraftInput,
    followUpExecutionSelection,
    isDefaultExecutionOptionsLoading,
    promptDraft,
    sendMessage,
    setBottomAttachmentError,
    thread.id,
    runtimeDisplayStatus,
  ]);
  const handleHardQueue = useCallback(async () => {
    if (isExecutionUpdatePending) return;
    const submittedDraft = currentPromptDraft;
    const request = buildCreateQueuedFollowUpRequest({
      threadId: thread.id,
      input: currentPromptDraftInput,
      execution: followUpExecutionSelection,
    });
    if (!request) return;
    promptDraft.clearIfCurrentMatches(submittedDraft);
    setBottomAttachmentError(null);
    try {
      await createQueuedMessage.mutateAsync({ ...request, hardQueue: true });
    } catch (nextError) {
      promptDraft.restoreIfEmpty(submittedDraft);
      showMutationErrorToast({
        error: nextError,
        fallbackMessage: "Failed to queue message",
        lifecycleOperation: "queue_message",
      });
    }
  }, [
    createQueuedMessage,
    currentPromptDraft,
    currentPromptDraftInput,
    followUpExecutionSelection,
    isExecutionUpdatePending,
    promptDraft,
    setBottomAttachmentError,
    thread.id,
  ]);
  const submitProgrammatically = useCallback(
    async (
      submitOptions: ExperimentalComposerSubmitOptions,
      pluginSubmission: SendMessageRequest["pluginSubmission"],
    ) => {
      if (movingToLocal) {
        throw new Error("Wait for Teleport to Local to finish.");
      }
      if (isDefaultExecutionOptionsLoading || isExecutionUpdatePending) {
        throw new Error(
          "This thread's execution settings are still loading or saving.",
        );
      }
      const submittedDraft = promptDraft.getCurrent();
      const request = buildAutoFollowUpRequest({
        threadId: thread.id,
        input: promptDraftToInput(submittedDraft),
        execution: followUpExecutionSelection,
      });
      if (request === null) {
        throw new Error("Type a message before submitting it.");
      }
      const clearedSubmittedDraft =
        promptDraft.clearIfCurrentMatches(submittedDraft);
      setBottomAttachmentError(null);
      try {
        await sendMessage.mutateAsync({
          ...request,
          ...(submitOptions.sendAt === undefined
            ? {}
            : { sendAt: submitOptions.sendAt }),
          ...(pluginSubmission === undefined ? {} : { pluginSubmission }),
        });
      } catch (scheduleError) {
        if (clearedSubmittedDraft) {
          promptDraft.restoreIfEmpty(submittedDraft);
        }
        throw new Error(
          getMutationErrorMessage({
            error: scheduleError,
            fallbackMessage: "Failed to submit message",
            lifecycleOperation: "send_message",
          }),
        );
      }
    },
    [
      followUpExecutionSelection,
      isDefaultExecutionOptionsLoading,
      isExecutionUpdatePending,
      movingToLocal,
      promptDraft,
      sendMessage,
      setBottomAttachmentError,
      thread.id,
    ],
  );
  useEffect(() => {
    submitProgrammaticallyRef.current = submitProgrammatically;
  }, [submitProgrammatically]);

  const handleModifierSubmit = useCallback(async () => {
    if (!canSubmitModifierShortcut) {
      return;
    }
    if (isCloud && currentPromptDraftInput.length > 0) {
      await runWhileFollowUpShortcutSending(setIsFollowUpShortcutSending, () => sendCloudDraft(true));
      return;
    }

    const submittedDraft = currentPromptDraft;
    const submittedInput = currentPromptDraftInput;
    const shortcutRequest = buildFollowUpShortcutRequest({
      execution: followUpExecutionSelection,
      input: submittedInput,
      queuedMessages: queuedMessagesRef.current,
      threadId: thread.id,
    });
    if (!shortcutRequest) {
      return;
    }

    if (shortcutRequest.kind === "draft") {
      promptDraft.clearIfCurrentMatches(submittedDraft);
      setBottomAttachmentError(null);
      await runWhileFollowUpShortcutSending(
        setIsFollowUpShortcutSending,
        async () => {
          try {
            await sendMessage.mutateAsync(shortcutRequest.request);
          } catch (nextError) {
            promptDraft.restoreIfEmpty(submittedDraft);
            showMutationErrorToast({
              error: nextError,
              fallbackMessage: "Failed to send message",
              lifecycleOperation: "send_message",
            });
          }
        },
      );
      return;
    }

    const queuedMessageId = shortcutRequest.request.queuedMessageId;
    if (queuedMessagesRef.current[0]?.id !== queuedMessageId) {
      return;
    }

    await runWhileFollowUpShortcutSending(
      setIsFollowUpShortcutSending,
      async () => {
        await sendQueuedMessageById({
          guard: "current-head",
          messageId: queuedMessageId,
          mode: shortcutRequest.request.mode,
        });
      },
    );
  }, [
    canSubmitModifierShortcut,
    currentPromptDraft,
    currentPromptDraftInput,
    followUpExecutionSelection,
    isCloud,
    promptDraft,
    queuedMessagesRef,
    sendCloudDraft,
    sendMessage,
    sendQueuedMessageById,
    setBottomAttachmentError,
    thread.id,
  ]);

  const handleSendQueuedMessage = useCallback(
    (messageId: string) => {
      void sendQueuedMessageById({
        guard: "exists",
        messageId,
        mode: shouldSteerWhenReady ? "steer" : "auto",
      });
    },
    [sendQueuedMessageById, shouldSteerWhenReady],
  );

  const bottomFocusEndKey = `${composerFocusRequestNonce}:${bottomPluginFocusNonce}`;

  const handleToggleBannerSection = useCallback(
    (section: ThreadPromptContextBannerExpandedSection | null) => {
      setExpandedBannerSection((previous) =>
        previous === section ? null : section,
      );
    },
    [],
  );
  const isUnarchiveCurrentThreadPending =
    unarchiveThread.isPending && unarchiveThread.variables?.id === thread.id;
  const handleUnarchiveCurrentThread = useCallback(() => {
    unarchiveThread.mutate({ id: thread.id });
  }, [thread.id, unarchiveThread]);
  const bottomAttachmentsConfig = useMemo(
    () => ({
      items: currentPromptDraft.attachments,
      projectId,
      isAttaching: isAttachingBottomFiles,
      error: bottomAttachmentError,
      onAttachFiles: handleAttachBottomFiles,
      onRemove: promptDraft.removeAttachment,
    }),
    [
      bottomAttachmentError,
      currentPromptDraft.attachments,
      handleAttachBottomFiles,
      isAttachingBottomFiles,
      projectId,
      promptDraft.removeAttachment,
    ],
  );
  const runCopyCommand = useCopyCommand(
    thread.id,
    promptDraft.clearIfCurrentMatches,
  );
  const runTeleportCommand = useCallback(
    (draft: PromptDraftState): boolean => {
      const start = canTeleportLocal ? startTeleportLocal : canTeleport ? startTeleport : null;
      if (!start || draft.text.trim() !== "/teleport" || draft.attachments.length > 0) return false;
      promptDraft.clearIfCurrentMatches(draft);
      start();
      return true;
    },
    [canTeleport, canTeleportLocal, promptDraft.clearIfCurrentMatches, startTeleport, startTeleportLocal],
  );
  const handleBottomComposerSubmit = useCallback(() => {
    if (runCopyCommand(currentPromptDraft) || runTeleportCommand(currentPromptDraft)) return;
    void handleSend();
  }, [currentPromptDraft, handleSend, runCopyCommand, runTeleportCommand]);
  const handleBottomComposerModifierSubmit = useCallback(() => {
    if (runCopyCommand(currentPromptDraft) || runTeleportCommand(currentPromptDraft)) return;
    void handleModifierSubmit();
  }, [currentPromptDraft, handleModifierSubmit, runCopyCommand, runTeleportCommand]);
  const handleBottomComposerHardQueueSubmit = useCallback(() => {
    if (runCopyCommand(currentPromptDraft) || runTeleportCommand(currentPromptDraft)) return;
    void handleHardQueue();
  }, [currentPromptDraft, handleHardQueue, runCopyCommand, runTeleportCommand]);
  const handleInlineComposerSubmit = useCallback(() => {
    void handleSaveInlineQueuedMessage();
  }, [handleSaveInlineQueuedMessage]);
  const wakeCloudThread = useCloudThreadWake(thread.id, isCloud);
  const setBottomComposerText = promptDraft.setTextAndMentions;
  const handleBottomComposerMessageChange = useCallback<FollowUpComposerProps["onChangeMessage"]>(
    (text, mentions) => {
      setBottomComposerText(text, mentions);
      if (text.trim()) wakeCloudThread("typing");
    },
    [setBottomComposerText, wakeCloudThread],
  );

  const bottomComposerConfig = useMemo<FollowUpComposerProps>(
    () => ({
      history: {
        currentDraft: currentPromptDraft,
        entries: promptHistoryDrafts,
        onSelectEntry: promptDraft.setDraft,
        resetKey: thread.id,
      },
      isFollowUpSubmitting: isFollowUpSubmitting || movingToLocal,
      message: currentPromptDraft.text,
      mentionRanges: currentPromptDraft.mentions,
      onChangeMessage: handleBottomComposerMessageChange,
      onModifierSubmit: handleBottomComposerModifierSubmit,
      ...(isCloud
        ? {}
        : { onHardQueueSubmit: handleBottomComposerHardQueueSubmit }),
      onSubmit: handleBottomComposerSubmit,
      compactPromptPlaceholder,
      promptPlaceholder,
      promptPlaceholderHint,
      canModifierSubmit: (!isCloud || cloudSteerSupported) && canSubmitModifierShortcut,
      steerActiveThreadOnEnter: isCloud ? cloudSteerSupported && steerActiveThreadOnEnter : steerActiveThreadOnEnter,
      submitMode: movingToLocal ? { kind: "ready" } : submitMode,
      threadRuntimeDisplayStatus: runtimeDisplayStatus,
    }),
    [
      isCloud,
      canSubmitModifierShortcut,
      compactPromptPlaceholder,
      currentPromptDraft,
      handleBottomComposerHardQueueSubmit,
      handleBottomComposerMessageChange,
      handleBottomComposerModifierSubmit,
      handleBottomComposerSubmit,
      isFollowUpSubmitting,
      movingToLocal,
      promptHistoryDrafts,
      promptPlaceholder,
      promptPlaceholderHint,
      promptDraft.setDraft,
      runtimeDisplayStatus,
      steerActiveThreadOnEnter,
      cloudSteerSupported,
      submitMode,
      thread.id,
    ],
  );
  const sentMessageEditInput = useMemo(
    () => (sentMessageEdit ? promptDraftToInput(sentMessageEdit.draft) : []),
    [sentMessageEdit],
  );
  const [sentMessageReasoningChoice, setSentMessageReasoningChoice] = useState<{
    operationId: string;
    level: ReasoningLevel;
  } | null>(null);
  const chooseSentMessageReasoning = useCallback(
    (level: ReasoningLevel) => {
      if (sentMessageEdit) {
        setSentMessageReasoningChoice({
          operationId: sentMessageEdit.operationId,
          level,
        });
      }
    },
    [sentMessageEdit],
  );
  const sentMessageExecutionSelection = useMemo<FollowUpExecutionSelection>(() => {
    const selection = isCloud
      ? cloudState.data && {
          model: cloudState.data.model,
          reasoningLevel: cloudReasoning,
          permissionMode: "full" as const,
          serviceTier: cloudFastSupported ? serviceTier : ("default" as const),
          supportsServiceTier: cloudFastSupported,
          executionInputSources: {},
        }
      : followUpExecutionSelection;
    if (!selection) return null;
    if (
      !sentMessageReasoningChoice ||
      sentMessageReasoningChoice.operationId !== sentMessageEdit?.operationId
    ) return selection;
    return {
      ...selection,
      reasoningLevel: sentMessageReasoningChoice.level,
      executionInputSources: {
        ...selection.executionInputSources,
        reasoningLevel: "explicit",
      },
    };
  }, [
    isCloud,
    cloudState.data,
    cloudReasoning,
    cloudFastSupported,
    serviceTier,
    followUpExecutionSelection,
    sentMessageReasoningChoice,
    sentMessageEdit?.operationId,
  ]);
  const canSubmitSentMessageEdit =
    sentMessageEdit !== undefined &&
    sentMessageExecutionSelection !== null &&
    sentMessageEditInput.length > 0 &&
    submitMode.kind === "ready" &&
    !shouldHideComposer &&
    !isDefaultExecutionOptionsLoading &&
    !isAttachingSentMessageFiles &&
    !isFollowUpSubmitting &&
    !isQueueMutationPending &&
    !sentMessageEdit.isSubmitting &&
    queuedMessages.length === 0 &&
    activeBackgroundAgentCount === 0 &&
    activeWorkflows.length === 0 &&
    activeBackgroundCommands.length === 0;
  const sentMessageEditSubmitMode = useMemo<FollowUpSubmitMode>(
    () =>
      canSubmitSentMessageEdit || sentMessageEditInput.length === 0
        ? { kind: "ready" }
        : submitMode.kind === "blocked"
          ? submitMode
          : { kind: "blocked", reason: "unavailable" },
    [canSubmitSentMessageEdit, sentMessageEditInput.length, submitMode],
  );
  const handleSentMessageEditSubmit = useCallback(() => {
    if (!sentMessageEdit || !canSubmitSentMessageEdit) {
      return;
    }
    sentMessageEdit.onSubmit({
      execution: sentMessageExecutionSelection,
      input: sentMessageEditInput,
    });
  }, [
    canSubmitSentMessageEdit,
    sentMessageExecutionSelection,
    sentMessageEdit,
    sentMessageEditInput,
  ]);
  const bottomExecutionConfig = useMemo(
    () => ({
      disabled: isExecutionUpdatePending,
      providerRouting:
        thread.environmentId === null
          ? executionOptionsRouting
          : { environmentId: thread.environmentId },
      provider: {
        options: providerOptions,
        selectedId: selectedProviderId,
        hasMultiple: hasMultipleProviders,
      },
      model: {
        active: effectiveSelectedModel
          ? { model: effectiveSelectedModel }
          : null,
        selected: selectedModel,
        options: modelOptions,
        moreOptions: moreModelOptions,
        isLoading: isLoadingModels,
        loadFailed: modelLoadFailed,
        loadError: modelLoadError,
        onChange: handleModelChange,
      },
      serviceTier: {
        value: serviceTier,
        onChange: setServiceTier,
        supported: supportsServiceTier,
        supportByProvider: serviceTierSupportByProvider,
        fastLabel: serviceTierFastLabel,
      },
      reasoning: {
        value: followUpReasoningLevel,
        options: reasoningOptions,
        onChange: handleReasoningChange,
      },
      onSelectModel: handleSelectModel,
      selectModel: handleSelectModel,
    }),
    [
      effectiveSelectedModel,
      executionOptionsRouting,
      hasMultipleProviders,
      handleSelectModel,
      handleModelChange,
      isLoadingModels,
      modelLoadFailed,
      modelLoadError,
      modelOptions,
      moreModelOptions,
      providerOptions,
      followUpReasoningLevel,
      reasoningOptions,
      isExecutionUpdatePending,
      handleReasoningChange,
      selectedModel,
      selectedProviderId,
      serviceTier,
      serviceTierSupportByProvider,
      setServiceTier,
      supportsServiceTier,
      serviceTierFastLabel,
      thread.environmentId,
    ],
  );
  const compactExecutionConfig = useMemo(() => {
    const {
      onSelectModel: _onSelectModel,
      selectModel: _selectModel,
      provider: lockedProvider,
      ...lockedExecution
    } = bottomExecutionConfig;
    return {
      ...lockedExecution,
      provider: { ...lockedProvider, selectedId: thread.providerId },
    };
  }, [bottomExecutionConfig, thread.providerId]);
  const sentMessageExecutionConfig = useMemo(
    () => ({
      ...compactExecutionConfig,
      lockModelSelection: true,
      disabled: sentMessageEdit?.isSubmitting ?? false,
      provider: { ...compactExecutionConfig.provider, hasMultiple: false },
      model: {
        ...compactExecutionConfig.model,
        active: sentMessageExecutionSelection
          ? { model: sentMessageExecutionSelection.model }
          : null,
        selected: sentMessageExecutionSelection?.model ?? compactExecutionConfig.model.selected,
        isLoading: isCloud ? !cloudState.data : compactExecutionConfig.model.isLoading,
        loadFailed: isCloud ? false : compactExecutionConfig.model.loadFailed,
        loadError: isCloud ? null : compactExecutionConfig.model.loadError,
      },
      reasoning: {
        value: sentMessageExecutionSelection?.reasoningLevel ?? reasoningLevel,
        options: isCloud ? cloudFollowUpReasoningOptions : reasoningOptions,
        onChange: chooseSentMessageReasoning,
      },
      serviceTier: { ...compactExecutionConfig.serviceTier, supported: false },
    }),
    [
      compactExecutionConfig,
      sentMessageEdit?.isSubmitting,
      sentMessageExecutionSelection,
      isCloud,
      cloudState.data,
      reasoningLevel,
      cloudFollowUpReasoningOptions,
      reasoningOptions,
      chooseSentMessageReasoning,
    ],
  );
  const inlineExecutionConfig = useMemo(() => {
    if (!inlineEditingQueuedMessage) return null;
    return {
      ...compactExecutionConfig,
      model: {
        ...compactExecutionConfig.model,
        active: { model: inlineEditingQueuedMessage.model },
        selected: inlineEditingQueuedMessage.model,
      },
      serviceTier: {
        ...compactExecutionConfig.serviceTier,
        value: inlineEditingQueuedMessage.serviceTier,
      },
      reasoning: {
        ...compactExecutionConfig.reasoning,
        value: inlineEditingQueuedMessage.reasoningLevel,
      },
    };
  }, [compactExecutionConfig, inlineEditingQueuedMessage]);

  const bottomPermissionConfig = useMemo(
    () => ({
      value: hasConcreteDefaultExecutionOptions ? permissionMode : undefined,
      options: hasConcreteDefaultExecutionOptions ? permissionModeOptions : [],
      onChange: setPermissionMode,
      supported:
        hasConcreteDefaultExecutionOptions && supportsPermissionModeSelection,
    }),
    [
      hasConcreteDefaultExecutionOptions,
      permissionMode,
      permissionModeOptions,
      setPermissionMode,
      supportsPermissionModeSelection,
    ],
  );
  const inlinePermissionConfig = useMemo(
    () =>
      inlineEditingQueuedMessage
        ? {
            ...bottomPermissionConfig,
            value: inlineEditingQueuedMessage.permissionMode,
          }
        : null,
    [bottomPermissionConfig, inlineEditingQueuedMessage],
  );

  const environmentSummary = useMemo(
    () =>
      isCloud || thread.environmentId !== null ? (
        <ThreadEnvironmentSummary
          projectName={projectName}
          environmentLabel={
            teleporting || movingToLocal ? "Teleporting" : isCloud ? CLOUDROOM_CLOUD_PRIMARY : environmentLabel
          }
          environmentCompactLabel={
            teleporting || movingToLocal ? "Teleporting" : isCloud ? CLOUDROOM_CLOUD_PRIMARY : environmentCompactLabel
          }
          environmentHost={isCloud ? undefined : environmentHost}
          environmentIcon={movingToLocal ? "Loading" : teleporting ? "Laptop" : isCloud ? "Cloud" : environmentIcon}
          environmentProviderName={isCloud ? "Cloud" : environmentProviderName}
          environmentMachineProvider={isCloud ? undefined : environmentMachineProvider}
          environmentCheckout={isCloud ? cloudCheckout : environmentCheckout}
          onCreateNewThreadInEnvironment={
            isCloud ? undefined : onCreateNewThreadInEnvironment
          }
          onTeleportToCloud={canTeleport ? startTeleport : undefined}
          onTeleportToLocal={canTeleportLocal ? startTeleportLocal : undefined}
        />
      ) : null,
    [
      isCloud,
      teleporting,
      canTeleport,
      startTeleport,
      movingToLocal,
      canTeleportLocal,
      startTeleportLocal,
      cloudCheckout,
      environmentCheckout,
      environmentCompactLabel,
      environmentHost,
      environmentIcon,
      environmentLabel,
      environmentMachineProvider,
      environmentProviderName,
      onCreateNewThreadInEnvironment,
      projectName,
      thread.environmentId,
    ],
  );
  const activePromptModeCard = useMemo(
    () => (
      <ThreadPromptModeCard
        activePromptMode={activePromptMode}
        isExitPending={cancelThreadPlan.isPending}
        isExpanded={isPromptModeExpanded}
        onExitPlanMode={handleCancelPlan}
        onToggle={() => setIsPromptModeExpanded((value) => !value)}
      />
    ),
    [
      activePromptMode,
      cancelThreadPlan.isPending,
      handleCancelPlan,
      isPromptModeExpanded,
    ],
  );
  const activeGoalCard = useMemo(
    () => (
      <ThreadGoalCard
        goal={goal}
        isClearPending={clearThreadGoal.isPending}
        isStatusPending={setThreadGoalStatus.isPending}
        isExpanded={isGoalExpanded}
        onClearGoal={handleClearGoal}
        onSetGoalStatus={handleSetGoalStatus}
        onToggle={() => setIsGoalExpanded((value) => !value)}
      />
    ),
    [
      clearThreadGoal.isPending,
      goal,
      handleClearGoal,
      handleSetGoalStatus,
      isGoalExpanded,
      setThreadGoalStatus.isPending,
    ],
  );
  const inlineEditSessionId = inlineEditingQueuedMessage?.editSessionId ?? null;
  const inlineEditQueuedMessageId =
    inlineEditingQueuedMessage?.queuedMessageId ?? null;
  const queuedMessagePluginComposerHost =
    useMemo<PluginComposerHost | null>(() => {
      if (inlineEditSessionId === null || inlineEditQueuedMessageId === null) {
        return null;
      }
      const session = {
        editSessionId: inlineEditSessionId,
        queuedMessageId: inlineEditQueuedMessageId,
      };
      return {
        scope: {
          kind: "queued-message",
          threadId: thread.id,
          queuedMessageId: inlineEditQueuedMessageId,
        },
        textEffectKey: `queued-message:${thread.id}:${inlineEditQueuedMessageId}:${inlineEditSessionId}`,
        getCurrent: () =>
          readInlineQueuedMessageDraft(
            inlineEditingQueuedMessageRef,
            session,
            ENDED_EDIT_SESSION_DRAFT,
          ),
        subscribeDraft: subscribeInlineQueuedDraft,
        setDraft: (draft) =>
          writeInlineQueuedMessageDraft(
            inlineEditingQueuedMessageRef,
            session,
            draft,
            commitInlineQueuedMessage,
          ),
        focus: focusInlinePluginComposer,
      };
    }, [
      commitInlineQueuedMessage,
      focusInlinePluginComposer,
      inlineEditQueuedMessageId,
      inlineEditSessionId,
      inlineEditingQueuedMessageRef,
      subscribeInlineQueuedDraft,
      thread.id,
    ]);
  const queuedMessageEditor = useMemo(() => {
    if (
      !inlineEditingQueuedMessage ||
      !inlineExecutionConfig ||
      !inlinePermissionConfig ||
      !queuedMessagePluginComposerHost
    ) {
      return null;
    }
    const { editSessionId, queuedMessageId } = inlineEditingQueuedMessage;
    const inlineEditor: QueuedMessageInlineEditor = {
      queuedMessageId,
      queuedMessageIndex: inlineEditingQueuedMessage.queuedMessageIndex,
      onDismiss: dismissInlineQueuedMessageEditor,
      content: buildInlineDraftComposer({
        attachments: {
          items: activeComposerDraft.attachments,
          projectId,
          isAttaching: isAttachingInlineFiles,
          error: inlineAttachmentError,
          onAttachFiles: handleAttachInlineFiles,
          onRemove: removeActiveComposerAttachment,
        },
        canModifierSubmit:
          activeComposerDraftInput.length > 0 && !isUpdateQueuedMessagePending,
        compactPromptPlaceholder,
        composerId: `${THREAD_DETAIL_COMPOSER_TEXTAREA_ID}-queued-${queuedMessageId}`,
        draft: activeComposerDraft,
        editFocusNonce,
        execution: inlineExecutionConfig,
        focusSessionKey: editSessionId,
        historyResetKey: `${thread.id}:${editSessionId}`,
        isSubmitting: isUpdateQueuedMessagePending,
        onChangeMessage: handleComposerMessageChange,
        onSelectHistoryEntry: setActiveComposerDraft,
        permission: inlinePermissionConfig,
        pluginComposerHost: queuedMessagePluginComposerHost,
        promptActions: inlinePromptActions,
        promptPlaceholder,
        submit: handleInlineComposerSubmit,
        submitMode: { kind: "ready" },
        textEffects: queuedComposerTextEffects,
        threadRuntimeDisplayStatus: runtimeDisplayStatus,
        typeahead: inlineTypeaheadConfig,
        collapseResetKey: `queued-message:${queuedMessageId}`,
      }),
    };
    return inlineEditor;
  }, [
    activeComposerDraft,
    activeComposerDraftInput.length,
    compactPromptPlaceholder,
    dismissInlineQueuedMessageEditor,
    editFocusNonce,
    handleAttachInlineFiles,
    handleComposerMessageChange,
    handleInlineComposerSubmit,
    inlineAttachmentError,
    inlineEditingQueuedMessage,
    inlineExecutionConfig,
    inlinePermissionConfig,
    isAttachingInlineFiles,
    isUpdateQueuedMessagePending,
    projectId,
    inlinePromptActions,
    promptPlaceholder,
    queuedComposerTextEffects,
    queuedMessagePluginComposerHost,
    removeActiveComposerAttachment,
    runtimeDisplayStatus,
    setActiveComposerDraft,
    thread.id,
    inlineTypeaheadConfig,
  ]);
  usePublishPluginComposerHost(
    queuedMessageEditor
      ? queuedMessagePluginComposerHost
      : normalPluginComposerHost,
  );
  const sentMessageEditOperationId = sentMessageEdit?.operationId ?? null;
  const sentMessagePluginComposerHost =
    useMemo<PluginComposerHost | null>(() => {
      if (sentMessageEditOperationId === null) {
        return null;
      }
      const operationId = sentMessageEditOperationId;
      return {
        scope: { kind: "thread", threadId: thread.id },
        textEffectKey: `sent-message:${thread.id}:${operationId}`,
        getCurrent: () =>
          readSentMessageEditDraft(
            sentMessageEditRef,
            operationId,
            ENDED_EDIT_SESSION_DRAFT,
          ),
        subscribeDraft: subscribeSentMessageEditDraft,
        setDraft: (nextDraft) =>
          writeSentMessageEditDraft(sentMessageEditRef, operationId, nextDraft),
        focus: focusInlinePluginComposer,
      };
    }, [
      focusInlinePluginComposer,
      sentMessageEditOperationId,
      sentMessageEditRef,
      subscribeSentMessageEditDraft,
      thread.id,
    ]);
  const sentMessageEditorPortal = useMemo(() => {
    if (!sentMessageEdit?.hostElement || !sentMessagePluginComposerHost) {
      return null;
    }
    const { draft, hostElement, operationId } = sentMessageEdit;
    return createPortal(
      <InlineMessageEditorFrame
        cancelLabel="Stop editing sent message"
        label="Editing message"
        onCancel={sentMessageEdit.onCancel}
        variant="cap"
      >
        {buildInlineDraftComposer({
          attachments: {
            items: draft.attachments,
            projectId,
            isAttaching: isAttachingSentMessageFiles,
            error: sentMessageAttachmentError,
            onAttachFiles: handleAttachSentMessageFiles,
            onRemove: (path) => {
              sentMessageEdit.updateDraft((current) => ({
                ...current,
                attachments: current.attachments.filter(
                  (attachment) => attachment.path !== path,
                ),
              }));
            },
          },
          canModifierSubmit: canSubmitSentMessageEdit,
          compactPromptPlaceholder: "Edit message",
          composerId: `${THREAD_DETAIL_COMPOSER_TEXTAREA_ID}-sent-${operationId}`,
          draft,
          editFocusNonce,
          execution: sentMessageExecutionConfig,
          executionReadOnly: false,
          focusSessionKey: operationId,
          historyResetKey: `${thread.id}:${operationId}`,
          isSubmitting: sentMessageEdit.isSubmitting,
          onChangeMessage: (text, mentions) =>
            sentMessageEdit.updateDraft((current) => ({
              ...current,
              text,
              mentions,
            })),
          onEscape: sentMessageEdit.onCancel,
          onSelectHistoryEntry: (nextDraft) =>
            sentMessageEdit.updateDraft(() => nextDraft),
          permission: {
            ...bottomPermissionConfig,
            value: sentMessageExecutionSelection?.permissionMode,
            supported: !isCloud && bottomPermissionConfig.supported,
          },
          pluginComposerHost: sentMessagePluginComposerHost,
          promptActions: inlinePromptActions,
          promptPlaceholder: "Edit message",
          submit: handleSentMessageEditSubmit,
          submitMode: sentMessageEditSubmitMode,
          submitTitle: "Submit edit (Enter)",
          suppressPluginComposerCustomizations: true,
          textEffects: sentMessageComposerTextEffects,
          threadRuntimeDisplayStatus: runtimeDisplayStatus,
          typeahead: inlineTypeaheadConfig,
          collapseResetKey: `sent-message:${operationId}`,
        })}
      </InlineMessageEditorFrame>,
      hostElement,
    );
  }, [
    bottomPermissionConfig,
    canSubmitSentMessageEdit,
    sentMessageExecutionConfig,
    sentMessageExecutionSelection,
    isCloud,
    editFocusNonce,
    handleAttachSentMessageFiles,
    handleSentMessageEditSubmit,
    isAttachingSentMessageFiles,
    projectId,
    inlinePromptActions,
    runtimeDisplayStatus,
    sentMessageAttachmentError,
    sentMessageComposerTextEffects,
    sentMessageEdit,
    sentMessageEditSubmitMode,
    sentMessagePluginComposerHost,
    thread.id,
    inlineTypeaheadConfig,
  ]);
  const childPendingInteractionBanners = useMemo(
    () =>
      childPendingInteractions.map((item) => (
        <ThreadPendingInteractionBanner
          key={item.interaction.id}
          interaction={item.interaction}
          sourceThread={{ href: item.href, title: item.childTitle }}
          threadId={item.childThreadId}
        />
      )),
    [childPendingInteractions],
  );
  const promptStack = useMemo(
    () => (
      <>
        {childPendingInteractionBanners}
        {activeWorkflows.map((workflow) => (
          <ThreadWorkflowCard
            key={workflow.id}
            workflow={workflow}
            isExpanded={expandedWorkflowIds.has(workflow.id)}
            onToggle={() => toggleWorkflowExpanded(workflow.id)}
          />
        ))}
        {activePromptModeCard}
        {activeGoalCard}
        <ThreadTodoCard
          pendingTodos={
            thread.archivedAt === null && environmentGoneStatus === null
              ? pendingTodos
              : null
          }
          isExpanded={isTodoExpanded}
          onToggle={() => setIsTodoExpanded((value) => !value)}
        />
        {environmentHostId &&
        thread.archivedAt === null &&
        environmentGoneStatus === null ? (
          <ThreadMachineStatus hostId={environmentHostId} />
        ) : null}
        <ThreadPromptContextBanner
          archivedSection={
            thread.archivedAt !== null
              ? {
                  archivedAt: thread.archivedAt,
                  onUnarchive: handleUnarchiveCurrentThread,
                  unarchivePending: isUnarchiveCurrentThreadPending,
                }
              : null
          }
          environmentGoneSection={
            environmentGoneStatus === null
              ? null
              : { status: environmentGoneStatus }
          }
          parentThreadSection={parentThreadSection}
          pullRequestSection={pullRequestSection}
          gitSection={
            workspaceChangedFilesSection
              ? {
                  changedFiles: workspaceChangedFilesSection,
                  mergeBase: contextBannerMergeBase,
                  onPromptBannerFileClick: canUseGitUi
                    ? onChangedFileClick
                    : ignorePromptBannerFileClick,
                }
              : null
          }
          gitSectionPending={workspaceStatusPending}
          expandedSection={expandedBannerSection}
          onToggleSection={handleToggleBannerSection}
          leading={
            activeBackgroundCommands.length > 0 ? (
              <ThreadBackgroundCommandsCard
                commands={activeBackgroundCommands}
                isExpanded={isBackgroundCommandsExpanded}
                onToggle={() =>
                  setIsBackgroundCommandsExpanded((value) => !value)
                }
              />
            ) : null
          }
        />
        {modelFallback ? (
          <ThreadModelFallbackCard
            key={`${thread.id}:${modelFallback.sourceSeq}`}
            fallback={modelFallback}
            threadId={thread.id}
          />
        ) : null}
        {shouldHideComposer ? null : queuedMessagesPending ? (
          <QueuedMessagesPendingCard queuedMessageCount={queuedMessageCount} />
        ) : (
          <QueuedMessagesList
            attachedToComposer={true}
            queuedMessages={queuedMessages}
            resolveMentionLink={resolveMentionLink}
            attachmentProjectId={projectId}
            inlineEditor={queuedMessageEditor ?? undefined}
            reorderable={!isCloud || cloudConnection.data?.queue_reorder === true}
            sendAction={shouldSteerWhenReady ? "steer-when-ready" : "send-now"}
            sendDisabled={
              submitMode.kind === "blocked" ||
              runtimeDisplayStatus === "waiting-for-host" ||
              isFollowUpSubmitting ||
              isQueueMutationPending ||
              movingToLocal
            }
            actionDisabled={isQueueMutationPending}
            processingMessageId={displayedProcessingQueuedMessage?.id ?? null}
            processingAction={displayedProcessingQueuedMessage?.action ?? null}
            onSend={handleSendQueuedMessage}
            onReorder={handleReorderQueuedMessage}
            onEdit={beginEditQueuedMessage}
            onDelete={handleDeleteQueuedMessage}
          />
        )}
      </>
    ),
    [
      canUseGitUi,
      childPendingInteractionBanners,
      contextBannerMergeBase,
      environmentHostId,
      expandedBannerSection,
      handleDeleteQueuedMessage,
      beginEditQueuedMessage,
      onChangedFileClick,
      handleReorderQueuedMessage,
      handleSendQueuedMessage,
      handleToggleBannerSection,
      handleUnarchiveCurrentThread,
      environmentGoneStatus,
      isFollowUpSubmitting,
      isUnarchiveCurrentThreadPending,
      isQueueMutationPending,
      movingToLocal,
      queuedMessageEditor,
      activeGoalCard,
      activePromptModeCard,
      isTodoExpanded,
      activeWorkflows,
      expandedWorkflowIds,
      toggleWorkflowExpanded,
      activeBackgroundCommands,
      isBackgroundCommandsExpanded,
      modelFallback,
      parentThreadSection,
      pullRequestSection,
      pendingTodos,
      displayedProcessingQueuedMessage,
      isCloud,
      cloudConnection.data?.queue_reorder,
      queuedMessageCount,
      queuedMessages,
      queuedMessagesPending,
      resolveMentionLink,
      runtimeDisplayStatus,
      shouldSteerWhenReady,
      shouldHideComposer,
      submitMode.kind,
      thread.archivedAt,
      thread.id,
      projectId,
      workspaceChangedFilesSection,
      workspaceStatusPending,
    ],
  );

  const pendingInteractionNode = useMemo(() => {
    if (!activePendingInteraction || shouldHideComposer) {
      return null;
    }
    return (
      <ThreadPendingInteractionBanner
        interaction={activePendingInteraction}
        threadId={thread.id}
      />
    );
  }, [activePendingInteraction, shouldHideComposer, thread.id]);
  const pendingInteractionStack = useMemo(
    () => (
      <>
        {childPendingInteractionBanners}
        {activePromptMode ? activePromptModeCard : null}
        {goal ? activeGoalCard : null}
      </>
    ),
    [
      activeGoalCard,
      activePromptMode,
      activePromptModeCard,
      childPendingInteractionBanners,
      goal,
    ],
  );

  const cloudFetchFailed = cloudState.error instanceof TypeError;
  const cloudOffline = cloudFetchFailed || (typeof navigator !== "undefined" && !navigator.onLine);
  const cloudError = retryCloudStart.error?.message ?? (cloudFetchFailed ? undefined : cloudState.error?.message) ?? cloudState.data?.error;
  const cloudReconnecting = !cloudError && (cloudOffline || cloudState.data?.reconnecting);
  const cloudLimitNotice = isCloud && !shouldHideComposer ? cloudState.data?.usageLimit ? <CloudUsageLimitNotice /> : cloudState.data?.disk ? <CloudDiskNotice disk={cloudState.data.disk} /> : null : null;
  const cloudFixPrompt = cloudError || cloudState.data?.failedStart ? cloudThreadFixPrompt(thread.id, thread.providerId, cloudError) : null;
  const cloudStatusKey = `${thread.id}|${cloudState.data?.failedStart ? "failed" : ""}|${cloudError ?? ""}`;
  const cloudStatusDismissed = dismissedCloudStatus === cloudStatusKey;
  const cloudAuthNotice = isCloud && !shouldHideComposer && cloudState.data?.authRequired ? (
    <PromptStackCard ariaLabel="Connect your account" className="w-full max-w-sm justify-self-center p-3 text-xs">
      {claudeThread ? <ClaudeSignIn target={{ target: "cloud" }} onContinue={() => retryCloudStart.mutate()} continuing={retryCloudStart.isPending} /> : (
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">Connect {thread.providerId === "acp-cursor" ? "Cursor" : "Codex"} to start</p>
            <p className="text-muted-foreground">Your message is saved.</p>
          </div>
          <Button type="button" size="sm" className="h-7 text-xs" onClick={() => openCloudConnection(thread.id)}>Connect</Button>
        </div>
      )}
      {retryCloudStart.error && <p role="alert" className="mt-2 text-destructive">{retryCloudStart.error.message}</p>}
    </PromptStackCard>
  ) : null;
  const cloudReconnectingPill = cloudReconnecting ? (
    <div className="flex items-center gap-2 justify-self-center rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
      <span role="status" className="flex items-center gap-2">{cloudOffline && <><span className="text-foreground">Offline</span><span aria-hidden>·</span></>}<span>Reconnecting…</span></span>
      <span aria-hidden>·</span>
      <button type="button" className="underline underline-offset-2 hover:text-foreground disabled:opacity-50" disabled={cloudState.isFetching} onClick={() => void cloudState.refetch()}>Retry</button>
    </div>
  ) : null;
  const cloudNotice = cloudAuthNotice ?? cloudLimitNotice ?? (isCloud && !shouldHideComposer && (cloudError || cloudReconnecting || cloudState.data?.failedStart) ? (<>
    {cloudReconnectingPill}
    {cloudFixPrompt && !cloudStatusDismissed && <div role="alert" aria-label="Cloud thread status" className="flex min-w-0 max-w-full items-center gap-2 justify-self-center rounded-full border border-border bg-background py-1 pl-3 pr-1.5 text-xs text-muted-foreground">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-destructive" />
      <span className="truncate text-foreground" title={cloudError ?? undefined}>{cloudError ? plainCloudError(cloudError) : "Cloud thread didn't start"}</span>
      {cloudState.data?.failedStart && <button type="button" className="shrink-0 text-foreground underline underline-offset-2 disabled:opacity-50" disabled={retryCloudStart.isPending} onClick={() => retryCloudStart.mutate()}>Retry</button>}
      {cloudState.isError && !cloudFetchFailed && <button type="button" className="shrink-0 text-foreground underline underline-offset-2 disabled:opacity-50" disabled={cloudState.isFetching} onClick={() => void cloudState.refetch()}>Reconnect</button>}
      <span aria-hidden className="h-3.5 w-px shrink-0 bg-border" />
      <CopyButton text={cloudFixPrompt} label="Copy fix prompt for your AI agent" className="shrink-0" />
      <button type="button" aria-label="Dismiss" className="flex size-5 shrink-0 cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground" onClick={() => setDismissedCloudStatus(cloudStatusKey)}><Icon name="X" className="size-3" aria-hidden /></button>
    </div>}
  </>) : null);

  const bottomContent = (
    <FollowUpPromptBox
      id={THREAD_DETAIL_COMPOSER_TEXTAREA_ID}
      attachments={bottomAttachmentsConfig}
      stack={<>{!isCloud && !teleporting && <TeleportCheckCard error={teleport.error} models={[...modelOptions, ...moreModelOptions]} reasoning={reasoningLevel} usedTokens={contextWindowUsage?.usedTokens ?? null} levelsFor={(model) => cloudReasoningLevels(cloudConnection.data, thread.providerId, model)} onTeleport={(choice) => teleport.mutate(choice)} onDismiss={teleport.reset} />}{!isCloud && !teleporting && canTeleport && !shouldHideComposer && <TryCloudCard threadId={thread.id} active={thread.status === "active"} attached={queuedMessageCount === 0} onMove={startTeleport} />}{thread.teleport && !movingToLocal && <TeleportNotice thread={thread} pendingDelivery={cloudState.data?.pendingDelivery} paused={cloudState.data?.paused} sending={sendMessage.isPending} />}{movingToLocal && <TeleportLocalNotice step={thread.teleportLocalStep} />}{thread.projectCopy && <ProjectCopyNotice thread={thread} />}{cloudNotice}{isCloud && claudeThread && !shouldHideComposer && <CloudMcpSignInNotice />}{!isCloud && !shouldHideComposer && <LocalSignInNotice threadId={thread.id} providerId={thread.providerId} hostId={environmentHostId} environmentId={thread.environmentId} authFailed={providerAuthFailed} started={thread.status !== "pending"} />}{pendingInteractionNode ? pendingInteractionStack : promptStack}</>}
      pendingInteraction={pendingInteractionNode}
      activePromptMode={activePromptMode}
      composer={shouldHideComposer || (teleporting && !movingToLocal) || transferredChild ? null : bottomComposerConfig}
      pluginComposerHost={normalPluginComposerHost}
      pluginComposerScope={normalPluginComposerHost.scope}
      textEffects={promptTextEffects}
      collapseResetKey={thread.id}
      focusEndKey={bottomFocusEndKey}
      environmentSummary={environmentSummary}
      contextWindowUsage={contextWindowUsage ?? null}
      contextWindowNote={thread.providerId === "acp-cursor" ? "Cursor doesn't report token usage, so this is an estimate." : undefined}
      execution={isCloud ? {
        ...bottomExecutionConfig,
        provider: { ...bottomExecutionConfig.provider, selectedId: thread.providerId, options: cloudProviderOptions, hasMultiple: cloudProviderOptions.length > 1 },
        model: { ...bottomExecutionConfig.model, active: cloudState.data ? { model: cloudState.data.model } : null, isLoading: !cloudState.data, options: [...modelOptions, ...moreModelOptions], moreOptions: [], loadFailed: false, loadError: null, onChange: (model: string) => handleSelectModel({ providerId: thread.providerId, model }) },
        reasoning: { ...bottomExecutionConfig.reasoning, value: cloudReasoning, options: cloudFollowUpReasoningOptions, onChange: handleReasoningChange },
        serviceTier: { ...bottomExecutionConfig.serviceTier, value: cloudFastSupported ? serviceTier : "default", supported: cloudFastSupported },
      } : bottomExecutionConfig}
      permission={isCloud ? { ...bottomPermissionConfig, value: "full", supported: false } : bottomPermissionConfig}
      typeahead={typeaheadConfig}
      promptActions={promptActions}
    />
  );

  return (
    <>
      {sentMessageEditorPortal}
      {bottomContent}
    </>
  );
}
