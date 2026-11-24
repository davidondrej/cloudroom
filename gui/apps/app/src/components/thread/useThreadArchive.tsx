import { useCallback, useState } from "react";
import { useStore } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { isThreadRunning } from "@cloudroom/client-core";
import type { Thread } from "@cloudroom/domain";
import { appToast } from "@/components/ui/app-toast";
import {
  getCachedArchiveTree,
  newestThread,
  pendingArchiveFamiliesAtom,
  pendingArchiveIdsAtom,
} from "@/hooks/cache-owners/thread-archive-cache";
import { useArchiveThreadAndChildren } from "@/hooks/mutations/thread-state-mutations";
import { threadQueryKey } from "@/hooks/queries/query-keys";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { showMutationErrorToast } from "@/lib/mutation-errors";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { ArchivedThreadToastDescription } from "./ArchivedThreadToastDescription";

async function cloudRunning(
  threadId: string,
  signal: AbortSignal,
): Promise<string[] | null> {
  const response = await fetchWithAppSurface(
    `/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/running`,
    { signal: AbortSignal.any([signal, AbortSignal.timeout(7_000)]) },
  ).catch(() => null);
  if (!response) return null;
  const body = await response.json().catch(() => null);
  if (
    [401, 403].includes(response.status) ||
    body?.code === "cloudroom_other_account"
  ) {
    throw new Error(
      body?.message ?? "Sign in to the account that owns this thread.",
    );
  }
  const running = body?.running;
  return response.ok &&
    Array.isArray(running) &&
    running.every((id) => typeof id === "string")
    ? running
    : null;
}

interface ArchiveConfirmation {
  thread: Thread;
  runningCount: number | null;
}

interface ArchiveActions {
  closePanes: (thread: Thread, ids: ReadonlySet<string>) => () => void;
  openThread: (thread: Thread) => void;
  unarchive: (request: { id: string; keepParent: true }) => void;
}

export function useThreadArchive({
  closePanes,
  openThread,
  unarchive,
}: ArchiveActions) {
  const store = useStore();
  const queryClient = useQueryClient();
  const { mutateAsync: commit } = useArchiveThreadAndChildren({
    sidebarAlreadyHidden: true,
  });
  const [confirmations, setConfirmations] = useState<ArchiveConfirmation[]>([]);

  const archive = useCallback(
    async (thread: Thread, confirmed = false): Promise<void> => {
      if (store.get(pendingArchiveIdsAtom).has(thread.id)) return;
      const family = () => {
        const { root, descendants } = getCachedArchiveTree(
          queryClient,
          thread.id,
        );
        return [newestThread(thread, root), ...descendants].map((item) =>
          newestThread<Thread>(
            item,
            queryClient.getQueryData<Thread>(threadQueryKey(item.id)),
          ),
        );
      };
      const members = family();
      const ask = (runningCount: number | null) =>
        setConfirmations((queue) =>
          queue.some((item) => item.thread.id === thread.id)
            ? queue
            : [...queue, { thread, runningCount }],
        );
      const knownRunning = members.filter(isThreadRunning);
      if (!confirmed && knownRunning.length) {
        ask(knownRunning.length);
        return;
      }

      const ids = new Set(members.map((item) => item.id));
      const controller = new AbortController();
      let committing = false;
      let idsToRestore: string[] | undefined;
      const reveal = () =>
        store.set(pendingArchiveFamiliesAtom, (families) =>
          families.includes(ids)
            ? families.filter((family) => family !== ids)
            : families,
        );
      const restorePanes = closePanes(thread, ids);
      const rollback = () => {
        reveal();
        const pending = store.get(pendingArchiveIdsAtom);
        if (!members.some((member) => pending.has(member.id))) restorePanes();
      };
      store.set(pendingArchiveFamiliesAtom, (families) => [...families, ids]);
      const title = getThreadDisplayTitle(thread);
      const toastId = `thread-archived-${thread.id}`;
      // Both versions of the toast use this callback, even if the server replies between paint and click.
      const undo = () => {
        controller.abort();
        if (!committing) rollback();
        for (const id of idsToRestore ?? [])
          unarchive({ id, keepParent: true });
        idsToRestore = undefined;
      };
      const undoAction = { label: "Undo", onClick: undo };
      const cloud = members.some((item) => item.executionTarget === "cloud");
      if (cloud)
        appToast.loading("Archiving…", {
          compact: true,
          description: title,
          id: toastId,
          cancel: undoAction,
        });

      try {
        if (cloud && !confirmed) {
          const running = await cloudRunning(thread.id, controller.signal);
          if (controller.signal.aborted) return;
          const runningIds = new Set([
            ...(running ?? []),
            ...family()
              .filter(isThreadRunning)
              .map((item) => item.id),
          ]);
          if (running === null || runningIds.size) {
            appToast.dismiss(toastId);
            rollback();
            ask(runningIds.size || null);
            return;
          }
        }
        committing = true;
        const { archivedThreadIds } = await commit({ id: thread.id });
        if (!archivedThreadIds.length) {
          appToast.dismiss(toastId);
          return;
        }
        idsToRestore = archivedThreadIds;
        if (controller.signal.aborted) {
          rollback();
          undo();
          return;
        }
        appToast.success("Archived", {
          compact: true,
          id: toastId,
          duration: 8_000,
          description: (
            <ArchivedThreadToastDescription
              archivedThreadCount={archivedThreadIds.length}
              threadTitle={title}
              onOpenThread={() => {
                openThread(thread);
                appToast.dismiss(toastId);
              }}
            />
          ),
          cancel: undoAction,
        });
      } catch (error) {
        rollback();
        appToast.dismiss(toastId);
        if (controller.signal.aborted) return;
        showMutationErrorToast({
          error,
          fallbackMessage: "Failed to archive thread and children",
          lifecycleOperation: "archive_thread",
        });
      } finally {
        reveal();
      }
    },
    [closePanes, commit, openThread, queryClient, store, unarchive],
  );

  const confirmation = confirmations[0];
  const closeConfirmation = () =>
    setConfirmations((queue) => queue.filter((item) => item !== confirmation));
  const actOnConfirmation = (confirmed: boolean) => {
    closeConfirmation();
    if (confirmation) void archive(confirmation.thread, confirmed);
  };
  return {
    archive,
    confirmation,
    closeConfirmation,
    confirmArchive: () => actOnConfirmation(true),
    retry: () => actOnConfirmation(false),
  };
}
