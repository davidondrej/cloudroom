import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { atom, useAtomValue, useSetAtom, useStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { atomFamily } from "jotai-family";
import type { TerminalCreateTarget } from "@cloudroom/server-contract";
import type { SyncStorage } from "@/lib/browser-storage";
import { hasThreadId } from "@/lib/thread-id";
import { useThreadTabs } from "@/hooks/queries/thread-tabs-query";
import {
  areThreadTabListsEquivalent,
  hasPendingThreadTabsWrite,
  reconcileFixedPanelTabsState,
  scheduleLocalThreadTabsMigration,
  scheduleThreadTabsPersistence,
} from "@/lib/thread-tabs-sync";
import { makeMigratingStorage } from "./panel-prefs";
import {
  EMPTY_FIXED_PANEL_TABS_STATE,
  createGitDiffFixedPanelTab,
  createNewTabFixedPanelTab,
  createTerminalFixedPanelTab,
  createThreadInfoFixedPanelTab,
  ensureOpenFixedPanelHasActiveTab,
  getFixedPanelTabsStateStorageKey,
  getLegacyFixedPanelTabsStorageKey,
  parseFixedPanelTabsState,
  pruneFixedPanelTabsStorage,
  serializeFixedPanelTabsState,
  type FixedPanelTab,
  type FixedPanelTabsState,
  type FixedPanelViewTab,
  type TerminalFixedPanelTab,
  type ThreadSecondaryPanel,
} from "./tab-model";
import {
  closeSecondaryPanelTabInState,
  reconcileFixedPanelViewTabsInState,
  setSecondaryPanelTabsInState,
} from "./tab-ops";

// --- Panel Tabs Store ---

const TOUCH_THROTTLE_MS = 60_000;
const disabledTabsAtom = atom(EMPTY_FIXED_PANEL_TABS_STATE);

function tabsStorageForThread(
  threadId: string,
): SyncStorage<FixedPanelTabsState> {
  const legacyKey = getLegacyFixedPanelTabsStorageKey(threadId);
  return makeMigratingStorage<FixedPanelTabsState>(
    (raw, initial) =>
      parseFixedPanelTabsState({
        initialValue: initial,
        now: Date.now(),
        storedValue: raw,
      }),
    (state) => serializeFixedPanelTabsState({ state }),
    () => legacyKey,
  );
}

const panelTabsAtomFamily = atomFamily((threadId: string) =>
  atomWithStorage<FixedPanelTabsState>(
    getFixedPanelTabsStateStorageKey({ threadId }),
    EMPTY_FIXED_PANEL_TABS_STATE,
    tabsStorageForThread(threadId),
    { getOnInit: true },
  ),
);

export function resetFixedPanelTabsStateForTest(): void {
  panelTabsAtomFamily.setShouldRemove(() => true);
  panelTabsAtomFamily.setShouldRemove(null);
}

function tabsAtomFor(threadId: string | null | undefined) {
  return hasThreadId(threadId)
    ? panelTabsAtomFamily(threadId)
    : disabledTabsAtom;
}

const panelTabForKind = (panel: ThreadSecondaryPanel): FixedPanelTab =>
  panel === "git-diff"
    ? createGitDiffFixedPanelTab()
    : createThreadInfoFixedPanelTab();

function activeTerminalTab(
  state: FixedPanelTabsState,
): TerminalFixedPanelTab | null {
  const id = state.secondary.activeTabId;
  if (id === null) return null;
  const tab = state.secondary.tabs.find((t) => t.id === id);
  return tab?.kind === "terminal" ? tab : null;
}

export function upsertTerminalTab(
  tabs: readonly FixedPanelTab[],
  terminalId: string,
  target?: TerminalCreateTarget,
): readonly FixedPanelTab[] {
  const next = createTerminalFixedPanelTab({ terminalId, target });
  const existing = tabs.find((t) => t.id === next.id);
  if (!existing) return [...tabs, next];
  if (
    target === undefined ||
    (existing.kind === "terminal" && existing.target === target)
  )
    return tabs;
  return tabs.map((t) => (t.id === next.id ? next : t));
}

export function removeFixedRightTerminalTabInState(
  state: FixedPanelTabsState,
  terminalId: string,
): FixedPanelTabsState {
  return closeSecondaryPanelTabInState(
    state,
    createTerminalFixedPanelTab({ terminalId }).id,
  );
}

let pruneScheduled = false;

export function useFixedPanelTabsStorageMaintenance(): void {
  useEffect(() => {
    if (pruneScheduled || typeof window === "undefined") return;
    pruneScheduled = true;
    const run = () => {
      try {
        pruneFixedPanelTabsStorage({ now: Date.now() });
      } catch {}
    };
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(run, { timeout: 5_000 });
    } else {
      window.setTimeout(run, 1_500);
    }
  }, []);
}

export function resetFixedPanelTabsStorageMaintenanceForTest(): void {
  pruneScheduled = false;
}

export function useFixedPanelTabsState(
  panelStateId: string | null | undefined,
  syncThreadId: string | null | undefined,
): FixedPanelTabsState {
  const stateAtom = tabsAtomFor(panelStateId);
  const store = useStore();
  const state = useAtomValue(stateAtom);
  const setState = useSetAtom(stateAtom);
  const queryClient = useQueryClient();
  const resolvedThreadId = hasThreadId(syncThreadId) ? syncThreadId : null;
  const tabsQuery = useThreadTabs(resolvedThreadId ?? "", {
    enabled: resolvedThreadId !== null,
  });

  useEffect(() => {
    if (resolvedThreadId === null || tabsQuery.data === undefined) return;
    if (hasPendingThreadTabsWrite(queryClient, resolvedThreadId)) return;
    if (tabsQuery.data.revision === 0 && state.secondary.tabs.length > 0) {
      scheduleLocalThreadTabsMigration({
        queryClient,
        tabs: state.secondary.tabs,
        threadId: resolvedThreadId,
      });
      return;
    }
    const current = store.get(stateAtom);
    const next = ensureOpenFixedPanelHasActiveTab(
      reconcileFixedPanelTabsState(current, tabsQuery.data.tabs),
    );
    if (next !== current) setState(next);
  }, [
    queryClient,
    resolvedThreadId,
    setState,
    state.secondary.tabs,
    stateAtom,
    store,
    tabsQuery.data,
  ]);

  return state;
}

export function useUpdateFixedPanelTabsState(
  panelStateId: string | null | undefined,
  syncThreadId: string | null | undefined,
): (update: (state: FixedPanelTabsState) => FixedPanelTabsState) => void {
  const stateAtom = tabsAtomFor(panelStateId);
  const store = useStore();
  const setState = useSetAtom(stateAtom);
  const queryClient = useQueryClient();
  return useCallback(
    (update) => {
      if (!hasThreadId(panelStateId)) return;
      const current = store.get(stateAtom);
      const next = ensureOpenFixedPanelHasActiveTab(update(current));
      if (next === current) return;
      const touched: FixedPanelTabsState = { ...next, lastUsedAt: Date.now() };
      setState(touched);
      if (
        hasThreadId(syncThreadId) &&
        !areThreadTabListsEquivalent(
          current.secondary.tabs,
          touched.secondary.tabs,
        )
      ) {
        scheduleThreadTabsPersistence({
          previousTabs: current.secondary.tabs,
          tabs: touched.secondary.tabs,
          queryClient,
          threadId: syncThreadId,
        });
      }
    },
    [panelStateId, queryClient, setState, stateAtom, store, syncThreadId],
  );
}

export function useReconciledFixedPanelTabsState(args: {
  fixedTabs: readonly FixedPanelViewTab[];
  isAuthoritative?: boolean;
  openFirstFixedTabWhenEmpty?: boolean;
  panelStateId: string | null | undefined;
  syncThreadId: string | null | undefined;
}): FixedPanelTabsState {
  const {
    fixedTabs,
    isAuthoritative = true,
    openFirstFixedTabWhenEmpty = false,
    panelStateId,
    syncThreadId,
  } = args;
  const state = useFixedPanelTabsState(panelStateId, syncThreadId);
  const updateState = useUpdateFixedPanelTabsState(panelStateId, syncThreadId);
  const reconciled = useMemo(
    () =>
      isAuthoritative
        ? reconcileFixedPanelViewTabsInState({
            fixedTabs,
            openFirstFixedTabWhenEmpty,
            state,
          })
        : state,
    [fixedTabs, isAuthoritative, openFirstFixedTabWhenEmpty, state],
  );

  useLayoutEffect(() => {
    if (!isAuthoritative || reconciled === state) return;
    updateState((cur) =>
      reconcileFixedPanelViewTabsInState({
        fixedTabs,
        openFirstFixedTabWhenEmpty,
        state: cur,
      }),
    );
  }, [
    fixedTabs,
    isAuthoritative,
    openFirstFixedTabWhenEmpty,
    reconciled,
    state,
    updateState,
  ]);

  return reconciled;
}

export function useTouchFixedPanelTabsState(
  panelStateId: string | null | undefined,
  syncThreadId: string | null | undefined,
): () => void {
  const updateState = useUpdateFixedPanelTabsState(panelStateId, syncThreadId);
  const lastRef = useRef<{
    threadId: string | null | undefined;
    touchedAt: number;
  } | null>(null);
  return useCallback(() => {
    const now = Date.now();
    if (
      lastRef.current !== null &&
      lastRef.current.threadId === panelStateId &&
      now - lastRef.current.touchedAt < TOUCH_THROTTLE_MS
    )
      return;
    lastRef.current = { threadId: panelStateId, touchedAt: now };
    updateState((cur) => {
      if (!cur.secondary.isOpen && cur.secondary.tabs.length === 0) return cur;
      if (now - cur.lastUsedAt < TOUCH_THROTTLE_MS) return cur;
      return { ...cur };
    });
  }, [panelStateId, updateState]);
}

export function useSetFixedSecondaryPanelTab(
  panelStateId: string | null | undefined,
  syncThreadId: string | null | undefined,
): (panel: ThreadSecondaryPanel) => void {
  const updateState = useUpdateFixedPanelTabsState(panelStateId, syncThreadId);
  return useCallback(
    (panel) => {
      updateState((cur) => {
        const target = panelTabForKind(panel);
        const tabs = cur.secondary.tabs.some((t) => t.id === target.id)
          ? cur.secondary.tabs
          : [...cur.secondary.tabs, target];
        if (
          tabs === cur.secondary.tabs &&
          cur.secondary.activeTabId === target.id &&
          cur.secondary.isOpen
        )
          return cur;
        return {
          ...cur,
          secondary: { tabs, activeTabId: target.id, isOpen: true },
        };
      });
    },
    [updateState],
  );
}

export function useCloseFixedSecondaryPanel(
  panelStateId: string | null | undefined,
  syncThreadId: string | null | undefined,
): () => void {
  const updateState = useUpdateFixedPanelTabsState(panelStateId, syncThreadId);
  return useCallback(() => {
    updateState((cur) =>
      cur.secondary.isOpen
        ? { ...cur, secondary: { ...cur.secondary, isOpen: false } }
        : cur,
    );
  }, [updateState]);
}

export function useOpenFixedSecondaryPanel(
  panelStateId: string | null | undefined,
  syncThreadId: string | null | undefined,
): () => void {
  const updateState = useUpdateFixedPanelTabsState(panelStateId, syncThreadId);
  return useCallback(() => {
    updateState((cur) => {
      const hasActive =
        cur.secondary.activeTabId !== null &&
        cur.secondary.tabs.some((t) => t.id === cur.secondary.activeTabId);
      if (hasActive) {
        return cur.secondary.isOpen
          ? cur
          : { ...cur, secondary: { ...cur.secondary, isOpen: true } };
      }
      const blank = createNewTabFixedPanelTab();
      const tabs = cur.secondary.tabs.some((t) => t.id === blank.id)
        ? cur.secondary.tabs
        : [...cur.secondary.tabs, blank];
      return {
        ...cur,
        secondary: { tabs, activeTabId: blank.id, isOpen: true },
      };
    });
  }, [updateState]);
}

export function useActiveFixedRightTerminalId(
  panelStateId: string | null | undefined,
  syncThreadId: string | null | undefined,
): string | null {
  return (
    activeTerminalTab(useFixedPanelTabsState(panelStateId, syncThreadId))
      ?.terminalId ?? null
  );
}

export function useSetFixedRightTerminalActiveTerminal(
  panelStateId: string | null | undefined,
  syncThreadId: string | null | undefined,
  target?: TerminalCreateTarget,
): (terminalId: string | null) => void {
  const updateState = useUpdateFixedPanelTabsState(panelStateId, syncThreadId);
  return useCallback(
    (terminalId) => {
      updateState((cur) => {
        if (terminalId === null) {
          return activeTerminalTab(cur) === null
            ? cur
            : { ...cur, secondary: { ...cur.secondary, activeTabId: null } };
        }
        const tabs = upsertTerminalTab(cur.secondary.tabs, terminalId, target);
        const activeTabId = createTerminalFixedPanelTab({
          terminalId,
          target,
        }).id;
        return setSecondaryPanelTabsInState({
          state: cur,
          tabs,
          activeTabId,
          isOpen: true,
        });
      });
    },
    [target, updateState],
  );
}

export function useRemoveFixedRightTerminalTab(
  panelStateId: string | null | undefined,
  syncThreadId: string | null | undefined,
  onCloseLastTab?: () => void,
): (terminalId: string) => void {
  const updateState = useUpdateFixedPanelTabsState(panelStateId, syncThreadId);
  return useCallback(
    (terminalId) => {
      let closedLast = false;
      updateState((cur) => {
        const next = removeFixedRightTerminalTabInState(cur, terminalId);
        closedLast = next !== cur && next.secondary.tabs.length === 0;
        return next;
      });
      if (closedLast) onCloseLastTab?.();
    },
    [onCloseLastTab, updateState],
  );
}

// --- Panel Sizing, Resizing & Conversation Collapse Atoms ---

// --- Recent Items Per Thread (Zero Zod) ---

const RECENT_STORAGE_PREFIX = "room.thread.recentItems";
const LEGACY_RECENT_PREFIX = "bb.thread.recentItems";
const RECENT_MAX_STORED = 24;
export const THREAD_RECENT_ITEMS_VISIBLE_LIMIT = 6;

export interface ThreadRecentItem {
  openedAt: number;
  path: string;
  source: "workspace" | "thread-storage";
}

const EMPTY_RECENTS: readonly ThreadRecentItem[] = [];

export function recordRecentItem(args: {
  items: readonly ThreadRecentItem[];
  limit?: number;
  openedAt: number;
  path: string;
  source: "workspace" | "thread-storage";
}): ThreadRecentItem[] {
  const limit = args.limit ?? RECENT_MAX_STORED;
  return [
    { source: args.source, path: args.path, openedAt: args.openedAt },
    ...args.items.filter(
      (i) => i.source !== args.source || i.path !== args.path,
    ),
  ].slice(0, limit);
}

export function getThreadRecentItemsStorageKey(args: {
  threadId: string;
}): string {
  return `${RECENT_STORAGE_PREFIX}-${encodeURIComponent(args.threadId)}-1`;
}

function parseRecentItems(
  raw: string | null,
  initial: readonly ThreadRecentItem[],
): readonly ThreadRecentItem[] {
  if (raw === null) return initial;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return initial;
    const valid: ThreadRecentItem[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null || Array.isArray(item))
        return initial;
      const o = item as Record<string, unknown>;
      if (
        Object.keys(o).length !== 3 ||
        (o.source !== "workspace" && o.source !== "thread-storage") ||
        typeof o.path !== "string" ||
        o.path.length === 0 ||
        typeof o.openedAt !== "number" ||
        !Number.isInteger(o.openedAt) ||
        o.openedAt < 0
      ) {
        return initial;
      }
      valid.push({ source: o.source, path: o.path, openedAt: o.openedAt });
    }
    return valid.slice(0, RECENT_MAX_STORED);
  } catch {
    return initial;
  }
}

const disabledRecentsAtom = atom<readonly ThreadRecentItem[]>(EMPTY_RECENTS);
const recentItemsFamily = atomFamily((threadId: string) =>
  atomWithStorage<readonly ThreadRecentItem[]>(
    getThreadRecentItemsStorageKey({ threadId }),
    EMPTY_RECENTS,
    makeMigratingStorage(
      parseRecentItems,
      JSON.stringify,
      () => `${LEGACY_RECENT_PREFIX}-${encodeURIComponent(threadId)}-1`,
      { syncAcrossWindows: true },
    ),
    { getOnInit: true },
  ),
);

export function useThreadRecentItems(
  threadId: string | null | undefined,
): readonly ThreadRecentItem[] {
  return useAtomValue(
    hasThreadId(threadId) ? recentItemsFamily(threadId) : disabledRecentsAtom,
  );
}

export function useRecordThreadRecentItem(
  threadId: string | null | undefined,
): (args: { path: string; source: "workspace" | "thread-storage" }) => void {
  const setRecents = useSetAtom(
    hasThreadId(threadId) ? recentItemsFamily(threadId) : disabledRecentsAtom,
  );
  return useCallback(
    ({ source, path }) => {
      if (!hasThreadId(threadId)) return;
      setRecents((items) =>
        recordRecentItem({ items, source, path, openedAt: Date.now() }),
      );
    },
    [setRecents, threadId],
  );
}
