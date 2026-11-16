import { useId, useState } from "react";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@cloudroom/shared-ui/popover";
import type { ThreadContextWindowUsage } from "@cloudroom/server-contract";
import { useHoverPopover } from "../../ui/hooks/use-hover-popover.js";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  calculateContextWindowUsagePercent,
  estimateContextTurnsLeft,
  formatCompactTokenCount,
  lastTurnContextTokens,
} from "./thread-context-window-usage.js";

import {
  CATEGORY_COLORS,
  ContextWindowReveal,
  ThreadContextWindowDetails,
} from "./ThreadContextWindowDetails.js";

/** The two ways out of a full context. A missing handler hides its button. */
export interface ThreadContextWindowActions {
  onCompact?: (() => void) | undefined;
  onFreshThread?: (() => void) | undefined;
  pending?: "compact" | "fresh" | null;
  /** The agent is mid-turn: a fresh thread waits for it, compaction queues behind it. */
  working?: boolean;
}

interface ThreadContextWindowCardProps {
  usage: ThreadContextWindowUsage;
  note?: string | undefined;
  actions?: ThreadContextWindowActions | undefined;
  className?: string;
}

interface ThreadContextWindowIndicatorProps {
  usage: ThreadContextWindowUsage;
  note?: string | undefined;
  actions?: ThreadContextWindowActions | undefined;
  defaultOpen?: boolean;
}

const DOT_COUNT = 100;

/** Amber from 75%, red from 90%. Below that the meter stays neutral. */
function warningToneClass(usedPercent: number): string | null {
  if (usedPercent >= 90) return "text-destructive";
  if (usedPercent >= 75) return "text-warning-text";
  return null;
}

function turnsLeftLabel(usage: ThreadContextWindowUsage): string {
  if (usage.usedTokens >= usage.modelContextWindow) return "Context is full";
  const turns = estimateContextTurnsLeft(usage);
  if (turns === null) {
    return `${formatCompactTokenCount(usage.modelContextWindow - usage.usedTokens)} left`;
  }
  if (turns < 1) return "less than 1 turn left";
  return `about ${turns} ${turns === 1 ? "turn" : "turns"} left`;
}

function ContextWindowAction({
  icon,
  label,
  pendingLabel,
  pending,
  disabled,
  onClick,
}: {
  icon: "CircleArrowShrink" | "MessageSquarePlus";
  label: string;
  pendingLabel: string;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-9 gap-1.5"
      disabled={disabled || pending}
      aria-busy={pending}
      onClick={onClick}
    >
      <Icon
        name={pending ? "Spinner" : icon}
        className={cn("size-3.5", pending && "animate-spin")}
        aria-hidden
      />
      {pending ? pendingLabel : label}
    </Button>
  );
}

export function ThreadContextWindowCard({
  usage,
  note,
  actions,
  className,
}: ThreadContextWindowCardProps) {
  const details = usage.snapshot?.categories.length
    ? usage.snapshot
    : undefined;
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const detailsId = useId();
  const usedPercent = calculateContextWindowUsagePercent(usage);
  const usedDots = Math.min(Math.max(usedPercent, 0), DOT_COUNT);
  const toneClass = warningToneClass(usedPercent);
  const lastTurnDots = Math.min(
    usedDots,
    Math.round(
      (lastTurnContextTokens(usage) / usage.modelContextWindow) * DOT_COUNT,
    ),
  );
  const detailsOpen = details !== undefined && detailsExpanded;
  const usedCategories = detailsOpen
    ? details.categories.filter((category) => category.kind === "used")
    : [];
  // One dot is 1% of the window: it takes the colour of the category at its middle.
  const categoryColor = (dot: number) => {
    const tokens = ((dot + 0.5) / DOT_COUNT) * usage.modelContextWindow;
    let end = 0;
    const index = usedCategories.findIndex((category) => {
      end += category.tokens;
      return tokens <= end;
    });
    return CATEGORY_COLORS[
      (index === -1 ? usedCategories.length - 1 : index) %
        CATEGORY_COLORS.length
    ];
  };
  const tokensLabel = `${formatCompactTokenCount(usage.usedTokens)} / ${formatCompactTokenCount(usage.modelContextWindow)}`;
  const pending = actions?.pending ?? null;
  const hasActions =
    actions?.onCompact !== undefined || actions?.onFreshThread !== undefined;

  return (
    <div
      className={cn(
        "@container/context-window w-85 rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg",
        className,
      )}
    >
      <div className="flex items-end justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "text-4xl font-semibold leading-none tracking-tight tabular-nums",
              toneClass ?? "text-foreground",
            )}
          >
            {usedPercent}%
          </span>
          <span className="text-xs text-muted-foreground">
            {usage.estimated ? "context used, estimated" : "context used"}
          </span>
        </div>
        {details ? (
          <button
            type="button"
            className="-mr-1 flex cursor-pointer items-center gap-1 rounded-xs px-1 text-xs tabular-nums text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={detailsOpen ? "Hide details" : "Show details"}
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            onClick={() => setDetailsExpanded((value) => !value)}
          >
            {tokensLabel}
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              aria-hidden="true"
              data-icon-root=""
              className={cn(
                "size-3 transition-transform duration-200 ease-out motion-reduce:transition-none",
                detailsOpen && "rotate-180",
              )}
            >
              <path d="m4 6 4 4 4-4" />
            </svg>
          </button>
        ) : (
          <span className="text-xs tabular-nums text-muted-foreground">
            {tokensLabel}
          </span>
        )}
      </div>
      <div
        aria-hidden="true"
        className={cn(
          "mt-4 grid grid-flow-col grid-cols-20 grid-rows-5 gap-1.25",
          toneClass,
        )}
      >
        {Array.from({ length: DOT_COUNT }, (_, dot) => (
          <span
            key={dot}
            className={cn(
              "aspect-square rounded-full",
              dot >= usedDots
                ? "bg-foreground/10"
                : detailsOpen
                  ? null
                  : dot >= usedDots - lastTurnDots
                    ? "bg-foreground"
                    : toneClass
                      ? "bg-current"
                      : "bg-foreground/45",
            )}
            style={
              detailsOpen && dot < usedDots
                ? { backgroundColor: categoryColor(dot) }
                : undefined
            }
          />
        ))}
      </div>
      {details ? (
        <div className="-mx-2">
          <ContextWindowReveal id={detailsId} open={detailsOpen}>
            <ThreadContextWindowDetails
              details={details}
              capacity={usage.modelContextWindow}
            />
          </ContextWindowReveal>
        </div>
      ) : null}
      {detailsOpen ? null : (
        <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            {lastTurnDots > 0 ? (
              <>
                <span
                  aria-hidden="true"
                  className="size-2 rounded-full bg-foreground"
                />
                last turn
              </>
            ) : null}
          </span>
          <span className={cn("tabular-nums", toneClass)}>
            {turnsLeftLabel(usage)}
          </span>
        </div>
      )}
      {usage.compactions ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Compacted {usage.compactions}{" "}
          {usage.compactions === 1 ? "time" : "times"}
        </p>
      ) : null}
      {note ? (
        <p className="mt-2 text-xs text-muted-foreground">{note}</p>
      ) : null}
      {hasActions ? (
        <div className="mt-4 flex gap-2 *:flex-1">
          {actions.onCompact ? (
            <ContextWindowAction
              icon="CircleArrowShrink"
              label="Compact"
              pendingLabel="Compacting…"
              pending={pending === "compact"}
              disabled={pending !== null}
              onClick={actions.onCompact}
            />
          ) : null}
          {actions.onFreshThread ? (
            <ContextWindowAction
              icon="MessageSquarePlus"
              label="Fresh thread"
              pendingLabel="Starting…"
              pending={pending === "fresh"}
              disabled={pending !== null || actions.working === true}
              onClick={actions.onFreshThread}
            />
          ) : null}
        </div>
      ) : null}
      {actions?.onFreshThread && actions.working ? (
        <p className="mt-2.5 text-center text-xs text-muted-foreground">
          Fresh thread waits for this turn to finish.
        </p>
      ) : null}
    </div>
  );
}

export function ThreadContextWindowIndicator({
  usage,
  note,
  actions,
  defaultOpen,
}: ThreadContextWindowIndicatorProps) {
  const {
    open: hoverOpen,
    triggerHoverProps,
    contentHoverProps,
    handleOpenChange,
  } = useHoverPopover({ closeDelayMs: 200 });
  const [pinned, setPinned] = useState(false);
  const open = defaultOpen || hoverOpen || pinned;

  const usedPercent = calculateContextWindowUsagePercent(usage);
  const visualPercent = Math.min(Math.max(usedPercent, 0), 100);

  const radius = 6.5;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - visualPercent / 100);

  const toneClass = warningToneClass(usedPercent) ?? "text-muted-foreground";
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
            "group -m-1 inline-flex h-8 min-w-8 cursor-pointer items-center justify-center gap-1 rounded-full transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
            <span className="text-xs tabular-nums text-muted-foreground opacity-40 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[state=open]:opacity-100 motion-reduce:transition-none">
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
        mobileTitle={usage.estimated ? "Estimated context" : "Context window"}
        className="w-auto border-0 bg-transparent p-0 shadow-none max-md:p-0"
      >
        <ThreadContextWindowCard
          usage={usage}
          note={note}
          actions={actions}
          className="max-md:w-full max-md:rounded-none max-md:border-0 max-md:bg-transparent max-md:px-4 max-md:pt-2 max-md:pb-[max(1rem,env(safe-area-inset-bottom))] max-md:shadow-none"
        />
      </PopoverContent>
    </Popover>
  );
}
