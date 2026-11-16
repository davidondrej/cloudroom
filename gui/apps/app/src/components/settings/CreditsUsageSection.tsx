import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { COLORS, REST, RangeToggle, Stat, sum } from "@/components/settings/UsageSection";
import { WavePlot } from "@/components/settings/WavePlot";
import { SettingsSection } from "@/components/ui/settings-section.js";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { createLastKnownCache } from "@/lib/last-known-cache";
import { getThreadRoutePath } from "@/lib/route-paths";
import { sdk } from "@/lib/sdk";

// Settings → Analytics: when Cloud Credits were used, the first tab (design A, David 2026-11-08). The same wave as the
// website's Usage tab on Plan & billing; the website builds the data (web/lib/credits.ts creditWave). Split by thread:
// colored layers and blocks for the top threads (design E, David 2026-11-15; web/lib/credits.ts creditSplit).
const splitSchema = z.object({
  since: z.string(),
  threads: z.number(),
  credits: z.number(),
  top: z.array(z.object({ id: z.string(), name: z.string(), credits: z.number(), points: z.array(z.number()).optional() })),
});
type CreditSplit = z.infer<typeof splitSchema>;
const waveSchema = z.object({
  start: z.string(),
  hours: z.array(z.object({ credits: z.number(), top: z.array(z.object({ name: z.string(), credits: z.number() })) })),
  days: z.array(z.number()),
  daysStart: z.string(),
  standouts: z.array(z.object({ at: z.number(), name: z.string(), credits: z.number() })),
  standouts24h: z.array(z.object({ at: z.number(), name: z.string(), credits: z.number() })),
  // Missing from older websites, and until the thread-split SQL is applied: then the wave stays one lime layer.
  split: z.object({ "24h": splitSchema, "7d": splitSchema, "30d": splitSchema }).optional(),
});
export type CreditsWave = z.infer<typeof waveSchema>;
/** Per account, so a sign-out or account switch never shows the last account's threads. */
export const creditsWaveKey = (accountId: string) => ["cloudroom-credits-wave", accountId];
// The last wave per account, so the tab opens instantly, even after a restart.
const waveCache = createLastKnownCache<CreditsWave>({ prefix: "bb.credits-wave", version: "1", schema: waveSchema, maxEntries: 2 });

/** Null before hourly data exists. Throws when the request fails, so the last saved wave stays on screen. */
async function loadWave(signal?: AbortSignal): Promise<CreditsWave | null> {
  const response = await fetchWithAppSurface("/api/v1/cloudroom/account/usage-wave", { signal });
  if (!response.ok) throw new Error(`Cloud Credits wave: ${response.status}`);
  return z.object({ wave: waveSchema.nullable() }).parse(await response.json()).wave;
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

/** The wave. Split by thread, the top 4 threads are colored layers and the rest one gray layer; hover lists them.
 *  Without a split, the biggest bursts are named and hover shows an hour's top threads. */
export function CreditsWavePlot({ wave, range }: { wave: CreditsWave; range: Range }) {
  const { points, start, step, standouts } = rangeOf(wave, range), last = points.length - 1;
  const layered = wave.split?.[range].top.filter((thread) => thread.points?.length === points.length).slice(0, COLORS.length) ?? [];
  const layers = layered.length === 0 ? undefined : [...layered.map((thread, k) => ({ name: thread.name, color: COLORS[k]!, values: thread.points! })),
    { name: "Other", color: REST, values: points.map((point, i) => Math.max(0, point.credits - sum(layered.map((thread) => thread.points![i]!)))) }];
  if (!points.some((point) => point.credits > 0)) return <p className="py-10 text-center text-sm text-muted-foreground">No Cloud Credits used {rangeLabel(wave, range)}.</p>;
  if (points.length < 2) return <p className="py-10 text-center text-sm text-muted-foreground">Collecting hourly data. The chart starts after the first full hour.</p>;
  const at = (i: number) => new Date(start + i * step), daily = step === DAY;
  const when = (i: number) => daily ? at(i).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
    : `${at(i).toLocaleDateString("en-US", { weekday: "short" })} ${at(i).toLocaleTimeString("en-US", { hour: "numeric" })}`;
  // Marks: local midnights across 7 days, every 4th local hour across 24 hours, every 7th day across 30 days.
  const marks = points.flatMap((_, i) => (daily ? (last - i) % 7 === 0 : range === "7d" ? at(i).getHours() === 0 : at(i).getHours() % 4 === 0) ? [i] : []);
  const labels = range === "7d"
    ? points.flatMap((_, i) => at(i).getHours() === 12 ? [{ i, text: at(i).toDateString() === new Date().toDateString() ? "today" : at(i).toLocaleDateString("en-US", { weekday: "short" }).toLowerCase() }] : [])
    : marks.map((i) => ({ i, text: daily ? at(i).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toLowerCase() : at(i).toLocaleTimeString("en-US", { hour: "numeric" }).toLowerCase() }));
  return (
    <WavePlot
      points={points.map((point, i) => ({ value: point.credits, top: layers
        ? layers.map((layer) => ({ name: layer.name, value: layer.values[i]!, color: layer.color })).filter((layer) => Math.round(layer.value) > 0)
        : point.top.map((thread) => ({ name: thread.name, value: thread.credits })) }))}
      sigma={range === "7d" ? 1.6 : range === "24h" ? 1 : 0.8}
      format={n}
      unit="credits"
      when={when}
      labels={labels}
      marks={range === "7d" ? marks : []}
      standouts={standouts.map((note) => ({ at: note.at, name: note.name, detail: `${n(note.credits)} credits` }))}
      layers={layers}
    />
  );
}

/** Blocks sized by area: squarified rows along the shorter side, so blocks stay close to square. */
function squarify(values: number[], width: number, height: number) {
  const scale = (width * height) / Math.max(sum(values), 1e-9), areas = values.map((value) => value * scale), rects: { x: number; y: number; w: number; h: number }[] = [];
  const worst = (row: number[], side: number) => Math.max((side * side * Math.max(...row)) / sum(row) ** 2, sum(row) ** 2 / (side * side * Math.min(...row)));
  let x = 0, y = 0, w = width, h = height;
  for (let i = 0; i < areas.length;) {
    const side = Math.min(w, h);
    let row = [areas[i]!];
    while (i + row.length < areas.length && worst([...row, areas[i + row.length]!], side) <= worst(row, side)) row = [...row, areas[i + row.length]!];
    const thick = sum(row) / side;
    let offset = 0;
    for (const area of row) {
      rects.push(w >= h ? { x, y: y + offset, w: thick, h: area / thick } : { x: x + offset, y, w: area / thick, h: thick });
      offset += area / thick;
    }
    if (w >= h) { x += thick; w -= thick; } else { y += thick; h -= thick; }
    i += row.length;
  }
  return rects;
}
const BLOCKS_W = 768, BLOCKS_H = 290;
const percent = (part: number, all: number) => { const value = all > 0 ? (part / all) * 100 : 0; return `${value >= 10 ? Math.round(value) : value.toFixed(1)}%`; };

/** The range's top threads as blocks sized by credits, in their wave colors, then one gray block for the rest.
 *  A block opens its thread when this computer has it. */
export function CreditBlocks({ split, from }: { split: CreditSplit; from: number }) {
  const navigate = useNavigate(), rest = split.threads - split.top.length;
  const blocks = [...split.top.map((thread, k) => ({ ...thread, color: COLORS[k] ?? REST })),
    { id: "", name: `${n(rest)} other thread${rest === 1 ? "" : "s"}`, short: `${n(rest)} more`, credits: rest > 0 ? Math.max(0, split.credits - sum(split.top.map((thread) => thread.credits))) : 0, color: REST }]
    .filter((block) => block.credits > 0);
  const rects = squarify(blocks.map((block) => block.credits), BLOCKS_W, BLOCKS_H);
  const open = (threadId: string) => void sdk.threads.get({ threadId }).then((thread) => navigate(getThreadRoutePath({ projectId: thread.projectId, threadId }))).catch(() => {});
  return (
    <div className="pt-1">
      {/* Thread hours start 2026-11-08, so a range reaching back further is split only from then. */}
      {Date.parse(split.since) > from + 60_000 ? (
        <div className="mb-2 text-[11px] tracking-[0.08em] text-muted-foreground uppercase">
          Threads since {new Date(split.since).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
        </div>
      ) : null}
      <div role="list" aria-label="Credits by thread" className="relative" style={{ aspectRatio: `${BLOCKS_W} / ${BLOCKS_H}` }}>
        {blocks.map((block, k) => {
          const r = rects[k]!, big = r.w > 150 && r.h > 110, small = r.w < 84 || r.h < 96, thread = block.id.startsWith("thr_");
          return (
            <div key={block.id || block.name} role="listitem" className="absolute p-px" style={{ left: `${(r.x / BLOCKS_W) * 100}%`, top: `${(r.y / BLOCKS_H) * 100}%`, width: `${(r.w / BLOCKS_W) * 100}%`, height: `${(r.h / BLOCKS_H) * 100}%` }}>
              <button type="button" disabled={!thread} onClick={() => open(block.id)} title={`${block.name}: ${n(block.credits)} credits`}
                className={cn("flex size-full flex-col justify-between overflow-hidden text-left text-foreground enabled:hover:brightness-125", big ? "p-3.5" : "p-2.5")}
                style={{ background: `color-mix(in oklab, ${block.color} 46%, var(--background))`, boxShadow: `inset 0 2px 0 ${block.color}` }}>
                <span className={cn("leading-snug", big ? "text-sm font-medium" : "text-xs", small ? "truncate" : "line-clamp-2", !block.id && "text-muted-foreground")}>{small && "short" in block ? block.short : block.name}</span>
                {r.h >= 44 ? (
                  <span className="flex items-baseline gap-2 font-mono tabular-nums">
                    <span className={big ? "text-2xl tracking-[-0.02em]" : "text-xs"}>{n(block.credits)}</span>
                    {r.w >= 100 ? <span className="text-[11px] text-foreground/60">{percent(block.credits, split.credits)}</span> : null}
                  </span>
                ) : null}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CreditsUsageSection() {
  const account = useCloudroomAccount().data, accountId = account?.account?.id ?? "";
  const [range, setRange] = useState<Range>("30d");
  const cacheKey = waveCache.key(accountId);
  const query = useQuery({
    queryKey: creditsWaveKey(accountId),
    queryFn: async ({ signal }) => {
      const wave = await loadWave(signal);
      if (wave) waveCache.write(cacheKey, wave);
      return wave;
    },
    enabled: accountId !== "",
    initialData: () => (accountId ? waveCache.read(cacheKey) ?? undefined : undefined),
    // Saved data counts as stale, so every first visit refetches.
    initialDataUpdatedAt: 0,
    staleTime: 60_000,
  });
  const wave = query.data;
  if (!accountId) return null;
  if (!wave) return <p className="text-sm text-muted-foreground">{query.isPending ? "Loading…" : query.isError ? "Couldn't load Cloud Credits." : "No Cloud Credits data yet."}</p>;
  const usage = account?.planUsage, points = rangeOf(wave, range).points, split = wave.split?.[range];
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
      description="When your credits were used, and which threads used them."
      action={
        <RangeToggle value={range} options={RANGES.map((option) => ({ value: option.id, label: option.id }))} onChange={setRange} />
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
        {split && split.credits > 0 ? <CreditBlocks split={split} from={start} /> : null}
      </div>
    </SettingsSection>
  );
}
