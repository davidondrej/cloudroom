import { isBackgroundCommandTaskType } from "@cloudroom/domain";
import type { TimelineWorkflowWorkRow } from "@cloudroom/server-contract";
import { durationToCompactString } from "@cloudroom/thread-view";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { LiveDurationText } from "./LiveDurationText";

const STATUS_LABEL = {
  pending: "running",
  completed: "finished",
  error: "failed",
  interrupted: "stopped",
} as const;

/** How long a finished command ran: Cloud reports it, since its start record is gone by then. */
function finishedMs(row: TimelineWorkflowWorkRow): number {
  if (row.usage) return row.usage.durationMs;
  return row.completedAt === null ? 0 : row.completedAt - row.startedAt;
}

/** Quiet centered hairline divider for a background command: dashed while the agent waits on it, edge-fading solid
 *  where it ended. Claude starts a turn by itself when one ends, so this separates the reply and says why without
 *  looking like a user message. */
export function BackgroundCommandBubble({
  row,
}: {
  row: TimelineWorkflowWorkRow;
}) {
  const waiting = row.status === "pending";
  const failed = row.status === "error";
  const ms = waiting ? 0 : finishedMs(row);
  const rawName = row.description.trim() || "Background command";
  const name = rawName.replace(/\s+/g, " ");
  const statusLabel = STATUS_LABEL[row.status];
  const leftRuleClassName = cn(
    "min-w-6 flex-1",
    waiting
      ? "h-0 border-t border-dashed border-border/50"
      : "h-px bg-gradient-to-r from-transparent to-border/45",
  );
  const rightRuleClassName = cn(
    "min-w-6 flex-1",
    waiting
      ? "h-0 border-t border-dashed border-border/50"
      : "h-px bg-gradient-to-l from-transparent to-border/45",
  );

  return (
    <div
      role="separator"
      aria-label={`${name} ${statusLabel}`}
      className="my-1.5 flex w-full items-center gap-2.5 px-2"
      data-message-column=""
    >
      <span className={leftRuleClassName} aria-hidden="true" />
      <div
        title={rawName}
        className="inline-flex min-w-0 max-w-[min(80%,28rem)] items-center gap-1.5 text-[11px] text-muted-foreground/65"
      >
        <Icon
          name="Terminal"
          className={cn(
            "size-3 shrink-0 opacity-60",
            failed && "text-destructive opacity-100",
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 truncate text-muted-foreground/90">
          {name}
        </span>
        <span
          className={cn(
            "shrink-0 text-muted-foreground/55",
            failed && "text-destructive",
          )}
        >
          {statusLabel}
        </span>
        {waiting ? (
          <span className="shrink-0 tabular-nums text-muted-foreground/45 empty:hidden before:mr-1 before:content-['·']">
            <LiveDurationText startedAt={row.startedAt} />
          </span>
        ) : ms > 0 ? (
          <span className="shrink-0 tabular-nums text-muted-foreground/45">
            · {durationToCompactString(ms)}
          </span>
        ) : null}
      </div>
      <span className={rightRuleClassName} aria-hidden="true" />
    </div>
  );
}

/** The background commands the agent is waiting on, last in the chat. */
export function BackgroundCommandBubbles({
  rows,
}: {
  rows: readonly TimelineWorkflowWorkRow[];
}) {
  return rows
    .filter((row) => isBackgroundCommandTaskType(row.taskType))
    .map((row) => <BackgroundCommandBubble key={row.id} row={row} />);
}
