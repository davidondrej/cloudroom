import { useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { ToggleGroup, ToggleGroupItem } from "@cloudroom/shared-ui/toggle-group";
import { SettingsSection } from "@/components/ui/settings-section.js";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { fetchWithAppSurface } from "@/lib/app-surface";

// Settings → Analytics: when Cloud Credits were used, above Skills (design A, David 2026-11-08). The same wave as the
// website's Usage tab on Plan & billing; the website builds the data (web/lib/credits.ts creditWave).
const waveSchema = z.object({
  start: z.string(),
  hours: z.array(z.object({ credits: z.number(), top: z.array(z.object({ name: z.string(), credits: z.number() })) })),
  days: z.array(z.number()),
  daysStart: z.string(),
  standouts: z.array(z.object({ at: z.number(), name: z.string(), credits: z.number() })),
  standouts24h: z.array(z.object({ at: z.number(), name: z.string(), credits: z.number() })),
});
export type CreditsWave = z.infer<typeof waveSchema>;
/** Per account, so a sign-out or account switch never shows the last account's threads. */
export const creditsWaveKey = (accountId: string) => ["cloudroom-credits-wave", accountId];

/** Null when signed out, on an older website, or before hourly data exists: the section then hides. */
async function loadWave(signal?: AbortSignal): Promise<CreditsWave | null> {
  const response = await fetchWithAppSurface("/api/v1/cloudroom/account/usage-wave", { signal });
  if (!response.ok) return null;
  const parsed = z.object({ wave: waveSchema.nullable() }).safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.wave : null;
}

type Range = "24h" | "7d" | "30d";
const RANGES: { id: Range; hours: number; long: string }[] = [
  { id: "24h", hours: 24, long: "24 hours" }, { id: "7d", hours: 168, long: "7 days" }, { id: "30d", hours: 720, long: "30 days" }];
const HOUR = 3_600_000, DAY = 86_400_000;
const n = (value: number) => Math.round(value).toLocaleString("en-US");

/** Hours for 24 hours and 7 days, UTC days for 30 days. */
function rangeOf(wave: CreditsWave, range: Range) {
  // Days are dated by the website's first day, so a page left open past midnight never shifts them.
  if (range === "30d") return { points: wave.days.map((credits) => ({ credits, top: [] as CreditsWave["hours"][number]["top"] })), start: Date.parse(`${wave.daysStart}T00:00:00Z`), step: DAY, standouts: [] as CreditsWave["standouts"] };
  const skip = range === "24h" ? Math.max(0, wave.hours.length - 24) : 0, standouts = range === "24h" ? wave.standouts24h : wave.standouts;
  return { points: wave.hours.slice(skip), start: Date.parse(wave.start) + skip * HOUR, step: HOUR, standouts: standouts.map((note) => ({ ...note, at: note.at - skip })) };
}
/** "last 7 days", or "since Nov 9" while hourly data is younger than the range. */
const rangeLabel = (wave: CreditsWave, range: Range) => {
  const r = RANGES.find((option) => option.id === range)!;
  return range !== "30d" && wave.hours.length < r.hours ? `since ${new Date(wave.start).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : `in the last ${r.long}`;
};

function smooth(values: number[], sigma: number) {
  const reach = Math.ceil(sigma * 3);
  return values.map((_, i) => {
    let sum = 0, weight = 0;
    for (let o = -reach; o <= reach; o++) {
      const v = values[i + o];
      if (v === undefined) continue;
      const k = Math.exp(-(o * o) / (2 * sigma * sigma));
      sum += v * k; weight += k;
    }
    return sum / weight;
  });
}
/** Monotone cubic through the points, so the wave never dips below zero. */
function curve(points: [number, number][]) {
  const k = points.length, dx: number[] = [], m: number[] = [], t: number[] = [];
  for (let i = 0; i < k - 1; i++) { dx[i] = points[i + 1]![0] - points[i]![0]; m[i] = (points[i + 1]![1] - points[i]![1]) / dx[i]!; }
  t[0] = m[0]!; t[k - 1] = m[k - 2]!;
  for (let i = 1; i < k - 1; i++) t[i] = m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2;
  let d = `M${points[0]![0]},${points[0]![1]}`;
  for (let i = 0; i < k - 1; i++) {
    const [x0, y0] = points[i]!, [x1, y1] = points[i + 1]!, h = dx[i]! / 3;
    d += ` C${x0 + h},${y0 + t[i]! * h} ${x1 - h},${y1 - t[i + 1]! * h} ${x1},${y1}`;
  }
  return d;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex-1 border border-border px-3.5 py-3">
      <div className="text-[11px] tracking-[0.08em] text-muted-foreground uppercase">{label}</div>
      <div className="mt-1 font-mono text-xl text-foreground tabular-nums">{value}</div>
    </div>
  );
}
const Dot = ({ style }: { style?: CSSProperties }) => <span className="pointer-events-none absolute -mt-[5px] -ml-[5px] size-2.5 rounded-full border-2 border-background bg-primary" style={style} />;

/** The wave: the biggest bursts named, and hover shows an hour's credits and its top threads. */
export function CreditsWavePlot({ wave, range }: { wave: CreditsWave; range: Range }) {
  const [hover, setHover] = useState<number | null>(null);
  const { points, start, step, standouts } = rangeOf(wave, range), last = points.length - 1;
  if (!points.some((point) => point.credits > 0)) return <p className="py-10 text-center text-sm text-muted-foreground">No Cloud Credits used {rangeLabel(wave, range)}.</p>;
  if (points.length < 2) return <p className="py-10 text-center text-sm text-muted-foreground">Collecting hourly data. The chart starts after the first full hour.</p>;
  const values = smooth(points.map((point) => point.credits), range === "7d" ? 1.6 : range === "24h" ? 1 : 0.8), peak = Math.max(...values) * 1.3;
  const x = (i: number) => (i / last) * 100, y = (v: number) => 100 - (v / peak) * 100;
  const line = curve(values.map((v, i) => [x(i) * 10, y(v)]));
  const at = (i: number) => new Date(start + i * step), daily = step === DAY;
  const when = (i: number) => daily ? at(i).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
    : `${at(i).toLocaleDateString("en-US", { weekday: "short" })} ${at(i).toLocaleTimeString("en-US", { hour: "numeric" })}`;
  // Marks: local midnights across 7 days, every 4th local hour across 24 hours, every 7th day across 30 days.
  const marks = points.flatMap((_, i) => (daily ? (last - i) % 7 === 0 : range === "7d" ? at(i).getHours() === 0 : at(i).getHours() % 4 === 0) ? [i] : []);
  const labels = range === "7d"
    ? points.flatMap((_, i) => at(i).getHours() === 12 ? [{ i, text: at(i).toDateString() === new Date().toDateString() ? "today" : at(i).toLocaleDateString("en-US", { weekday: "short" }).toLowerCase() }] : [])
    : marks.map((i) => ({ i, text: daily ? at(i).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toLowerCase() : at(i).toLocaleTimeString("en-US", { hour: "numeric" }).toLowerCase() }));
  const focus = hover === null ? null : points[hover]!;
  return (
    <div>
      <div
        className="relative mt-14 h-52 cursor-crosshair"
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setHover(Math.min(last, Math.max(0, Math.round(((event.clientX - box.left) / box.width) * last))));
        }}
        onMouseLeave={() => setHover(null)}
      >
        {range === "7d" ? marks.map((i) => <span key={i} className="absolute inset-y-0 w-px bg-border/50" style={{ left: `${x(i)}%` }} />) : null}
        <svg aria-hidden viewBox="0 0 1000 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
          <defs>
            <linearGradient id="credits-wave" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--primary)" stopOpacity="0.45" />
              <stop offset="1" stopColor="var(--primary)" stopOpacity="0.05" />
            </linearGradient>
          </defs>
          <path d={`${line} L1000,100 L0,100 Z`} fill="url(#credits-wave)" />
          <path d={line} fill="none" stroke="var(--primary)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        </svg>
        {hover === null
          ? standouts.map((note) => (
              <div key={note.at} className="pointer-events-none absolute" style={{ left: `${x(note.at)}%`, top: `${y(values[note.at]!)}%` }}>
                <Dot />
                <span className="absolute bottom-2 left-0 h-7 w-px bg-muted-foreground/50" />
                <span className={cn("absolute bottom-10 font-mono text-xs whitespace-nowrap text-muted-foreground", x(note.at) > 50 ? "-right-2 text-right" : "-left-2")}>
                  <span className="block text-foreground">{note.name}</span>
                  {n(note.credits)} credits
                </span>
              </div>
            ))
          : null}
        <Dot style={{ left: "100%", top: `${y(values[last]!)}%` }} />
        {hover !== null && focus ? (
          <>
            <span className="pointer-events-none absolute inset-y-0 w-px bg-muted-foreground/60" style={{ left: `${x(hover)}%` }} />
            <Dot style={{ left: `${x(hover)}%`, top: `${y(values[hover]!)}%` }} />
            <div
              className="pointer-events-none absolute top-1 z-10 min-w-52 rounded-md border border-border bg-popover px-3 py-2.5 text-xs text-popover-foreground shadow-md"
              style={x(hover) > 75 ? { right: `calc(${100 - x(hover)}% + 12px)` } : { left: `calc(${x(hover)}% + 12px)` }}
            >
              <div className="text-muted-foreground">{when(hover)}</div>
              <div className="mt-0.5 mb-1.5 font-mono text-base text-foreground tabular-nums">{n(focus.credits)} credits</div>
              {focus.top.map((thread) => (
                <div key={thread.name} className="flex justify-between gap-4 leading-6">
                  <span>{thread.name}</span>
                  <span className="font-mono tabular-nums">{n(thread.credits)}</span>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>
      <div className="relative mt-2 h-4 font-mono text-[11px] text-muted-foreground">
        {labels.map((label) => (
          <span key={label.i} className="absolute whitespace-nowrap" style={{ left: `${x(label.i)}%`, transform: `translateX(${x(label.i) < 4 ? 0 : x(label.i) > 96 ? -100 : -50}%)` }}>{label.text}</span>
        ))}
      </div>
    </div>
  );
}

export function CreditsUsageSection() {
  const account = useCloudroomAccount().data, accountId = account?.account?.id ?? "";
  const [range, setRange] = useState<Range>("7d");
  const query = useQuery({ queryKey: creditsWaveKey(accountId), queryFn: ({ signal }) => loadWave(signal), enabled: accountId !== "", staleTime: 60_000 });
  const wave = query.data;
  if (!accountId || !wave) return null;
  const usage = account?.planUsage, points = rangeOf(wave, range).points;
  const left = usage && usage.credits !== null ? Math.max(0, usage.creditsLimit - usage.credits) + Math.max(0, usage.extraCredits ?? 0) : null;
  // Busiest weekday in the range, by local time.
  const byDay = new Map<string, number>(), { start, step } = rangeOf(wave, range);
  points.forEach((point, i) => {
    const name = new Date(start + i * step).toLocaleDateString("en-US", { weekday: "short", ...(step === DAY ? { timeZone: "UTC" } : {}) });
    byDay.set(name, (byDay.get(name) ?? 0) + point.credits);
  });
  const busiest = [...byDay].sort((a, b) => b[1] - a[1])[0];
  return (
    <SettingsSection
      title="Cloud Credits"
      description="When your credits were used, hour by hour. Hover to see which threads used them."
      action={
        <ToggleGroup type="single" aria-label="Time range" value={range} onValueChange={(next) => { if (next) setRange(next as Range); }} className="h-8 gap-0.5 rounded-md border border-input bg-background p-0.5">
          {RANGES.map((option) => (
            <ToggleGroupItem key={option.id} value={option.id} className="h-6 rounded-sm px-2.5 text-xs font-medium text-muted-foreground shadow-none hover:bg-state-hover hover:text-foreground data-[state=on]:bg-state-active data-[state=on]:text-foreground data-[state=on]:hover:bg-state-active">
              {option.id}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      }
      plain
    >
      <div className="space-y-5">
        <div className="flex gap-3">
          <Stat label={`Credits · ${range}`} value={n(points.reduce((sum, point) => sum + point.credits, 0))} />
          <Stat label="Left" value={left === null ? "—" : n(left)} />
          <Stat label="Busiest day" value={busiest && busiest[1] > 0 ? busiest[0] : "—"} />
        </div>
        <CreditsWavePlot wave={wave} range={range} />
      </div>
    </SettingsSection>
  );
}
