import { useCallback } from "react";
import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { Thread } from "@cloudroom/domain";
import type {
  ReorderPinnedThreadRequest,
  ThreadArchiveAllResponse,
  ThreadResponse,
  UpdateThreadRequest,
} from "@cloudroom/server-contract";
import { useCommittedRef } from "@/hooks/useLatestRef";
import { sdk } from "@/lib/sdk";
import type { LifecycleErrorOperation } from "@/lib/lifecycle-errors";
import {
  applyReorderPinnedThreadResult,
  applyThreadPinStateResult,
  applyThreadReadStateResult,
  applyThreadReasoningResult,
  applyThreadUpdateResult,
  beginArchiveThreadAndChildrenTransaction,
  beginDeleteThreadTransaction,
  beginPinThreadTransaction,
  beginThreadReadStateTransaction,
  beginThreadMetadataTransaction,
  beginReorderPinnedThreadTransaction,
  beginUnarchiveThreadTransaction,
  beginUnpinAndMoveThreadTransaction,
  beginUnpinThreadTransaction,
  rollbackArchiveThreadsTransaction,
  rollbackDeleteThreadTransaction,
  rollbackReorderPinnedThreadTransaction,
  rollbackThreadListMutationTransaction,
  rollbackThreadReadStateTransaction,
  rollbackUnarchiveThreadTransaction,
  type ThreadReadStateTransaction,
  settleArchiveThreadsTransaction,
  settleDeleteThreadTransaction,
  settleThreadListMembershipMutation,
  type ArchiveThreadsTransaction,
  type DeleteThreadTransaction,
  type PinnedThreadOrderTransaction,
  type PinThreadPosition,
  type ThreadListMutationTransaction,
} from "../cache-owners/thread-state-cache-owner";
import { applyArchivedThreadIds } from "../cache-owners/thread-archive-cache";
import { threadReasoningSaveKey } from "../queries/query-keys";

interface ThreadMutationRequest {
  id: string;
}

type UpdateThreadMutationRequest = ThreadMutationRequest & UpdateThreadRequest;
type PinThreadMutationRequest = ThreadMutationRequest & {
  position?: PinThreadPosition;
};
type ReorderPinnedThreadMutationRequest = ThreadMutationRequest &
  ReorderPinnedThreadRequest;
type UnpinAndMoveThreadMutationRequest = ThreadMutationRequest & {
  sectionId: string | null;
};

interface MoveThreadToSectionRequest {
  sectionId: string | null;
  thread: Pick<Thread, "id" | "pinnedAt" | "sectionId">;
}

interface UpdateThreadMutationOptions {
  threadId?: string;
  errorMessage?: string | undefined;
  lifecycleOperation?: LifecycleErrorOperation | undefined;
  reasoning?: boolean;
}

export const THREAD_STOP_MUTATION_KEY = ["thread-stop"];

/**
 * A send waits for the thread's pending reasoning, model, or agent save, so a pick never blocks the composer.
 * It fails when a model or agent switch it waited for failed (the message would go to the wrong model),
 * or when the user pressed Stop meanwhile: the message shows as running, so Stop must drop it.
 */
export function waitForThreadExecutionSave(
  queryClient: QueryClient,
  threadId: string,
): Promise<void> {
  const keys = [threadReasoningSaveKey(threadId), threadUpdateKey(threadId)];
  const cache = queryClient.getMutationCache();
  const watched = keys.flatMap((mutationKey) =>
    cache.findAll({ mutationKey, exact: true, status: "pending" }),
  );
  if (watched.length === 0) return Promise.resolve();
  const waitingSince = Date.now();
  const stopped = () =>
    cache
      .findAll({ mutationKey: THREAD_STOP_MUTATION_KEY, exact: true })
      .some(
        (mutation) =>
          mutation.state.variables === threadId &&
          mutation.state.submittedAt >= waitingSince,
      );
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const settle = () => {
      if (stopped()) {
        unsubscribe();
        reject(new Error("Stopped before it was sent."));
        return;
      }
      if (watched.some((mutation) => mutation.state.status === "pending"))
        return;
      unsubscribe();
      const switchFailed = watched.some((mutation) => {
        const variables = mutation.state.variables as
          | UpdateThreadRequest
          | undefined;
        return (
          mutation.state.status === "error" &&
          (variables?.model !== undefined ||
            variables?.providerId !== undefined)
        );
      });
      if (switchFailed) {
        reject(new Error("The model switch failed, so this message wasn't sent."));
      } else {
        resolve();
      }
    };
    unsubscribe = cache.subscribe(settle);
    settle();
  });
}

function threadUpdateKey(threadId: string | undefined) {
  return ["thread-update", threadId];
}

interface ArchiveThreadAndChildrenMutationRequest {
  id: string;
  /** Default true: running children are stopped and archived too. False keeps them open. */
  includeLive?: boolean;
}

interface DeleteThreadMutationRequest {
  id: string;
  childThreadsConfirmed: boolean;
}

interface ThreadReadMutationInput {
  signal?: AbortSignal;
  threadId: string;
}

/** A Local picker or a same-session shortcut saves through the queue that follow-up sends already wait for. */
export function useSaveThreadModel(threadId: string, onSaved: (model: string) => void) {
  const { mutateAsync, isPending, variables } = useUpdateThread({
    threadId,
    errorMessage: "Failed to save the thread model.",
  });
  const currentThread = useCommittedRef(threadId);
  const save = useCallback(async (model: string, shortcutProvider?: string) => {
    await mutateAsync(
      { id: threadId, model, ...(shortcutProvider ? { providerId: shortcutProvider, idleSessionOnly: true } : {}) },
      { onSuccess: () => { if (currentThread.current === threadId) onSaved(model); } },
    );
  }, [currentThread, mutateAsync, onSaved, threadId]);
  return { save, pendingModel: isPending && variables.id === threadId ? variables.model : null };
}

export function useUpdateThread(options?: UpdateThreadMutationOptions) {
  const queryClient = useQueryClient();

  return useMutation<
    ThreadResponse,
    Error,
    UpdateThreadMutationRequest,
    ThreadListMutationTransaction | undefined
  >({
    mutationKey:
      options?.reasoning && options.threadId
        ? threadReasoningSaveKey(options.threadId)
        : threadUpdateKey(options?.threadId),
    ...(options?.threadId
      ? { scope: { id: `thread-update:${options.threadId}` } }
      : {}),
    meta: {
      errorMessage: options?.errorMessage ?? "Failed to update thread.",
      ...(options?.lifecycleOperation
        ? { lifecycleOperation: options.lifecycleOperation }
        : {}),
    },
    mutationFn: ({ id, ...request }: UpdateThreadMutationRequest) =>
      sdk.threads.update({ threadId: id, ...request }),
    onMutate: ({
      parentThreadId,
      sectionId,
      id,
      title,
    }): Promise<ThreadListMutationTransaction | undefined> | undefined => {
      if (
        title === undefined &&
        sectionId === undefined &&
        parentThreadId === undefined
      ) {
        return undefined;
      }

      return beginThreadMetadataTransaction({
        parentThreadId,
        sectionId,
        queryClient,
        threadId: id,
        title,
      });
    },
    onError: (_error, variables, context) => {
      rollbackThreadListMutationTransaction({
        queryClient,
        threadId: variables.id,
        transaction: context,
      });
    },
    onSuccess: (thread, request) =>
      options?.reasoning
        ? applyThreadReasoningResult({ queryClient, thread, request })
        : applyThreadUpdateResult({
            queryClient,
            thread,
            executionOptionsChanged:
              "model" in request || "reasoningLevel" in request,
          }),
  });
}

export function usePinThread() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to pin thread.",
    },
    mutationFn: async ({ id, position }: PinThreadMutationRequest) => {
      const thread = await sdk.threads.pin({ threadId: id });
      const orderedRoots = position
        ? await sdk.threads
            .reorderPinned({ threadId: id, ...position })
            .catch(() => null)
        : null;
      return { orderedRoots, thread };
    },
    onMutate: async ({
      id,
      position,
    }): Promise<ThreadListMutationTransaction> =>
      beginPinThreadTransaction({
        pinnedAt: Date.now(),
        position,
        queryClient,
        threadId: id,
      }),
    onError: (_error, variables, context) => {
      rollbackThreadListMutationTransaction({
        queryClient,
        threadId: variables.id,
        transaction: context,
      });
    },
    onSuccess: ({ orderedRoots, thread }) => {
      applyThreadPinStateResult({
        queryClient,
        thread,
        pinSortKey:
          orderedRoots?.find((root) => root.id === thread.id)?.pinSortKey ??
          null,
      });
      if (orderedRoots) {
        applyReorderPinnedThreadResult({ orderedRoots, queryClient });
      }
    },
    onSettled: (_data, _error, variables) => {
      settleThreadListMembershipMutation({
        queryClient,
        threadId: variables.id,
      });
    },
  });
}

export function useUnpinThread() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to unpin thread.",
    },
    mutationFn: ({ id }: ThreadMutationRequest) =>
      sdk.threads.unpin({ threadId: id }),
    onMutate: async ({ id }): Promise<ThreadListMutationTransaction> =>
      beginUnpinThreadTransaction({ queryClient, threadId: id }),
    onError: (_error, variables, context) => {
      rollbackThreadListMutationTransaction({
        queryClient,
        threadId: variables.id,
        transaction: context,
      });
    },
    onSuccess: (thread) => {
      applyThreadPinStateResult({ queryClient, thread, pinSortKey: null });
    },
    onSettled: (_data, _error, variables) => {
      settleThreadListMembershipMutation({
        queryClient,
        threadId: variables.id,
      });
    },
  });
}

export function useUnpinAndMoveThread() {
  const queryClient = useQueryClient();

  return useMutation<
    ThreadResponse,
    Error,
    UnpinAndMoveThreadMutationRequest,
    ThreadListMutationTransaction
  >({
    meta: {
      errorMessage: "Failed to unpin and move thread.",
    },
    mutationFn: async ({ sectionId, id }) => {
      await sdk.threads.unpin({ threadId: id });
      return sdk.threads.update({ sectionId, threadId: id });
    },
    onMutate: async ({ sectionId, id }) =>
      beginUnpinAndMoveThreadTransaction({
        sectionId,
        queryClient,
        threadId: id,
      }),
    onError: (_error, variables, context) => {
      rollbackThreadListMutationTransaction({
        queryClient,
        threadId: variables.id,
        transaction: context,
      });
    },
    onSuccess: (thread) => {
      applyThreadPinStateResult({ queryClient, thread, pinSortKey: null });
    },
    onSettled: (_data, _error, variables) => {
      settleThreadListMembershipMutation({
        queryClient,
        threadId: variables.id,
      });
    },
  });
}

export function useMoveThreadToSection() {
  const { mutate: updateThread } = useUpdateThread();
  const { mutate: unpinThread } = useUnpinThread();
  const { mutate: unpinAndMoveThread } = useUnpinAndMoveThread();

  return useCallback(
    ({ thread, sectionId }: MoveThreadToSectionRequest) => {
      if (thread.pinnedAt !== null) {
        if (thread.sectionId === sectionId) {
          unpinThread({ id: thread.id });
        } else {
          unpinAndMoveThread({ id: thread.id, sectionId });
        }
      } else if (thread.sectionId !== sectionId) {
        updateThread({ id: thread.id, sectionId });
      }
    },
    [unpinAndMoveThread, unpinThread, updateThread],
  );
}

export function useReorderPinnedThread() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to reorder pinned threads.",
      showErrorToast: false,
    },
    mutationFn: ({
      id,
      previousThreadId,
      nextThreadId,
    }: ReorderPinnedThreadMutationRequest) =>
      sdk.threads.reorderPinned({
        threadId: id,
        previousThreadId,
        nextThreadId,
      }),
    onMutate: async (request): Promise<PinnedThreadOrderTransaction> =>
      beginReorderPinnedThreadTransaction({ queryClient, request }),
    onError: (_error, _variables, context) => {
      rollbackReorderPinnedThreadTransaction({
        queryClient,
        transaction: context,
      });
    },
    onSuccess: (orderedRoots) => {
      applyReorderPinnedThreadResult({ orderedRoots, queryClient });
    },
  });
}

export function useArchiveThreadAndChildren({
  sidebarAlreadyHidden = false,
} = {}) {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to archive thread and children.",
      lifecycleOperation: "archive_thread",
      showErrorToast: false,
    },
    mutationFn: ({
      id,
      includeLive = true,
    }: ArchiveThreadAndChildrenMutationRequest): Promise<ThreadArchiveAllResponse> =>
      sdk.threads.archiveAll({ threadId: id, includeLive }),
    onMutate: async ({ id, includeLive }): Promise<ArchiveThreadsTransaction | undefined> => {
      // The sidebar hides each pending family separately. Its rollback only removes that family's filter.
      if (sidebarAlreadyHidden) return;
      return beginArchiveThreadAndChildrenTransaction({
        queryClient,
        threadId: id,
        includeLive,
      });
    },
    onError: (_error, _variables, context) => {
      rollbackArchiveThreadsTransaction({ queryClient, transaction: context });
    },
    onSuccess: ({ archivedThreadIds }) => {
      if (!sidebarAlreadyHidden) return;
      applyArchivedThreadIds({ queryClient, threadIds: archivedThreadIds });
    },
    onSettled: (data, _error, _variables, context) => {
      settleArchiveThreadsTransaction({
        queryClient,
        response: data,
        transaction: context,
      });
    },
  });
}

export function useUnarchiveThread() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to unarchive thread.",
    },
    mutationFn: ({
      id,
      keepParent,
      withChildren,
    }: ThreadMutationRequest & {
      keepParent?: boolean;
      withChildren?: boolean;
    }) => sdk.threads.unarchive({ threadId: id, keepParent, withChildren }),
    onMutate: async ({ id }): Promise<ThreadListMutationTransaction> =>
      beginUnarchiveThreadTransaction({ queryClient, threadId: id }),
    onError: (_error, variables, context) => {
      rollbackUnarchiveThreadTransaction({
        queryClient,
        threadId: variables.id,
        transaction: context,
      });
    },
    onSettled: (_data, _error, variables) => {
      settleThreadListMembershipMutation({
        queryClient,
        threadId: variables.id,
      });
    },
  });
}

export function useDeleteThread() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to delete thread.",
    },
    mutationFn: async ({
      childThreadsConfirmed,
      id,
    }: DeleteThreadMutationRequest) => {
      await sdk.threads.delete({ childThreadsConfirmed, threadId: id });
    },
    onMutate: async ({ id }): Promise<DeleteThreadTransaction> =>
      beginDeleteThreadTransaction({ queryClient, threadId: id }),
    onError: (_error, variables, context) => {
      rollbackDeleteThreadTransaction({
        queryClient,
        threadId: variables.id,
        transaction: context,
      });
    },
    onSettled: (_data, _error, variables, context) => {
      settleDeleteThreadTransaction({
        queryClient,
        threadId: variables.id,
        transaction: context,
      });
    },
  });
}

export function useMarkThreadRead() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to mark thread read.",
      showErrorToast: false,
    },
    mutationFn: (input: ThreadReadMutationInput) => sdk.threads.markRead(input),
    onMutate: (input): Promise<ThreadReadStateTransaction> =>
      beginThreadReadStateTransaction({
        lastReadAt: Date.now(),
        queryClient,
        threadId: input.threadId,
      }),
    onError: (_error, input, context) => {
      rollbackThreadReadStateTransaction({
        queryClient,
        threadId: input.threadId,
        transaction: context,
      });
    },
    onSuccess: (thread) => {
      applyThreadReadStateResult({ queryClient, thread });
    },
  });
}

export function useMarkThreadUnread() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to mark thread unread.",
      showErrorToast: false,
    },
    mutationFn: (input: ThreadReadMutationInput) =>
      sdk.threads.markUnread(input),
    onMutate: (input): Promise<ThreadListMutationTransaction> =>
      beginThreadReadStateTransaction({
        lastReadAt: null,
        queryClient,
        threadId: input.threadId,
      }),
    onError: (_error, input, context) => {
      rollbackThreadListMutationTransaction({
        queryClient,
        threadId: input.threadId,
        transaction: context,
      });
    },
    onSuccess: (thread) => {
      applyThreadReadStateResult({ queryClient, thread });
    },
  });
}
