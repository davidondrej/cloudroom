import { useState } from "react";
import { Stat, UsageSection, hourName, n, sum } from "@/components/settings/UsageSection";
import { useUsageAnalytics } from "@/hooks/queries/system-queries";

// Settings → Analytics → Prompts: punch card (design A, David 2026-11-10).
const RANGES = ["30", "90", "365"] as const;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const ROW = "grid grid-cols-[2.5rem_1fr_3.25rem] items-center gap-2";

/** Days in a row with a prompt, up to today. A quiet today doesn't break it until the day is over. */
function streakOf(daily: readonly number[]): number {
  let day = daily.length - 1, streak = 0;
  if (daily[day] === 0) day -= 1;
  for (; day >= 0 && daily[day]! > 0; day -= 1) streak += 1;
  return streak;
}

export function PromptsSection() {
  const [range, setRange] = useState<(typeof RANGES)[number]>("30");
  const query = useUsageAnalytics("prompts", range);
  return (
    <UsageSection title="Prompts" description="Which hours of the week you prompt in. Loops and agent-to-agent messages are left out."
      ranges={RANGES} range={range} onRange={setRange} data={query.data?.prompts && query.data} failed={query.isError}>
      {(usage) => {
        const { daily, hours } = usage.prompts!, max = Math.max(...hours, 1), streak = streakOf(daily);
        const byHour = HOURS.map((hour) => sum(WEEKDAYS.map((_, day) => hours[day * 24 + hour]!)));
        // The quietest five hours in a row, wrapping past midnight.
        const stretch = (from: number) => sum([0, 1, 2, 3, 4].map((offset) => byHour[(from + offset) % 24]!));
        const quiet = HOURS.reduce((best, hour) => (stretch(hour) < stretch(best) ? hour : best), 0);
        return (
          <>
            <div className="flex gap-3">
              <Stat label={`Your prompts · ${usage.days === 365 ? "1y" : `${usage.days}d`}`} value={n(sum(daily))} />
              {/* A streak as long as the range may go back further. */}
              <Stat label="Streak" value={`${streak}${streak >= usage.days - 1 ? "+" : ""} ${streak === 1 ? "day" : "days"}`} />
              <Stat label="Busiest hour" value={sum(daily) > 0 ? hourName(byHour.indexOf(Math.max(...byHour))) : "—"} />
            </div>
            <div role="img" aria-label="Prompts by weekday and hour" className="font-mono text-[11px] text-muted-foreground">
              <div className={ROW}>
                <span />
                <span className="flex">
                  {HOURS.map((hour) => <span key={hour} className="flex-1 text-center">{hour % 3 === 0 ? `${hour % 12 || 12}${hour < 12 ? "a" : "p"}` : ""}</span>)}
                </span>
                <span />
              </div>
              {WEEKDAYS.map((weekday, day) => (
                <div key={weekday} className={ROW} style={{ height: 30 }}>
                  <span className="text-foreground">{weekday}</span>
                  <span className="relative flex h-full items-center">
                    <span className="absolute inset-x-0 h-px bg-border/60" />
                    {HOURS.map((hour) => {
                      const count = hours[day * 24 + hour]!;
                      return (
                        <span key={hour} className="relative flex flex-1 justify-center" title={`${weekday} ${hourName(hour)}: ${n(count)} prompts`}>
                          {count > 0 ? <span className="aspect-square max-w-[26px] rounded-full bg-primary" style={{ width: `${12 + 80 * Math.sqrt(count / max)}%`, opacity: 0.3 + 0.7 * (count / max) }} /> : <span className="h-4 w-full" />}
                        </span>
                      );
                    })}
                  </span>
                  <span className="text-right tabular-nums">{n(sum(hours.slice(day * 24, day * 24 + 24)))}</span>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Bigger dots mean more prompts in that hour.{sum(daily) > 0 ? ` Quietest stretch: ${hourName(quiet)} to ${hourName((quiet + 5) % 24)}.` : ""}
            </p>
          </>
        );
      }}
    </UsageSection>
  );
}
