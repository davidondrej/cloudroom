import { useState } from "react";
import { Stat, UsageSection, dayText, dayTicks, short, sum } from "@/components/settings/UsageSection";
import { WavePlot } from "@/components/settings/WavePlot";
import { useUsageAnalytics } from "@/hooks/queries/system-queries";

// Settings → Analytics → Tokens: wave (design A, David 2026-11-10).
const RANGES = ["7", "30", "90"] as const;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export function TokensSection() {
  const [range, setRange] = useState<(typeof RANGES)[number]>("30");
  const query = useUsageAnalytics("tokens", range);
  return (
    <UsageSection title="Tokens" description="Tokens your agents wrote each day, with the threads that wrote the most. Hover a day for its threads."
      ranges={RANGES} range={range} onRange={setRange} data={query.data?.tokens && query.data} failed={query.isError}>
      {(usage) => {
        const { written, read, cached, top } = usage.tokens!, { days, startDate } = usage, wrote = sum(written), all = wrote + read + cached;
        // The two days one thread wrote the most, far enough apart that their labels never touch.
        const picks: number[] = [];
        for (const day of written.map((_, i) => i).sort((a, b) => (top[b]![0]?.written ?? 0) - (top[a]![0]?.written ?? 0))) {
          if (picks.length < 2 && top[day]![0] && picks.every((pick) => Math.abs(pick - day) > days * 0.3)) picks.push(day);
        }
        return (
          <>
            <div className="flex gap-3">
              <Stat label={`Written · ${days}d`} value={short(wrote)} />
              <Stat label="Read" value={short(read)} />
              <Stat label="From cache" value={short(cached)} sub={all > 0 ? `${Math.round((cached / all) * 100)}% of all` : undefined} />
            </div>
            {wrote > 0 ? (
              <WavePlot
                points={written.map((value, day) => ({ value, top: top[day]!.map((thread) => ({ name: thread.name, value: thread.written })) }))}
                sigma={days <= 7 ? 0.6 : days / 33}
                format={short}
                unit="written"
                when={(day) => dayText(startDate, day, { weekday: "short", month: "short", day: "numeric" })}
                labels={dayTicks(startDate, days)}
                standouts={picks.map((day) => ({ at: day, name: clip(top[day]![0]!.name, 30), detail: `${short(top[day]![0]!.written)} written · ${dayText(startDate, day).toLowerCase()}` }))}
              />
            ) : <p className="py-10 text-center text-sm text-muted-foreground">No tokens counted in this range yet.</p>}
            <p className="text-xs text-muted-foreground">Estimates from each thread's running totals. Cursor agents report no tokens.</p>
          </>
        );
      }}
    </UsageSection>
  );
}
