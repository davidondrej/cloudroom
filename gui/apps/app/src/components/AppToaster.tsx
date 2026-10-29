import type { CSSProperties } from "react";
import { Toaster, type ToasterProps } from "sonner";
import { useIsCompactViewport } from "@cloudroom/shared-ui/hooks/use-compact-viewport";
import { usePreferredTheme } from "@/hooks/useTheme";

const COMPACT_TOAST_OFFSET: NonNullable<ToasterProps["offset"]> = {
  top: "calc(env(safe-area-inset-top) + var(--bb-app-chrome-row-height) + 16px)",
};
const COMPACT_TOAST_SWIPE_DIRECTIONS: NonNullable<
  ToasterProps["swipeDirections"]
> = ["top", "left", "right"];
const TOASTER_STYLE = { "--width": "320px" } as CSSProperties;

export function AppToaster() {
  const theme = usePreferredTheme();
  const isCompactViewport = useIsCompactViewport();
  return (
    <Toaster
      theme={theme}
      style={TOASTER_STYLE}
      position={isCompactViewport ? "top-center" : "bottom-right"}
      offset={isCompactViewport ? COMPACT_TOAST_OFFSET : undefined}
      mobileOffset={isCompactViewport ? COMPACT_TOAST_OFFSET : undefined}
      swipeDirections={
        isCompactViewport ? COMPACT_TOAST_SWIPE_DIRECTIONS : undefined
      }
    />
  );
}
