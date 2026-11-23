import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useSetAtom, useStore } from "jotai";
import { useLocation } from "react-router";
import {
  closePanesForThreadsAtom,
  splitLayoutAtom, maximizedPaneIdAtom,
  type ClosePanesForThreadsResult,
} from "@/lib/split-layout/atoms";
import type { Thread } from "@cloudroom/domain";
import {
  useDeleteThread,
  useMarkThreadRead,
  useMarkThreadUnread,
  usePinThread,
  useUnarchiveThread,
  useUnpinThread,
  useUpdateThread,
} from "@/hooks/mutations/thread-state-mutations";
import { sdk } from "@/lib/sdk";
import { useRouteState } from "@/hooks/useRouteState";
import { useDialogState } from "@/hooks/useDialogState";
import { showMutationErrorToast } from "@/lib/mutation-errors";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import {
  ThreadRenameDialog,
  type ThreadRenameDialogPayload,
  type ThreadRenameDialogTarget,
} from "@/components/dialogs/ThreadRenameDialog";
import {
  ThreadDeleteDialog,
  type ThreadDeleteDialogTarget,
} from "@/components/dialogs/ThreadDeleteDialog";
import {
  ConfirmDeleteDialog,
  ConfirmDeleteDialogContent,
} from "@/components/dialogs/ConfirmDeleteDialog";
import { useThreadArchive } from "./useThreadArchive";
import { destroyPersistedBrowserViewsForThread } from "@/components/right-panel/tabs/browser-visibility";
import { getThreadReadToggleAction } from "@cloudroom/client-core";
import type { PaneContent } from "@/lib/split-layout";
import { paneContentRoute, reconcileLayoutForContent, threadPaneContent } from "@/views/thread-detail/splitThreadNavigation";
import { getThreadRoutePath } from "@/lib/route-paths";
import { getDesktopBrowserApi, getRoomDesktopInfo } from "@/lib/room-desktop";
import {
  useAppCommandHandler,
  useAppCommandShortcut,
} from "@/components/commands/AppCommandProvider";
import { useRouteNavigate } from "@/components/ui/app-route-anchor";
import {
  getSidebarThreadNavigationTargets,
  type SidebarThreadShortcutTarget,
} from "@/components/sidebar/sidebarThreadShortcuts";

function getSidebarSectionTargets(
  threadId: string,
): SidebarThreadShortcutTarget[] {
  return getSidebarThreadNavigationTargets(
    document
      .querySelector(`a[data-sidebar-thread-id="${threadId}"]`)
      ?.closest<HTMLElement>("[data-sidebar-sticky-section]") ?? null,
  );
}

// The next top-level thread below the archived one, else the nearest above. Never a subagent.
function findArchiveFallback(
  targets: readonly SidebarThreadShortcutTarget[],
  threadId: string,
  isAvailable: (target: SidebarThreadShortcutTarget) => boolean,
): SidebarThreadShortcutTarget | undefined {
  const index = targets.findIndex((target) => target.threadId === threadId);
  if (index < 0) return undefined;
  const candidate = (target: SidebarThreadShortcutTarget) =>
    !target.isChild && isAvailable(target);
  return (
    targets.slice(index + 1).find(candidate) ??
    targets.slice(0, index).reverse().find(candidate)
  );
}

export interface ThreadActionsContextValue {
  archiveThreadAndChildren: (thread: Thread) => void;
  renameThread: (threadId: string, title: string) => void;
  requestRename: (thread: Thread) => void;
  requestDelete: (thread: Thread) => void;
  unarchiveThread: (thread: Thread) => void;
  togglePin: (thread: Thread) => void;
  toggleRead: (thread: Thread) => void;
}

const ThreadActionsContext = createContext<ThreadActionsContextValue | null>(
  null,
);

export function useThreadActions(): ThreadActionsContextValue {
  const value = useContext(ThreadActionsContext);
  if (!value) {
    throw new Error(
      "useThreadActions must be used within a <ThreadActionsProvider>",
    );
  }
  return value;
}

interface ThreadActionsProviderProps {
  children: ReactNode;
}

interface DeleteThreadActionRequest {
  childThreadsConfirmed: boolean;
  closeDialog: () => void;
  thread: Thread;
}

interface ThreadActionContext {
  childThreadCount: number;
}

const SHORTCUT_CONFIRM_DELAY_MS = 400;

export function ThreadActionsProvider({
  children,
}: ThreadActionsProviderProps) {
  const navigate = useRouteNavigate();
  const { threadId: viewedThreadId } = useRouteState();
  const viewedThreadIdRef = useRef(viewedThreadId);
  const openedSectionTargetsRef = useRef<{
    threadId: string;
    targets: SidebarThreadShortcutTarget[];
  } | null>(null);
  useEffect(() => {
    viewedThreadIdRef.current = viewedThreadId;
    openedSectionTargetsRef.current = viewedThreadId
      ? {
          threadId: viewedThreadId,
          targets: getSidebarSectionTargets(viewedThreadId),
        }
      : null;
  }, [viewedThreadId]);
  const closePanesForThreads = useSetAtom(closePanesForThreadsAtom);
  const unarchiveThreadMutation = useUnarchiveThread();
  const markThreadRead = useMarkThreadRead();
  const markThreadUnread = useMarkThreadUnread();
  const pinThread = usePinThread();
  const unpinThread = useUnpinThread();
  const deleteThread = useDeleteThread();
  const updateThread = useUpdateThread();
  const threadActionContextAbortRef = useRef<AbortController | null>(null);
  const { mutate: unarchiveMutate } = unarchiveThreadMutation;
  const { mutate: markReadMutate } = markThreadRead;
  const { mutate: markUnreadMutate } = markThreadUnread;
  const { mutate: pinMutate } = pinThread;
  const { mutate: unpinMutate } = unpinThread;
  const { mutate: deleteMutate } = deleteThread;
  const { mutate: updateMutate } = updateThread;

  const renameDialog = useDialogState<ThreadRenameDialogTarget>();
  const deleteDialog = useDialogState<ThreadDeleteDialogTarget>();

  const { onClose: closeRenameDialog, onOpen: openRenameDialog } = renameDialog;
  const { onClose: closeDeleteDialog, onOpen: openDeleteDialog } = deleteDialog;

  useEffect(() => {
    return () => {
      threadActionContextAbortRef.current?.abort();
      threadActionContextAbortRef.current = null;
    };
  }, []);

  const syncNavigationAfterClose = useCallback(
    (result: ClosePanesForThreadsResult, fallback: () => PaneContent | undefined) => {
      if (result.removedAny && result.focusedRoute) {
        if (result.focusedRoute.threadId === viewedThreadIdRef.current) return;
        const content = threadPaneContent(result.focusedRoute);
        navigate(paneContentRoute(content), { replace: true });
        return content;
      }
      const content = fallback();
      if (content) navigate(paneContentRoute(content));
      return content;
    },
    [navigate],
  );

  const requestRename = useCallback(
    (thread: Thread) => {
      openRenameDialog({
        id: thread.id,
        currentTitle: getThreadDisplayTitle(thread),
      });
    },
    [openRenameDialog],
  );

  const renameThread = useCallback(
    (threadId: string, title: string) => {
      updateMutate({ id: threadId, title });
    },
    [updateMutate],
  );

  const submitRename = useCallback(
    (threadId: string, payload: ThreadRenameDialogPayload) => {
      updateMutate(
        { id: threadId, ...payload },
        {
          onSuccess: () => {
            closeRenameDialog();
          },
        },
      );
    },
    [closeRenameDialog, updateMutate],
  );

  const loadThreadActionContext = useCallback(
    async (
      thread: Thread,
      signal: AbortSignal,
    ): Promise<ThreadActionContext | null> => {
      try {
        const childSummary = await sdk.threads.childSummary({
          signal,
          threadId: thread.id,
        });
        if (signal.aborted) return null;

        return {
          childThreadCount: childSummary?.nonDeletedChildCount ?? 0,
        };
      } catch (error) {
        if (signal.aborted) return null;
        showMutationErrorToast({
          error,
          fallbackMessage: "Failed to check thread state",
        });
        return null;
      }
    },
    [],
  );

  const claimThreadActionContextAbortController =
    useCallback((): AbortController => {
      threadActionContextAbortRef.current?.abort();
      const controller = new AbortController();
      threadActionContextAbortRef.current = controller;
      return controller;
    }, []);

  function buildDialogTargetFromContext<T extends { thread: Thread }>(
    base: T,
    context: ThreadActionContext,
  ): T & { childThreadCount?: number } {
    return {
      ...base,
      ...(context.childThreadCount > 0
        ? { childThreadCount: context.childThreadCount }
        : {}),
    };
  }

  const performDelete = useCallback(
    ({
      childThreadsConfirmed,
      closeDialog,
      thread,
    }: DeleteThreadActionRequest) => {
      deleteMutate(
        { id: thread.id, childThreadsConfirmed },
        {
          onSuccess: () => {
            destroyPersistedBrowserViewsForThread({
              desktopBrowser: getDesktopBrowserApi(),
              threadId: thread.id,
            });
            closeDialog();
            syncNavigationAfterClose(closePanesForThreads([thread.id]), () =>
              viewedThreadIdRef.current === thread.id ? { kind: "new-thread" } : undefined,
            );
          },
        },
      );
    },
    [
      closePanesForThreads,
      deleteMutate,
      syncNavigationAfterClose,
    ],
  );

  const requestDelete = useCallback(
    async (thread: Thread) => {
      const controller = claimThreadActionContextAbortController();
      const context = await loadThreadActionContext(thread, controller.signal);
      if (context === null || controller.signal.aborted) return;
      if (threadActionContextAbortRef.current === controller) {
        threadActionContextAbortRef.current = null;
      }
      openDeleteDialog(buildDialogTargetFromContext({ thread }, context));
    },
    [
      claimThreadActionContextAbortController,
      loadThreadActionContext,
      openDeleteDialog,
    ],
  );

  const confirmDelete = useCallback(
    (target: ThreadDeleteDialogTarget) => {
      performDelete({
        childThreadsConfirmed: target.childThreadCount !== undefined,
        closeDialog: closeDeleteDialog,
        thread: target.thread,
      });
    },
    [closeDeleteDialog, performDelete],
  );

  const unarchiveThreadAction = useCallback(
    (thread: Thread) => {
      unarchiveMutate({ id: thread.id });
    },
    [unarchiveMutate],
  );

  const store = useStore();
  const location = useLocation();
  const route = useRef({ location, revision: 0 });
  useLayoutEffect(() => {
    if (route.current.location.key !== location.key) route.current = { location, revision: route.current.revision + 1 };
  }, [location]);
  const closeArchivedPanes = useCallback(
    (thread: Thread, archivedThreadIds: ReadonlySet<string>) => {
      const original = route.current;
      const layout = store.get(splitLayoutAtom);
      const maximized = store.get(maximizedPaneIdAtom);
      const opened = openedSectionTargetsRef.current;
      const openedTargets =
        opened?.threadId === thread.id ? opened.targets : [];
      const fallbackAfterArchive = (): PaneContent | undefined => {
        const viewed = viewedThreadIdRef.current;
        if (!viewed || !archivedThreadIds.has(viewed)) return;
        const listedThreadIds = new Set(
          getSidebarThreadNavigationTargets(document.body).map(
            (target) => target.threadId,
          ),
        );
        const isAvailable = (target: SidebarThreadShortcutTarget) =>
          !archivedThreadIds.has(target.threadId) &&
          listedThreadIds.has(target.threadId);
        const fallback =
          findArchiveFallback(openedTargets, thread.id, isAvailable) ??
          findArchiveFallback(
            getSidebarSectionTargets(thread.id),
            thread.id,
            isAvailable,
          );
        return fallback
          ? threadPaneContent({ projectId: fallback.projectId ?? thread.projectId, threadId: fallback.threadId })
          : { kind: "new-thread" };
      };
      const closed = closePanesForThreads([...archivedThreadIds]);
      const destination = syncNavigationAfterClose(closed, fallbackAfterArchive);
      const afterClose = store.get(splitLayoutAtom);
      // Apply the route's pane change now so the workspace effect reuses this exact layout.
      const remaining = destination ? reconcileLayoutForContent(afterClose, destination) : afterClose;
      if (remaining !== afterClose) store.set(splitLayoutAtom, remaining);
      const remainingMaximized = store.get(maximizedPaneIdAtom);
      return () => {
        // Leave later navigation, resizing, and other archive actions in the user's hands.
        const current = route.current;
        if (current !== original && (
          !destination ||
          current.revision !== original.revision + 1 ||
          current.location.pathname !== paneContentRoute(destination)
        )) return;
        if (store.get(splitLayoutAtom) !== remaining || store.get(maximizedPaneIdAtom) !== remainingMaximized) return;
        if (remaining !== layout) store.set(splitLayoutAtom, layout);
        if (remainingMaximized !== maximized) store.set(maximizedPaneIdAtom, maximized);
        if (destination) {
          const { pathname, search, hash, state } = original.location;
          navigate(pathname + search + hash, { replace: true, state });
        }
      };
    },
    [closePanesForThreads, navigate, store, syncNavigationAfterClose],
  );
  const openThread = useCallback(
    (thread: Thread) =>
      navigate(getThreadRoutePath({ projectId: thread.projectId, threadId: thread.id })),
    [navigate],
  );
  const {
    archive: archiveThreadAndChildrenAction,
    confirmation,
    closeConfirmation,
    confirmArchive, retry,
  } = useThreadArchive({
    closePanes: closeArchivedPanes,
    openThread,
    unarchive: unarchiveMutate,
  });
  // On desktop the archive shortcut is a menu accelerator, so it still fires
  // while this confirmation is open: pressing it again confirms. Presses in
  // the first moments after a popup appears are swallowed, so a late Cloud
  // check, a queued popup, or a held key can't confirm unread.
  const confirmArmedAtRef = useRef(0);
  useEffect(() => {
    confirmArmedAtRef.current = Date.now() + SHORTCUT_CONFIRM_DELAY_MS;
  }, [confirmation]);
  useAppCommandHandler(
    "thread.archive",
    () => {
      if (Date.now() >= confirmArmedAtRef.current) confirmArchive();
      return true;
    },
    200,
    Boolean(confirmation),
  );
  const archiveShortcut = useAppCommandShortcut("thread.archive");
  const archiveHint =
    getRoomDesktopInfo()?.onAppCommand && archiveShortcut ? (
      <>
        <kbd className="shrink-0 rounded border border-foreground/15 px-1.5 py-0.5 font-sans text-foreground/85">
          {archiveShortcut.label}
        </kbd>{" "}
        again to archive
      </>
    ) : null;

  const toggleRead = useCallback(
    (thread: Thread) => {
      if (getThreadReadToggleAction(thread) === "mark_unread") {
        markUnreadMutate({ threadId: thread.id }, {
          onError: (error) => {
            showMutationErrorToast({
              error,
              fallbackMessage: "Failed to mark thread unread",
            });
          },
        });
        return;
      }
      markReadMutate({ threadId: thread.id }, {
        onError: (error) => {
          showMutationErrorToast({
            error,
            fallbackMessage: "Failed to mark thread read",
          });
        },
      });
    },
    [markReadMutate, markUnreadMutate],
  );

  const togglePin = useCallback(
    (thread: Thread) => {
      if (thread.pinnedAt !== null) {
        unpinMutate({ id: thread.id });
        return;
      }
      pinMutate({ id: thread.id });
    },
    [pinMutate, unpinMutate],
  );

  const value = useMemo<ThreadActionsContextValue>(
    () => ({
      renameThread,
      requestRename,
      requestDelete,
      archiveThreadAndChildren: archiveThreadAndChildrenAction,
      unarchiveThread: unarchiveThreadAction,
      togglePin,
      toggleRead,
    }),
    [
      archiveThreadAndChildrenAction,
      renameThread,
      requestRename,
      requestDelete,
      togglePin,
      toggleRead,
      unarchiveThreadAction,
    ],
  );

  return (
    <ThreadActionsContext.Provider value={value}>
      {children}
      <ThreadRenameDialog
        target={renameDialog.target}
        pending={updateThread.isPending}
        onOpenChange={renameDialog.onOpenChange}
        onRename={submitRename}
      />
      <ThreadDeleteDialog
        target={deleteDialog.target}
        pending={deleteThread.isPending}
        onOpenChange={deleteDialog.onOpenChange}
        onDelete={confirmDelete}
      />
      <ConfirmDeleteDialog
        compact
        open={Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open) closeConfirmation();
        }}
      >
        <ConfirmDeleteDialogContent
          compact
          hint={archiveHint}
          title={confirmation?.runningCount === null ? "Archive without checking?" : "Archive running thread?"}
          secondaryAction={confirmation?.runningCount === null ? { label: "Retry", onClick: retry } : undefined}
          description={
            confirmation && <>
              {confirmation.runningCount === null && "Cloud couldn’t check whether this thread is running. "}
              {confirmation.runningCount !== null && confirmation.runningCount > 1 && `At least ${confirmation.runningCount} threads are running. `}
              Stops active work in{" "}
              <span className="font-medium text-foreground/90">{getThreadDisplayTitle(confirmation.thread)}</span>{" "}
              and its children.
            </>
          }
          confirmLabel="Archive"
          pending={false}
          onConfirm={confirmArchive}
          onCancel={closeConfirmation}
        />
      </ConfirmDeleteDialog>
    </ThreadActionsContext.Provider>
  );
}
