import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Thread } from "@cloudroom/domain";
import { isThreadRead, type ThreadReadState } from "@cloudroom/client-core";
import {
  isDocumentAttended,
  subscribeToDocumentVisibility,
  useDocumentVisibilityRevision,
} from "@/lib/document-visibility";

type ThreadReadTrackingState = ThreadReadState & Pick<Thread, "id">;

interface MarkThreadReadMutation {
  mutateAsync: (input: {
    signal?: AbortSignal;
    threadId: string;
  }) => Promise<ThreadReadState>;
}

interface UseThreadReadTrackingParams {
  active?: boolean;
  markThreadRead: MarkThreadReadMutation;
  thread?: ThreadReadTrackingState;
}

interface ReadTrackingSnapshot {
  isVisible: boolean;
  isRead: boolean | null;
  latestAttentionAt: number | null;
  threadId: string | null;
}

export function useThreadReadTracking({
  active = true,
  markThreadRead,
  thread,
}: UseThreadReadTrackingParams) {
  const failedReadKeysRef = useRef<Set<string>>(new Set());
  const pendingReadControllersRef = useRef<Map<string, AbortController>>(
    new Map(),
  );
  const suppressedManualUnreadKeysRef = useRef<Set<string>>(new Set());
  const previousSnapshotRef = useRef<ReadTrackingSnapshot | null>(null);
  const visibilityRevision = useDocumentVisibilityRevision();
  // A hook, not a plain call: the React Compiler caches a plain call's result from the first render.
  const isDocumentVisible = useSyncExternalStore(
    subscribeToDocumentVisibility,
    isDocumentAttended,
    isDocumentAttended,
  );
  const isVisible = active && isDocumentVisible;

  useEffect(() => {
    const controllers = pendingReadControllersRef.current;
    return () => {
      for (const controller of controllers.values()) controller.abort();
    };
  }, []);

  useEffect(() => {
    const previousSnapshot = previousSnapshotRef.current;
    const threadIsRead = thread ? isThreadRead(thread) : null;
    const currentSnapshot: ReadTrackingSnapshot = {
      isVisible,
      isRead: threadIsRead,
      latestAttentionAt: thread?.latestAttentionAt ?? null,
      threadId: thread?.id ?? null,
    };
    previousSnapshotRef.current = currentSnapshot;

    if (previousSnapshot?.threadId !== currentSnapshot.threadId) {
      for (const controller of pendingReadControllersRef.current.values()) {
        controller.abort();
      }
    }

    if (!isVisible) {
      return;
    }
    if (!thread) {
      return;
    }

    const marker = `${thread.id}:${thread.latestAttentionAt}`;
    const isOpenedThread =
      previousSnapshot === null || previousSnapshot.threadId !== thread.id;
    const hasNewAttention =
      previousSnapshot?.threadId === thread.id &&
      previousSnapshot.latestAttentionAt !== thread.latestAttentionAt;
    if (isOpenedThread || hasNewAttention) {
      suppressedManualUnreadKeysRef.current.clear();
    }

    if (threadIsRead) {
      failedReadKeysRef.current.delete(marker);
      suppressedManualUnreadKeysRef.current.delete(marker);
      return;
    }

    const becameVisible =
      previousSnapshot?.threadId === thread.id &&
      previousSnapshot.isVisible === false;
    const isRetry = failedReadKeysRef.current.has(marker);
    const becameManuallyUnread =
      previousSnapshot?.threadId === thread.id &&
      previousSnapshot.latestAttentionAt === thread.latestAttentionAt &&
      previousSnapshot.isVisible &&
      previousSnapshot.isRead === true &&
      !isRetry;

    if (becameManuallyUnread) {
      suppressedManualUnreadKeysRef.current.add(marker);
    }
    if (
      suppressedManualUnreadKeysRef.current.has(marker) &&
      !isOpenedThread &&
      !hasNewAttention
    ) {
      return;
    }

    if (!isOpenedThread && !hasNewAttention && !becameVisible && !isRetry) {
      return;
    }
    if (pendingReadControllersRef.current.has(marker)) {
      return;
    }

    failedReadKeysRef.current.delete(marker);
    const controller = new AbortController();
    pendingReadControllersRef.current.set(marker, controller);
    void markThreadRead
      .mutateAsync({ signal: controller.signal, threadId: thread.id })
      .catch(() => {
        failedReadKeysRef.current.add(marker);
      })
      .finally(() => {
        if (pendingReadControllersRef.current.get(marker) === controller) {
          pendingReadControllersRef.current.delete(marker);
        }
      });
  }, [isVisible, markThreadRead, thread, visibilityRevision]);
}
