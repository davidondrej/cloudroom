import {
  useCallback,
  useContext,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Button } from "@cloudroom/shared-ui/button";
import { useAtomValue } from "jotai";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Pill } from "@cloudroom/shared-ui/pill";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cloudroom/shared-ui/tooltip";
import type { ThreadPurpose } from "@cloudroom/domain";
import {
  AppPageHeader,
  COMPACT_SHELF_HIDDEN_PAGE_HEADER_ACTIONS_CLASS,
  HEADER_ICON_BUTTON_CLASS,
  HEADER_PANE_ACTION_ICON_BUTTON_CLASS,
} from "@/components/layout/AppPageHeader";
import {
  getBbDesktopInfo,
  MACOS_APP_REGION_NO_DRAG_CLASS,
  MACOS_WINDOW_NO_DRAG_CLASS,
  shouldUseMacosDesktopChrome,
} from "@/lib/bb-desktop";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { useAppCommandShortcut } from "@/components/commands/AppCommandProvider";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import { useInlineThreadTitle } from "@/components/thread/InlineThreadTitle";
import { useThreadActions } from "@/components/thread/ThreadActionsProvider";
import { ThreadPurposeHoverCard } from "@/components/thread/ThreadPurposeHoverCard";
import { ThreadTitleMentions } from "@/components/thread/ThreadTitleMentions";
import { SecondaryPanelHostLayoutContext } from "@/components/secondary-panel/SecondaryPanelHostLayoutContext";
import { RIGHT_PANEL_TOGGLE_ICON_NAME } from "@/components/secondary-panel/panelToggleControlState";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@cloudroom/shared-ui/chrome-style-tokens";
import { useIsCompactViewport } from "@cloudroom/shared-ui/hooks/use-compact-viewport";
import { dimInactiveSplitsAtom } from "@/lib/split-layout/atoms";
import {
  CONTEXT_INACTIVE_TEXT_CLASS,
  CONTEXT_SELECTION_SURFACE_CLASS,
} from "@/components/ui/context-selection";
import { usePaneContext } from "./PaneContext";
import { PaneMaximizeButton } from "./PaneMaximizeButton";

interface ThreadDetailHeaderProps {
  actionsMenu: ReactNode;
  childPillLabel: "child" | "side chat" | null;
  isSecondaryPanelOpen: boolean;
  onClosePane?: () => void;
  onToggleSecondaryPanel: () => void;
  onStartSideChat?: () => void;
  pluginActions?: ReactNode;
  shareButton?: ReactNode;
  threadId: string;
  threadPurpose?: ThreadPurpose | null;
  threadTitle: string;
}

export function ThreadDetailHeader({
  actionsMenu,
  childPillLabel,
  isSecondaryPanelOpen,
  onClosePane,
  onToggleSecondaryPanel,
  onStartSideChat,
  pluginActions,
  shareButton,
  threadId,
  threadPurpose = null,
  threadTitle,
}: ThreadDetailHeaderProps) {
  const isCompactViewport = useIsCompactViewport();
  const { renameThread } = useThreadActions();
  const handleRename = useCallback(
    (nextTitle: string) => {
      renameThread(threadId, nextTitle);
    },
    [renameThread, threadId],
  );
  const { editor, isEditing, startEditing } = useInlineThreadTitle({
    onCommit: handleRename,
    resetKey: threadId,
    title: threadTitle,
  });
  const [desktopInfo] = useState(getBbDesktopInfo);
  const dimsInactiveSplits = useAtomValue(dimInactiveSplitsAtom);
  const panelShortcut = useAppCommandShortcut("panel.toggle");
  const usesDesktopChrome = shouldUseMacosDesktopChrome(desktopInfo);
  const {
    beginPaneDrag,
    isFocused,
    isTopRow,
    ownsWindowTopLeft,
    reservesWindowPanelToggle,
    secondaryPanelHost,
  } = usePaneContext();
  const isWindowPanelOpen =
    useContext(SecondaryPanelHostLayoutContext)?.isOpen === true;
  const isSplitPaneHeader = beginPaneDrag !== undefined;
  const handleTitlePointerDown = (event: ReactPointerEvent) => {
    if (isEditing || !beginPaneDrag || event.button !== 0) {
      return;
    }
    beginPaneDrag(event, threadTitle);
  };
  const handleTitleDoubleClick = () => {
    if (isEditing) {
      return;
    }
    startEditing();
  };
  const rightPanelLabel = isSecondaryPanelOpen
    ? "Hide right panel"
    : "Show right panel";
  const rightPanelIconName = RIGHT_PANEL_TOGGLE_ICON_NAME;
  const showRightPanelToggle =
    secondaryPanelHost === null &&
    (!isSecondaryPanelOpen || isCompactViewport);

  const center = (
    <>
      <div
        data-pane-header-focus-tab={
          isSplitPaneHeader && isFocused ? "" : undefined
        }
        className={cn(
          "relative min-w-0",
          isSplitPaneHeader && "-my-1 -ml-2 rounded-md px-2 py-1",
          isSplitPaneHeader && isFocused && CONTEXT_SELECTION_SURFACE_CLASS,
        )}
      >
        <ThreadPurposeHoverCard purpose={isEditing ? null : threadPurpose}>
          <p
            className={cn(
              "relative min-w-0 text-xs font-normal text-foreground/70 transition-colors",
              isEditing ? "overflow-visible" : "bb-thread-title",
              usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
              isSplitPaneHeader &&
                !isFocused &&
                dimsInactiveSplits &&
                CONTEXT_INACTIVE_TEXT_CLASS,
              beginPaneDrag &&
                !isEditing &&
                cn(
                  "cursor-grab touch-none select-none",
                  usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
                ),
            )}
            onDoubleClick={handleTitleDoubleClick}
            onPointerDown={beginPaneDrag ? handleTitlePointerDown : undefined}
          >
            {isEditing ? editor : <ThreadTitleMentions title={threadTitle} />}
          </p>
        </ThreadPurposeHoverCard>
      </div>
      {childPillLabel ? (
        <Pill variant="outline" size="sm">
          {childPillLabel}
        </Pill>
      ) : null}
      {actionsMenu == null ? null : (
        <span
          data-testid="thread-detail-header-actions-menu"
          className={cn(
            "flex items-center",
            COMPACT_SHELF_HIDDEN_PAGE_HEADER_ACTIONS_CLASS,
            usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
          )}
        >
          {actionsMenu}
        </span>
      )}
    </>
  );

  const actions = (
    <>
      <div
        className="flex items-center gap-1"
        data-thread-header-workflow-actions=""
      >
        {shareButton}
        {pluginActions}
      </div>
      <div
        className="relative ml-1 flex items-center gap-0.5"
        data-thread-header-pane-actions=""
      >
        {onStartSideChat ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  HEADER_ICON_BUTTON_CLASS,
                  CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
                  "absolute right-0 top-full z-20 mt-2",
                  usesDesktopChrome && MACOS_APP_REGION_NO_DRAG_CLASS,
                )}
                aria-label="Side chat"
                onClick={onStartSideChat}
              >
                <Icon name="SideChat" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Side chat</TooltipContent>
          </Tooltip>
        ) : null}
        {showRightPanelToggle ? (
          <span className="inline-flex items-center gap-1.5">
            <AppCommandShortcutHint shortcut={panelShortcut} />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                HEADER_ICON_BUTTON_CLASS,
                CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
              )}
              aria-label={
                panelShortcut
                  ? `${rightPanelLabel} (${panelShortcut.label})`
                  : rightPanelLabel
              }
              aria-keyshortcuts={panelShortcut?.ariaKeyshortcuts}
              aria-expanded={isSecondaryPanelOpen}
              onClick={onToggleSecondaryPanel}
            >
              <Icon name={rightPanelIconName} />
            </Button>
          </span>
        ) : null}
        <PaneMaximizeButton />
        {onClosePane ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              HEADER_PANE_ACTION_ICON_BUTTON_CLASS,
              CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
            )}
            aria-label="Close pane"
            onClick={onClosePane}
          >
            <Icon name="CloseThreadPane" />
          </Button>
        ) : null}
        {reservesWindowPanelToggle && !isWindowPanelOpen ? (
          <span aria-hidden className={HEADER_ICON_BUTTON_CLASS} />
        ) : null}
      </div>
    </>
  );

  return (
    <AppPageHeader
      center={center}
      actions={actions}
      compact
      isWindowDragRegion={isTopRow}
      ownsWindowTopLeft={ownsWindowTopLeft}
      className={beginPaneDrag ? "z-[21]" : undefined}
    />
  );
}
