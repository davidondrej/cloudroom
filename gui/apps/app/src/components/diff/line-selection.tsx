import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { SelectedLineRange } from "@pierre/diffs";
import {
  anchorPointFromMouseEvent,
  selectionAnchorFromPointerRelease,
  type MessageProseSelection,
  type SelectionAnchor,
  type SelectionAnchorPoint,
  type SelectionAnchorSide,
} from "@/components/thread/timeline/SelectableMessageProse.js";
import { TimelineSelectionMenu } from "@/components/thread/timeline/TimelineSelectionMenu.js";
import { getDiffShadowRoots } from "./patch-utils";

const MENU_OFFSET_PX = 72;

let docPointerStart: SelectionAnchorPoint | null = null;
let docPointerRelease: SelectionAnchor | null = null;

export interface PierreLineSelectionActions {
  menu: ReactNode;
  onGutterUtilityClick: (range: SelectedLineRange) => void;
  onLineSelectionChange: (range: SelectedLineRange | null) => void;
  onLineSelectionEnd: (range: SelectedLineRange | null) => void;
  onLineSelectionStart: (range: SelectedLineRange | null) => void;
  onPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMoveCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUpCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  selectedRange: SelectedLineRange | null;
}

function isGutterUtilityPath(
  path: readonly (EventTarget | undefined)[],
): boolean {
  return path.some(
    (t) =>
      t instanceof Element &&
      (t.hasAttribute("data-utility-button") ||
        t.hasAttribute("data-gutter-utility-slot") ||
        t.getAttribute("slot") === "gutter-utility-slot" ||
        t.getAttribute("name") === "gutter-utility-slot"),
  );
}

function sameRange(
  a: SelectedLineRange | null,
  b: SelectedLineRange | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.start === b.start &&
    a.end === b.end &&
    a.side === b.side &&
    a.endSide === b.endSide
  );
}

function pickBoundaryRow(
  rows: HTMLElement[],
  side: SelectionAnchorSide,
): HTMLElement | undefined {
  const exact = rows.find((r) => {
    const attr = r.getAttribute("data-selected-line");
    return attr === "single" || attr === (side === "bottom" ? "last" : "first");
  });
  if (exact) return exact;
  return rows
    .map((row) => ({ row, rect: row.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > 0 || rect.height > 0)
    .sort((a, b) =>
      side === "bottom"
        ? b.rect.bottom - a.rect.bottom
        : a.rect.top - b.rect.top,
    )[0]?.row;
}

function resolveAnchorPoint(
  el: HTMLElement | null,
  side: SelectionAnchorSide,
): SelectionAnchorPoint | null {
  const roots = getDiffShadowRoots(el);
  for (const root of roots) {
    const line = pickBoundaryRow(
      Array.from(
        root.querySelectorAll<HTMLElement>("[data-selected-line][data-line]"),
      ),
      side,
    );
    if (line) {
      const r = line.getBoundingClientRect();
      return {
        x: r.left + Math.min(MENU_OFFSET_PX, r.width / 2),
        y: side === "bottom" ? r.bottom : r.top,
      };
    }
  }
  for (const root of roots) {
    const num = pickBoundaryRow(
      Array.from(
        root.querySelectorAll<HTMLElement>(
          "[data-selected-line][data-column-number]",
        ),
      ),
      side,
    );
    if (num) {
      const r = num.getBoundingClientRect();
      return {
        x: r.right + MENU_OFFSET_PX,
        y: side === "bottom" ? r.bottom : r.top,
      };
    }
  }
  for (const root of roots) {
    const btn = root.querySelector("[data-utility-button]");
    if (!btn) continue;
    const r = btn.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    return {
      x: r.right + MENU_OFFSET_PX,
      y: side === "bottom" ? r.bottom : r.top,
    };
  }
  return null;
}

function inferSide(
  range: SelectedLineRange,
  startRange: SelectedLineRange | null,
): SelectionAnchorSide | null {
  if (startRange) {
    const s = startRange.start;
    const lo = Math.min(range.start, range.end);
    const hi = Math.max(range.start, range.end);
    if (s <= lo && hi > s) return "bottom";
    if (s >= hi && lo < s) return "top";
  }
  return range.end > range.start
    ? "bottom"
    : range.end < range.start
      ? "top"
      : null;
}

export function usePierreLineSelectionActions(args: {
  buildCopyText?: (range: SelectedLineRange) => string | null;
  buildFallbackSelectionText?: (ctx: {
    containerElement: HTMLElement | null;
    range: SelectedLineRange;
  }) => string | null;
  buildSelectionText: (range: SelectedLineRange) => string | null;
  containerRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  onSelectionAddToChat?: (text: string) => void;
}): PierreLineSelectionActions {
  const {
    buildCopyText,
    buildFallbackSelectionText,
    buildSelectionText,
    containerRef,
    enabled,
    onSelectionAddToChat,
  } = args;
  const [activeRange, setActiveRange] = useState<SelectedLineRange | null>(
    null,
  );
  const [previewRange, setPreviewRange] = useState<SelectedLineRange | null>(
    null,
  );
  const [selection, setSelection] = useState<MessageProseSelection | null>(
    null,
  );

  const startPtRef = useRef<SelectionAnchorPoint | null>(null);
  const releaseAnchorRef = useRef<SelectionAnchor | null>(null);
  const lineAnchorRef = useRef<SelectionAnchor | null>(null);
  const utilityAnchorRef = useRef<SelectionAnchor | null>(null);
  const startRangeRef = useRef<SelectedLineRange | null>(null);
  const currentRangeRef = useRef<SelectedLineRange | null>(null);
  const suppressedEndRef = useRef<SelectedLineRange | null>(null);

  const recordUtility = useCallback(
    (e: Pick<MouseEvent, "clientX" | "clientY">) => {
      const pt = anchorPointFromMouseEvent(e);
      utilityAnchorRef.current = pt
        ? { point: pt, side: lineAnchorRef.current?.side ?? "top" }
        : null;
    },
    [],
  );

  const recordStart = useCallback(
    (e: Pick<MouseEvent, "clientX" | "clientY">) => {
      const pt = anchorPointFromMouseEvent(e);
      docPointerRelease = null;
      startPtRef.current = pt;
      docPointerStart = pt;
    },
    [],
  );

  const recordRelease = useCallback(
    (e: Pick<PointerEvent, "clientX" | "clientY" | "pointerType">) => {
      const startPt = startPtRef.current ?? docPointerStart;
      startPtRef.current = null;
      docPointerStart = null;
      if (!startPt) return;
      const anchor = selectionAnchorFromPointerRelease(startPt, e);
      if (!anchor) return;
      releaseAnchorRef.current = anchor;
      docPointerRelease = anchor;
      if (currentRangeRef.current) lineAnchorRef.current = anchor;
    },
    [],
  );

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    const onDown = (e: PointerEvent) => {
      if (!isGutterUtilityPath(e.composedPath())) recordStart(e);
    };
    const onUp = (e: PointerEvent) => {
      if (!isGutterUtilityPath(e.composedPath())) recordRelease(e);
    };
    const onCancel = () => {
      startPtRef.current = null;
      docPointerStart = null;
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onCancel, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onCancel, true);
    };
  }, [enabled, recordRelease, recordStart]);

  const dismiss = useCallback(() => {
    setActiveRange(null);
    setPreviewRange(null);
    setSelection(null);
    currentRangeRef.current = null;
    startPtRef.current = null;
    releaseAnchorRef.current = null;
    lineAnchorRef.current = null;
    utilityAnchorRef.current = null;
    startRangeRef.current = null;
    docPointerStart = null;
    docPointerRelease = null;
  }, []);

  const onGutterUtilityClick = useCallback(
    (range: SelectedLineRange) => {
      if (!enabled) return;
      const el = containerRef.current;
      const text = (
        buildSelectionText(range) ??
        buildFallbackSelectionText?.({ containerElement: el, range }) ??
        ""
      ).trim();
      if (!text) {
        suppressedEndRef.current = range;
        setActiveRange(null);
        setPreviewRange(null);
        setSelection(null);
        currentRangeRef.current = null;
        return;
      }
      const ptrAnchor =
        lineAnchorRef.current ?? releaseAnchorRef.current ?? docPointerRelease;
      const side =
        ptrAnchor?.side ??
        inferSide(range, startRangeRef.current) ??
        utilityAnchorRef.current?.side ??
        "top";
      const rect = el?.getBoundingClientRect();
      const fallbackPt = rect
        ? { x: rect.left + 24, y: rect.top + 24 }
        : { x: 0, y: 0 };
      const point =
        resolveAnchorPoint(el, side) ??
        ptrAnchor?.point ??
        utilityAnchorRef.current?.point ??
        fallbackPt;
      const copyText = buildCopyText?.(range) ?? null;

      suppressedEndRef.current = null;
      currentRangeRef.current = range;
      setActiveRange(range);
      setPreviewRange(range);
      setSelection({
        text,
        ...(copyText !== null ? { copyText } : {}),
        rect: new DOMRect(point.x, point.y, 0, 0),
        anchorPoint: point,
        anchorSide: side,
      });
    },
    [
      buildCopyText,
      buildFallbackSelectionText,
      buildSelectionText,
      containerRef,
      enabled,
    ],
  );

  const onPointerDownCapture = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!enabled) return;
      if (isGutterUtilityPath(e.nativeEvent.composedPath())) recordUtility(e);
      else recordStart(e);
    },
    [enabled, recordStart, recordUtility],
  );

  const onPointerMoveCapture = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (enabled && isGutterUtilityPath(e.nativeEvent.composedPath()))
        recordUtility(e);
    },
    [enabled, recordUtility],
  );

  const onPointerUpCapture = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!enabled) return;
      if (isGutterUtilityPath(e.nativeEvent.composedPath())) recordUtility(e);
      else recordRelease(e);
    },
    [enabled, recordRelease, recordUtility],
  );

  const onLineSelectionStart = useCallback(
    (range: SelectedLineRange | null) => {
      if (!enabled) return;
      suppressedEndRef.current = null;
      currentRangeRef.current = range;
      lineAnchorRef.current = null;
      startRangeRef.current = range;
      setActiveRange(null);
      setSelection(null);
      setPreviewRange(range);
    },
    [enabled],
  );

  const onLineSelectionChange = useCallback(
    (range: SelectedLineRange | null) => {
      if (!enabled) return;
      suppressedEndRef.current = null;
      currentRangeRef.current = range;
      setPreviewRange(range);
    },
    [enabled],
  );

  const onLineSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      if (!enabled) return;
      if (sameRange(range, suppressedEndRef.current)) {
        suppressedEndRef.current = null;
        currentRangeRef.current = null;
        setPreviewRange(null);
        return;
      }
      currentRangeRef.current = range;
      const ptr = releaseAnchorRef.current ?? docPointerRelease;
      if (range && ptr) lineAnchorRef.current = ptr;
      setPreviewRange(range);
    },
    [enabled],
  );

  const handleAddToChat = useCallback(
    (text: string) => {
      onSelectionAddToChat?.(text);
      dismiss();
    },
    [dismiss, onSelectionAddToChat],
  );

  const menu = useMemo(
    () =>
      enabled ? (
        <TimelineSelectionMenu
          selection={selection}
          onAddToChat={onSelectionAddToChat ? handleAddToChat : undefined}
          onDismiss={dismiss}
        />
      ) : null,
    [dismiss, enabled, handleAddToChat, onSelectionAddToChat, selection],
  );

  return {
    menu,
    onGutterUtilityClick,
    onLineSelectionChange,
    onLineSelectionEnd,
    onLineSelectionStart,
    onPointerDownCapture,
    onPointerMoveCapture,
    onPointerUpCapture,
    selectedRange: activeRange ?? previewRange,
  };
}
