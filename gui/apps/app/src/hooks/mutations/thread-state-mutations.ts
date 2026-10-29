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

export function waitForThreadReasoningSave(
  queryClient: QueryClient,
  threadId: string,
): Promise<void> {
  const filters = { mutationKey: threadReasoningSaveKey(threadId) };
  return new Promise((resolve) => {
    if (queryClient.isMutating(filters) === 0) return resolve();
    const unsubscribe = queryClient.getMutationCache().subscribe(() => {
      if (queryClient.isMutating(filters) > 0) return;
      unsubscribe();
      resolve();
    });
  });
}

interface ArchiveThreadAndChildrenMutationRequest {
  id: string;
}

interface DeleteThreadMutationRequest {
  id: string;
  childThreadsConfirmed: boolean;
}

interface ThreadReadMutationInput {
  signal?: AbortSignal;
  threadId: string;
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
        : ["thread-update", options?.threadId],
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

export function useArchiveThreadAndChildren() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to archive thread and children.",
      lifecycleOperation: "archive_thread",
      showErrorToast: false,
    },
    mutationFn: ({
      id,
    }: ArchiveThreadAndChildrenMutationRequest): Promise<ThreadArchiveAllResponse> =>
      sdk.threads.archiveAll({ threadId: id }),
    onMutate: async ({ id }): Promise<ArchiveThreadsTransaction> =>
      beginArchiveThreadAndChildrenTransaction({
        queryClient,
        threadId: id,
      }),
    onError: (_error, _variables, context) => {
      rollbackArchiveThreadsTransaction({ queryClient, transaction: context });
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
    mutationFn: async ({
      id,
      keepParent,
    }: ThreadMutationRequest & { keepParent?: boolean }) => {
      await sdk.threads.unarchive({ threadId: id, keepParent });
    },
    onMutate: async ({ id }): Promise<ThreadListMutationTransaction> =>
      beginUnarchiveThreadTransaction({ queryClient, threadId: id }),
    onError: (_error, variables, context) => {
      rollbackThreadListMutationTransaction({
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
