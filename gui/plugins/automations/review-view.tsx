import { Fragment, type ReactNode } from "react";
import type {
  ReviewItem,
  ReviewItemStatus,
  ReviewResponse,
} from "./src/rpc-types.js";
import { Button } from "@cloudroom/shared-ui/button";
import { DelayedLoading } from "@cloudroom/shared-ui/delayed-loading";
import { Icon } from "@cloudroom/shared-ui/icon";
import { ResourceListState } from "@cloudroom/shared-ui/resource-list";
import { cn } from "@cloudroom/shared-ui/lib/utils";

export type ReviewLayout = "list" | "board";
export type ReviewFilter = "to-review" | "all";

const STATUS: Record<
  ReviewItemStatus,
  { label: string; dot: string; text: string }
> = {
  "needs-you": {
    label: "Needs you",
    dot: "bg-warning",
    text: "text-warning-text",
  },
  running: {
    label: "Running",
    dot: "animate-pulse bg-primary",
    text: "text-primary-text",
  },
  done: { label: "Done", dot: "bg-success", text: "text-success" },
  failed: {
    label: "Failed",
    dot: "bg-destructive",
    text: "text-destructive-text",
  },
};

const BOARD_COLUMNS: readonly ReviewItemStatus[] = [
  "needs-you",
  "running",
  "done",
  "failed",
];

const DAY_MS = 24 * 60 * 60_000;
export const OFFSCREEN_ROW_CLASSES =
  "[content-visibility:auto] [contain-intrinsic-size:auto_96px]";

export function reviewableItems(items: readonly ReviewItem[]): ReviewItem[] {
  return items.filter(
    (item) => item.reviewedAt === null && item.status !== "running",
  );
}

function visibleItems(
  items: readonly ReviewItem[],
  filter: ReviewFilter,
): readonly ReviewItem[] {
  return filter === "all"
    ? items
    : items.filter((item) => item.reviewedAt === null);
}

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dayLabel(at: number, now: number): string {
  const day = new Date(at).setHours(0, 0, 0, 0);
  const today = new Date(now).setHours(0, 0, 0, 0);
  if (day === today) return "Today";
  if (day === today - DAY_MS) return "Yesterday";
  return new Date(at).toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function groupByDay(
  items: readonly ReviewItem[],
  now: number,
): { label: string; items: ReviewItem[] }[] {
  const groups: { label: string; items: ReviewItem[] }[] = [];
  for (const item of items) {
    const label = dayLabel(item.at, now);
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

function StatusDot({ status }: { status: ReviewItemStatus }) {
  return (
    <span
      role="img"
      aria-label={STATUS[status].label}
      className={cn(
        "size-[9px] shrink-0 rounded-full ring-4 ring-background",
        STATUS[status].dot,
      )}
    />
  );
}

function LoopLabel({ item }: { item: ReviewItem }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <Icon
        name={item.loop.cloud ? "Cloud" : "Repeat"}
        className={cn(
          "size-3.5 shrink-0",
          item.loop.cloud && "text-primary-text",
        )}
        aria-hidden
      />
      <span className="min-w-0 truncate font-medium text-foreground/80">
        {item.loop.name}
      </span>
      <span aria-hidden className="text-muted-foreground/40">
        ·
      </span>
      <span className={cn("shrink-0", STATUS[item.status].text)}>
        {STATUS[item.status].label}
      </span>
    </span>
  );
}

function ReviewedButton({
  item,
  onMark,
}: {
  item: ReviewItem;
  onMark: (itemIds: string[], reviewed: boolean) => void;
}) {
  const reviewed = item.reviewedAt !== null;
  return (
    <Button
      type="button"
      size="sm"
      variant={reviewed ? "secondary" : "outline"}
      aria-pressed={reviewed}
      aria-label={
        reviewed ? `Unmark ${item.title}` : `Mark ${item.title} reviewed`
      }
      className={cn("h-7 shrink-0 gap-1 px-2", reviewed && "text-success")}
      onClick={(event) => {
        event.stopPropagation();
        onMark([item.id], !reviewed);
      }}
    >
      <Icon name="Check" className="size-3.5" aria-hidden />
      {reviewed ? "Reviewed" : "Looks good"}
    </Button>
  );
}

function openable(item: ReviewItem): boolean {
  return item.threadId !== null;
}

function ReviewTimelineRow({
  item,
  onOpenThread,
  onMark,
}: {
  item: ReviewItem;
  onOpenThread: (threadId: string) => void;
  onMark: (itemIds: string[], reviewed: boolean) => void;
}) {
  const open = () => {
    if (item.threadId !== null) onOpenThread(item.threadId);
  };
  return (
    <li
      className={cn(
        "group relative grid grid-cols-[4.5rem_1.5rem_minmax(0,1fr)_auto] items-start gap-x-1 rounded-sm py-2.5 pr-2",
        OFFSCREEN_ROW_CLASSES,
        openable(item) && "cursor-pointer hover:bg-state-hover",
        item.reviewedAt !== null && "opacity-55",
      )}
      onClick={open}
    >
      <time
        dateTime={new Date(item.at).toISOString()}
        className="whitespace-nowrap pt-px text-right font-mono text-xs tabular-nums text-muted-foreground"
      >
        {timeLabel(item.at)}
      </time>
      <span className="flex justify-center pt-1">
        <StatusDot status={item.status} />
      </span>
      <div className="min-w-0">
        <LoopLabel item={item} />
        {openable(item) ? (
          <button
            type="button"
            className="mt-1 block max-w-full truncate text-left text-sm font-medium text-foreground focus-visible:outline-none focus-visible:underline"
            onClick={(event) => {
              event.stopPropagation();
              open();
            }}
          >
            {item.title}
          </button>
        ) : (
          <div className="mt-1 truncate text-sm font-medium text-foreground">
            {item.title}
          </div>
        )}
        <p
          className={cn(
            "mt-0.5 line-clamp-2 whitespace-pre-line text-xs leading-relaxed",
            item.report === null
              ? "italic text-subtle-foreground"
              : "text-muted-foreground",
            item.threadId === null && "font-mono",
          )}
        >
          {item.report ?? "No summary yet."}
        </p>
      </div>
      <span className="flex items-center pt-0.5">
        {item.status === "running" ? null : (
          <ReviewedButton item={item} onMark={onMark} />
        )}
      </span>
    </li>
  );
}

function ReviewTimeline({
  items,
  now,
  onOpenThread,
  onMark,
}: {
  items: readonly ReviewItem[];
  now: number;
  onOpenThread: (threadId: string) => void;
  onMark: (itemIds: string[], reviewed: boolean) => void;
}) {
  return (
    <div className="space-y-5 pb-4">
      {groupByDay(items, now).map((group) => (
        <section key={group.label} aria-label={group.label}>
          <div className="pb-1 pl-[6.5rem] text-2xs font-semibold uppercase tracking-wider text-muted-foreground/70">
            {group.label} · {group.items.length}
          </div>
          <ol className="relative before:absolute before:bottom-3 before:left-[5.5rem] before:top-3 before:w-px before:bg-foreground/10">
            {group.items.map((item) => (
              <ReviewTimelineRow
                key={item.id}
                item={item}
                onOpenThread={onOpenThread}
                onMark={onMark}
              />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function ReviewCard({
  item,
  now,
  onOpenThread,
  onMark,
}: {
  item: ReviewItem;
  now: number;
  onOpenThread: (threadId: string) => void;
  onMark: (itemIds: string[], reviewed: boolean) => void;
}) {
  const day = dayLabel(item.at, now);
  return (
    <li
      className={cn(
        "rounded-md border border-border bg-background p-3",
        OFFSCREEN_ROW_CLASSES,
        openable(item) && "cursor-pointer hover:border-foreground/25",
        item.reviewedAt !== null && "opacity-55",
      )}
      onClick={() => {
        if (item.threadId !== null) onOpenThread(item.threadId);
      }}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="shrink-0 font-mono tabular-nums">
          {day === "Today"
            ? timeLabel(item.at)
            : `${day} ${timeLabel(item.at)}`}
        </span>
        <span className="ml-auto flex min-w-0 items-center gap-1">
          <Icon
            name={item.loop.cloud ? "Cloud" : "Repeat"}
            className={cn(
              "size-3 shrink-0",
              item.loop.cloud && "text-primary-text",
            )}
            aria-hidden
          />
          <span className="truncate">{item.loop.name}</span>
        </span>
      </div>
      <div className="mt-1.5 line-clamp-2 text-sm font-medium leading-snug text-foreground">
        {item.title}
      </div>
      {item.report !== null ? (
        <p
          className={cn(
            "mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground",
            item.threadId === null && "font-mono",
          )}
        >
          {item.report}
        </p>
      ) : null}
      {item.status === "running" ? null : (
        <div className="mt-2.5 flex justify-end">
          <ReviewedButton item={item} onMark={onMark} />
        </div>
      )}
    </li>
  );
}

function ReviewBoard({
  items,
  now,
  onOpenThread,
  onMark,
}: {
  items: readonly ReviewItem[];
  now: number;
  onOpenThread: (threadId: string) => void;
  onMark: (itemIds: string[], reviewed: boolean) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 pb-4 sm:grid-cols-2 xl:grid-cols-4">
      {BOARD_COLUMNS.map((status) => {
        const column = items.filter((item) => item.status === status);
        return (
          <section
            key={status}
            aria-label={STATUS[status].label}
            className="flex min-w-0 flex-col rounded-lg bg-surface-recessed/55 p-2"
          >
            <div className="flex items-center gap-2 px-1 pb-2 pt-0.5">
              <StatusDot status={status} />
              <span className="text-xs font-semibold text-foreground">
                {STATUS[status].label}
              </span>
              <span className="text-xs text-muted-foreground">
                {column.length}
              </span>
            </div>
            {column.length === 0 ? (
              <div className="px-1 pb-2 text-xs text-subtle-foreground">
                Nothing here.
              </div>
            ) : (
              <ol className="space-y-2">
                {column.map((item) => (
                  <ReviewCard
                    key={item.id}
                    item={item}
                    now={now}
                    onOpenThread={onOpenThread}
                    onMark={onMark}
                  />
                ))}
              </ol>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function LoopReviewView({
  review,
  error,
  layout,
  filter,
  now,
  onRetry,
  onOpenThread,
  onMark,
}: {
  review: ReviewResponse | null;
  error: string | null;
  layout: ReviewLayout;
  filter: ReviewFilter;
  now: number;
  onRetry: () => void;
  onOpenThread: (threadId: string) => void;
  onMark: (itemIds: string[], reviewed: boolean) => void;
}) {
  let body: ReactNode;
  if (error !== null) {
    body = (
      <ResourceListState
        state="error"
        message="Couldn't load the review."
        onRetry={onRetry}
      />
    );
  } else if (review === null) {
    body = (
      <DelayedLoading>
        <ResourceListState state="loading" message="Loading review" />
      </DelayedLoading>
    );
  } else {
    const items = visibleItems(review.items, filter);
    body =
      items.length === 0 ? (
        <ResourceListState
          state="empty"
          message={
            review.items.length === 0
              ? "Nothing yet. What your loops do on their own shows up here."
              : "All caught up. Every loop result is reviewed."
          }
        />
      ) : layout === "board" ? (
        <ReviewBoard
          items={items}
          now={now}
          onOpenThread={onOpenThread}
          onMark={onMark}
        />
      ) : (
        <ReviewTimeline
          items={items}
          now={now}
          onOpenThread={onOpenThread}
          onMark={onMark}
        />
      );
  }
  return <Fragment>{body}</Fragment>;
}

export function ReviewToolbar({
  layout,
  filter,
  markable,
  onLayoutChange,
  onFilterChange,
  onMarkAll,
}: {
  layout: ReviewLayout;
  filter: ReviewFilter;
  markable: number;
  onLayoutChange: (layout: ReviewLayout) => void;
  onFilterChange: (filter: ReviewFilter) => void;
  onMarkAll: () => void;
}) {
  const segment = (active: boolean) =>
    cn(
      "h-7 cursor-pointer rounded-sm px-2 text-xs transition-colors",
      active
        ? "bg-background text-foreground shadow-sm"
        : "text-muted-foreground hover:text-foreground",
    );
  return (
    <>
      <div
        role="group"
        aria-label="Show"
        className="flex items-center gap-0.5 rounded-md bg-muted/50 p-0.5"
      >
        <button
          type="button"
          aria-pressed={filter === "to-review"}
          className={segment(filter === "to-review")}
          onClick={() => onFilterChange("to-review")}
        >
          To review
        </button>
        <button
          type="button"
          aria-pressed={filter === "all"}
          className={segment(filter === "all")}
          onClick={() => onFilterChange("all")}
        >
          All
        </button>
      </div>
      <div
        role="group"
        aria-label="Layout"
        className="flex items-center gap-0.5 rounded-md bg-muted/50 p-0.5"
      >
        <button
          type="button"
          aria-pressed={layout === "list"}
          aria-label="List"
          title="List"
          className={segment(layout === "list")}
          onClick={() => onLayoutChange("list")}
        >
          <Icon name="ListView" className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-pressed={layout === "board"}
          aria-label="Board"
          title="Board"
          className={segment(layout === "board")}
          onClick={() => onLayoutChange("board")}
        >
          <Icon name="Columns2" className="size-3.5" aria-hidden />
        </button>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-8 gap-1.5 px-2.5"
        disabled={markable === 0}
        onClick={onMarkAll}
      >
        <Icon name="Check" className="size-3.5" aria-hidden />
        Mark all reviewed
      </Button>
    </>
  );
}
