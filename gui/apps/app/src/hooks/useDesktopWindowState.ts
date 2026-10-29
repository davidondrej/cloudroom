import { useEffect, useMemo, useState } from "react";
import type { BbDesktopWindowState } from "@cloudroom/desktop-contract";
import {
  DEFAULT_DESKTOP_WINDOW_STATE,
  getBbDesktopInfo,
} from "@/lib/bb-desktop";

export function useDesktopWindowState(): BbDesktopWindowState {
  const [isFullScreen, setIsFullScreen] = useState(
    DEFAULT_DESKTOP_WINDOW_STATE.isFullScreen,
  );

  useEffect(() => {
    const desktopApi = getBbDesktopInfo();
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
