import { useId, useState } from "react";
import { PERSONAL_PROJECT_ID } from "@cloudroom/domain";
import type { SystemSkillUsageResponse } from "@cloudroom/server-contract";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { RangeToggle, Stat } from "@/components/settings/UsageSection";
import { SettingsSection } from "@/components/ui/settings-section.js";
import { useProjectSkills } from "@/hooks/queries/skills-queries";
import { useSkillUsage } from "@/hooks/queries/system-queries";

type Range = "30" | "90" | "365";
type UsedSkill = SystemSkillUsageResponse["skills"][number];

const RANGES: { value: Range; label: string }[] = [
  { value: "30", label: "30d" },
  { value: "90", label: "90d" },
  { value: "365", label: "1y" },
];
const ROW_PX = 31;
/** How many rows tall a ridge at the overall peak is. */
const OVERLAP = 2.35;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** `plugin:name` → `name`, matching the server's run names. */
const skillName = (name: string) =>
  name.slice(name.lastIndexOf(":") + 1).trim();

/** Gaussian smoothing; wider for longer ranges so a year still reads as waves. */
export function smoothSeries(values: readonly number[]): number[] {
  const sigma = Math.max(1.2, values.length / 40);
  const reach = Math.ceil(sigma * 3);
  return values.map((_, index) => {
    let sum = 0;
    let weight = 0;
    for (let offset = -reach; offset <= reach; offset += 1) {
      const value = values[index + offset];
      if (value === undefined) continue;
      const k = Math.exp(-(offset * offset) / (2 * sigma * sigma));
      sum += value * k;
      weight += k;
    }
    return weight === 0 ? 0 : sum / weight;
  });
}

/** Used skills (most used first, from the server) plus installed ones never used. */
export function splitSkills(
  used: readonly UsedSkill[],
  installedNames: readonly string[],
): { used: readonly UsedSkill[]; unused: string[] } {
  const usedNames = new Set(used.map((skill) => skill.name));
  const unused = [...new Set(installedNames.map(skillName))]
    .filter((name) => name.length > 0 && !usedNames.has(name))
    .sort((a, b) => a.localeCompare(b));
  return { used, unused };
}

export function busiestWeekday(
  used: readonly UsedSkill[],
  startDate: string,
): string | null {
  const totals = new Array<number>(7).fill(0);
  const firstWeekday = new Date(`${startDate}T00:00:00Z`).getUTCDay();
  for (const skill of used) {
    skill.daily.forEach((count, day) => {
      totals[(firstWeekday + day) % 7]! += count;
    });
  }
  const best = Math.max(...totals);
  return best > 0 ? WEEKDAYS[totals.indexOf(best)]! : null;
}

/** Monotone cubic ridge line and closed cutout area, scaled into a 1000×100 viewBox. */
function ridgePaths(
  values: readonly number[],
  peak: number,
  scale = 1,
): { line: string; area: string; maxRatio: number } {
  const n = values.length;
  const last = Math.max(n - 1, 1);
  const xs = values.map((_, i) => (i / last) * 1000);
  const ratios = values.map((value) => (value * scale) / peak);
  // Leave 4 units of headroom so the highest summit never clips at y = 0.
  const ys = ratios.map((ratio) => 100 - ratio * 96);
  const maxRatio = Math.max(...ratios, 0);
  if (n < 2) {
    const line = "M0,100 L1000,100";
    return { line, area: `${line} L1000,100 L0,100 Z`, maxRatio };
  }

  const dx: number[] = [];
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx[i] = xs[i + 1]! - xs[i]!;
    slopes[i] = (ys[i + 1]! - ys[i]!) / dx[i]!;
  }
  const tangents = new Array<number>(n).fill(0);
  tangents[0] = Math.abs(slopes[0]!) < 1e-6 ? 0 : slopes[0]!;
  tangents[n - 1] = Math.abs(slopes[n - 2]!) < 1e-6 ? 0 : slopes[n - 2]!;
  for (let i = 1; i < n - 1; i += 1) {
    if (slopes[i - 1]! * slopes[i]! > 0) {
      const avg = (slopes[i - 1]! + slopes[i]!) / 2;
      const cap = 3 * Math.min(Math.abs(slopes[i - 1]!), Math.abs(slopes[i]!));
      tangents[i] = Math.sign(avg) * Math.min(Math.abs(avg), cap);
    }
  }

  let line = `M${xs[0]!.toFixed(2)},${ys[0]!.toFixed(2)}`;
  for (let i = 0; i < n - 1; i += 1) {
    const h = dx[i]! / 3;
    const c1y = Math.min(100, ys[i]! + tangents[i]! * h);
    const c2y = Math.min(100, ys[i + 1]! - tangents[i + 1]! * h);
    line += ` C${(xs[i]! + h).toFixed(2)},${c1y.toFixed(2)} ${(xs[i + 1]! - h).toFixed(2)},${c2y.toFixed(2)} ${xs[i + 1]!.toFixed(2)},${ys[i + 1]!.toFixed(2)}`;
  }
  return { line, area: `${line} L1000,100 L0,100 Z`, maxRatio };
}

const ROW_GRID = "grid grid-cols-[11rem_1fr_3.5rem] items-end gap-3";

// Topographic contour ridgeline (design 1, David 2026-11-21).
function SkillRidges({
  used,
  unused,
  days,
}: {
  used: readonly UsedSkill[];
  unused: readonly string[];
  days: number;
}) {
  const uid = useId();
  const curves = used.map((skill) => smoothSeries(skill.daily));
  const peak = Math.max(...curves.flat(), 0.0001);
  const ticks = [
    days - 1,
    Math.round((days - 1) * (2 / 3)),
    Math.round((days - 1) / 3),
    0,
  ];
  return (
    <div role="list" aria-label="Skill usage by day">
      <div
        className={cn(
          ROW_GRID,
          "sticky top-0 z-10 items-center bg-background py-2 text-[11px] text-muted-foreground",
        )}
      >
        <span>Skill</span>
        <span className="flex justify-between font-mono">
          {ticks.map((ago) => (
            <span key={ago}>{ago === 0 ? "today" : `${ago}d ago`}</span>
          ))}
        </span>
        <span className="text-right">Runs</span>
      </div>
      <div className="relative" style={{ paddingTop: ROW_PX * (OVERLAP - 1) }}>
        {/* Interior vertical guides aligned with the two middle ticks. */}
        <div
          aria-hidden
          className={cn(ROW_GRID, "pointer-events-none absolute inset-0")}
        >
          <span />
          <span className="relative block h-full">
            {[33.333, 66.667].map((pct) => (
              <span
                key={pct}
                className="absolute inset-y-0 w-px border-l border-dashed border-foreground/[0.07]"
                style={{ left: `${pct}%` }}
              />
            ))}
          </span>
          <span />
        </div>
        {used.map((skill, index) => {
          const curve = curves[index]!;
          const ridge = ridgePaths(curve, peak);
          const echoHigh =
            ridge.maxRatio > 0.16 ? ridgePaths(curve, peak, 0.64) : null;
          const echoLow =
            ridge.maxRatio > 0.32 ? ridgePaths(curve, peak, 0.34) : null;
          const crestId = `${uid}-c-${index}`;
          const innerId = `${uid}-i-${index}`;
          const isHighPeak = ridge.maxRatio > 0.45;
          return (
            <div
              key={skill.name}
              role="listitem"
              title={`${skill.name}: ${skill.total} runs`}
              className={ROW_GRID}
              style={{ height: ROW_PX }}
            >
              <span
                className={cn(
                  "truncate pb-1 text-right font-mono text-xs",
                  isHighPeak ? "text-foreground" : "text-foreground/78",
                )}
              >
                {skill.name}
              </span>
              <span className="relative h-full">
                <svg
                  aria-hidden
                  viewBox="0 0 1000 100"
                  preserveAspectRatio="none"
                  className="pointer-events-none absolute inset-x-0 bottom-0 w-full overflow-visible"
                  style={{ height: ROW_PX * OVERLAP }}
                >
                  <defs>
                    {/* Height-mapped crest: summits glow primary, slopes cool to foreground, zeros fade into the baseline. */}
                    <linearGradient
                      id={crestId}
                      gradientUnits="userSpaceOnUse"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="100"
                    >
                      <stop
                        offset="0%"
                        stopColor="var(--primary)"
                        stopOpacity="1"
                      />
                      <stop
                        offset="34%"
                        stopColor="var(--primary)"
                        stopOpacity="0.96"
                      />
                      <stop
                        offset="60%"
                        stopColor="var(--foreground)"
                        stopOpacity="0.86"
                      />
                      <stop
                        offset="95%"
                        stopColor="var(--foreground)"
                        stopOpacity="0.54"
                      />
                      <stop
                        offset="98.6%"
                        stopColor="var(--foreground)"
                        stopOpacity="0"
                      />
                      <stop
                        offset="100%"
                        stopColor="var(--foreground)"
                        stopOpacity="0"
                      />
                    </linearGradient>
                    {echoHigh ? (
                      <linearGradient
                        id={innerId}
                        gradientUnits="userSpaceOnUse"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="100"
                      >
                        <stop
                          offset="0%"
                          stopColor="var(--primary)"
                          stopOpacity="0.32"
                        />
                        <stop
                          offset="48%"
                          stopColor="var(--foreground)"
                          stopOpacity="0.22"
                        />
                        <stop
                          offset="94.5%"
                          stopColor="var(--foreground)"
                          stopOpacity="0.14"
                        />
                        <stop
                          offset="98.4%"
                          stopColor="var(--foreground)"
                          stopOpacity="0"
                        />
                        <stop
                          offset="100%"
                          stopColor="var(--foreground)"
                          stopOpacity="0"
                        />
                      </linearGradient>
                    ) : null}
                  </defs>
                  <path d={ridge.area} fill="var(--background)" />
                  <line
                    x1="0"
                    y1="100"
                    x2="1000"
                    y2="100"
                    stroke="var(--foreground)"
                    strokeOpacity={0.13}
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                  {echoHigh ? (
                    <path
                      d={echoHigh.line}
                      fill="none"
                      stroke={`url(#${innerId})`}
                      strokeWidth={1}
                      vectorEffect="non-scaling-stroke"
                    />
                  ) : null}
                  {echoLow ? (
                    <path
                      d={echoLow.line}
                      fill="none"
                      stroke={`url(#${innerId})`}
                      strokeOpacity={0.65}
                      strokeWidth={1}
                      vectorEffect="non-scaling-stroke"
                    />
                  ) : null}
                  <path
                    d={ridge.line}
                    fill="none"
                    stroke={`url(#${crestId})`}
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              </span>
              <span
                className={cn(
                  "pb-1 text-right font-mono text-xs tabular-nums",
                  isHighPeak ? "text-foreground/90" : "text-muted-foreground",
                )}
              >
                {skill.total.toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>
      {unused.length > 0 ? (
        <>
          <div className="mt-6 mb-1 text-[11px] tracking-[0.08em] text-muted-foreground uppercase">
            Never used · {unused.length}
          </div>
          {unused.map((name) => (
            <div
              key={name}
              role="listitem"
              className={ROW_GRID}
              style={{ height: ROW_PX }}
            >
              <span className="truncate pb-1 text-right font-mono text-xs text-muted-foreground">
                {name}
              </span>
              <span className="mb-1.5 border-b border-dashed border-border" />
              <span className="pb-1 text-right font-mono text-xs text-muted-foreground">
                0
              </span>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}

export function SkillUsageSection() {
  const [range, setRange] = useState<Range>("90");
  const usage = useSkillUsage(range);
  const installed = useProjectSkills(PERSONAL_PROJECT_ID);
  const data = usage.data;
  const { used, unused } = splitSkills(
    data?.skills ?? [],
    installed.data?.skills.map((skill) => skill.name) ?? [],
  );
  const total = used.reduce((sum, skill) => sum + skill.total, 0);
  // Named after the data on screen: a new range shows the last one until it loads.
  const rangeLabel =
    RANGES.find((option) => option.value === String(data?.days ?? range))
      ?.label ?? "";

  return (
    <SettingsSection
      title="Skills"
      description="Every skill, most used first. Each ridge is one skill's daily runs. Scroll down for the least used."
      action={
        <RangeToggle value={range} options={RANGES} onChange={setRange} />
      }
      plain
    >
      {usage.isError ? (
        <p className="text-sm text-muted-foreground">
          Couldn't load skill usage.
        </p>
      ) : !data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-5">
          <div className="flex gap-3">
            <Stat
              label={`Runs · ${rangeLabel}`}
              value={total.toLocaleString()}
            />
            <Stat
              label="Skills used"
              value={`${used.length} of ${used.length + unused.length}`}
            />
            <Stat
              label="Busiest day"
              value={busiestWeekday(used, data.startDate) ?? "—"}
            />
          </div>
          {used.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No skill runs in this range yet. Type / in a prompt to use one.
            </p>
          ) : null}
          <SkillRidges used={used} unused={unused} days={data.days} />
        </div>
      )}
    </SettingsSection>
  );
}
