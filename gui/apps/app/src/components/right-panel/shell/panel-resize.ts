import { useCallback, useEffect, useRef, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useAtomValue, useSetAtom } from "jotai";
import type { ImperativePanelHandle } from "react-resizable-panels";
import {
  secondaryPanelWidthPercentAtom,
  threadSecondaryPanelResizingAtom,
} from "@/components/right-panel/store/panel-prefs";
import { useResizeObserver } from "@/hooks/useElementObservers";
import { createSplitResizeSnapSession } from "@/lib/split-resize-snap";
import {
  THREAD_SECONDARY_PANEL_MAX_SIZE_PERCENT,
  THREAD_SECONDARY_PANEL_MIN_SIZE_PERCENT,
} from "./panel-tokens";

export type SecondaryPanelWidthChangeHandler = (
  width: number | undefined,
) => void;

const MIN_LEADING_FRACTION =
  (100 - THREAD_SECONDARY_PANEL_MAX_SIZE_PERCENT) / 100;
const MAX_LEADING_FRACTION =
  (100 - THREAD_SECONDARY_PANEL_MIN_SIZE_PERCENT) / 100;

export function usePanelResizeSnap({
  hitTargetRef: externalHitTargetRef,
  onResize,
  onDragging,
}: {
  hitTargetRef?: RefObject<HTMLSpanElement | null>;
  onResize: (leadingFraction: number) => void;
  onDragging: (isDragging: boolean) => void;
}) {
  const internalHitTargetRef = useRef<HTMLSpanElement>(null);
  const hitTargetRef = externalHitTargetRef ?? internalHitTargetRef;
  const stopActiveDragRef = useRef<((commit: boolean) => void) | null>(null);

  useEffect(() => () => stopActiveDragRef.current?.(false), []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof HTMLElement)) return;
      const divider = event.target.closest<HTMLElement>(
        "[data-panel-resize-snap-handle]",
      );
      if (
        !divider ||
        hitTargetRef.current?.parentElement !== divider ||
        divider.getAttribute("data-panel-resize-handle-enabled") !== "true"
      ) {
        return;
      }

      stopActiveDragRef.current?.(true);
      const prevEl = divider.previousElementSibling;
      const nextEl = divider.nextElementSibling;
      if (
        !(prevEl instanceof HTMLElement) ||
        !(nextEl instanceof HTMLElement)
      ) {
        return;
      }

      const start = prevEl.getBoundingClientRect().left;
      const end = nextEl.getBoundingClientRect().right;
      const win = divider.ownerDocument.defaultView;
      if (end <= start || !win) return;

      event.preventDefault();
      event.stopPropagation();

      const snap = createSplitResizeSnapSession(divider, "x", {
        boundaryIndex: 1,
        childCount: 2,
      });
      const grid = divider.closest<HTMLElement>(
        "[data-split-resize-grid-root]",
      );
      const prevDuration = grid?.style.getPropertyValue(
        "--panel-collapse-duration",
      );
      const prevPriority = grid?.style.getPropertyPriority(
        "--panel-collapse-duration",
      );
      grid?.style.setProperty("--panel-collapse-duration", "0ms");

      const pointerId = event.pointerId;
      divider.setPointerCapture(pointerId);
      divider.dataset.dragging = "true";
      snap.resolve({ start, end, pointer: event.clientX });

      let done = false;
      let queuedFraction: number | null = null;
      let rafId: number | null = null;

      const apply = () => {
        rafId = null;
        const frac = queuedFraction;
        queuedFraction = null;
        if (frac !== null) onResize(frac);
      };

      const finish = (commit: boolean) => {
        if (done) return;
        done = true;

        win.removeEventListener("pointermove", onMove, true);
        win.removeEventListener("pointerup", onPointerEnd, true);
        win.removeEventListener("pointercancel", onPointerEnd, true);
        win.removeEventListener("mouseup", commitEnd, true);
        win.removeEventListener("blur", commitEnd);
        divider.removeEventListener("lostpointercapture", onPointerEnd);

        delete divider.dataset.dragging;
        if (divider.hasPointerCapture(pointerId)) {
          divider.releasePointerCapture(pointerId);
        }
        snap.clear();
        if (stopActiveDragRef.current === finish)
          stopActiveDragRef.current = null;

        if (commit) {
          if (rafId !== null) win.cancelAnimationFrame(rafId);
          flushSync(apply);
          prevEl.getBoundingClientRect();
        } else if (rafId !== null) {
          win.cancelAnimationFrame(rafId);
        }

        onDragging(false);
        if (grid) {
          if (!prevDuration)
            grid.style.removeProperty("--panel-collapse-duration");
          else
            grid.style.setProperty(
              "--panel-collapse-duration",
              prevDuration,
              prevPriority,
            );
        }
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        if (ev.buttons === 0) {
          finish(true);
          return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        const resolved = snap.resolve({ start, end, pointer: ev.clientX });
        queuedFraction = Math.max(
          MIN_LEADING_FRACTION,
          Math.min(MAX_LEADING_FRACTION, resolved.fraction),
        );
        if (rafId === null) rafId = win.requestAnimationFrame(apply);
      };

      const commitEnd = () => finish(true);
      const onPointerEnd = (ev: PointerEvent) => {
        if (ev.pointerId === pointerId) finish(true);
      };

      stopActiveDragRef.current = finish;
      win.addEventListener("pointermove", onMove, true);
      win.addEventListener("pointerup", onPointerEnd, true);
      win.addEventListener("pointercancel", onPointerEnd, true);
      win.addEventListener("mouseup", commitEnd, true);
      win.addEventListener("blur", commitEnd);
      divider.addEventListener("lostpointercapture", onPointerEnd);
      onDragging(true);
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [hitTargetRef, onDragging, onResize]);

  return hitTargetRef;
}

export function useSecondaryPanelResize({
  isSecondaryPanelOpen,
  onPanelWidthChange,
  onResizeStart,
  resizeHitTargetRef,
  secondaryPanelRef,
  secondaryResizablePanelRef,
}: {
  isSecondaryPanelOpen: boolean;
  onPanelWidthChange: SecondaryPanelWidthChangeHandler;
  onResizeStart: () => void;
  resizeHitTargetRef: RefObject<HTMLSpanElement | null>;
  secondaryPanelRef: RefObject<HTMLElement>;
  secondaryResizablePanelRef: RefObject<ImperativePanelHandle | null>;
}) {
  const persistedWidthPercent = useAtomValue(secondaryPanelWidthPercentAtom);
  const setPersistedWidthPercent = useSetAtom(secondaryPanelWidthPercentAtom);
  const setIsResizing = useSetAtom(threadSecondaryPanelResizingAtom);

  const latestWidthRef = useRef(persistedWidthPercent);
  const wasOpenRef = useRef(isSecondaryPanelOpen);

  const onPointerResize = useCallback(
    (leadingFraction: number) => {
      secondaryResizablePanelRef.current?.resize((1 - leadingFraction) * 100);
    },
    [secondaryResizablePanelRef],
  );

  const onDragging = useCallback(
    (dragging: boolean) => {
      setIsResizing(dragging);
      if (dragging) {
        onResizeStart();
      } else if (latestWidthRef.current > 0) {
        setPersistedWidthPercent(latestWidthRef.current);
      }
    },
    [onResizeStart, setIsResizing, setPersistedWidthPercent],
  );

  usePanelResizeSnap({
    hitTargetRef: resizeHitTargetRef,
    onResize: onPointerResize,
    onDragging,
  });

  useEffect(() => {
    if (wasOpenRef.current === isSecondaryPanelOpen) return;
    wasOpenRef.current = isSecondaryPanelOpen;
    const panel = secondaryResizablePanelRef.current;
    if (!panel) return;
    if (isSecondaryPanelOpen) {
      panel.expand(latestWidthRef.current);
      onPanelWidthChange(
        secondaryPanelRef.current?.getBoundingClientRect().width,
      );
    } else {
      panel.collapse();
    }
  }, [
    isSecondaryPanelOpen,
    onPanelWidthChange,
    secondaryPanelRef,
    secondaryResizablePanelRef,
  ]);

  useResizeObserver({
    ref: secondaryPanelRef,
    onResize: ({ width }) => {
      onPanelWidthChange(
        width ?? secondaryPanelRef.current?.getBoundingClientRect().width,
      );
    },
  });

  const handleSecondaryPanelResize = useCallback(
    (size: number) => {
      if (size <= 0) return;
      latestWidthRef.current = size;
      secondaryPanelRef.current?.style.setProperty(
        "--secondary-swipe-width",
        `${size}cqw`,
      );
    },
    [secondaryPanelRef],
  );

  return {
    handleSecondaryPanelResize,
    persistedWidthPercent,
  };
}
