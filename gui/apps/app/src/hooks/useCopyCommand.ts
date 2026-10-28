import { useCallback } from "react";
import type { ThreadTimelineResponse, TimelineRow } from "@cloudroom/server-contract";
import type { PromptDraftState } from "@cloudroom/client-core";
import { appToast } from "@/components/ui/app-toast";
import { threadTimelineQueryKey } from "@/hooks/queries/query-keys";
import { appQueryClient } from "@/lib/app-query-client";
import { copyToClipboardWithToast } from "@/lib/clipboard";

export const COPY_COMMAND_NAME = "copy";

export function findLastAssistantMessageText(
  rows: readonly TimelineRow[],
): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.kind === "turn") {
      const text = findLastAssistantMessageText(row.children ?? []);
      if (text !== null) return text;
    } else if (
      row.kind === "conversation" &&
      row.role === "assistant" &&
      row.text.trim().length > 0
    ) {
      return row.text;
    }
  }
  return null;
}

export function useCopyCommand(
  threadId: string,
  clearDraft: (draft: PromptDraftState) => boolean,
) {
  return useCallback(
    (draft: PromptDraftState): boolean => {
      if (
        draft.text.trim() !== `/${COPY_COMMAND_NAME}` ||
        draft.attachments.length > 0
      ) {
        return false;
      }
      const timeline = appQueryClient.getQueryData<ThreadTimelineResponse>(
        threadTimelineQueryKey(threadId),
      );
      const text = findLastAssistantMessageText(timeline?.rows ?? []);
      if (text === null) {
        appToast.error("No agent response to copy");
        return true;
      }
      clearDraft(draft);
      void copyToClipboardWithToast(text, {
        successMessage: "Copied last response",
      });
      return true;
    },
    [clearDraft, threadId],
  );
}
