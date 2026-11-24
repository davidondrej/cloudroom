import { useEffect, useState } from "react";
import { sdk } from "@/lib/sdk";

export type PromptSuggestionAction = "shown" | "accepted";

export function reportPromptSuggestion(
  threadId: string,
  action: PromptSuggestionAction,
): void {
  void sdk.cloudroom
    .promptSuggestionEvent({ threadId, action })
    .catch(() => {});
}

export function usePromptSuggestion(
  threadId: string,
  active: boolean,
  turnKey: number,
): string | null {
  const [result, setResult] = useState<{
    threadId: string;
    text: string | null;
  } | null>(null);
  useEffect(() => {
    setResult(null);
    if (!active) return;
    const controller = new AbortController();
    sdk.cloudroom
      .promptSuggestion({ threadId }, controller.signal)
      .then(({ suggestion }) => {
        if (!controller.signal.aborted) setResult({ threadId, text: suggestion });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [threadId, active, turnKey]);
  return active && result?.threadId === threadId ? result.text : null;
}
