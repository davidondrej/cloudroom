import { useCallback, useEffect, useMemo, type RefObject } from "react";
import { appToast } from "@/components/ui/app-toast";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import {
  getPromptDraftAccessor,
  type PromptDraftScope,
} from "@/hooks/usePromptDraftStorage";
import { transcribeVoiceInput } from "@/lib/api";
import type { PromptBoxHandle, PromptVoiceConfig } from "./PromptBoxInternal";

/** The draft a voice recording belongs to. Its text lands there even after the user leaves. */
export interface PromptVoiceTarget {
  draftScope: PromptDraftScope;
  /** Shown in the toast when the text lands while the user is elsewhere, e.g. the thread title. */
  label?: string;
  /**
   * Sends that draft and resolves true once it is sent or queued.
   * Must read the stored draft when called: it can run after the composer is gone.
   */
  send?: () => Promise<boolean>;
}

async function requestVoiceTranscription({
  file,
  promptContext,
  signal,
  clientId,
}: {
  file: File;
  promptContext?: string;
  signal?: AbortSignal;
  clientId?: string;
}): Promise<string> {
  const transcription = await transcribeVoiceInput(
    file,
    promptContext,
    signal,
    clientId,
  );
  return transcription.text;
}

function createVoiceAbortError(): DOMException {
  return new DOMException("Voice transcription was cancelled", "AbortError");
}

/** Sends the draft if asked, then says honestly where the text ended up. */
async function reportBackgroundDelivery(
  target: PromptVoiceTarget,
  submit: boolean,
): Promise<void> {
  const sent =
    submit && target.send ? await target.send().catch(() => false) : false;
  const description = target.label ? { description: target.label } : {};
  if (sent) appToast.success("Voice message sent", description);
  else appToast.message("Voice text saved to draft", description);
}

/** Adds the text to the end of a stored draft, the way it would have been typed. */
function appendToDraft(scope: PromptDraftScope, text: string): void {
  const draft = getPromptDraftAccessor(scope);
  const current = draft.getCurrent();
  const separator = current.text === "" || /\s$/.test(current.text) ? "" : " ";
  draft.setDraft({ ...current, text: current.text + separator + text });
}

export function usePromptVoice(
  promptBoxRef: RefObject<PromptBoxHandle | null>,
  target?: PromptVoiceTarget,
): PromptVoiceConfig {
  const draftKey = target
    ? getPromptDraftAccessor(target.draftScope).storageKey
    : null;

  // Captured per recording by useVoiceInput, so `target` is the draft that recording belongs to.
  const onTranscript = useCallback(
    (text: string, { submit, shown }: { submit: boolean; shown: boolean }) => {
      const promptBox = promptBoxRef.current;
      if (shown && promptBox) {
        promptBox.insertTextAtCursor(text);
        if (submit) promptBox.submit();
        return;
      }
      if (!target) {
        // Throwing keeps the audio and offers Retry and Download.
        throw new Error(
          "The message box closed before transcription finished.",
        );
      }
      appendToDraft(target.draftScope, text);
      void reportBackgroundDelivery(target, submit);
    },
    [promptBoxRef, target],
  );

  const getPromptContext = useCallback(
    () => promptBoxRef.current?.getTextBeforeCursor(),
    [promptBoxRef],
  );

  const transcribeAfterCompletionTransition = useCallback(
    async (
      args: Parameters<typeof requestVoiceTranscription>[0] & {
        isShown?: () => boolean;
      },
    ) => {
      const text = await requestVoiceTranscription(args);
      // Only the recording this box shows may fade its voice bar; another may be recording now.
      if (args.isShown?.()) {
        await promptBoxRef.current?.playVoiceCompletionTransition();
      }
      if (args.signal?.aborted) {
        throw createVoiceAbortError();
      }
      return text;
    },
    [promptBoxRef],
  );

  const voiceInput = useVoiceInput({
    onTranscript,
    onTranscribe: transcribeAfterCompletionTransition,
    getPromptContext,
  });

  // The composer stays mounted when the user opens another thread. Hand the old recording off so
  // its text goes to its own thread, and this composer is free for the new one.
  const { detach } = voiceInput;
  useEffect(() => detach, [detach, draftKey]);

  const { stop: stopVoiceInput } = voiceInput;
  const stop = useCallback(() => stopVoiceInput(false), [stopVoiceInput]);
  const stopAndSend = useCallback(() => stopVoiceInput(true), [stopVoiceInput]);

  return useMemo<PromptVoiceConfig>(
    () => ({
      state: voiceInput.state,
      isSupported: voiceInput.isSupported,
      stream: voiceInput.stream,
      start: voiceInput.start,
      stop,
      stopAndSend,
      cancel: voiceInput.cancel,
    }),
    [
      voiceInput.state,
      voiceInput.isSupported,
      voiceInput.stream,
      voiceInput.start,
      stop,
      stopAndSend,
      voiceInput.cancel,
    ],
  );
}
