import {
  createContext,
  useEffect,
  useState,
  type CSSProperties,
  type Key,
} from "react";

export const SECONDARY_PANEL_TOP_CHROME_BACKGROUND_CLASS = "bg-sidebar";
export const PANEL_SCROLL_SLOT_CLASS =
  "min-h-0 flex-1 overflow-x-auto overflow-y-auto";

export const THREAD_SECONDARY_PANEL_MIN_SIZE_PERCENT = 24;
export const THREAD_SECONDARY_PANEL_MAX_SIZE_PERCENT = 70;
export const CONVERSATION_COLLAPSED_PANEL_SIZE_PERCENT = 100;

export const RIGHT_PANEL_TOGGLE_ICON_NAME = "PanelRight" as const;

export const PANEL_COLLAPSE_TRANSITION_CLASS =
  "duration-[var(--panel-collapse-duration,220ms)] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none";
export const PANEL_RESIZE_HANDLE_LAYER_CLASS = "z-[25]";
export const PANEL_RESIZE_HIT_TARGET_CLASS =
  "absolute inset-y-0 left-1/2 z-10 w-4 -translate-x-1/2 touch-none cursor-col-resize pointer-coarse:w-8 bg-transparent";

export interface SecondaryPanelHostLayout {
  isOpen: boolean;
  isSuppressed: boolean;
  pinsCornerToggle: boolean;
}

export const SecondaryPanelHostLayoutContext =
  createContext<SecondaryPanelHostLayout | null>(null);

export function getPanelCollapseTransitionStyle(
  ready: boolean,
): CSSProperties & { "--panel-collapse-duration": string } {
  return { "--panel-collapse-duration": ready ? "220ms" : "0ms" };
}

export function usePanelCollapseTransitionsReady(
  resetKey: Key,
  enabled: boolean,
): boolean {
  const [settledKey, setSettledKey] = useState<Key | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let frame2: number | null = null;
    const frame1 = window.requestAnimationFrame(() => {
      frame2 = window.requestAnimationFrame(() => {
        setSettledKey(resetKey);
      });
    });
    return () => {
      window.cancelAnimationFrame(frame1);
      if (frame2 !== null) window.cancelAnimationFrame(frame2);
    };
  }, [enabled, resetKey]);

  return !enabled || settledKey === resetKey;
}

export function resolveConversationCollapseControl({
  isConversationCollapsed,
  onToggleConversationCollapse,
}: {
  isConversationCollapsed: boolean;
  onToggleConversationCollapse: () => void;
}): {
  label: string;
  isFullScreen: boolean;
  iconName: "Maximize2" | "Minimize2";
  onClick: () => void;
} {
  return isConversationCollapsed
    ? {
        label: "Exit Full Screen",
        iconName: "Minimize2",
        isFullScreen: true,
        onClick: onToggleConversationCollapse,
      }
    : {
        label: "Full Screen",
        iconName: "Maximize2",
        isFullScreen: false,
        onClick: onToggleConversationCollapse,
      };
}

export function getCompactPanelPresentation(
  activeTabKind: string | undefined,
  fallbackTabKind?: string,
): "shelf" | "full" {
  const kind = activeTabKind ?? fallbackTabKind;
  return kind === undefined || kind === "thread-info" ? "shelf" : "full";
}
