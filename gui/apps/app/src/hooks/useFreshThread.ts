import { useCallback } from "react";
import {
  buildFreshThreadRequest,
  type FollowUpExecutionSelection,
} from "@cloudroom/client-core";
import type { Thread } from "@cloudroom/domain";
import { useRouteNavigate } from "@/components/ui/app-route-anchor";
import { useCreateThread } from "@/hooks/mutations/thread-runtime-mutations";
import { useArchiveThreadAndChildren } from "@/hooks/mutations/thread-state-mutations";
import { getThreadRoutePath } from "@/lib/route-paths";

/**
 * "Fresh thread" on the context card: opens a new thread in the same folder
 * that continues this one and archives this one. Running children stay open.
 * The new thread is never pinned: only the user pins a thread.
 */
export function useFreshThread({
  thread,
  providerId,
  execution,
}: {
  thread: Thread;
  providerId: string;
  execution: FollowUpExecutionSelection;
}): { start: () => Promise<void>; isPending: boolean } {
  const navigate = useRouteNavigate();
  const { mutateAsync: createThread, isPending } = useCreateThread();
  const { mutate: archiveThread } = useArchiveThreadAndChildren();

  const start = useCallback(async () => {
    const request = buildFreshThreadRequest({ thread, providerId, execution });
    if (request === null) return;
    // One ID per click: the create retries on its own, and the server makes one thread.
    // A failed create shows its own toast; this thread stays as it is.
    const fresh = await createThread({
      ...request,
      requestId: crypto.randomUUID(),
    }).catch(() => null);
    if (fresh === null) return;
    navigate(
      getThreadRoutePath({ projectId: fresh.projectId, threadId: fresh.id }),
    );
    // The server keeps running children open; idle ones are archived with it.
    archiveThread({ id: thread.id, includeLive: false });
  }, [
    archiveThread,
    createThread,
    execution,
    navigate,
    providerId,
    thread,
  ]);

  return { start, isPending };
}
