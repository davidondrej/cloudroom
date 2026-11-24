import { useMemo } from "react";
import { AppPageHeader } from "@/components/layout/AppPageHeader";
import { EmbeddedThreadChat } from "@/components/thread/embedded-chat";
import type { NewThreadComposerSubmission } from "@/components/promptbox/NewThreadComposer";
import { buildOptimisticUserMessageRow } from "@/hooks/cache-owners/thread-runtime-cache-owner";

const STARTING_THREAD_ID = "starting";

export type StartingThreadMessage = Pick<
  NewThreadComposerSubmission,
  "input" | "projectId"
> & { sentAt: number };

/** A phone's screen from the tap on Send until the server has made the thread.
 *  It draws the thread screen's own header and timeline with the message
 *  already in it, so the real thread takes its place without a jump. It asks
 *  the server for nothing. */
export function StartingThread({
  input,
  projectId,
  sentAt,
}: StartingThreadMessage) {
  const row = useMemo(
    () =>
      buildOptimisticUserMessageRow({
        createdAt: sentAt,
        input,
        mode: "start",
        threadId: STARTING_THREAD_ID,
        threadStatus: null,
      }),
    [input, sentAt],
  );
  return (
    <div className="-mx-4 -mb-4 -mt-4 flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-clip">
      <AppPageHeader compact />
      <EmbeddedThreadChat
        variant="hosted-footer"
        footer={null}
        surface={{
          activeThinking: null,
          contextBoundarySeq: null,
          isThreadTimelinePending: false,
          timelineError: false,
          projectId,
          includePluginMessageActions: false,
          showOngoingIndicator: true,
          ongoingIndicatorLabel: "Provisioning thread...",
          timelineRows: [row],
          threadId: STARTING_THREAD_ID,
          threadRuntimeDisplayStatus: "starting",
          workspaceRootPath: undefined,
        }}
      />
    </div>
  );
}
