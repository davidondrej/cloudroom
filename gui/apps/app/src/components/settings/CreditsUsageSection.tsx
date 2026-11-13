import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { RangeToggle, Stat } from "@/components/settings/UsageSection";
import { WavePlot } from "@/components/settings/WavePlot";
import { SettingsSection } from "@/components/ui/settings-section.js";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { createLastKnownCache } from "@/lib/last-known-cache";

// Settings → Analytics: when Cloud Credits were used, the first tab (design A, David 2026-11-08). The same wave as the
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

/** The wave: the biggest bursts named, and hover shows an hour's credits and its top threads. */
export function CreditsWavePlot({ wave, range }: { wave: CreditsWave; range: Range }) {
  const { points, start, step, standouts } = rangeOf(wave, range), last = points.length - 1;
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
      points={points.map((point) => ({ value: point.credits, top: point.top.map((thread) => ({ name: thread.name, value: thread.credits })) }))}
      sigma={range === "7d" ? 1.6 : range === "24h" ? 1 : 0.8}
      format={n}
      unit="credits"
      when={when}
      labels={labels}
      marks={range === "7d" ? marks : []}
      standouts={standouts.map((note) => ({ at: note.at, name: note.name, detail: `${n(note.credits)} credits` }))}
    />
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
      </div>
    </SettingsSection>
  );
}
