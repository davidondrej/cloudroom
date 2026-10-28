import { useId, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@cloudroom/shared-ui/popover";
import type { ThreadContextWindowUsage } from "@cloudroom/server-contract";
import { useHoverPopover } from "../../ui/hooks/use-hover-popover.js";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  calculateContextWindowUsagePercent,
  formatCompactTokenCount,
} from "./thread-context-window-usage.js";

import {
  ContextWindowReveal,
  ThreadContextWindowDetails,
  ThreadContextWindowSegments,
} from "./ThreadContextWindowDetails.js";

interface ThreadContextWindowCardProps {
  usage: ThreadContextWindowUsage;
  note?: string | undefined;
  expanded?: boolean;
  className?: string;
}

interface ThreadContextWindowIndicatorProps {
  usage: ThreadContextWindowUsage;
  note?: string | undefined;
  defaultOpen?: boolean;
}

const CONTEXT_WINDOW_POPOVER_CLOSE_DELAY_MS = 60;
function ThreadContextWindowHistory({
  history,
  modelContextWindow,
  autoCompactAtTokens,
}: {
  history: readonly number[];
  modelContextWindow: number;
  autoCompactAtTokens: number | null | undefined;
}) {
  const height = (tokens: number) =>
    `${Math.min(Math.max((tokens / modelContextWindow) * 100, 3), 100)}%`;
  return (
    <div aria-hidden="true" className="relative flex h-12 items-end gap-px">
      {autoCompactAtTokens ? (
        <div
          className="absolute inset-x-0 border-t border-dashed border-muted-foreground/50"
          style={{ bottom: height(autoCompactAtTokens) }}
        />
      ) : null}
      {history.map((tokens, index) => (
        <div
          key={index}
          className={cn(
            "flex-1 rounded-[1px]",
            index === history.length - 1
              ? "bg-foreground"
              : "bg-muted-foreground/45",
          )}
          style={{ height: height(tokens) }}
        />
      ))}
    </div>
  );
}

export function ThreadContextWindowCard({
  usage,
  note,
  expanded = false,
  className,
}: ThreadContextWindowCardProps) {
  const details = usage.snapshot?.categories.length
    ? usage.snapshot
    : undefined;
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const detailsId = useId();
  const usedPercent = calculateContextWindowUsagePercent(usage);
  const leftPercent = Math.max(0, 100 - usedPercent);
  const visualPercent = Math.min(Math.max(usedPercent, 0), 100);

  const toneClass =
    usedPercent >= 90
      ? "text-destructive"
      : usedPercent >= 75
        ? "text-warning-text"
        : "text-muted-foreground";

  const usedTokensLabel = formatCompactTokenCount(usage.usedTokens);
  const windowTokensLabel = formatCompactTokenCount(usage.modelContextWindow);
  const titleLabel = usage.estimated ? "Estimated context" : "Context window";
  const history = usage.history ?? [];
  const showHistory = expanded && history.length >= 2 && !detailsExpanded;

  return (
    <div
      className={cn(
        "@container/context-window w-56 rounded-md border bg-popover p-2 text-popover-foreground shadow-md max-md:px-4",
        details &&
          "transition-[width] duration-200 ease-out motion-reduce:transition-none",
        details && detailsExpanded && "w-90",
        className,
      )}
    >
      <div className="flex flex-col gap-2 max-md:gap-3">
        <div className="flex items-baseline justify-between gap-2 text-xs max-md:text-sm">
          <span
            className={cn(
              "text-muted-foreground",
              details && detailsExpanded && "font-medium text-foreground",
            )}
          >
            {titleLabel}
          </span>
          <span className={cn("font-medium tabular-nums", toneClass)}>
            {usedPercent}% used
          </span>
        </div>
        {showHistory ? (
          <ThreadContextWindowHistory
            history={history}
            modelContextWindow={usage.modelContextWindow}
            autoCompactAtTokens={usage.snapshot?.autoCompactAtTokens}
          />
        ) : null}
        <div
          className={cn(
            showHistory && "hidden",
            "relative h-1.5 w-full overflow-hidden rounded-full bg-border transition-[height] duration-200 motion-reduce:transition-none max-md:h-2",
            details && detailsExpanded && "order-2 h-4 max-md:h-5",
          )}
        >
          <div
            className={cn(
              "h-full rounded-full bg-current transition-opacity duration-200 ease-out motion-reduce:transition-none",
              toneClass,
              details && detailsExpanded && "opacity-0",
            )}
            style={{ width: `${visualPercent}%` }}
          />
          {details ? (
            <ThreadContextWindowSegments
              details={details}
              modelContextWindow={usage.modelContextWindow}
              visible={detailsExpanded}
            />
          ) : null}
        </div>
        <div
          className={cn(
            "flex items-baseline justify-between gap-2 text-xs tabular-nums text-muted-foreground max-md:text-sm",
            details && detailsExpanded && "order-1",
          )}
        >
          <span>
            <span
              className={cn(
                details && detailsExpanded && "font-medium text-foreground",
              )}
            >
              {usedTokensLabel}
            </span>{" "}
            / {windowTokensLabel} tokens
          </span>
          <span>
            {showHistory ? `${history.length} turns` : `${leftPercent}% left`}
          </span>
        </div>
        {usage.compactions ? (
          <p className="text-xs text-muted-foreground max-md:text-sm">
            Compacted {usage.compactions}{" "}
            {usage.compactions === 1 ? "time" : "times"}
          </p>
        ) : null}
        {note ? (
          <p className="text-xs text-muted-foreground max-md:text-sm">{note}</p>
        ) : null}
      </div>
      {details ? (
        <>
          <div className="-mx-2 max-md:-mx-4">
            <ContextWindowReveal id={detailsId} open={detailsExpanded}>
              <ThreadContextWindowDetails
                details={details}
                capacity={usage.modelContextWindow}
              />
            </ContextWindowReveal>
          </div>
          <button
            type="button"
            className="ml-auto mt-2 flex cursor-pointer items-center gap-1.5 rounded-xs text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:mt-3 max-md:py-1 max-md:text-sm"
            aria-expanded={detailsExpanded}
            aria-controls={detailsId}
            onClick={() => setDetailsExpanded((value) => !value)}
          >
            {detailsExpanded ? "Hide details" : "Show details"}
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              aria-hidden="true"
              data-icon-root=""
              className={cn(
                "size-3 transition-transform duration-200 ease-out motion-reduce:transition-none",
                detailsExpanded && "rotate-180",
              )}
            >
              <path d="m4 6 4 4 4-4" />
            </svg>
          </button>
        </>
      ) : null}
    </div>
  );
}

export function ThreadContextWindowIndicator({
  usage,
  note,
  defaultOpen,
}: ThreadContextWindowIndicatorProps) {
  const details = usage.snapshot?.categories.length
    ? usage.snapshot
    : undefined;
  const {
    open: hoverOpen,
    triggerHoverProps,
    contentHoverProps,
    handleOpenChange,
  } = useHoverPopover({
    closeDelayMs: details ? 200 : CONTEXT_WINDOW_POPOVER_CLOSE_DELAY_MS,
    hoverableContent: details !== undefined,
  });
  const [pinned, setPinned] = useState(false);
  const open = defaultOpen || hoverOpen || pinned;

  const usedPercent = calculateContextWindowUsagePercent(usage);
  const visualPercent = Math.min(Math.max(usedPercent, 0), 100);

  const radius = 6.5;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - visualPercent / 100);

  const toneClass =
    usedPercent >= 90
      ? "text-destructive"
      : usedPercent >= 75
        ? "text-warning-text"
        : "text-muted-foreground";

  const titleLabel = usage.estimated ? "Estimated context" : "Context window";
  const compactions = usage.compactions ?? 0;

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setPinned(false);
        handleOpenChange(nextOpen);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          {...triggerHoverProps}
          onClick={(event) => {
            event.preventDefault();
            setPinned((value) => !value);
          }}
          className={cn(
            "-m-1 inline-flex h-8 min-w-8 cursor-pointer items-center justify-center gap-1 rounded-full transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            compactions > 0 && "px-2",
          )}
          aria-label={`Context window ${usedPercent}% used${compactions > 0 ? `, compacted ${compactions} times` : ""}`}
        >
          <svg
            viewBox="0 0 16 16"
            className={cn("size-4", toneClass)}
            aria-hidden="true"
          >
            <circle
              cx="8"
              cy="8"
              r={radius}
              fill="none"
              strokeWidth="3"
              className="stroke-border-hairline"
            />
            <circle
              cx="8"
              cy="8"
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              transform="rotate(-90 8 8)"
            />
          </svg>
          {compactions > 0 ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {compactions}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        {...contentHoverProps}
        mobileTitle={titleLabel}
        className="w-auto border-0 bg-transparent p-0 shadow-none max-md:p-0"
      >
        <ThreadContextWindowCard
          usage={usage}
          note={note}
          expanded={pinned}
          className="max-md:w-full max-md:rounded-none max-md:border-0 max-md:bg-transparent max-md:px-4 max-md:pt-2 max-md:pb-[max(1rem,env(safe-area-inset-bottom))] max-md:shadow-none"
        />
      </PopoverContent>
    </Popover>
  );
}
