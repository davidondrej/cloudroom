// Arrow-up recall of earlier prompts, like a shell's history.
import {
  arePromptDraftStatesEqual,
  isPromptDraftEmpty,
  type PromptDraftState,
} from "@cloudroom/client-core";
import { useEffect, useState } from "react";
import type { HistoryConfig } from "./prompt-box-types";

interface RecallSession {
  /** Which entry is showing. 0 is the newest. */
  index: number;
  /** The entry that was put into the editor. */
  recalled: PromptDraftState;
  /** What the user had typed before recalling, restored on the way back down. */
  saved: PromptDraftState;
}

export interface PromptHistory {
  /** True while the arrow keys walk the history instead of moving the caret. */
  canBrowse: boolean;
  /** Each returns true when it showed another draft. */
  showOlder: () => boolean;
  showNewer: () => boolean;
}

export function usePromptHistory(
  history: HistoryConfig | undefined,
  showDraft: (draft: PromptDraftState) => void,
): PromptHistory {
  const [session, setSession] = useState<RecallSession | null>(null);

  // Recall ends once the draft stops being the recalled entry: the user edited
  // it, sent it, or the entry is gone.
  useEffect(() => {
    if (!session) return;
    const entry = history?.entries[session.index];
    const stillShowing =
      history !== undefined &&
      entry !== undefined &&
      arePromptDraftStatesEqual(entry, session.recalled) &&
      arePromptDraftStatesEqual(history.currentDraft, session.recalled);
    if (!stillShowing) setSession(null);
  }, [history, session]);

  useEffect(() => {
    setSession(null);
  }, [history?.resetKey]);

  const entries = history?.entries ?? [];
  const recall = (index: number, saved: PromptDraftState) => {
    const draft = entries[index];
    if (!draft) return false;
    setSession({ index, recalled: draft, saved });
    showDraft(draft);
    return true;
  };

  return {
    canBrowse:
      history !== undefined &&
      (isPromptDraftEmpty(history.currentDraft) ||
        (session !== null &&
          entries[session.index] !== undefined &&
          arePromptDraftStatesEqual(
            history.currentDraft,
            entries[session.index]!,
          ))),
    showOlder: () => {
      if (!history) return false;
      return session
        ? recall(Math.min(session.index + 1, entries.length - 1), session.saved)
        : recall(0, history.currentDraft);
    },
    showNewer: () => {
      if (!session) return false;
      if (session.index > 0) return recall(session.index - 1, session.saved);
      showDraft(session.saved);
      setSession(null);
      return true;
    },
  };
}
