import { useEffect, useMemo, useRef } from "react";
import type { RoomDesktopBrowserApi } from "@cloudroom/desktop-contract";
import type { BrowserFixedPanelTab } from "@/components/right-panel/store/tab-model";
import { getDesktopBrowserApi } from "@/lib/room-desktop";

export interface BrowserViewVisibilityCoordinator {
  show(
    tabId: string,
    syncBounds: () => void,
    options?: { focus?: boolean },
  ): void;
  hide(tabId: string): void;
  release(tabId: string): void;
}

interface PersistedViewEntry {
  environmentId: string | null;
  tabId: string;
  threadId: string;
}

const persistedViews = new Map<string, PersistedViewEntry>();

export function createBrowserViewVisibilityCoordinator(
  desktopBrowser: RoomDesktopBrowserApi,
): BrowserViewVisibilityCoordinator {
  let visibleId: string | null = null;

  return {
    show(tabId, syncBounds, options) {
      if (visibleId !== null && visibleId !== tabId) {
        desktopBrowser.setVisible({ tabId: visibleId, visible: false });
      }
      visibleId = tabId;
      syncBounds();

      const req = { tabId, visible: true };
      if (options?.focus === false && desktopBrowser.setVisibleWithoutFocus) {
        desktopBrowser.setVisibleWithoutFocus(req);
      } else {
        desktopBrowser.setVisible(req);
      }
    },

    hide(tabId) {
      if (visibleId === tabId) visibleId = null;
      desktopBrowser.setVisible({ tabId, visible: false });
    },

    release(tabId) {
      if (visibleId === tabId) visibleId = null;
    },
  };
}

export function registerBrowserView(entry: PersistedViewEntry): void {
  persistedViews.set(entry.tabId, entry);
}

export function destroyPersistedBrowserView({
  desktopBrowser,
  tabId,
}: {
  desktopBrowser: RoomDesktopBrowserApi;
  tabId: string;
}): void {
  desktopBrowser.setVisible({ tabId, visible: false });
  desktopBrowser.detach(tabId);
  persistedViews.delete(tabId);
}

function destroyMatching(
  desktopBrowser: RoomDesktopBrowserApi | null,
  predicate: (entry: PersistedViewEntry) => boolean,
): void {
  if (!desktopBrowser) return;
  for (const entry of [...persistedViews.values()]) {
    if (predicate(entry)) {
      destroyPersistedBrowserView({ desktopBrowser, tabId: entry.tabId });
    }
  }
}

export function destroyPersistedBrowserViewsForThread({
  desktopBrowser,
  threadId,
}: {
  desktopBrowser: RoomDesktopBrowserApi | null;
  threadId: string;
}): void {
  destroyMatching(desktopBrowser, (entry) => entry.threadId === threadId);
}

export function destroyPersistedBrowserViewsForEnvironment({
  desktopBrowser,
  environmentId,
}: {
  desktopBrowser: RoomDesktopBrowserApi | null;
  environmentId: string;
}): void {
  destroyMatching(
    desktopBrowser,
    (entry) => entry.environmentId === environmentId,
  );
}

export function resetBrowserViewPersistence(): void {
  persistedViews.clear();
}

export function buildBrowserTabIdSet({
  browserTabs,
}: {
  browserTabs: readonly BrowserFixedPanelTab[];
}): ReadonlySet<string> {
  return new Set(browserTabs.map((tab) => tab.id));
}

export function selectActiveBrowserTab(
  browserTabs: readonly BrowserFixedPanelTab[],
  activeBrowserTabId: string | null,
): BrowserFixedPanelTab | null {
  if (activeBrowserTabId === null) return null;
  return browserTabs.find((tab) => tab.id === activeBrowserTabId) ?? null;
}

export function BrowserTabLifecycleObserver({
  browserTabs,
  threadId,
}: {
  browserTabs: readonly BrowserFixedPanelTab[];
  threadId: string;
}): null {
  const desktopBrowser = useMemo(() => getDesktopBrowserApi(), []);
  const prevRef = useRef<{
    tabIds: ReadonlySet<string>;
    threadId: string;
  } | null>(null);

  useEffect(() => {
    const currentIds = buildBrowserTabIdSet({ browserTabs });
    const prev = prevRef.current;
    if (desktopBrowser && prev && prev.threadId === threadId) {
      for (const oldId of prev.tabIds) {
        if (!currentIds.has(oldId)) {
          destroyPersistedBrowserView({ desktopBrowser, tabId: oldId });
        }
      }
    }
    prevRef.current = { tabIds: currentIds, threadId };
  }, [browserTabs, desktopBrowser, threadId]);

  return null;
}
