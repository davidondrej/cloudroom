import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useAtomValue } from "jotai";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  createSidebarSplitState,
  focusSidebarPane,
  getSidebarGroupForPane,
  getSidebarTabPlacement,
  isCanonicalSidebarSplitState,
  legacySidebarSplitStorageKey,
  moveSidebarPaneToSide,
  moveSidebarTab,
  parseSidebarSplitState,
  pruneSidebarSplitStorage,
  reconcileSidebarSplitState,
  removeSidebarSplit,
  reorderSidebarTab,
  replaceSidebarTab,
  resizeSidebarSplit,
  restoreSidebarTabPlacement,
  selectSidebarTab,
  serializeSidebarSplitState,
  setSidebarPaneMaximized,
  sidebarPaneGroupId,
  sidebarSplitStorageKey,
  toggleSidebarPaneMaximize,
  type SidebarSplitState,
  type SidebarTabGroup,
  type SidebarTabPlacement,
} from "@/components/right-panel/store/split-state";
import type { SecondaryPanelTabReorderRequest } from "@/components/right-panel/store/tab-ops";
import { withLocalStorage } from "@/lib/browser-storage";
import { IframeDragGuardOverlay } from "@/lib/iframe-drag-guard";
import { MACOS_APP_REGION_NO_DRAG_CLASS } from "@/lib/room-desktop";
import { beginSplitDrag, type SplitDropTarget } from "@/lib/split-drag";
import {
  computePaneRects,
  countPanes,
  listPanes,
  MAX_PANES,
  type LayoutNode,
  type SplitLayout,
  type SplitPath,
  type SplitSide,
} from "@/lib/split-layout";
import { dimInactiveSplitsAtom } from "@/lib/split-layout/atoms";
import {
  createSplitResizeFlexPair,
  createSplitResizeSnapSession,
} from "@/lib/split-resize-snap";
import {
  PaneContext,
  type PaneContextValue,
} from "@/views/thread-detail/PaneContext";

const DRAG_ENGAGE_PX = 7;
const EDGE_EPSILON = 1e-9;

type ResizeCursor = "col-resize" | "row-resize";

export interface SidebarSplitTabDescriptor {
  id: string;
  label: string;
  restoresPlacementAfterRemoval: boolean;
}

export interface SidebarSplitPaneRenderArgs {
  group: SidebarTabGroup;
  isFocused: boolean;
  isLeftEdge: boolean;
  isMaximized: boolean;
  isTopRow: boolean;
  onBeginTabDrag: (
    tabId: string,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  onReorderTab: (request: SecondaryPanelTabReorderRequest) => void;
  onFocusPane: () => void;
  onRemoveSplit?: () => void;
  onMoveActiveTabToSide?: (side: SplitSide) => void;
  onSelectTab: (tabId: string) => void;
  onToggleMaximize: () => void;
  paneId: string;
  showOuterControls: boolean;
}

function canMoveActiveTab(group: SidebarTabGroup, paneCount: number): boolean {
  return group.tabIds.length > 1 ? paneCount < MAX_PANES : paneCount > 1;
}

function allocateGroupId(state: SidebarSplitState): string {
  let n = 1;
  while (state.groups[`group-split-${n}`] !== undefined) n += 1;
  return `group-split-${n}`;
}

function subtreeKey(node: LayoutNode): string {
  return listPanes(node)
    .map((p) => `${p.paneId}:${sidebarPaneGroupId(p) ?? "unknown"}`)
    .join("|");
}

function SplitDivider({
  boundaryIndex,
  childCount,
  dir,
  hidden,
  onResize,
  onResizeDragChange,
  onPreviewResize,
}: {
  boundaryIndex: number;
  childCount: number;
  dir: "row" | "col";
  hidden: boolean;
  onResize: (fraction: number) => void;
  onResizeDragChange: (cursor: ResizeCursor | null) => void;
  onPreviewResize: (fraction: number | null) => void;
}) {
  const isRow = dir === "row";
  const cancelActiveRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cancelActiveRef.current?.(), []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      cancelActiveRef.current?.();

      const hit = event.currentTarget;
      const divider = hit.parentElement;
      const prev = divider?.previousElementSibling;
      const next = divider?.nextElementSibling;
      if (
        !(divider instanceof HTMLElement) ||
        !(prev instanceof HTMLElement) ||
        !(next instanceof HTMLElement)
      ) {
        return;
      }

      const prevRect = prev.getBoundingClientRect();
      const nextRect = next.getBoundingClientRect();
      const start = isRow ? prevRect.left : prevRect.top;
      const end = isRow ? nextRect.right : nextRect.bottom;
      if (end <= start) return;

      const pointerId = event.pointerId;
      const downPos = isRow ? event.clientX : event.clientY;
      const flexPair = createSplitResizeFlexPair(prev, next);
      hit.setPointerCapture(pointerId);
      divider.dataset.dragging = "true";

      const snap = createSplitResizeSnapSession(divider, isRow ? "x" : "y", {
        boundaryIndex,
        childCount,
      });
      snap.resolve({ start, end, pointer: downPos });

      let lastFrac: number | null = null;
      let moved = false;
      let ended = false;

      const apply = (ev: PointerEvent) => {
        const pos = isRow ? ev.clientX : ev.clientY;
        const { fraction } = snap.resolve({ start, end, pointer: pos });
        lastFrac = fraction;
        flexPair.apply(fraction);
        onPreviewResize(fraction);
      };

      const finish = (commit: boolean) => {
        if (ended) return;
        ended = true;
        cancelActiveRef.current = null;
        delete divider.dataset.dragging;
        hit.removeEventListener("pointermove", onMove);
        hit.removeEventListener("pointerup", onUp);
        hit.removeEventListener("pointercancel", onCancel);
        hit.removeEventListener("lostpointercapture", onCancel);
        if (hit.hasPointerCapture?.(pointerId))
          hit.releasePointerCapture(pointerId);
        snap.clear();
        onResizeDragChange(null);
        onPreviewResize(null);
        if (commit && lastFrac !== null) {
          onResize(lastFrac);
        } else {
          flexPair.restore();
        }
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        moved = true;
        apply(ev);
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const upPos = isRow ? ev.clientX : ev.clientY;
        if (!moved && upPos === downPos) {
          finish(false);
          return;
        }
        apply(ev);
        finish(true);
      };
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId === pointerId) finish(false);
      };

      hit.addEventListener("pointermove", onMove);
      hit.addEventListener("pointerup", onUp);
      hit.addEventListener("pointercancel", onCancel);
      hit.addEventListener("lostpointercapture", onCancel);
      cancelActiveRef.current = () => finish(false);
      onResizeDragChange(isRow ? "col-resize" : "row-resize");
    },
    [
      boundaryIndex,
      childCount,
      isRow,
      onPreviewResize,
      onResize,
      onResizeDragChange,
    ],
  );

  return (
    <div
      role="separator"
      data-split-resize-grid-boundary={boundaryIndex}
      data-split-resize-grid-count={childCount}
      aria-hidden={hidden || undefined}
      aria-label={
        isRow ? "Resize right panel panes" : "Resize stacked right panel panes"
      }
      aria-orientation={isRow ? "vertical" : "horizontal"}
      className={cn(
        "group pointer-events-auto relative z-[25] shrink-0 bg-border-seam transition-colors hover:bg-ring/40 data-[dragging]:bg-ring/40",
        MACOS_APP_REGION_NO_DRAG_CLASS,
        hidden && "invisible pointer-events-none",
        isRow ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
      )}
    >
      <div
        aria-hidden
        onPointerDown={onPointerDown}
        className={cn(
          "absolute z-10 touch-none bg-transparent",
          isRow
            ? "-left-1.5 top-0 h-full w-3 cursor-col-resize"
            : "left-0 -top-1.5 h-3 w-full cursor-row-resize",
        )}
      />
    </div>
  );
}

function SplitTrackTree({
  node,
  path,
  maximizedPaneId,
  onResize,
  onResizeDragChange,
  onPreviewResize,
}: {
  node: LayoutNode;
  path: number[];
  maximizedPaneId: string | null;
  onResize: (path: SplitPath, childIndex: number, fraction: number) => void;
  onResizeDragChange: (cursor: ResizeCursor | null) => void;
  onPreviewResize: (
    path: SplitPath,
    childIndex: number,
    fraction: number | null,
  ) => void;
}) {
  if (node.type === "pane") {
    return <div className="flex min-h-0 min-w-0 flex-1" />;
  }
  return (
    <div
      data-split-resize-grid-root=""
      className={cn(
        "pointer-events-none flex min-h-0 min-w-0 flex-1",
        node.dir === "row" ? "flex-row" : "flex-col",
      )}
    >
      {node.children.map((child, idx) => (
        <Fragment key={subtreeKey(child)}>
          {idx > 0 ? (
            <SplitDivider
              boundaryIndex={idx}
              childCount={node.children.length}
              dir={node.dir}
              hidden={maximizedPaneId !== null}
              onResize={(f) => onResize(path, idx - 1, f)}
              onResizeDragChange={onResizeDragChange}
              onPreviewResize={(f) => onPreviewResize(path, idx - 1, f)}
            />
          ) : null}
          <div
            className="flex min-h-0 min-w-0"
            style={{ flex: `${node.sizes[idx] ?? 1} 1 0px` }}
          >
            <SplitTrackTree
              node={child}
              path={[...path, idx]}
              maximizedPaneId={maximizedPaneId}
              onResize={onResize}
              onResizeDragChange={onResizeDragChange}
              onPreviewResize={onPreviewResize}
            />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function SplitLeafPane({
  pane,
  rect,
  state,
  dimsInactiveSplits,
  isLeftEdge,
  isRightEdge,
  isTopRow,
  renderPane,
  onBeginTabDrag,
  onFocusPane,
  onMoveActiveTabToSide,
  onRemoveSplit,
  onReorderTab,
  onSelectTab,
  onToggleMaximize,
}: {
  pane: Extract<LayoutNode, { type: "pane" }>;
  rect: { x: number; y: number; w: number; h: number };
  state: SidebarSplitState;
  dimsInactiveSplits: boolean;
  isLeftEdge: boolean;
  isRightEdge: boolean;
  isTopRow: boolean;
  renderPane: (args: SidebarSplitPaneRenderArgs) => ReactNode;
  onBeginTabDrag: (
    paneId: string,
    tabId: string,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  onFocusPane: (paneId: string) => void;
  onMoveActiveTabToSide: (paneId: string, side: SplitSide) => void;
  onRemoveSplit: (paneId: string) => void;
  onReorderTab: (
    paneId: string,
    request: SecondaryPanelTabReorderRequest,
  ) => void;
  onSelectTab: (paneId: string, tabId: string) => void;
  onToggleMaximize: (paneId: string) => void;
}) {
  const groupId = sidebarPaneGroupId(pane);
  const group = groupId ? state.groups[groupId] : undefined;
  if (!group) return null;

  const isFocused = pane.paneId === state.layout.focusedPaneId;
  const isMaximized = pane.paneId === state.maximizedPaneId;
  const hiddenByMax = state.maximizedPaneId !== null && !isMaximized;
  const canMove = canMoveActiveTab(group, countPanes(state.layout.root));
  const showOuterControls =
    isMaximized || (state.maximizedPaneId === null && isTopRow && isRightEdge);

  const paneCtx: PaneContextValue = {
    paneId: pane.paneId,
    isFocused,
    isSplitPane: true,
    secondaryPanelHost: null,
    reservesWindowPanelToggle: showOuterControls,
    onRequestClose: null,
    isMaximized,
    onToggleMaximize: () => onToggleMaximize(pane.paneId),
    isBoundedPane: true,
    isTopRow: isMaximized || isTopRow,
    ownsWindowTopLeft: false,
    navigateInPane: () => {},
  };

  return (
    <PaneContext.Provider value={paneCtx}>
      <div
        onPointerDownCapture={() => onFocusPane(pane.paneId)}
        onFocusCapture={() => onFocusPane(pane.paneId)}
        aria-hidden={hiddenByMax || undefined}
        style={
          isMaximized
            ? undefined
            : {
                contentVisibility: hiddenByMax ? "hidden" : undefined,
                left: `${rect.x * 100}%`,
                top: `${rect.y * 100}%`,
                width: `${rect.w * 100}%`,
                height: `${rect.h * 100}%`,
              }
        }
        className={cn(
          "absolute flex min-h-0 min-w-0 overflow-hidden",
          hiddenByMax && "invisible pointer-events-none",
          isMaximized && "absolute inset-0 z-30",
        )}
        data-split-pane-id={pane.paneId}
        data-focused={isFocused ? "true" : "false"}
        data-maximized={isMaximized ? "true" : undefined}
      >
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-sidebar">
          {renderPane({
            group,
            isFocused,
            isLeftEdge: isMaximized || isLeftEdge,
            isMaximized,
            isTopRow: isMaximized || isTopRow,
            onBeginTabDrag: (tabId, e) => onBeginTabDrag(pane.paneId, tabId, e),
            onReorderTab: (req) => onReorderTab(pane.paneId, req),
            onFocusPane: () => onFocusPane(pane.paneId),
            onRemoveSplit: () => onRemoveSplit(pane.paneId),
            onMoveActiveTabToSide: canMove
              ? (side) => onMoveActiveTabToSide(pane.paneId, side)
              : undefined,
            onSelectTab: (tabId) => onSelectTab(pane.paneId, tabId),
            onToggleMaximize: () => onToggleMaximize(pane.paneId),
            paneId: pane.paneId,
            showOuterControls,
          })}
        </section>
        <div
          aria-hidden
          data-pane-focus-scrim=""
          className={cn(
            "pointer-events-none absolute inset-0 z-20 transition-colors",
            isFocused || !dimsInactiveSplits
              ? "bg-transparent"
              : "bg-background/30",
          )}
        />
      </div>
    </PaneContext.Provider>
  );
}

function SoloPaneHost({
  canMove,
  group,
  isFullScreen,
  onBeginTabDrag,
  onFocusPane,
  onMoveActiveTabToSide,
  onReorderTab,
  onSelectTab,
  onToggleMaximize,
  paneId,
  renderPane,
}: {
  canMove: boolean;
  group: SidebarTabGroup;
  isFullScreen: boolean;
  onBeginTabDrag: (
    paneId: string,
    tabId: string,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  onFocusPane: (paneId: string) => void;
  onMoveActiveTabToSide: (paneId: string, side: SplitSide) => void;
  onReorderTab: (paneId: string, req: SecondaryPanelTabReorderRequest) => void;
  onSelectTab: (paneId: string, tabId: string) => void;
  onToggleMaximize: () => void;
  paneId: string;
  renderPane: (args: SidebarSplitPaneRenderArgs) => ReactNode;
}) {
  return renderPane({
    group,
    isFocused: true,
    isLeftEdge: true,
    isMaximized: isFullScreen,
    isTopRow: true,
    onBeginTabDrag: (tabId, e) => onBeginTabDrag(paneId, tabId, e),
    onReorderTab: (req) => onReorderTab(paneId, req),
    onFocusPane: () => onFocusPane(paneId),
    onRemoveSplit: undefined,
    onMoveActiveTabToSide: canMove
      ? (side) => onMoveActiveTabToSide(paneId, side)
      : undefined,
    onSelectTab: (tabId) => onSelectTab(paneId, tabId),
    onToggleMaximize,
    paneId,
    showOuterControls: true,
  });
}

export function SidebarSplitContainer({
  activeTabId,
  isFullScreen,
  onActivateTab,
  onGlobalTabReorder,
  onToggleFullScreen,
  panelStateId,
  renderPane,
  tabs,
}: {
  activeTabId: string;
  isFullScreen: boolean;
  onActivateTab: (tabId: string) => void;
  onGlobalTabReorder: (request: SecondaryPanelTabReorderRequest) => void;
  onToggleFullScreen: () => void;
  panelStateId: string;
  renderPane: (args: SidebarSplitPaneRenderArgs) => ReactNode;
  tabs: readonly SidebarSplitTabDescriptor[];
}) {
  const availableIds = useMemo(() => tabs.map((t) => t.id), [tabs]);
  const storageKey = sidebarSplitStorageKey(panelStateId);
  const legacyKey = legacySidebarSplitStorageKey(panelStateId);

  const [initialStored] = useState<string | null>(() =>
    withLocalStorage(
      (s) => s.getItem(storageKey) ?? s.getItem(legacyKey),
      null,
    ),
  );

  const [state, setState] = useState<SidebarSplitState>(() => {
    const base =
      typeof window === "undefined"
        ? createSidebarSplitState(availableIds, activeTabId)
        : parseSidebarSplitState(initialStored, availableIds, activeTabId);
    return setSidebarPaneMaximized(
      base,
      isFullScreen ? base.layout.focusedPaneId : null,
    );
  });

  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  });
  const lastSavedRef = useRef({ storageKey, value: initialStored });
  const prevActiveRef = useRef(activeTabId);
  const prevTabsRef = useRef(tabs);
  const removedPlacementsRef = useRef(new Map<string, SidebarTabPlacement>());
  const prevFullScreenRef = useRef(isFullScreen);

  const dimsInactive = useAtomValue(dimInactiveSplitsAtom);
  const [resizeCursor, setResizeCursor] = useState<ResizeCursor | null>(null);
  const [previewLayout, setPreviewLayout] = useState<SplitLayout | null>(null);

  // Reconcile tab additions, removals, replacements, and external active-tab changes
  useEffect(() => {
    const prevActive = prevActiveRef.current;
    const prevTabs = prevTabsRef.current;
    const prevIds = new Set(prevTabs.map((t) => t.id));
    const externalChange = prevActive !== activeTabId;

    prevActiveRef.current = activeTabId;
    prevTabsRef.current = tabs;

    const current = stateRef.current;
    const availableSet = new Set(availableIds);

    for (const old of prevTabs) {
      if (availableSet.has(old.id)) continue;
      if (!old.restoresPlacementAfterRemoval) {
        removedPlacementsRef.current.delete(old.id);
        continue;
      }
      const placement = getSidebarTabPlacement(current, old.id);
      if (placement) removedPlacementsRef.current.set(old.id, placement);
    }

    const withReplacement =
      externalChange && !availableSet.has(prevActive)
        ? replaceSidebarTab(current, prevActive, activeTabId)
        : current;

    let next = reconcileSidebarSplitState(
      withReplacement,
      availableIds,
      activeTabId,
    );

    for (const tab of tabs) {
      if (prevIds.has(tab.id)) continue;
      if (!tab.restoresPlacementAfterRemoval) {
        removedPlacementsRef.current.delete(tab.id);
        continue;
      }
      const saved = removedPlacementsRef.current.get(tab.id);
      if (saved) {
        next = restoreSidebarTabPlacement(next, tab.id, saved);
        removedPlacementsRef.current.delete(tab.id);
      }
    }

    if (externalChange) {
      const targetPane = listPanes(next.layout.root).find((p) =>
        getSidebarGroupForPane(next, p.paneId)?.tabIds.includes(activeTabId),
      );
      if (targetPane)
        next = selectSidebarTab(next, targetPane.paneId, activeTabId);
    }

    if (next !== current) {
      stateRef.current = next;
      setState(next);
    }
  }, [activeTabId, availableIds, tabs]);

  // Prune stale split entries on thread switch
  useEffect(() => {
    withLocalStorage((storage) => {
      pruneSidebarSplitStorage({ storage, now: Date.now() });
    }, undefined);
    lastSavedRef.current = {
      storageKey,
      value: withLocalStorage((s) => s.getItem(storageKey), null),
    };
  }, [storageKey]);

  // Persist non-canonical split state
  useEffect(() => {
    const serialized = isCanonicalSidebarSplitState(
      state,
      availableIds,
      activeTabId,
    )
      ? null
      : serializeSidebarSplitState(state);
    if (
      lastSavedRef.current.storageKey === storageKey &&
      lastSavedRef.current.value === serialized
    ) {
      return;
    }
    try {
      if (serialized === null) {
        window.localStorage.removeItem(storageKey);
        window.localStorage.removeItem(legacyKey);
      } else {
        window.localStorage.setItem(storageKey, serialized);
        window.localStorage.removeItem(legacyKey);
      }
      lastSavedRef.current = { storageKey, value: serialized };
    } catch (err) {
      console.warn(
        `[right-panel] could not persist split layout for ${panelStateId}; keeping in memory only`,
        err,
      );
    }
  }, [activeTabId, availableIds, legacyKey, panelStateId, state, storageKey]);

  const commit = useCallback(
    (
      updater: (cur: SidebarSplitState) => SidebarSplitState,
      syncFocusedTab = false,
    ) => {
      const cur = stateRef.current;
      const next = updater(cur);
      if (next === cur) return cur;
      stateRef.current = next;
      setState(next);
      if (syncFocusedTab) {
        const grp = getSidebarGroupForPane(next, next.layout.focusedPaneId);
        if (grp && grp.activeTabId !== activeTabId) {
          onActivateTab(grp.activeTabId);
        }
      }
      return next;
    },
    [activeTabId, onActivateTab],
  );

  useEffect(() => {
    if (prevFullScreenRef.current === isFullScreen) return;
    prevFullScreenRef.current = isFullScreen;
    commit((cur) =>
      setSidebarPaneMaximized(
        cur,
        isFullScreen ? cur.layout.focusedPaneId : null,
      ),
    );
  }, [commit, isFullScreen]);

  const selectTab = useCallback(
    (paneId: string, tabId: string) => {
      commit((cur) => selectSidebarTab(cur, paneId, tabId));
      if (tabId !== activeTabId) onActivateTab(tabId);
    },
    [activeTabId, commit, onActivateTab],
  );

  const focusPane = useCallback(
    (paneId: string) => {
      commit((cur) => focusSidebarPane(cur, paneId), true);
    },
    [commit],
  );

  const removeSplit = useCallback(
    (paneId: string) => {
      commit((cur) => removeSidebarSplit(cur, paneId), true);
    },
    [commit],
  );

  const moveActiveTabToSide = useCallback(
    (paneId: string, side: SplitSide) => {
      commit((cur) => {
        const focused = focusSidebarPane(cur, paneId);
        const src = getSidebarGroupForPane(focused, paneId);
        if (!src) return cur;
        if (src.tabIds.length > 1) {
          if (countPanes(focused.layout.root) >= MAX_PANES) return focused;
          const moved = moveSidebarTab(
            focused,
            paneId,
            src.activeTabId,
            { paneId, zone: side },
            { groupId: allocateGroupId(focused) },
          );
          return isFullScreen
            ? setSidebarPaneMaximized(moved, moved.layout.focusedPaneId)
            : moved;
        }
        const rects = computePaneRects(focused.layout.root);
        const edgeScore = (r: {
          x: number;
          y: number;
          w: number;
          h: number;
        }) => {
          switch (side) {
            case "left":
              return r.x;
            case "right":
              return -(r.x + r.w);
            case "top":
              return r.y;
            case "bottom":
              return -(r.y + r.h);
          }
        };
        const target = listPanes(focused.layout.root)
          .filter((p) => p.paneId !== paneId)
          .sort((a, b) => {
            const ra = rects.get(a.paneId);
            const rb = rects.get(b.paneId);
            return ra && rb ? edgeScore(ra) - edgeScore(rb) : 0;
          })[0];
        return target
          ? moveSidebarPaneToSide(focused, paneId, target.paneId, side)
          : focused;
      }, true);
    },
    [commit, isFullScreen],
  );

  const toggleMaximize = useCallback(
    (paneId: string) => {
      const cur = stateRef.current;
      const next = commit((s) => toggleSidebarPaneMaximize(s, paneId));
      if (next !== cur && (next.maximizedPaneId !== null) !== isFullScreen) {
        onToggleFullScreen();
      }
    },
    [commit, isFullScreen, onToggleFullScreen],
  );

  const moveTab = useCallback(
    (sourcePaneId: string, tabId: string, target: SplitDropTarget) => {
      const groupId = allocateGroupId(stateRef.current);
      commit((cur) => {
        const moved = moveSidebarTab(cur, sourcePaneId, tabId, target, {
          groupId,
        });
        return isFullScreen
          ? setSidebarPaneMaximized(moved, moved.layout.focusedPaneId)
          : moved;
      }, true);
    },
    [commit, isFullScreen],
  );

  const beginTabDrag = useCallback(
    (
      sourcePaneId: string,
      tabId: string,
      event: ReactPointerEvent<HTMLElement>,
    ) => {
      if (event.button !== 0) return;
      const srcGroup = getSidebarGroupForPane(state, sourcePaneId);
      const srcEl = event.currentTarget;
      const boundary = srcEl.closest<HTMLElement>("aside");
      if (!boundary) return;

      const chromeRect =
        srcEl
          .closest<HTMLElement>(
            '[data-testid="thread-secondary-panel-top-chrome"]',
          )
          ?.getBoundingClientRect() ?? null;
      const startX = event.clientX;
      const startY = event.clientY;
      const ghostLabel = tabs.find((t) => t.id === tabId)?.label ?? "Panel tab";

      beginSplitDrag({
        ghostLabel,
        sourceEl: srcEl,
        targetBoundary: boundary,
        fallback: { paneId: sourcePaneId, container: boundary },
        cancelSidebarReorderOnEngage: true,
        shouldEngage: (x, y) => {
          const dx = x - startX;
          const dy = y - startY;
          if (Math.hypot(dx, dy) <= DRAG_ENGAGE_PX) return false;
          return (
            Math.abs(dy) > Math.abs(dx) ||
            chromeRect === null ||
            y < chromeRect.top ||
            y > chromeRect.bottom
          );
        },
        decide: (targetPaneId, zone) => {
          const count = srcGroup?.tabIds.length ?? 0;
          if (
            targetPaneId === sourcePaneId &&
            (zone === "center" || count <= 1)
          ) {
            return null;
          }
          if (
            zone !== "center" &&
            count > 1 &&
            countPanes(state.layout.root) >= MAX_PANES
          ) {
            return null;
          }
          return {
            zone,
            label: zone === "center" ? "Group tab here" : `Split ${zone}`,
          };
        },
        onDrop: (target) => moveTab(sourcePaneId, tabId, target),
      });
    },
    [moveTab, state, tabs],
  );

  const reorderTab = useCallback(
    (paneId: string, req: SecondaryPanelTabReorderRequest) => {
      commit((cur) =>
        reorderSidebarTab(cur, paneId, req.activeTabId, req.overTabId),
      );
      onGlobalTabReorder(req);
    },
    [commit, onGlobalTabReorder],
  );

  const onResize = useCallback(
    (path: SplitPath, childIndex: number, fraction: number) => {
      commit((cur) => resizeSidebarSplit(cur, path, childIndex, fraction));
    },
    [commit],
  );

  const onPreviewResize = useCallback(
    (path: SplitPath, childIndex: number, fraction: number | null) => {
      setPreviewLayout(
        fraction === null
          ? null
          : resizeSidebarSplit(stateRef.current, path, childIndex, fraction)
              .layout,
      );
    },
    [],
  );

  const paneCount = countPanes(state.layout.root);
  const panes = listPanes(state.layout.root);

  if (paneCount <= 1 && panes[0]) {
    const solo = panes[0];
    const group = getSidebarGroupForPane(state, solo.paneId);
    if (!group) return null;
    const canMove = canMoveActiveTab(group, paneCount);
    return (
      <SoloPaneHost
        canMove={canMove}
        group={group}
        isFullScreen={isFullScreen}
        onBeginTabDrag={beginTabDrag}
        onFocusPane={focusPane}
        onMoveActiveTabToSide={moveActiveTabToSide}
        onReorderTab={reorderTab}
        onSelectTab={selectTab}
        onToggleMaximize={onToggleFullScreen}
        paneId={solo.paneId}
        renderPane={renderPane}
      />
    );
  }

  const presented = previewLayout ?? state.layout;
  const rects = computePaneRects(presented.root);

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-sidebar-split-container=""
      data-sidebar-split-root-direction={
        presented.root.type === "split" ? presented.root.dir : undefined
      }
    >
      <SplitTrackTree
        node={presented.root}
        path={[]}
        maximizedPaneId={state.maximizedPaneId}
        onResize={onResize}
        onResizeDragChange={setResizeCursor}
        onPreviewResize={onPreviewResize}
      />
      {panes.map((pane) => {
        const rect = rects.get(pane.paneId);
        if (!rect) return null;
        return (
          <SplitLeafPane
            key={pane.paneId}
            pane={pane}
            rect={rect}
            state={state}
            dimsInactiveSplits={dimsInactive}
            isLeftEdge={rect.x <= EDGE_EPSILON}
            isRightEdge={rect.x + rect.w >= 1 - EDGE_EPSILON}
            isTopRow={rect.y <= EDGE_EPSILON}
            renderPane={renderPane}
            onBeginTabDrag={beginTabDrag}
            onFocusPane={focusPane}
            onMoveActiveTabToSide={moveActiveTabToSide}
            onRemoveSplit={removeSplit}
            onReorderTab={reorderTab}
            onSelectTab={selectTab}
            onToggleMaximize={toggleMaximize}
          />
        );
      })}
      <IframeDragGuardOverlay
        active={resizeCursor !== null}
        cursor={resizeCursor ?? "col-resize"}
      />
    </div>
  );
}
