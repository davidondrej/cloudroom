import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePointerCoarse } from "@cloudroom/shared-ui/hooks/use-pointer-coarse";
import {
  anchorPointFromMouseEvent,
  createLiveSelectionRectReader,
  firstClientRect,
  selectionAnchorFromPointerRelease,
  type MessageProseSelection,
  type SelectionAnchor,
  type SelectionAnchorPoint,
} from "@/components/thread/timeline/SelectableMessageProse.js";
import { TimelineSelectionMenu } from "@/components/thread/timeline/TimelineSelectionMenu.js";

interface SecondaryPanelSelectionActionsProps {
  children: ReactNode;
  onSelectionAddToChat?: (text: string) => void;
}

function rangeIntersectsElement(range: Range, el: HTMLElement): boolean {
  if (el.contains(range.commonAncestorContainer)) return true;
  if (typeof range.intersectsNode !== "function") return false;
  try {
    return range.intersectsNode(el);
  } catch {
    return false;
  }
}

function capturePanelSelection(
  container: HTMLElement | null,
  startedInside: boolean,
  anchor: SelectionAnchor | null,
): MessageProseSelection | null {
  if (!container || typeof window === "undefined") return null;

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;

  const copyText = sel.toString();
  const text = copyText.trim();
  if (!text) return null;

  const range = sel.getRangeAt(0);
  if (!startedInside && !rangeIntersectsElement(range, container)) return null;

  const common = range.commonAncestorContainer;
  const commonElement =
    common instanceof Element ? common : common.parentElement;
  const anchorElement =
    commonElement !== null && container.contains(commonElement)
      ? commonElement
      : container;
  const rect =
    firstClientRect(range) ??
    (anchor
      ? new DOMRect(anchor.point.x, anchor.point.y, 0, 0)
      : anchorElement.getBoundingClientRect());
  const getAnchorRect = createLiveSelectionRectReader({
    anchor,
    anchorElement,
    range,
    rect,
  });

  return anchor
    ? {
        text,
        copyText,
        rect,
        anchorPoint: anchor.point,
        anchorSide: anchor.side,
        anchorElement,
        getAnchorRect,
      }
    : { text, copyText, rect, anchorElement, getAnchorRect };
}

export function SecondaryPanelSelectionActions({
  children,
  onSelectionAddToChat,
}: SecondaryPanelSelectionActionsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const trackingRef = useRef({
    startedInside: false,
    startPoint: null as SelectionAnchorPoint | null,
    isPointerDown: false,
    lastAnchor: null as SelectionAnchor | null,
  });

  const isCoarse = usePointerCoarse();
  const [selection, setSelection] = useState<MessageProseSelection | null>(
    null,
  );

  const dismiss = useCallback(() => setSelection(null), []);

  const handleAddToChat = useCallback(
    (text: string) => {
      onSelectionAddToChat?.(text);
      setSelection(null);
    },
    [onSelectionAddToChat],
  );

  useEffect(() => {
    if (isCoarse || typeof window === "undefined") return;

    let rafId: number | null = null;
    const clearScheduled = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
    };
    const scheduleRead = (anchor: SelectionAnchor | null) => {
      clearScheduled();
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        setSelection(
          capturePanelSelection(
            containerRef.current,
            trackingRef.current.startedInside,
            anchor,
          ),
        );
      });
    };

    const onPointerDown = (event: PointerEvent) => {
      clearScheduled();
      const el = containerRef.current;
      const inside =
        el !== null &&
        event.target instanceof Node &&
        el.contains(event.target);
      trackingRef.current.startedInside = inside;
      trackingRef.current.startPoint = inside
        ? anchorPointFromMouseEvent(event)
        : null;
      trackingRef.current.isPointerDown = true;
    };

    const onPointerRelease = (event: PointerEvent | MouseEvent) => {
      const state = trackingRef.current;
      const anchor =
        state.startedInside && state.startPoint
          ? selectionAnchorFromPointerRelease(state.startPoint, event)
          : null;
      if (anchor) state.lastAnchor = anchor;
      state.isPointerDown = false;
      state.startPoint = null;
      scheduleRead(anchor ?? state.lastAnchor);
    };

    const onPointerCancel = () => {
      trackingRef.current.isPointerDown = false;
      trackingRef.current.startPoint = null;
      scheduleRead(trackingRef.current.lastAnchor);
    };

    const onSelectionEvent = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key === "Escape") return;
      if (trackingRef.current.isPointerDown) return;
      scheduleRead(trackingRef.current.lastAnchor);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerRelease);
    document.addEventListener("pointercancel", onPointerCancel);
    document.addEventListener("mouseup", onPointerRelease);
    document.addEventListener("selectionchange", onSelectionEvent);
    document.addEventListener("keyup", onSelectionEvent);
    return () => {
      clearScheduled();
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerRelease);
      document.removeEventListener("pointercancel", onPointerCancel);
      document.removeEventListener("mouseup", onPointerRelease);
      document.removeEventListener("selectionchange", onSelectionEvent);
      document.removeEventListener("keyup", onSelectionEvent);
    };
  }, [isCoarse]);

  if (isCoarse) return <>{children}</>;

  return (
    <>
      <div ref={containerRef} className="contents">
        {children}
      </div>
      <TimelineSelectionMenu
        selection={selection}
        onAddToChat={onSelectionAddToChat ? handleAddToChat : undefined}
        onDismiss={dismiss}
      />
    </>
  );
}
