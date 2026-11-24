import { arrayMove } from "@cloudroom/client-core";
import {
  MAX_PANES,
  countPanes,
  findPane,
  listPanes,
  movePane,
  removePane,
  resizeSplit,
  setFocus,
  splitPane,
  type LayoutNode,
  type PaneContent,
  type PaneNode,
  type SplitLayout,
  type SplitPath,
  type SplitSide,
} from "@/lib/split-layout";
import type { SplitDropTarget } from "@/lib/split-drag";
import {
  FIXED_PANEL_TABS_IDLE_EXPIRY_MS,
  createThreadInfoFixedPanelTab,
  getFixedPanelTabsStateStorageKey,
  getLegacyFixedPanelTabsStorageKey,
} from "./tab-model";

const SPLIT_VERSION = 1;
const SPLIT_STORAGE_PREFIX = "room.thread.panelSplit";
const LEGACY_SPLIT_STORAGE_PREFIX = "bb.thread.secondaryPanelSplitLayout";
const SPLIT_PLUGIN_ID = "room-right-panel-split";
const LEGACY_SPLIT_PLUGIN_ID = "bb-secondary-panel-split";
const SIZE_EPSILON = 1e-9;

export const SIDEBAR_FIXED_INFO_TAB_ID = createThreadInfoFixedPanelTab().id;

export interface SidebarSplitStorage {
  readonly length: number;
  getItem(key: string): string | null;
  key(index: number): string | null;
  removeItem(key: string): void;
}

export interface SidebarTabGroup {
  activeTabId: string;
  id: string;
  tabIds: string[];
}

export interface SidebarSplitState {
  groups: Record<string, SidebarTabGroup>;
  layout: SplitLayout;
  maximizedPaneId: string | null;
  version: typeof SPLIT_VERSION;
}

export interface SidebarTabPlacement {
  followingTabId: string | null;
  groupId: string;
  index: number;
  precedingTabId: string | null;
}

function groupContent(groupId: string): PaneContent {
  return {
    kind: "plugin-panel",
    pluginId: SPLIT_PLUGIN_ID,
    panelPath: groupId,
    subPath: "",
  };
}

export function sidebarPaneNode(paneId: string, groupId: string): PaneNode {
  return { type: "pane", paneId, content: groupContent(groupId) };
}

export function sidebarPaneGroupId(pane: PaneNode): string | null {
  return pane.content.kind === "plugin-panel" &&
    (pane.content.pluginId === SPLIT_PLUGIN_ID ||
      pane.content.pluginId === LEGACY_SPLIT_PLUGIN_ID)
    ? pane.content.panelPath
    : null;
}

export function createSidebarSplitState(
  tabIds: readonly string[],
  activeTabId: string,
  ids: { groupId: string; paneId: string } = {
    groupId: "group-primary",
    paneId: "pane-primary",
  },
): SidebarSplitState {
  const unique = [...new Set(tabIds)];
  const active = unique.includes(activeTabId)
    ? activeTabId
    : (unique[0] ?? SIDEBAR_FIXED_INFO_TAB_ID);
  return {
    version: SPLIT_VERSION,
    groups: {
      [ids.groupId]: { id: ids.groupId, tabIds: unique, activeTabId: active },
    },
    layout: {
      root: sidebarPaneNode(ids.paneId, ids.groupId),
      focusedPaneId: ids.paneId,
    },
    maximizedPaneId: null,
  };
}

const sameStrings = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

function sameLayout(a: LayoutNode, b: LayoutNode): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "pane" || b.type === "pane") {
    return (
      a.type === "pane" &&
      b.type === "pane" &&
      a.paneId === b.paneId &&
      sidebarPaneGroupId(a) === sidebarPaneGroupId(b)
    );
  }
  return (
    a.dir === b.dir &&
    a.sizes.length === b.sizes.length &&
    a.sizes.every((s, i) => s === b.sizes[i]) &&
    a.children.length === b.children.length &&
    a.children.every(
      (child, i) =>
        b.children[i] !== undefined && sameLayout(child, b.children[i]!),
    )
  );
}

function sameState(a: SidebarSplitState, b: SidebarSplitState): boolean {
  const aKeys = Object.keys(a.groups);
  const bKeys = Object.keys(b.groups);
  if (
    a.version !== b.version ||
    a.layout.focusedPaneId !== b.layout.focusedPaneId ||
    a.maximizedPaneId !== b.maximizedPaneId ||
    !sameStrings(aKeys, bKeys) ||
    !sameLayout(a.layout.root, b.layout.root)
  ) {
    return false;
  }
  return aKeys.every((k) => {
    const ga = a.groups[k];
    const gb = b.groups[k];
    return (
      ga !== undefined &&
      gb !== undefined &&
      ga.id === gb.id &&
      ga.activeTabId === gb.activeTabId &&
      sameStrings(ga.tabIds, gb.tabIds)
    );
  });
}

const keepIdentity = (cur: SidebarSplitState, next: SidebarSplitState) =>
  sameState(cur, next) ? cur : next;

function paneGroup(
  state: SidebarSplitState,
  paneId: string,
): { group: SidebarTabGroup; groupId: string } | null {
  const pane = findPane(state.layout.root, paneId);
  const groupId = pane ? sidebarPaneGroupId(pane) : null;
  const group = groupId ? state.groups[groupId] : undefined;
  return groupId && group ? { groupId, group } : null;
}

function maxAfterRemoval(
  prevMax: string | null,
  removedId: string,
  layout: SplitLayout,
): string | null {
  if (countPanes(layout.root) <= 1) return null;
  return prevMax === removedId ? layout.focusedPaneId : prevMax;
}

export function getSidebarGroupForPane(
  state: SidebarSplitState,
  paneId: string,
): SidebarTabGroup | null {
  return paneGroup(state, paneId)?.group ?? null;
}

export function getSidebarTabPlacement(
  state: SidebarSplitState,
  tabId: string,
): SidebarTabPlacement | null {
  const group = Object.values(state.groups).find((g) =>
    g.tabIds.includes(tabId),
  );
  if (!group) return null;
  const index = group.tabIds.indexOf(tabId);
  return {
    groupId: group.id,
    index,
    precedingTabId: group.tabIds[index - 1] ?? null,
    followingTabId: group.tabIds[index + 1] ?? null,
  };
}

export function restoreSidebarTabPlacement(
  state: SidebarSplitState,
  tabId: string,
  placement: SidebarTabPlacement,
): SidebarSplitState {
  const currentGroup = Object.values(state.groups).find((g) =>
    g.tabIds.includes(tabId),
  );
  if (!currentGroup) return state;
  const placed = state.groups[placement.groupId];
  const targetGroup =
    placed !== undefined &&
    (placed.id === currentGroup.id || currentGroup.tabIds.length > 1)
      ? placed
      : currentGroup;
  const groups: Record<string, SidebarTabGroup> = {};
  for (const [id, g] of Object.entries(state.groups)) {
    const tabIds = g.tabIds.filter((t) => t !== tabId);
    groups[id] = {
      ...g,
      tabIds,
      activeTabId:
        g.activeTabId === tabId
          ? (tabIds[0] ?? targetGroup.activeTabId)
          : g.activeTabId,
    };
  }
  const dest = groups[targetGroup.id];
  if (!dest) return state;
  const followIdx =
    placement.followingTabId === null
      ? -1
      : dest.tabIds.indexOf(placement.followingTabId);
  const prevIdx =
    placement.precedingTabId === null
      ? -1
      : dest.tabIds.indexOf(placement.precedingTabId);
  const insertAt =
    followIdx >= 0
      ? followIdx
      : prevIdx >= 0
        ? prevIdx + 1
        : Math.min(placement.index, dest.tabIds.length);
  const nextIds = [...dest.tabIds];
  nextIds.splice(insertAt, 0, tabId);
  groups[targetGroup.id] = { ...dest, tabIds: nextIds };
  return { ...state, groups };
}

export function isCanonicalSidebarSplitState(
  state: SidebarSplitState,
  availableTabIds: readonly string[],
  activeTabId: string,
): boolean {
  return sameState(
    state,
    createSidebarSplitState(availableTabIds, activeTabId),
  );
}

export function selectSidebarTab(
  state: SidebarSplitState,
  paneId: string,
  tabId: string,
): SidebarSplitState {
  const pg = paneGroup(state, paneId);
  if (!pg || !pg.group.tabIds.includes(tabId)) return state;
  const maximizedPaneId = state.maximizedPaneId === null ? null : paneId;
  if (
    pg.group.activeTabId === tabId &&
    state.layout.focusedPaneId === paneId &&
    state.maximizedPaneId === maximizedPaneId
  ) {
    return state;
  }
  return {
    ...state,
    groups: {
      ...state.groups,
      [pg.groupId]: { ...pg.group, activeTabId: tabId },
    },
    layout: setFocus(state.layout, paneId),
    maximizedPaneId,
  };
}

export function focusSidebarPane(
  state: SidebarSplitState,
  paneId: string,
): SidebarSplitState {
  if (!findPane(state.layout.root, paneId)) return state;
  const maximizedPaneId = state.maximizedPaneId === null ? null : paneId;
  if (
    state.layout.focusedPaneId === paneId &&
    state.maximizedPaneId === maximizedPaneId
  )
    return state;
  return { ...state, layout: setFocus(state.layout, paneId), maximizedPaneId };
}

export function replaceSidebarTab(
  state: SidebarSplitState,
  previousTabId: string,
  nextTabId: string,
): SidebarSplitState {
  if (previousTabId === nextTabId) return state;
  const allGroups = Object.values(state.groups);
  if (allGroups.some((g) => g.tabIds.includes(nextTabId))) return state;
  const owner = allGroups.find((g) => g.tabIds.includes(previousTabId));
  if (!owner) return state;
  return {
    ...state,
    groups: {
      ...state.groups,
      [owner.id]: {
        ...owner,
        tabIds: owner.tabIds.map((id) =>
          id === previousTabId ? nextTabId : id,
        ),
        activeTabId:
          owner.activeTabId === previousTabId ? nextTabId : owner.activeTabId,
      },
    },
  };
}

export function reorderSidebarTab(
  state: SidebarSplitState,
  paneId: string,
  activeTabId: string,
  overTabId: string,
): SidebarSplitState {
  const pg = paneGroup(state, paneId);
  if (!pg || activeTabId === overTabId) return state;
  const from = pg.group.tabIds.indexOf(activeTabId);
  const to = pg.group.tabIds.indexOf(overTabId);
  if (from === -1 || to === -1) return state;
  return {
    ...state,
    groups: {
      ...state.groups,
      [pg.groupId]: {
        ...pg.group,
        tabIds: arrayMove(pg.group.tabIds, from, to),
      },
    },
  };
}

export function moveSidebarTab(
  state: SidebarSplitState,
  sourcePaneId: string,
  tabId: string,
  target: SplitDropTarget,
  ids: { groupId: string },
): SidebarSplitState {
  const src = paneGroup(state, sourcePaneId);
  const dst = paneGroup(state, target.paneId);
  if (!src || !dst || !src.group.tabIds.includes(tabId)) return state;

  if (target.zone === "center") {
    if (sourcePaneId === target.paneId) return state;
    const groups = { ...state.groups };
    groups[dst.groupId] = {
      ...dst.group,
      tabIds: [...dst.group.tabIds.filter((id) => id !== tabId), tabId],
      activeTabId: tabId,
    };
    if (src.group.tabIds.length === 1) {
      delete groups[src.groupId];
      const layout = removePane(state.layout, sourcePaneId);
      return {
        ...state,
        groups,
        layout: setFocus(layout, target.paneId),
        maximizedPaneId:
          countPanes(layout.root) > 1 && state.maximizedPaneId !== null
            ? target.paneId
            : null,
      };
    }
    const remaining = src.group.tabIds.filter((id) => id !== tabId);
    groups[src.groupId] = {
      ...src.group,
      tabIds: remaining,
      activeTabId:
        src.group.activeTabId === tabId
          ? (remaining[0] ?? dst.group.activeTabId)
          : src.group.activeTabId,
    };
    return {
      ...state,
      groups,
      layout: setFocus(state.layout, target.paneId),
      maximizedPaneId: state.maximizedPaneId === null ? null : target.paneId,
    };
  }

  if (src.group.tabIds.length === 1) {
    const layout = movePane(
      state.layout,
      sourcePaneId,
      target.paneId,
      target.zone,
    );
    return layout === state.layout ? state : { ...state, layout };
  }
  if (
    countPanes(state.layout.root) >= MAX_PANES ||
    state.groups[ids.groupId] !== undefined
  )
    return state;
  const remaining = src.group.tabIds.filter((id) => id !== tabId);
  const layout = splitPane(
    state.layout,
    target.paneId,
    target.zone,
    groupContent(ids.groupId),
  );
  return {
    ...state,
    groups: {
      ...state.groups,
      [src.groupId]: {
        ...src.group,
        tabIds: remaining,
        activeTabId:
          src.group.activeTabId === tabId
            ? (remaining[0] ?? src.group.activeTabId)
            : src.group.activeTabId,
      },
      [ids.groupId]: { id: ids.groupId, tabIds: [tabId], activeTabId: tabId },
    },
    layout,
    maximizedPaneId:
      state.maximizedPaneId === sourcePaneId
        ? layout.focusedPaneId
        : state.maximizedPaneId,
  };
}

export function removeSidebarSplit(
  state: SidebarSplitState,
  paneId: string,
): SidebarSplitState {
  if (countPanes(state.layout.root) <= 1) return state;
  const removed = paneGroup(state, paneId);
  if (!removed) return state;
  const removedFocused = state.layout.focusedPaneId === paneId;
  const layout = removePane(state.layout, paneId);
  const survivor = paneGroup({ ...state, layout }, layout.focusedPaneId);
  if (!survivor) return state;
  const groups = { ...state.groups };
  delete groups[removed.groupId];
  groups[survivor.groupId] = {
    ...survivor.group,
    tabIds: [
      ...survivor.group.tabIds,
      ...removed.group.tabIds.filter(
        (id) => !survivor.group.tabIds.includes(id),
      ),
    ],
    activeTabId: removedFocused
      ? removed.group.activeTabId
      : survivor.group.activeTabId,
  };
  return {
    ...state,
    groups,
    layout,
    maximizedPaneId: maxAfterRemoval(state.maximizedPaneId, paneId, layout),
  };
}

export function setSidebarPaneMaximized(
  state: SidebarSplitState,
  paneId: string | null,
): SidebarSplitState {
  if (paneId === null)
    return state.maximizedPaneId === null
      ? state
      : { ...state, maximizedPaneId: null };
  if (countPanes(state.layout.root) < 2 || !findPane(state.layout.root, paneId))
    return state;
  if (state.maximizedPaneId === paneId && state.layout.focusedPaneId === paneId)
    return state;
  return {
    ...state,
    layout: setFocus(state.layout, paneId),
    maximizedPaneId: paneId,
  };
}

export function toggleSidebarPaneMaximize(
  state: SidebarSplitState,
  paneId: string,
): SidebarSplitState {
  return setSidebarPaneMaximized(
    state,
    state.maximizedPaneId === paneId ? null : paneId,
  );
}

export function moveSidebarPaneToSide(
  state: SidebarSplitState,
  paneId: string,
  targetPaneId: string,
  side: SplitSide,
): SidebarSplitState {
  const layout = movePane(state.layout, paneId, targetPaneId, side);
  return layout === state.layout ? state : { ...state, layout };
}

export function resizeSidebarSplit(
  state: SidebarSplitState,
  path: SplitPath,
  childIndex: number,
  fraction: number,
): SidebarSplitState {
  const layout = resizeSplit(state.layout, path, childIndex, fraction);
  return layout === state.layout ? state : { ...state, layout };
}

function insertMissingInOrder(
  existing: readonly string[],
  missing: readonly string[],
  available: readonly string[],
): string[] {
  const next = [...existing];
  for (const id of missing) {
    const idx = available.indexOf(id);
    const follow = available.slice(idx + 1).find((t) => next.includes(t));
    if (follow !== undefined) {
      next.splice(next.indexOf(follow), 0, id);
      continue;
    }
    const prev = [...available.slice(0, idx)]
      .reverse()
      .find((t) => next.includes(t));
    next.splice(
      prev === undefined ? next.length : next.indexOf(prev) + 1,
      0,
      id,
    );
  }
  return next;
}

export function reconcileSidebarSplitState(
  state: SidebarSplitState,
  availableTabIds: readonly string[],
  activeTabId: string,
): SidebarSplitState {
  const available = [...new Set(availableTabIds)];
  if (available.length === 0) return state;
  const allowed = new Set(available);
  const seen = new Set<string>();
  const groups = { ...state.groups };

  for (const pane of listPanes(state.layout.root)) {
    const gid = sidebarPaneGroupId(pane);
    const g = gid ? groups[gid] : undefined;
    if (!gid || !g)
      return keepIdentity(
        state,
        createSidebarSplitState(available, activeTabId),
      );
    const tabIds = g.tabIds.filter((id) => {
      if (!allowed.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    groups[gid] = {
      ...g,
      tabIds,
      activeTabId: tabIds.includes(g.activeTabId)
        ? g.activeTabId
        : (tabIds[0] ?? activeTabId),
    };
  }

  let next: SidebarSplitState = { ...state, groups };
  for (const pane of listPanes(next.layout.root)) {
    if (countPanes(next.layout.root) === 1) break;
    const pg = paneGroup(next, pane.paneId);
    if (pg && pg.group.tabIds.length === 0) {
      const nextGroups = { ...next.groups };
      delete nextGroups[pg.groupId];
      const layout = removePane(next.layout, pane.paneId);
      next = {
        ...next,
        groups: nextGroups,
        layout,
        maximizedPaneId: maxAfterRemoval(
          next.maximizedPaneId,
          pane.paneId,
          layout,
        ),
      };
    }
  }

  const missing = available.filter((id) => !seen.has(id));
  const focused = getSidebarGroupForPane(next, next.layout.focusedPaneId);
  if (!focused)
    return keepIdentity(state, createSidebarSplitState(available, activeTabId));
  if (missing.length > 0 || focused.tabIds.length === 0) {
    next = {
      ...next,
      groups: {
        ...next.groups,
        [focused.id]: {
          ...focused,
          tabIds: insertMissingInOrder(focused.tabIds, missing, available),
          activeTabId:
            focused.tabIds.length === 0 ? activeTabId : focused.activeTabId,
        },
      },
    };
  }

  for (const pane of listPanes(next.layout.root)) {
    const pg = paneGroup(next, pane.paneId);
    if (pg && !pg.group.tabIds.includes(pg.group.activeTabId)) {
      const fallback = pg.group.tabIds[0];
      if (!fallback)
        return keepIdentity(
          state,
          createSidebarSplitState(available, activeTabId),
        );
      next = {
        ...next,
        groups: {
          ...next.groups,
          [pg.groupId]: { ...pg.group, activeTabId: fallback },
        },
      };
    }
  }
  if (
    next.maximizedPaneId !== null &&
    !findPane(next.layout.root, next.maximizedPaneId)
  ) {
    next = {
      ...next,
      maximizedPaneId:
        countPanes(next.layout.root) > 1 ? next.layout.focusedPaneId : null,
    };
  }
  return keepIdentity(state, next);
}

// --- Plain Structural Validation & Storage ---

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

function parseLayoutNode(v: unknown): LayoutNode | null {
  if (!isObj(v)) return null;
  if (v.type === "pane") {
    const keys = Object.keys(v);
    if (keys.length !== 3 || !isStr(v.paneId) || !isObj(v.content)) return null;
    const c = v.content;
    if (
      Object.keys(c).length !== 4 ||
      c.kind !== "plugin-panel" ||
      (c.pluginId !== SPLIT_PLUGIN_ID &&
        c.pluginId !== LEGACY_SPLIT_PLUGIN_ID) ||
      !isStr(c.panelPath) ||
      c.subPath !== ""
    ) {
      return null;
    }
    return {
      type: "pane",
      paneId: v.paneId,
      content: groupContent(c.panelPath),
    };
  }
  if (v.type === "split") {
    if (Object.keys(v).length !== 4 || (v.dir !== "row" && v.dir !== "col"))
      return null;
    if (
      !Array.isArray(v.sizes) ||
      !Array.isArray(v.children) ||
      v.sizes.length < 2 ||
      v.sizes.length !== v.children.length
    ) {
      return null;
    }
    let total = 0;
    const sizes: number[] = [];
    for (const s of v.sizes) {
      if (typeof s !== "number" || !Number.isFinite(s) || s <= 0) return null;
      sizes.push(s);
      total += s;
    }
    if (Math.abs(total - 1) > SIZE_EPSILON) return null;
    const children: LayoutNode[] = [];
    for (const child of v.children) {
      const node = parseLayoutNode(child);
      if (!node) return null;
      children.push(node);
    }
    return { type: "split", dir: v.dir, sizes, children };
  }
  return null;
}

const STATE_KEYS = new Set(["version", "groups", "layout", "maximizedPaneId"]);
const GROUP_KEYS = new Set(["id", "tabIds", "activeTabId"]);

function validateSplitState(raw: unknown): SidebarSplitState | null {
  if (
    !isObj(raw) ||
    raw.version !== SPLIT_VERSION ||
    !Object.keys(raw).every((k) => STATE_KEYS.has(k))
  )
    return null;
  if (
    !isObj(raw.layout) ||
    Object.keys(raw.layout).length !== 2 ||
    !isStr(raw.layout.focusedPaneId)
  )
    return null;
  const root = parseLayoutNode(raw.layout.root);
  if (!root) return null;
  if (!isObj(raw.groups)) return null;

  const groups: Record<string, SidebarTabGroup> = {};
  for (const [key, value] of Object.entries(raw.groups)) {
    if (!isObj(value) || !Object.keys(value).every((k) => GROUP_KEYS.has(k)))
      return null;
    if (value.id !== key || !isStr(value.id) || !isStr(value.activeTabId))
      return null;
    if (
      !Array.isArray(value.tabIds) ||
      value.tabIds.length === 0 ||
      !value.tabIds.every(isStr)
    )
      return null;
    if (!value.tabIds.includes(value.activeTabId)) return null;
    groups[key] = {
      id: value.id,
      tabIds: value.tabIds,
      activeTabId: value.activeTabId,
    };
  }

  const panes = listPanes(root);
  if (panes.length === 0 || panes.length > MAX_PANES) return null;
  const paneIds = panes.map((p) => p.paneId);
  if (
    new Set(paneIds).size !== paneIds.length ||
    !paneIds.includes(raw.layout.focusedPaneId)
  )
    return null;

  const refGroups = panes.map(sidebarPaneGroupId);
  const groupKeys = Object.keys(groups);
  if (
    refGroups.some((id) => id === null || groups[id] === undefined) ||
    new Set(refGroups).size !== panes.length ||
    groupKeys.length !== panes.length
  ) {
    return null;
  }

  if (
    raw.maximizedPaneId !== undefined &&
    raw.maximizedPaneId !== null &&
    !isStr(raw.maximizedPaneId)
  )
    return null;
  const maxId =
    typeof raw.maximizedPaneId === "string" &&
    findPane(root, raw.maximizedPaneId) !== null
      ? raw.maximizedPaneId
      : null;

  return {
    version: SPLIT_VERSION,
    groups,
    layout: { root, focusedPaneId: raw.layout.focusedPaneId },
    maximizedPaneId: maxId,
  };
}

export function sidebarSplitStorageKey(panelStateId: string): string {
  return `${SPLIT_STORAGE_PREFIX}.${panelStateId}`;
}

export function legacySidebarSplitStorageKey(panelStateId: string): string {
  return `${LEGACY_SPLIT_STORAGE_PREFIX}.${panelStateId}`;
}

function readLastUsedAt(storedValue: string | null): number | null {
  if (storedValue === null) return null;
  try {
    const parsed: unknown = JSON.parse(storedValue);
    if (!isObj(parsed)) return null;
    return typeof parsed.lastUsedAt === "number" &&
      Number.isInteger(parsed.lastUsedAt) &&
      parsed.lastUsedAt >= 0
      ? parsed.lastUsedAt
      : null;
  } catch {
    return null;
  }
}

export function pruneSidebarSplitStorage(args: {
  now: number;
  storage: SidebarSplitStorage;
}): void {
  const prefixes = [
    `${SPLIT_STORAGE_PREFIX}.`,
    `${LEGACY_SPLIT_STORAGE_PREFIX}.`,
  ];
  const keys: { key: string; panelStateId: string }[] = [];
  for (let i = 0; i < args.storage.length; i += 1) {
    const key = args.storage.key(i);
    if (!key) continue;
    const prefix = prefixes.find((p) => key.startsWith(p));
    if (prefix) keys.push({ key, panelStateId: key.slice(prefix.length) });
  }
  for (const { key, panelStateId } of keys) {
    const lastUsedAt =
      readLastUsedAt(
        args.storage.getItem(
          getFixedPanelTabsStateStorageKey({ threadId: panelStateId }),
        ),
      ) ??
      readLastUsedAt(
        args.storage.getItem(getLegacyFixedPanelTabsStorageKey(panelStateId)),
      );
    if (
      panelStateId.length === 0 ||
      lastUsedAt === null ||
      args.now - lastUsedAt > FIXED_PANEL_TABS_IDLE_EXPIRY_MS
    ) {
      args.storage.removeItem(key);
    }
  }
}

export function parseSidebarSplitState(
  storedValue: string | null,
  availableTabIds: readonly string[],
  activeTabId: string,
): SidebarSplitState {
  if (storedValue !== null) {
    try {
      const valid = validateSplitState(JSON.parse(storedValue));
      if (valid)
        return reconcileSidebarSplitState(valid, availableTabIds, activeTabId);
    } catch {}
  }
  return createSidebarSplitState(availableTabIds, activeTabId);
}

export function serializeSidebarSplitState(state: SidebarSplitState): string {
  return JSON.stringify(state);
}
