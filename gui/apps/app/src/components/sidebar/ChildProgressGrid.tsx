import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ThreadListEntry } from "@cloudroom/domain";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { sdk } from "@/lib/sdk";

type Cell = "done" | "running" | "waiting" | "failed";

const CELL_CLASS: Record<Cell, string> = {
  done: "bg-primary",
  running: "animate-pulse bg-primary/35",
  waiting: "bg-foreground/10",
  failed: "bg-destructive",
};

function cellFor(thread: ThreadListEntry): Cell {
  if (thread.status === "error") return "failed";
  if (thread.status === "idle") return "done";
  if (thread.status === "pending") return "waiting";
  return "running";
}

export function useHiddenChildCells(thread: ThreadListEntry): Cell[] | null {
  const busy = thread.status === "starting" || thread.status === "active";
  const { data } = useQuery({
    queryKey: ["hidden-child-threads", thread.id],
    queryFn: ({ signal }) =>
      sdk.threads.list({
        archived: false,
        includeHidden: true,
        parentThreadId: thread.id,
        signal,
      }),
    enabled: busy,
    refetchInterval: busy ? 5_000 : false,
  });
  return useMemo(() => {
    const children = (busy ? (data ?? []) : [])
      .filter((child) => child.visibility === "hidden")
      .sort((a, b) => a.createdAt - b.createdAt);
    return children.length >= 2 ? children.map(cellFor) : null;
  }, [busy, data]);
}

export function ChildProgressGrid({
  cells,
  paddingLeft,
}: {
  cells: Cell[];
  paddingLeft: number;
}) {
  const done = cells.filter((cell) => cell === "done").length;
  return (
    <div
      className="pointer-events-none flex items-center gap-2 pr-2 pb-1.5"
      style={{ paddingLeft }}
      aria-label={`${done} of ${cells.length} agents done`}
    >
      <div className="flex min-w-0 flex-1 gap-[2px]">
        {cells.map((cell, index) => (
          <span
            key={index}
            className={cn(
              "h-1.5 min-w-0 flex-1 rounded-[1.5px]",
              CELL_CLASS[cell],
            )}
          />
        ))}
      </div>
      <span className="text-[11px] text-muted-foreground tabular-nums">
        {done}/{cells.length}
      </span>
    </div>
  );
}
