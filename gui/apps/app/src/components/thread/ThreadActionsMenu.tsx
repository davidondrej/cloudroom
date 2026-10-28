import {
  ActionMenuItem,
  ActionMenuSeparator,
} from "@/components/ui/action-menu-items";
import type { Thread } from "@cloudroom/domain";
import { useCallback, useState, type ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@cloudroom/shared-ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import { Icon, type IconName } from "@cloudroom/shared-ui/icon";
import { Button } from "@cloudroom/shared-ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cloudroom/shared-ui/tooltip";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@cloudroom/shared-ui/coarse-pointer-sizing";
import { useIsCompactViewport } from "@cloudroom/shared-ui/hooks/use-compact-viewport";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { CompactLongPressMenu } from "@/components/ui/compact-long-press-menu";
import { isThreadRead } from "@cloudroom/client-core";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { useThreadActions } from "./ThreadActionsProvider";
import { useThreadSectionMove } from "./ThreadSectionMoveProvider";
import { sdk } from "@/lib/sdk";
import { openTeleportLogin } from "@/components/CodexConnectionPanel";
import { showMutationErrorToast } from "@/lib/mutation-errors";
import { useTeleportLocal, useTeleportThread } from "@/hooks/queries/cloudroom-queries";
import { showCloudSignIn, useCloudLocked } from "@/hooks/useCloudLocked";
import { appToast } from "@/components/ui/app-toast";
import { useSidebarProjects } from "@/hooks/queries/sidebar-navigation-query";

interface ThreadActionsMenuBaseProps {
  thread: Thread;
  onOpenInSplit?: () => void;
}

export interface ThreadActionsMenuResponsiveAction {
  icon: IconName;
  label: string;
  onSelect?: () => void | Promise<void>;
  children?: readonly ThreadActionsMenuResponsiveAction[];
}

interface ThreadActionsMenuProps extends ThreadActionsMenuBaseProps {
  onOpenChange?: (open: boolean) => void;
  triggerClassName?: string;
  responsiveActions?: readonly ThreadActionsMenuResponsiveAction[];
}

interface ThreadActionsContextMenuProps extends ThreadActionsMenuBaseProps {
  children: ReactNode;
  onOpenChange?: (open: boolean) => void;
}

type ThreadActionsMenuSurface = "context" | "dropdown";
type ThreadActionsCompactStep = "actions" | "move" | "project";

interface ThreadActionsMenuItemsProps extends ThreadActionsMenuBaseProps {
  compactStep?: ThreadActionsCompactStep;
  onCompactStepChange?: (step: ThreadActionsCompactStep) => void;
  responsiveActions?: readonly ThreadActionsMenuResponsiveAction[];
  surface: ThreadActionsMenuSurface;
}

export function canTeleportLocalThread(thread: Thread): boolean {
  return thread.executionTarget === "cloud" && !thread.parentThreadId && thread.archivedAt == null && ["codex", "pi", "claude-code", "acp-cursor", "acp-opencode"].includes(thread.providerId) && (!thread.teleport || ["complete", "cancelled", "error"].includes(thread.teleport.phase));
}

/** Each cloud thread works on its own branch; the user decides how the work comes back (docs/scopes/sandboxes.md). */
export function canReturnCloudWork(thread: Thread): boolean {
  return thread.executionTarget === "cloud" && !thread.parentThreadId && thread.archivedAt == null && thread.deletedAt == null;
}
const RETURN_PR_PROMPT = "Commit all your work on this thread's branch, push the branch to origin, and open a pull request into the default branch with gh. Reply with the pull request link.";

export function canTeleportThread(thread: Thread): boolean {
  return thread.executionTarget !== "cloud" && !thread.parentThreadId && thread.archivedAt == null && ["codex", "pi", "claude-code", "acp-opencode"].includes(thread.providerId) && (!thread.teleport || ["cancelled", "error"].includes(thread.teleport.phase));
}

function ThreadSectionMoveMenu({
  drawerStep = false,
  isDrawer,
  onBack,
  onOpenDrawerStep,
  surface,
  thread,
}: {
  drawerStep?: boolean;
  isDrawer: boolean;
  onBack?: () => void;
  onOpenDrawerStep?: () => void;
  surface: ThreadActionsMenuSurface;
  thread: Thread;
}) {
  const sectionMove = useThreadSectionMove();
  if (
    !sectionMove ||
    thread.parentThreadId !== null ||
    thread.archivedAt !== null
  ) {
    return null;
  }

  const hasValidDestination = sectionMove.destinations.some(
    (destination) =>
      thread.pinnedAt !== null || thread.sectionId !== destination.sectionId,
  );
  if (!hasValidDestination) return null;

  const Item = surface === "context" ? ContextMenuItem : DropdownMenuItem;
  const items = sectionMove.destinations.map((destination) => {
    const isCurrent =
      thread.pinnedAt === null && thread.sectionId === destination.sectionId;
    return (
      <Item
        key={destination.sectionId ?? "threads"}
        aria-current={isCurrent ? "true" : undefined}
        className="flex items-center justify-between gap-3"
        disabled={isCurrent}
        onSelect={() => sectionMove.moveThread(thread, destination.sectionId)}
      >
        <span className="min-w-0 flex-1 truncate">{destination.label}</span>
        {isCurrent ? (
          <Icon name="Check" className="ml-auto" aria-hidden="true" />
        ) : null}
      </Item>
    );
  });

  return (
    <MoveSubmenu
      label="Move to section"
      drawerStep={drawerStep}
      isDrawer={isDrawer}
      onBack={onBack}
      onOpenDrawerStep={onOpenDrawerStep}
      surface={surface}
    >
      {items}
    </MoveSubmenu>
  );
}

export async function moveThreadToProject(
  threadId: string,
  project: { id: string; name: string },
): Promise<boolean> {
  try {
    const result = await sdk.threads.move({ threadId, projectId: project.id });
    appToast.success(
      result.moved
        ? `Moved to ${project.name}`
        : `Moves to ${project.name} when this turn ends`,
    );
    return result.moved;
  } catch (error) {
    showMutationErrorToast({ error, fallbackMessage: "Could not move the thread" });
    return false;
  }
}

function ThreadProjectMoveMenu({
  drawerStep = false,
  isDrawer,
  onBack,
  onOpenDrawerStep,
  surface,
  thread,
}: {
  drawerStep?: boolean;
  isDrawer: boolean;
  onBack?: () => void;
  onOpenDrawerStep?: () => void;
  surface: ThreadActionsMenuSurface;
  thread: Thread;
}) {
  const projects = useSidebarProjects().filter(
    (project) => project.id !== thread.projectId,
  );
  if (
    thread.parentThreadId !== null ||
    thread.archivedAt !== null ||
    projects.length === 0
  ) {
    return null;
  }
  const Item = surface === "context" ? ContextMenuItem : DropdownMenuItem;
  return (
    <MoveSubmenu
      label="Move to project"
      drawerStep={drawerStep}
      isDrawer={isDrawer}
      onBack={onBack}
      onOpenDrawerStep={onOpenDrawerStep}
      surface={surface}
    >
      {projects.map((project) => (
        <Item key={project.id} onSelect={() => void moveThreadToProject(thread.id, project)}>
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
        </Item>
      ))}
    </MoveSubmenu>
  );
}

function MoveSubmenu({
  children,
  drawerStep,
  isDrawer,
  label,
  onBack,
  onOpenDrawerStep,
  surface,
}: {
  children: ReactNode;
  drawerStep: boolean;
  isDrawer: boolean;
  label: string;
  onBack?: () => void;
  onOpenDrawerStep?: () => void;
  surface: ThreadActionsMenuSurface;
}) {
  if (isDrawer) {
    if (!drawerStep) {
      return (
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            onOpenDrawerStep?.();
          }}
        >
          <Icon name="MoveTo" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <Icon name="ChevronRight" className="ml-auto" aria-hidden="true" />
        </DropdownMenuItem>
      );
    }
    return (
      <>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            onBack?.();
          }}
        >
          <Icon name="ChevronLeft" aria-hidden="true" />
          Back
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {children}
      </>
    );
  }

  const Sub = surface === "context" ? ContextMenuSub : DropdownMenuSub;
  const SubTrigger =
    surface === "context" ? ContextMenuSubTrigger : DropdownMenuSubTrigger;
  const SubContent =
    surface === "context" ? ContextMenuSubContent : DropdownMenuSubContent;

  return (
    <Sub>
      <SubTrigger>
        <Icon name="MoveTo" aria-hidden="true" />
        {label}
      </SubTrigger>
      <SubContent className="max-h-[min(24rem,calc(100vh-2rem))] min-w-44 overflow-y-auto">
        {children}
      </SubContent>
    </Sub>
  );
}

function ResponsiveActionSubmenu({
  action,
  surface,
}: {
  action: ThreadActionsMenuResponsiveAction;
  surface: ThreadActionsMenuSurface;
}) {
  const Sub = surface === "context" ? ContextMenuSub : DropdownMenuSub;
  const SubTrigger =
    surface === "context" ? ContextMenuSubTrigger : DropdownMenuSubTrigger;
  const SubContent =
    surface === "context" ? ContextMenuSubContent : DropdownMenuSubContent;
  return (
    <Sub>
      <SubTrigger>
        <Icon name={action.icon} aria-hidden="true" />
        {action.label}
      </SubTrigger>
      <SubContent className="max-h-[min(24rem,calc(100vh-2rem))] min-w-44 overflow-y-auto">
        {action.children?.map((item) => (
          <ActionMenuItem
            key={item.label}
            surface={surface}
            icon={item.icon}
            onSelect={() => {
              void item.onSelect?.();
            }}
          >
            {item.label}
          </ActionMenuItem>
        ))}
      </SubContent>
    </Sub>
  );
}

function ThreadActionsMenuItems({
  thread,
  onOpenInSplit,
  compactStep = "actions",
  onCompactStepChange,
  responsiveActions = [],
  surface,
}: ThreadActionsMenuItemsProps) {
  const {
    archiveThreadAndChildren,
    requestRename,
    requestDelete,
    togglePin,
    toggleRead,
    unarchiveThread,
  } = useThreadActions();
  const isCompactViewport = useIsCompactViewport();
  const isDrawer = surface === "dropdown" && isCompactViewport;
  const showSeparators = !isDrawer;
  const isRead = isThreadRead(thread);
  const isArchived = thread.archivedAt != null;
  const isPinned = thread.pinnedAt !== null;
  const threadName = getThreadDisplayTitle(thread);
  const teleport = useTeleportThread(thread.id);
  const cloudLocked = useCloudLocked();
  const startTeleport = async () => {
    if (cloudLocked) return showCloudSignIn();
    try { await teleport.mutateAsync("start"); }
    catch (error) { if (!openTeleportLogin(error, thread.providerId)) showMutationErrorToast({ error, fallbackMessage: "Could not start Teleport" }); }
  };
  const canTeleport = canTeleportThread(thread);
  const teleportLocal = useTeleportLocal(thread.id);
  const askAgent = async (text: string) => {
    try { await sdk.threads.send({ threadId: thread.id, mode: "auto", input: [{ type: "text", text, mentions: [] }] }); }
    catch (error) { showMutationErrorToast({ error, fallbackMessage: "Could not send the request" }); }
  };

  if (isDrawer && compactStep === "project") {
    return (
      <ThreadProjectMoveMenu
        drawerStep
        isDrawer
        onBack={() => onCompactStepChange?.("actions")}
        surface={surface}
        thread={thread}
      />
    );
  }

  if (isDrawer && compactStep === "move") {
    return (
      <ThreadSectionMoveMenu
        drawerStep
        isDrawer
        onBack={() => onCompactStepChange?.("actions")}
        surface={surface}
        thread={thread}
      />
    );
  }

  return (
    <>
      {canTeleport && <ActionMenuItem surface={surface} icon="Cloud" disabled={teleport.isPending} onSelect={() => void startTeleport()}>Teleport to Cloud</ActionMenuItem>}
      {canTeleportLocalThread(thread) && <ActionMenuItem surface={surface} icon="Laptop" disabled={teleportLocal.isPending} onSelect={() => teleportLocal.mutate()}>Teleport to Local</ActionMenuItem>}
      {canReturnCloudWork(thread) && <ActionMenuItem surface={surface} icon="GitPullRequestArrow" onSelect={() => void askAgent(RETURN_PR_PROMPT)}>Open pull request</ActionMenuItem>}
      {responsiveActions.length > 0 ? (
        <>
          {responsiveActions.map((action) =>
            action.children && !isDrawer ? (
              <ResponsiveActionSubmenu key={action.label} action={action} surface={surface} />
            ) : (
              (action.children ?? [action]).map((item) => (
                <ActionMenuItem
                  key={item.label}
                  surface={surface}
                  icon={item.icon}
                  onSelect={() => {
                    void item.onSelect?.();
                  }}
                >
                  {action.children ? `${action.label} ${item.label}` : item.label}
                </ActionMenuItem>
              ))
            ),
          )}
          {showSeparators ? <ActionMenuSeparator surface={surface} /> : null}
        </>
      ) : null}
      {onOpenInSplit ? (
        <>
          <ActionMenuItem
            surface={surface}
            icon="Columns2"
            onSelect={() => {
              onOpenInSplit();
            }}
          >
            Open in split
          </ActionMenuItem>
          {showSeparators ? <ActionMenuSeparator surface={surface} /> : null}
        </>
      ) : null}
      <ActionMenuItem
        surface={surface}
        icon="Copy"
        onSelect={() => {
          void copyToClipboardWithToast(threadName, {
            successMessage: "Thread name copied",
            errorMessage: "Failed to copy thread name",
          });
        }}
      >
        Copy thread name
      </ActionMenuItem>
      <ActionMenuItem
        surface={surface}
        icon={isRead ? "Mail" : "MailOpen"}
        onSelect={() => {
          toggleRead(thread);
        }}
      >
        {isRead ? "Mark unread" : "Mark read"}
      </ActionMenuItem>
      <ActionMenuItem
        surface={surface}
        icon={isPinned ? "PinOff" : "Pin"}
        onSelect={() => {
          togglePin(thread);
        }}
      >
        {isPinned ? "Unpin" : "Pin"}
      </ActionMenuItem>
      <ThreadSectionMoveMenu
        isDrawer={isDrawer}
        onOpenDrawerStep={() => onCompactStepChange?.("move")}
        surface={surface}
        thread={thread}
      />
      <ThreadProjectMoveMenu
        isDrawer={isDrawer}
        onOpenDrawerStep={() => onCompactStepChange?.("project")}
        surface={surface}
        thread={thread}
      />
      <ActionMenuItem
        surface={surface}
        icon="Edit"
        onSelect={() => {
          window.setTimeout(() => {
            requestRename(thread);
          }, 0);
        }}
      >
        Rename
      </ActionMenuItem>
      {showSeparators ? <ActionMenuSeparator surface={surface} /> : null}
      <ActionMenuItem
        surface={surface}
        icon={isArchived ? "ArchiveRestore" : "Archive"}
        onSelect={() => {
          if (isArchived) {
            unarchiveThread(thread);
            return;
          }
          archiveThreadAndChildren(thread);
        }}
      >
        {isArchived ? "Unarchive" : "Archive"}
      </ActionMenuItem>
      <ActionMenuItem
        surface={surface}
        icon="Trash2"
        variant="destructive"
        onSelect={() => {
          window.setTimeout(() => {
            requestDelete(thread);
          }, 0);
        }}
      >
        Delete
      </ActionMenuItem>
    </>
  );
}

function useThreadActionsMenuLifecycle(onOpenChange?: (open: boolean) => void) {
  const [compactStep, setCompactStep] =
    useState<ThreadActionsCompactStep>("actions");
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setCompactStep("actions");
      }
      onOpenChange?.(open);
    },
    [onOpenChange],
  );

  return { compactStep, setCompactStep, handleOpenChange };
}

export function ThreadArchiveQuickAction({
  thread,
  className,
}: {
  thread: Thread;
  className?: string;
}) {
  const { archiveThreadAndChildren, unarchiveThread } = useThreadActions();
  const isArchived = thread.archivedAt != null;
  const label = isArchived ? "Unarchive" : "Archive";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn("rounded-md p-0", className)}
          aria-label={`${label} thread`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (isArchived) {
              unarchiveThread(thread);
              return;
            }
            archiveThreadAndChildren(thread);
          }}
        >
          <Icon
            name={isArchived ? "ArchiveRestore" : "Archive"}
            className={COARSE_POINTER_ICON_SIZE_CLASS}
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function ThreadActionsMenu({
  thread,
  onOpenInSplit,
  responsiveActions,
  onOpenChange,
  triggerClassName,
}: ThreadActionsMenuProps) {
  const { compactStep, setCompactStep, handleOpenChange } =
    useThreadActionsMenuLifecycle(onOpenChange);

  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "rounded-md p-0",
            "data-[state=open]:bg-state-active data-[state=open]:text-foreground",
            triggerClassName,
          )}
          aria-label="Thread actions"
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <Icon
            name="MoreHorizontal"
            className={COARSE_POINTER_ICON_SIZE_CLASS}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <ThreadActionsMenuItems
          thread={thread}
          onOpenInSplit={onOpenInSplit}
          compactStep={compactStep}
          onCompactStepChange={setCompactStep}
          responsiveActions={responsiveActions}
          surface="dropdown"
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ThreadActionsContextMenu(props: ThreadActionsContextMenuProps) {
  const isCompactViewport = useIsCompactViewport();
  if (isCompactViewport) {
    return <ThreadActionsCompactLongPressMenu {...props} />;
  }
  return <ThreadActionsDesktopContextMenu {...props} />;
}

function ThreadActionsCompactLongPressMenu({
  children,
  thread,
  onOpenInSplit,
  onOpenChange,
}: ThreadActionsContextMenuProps) {
  const { compactStep, setCompactStep, handleOpenChange } =
    useThreadActionsMenuLifecycle(onOpenChange);

  return (
    <CompactLongPressMenu
      label="Thread actions"
      onOpenChange={handleOpenChange}
      items={
        <ThreadActionsMenuItems
          thread={thread}
          onOpenInSplit={onOpenInSplit}
          compactStep={compactStep}
          onCompactStepChange={setCompactStep}
          surface="dropdown"
        />
      }
    >
      {children}
    </CompactLongPressMenu>
  );
}

function ThreadActionsDesktopContextMenu({
  children,
  thread,
  onOpenInSplit,
  onOpenChange,
}: ThreadActionsContextMenuProps) {
  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent aria-label="Thread actions">
        <ThreadActionsMenuItems
          thread={thread}
          onOpenInSplit={onOpenInSplit}
          surface="context"
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}
