import { useCallback, useEffect, type RefObject } from "react";
import { SIDEBAR_CONTENT_SELECTOR } from "@/components/ui/sidebar";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { isDocumentVisible, subscribeToDocumentVisibility, useDocumentVisibilityRevision } from "@/lib/document-visibility";

export type CloudWakeReason = "view" | "typing";

const WAKE_INTERVAL_MS = 60_000;
const VIEW_DELAY_MS = 500;
const PRELOAD_SETTLE_MS = 2_000;
const PRELOAD_MAX_WAIT_MS = 3_000;
const PRELOAD_MAX_THREADS = 50;
const lastWakeAt = new Map<string, number>();

export function useCloudThreadWake(threadId: string, isCloud: boolean): (reason: CloudWakeReason) => void {
  const wake = useCallback((reason: CloudWakeReason) => {
    if (!isCloud || Date.now() - (lastWakeAt.get(threadId) ?? 0) < WAKE_INTERVAL_MS) return;
    lastWakeAt.set(threadId, Date.now());
    void fetchWithAppSurface(`/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/wake`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }),
    }).catch(() => {});
  }, [isCloud, threadId]);
  const visibility = useDocumentVisibilityRevision();
  useEffect(() => {
    if (!isCloud || !isDocumentVisible()) return;
    const timer = setTimeout(() => wake("view"), VIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isCloud, visibility, wake]);
  return wake;
}

export function useSidebarPreload(sidebarRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = sidebarRef.current;
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waitingSince = 0;
    let scrolledAt = 0;
    let sent = "";
    let refocused = false;
    const send = () => {
      const scrolling = PRELOAD_SETTLE_MS - (Date.now() - scrolledAt);
      if (scrolling > 0) {
        timer = setTimeout(send, scrolling);
        return;
      }
      timer = undefined;
      const content = root.querySelector<HTMLElement>(SIDEBAR_CONTENT_SELECTOR);
      if (!content || !isDocumentVisible() || !document.hasFocus()) return;
      const box = content.getBoundingClientRect();
      const top = Math.max(box.top, 0);
      const bottom = Math.min(box.bottom, window.innerHeight);
      if (box.width <= 0 || box.right <= 0 || box.left >= window.innerWidth || bottom <= top) return;
      const threads = new Set<string>();
      for (const row of content.querySelectorAll<HTMLElement>("a[data-sidebar-thread-id]")) {
        const id = row.dataset.sidebarThreadId;
        const rect = row.getBoundingClientRect();
        if (id && rect.height > 0 && rect.bottom > top && rect.top < bottom) threads.add(id);
        if (threads.size === PRELOAD_MAX_THREADS) break;
      }
      const key = [...threads].join(" ");
      if (!key || (key === sent && !refocused)) return;
      sent = key;
      refocused = false;
      void fetchWithAppSurface("/api/v1/cloudroom/preload", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threads: [...threads] }),
      }).catch(() => {});
    };
    const schedule = () => {
      if (timer && Date.now() - waitingSince >= PRELOAD_MAX_WAIT_MS) return;
      if (!timer) waitingSince = Date.now();
      clearTimeout(timer);
      timer = setTimeout(send, PRELOAD_SETTLE_MS);
    };
    const refocus = () => {
      refocused = true;
      schedule();
    };
    const scroll = () => {
      scrolledAt = Date.now();
      schedule();
    };
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true });
    root.addEventListener("scroll", scroll, { capture: true, passive: true });
    const unsubscribe = subscribeToDocumentVisibility(refocus);
    schedule();
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      root.removeEventListener("scroll", scroll, { capture: true });
      unsubscribe();
    };
  }, [sidebarRef]);
}
