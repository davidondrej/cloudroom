import { useEffect, useMemo, useState } from "react";
import type { RoomDesktopWindowState } from "@cloudroom/desktop-contract";
import {
  DEFAULT_DESKTOP_WINDOW_STATE,
  getRoomDesktopInfo,
} from "@/lib/room-desktop";

export function useDesktopWindowState(): RoomDesktopWindowState {
  const [isFullScreen, setIsFullScreen] = useState(
    DEFAULT_DESKTOP_WINDOW_STATE.isFullScreen,
  );

  useEffect(() => {
    const desktopApi = getRoomDesktopInfo();
    let cancelled = false;

    const unsubscribe = desktopApi?.onWindowStateChange?.((nextState) => {
      setIsFullScreen(nextState.isFullScreen);
    });

    void desktopApi?.getWindowState?.().then((nextState) => {
      if (!cancelled) {
        setIsFullScreen(nextState.isFullScreen);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  return useMemo(() => ({ isFullScreen }), [isFullScreen]);
}
