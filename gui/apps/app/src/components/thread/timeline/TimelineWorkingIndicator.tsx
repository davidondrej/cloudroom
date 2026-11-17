import type { CSSProperties } from "react";
import type { TimelineTitle } from "@cloudroom/thread-view";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { ExpandableTimelineRow } from "./ExpandableTimelineRow.js";
import { TimelineReasoningDetail } from "./TimelineReasoningDetail.js";
import { TimelineStatusIndicator } from "./TimelineStatusIndicator.js";
import { TimelineTitleView } from "./TimelineTitleView.js";

const INDICATOR_HEADER_CLASS_NAME = "min-h-7 items-center";

/** Row, column and ring of each cell; `.working-grid` in theme.css times the wave from them. */
const WORKING_GRID_CELLS = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const column = index % 3;
  const distance = Math.abs(row - 1) + Math.abs(column - 1);
  return {
    "--r": row,
    "--c": column,
    "--k": distance === 2 ? 1.7 : distance,
  } as CSSProperties;
});

function WorkingGrid() {
  return (
    <span className="working-grid">
      {WORKING_GRID_CELLS.map((style, index) => (
        <i key={index} style={style} />
      ))}
    </span>
  );
}

interface TimelineWorkingIndicatorProps {
  label?: string;
  isThinking?: boolean;
  details?: string;
  reasoningId?: string;
  shimmer?: boolean;
}

export function TimelineWorkingIndicator({
  label,
  isThinking = false,
  details,
  reasoningId,
  shimmer = true,
}: TimelineWorkingIndicatorProps) {
  const resolvedLabel = label ?? (isThinking ? "Thinking…" : "Working...");
  const hasDetails = (details?.trim().length ?? 0) > 0;

  if (isThinking || hasDetails) {
    const title: TimelineTitle = {
      segments: [{ text: resolvedLabel, em: false, shimmer, truncate: true }],
      decorations: [],
      tone: "default",
      action: null,
      plain: resolvedLabel,
    };
    return (
      <div className="mt-4">
        <ExpandableTimelineRow
          reasoningExpansionKey={reasoningId}
          expandable={hasDetails}
          headerClassName={INDICATOR_HEADER_CLASS_NAME}
          title={title}
          titleContent={
            shimmer ? (
              <>
                <WorkingGrid />
                <TimelineTitleView title={title} />
              </>
            ) : undefined
          }
          renderBody={() => <TimelineReasoningDetail text={details ?? ""} />}
        />
      </div>
    );
  }

  return (
    <TimelineStatusIndicator
      label={
        shimmer ? (
          <span className="flex items-center gap-1.5">
            <WorkingGrid />
            <span className="animate-shine">{resolvedLabel}</span>
          </span>
        ) : (
          resolvedLabel
        )
      }
      className={cn("mt-4 flex", INDICATOR_HEADER_CLASS_NAME)}
    />
  );
}
