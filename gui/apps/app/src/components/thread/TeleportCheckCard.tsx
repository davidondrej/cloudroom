import { useState } from "react";
import { reasoningLevelSchema } from "@cloudroom/domain";
import { Icon } from "@cloudroom/shared-ui/icon";
import { PromptStackCard, PROMPT_STACK_CARD_ROW_HEIGHT, PROMPT_STACK_INLAY_SEGMENT_CLASS } from "@/components/promptbox/banner/PromptStackCard";
import { BannerActionSlot, PromptBannerActionButton } from "@/components/promptbox/banner/prompt-banner-actions";
import type { ModelPickerOption } from "@/components/pickers/model-picker-option";
import { reasoningLevelLabel } from "@/lib/reasoning-labels";
import { BbHttpError } from "@/lib/sdk";
import { cn } from "@cloudroom/shared-ui/lib/utils";

type Choice = { model: string; reasoning: string };

export function claudeContextWindow(model: string): number | null {
  if (!model.startsWith("claude-") && !["opus", "sonnet", "fable", "haiku"].some((alias) => model.startsWith(alias))) return null;
  return model.endsWith("[1m]") ? 1_000_000 : 200_000;
}

export function TeleportCheckCard({ error, models, reasoning, usedTokens, levelsFor, onTeleport, onDismiss }: {
  error: Error | null;
  models: ModelPickerOption[];
  reasoning: string;
  usedTokens: number | null;
  levelsFor: (model: string) => string[];
  onTeleport: (choice: Choice) => void;
  onDismiss: () => void;
}) {
  const choices = models.flatMap((option) => {
    const levels = levelsFor(option.value);
    return levels.length ? [{ option, levels }] : [];
  });
  const [model, setModel] = useState<string | null>(null);
  const [level, setLevel] = useState<string | null>(null);
  if (!error) return null;
  const pickModel = error instanceof BbHttpError && error.code === "teleport_model_unavailable";
  const selected = choices.find((choice) => choice.option.value === model) ?? choices[0];
  const levels = selected?.levels ?? [];
  const effort = level && levels.includes(level) ? level : levels.includes(reasoning) ? reasoning : levels.includes("high") ? "high" : levels[0];
  const contextWindow = selected ? claudeContextWindow(selected.option.value) : null;
  const tooBig = usedTokens !== null && contextWindow !== null && usedTokens > contextWindow;
  const label = (value: string) => {
    const parsed = reasoningLevelSchema.safeParse(value);
    return parsed.success ? reasoningLevelLabel(parsed.data, undefined) : value;
  };
  const message = error?.message.replace(/^HTTP \d+: /, "");
  return (
    <PromptStackCard ariaLabel="Teleport check" className="ml-auto mr-3 w-fit max-w-[calc(100%-1.5rem)] overflow-hidden sm:mr-4" style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}>
      <div className="flex items-center gap-0.5 p-0.5 text-xs">
        <div role="status" className={cn("flex min-w-0 items-center gap-1.5", PROMPT_STACK_INLAY_SEGMENT_CLASS)}>
          <Icon name="AlertCircle" aria-hidden className="size-3.5 shrink-0 text-destructive" />
          <span className="shrink-0 text-foreground">Teleport did not start</span>
          <span className="min-w-0 truncate text-muted-foreground">This thread stays local.</span>
        </div>
        <BannerActionSlot hideInTiny={false}>
          {pickModel && selected && effort && (
            <PromptBannerActionButton onClick={() => onTeleport({ model: selected.option.value, reasoning: effort })}>Teleport with this model</PromptBannerActionButton>
          )}
          <button type="button" aria-label="Dismiss" className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground" onClick={onDismiss}>
            <Icon name="CircleX" className="size-4" aria-hidden />
          </button>
        </BannerActionSlot>
      </div>
      {message && <p role="alert" className="whitespace-pre-wrap break-words px-3 pb-2 text-xs text-destructive">{message}</p>}
      {pickModel && (
        choices.length ? (
          <div className="flex flex-wrap items-center gap-2 px-3 pb-2 text-xs">
            <span className="text-muted-foreground">Run in Cloud with</span>
            <select aria-label="Cloud model" className="rounded border border-border bg-background px-1.5 py-0.5" value={selected?.option.value} onChange={(event) => setModel(event.target.value)}>
              {choices.map((choice) => <option key={choice.option.value} value={choice.option.value}>{choice.option.label}</option>)}
            </select>
            <select aria-label="Cloud reasoning" className="rounded border border-border bg-background px-1.5 py-0.5" value={effort} onChange={(event) => setLevel(event.target.value)}>
              {levels.map((value) => <option key={value} value={value}>{label(value)}</option>)}
            </select>
            {usedTokens !== null && (
              <span className={tooBig ? "text-destructive" : "text-muted-foreground"}>
                {tooBig ? `This chat (${Math.round(usedTokens / 1000)}K tokens) is too big for this model.` : `This chat uses ${Math.round(usedTokens / 1000)}K tokens.`}
              </span>
            )}
          </div>
        ) : <p className="px-3 pb-2 text-xs text-muted-foreground">Cloud offers no model for this agent yet. Check its login in Settings.</p>
      )}
    </PromptStackCard>
  );
}
