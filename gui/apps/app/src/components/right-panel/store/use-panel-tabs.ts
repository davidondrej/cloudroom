import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type {
  TerminalSession,
  ThreadStorageFileListResponse,
} from "@cloudroom/server-contract";
import type {
  HostFileTabState,
  ThreadStorageFileTabState,
  WorkspaceFileTabState,
} from "@cloudroom/client-core";
import { usePluginSlots } from "@/lib/plugin-slots";
import { useFileOpenerPreferenceValue } from "@/lib/file-opener-preference";
import {
  createFileOpenerOriginalTab,
  createFileOpenerTabForRequest,
  fileOpenerIdFromActionId,
  parseFileOpenerParams,
} from "@/components/plugin/file-opener-tabs";
import type { FileOpenerOverride } from "@/lib/plugin-slot-resolvers";
import type { OpenPluginPanelArgs } from "@/components/plugin/PluginPanelActions";
import {
  createBrowserFixedPanelTab,
  createHostFilePreviewFixedPanelTab,
  createNewTabFixedPanelTab,
  createPluginPanelFixedPanelTab,
  createThreadStorageFilePreviewFixedPanelTab,
  createWorkspaceFilePreviewFixedPanelTab,
  type BrowserFixedPanelTab,
  type FixedPanelTab,
  type FixedPanelTabsState,
  type HostFilePreviewFixedPanelTab,
  type NewTabFixedPanelTab,
  type PluginPanelFixedPanelTab,
  type ThreadStorageFilePreviewFixedPanelTab,
  type WorkspaceFilePreviewFixedPanelTab,
} from "./tab-model";
import {
  activateSecondaryPanelTabInState,
  buildOrderedSecondaryPanelFileTabs,
  clearActiveSecondaryFileTabInState,
  closeSecondaryPanelTabInState,
  findSecondaryPanelTab,
  getActiveSecondaryPanelTab,
  getActiveTabIdAfterPrune,
  isBrowserTab,
  openSecondaryPanelTabInState,
  pruneStorageTabs,
  pruneTerminalTabsInFixedPanelState,
  removeWorkspaceTabsForOtherEnvironments,
  reorderSecondaryPanelFileTabInState,
  replaceNewTabWithSecondaryPanelTabInState,
  setSecondaryPanelTabsInState,
  updateSecondaryPanelTabInState,
  type SecondaryPanelTabReorderHandler,
} from "./tab-ops";
import {
  useFixedPanelTabsState,
  useRecordThreadRecentItem,
  useUpdateFixedPanelTabsState,
} from "./panel-atoms";

export type FileSearchSelection =
  | { path: string; source: "workspace" }
  | { path: string; source: "thread-storage" };

export interface UpdateBrowserTabArgs {
  tabId: string;
  title: string | null;
  url: string;
}

export type OpenSecondaryPanelTabRequest =
  | {
      environmentId?: string;
      kind: "workspace-file-preview";
      tab: WorkspaceFileTabState;
    }
  | { hostId?: string; kind: "host-file-preview"; tab: HostFileTabState }
  | {
      kind: "thread-storage-file-preview";
      tab: ThreadStorageFileTabState;
      threadId?: string;
    }
  | { kind: "browser"; url: string }
  | { kind: "new-tab" };

type OpenableTab =
  | WorkspaceFilePreviewFixedPanelTab
  | HostFilePreviewFixedPanelTab
  | ThreadStorageFilePreviewFixedPanelTab
  | BrowserFixedPanelTab
  | NewTabFixedPanelTab
  | PluginPanelFixedPanelTab;

type ReopenableTab = Exclude<OpenableTab, NewTabFixedPanelTab>;

interface ClosedEntry {
  index: number;
  tab: ReopenableTab;
}

interface ClosedContext {
  environmentId: string | null | undefined;
  fileOwnerThreadId: string | null;
  panelStateId: string;
  projectHostId: string | null;
  projectId: string | null;
}

interface StorageInventory {
  knownPaths: ReadonlySet<string>;
  truncated: boolean;
}

const MAX_CLOSED_HISTORY = 25;
const closedHistory = new Map<string, ClosedEntry[]>();

export function resetRecentlyClosedPanelTabsForTest(): void {
  closedHistory.clear();
}

function isReopenable(tab: FixedPanelTab): tab is ReopenableTab {
  return (
    tab.kind === "workspace-file-preview" ||
    tab.kind === "host-file-preview" ||
    tab.kind === "thread-storage-file-preview" ||
    tab.kind === "browser" ||
    tab.kind === "plugin-panel"
  );
}

function pushClosed(key: string, entry: ClosedEntry): void {
  const stack = closedHistory.get(key) ?? [];
  stack.push(entry);
  if (stack.length > MAX_CLOSED_HISTORY)
    stack.splice(0, stack.length - MAX_CLOSED_HISTORY);
  closedHistory.set(key, stack);
}

function dropClosed(key: string, tabId: string): boolean {
  const stack = closedHistory.get(key);
  if (!stack) return false;
  const wasTop = stack.at(-1)?.tab.id === tabId;
  const next = stack.filter((e) => e.tab.id !== tabId);
  if (next.length === 0) closedHistory.delete(key);
  else closedHistory.set(key, next);
  return wasTop;
}

function ownedByContext(tab: ReopenableTab, ctx: ClosedContext): boolean {
  const effective =
    (tab.kind === "plugin-panel" ? createFileOpenerOriginalTab(tab) : null) ??
    tab;
  switch (effective.kind) {
    case "workspace-file-preview":
      return (
        effective.environmentId === ctx.environmentId &&
        effective.projectId ===
          (ctx.environmentId === null ? ctx.projectId : null)
      );
    case "host-file-preview":
      return (
        effective.hostId !== null ||
        (effective.environmentId === ctx.environmentId &&
          effective.threadId === ctx.fileOwnerThreadId)
      );
    case "thread-storage-file-preview":
      return effective.threadId === ctx.fileOwnerThreadId;
    case "browser":
      return effective.environmentId === ctx.environmentId;
    case "plugin-panel":
      return true;
  }
}

function storagePathFor(tab: ReopenableTab): string | null {
  const resource =
    (tab.kind === "plugin-panel" ? createFileOpenerOriginalTab(tab) : null) ??
    tab;
  return resource.kind === "thread-storage-file-preview" ? resource.path : null;
}

function checkAvailability(
  tab: ReopenableTab,
  inv: StorageInventory | null,
): "available" | "missing" | "unresolved" {
  const path = storagePathFor(tab);
  if (path === null) return "available";
  if (inv === null) return "unresolved";
  if (inv.knownPaths.has(path)) return "available";
  return inv.truncated ? "unresolved" : "missing";
}

function popClosed(
  key: string,
  openIds: ReadonlySet<string>,
  check: (e: ClosedEntry) => "available" | "missing" | "unresolved",
):
  | { entry: ClosedEntry; kind: "available" | "unresolved" }
  | { kind: "empty" } {
  const stack = closedHistory.get(key);
  if (!stack) return { kind: "empty" };
  while (stack.length > 0) {
    const entry = stack.at(-1)!;
    if (openIds.has(entry.tab.id)) {
      stack.pop();
      continue;
    }
    const status = check(entry);
    if (status === "unresolved") return { kind: "unresolved", entry };
    stack.pop();
    if (status === "missing") continue;
    if (stack.length === 0) closedHistory.delete(key);
    return { kind: "available", entry };
  }
  closedHistory.delete(key);
  return { kind: "empty" };
}

function buildTabForRequest(args: {
  projectId: string | null;
  request: OpenSecondaryPanelTabRequest;
  resolvedEnvironmentId: string | null | undefined;
  threadId: string | null | undefined;
}): OpenableTab | null {
  const { request, projectId, resolvedEnvironmentId, threadId } = args;
  switch (request.kind) {
    case "workspace-file-preview": {
      if (
        request.environmentId === undefined &&
        resolvedEnvironmentId === undefined
      )
        return null;
      const envId = request.environmentId ?? resolvedEnvironmentId ?? null;
      return createWorkspaceFilePreviewFixedPanelTab({
        environmentId: envId,
        projectId: envId === null ? projectId : null,
        tab: request.tab,
      });
    }
    case "host-file-preview":
      if (request.hostId !== undefined) {
        return createHostFilePreviewFixedPanelTab({
          environmentId: null,
          hostId: request.hostId,
          threadId: null,
          tab: request.tab,
        });
      }
      if (!threadId || resolvedEnvironmentId === undefined) return null;
      return createHostFilePreviewFixedPanelTab({
        environmentId: resolvedEnvironmentId,
        threadId,
        tab: request.tab,
      });
    case "thread-storage-file-preview": {
      const ownerThreadId = request.threadId ?? threadId;
      if (!ownerThreadId) return null;
      return createThreadStorageFilePreviewFixedPanelTab({
        environmentId: resolvedEnvironmentId ?? null,
        isPinned: false,
        threadId: ownerThreadId,
        tab: request.tab,
      });
    }
    case "browser":
      return createBrowserFixedPanelTab({
        environmentId: resolvedEnvironmentId ?? null,
        url: request.url,
      });
    case "new-tab":
      return createNewTabFixedPanelTab();
  }
}

function applyPruned(
  state: FixedPanelTabsState,
  tabs: readonly FixedPanelTab[],
): FixedPanelTabsState {
  return setSecondaryPanelTabsInState({
    state,
    tabs,
    activeTabId: getActiveTabIdAfterPrune(tabs, state.secondary.activeTabId),
    isOpen: state.secondary.isOpen,
  });
}

export interface UseThreadFileTabsParams {
  environmentId: string | null | undefined;
  fileOwnerThreadId?: string | null;
  onCloseLastTab?: () => void;
  panelStateId: string | null | undefined;
  preserveWorkspaceTabsAcrossContexts?: boolean;
  projectHostId?: string | null;
  projectId?: string | null;
  retainedTerminalId?: string | null;
  storageFileExists?: (path: string) => Promise<boolean>;
  storageFiles:
    | Pick<ThreadStorageFileListResponse, "files" | "truncated">
    | undefined;
  syncThreadId: string | null | undefined;
  terminalSessions: readonly TerminalSession[] | undefined;
}

export function useThreadFileTabs({
  panelStateId,
  syncThreadId,
  environmentId,
  fileOwnerThreadId,
  onCloseLastTab,
  preserveWorkspaceTabsAcrossContexts = false,
  projectHostId = null,
  projectId = null,
  retainedTerminalId = null,
  storageFileExists,
  storageFiles,
  terminalSessions,
}: UseThreadFileTabsParams) {
  const state = useFixedPanelTabsState(panelStateId, syncThreadId);
  const updateState = useUpdateFixedPanelTabsState(panelStateId, syncThreadId);
  const recordRecent = useRecordThreadRecentItem(panelStateId);

  const resolvedPanelId =
    typeof panelStateId === "string" && panelStateId.length > 0
      ? panelStateId
      : null;
  const ownerThreadId =
    fileOwnerThreadId !== undefined
      ? fileOwnerThreadId
      : (syncThreadId ?? null);
  const resolvedEnvId = resolvedPanelId !== null ? environmentId : undefined;

  const storageInv = useMemo<StorageInventory | null>(
    () =>
      storageFiles
        ? {
            knownPaths: new Set(storageFiles.files.map((f) => f.path)),
            truncated: storageFiles.truncated,
          }
        : null,
    [storageFiles],
  );
  const closedCtx = useMemo<ClosedContext | null>(
    () =>
      resolvedPanelId
        ? {
            environmentId: resolvedEnvId,
            fileOwnerThreadId: ownerThreadId,
            panelStateId: resolvedPanelId,
            projectHostId,
            projectId,
          }
        : null,
    [ownerThreadId, projectHostId, projectId, resolvedEnvId, resolvedPanelId],
  );
  const closedKey = useMemo(
    () => (closedCtx ? JSON.stringify(closedCtx) : null),
    [closedCtx],
  );
  const closedKeyRef = useRef(closedKey);
  const pendingValidationRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useLayoutEffect(() => {
    closedKeyRef.current = closedKey;
    pendingValidationRef.current = null;
  }, [closedKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Migrate legacy ownerless host/storage tabs once thread ownership is known.
  useEffect(() => {
    if (!ownerThreadId) return;
    updateState((cur) => {
      let changed = false;
      const remapped = new Map<string, string>();
      const seen = new Set<string>();
      const tabs: FixedPanelTab[] = [];
      for (const tab of cur.secondary.tabs) {
        let next = tab;
        if (
          tab.kind === "host-file-preview" &&
          tab.threadId === null &&
          resolvedEnvId
        ) {
          next = createHostFilePreviewFixedPanelTab({
            environmentId: resolvedEnvId,
            hostId: tab.hostId,
            threadId: ownerThreadId,
            tab: { path: tab.path, lineRange: tab.lineRange },
          });
          changed = true;
          remapped.set(tab.id, next.id);
        } else if (
          tab.kind === "thread-storage-file-preview" &&
          tab.threadId === null
        ) {
          next = createThreadStorageFilePreviewFixedPanelTab({
            environmentId: tab.environmentId ?? resolvedEnvId ?? null,
            isPinned: tab.isPinned,
            threadId: ownerThreadId,
            tab: { path: tab.path, lineRange: tab.lineRange },
          });
          changed = true;
          remapped.set(tab.id, next.id);
        }
        if (seen.has(next.id)) {
          changed = true;
          remapped.set(tab.id, next.id);
          continue;
        }
        seen.add(next.id);
        tabs.push(next);
      }
      if (!changed) return cur;
      const activeTabId =
        cur.secondary.activeTabId === null
          ? null
          : (remapped.get(cur.secondary.activeTabId) ??
            cur.secondary.activeTabId);
      return setSecondaryPanelTabsInState({
        state: cur,
        tabs,
        activeTabId,
        isOpen: cur.secondary.isOpen,
      });
    });
  }, [ownerThreadId, resolvedEnvId, updateState]);

  // Prune workspace tabs belonging to other environments.
  useEffect(() => {
    if (preserveWorkspaceTabsAcrossContexts || resolvedEnvId === undefined)
      return;
    updateState((cur) =>
      applyPruned(
        cur,
        removeWorkspaceTabsForOtherEnvironments(
          cur.secondary.tabs,
          resolvedEnvId,
        ),
      ),
    );
  }, [preserveWorkspaceTabsAcrossContexts, resolvedEnvId, updateState]);

  // Prune storage tabs for deleted files when the inventory is complete.
  useEffect(() => {
    if (resolvedPanelId === null || storageInv === null || storageInv.truncated)
      return;
    updateState((cur) =>
      applyPruned(
        cur,
        pruneStorageTabs({
          knownPaths: storageInv.knownPaths,
          tabs: cur.secondary.tabs,
          threadId: ownerThreadId,
        }),
      ),
    );
  }, [ownerThreadId, resolvedPanelId, storageInv, updateState]);

  // Prune exited terminal tabs.
  useEffect(() => {
    if (resolvedPanelId === null || terminalSessions === undefined) return;
    updateState((cur) =>
      pruneTerminalTabsInFixedPanelState({
        state: cur,
        retainedTerminalId,
        terminalSessions,
      }),
    );
  }, [resolvedPanelId, retainedTerminalId, terminalSessions, updateState]);

  const { fileOpeners } = usePluginSlots();
  const fileOpenerPreference = useFileOpenerPreferenceValue();

  const openWithMode = useCallback(
    (
      request: OpenSecondaryPanelTabRequest,
      mode: "open" | "replace-new-tab",
      viewer?: FileOpenerOverride,
    ): OpenableTab | null => {
      const tab =
        createFileOpenerTabForRequest({
          fileOpeners,
          preference: fileOpenerPreference,
          projectHostId,
          projectId,
          request,
          resolvedEnvironmentId: resolvedEnvId,
          threadId: ownerThreadId,
          ...(viewer !== undefined ? { viewer } : {}),
        }) ??
        buildTabForRequest({
          projectId,
          request,
          resolvedEnvironmentId: resolvedEnvId,
          threadId: ownerThreadId,
        });
      if (!tab) return null;
      if (closedKey) dropClosed(closedKey, tab.id);
      if (
        request.kind === "workspace-file-preview" &&
        request.tab.source.kind === "working-tree"
      ) {
        recordRecent({ source: "workspace", path: request.tab.path });
      } else if (request.kind === "thread-storage-file-preview") {
        recordRecent({ source: "thread-storage", path: request.tab.path });
      }
      updateState((cur) =>
        mode === "replace-new-tab"
          ? replaceNewTabWithSecondaryPanelTabInState({ state: cur, tab })
          : openSecondaryPanelTabInState({ state: cur, tab }),
      );
      return tab;
    },
    [
      closedKey,
      fileOpenerPreference,
      fileOpeners,
      ownerThreadId,
      projectHostId,
      projectId,
      recordRecent,
      resolvedEnvId,
      updateState,
    ],
  );

  const openTab = useCallback(
    (
      request: OpenSecondaryPanelTabRequest,
      options?: { viewer?: FileOpenerOverride },
    ) =>
      openWithMode(
        request,
        request.kind === "browser" ? "replace-new-tab" : "open",
        options?.viewer,
      ),
    [openWithMode],
  );

  const activateTab = useCallback(
    (tabId: string) =>
      updateState((cur) => activateSecondaryPanelTabInState(cur, tabId)),
    [updateState],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      let closedLast = false;
      updateState((cur) => {
        const idx = cur.secondary.tabs.findIndex((t) => t.id === tabId);
        const tab = cur.secondary.tabs[idx];
        const next = closeSecondaryPanelTabInState(cur, tabId);
        closedLast = next !== cur && next.secondary.tabs.length === 0;
        if (
          next !== cur &&
          closedCtx &&
          closedKey &&
          tab &&
          isReopenable(tab) &&
          ownedByContext(tab, closedCtx)
        ) {
          pushClosed(closedKey, { index: idx, tab });
        }
        return next;
      });
      if (closedLast) onCloseLastTab?.();
    },
    [closedCtx, closedKey, onCloseLastTab, updateState],
  );

  const reopenClosedTab = useCallback((): boolean => {
    if (!closedKey) return false;
    const key = closedKey;
    const restore = (cur: FixedPanelTabsState, entry: ClosedEntry) => {
      const tabs = [...cur.secondary.tabs];
      tabs.splice(
        Math.max(0, Math.min(entry.index, tabs.length)),
        0,
        entry.tab,
      );
      return setSecondaryPanelTabsInState({
        state: cur,
        tabs,
        activeTabId: entry.tab.id,
        isOpen: true,
      });
    };
    const attempt = (): boolean => {
      let reopened = false;
      let unresolved: ClosedEntry | undefined;
      updateState((cur) => {
        const res = popClosed(
          key,
          new Set(cur.secondary.tabs.map((t) => t.id)),
          (e) => checkAvailability(e.tab, storageInv),
        );
        if (res.kind === "empty") return cur;
        if (res.kind === "unresolved") {
          unresolved = res.entry;
          return cur;
        }
        reopened = true;
        return restore(cur, res.entry);
      });
      if (reopened) return true;
      if (!unresolved || !storageFileExists) return false;
      const path = storagePathFor(unresolved.tab);
      if (path === null) return false;
      const vKey = `${key}:${unresolved.tab.id}`;
      if (pendingValidationRef.current === vKey) return true;
      pendingValidationRef.current = vKey;
      const targetEntry = unresolved;
      void storageFileExists(path)
        .then((exists) => {
          if (
            !mountedRef.current ||
            closedKeyRef.current !== key ||
            pendingValidationRef.current !== vKey
          )
            return;
          pendingValidationRef.current = null;
          if (!exists) {
            if (dropClosed(key, targetEntry.tab.id)) attempt();
            return;
          }
          updateState((cur) => {
            const res = popClosed(
              key,
              new Set(cur.secondary.tabs.map((t) => t.id)),
              (c) =>
                c.tab.id === targetEntry.tab.id ? "available" : "unresolved",
            );
            return res.kind === "available" ? restore(cur, res.entry) : cur;
          });
        })
        .catch(() => {
          if (pendingValidationRef.current === vKey)
            pendingValidationRef.current = null;
        });
      return true;
    };
    return attempt();
  }, [closedKey, storageFileExists, storageInv, updateState]);

  const openPluginPanel = useCallback(
    ({ pluginId, actionId, title, paramsJson }: OpenPluginPanelArgs) => {
      const tab = createPluginPanelFixedPanelTab({
        actionId,
        paramsJson,
        pluginId,
        title,
      });
      if (closedKey) dropClosed(closedKey, tab.id);
      updateState((cur) => {
        const existing = findSecondaryPanelTab(cur.secondary.tabs, tab.id);
        if (existing?.kind === "plugin-panel") {
          const updated =
            existing.title === title
              ? cur
              : updateSecondaryPanelTabInState({
                  state: cur,
                  tab: { ...existing, title },
                });
          return activateSecondaryPanelTabInState(updated, tab.id);
        }
        return replaceNewTabWithSecondaryPanelTabInState({ state: cur, tab });
      });
    },
    [closedKey, updateState],
  );

  const selectFileSearchResult = useCallback(
    (selection: FileSearchSelection) => {
      openWithMode(
        selection.source === "workspace"
          ? {
              kind: "workspace-file-preview",
              tab: {
                path: selection.path,
                lineRange: null,
                source: { kind: "working-tree" },
                statusLabel: null,
              },
            }
          : {
              kind: "thread-storage-file-preview",
              tab: { path: selection.path, lineRange: null },
            },
        "replace-new-tab",
      );
    },
    [openWithMode],
  );

  const updateBrowserTab = useCallback(
    ({ tabId, url, title }: UpdateBrowserTabArgs) => {
      updateState((cur) => {
        const tab = findSecondaryPanelTab(cur.secondary.tabs, tabId);
        return tab && isBrowserTab(tab)
          ? updateSecondaryPanelTabInState({
              state: cur,
              tab: { ...tab, url, title },
            })
          : cur;
      });
    },
    [updateState],
  );

  const clearActiveFileTabs = useCallback(
    () => updateState(clearActiveSecondaryFileTabInState),
    [updateState],
  );
  const reorderTab = useCallback<SecondaryPanelTabReorderHandler>(
    (req) =>
      updateState((cur) =>
        reorderSecondaryPanelFileTabInState({ ...req, state: cur }),
      ),
    [updateState],
  );

  const activeTab = getActiveSecondaryPanelTab(state);
  const orderedSecondaryFileTabs = buildOrderedSecondaryPanelFileTabs({
    includeWorkspaceTabsOutsideEnvironment: preserveWorkspaceTabsAcrossContexts,
    resolvedEnvironmentId: resolvedEnvId,
    tabs: state.secondary.tabs,
  });
  const browserTabs = useMemo(
    () => state.secondary.tabs.filter(isBrowserTab),
    [state.secondary.tabs],
  );

  const activeWs =
    activeTab?.kind === "workspace-file-preview" &&
    (preserveWorkspaceTabsAcrossContexts ||
      activeTab.environmentId === resolvedEnvId)
      ? activeTab
      : null;
  const activeStorage =
    activeTab?.kind === "thread-storage-file-preview" ? activeTab : null;
  const activeHost = activeTab?.kind === "host-file-preview" ? activeTab : null;
  const activeBrowser = activeTab?.kind === "browser" ? activeTab : null;
  const activePlugin = activeTab?.kind === "plugin-panel" ? activeTab : null;
  const openerOwner =
    activePlugin && fileOpenerIdFromActionId(activePlugin.actionId) !== null
      ? (activePlugin.fileOpenerOwner ?? null)
      : null;
  const openerFile =
    openerOwner && activePlugin
      ? parseFileOpenerParams(activePlugin.paramsJson)
      : null;

  return {
    activateTab,
    activeBrowserTab: activeBrowser,
    activeHostFileLineRange:
      activeHost?.lineRange ??
      (openerOwner?.kind === "host-file-preview"
        ? openerOwner.tab.lineRange
        : null),
    activeHostFilePath:
      activeHost?.path ??
      (openerOwner?.kind === "host-file-preview" &&
      openerFile?.source.kind === "host"
        ? openerFile.path
        : null),
    activeStorageFilePath:
      activeStorage?.path ??
      (openerOwner?.kind === "thread-storage-file-preview" &&
      openerFile?.source.kind === "thread-storage"
        ? openerFile.path
        : null),
    activeWorkspaceFilePath:
      activeWs?.path ??
      (openerOwner?.kind === "workspace-file-preview" &&
      openerFile?.source.kind === "workspace"
        ? openerFile.path
        : null),
    browserTabs,
    clearActiveFileTabs,
    closeTab,
    openPluginPanel,
    openTab,
    orderedSecondaryFileTabs,
    reopenClosedTab,
    reorderTab,
    selectFileSearchResult,
    updateBrowserTab,
  };
}
