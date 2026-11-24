import type {
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
} from "react";
import { useAtomValue } from "jotai";
import { PanelResizeHandle } from "react-resizable-panels";
import { Button } from "@cloudroom/shared-ui/button";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@cloudroom/shared-ui/chrome-style-tokens";
import {
  COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
  COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
} from "@cloudroom/shared-ui/coarse-pointer-sizing";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@cloudroom/shared-ui/tooltip";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import { HEADER_PANE_ACTION_ICON_BUTTON_CLASS } from "@/components/layout/AppPageHeader";
import { threadSecondaryPanelResizingAtom } from "@/components/right-panel/store/panel-prefs";
import type { FixedPanelViewTab } from "@/components/right-panel/store/tab-model";
import type {
  SecondaryPanelPaneRenderContext,
  SecondaryPanelRenderableTab,
  SecondaryPanelTabReorderHandler,
} from "@/components/right-panel/store/tab-ops";
import { TabPill } from "@/components/ui/tab-pill";
import type { AppShortcutPresentation } from "@/lib/app-keybindings";
import {
  CHROME_ROW_CLASS,
  MACOS_CHROME_CONTROL_AXIS_CLASS,
  MACOS_WINDOW_DRAG_CLASS,
  MACOS_WINDOW_NO_DRAG_CLASS,
} from "@/lib/room-desktop";
import type { SplitSide } from "@/lib/split-layout";
import { PaneArrangementButton } from "@/views/thread-detail/PaneMaximizeButton";
import {
  PANEL_COLLAPSE_TRANSITION_CLASS,
  PANEL_RESIZE_HANDLE_LAYER_CLASS,
  PANEL_RESIZE_HIT_TARGET_CLASS,
  RIGHT_PANEL_TOGGLE_ICON_NAME,
  SECONDARY_PANEL_TOP_CHROME_BACKGROUND_CLASS,
} from "./panel-tokens";
import { SecondaryPanelTabStrip } from "./tab-strip";

const CHROME_BTN = `${COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS} shrink-0 ${CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS}`;
const HIDE_BTN = `${COARSE_POINTER_HEADER_ICON_BUTTON_CLASS} shrink-0 ${CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS}`;

export interface SecondaryPanelFixedTab {
  ariaLabel: string;
  contentFillsRegion?: boolean;
  label: string;
  leadingVisual: ReactNode;
  onSelect: () => void;
  renderContent?: (pane: SecondaryPanelPaneRenderContext) => ReactNode;
  tab: FixedPanelViewTab;
  title: string;
}

export function getSecondaryPanelChromeStackClassName(
  hasDiffToolbar: boolean,
): string {
  return cn(
    "shrink-0 select-none",
    hasDiffToolbar && "flex flex-col",
    SECONDARY_PANEL_TOP_CHROME_BACKGROUND_CLASS,
  );
}

export function PanelEdgeResizeHandle({
  isOpen,
  isConversationCollapsed,
  matchesSplitDividers,
  hitTargetRef,
}: {
  isOpen: boolean;
  isConversationCollapsed: boolean;
  matchesSplitDividers: boolean;
  hitTargetRef: RefObject<HTMLSpanElement | null>;
}) {
  const resizing = useAtomValue(threadSecondaryPanelResizingAtom);
  const interactive = isOpen && !isConversationCollapsed;

  return (
    <PanelResizeHandle
      id="thread-detail-secondary-panel-handle"
      disabled={!interactive}
      data-panel-resize-snap-handle=""
      hitAreaMargins={{ coarse: 0, fine: 0 }}
      tabIndex={-1}
      aria-label="Resize thread and right panel"
      className={cn(
        "group relative shrink-0 overflow-visible transition-[width,opacity,background-color]",
        PANEL_RESIZE_HANDLE_LAYER_CLASS,
        PANEL_COLLAPSE_TRANSITION_CLASS,
        isConversationCollapsed ? "cursor-default" : "cursor-col-resize",
        matchesSplitDividers
          ? [
              "bg-border-seam hover:bg-ring/40",
              interactive
                ? "w-px opacity-100"
                : "pointer-events-none w-0 opacity-0",
              resizing && "bg-ring/40",
            ]
          : [
              "bg-transparent",
              interactive
                ? "w-0 opacity-100"
                : "pointer-events-none w-0 opacity-0",
              resizing && "bg-accent/20",
            ],
      )}
    >
      <span
        aria-hidden
        ref={hitTargetRef}
        data-panel-resize-hit-target=""
        className={PANEL_RESIZE_HIT_TARGET_CLASS}
      />
      {!matchesSplitDividers ? (
        <span
          className={cn(
            "pointer-events-none absolute inset-y-0 left-full z-10 w-px transition-colors",
            resizing
              ? "bg-accent-foreground/50"
              : "bg-border-seam group-hover:bg-accent-foreground/35",
          )}
        />
      ) : null}
    </PanelResizeHandle>
  );
}

export function PanelTopChrome({
  paneId,
  activeFixed,
  activeTabId,
  fixedTabs,
  visibleTabs,
  hasActiveDynamicTab,
  isOpen,
  usesDesktopChrome,
  useWindowChrome,
  reserveCompactSidebarToggle,
  trafficLightReserve,
  reserveLeading,
  showNewTab,
  reserveNewTab,
  newTabShortcut,
  diffShortcut,
  toggleShortcut,
  showOuterControls,
  useArrangementBtn,
  isFullScreen,
  collapseControl,
  renderAsDrawer,
  inlinePanelToggle,
  onBeginTabDrag,
  onReorder,
  onOpenNewTab,
  onMoveActiveTabToSide,
  onToggleFullScreen,
  onRemoveSplit,
  onClose,
  diffToolbar,
}: {
  paneId: string | null;
  activeFixed: SecondaryPanelFixedTab | undefined;
  activeTabId: string | null;
  fixedTabs: readonly SecondaryPanelFixedTab[];
  visibleTabs: readonly SecondaryPanelRenderableTab[];
  hasActiveDynamicTab: boolean;
  isOpen: boolean;
  usesDesktopChrome: boolean;
  useWindowChrome: boolean;
  reserveCompactSidebarToggle: boolean;
  trafficLightReserve: string | false;
  reserveLeading: boolean;
  showNewTab: boolean;
  reserveNewTab: boolean;
  newTabShortcut: AppShortcutPresentation | null;
  diffShortcut: AppShortcutPresentation | null;
  toggleShortcut: AppShortcutPresentation | null;
  showOuterControls: boolean;
  useArrangementBtn: boolean;
  isFullScreen?: boolean;
  collapseControl: {
    label: string;
    isFullScreen: boolean;
    iconName: "Maximize2" | "Minimize2";
    onClick: () => void;
  } | null;
  renderAsDrawer: boolean;
  inlinePanelToggle: "button" | "hidden";
  onBeginTabDrag?: (tabId: string, e: ReactPointerEvent<HTMLElement>) => void;
  onReorder: SecondaryPanelTabReorderHandler;
  onOpenNewTab: () => void;
  onMoveActiveTabToSide?: (side: SplitSide) => void;
  onToggleFullScreen?: () => void;
  onRemoveSplit?: () => void;
  onClose: () => void;
  diffToolbar: ReactNode;
}) {
  const noDrag = usesDesktopChrome ? MACOS_WINDOW_NO_DRAG_CLASS : undefined;
  const newTabLabel = onRemoveSplit
    ? "Open new tab in this pane"
    : "Open new tab";

  return (
    <div
      className={getSecondaryPanelChromeStackClassName(Boolean(diffToolbar))}
    >
      <div
        data-testid="thread-secondary-panel-top-chrome"
        className={cn(
          CHROME_ROW_CLASS,
          "min-w-0 justify-between gap-2 px-4",
          reserveCompactSidebarToggle && "pl-14",
          usesDesktopChrome && useWindowChrome && MACOS_WINDOW_DRAG_CLASS,
          usesDesktopChrome &&
            useWindowChrome &&
            MACOS_CHROME_CONTROL_AXIS_CLASS,
        )}
      >
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1 transition-[padding]",
            PANEL_COLLAPSE_TRANSITION_CLASS,
            reserveLeading && trafficLightReserve,
          )}
          data-sidebar-split-tab-group={paneId ?? undefined}
          role="toolbar"
          aria-label="Right panel views"
        >
          {fixedTabs.map((ft) => {
            const sc = ft.tab.kind === "git-diff" ? diffShortcut : null;
            return (
              <Tooltip key={ft.tab.id}>
                <TooltipTrigger asChild>
                  <div
                    data-testid={
                      ft.label === "Info" ? "thread-info-tab" : undefined
                    }
                    className={cn("shrink-0", noDrag)}
                    onPointerDown={
                      onBeginTabDrag
                        ? (e) => onBeginTabDrag(ft.tab.id, e)
                        : undefined
                    }
                  >
                    <TabPill
                      label={ft.label}
                      ariaLabel={
                        sc ? `${ft.ariaLabel} (${sc.label})` : ft.ariaLabel
                      }
                      ariaKeyshortcuts={sc?.ariaKeyshortcuts}
                      iconOnly
                      leadingVisual={ft.leadingVisual}
                      title={ft.title}
                      isActive={
                        activeFixed?.tab.id === ft.tab.id &&
                        !hasActiveDynamicTab
                      }
                      onSelect={ft.onSelect}
                      closeAction={null}
                    />
                  </div>
                </TooltipTrigger>
                <TooltipContent>{ft.title}</TooltipContent>
              </Tooltip>
            );
          })}

          {visibleTabs.length > 0 ? (
            <SecondaryPanelTabStrip
              activeTabId={activeTabId}
              tabs={visibleTabs}
              onBeginTabDrag={onBeginTabDrag}
              onReorderTab={onReorder}
              usesDesktopChrome={usesDesktopChrome}
              isPanelOpen={isOpen}
            />
          ) : null}

          {showNewTab ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(CHROME_BTN, noDrag)}
              onClick={onOpenNewTab}
              aria-label={
                newTabShortcut
                  ? `${newTabLabel} (${newTabShortcut.label})`
                  : newTabLabel
              }
              aria-keyshortcuts={newTabShortcut?.ariaKeyshortcuts}
            >
              <Icon name="Plus" />
            </Button>
          ) : reserveNewTab ? (
            <div
              aria-hidden
              data-new-tab-control-reserved=""
              className={cn(CHROME_BTN, noDrag)}
            />
          ) : null}
        </div>

        {showOuterControls || onRemoveSplit || useArrangementBtn ? (
          <div
            className="flex min-w-0 shrink-0 items-center gap-1"
            onPointerDown={(e) => e.stopPropagation()}
          >
            {useArrangementBtn ? (
              onToggleFullScreen ? (
                <PaneArrangementButton
                  className={cn("shrink-0", noDrag)}
                  isFullScreen={isFullScreen ?? false}
                  onMoveToSide={onMoveActiveTabToSide}
                  onToggleFullScreen={onToggleFullScreen}
                />
              ) : null
            ) : showOuterControls && collapseControl ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={cn(
                      HEADER_PANE_ACTION_ICON_BUTTON_CLASS,
                      CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
                      "shrink-0",
                      noDrag,
                    )}
                    onClick={collapseControl.onClick}
                    aria-label={collapseControl.label}
                    aria-pressed={collapseControl.isFullScreen}
                  >
                    <Icon name={collapseControl.iconName} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{collapseControl.label}</TooltipContent>
              </Tooltip>
            ) : null}

            {onRemoveSplit ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  HEADER_PANE_ACTION_ICON_BUTTON_CLASS,
                  CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
                  "shrink-0",
                  noDrag,
                )}
                aria-label="Remove split"
                onClick={onRemoveSplit}
              >
                <Icon name="CloseThreadPane" />
              </Button>
            ) : null}

            {showOuterControls &&
            (renderAsDrawer || inlinePanelToggle === "button") ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(HIDE_BTN, "relative", noDrag)}
                onClick={onClose}
                aria-label={
                  toggleShortcut
                    ? `Hide right panel (${toggleShortcut.label})`
                    : "Hide right panel"
                }
                aria-keyshortcuts={toggleShortcut?.ariaKeyshortcuts}
              >
                <Icon name={RIGHT_PANEL_TOGGLE_ICON_NAME} />
                <AppCommandShortcutHint
                  shortcut={toggleShortcut}
                  className="absolute right-full mr-1"
                />
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {diffToolbar}
    </div>
  );
}
