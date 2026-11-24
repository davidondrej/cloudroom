import { COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS } from "@cloudroom/shared-ui/coarse-pointer-sizing";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import type { ClientRect, Modifier } from "@dnd-kit/core";
import { useMemo } from "react";
import type { CSSProperties } from "react";
import {
  getSidebarThreadRowPaddingLeft,
  SIDEBAR_ROW_BASE_CLASS,
} from "./sidebarRowClasses";

export const SIDEBAR_THREAD_DRAG_CHIP_CLASS = cn(
  SIDEBAR_ROW_BASE_CLASS,
  COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS,
  "pointer-events-none w-fit max-w-56 bg-sidebar-accent pr-2 text-sidebar-accent-foreground shadow-sm ring-1 ring-sidebar-border",
);

export const SIDEBAR_THREAD_DRAG_CHIP_STYLE = {
  paddingLeft: `${getSidebarThreadRowPaddingLeft(0)}px`,
} satisfies CSSProperties;

// The viewport point of a touch, mouse, or pointer event; null for others, such
// as key presses. Ported from @dnd-kit/utilities' getEventCoordinates, with its
// TouchEvent check against the target's own window (for iframes).
function getEventCoordinates(event: Event): { x: number; y: number } | null {
  const view =
    (event.target as Node | null)?.ownerDocument?.defaultView ?? window;
  if (
    typeof view.TouchEvent === "function" &&
    event instanceof view.TouchEvent
  ) {
    const touch = event.touches[0] ?? event.changedTouches[0];
    if (touch) return { x: touch.clientX, y: touch.clientY };
  }
  if (!("clientX" in event && "clientY" in event)) return null;
  const { clientX: x, clientY: y } = event as MouseEvent;
  return { x, y };
}

export function createSnapSidebarThreadDragChipToCursor(): Modifier {
  let overlayOriginRect: ClientRect | null = null;
  return ({
    activatorEvent,
    active,
    activeNodeRect,
    draggingNodeRect,
    transform,
  }) => {
    if (active === null) {
      overlayOriginRect = null;
      return transform;
    }
    overlayOriginRect ??= activeNodeRect;
    if (
      overlayOriginRect === null ||
      draggingNodeRect === null ||
      activatorEvent === null
    ) {
      return transform;
    }
    const coordinates = getEventCoordinates(activatorEvent);
    if (coordinates === null) return transform;
    return {
      ...transform,
      x:
        transform.x +
        coordinates.x -
        overlayOriginRect.left -
        draggingNodeRect.width / 2,
      y:
        transform.y +
        coordinates.y -
        overlayOriginRect.top -
        draggingNodeRect.height / 2,
    };
  };
}

export function useSidebarThreadDragOverlayModifiers(): Modifier[] {
  return useMemo(() => [createSnapSidebarThreadDragChipToCursor()], []);
}
