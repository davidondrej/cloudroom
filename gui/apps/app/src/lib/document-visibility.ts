import { useSyncExternalStore } from "react";
import { getRoomDesktopInfo } from "@/lib/room-desktop";

const listeners = new Set<() => void>();
let revision = 0;

function notifyListeners(): void {
  revision += 1;
  for (const listener of listeners) {
    listener();
  }
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  document.addEventListener("visibilitychange", notifyListeners);
  window.addEventListener("pageshow", notifyListeners);
  window.addEventListener("focus", notifyListeners);
}

export function subscribeToDocumentVisibility(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isDocumentVisible(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState === "visible"
  );
}

// The Windows app turns off Chromium's occlusion tracking (#1944), so a window covered by another
// app still reports "visible". There the user is only looking if the window has focus: native
// focus (the page loses DOM focus to the in-app browser view) or page focus.
let nativeFocused: boolean | undefined;
let trackingWindowsFocus = false;

function needsWindowsFocus(): boolean {
  const desktop = getRoomDesktopInfo();
  if (desktop?.platform !== "windows") return false;
  if (!trackingWindowsFocus) {
    trackingWindowsFocus = true;
    const update = ({ isFocused }: { isFocused?: boolean }) => {
      nativeFocused = isFocused;
      notifyListeners();
    };
    desktop.onWindowStateChange?.(update);
    void desktop.getWindowState?.().then(update);
    window.addEventListener("blur", notifyListeners);
  }
  return true;
}

export function isDocumentAttended(): boolean {
  if (!isDocumentVisible()) return false;
  return !needsWindowsFocus() || nativeFocused === true || document.hasFocus();
}

export function useDocumentVisibilityRevision(): number {
  return useSyncExternalStore(
    subscribeToDocumentVisibility,
    () => revision,
    () => revision,
  );
}
