import { fetchWithAppSurface } from "@/lib/app-surface";

// Counts minutes the user is actively in Cloudroom: the window is focused and they typed, clicked, or scrolled
// in the last 5 minutes. No mouse-move listener: it can fire hundreds of times a second.
// The server counts each minute once, however many windows report it.
const IDLE_MS = 5 * 60_000;

export function installTimeInApp(): void {
  if (typeof window === "undefined") return;
  let inputAt = Date.now();
  const onInput = () => { inputAt = Date.now(); };
  for (const type of ["pointerdown", "keydown", "wheel"]) {
    window.addEventListener(type, onInput, { capture: true, passive: true });
  }
  window.setInterval(() => {
    if (document.visibilityState !== "visible" || !document.hasFocus() || Date.now() - inputAt > IDLE_MS) return;
    void fetchWithAppSurface("/api/v1/cloudroom/time-in-app", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
  }, 60_000);
}
