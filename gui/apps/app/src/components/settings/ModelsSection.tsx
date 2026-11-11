import { useState } from "react";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { Stat, UsageSection, n } from "@/components/settings/UsageSection";
import { curve, smooth } from "@/components/settings/WavePlot";
import { useUsageAnalytics } from "@/hooks/queries/system-queries";

// Settings → Analytics → Models: ranked list (design B, David 2026-11-10).
const RANGES = ["30", "90", "365"] as const;
const ROW = "grid grid-cols-[8.5rem_1fr_8.25rem_3.5rem_2.75rem] items-center gap-3.5";
const SPARK_W = 132, SPARK_H = 22;
const percent = (part: number, all: number) => {
  const value = all > 0 ? (part / all) * 100 : 0;
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)}%`;
};

export function ModelsSection() {
  const [range, setRange] = useState<(typeof RANGES)[number]>("30");
  const query = useUsageAnalytics("models", range);
  return (
    <UsageSection title="Models" description="Every model, most used first. The small line is its use over the range."
      ranges={RANGES} range={range} onRange={setRange} data={query.data?.models && query.data} failed={query.isError}>
      {(usage) => {
        const { list: rows, local, cloud } = usage.models!, prompts = local + cloud, top = rows[0];
        return (
          <>
            <div className="flex gap-3">
              <Stat label={`Prompts · ${usage.days === 365 ? "1y" : `${usage.days}d`}`} value={n(prompts)} />
              <Stat label="Top model" value={top?.name ?? "—"} sub={top ? percent(top.total, prompts) : undefined} />
              <Stat label="Local / Cloud" value={prompts > 0 ? `${Math.round((local / prompts) * 100)} / ${Math.round((cloud / prompts) * 100)}%` : "—"} />
            </div>
            {top ? (
              <div role="list" aria-label="Prompts by model">
                <div className={cn(ROW, "h-7 text-[11px] text-muted-foreground")}>
                  <span>Model</span>
                  <span>Share of prompts</span>
                  <span>{usage.days === 365 ? "Last year" : `Last ${usage.days} days`}</span>
                  <span className="text-right">Prompts</span>
                  <span />
                </div>
                {rows.map((model, index) => {
                  const line = smooth(model.daily, Math.max(1, usage.days / 30)), peak = Math.max(...line, 0.001);
                  return (
                    <div key={model.name} role="listitem" className={cn(ROW, "h-8 border-t border-border font-mono text-xs")}>
                      <span className="truncate text-foreground" title={model.name}>{model.name}</span>
                      <span className="h-2.5 bg-surface-recessed">
                        <span className={cn("block h-full", index === 0 ? "bg-primary" : "bg-muted-foreground/60")} style={{ width: `${Math.max(0.4, (model.total / top.total) * 100)}%` }} />
                      </span>
                      <svg aria-hidden viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" className={cn("w-full", index === 0 ? "text-primary" : "text-foreground/70")} style={{ height: SPARK_H }}>
                        <path d={curve(line.map((value, day) => [(day / (line.length - 1)) * SPARK_W, SPARK_H - 2 - (value / peak) * (SPARK_H - 4)]))} fill="none" stroke="currentColor" strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
                      </svg>
                      <span className="text-right text-foreground tabular-nums">{n(model.total)}</span>
                      <span className="text-right text-muted-foreground tabular-nums">{percent(model.total, prompts)}</span>
                    </div>
                  );
                })}
              </div>
            ) : <p className="text-sm text-muted-foreground">No prompts in this range yet.</p>}
          </>
        );
      }}
    </UsageSection>
  );
}
