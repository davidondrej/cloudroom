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

/** A centered pill on a hairline divider for a background command: dashed while the agent waits on it, solid where it
 *  ended. Claude starts a turn by itself when one ends, so this separates the reply and says why without looking like
 *  a user message. */
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
  const ruleClassName = cn(
    "min-w-4 flex-1",
    waiting
      ? "h-0 border-t border-dashed border-border/80"
      : "h-px bg-border/80",
  );

  return (
    <div
      role="separator"
      aria-label={`${name} ${statusLabel}`}
      className="my-2.5 flex w-full items-center px-2"
      data-message-column=""
    >
      <span className={ruleClassName} aria-hidden="true" />
      <div
        title={rawName}
        className={cn(
          "inline-flex min-w-0 max-w-[min(85%,30rem)] items-center gap-1.5 rounded-full border bg-background px-3 py-1 text-xs text-muted-foreground",
          waiting
            ? "border-dashed border-foreground/25"
            : failed
              ? "border-destructive/40"
              : "border-border",
        )}
      >
        <Icon
          name="Terminal"
          className={cn("size-3.5 shrink-0", failed && "text-destructive")}
          aria-hidden="true"
        />
        <span className="min-w-0 truncate font-medium text-foreground/85">
          {name}
        </span>
        <span className={cn("shrink-0", failed && "text-destructive")}>
          {statusLabel}
        </span>
        {waiting ? (
          <span className="shrink-0 tabular-nums text-muted-foreground/65 empty:hidden before:mr-1 before:content-['·']">
            <LiveDurationText startedAt={row.startedAt} />
          </span>
        ) : ms > 0 ? (
          <span className="shrink-0 tabular-nums text-muted-foreground/65">
            · {durationToCompactString(ms)}
          </span>
        ) : null}
      </div>
      <span className={ruleClassName} aria-hidden="true" />
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
