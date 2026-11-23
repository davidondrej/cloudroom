import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEventHandler,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from "@dnd-kit/sortable";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import type {
  SecondaryPanelRenderableTab,
  SecondaryPanelTabReorderHandler,
} from "@/components/right-panel/store/tab-ops";
import {
  OverflowFade,
  type OverflowFadeTone,
} from "@/components/ui/overflow-fade";
import { TabPill } from "@/components/ui/tab-pill";
import { useDragClickSuppression } from "@/components/ui/use-drag-click-suppression";
import {
  MACOS_APP_REGION_NO_DRAG_CLASS,
  MACOS_WINDOW_NO_DRAG_CLASS,
} from "@/lib/room-desktop";
import { sortableTranslate } from "@/lib/sortable-translate";

export const SECONDARY_PANEL_TAB_STRIP_FADE_TONE: OverflowFadeTone = "sidebar";

const SCROLL_STEP_PX = 140;
const EDGE_EPSILON = 1;
const SCROLL_BTN_OPEN_CLASS =
  "h-7 w-5 rounded-md p-0 [&_[data-icon-root]]:size-3.5 max-md:pointer-coarse:h-9 max-md:pointer-coarse:w-9 max-md:pointer-coarse:[&_[data-icon-root]]:size-5";

class DisabledTouchSensor extends TouchSensor {
  static override setup(): () => void {
    return () => {};
  }
}

export interface SecondaryPanelTabStripProps {
  activeTabId: string | null;
  tabs: readonly SecondaryPanelRenderableTab[];
  onBeginTabDrag?: (
    tabId: string,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  onReorderTab: SecondaryPanelTabReorderHandler;
  usesDesktopChrome: boolean;
  isPanelOpen: boolean;
}

function PanelTabPill({
  tab,
  isActive,
}: {
  tab: SecondaryPanelRenderableTab;
  isActive: boolean;
}) {
  const isFilePreview =
    tab.tab.kind === "workspace-file-preview" ||
    tab.tab.kind === "host-file-preview" ||
    tab.tab.kind === "thread-storage-file-preview";

  return (
    <TabPill
      label={tab.label}
      leadingVisual={tab.leadingVisual}
      secondaryLabel={tab.statusLabel ? `(${tab.statusLabel})` : null}
      title={tab.statusLabel ? `${tab.label} (${tab.statusLabel})` : tab.label}
      isActive={isActive}
      onSelect={tab.onSelect}
      labelMaxWidthClass="max-w-[160px]"
      enlargeCloseTargetOnCoarsePointer={isFilePreview}
      closeAction={
        tab.isPinned
          ? null
          : { onClose: tab.onClose, closeLabel: `Close ${tab.label}` }
      }
    />
  );
}

function SortableTabItem({
  tab,
  isActive,
  dragDisabled,
  noDragClass,
  activeTabRef,
  onBeginTabDrag,
}: {
  tab: SecondaryPanelRenderableTab;
  isActive: boolean;
  dragDisabled: boolean;
  noDragClass: string | null;
  activeTabRef: RefObject<HTMLDivElement | null>;
  onBeginTabDrag?: (
    tabId: string,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
}) {
  const { isDragging, listeners, setNodeRef, transform, transition } =
    useSortable({
      id: tab.tab.id,
      disabled: dragDisabled,
    });
  const { onPointerDown: dndPointerDown, ...otherListeners } = listeners ?? {};

  const bindRef = useCallback(
    (el: HTMLDivElement | null) => {
      setNodeRef(el);
      if (isActive) activeTabRef.current = el;
    },
    [activeTabRef, isActive, setNodeRef],
  );

  const style = useMemo<CSSProperties>(
    () => ({ transform: sortableTranslate(transform), transition }),
    [transform, transition],
  );

  return (
    <div
      ref={bindRef}
      style={style}
      className={cn(
        "shrink-0",
        !dragDisabled && "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-40",
        noDragClass,
      )}
      onPointerDown={(e) => {
        onBeginTabDrag?.(tab.tab.id, e);
        dndPointerDown?.(e);
      }}
      {...otherListeners}
    >
      <PanelTabPill tab={tab} isActive={isActive} />
    </div>
  );
}

function ScrollChevron({
  buttonRef,
  direction,
  hasOverflow,
  canScroll,
  className,
  onClick,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  direction: "left" | "right";
  hasOverflow: boolean;
  canScroll: boolean;
  className: string | null;
  onClick: () => void;
}) {
  return (
    <Button
      ref={buttonRef}
      type="button"
      variant="ghost"
      size="sm"
      tabIndex={canScroll ? 0 : -1}
      aria-hidden={!canScroll}
      aria-label={
        direction === "left" ? "Scroll tabs left" : "Scroll tabs right"
      }
      onClick={onClick}
      className={cn(
        "z-20 shrink-0 bg-sidebar text-muted-foreground shadow-none hover:bg-surface-raised-solid hover:text-foreground focus-visible:bg-sidebar transition-opacity",
        hasOverflow
          ? SCROLL_BTN_OPEN_CLASS
          : "h-7 w-0 overflow-hidden p-0 max-md:pointer-coarse:h-9",
        canScroll
          ? "pointer-events-auto opacity-100"
          : "pointer-events-none opacity-0",
        className,
      )}
    >
      <Icon name={direction === "left" ? "ChevronLeft" : "ChevronRight"} />
    </Button>
  );
}

export function SecondaryPanelTabStrip({
  activeTabId,
  tabs,
  onBeginTabDrag,
  onReorderTab,
  usesDesktopChrome,
  isPanelOpen,
}: SecondaryPanelTabStripProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLDivElement>(null);
  const leftBtnRef = useRef<HTMLButtonElement>(null);
  const rightBtnRef = useRef<HTMLButtonElement>(null);

  const metricsRef = useRef({ maxScroll: 0, overflow: false });
  const [edges, setEdges] = useState({
    hasOverflow: false,
    canScrollLeft: false,
    canScrollRight: false,
  });
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const {
    beginDragClickSuppression,
    clearDragClickSuppressionSoon,
    consumeDragClickSuppression,
  } = useDragClickSuppression();

  const dragDisabled = tabs.length < 2;
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(
      isPanelOpen && !dragDisabled ? TouchSensor : DisabledTouchSensor,
      {
        activationConstraint: { delay: 200, tolerance: 6 },
      },
    ),
  );

  const tabIds = useMemo(() => tabs.map((t) => t.tab.id), [tabs]);
  const draggingTab = draggingId
    ? (tabs.find((t) => t.tab.id === draggingId) ?? null)
    : null;

  const updateEdgeFlags = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const { maxScroll, overflow } = metricsRef.current;
    const scrollable = overflow && maxScroll > EDGE_EPSILON;
    const canLeft = scrollable && vp.scrollLeft > EDGE_EPSILON;
    const canRight = scrollable && vp.scrollLeft < maxScroll - EDGE_EPSILON;
    setEdges((prev) =>
      prev.hasOverflow === overflow &&
      prev.canScrollLeft === canLeft &&
      prev.canScrollRight === canRight
        ? prev
        : {
            hasOverflow: overflow,
            canScrollLeft: canLeft,
            canScrollRight: canRight,
          },
    );
  }, []);

  const measure = useCallback(() => {
    const strip = stripRef.current;
    const vp = viewportRef.current;
    const content = contentRef.current;
    if (!strip || !vp || !content) return;
    const overflow = content.scrollWidth > strip.clientWidth + EDGE_EPSILON;
    metricsRef.current.overflow = overflow;
    metricsRef.current.maxScroll = overflow
      ? Math.max(0, vp.scrollWidth - vp.clientWidth)
      : 0;
    updateEdgeFlags();
  }, [updateEdgeFlags]);

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;

    let rafId: number | null = null;
    const onScroll = () => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        updateEdgeFlags();
      });
    };

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0 || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      const max = metricsRef.current.maxScroll;
      if (max <= EDGE_EPSILON) return;
      const canMove =
        e.deltaY > 0
          ? vp.scrollLeft < max - EDGE_EPSILON
          : vp.scrollLeft > EDGE_EPSILON;
      if (!canMove) return;
      vp.scrollLeft = Math.min(max, Math.max(0, vp.scrollLeft + e.deltaY));
      e.preventDefault();
    };

    vp.addEventListener("scroll", onScroll, { passive: true });
    vp.addEventListener("wheel", onWheel, { passive: false });

    const ro = new ResizeObserver(measure);
    if (stripRef.current) ro.observe(stripRef.current);
    ro.observe(vp);
    if (contentRef.current) ro.observe(contentRef.current);

    return () => {
      vp.removeEventListener("scroll", onScroll);
      vp.removeEventListener("wheel", onWheel);
      ro.disconnect();
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [measure, updateEdgeFlags]);

  useEffect(() => {
    measure();
  }, [measure, tabs]);

  useEffect(() => {
    void document.fonts?.ready?.then(measure);
  }, [measure]);

  useLayoutEffect(() => {
    activeTabRef.current?.scrollIntoView({
      inline: "nearest",
      block: "nearest",
    });
  }, [activeTabId, edges.hasOverflow]);

  useLayoutEffect(() => {
    const active = document.activeElement;
    const activeBtn =
      activeTabRef.current?.querySelector<HTMLButtonElement>("button") ?? null;
    if (!edges.canScrollLeft && active === leftBtnRef.current) {
      (edges.canScrollRight ? rightBtnRef.current : activeBtn)?.focus();
    } else if (!edges.canScrollRight && active === rightBtnRef.current) {
      (edges.canScrollLeft ? leftBtnRef.current : activeBtn)?.focus();
    }
  }, [edges.canScrollLeft, edges.canScrollRight]);

  const scrollStep = useCallback((dir: -1 | 1) => {
    viewportRef.current?.scrollBy({
      left: dir * SCROLL_STEP_PX,
      behavior: "smooth",
    });
  }, []);

  const onDragStart = useCallback(
    (e: DragStartEvent) => {
      setDraggingId(String(e.active.id));
      beginDragClickSuppression();
    },
    [beginDragClickSuppression],
  );

  const onDragCancel = useCallback(() => {
    setDraggingId(null);
    clearDragClickSuppressionSoon();
  }, [clearDragClickSuppressionSoon]);

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      setDraggingId(null);
      clearDragClickSuppressionSoon();
      if (!e.over) return;
      const from = String(e.active.id);
      const to = String(e.over.id);
      if (from !== to) onReorderTab({ activeTabId: from, overTabId: to });
    },
    [clearDragClickSuppressionSoon, onReorderTab],
  );

  const onClickCapture = useCallback<MouseEventHandler<HTMLDivElement>>(
    (e) => {
      if (!consumeDragClickSuppression()) return;
      e.preventDefault();
      e.stopPropagation();
    },
    [consumeDragClickSuppression],
  );

  const noDragClass = usesDesktopChrome ? MACOS_WINDOW_NO_DRAG_CLASS : null;
  const chevronNoDrag = usesDesktopChrome
    ? MACOS_APP_REGION_NO_DRAG_CLASS
    : null;

  return (
    <div
      ref={stripRef}
      data-testid="secondary-panel-tab-strip"
      className="group relative flex min-w-0 items-center"
    >
      <ScrollChevron
        buttonRef={leftBtnRef}
        direction="left"
        hasOverflow={edges.hasOverflow}
        canScroll={edges.canScrollLeft}
        className={chevronNoDrag}
        onClick={() => scrollStep(-1)}
      />
      <div data-secondary-panel-tab-scroll-region className="relative min-w-0">
        <OverflowFade
          placement="left"
          tone={SECONDARY_PANEL_TAB_STRIP_FADE_TONE}
          className={cn(
            "z-10",
            edges.canScrollLeft ? "opacity-100" : "opacity-0",
          )}
        />
        <OverflowFade
          placement="right"
          tone={SECONDARY_PANEL_TAB_STRIP_FADE_TONE}
          className={cn(
            "z-10",
            edges.canScrollRight ? "opacity-100" : "opacity-0",
          )}
        />
        <div
          ref={viewportRef}
          onClickCapture={onClickCapture}
          className={cn(
            "no-scrollbar min-w-0 overflow-x-auto overflow-y-hidden",
            usesDesktopChrome && MACOS_APP_REGION_NO_DRAG_CLASS,
          )}
        >
          <div
            ref={contentRef}
            data-secondary-panel-tab-content
            className="flex w-max items-center gap-1"
          >
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={onDragStart}
              onDragCancel={onDragCancel}
              onDragEnd={onDragEnd}
            >
              <SortableContext
                items={tabIds}
                strategy={horizontalListSortingStrategy}
              >
                {tabs.map((tab) => (
                  <SortableTabItem
                    key={tab.tab.id}
                    tab={tab}
                    isActive={tab.tab.id === activeTabId}
                    dragDisabled={dragDisabled}
                    noDragClass={noDragClass}
                    activeTabRef={activeTabRef}
                    onBeginTabDrag={onBeginTabDrag}
                  />
                ))}
              </SortableContext>
              {createPortal(
                <DragOverlay className="cursor-grabbing">
                  {draggingTab ? (
                    <PanelTabPill
                      tab={draggingTab}
                      isActive={draggingTab.tab.id === activeTabId}
                    />
                  ) : null}
                </DragOverlay>,
                document.body,
              )}
            </DndContext>
          </div>
        </div>
      </div>
      <ScrollChevron
        buttonRef={rightBtnRef}
        direction="right"
        hasOverflow={edges.hasOverflow}
        canScroll={edges.canScrollRight}
        className={chevronNoDrag}
        onClick={() => scrollStep(1)}
      />
    </div>
  );
}
