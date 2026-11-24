import type { ReactNode } from "react";
import { arrayMove } from "@cloudroom/client-core";
import type { TerminalSession } from "@cloudroom/server-contract";
import { shouldShowRetainedTerminalSession } from "@/lib/terminal-session-visibility";
import {
  areFixedPanelTabsEquivalent,
  createTerminalFixedPanelTab,
  type BrowserFixedPanelTab,
  type FixedPanelTab,
  type FixedPanelTabsState,
  type FixedPanelViewTab,
  type SecondaryFileFixedPanelTab,
  type SecondaryFixedPanelTab,
  type TerminalFixedPanelTab,
} from "./tab-model";

export interface MarketplacePluginDetailPanelTab {
  id: string;
  kind: "marketplace-plugin-detail";
}

export interface SecondaryPanelTabReorderRequest {
  activeTabId: string;
  overTabId: string;
}

export type SecondaryPanelTabReorderHandler = (
  request: SecondaryPanelTabReorderRequest,
) => void;

export interface SecondaryPanelPaneRenderContext {
  isFocused: boolean;
  onFocusPane: () => void;
}

export interface SecondaryPanelRenderableTab {
  contentFillsRegion?: boolean;
  isHidden?: boolean;
  isPinned?: boolean;
  label: string;
  leadingVisual: ReactNode;
  onClose: () => void;
  onSelect: () => void;
  renderContent: (pane: SecondaryPanelPaneRenderContext) => ReactNode;
  statusLabel: string | null;
  tab: SecondaryFileFixedPanelTab | MarketplacePluginDetailPanelTab;
}

export const isBrowserTab = (tab: FixedPanelTab): tab is BrowserFixedPanelTab =>
  tab.kind === "browser";

export function isSecondaryFileTab(
  tab: FixedPanelTab,
): tab is SecondaryFileFixedPanelTab {
  return (
    tab.kind !== "thread-info" &&
    tab.kind !== "git-diff" &&
    tab.kind !== "plugin-page-fixed"
  );
}

export function findSecondaryPanelTab(
  tabs: readonly FixedPanelTab[],
  tabId: string,
): FixedPanelTab | null {
  return tabs.find((tab) => tab.id === tabId) ?? null;
}

export function getActiveSecondaryPanelTab(
  state: FixedPanelTabsState,
): SecondaryFixedPanelTab | null {
  return state.secondary.activeTabId === null
    ? null
    : findSecondaryPanelTab(state.secondary.tabs, state.secondary.activeTabId);
}

function nextPreviousActive(
  state: FixedPanelTabsState,
  tabs: readonly FixedPanelTab[],
  activeTabId: string | null,
  replacedTabId?: string,
): string | undefined {
  const prev = state.secondary.activeTabId;
  if (activeTabId === prev || prev === replacedTabId) {
    const kept = state.secondary.previousActiveTabId;
    return kept !== undefined && tabs.some((t) => t.id === kept)
      ? kept
      : undefined;
  }
  return prev !== null && tabs.some((t) => t.id === prev) ? prev : undefined;
}

export function setSecondaryPanelTabsInState(args: {
  activeTabId: string | null;
  isOpen: boolean;
  replacedTabId?: string;
  state: FixedPanelTabsState;
  tabs: readonly FixedPanelTab[];
}): FixedPanelTabsState {
  const { state, tabs, activeTabId, isOpen, replacedTabId } = args;
  if (
    tabs === state.secondary.tabs &&
    activeTabId === state.secondary.activeTabId &&
    isOpen === state.secondary.isOpen
  ) {
    return state;
  }
  return {
    ...state,
    secondary: {
      tabs,
      activeTabId,
      isOpen,
      previousActiveTabId: nextPreviousActive(
        state,
        tabs,
        activeTabId,
        replacedTabId,
      ),
    },
  };
}

function upsertTab(
  tabs: readonly FixedPanelTab[],
  tab: FixedPanelTab,
  forceReplace: boolean,
): readonly FixedPanelTab[] {
  const idx = tabs.findIndex((t) => t.id === tab.id);
  if (idx === -1) return [...tabs, tab];
  const existing = tabs[idx];
  if (!forceReplace && existing && areFixedPanelTabsEquivalent(existing, tab))
    return tabs;
  return tabs.map((t) => (t.id === tab.id ? tab : t));
}

export function reconcileFixedPanelViewTabsInState(args: {
  fixedTabs: readonly FixedPanelViewTab[];
  openFirstFixedTabWhenEmpty?: boolean;
  state: FixedPanelTabsState;
}): FixedPanelTabsState {
  const { fixedTabs, openFirstFixedTabWhenEmpty = false, state } = args;
  const contentTabs = state.secondary.tabs.filter(isSecondaryFileTab);
  const tabs: readonly FixedPanelTab[] = [...fixedTabs, ...contentTabs];
  const unchanged =
    tabs.length === state.secondary.tabs.length &&
    tabs.every((t, i) => {
      const cur = state.secondary.tabs[i];
      return cur !== undefined && areFixedPanelTabsEquivalent(t, cur);
    });
  const activeExists = tabs.some((t) => t.id === state.secondary.activeTabId);
  const activeTabId = activeExists
    ? state.secondary.activeTabId
    : (fixedTabs[0]?.id ?? contentTabs[0]?.id ?? null);
  const isFirstInit =
    state.secondary.tabs.length === 0 &&
    state.secondary.activeTabId === null &&
    !state.secondary.isOpen;
  const isOpen =
    activeTabId !== null &&
    (state.secondary.isOpen ||
      (openFirstFixedTabWhenEmpty && isFirstInit && fixedTabs.length > 0));
  if (
    unchanged &&
    activeTabId === state.secondary.activeTabId &&
    isOpen === state.secondary.isOpen
  )
    return state;
  return setSecondaryPanelTabsInState({ state, tabs, activeTabId, isOpen });
}

export function openSecondaryPanelTabInState(args: {
  state: FixedPanelTabsState;
  tab: FixedPanelTab;
}): FixedPanelTabsState {
  const { state, tab } = args;
  const force =
    tab.kind === "plugin-panel" && tab.fileOpenerOwner?.tab.lineRange != null;
  const tabs = upsertTab(state.secondary.tabs, tab, force);
  if (
    tabs === state.secondary.tabs &&
    state.secondary.activeTabId === tab.id &&
    state.secondary.isOpen
  )
    return state;
  return setSecondaryPanelTabsInState({
    state,
    tabs,
    activeTabId: tab.id,
    isOpen: true,
  });
}

export function replaceNewTabWithSecondaryPanelTabInState(args: {
  state: FixedPanelTabsState;
  tab: FixedPanelTab;
}): FixedPanelTabsState {
  const { state, tab } = args;
  const newTab = state.secondary.tabs.find((t) => t.kind === "new-tab") ?? null;
  const withoutNew =
    newTab === null
      ? state.secondary.tabs
      : state.secondary.tabs.filter((t) => t.id !== newTab.id);
  const existing = withoutNew.find((t) => t.id === tab.id);
  if (existing) {
    return setSecondaryPanelTabsInState({
      state,
      tabs: withoutNew,
      activeTabId: existing.id,
      isOpen: true,
      replacedTabId: newTab?.id,
    });
  }
  const tabs =
    newTab === null
      ? upsertTab(withoutNew, tab, false)
      : state.secondary.tabs.map((t) => (t.id === newTab.id ? tab : t));
  return setSecondaryPanelTabsInState({
    state,
    tabs,
    activeTabId: tab.id,
    isOpen: true,
    replacedTabId: newTab?.id,
  });
}

export function updateSecondaryPanelTabInState(args: {
  state: FixedPanelTabsState;
  tab: FixedPanelTab;
}): FixedPanelTabsState {
  const tabs = upsertTab(args.state.secondary.tabs, args.tab, false);
  if (tabs === args.state.secondary.tabs) return args.state;
  return setSecondaryPanelTabsInState({
    state: args.state,
    tabs,
    activeTabId: args.state.secondary.activeTabId,
    isOpen: args.state.secondary.isOpen,
  });
}

export function activateSecondaryPanelTabInState(
  state: FixedPanelTabsState,
  tabId: string,
): FixedPanelTabsState {
  if (!state.secondary.tabs.some((t) => t.id === tabId)) return state;
  if (state.secondary.activeTabId === tabId && state.secondary.isOpen)
    return state;
  return setSecondaryPanelTabsInState({
    state,
    tabs: state.secondary.tabs,
    activeTabId: tabId,
    isOpen: true,
  });
}

export function closeSecondaryPanelTabInState(
  state: FixedPanelTabsState,
  tabId: string,
): FixedPanelTabsState {
  const closing = findSecondaryPanelTab(state.secondary.tabs, tabId);
  if (closing === null) return state;
  const tabs = state.secondary.tabs.filter((t) => t.id !== tabId);
  if (tabs.length === state.secondary.tabs.length) return state;

  const isClosingActive = state.secondary.activeTabId === tabId;
  const prevId = state.secondary.previousActiveTabId;
  if (
    isClosingActive &&
    isSecondaryFileTab(closing) &&
    !tabs.some(isSecondaryFileTab) &&
    !(prevId !== undefined && tabs.some((t) => t.id === prevId))
  ) {
    const fallback = tabs[0] ?? null;
    return setSecondaryPanelTabsInState({
      state,
      tabs,
      activeTabId: fallback?.id ?? null,
      isOpen: fallback !== null,
    });
  }

  let activeTabId = state.secondary.activeTabId;
  if (isClosingActive) {
    if (
      prevId !== undefined &&
      prevId !== tabId &&
      tabs.some((t) => t.id === prevId)
    ) {
      activeTabId = prevId;
    } else {
      const beforeFiles = state.secondary.tabs.filter(isSecondaryFileTab);
      const closedIdx = beforeFiles.findIndex((t) => t.id === tabId);
      const afterFiles = tabs.filter(isSecondaryFileTab);
      activeTabId =
        closedIdx === -1
          ? null
          : ((afterFiles[closedIdx] ?? afterFiles[closedIdx - 1] ?? null)?.id ??
            null);
    }
  }
  return setSecondaryPanelTabsInState({
    state,
    tabs,
    activeTabId,
    isOpen: state.secondary.isOpen,
  });
}

export function reorderSecondaryPanelFileTabInState(args: {
  activeTabId: string;
  overTabId: string;
  state: FixedPanelTabsState;
}): FixedPanelTabsState {
  const { state, activeTabId, overTabId } = args;
  if (activeTabId === overTabId) return state;
  const from = state.secondary.tabs.findIndex(
    (t) => t.id === activeTabId && isSecondaryFileTab(t),
  );
  const to = state.secondary.tabs.findIndex(
    (t) => t.id === overTabId && isSecondaryFileTab(t),
  );
  if (from === -1 || to === -1) return state;
  return setSecondaryPanelTabsInState({
    state,
    tabs: arrayMove([...state.secondary.tabs], from, to),
    activeTabId: state.secondary.activeTabId,
    isOpen: state.secondary.isOpen,
  });
}

export function clearActiveSecondaryFileTabInState(
  state: FixedPanelTabsState,
): FixedPanelTabsState {
  const active = getActiveSecondaryPanelTab(state);
  if (!active || !isSecondaryFileTab(active)) return state;
  return setSecondaryPanelTabsInState({
    state,
    tabs: state.secondary.tabs,
    activeTabId: null,
    isOpen: state.secondary.isOpen,
  });
}

export function removeWorkspaceTabsForOtherEnvironments(
  tabs: readonly FixedPanelTab[],
  environmentId: string | null,
): readonly FixedPanelTab[] {
  const next = tabs.filter(
    (t) =>
      t.kind !== "workspace-file-preview" || t.environmentId === environmentId,
  );
  return next.length === tabs.length ? tabs : next;
}

export function pruneStorageTabs(args: {
  knownPaths: ReadonlySet<string>;
  tabs: readonly FixedPanelTab[];
  threadId: string | null | undefined;
}): readonly FixedPanelTab[] {
  const next = args.tabs.filter(
    (t) =>
      t.kind !== "thread-storage-file-preview" ||
      (t.threadId !== null && t.threadId !== args.threadId) ||
      args.knownPaths.has(t.path),
  );
  return next.length === args.tabs.length ? args.tabs : next;
}

export function getActiveTabIdAfterPrune(
  tabs: readonly FixedPanelTab[],
  activeTabId: string | null,
): string | null {
  return activeTabId !== null && tabs.some((t) => t.id === activeTabId)
    ? activeTabId
    : null;
}

export function buildOrderedSecondaryPanelFileTabs(args: {
  includeWorkspaceTabsOutsideEnvironment?: boolean;
  resolvedEnvironmentId: string | null | undefined;
  tabs: readonly FixedPanelTab[];
}): readonly SecondaryFileFixedPanelTab[] {
  const out: SecondaryFileFixedPanelTab[] = [];
  for (const tab of args.tabs) {
    if (!isSecondaryFileTab(tab)) continue;
    if (
      tab.kind === "workspace-file-preview" &&
      !args.includeWorkspaceTabsOutsideEnvironment &&
      (args.resolvedEnvironmentId === undefined ||
        tab.environmentId !== args.resolvedEnvironmentId)
    ) {
      continue;
    }
    out.push(tab);
  }
  return out;
}

// --- Terminal Tab Sync Helpers ---

function visibleTerminalIds(
  sessions: readonly TerminalSession[],
  retainedTerminalId: string | null,
): Set<string> {
  return new Set(
    sessions
      .filter((session) =>
        shouldShowRetainedTerminalSession({ retainedTerminalId, session }),
      )
      .map((s) => s.id),
  );
}

export function getRetainedTerminalTabId(args: {
  activeTab: SecondaryFixedPanelTab | null;
  isPanelOpen: boolean;
}): string | null {
  return args.isPanelOpen && args.activeTab?.kind === "terminal"
    ? args.activeTab.terminalId
    : null;
}

export function pruneTerminalTabsForSessions(args: {
  retainedTerminalId: string | null;
  tabs: readonly FixedPanelTab[];
  terminalSessions: readonly TerminalSession[];
}): readonly FixedPanelTab[] {
  const ids = visibleTerminalIds(
    args.terminalSessions,
    args.retainedTerminalId,
  );
  const next = args.tabs.filter(
    (t) => t.kind !== "terminal" || ids.has(t.terminalId),
  );
  return next.length === args.tabs.length ? args.tabs : next;
}

export function pruneTerminalTabsInFixedPanelState(args: {
  retainedTerminalId: string | null;
  state: FixedPanelTabsState;
  terminalSessions: readonly TerminalSession[];
}): FixedPanelTabsState {
  const tabs = pruneTerminalTabsForSessions({
    tabs: args.state.secondary.tabs,
    retainedTerminalId: args.retainedTerminalId,
    terminalSessions: args.terminalSessions,
  });
  if (tabs === args.state.secondary.tabs) return args.state;
  const kept = new Set(tabs.map((t) => t.id));
  let next = args.state;
  for (const tab of args.state.secondary.tabs) {
    if (!kept.has(tab.id)) next = closeSecondaryPanelTabInState(next, tab.id);
  }
  return next;
}

function syncTerminals<T extends SecondaryFixedPanelTab>(
  tabs: readonly T[],
  sessions: readonly TerminalSession[],
  retainedTerminalId: string | null,
): { changed: boolean; tabs: Array<T | TerminalFixedPanelTab> } {
  const visible = visibleTerminalIds(sessions, retainedTerminalId);
  const seen = new Set<string>();
  const out: Array<T | TerminalFixedPanelTab> = [];
  let changed = false;
  for (const tab of tabs) {
    if (tab.kind === "terminal") {
      if (!visible.has(tab.terminalId) || seen.has(tab.terminalId)) {
        changed = true;
        continue;
      }
      seen.add(tab.terminalId);
    }
    out.push(tab);
  }
  for (const session of sessions) {
    if (!visible.has(session.id) || seen.has(session.id)) continue;
    seen.add(session.id);
    out.push(createTerminalFixedPanelTab({ terminalId: session.id }));
    changed = true;
  }
  return { tabs: out, changed };
}

export function buildTerminalSyncedSecondaryFileTabs(args: {
  orderedTabs: readonly SecondaryFileFixedPanelTab[];
  retainedTerminalId: string | null;
  terminalSessions: readonly TerminalSession[];
}): readonly SecondaryFileFixedPanelTab[] {
  return syncTerminals(
    args.orderedTabs,
    args.terminalSessions,
    args.retainedTerminalId,
  ).tabs;
}

export function syncTerminalTabsInFixedPanelState(args: {
  retainedTerminalId: string | null;
  state: FixedPanelTabsState;
  terminalSessions: readonly TerminalSession[];
}): FixedPanelTabsState {
  const pruned = pruneTerminalTabsInFixedPanelState(args);
  const { tabs, changed } = syncTerminals(
    pruned.secondary.tabs,
    args.terminalSessions,
    args.retainedTerminalId,
  );
  const activeTabId =
    pruned.secondary.activeTabId !== null &&
    tabs.some((t) => t.id === pruned.secondary.activeTabId)
      ? pruned.secondary.activeTabId
      : null;
  if (!changed && activeTabId === pruned.secondary.activeTabId) return pruned;
  return { ...pruned, secondary: { ...pruned.secondary, activeTabId, tabs } };
}
