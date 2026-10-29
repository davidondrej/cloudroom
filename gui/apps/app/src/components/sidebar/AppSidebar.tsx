import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { THREAD_JUMP_APP_COMMAND_IDS } from "@cloudroom/domain";
import { useNavigate } from "react-router-dom";
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
import { CloudroomSignInButton } from "./CloudroomSignInButton";
import { MacAccessChip } from "./MacAccessChip";
import { CloudQueueChip, PlanCard } from "@/components/CloudQueue";
import {
  EMPTY_SIDEBAR_THREAD_SHORTCUT_KEYS,
  getSidebarThreadNavigationTargets,
  getSidebarThreadShortcutTargets,
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

const NEW_THREAD_PANE_CONTENT = { kind: "new-thread" } as const;

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
  const newThreadSplit = usePaneContentSplitDrag({
    content: NEW_THREAD_PANE_CONTENT,
    enabled: true,
    label: "New thread",
  });
  const closeOnMobile = useCloseMobileSidebar();
  const { isCompactViewport, openMobile } = useSidebar();
  const [compactCustomizeMode, setCompactCustomizeMode] = useState(false);
  const [threadShortcutKeysById, setThreadShortcutKeysById] = useState<
    ReadonlyMap<string, SidebarThreadShortcutPresentation>
  >(EMPTY_SIDEBAR_THREAD_SHORTCUT_KEYS);
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  useSidebarPreload(sidebarRef);
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

  const openNavigationTarget = useCallback(
    (target: SidebarThreadShortcutTarget | undefined): boolean => {
      if (!target) return false;
      if (target.element) {
        target.element.click();
        revealSidebarThread(sidebarRef.current, target.threadId);
        return true;
      }
      if (!target.projectId) return false;
      closeOnMobile();
      void navigate(
        getThreadRoutePath({
          projectId: target.projectId,
          threadId: target.threadId,
        }),
      );
      revealSidebarThread(sidebarRef.current, target.threadId);
      return true;
    },
    [closeOnMobile, navigate],
  );

  const activateThreadShortcut = useCallback(
    (index: number): boolean => {
      const target =
        threadShortcutTargetsRef.current[index] ??
        getSidebarThreadShortcutTargets(sidebarRef.current)[index];
      return target?.element ? openNavigationTarget(target) : false;
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
    return openNavigationTarget(
      targets
        .filter((target) => target.projectId === projectId && !target.isChild)
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
          .filter((target) => !target.isChild)
          .at(-1),
      ),
    [openNavigationTarget],
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

  useEffect(() => {
    if (activeThreadId && !isHiddenHostedBody) {
      revealSidebarThread(sidebarRef.current, activeThreadId);
    }
  }, [activeThreadId, isHiddenHostedBody]);

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
      <SidebarContent
        className={cn(isCompactCustomizeModeActive && "hidden")}
        aria-hidden={isCompactCustomizeModeActive ? true : undefined}
        inert={isCompactCustomizeModeActive ? true : undefined}
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
          onDismiss={pluginSidebarFooter.dismiss}
        />
        <PlanCard />
        <SidebarMenu className="flex-row flex-wrap-reverse items-center gap-1">
          <PluginSidebarFooterItems
            activeDisclosureKey={pluginSidebarFooter.activeKey}
            onDisclosureCommand={pluginSidebarFooter.handleCommand}
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
          <CloudroomSignInButton />
          <li aria-hidden="true" className="min-w-0 flex-1" />
          <SidebarPluginAttentionGlyph
            className={SIDEBAR_FOOTER_ACTION_CLASS}
            onNavigate={closeOnMobile}
          />
          <SidebarUpdatesBadge onNavigate={closeOnMobile} />
          <CloudQueueChip />
          <MacAccessChip />
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
        <Sidebar
          ref={sidebarRef}
          // The footer popup spills past the sidebar; lift the sidebar above the thread composer while it is open.
          className={pluginSidebarFooter.activeItem ? "md:z-40" : undefined}
        >
          {body}
        </Sidebar>
      )}
    </SidebarThreadShortcutKeysContext.Provider>
  );
}
