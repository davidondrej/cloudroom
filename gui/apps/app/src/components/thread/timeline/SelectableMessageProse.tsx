import { useEffect, useRef, type ReactNode } from "react";

export interface SelectionAnchorPoint {
  x: number;
  y: number;
}

export type SelectionAnchorSide = "top" | "bottom";

export interface SelectionAnchor {
  point: SelectionAnchorPoint;
  side: SelectionAnchorSide;
}

export interface MessageProseSelection {
  /** Trimmed text, plus any context, for Reply and other chat actions. */
  text: string;
  /** Exactly what the user selected, for Copy. Falls back to `text`. */
  copyText?: string;
  rect: DOMRect;
  anchorPoint?: SelectionAnchorPoint;
  anchorSide?: SelectionAnchorSide;
  /** Element whose scroll and layout ancestors move this selection. */
  anchorElement?: Element | null;
  /** Live viewport anchor rect, re-read on scroll, resize, or layout shifts. */
  getAnchorRect?: () => DOMRect | null;
  sourceSeqEnd?: number;
}

interface SelectableMessageProseProps {
  children: ReactNode;
  className?: string;
  onSelect?: (selection: MessageProseSelection | null) => void;
}

export const MULTI_CLICK_SELECTION_REPORT_DELAY_MS = 180;
const SELECTION_DRAG_DIRECTION_THRESHOLD_PX = 4;
const CLIPBOARD_REPLACED_CONTENT_SELECTOR =
  "audio, canvas, embed, iframe, img, object, video";

export function isSelectionWithinNode(
  node: Pick<Node, "contains"> | null,
  selection: {
    isCollapsed: boolean;
    anchorNode: Node | null;
    focusNode: Node | null;
    commonAncestorContainer: Node | null;
  } | null,
): boolean {
  if (node === null || selection === null) return false;
  if (selection.isCollapsed) return false;

  const { anchorNode, focusNode, commonAncestorContainer } = selection;
  if (anchorNode === null || focusNode === null) return false;

  return (
    node.contains(anchorNode) &&
    node.contains(focusNode) &&
    (commonAncestorContainer === null || node.contains(commonAncestorContainer))
  );
}

export function firstClientRect(range: Range): DOMRect | null {
  const rects = range.getClientRects();
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects.item(index);
    if (rect === null) {
      continue;
    }
    if (rect.width > 0 || rect.height > 0) {
      return rect;
    }
  }
  const rect = range.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 ? rect : null;
}

function lastClientRect(range: Range): DOMRect | null {
  const rects = range.getClientRects();
  for (let index = rects.length - 1; index >= 0; index -= 1) {
    const rect = rects.item(index);
    if (rect === null) {
      continue;
    }
    if (rect.width > 0 || rect.height > 0) {
      return rect;
    }
  }
  const rect = range.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 ? rect : null;
}

export function createLiveSelectionRectReader({
  anchor,
  anchorElement,
  range,
  rect,
}: {
  anchor: SelectionAnchor | null;
  anchorElement: Element | null;
  range?: Range | null;
  rect: DOMRect;
}): () => DOMRect | null {
  const anchorSide = anchor?.side ?? "top";
  const baseX = anchor?.point.x ?? rect.left + rect.width / 2;
  const baseY =
    anchor?.point.y ?? (anchorSide === "bottom" ? rect.bottom : rect.top);
  const trackedRange =
    range != null && typeof range.cloneRange === "function"
      ? range.cloneRange()
      : null;
  const readRangeRect = (): DOMRect | null => {
    if (
      trackedRange === null ||
      !trackedRange.startContainer?.isConnected ||
      !trackedRange.endContainer?.isConnected
    ) {
      return null;
    }
    return anchorSide === "bottom"
      ? lastClientRect(trackedRange)
      : firstClientRect(trackedRange);
  };
  const baseRangeRect = readRangeRect();
  const baseElementRect =
    anchorElement !== null && anchorElement.isConnected
      ? anchorElement.getBoundingClientRect()
      : null;

  return () => {
    if (anchorElement !== null && !anchorElement.isConnected) {
      return null;
    }
    const liveRangeRect = readRangeRect();
    if (liveRangeRect !== null) {
      if (anchor === null) {
        return new DOMRect(
          liveRangeRect.left + liveRangeRect.width / 2,
          anchorSide === "bottom" ? liveRangeRect.bottom : liveRangeRect.top,
          0,
          0,
        );
      }
      if (baseRangeRect !== null) {
        return new DOMRect(
          baseX + (liveRangeRect.left - baseRangeRect.left),
          baseY + (liveRangeRect.top - baseRangeRect.top),
          0,
          0,
        );
      }
    }
    if (anchorElement !== null && baseElementRect !== null) {
      const liveElementRect = anchorElement.getBoundingClientRect();
      return new DOMRect(
        baseX + (liveElementRect.left - baseElementRect.left),
        baseY + (liveElementRect.top - baseElementRect.top),
        0,
        0,
      );
    }
    return new DOMRect(baseX, baseY, 0, 0);
  };
}

function normalizeSelectionText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function isSelectionBoundarySpillWithinNode(
  node: HTMLElement,
  range: Range,
  selectionText: string,
): boolean {
  if (typeof range.intersectsNode !== "function") {
    return false;
  }
  if (!range.intersectsNode(node)) {
    return false;
  }

  const normalizedSelectionText = normalizeSelectionText(selectionText);
  if (normalizedSelectionText.length === 0) {
    return false;
  }

  return normalizeSelectionText(node.textContent ?? "").includes(
    normalizedSelectionText,
  );
}

function toMessageProseSelection({
  anchor,
  anchorElement,
  copyText,
  range,
  rect,
  text,
}: {
  anchor: SelectionAnchor | null;
  anchorElement: Element | null;
  copyText?: string;
  range?: Range | null;
  rect: DOMRect | null;
  text: string;
}): MessageProseSelection | null {
  if (text.length === 0 || rect === null) return null;
  const selection: MessageProseSelection = {
    text,
    rect,
    anchorElement,
    getAnchorRect: createLiveSelectionRectReader({
      anchor,
      anchorElement,
      range,
      rect,
    }),
  };
  if (copyText !== undefined) selection.copyText = copyText;
  if (anchor !== null) {
    selection.anchorPoint = anchor.point;
    selection.anchorSide = anchor.side;
  }
  return selection;
}

export function anchorPointFromMouseEvent(
  event: Pick<MouseEvent, "clientX" | "clientY">,
): SelectionAnchorPoint | null {
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
    return null;
  }
  return { x: event.clientX, y: event.clientY };
}

function usesLiveSelectionRange(pointerType: string | undefined): boolean {
  return (
    pointerType !== undefined && pointerType !== "" && pointerType !== "mouse"
  );
}

export function selectionAnchorFromPointerRelease(
  startPoint: SelectionAnchorPoint | null,
  releaseEvent: Pick<MouseEvent, "clientX" | "clientY"> & {
    pointerType?: string;
  },
): SelectionAnchor | null {
  if (usesLiveSelectionRange(releaseEvent.pointerType)) {
    return null;
  }
  const releasePoint = anchorPointFromMouseEvent(releaseEvent);
  if (releasePoint === null) {
    return null;
  }

  return {
    point: releasePoint,
    side:
      startPoint !== null &&
      releasePoint.y - startPoint.y > SELECTION_DRAG_DIRECTION_THRESHOLD_PX
        ? "bottom"
        : "top",
  };
}

function readSelectionWithinNode(
  node: HTMLElement | null,
  anchor: SelectionAnchor | null,
): MessageProseSelection | null {
  if (node === null || typeof window === "undefined") return null;

  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const commonElement =
    common instanceof Element ? common : common.parentElement;
  if (
    commonElement?.closest('[contenteditable]:not([contenteditable="false"])')
  ) {
    return null;
  }

  const anchorElement =
    commonElement !== null && node.contains(commonElement)
      ? commonElement
      : node;
  const accepted = isSelectionWithinNode(node, {
    isCollapsed: selection.isCollapsed,
    anchorNode: selection.anchorNode,
    focusNode: selection.focusNode,
    commonAncestorContainer: range.commonAncestorContainer,
  });
  if (accepted) {
    const copyText = selection.toString();
    const rect = firstClientRect(range);
    return toMessageProseSelection({
      anchor,
      anchorElement,
      copyText,
      range,
      rect,
      text: copyText.trim(),
    });
  }

  const text = selection.toString().trim();
  if (isSelectionBoundarySpillWithinNode(node, range, text)) {
    const rect = firstClientRect(range);
    return toMessageProseSelection({
      anchor,
      anchorElement: node,
      range,
      rect,
      text,
    });
  }

  return null;
}

function clippedRangeForWhitespaceBoundarySpill(
  node: HTMLElement,
  range: Range,
): Range | null {
  if (
    typeof range.intersectsNode !== "function" ||
    !range.intersectsNode(node)
  ) {
    return null;
  }

  const clippedRange = range.cloneRange();
  if (!node.contains(range.startContainer)) {
    const leadingRange = range.cloneRange();
    leadingRange.setEnd(node, 0);
    if (
      leadingRange.toString().trim().length > 0 ||
      leadingRange
        .cloneContents()
        .querySelector(CLIPBOARD_REPLACED_CONTENT_SELECTOR) !== null
    ) {
      return null;
    }
    clippedRange.setStart(node, 0);
  }
  if (!node.contains(range.endContainer)) {
    const trailingRange = range.cloneRange();
    trailingRange.setStart(node, node.childNodes.length);
    if (
      trailingRange.toString().trim().length > 0 ||
      trailingRange
        .cloneContents()
        .querySelector(CLIPBOARD_REPLACED_CONTENT_SELECTOR) !== null
    ) {
      return null;
    }
    clippedRange.setEnd(node, node.childNodes.length);
  }

  return clippedRange.toString().trim().length > 0 ? clippedRange : null;
}

function clipWhitespaceOnlyBoundarySpillForCopy(node: HTMLElement): boolean {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (
    node.contains(range.startContainer) &&
    node.contains(range.endContainer)
  ) {
    return false;
  }
  const clippedRange = clippedRangeForWhitespaceBoundarySpill(node, range);
  if (clippedRange === null) return false;

  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  range.setStart(clippedRange.startContainer, clippedRange.startOffset);
  range.setEnd(clippedRange.endContainer, clippedRange.endOffset);
  const clippedStartContainer = range.startContainer;
  const clippedStartOffset = range.startOffset;
  const clippedEndContainer = range.endContainer;
  const clippedEndOffset = range.endOffset;

  window.setTimeout(() => {
    if (
      anchorNode?.isConnected &&
      focusNode?.isConnected &&
      selection.rangeCount > 0
    ) {
      const liveRange = selection.getRangeAt(0);
      if (
        liveRange.startContainer !== clippedStartContainer ||
        liveRange.startOffset !== clippedStartOffset ||
        liveRange.endContainer !== clippedEndContainer ||
        liveRange.endOffset !== clippedEndOffset
      ) {
        return;
      }
      selection.setBaseAndExtent(
        anchorNode,
        anchorOffset,
        focusNode,
        focusOffset,
      );
    }
  }, 0);
  return true;
}

interface SelectionSignature {
  text: string;
  anchorNode: Node | null;
  anchorOffset: number;
  focusNode: Node | null;
  focusOffset: number;
}

interface SelectableProseInstance {
  node: HTMLElement;
  onSelectRef: {
    readonly current:
      | ((selection: MessageProseSelection | null) => void)
      | undefined;
  };
  hadSelection: boolean;
  lastSelectionSignature: SelectionSignature | null;
  pendingReportAnchor: SelectionAnchor | null;
  lastPointerReleaseAnchor: SelectionAnchor | null;
  multiClickTimer: number | null;
}

function readSelectionSignature(text: string): SelectionSignature | null {
  const selection = window.getSelection();
  if (selection === null) return null;
  return {
    text,
    anchorNode: selection.anchorNode,
    anchorOffset: selection.anchorOffset,
    focusNode: selection.focusNode,
    focusOffset: selection.focusOffset,
  };
}

function sameSelectionSignature(
  a: SelectionSignature | null,
  b: SelectionSignature | null,
): boolean {
  if (a === null || b === null) return false;
  return (
    a.text === b.text &&
    a.anchorNode === b.anchorNode &&
    a.anchorOffset === b.anchorOffset &&
    a.focusNode === b.focusNode &&
    a.focusOffset === b.focusOffset
  );
}

const proseInstances = new Set<SelectableProseInstance>();
const instanceByNode = new Map<HTMLElement, SelectableProseInstance>();
let sharedFrame: number | null = null;
let pointerIsDown = false;
let pointerUsesLiveSelectionRange = false;
let pointerActiveInstance: SelectableProseInstance | null = null;
let pointerStartPoint: SelectionAnchorPoint | null = null;

function findInstanceContaining(
  target: EventTarget | null,
): SelectableProseInstance | null {
  if (!(target instanceof Node)) return null;
  let element = target instanceof Element ? target : target.parentElement;
  while (element !== null) {
    const instance = instanceByNode.get(element as HTMLElement);
    if (instance !== undefined) return instance;
    element = element.parentElement;
  }
  return null;
}

function reportInstanceSelection(instance: SelectableProseInstance): void {
  const anchor = instance.pendingReportAnchor;
  instance.pendingReportAnchor = null;
  const next = readSelectionWithinNode(instance.node, anchor);
  if (next === null) {
    if (!instance.hadSelection) return;
    instance.hadSelection = false;
    instance.lastSelectionSignature = null;
    instance.onSelectRef.current?.(null);
    return;
  }
  const signature = readSelectionSignature(next.copyText ?? next.text);
  if (
    anchor === null &&
    instance.hadSelection &&
    sameSelectionSignature(instance.lastSelectionSignature, signature)
  ) {
    return;
  }
  instance.hadSelection = true;
  instance.lastSelectionSignature = signature;
  instance.onSelectRef.current?.(next);
}

function reportInstanceNull(instance: SelectableProseInstance): void {
  instance.pendingReportAnchor = null;
  if (!instance.hadSelection) return;
  instance.hadSelection = false;
  instance.lastSelectionSignature = null;
  instance.onSelectRef.current?.(null);
}

function reportAllInstances(): void {
  sharedFrame = null;
  const selection = window.getSelection();
  const range =
    selection !== null && selection.rangeCount > 0
      ? selection.getRangeAt(0)
      : null;
  const canPreFilter =
    range !== null && typeof range.intersectsNode === "function";
  for (const instance of proseInstances) {
    if (instance.multiClickTimer !== null) continue;
    if (
      range === null ||
      (canPreFilter && !range.intersectsNode(instance.node))
    ) {
      reportInstanceNull(instance);
      continue;
    }
    reportInstanceSelection(instance);
  }
}

function scheduleSharedReport(): void {
  if (sharedFrame !== null || proseInstances.size === 0) return;
  sharedFrame = window.requestAnimationFrame(reportAllInstances);
}

function cancelSharedFrame(): void {
  if (sharedFrame === null) return;
  window.cancelAnimationFrame(sharedFrame);
  sharedFrame = null;
}

function cancelMultiClickTimer(instance: SelectableProseInstance): void {
  if (instance.multiClickTimer === null) return;
  window.clearTimeout(instance.multiClickTimer);
  instance.multiClickTimer = null;
}

function scheduleInstanceWithAnchor(
  instance: SelectableProseInstance,
  anchor: SelectionAnchor | null,
): void {
  if (anchor !== null) {
    instance.pendingReportAnchor = anchor;
  }
  scheduleSharedReport();
}

function scheduleInstanceAfterMultiClickDelay(
  instance: SelectableProseInstance,
  anchor: SelectionAnchor | null,
): void {
  cancelMultiClickTimer(instance);
  instance.multiClickTimer = window.setTimeout(() => {
    instance.multiClickTimer = null;
    scheduleInstanceWithAnchor(instance, anchor);
  }, MULTI_CLICK_SELECTION_REPORT_DELAY_MS);
}

function handleInstanceMultiClick(
  instance: SelectableProseInstance,
  event: MouseEvent,
): void {
  if (event.detail < 2) {
    return;
  }
  const clickAnchor =
    selectionAnchorFromPointerRelease(null, event) ??
    instance.lastPointerReleaseAnchor;
  if (event.detail === 2) {
    scheduleInstanceAfterMultiClickDelay(instance, clickAnchor);
    return;
  }
  cancelMultiClickTimer(instance);
  scheduleInstanceWithAnchor(instance, clickAnchor);
}

function handleInstanceDoubleClick(instance: SelectableProseInstance): void {
  scheduleInstanceAfterMultiClickDelay(
    instance,
    instance.lastPointerReleaseAnchor,
  );
}

function handleSharedSelectionChange(): void {
  if (pointerIsDown && !pointerUsesLiveSelectionRange) {
    return;
  }
  scheduleSharedReport();
}

function handleSharedPointerDown(event: PointerEvent): void {
  cancelSharedFrame();
  for (const instance of proseInstances) {
    cancelMultiClickTimer(instance);
    instance.pendingReportAnchor = null;
  }
  pointerActiveInstance = findInstanceContaining(event.target);
  pointerStartPoint =
    pointerActiveInstance !== null ? anchorPointFromMouseEvent(event) : null;
  pointerUsesLiveSelectionRange = usesLiveSelectionRange(event.pointerType);
  pointerIsDown = true;
}

function handleSharedPointerRelease(event: PointerEvent | MouseEvent): void {
  const instance = pointerActiveInstance;
  pointerActiveInstance = null;
  if (instance !== null) {
    const anchor = selectionAnchorFromPointerRelease(pointerStartPoint, event);
    if (anchor !== null) {
      instance.lastPointerReleaseAnchor = anchor;
      instance.pendingReportAnchor = anchor;
    }
  }
  pointerIsDown = false;
  pointerUsesLiveSelectionRange = false;
  pointerStartPoint = null;
  scheduleSharedReport();
}

function handleSharedPointerCancel(): void {
  pointerActiveInstance = null;
  pointerIsDown = false;
  pointerUsesLiveSelectionRange = false;
  pointerStartPoint = null;
  scheduleSharedReport();
}

function handleSharedKeyUp(event: KeyboardEvent): void {
  if (event.key === "Escape") return;
  scheduleSharedReport();
}

function handleSharedCopy(): void {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount !== 1) return;
  const range = selection.getRangeAt(0);
  for (const instance of proseInstances) {
    if (
      typeof range.intersectsNode === "function" &&
      range.intersectsNode(instance.node) &&
      clipWhitespaceOnlyBoundarySpillForCopy(instance.node)
    ) {
      return;
    }
  }
}

function attachSharedDocumentListeners(): void {
  document.addEventListener("pointerdown", handleSharedPointerDown, {
    passive: true,
  });
  document.addEventListener("pointerup", handleSharedPointerRelease, {
    passive: true,
  });
  document.addEventListener("pointercancel", handleSharedPointerCancel, {
    passive: true,
  });
  document.addEventListener("mouseup", handleSharedPointerRelease);
  document.addEventListener("selectionchange", handleSharedSelectionChange);
  document.addEventListener("keyup", handleSharedKeyUp);
  document.addEventListener("copy", handleSharedCopy);
}

function detachSharedDocumentListeners(): void {
  document.removeEventListener("pointerdown", handleSharedPointerDown);
  document.removeEventListener("pointerup", handleSharedPointerRelease);
  document.removeEventListener("pointercancel", handleSharedPointerCancel);
  document.removeEventListener("mouseup", handleSharedPointerRelease);
  document.removeEventListener("selectionchange", handleSharedSelectionChange);
  document.removeEventListener("keyup", handleSharedKeyUp);
  document.removeEventListener("copy", handleSharedCopy);
}

function registerSelectableProseInstance(
  instance: SelectableProseInstance,
): void {
  if (proseInstances.size === 0) {
    attachSharedDocumentListeners();
  }
  proseInstances.add(instance);
  instanceByNode.set(instance.node, instance);
}

function unregisterSelectableProseInstance(
  instance: SelectableProseInstance,
): void {
  proseInstances.delete(instance);
  instanceByNode.delete(instance.node);
  cancelMultiClickTimer(instance);
  if (pointerActiveInstance === instance) {
    pointerActiveInstance = null;
  }
  if (proseInstances.size === 0) {
    detachSharedDocumentListeners();
    cancelSharedFrame();
    pointerIsDown = false;
    pointerUsesLiveSelectionRange = false;
    pointerStartPoint = null;
  }
}

export function SelectableMessageProse({
  children,
  className,
  onSelect,
}: SelectableMessageProseProps) {
  const nodeRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const node = nodeRef.current;
    if (node === null) return;

    const instance: SelectableProseInstance = {
      node,
      onSelectRef,
      hadSelection: false,
      lastSelectionSignature: null,
      pendingReportAnchor: null,
      lastPointerReleaseAnchor: null,
      multiClickTimer: null,
    };
    const handleMultiClick = (event: MouseEvent) =>
      handleInstanceMultiClick(instance, event);
    const handleDoubleClick = () => handleInstanceDoubleClick(instance);

    registerSelectableProseInstance(instance);
    node.addEventListener("click", handleMultiClick);
    node.addEventListener("dblclick", handleDoubleClick);
    return () => {
      node.removeEventListener("click", handleMultiClick);
      node.removeEventListener("dblclick", handleDoubleClick);
      unregisterSelectableProseInstance(instance);
    };
  }, []);

  return (
    <div ref={nodeRef} className={className} data-sidebar-swipe-selectable>
      {children}
    </div>
  );
}
