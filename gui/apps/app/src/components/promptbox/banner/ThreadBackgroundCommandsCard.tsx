import { useRef, useState } from "react";
import { isBackgroundAgentTaskType } from "@cloudroom/domain";
import type { TimelineWorkflowWorkRow } from "@cloudroom/server-contract";
import { useResizeObserver } from "usehooks-ts";
import { AnimatedBody } from "@/components/promptbox/banner/AnimatedBody";
import { PromptStackCardChevron } from "@/components/promptbox/banner/PromptStackCard";
import { LiveDurationText } from "@/components/thread/timeline/LiveDurationText";
import { Icon } from "@cloudroom/shared-ui/icon";
import { useIsCompactViewport } from "@cloudroom/shared-ui/hooks/use-compact-viewport";
import {
  activityIconClass,
  activityMetaClass,
  activityTextClass,
} from "@cloudroom/shared-ui/activity-row-styles";
import { cn } from "@cloudroom/shared-ui/lib/utils";

const BODY_ID = "thread-background-commands-card-body";
const TOGGLE_ID = "thread-background-commands-card-toggle";
const COMPACT_PROMPT_SHELL_MAX_WIDTH_REM = 34;
const DEFAULT_ROOT_FONT_SIZE_PX = 16;
// Borderless, compact row so background work stays subtle above the composer.
const ROW_CLASS =
  "flex min-h-6 w-full min-w-0 items-center gap-1.5 rounded-md px-3 py-0.5 text-xs text-foreground";

function isCompactPromptShellWidth(width: number): boolean {
  const parsedRootFontSize =
    typeof window === "undefined"
      ? Number.NaN
      : Number.parseFloat(
          window.getComputedStyle(document.documentElement).fontSize,
        );
  const rootFontSize = Number.isFinite(parsedRootFontSize)
    ? parsedRootFontSize
    : DEFAULT_ROOT_FONT_SIZE_PX;
  return width <= COMPACT_PROMPT_SHELL_MAX_WIDTH_REM * rootFontSize;
}

interface BackgroundActivityDisplay {
  icon: "Terminal" | "UserRoundPlus";
  label: string;
  runningPrefix: string;
}

function backgroundActivityDisplay(
  row: TimelineWorkflowWorkRow,
): BackgroundActivityDisplay {
  if (isBackgroundAgentTaskType(row.taskType)) {
    return {
      icon: "UserRoundPlus",
      label: "Background agent",
      runningPrefix: "Running background agent:",
    };
  }
  return {
    icon: "Terminal",
    label: "Background command",
    runningPrefix: "Running background command:",
  };
}

function backgroundActivityGroupLabel(
  rows: readonly TimelineWorkflowWorkRow[],
): string {
  const hasAgent = rows.some((row) => isBackgroundAgentTaskType(row.taskType));
  const hasCommand = rows.some(
    (row) => !isBackgroundAgentTaskType(row.taskType),
  );
  if (hasAgent && hasCommand) {
    return "Background activity";
  }
  return hasAgent ? "Background agents" : "Background commands";
}

function backgroundActivityModel(row: TimelineWorkflowWorkRow): string | null {
  return isBackgroundAgentTaskType(row.taskType) ? row.model : null;
}

function backgroundActivityAriaLabel(
  row: TimelineWorkflowWorkRow,
  label = backgroundActivityDisplay(row).label,
): string {
  const model = backgroundActivityModel(row);
  return model
    ? `${label}: ${row.description} · Model ${model}`
    : `${label}: ${row.description}`;
}

function compactBackgroundActivityLabel(
  rows: readonly TimelineWorkflowWorkRow[],
): string {
  const agentCount = rows.filter((row) =>
    isBackgroundAgentTaskType(row.taskType),
  ).length;
  const commandCount = rows.length - agentCount;
  if (commandCount === 0) {
    return `Running ${agentCount} background agent${agentCount === 1 ? "" : "s"}`;
  }
  if (agentCount === 0) {
    return `Running ${commandCount} background command${commandCount === 1 ? "" : "s"}`;
  }
  return `Running ${rows.length} background activities`;
}

function BackgroundActivitySummary({
  row,
  showDuration,
}: {
  row: TimelineWorkflowWorkRow;
  showDuration: boolean;
}) {
  const display = backgroundActivityDisplay(row);
  const model = backgroundActivityModel(row);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1 text-left">
      <span
        className={cn(
          "shrink-0 whitespace-nowrap",
          activityMetaClass("running"),
        )}
      >
        {display.runningPrefix}
      </span>
      <span
        className={cn("min-w-0 truncate", activityTextClass("running"))}
        title={row.description}
      >
        {row.description}
      </span>
      {model ? (
        <span
          className={cn(
            "shrink-0 whitespace-nowrap font-mono text-2xs",
            activityMetaClass("running"),
          )}
          title={`Model: ${model}`}
        >
          {model}
        </span>
      ) : null}
      {showDuration ? (
        <span
          className={cn("shrink-0 tabular-nums", activityMetaClass("running"))}
        >
          <LiveDurationText startedAt={row.startedAt} />
        </span>
      ) : null}
    </span>
  );
}

interface ThreadBackgroundCommandsCardProps {
  commands: TimelineWorkflowWorkRow[];
  isExpanded: boolean;
  onToggle: () => void;
}

export function ThreadBackgroundCommandsCard({
  commands,
  isExpanded,
  onToggle,
}: ThreadBackgroundCommandsCardProps) {
  const isCompactViewport = useIsCompactViewport();
  const cardRef = useRef<HTMLElement>(null!);
  const [isCompactCard, setIsCompactCard] = useState<boolean | null>(null);
  useResizeObserver({
    ref: cardRef,
    box: "border-box",
    onResize: ({ width }) => {
      if (width === undefined) return;
      const nextIsCompact = isCompactPromptShellWidth(width);
      setIsCompactCard((previous) =>
        previous === nextIsCompact ? previous : nextIsCompact,
      );
    },
  });
  const primary = commands[0];
  if (!primary) {
    return null;
  }
  const others = commands.slice(1);
  const hasMore = others.length > 0;
  const useCompactSummary = isCompactCard ?? isCompactViewport;
  const canExpand = hasMore || useCompactSummary;
  const expandedRows = useCompactSummary ? commands : others;
  const compactLabel = compactBackgroundActivityLabel(commands);
  const primaryDisplay = backgroundActivityDisplay(primary);
  const groupLabel = backgroundActivityGroupLabel(commands);

  return (
    <section ref={cardRef} aria-label={groupLabel} className="overflow-hidden">
      <div className="flex items-center">
        {canExpand ? (
          <button
            type="button"
            id={TOGGLE_ID}
            aria-expanded={isExpanded}
            aria-controls={BODY_ID}
            aria-label={
              useCompactSummary
                ? compactLabel
                : backgroundActivityAriaLabel(primary, groupLabel)
            }
            onClick={onToggle}
            className={cn(
              ROW_CLASS,
              "cursor-pointer transition-colors hover:bg-background/60",
            )}
          >
            <Icon
              name={primaryDisplay.icon}
              className={activityIconClass("running", "size-3.5 shrink-0")}
              aria-hidden="true"
            />
            {useCompactSummary ? (
              <span className="min-w-0 flex-1 truncate text-left font-medium">
                {compactLabel}
              </span>
            ) : (
              <>
                <BackgroundActivitySummary row={primary} showDuration={false} />
                <span className={activityMetaClass("running", "shrink-0")}>
                  +{others.length} more
                </span>
              </>
            )}
            <PromptStackCardChevron
              isExpanded={isExpanded}
              className={activityIconClass("running")}
            />
          </button>
        ) : (
          <div
            className={cn(ROW_CLASS, "cursor-default")}
            aria-label={backgroundActivityAriaLabel(primary)}
          >
            <Icon
              name={primaryDisplay.icon}
              className={activityIconClass("running", "size-3.5 shrink-0")}
              aria-hidden="true"
            />
            <BackgroundActivitySummary row={primary} showDuration />
          </div>
        )}
      </div>
      {canExpand ? (
        <AnimatedBody
          id={BODY_ID}
          labelledBy={TOGGLE_ID}
          isExpanded={isExpanded}
          collapsedBorder="none"
        >
          <div className="flex flex-col gap-0.5 py-1">
            {expandedRows.map((row) => {
              const display = backgroundActivityDisplay(row);
              const model = backgroundActivityModel(row);
              return (
                <div
                  key={row.id}
                  className={cn(
                    "flex min-w-0 gap-1.5 px-3 py-0.5 text-xs",
                    useCompactSummary ? "items-start" : "items-center",
                  )}
                >
                  <Icon
                    name={display.icon}
                    className="size-3.5 shrink-0 text-muted-foreground/60"
                    aria-hidden="true"
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1 text-muted-foreground",
                      useCompactSummary
                        ? "whitespace-normal [overflow-wrap:anywhere]"
                        : "truncate",
                    )}
                    title={row.description}
                  >
                    {row.description}
                  </span>
                  {model ? (
                    <span
                      className="shrink-0 whitespace-nowrap font-mono text-2xs text-subtle-foreground"
                      title={`Model: ${model}`}
                    >
                      {model}
                    </span>
                  ) : null}
                  <span className="shrink-0 whitespace-nowrap tabular-nums text-subtle-foreground">
                    {isExpanded ? (
                      <LiveDurationText startedAt={row.startedAt} />
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        </AnimatedBody>
      ) : null}
    </section>
  );
}
