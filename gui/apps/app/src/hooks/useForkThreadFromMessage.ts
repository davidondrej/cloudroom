import { useCallback, useLayoutEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Thread } from "@cloudroom/domain";
import { appToast } from "@/components/ui/app-toast";
import { sdk } from "@/lib/sdk";
import {
  FORK_THREAD_CREATE_SEED_LOCATION_STATE_KEY,
  isThreadForkable,
  type ForkThreadCreateSeed,
} from "@cloudroom/client-core";
import { getRootComposeRoutePath } from "@/lib/route-paths";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import type { ThreadTimelineForkMessageHandler } from "@/components/thread/timeline/types";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { useSetRootComposeProjectId } from "@/lib/root-compose-selection";
import { threadDefaultExecutionOptionsQueryKey } from "@/hooks/queries/query-keys";
import { useRouteNavigate } from "@/components/ui/app-route-anchor";

interface UseForkThreadFromMessageArgs {
  sourceThread: Thread | null;
}

type ForkThreadFromMessageTarget = Parameters<ThreadTimelineForkMessageHandler>[0];

export function useForkThreadFromMessage({
  sourceThread,
}: UseForkThreadFromMessageArgs): (
  target: ForkThreadFromMessageTarget,
) => Promise<void> {
  const navigate = useRouteNavigate();
  const queryClient = useQueryClient();
  const setRootComposeProjectId = useSetRootComposeProjectId();
  const forkInFlightRef = useRef(false);
  const sourceThreadRef = useRef(sourceThread);
  useLayoutEffect(() => {
    sourceThreadRef.current = sourceThread;
  }, [sourceThread]);

  return useCallback(
    async (target: ForkThreadFromMessageTarget) => {
      const source = sourceThreadRef.current;
      if (
        source === null ||
        !isThreadForkable(source) ||
        forkInFlightRef.current
      ) {
        return;
      }

      forkInFlightRef.current = true;
      try {
        const [point, executionOptions] = await Promise.all([
          sdk.threads.messageForkPoint({ threadId: source.id, sequence: target.sourceSeqEnd }),
          queryClient.fetchQuery({
            queryKey: threadDefaultExecutionOptionsQueryKey(source.id),
            queryFn: ({ signal }) =>
              sdk.threads.defaultExecutionOptions({
                signal,
                threadId: source.id,
              }),
          }),
        ]);
        if (sourceThreadRef.current?.id !== source.id) return;
        if (executionOptions === null) {
          appToast.message("Couldn't load this thread's settings to fork it.");
          return;
        }

        const openComposer = (sequence: number) => {
          if (sourceThreadRef.current?.id !== source.id) return;
          const seed: ForkThreadCreateSeed = {
            environmentId: source.environmentId,
            model: executionOptions.model,
            permissionMode: executionOptions.permissionMode,
            projectId: source.projectId,
            providerId: source.providerId,
            reasoningLevel: executionOptions.reasoningLevel,
            serviceTier: executionOptions.serviceTier,
            sourceSeqEnd: sequence,
            sourceThreadId: source.id,
            sourceThreadTitle: getThreadDisplayTitle(source),
          };
          if (target.context !== undefined) {
            getPromptDraftAccessor({ kind: "new-thread" }).addQuote(
              target.context.text,
              undefined,
              { messageNumber: target.context.messageNumber },
            );
          }
          setRootComposeProjectId(source.projectId);
          navigate(getRootComposeRoutePath(), {
            state: {
              focusPrompt: true,
              [FORK_THREAD_CREATE_SEED_LOCATION_STATE_KEY]: seed,
            },
          });
        };
        const sequence = point.sequence;
        if (sequence === null) {
          appToast.message("No saved reply is available to fork here yet.");
        } else if (point.exact) {
          openComposer(sequence);
        } else {
          appToast.message("This message can’t be forked on its own.", {
            action: { label: "Use previous finished turn", onClick: () => openComposer(sequence) },
          });
        }
      } catch (error) {
        appToast.error(error instanceof Error ? error.message : "Could not check this fork point.");
      } finally {
        forkInFlightRef.current = false;
      }
    },
    [navigate, queryClient, setRootComposeProjectId],
  );
}
