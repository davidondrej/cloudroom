import { useCallback, useEffect, useRef } from "react";
import type { Thread } from "@cloudroom/domain";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { useThreadActions } from "@/components/thread/ThreadActionsProvider";
import { usePinThread } from "@/hooks/mutations/thread-state-mutations";
import { useOptionalPaneContext, usePaneContext } from "./PaneContext";

export function ThreadPinCommandHandler({ thread }: { thread: Thread }) {
  const { isFocused } = usePaneContext();
  const { togglePin } = useThreadActions();

  useAppCommandHandler("thread.pin", () => {
    if (!isFocused) return false;
    togglePin(thread);
    return true;
  });

  return null;
}

export function useNewThreadPinCommand(isCreating: boolean) {
  const isFocused = useOptionalPaneContext()?.isFocused ?? true;
  const { mutate: pinThread } = usePinThread();
  const pinRequestedRef = useRef(false);

  useEffect(() => {
    if (isCreating) pinRequestedRef.current = false;
  }, [isCreating]);

  useAppCommandHandler(
    "thread.pin",
    () => {
      if (!isFocused) return false;
      pinRequestedRef.current = true;
      return true;
    },
    0,
    isCreating,
  );

  return useCallback(
    (
      threadId: string,
      pin = false,
      alreadyPinned = false,
    ): Promise<void> => {
      const requested = pinRequestedRef.current || pin;
      pinRequestedRef.current = false;
      if (!requested || alreadyPinned) return Promise.resolve();
      return new Promise<void>((resolve) => {
        pinThread({ id: threadId, onOptimisticApplied: resolve });
      });
    },
    [pinThread],
  );
}
