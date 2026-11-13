import { useId, useState } from "react";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { RangeToggle, UsageSection, dayText, dayTicks, short, sum } from "@/components/settings/UsageSection";
import { useUsageAnalytics } from "@/hooks/queries/system-queries";

// Settings → Analytics → Tokens: dots (David 2026-11-11). Each column is a day, each dot a batch of tokens.
const RANGES = ["7", "30", "90"] as const;
const KINDS = [
  { value: "all", label: "All tokens", word: "tokens" },
  { value: "written", label: "Written", word: "written" },
  { value: "read", label: "Read", word: "read" },
  { value: "cached", label: "From cache", word: "from cache" },
] as const;
type Kind = (typeof KINDS)[number]["value"];
type Use<T> = { written: T; read: T; cached: T };
const of = (use: Use<number>, kind: Kind) => (kind === "all" ? use.written + use.read + use.cached : use[kind]);
const daily = (use: Use<number[]>, kind: Kind) => use.written.map((written, day) => of({ written, read: use.read[day]!, cached: use.cached[day]! }, kind));

// One color per model, picked so color-blind readers can tell them apart. Lime is the app's own; gray is the rest.
const COLORS = ["var(--primary)", "#3987e5", "#d95926", "#2bb5a0"], REST = "color-mix(in oklab, var(--foreground) 38%, var(--background))";
const kept = new Map<string, number>();
/** A model keeps its color when the range changes, so the eye can follow it. New models take a free one. */
function paint(names: string[]) {
  const shown = names.slice(0, COLORS.length), taken = new Set<number>();
  for (const name of shown) {
    const color = kept.get(name);
    if (color !== undefined && !taken.has(color)) taken.add(color);
    else kept.delete(name);
  }
  for (const name of shown) {
    if (kept.has(name)) continue;
    const free = COLORS.findIndex((_, color) => !taken.has(color));
    kept.set(name, free);
    taken.add(free);
  }
  return names.map((name, rank) => (rank < COLORS.length ? COLORS[kept.get(name)!]! : REST));
}
// Dots side by side in one day, and the most rows a day may fill.
const GRID = { 7: { across: 8, rows: 16 }, 30: { across: 2, rows: 20 }, 90: { across: 1, rows: 28 } } as const;
const WIDTH = 694;
/** 50,000,000 → "50M". */
const round = (value: number) => {
  const [unit, size] = value >= 1e9 ? (["B", 1e9] as const) : value >= 1e6 ? (["M", 1e6] as const) : value >= 1e3 ? (["K", 1e3] as const) : (["", 1] as const);
  return `${+(value / size).toFixed(1)}${unit}`;
};
/** Whole dots per model that add up to the day's rounded total. */
function allot(values: number[], unit: number) {
  const exact = values.map((value) => value / unit), dots = exact.map(Math.floor);
  let spare = Math.round(sum(exact)) - sum(dots);
  for (const i of exact.map((_, index) => index).sort((a, b) => exact[b]! - dots[b]! - (exact[a]! - dots[a]!))) {
    if (spare <= 0) break;
    dots[i]! += 1; spare -= 1;
  }
  return dots;
}

/** Up or down against the range before: "↑ 4.5×", "↓ 11%". */
function Change({ now, before, days }: { now: number; before: number; days: number }) {
  const ratio = now / before, up = ratio >= 1;
  return (
    <span title={`Compared with the ${days} days before`} className={cn("rounded-full px-2.5 py-1 font-mono text-[11px] whitespace-nowrap tabular-nums", up ? "bg-primary/12 text-primary-text" : "bg-foreground/8 text-muted-foreground")}>
      {up ? "↑" : "↓"} {ratio >= 2 ? `${ratio.toFixed(1)}×` : `${Math.abs(Math.round((ratio - 1) * 100))}%`}
    </span>
  );
}

export function TokensSection() {
  const [range, setRange] = useState<(typeof RANGES)[number]>("30"), [kind, setKind] = useState<Kind>("all"), [hover, setHover] = useState<number | null>(null);
  const query = useUsageAnalytics("tokens", range), empty = useId();
  return (
    <UsageSection title="Tokens" description="Each column is a day, each dot a batch of tokens, colored by model. Hover a day for its threads."
      ranges={RANGES} range={range} onRange={setRange} data={query.data?.tokens && query.data} failed={query.isError}>
      {(usage) => {
        const { models, top } = usage.tokens!, { days, startDate } = usage, chosen = KINDS.find((item) => item.value === kind)!;
        const all = daily(usage.tokens!, kind), now = all.slice(days), before = all.slice(0, days), total = sum(now), most = Math.max(...now);
        const lists = models.map((model) => daily(model, kind)), colors = paint(models.map((model) => model.name)), focus = hover !== null && hover < days ? hover : null;
        // The dot grid: a round number of tokens per dot, sized so the busiest day still fits.
        const grid = GRID[days as keyof typeof GRID] ?? GRID[30], room = grid.across * grid.rows, power = 10 ** Math.floor(Math.log10(Math.max(most, 1) / room));
        const unit = [1, 2, 2.5, 5, 10].map((step) => step * power).find((size) => most / size <= room)!;
        const dayWidth = WIDTH / days, pitch = Math.min(11, dayWidth / (grid.across + 0.12)), rows = Math.ceil(Math.round(most / unit) / grid.across) + 1, height = rows * pitch;
        const spot = (col: number) => dayWidth / 2 + (col - (grid.across - 1) / 2) * pitch;
        // Two round numbers down the side, on rows that are a multiple of five.
        const high = rows > 5 ? Math.floor((rows - 1) / 5) * 5 : rows - 1, half = Math.round(high / 10) * 5;
        return (
          <div className="space-y-6 pt-2">
            <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
              <div>
                <div className="text-[11px] tracking-[0.08em] text-muted-foreground uppercase">{chosen.label} · last {days} days</div>
                <div className="mt-2.5 flex items-center gap-3.5">
                  <span className="font-mono text-[46px] leading-none tracking-[-0.03em] text-foreground tabular-nums">{short(total)}</span>
                  {/* Only compared when the range before has history from its start, or a new user would see a huge jump. */}
                  {total > 0 && before.slice(0, Math.ceil(days / 4)).some((value) => value > 0) ? <Change now={total} before={sum(before)} days={days} /> : null}
                </div>
              </div>
              <div className="flex flex-col items-end gap-3">
                <RangeToggle label="Kind of tokens" value={kind} options={KINDS} onChange={setKind} />
                {total > 0 ? <span className="text-xs text-muted-foreground">one dot is <span className="font-mono text-foreground tabular-nums">{round(unit)}</span> tokens</span> : null}
              </div>
            </div>
            {total > 0 ? (
              <>
                <div>
                  <div className="flex">
                    <div className="relative w-9 shrink-0 font-mono text-[10.5px] text-muted-foreground tabular-nums">
                      {[...new Set([half, high])].filter((row) => row > 0).map((row) => (
                        <span key={row} className="absolute right-3 -translate-y-1/2" style={{ top: `${(1 - row / rows) * 100}%` }}>{round(row * grid.across * unit)}</span>
                      ))}
                    </div>
                    <div className="relative min-w-0 flex-1 cursor-crosshair"
                      onMouseMove={(event) => {
                        const box = event.currentTarget.getBoundingClientRect();
                        setHover(Math.min(days - 1, Math.max(0, Math.floor(((event.clientX - box.left) / box.width) * days))));
                      }}
                      onMouseLeave={() => setHover(null)}>
                      <svg aria-hidden viewBox={`0 0 ${WIDTH} ${height}`} className="block w-full">
                        <defs>
                          <pattern id={empty} width={dayWidth} height={pitch} patternUnits="userSpaceOnUse">
                            {Array.from({ length: grid.across }, (_, col) => <circle key={col} cx={spot(col)} cy={pitch / 2} r={pitch * 0.36} fill="var(--foreground)" fillOpacity={0.085} />)}
                          </pattern>
                        </defs>
                        {focus !== null ? <rect x={focus * dayWidth} width={dayWidth} height={height} rx={3} fill="var(--foreground)" fillOpacity={0.07} /> : null}
                        <rect width={WIDTH} height={height} fill={`url(#${empty})`} />
                        {now.map((_, day) => {
                          const owners = allot(lists.map((list) => list[day]!), unit).flatMap((count, model) => Array.from({ length: count }, () => model));
                          return owners.map((model, i) => (
                            <circle key={`${day}-${i}`} cx={day * dayWidth + spot(i % grid.across)} cy={height - (Math.floor(i / grid.across) + 0.5) * pitch} r={pitch * 0.36} fill={colors[model]} />
                          ));
                        })}
                      </svg>
                      {focus !== null ? (
                        <div className="pointer-events-none absolute top-0 z-10 min-w-56 rounded-md border border-border bg-popover px-3 py-2.5 text-xs text-popover-foreground shadow-md"
                          style={focus > days / 2 ? { right: `calc(${(1 - focus / days) * 100}% + 10px)` } : { left: `calc(${((focus + 1) / days) * 100}% + 10px)` }}>
                          <div className="text-muted-foreground">{dayText(startDate, focus, { weekday: "short", month: "short", day: "numeric" })}</div>
                          <div className="mt-0.5 mb-1.5 font-mono text-base text-foreground tabular-nums">{short(now[focus]!)} {chosen.word}</div>
                          {models.map((model, i) => lists[i]![focus]! > 0 ? (
                            <div key={model.name} className="flex items-center justify-between gap-4 leading-6">
                              <span className="flex min-w-0 items-center gap-2"><span className="size-2 shrink-0 rounded-full" style={{ background: colors[i] }} /><span className="truncate">{model.name}</span></span>
                              <span className="font-mono tabular-nums">{short(lists[i]![focus]!)}</span>
                            </div>
                          ) : null)}
                          <div className="mt-1.5 border-t border-border pt-1.5">
                            {[...top[focus]!].sort((a, b) => of(b, kind) - of(a, kind)).slice(0, 3).filter((thread) => of(thread, kind) > 0).map((thread, i) => (
                              <div key={i} className="flex justify-between gap-4 leading-6 text-muted-foreground">
                                <span className="max-w-56 truncate">{thread.name}</span>
                                <span className="font-mono tabular-nums">{short(of(thread, kind))}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <div className="relative mt-2 ml-9 h-4 font-mono text-[10.5px] text-muted-foreground">
                    {dayTicks(startDate, days).map((label) => <span key={label.i} className={cn("absolute whitespace-nowrap", label.i === days - 1 ? "right-0" : "-translate-x-1/2")} style={label.i === days - 1 ? undefined : { left: `${((label.i + 0.5) / days) * 100}%` }}>{label.text}</span>)}
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-xs text-muted-foreground">
                  {models.map((model, i) => (
                    <span key={model.name} className="whitespace-nowrap">
                      <span className="mr-2 inline-block size-2 rounded-full" style={{ background: colors[i] }} />
                      <span className="text-foreground">{model.name}</span>
                      <span className="ml-2 font-mono tabular-nums">{short(sum(lists[i]!))}</span>
                    </span>
                  ))}
                </div>
              </>
            ) : <p className="py-10 text-center text-sm text-muted-foreground">No tokens counted in this range yet.</p>}
            <p className="text-xs text-muted-foreground">Estimates from each thread's running totals. Cursor agents report no tokens.</p>
          </div>
        );
      }}
    </UsageSection>
  );
}
