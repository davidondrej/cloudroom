import { isBackgroundCommandTaskType } from "@cloudroom/domain";
import type { TimelineWorkflowWorkRow } from "@cloudroom/server-contract";
import { durationToCompactString } from "@cloudroom/thread-view";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { LiveDurationText } from "./LiveDurationText";

const FINISHED_LABEL = {
  pending: "Background command running:",
  completed: "Background command finished:",
  error: "Background command failed:",
  interrupted: "Background command stopped:",
} as const;

/** How long a finished command ran: Cloud reports it, since its start record is gone by then. */
function finishedMs(row: TimelineWorkflowWorkRow): number {
  if (row.usage) return row.usage.durationMs;
  return row.completedAt === null ? 0 : row.completedAt - row.startedAt;
}

/** A background command on the right, where messages to the agent sit: dashed while the agent waits on it, solid where
 *  it ended. Claude starts a turn by itself when one ends, so this says why the agent spoke again. */
export function BackgroundCommandBubble({ row }: { row: TimelineWorkflowWorkRow }) {
  const waiting = row.status === "pending";
  const failed = row.status === "error";
  const ms = waiting ? 0 : finishedMs(row);
  const name = (
    <span className="break-words font-medium text-foreground">
      {row.description.trim() || "a background command"}
    </span>
  );
  // Inline text, so a long name wraps like a sentence on narrow screens.
  return (
    <div className="w-full py-1.5" data-message-column="">
      <p
        className={cn(
          "ml-auto w-fit max-w-[85%] rounded-xl px-4 py-2.5 text-sm leading-relaxed text-muted-foreground",
          waiting
            ? "border border-dashed border-foreground/25"
            : "bg-background shadow-message dark:bg-surface-recessed",
        )}
      >
        <Icon
          name="Terminal"
          className={cn(
            "mr-2 inline size-3.5 align-[-2px]",
            failed && "text-destructive",
          )}
          aria-hidden="true"
        />
        {waiting ? (
          <>
            When {name} finishes, the agent continues{" "}
            <span className="tabular-nums">
              <LiveDurationText startedAt={row.startedAt} />
            </span>
          </>
        ) : (
          <>
            <span className={cn(failed && "text-destructive")}>
              {FINISHED_LABEL[row.status]}
            </span>{" "}
            {name}
            {ms > 0 ? (
              <span className="tabular-nums"> {durationToCompactString(ms)}</span>
            ) : null}
          </>
        )}
      </p>
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
