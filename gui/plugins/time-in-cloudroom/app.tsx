import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";

// A year of active minutes per day, drawn like GitHub's contribution graph. Settings → General shows it at the top.
const WEEKS = 53;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const OPACITY = [0, 0.25, 0.45, 0.7, 1];
const dayKey = (at: Date) => at.toLocaleDateString("en-CA");
const level = (minutes: number) => (minutes === 0 ? 0 : minutes < 60 ? 1 : minutes < 180 ? 2 : minutes < 300 ? 3 : 4);

function formatMinutes(minutes: number): string {
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

interface TimeInApp { days: Record<string, number>; today: number }

function useTimeInApp(): TimeInApp | null {
  const [time, setTime] = useState<TimeInApp | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      void fetch("/api/v1/cloudroom/time-in-app").then((response) => response.ok ? response.json() as Promise<TimeInApp> : null).then((value) => { if (live && value) setTime(value); }, () => {});
    };
    load();
    const timer = window.setInterval(load, 60_000);
    return () => { live = false; window.clearInterval(timer); };
  }, []);
  return time;
}

function Cell({ minutes }: { minutes: number }) {
  const shade = level(minutes);
  return (
    <span
      className={shade === 0 ? "bg-muted" : "bg-primary"}
      style={{ aspectRatio: "1", borderRadius: 2, opacity: shade === 0 ? 1 : OPACITY[shade] }}
    />
  );
}

function TimeHeatmap() {
  const time = useTimeInApp();
  const gridRef = useRef<HTMLDivElement>(null);
  // One shared hover tooltip, like GitHub's: shows instantly above the hovered day.
  const [tip, setTip] = useState<{ text: string; x: number; y: number; week: number } | null>(null);
  if (!time) return null;
  const showTip = (event: MouseEvent<HTMLElement>, text: string, week: number) => {
    const cell = event.currentTarget.getBoundingClientRect();
    const grid = gridRef.current!.getBoundingClientRect();
    setTip({ text, x: cell.left + cell.width / 2 - grid.left, y: cell.top - grid.top, week });
  };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay() - 7 * (WEEKS - 1));
  const cells: ReactNode[] = [];
  let total = 0;
  for (let week = 0; week < WEEKS; week++) {
    for (let weekday = 0; weekday < 7; weekday++) {
      const date = new Date(start);
      date.setDate(start.getDate() + week * 7 + weekday);
      if (weekday === 0 && date.getDate() <= 7 && week < WEEKS - 1) {
        cells.push(<span key={`m${week}`} className="text-2xs text-subtle-foreground" style={{ gridColumn: week + 2, gridRow: 1, whiteSpace: "nowrap" }}>{MONTHS[date.getMonth()]}</span>);
      }
      if (date > today) continue;
      const minutes = time.days[dayKey(date)] ?? 0;
      total += minutes;
      const label = date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
      const text = minutes === 0 ? `No time on ${label}` : `${formatMinutes(minutes)} on ${label}`;
      cells.push(
        <span key={`${week}-${weekday}`} aria-label={text} onMouseEnter={(event) => showTip(event, text, week)} style={{ gridColumn: week + 2, gridRow: weekday + 2, display: "grid" }}>
          <Cell minutes={minutes} />
        </span>,
      );
    }
  }
  const hours = Math.round(total / 60);
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="min-w-0 text-sm font-semibold text-foreground">
          {hours} {hours === 1 ? "hour" : "hours"} in Cloudroom in the last year
        </h2>
        <span className="text-xs text-subtle-foreground">{formatMinutes(time.today)} today</span>
      </div>
      <div className="rounded-lg bg-surface-recessed px-4 py-3.5">
        <div ref={gridRef} onMouseLeave={() => setTip(null)} style={{ position: "relative", display: "grid", gridTemplateColumns: `28px repeat(${WEEKS}, minmax(0, 1fr))`, gap: 3 }}>
          {[["Mon", 3], ["Wed", 5], ["Fri", 7]].map(([name, row]) => (
            <span key={name} className="text-2xs text-subtle-foreground" style={{ gridColumn: 1, gridRow: row, lineHeight: 1, alignSelf: "center" }}>{name}</span>
          ))}
          {cells}
          {tip && (
            <div
              role="tooltip"
              className="pointer-events-none absolute z-50 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
              // Centered above the day, but kept inside the card at the left and right edges.
              style={{ left: tip.x, top: tip.y - 6, transform: `translate(${tip.week < 6 ? "-12px" : tip.week > WEEKS - 7 ? "calc(-100% + 12px)" : "-50%"}, -100%)` }}
            >
              {tip.text}
            </div>
          )}
        </div>
        <div className="mt-3 flex items-center justify-between gap-4 text-2xs text-subtle-foreground">
          <span>Counts minutes while Cloudroom is focused and you are active.</span>
          <span className="flex items-center gap-1">
            Less
            {OPACITY.map((_, shade) => (
              <span key={shade} style={{ width: 10, display: "grid" }}><Cell minutes={[0, 30, 120, 240, 400][shade]!} /></span>
            ))}
            More
          </span>
        </div>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "time", component: TimeHeatmap });
});
