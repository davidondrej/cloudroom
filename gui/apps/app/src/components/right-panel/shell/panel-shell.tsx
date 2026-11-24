import {
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TransitionEvent,
} from "react";
import { useAtomValue } from "jotai";
import { Panel, type ImperativePanelHandle } from "react-resizable-panels";
import type { DiffFileEntry } from "@cloudroom/server-contract";
import { Button } from "@cloudroom/shared-ui/button";
import { EmptyStatePanel } from "@cloudroom/shared-ui/empty-state";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import type { DiffPresentation } from "@/components/code/code-rendering";
import { useAppCommandShortcut } from "@/components/commands/AppCommandProvider";
import { GitDiffToolbar } from "@/components/diff/diff-panel";
import {
  useGitDiffPanelState,
  useResponsiveGitDiffPanelDisplay,
} from "@/components/diff/diff-panel-hooks";
import {
  buildGitDiffIdentity,
  summarizeDiffFileEntries,
  useDiffFilesCollapseControls,
  type GitDiffTabStatus,
} from "@/components/diff/diff-store";
import { usePluginDetailPanelProps } from "@/components/plugin/plugin-detail-navigation";
import { SIDEBAR_FIXED_INFO_TAB_ID } from "@/components/right-panel/store/split-state";
import { threadSecondaryPanelResizingAtom } from "@/components/right-panel/store/panel-prefs";
import type {
  FixedPanelViewTab,
  SecondaryFixedPanelTab,
} from "@/components/right-panel/store/tab-model";
import type {
  MarketplacePluginDetailPanelTab,
  SecondaryPanelPaneRenderContext,
  SecondaryPanelRenderableTab,
  SecondaryPanelTabReorderHandler,
} from "@/components/right-panel/store/tab-ops";
import { ImageTabLightboxProvider } from "@/components/right-panel/tabs/image-lightbox";
import { useOptionalIsSidebarShowing } from "@/components/ui/sidebar.js";
import { useEnvironmentDiffFiles } from "@/hooks/queries/environment-queries";
import { useDesktopWindowState } from "@/hooks/useDesktopWindowState";
import { dispatchBrowserViewBoundsSync } from "@/lib/browser-view-bounds-sync";
import {
  DEFAULT_CODE_OVERFLOW_MODE,
  type CodeOverflowMode,
} from "@/lib/code-overflow-mode";
import { IframeDragGuardOverlay } from "@/lib/iframe-drag-guard";
import {
  MACOS_COLLAPSED_TOP_LEFT_RESERVE_CLASS,
  getRoomDesktopInfo,
  shouldReserveMacosTrafficLights,
  shouldUseMacosDesktopChrome,
} from "@/lib/room-desktop";
import type { SplitSide } from "@/lib/split-layout";
import { GitDiffTabContent } from "./diff-tab-host";
import {
  PanelEdgeResizeHandle,
  PanelTopChrome,
  getSecondaryPanelChromeStackClassName,
  type SecondaryPanelFixedTab,
} from "./panel-chrome";
import { useSecondaryPanelResize } from "./panel-resize";
import {
  CONVERSATION_COLLAPSED_PANEL_SIZE_PERCENT,
  PANEL_COLLAPSE_TRANSITION_CLASS,
  PANEL_SCROLL_SLOT_CLASS,
  SecondaryPanelHostLayoutContext,
  THREAD_SECONDARY_PANEL_MAX_SIZE_PERCENT,
  THREAD_SECONDARY_PANEL_MIN_SIZE_PERCENT,
  getCompactPanelPresentation,
  resolveConversationCollapseControl,
} from "./panel-tokens";
import {
  SidebarSplitContainer,
  type SidebarSplitPaneRenderArgs,
  type SidebarSplitTabDescriptor,
} from "./split-container";

export { getSecondaryPanelChromeStackClassName };
export type {
  SecondaryPanelFixedTab,
  SecondaryPanelPaneRenderContext,
  SecondaryPanelRenderableTab,
};

const EMPTY_FILES: readonly DiffFileEntry[] = [];
const RESIZABLE_STYLE: CSSProperties = { pointerEvents: "auto" };

export function isSecondaryPanelLayoutTransition(property: string): boolean {
  return property === "flex-grow" || property === "flex-basis";
}

export function resolveCollapsedPanelTrafficLightReserveClassName({
  isConversationCollapsed,
  renderAsDrawer,
  isSidebarShowing,
  reserveMacosTrafficLights,
}: {
  isConversationCollapsed: boolean;
  renderAsDrawer: boolean;
  isSidebarShowing: boolean | null;
  reserveMacosTrafficLights: boolean;
}): string | false {
  return (
    isConversationCollapsed &&
    !renderAsDrawer &&
    isSidebarShowing === false &&
    reserveMacosTrafficLights &&
    MACOS_COLLAPSED_TOP_LEFT_RESERVE_CLASS
  );
}

export interface ThreadSecondaryPanelProps {
  activeTab: SecondaryFixedPanelTab | MarketplacePluginDetailPanelTab | null;
  canUseGitUi: boolean;
  gitDiffTabStatus?: GitDiffTabStatus;
  onRetryGitDiffEligibility?: () => void;
  requestedMergeBaseBranch?: string;
  environmentId?: string;
  metadataContent: ReactNode;
  tabs: readonly SecondaryPanelRenderableTab[];
  fixedTabs: readonly SecondaryPanelFixedTab[];
  onTabReorder: SecondaryPanelTabReorderHandler;
  renderBrowserDeck?: (
    activeBrowserTabId: string | null,
    pane: SecondaryPanelPaneRenderContext,
  ) => ReactNode;
  splitPanelStateId?: string;
  isOpen: boolean;
  showConversationCollapseControl?: boolean;
  showNewTabButton?: boolean;
  inlinePanelToggle?: "button" | "hidden";
  resizablePanelId?: string;
  onPanelFocus: () => void;
  onCollapse: () => void;
  onClose: () => void;
  onClearPendingGitDiffIntent?: () => void;
  onOpenNewTab: () => void;
  pendingGitDiffCommitSha?: string | null;
  pendingGitDiffScrollPath?: string | null;
  workspaceRootPath?: string | null;
  onOpenFileInEditor?: (path: string) => void;
  onOpenFilePreview?: (path: string) => void;
  onSelectionAddToChat?: (text: string) => void;
  isConversationCollapsed: boolean;
  onToggleConversationCollapse: () => void;
  renderAsDrawer: boolean;
}

export function ThreadSecondaryPanel(props: ThreadSecondaryPanelProps) {
  const merged = usePluginDetailPanelProps(props);
  return <RightPanelInner {...merged} />;
}

function RightPanelInner(p: ThreadSecondaryPanelProps) {
  const {
    activeTab,
    canUseGitUi,
    gitDiffTabStatus,
    requestedMergeBaseBranch,
    environmentId,
    metadataContent,
    tabs,
    fixedTabs,
    onTabReorder,
    renderBrowserDeck,
    splitPanelStateId,
    isOpen,
    showConversationCollapseControl = true,
    showNewTabButton = true,
    inlinePanelToggle = "button",
    resizablePanelId = "thread-detail-secondary-panel",
    onPanelFocus,
    onCollapse,
    onClose,
    onClearPendingGitDiffIntent,
    onOpenNewTab,
    onRetryGitDiffEligibility,
    pendingGitDiffCommitSha,
    pendingGitDiffScrollPath,
    workspaceRootPath,
    onOpenFileInEditor,
    onOpenFilePreview,
    onSelectionAddToChat,
    isConversationCollapsed,
    onToggleConversationCollapse,
    renderAsDrawer,
  } = p;

  const diffStatus =
    gitDiffTabStatus ?? (canUseGitUi ? "eligible" : "ineligible");
  const newTabShortcut = useAppCommandShortcut("panel.newTab");
  const toggleShortcut = useAppCommandShortcut("panel.toggle");
  const diffShortcut = useAppCommandShortcut("diff.toggle");

  const visibleTabs = useMemo(
    () => tabs.filter((t) => t.isHidden !== true),
    [tabs],
  );
  const reserveCompactToggle =
    renderAsDrawer &&
    getCompactPanelPresentation(
      activeTab?.kind,
      fixedTabs[0]?.tab.kind ?? visibleTabs[0]?.tab.kind,
    ) === "full";

  const activeDyn =
    tabs.find((t) => t.tab.id === activeTab?.id) ??
    (activeTab === null && fixedTabs.length === 0 ? visibleTabs[0] : undefined);
  const activeFix =
    fixedTabs.find((f) => f.tab.id === activeTab?.id) ??
    (activeDyn === undefined ? fixedTabs[0] : undefined);

  const collapseControl =
    renderAsDrawer || !showConversationCollapseControl
      ? null
      : resolveConversationCollapseControl({
          isConversationCollapsed,
          onToggleConversationCollapse,
        });

  const responsiveDiff = useResponsiveGitDiffPanelDisplay({
    isSecondaryPanelOpen: isOpen,
  });
  const secondaryPanelRef = useRef<HTMLElement>(null!);
  const secondaryResizablePanelRef = useRef<ImperativePanelHandle | null>(null);
  const resizeHitTargetRef = useRef<HTMLSpanElement | null>(null);
  const { handleSecondaryPanelResize, persistedWidthPercent } =
    useSecondaryPanelResize({
      isSecondaryPanelOpen: isOpen,
      onPanelWidthChange: responsiveDiff.handleSecondaryPanelWidthChange,
      onResizeStart: responsiveDiff.handleSecondaryPanelResizeStart,
      resizeHitTargetRef,
      secondaryPanelRef,
      secondaryResizablePanelRef,
    });

  const expandedRef = useRef(false);
  useLayoutEffect(() => {
    expandedRef.current = false;
  }, [splitPanelStateId]);

  const onResizePanel = useCallback(
    (size: number) => {
      if (size > 0) expandedRef.current = true;
      handleSecondaryPanelResize(size);
    },
    [handleSecondaryPanelResize],
  );

  const hostLayout = useContext(SecondaryPanelHostLayoutContext);
  const onCollapsePanel = useCallback(() => {
    if (!isOpen || hostLayout?.isSuppressed || !expandedRef.current) return;
    expandedRef.current = false;
    onCollapse();
  }, [hostLayout?.isSuppressed, isOpen, onCollapse]);

  const onTransitionEnd = useCallback((ev: TransitionEvent<HTMLElement>) => {
    if (
      ev.target === ev.currentTarget &&
      isSecondaryPanelLayoutTransition(ev.propertyName)
    ) {
      dispatchBrowserViewBoundsSync();
    }
  }, []);

  const layoutOpen =
    (hostLayout?.isOpen ?? isOpen) && !hostLayout?.isSuppressed;
  const diffLive =
    diffStatus === "eligible" &&
    activeFix?.tab.kind === "git-diff" &&
    layoutOpen;

  const diffState = useGitDiffPanelState({
    environmentId,
    isDiffPanelActive: diffLive,
    requestedMergeBaseBranch,
    onClearPendingGitDiffIntent,
    pendingGitDiffCommitSha,
    pendingGitDiffScrollPath,
  });

  const diffFilesQuery = useEnvironmentDiffFiles(environmentId ?? "", {
    enabled:
      diffLive &&
      Boolean(environmentId) &&
      diffState.gitDiffTarget !== undefined,
    target: diffState.gitDiffTarget,
  });

  const files = useMemo(
    () =>
      diffFilesQuery.data?.outcome === "available"
        ? diffFilesQuery.data.files
        : EMPTY_FILES,
    [diffFilesQuery.data],
  );
  const mergeBaseRef =
    diffFilesQuery.data?.outcome === "available"
      ? diffFilesQuery.data.mergeBaseRef
      : null;
  const truncated =
    diffFilesQuery.data?.outcome === "available" &&
    diffFilesQuery.data.truncated;

  const diffIdentity = useMemo(
    () =>
      buildGitDiffIdentity({
        environmentId,
        mergeBaseRef,
        target: diffState.gitDiffTarget,
      }),
    [diffState.gitDiffTarget, environmentId, mergeBaseRef],
  );
  const stats = useMemo(() => summarizeDiffFileEntries(files), [files]);
  const collapseAll = useDiffFilesCollapseControls(diffIdentity, files);

  const resizing = useAtomValue(threadSecondaryPanelResizingAtom);
  const [desktopInfo] = useState(getRoomDesktopInfo);
  const [overflowMode, setOverflowMode] = useState<CodeOverflowMode>(
    DEFAULT_CODE_OVERFLOW_MODE,
  );
  const usesDesktopChrome = shouldUseMacosDesktopChrome(desktopInfo);
  const winState = useDesktopWindowState();
  const sidebarShowing = useOptionalIsSidebarShowing();
  const trafficReserve = resolveCollapsedPanelTrafficLightReserveClassName({
    isConversationCollapsed,
    renderAsDrawer,
    isSidebarShowing: sidebarShowing,
    reserveMacosTrafficLights: shouldReserveMacosTrafficLights({
      desktopInfo,
      windowState: winState,
    }),
  });

  const presentation = useMemo<DiffPresentation>(
    () => ({
      view: responsiveDiff.gitDiffDisplayMode,
      overflow: overflowMode,
      showLineNumbers: true,
    }),
    [overflowMode, responsiveDiff.gitDiffDisplayMode],
  );

  const onFocusCapture = (ev: FocusEvent<HTMLElement>) => {
    if (
      ev.relatedTarget instanceof Node &&
      ev.currentTarget.contains(ev.relatedTarget)
    )
      return;
    onPanelFocus();
  };

  const isPendingEligibility = (kind: FixedPanelViewTab["kind"] | undefined) =>
    kind === "git-diff" && (diffStatus === "loading" || diffStatus === "error");

  const renderPaneSurface = (args: {
    activeFixed: SecondaryPanelFixedTab | undefined;
    activeTabId: string | null;
    surfaceTabs: readonly SecondaryPanelRenderableTab[];
    surfaceFixedTabs: readonly SecondaryPanelFixedTab[];
    isFocused: boolean;
    isFullScreen?: boolean;
    onBeginTabDrag?: (tabId: string, e: ReactPointerEvent<HTMLElement>) => void;
    onFocusPane: () => void;
    onMoveActiveTabToSide?: (side: SplitSide) => void;
    onRemoveSplit?: () => void;
    onToggleFullScreen?: () => void;
    onReorder: SecondaryPanelTabReorderHandler;
    paneId: string | null;
    reserveLeading: boolean;
    reserveNewTab: boolean;
    showNewTab: boolean;
    showOuterControls: boolean;
    useArrangementBtn: boolean;
    useWindowChrome: boolean;
  }) => {
    const dynTab =
      args.surfaceTabs.find((t) => t.tab.id === args.activeTabId) ?? null;
    const visTabs = args.surfaceTabs.filter((t) => t.isHidden !== true);
    const paneCtx: SecondaryPanelPaneRenderContext = {
      isFocused: args.isFocused,
      onFocusPane: args.onFocusPane,
    };
    const isBrowser = dynTab?.tab.kind === "browser";
    const isTerminal = dynTab?.tab.kind === "terminal";
    const isDiff =
      args.activeFixed?.tab.kind === "git-diff" && diffStatus === "eligible";
    const diffPending = isPendingEligibility(args.activeFixed?.tab.kind);
    const fixedBody = args.activeFixed?.renderContent?.(paneCtx);

    const browserNode =
      renderBrowserDeck && (args.paneId === null || isBrowser)
        ? renderBrowserDeck(isBrowser ? dynTab.tab.id : null, paneCtx)
        : null;

    const diffToolbarNode =
      isDiff && dynTab === null ? (
        <GitDiffToolbar
          selectionValue={diffState.gitDiffSelectValue}
          selectionOptions={diffState.gitDiffSelectOptions}
          onSelectionChange={diffState.onGitDiffSelectionChange}
          isSelectorDisabled={
            diffFilesQuery.isLoading || diffState.gitDiffTarget === undefined
          }
          stats={stats}
          isTruncated={truncated}
          areAllFilesCollapsed={collapseAll.areAllCollapsed}
          isCollapseAllDisabled={
            !collapseAll.hasFiles || diffFilesQuery.isLoading
          }
          onToggleAllCollapsed={collapseAll.toggleAllCollapsed}
          displayMode={responsiveDiff.gitDiffDisplayMode}
          onDisplayModeChange={responsiveDiff.handleGitDiffDisplayModeChange}
          lineOverflowMode={overflowMode}
          onLineOverflowModeChange={setOverflowMode}
        />
      ) : null;

    return (
      <ImageTabLightboxProvider
        activeTabId={args.activeTabId}
        tabs={args.surfaceTabs}
      >
        <PanelTopChrome
          paneId={args.paneId}
          activeFixed={args.activeFixed}
          activeTabId={args.activeTabId}
          fixedTabs={args.surfaceFixedTabs}
          visibleTabs={visTabs}
          hasActiveDynamicTab={dynTab !== null}
          isOpen={isOpen}
          usesDesktopChrome={usesDesktopChrome}
          useWindowChrome={args.useWindowChrome}
          reserveCompactSidebarToggle={reserveCompactToggle}
          trafficLightReserve={trafficReserve}
          reserveLeading={args.reserveLeading}
          showNewTab={args.showNewTab}
          reserveNewTab={args.reserveNewTab}
          newTabShortcut={newTabShortcut}
          diffShortcut={diffShortcut}
          toggleShortcut={toggleShortcut}
          showOuterControls={args.showOuterControls}
          useArrangementBtn={args.useArrangementBtn}
          isFullScreen={args.isFullScreen}
          collapseControl={collapseControl}
          renderAsDrawer={renderAsDrawer}
          inlinePanelToggle={inlinePanelToggle}
          onBeginTabDrag={args.onBeginTabDrag}
          onReorder={args.onReorder}
          onOpenNewTab={onOpenNewTab}
          onMoveActiveTabToSide={args.onMoveActiveTabToSide}
          onToggleFullScreen={args.onToggleFullScreen}
          onRemoveSplit={args.onRemoveSplit}
          onClose={onClose}
          diffToolbar={diffToolbarNode}
        />

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-sidebar">
          {browserNode}
          {isBrowser ? null : dynTab ? (
            <div
              className={
                isTerminal || dynTab.contentFillsRegion
                  ? "min-h-0 flex-1 overflow-hidden"
                  : cn(PANEL_SCROLL_SLOT_CLASS, "pb-3")
              }
              data-file-preview-scroll-container={
                isTerminal || dynTab.contentFillsRegion ? undefined : ""
              }
            >
              {dynTab.renderContent(paneCtx) ?? (
                <EmptyStatePanel className="mx-4 rounded-lg">
                  No file preview content provided.
                </EmptyStatePanel>
              )}
            </div>
          ) : args.activeFixed && fixedBody !== undefined ? (
            <div
              className={
                args.activeFixed.contentFillsRegion
                  ? "flex min-h-0 flex-1 flex-col overflow-hidden"
                  : cn(PANEL_SCROLL_SLOT_CLASS, "p-4 pb-3")
              }
            >
              {fixedBody}
            </div>
          ) : diffPending ? (
            <EmptyStatePanel className="m-4 rounded-lg" role="status">
              {diffStatus === "error" ? (
                <div className="flex flex-col items-center gap-3 text-center">
                  <span>
                    Could not determine whether this workspace uses Git.
                  </span>
                  {onRetryGitDiffEligibility ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onRetryGitDiffEligibility}
                    >
                      Retry
                    </Button>
                  ) : null}
                </div>
              ) : (
                "Checking Git support…"
              )}
            </EmptyStatePanel>
          ) : isDiff ? (
            <GitDiffTabContent
              environmentId={environmentId}
              target={diffState.gitDiffTarget}
              isPanelOpen={layoutOpen}
              gitDiffPresentation={presentation}
              onClearPendingGitDiffIntent={onClearPendingGitDiffIntent}
              onOpenFileInEditor={onOpenFileInEditor}
              onOpenFilePreview={onOpenFilePreview}
              onSelectionAddToChat={onSelectionAddToChat}
              pendingGitDiffScrollPath={pendingGitDiffScrollPath}
              workspaceRootPath={workspaceRootPath}
            />
          ) : args.activeFixed?.tab.kind === "thread-info" ? (
            <div className="flex min-h-0 flex-1 flex-col">
              {metadataContent}
            </div>
          ) : (
            <EmptyStatePanel className="m-4 rounded-lg">
              This panel view is unavailable.
            </EmptyStatePanel>
          )}
        </div>
      </ImageTabLightboxProvider>
    );
  };

  const splitEnabled = !renderAsDrawer && splitPanelStateId !== undefined;
  const descriptors: SidebarSplitTabDescriptor[] = splitEnabled
    ? [
        ...fixedTabs.map((f) => ({
          id: f.tab.id,
          label: f.label,
          restoresPlacementAfterRemoval: true,
        })),
        ...visibleTabs.map((t) => ({
          id: t.tab.id,
          label: t.label,
          restoresPlacementAfterRemoval: t.tab.kind !== "new-tab",
        })),
      ]
    : [];

  const activeGlobalId =
    activeDyn?.tab.id ??
    activeFix?.tab.id ??
    fixedTabs[0]?.tab.id ??
    SIDEBAR_FIXED_INFO_TAB_ID;

  const content = splitEnabled ? (
    <SidebarSplitContainer
      key={splitPanelStateId}
      activeTabId={activeGlobalId}
      isFullScreen={isConversationCollapsed}
      onActivateTab={(id) => {
        const ft = fixedTabs.find((f) => f.tab.id === id);
        if (ft) ft.onSelect();
        else tabs.find((t) => t.tab.id === id)?.onSelect();
      }}
      onGlobalTabReorder={onTabReorder}
      onToggleFullScreen={onToggleConversationCollapse}
      panelStateId={splitPanelStateId}
      tabs={descriptors}
      renderPane={(pane: SidebarSplitPaneRenderArgs) => {
        const isSplit = pane.onRemoveSplit !== undefined;
        const paneTabs = pane.group.tabIds
          .map((id) => tabs.find((t) => t.tab.id === id))
          .filter((t): t is SecondaryPanelRenderableTab => t !== undefined)
          .map((t) => ({ ...t, onSelect: () => pane.onSelectTab(t.tab.id) }));
        const paneFixed = fixedTabs
          .filter((f) => pane.group.tabIds.includes(f.tab.id))
          .map((f) => ({ ...f, onSelect: () => pane.onSelectTab(f.tab.id) }));
        const activePaneFixed = paneFixed.find(
          (f) => f.tab.id === pane.group.activeTabId,
        );

        return renderPaneSurface({
          activeFixed: activePaneFixed,
          activeTabId: pane.group.activeTabId,
          surfaceTabs: paneTabs,
          surfaceFixedTabs: paneFixed,
          isFocused: pane.isFocused,
          isFullScreen: pane.isMaximized,
          onBeginTabDrag: pane.onBeginTabDrag,
          onFocusPane: pane.onFocusPane,
          onMoveActiveTabToSide: pane.onMoveActiveTabToSide,
          onRemoveSplit: pane.onRemoveSplit,
          onToggleFullScreen: pane.onToggleMaximize,
          onReorder: pane.onReorderTab,
          paneId: pane.paneId,
          reserveLeading: pane.isTopRow && pane.isLeftEdge,
          reserveNewTab: isSplit && !pane.isFocused && showNewTabButton,
          showNewTab: (!isSplit || pane.isFocused) && showNewTabButton,
          showOuterControls: pane.showOuterControls,
          useArrangementBtn: true,
          useWindowChrome: pane.isTopRow,
        });
      }}
    />
  ) : (
    renderPaneSurface({
      activeFixed: activeFix,
      activeTabId: activeDyn?.tab.id ?? activeTab?.id ?? null,
      surfaceTabs: tabs,
      surfaceFixedTabs: fixedTabs,
      isFocused: true,
      onFocusPane: onPanelFocus,
      onReorder: onTabReorder,
      paneId: null,
      reserveLeading: true,
      reserveNewTab: false,
      showNewTab: showNewTabButton,
      showOuterControls: true,
      useArrangementBtn: false,
      useWindowChrome: true,
    })
  );

  const aside = (
    <aside
      ref={secondaryPanelRef}
      aria-hidden={!isOpen}
      inert={!isOpen}
      onFocusCapture={onFocusCapture}
      style={
        !renderAsDrawer && !resizing
          ? {
              width: isConversationCollapsed
                ? "100%"
                : `var(--secondary-swipe-width, ${persistedWidthPercent}cqw)`,
            }
          : undefined
      }
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden bg-sidebar",
        renderAsDrawer
          ? "min-w-0 flex-1"
          : [
              "absolute inset-y-0 left-0",
              hostLayout === null &&
                !isConversationCollapsed &&
                "border-l border-border-seam",
              resizing && "right-0",
              !isOpen && "pointer-events-none",
            ],
      )}
    >
      {content}
      <IframeDragGuardOverlay active={resizing} cursor="col-resize" />
    </aside>
  );

  if (renderAsDrawer) return aside;

  return (
    <>
      <PanelEdgeResizeHandle
        isOpen={isOpen}
        isConversationCollapsed={isConversationCollapsed}
        matchesSplitDividers={hostLayout !== null}
        hitTargetRef={resizeHitTargetRef}
      />
      <Panel
        ref={secondaryResizablePanelRef}
        id={resizablePanelId}
        collapsible
        collapsedSize={0}
        defaultSize={
          layoutOpen
            ? isConversationCollapsed
              ? CONVERSATION_COLLAPSED_PANEL_SIZE_PERCENT
              : persistedWidthPercent
            : 0
        }
        minSize={THREAD_SECONDARY_PANEL_MIN_SIZE_PERCENT}
        maxSize={
          isConversationCollapsed
            ? CONVERSATION_COLLAPSED_PANEL_SIZE_PERCENT
            : THREAD_SECONDARY_PANEL_MAX_SIZE_PERCENT
        }
        onCollapse={onCollapsePanel}
        onResize={onResizePanel}
        onTransitionEnd={onTransitionEnd}
        order={2}
        style={RESIZABLE_STYLE}
        className={cn(
          "relative min-w-0 overflow-clip transition-[flex-grow,flex-basis]",
          PANEL_COLLAPSE_TRANSITION_CLASS,
        )}
      >
        {aside}
      </Panel>
    </>
  );
}
