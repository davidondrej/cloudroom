import { useEffect, useState } from "react";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { PROMPT_STACK_ON_INPUT_CLASS, PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { useCard, useCardBudget } from "@/lib/popups";
import { sdk } from "@/lib/sdk";

type Suggestion = { name: string; what: string; count: number; prompt: string };
const report = (threadId: string, action: "shown" | "accepted" | "dismissed") => void sdk.cloudroom.skillSuggestionEvent({ threadId, action }).catch(() => {});

/**
 * The "save as skill" card above the chat input (docs/scopes/skill-suggestions.md): shows when this thread just
 * finished a job the user keeps asking for by hand. The server decides who sees it and how often. The button puts
 * the request in the chat box; it never sends by itself.
 */
export function SkillSuggestionCard({ threadId, idle, turnKey, attached, onUse }: { threadId: string; idle: boolean; turnKey: number; attached: boolean; onUse: (prompt: string) => void }) {
  // `undefined`: still asking. The answer belongs to one thread and one turn.
  const [found, setFound] = useState<{ key: string; suggestion: Suggestion | null }>();
  const key = `${threadId}:${turnKey}`;
  useEffect(() => {
    if (!idle) return;
    const controller = new AbortController();
    sdk.cloudroom.skillSuggestion({ threadId }, controller.signal)
      .then(({ suggestion }) => { if (!controller.signal.aborted) setFound({ key, suggestion }); })
      .catch(() => { if (!controller.signal.aborted) setFound({ key, suggestion: null }); });
    return () => controller.abort();
  }, [threadId, idle, key]);
  const suggestion = idle && found?.key === key ? found.suggestion : null;
  const budget = useCardBudget();
  // While the answer is on its way, less important cards wait, so one never shows and then gives way.
  const first = useCard("skill", !idle ? false : found?.key !== key || budget.left === null ? null : suggestion !== null && budget.left);
  useEffect(() => { if (first) report(threadId, "shown"); }, [first, threadId]);
  if (!first || !suggestion) return null;
  const answer = (action: "accepted" | "dismissed") => {
    report(threadId, action);
    setFound({ key, suggestion: null });
  };
  return (
    <PromptStackCard ariaLabel="Save as skill" className={cn("mx-3 overflow-hidden rounded-xl border-muted-foreground/15 sm:mx-4", attached && PROMPT_STACK_ON_INPUT_CLASS)}>
      <div data-testid="skill-card" className="flex items-center gap-3 py-2 pr-2 pl-3.5">
        <span className="shrink-0 text-2xl leading-none font-semibold text-primary tabular-nums">
          {suggestion.count}<span className="ml-px text-[13px]">×</span>
        </span>
        <span className="flex h-6 shrink-0 items-end gap-[3px]" aria-hidden="true">
          {Array.from({ length: Math.min(suggestion.count, 8) }, (_, index) => <span key={index} className="h-full w-2 rounded-[1.5px] bg-primary" />)}
        </span>
        <span className="h-7 w-px shrink-0 bg-muted-foreground/20" aria-hidden="true" />
        <span className="min-w-0 flex-1 text-[12.5px] leading-[1.35]">
          <span className="block truncate font-medium text-foreground">You asked for this job {suggestion.count} times in 2 weeks</span>
          <span className="block truncate text-muted-foreground">Save the steps and your fixes as /{suggestion.name}.</span>
        </span>
        <button type="button" className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-2.5 text-[12.5px] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          onClick={() => { onUse(suggestion.prompt); answer("accepted"); }}>
          <Icon name="Zap" className="size-3.5" aria-hidden="true" />
          Save as skill
        </button>
        <button type="button" aria-label="Dismiss" className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground" onClick={() => answer("dismissed")}>
          <Icon name="X" className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </PromptStackCard>
  );
}
