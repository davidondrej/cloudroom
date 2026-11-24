import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { useIsSidebarShowing } from "@/components/ui/sidebar.js";
import {
  COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
  COARSE_POINTER_HEADER_REDUCED_GLYPH_ICON_BUTTON_CLASS,
} from "@cloudroom/shared-ui/coarse-pointer-sizing";
import { useIsCompactViewport } from "@cloudroom/shared-ui/hooks/use-compact-viewport";
import {
  BROWSER_COLLAPSED_HEADER_RESERVE_CLASS,
  CHROME_ROW_CLASS,
  CHROME_ROW_HEIGHT_CLASS,
  getRoomDesktopInfo,
  MACOS_CHROME_CONTROL_AXIS_CLASS,
  MACOS_COLLAPSED_TOP_LEFT_RESERVE_CLASS,
  MACOS_WINDOW_DRAG_CLASS,
  MACOS_WINDOW_NO_DRAG_CLASS,
  shouldReserveMacosTrafficLights,
  shouldUseMacosDesktopChrome,
} from "@/lib/room-desktop";
import { useBrandMark } from "@/hooks/useBrandMark";
import { useDesktopWindowState } from "@/hooks/useDesktopWindowState";
import { observeSharedResize } from "@/lib/shared-resize-observer";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { BrandMark } from "./BrandMark";

export const HEADER_ICON_BUTTON_CLASS = COARSE_POINTER_HEADER_ICON_BUTTON_CLASS;

export const HEADER_PANE_ACTION_ICON_BUTTON_CLASS =
  COARSE_POINTER_HEADER_REDUCED_GLYPH_ICON_BUTTON_CLASS;

export const HEADER_SEAM_CLASS = "border-b border-border-seam-vertical/60";

export const APP_PAGE_HEADER_SURFACE_CLASS = "bg-surface-scrim";

export const COMPACT_SHELF_HIDDEN_PAGE_HEADER_ACTIONS_CLASS =
  "group-data-[panel-shelf=open]/page-inset:invisible group-data-[panel-shelf=shelf]/page-inset:invisible";

// Below this row width the title and actions need the space, so the name hides.
const BRAND_MARK_MIN_ROW_WIDTH = 640;

interface AppPageHeaderProps {
  center?: ReactNode;
  actions?: ReactNode;
  className?: string;
  compact?: boolean;
  headerRef?: Ref<HTMLElement>;
  isWindowDragRegion?: boolean;
  ownsWindowTopLeft?: boolean;
}

export function AppPageHeader({
  center,
  actions,
  className,
  compact = false,
  headerRef,
  isWindowDragRegion = true,
  ownsWindowTopLeft = true,
}: AppPageHeaderProps) {
  const isSidebarShowing = useIsSidebarShowing();
  const isCompactViewport = useIsCompactViewport();
  const [desktopInfo] = useState(getRoomDesktopInfo);
  const desktopWindowState = useDesktopWindowState();
  const usesDesktopChrome = shouldUseMacosDesktopChrome(desktopInfo);
  const reserveMacosTrafficLights = shouldReserveMacosTrafficLights({
    desktopInfo,
    windowState: desktopWindowState,
  });
  const shouldReserveSidebarTrigger =
    ownsWindowTopLeft && (isCompactViewport || !isSidebarShowing);
  const [brandMarkEnabled] = useBrandMark();
  const wantsBrandMark =
    brandMarkEnabled && ownsWindowTopLeft && !isCompactViewport;
  const rowRef = useRef<HTMLDivElement>(null);
  const [rowHasRoom, setRowHasRoom] = useState(false);
  useEffect(() => {
    const row = rowRef.current;
    if (!wantsBrandMark || row === null) {
      return;
    }
    const read = () => row.clientWidth >= BRAND_MARK_MIN_ROW_WIDTH;
    setRowHasRoom(read());
    return observeSharedResize(row, { read, write: setRowHasRoom });
  }, [wantsBrandMark]);
  const showBrandMark = wantsBrandMark && rowHasRoom;
  const topLeftReserveClass = shouldReserveSidebarTrigger
    ? reserveMacosTrafficLights
      ? MACOS_COLLAPSED_TOP_LEFT_RESERVE_CLASS
      : BROWSER_COLLAPSED_HEADER_RESERVE_CLASS
    : undefined;
  return (
    <header
      ref={headerRef}
      className={cn(
        CHROME_ROW_HEIGHT_CLASS,
        !compact && HEADER_SEAM_CLASS,
        APP_PAGE_HEADER_SURFACE_CLASS,
        "relative shrink-0 select-none px-4",
        usesDesktopChrome && isWindowDragRegion && MACOS_WINDOW_DRAG_CLASS,
        className,
      )}
    >
      <div
        ref={rowRef}
        data-testid="app-page-header-content-row"
        className={cn(
          CHROME_ROW_CLASS,
          "relative z-10 gap-1 md:gap-2",
          usesDesktopChrome && MACOS_CHROME_CONTROL_AXIS_CLASS,
          // With the name shown, the reserve moves inside the left side so
          // the name stays centered on the header.
          !showBrandMark && topLeftReserveClass,
        )}
      >
        {center ? (
          <div className="flex min-w-0 flex-1 items-center">
            <div
              className={cn(
                "flex min-w-0 max-w-full items-center gap-2",
                showBrandMark && topLeftReserveClass,
              )}
            >
              {center}
            </div>
          </div>
        ) : (
          <div className="min-w-0 flex-1" />
        )}
        {showBrandMark ? <BrandMark /> : null}
        {actions ? (
          <div
            data-app-page-header-actions=""
            className={cn(
              "flex shrink-0 items-center gap-1",
              // Grows like the left side, so the name sits in the middle.
              showBrandMark && "flex-1 justify-end",
              COMPACT_SHELF_HIDDEN_PAGE_HEADER_ACTIONS_CLASS,
              usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
            )}
          >
            {actions}
          </div>
        ) : showBrandMark ? (
          <div className="flex-1" />
        ) : null}
      </div>
    </header>
  );
}
