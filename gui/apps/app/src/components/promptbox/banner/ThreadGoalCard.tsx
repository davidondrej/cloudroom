import type { ThreadTimelineGoal } from "@cloudroom/domain";
import { CollapsibleActiveStackCard } from "@/components/promptbox/banner/CollapsibleActiveStackCard";
import { Icon } from "@cloudroom/shared-ui/icon";

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = Math.round(seconds % 60);
    return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

function formatTokenUsage(goal: ThreadTimelineGoal): string {
  const used = goal.tokensUsed.toLocaleString();
  if (goal.tokenBudget === null) {
    return `${used} tokens`;
  }
  return `${used} / ${goal.tokenBudget.toLocaleString()} tokens`;
}

/** Statuses the user can resume, as in Codex's own UI. */
const RESUMABLE = new Set<ThreadTimelineGoal["status"]>(["paused", "blocked", "usageLimited"]);
const STATUS_LABELS: Partial<Record<ThreadTimelineGoal["status"], string>> = {
  paused: "paused",
  blocked: "blocked",
  usageLimited: "usage limit",
  budgetLimited: "budget reached",
};

interface ThreadGoalCardProps {
  goal: ThreadTimelineGoal | null;
  isClearPending?: boolean;
  isStatusPending?: boolean;
  isExpanded: boolean;
  onClearGoal?: () => void;
  onSetGoalStatus?: (status: "active" | "paused") => void;
  onToggle: () => void;
}

const BODY_ID = "thread-goal-card-body";
const TOGGLE_ID = "thread-goal-card-toggle";

export function ThreadGoalCard({
  goal,
  isClearPending = false,
  isStatusPending = false,
  isExpanded,
  onClearGoal,
  onSetGoalStatus,
  onToggle,
}: ThreadGoalCardProps) {
  if (!goal || goal.status === "complete") {
    return null;
  }
  const objective = goal.objective.trim();
  const statusLabel = STATUS_LABELS[goal.status];
  const next = goal.status === "active" ? "paused" : RESUMABLE.has(goal.status) ? "active" : null;
  return (
    <CollapsibleActiveStackCard
      cardAriaLabel="Goal"
      controlsAriaLabel="Goal controls"
      toggleId={TOGGLE_ID}
      bodyId={BODY_ID}
      toggleAriaLabel="Goal"
      iconName="Target"
      title={statusLabel ? `Goal · ${statusLabel}` : "Goal"}
      isExpanded={isExpanded}
      onToggle={onToggle}
      action={
        onSetGoalStatus && next
          ? {
              ariaLabel: next === "paused" ? "Pause Goal" : "Resume Goal",
              iconName: next === "paused" ? "Pause" : "Play",
              isPending: isStatusPending,
              onClick: () => onSetGoalStatus(next),
            }
          : null
      }
      dismiss={
        onClearGoal
          ? {
              ariaLabel: "Clear Goal",
              isPending: isClearPending,
              onDismiss: onClearGoal,
            }
          : null
      }
    >
      <div className="space-y-2 px-3 pb-2.5 pt-2">
        <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/90">
          {objective.length > 0 ? objective : "No goal objective."}
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Icon name="Zap" className="size-3.5 shrink-0" aria-hidden="true" />
            {formatTokenUsage(goal)}
          </span>
          <span className="inline-flex items-center gap-1.5 tabular-nums">
            <Icon
              name="Clock"
              className="size-3.5 shrink-0"
              aria-hidden="true"
            />
            {formatDuration(goal.timeUsedSeconds)}
          </span>
        </div>
      </div>
    </CollapsibleActiveStackCard>
  );
}
