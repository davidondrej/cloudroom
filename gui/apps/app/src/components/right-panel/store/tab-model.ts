import {
  ROOM_DESKTOP_BROWSER_MAX_TITLE_LENGTH,
  ROOM_DESKTOP_BROWSER_MAX_URL_LENGTH,
  type RoomDesktopBrowserTarget,
} from "@cloudroom/desktop-contract";
import type {
  TerminalCreateTarget,
  ThreadTabFileOpenerOwner,
} from "@cloudroom/server-contract";
import {
  areEnvironmentFilePreviewSourcesEqual,
  areFilePreviewLineRangesEqual,
  type EnvironmentFilePreviewSource,
  type FilePreviewLineRange,
  type HostFileTabState,
  type ThreadStorageFileTabState,
  type WorkspaceFilePreviewStatusLabel,
  type WorkspaceFileTabState,
} from "@cloudroom/client-core";
import { getLocalStorage } from "@/lib/browser-storage";
import { randomId } from "@/lib/random-id";

const STORAGE_PREFIX = "room.thread.panelTabs";
const LEGACY_STORAGE_PREFIX = "bb.thread.fixedPanelTabsState";
export const FIXED_PANEL_TABS_STATE_STORAGE_VERSION = 1;
export const FIXED_PANEL_TABS_IDLE_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

const THREAD_INFO_ID = "thread-info:thread-info:none";
const GIT_DIFF_ID = "git-diff:git-diff:none";
const NEW_TAB_ID = "new-tab:new-tab:none";

export type ThreadSecondaryPanel = "git-diff" | "thread-info";

export interface ThreadInfoFixedPanelTab {
  id: string;
  kind: "thread-info";
}

export interface GitDiffFixedPanelTab {
  id: string;
  kind: "git-diff";
}

export interface PluginPageFixedPanelTab {
  fixedTabId: string;
  id: string;
  kind: "plugin-page-fixed";
  pageId: string;
  pluginId: string;
}

export type FixedPanelViewTab =
  | ThreadInfoFixedPanelTab
  | GitDiffFixedPanelTab
  | PluginPageFixedPanelTab;

export interface PluginPanelFixedPanelTab {
  actionId: string;
  fileOpenerOwner?: ThreadTabFileOpenerOwner;
  id: string;
  kind: "plugin-panel";
  paramsJson: string | null;
  pluginId: string;
  title: string;
}

export interface WorkspaceFilePreviewFixedPanelTab {
  environmentId: string | null;
  id: string;
  kind: "workspace-file-preview";
  lineRange: FilePreviewLineRange | null;
  path: string;
  projectId: string | null;
  source: EnvironmentFilePreviewSource;
  statusLabel: WorkspaceFilePreviewStatusLabel | null;
}

export interface HostFilePreviewFixedPanelTab {
  environmentId: string | null;
  hostId: string | null;
  id: string;
  kind: "host-file-preview";
  lineRange: FilePreviewLineRange | null;
  path: string;
  threadId: string | null;
}

export interface ThreadStorageFilePreviewFixedPanelTab {
  environmentId: string | null;
  id: string;
  isPinned: boolean;
  kind: "thread-storage-file-preview";
  lineRange: FilePreviewLineRange | null;
  path: string;
  threadId: string | null;
}

export interface BrowserFixedPanelTab {
  desktopTarget?: RoomDesktopBrowserTarget;
  environmentId: string | null;
  id: string;
  kind: "browser";
  title: string | null;
  url: string;
}

export interface NewTabFixedPanelTab {
  id: string;
  kind: "new-tab";
}

export interface TerminalFixedPanelTab {
  id: string;
  kind: "terminal";
  target?: TerminalCreateTarget;
  terminalId: string;
}

export type SecondaryFixedPanelTab =
  | ThreadInfoFixedPanelTab
  | GitDiffFixedPanelTab
  | PluginPageFixedPanelTab
  | PluginPanelFixedPanelTab
  | WorkspaceFilePreviewFixedPanelTab
  | HostFilePreviewFixedPanelTab
  | ThreadStorageFilePreviewFixedPanelTab
  | BrowserFixedPanelTab
  | NewTabFixedPanelTab
  | TerminalFixedPanelTab;

export type SecondaryFileFixedPanelTab =
  | WorkspaceFilePreviewFixedPanelTab
  | HostFilePreviewFixedPanelTab
  | ThreadStorageFilePreviewFixedPanelTab
  | BrowserFixedPanelTab
  | NewTabFixedPanelTab
  | TerminalFixedPanelTab
  | PluginPanelFixedPanelTab;

export type FixedPanelTab = SecondaryFixedPanelTab;

export interface SecondaryTabGroupState {
  activeTabId: string | null;
  isOpen: boolean;
  previousActiveTabId?: string;
  tabs: readonly FixedPanelTab[];
}

export interface FixedPanelTabsState {
  lastUsedAt: number;
  secondary: SecondaryTabGroupState;
  version: typeof FIXED_PANEL_TABS_STATE_STORAGE_VERSION;
}

// --- ID & Factory Helpers ---

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function buildFixedPanelTabId(args: {
  environmentId: string | null;
  kind: FixedPanelTab["kind"];
  path: string;
}): string {
  return `${args.kind}:${encodeURIComponent(args.path)}:${encodeURIComponent(args.environmentId ?? "none")}`;
}

function workspaceTabId(
  environmentId: string | null,
  projectId: string | null,
  path: string,
): string {
  return buildFixedPanelTabId({
    kind: "workspace-file-preview",
    path,
    environmentId: environmentId ?? (projectId ? `project:${projectId}` : null),
  });
}

function hostTabId(
  environmentId: string | null,
  hostId: string | null,
  threadId: string | null,
  path: string,
): string {
  const scope =
    hostId !== null
      ? `host:${hostId}`
      : threadId !== null && environmentId !== null
        ? `thread:${threadId}:environment:${environmentId}`
        : null;
  return buildFixedPanelTabId({
    kind: "host-file-preview",
    path,
    environmentId: scope,
  });
}

function storageTabId(threadId: string | null, path: string): string {
  return buildFixedPanelTabId({
    kind: "thread-storage-file-preview",
    path,
    environmentId: threadId === null ? null : `thread:${threadId}`,
  });
}

export function createThreadInfoFixedPanelTab(): ThreadInfoFixedPanelTab {
  return { id: THREAD_INFO_ID, kind: "thread-info" };
}

export function createGitDiffFixedPanelTab(): GitDiffFixedPanelTab {
  return { id: GIT_DIFF_ID, kind: "git-diff" };
}

export function createNewTabFixedPanelTab(): NewTabFixedPanelTab {
  return { id: NEW_TAB_ID, kind: "new-tab" };
}

export function createPluginPageFixedPanelTab(args: {
  fixedTabId: string;
  pageId: string;
  pluginId: string;
}): PluginPageFixedPanelTab {
  return {
    fixedTabId: args.fixedTabId,
    pageId: args.pageId,
    pluginId: args.pluginId,
    kind: "plugin-page-fixed",
    id: buildFixedPanelTabId({
      kind: "plugin-page-fixed",
      path: `${args.pluginId}:${args.pageId}:${args.fixedTabId}`,
      environmentId: null,
    }),
  };
}

export function createPluginPanelFixedPanelTab(args: {
  actionId: string;
  paramsJson: string | null;
  pluginId: string;
  title: string;
}): PluginPanelFixedPanelTab {
  return {
    actionId: args.actionId,
    paramsJson: args.paramsJson,
    pluginId: args.pluginId,
    title: args.title,
    kind: "plugin-panel",
    id: buildFixedPanelTabId({
      kind: "plugin-panel",
      path: `${args.pluginId}:${args.actionId}:${args.paramsJson ?? ""}`,
      environmentId: null,
    }),
  };
}

export function createWorkspaceFilePreviewFixedPanelTab(args: {
  environmentId: string | null;
  projectId: string | null;
  tab: WorkspaceFileTabState;
}): WorkspaceFilePreviewFixedPanelTab {
  return {
    kind: "workspace-file-preview",
    id: workspaceTabId(args.environmentId, args.projectId, args.tab.path),
    environmentId: args.environmentId,
    projectId: args.projectId,
    path: args.tab.path,
    source: args.tab.source,
    statusLabel: args.tab.statusLabel,
    lineRange: args.tab.lineRange,
  };
}

export function createHostFilePreviewFixedPanelTab(args: {
  environmentId: string | null;
  hostId?: string | null;
  tab: HostFileTabState;
  threadId: string | null;
}): HostFilePreviewFixedPanelTab {
  const hostId = args.hostId ?? null;
  return {
    kind: "host-file-preview",
    id: hostTabId(args.environmentId, hostId, args.threadId, args.tab.path),
    environmentId: args.environmentId,
    hostId,
    threadId: args.threadId,
    path: args.tab.path,
    lineRange: args.tab.lineRange,
  };
}

export function createThreadStorageFilePreviewFixedPanelTab(args: {
  environmentId: string | null;
  isPinned: boolean;
  tab: ThreadStorageFileTabState;
  threadId: string;
}): ThreadStorageFilePreviewFixedPanelTab {
  return {
    kind: "thread-storage-file-preview",
    id: storageTabId(args.threadId, args.tab.path),
    environmentId: args.environmentId,
    threadId: args.threadId,
    isPinned: args.isPinned,
    path: args.tab.path,
    lineRange: args.tab.lineRange,
  };
}

export function createBrowserFixedPanelTab(args: {
  environmentId: string | null;
  url: string;
}): BrowserFixedPanelTab {
  return {
    kind: "browser",
    id: buildFixedPanelTabId({
      kind: "browser",
      path: randomId(),
      environmentId: args.environmentId,
    }),
    environmentId: args.environmentId,
    title: null,
    url: args.url,
  };
}

export function createTerminalFixedPanelTab(args: {
  target?: TerminalCreateTarget;
  terminalId: string;
}): TerminalFixedPanelTab {
  return {
    kind: "terminal",
    id: buildFixedPanelTabId({
      kind: "terminal",
      path: args.terminalId,
      environmentId: null,
    }),
    terminalId: args.terminalId,
    ...(args.target !== undefined ? { target: args.target } : {}),
  };
}

// --- Plain Structural Validation (Zero Zod Overhead) ---

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyStr = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;
const isNullOrNonEmptyStr = (v: unknown): v is string | null =>
  v === null || isNonEmptyStr(v);
const isOptNullNonEmptyStr = (v: unknown): string | null | undefined =>
  v === undefined ? null : isNullOrNonEmptyStr(v) ? v : undefined;
const hasOnlyKeys = (o: Obj, allowed: ReadonlySet<string>): boolean =>
  Object.keys(o).every((k) => allowed.has(k));

const LINE_RANGE_KEYS = new Set(["startLineNumber", "endLineNumber"]);
function parseLineRange(v: unknown): FilePreviewLineRange | null | undefined {
  if (v === undefined || v === null) return null;
  if (!isObj(v) || !hasOnlyKeys(v, LINE_RANGE_KEYS)) return undefined;
  const { startLineNumber: s, endLineNumber: e } = v;
  if (
    typeof s !== "number" ||
    typeof e !== "number" ||
    !Number.isInteger(s) ||
    !Number.isInteger(e) ||
    s <= 0 ||
    e <= 0 ||
    s > e
  ) {
    return undefined;
  }
  return { startLineNumber: s, endLineNumber: e };
}

function parseEnvSource(v: unknown): EnvironmentFilePreviewSource | undefined {
  if (!isObj(v)) return undefined;
  const keys = Object.keys(v);
  if ((v.kind === "working-tree" || v.kind === "head") && keys.length === 1) {
    return { kind: v.kind };
  }
  if (v.kind === "merge-base" && keys.length === 2 && isNonEmptyStr(v.ref)) {
    return { kind: "merge-base", ref: v.ref };
  }
  return undefined;
}

const DESKTOP_TARGET_KEYS = new Set(["hostId", "instanceId", "generation"]);
function parseDesktopTarget(v: unknown): RoomDesktopBrowserTarget | undefined {
  if (!isObj(v) || !hasOnlyKeys(v, DESKTOP_TARGET_KEYS)) return undefined;
  if (
    !isNonEmptyStr(v.hostId) ||
    !isNonEmptyStr(v.instanceId) ||
    !isNonEmptyStr(v.generation)
  ) {
    return undefined;
  }
  return {
    hostId: v.hostId,
    instanceId: v.instanceId,
    generation: v.generation,
  };
}

function parseTerminalTarget(v: unknown): TerminalCreateTarget | undefined {
  if (!isObj(v)) return undefined;
  const keys = Object.keys(v);
  if (v.kind === "thread" && keys.length === 2 && isNonEmptyStr(v.threadId)) {
    return { kind: "thread", threadId: v.threadId };
  }
  if (
    v.kind === "environment" &&
    keys.length === 2 &&
    isNonEmptyStr(v.environmentId)
  ) {
    return { kind: "environment", environmentId: v.environmentId };
  }
  if (v.kind === "host_path" && keys.length === 3 && isNonEmptyStr(v.hostId)) {
    if (v.cwd === null)
      return { kind: "host_path", hostId: v.hostId, cwd: null };
    if (typeof v.cwd === "string" && v.cwd.trim().length > 0) {
      return { kind: "host_path", hostId: v.hostId, cwd: v.cwd.trim() };
    }
  }
  return undefined;
}

const WS_OWNER_KEYS = new Set([
  "kind",
  "environmentId",
  "projectId",
  "threadId",
  "tab",
]);
const WS_OWNER_TAB_KEYS = new Set([
  "lineRange",
  "path",
  "source",
  "statusLabel",
]);
const HOST_OWNER_KEYS = new Set([
  "kind",
  "environmentId",
  "hostId",
  "threadId",
  "tab",
]);
const STORAGE_OWNER_KEYS = new Set([
  "kind",
  "environmentId",
  "threadId",
  "tab",
]);
const SIMPLE_OWNER_TAB_KEYS = new Set(["lineRange", "path"]);

function parseFileOpenerOwner(
  v: unknown,
): ThreadTabFileOpenerOwner | undefined {
  if (!isObj(v) || !isObj(v.tab)) return undefined;
  if (v.kind === "workspace-file-preview") {
    if (
      !hasOnlyKeys(v, WS_OWNER_KEYS) ||
      !hasOnlyKeys(v.tab, WS_OWNER_TAB_KEYS)
    )
      return undefined;
    const lineRange = parseLineRange(v.tab.lineRange);
    const source = parseEnvSource(v.tab.source);
    if (
      !isNullOrNonEmptyStr(v.environmentId) ||
      !isNullOrNonEmptyStr(v.projectId) ||
      !isNullOrNonEmptyStr(v.threadId) ||
      !isNonEmptyStr(v.tab.path) ||
      lineRange === undefined ||
      source === undefined ||
      (v.tab.statusLabel !== null && v.tab.statusLabel !== "deleted")
    ) {
      return undefined;
    }
    return {
      kind: "workspace-file-preview",
      environmentId: v.environmentId,
      projectId: v.projectId,
      threadId: v.threadId,
      tab: {
        lineRange,
        path: v.tab.path,
        source,
        statusLabel: v.tab.statusLabel,
      },
    };
  }
  if (v.kind === "host-file-preview") {
    if (
      !hasOnlyKeys(v, HOST_OWNER_KEYS) ||
      !hasOnlyKeys(v.tab, SIMPLE_OWNER_TAB_KEYS)
    )
      return undefined;
    const environmentId = isOptNullNonEmptyStr(v.environmentId);
    const hostId = isOptNullNonEmptyStr(v.hostId);
    const threadId = isOptNullNonEmptyStr(v.threadId);
    const lineRange = parseLineRange(v.tab.lineRange);
    if (
      environmentId === undefined ||
      hostId === undefined ||
      threadId === undefined ||
      (hostId === null && threadId === null) ||
      !isNonEmptyStr(v.tab.path) ||
      lineRange === undefined
    ) {
      return undefined;
    }
    return {
      kind: "host-file-preview",
      environmentId,
      hostId,
      threadId,
      tab: { lineRange, path: v.tab.path },
    };
  }
  if (v.kind === "thread-storage-file-preview") {
    if (
      !hasOnlyKeys(v, STORAGE_OWNER_KEYS) ||
      !hasOnlyKeys(v.tab, SIMPLE_OWNER_TAB_KEYS)
    )
      return undefined;
    const lineRange = parseLineRange(v.tab.lineRange);
    if (
      !isNullOrNonEmptyStr(v.environmentId) ||
      !isNonEmptyStr(v.threadId) ||
      !isNonEmptyStr(v.tab.path) ||
      lineRange === undefined
    ) {
      return undefined;
    }
    return {
      kind: "thread-storage-file-preview",
      environmentId: v.environmentId,
      threadId: v.threadId,
      tab: { lineRange, path: v.tab.path },
    };
  }
  return undefined;
}

const K_SIMPLE = new Set(["id", "kind"]);
const K_PLUGIN_PAGE = new Set([
  "id",
  "kind",
  "fixedTabId",
  "pageId",
  "pluginId",
]);
const K_PLUGIN_PANEL = new Set([
  "id",
  "kind",
  "actionId",
  "fileOpenerOwner",
  "paramsJson",
  "pluginId",
  "title",
]);
const K_WORKSPACE = new Set([
  "id",
  "kind",
  "environmentId",
  "lineRange",
  "path",
  "projectId",
  "source",
  "statusLabel",
]);
const K_HOST = new Set([
  "id",
  "kind",
  "environmentId",
  "hostId",
  "lineRange",
  "path",
  "threadId",
]);
const K_STORAGE = new Set([
  "id",
  "kind",
  "environmentId",
  "isPinned",
  "lineRange",
  "path",
  "threadId",
]);
const K_BROWSER = new Set([
  "id",
  "kind",
  "environmentId",
  "desktopTarget",
  "title",
  "url",
]);
const K_TERMINAL = new Set(["id", "kind", "terminalId", "target"]);

function parseTab(v: unknown): FixedPanelTab | undefined {
  if (!isObj(v) || !isNonEmptyStr(v.id) || typeof v.kind !== "string")
    return undefined;
  switch (v.kind) {
    case "thread-info":
    case "git-diff":
    case "new-tab":
      return hasOnlyKeys(v, K_SIMPLE) ? { id: v.id, kind: v.kind } : undefined;
    case "plugin-page-fixed":
      if (
        !hasOnlyKeys(v, K_PLUGIN_PAGE) ||
        !isNonEmptyStr(v.fixedTabId) ||
        !isNonEmptyStr(v.pageId) ||
        !isNonEmptyStr(v.pluginId)
      ) {
        return undefined;
      }
      return {
        id: v.id,
        kind: "plugin-page-fixed",
        fixedTabId: v.fixedTabId,
        pageId: v.pageId,
        pluginId: v.pluginId,
      };
    case "plugin-panel": {
      if (
        !hasOnlyKeys(v, K_PLUGIN_PANEL) ||
        !isNonEmptyStr(v.actionId) ||
        !isNonEmptyStr(v.pluginId) ||
        !isNonEmptyStr(v.title) ||
        (v.paramsJson !== null && typeof v.paramsJson !== "string")
      ) {
        return undefined;
      }
      let fileOpenerOwner: ThreadTabFileOpenerOwner | undefined;
      if (v.fileOpenerOwner !== undefined) {
        fileOpenerOwner = parseFileOpenerOwner(v.fileOpenerOwner);
        if (fileOpenerOwner === undefined) return undefined;
      }
      return {
        id: v.id,
        kind: "plugin-panel",
        actionId: v.actionId,
        paramsJson: v.paramsJson,
        pluginId: v.pluginId,
        title: v.title,
        ...(fileOpenerOwner !== undefined ? { fileOpenerOwner } : {}),
      };
    }
    case "workspace-file-preview": {
      if (
        !hasOnlyKeys(v, K_WORKSPACE) ||
        !isNonEmptyStr(v.path) ||
        !isNullOrNonEmptyStr(v.environmentId)
      ) {
        return undefined;
      }
      const projectId = isOptNullNonEmptyStr(v.projectId);
      const lineRange = parseLineRange(v.lineRange);
      const source = parseEnvSource(v.source);
      if (
        projectId === undefined ||
        lineRange === undefined ||
        source === undefined ||
        (v.statusLabel !== null && v.statusLabel !== "deleted")
      ) {
        return undefined;
      }
      return {
        id: v.id,
        kind: "workspace-file-preview",
        environmentId: v.environmentId,
        projectId,
        path: v.path,
        source,
        statusLabel: v.statusLabel,
        lineRange,
      };
    }
    case "host-file-preview": {
      if (!hasOnlyKeys(v, K_HOST) || !isNonEmptyStr(v.path)) return undefined;
      const environmentId = isOptNullNonEmptyStr(v.environmentId);
      const hostId = isOptNullNonEmptyStr(v.hostId);
      const threadId = isOptNullNonEmptyStr(v.threadId);
      const lineRange = parseLineRange(v.lineRange);
      if (
        environmentId === undefined ||
        hostId === undefined ||
        threadId === undefined ||
        lineRange === undefined
      ) {
        return undefined;
      }
      return {
        id: v.id,
        kind: "host-file-preview",
        environmentId,
        hostId,
        threadId,
        path: v.path,
        lineRange,
      };
    }
    case "thread-storage-file-preview": {
      if (
        !hasOnlyKeys(v, K_STORAGE) ||
        !isNonEmptyStr(v.path) ||
        typeof v.isPinned !== "boolean"
      )
        return undefined;
      const environmentId = isOptNullNonEmptyStr(v.environmentId);
      const threadId = isOptNullNonEmptyStr(v.threadId);
      const lineRange = parseLineRange(v.lineRange);
      if (
        environmentId === undefined ||
        threadId === undefined ||
        lineRange === undefined
      )
        return undefined;
      return {
        id: v.id,
        kind: "thread-storage-file-preview",
        environmentId,
        threadId,
        isPinned: v.isPinned,
        path: v.path,
        lineRange,
      };
    }
    case "browser": {
      if (
        !hasOnlyKeys(v, K_BROWSER) ||
        typeof v.url !== "string" ||
        v.url.length > ROOM_DESKTOP_BROWSER_MAX_URL_LENGTH
      ) {
        return undefined;
      }
      const environmentId = isOptNullNonEmptyStr(v.environmentId);
      if (environmentId === undefined) return undefined;
      if (
        v.title !== null &&
        (!isNonEmptyStr(v.title) ||
          v.title.length > ROOM_DESKTOP_BROWSER_MAX_TITLE_LENGTH)
      ) {
        return undefined;
      }
      let desktopTarget: RoomDesktopBrowserTarget | undefined;
      if (v.desktopTarget !== undefined) {
        desktopTarget = parseDesktopTarget(v.desktopTarget);
        if (desktopTarget === undefined) return undefined;
      }
      return {
        id: v.id,
        kind: "browser",
        environmentId,
        title: v.title,
        url: v.url,
        ...(desktopTarget !== undefined ? { desktopTarget } : {}),
      };
    }
    case "terminal": {
      if (!hasOnlyKeys(v, K_TERMINAL) || !isNonEmptyStr(v.terminalId))
        return undefined;
      let target: TerminalCreateTarget | undefined;
      if (v.target !== undefined) {
        target = parseTerminalTarget(v.target);
        if (target === undefined) return undefined;
      }
      return {
        id: v.id,
        kind: "terminal",
        terminalId: v.terminalId,
        ...(target !== undefined ? { target } : {}),
      };
    }
    default:
      return undefined;
  }
}

const SECONDARY_KEYS = new Set(["tabs", "activeTabId", "isOpen"]);

function parseRawState(value: unknown): FixedPanelTabsState | undefined {
  if (!isObj(value)) return undefined;
  if (value.version !== FIXED_PANEL_TABS_STATE_STORAGE_VERSION)
    return undefined;
  if (
    typeof value.lastUsedAt !== "number" ||
    !Number.isInteger(value.lastUsedAt) ||
    value.lastUsedAt < 0
  ) {
    return undefined;
  }
  const sec = value.secondary;
  if (!isObj(sec) || !hasOnlyKeys(sec, SECONDARY_KEYS)) return undefined;
  if (
    typeof sec.isOpen !== "boolean" ||
    !isNullOrNonEmptyStr(sec.activeTabId) ||
    !Array.isArray(sec.tabs)
  ) {
    return undefined;
  }
  const tabs: FixedPanelTab[] = [];
  for (const item of sec.tabs) {
    if (isObj(item) && item.kind === "side-chat") continue;
    const parsed = parseTab(item);
    if (parsed === undefined) return undefined;
    tabs.push(parsed);
  }
  return {
    version: FIXED_PANEL_TABS_STATE_STORAGE_VERSION,
    lastUsedAt: value.lastUsedAt,
    secondary: { tabs, activeTabId: sec.activeTabId, isOpen: sec.isOpen },
  };
}

// --- Normalization, Serialization & Pruning ---

function canonicalTab(tab: FixedPanelTab): FixedPanelTab {
  let id: string;
  switch (tab.kind) {
    case "thread-info":
      id = THREAD_INFO_ID;
      break;
    case "git-diff":
      id = GIT_DIFF_ID;
      break;
    case "new-tab":
      id = NEW_TAB_ID;
      break;
    case "plugin-page-fixed":
      id = createPluginPageFixedPanelTab(tab).id;
      break;
    case "plugin-panel":
      id = createPluginPanelFixedPanelTab(tab).id;
      break;
    case "workspace-file-preview":
      id = workspaceTabId(tab.environmentId, tab.projectId, tab.path);
      break;
    case "host-file-preview":
      id = hostTabId(tab.environmentId, tab.hostId, tab.threadId, tab.path);
      break;
    case "thread-storage-file-preview":
      id = storageTabId(tab.threadId, tab.path);
      break;
    case "browser": {
      if (tab.desktopTarget !== undefined) return tab;
      const parts = tab.id.split(":");
      const path =
        parts.length === 3 && parts[0] === "browser"
          ? decodeSegment(parts[1] ?? "")
          : tab.id;
      id = buildFixedPanelTabId({
        kind: "browser",
        path,
        environmentId: tab.environmentId,
      });
      break;
    }
    case "terminal":
      id = buildFixedPanelTabId({
        kind: "terminal",
        path: tab.terminalId,
        environmentId: null,
      });
      break;
  }
  return tab.id === id ? tab : { ...tab, id };
}

function stripTransient(tab: FixedPanelTab): FixedPanelTab {
  if (
    tab.kind === "workspace-file-preview" ||
    tab.kind === "host-file-preview" ||
    tab.kind === "thread-storage-file-preview"
  ) {
    return tab.lineRange === null ? tab : { ...tab, lineRange: null };
  }
  if (tab.kind === "plugin-panel" && tab.fileOpenerOwner !== undefined) {
    const owner = tab.fileOpenerOwner;
    if (owner.tab.lineRange === null) return tab;
    const stripped: ThreadTabFileOpenerOwner =
      owner.kind === "workspace-file-preview"
        ? { ...owner, tab: { ...owner.tab, lineRange: null } }
        : owner.kind === "host-file-preview"
          ? { ...owner, tab: { ...owner.tab, lineRange: null } }
          : { ...owner, tab: { ...owner.tab, lineRange: null } };
    return { ...tab, fileOpenerOwner: stripped };
  }
  return tab;
}

function normalizeState(
  state: FixedPanelTabsState,
  stripLineRanges = false,
): FixedPanelTabsState {
  const seen = new Set<string>();
  const tabs: FixedPanelTab[] = [];
  let activeTabId: string | null = null;
  for (const raw of state.secondary.tabs) {
    const tab = canonicalTab(raw);
    if (tab.kind === "new-tab" || seen.has(tab.id)) continue;
    seen.add(tab.id);
    tabs.push(stripLineRanges ? stripTransient(tab) : tab);
    if (
      state.secondary.activeTabId !== null &&
      (raw.id === state.secondary.activeTabId ||
        tab.id === state.secondary.activeTabId)
    ) {
      activeTabId = tab.id;
    }
  }
  return {
    version: state.version,
    lastUsedAt: state.lastUsedAt,
    secondary: { tabs, activeTabId, isOpen: state.secondary.isOpen },
  };
}

export function ensureOpenFixedPanelHasActiveTab(
  state: FixedPanelTabsState,
): FixedPanelTabsState {
  if (!state.secondary.isOpen) return state;
  if (
    state.secondary.tabs.some((tab) => tab.id === state.secondary.activeTabId)
  )
    return state;
  const fallback = state.secondary.tabs[0];
  if (fallback === undefined) {
    return {
      ...state,
      secondary: { ...state.secondary, activeTabId: null, isOpen: false },
    };
  }
  return {
    ...state,
    secondary: { ...state.secondary, activeTabId: fallback.id },
  };
}

export function createEmptyFixedPanelTabsState(
  args: { lastUsedAt?: number; secondary?: SecondaryTabGroupState } = {},
): FixedPanelTabsState {
  return normalizeState({
    version: FIXED_PANEL_TABS_STATE_STORAGE_VERSION,
    lastUsedAt: args.lastUsedAt ?? 0,
    secondary: args.secondary ?? { tabs: [], activeTabId: null, isOpen: false },
  });
}

export const EMPTY_FIXED_PANEL_TABS_STATE = createEmptyFixedPanelTabsState();

export function getFixedPanelTabsStateStorageKey(args: {
  threadId: string;
}): string {
  return `${STORAGE_PREFIX}-${encodeURIComponent(args.threadId.trim())}-${FIXED_PANEL_TABS_STATE_STORAGE_VERSION}`;
}

export function getLegacyFixedPanelTabsStorageKey(threadId: string): string {
  return `${LEGACY_STORAGE_PREFIX}-${encodeURIComponent(threadId.trim())}-${FIXED_PANEL_TABS_STATE_STORAGE_VERSION}`;
}

export function isFixedPanelTabsStateStorageKey(key: string): boolean {
  return (
    key.startsWith(`${STORAGE_PREFIX}-`) ||
    key.startsWith(`${LEGACY_STORAGE_PREFIX}-`)
  );
}

function parseForStorage(args: {
  initialValue: FixedPanelTabsState;
  now: number;
  storedValue: string | null;
}): { shouldPrune: boolean; state: FixedPanelTabsState } {
  if (args.storedValue === null)
    return { shouldPrune: false, state: args.initialValue };
  let raw: unknown;
  try {
    raw = JSON.parse(args.storedValue);
  } catch {
    return { shouldPrune: true, state: args.initialValue };
  }
  const parsed = parseRawState(raw);
  if (parsed === undefined)
    return { shouldPrune: true, state: args.initialValue };
  const normalized = normalizeState(parsed, true);
  if (args.now - normalized.lastUsedAt > FIXED_PANEL_TABS_IDLE_EXPIRY_MS) {
    return { shouldPrune: true, state: args.initialValue };
  }
  return {
    shouldPrune: false,
    state: ensureOpenFixedPanelHasActiveTab(normalized),
  };
}

export function parseFixedPanelTabsState(args: {
  initialValue: FixedPanelTabsState;
  now: number;
  storedValue: string | null;
}): FixedPanelTabsState {
  return parseForStorage(args).state;
}

export function shouldPruneStoredFixedPanelTabsState(
  storedValue: string | null,
  now: number,
): boolean {
  if (storedValue === null) return false;
  return parseForStorage({
    initialValue: EMPTY_FIXED_PANEL_TABS_STATE,
    now,
    storedValue,
  }).shouldPrune;
}

export function serializeFixedPanelTabsState(args: {
  state: FixedPanelTabsState;
}): string {
  return JSON.stringify(normalizeState(args.state, true));
}

export function pruneFixedPanelTabsStorage(args: { now: number }): void {
  const storage = getLocalStorage();
  if (!storage) return;
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key && isFixedPanelTabsStateStorageKey(key)) keys.push(key);
  }
  for (const key of keys) {
    if (shouldPruneStoredFixedPanelTabsState(storage.getItem(key), args.now)) {
      storage.removeItem(key);
    }
  }
}

// --- Structural Equality ---

function ownersEqual(
  a: ThreadTabFileOpenerOwner | undefined,
  b: ThreadTabFileOpenerOwner | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (
    a.kind !== b.kind ||
    a.environmentId !== b.environmentId ||
    a.threadId !== b.threadId ||
    a.tab.path !== b.tab.path ||
    !areFilePreviewLineRangesEqual({ a: a.tab.lineRange, b: b.tab.lineRange })
  ) {
    return false;
  }
  if (a.kind === "host-file-preview")
    return b.kind === "host-file-preview" && a.hostId === b.hostId;
  if (a.kind === "workspace-file-preview") {
    return (
      b.kind === "workspace-file-preview" &&
      a.projectId === b.projectId &&
      areEnvironmentFilePreviewSourcesEqual(a.tab.source, b.tab.source) &&
      a.tab.statusLabel === b.tab.statusLabel
    );
  }
  return true;
}

export function areFixedPanelTabsEquivalent(
  a: FixedPanelTab,
  b: FixedPanelTab,
): boolean {
  if (a.id !== b.id || a.kind !== b.kind) return false;
  switch (a.kind) {
    case "thread-info":
    case "git-diff":
    case "new-tab":
      return true;
    case "plugin-page-fixed":
      return (
        b.kind === "plugin-page-fixed" &&
        a.pluginId === b.pluginId &&
        a.pageId === b.pageId &&
        a.fixedTabId === b.fixedTabId
      );
    case "plugin-panel":
      return (
        b.kind === "plugin-panel" &&
        a.pluginId === b.pluginId &&
        a.actionId === b.actionId &&
        a.paramsJson === b.paramsJson &&
        a.title === b.title &&
        ownersEqual(a.fileOpenerOwner, b.fileOpenerOwner)
      );
    case "workspace-file-preview":
      return (
        b.kind === "workspace-file-preview" &&
        a.environmentId === b.environmentId &&
        a.projectId === b.projectId &&
        a.path === b.path &&
        a.statusLabel === b.statusLabel &&
        areFilePreviewLineRangesEqual({ a: a.lineRange, b: b.lineRange }) &&
        areEnvironmentFilePreviewSourcesEqual(a.source, b.source)
      );
    case "host-file-preview":
      return (
        b.kind === "host-file-preview" &&
        a.environmentId === b.environmentId &&
        a.hostId === b.hostId &&
        a.threadId === b.threadId &&
        a.path === b.path &&
        areFilePreviewLineRangesEqual({ a: a.lineRange, b: b.lineRange })
      );
    case "thread-storage-file-preview":
      return (
        b.kind === "thread-storage-file-preview" &&
        a.environmentId === b.environmentId &&
        a.threadId === b.threadId &&
        a.isPinned === b.isPinned &&
        a.path === b.path &&
        areFilePreviewLineRangesEqual({ a: a.lineRange, b: b.lineRange })
      );
    case "browser":
      return (
        b.kind === "browser" &&
        a.environmentId === b.environmentId &&
        a.url === b.url &&
        a.title === b.title &&
        a.desktopTarget?.hostId === b.desktopTarget?.hostId &&
        a.desktopTarget?.instanceId === b.desktopTarget?.instanceId &&
        a.desktopTarget?.generation === b.desktopTarget?.generation
      );
    case "terminal":
      return (
        b.kind === "terminal" &&
        a.terminalId === b.terminalId &&
        JSON.stringify(a.target) === JSON.stringify(b.target)
      );
  }
}
