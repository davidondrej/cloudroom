import { useState } from "react";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { MarkdownPreview } from "@/components/ui/markdown-preview.js";

// The header a loop puts on each prompt it sends: Local (gui/plugins/automations/src/run.ts; older ones have no
// name) or Cloud (web/lib/automations.ts).
const HEADER =
  /^\[(?:room-cli automation due:([^\s\]"]+)(?: "(.+?)")?|Cloudroom automation "(.+?)" due: ?([^\s\]]+))\]\s*/;

/** The loop that sent this message, or null when a person wrote it. */
export function loopRun(text: string) {
  const match = HEADER.exec(text);
  if (match === null) return null;
  const body = text.slice(match[0].length).trim();
  const name = match[2] ?? match[3] ?? body.split("\n", 1)[0]!.slice(0, 80);
  return {
    id: match[1] ?? match[4]!,
    cloud: match[1] === undefined,
    name,
    body,
  };
}

/** A loop's prompt as a centered "Loop run" divider, so it doesn't look like the user wrote it. Click shows what it
 *  sent. */
export function LoopRunMarker({
  run,
  createdAt,
}: {
  run: NonNullable<ReturnType<typeof loopRun>>;
  createdAt: number;
}) {
  const [open, setOpen] = useState(false);
  const date = new Date(createdAt);
  const time = date.toLocaleString(undefined, {
    ...(date.toDateString() === new Date().toDateString()
      ? {}
      : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
  const rule = "h-px min-w-4 flex-1 from-transparent to-timeline-accent/45";

  return (
    <div className="my-3 w-full px-2" data-message-column="">
      <button
        type="button"
        aria-expanded={open}
        title={open ? "Hide what the loop sent" : "Show what the loop sent"}
        onClick={() => setOpen(!open)}
        className="group flex w-full items-center gap-3 text-xs text-timeline-accent"
      >
        <span className={cn(rule, "bg-gradient-to-r")} aria-hidden="true" />
        <span className="inline-flex min-w-0 max-w-[min(85%,32rem)] items-center gap-1.5">
          <Icon
            name="Repeat"
            className="size-3.5 shrink-0"
            aria-hidden="true"
          />
          <span className="shrink-0 font-semibold uppercase tracking-[0.08em]">
            Loop run
          </span>
          <span className="shrink-0 opacity-50">·</span>
          <span className="min-w-0 truncate font-medium group-hover:underline">
            {run.name}
          </span>
          <span className="shrink-0 tabular-nums opacity-60">· {time}</span>
          <Icon
            name="ChevronDown"
            className={cn(
              "size-3 shrink-0 opacity-0 transition group-hover:opacity-70",
              open && "rotate-180 opacity-70",
            )}
            aria-hidden="true"
          />
        </span>
        <span className={cn(rule, "bg-gradient-to-l")} aria-hidden="true" />
      </button>
      {open ? (
        <div className="mx-auto mt-2 w-full max-w-[min(100%,40rem)] rounded-xl bg-surface-recessed px-4 py-3 text-sm text-muted-foreground">
          <MarkdownPreview content={run.body} />
          <div className="mt-3 border-t border-border/60 pt-2 text-xs text-muted-foreground/70">
            {run.cloud ? "Cloud" : "Local"} loop ·{" "}
            <span className="font-mono">{run.id}</span> · sent {time}
          </div>
        </div>
      ) : null}
    </div>
  );
}
