import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Key,
  type ReactNode,
} from "react";
import { useAtomValue } from "jotai";
import {
  Panel,
  PanelGroup,
  type ImperativePanelGroupHandle,
} from "react-resizable-panels";
import { useIsCompactViewport } from "@cloudroom/shared-ui/hooks/use-compact-viewport";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { useResponsiveDrawerRealization } from "@cloudroom/shared-ui/responsive-overlay";
import type { PluginComposerHost } from "@/components/plugin/plugin-composer-host";
import { secondaryPanelWidthPercentAtom } from "@/components/right-panel/store/panel-prefs";
import {
  isCompactSidebarDrawerShowing,
  subscribeCompactSidebarDrawerShowing,
} from "@/components/ui/sidebar-mobile-drawer-visibility";
import { dispatchBrowserViewBoundsSync } from "@/lib/browser-view-bounds-sync";
import {
  useOptionalPaneContext,
  usePaneSecondaryPanelRegistration,
  type PaneSecondaryPanelViewModel,
} from "@/views/thread-detail/PaneContext";
import { CompactSecondaryPanelShelf } from "./mobile-drawer";
import {
  PANEL_COLLAPSE_TRANSITION_CLASS,
  getPanelCollapseTransitionStyle,
  usePanelCollapseTransitionsReady,
} from "./panel-tokens";

const noop = () => {};

export interface SecondaryPanelRenderArgs {
  presentation: "inline" | "drawer";
  canShowNativeBrowserView: boolean;
  isMainCollapsed: boolean;
  onToggleMainCollapse: () => void;
  resizablePanelId?: string;
}

export function SecondaryPanelLayout({
  open,
  onToggle,
  onClose,
  panelGroupKey,
  resetKey,
  contentKey,
  drawerLabel,
  drawerFallback,
  mainPanelId,
  mainHeader,
  main,
  collapse,
  renderPanel,
  renderHostedPanel,
  composerHost,
  compactPresentation,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  panelGroupKey?: Key;
  resetKey: Key;
  contentKey: string;
  drawerLabel: string;
  drawerFallback: ReactNode;
  mainPanelId: string;
  mainHeader?: ReactNode;
  main: ReactNode;
  collapse?: { active: boolean; onToggle: () => void };
  renderPanel: (args: SecondaryPanelRenderArgs) => ReactNode;
  renderHostedPanel?: (panel: ReactNode) => ReactNode;
  composerHost: PluginComposerHost | null;
  compactPresentation: "shelf" | "full";
}) {
  const paneCtx = useOptionalPaneContext();
  const host = paneCtx?.secondaryPanelHost ?? null;
  const isDrawer = useIsCompactViewport();

  const sidebarOpen = useSyncExternalStore(
    subscribeCompactSidebarDrawerShowing,
    isCompactSidebarDrawerShowing,
    () => false,
  );
  const prevSidebarRef = useRef(sidebarOpen);
  useEffect(() => {
    const justOpened = sidebarOpen && !prevSidebarRef.current;
    prevSidebarRef.current = sidebarOpen;
    if (isDrawer && open && justOpened) onClose();
  }, [isDrawer, onClose, open, sidebarOpen]);

  const transitionsReady = usePanelCollapseTransitionsReady(
    resetKey,
    !isDrawer,
  );
  const savedWidth = useAtomValue(secondaryPanelWidthPercentAtom);
  const savedWidthRef = useRef(savedWidth);
  useLayoutEffect(() => {
    savedWidthRef.current = savedWidth;
  }, [savedWidth]);

  const mainCollapsed = open && !isDrawer && collapse?.active === true;
  const groupRef = useRef<ImperativePanelGroupHandle | null>(null);

  useLayoutEffect(() => {
    const grp = groupRef.current;
    if (!grp || isDrawer || grp.getLayout().length !== 2) return;
    if (!open) grp.setLayout([100, 0]);
    else if (mainCollapsed) grp.setLayout([0, 100]);
    else {
      const w = savedWidthRef.current;
      grp.setLayout([100 - w, w]);
    }
  }, [isDrawer, mainCollapsed, open]);

  const [drawerSettled, setDrawerSettled] = useState(false);
  const { isContentRealized, realizeContent } = useResponsiveDrawerRealization({
    open,
    enabled: isDrawer,
  });

  const settleRef = useRef({
    raf: null as number | null,
    seq: 0,
    open,
    isDrawer,
    resetKey,
  });
  useLayoutEffect(() => {
    settleRef.current.open = open;
    settleRef.current.isDrawer = isDrawer;
    settleRef.current.resetKey = resetKey;
  }, [isDrawer, open, resetKey]);

  const abortSettle = useCallback(() => {
    settleRef.current.seq += 1;
    if (settleRef.current.raf !== null) {
      window.cancelAnimationFrame(settleRef.current.raf);
      settleRef.current.raf = null;
    }
  }, []);

  useLayoutEffect(() => {
    abortSettle();
    setDrawerSettled(false);
  }, [abortSettle, isDrawer, open, resetKey]);

  useLayoutEffect(() => () => abortSettle(), [abortSettle]);

  const onDrawerSettled = useCallback(
    (endedOpen: boolean) => {
      const s = settleRef.current;
      if (!endedOpen || !s.open || !s.isDrawer) return;
      abortSettle();
      const seq = s.seq;
      const key = s.resetKey;
      s.raf = window.requestAnimationFrame(() => {
        s.raf = null;
        if (s.seq !== seq || s.resetKey !== key || !s.open || !s.isDrawer)
          return;
        dispatchBrowserViewBoundsSync();
        if (s.seq === seq && s.resetKey === key && s.open && s.isDrawer) {
          setDrawerSettled(true);
          realizeContent();
        }
      });
    },
    [abortSettle, realizeContent],
  );

  const canShowBrowser = isDrawer
    ? open && drawerSettled
    : open && (host === null || paneCtx?.isFocused === true);

  const panelId =
    host && paneCtx
      ? `thread-detail-secondary-panel-${paneCtx.paneId}`
      : undefined;
  const toggleCollapse = collapse?.onToggle ?? noop;

  const inlinePanel = useMemo(
    () =>
      isDrawer
        ? null
        : renderPanel({
            presentation: "inline",
            canShowNativeBrowserView: canShowBrowser,
            isMainCollapsed: mainCollapsed,
            onToggleMainCollapse: toggleCollapse,
            resizablePanelId: panelId,
          }),
    [
      canShowBrowser,
      isDrawer,
      mainCollapsed,
      panelId,
      renderPanel,
      toggleCollapse,
    ],
  );

  const drawerPanel = useMemo(
    () =>
      isDrawer
        ? renderPanel({
            presentation: "drawer",
            canShowNativeBrowserView: canShowBrowser,
            isMainCollapsed: false,
            onToggleMainCollapse: toggleCollapse,
          })
        : null,
    [canShowBrowser, isDrawer, renderPanel, toggleCollapse],
  );

  const hostedModel = useMemo<PaneSecondaryPanelViewModel>(
    () => ({
      composerHost,
      contentKey,
      isMainCollapsed: mainCollapsed,
      isOpen: open,
      panel: renderHostedPanel ? renderHostedPanel(inlinePanel) : inlinePanel,
      onToggle,
      transitionsReady,
    }),
    [
      composerHost,
      contentKey,
      inlinePanel,
      mainCollapsed,
      onToggle,
      open,
      renderHostedPanel,
      transitionsReady,
    ],
  );
  usePaneSecondaryPanelRegistration(host, hostedModel);

  const mainNode = (
    <div
      data-split-pane-id={host === null ? paneCtx?.paneId : undefined}
      inert={mainCollapsed}
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col transition-opacity",
        host === null && "h-full",
        PANEL_COLLAPSE_TRANSITION_CLASS,
        mainCollapsed && "opacity-0",
      )}
    >
      {host === null ? mainHeader : null}
      {main}
    </div>
  );

  if (host !== null) {
    return (
      <>
        {mainHeader}
        {mainNode}
      </>
    );
  }

  return (
    <>
      <div className="flex min-h-0 w-full min-w-0 flex-1">
        <PanelGroup
          key={panelGroupKey ?? resetKey}
          ref={groupRef}
          data-split-resize-grid-root=""
          direction="horizontal"
          className="@container h-full min-w-0 flex-1"
          style={{
            overflow: "clip",
            ...getPanelCollapseTransitionStyle(transitionsReady),
          }}
        >
          <Panel
            id={mainPanelId}
            {...(collapse ? { collapsible: true, collapsedSize: 0 } : {})}
            defaultSize={
              mainCollapsed ? 0 : open && !isDrawer ? 100 - savedWidth : 100
            }
            minSize={30}
            order={1}
            className={cn(
              "min-w-0 overflow-clip transition-[flex-grow,flex-basis]",
              PANEL_COLLAPSE_TRANSITION_CLASS,
            )}
          >
            {mainNode}
          </Panel>
          {inlinePanel}
        </PanelGroup>
      </div>
      {isDrawer ? (
        <CompactSecondaryPanelShelf
          open={open}
          onClose={onClose}
          presentation={compactPresentation}
          srLabel={drawerLabel}
          onContentAnimationEnd={onDrawerSettled}
        >
          {isContentRealized ? drawerPanel : drawerFallback}
        </CompactSecondaryPanelShelf>
      ) : null}
    </>
  );
}
