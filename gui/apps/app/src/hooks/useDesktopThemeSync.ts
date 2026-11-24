import { useEffect } from "react";
import { getRoomDesktopInfo } from "@/lib/room-desktop";
import { useThemePreference } from "./useTheme";

export function useDesktopThemeSync(): void {
  const themePreference = useThemePreference();
  useEffect(() => {
    const desktopApi = getRoomDesktopInfo();
    desktopApi?.setTheme(themePreference);
  }, [themePreference]);
}
