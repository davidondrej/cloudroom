// The prompt box: wires the editor, the `@` and `/` menus, history, voice and attachments into one form.
// Each of those lives in its own file next to this one; this file only connects them and lays them out.
import { usePointerCoarse } from "@cloudroom/shared-ui/hooks/use-pointer-coarse";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  blurActiveKeyboardInputWithin,
  OverlayCloseFocusContext,
} from "@cloudroom/shared-ui/overlay-trigger";
import type { ComposerView } from "@get-bb/plugin-sdk";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import {
  useAppCommandHandler,
  useAppCommandKeyDispatch,
  useAppCommandShortcut,
} from "@/components/commands/AppCommandProvider";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import { useResolvedComposerEditor } from "@/components/plugin/composer-slot-hooks";
import {
  composerScopeIdentity,
  PluginComposerViewProvider,
  useOptionalPluginComposerView,
  usePluginComposerHost,
  usePluginComposerViewModel,
} from "@/components/plugin/plugin-composer-host";
import { flushPromptDraftNotifies } from "@/hooks/usePromptDraftStorage";
import type { ComposerTextEffectSource } from "@/lib/composer-text-effects";
import { useComposerInputLock } from "@/lib/plugin-sdk-hooks";
import { AttachmentPreview, useUploadingImageCount } from "./AttachmentPreview";
import { blurPromptEditor, ComposerEditorSlot } from "./ComposerEditorSlot";
import type {
  PromptDecorationSource,
  PromptDraftObserver,
} from "./editor/prompt-decoration-extension";
import { MentionMenu } from "./mentions/MentionMenu";
import {
  DEFAULT_COMPOSER_SCOPE,
  type PromptBoxProps,
} from "./prompt-box-types";
import { handlePromptKey } from "./prompt-keys";
import { ComposerPlusMenuSlot } from "./PromptBoxActionsMenu";
import {
  PromptActionRow,
  PromptAttachmentFailures,
  PromptCollapseButton,
  PromptDropOverlay,
  usePromptFileDrop,
  usePromptHeightAnimation,
  usePromptVoiceAction,
  useReportTypeaheadLayout,
  type PromptSubmitState,
} from "./PromptBoxView";
import {
  focusEditorAtEnd,
  useLatest,
  usePromptDocument,
  usePromptEditor,
} from "./usePromptEditor";
import { usePromptHistory } from "./usePromptHistory";
import { usePromptTypeahead } from "./usePromptTypeahead";

export * from "./prompt-box-types";
export { suppressPromptEditorAnchorActivation } from "./usePromptEditor";

const DEFAULT_MIN_HEIGHT_PX = 68;
const UPLOADING_TITLE = "Uploading attachments...";
// A press on any of these is for that control. Anywhere else in the box focuses the editor.
const OWN_CONTROLS_SELECTOR =
  "a[href], button, input, select, textarea, [contenteditable='true'], [data-prompt-mention='true'], [role='button'], [role='link'], [role='menuitem'], [role='option']";

/** Turns what plugins registered for this composer into what the editor paints and notifies. */
function pluginTextEffects(
  registered: ReturnType<typeof useResolvedComposerEditor>,
  wholeDraftEffects: readonly ComposerTextEffectSource[] | undefined,
  getView: () => ComposerView,
): {
  sources: PromptDecorationSource[];
  observers: PromptDraftObserver[];
} {
  const sources: PromptDecorationSource[] = registered.effects.map((entry) => ({
    id: `${entry.pluginId}/${entry.customizationId}`,
    generation: entry.generation,
    pluginId: entry.pluginId,
    effects: entry.effects,
  }));
  for (const { pluginId, order, effect } of wholeDraftEffects ?? []) {
    if (effect.className.length === 0) continue;
    sources.push({
      id: `plugin-imperative:${pluginId}:${order}`,
      generation: order,
      pluginId,
      effects: [
        {
          id: "whole-draft",
          className: effect.className,
          match: (text) =>
            text.length > 0 ? [{ from: 0, to: text.length }] : [],
        },
      ],
    });
  }
  const observers = registered.observers.map((entry) => ({
    id: `${entry.pluginId}/${entry.customizationId}`,
    getView,
    onDraftChange: entry.onDraftChange,
  }));
  return { sources, observers };
}

/** Confirms a send on touch screens: the send control pops once. It runs on the
 *  group, which stays mounted while Send swaps to Stop or the mic. */
function popSentControl(form: HTMLFormElement | null): void {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  form
    ?.querySelector("[data-promptbox-submit-group]")
    ?.animate?.([{ scale: 1 }, { scale: 1.14 }, { scale: 1 }], {
      duration: 260,
      easing: "ease-out",
    });
}

export function PromptBoxInternal({
  id,
  value,
  mentionRanges,
  onChange,
  onSubmit,
  onEscape,
  onEnterKey,
  blurOnPointerSubmit = false,
  placeholder = "Ask anything. @ to mention files, folders, or sections",
  placeholderHint,
  ghostText,
  onGhostText,
  autoFocus = true,
  allowSoftKeyboardAutoFocus = false,
  textEffects,
  onComposerLayoutChange,
  header,
  modeHeader,
  footerStart,
  submission = {},
  minHeight = DEFAULT_MIN_HEIGHT_PX,
  typeahead: typeaheadConfig,
  reasoning,
  fastMode,
  modelShortcuts,
  locationCommands,
  mentionMenuPlacement,
  attachments: attachmentConfig = {},
  promptActions,
  suppressPluginComposerCustomizations = false,
  editorLayout = "thread",
  onCollapse,
  compact,
  containerCompactPlaceholder,
  heightAnimationKey,
  history: historyConfig,
  voice,
  promptBoxRef,
  focusEndKey,
}: PromptBoxProps) {
  const {
    isSubmitting = false,
    isRunning = false,
    onStop,
    onModifierSubmit,
    onHardQueueSubmit,
  } = submission;
  const {
    isAttaching = false,
    onAttachFiles,
    projectId: attachmentProjectId,
  } = attachmentConfig;
  const attachments = attachmentConfig.items ?? [];
  const isPointerCoarse = usePointerCoarse();
  const focusShortcut = useAppCommandShortcut("composer.focus");
  const runAppShortcut = useAppCommandKeyDispatch();
  const formRef = useRef<HTMLFormElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [expandedImageIndex, setExpandedImageIndex] = useState<number | null>(
    null,
  );
  const { uploadingImageCount, trackUpload } =
    useUploadingImageCount(attachments);

  // Layout: voice input takes over the whole box, so it is never compact while recording.
  const voiceAction = usePromptVoiceAction(voice);
  const isVoiceActive = voiceAction.isActive;
  const isCompact = compact?.isCompact === true && !isVoiceActive;
  const shownGhostText = isCompact ? null : (ghostText ?? null);
  const shownPlaceholder = isCompact
    ? (compact.placeholder ?? placeholder)
    : (shownGhostText ?? placeholder);
  const layout = isCompact ? "compact" : "expanded";
  const captureHeight = usePromptHeightAnimation(
    formRef,
    heightAnimationKey,
    isCompact,
  );
  useEffect(() => {
    onComposerLayoutChange?.(layout);
  }, [layout, onComposerLayoutChange]);
  useEffect(() => {
    if (shownGhostText) onGhostText?.("shown");
  }, [onGhostText, shownGhostText]);
  // CSS shows this placeholder when the container, not the prop, makes the box narrow.
  useLayoutEffect(() => {
    const style = formRef.current?.style;
    const name = "--promptbox-container-compact-placeholder";
    if (containerCompactPlaceholder === undefined) style?.removeProperty(name);
    else style?.setProperty(name, JSON.stringify(containerCompactPlaceholder));
  }, [containerCompactPlaceholder]);

  // Plugins: they see this composer as a "view" and may paint text or lock input.
  const pluginHost = usePluginComposerHost();
  const inputLocked = useComposerInputLock(pluginHost?.textEffectKey ?? null);
  const ownView = usePluginComposerViewModel({
    scope: pluginHost?.scope ?? DEFAULT_COMPOSER_SCOPE,
    layout,
    text: value,
    attachmentCount: attachments.length,
    isRunning,
    isSubmitting,
  });
  const composerView = useOptionalPluginComposerView() ?? ownView;
  const latestView = useLatest(composerView);
  const registered = useResolvedComposerEditor(
    suppressPluginComposerCustomizations ? null : composerView.scope.kind,
  );
  const decorations = useMemo(
    () => pluginTextEffects(registered, textEffects, () => latestView.current),
    [latestView, registered, textEffects],
  );

  const doc = usePromptDocument(value, mentionRanges, onChange);

  // Submitting.
  const hasInput = value.trim().length > 0 || attachments.length > 0;
  const isBlocked =
    isAttaching ||
    isSubmitting ||
    submission.disabled === true ||
    isVoiceActive;
  const canSubmit = hasInput && !isBlocked;
  const blurAfterSubmit = useRef(false);
  const submit = () => {
    const blur = blurAfterSubmit.current;
    blurAfterSubmit.current = false;
    if (!canSubmit) return;
    onSubmit();
    if (isPointerCoarse) popSentControl(formRef.current);
    if (blur) blurPromptEditor(doc.ref.current);
  };
  // A submit asked for mid-keystroke waits one render, so it sends the newest draft.
  const latestSubmit = useLatest(submit);
  const [submitRequested, setSubmitRequested] = useState(false);
  const submitAfterRender = useCallback(() => {
    flushPromptDraftNotifies();
    setSubmitRequested(true);
  }, []);
  useEffect(() => {
    if (!submitRequested) return;
    setSubmitRequested(false);
    latestSubmit.current();
  }, [latestSubmit, submitRequested]);

  // The editor's features.
  const typeahead = usePromptTypeahead({
    editor: doc,
    typeahead: typeaheadConfig,
    promptActions,
    hidden: isVoiceActive,
    reasoning,
    fastMode,
    modelShortcuts,
    locationCommands,
  });
  const history = usePromptHistory(historyConfig, (draft) => {
    historyConfig?.onSelectEntry(draft);
    requestAnimationFrame(() => {
      const current = doc.ref.current;
      if (!current || current.isDestroyed) return;
      focusEditorAtEnd(current);
      typeahead.closeAt(current);
      doc.reveal();
    });
  });
  /** Puts the suggested prompt into the editor: Tab on a keyboard, the hint chip on touch. */
  const acceptGhostText = () => {
    const current = doc.ref.current;
    if (!shownGhostText || !current || current.isDestroyed) return;
    current.chain().focus().insertContent(shownGhostText).run();
    onGhostText?.("accepted");
  };
  const { editor, focus, focusEnd, insertText, getTextBeforeCursor } =
    usePromptEditor(doc, {
      id,
      text: value,
      mentions: mentionRanges,
      placeholder: shownPlaceholder,
      hasModifierSubmit: onModifierSubmit !== undefined,
      editable: !inputLocked && !isVoiceActive,
      isPointerCoarse,
      autoFocus,
      allowSoftKeyboardAutoFocus,
      focusScopeKey: historyConfig?.resetKey,
      focusEndKey,
      minHeight,
      promptActions,
      decorations,
      decorationScopeKey: composerScopeIdentity(composerView.scope),
      onPasteFiles: onAttachFiles
        ? (files) => trackUpload(files, onAttachFiles(files))
        : undefined,
      onFocus: typeaheadConfig.command.onEditorFocus,
      onBlur: typeahead.closeOnBlur,
      onCaretMove: typeahead.sync,
      onEdit: typeahead.trackEdit,
      onValueReplaced: (replaced) => {
        typeahead.forget();
        typeahead.sync(replaced);
      },
      onKeyDown: (event, isIPadHardwareEnter) =>
        handlePromptKey({
          event,
          editor: doc.ref.current,
          enterSubmits: !isPointerCoarse || isIPadHardwareEnter,
          typeahead,
          history,
          ghostText: shownGhostText,
          acceptGhostText,
          onEscape,
          onEnterKey,
          runAppShortcut,
          submit,
          submitAfterRender,
          submitWithModifier: onModifierSubmit
            ? () => {
                if (!isBlocked) onModifierSubmit();
              }
            : undefined,
        }),
    });
  useReportTypeaheadLayout(menuRef, typeahead.isOpen);
  useAppCommandHandler(
    "composer.hardQueue",
    ({ target }) => {
      const isInEditor =
        target instanceof Node && doc.ref.current?.view.dom.contains(target);
      if (!isInEditor) return false;
      if (canSubmit) onHardQueueSubmit?.();
      return true;
    },
    0,
    onHardQueueSubmit !== undefined,
  );

  const attachFiles = useCallback(
    (files: File[]) => {
      if (!onAttachFiles || files.length === 0) return;
      trackUpload(files, onAttachFiles(files));
      focusEnd();
    },
    [focusEnd, onAttachFiles, trackUpload],
  );
  const fileDrop = usePromptFileDrop(onAttachFiles ? attachFiles : undefined);

  const playVoiceCompletionTransition = voiceAction.playCompletion;
  useImperativeHandle(
    promptBoxRef,
    () => ({
      attachFiles,
      captureHeightForLayoutChange: captureHeight,
      focus,
      focusEnd,
      insertTextAtCursor: insertText,
      submit: submitAfterRender,
      getTextBeforeCursor,
      playVoiceCompletionTransition,
    }),
    [
      attachFiles,
      captureHeight,
      focus,
      focusEnd,
      getTextBeforeCursor,
      insertText,
      playVoiceCompletionTransition,
      submitAfterRender,
    ],
  );

  // Which button sits in the primary spot: stop while running with nothing typed,
  // the mic on touch with nothing typed, send otherwise.
  const showStop =
    isRunning &&
    onStop !== undefined &&
    !hasInput &&
    !isAttaching &&
    !isVoiceActive;
  const canStartVoice =
    voice !== undefined && voice.isSupported && !isSubmitting;
  const isVoicePrimary =
    isPointerCoarse && !isAttaching && !hasInput && canStartVoice;
  const hasSecondaryMic = !isVoicePrimary || showStop;
  const showCompactMic = isCompact && canStartVoice && hasSecondaryMic;
  const disabledReason = isAttaching
    ? UPLOADING_TITLE
    : submission.disabledReason;
  const submitState: PromptSubmitState = {
    canSubmit,
    icon: submission.icon,
    label: submission.label,
    title: isAttaching
      ? UPLOADING_TITLE
      : (!canSubmit && submission.disabledReason) ||
        (submission.title ?? "Submit (Enter)"),
    disabledReason: canSubmit ? undefined : disabledReason,
    isBusy: isSubmitting || isAttaching,
    // Pressing send must not take focus from the editor (or open the touch keyboard).
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      const current = doc.ref.current;
      const editorHasFocus =
        current !== null &&
        !current.isDestroyed &&
        current.view.dom.contains(current.view.dom.ownerDocument.activeElement);
      if (isPointerCoarse || editorHasFocus) event.preventDefault();
    },
    onClick: (event) => {
      blurAfterSubmit.current = blurOnPointerSubmit && event.detail > 0;
    },
    onTouchSubmit: () => {
      blurAfterSubmit.current = blurOnPointerSubmit;
      submit();
    },
  };

  const focusEditorFromChrome = (event: MouseEvent<HTMLFormElement>) => {
    const current = doc.ref.current;
    const isOwnControl =
      !(event.target instanceof Element) ||
      event.target.closest(OWN_CONTROLS_SELECTOR) !== null;
    if (isOwnControl || !current || current.isDestroyed) return;
    event.preventDefault();
    focusEditorAtEnd(current);
    doc.reveal();
  };
  const startVoice = () => {
    const current = doc.ref.current;
    // On touch, close the keyboard first so it does not cover the recording bar.
    if (isPointerCoarse && current && !current.isDestroyed) {
      blurActiveKeyboardInputWithin(current.view.dom);
    }
    void voice?.start();
  };
  const collapse = () => {
    captureHeight();
    blurPromptEditor(doc.ref.current);
    onCollapse?.();
  };

  const coveredByVoice = isVoiceActive ? true : undefined;
  const attachmentPreviewProps = {
    attachments,
    attachmentProjectId,
    expandedImageIndex,
    onExpandedImageIndexChange: setExpandedImageIndex,
    onRemoveAttachment: attachmentConfig.onRemove,
  };

  return (
    <OverlayCloseFocusContext.Provider value={focus}>
      <form
        ref={formRef}
        data-promptbox=""
        data-promptbox-compact={isCompact ? "" : undefined}
        data-promptbox-voice-active={isVoiceActive ? "" : undefined}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onMouseDown={focusEditorFromChrome}
        {...fileDrop.handlers}
        className={cn(
          "group/promptbox relative w-full rounded-xl bg-composer shadow-message",
          // Mobile: soft, rounded iOS-style card.
          "max-md:pointer-coarse:rounded-[26px] max-md:pointer-coarse:border max-md:pointer-coarse:border-foreground/15 max-md:pointer-coarse:shadow-[0_6px_24px_-8px_rgb(0_0_0/0.18)]",
          isCompact && "overflow-hidden",
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            attachFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <PromptDropOverlay
          direction={fileDrop.direction}
          isCompact={isCompact}
        />
        {modeHeader ? (
          <div inert={coveredByVoice} className="px-3 pt-1.5">
            {modeHeader}
          </div>
        ) : null}
        <div
          data-promptbox-layout=""
          className={cn(
            "grid transition-[grid-template-rows] duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
            isCompact && "relative",
          )}
          style={{ gridTemplateRows: "1fr" }}
        >
          <div
            data-promptbox-main=""
            className={cn(
              "min-h-0 overflow-hidden transition-opacity duration-[180ms] motion-reduce:transition-none",
              isCompact && "relative flex h-12 items-center",
              isVoiceActive && "pointer-events-none",
            )}
          >
            {header && !isCompact ? (
              <div
                data-promptbox-expanded-only=""
                inert={coveredByVoice}
                className="pl-4 pr-14 pt-3"
              >
                {header}
              </div>
            ) : null}
            {isCompact ? (
              <AttachmentPreview compact {...attachmentPreviewProps} />
            ) : null}
            <div
              data-promptbox-input-region=""
              className={cn(
                "relative",
                isCompact && "min-w-0 flex-1",
                showCompactMic && "pr-9",
              )}
            >
              {isCompact ? null : (
                <div data-promptbox-expanded-only="">
                  <AppCommandShortcutHint
                    shortcut={focusShortcut}
                    className={cn(
                      "absolute top-2 z-20 group-focus-within/promptbox:hidden",
                      onCollapse ? "right-10" : "right-2",
                    )}
                  />
                </div>
              )}
              {onCollapse && !isCompact ? (
                <div
                  data-promptbox-expanded-only=""
                  data-promptbox-standard-actions=""
                  inert={coveredByVoice}
                  className="absolute right-[13px] top-2 z-20 flex items-center"
                >
                  <PromptCollapseButton onCollapse={collapse} />
                </div>
              ) : null}
              <ComposerEditorSlot
                editor={editor}
                scrollContainerRef={doc.scrollContainerRef}
                inputLocked={inputLocked}
                isCompactLayout={isCompact}
                placeholder={shownPlaceholder}
                placeholderHint={
                  isCompact
                    ? undefined
                    : shownGhostText
                      ? isPointerCoarse
                        ? "Tap to use"
                        : "Tab to accept"
                      : placeholderHint
                }
                onPlaceholderHintClick={
                  shownGhostText && isPointerCoarse
                    ? acceptGhostText
                    : undefined
                }
                minHeight={minHeight}
                layout={editorLayout}
                resolveMentionLink={typeaheadConfig.mention.resolveLink}
              />
            </div>

            {typeahead.isOpen ? (
              <div
                ref={menuRef}
                data-promptbox-typeahead-menu=""
                className={cn(
                  "absolute -left-px -right-px z-20",
                  mentionMenuPlacement === "top"
                    ? "bottom-full mb-2"
                    : "top-full mt-2",
                )}
              >
                <MentionMenu
                  state={typeahead.menuState}
                  selectedIndex={typeahead.selectedIndex}
                  onApply={typeahead.apply}
                  onDismiss={isPointerCoarse ? typeahead.dismiss : undefined}
                  onCommandLoadMore={typeahead.loadMore}
                />
              </div>
            ) : null}

            {isCompact ? null : (
              <div data-promptbox-expanded-only="" inert={coveredByVoice}>
                <AttachmentPreview
                  uploadingImageCount={uploadingImageCount}
                  {...attachmentPreviewProps}
                />
                <PromptAttachmentFailures
                  failures={attachmentConfig.failures ?? []}
                  onDismiss={attachmentConfig.onDismissFailure}
                />
                {attachmentConfig.error ? (
                  <div className="mx-3 mb-1 mt-1 text-xs text-destructive">
                    {attachmentConfig.error}
                  </div>
                ) : null}
              </div>
            )}

            <PluginComposerViewProvider value={composerView}>
              <PromptActionRow
                isCompact={isCompact}
                isPointerCoarse={isPointerCoarse}
                voice={voice}
                voiceAction={voiceAction}
                start={
                  <>
                    <ComposerPlusMenuSlot
                      actions={promptActions}
                      isAttaching={isAttaching}
                      onAttach={
                        onAttachFiles
                          ? () => fileInputRef.current?.click()
                          : undefined
                      }
                      onAction={typeahead.insertAction}
                      includePluginContributions={
                        !suppressPluginComposerCustomizations
                      }
                    />
                    {footerStart}
                  </>
                }
                includePluginActions={
                  !isCompact && !suppressPluginComposerCustomizations
                }
                primaryAction={
                  showStop ? "stop" : isVoicePrimary ? "voice" : "submit"
                }
                showMic={
                  (!isCompact || showCompactMic) &&
                  !isVoiceActive &&
                  hasSecondaryMic
                }
                canStartVoice={canStartVoice}
                onStartVoice={startVoice}
                onStop={onStop}
                submit={submitState}
              />
            </PluginComposerViewProvider>
          </div>
        </div>
      </form>
    </OverlayCloseFocusContext.Provider>
  );
}
