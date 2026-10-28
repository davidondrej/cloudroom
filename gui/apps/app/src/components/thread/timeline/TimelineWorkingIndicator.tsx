import { cn } from "@cloudroom/shared-ui/lib/utils";
import { ExpandableTimelineRow } from "./ExpandableTimelineRow.js";
import { TimelineReasoningDetail } from "./TimelineReasoningDetail.js";
import { TimelineStatusIndicator } from "./TimelineStatusIndicator.js";

const INDICATOR_HEADER_CLASS_NAME = "min-h-7 items-center";

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
    return (
      <div className="mt-4">
        <ExpandableTimelineRow
          reasoningExpansionKey={reasoningId}
          expandable={hasDetails}
          headerClassName={INDICATOR_HEADER_CLASS_NAME}
          title={{
            segments: [
              { text: resolvedLabel, em: false, shimmer, truncate: true },
            ],
            decorations: [],
            tone: "default",
            action: null,
            plain: resolvedLabel,
          }}
          renderBody={() => <TimelineReasoningDetail text={details ?? ""} />}
        />
      </div>
    );
  }

  return (
    <TimelineStatusIndicator
      label={
        <span className={cn(shimmer && "animate-shine")}>{resolvedLabel}</span>
      }
      className={cn("mt-4 flex", INDICATOR_HEADER_CLASS_NAME)}
    />
  );
}
