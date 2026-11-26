import { useState, type MouseEvent as ReactMouseEvent } from "react";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { useCloseMobileSidebar } from "@/components/ui/sidebar.js";
import {
  CHROME_ROW_CLASS,
  getRoomDesktopInfo,
  MACOS_CHROME_CONTROL_NO_DRAG_CLASS,
  MACOS_WINDOW_DRAG_CLASS,
  shouldReserveMacosTrafficLights,
  shouldUseMacosDesktopChrome,
} from "@/lib/room-desktop";
import { useDesktopWindowState } from "@/hooks/useDesktopWindowState";
import { SidebarHistoryNavigationControls } from "./SidebarHistoryNavigationControls";

export function SidebarTopReserveRow({ testId }: { testId: string }) {
  const closeOnMobile = useCloseMobileSidebar();
  const [desktopInfo] = useState(getRoomDesktopInfo);
  const desktopWindowState = useDesktopWindowState();
  const usesDesktopChrome = shouldUseMacosDesktopChrome(desktopInfo);
  const controlsLiveInWindowCapsule = shouldReserveMacosTrafficLights({
    desktopInfo,
    windowState: desktopWindowState,
  });

  return (
    <div
      data-testid={testId}
      className={cn(
        CHROME_ROW_CLASS,
        "shrink-0 justify-end px-2",
        usesDesktopChrome && MACOS_WINDOW_DRAG_CLASS,
      )}
    >
      {controlsLiveInWindowCapsule ? null : (
        <SidebarHistoryNavigationControls
          onNavigate={closeOnMobile}
          className={
            usesDesktopChrome ? MACOS_CHROME_CONTROL_NO_DRAG_CLASS : undefined
          }
        />
      )}
    </div>
  );
}

export function SidebarResizeHandle({
  isResizing,
  onMouseDown,
  testId,
}: {
  isResizing: boolean;
  onMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "absolute -right-1.5 top-0 z-30 hidden h-full w-3 cursor-col-resize md:block",
        // Neutral gray, not the brand-tinted border. The mask fades the line out before the card's 14px corners.
        "before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors hover:before:bg-sidebar-foreground/50",
        "before:[mask-image:linear-gradient(to_bottom,transparent_14px,black_72px,black_calc(100%-72px),transparent_calc(100%-14px))]",
        isResizing && "before:bg-sidebar-foreground/50",
      )}
      onMouseDown={onMouseDown}
    />
  );
}
