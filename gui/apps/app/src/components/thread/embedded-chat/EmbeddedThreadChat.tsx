import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  useIsMutating,
  useMutationState,
  useQueryClient,
} from "@tanstack/react-query";
import {
  defaultAppSettings,
  reasoningLevelSchema,
  reconcileReasoningLevel,
  type PromptInput,
  type ReasoningLevel,
} from "@cloudroom/domain";
import type {
  SendMessageDelivery,
  ThreadTimelineResponse,
  UpdateThreadRequest,
} from "@cloudroom/server-contract";
import type { ModelReasoningPickerSelection } from "@/components/pickers/ModelReasoningPicker";
import type {
  AttachmentsConfig,
  HistoryConfig,
} from "@/components/promptbox/PromptBoxInternal";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { Button } from "@cloudroom/shared-ui/button";
import { BottomAnchoredScrollBody } from "@/components/ui/bottom-anchored-scroll-body";
import { PageShell } from "@/components/ui/page-shell.js";
import {
  FollowUpPromptBox,
  type FollowUpComposerProps,
} from "@/components/promptbox/FollowUpPromptBox";
import {
  useComposerHostDraftNotifier,
  type PluginComposerHost,
} from "@/components/plugin/plugin-composer-host";
import { ThreadPendingInteractionBanner } from "@/components/thread/pending-interactions/ThreadPendingInteractionBanner";
import {
  QueuedMessagesList,
  type QueuedMessageInlineEditor,
} from "@/components/promptbox/banner/QueuedMessagesList";
import type {
  ExecutionControlsProps,
  ExecutionPermissionConfig,
} from "@/components/promptbox/ExecutionControls";
import { OverflowFade } from "@/components/ui/overflow-fade";
import {
  ThreadTimelinePanelContent,
  ThreadTimelineSurface,
  type ThreadTimelineAddToChatHandler,
  type ThreadTimelineConsumerMessageAction,
  type ThreadTimelineLinkHandler,
  type ThreadTimelineLocalFileLinkHandler,
  type ThreadTimelineSurfaceProps,
} from "@/components/thread/timeline";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import {
  getLatestPendingInteraction,
  isPendingInteractionStateUnknown,
  useThread,
  useThreadPendingInteractions,
  useThreadQueuedMessages,
  useThreadTimeline,
} from "@/hooks/queries/thread-queries";
import { useThreadDefaultExecutionOptions } from "@/hooks/queries/thread-default-execution-options-query";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import {
  useCreateThreadQueuedMessage,
  useSendThreadMessage,
  useStopThread,
} from "@/hooks/mutations/thread-runtime-mutations";
import {
  useMarkThreadRead,
  useSaveThreadModel,
  useUpdateThread,
} from "@/hooks/mutations/thread-state-mutations";
import {
  cloudCanRunHarness,
  cloudHarness,
  cloudOpenCodeCatalog,
  cloudReasoningLevels,
  cloudServiceTierSupported,
  cloudUltraFastSupported,
  partitionCloudOpenCodeModelOptions,
  useCloudroomConnection,
  useCloudroomThread,
  useRetryCloudStart,
  useSetCloudReasoning,
} from "@/hooks/queries/cloudroom-queries";
import { resolveModelReasoningLevel } from "@/hooks/thread-creation-options/model-catalog-selection";
import { plainError } from "@/lib/fix-prompts";
import { reasoningLevelLabel } from "@/lib/reasoning-labels";
import { useThreadReadTracking } from "@/hooks/useThreadReadTracking";
import { useComposerTextEffects } from "@/lib/composer-text-effects";
import { showMutationErrorToast } from "@/lib/mutation-errors";
import type { PromptDraftScope } from "@/hooks/usePromptDraftStorage";
import { appToast } from "@/components/ui/app-toast";
import {
  buildSideChatSubmitMode,
  canSubmitFollowUpShortcut,
  shouldQueueFollowUpMessage,
} from "@cloudroom/client-core";
import { useActiveComposerDraft } from "./useActiveComposerDraft";
import { useComposerAttachmentUploads } from "./useComposerAttachmentUploads";
import { useLatestRef } from "@/hooks/useLatestRef";
import { useComposerTypeahead } from "./useComposerTypeahead";
import { useCopyCommand } from "@/hooks/useCopyCommand";
import { useInlineQueuedMessageEditing } from "./useInlineQueuedMessageEditing";
import { useQueuedMessageActions } from "./useQueuedMessageActions";
import { PromptDraftContextsContext } from "@/components/promptbox/editor/prompt-context-chip";

const selectContextWindowUsage = (timeline: ThreadTimelineResponse) =>
  timeline.contextWindowUsage ?? null;

function reportQueuedSendDelivery(delivery: SendMessageDelivery): void {
  if (delivery !== "queued") {
    return;
  }
  appToast.message(
    "Message queued until this thread can take it. It sends by itself; do not send it again.",
  );
}

let pluginComposerHostOwnershipSequence = 0;

function createPluginComposerHostIdentity(scopeIdentity: string): string {
  pluginComposerHostOwnershipSequence += 1;
  return `${scopeIdentity}:ownership:${pluginComposerHostOwnershipSequence}`;
}

type PendingInteractionsQueryBannerProps =
  | { state: "loading" }
  | { state: "error"; isRetrying: boolean; onRetry: () => void };

function PendingInteractionsQueryBanner(
  props: PendingInteractionsQueryBannerProps,
) {
  const isError = props.state === "error";
  return (
    <div
      className={cn(
        "mb-2 flex min-w-0 max-w-full items-center justify-between gap-3 rounded-lg border border-border bg-surface-recessed px-4 py-3 text-xs text-muted-foreground",
        isError &&
          "border-surface-destructive-border bg-surface-destructive text-destructive-text",
      )}
      role={isError ? "alert" : "status"}
    >
      <span>
        {isError
          ? "Couldn't check pending interactions."
          : "Checking pending interactions…"}
      </span>
      {props.state === "error" ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.isRetrying}
          onClick={props.onRetry}
          className="h-7 cursor-pointer px-2"
        >
          {props.isRetrying ? "Retrying…" : "Retry"}
        </Button>
      ) : null}
    </div>
  );
}

interface EmbeddedThreadChatComposerProps {
  draftScope: PromptDraftScope;
  executionDefaultsThreadId: string;
  executionResetKey: string;
  executionEnvironmentId?: string;
  executionEnvironmentHostId?: string;
  permissionPolicy: "editable" | "snapshot";
  environmentSummary: ReactNode;
  pluginComposerBottomScope?: PluginComposerHost["scope"] | null;
  composerIdentity?: string;
  focusRequestKey?: number;
}

interface EmbeddedThreadChatSharedProps {
  threadId: string;
  projectId: string;
  providerId: string;
  promptContextEnvironmentId: string | null;
  resolveMentionLink: PromptMentionLinkResolver;
  leadingContent?: ReactNode;
  consumerMessageActions?: readonly ThreadTimelineConsumerMessageAction[];
  includePluginMessageActions?: boolean;
  onOpenLink?: ThreadTimelineLinkHandler;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  workspaceRootPath?: string;
  layout?: "contained" | "document";
  measure?: "panel" | "page";
}

interface EmbeddedThreadChatComposerModeProps extends EmbeddedThreadChatSharedProps {
  variant: "compact";
  surfaceTone?: "background" | "sidebar";
  composer: EmbeddedThreadChatComposerProps;
  footer?: never;
}

interface EmbeddedThreadChatHostedFooterProps {
  variant: "hosted-footer";
  footer: ReactNode;
  scrollOverlay?: ReactNode;
  surface: ThreadTimelineSurfaceProps;
  composer?: never;
}

type EmbeddedThreadChatProps =
  | EmbeddedThreadChatComposerModeProps
  | EmbeddedThreadChatHostedFooterProps;

export function EmbeddedThreadChat(props: EmbeddedThreadChatProps) {
  if (props.variant === "hosted-footer") {
    return <EmbeddedThreadChatHostedFooter {...props} />;
  }
  return <EmbeddedThreadChatWithComposer {...props} />;
}

function EmbeddedThreadChatHostedFooter({
  footer,
  scrollOverlay,
  surface,
}: EmbeddedThreadChatHostedFooterProps) {
  return (
    <div
      data-thread-window=""
      data-wallpaper="thread"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-clip"
    >
      <PageShell
        key={surface.threadId}
        scrollBehavior="bottom-anchor"
        scrollAnchorThreadId={surface.threadId}
        shellClassName="!mx-0 !mt-0 md:!mx-0 md:!mt-0"
        contentClassName="gap-2 pt-4"
        footerClassName="chat-prompt-box"
        footer={footer}
        scrollOverlay={scrollOverlay}
      >
        <ThreadTimelineSurface {...surface} />
      </PageShell>
    </div>
  );
}

function EmbeddedThreadChatWithComposer({
  threadId,
  projectId,
  providerId,
  promptContextEnvironmentId,
  resolveMentionLink,
  leadingContent,
  consumerMessageActions,
  includePluginMessageActions,
  onOpenLink,
  onOpenLocalFileLink,
  workspaceRootPath,
  layout = "contained",
  measure = "panel",
  surfaceTone = "background",
  composer,
}: EmbeddedThreadChatComposerModeProps) {
  const systemConfigQuery = useSystemConfig();
  const steerActiveThreadOnEnter =
    systemConfigQuery.data?.generalSettings.steerActiveThreadOnEnter ??
    defaultAppSettings.steerActiveThreadOnEnter;
  const surfaceKey = threadId;
  const markThreadRead = useMarkThreadRead();
  const stopThread = useStopThread();
  const sendThreadMessage = useSendThreadMessage();
  const createQueuedMessage = useCreateThreadQueuedMessage();
  const threadQuery = useThread(threadId);
  // Shares the timeline query the panel already loads; no extra request.
  const contextWindowUsage =
    useThreadTimeline(threadId, { select: selectContextWindowUsage }).data ??
    null;
  const pendingInteractionsQuery = useThreadPendingInteractions(threadId);
  const activePendingInteraction = getLatestPendingInteraction(
    pendingInteractionsQuery.data,
  );
  const hasComposerBlockingPendingInteraction =
    activePendingInteraction !== null &&
    activePendingInteraction.payload.kind !== "plugin";
  const pendingInteractionsInitialLoading = isPendingInteractionStateUnknown(
    pendingInteractionsQuery.data,
    pendingInteractionsQuery.isFetching,
  );
  const pendingInteractionsUnavailable =
    activePendingInteraction === null && pendingInteractionsQuery.isError;
  const pendingInteractionOccupiesComposer =
    hasComposerBlockingPendingInteraction ||
    pendingInteractionsInitialLoading ||
    pendingInteractionsUnavailable;
  useThreadReadTracking({
    markThreadRead,
    thread: threadQuery.data,
  });
  const { data: queuedMessages = [] } = useThreadQueuedMessages(threadId);

  const threadProviderId = threadQuery.data?.providerId ?? providerId;
  const displayStatus = threadQuery.data?.runtime.displayStatus ?? "idle";
  const isCloud = threadQuery.data?.executionTarget === "cloud";
  const canPickLocalModel = threadQuery.data?.executionTarget === "local";
  const queryClient = useQueryClient();
  const cloudState = useCloudroomThread(threadId, isCloud);
  const cloudConnection = useCloudroomConnection();
  const setCloudReasoning = useSetCloudReasoning(threadId);
  const retryCloudStart = useRetryCloudStart(threadId);
  const { mutate: updateExecution } = useUpdateThread({
    threadId,
    errorMessage: "Failed to save thread execution settings.",
  });
  const saveReasoning = useUpdateThread({
    threadId,
    errorMessage: "Failed to save thread execution settings.",
    reasoning: true,
  });
  const pendingSwitch = useMutationState({
    filters: {
      mutationKey: ["thread-update", threadId],
      exact: true,
      status: "pending",
    },
    select: (mutation) =>
      mutation.state.variables as UpdateThreadRequest | undefined,
  })
    .filter((variables) => typeof variables?.model === "string")
    .at(-1);
  const isExecutionUpdatePending =
    useIsMutating({ mutationKey: ["thread-update", threadId] }) > 0;
  const cloudReasoning =
    pendingSwitch?.reasoningLevel ??
    (setCloudReasoning.isPending ? setCloudReasoning.variables : undefined) ??
    cloudState.data?.reasoning ??
    "medium";
  const cloudModel = pendingSwitch?.model ?? cloudState.data?.model;
  const cloudSessionId = cloudState.data?.sessionId ?? null;

  const executionOptionsQuery = useThreadDefaultExecutionOptions(
    composer.executionDefaultsThreadId,
    { enabled: !isCloud },
  );
  const defaultExecutionOptions =
    isCloud && cloudState.data
      ? {
          providerId: threadProviderId,
          model: cloudState.data.model,
          reasoningLevel: cloudState.data.reasoning,
          permissionMode: "full" as const,
          serviceTier: cloudState.data.serviceTier,
        }
      : executionOptionsQuery.data;
  const threadCreationOptions = useThreadCreationOptions({
    cloud: isCloud,
    enabled: true,
    scope: "component-local",
    environmentId: composer.executionEnvironmentId,
    environmentHostId: composer.executionEnvironmentHostId,
    resetKey: composer.executionResetKey,
    initialProviderId: threadProviderId,
    initialModel: defaultExecutionOptions?.model,
    initialServiceTier: defaultExecutionOptions?.serviceTier,
    initialReasoningLevel: defaultExecutionOptions?.reasoningLevel,
    initialPermissionMode: defaultExecutionOptions?.permissionMode,
  });
  const {
    executionOptionsRouting,
    selectedProviderId,
    setProviderModelReasoning,
    providerOptions,
    hasMultipleProviders,
    selectedProviderComposerActions,
    selectedModel,
    setSelectedModel,
    serviceTier: selectedServiceTier,
    setServiceTier,
    reasoningLevel,
    setReasoningLevel,
    permissionMode,
    setPermissionMode,
    activeModel,
    modelOptions,
    moreModelOptions,
    modelCatalogIsVerified,
    modelLoadFailed,
    modelLoadError,
    reasoningOptions,
    permissionModeOptions,
    supportsPermissionModeSelection,
    supportsServiceTier,
    supportsUltraFast,
    serviceTierSupportByProvider,
    serviceTierFastLabel,
    isLoadingModels,
  } = threadCreationOptions;
  const { save: saveModel, pendingModel } = useSaveThreadModel(threadId, setSelectedModel);
  const activeCloudProviderId = pendingSwitch?.providerId ?? threadProviderId;
  const cloudProviderOptions = useMemo(
    () => providerOptions.filter((option) => cloudCanRunHarness(option.value)),
    [providerOptions],
  );
  const cloudFollowUpReasoningOptions = useMemo(() => {
    // Before its first message a side chat has no session, so any effort its agent offers can still be picked.
    const fixed =
      Boolean(cloudSessionId) &&
      activeCloudProviderId.startsWith("acp-") &&
      !cloudHarness(cloudConnection.data, activeCloudProviderId)?.prompt_reasoning;
    const levels = fixed
      ? [cloudReasoning]
      : cloudReasoningLevels(cloudConnection.data, activeCloudProviderId, cloudModel);
    return [...new Set([cloudReasoning, ...levels])]
      .flatMap((level) => {
        const parsed = reasoningLevelSchema.safeParse(level);
        return parsed.success
          ? [{ value: parsed.data, label: reasoningLevelLabel(parsed.data, undefined) }]
          : [];
      })
      .sort(
        (a, b) =>
          reasoningLevelSchema.options.indexOf(a.value) -
          reasoningLevelSchema.options.indexOf(b.value),
      );
  }, [activeCloudProviderId, cloudConnection.data, cloudModel, cloudReasoning, cloudSessionId]);
  const cloudFastSupported =
    isCloud && cloudServiceTierSupported(cloudConnection.data, activeCloudProviderId);
  const ultraFast =
    supportsUltraFast &&
    (!isCloud || cloudUltraFastSupported(cloudConnection.data, activeCloudProviderId, cloudModel));
  const serviceTier =
    selectedServiceTier === "ultrafast" && !ultraFast ? "default" : selectedServiceTier;
  const cloudOpenCodeModelsRef =
    isCloud && activeCloudProviderId === "acp-opencode"
      ? cloudOpenCodeCatalog(cloudConnection.data)
      : null;
  const cloudModelPartition = useMemo(() => {
    const combined = [...modelOptions, ...moreModelOptions];
    return (
      partitionCloudOpenCodeModelOptions(combined, cloudOpenCodeModelsRef) ?? {
        primary: combined,
        more: [],
      }
    );
  }, [modelOptions, moreModelOptions, cloudOpenCodeModelsRef]);
  const shortcutHarness =
    isCloud && cloudState.data?.sessionId
      ? cloudHarness(cloudConnection.data, threadProviderId)
      : undefined;
  const selectedExecutionModel =
    pendingSwitch?.model ?? pendingModel ?? activeModel?.model ?? selectedModel;
  const followUpReasoningLevel = isCloud
    ? cloudReasoning
    : pendingSwitch?.reasoningLevel ??
      resolveModelReasoningLevel(
        activeModel,
        (saveReasoning.isPending ? saveReasoning.variables?.reasoningLevel : undefined) ??
          defaultExecutionOptions?.reasoningLevel ??
          reasoningLevel,
      );
  const handleReasoningChange = useCallback(
    (level: ReasoningLevel) => {
      if (isCloud) {
        setCloudReasoning.mutate(level);
        return;
      }
      setReasoningLevel(level);
      saveReasoning.mutate({
        id: threadId,
        reasoningLevel: level,
        ...(selectedExecutionModel !== defaultExecutionOptions?.model
          ? { model: selectedExecutionModel }
          : {}),
      });
    },
    [
      defaultExecutionOptions?.model,
      isCloud,
      saveReasoning,
      selectedExecutionModel,
      setCloudReasoning,
      setReasoningLevel,
      threadId,
    ],
  );
  // Picking another harness or a Cloud model switches the side chat in place (ADR 0211).
  const handleSelectModel = useCallback(
    (
      selection: { providerId: string; model: string } & Partial<ModelReasoningPickerSelection>,
    ) => {
      if (selection.providerId === threadProviderId) {
        if (!isCloud) {
          void saveModel(selection.model).catch(() => {});
          return;
        }
        if (selection.model === cloudState.data?.model) return;
      }
      const level = selection.reasoningLevel ?? followUpReasoningLevel;
      const cloudLevels = isCloud
        ? cloudReasoningLevels(cloudConnection.data, selection.providerId, selection.model)
        : [];
      const supported = reasoningLevelSchema.options.filter((option) =>
        cloudLevels.includes(option),
      );
      const next = {
        ...selection,
        reasoningLevel:
          supported.length > 0
            ? reconcileReasoningLevel(level, supported)
            : level,
      };
      const previous = {
        providerId: threadProviderId,
        model: isCloud ? (cloudState.data?.model ?? selectedExecutionModel) : selectedExecutionModel,
        reasoningLevel: followUpReasoningLevel,
      };
      setProviderModelReasoning(next);
      updateExecution(
        { id: threadId, ...next },
        {
          // Show the new model and effort at once, so a quick send can't carry the old ones.
          onSuccess: async () => {
            const queryKey = ["cloudroom-thread", threadId];
            await queryClient.cancelQueries({ queryKey });
            queryClient.setQueryData<{ model: string; reasoning: string } | null>(queryKey, (data) =>
              data && { ...data, model: next.model, reasoning: next.reasoningLevel },
            );
            void queryClient.invalidateQueries({ queryKey });
          },
          onError: () => setProviderModelReasoning(previous),
        },
      );
    },
    [
      cloudConnection.data,
      cloudState.data?.model,
      followUpReasoningLevel,
      isCloud,
      queryClient,
      saveModel,
      selectedExecutionModel,
      setProviderModelReasoning,
      threadId,
      threadProviderId,
      updateExecution,
    ],
  );
  const selectedExecutionServiceTier = isCloud
    ? (cloudFastSupported ? serviceTier : undefined)
    : supportsServiceTier
      ? serviceTier
      : undefined;
  const snapshotPermissionMode = defaultExecutionOptions?.permissionMode;
  const effectivePermissionMode =
    composer.permissionPolicy === "snapshot"
      ? snapshotPermissionMode
      : permissionMode;

  const executionRequestFields = useMemo(
    () => ({
      ...(selectedExecutionModel.length > 0 || isCloud
        ? {
            ...(isCloud ? {} : { model: selectedExecutionModel }),
            reasoningLevel: followUpReasoningLevel,
            ...(selectedExecutionServiceTier
              ? { serviceTier: selectedExecutionServiceTier }
              : {}),
          }
        : {}),
      ...(effectivePermissionMode !== undefined && !isCloud
        ? { permissionMode: effectivePermissionMode }
        : {}),
    }),
    [
      effectivePermissionMode,
      followUpReasoningLevel,
      isCloud,
      selectedExecutionModel,
      selectedExecutionServiceTier,
    ],
  );
  const [composerFocusNonce, setComposerFocusNonce] = useState(0);
  const [inlineComposerFocusNonce, setInlineComposerFocusNonce] = useState(0);
  const [isTurnSubmitting, setIsTurnSubmitting] = useState(false);
  const isMountedRef = useRef(false);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const clearInlineAttachmentErrorRef = useRef<() => void>(() => {});
  const {
    inlineEditingQueuedMessage,
    inlineEditingQueuedMessageRef,
    updateInlineQueuedMessage,
    dismissInlineQueuedMessageEditor,
    beginEditQueuedMessage,
    queuedMessageDraftSession,
  } = useInlineQueuedMessageEditing({
    ownerThreadId: threadId,
    queuedMessages,
    onBeginEdit: () => {
      clearInlineAttachmentErrorRef.current();
      setInlineComposerFocusNonce((nonce) => nonce + 1);
    },
  });
  const inlineDraftSessionRef = useLatestRef(queuedMessageDraftSession);
  const {
    promptDraft,
    currentPromptDraft,
    currentPromptDraftInput,
    activeComposerDraft,
    activeComposerDraftInput,
    setActiveComposerDraft,
    handleChangeMessage,
    removeActiveComposerAttachment,
  } = useActiveComposerDraft({
    draftScope: composer.draftScope,
    inlineDraft: inlineEditingQueuedMessage?.draft ?? null,
    inlineSessionRef: inlineDraftSessionRef,
  });
  const {
    bottomAttachmentFailures,
    dismissBottomAttachmentFailures,
    handleAttachBottomFiles,
    isAttachingBottomFiles,
    inlineAttachmentFailures,
    dismissInlineAttachmentFailures,
    handleAttachInlineFiles,
    isAttachingInlineFiles,
  } = useComposerAttachmentUploads({
    projectId,
    addDraftAttachment: promptDraft.addAttachment,
    inlineEditSessionId: queuedMessageDraftSession?.editSessionId ?? null,
    inlineSessionRef: inlineDraftSessionRef,
  });
  clearInlineAttachmentErrorRef.current = () => dismissInlineAttachmentFailures();
  const { typeaheadConfig, promptActions } = useComposerTypeahead({
    projectId,
    providerId: selectedProviderId,
    environmentId: promptContextEnvironmentId,
    currentThreadId: threadId,
    selectedProviderComposerActions,
    resolveMentionLink,
  });

  const isStopRequested =
    threadQuery.data?.status === "stopping" ||
    (stopThread.isPending && stopThread.variables === threadId);
  const handleStopThread = useCallback(() => {
    stopThread.mutate(threadId);
  }, [stopThread, threadId]);
  const isProvisioning =
    displayStatus === "provisioning" || displayStatus === "starting";
  const isDefaultExecutionOptionsLoading = isCloud
    ? cloudState.data === undefined && cloudState.isLoading
    : executionOptionsQuery.isPlaceholderData ||
      (defaultExecutionOptions === undefined && executionOptionsQuery.isLoading);

  const {
    processingQueuedMessage,
    queuedMessageActionPending,
    isUpdateQueuedMessagePending,
    sendQueuedMessageById,
    handleSaveInlineQueuedMessage,
    handleDeleteQueuedMessage,
    handleReorderQueuedMessage,
  } = useQueuedMessageActions({
    threadId,
    queuedMessages,
    sendProcessingPersistence: "clear-on-settle",
    onSaveSuccess: () => dismissInlineAttachmentFailures(),
    inlineEditingQueuedMessage,
    dismissInlineQueuedMessageEditor,
    activeComposerDraftInput,
  });

  const submitMode = useMemo<FollowUpComposerProps["submitMode"]>(
    () =>
      buildSideChatSubmitMode({
        childThreadId: threadId,
        hasPendingInteraction: hasComposerBlockingPendingInteraction,
        isDefaultExecutionOptionsLoading,
        isPendingInteractionsInitialLoading:
          pendingInteractionsInitialLoading || pendingInteractionsUnavailable,
        isStopRequested,
        onStop: handleStopThread,
        runtimeDisplayStatus: displayStatus,
      }),
    [
      displayStatus,
      hasComposerBlockingPendingInteraction,
      handleStopThread,
      isDefaultExecutionOptionsLoading,
      isStopRequested,
      pendingInteractionsInitialLoading,
      pendingInteractionsUnavailable,
      threadId,
    ],
  );

  const defaultSendOrQueueInput = useCallback(
    async (input: PromptInput[]) => {
      if (shouldQueueFollowUpMessage(displayStatus)) {
        await createQueuedMessage.mutateAsync({
          id: threadId,
          input,
          ...executionRequestFields,
        });
        return;
      }
      const result = await sendThreadMessage.mutateAsync({
        id: threadId,
        input,
        mode: "queue-if-active",
        ...executionRequestFields,
      });
      reportQueuedSendDelivery(result.delivery);
    },
    [
      createQueuedMessage,
      displayStatus,
      executionRequestFields,
      sendThreadMessage,
      threadId,
    ],
  );
  const runCopyCommand = useCopyCommand(
    threadId,
    promptDraft.clearIfCurrentMatches,
  );
  const handleSubmit = useCallback(() => {
    const submittedDraft = currentPromptDraft;
    const submittedInput = currentPromptDraftInput;
    if (runCopyCommand(submittedDraft)) return;
    if (submittedInput.length === 0 || isTurnSubmitting) {
      return;
    }
    promptDraft.clearIfCurrentMatches(submittedDraft);
    dismissBottomAttachmentFailures();
    setIsTurnSubmitting(true);
    void defaultSendOrQueueInput(submittedInput)
      .catch((error) => {
        if (!isMountedRef.current) {
          return;
        }
        promptDraft.restoreIfEmpty(submittedDraft);
        showMutationErrorToast({
          error,
          fallbackMessage: "Failed to send message",
          lifecycleOperation: shouldQueueFollowUpMessage(displayStatus)
            ? "queue_message"
            : "send_message",
        });
      })
      .finally(() => {
        if (isMountedRef.current) {
          setIsTurnSubmitting(false);
        }
      });
  }, [
    currentPromptDraft,
    currentPromptDraftInput,
    defaultSendOrQueueInput,
    displayStatus,
    isTurnSubmitting,
    promptDraft,
    runCopyCommand,
    dismissBottomAttachmentFailures,
  ]);

  const isQueueMutationPending =
    queuedMessageActionPending || createQueuedMessage.isPending;
  const handleSendQueuedMessage = useCallback(
    (queuedMessageId: string) => {
      void sendQueuedMessageById({
        guard: "exists",
        messageId: queuedMessageId,
        mode: isProvisioning ? "steer" : "auto",
      });
    },
    [isProvisioning, sendQueuedMessageById],
  );
  const hasPromptDraftInput = currentPromptDraftInput.length > 0;
  const canSubmitModifierShortcut = canSubmitFollowUpShortcut({
    hasPromptDraftInput,
    isFollowUpSubmitting: isTurnSubmitting,
    isQueueMutationPending,
    queuedMessageCount: queuedMessages.length,
    runtimeDisplayStatus: displayStatus,
    submitModeKind: submitMode.kind,
  });
  const handleModifierSubmit = useCallback(() => {
    if (!canSubmitModifierShortcut) {
      return;
    }

    const submittedDraft = currentPromptDraft;
    const submittedInput = currentPromptDraftInput;
    if (submittedInput.length === 0) {
      const nextQueuedMessage = queuedMessages[0];
      if (nextQueuedMessage) {
        void sendQueuedMessageById({
          guard: "current-head",
          messageId: nextQueuedMessage.id,
          mode: "steer",
        });
      }
      return;
    }

    promptDraft.clearIfCurrentMatches(submittedDraft);
    dismissBottomAttachmentFailures();
    setIsTurnSubmitting(true);
    void sendThreadMessage
      .mutateAsync({
        id: threadId,
        input: submittedInput,
        mode: "steer-if-active",
        ...executionRequestFields,
      })
      .then((result) => {
        reportQueuedSendDelivery(result.delivery);
      })
      .catch((error) => {
        if (!isMountedRef.current) {
          return;
        }
        promptDraft.restoreIfEmpty(submittedDraft);
        showMutationErrorToast({
          error,
          fallbackMessage: "Failed to send message",
          lifecycleOperation: "send_message",
        });
      })
      .finally(() => {
        if (isMountedRef.current) {
          setIsTurnSubmitting(false);
        }
      });
  }, [
    canSubmitModifierShortcut,
    currentPromptDraft,
    currentPromptDraftInput,
    executionRequestFields,
    promptDraft,
    queuedMessages,
    sendQueuedMessageById,
    sendThreadMessage,
    dismissBottomAttachmentFailures,
    threadId,
  ]);

  const handleInlineComposerSubmit = useCallback(() => {
    void handleSaveInlineQueuedMessage();
  }, [handleSaveInlineQueuedMessage]);

  const addQuoteToPromptDraft = promptDraft.addQuote;
  const handleAddToChat = useCallback<ThreadTimelineAddToChatHandler>(
    (text, attachments, source) => {
      addQuoteToPromptDraft(text, attachments, source);
      setComposerFocusNonce((nonce) => nonce + 1);
    },
    [addQuoteToPromptDraft],
  );

  const queuedEditSessionId = inlineEditingQueuedMessage?.editSessionId ?? null;
  const queuedEditOwnerThreadId =
    inlineEditingQueuedMessage?.ownerThreadId ?? null;
  const queuedEditMessageId =
    inlineEditingQueuedMessage?.queuedMessageId ?? null;
  const queuedComposerIdentity = useMemo(
    () =>
      queuedEditSessionId === null ||
      queuedEditOwnerThreadId === null ||
      queuedEditMessageId === null
        ? null
        : {
            editSessionId: queuedEditSessionId,
            ownerThreadId: queuedEditOwnerThreadId,
            queuedMessageId: queuedEditMessageId,
          },
    [queuedEditMessageId, queuedEditOwnerThreadId, queuedEditSessionId],
  );
  const bottomScope = composer.pluginComposerBottomScope ?? null;
  const bottomComposerHostIdentity = useMemo(
    () =>
      createPluginComposerHostIdentity(
        `${composer.composerIdentity ?? surfaceKey}:bottom:active`,
      ),
    [composer.composerIdentity, surfaceKey],
  );
  const queuedComposerHostIdentity = useMemo(
    () =>
      queuedComposerIdentity
        ? createPluginComposerHostIdentity(
            `queued-message:${queuedComposerIdentity.ownerThreadId}:${queuedComposerIdentity.queuedMessageId}:${queuedComposerIdentity.editSessionId}:active`,
          )
        : null,
    [queuedComposerIdentity],
  );
  const activeBottomComposerIdentityRef = useRef<string | null>(null);
  const activeQueuedComposerIdentityRef = useRef<string | null>(null);
  const currentPromptDraftRef = useRef(currentPromptDraft);
  const committedInlineEditRef = useRef(inlineEditingQueuedMessage);
  useLayoutEffect(() => {
    currentPromptDraftRef.current = currentPromptDraft;
    committedInlineEditRef.current = inlineEditingQueuedMessage;
  }, [currentPromptDraft, inlineEditingQueuedMessage]);
  useLayoutEffect(() => {
    activeBottomComposerIdentityRef.current = bottomComposerHostIdentity;
    return () => {
      if (
        activeBottomComposerIdentityRef.current === bottomComposerHostIdentity
      ) {
        activeBottomComposerIdentityRef.current = null;
      }
    };
  }, [bottomComposerHostIdentity]);
  useLayoutEffect(() => {
    activeQueuedComposerIdentityRef.current =
      queuedComposerHostIdentity ?? null;
    return () => {
      if (
        activeQueuedComposerIdentityRef.current === queuedComposerHostIdentity
      ) {
        activeQueuedComposerIdentityRef.current = null;
      }
    };
  }, [queuedComposerHostIdentity]);
  const subscribeBottomDraft = useComposerHostDraftNotifier(currentPromptDraft);
  const subscribeQueuedDraft = useComposerHostDraftNotifier(
    inlineEditingQueuedMessage?.draft ?? null,
  );
  const setStoredPromptDraft = promptDraft.setDraft;
  const getStoredPromptDraft = promptDraft.getCurrent;
  const bottomPluginComposerHost = useMemo<PluginComposerHost | null>(() => {
    if (bottomScope === null) return null;
    const identity = bottomComposerHostIdentity;
    const initialDraft = currentPromptDraftRef.current;
    return {
      scope: bottomScope,
      textEffectKey: identity,
      // The store, not the last render: typing reaches React only after paint.
      getCurrent: () =>
        activeBottomComposerIdentityRef.current === identity
          ? getStoredPromptDraft()
          : initialDraft,
      subscribeDraft: subscribeBottomDraft,
      setDraft: (draft) => {
        if (activeBottomComposerIdentityRef.current === identity) {
          setStoredPromptDraft(draft);
        }
      },
      focus: () => {
        if (activeBottomComposerIdentityRef.current === identity) {
          setComposerFocusNonce((nonce) => nonce + 1);
        }
      },
    };
  }, [
    bottomComposerHostIdentity,
    bottomScope,
    getStoredPromptDraft,
    setStoredPromptDraft,
    subscribeBottomDraft,
  ]);
  const queuedPluginComposerHost = useMemo<PluginComposerHost | null>(() => {
    if (
      queuedComposerIdentity === null ||
      queuedComposerHostIdentity === null
    ) {
      return null;
    }
    const identity = queuedComposerHostIdentity;
    const initialDraft = inlineEditingQueuedMessageRef.current?.draft ?? {
      attachments: [],
      mentions: [],
      text: "",
    };
    const queuedEdit = queuedComposerIdentity;
    const isCurrentQueuedEdit = (
      current: typeof inlineEditingQueuedMessageRef.current,
    ): current is NonNullable<typeof current> =>
      queuedEdit !== null &&
      current?.editSessionId === queuedEdit.editSessionId &&
      current.ownerThreadId === queuedEdit.ownerThreadId &&
      current.queuedMessageId === queuedEdit.queuedMessageId;
    return {
      scope: {
        kind: "queued-message",
        threadId: queuedEdit.ownerThreadId,
        queuedMessageId: queuedEdit.queuedMessageId,
      },
      textEffectKey: identity,
      getCurrent: () => {
        if (activeQueuedComposerIdentityRef.current !== identity) {
          return initialDraft;
        }
        const currentQueuedEdit = committedInlineEditRef.current;
        return isCurrentQueuedEdit(currentQueuedEdit)
          ? currentQueuedEdit.draft
          : initialDraft;
      },
      subscribeDraft: subscribeQueuedDraft,
      setDraft: (draft) => {
        if (activeQueuedComposerIdentityRef.current !== identity) {
          return;
        }
        updateInlineQueuedMessage((current) =>
          isCurrentQueuedEdit(current) ? { ...current, draft } : current,
        );
      },
      focus: () => {
        if (activeQueuedComposerIdentityRef.current === identity) {
          setInlineComposerFocusNonce((nonce) => nonce + 1);
        }
      },
    };
  }, [
    inlineEditingQueuedMessageRef,
    queuedComposerIdentity,
    queuedComposerHostIdentity,
    subscribeQueuedDraft,
    updateInlineQueuedMessage,
  ]);
  const bottomComposerTextEffects = useComposerTextEffects(
    bottomPluginComposerHost?.textEffectKey ?? null,
  );
  const queuedComposerTextEffects = useComposerTextEffects(
    queuedPluginComposerHost?.textEffectKey ?? null,
  );

  const composerPlaceholder = isStopRequested
    ? "Stopping thread..."
    : isProvisioning
      ? "Provisioning thread..."
      : "Reply…";

  const bottomComposerConfig = useMemo<FollowUpComposerProps>(
    () => ({
      history: {
        currentDraft: currentPromptDraft,
        entries: [],
        onSelectEntry: promptDraft.setDraft,
      } satisfies HistoryConfig,
      isFollowUpSubmitting: isTurnSubmitting,
      message: currentPromptDraft.text,
      mentionRanges: currentPromptDraft.mentions,
      onChangeMessage: promptDraft.setTextAndMentions,
      onModifierSubmit: handleModifierSubmit,
      onSubmit: handleSubmit,
      compactPromptPlaceholder: composerPlaceholder,
      promptPlaceholder: composerPlaceholder,
      canModifierSubmit: canSubmitModifierShortcut,
      steerActiveThreadOnEnter,
      submitMode,
      threadRuntimeDisplayStatus: displayStatus,
    }),
    [
      canSubmitModifierShortcut,
      composerPlaceholder,
      currentPromptDraft,
      displayStatus,
      handleModifierSubmit,
      handleSubmit,
      isTurnSubmitting,
      promptDraft.setDraft,
      promptDraft.setTextAndMentions,
      steerActiveThreadOnEnter,
      submitMode,
    ],
  );
  const inlineComposerConfig = useMemo<FollowUpComposerProps | null>(
    () =>
      inlineEditingQueuedMessage
        ? {
            history: {
              currentDraft: activeComposerDraft,
              entries: [],
              onSelectEntry: setActiveComposerDraft,
            } satisfies HistoryConfig,
            isFollowUpSubmitting: isUpdateQueuedMessagePending,
            message: activeComposerDraft.text,
            mentionRanges: activeComposerDraft.mentions,
            onChangeMessage: handleChangeMessage,
            onModifierSubmit: handleInlineComposerSubmit,
            onSubmit: handleInlineComposerSubmit,
            compactPromptPlaceholder: composerPlaceholder,
            promptPlaceholder: composerPlaceholder,
            canModifierSubmit:
              activeComposerDraftInput.length > 0 &&
              !isUpdateQueuedMessagePending,
            steerActiveThreadOnEnter: false,
            submitMode: { kind: "ready" },
            threadRuntimeDisplayStatus: displayStatus,
          }
        : null,
    [
      activeComposerDraft,
      activeComposerDraftInput.length,
      composerPlaceholder,
      displayStatus,
      handleChangeMessage,
      handleInlineComposerSubmit,
      inlineEditingQueuedMessage,
      isUpdateQueuedMessagePending,
      setActiveComposerDraft,
    ],
  );

  const bottomAttachmentsConfig = useMemo<AttachmentsConfig>(
    () => ({
      items: currentPromptDraft.attachments,
      projectId,
      isAttaching: isAttachingBottomFiles,
      failures: bottomAttachmentFailures,
      onDismissFailure: dismissBottomAttachmentFailures,
      onAttachFiles: handleAttachBottomFiles,
      onRemove: promptDraft.removeAttachment,
    }),
    [
      bottomAttachmentFailures,
      dismissBottomAttachmentFailures,
      currentPromptDraft.attachments,
      handleAttachBottomFiles,
      isAttachingBottomFiles,
      projectId,
      promptDraft.removeAttachment,
    ],
  );
  const inlineAttachmentsConfig = useMemo<AttachmentsConfig>(
    () => ({
      items: activeComposerDraft.attachments,
      projectId,
      isAttaching: isAttachingInlineFiles,
      failures: inlineAttachmentFailures,
      onDismissFailure: dismissInlineAttachmentFailures,
      onAttachFiles: handleAttachInlineFiles,
      onRemove: removeActiveComposerAttachment,
    }),
    [
      activeComposerDraft.attachments,
      inlineAttachmentFailures,
      dismissInlineAttachmentFailures,
      handleAttachInlineFiles,
      isAttachingInlineFiles,
      projectId,
      removeActiveComposerAttachment,
    ],
  );

  const bottomExecutionConfig = useMemo(
    () => ({
      providerRouting: executionOptionsRouting,
      disabled: isExecutionUpdatePending || Boolean(pendingModel),
      onSelectModel: handleSelectModel,
      selectModel: ({
        providerId: shortcutProviderId,
        model,
      }: {
        providerId: string;
        model: string;
      }) => saveModel(model, shortcutProviderId),
      provider: {
        options: providerOptions,
        selectedId: pendingSwitch?.providerId ?? selectedProviderId,
        hasMultiple: hasMultipleProviders,
      },
      model: {
        active: selectedExecutionModel ? { model: selectedExecutionModel } : null,
        selected: selectedModel,
        options: modelOptions,
        moreOptions: moreModelOptions,
        loadError: modelLoadError,
        isLoading: isLoadingModels,
        loadFailed: modelLoadFailed,
        onChange: (model: string) => {
          void saveModel(model).catch(() => {});
        },
      },
      serviceTier: {
        value: serviceTier,
        onChange: setServiceTier,
        supported: supportsServiceTier,
        supportByProvider: serviceTierSupportByProvider,
        fastLabel: serviceTierFastLabel,
        ultraFast,
      },
      reasoning: {
        value: followUpReasoningLevel,
        options: reasoningOptions,
        onChange: handleReasoningChange,
      },
    }),
    [
      executionOptionsRouting,
      followUpReasoningLevel,
      handleReasoningChange,
      handleSelectModel,
      hasMultipleProviders,
      isExecutionUpdatePending,
      isLoadingModels,
      modelLoadFailed,
      modelLoadError,
      modelOptions,
      moreModelOptions,
      pendingModel,
      pendingSwitch?.providerId,
      providerOptions,
      reasoningOptions,
      saveModel,
      selectedExecutionModel,
      selectedModel,
      selectedProviderId,
      serviceTier,
      serviceTierFastLabel,
      serviceTierSupportByProvider,
      setServiceTier,
      supportsServiceTier,
      ultraFast,
    ],
  );
  const inlineExecutionConfig = useMemo<ExecutionControlsProps | null>(() => {
    if (!inlineEditingQueuedMessage) return null;
    const {
      onSelectModel: _onSelectModel,
      selectModel: _selectModel,
      ...lockedExecution
    } = bottomExecutionConfig;
    return {
      ...lockedExecution,
      model: {
        ...bottomExecutionConfig.model,
        active: { model: inlineEditingQueuedMessage.model },
        selected: inlineEditingQueuedMessage.model,
      },
      serviceTier: {
        value: inlineEditingQueuedMessage.serviceTier,
        onChange: setServiceTier,
        supported: supportsServiceTier,
        supportByProvider: serviceTierSupportByProvider,
        fastLabel: serviceTierFastLabel,
        ultraFast,
      },
      reasoning: {
        ...bottomExecutionConfig.reasoning,
        value: inlineEditingQueuedMessage.reasoningLevel,
      },
    };
  }, [
    bottomExecutionConfig,
    inlineEditingQueuedMessage,
    serviceTierFastLabel,
    serviceTierSupportByProvider,
    setServiceTier,
    supportsServiceTier,
    ultraFast,
  ]);

  const bottomPermissionConfig = useMemo<ExecutionPermissionConfig>(
    () =>
      composer.permissionPolicy === "snapshot"
        ? {
            value: snapshotPermissionMode,
            options: permissionModeOptions,
            onChange: () => {},
            supported: supportsPermissionModeSelection,
          }
        : {
            value: permissionMode,
            options: permissionModeOptions,
            onChange: setPermissionMode,
            supported: supportsPermissionModeSelection,
          },
    [
      composer.permissionPolicy,
      permissionMode,
      permissionModeOptions,
      setPermissionMode,
      snapshotPermissionMode,
      supportsPermissionModeSelection,
    ],
  );
  const inlinePermissionConfig = useMemo<ExecutionPermissionConfig | null>(
    () =>
      inlineEditingQueuedMessage
        ? {
            ...bottomPermissionConfig,
            value: inlineEditingQueuedMessage.permissionMode,
          }
        : null,
    [bottomPermissionConfig, inlineEditingQueuedMessage],
  );

  const inlineEditor = useMemo<QueuedMessageInlineEditor | undefined>(() => {
    if (
      !inlineEditingQueuedMessage ||
      !inlineComposerConfig ||
      !inlineExecutionConfig ||
      !inlinePermissionConfig
    ) {
      return undefined;
    }
    return {
      queuedMessageId: inlineEditingQueuedMessage.queuedMessageId,
      queuedMessageIndex: inlineEditingQueuedMessage.queuedMessageIndex,
      onDismiss: dismissInlineQueuedMessageEditor,
      content: (
        <PromptDraftContextsContext.Provider
          value={activeComposerDraft.contexts}
        >
          <FollowUpPromptBox
            attachments={inlineAttachmentsConfig}
            stack={null}
            composer={inlineComposerConfig}
            pluginComposerHost={queuedPluginComposerHost}
            pluginComposerScope={queuedPluginComposerHost?.scope ?? null}
            textEffects={queuedComposerTextEffects}
            environmentSummary={null}
            contextWindowUsage={null}
            execution={inlineExecutionConfig}
            executionReadOnly
            permission={inlinePermissionConfig}
            permissionReadOnly
            permissionInToolbar
            typeahead={typeaheadConfig}
            promptActions={promptActions}
            collapseResetKey={`${surfaceKey}:queued-message:${inlineEditingQueuedMessage.queuedMessageId}`}
            focusEndKey={`${inlineEditingQueuedMessage.editSessionId}:${inlineComposerFocusNonce}`}
            isPrimaryComposer={false}
            showScrollToBottomButton={false}
          />
        </PromptDraftContextsContext.Provider>
      ),
    };
  }, [
    activeComposerDraft.contexts,
    dismissInlineQueuedMessageEditor,
    inlineAttachmentsConfig,
    inlineComposerConfig,
    inlineComposerFocusNonce,
    inlineEditingQueuedMessage,
    inlineExecutionConfig,
    inlinePermissionConfig,
    promptActions,
    queuedComposerTextEffects,
    queuedPluginComposerHost,
    surfaceKey,
    typeaheadConfig,
  ]);

  const queuedMessagesStack = useMemo(
    () =>
      queuedMessages.length > 0 && !pendingInteractionOccupiesComposer ? (
        <QueuedMessagesList
          attachedToComposer
          queuedMessages={queuedMessages}
          resolveMentionLink={resolveMentionLink}
          attachmentProjectId={projectId}
          inlineEditor={inlineEditor}
          sendAction={isProvisioning ? "steer-when-ready" : "send-now"}
          sendDisabled={queuedMessageActionPending}
          actionDisabled={queuedMessageActionPending}
          processingMessageId={processingQueuedMessage?.id ?? null}
          processingAction={processingQueuedMessage?.action ?? null}
          onSend={handleSendQueuedMessage}
          onReorder={handleReorderQueuedMessage}
          onEdit={beginEditQueuedMessage}
          onDelete={handleDeleteQueuedMessage}
        />
      ) : null,
    [
      beginEditQueuedMessage,
      handleDeleteQueuedMessage,
      handleReorderQueuedMessage,
      handleSendQueuedMessage,
      inlineEditor,
      isProvisioning,
      processingQueuedMessage?.action,
      processingQueuedMessage?.id,
      pendingInteractionOccupiesComposer,
      projectId,
      queuedMessageActionPending,
      queuedMessages,
      resolveMentionLink,
    ],
  );

  const surfaceClassName =
    surfaceTone === "sidebar" ? "bg-sidebar" : "bg-background";
  const pendingInteractionBanner = pendingInteractionsUnavailable ? (
    <PendingInteractionsQueryBanner
      state="error"
      isRetrying={pendingInteractionsQuery.isFetching}
      onRetry={() => void pendingInteractionsQuery.refetch()}
    />
  ) : pendingInteractionsInitialLoading ? (
    <PendingInteractionsQueryBanner state="loading" />
  ) : activePendingInteraction !== null &&
    activePendingInteraction.payload.kind !== "plugin" ? (
    <ThreadPendingInteractionBanner
      interaction={activePendingInteraction}
      threadId={threadId}
    />
  ) : null;
  const startError = retryCloudStart.error?.message ?? cloudState.data?.error ?? null;
  const footer = (
    <div className={cn("relative", surfaceClassName)}>
      <OverflowFade placement="above" tone={surfaceTone} />
      <div className="px-4 pb-4 pt-2">
        {isCloud && cloudState.data?.failedStart && (
          <div role="alert" aria-label="Side chat status" className="mb-2 flex min-w-0 items-center gap-2 rounded-full border border-border bg-background py-1 pl-3 pr-2 text-xs text-muted-foreground">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-destructive" />
            <span className="min-w-0 flex-1 truncate text-foreground" title={startError ?? undefined}>
              {startError ? plainError(startError) : "Side chat didn't start"}
            </span>
            <button type="button" className="shrink-0 text-foreground underline underline-offset-2 disabled:opacity-50" disabled={retryCloudStart.isPending} onClick={() => retryCloudStart.mutate()}>
              Retry
            </button>
          </div>
        )}
        <PromptDraftContextsContext.Provider value={currentPromptDraft.contexts}>
        <FollowUpPromptBox
          threadProviderId={
            isCloud ||
            (canPickLocalModel &&
              modelCatalogIsVerified &&
              selectedProviderId === threadProviderId)
              ? threadProviderId
              : undefined
          }
          cloudShortcutModels={
            isCloud
              ? shortcutHarness?.idle_set_model
                ? (shortcutHarness.models?.map(({ model }) => model) ?? [])
                : []
              : undefined
          }
          attachments={bottomAttachmentsConfig}
          stack={queuedMessagesStack}
          pendingInteraction={pendingInteractionBanner}
          composer={bottomComposerConfig}
          pluginComposerHost={bottomPluginComposerHost}
          pluginComposerScope={bottomPluginComposerHost?.scope ?? null}
          textEffects={bottomComposerTextEffects}
          environmentSummary={composer.environmentSummary}
          contextWindowUsage={contextWindowUsage}
          execution={
            isCloud
              ? {
                  ...bottomExecutionConfig,
                  provider: {
                    ...bottomExecutionConfig.provider,
                    selectedId: activeCloudProviderId,
                    options: cloudProviderOptions,
                    hasMultiple: cloudProviderOptions.length > 1,
                  },
                  model: {
                    ...bottomExecutionConfig.model,
                    active: cloudModel ? { model: cloudModel } : null,
                    isLoading: !cloudModel,
                    options: cloudModelPartition.primary,
                    moreOptions: cloudModelPartition.more,
                    loadFailed: false,
                    loadError: null,
                    onChange: (model: string) =>
                      handleSelectModel({ providerId: threadProviderId, model }),
                  },
                  reasoning: {
                    ...bottomExecutionConfig.reasoning,
                    value: cloudReasoning,
                    options: cloudFollowUpReasoningOptions,
                    onChange: handleReasoningChange,
                  },
                  serviceTier: {
                    ...bottomExecutionConfig.serviceTier,
                    value: cloudFastSupported ? serviceTier : "default",
                    supported: cloudFastSupported,
                  },
                }
              : bottomExecutionConfig
          }
          permission={
            isCloud
              ? { ...bottomPermissionConfig, value: "full", supported: false }
              : bottomPermissionConfig
          }
          permissionReadOnly={composer.permissionPolicy === "snapshot"}
          typeahead={typeaheadConfig}
          promptActions={promptActions}
          collapseResetKey={surfaceKey}
          focusEndKey={`${composerFocusNonce}:${composer.focusRequestKey ?? ""}:${pendingInteractionsInitialLoading}`}
          isPrimaryComposer={false}
        />
        </PromptDraftContextsContext.Provider>
      </div>
    </div>
  );

  const maxWidthClassName = measure === "page" ? "max-w-[760px]" : "max-w-none";
  const timelineBody = (
    <ThreadTimelinePanelContent
      isTurnSubmitting={isTurnSubmitting}
      leadingContent={leadingContent}
      consumerMessageActions={consumerMessageActions}
      includePluginMessageActions={includePluginMessageActions}
      onOpenLink={onOpenLink}
      onOpenLocalFileLink={onOpenLocalFileLink}
      onMessageAddToChat={handleAddToChat}
      onSelectionAddToChat={handleAddToChat}
      projectId={projectId}
      resolveMentionLink={resolveMentionLink}
      threadId={threadId}
      workspaceRootPath={workspaceRootPath}
    />
  );

  if (layout === "document") {
    return (
      <div
        key={surfaceKey}
        data-thread-window=""
        data-surface-tone={surfaceTone}
        className={cn("flex min-w-0 flex-col", surfaceClassName)}
      >
        <div
          className={cn(
            "mx-auto flex w-full min-w-0 flex-col",
            measure === "page" ? "px-4 pb-3 pt-3" : "px-2 pb-3 pt-3",
            maxWidthClassName,
          )}
        >
          {timelineBody}
        </div>
        <div className="sticky bottom-0 z-20">{footer}</div>
      </div>
    );
  }

  return (
    <div
      data-thread-window=""
      data-surface-tone={surfaceTone}
      className="flex min-h-0 flex-1 flex-col"
    >
      <BottomAnchoredScrollBody
        key={surfaceKey}
        scrollAreaClassName={surfaceClassName}
        contentClassName={
          measure === "page" ? "!pb-3 !pt-3" : "!px-2 !pb-3 !pt-3"
        }
        maxWidthClassName={maxWidthClassName}
        footer={footer}
        scrollAnchorThreadId={threadId}
      >
        {timelineBody}
      </BottomAnchoredScrollBody>
    </div>
  );
}
