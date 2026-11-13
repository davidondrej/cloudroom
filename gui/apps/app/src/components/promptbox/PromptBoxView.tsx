// The prompt box's buttons and visual behaviours: transitions, drag and drop, press handling. No editor logic.
import { Button } from "@cloudroom/shared-ui/button";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@cloudroom/shared-ui/chrome-style-tokens";
import {
  COARSE_POINTER_PROMPT_ACTION_BUTTON_CLASS,
  COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS,
} from "@cloudroom/shared-ui/coarse-pointer-sizing";
import {
  getMediaQuerySnapshot,
  REDUCED_MOTION_QUERY,
} from "@cloudroom/shared-ui/hooks/use-media-query";
import { Icon, type IconName } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@cloudroom/shared-ui/tooltip";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ComposerActionsSlot } from "@/components/plugin/PluginComposerActions";
import { voiceUnsupportedMessage } from "@/hooks/voice-input-support";
import { PROMPT_STACK_EDGE_CARET_BUTTON_WIDTH_CLASS } from "./banner/PromptStackCard";
import type { AttachmentFailure, PromptVoiceConfig } from "./prompt-box-types";
import { QueuedEditorTypeaheadLayoutContext } from "./queued-editor-typeahead-layout";
import { VoiceRecordingBar } from "./VoiceRecordingBar";

const VOICE_TRANSITION_MS = 180;
const TAP_SLOP_PX = 10;
const COMPACT_BUTTON_CLASS =
  "size-8 p-0 transition [&_[data-icon-root]]:size-4";
// Mobile touch: bigger round icon buttons with bolder glyphs.
const MOBILE_ROUND_BUTTON_CLASS =
  "[--press-scale:0.9] max-md:pointer-coarse:size-11 max-md:pointer-coarse:rounded-full max-md:pointer-coarse:px-0 max-md:pointer-coarse:[&_[data-icon-root]]:size-5 max-md:pointer-coarse:[&_[data-icon-root]_path]:stroke-[2]";
const FADE_CLASS =
  "transition-[opacity,transform] duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none";
const FADED_OUT_CLASS = "pointer-events-none translate-y-1 opacity-0";
const FADED_IN_CLASS = "translate-y-0 opacity-100";

const prefersReducedMotion = () => getMediaQuerySnapshot(REDUCED_MOTION_QUERY);

// --- Voice bar transition -------------------------------------------------

type VoicePhase = "recording" | "transcribing";
/** "hidden" is unmounted. The other three are the bar's fade in, rest, and fade out. */
type VoiceStage = "hidden" | "entering" | "active" | "exiting";

/** Fades the voice bar over the action row while recording or transcribing. */
export function usePromptVoiceAction(voice: PromptVoiceConfig | undefined) {
  const phase: VoicePhase | null =
    voice?.state === "recording" || voice?.state === "transcribing"
      ? voice.state
      : null;
  const isActive = phase !== null;
  const [stage, setStage] = useState<VoiceStage>(
    isActive ? "active" : "hidden",
  );
  const fadeOut = useCallback(
    () => setStage((current) => (current === "hidden" ? current : "exiting")),
    [],
  );
  // The bar keeps showing its last phase while it fades out.
  const [lastPhase, setLastPhase] = useState<VoicePhase>(phase ?? "recording");
  if (phase && phase !== lastPhase) setLastPhase(phase);
  const timers = useRef({
    wasActive: isActive,
    enterFrame: null as number | null,
    unmount: undefined as number | undefined,
    done: undefined as number | undefined,
    donePromise: null as Promise<void> | null,
    resolveDone: null as (() => void) | null,
  });
  const cancelEnter = useCallback(() => {
    if (timers.current.enterFrame !== null)
      window.cancelAnimationFrame(timers.current.enterFrame);
    timers.current.enterFrame = null;
  }, [timers]);
  const settleDone = useCallback(() => {
    window.clearTimeout(timers.current.done);
    const resolve = timers.current.resolveDone;
    timers.current.donePromise = null;
    timers.current.resolveDone = null;
    resolve?.();
  }, [timers]);

  useLayoutEffect(() => {
    const wasActive = timers.current.wasActive;
    timers.current.wasActive = isActive;
    cancelEnter();
    window.clearTimeout(timers.current.unmount);
    const instant = prefersReducedMotion();
    if (isActive) {
      if (wasActive || instant) {
        setStage("active");
        return;
      }
      setStage("entering");
      timers.current.enterFrame = window.requestAnimationFrame(() => {
        timers.current.enterFrame = null;
        setStage("active");
      });
    } else if (!wasActive || instant) {
      setStage("hidden");
    } else {
      setStage("exiting");
      timers.current.unmount = window.setTimeout(
        () => setStage("hidden"),
        VOICE_TRANSITION_MS,
      );
    }
  }, [cancelEnter, isActive, timers]);

  useEffect(
    () => () => {
      cancelEnter();
      window.clearTimeout(timers.current.unmount);
      settleDone();
    },
    [cancelEnter, settleDone, timers],
  );

  const cancel = useCallback(() => {
    cancelEnter();
    fadeOut();
    voice?.cancel();
  }, [cancelEnter, fadeOut, voice]);

  // Escape cancels a recording from anywhere, before any other handler sees it.
  useEffect(() => {
    if (!isActive || !voice) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cancel, isActive, voice]);

  /** Fades the bar out and resolves when it is gone, so a send can follow the animation. */
  const playCompletion = useCallback((): Promise<void> => {
    cancelEnter();
    fadeOut();
    const nobodyWatches =
      prefersReducedMotion() ||
      (typeof document !== "undefined" &&
        document.visibilityState === "hidden");
    if (nobodyWatches) {
      settleDone();
      return Promise.resolve();
    }
    timers.current.donePromise ??= new Promise<void>((resolve) => {
      timers.current.resolveDone = resolve;
      timers.current.done = window.setTimeout(settleDone, VOICE_TRANSITION_MS);
    });
    return timers.current.donePromise;
  }, [cancelEnter, fadeOut, settleDone, timers]);

  return {
    isActive,
    stage,
    phase: phase ?? lastPhase,
    cancel,
    playCompletion,
  };
}

export type PromptVoiceAction = ReturnType<typeof usePromptVoiceAction>;

// --- Height animation -----------------------------------------------------

/**
 * Animates the box between two heights when its layout changes. The caller
 * captures the old height first; the new one is measured after React commits.
 */
export function usePromptHeightAnimation(
  boxRef: RefObject<HTMLElement | null>,
  layoutKey: string | number | undefined,
  isCompact: boolean,
) {
  const fromHeight = useRef<number | null>(null);
  useLayoutEffect(() => {
    const box = boxRef.current;
    const from = fromHeight.current;
    if (from === null || !box) return;
    fromHeight.current = null;
    if (prefersReducedMotion()) return;

    const { style } = box;
    const { transition, willChange, overflow } = style;
    style.transition = "none";
    style.height = "";
    const to = box.getBoundingClientRect().height;
    if (Math.abs(to - from) < 0.5) {
      style.transition = transition;
      return;
    }
    style.height = `${from}px`;
    box.getBoundingClientRect(); // Applies the start height before the transition begins.
    Object.assign(style, {
      overflow: "hidden",
      willChange: "height",
      transition: "height 240ms cubic-bezier(0.22, 1, 0.36, 1)",
      height: `${to}px`,
    });

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      Object.assign(style, { transition, willChange, overflow, height: "" });
      box.removeEventListener("transitionend", onTransitionEnd);
      window.clearTimeout(fallback);
    };
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.propertyName === "height") finish();
    };
    const fallback = window.setTimeout(finish, 320);
    box.addEventListener("transitionend", onTransitionEnd);
    return finish;
  }, [boxRef, isCompact, layoutKey]);

  return useCallback(() => {
    fromHeight.current = boxRef.current?.getBoundingClientRect().height ?? null;
  }, [boxRef]);
}

// --- Typeahead menu size ----------------------------------------------------

/** A queued message's inline editor makes room for the open menu, so it reports its height. */
export function useReportTypeaheadLayout(
  menuRef: RefObject<HTMLElement | null>,
  isOpen: boolean,
): void {
  const report = useContext(QueuedEditorTypeaheadLayoutContext);
  useLayoutEffect(() => {
    if (report === null) return;
    const menu = menuRef.current;
    // Braces matter: an effect must not return whatever the reporter returns.
    const reportClosed = () => {
      report({ height: 0, isOpen: false });
    };
    if (!isOpen || menu === null) {
      reportClosed();
      return;
    }
    const reportOpen = () => {
      report({ height: menu.getBoundingClientRect().height, isOpen: true });
    };
    reportOpen();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(reportOpen);
    observer?.observe(menu);
    return () => {
      observer?.disconnect();
      reportClosed();
    };
  }, [isOpen, menuRef, report]);
}

// --- File drop --------------------------------------------------------------

/** Which way the drop overlay grows: away from the nearer screen edge. */
type DropDirection = "up" | "down";

export function usePromptFileDrop(
  onFiles: ((files: File[]) => void) | undefined,
) {
  const [direction, setDirection] = useState<DropDirection | null>(null);
  return {
    direction,
    handlers: {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!onFiles) return;
        event.preventDefault();
        if (direction || !event.dataTransfer.types.includes("Files")) return;
        const nearTop = event.currentTarget.getBoundingClientRect().top < 120;
        setDirection(nearTop ? "down" : "up");
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        const stillInside = event.currentTarget.contains(
          event.relatedTarget as Node | null,
        );
        if (!stillInside) setDirection(null);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        setDirection(null);
        if (!onFiles) return;
        event.preventDefault();
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length > 0) onFiles(files);
      },
    },
  };
}

export function PromptDropOverlay({
  direction,
  isCompact,
}: {
  direction: DropDirection | null;
  isCompact: boolean;
}) {
  return (
    <div
      data-promptbox-drop-overlay=""
      aria-hidden
      className={cn(
        "absolute z-40 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-composer text-sm text-muted-foreground shadow-message transition-[top,bottom,left,right,opacity] duration-150 ease-out motion-reduce:transition-none",
        direction === null
          ? "pointer-events-none inset-0 opacity-0"
          : isCompact
            ? "inset-0"
            : direction === "up"
              ? "-inset-x-20 -top-24 bottom-0 max-md:-inset-x-2"
              : "-inset-x-20 -bottom-24 top-0 max-md:-inset-x-2",
      )}
    >
      <Icon name="Image" className="size-5" />
      Drop image here
    </div>
  );
}

// --- Attachments that failed ------------------------------------------------

export function PromptAttachmentFailures({
  failures,
  onDismiss,
}: {
  failures: readonly AttachmentFailure[];
  onDismiss: ((index: number) => void) | undefined;
}) {
  if (failures.length === 0) return null;
  return (
    <div className="mx-3 mb-1 mt-1 flex flex-wrap gap-1.5">
      {failures.map(({ name, reason }, index) => (
        <div
          key={`${name}-${index}`}
          title={`${name}: ${reason}`}
          className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 pl-2 pr-1.5 text-xs"
        >
          <Icon name="File" className="size-3.5 shrink-0 text-destructive" />
          <span className="max-w-[200px] truncate text-foreground line-through decoration-destructive/60">
            {name}
          </span>
          <span className="truncate text-destructive">{reason}</span>
          {onDismiss ? (
            <button
              type="button"
              aria-label={`Dismiss ${name}`}
              onClick={() => onDismiss(index)}
              className="inline-flex size-4 shrink-0 items-center justify-center rounded text-destructive hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:size-7"
            >
              <Icon name="X" className="size-3" />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// --- Buttons ----------------------------------------------------------------

export function PromptCollapseButton({
  onCollapse,
}: {
  onCollapse: () => void;
}) {
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onCollapse}
      aria-label="Collapse prompt box"
      className={cn(
        CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
        COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS,
        PROMPT_STACK_EDGE_CARET_BUTTON_WIDTH_CLASS,
      )}
    >
      <Icon name="ChevronDown" className="size-3.5" />
    </Button>
  );
}

/**
 * A pointer click counts only when the press began on this same button. The
 * submit, stop and mic buttons swap places, so a press that started on one
 * must not fire the one that replaced it.
 */
function useOwnPress(
  run: () => void,
  onPress?: (event: PointerEvent<HTMLButtonElement>) => void,
) {
  const pressed = useRef<HTMLButtonElement | null>(null);
  return {
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      pressed.current = event.currentTarget;
      onPress?.(event);
    },
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      const startedHere = pressed.current === event.currentTarget;
      pressed.current = null;
      // `detail` is 0 for keyboard and scripted clicks, which have no press.
      if (event.detail === 0 || startedHere) run();
    },
  };
}

export interface PromptSubmitState {
  canSubmit: boolean;
  icon: IconName | undefined;
  label: string | undefined;
  title: string;
  /** Why the button is off, shown as a tooltip. */
  disabledReason: string | undefined;
  isBusy: boolean;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  /** A finger tap submits on lift, without waiting for the browser's delayed click. */
  onTouchSubmit: () => void;
}

function PromptSubmitButton({
  submit,
  isCompact,
  className,
}: {
  submit: PromptSubmitState;
  isCompact: boolean;
  className: string;
}) {
  const { canSubmit, label, disabledReason } = submit;
  const tap = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const skipNextClick = useRef(false);
  const movedTooFar = (event: PointerEvent, from: { x: number; y: number }) =>
    Math.hypot(event.clientX - from.x, event.clientY - from.y) > TAP_SLOP_PX;
  const showsLabel = label !== undefined && !isCompact;

  const button = (
    <Button
      data-promptbox-submit-action=""
      type="submit"
      size={isCompact ? "icon" : "sm"}
      variant="default"
      aria-label={submit.title}
      aria-busy={submit.isBusy}
      disabled={!canSubmit}
      onPointerDown={(event) => {
        const isFinger =
          event.pointerType === "touch" &&
          event.isPrimary &&
          event.button === 0;
        skipNextClick.current = false;
        tap.current = isFinger
          ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
          : null;
        submit.onPointerDown(event);
      }}
      onPointerMove={(event) => {
        const start = tap.current;
        if (start?.pointerId !== event.pointerId || !movedTooFar(event, start))
          return;
        tap.current = null;
        skipNextClick.current = true;
      }}
      onPointerCancel={() => {
        if (tap.current) skipNextClick.current = true;
        tap.current = null;
      }}
      onPointerUp={(event) => {
        const start = tap.current;
        tap.current = null;
        if (start?.pointerId !== event.pointerId) return;
        skipNextClick.current = true;
        // A finger that stayed put is a tap, wherever the button is by now: it
        // shrinks while pressed and moves while the composer grows.
        if (canSubmit && !movedTooFar(event, start)) submit.onTouchSubmit();
      }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        // The tap already submitted (or was a scroll), so its click must not.
        if (skipNextClick.current && event.detail > 0) event.preventDefault();
        else submit.onClick(event);
      }}
      className={cn(
        className,
        "rounded-full disabled:border-transparent disabled:bg-foreground/10 disabled:text-foreground/55 disabled:opacity-100",
        showsLabel &&
          "size-auto h-8 gap-1.5 px-2.5 max-md:pointer-coarse:size-auto max-md:pointer-coarse:h-10 max-md:pointer-coarse:px-3",
      )}
    >
      {submit.isBusy ? (
        <Icon name="Spinner" className="size-4 animate-spin" />
      ) : (
        <>
          <Icon name={submit.icon ?? "Send"} className="size-4" />
          {showsLabel ? (
            <span data-promptbox-submit-label="">{label}</span>
          ) : null}
        </>
      )}
    </Button>
  );
  if (!disabledReason) return button;

  // A disabled button gets no pointer events, so the tooltip hangs off a wrapper.
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-promptbox-submit-disabled-reason=""
            className="inline-flex shrink-0"
          >
            {button}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{disabledReason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** The bottom row: plus menu and footer on the left, mic and send on the right, voice bar on top. */
export function PromptActionRow({
  isCompact,
  isPointerCoarse,
  voice,
  voiceAction,
  start,
  includePluginActions,
  primaryAction,
  showMic,
  canStartVoice,
  onStartVoice,
  onStop,
  submit,
}: {
  isCompact: boolean;
  isPointerCoarse: boolean;
  voice: PromptVoiceConfig | undefined;
  voiceAction: PromptVoiceAction;
  /** The plus menu and the caller's footer controls. */
  start: ReactNode;
  includePluginActions: boolean;
  primaryAction: "stop" | "voice" | "submit";
  showMic: boolean;
  canStartVoice: boolean;
  onStartVoice: () => void;
  onStop: (() => void) | undefined;
  submit: PromptSubmitState;
}) {
  const stopPress = useOwnPress(() => onStop?.());
  // On touch, keep the press from moving focus: that would pop the keyboard.
  const voicePress = useOwnPress(onStartVoice, (event) => {
    if (isPointerCoarse) event.preventDefault();
  });
  const isVoiceBarVisible = voiceAction.stage === "active";
  const standardActionsClass = cn(
    FADE_CLASS,
    voiceAction.isActive ? FADED_OUT_CLASS : FADED_IN_CLASS,
  );
  const covered = voiceAction.isActive ? true : undefined;
  const iconButtonClass = cn(
    isCompact
      ? COMPACT_BUTTON_CLASS
      : COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS,
    MOBILE_ROUND_BUTTON_CLASS,
  );
  const primaryButtonClass = cn(
    isCompact
      ? COMPACT_BUTTON_CLASS
      : ["ml-1", COARSE_POINTER_PROMPT_ACTION_BUTTON_CLASS],
    "transition-colors",
    MOBILE_ROUND_BUTTON_CLASS,
  );

  return (
    <div
      data-promptbox-action-row=""
      className={cn(
        "relative flex shrink-0 select-none flex-row items-center gap-3 pb-2 pl-3.5 pr-2 pt-1.5",
        isCompact && "absolute inset-y-0 right-2 gap-0 p-0",
      )}
    >
      {voice && voiceAction.stage !== "hidden" ? (
        <div
          data-promptbox-voice-controls=""
          data-voice-transition={voiceAction.stage}
          inert={isVoiceBarVisible ? undefined : true}
          aria-hidden={isVoiceBarVisible ? undefined : true}
          className={cn(
            "absolute inset-0 z-10 min-w-0 origin-center transition-[opacity,transform] duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] will-change-[opacity,transform] motion-reduce:transition-none",
            isVoiceBarVisible
              ? "pointer-events-auto translate-y-0 scale-100 opacity-100"
              : "pointer-events-none translate-y-1 scale-[0.985] opacity-0",
          )}
        >
          <VoiceRecordingBar
            state={voiceAction.phase}
            stream={voice.stream}
            onConfirm={voice.stop}
            onSend={isPointerCoarse ? voice.stopAndSend : undefined}
            onCancel={voiceAction.cancel}
          />
        </div>
      ) : null}
      {isCompact ? null : (
        <div
          data-promptbox-expanded-only=""
          data-promptbox-standard-actions=""
          className={cn(
            "flex min-w-0 flex-1 flex-row items-center gap-1",
            standardActionsClass,
          )}
          inert={covered}
          aria-live="polite"
        >
          {start}
        </div>
      )}
      <div
        data-promptbox-standard-actions=""
        className={cn(
          "flex shrink-0 flex-row items-center gap-1",
          standardActionsClass,
        )}
        inert={covered}
      >
        <ComposerActionsSlot includePluginContributions={includePluginActions}>
          {voice && showMic ? (
            <Button
              data-promptbox-expanded-only={isCompact ? undefined : ""}
              type="button"
              size="icon"
              variant="ghost"
              aria-label={
                voice.isSupported
                  ? "Start voice input"
                  : voiceUnsupportedMessage(voice.unsupportedReason ?? null)
              }
              disabled={!canStartVoice}
              {...voicePress}
              className={iconButtonClass}
            >
              <Icon name="Mic" className="size-4" />
            </Button>
          ) : null}
          <div
            data-promptbox-submit-group=""
            className="flex shrink-0 flex-row items-center"
          >
            {primaryAction === "stop" ? (
              <Button
                data-promptbox-submit-action=""
                type="button"
                size="icon"
                variant="secondary"
                aria-label="Stop run"
                {...stopPress}
                className={cn(
                  "rounded-full bg-foreground/10 hover:bg-foreground/15",
                  iconButtonClass,
                )}
              >
                <Icon
                  name="Square"
                  className="size-3.5 fill-current [&_*]:!stroke-0"
                />
              </Button>
            ) : primaryAction === "voice" ? (
              <Button
                data-promptbox-submit-action=""
                type="button"
                size={isCompact ? "icon" : "sm"}
                variant="default"
                aria-label="Start voice input"
                {...voicePress}
                className={primaryButtonClass}
              >
                <Icon name="Mic" className="size-4" />
              </Button>
            ) : (
              <PromptSubmitButton
                submit={submit}
                isCompact={isCompact}
                className={primaryButtonClass}
              />
            )}
          </div>
        </ComposerActionsSlot>
      </div>
    </div>
  );
}
