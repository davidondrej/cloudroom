import { useEffect, useMemo, useRef, useState } from "react";
import type { TimelineRow } from "@cloudroom/server-contract";
import { splitMessageContextSegments } from "@cloudroom/client-core";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { loopRun } from "@/components/thread/timeline/LoopRunMarker";
import {
  getTopVisibleTimelineRow,
  useBottomAnchoredScroll,
} from "@/components/ui/bottom-anchored-scroll-body.js";

interface Prompt {
  id: string;
  seq: number;
  label: string;
}

const SHOW_AFTER_UP_PX = 24;
const HIDE_AFTER_DOWN_PX = 4;
const NOISE_PX = 2;
const BOTTOM_PX = 4;
const MOUNT_WAIT_FRAMES = 10;

/** Prompts the user typed (not system, agent, or loop messages), in timeline order. */
function buildPrompts(rows: readonly TimelineRow[]): Prompt[] {
  const prompts: Prompt[] = [];
  for (const row of rows) {
    if (
      row.kind !== "conversation" ||
      row.role !== "user" ||
      row.initiator !== "user" ||
      loopRun(row.text) !== null
    ) {
      continue;
    }
    prompts.push({
      id: row.id,
      seq: row.sourceSeqStart,
      label: promptLabel(row.text),
    });
  }
  return prompts;
}

/** First line of the typed text, without "Add to chat" context blocks. */
function promptLabel(text: string): string {
  for (const segment of splitMessageContextSegments(text)) {
    if (segment.kind !== "text") continue;
    const line = segment.text.split("\n").find((part) => part.trim());
    if (line) return line.trim();
  }
  return "Attachment";
}

/** The last prompt at or before a timeline position. */
function promptAtOrBefore(prompts: readonly Prompt[], seq: number) {
  let low = 0;
  let high = prompts.length - 1;
  let found: Prompt | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const prompt = prompts[mid]!;
    if (prompt.seq <= seq) {
      found = prompt;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

function findRow(scroll: HTMLElement, id: string): HTMLElement | null {
  const value = id.replace(/["\\]/g, "\\$&");
  return scroll.querySelector(`[data-timeline-row-id="${value}"]`);
}

/** The prompt behind the top visible row, if that prompt is scrolled out of view. */
function findHiddenPrompt(
  scroll: HTMLElement,
  topRow: HTMLElement,
  prompts: readonly Prompt[],
) {
  const seq = Number(topRow.dataset.timelineRowSeq);
  const prompt = Number.isFinite(seq) ? promptAtOrBefore(prompts, seq) : null;
  if (!prompt) return null;
  // Windowing unmounts far rows; an unmounted earlier prompt is above the viewport.
  const row = findRow(scroll, prompt.id);
  const bubble = row?.querySelector("[data-user-message-bubble]") ?? row;
  const scrollTop = scroll.getBoundingClientRect().top;
  return bubble && bubble.getBoundingClientRect().bottom > scrollTop
    ? null
    : prompt;
}

function isRealized(row: HTMLElement | null): row is HTMLElement {
  return row !== null && row.dataset.timelineWindowedRealized !== "false";
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/** Resolves once the element stops scrolling (no `scrollend` in older Safari). */
function waitForScrollIdle(element: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    let idle = window.setTimeout(done, 150);
    const max = window.setTimeout(done, 1500);
    function onScroll() {
      window.clearTimeout(idle);
      idle = window.setTimeout(done, 150);
    }
    function done() {
      window.clearTimeout(idle);
      window.clearTimeout(max);
      element.removeEventListener("scroll", onScroll);
      resolve();
    }
    element.addEventListener("scroll", onScroll, { passive: true });
  });
}

function flash(element: Element) {
  element.animate?.(
    [
      {
        outlineStyle: "solid",
        outlineWidth: "2px",
        outlineColor: "color-mix(in oklab, var(--primary) 70%, transparent)",
      },
      {
        outlineStyle: "solid",
        outlineWidth: "2px",
        outlineColor: "transparent",
      },
    ],
    { duration: 1200, easing: "ease-out" },
  );
}

// Once the user scrolls up, shows the prompt behind the reply they are
// reading, at the top right of the message column. Click to jump to it.
export function ScrollToPromptButton({
  timelineRows,
  onNavigateToRow,
}: {
  timelineRows: readonly TimelineRow[];
  onNavigateToRow?: (rowId: string) => void;
}) {
  const bottomAnchor = useBottomAnchoredScroll();
  const getScrollElement = bottomAnchor?.getScrollElement;
  const prompts = useMemo(() => buildPrompts(timelineRows), [timelineRows]);
  const promptsRef = useRef(prompts);
  useEffect(() => {
    promptsRef.current = prompts;
  }, [prompts]);
  const [shown, setShown] = useState<Prompt | null>(null);
  const [visible, setVisible] = useState(false);
  // Scroll tracking shared by the listener and the click handler.
  const trackRef = useRef({
    up: false,
    upPx: 0,
    jumping: false,
    top: 0,
    row: null as HTMLElement | null,
    rowTop: 0,
  });

  useEffect(() => {
    const scroll = getScrollElement?.();
    if (!scroll) return;
    const track = trackRef.current;
    track.top = scroll.scrollTop;
    track.row = null;
    const onScroll = () => {
      const areaTop = scroll.getBoundingClientRect().top;
      const row = getTopVisibleTimelineRow(scroll);
      const rowTop = row ? row.getBoundingClientRect().top - areaTop : 0;
      // Windowing and scroll anchoring shift scrollTop without moving the
      // content, so measure how far the last top row moved on screen instead.
      const ref = track.row?.isConnected ? track.row : null;
      const dy = ref
        ? track.rowTop - (ref.getBoundingClientRect().top - areaTop)
        : scroll.scrollTop - track.top;
      track.top = scroll.scrollTop;
      track.row = row;
      track.rowTop = rowTop;
      if (track.jumping) return;
      const atBottom =
        scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <=
        BOTTOM_PX;
      if (atBottom || dy >= HIDE_AFTER_DOWN_PX) {
        track.up = false;
        track.upPx = 0;
      } else if (dy >= NOISE_PX) {
        track.upPx = 0;
      } else if (dy <= -NOISE_PX) {
        track.upPx -= dy;
        if (track.upPx >= SHOW_AFTER_UP_PX) track.up = true;
      }
      const prompt =
        track.up && row
          ? findHiddenPrompt(scroll, row, promptsRef.current)
          : null;
      if (prompt) {
        setShown((current) => (current?.id === prompt.id ? current : prompt));
      }
      setVisible(prompt !== null);
    };
    scroll.addEventListener("scroll", onScroll, { passive: true });
    return () => scroll.removeEventListener("scroll", onScroll);
  }, [getScrollElement]);

  if (!bottomAnchor || prompts.length === 0) return null;

  const jump = async () => {
    const scroll = getScrollElement?.();
    if (!scroll || !shown) return;
    const track = trackRef.current;
    track.jumping = true;
    track.up = false;
    track.upPx = 0;
    setVisible(false);
    try {
      onNavigateToRow?.(shown.id);
      // Windowing mounts and realizes the row a few frames after navigation.
      let row = findRow(scroll, shown.id);
      for (let i = 0; i < MOUNT_WAIT_FRAMES && !isRealized(row); i++) {
        await nextFrame();
        row = findRow(scroll, shown.id);
      }
      if (!row) return;
      const reduceMotion =
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ??
        false;
      bottomAnchor.scrollElementIntoView({
        element: row,
        options: { block: "start", behavior: reduceMotion ? "auto" : "smooth" },
      });
      await waitForScrollIdle(scroll);
      // Rows above may have changed height while windowing realized them.
      row = findRow(scroll, shown.id) ?? row;
      const offset =
        row.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      if (Math.abs(offset) > 2) scroll.scrollTop += offset;
      flash(row.querySelector("[data-user-message-bubble]") ?? row);
    } finally {
      track.top = scroll.scrollTop;
      track.row = null;
      track.jumping = false;
    }
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0">
      {/* Same width and padding as PageShell's message column. */}
      <div className="mx-auto flex w-full max-w-[760px] justify-end px-4 pt-3">
        <button
          type="button"
          onClick={() => void jump()}
          tabIndex={visible ? 0 : -1}
          aria-hidden={!visible}
          aria-label={
            shown ? `Scroll to your message: ${shown.label}` : undefined
          }
          className={cn(
            "group relative isolate flex h-8 min-w-0 max-w-96 cursor-pointer items-center gap-1.5 rounded-full bg-[color-mix(in_oklab,var(--foreground)_8%,var(--background))] pr-3.5 pl-2.5 text-[13px] text-foreground/80 shadow-message transition-[translate,opacity,visibility,scale,color] duration-200 hover:text-primary-foreground active:scale-95 motion-reduce:transition-none",
            "before:absolute before:inset-0 before:-z-10 before:scale-x-50 before:rounded-full before:bg-primary before:opacity-0 before:transition-[scale,opacity] before:duration-300 before:ease-[cubic-bezier(.34,1.56,.64,1)] hover:before:scale-x-100 hover:before:opacity-100 motion-reduce:before:transition-none",
            visible
              ? "pointer-events-auto translate-y-0 scale-100 opacity-100"
              : "pointer-events-none invisible -translate-y-2 scale-95 opacity-0",
          )}
        >
          <Icon
            name="ArrowUp"
            className="size-3.5 shrink-0 transition-[translate] duration-300 group-hover:-translate-y-0.5 motion-reduce:transition-none"
          />
          <span
            key={shown?.id}
            className="truncate animate-in fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none"
          >
            {shown?.label}
          </span>
        </button>
      </div>
    </div>
  );
}
