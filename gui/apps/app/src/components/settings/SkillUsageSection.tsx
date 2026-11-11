import { useState } from "react";
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
const ROW_PX = 30;
/** How many rows tall a ridge at the overall peak is. */
const OVERLAP = 2.2;
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

/** The ridge's top line, and the closed area under it. */
function ridgePaths(
  values: readonly number[],
  peak: number,
): { line: string; area: string } {
  const last = Math.max(values.length - 1, 1);
  const line = values
    .map(
      (value, x) =>
        `${x ? "L" : "M"}${x} ${(100 - (value / peak) * 100).toFixed(2)}`,
    )
    .join(" ");
  return { line, area: `${line} L${last} 100 L0 100 Z` };
}

const ROW_GRID = "grid grid-cols-[11rem_1fr_3.5rem] items-end gap-3";

function SkillRidges({
  used,
  unused,
  days,
}: {
  used: readonly UsedSkill[];
  unused: readonly string[];
  days: number;
}) {
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
      <div style={{ paddingTop: ROW_PX * (OVERLAP - 1) }}>
        {used.map((skill, index) => {
          const ridge = ridgePaths(curves[index]!, peak);
          return (
            <div
              key={skill.name}
              role="listitem"
              title={`${skill.name}: ${skill.total} runs`}
              className={ROW_GRID}
              style={{ height: ROW_PX }}
            >
              <span className="truncate pb-1 text-right font-mono text-xs text-foreground">
                {skill.name}
              </span>
              <span className="relative h-full">
                <svg
                  aria-hidden
                  viewBox={`0 0 ${Math.max(skill.daily.length - 1, 1)} 100`}
                  preserveAspectRatio="none"
                  className="pointer-events-none absolute inset-x-0 bottom-0 w-full overflow-visible"
                  style={{ height: ROW_PX * OVERLAP }}
                >
                  <path d={ridge.area} fill="var(--background)" />
                  <path
                    d={ridge.area}
                    fill="var(--primary)"
                    fillOpacity={
                      0.08 + 0.5 * (1 - index / Math.max(used.length, 1))
                    }
                  />
                  <path
                    d={ridge.line}
                    fill="none"
                    stroke="var(--primary)"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              </span>
              <span className="pb-1 text-right font-mono text-xs text-muted-foreground tabular-nums">
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
  const rangeLabel = RANGES.find((option) => option.value === String(data?.days ?? range))?.label ?? "";

  return (
    <SettingsSection
      title="Skills"
      description="Every skill, most used first. Each ridge is one skill's daily runs. Scroll down for the least used."
      action={<RangeToggle value={range} options={RANGES} onChange={setRange} />}
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
