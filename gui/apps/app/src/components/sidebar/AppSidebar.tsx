import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { getThreadConversationCollapsedAtom } from "@/components/right-panel/store/panel-prefs";
import { prefetchThreadTimeline } from "@/hooks/queries/thread-queries";
import { isDocumentVisible } from "@/lib/document-visibility";
import { usePointerCoarse } from "@cloudroom/shared-ui/hooks/use-pointer-coarse";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { setSidebarCards } from "@cloudroom/shared-ui/lib/sidebar-cards";
import { THREAD_JUMP_APP_COMMAND_IDS } from "@cloudroom/domain";
import { useNavigate } from "react-router";
import { OverflowFade } from "@/components/ui/overflow-fade.js";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  useCloseMobileSidebar,
  useSidebar,
} from "@/components/ui/sidebar.js";
import { ProjectList } from "./ProjectList";
import { PluginThreadList } from "./PluginThreadList";
import { useThreadListReplacement } from "./threadListProvider";
import {
  PluginSidebarFooterDisclosure,
  PluginSidebarFooterItems,
  usePluginSidebarFooterDisclosure,
} from "@/components/plugin/PluginSidebarFooterItems";
import { SidebarPluginAttentionGlyph } from "./SidebarPluginAttentionGlyph";
import { SidebarUpdatesBadge } from "./SidebarUpdatesBadge";
import { SidebarResizeHandle, SidebarTopReserveRow } from "./SidebarChrome";
import { SIDEBAR_FOOTER_ACTION_CLASS } from "./sidebarRowClasses";
import { useQuickCreateProjectController } from "@/hooks/useQuickCreateProject";
import { useSidebarPreload } from "@/hooks/useCloudThreadWake";
import { getRootComposeRoutePath, getThreadRoutePath } from "@/lib/route-paths";
import { usePaneContentSplitDrag } from "./usePaneContentSplitDrag";
import { MacAccessChip } from "./MacAccessChip";
import { ViewingMacBar } from "@/components/settings/YourComputers";
import { CloudCapacityChip, CloudQueueChip, PlanCard } from "@/components/CloudQueue";
import {
  EMPTY_SIDEBAR_THREAD_SHORTCUT_KEYS,
  getSidebarThreadNavigationTargets,
  getSidebarThreadShortcutTargets,
  revealSidebarProject,
  revealSidebarThread,
  SidebarThreadShortcutKeysContext,
  type SidebarThreadShortcutPresentation,
  type SidebarThreadShortcutTarget,
} from "./sidebarThreadShortcuts";
import {
  useAppCommandHandler,
  useAppCommandShortcut,
  useAppCommandShortcuts,
  useIsAppCommandModifierHeld,
  useIndexedAppCommandHandlers,
} from "@/components/commands/AppCommandProvider";
import { useRouteState } from "@/hooks/useRouteState";
import { SidebarNavigationRegion } from "./SidebarNavigationRegion";
import { SidebarNeedsYou } from "./SidebarNeedsYou";
import {
  sidebarProjectRevealRequestAtom,
  sidebarProjectRevealStateAtom,
} from "./sidebarCollapsedAtoms";
import { closeSidebarPurposeCardAtom } from "@/components/thread/ThreadPurposeHoverCard";

const NEW_THREAD_PANE_CONTENT = { kind: "new-thread" } as const;
const SHORTCUT_PRELOAD_DELAY_MS = 400;
const SHORTCUT_PRELOAD_CONCURRENCY = 2;

function collectShortcutPreloadThreadIds(
  root: HTMLElement | null,
  activeProjectId: string | undefined,
  activeThreadId: string | undefined,
): string[] {
  if (!root) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (threadId: string | undefined) => {
    if (!threadId || threadId === activeThreadId || seen.has(threadId)) return;
    seen.add(threadId);
    ids.push(threadId);
  };
  // Priority 1: Cmd+E (last non-child pinned thread)
  const pinnedSection = root.querySelector<HTMLElement>(
    '[data-sidebar-section-id="pinned"]',
  );
  const lastPinned = getSidebarThreadNavigationTargets(pinnedSection)
    .filter((target) => !target.isChild && target.threadId !== activeThreadId)
    .at(-1);
  add(lastPinned?.threadId);
  // Priority 2: Cmd+L (oldest non-child thread in active project)
  const allTargets = getSidebarThreadNavigationTargets(root);
  const projectId =
    activeProjectId ??
    allTargets.find((target) => target.threadId === activeThreadId)?.projectId;
  if (projectId) {
    const oldestInProject = allTargets
      .filter(
        (target) =>
          target.projectId === projectId &&
          !target.isChild &&
          target.threadId !== activeThreadId,
      )
      .at(-1);
    add(oldestInProject?.threadId);
  }
  // Priority 3: Cmd+1..9 jump targets
  for (const target of getSidebarThreadShortcutTargets(root)) {
    add(target.threadId);
  }
  return ids;
}

function useShortcutTargetPreload(
  sidebarRef: RefObject<HTMLElement | null>,
  activeProjectId: string | undefined,
  activeThreadId: string | undefined,
  disabled: boolean,
): void {
  const queryClient = useQueryClient();
  const preloadedIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (disabled) return;
    const root = sidebarRef.current;
    if (!root) return;
    let cancelled = false;
    let timerId: number | null = null;
    let idleId: number | null = null;

    const runPreload = () => {
      if (cancelled || !isDocumentVisible()) return;
      const ids = collectShortcutPreloadThreadIds(
        sidebarRef.current,
        activeProjectId,
        activeThreadId,
      ).filter((threadId) => !preloadedIdsRef.current.has(threadId));
      if (ids.length === 0) return;
      let cursor = 0;
      const worker = async () => {
        while (!cancelled && cursor < ids.length) {
          const threadId = ids[cursor++];
          if (!threadId || preloadedIdsRef.current.has(threadId)) continue;
          preloadedIdsRef.current.add(threadId);
          await prefetchThreadTimeline(queryClient, threadId).catch(() => {});
        }
      };
      const workerCount = Math.min(SHORTCUT_PRELOAD_CONCURRENCY, ids.length);
      for (let i = 0; i < workerCount; i += 1) {
        void worker();
      }
    };

    const schedule = () => {
      if (cancelled) return;
      if (timerId !== null) window.clearTimeout(timerId);
      if (idleId !== null && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleId);
        idleId = null;
      }
      timerId = window.setTimeout(() => {
        timerId = null;
        if (typeof window.requestIdleCallback === "function") {
          idleId = window.requestIdleCallback(() => {
            idleId = null;
            runPreload();
          });
        } else {
          runPreload();
        }
      }, SHORTCUT_PRELOAD_DELAY_MS);
    };

    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true });
    schedule();
    return () => {
      cancelled = true;
      observer.disconnect();
      if (timerId !== null) window.clearTimeout(timerId);
      if (idleId !== null && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleId);
      }
    };
  }, [activeProjectId, activeThreadId, disabled, queryClient, sidebarRef]);
}

interface AppSidebarProps {
  onResizeMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  isResizing: boolean;
  settingsRoutePath: string;
  mobileHosted?: { hidden: boolean };
}

export function AppSidebar({
  onResizeMouseDown,
  isResizing,
  settingsRoutePath,
  mobileHosted,
}: AppSidebarProps) {
  const quickCreateProject = useQuickCreateProjectController();
  const threadListReplacement = useThreadListReplacement();
  const { projectId: activeProjectId, threadId: activeThreadId } =
    useRouteState();
  const navigate = useNavigate();
  const store = useStore();
  const newThreadSplit = usePaneContentSplitDrag({
    content: NEW_THREAD_PANE_CONTENT,
    enabled: true,
    label: "New thread",
  });
  const closeOnMobile = useCloseMobileSidebar();
  const cardsRef = useCallback(
    (element: HTMLDivElement | null) =>
      setSidebarCards(element && { element, close: closeOnMobile }),
    [closeOnMobile],
  );
  const closePurposeCard = useSetAtom(closeSidebarPurposeCardAtom);
  const { isCompactViewport, openMobile } = useSidebar();
  const isPointerCoarse = usePointerCoarse();
  const [compactCustomizeMode, setCompactCustomizeMode] = useState(false);
  const [threadShortcutKeysById, setThreadShortcutKeysById] = useState<
    ReadonlyMap<string, SidebarThreadShortcutPresentation>
  >(EMPTY_SIDEBAR_THREAD_SHORTCUT_KEYS);
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  useSidebarPreload(sidebarRef);
  useShortcutTargetPreload(
    sidebarRef,
    activeProjectId,
    activeThreadId,
    mobileHosted?.hidden === true || isCompactViewport || isPointerCoarse,
  );
  const threadShortcutTargetsRef = useRef<
    readonly SidebarThreadShortcutTarget[]
  >([]);
  const threadJumpShortcuts = useAppCommandShortcuts(
    THREAD_JUMP_APP_COMMAND_IDS,
  );
  const isAppCommandModifierHeld = useIsAppCommandModifierHeld();
  const settingsShortcut = useAppCommandShortcut("settings.open");
  const pluginSidebarFooter = usePluginSidebarFooterDisclosure();

  const handleNewChat = useCallback(() => {
    closeOnMobile();
    void navigate(getRootComposeRoutePath(), {
      state: { focusPrompt: true },
    });
  }, [closeOnMobile, navigate]);

  const showThreadShortcuts = useCallback(() => {
    const targets = getSidebarThreadShortcutTargets(sidebarRef.current);
    threadShortcutTargetsRef.current = targets;
    setThreadShortcutKeysById(
      new Map(
        targets.flatMap((target, index) => {
          const command = THREAD_JUMP_APP_COMMAND_IDS[index];
          const shortcut = command
            ? threadJumpShortcuts.get(command)
            : undefined;
          return shortcut ? [[target.threadId, shortcut] as const] : [];
        }),
      ),
    );
  }, [threadJumpShortcuts]);

  const hideThreadShortcuts = useCallback(() => {
    threadShortcutTargetsRef.current = [];
    setThreadShortcutKeysById(EMPTY_SIDEBAR_THREAD_SHORTCUT_KEYS);
  }, []);

  const cancelThreadRevealRef = useRef<(() => void) | null>(null);
  const scheduleThreadReveal = useCallback((threadId: string) => {
    cancelThreadRevealRef.current?.();
    cancelThreadRevealRef.current = revealSidebarThread(
      sidebarRef.current,
      threadId,
    );
  }, []);

  const openNavigationTarget = useCallback(
    (target: SidebarThreadShortcutTarget | undefined): boolean => {
      if (!target) return false;
      const projectId =
        target.projectId ?? target.element?.dataset.sidebarProjectId;
      if (!projectId) {
        if (!target.element) return false;
        target.element.click();
        return true;
      }
      const collapsedAtom = getThreadConversationCollapsedAtom(target.threadId);
      if (store.get(collapsedAtom)) {
        store.set(collapsedAtom, false);
      }
      closeOnMobile();
      if (target.threadId === activeThreadId) {
        scheduleThreadReveal(target.threadId);
        return true;
      }
      void navigate(
        getThreadRoutePath({
          projectId,
          threadId: target.threadId,
        }),
      );
      return true;
    },
    [activeThreadId, closeOnMobile, navigate, scheduleThreadReveal, store],
  );

  const activateThreadShortcut = useCallback(
    (index: number): boolean => {
      return openNavigationTarget(
        threadShortcutTargetsRef.current[index] ??
          getSidebarThreadShortcutTargets(sidebarRef.current)[index],
      );
    },
    [openNavigationTarget],
  );

  const activateAdjacentThread = useCallback(
    (offset: -1 | 1): boolean => {
      const targets = getSidebarThreadNavigationTargets(sidebarRef.current);
      if (targets.length === 0) return false;
      const activeIndex = targets.findIndex(
        (target) => target.threadId === activeThreadId,
      );
      const nextIndex =
        activeIndex === -1
          ? offset === 1
            ? 0
            : targets.length - 1
          : (activeIndex + offset + targets.length) % targets.length;
      return openNavigationTarget(targets[nextIndex]);
    },
    [activeThreadId, openNavigationTarget],
  );

  const activateOldestProjectThread = useCallback((): boolean => {
    const targets = getSidebarThreadNavigationTargets(sidebarRef.current);
    const projectId =
      activeProjectId ??
      targets.find((target) => target.threadId === activeThreadId)?.projectId;
    if (!projectId) return false;
    // Skip the open thread: after a send it stays last until the list re-sorts.
    return openNavigationTarget(
      targets
        .filter(
          (target) =>
            target.projectId === projectId &&
            !target.isChild &&
            target.threadId !== activeThreadId,
        )
        .at(-1),
    );
  }, [activeProjectId, activeThreadId, openNavigationTarget]);

  const activateLastPinnedThread = useCallback(
    (): boolean =>
      openNavigationTarget(
        getSidebarThreadNavigationTargets(
          sidebarRef.current?.querySelector<HTMLElement>(
            '[data-sidebar-section-id="pinned"]',
          ) ?? null,
        )
          .filter(
            (target) => !target.isChild && target.threadId !== activeThreadId,
          )
          .at(-1),
      ),
    [activeThreadId, openNavigationTarget],
  );

  const isHiddenHostedBody = mobileHosted?.hidden === true;
  const isCompactCustomizeModeActive =
    isCompactViewport && compactCustomizeMode;
  useEffect(() => {
    if (!isCompactViewport || !openMobile || isHiddenHostedBody) {
      setCompactCustomizeMode(false);
    }
  }, [isCompactViewport, isHiddenHostedBody, openMobile]);
  const activateVisibleThreadShortcut = useCallback(
    (index: number) =>
      isHiddenHostedBody ? false : activateThreadShortcut(index),
    [activateThreadShortcut, isHiddenHostedBody],
  );
  useIndexedAppCommandHandlers(
    THREAD_JUMP_APP_COMMAND_IDS,
    activateVisibleThreadShortcut,
  );
  useAppCommandHandler("thread.previous", () =>
    isHiddenHostedBody ? false : activateAdjacentThread(-1),
  );
  useAppCommandHandler("thread.next", () =>
    isHiddenHostedBody ? false : activateAdjacentThread(1),
  );
  useAppCommandHandler("thread.oldestInProject", () =>
    isHiddenHostedBody ? false : activateOldestProjectThread(),
  );
  useAppCommandHandler("thread.lastPinned", () =>
    isHiddenHostedBody ? false : activateLastPinnedThread(),
  );

  const projectRevealState = useAtomValue(sidebarProjectRevealStateAtom);
  const setProjectRevealRequest = useSetAtom(sidebarProjectRevealRequestAtom);

  useEffect(() => {
    if (activeThreadId && !isHiddenHostedBody) {
      scheduleThreadReveal(activeThreadId);
    }
    return () => {
      cancelThreadRevealRef.current?.();
      cancelThreadRevealRef.current = null;
    };
  }, [activeThreadId, isHiddenHostedBody, scheduleThreadReveal]);

  useEffect(() => {
    if (
      isHiddenHostedBody ||
      projectRevealState.status === "idle" ||
      projectRevealState.status === "waiting-expand"
    ) {
      return;
    }
    const clearRequest = () => {
      setProjectRevealRequest((current) =>
        current?.id === projectRevealState.id ? null : current,
      );
    };
    if (projectRevealState.status === "skip") {
      clearRequest();
      return;
    }
    return revealSidebarProject(
      sidebarRef.current,
      projectRevealState.projectId,
      clearRequest,
    );
  }, [isHiddenHostedBody, projectRevealState, setProjectRevealRequest]);

  useEffect(() => {
    if (isAppCommandModifierHeld) {
      showThreadShortcuts();
      return;
    }
    hideThreadShortcuts();
  }, [hideThreadShortcuts, isAppCommandModifierHeld, showThreadShortcuts]);

  const originalThreadList = (
    <ProjectList
      onNewProject={
        quickCreateProject.isAvailable
          ? quickCreateProject.openCreateDialog
          : undefined
      }
      onProjectSelect={closeOnMobile}
      isCreatingProject={quickCreateProject.isCreating}
    />
  );

  const body = (
    <>
      <SidebarTopReserveRow testId="app-sidebar-top-reserve-row" />
      <ViewingMacBar />
      <SidebarNavigationRegion
        compactCustomizeMode={isCompactCustomizeModeActive}
        onCompactCustomizeModeChange={setCompactCustomizeMode}
        onNavigate={closeOnMobile}
        splitEnabled
        newThreadSplit={newThreadSplit}
        onNewChat={handleNewChat}
        onSearchThreads={closeOnMobile}
      />
      <div
        aria-hidden="true"
        className={cn(
          "mx-2 my-2 shrink-0 border-t border-sidebar-border/25",
          isCompactCustomizeModeActive && "hidden",
        )}
        data-testid="app-sidebar-navigation-divider"
      />
      {isCompactCustomizeModeActive ? null : (
        <SidebarNeedsYou onNavigate={closeOnMobile} />
      )}
      <SidebarContent
        className={cn(isCompactCustomizeModeActive && "hidden")}
        aria-hidden={isCompactCustomizeModeActive ? true : undefined}
        inert={isCompactCustomizeModeActive ? true : undefined}
        onPointerLeave={closePurposeCard}
        onScroll={closePurposeCard}
      >
        <PluginThreadList
          replacement={threadListReplacement}
          original={originalThreadList}
          searchQuery=""
          onNavigate={closeOnMobile}
        />
      </SidebarContent>
      <SidebarFooter className="relative">
        <OverflowFade placement="above" tone="sidebar" size="sm" />
        <PluginSidebarFooterDisclosure
          item={pluginSidebarFooter.activeItem}
          warmItem={pluginSidebarFooter.warmItem}
          onDismiss={pluginSidebarFooter.dismiss}
        />
        <div ref={cardsRef} className="empty:hidden" />
        <PlanCard />
        <SidebarMenu className="flex-row flex-wrap-reverse items-center gap-1">
          <PluginSidebarFooterItems
            activeDisclosureKey={pluginSidebarFooter.activeKey}
            onDisclosureCommand={pluginSidebarFooter.handleCommand}
            onDisclosureWarm={pluginSidebarFooter.handleWarm}
            onNavigate={closeOnMobile}
            builtInActions={[
              {
                id: "settings",
                href: settingsRoutePath,
                ariaLabel: settingsShortcut
                  ? `Settings (${settingsShortcut.label})`
                  : "Settings",
                ariaKeyShortcuts: settingsShortcut?.ariaKeyshortcuts,
                onActivate: () => {
                  closeOnMobile();
                  void navigate(settingsRoutePath);
                },
              },
            ]}
          />
          <li aria-hidden="true" className="min-w-0 flex-1" />
          <SidebarPluginAttentionGlyph
            className={SIDEBAR_FOOTER_ACTION_CLASS}
            onNavigate={closeOnMobile}
          />
          <SidebarUpdatesBadge onNavigate={closeOnMobile} />
          <CloudQueueChip />
          <CloudCapacityChip />
          <MacAccessChip hidden={isHiddenHostedBody} />
        </SidebarMenu>
      </SidebarFooter>
      <SidebarResizeHandle
        testId="app-sidebar-resize-handle"
        isResizing={isResizing}
        onMouseDown={onResizeMouseDown}
      />
    </>
  );

  return (
    <SidebarThreadShortcutKeysContext.Provider value={threadShortcutKeysById}>
      {mobileHosted ? (
        <div
          ref={sidebarRef}
          data-testid="app-sidebar-body"
          hidden={mobileHosted.hidden}
          className="flex min-h-0 flex-1 flex-col"
        >
          {body}
        </div>
      ) : (
        <Sidebar ref={sidebarRef}>{body}</Sidebar>
      )}
    </SidebarThreadShortcutKeysContext.Provider>
  );
}
