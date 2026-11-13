import { useState } from "react";
import type { SystemUsageAnalyticsResponse } from "@cloudroom/server-contract";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { Stat, UsageSection, dayText, dayTicks, n, sum } from "@/components/settings/UsageSection";
import { useUsageAnalytics } from "@/hooks/queries/system-queries";

// Settings → Analytics → Agent hours: mirror bars (design B, David 2026-11-10).
const RANGES = ["7", "30", "90"] as const;
const PLOT_PX = 240;
const hours = (value: number) => (value >= 10 ? n(value) : value.toFixed(1));

/** Agents above the line, you below it, on one scale. The best day is named. */
function MirrorBars({ data, startDate }: { data: NonNullable<SystemUsageAnalyticsResponse["agentHours"]>; startDate: string }) {
  const { local, cloud, you } = data, days = local.length, total = local.map((value, i) => value + cloud[i]!);
  const up = Math.max(...total, 1), down = Math.max(...you, 1), px = PLOT_PX / (up + down), base = up * px;
  const leverage = (i: number) => (you[i]! > 0.5 ? total[i]! / you[i]! : 0);
  const best = total.reduce((top, _, i) => (leverage(i) > leverage(top) ? i : top), 0);
  const step = [5, 10, 20, 50, 100].find((size) => up / size < 3) ?? 200, below = [8, 4, 2, 1].find((size) => size <= down);
  const lines = [...[1, 2].map((k) => k * step).filter((value) => value <= up).map((value) => ({ value, top: base - value * px })),
    ...(below ? [{ value: below, top: base + below * px }] : [])];
  const ticks = new Map(dayTicks(startDate, days).map((tick) => [tick.i, tick.text]));
  return (
    <div>
      <div className="relative mt-16 mb-9" style={{ height: PLOT_PX }}>
        {lines.map((line) => (
          <div key={line.top} className="absolute inset-x-0 flex -translate-y-1/2 items-center" style={{ top: line.top }}>
            <span className="w-9 font-mono text-[11px] text-muted-foreground">{line.value}h</span>
            <span className="flex-1 border-t border-dashed border-border" />
          </div>
        ))}
        <div className="absolute inset-y-0 right-0 left-9 flex" style={{ gap: days <= 7 ? 16 : days <= 30 ? 6 : 2 }}>
          {total.map((agents, i) => (
            <div key={i} className="relative flex-1" title={`${dayText(startDate, i, { weekday: "short", month: "short", day: "numeric" })}: ${hours(agents)}h agents (${hours(local[i]!)}h local, ${hours(cloud[i]!)}h cloud), ${hours(you[i]!)}h you`}>
              <span className="absolute inset-x-0 bg-primary/40" style={{ top: base - 1 - agents * px, height: Math.max(0, cloud[i]! * px - 1) }} />
              <span className="absolute inset-x-0 bg-primary" style={{ top: base - 1 - local[i]! * px, height: local[i]! * px }} />
              <span className="absolute inset-x-0 bg-foreground/85" style={{ top: base + 1, height: you[i]! * px }} />
              {i === best && leverage(i) > 0 ? (
                <span className={cn("pointer-events-none absolute flex -translate-y-full flex-col font-mono text-[11px] whitespace-nowrap text-muted-foreground",
                  i < days * 0.2 ? "left-0 items-start" : i > days * 0.8 ? "right-0 items-end" : "left-1/2 -translate-x-1/2 items-center")} style={{ top: base - agents * px - 6 }}>
                  <span className="text-[13px] font-semibold text-primary">{Math.round(leverage(i))}× leverage</span>
                  {dayText(startDate, i).toLowerCase()} · {hours(agents)}h agents, {hours(you[i]!)}h you
                  <span className="mt-1 h-2.5 w-px bg-muted-foreground/50" />
                </span>
              ) : null}
              {ticks.has(i) ? <span className="absolute top-full left-1/2 mt-2 -translate-x-1/2 font-mono text-[11px] whitespace-nowrap text-muted-foreground">{ticks.get(i)}</span> : null}
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-foreground">
        {([["bg-primary", "Local agents", local], ["bg-primary/40", "Cloud agents", cloud], ["bg-foreground/85", "You", you]] as const).map(([color, label, values]) => (
          <span key={label} className="flex items-center gap-2">
            <span className={cn("size-2.5", color)} />
            {label}
            <span className="font-mono text-muted-foreground">{hours(sum(values))}h</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function AgentHoursSection() {
  const [range, setRange] = useState<(typeof RANGES)[number]>("30");
  const query = useUsageAnalytics("agentHours", range);
  return (
    <UsageSection title="Agent hours" description="Agents above the line, you below it. Same scale, so the gap is your leverage."
      ranges={RANGES} range={range} onRange={setRange} data={query.data?.agentHours && query.data} failed={query.isError}>
      {(usage) => {
        const { local, cloud, you } = usage.agentHours!, agents = local.map((value, i) => value + cloud[i]!);
        // Time in the app is only counted since the app learned to count it. Leverage skips the days before.
        const tracked = you.findIndex((value) => value > 0), yours = sum(you);
        return (
          <>
            <div className="flex gap-3">
              <Stat label={`Agent hours · ${usage.days}d`} value={hours(sum(agents))} />
              <Stat label="Your hours" value={yours > 0 ? hours(yours) : "—"} />
              <Stat label="Leverage" value={yours > 0 ? `${(sum(agents.slice(tracked)) / yours).toFixed(1)}×` : "—"} />
            </div>
            <MirrorBars data={usage.agentHours!} startDate={usage.startDate} />
          </>
        );
      }}
    </UsageSection>
  );
}
