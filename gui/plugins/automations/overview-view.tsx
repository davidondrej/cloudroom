import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  experimental_ProviderIcon as ProviderIcon,
  experimental_useProviders as useProviders,
  type PluginProvidersState,
} from "@get-bb/plugin-sdk/app";
import type {
  AutomationAgentSummary,
  AutomationReadProblem,
  AutomationResponse,
  AutomationsOverviewResponse,
  ReviewResponse,
} from "./src/rpc-types.js";
import { AutomationLifecycleControl } from "./detail-view.js";
import { ScansTabLabel, ScansView } from "./scans-view.js";
import { Icon } from "@cloudroom/shared-ui/icon";
import { DelayedLoading } from "@cloudroom/shared-ui/delayed-loading";
import { COARSE_POINTER_ICON_SIZE_SHRINK_CLASS } from "@cloudroom/shared-ui/coarse-pointer-sizing";
import {
  ResourceActionButton,
  ResourceCollectionPage,
  ResourceCollectionViewport,
  ResourceListState,
  ResourceMeta,
  ResourceRow,
  ResourceSortMenu,
} from "@cloudroom/shared-ui/resource-list";
import { Input } from "@cloudroom/shared-ui/input";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { Button } from "@cloudroom/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import {
  formatAutomationTrigger,
  isCloudWebhook,
  formatOverviewScheduleMetadata,
  formatScheduleRunTime,
  formatScheduleStatusLabel,
  formatTimeUntil,
  getOneShotLifecycle,
  matchesAutomationStatusFilters,
  oneShotLifecycleAllowsToggle,
  PERSONAL_PROJECT_ID,
} from "./lib/format-schedule.js";
import { AutomationMetadataItem } from "./metadata.js";
import {
  LoopTemplatesView,
  type LoopTemplatesState,
  LOOP_PRIORITY_STYLE,
  LoopGroupDivider,
  LoopSideMenu,
  type LoopMenuItem,
} from "./templates-view.js";
import {
  LoopLimitSwitch,
  type CloudAutomation,
  type CloudAutomationActions,
} from "./cloud-view.js";
import { CloudLoopDialog } from "./loop-dialog.js";
import {
  LoopReviewView,
  OFFSCREEN_ROW_CLASSES,
  reviewableItems,
  ReviewToolbar,
  type ReviewFilter,
  type ReviewLayout,
} from "./review-view.js";

export const CREATE_AUTOMATION_PROMPT = "Create a new Cloudroom loop to ";
// The New button's menu (ADR 0262, design 1): pick the trigger, then finish the sentence in chat.
const NEW_LOOP_OPTIONS = [
  {
    label: "On a schedule",
    description: "Every hour, every weekday at 9…",
    icon: "TimeSchedule",
    prompt: "Create a new Cloudroom loop that runs on a schedule to ",
  },
  {
    label: "Once",
    description: "At a time, or in 30 minutes",
    icon: "Calendar",
    prompt: "Create a new Cloudroom loop that runs once to ",
  },
  {
    label: "On a webhook",
    description: "Runs when a URL gets a POST",
    icon: "Link",
    prompt: "Create a new Cloudroom loop that runs on a webhook to ",
    isNew: true,
  },
  {
    label: "Describe it in chat",
    description: "An agent sets it up for you",
    icon: "SideChat",
    prompt: CREATE_AUTOMATION_PROMPT,
    divider: true,
  },
] as const;

type OverviewEntry = AutomationsOverviewResponse["automations"][number];
type AutomationSortMode = "next" | "project" | "alpha";
type ProviderList = PluginProvidersState["providers"];
type AutomationSortDirection = "asc" | "desc";
export type AutomationCollectionMode = "installed" | "review" | "templates" | "scans";

export interface LoopReviewState {
  data: ReviewResponse | null;
  error: string | null;
  onRetry: () => void;
  onOpenThread: (threadId: string) => void;
  onMark: (itemIds: string[], reviewed: boolean) => void;
}
type ReadableOverviewAutomation =
  | AutomationResponse
  | Extract<AutomationReadProblem, { problem: "missing-agent-prompt" }>;

interface AutomationDetailRoute {
  projectId: string;
  automationId: string;
}

interface AutomationDetailNavigationOptions {
  editing?: boolean;
}

function routeOf(
  automation: Pick<AutomationResponse, "id" | "projectId">,
): AutomationDetailRoute {
  return { projectId: automation.projectId, automationId: automation.id };
}

const LOOP_PRIORITIES = [1, 2, 3, 4] as const;

function cloudLoopKey(projectId: string | null | undefined, name: string) {
  return `cloud:${projectId ?? ""}:${name}`;
}

const cloudKey = (automation: CloudAutomation) =>
  cloudLoopKey(automation.project_id, automation.name);
type LoopPriority = (typeof LOOP_PRIORITIES)[number];
const DEFAULT_LOOP_PRIORITY: LoopPriority = 3;
/** Priorities just picked, shown until the saved loops catch up; a failed save drops its pick. */
function useChosenPriorities(local: unknown, cloud: unknown) {
  const [chosen, setChosen] = useState<Record<string, LoopPriority>>({});
  useEffect(() => setChosen({}), [local, cloud]);
  const choose = useCallback(
    (key: string, priority: LoopPriority, save: () => Promise<void>) => {
      setChosen((current) => ({ ...current, [key]: priority }));
      save().catch(() => setChosen(({ [key]: _dropped, ...rest }) => rest));
    },
    [],
  );
  return { chosen, choose };
}

function LoopPriorityMenu({
  priority,
  name,
  onChange,
}: {
  priority: LoopPriority;
  name: string;
  onChange: (priority: LoopPriority) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-row-action
          aria-label={`Priority ${priority} for ${name}. Change priority`}
          className="flex size-6 cursor-pointer items-center justify-center rounded-full hover:bg-state-hover"
        >
          <span
            className={cn(
              "size-4 rounded-full border-2",
              LOOP_PRIORITY_STYLE[priority].ring,
            )}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-40"
        onClick={(event) => event.stopPropagation()}
      >
        {LOOP_PRIORITIES.map((level) => (
          <DropdownMenuItem
            key={level}
            className="gap-2"
            onSelect={() => onChange(level)}
          >
            <span
              className={cn(
                "size-3.5 rounded-full border-2",
                LOOP_PRIORITY_STYLE[level].ring,
              )}
            />
            Priority {level}
            {level === priority ? (
              <Icon name="Check" className="ml-auto size-3.5" aria-hidden />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function formatModelName(model: string): string {
  const [, base = model, context] = /^(.+?)(?:\[(\w+)\])?$/u.exec(model) ?? [];
  const name = (base.split("/").at(-1) ?? base)
    .replace(/^claude-/u, "")
    .split("-")
    .map((part) =>
      part === "gpt" ? "GPT" : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ")
    .replace(/(\d) (?=\d)/gu, "$1.")
    .replace(/^GPT /u, "GPT-");
  return context === undefined ? name : `${name} (${context.toUpperCase()})`;
}

function automationAgents(
  automation: AutomationResponse,
  scriptAgents: readonly AutomationAgentSummary[] | undefined,
): readonly AutomationAgentSummary[] {
  const { execution } = automation;
  if (execution.mode === "script") return scriptAgents ?? [];
  return [
    {
      providerId: execution.providerId,
      model: execution.model,
      reasoningLevel: execution.reasoningLevel,
    },
  ];
}

function AutomationAgentLine({
  agents,
  providers,
  compact = false,
  quiet = false,
}: {
  agents: readonly AutomationAgentSummary[];
  providers: ProviderList;
  /** Logo instead of the harness name, for narrow cards. */
  compact?: boolean;
  quiet?: boolean;
}) {
  if (agents.length === 0) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon
          name="ComputerTerminal01"
          className="size-3.5 shrink-0"
          aria-hidden
        />
        Script
      </span>
    );
  }
  const providerIds = [...new Set(agents.map((agent) => agent.providerId))];
  const models = [
    ...new Set(
      agents.flatMap((agent) =>
        agent.model === null || agent.model === "default"
          ? []
          : [formatModelName(agent.model)],
      ),
    ),
  ];
  const levels = [
    ...new Set(
      agents.flatMap((agent) =>
        agent.reasoningLevel === null ? [] : [agent.reasoningLevel],
      ),
    ),
  ];
  const providerOf = (id: string) => providers.find((info) => info.id === id);
  const levelLabel = (level: string) =>
    providers
      .flatMap((info) => info.reasoningLevels ?? [])
      .find((option) => option.id === level)?.label ?? level;
  const level = levels.map(levelLabel).join(" ⇄ ");
  const parts = [
    compact
      ? ""
      : providerIds
          .map((id) =>
            id === null ? "Agent" : (providerOf(id)?.displayName ?? id),
          )
          .join(" ⇄ "),
    models.join(" ⇄ "),
    level,
  ].filter((part) => part !== "");
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="flex shrink-0 items-center">
        {providerIds.map((id, index) =>
          id === null ? (
            <Icon key="default" name="Bot" className="size-3.5" aria-hidden />
          ) : (
            <ProviderIcon
              key={id}
              providerKind="agent"
              provider={providerOf(id) ?? { id }}
              fallback="Bot"
              className={cn("size-3.5", index > 0 && "-ml-1")}
              aria-hidden
            />
          ),
        )}
      </span>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <span aria-hidden className="text-muted-foreground/40">
              ·
            </span>
          ) : null}
          <span
            className={cn(
              "min-w-0 truncate",
              part === level &&
                (quiet
                  ? "text-muted-foreground"
                  : part === levelLabel("max") && "text-primary"),
            )}
          >
            {part}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

function automationNextRunText(
  automation: AutomationResponse,
  now: number,
): string {
  if (automation.lastRunStatus === "running") return "Running";
  const metadata = formatOverviewScheduleMetadata({
    enabled: automation.enabled,
    nextRunAt: automation.nextRunAt,
    trigger: automation.trigger,
    runCount: automation.runCount,
    lastRunStatus: automation.lastRunStatus,
    now,
  });
  if (metadata?.isNextRun && automation.nextRunAt !== null) {
    return formatTimeUntil(automation.nextRunAt, now);
  }
  return formatScheduleStatusLabel({ ...automation, now }).split(" — ")[0]!;
}

function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function automationProjectLabel(
  project: OverviewEntry["project"],
): string {
  return project.name;
}

function applyAutomationSortDirection(
  result: number,
  direction: AutomationSortDirection,
): number {
  return direction === "asc" ? result : -result;
}

function automationLifecycleSortRank(automation: AutomationResponse): number {
  const oneShotLifecycle = getOneShotLifecycle({
    enabled: automation.enabled,
    trigger: automation.trigger,
    runCount: automation.runCount,
    lastRunStatus: automation.lastRunStatus,
  });
  if (oneShotLifecycle === "completed") return 3;
  if (!automation.enabled && oneShotLifecycle !== "running") return 2;
  if (oneShotLifecycle === "scheduled") return 1;
  return 0;
}

function AutomationRowMetadata({
  automation,
  project,
}: {
  automation: ReadableOverviewAutomation | null;
  project: OverviewEntry["project"];
}) {
  const projectLabel = automationProjectLabel(project);
  const personalProject = project.id === PERSONAL_PROJECT_ID;
  const scheduleMetadata =
    automation === null
      ? null
      : formatOverviewScheduleMetadata({
          enabled: automation.enabled,
          nextRunAt: automation.nextRunAt,
          trigger: automation.trigger,
          runCount: automation.runCount,
          lastRunStatus: automation.lastRunStatus,
        });
  return (
    <ResourceMeta
      items={[
        <AutomationMetadataItem
          icon="Folder"
          iconLabel={personalProject ? `Project: ${projectLabel}` : "Project"}
          title={projectLabel}
        >
          {projectLabel}
        </AutomationMetadataItem>,
        automation !== null ? (
          <AutomationMetadataItem icon="DateTime" iconLabel="Schedule">
            {formatAutomationTrigger(automation.trigger)}
          </AutomationMetadataItem>
        ) : null,
        automation !== null && scheduleMetadata !== null ? (
          <AutomationMetadataItem
            icon={scheduleMetadata.isNextRun ? "CalendarCheckOut02" : undefined}
            iconLabel={scheduleMetadata.isNextRun ? "Next run" : undefined}
          >
            {scheduleMetadata.text}
          </AutomationMetadataItem>
        ) : null,
        automation === null ? "The stored configuration cannot be read." : null,
      ]}
    />
  );
}

function FailedBadge({
  error,
  waiting = false,
}: {
  error: string | null;
  waiting?: boolean;
}) {
  return (
    <span
      title={error ?? undefined}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 self-center whitespace-nowrap rounded-full px-2 py-0.5 text-2xs font-medium",
        waiting
          ? "bg-muted text-muted-foreground"
          : "bg-destructive/10 text-destructive-text",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          waiting ? "bg-muted-foreground/50" : "bg-destructive",
        )}
        aria-hidden
      />
      {waiting ? "Waiting" : "Failed"}
    </span>
  );
}

function NeedsYouBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 self-center whitespace-nowrap rounded-full bg-warning/10 px-2 py-0.5 text-2xs font-medium text-warning-text">
      <span className="size-1.5 rounded-full bg-warning" aria-hidden />
      {count} need{count === 1 ? "s" : ""} you
    </span>
  );
}

type OrbitTick = "done" | "needs-you" | "failed" | null;

const ORBIT_SIZE = 236;
const ORBIT_TICKS = 40;
const ORBIT_TICK_COLOR = {
  done: "var(--primary)",
  "needs-you": "var(--warning-text)",
  failed: "var(--destructive-text)",
};

function cronFieldCount(spec: string, min: number, max: number): number {
  let count = 0;
  for (let value = min; value <= max; value++) {
    const matches = spec.split(",").some((part) => {
      const [range = "", stepText] = part.split("/");
      const step = stepText === undefined ? 1 : Number(stepText);
      const [from = NaN, to] =
        range === "*" ? [min, max] : range.split("-").map(Number);
      const end = to ?? (stepText === undefined ? from : max);
      return value >= from && value <= end && (value - from) % step === 0;
    });
    if (matches) count++;
  }
  return count;
}

function cronRunsPerDay(cron: string | null): number {
  const [minute, hour, day, , weekday] = cron?.trim().split(/\s+/) ?? [];
  if (minute === undefined || hour === undefined || weekday === undefined) {
    return 0;
  }
  return (
    cronFieldCount(minute, 0, 59) *
    cronFieldCount(hour, 0, 23) *
    (day === "*" || day === undefined ? 1 : cronFieldCount(day, 1, 31) / 31) *
    (weekday === "*" ? 1 : cronFieldCount(weekday, 0, 6) / 7)
  );
}

function orbitArc(radius: number, from: number, to: number) {
  const center = ORBIT_SIZE / 2;
  const point = (degrees: number) => {
    const radians = ((degrees - 90) * Math.PI) / 180;
    return `${(center + radius * Math.cos(radians)).toFixed(1)} ${(center + radius * Math.sin(radians)).toFixed(1)}`;
  };
  return `M${point(from)}A${radius} ${radius} 0 0 1 ${point(to)}`;
}

function OrbitStat({
  label,
  value,
  hint,
  bar,
  onClick,
}: {
  label: string;
  value: ReactNode;
  hint: ReactNode;
  bar: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={onClick === undefined}
      onClick={onClick}
      className="min-w-0 rounded-lg text-left enabled:cursor-pointer enabled:hover:opacity-80"
    >
      <div className="truncate text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 font-mono text-[26px] font-semibold tabular-nums leading-tight">
        {value}
      </div>
      <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-foreground/10">
        {bar}
      </div>
      <div className="mt-2 truncate text-xs text-muted-foreground">{hint}</div>
    </button>
  );
}

function LoopOrbit({
  rings,
  running,
  cloud,
  runsPerDay,
  totalRuns,
  ownPercent,
  needsYou,
  failedToday,
  next,
  now,
  onReview,
}: {
  rings: OrbitTick[][];
  running: number;
  cloud: number;
  runsPerDay: number;
  totalRuns: number;
  ownPercent: number | null;
  needsYou: number;
  failedToday: number;
  next: { name: string; at: number } | null;
  now: number;
  onReview?: () => void;
}) {
  const center = ORBIT_SIZE / 2;
  const span = 360 / ORBIT_TICKS;
  return (
    <section
      aria-label="Loops at a glance"
      className="relative flex items-center gap-10 overflow-hidden rounded-2xl border border-foreground/10 bg-linear-to-b from-foreground/[0.035] to-foreground/[0.012] px-8 pt-7 pb-11 @max-2xl:flex-col @max-2xl:items-stretch"
    >
      <div className="relative mx-auto size-[236px] shrink-0">
        <svg
          viewBox={`0 0 ${ORBIT_SIZE} ${ORBIT_SIZE}`}
          className="size-full overflow-visible"
          aria-hidden
        >
          <defs>
            <radialGradient id="loop-orbit-glow">
              <stop offset="0" stopColor="var(--primary)" stopOpacity="0.16" />
              <stop offset="1" stopColor="var(--primary)" stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle
            cx={center}
            cy={center}
            r={center}
            fill="url(#loop-orbit-glow)"
          />
          {rings.map((ticks, ring) =>
            ticks.map((tick, index) => (
              <path
                key={`${ring}-${index}`}
                d={orbitArc(
                  center - 12 - ring * 13,
                  index * span + 1.5,
                  (index + 1) * span - 1.5,
                )}
                fill="none"
                strokeWidth={6}
                stroke={
                  tick === null ? "var(--foreground)" : ORBIT_TICK_COLOR[tick]
                }
                strokeOpacity={
                  tick === null ? 0.08 : 0.3 + (0.7 * index) / (ORBIT_TICKS - 1)
                }
              />
            )),
          )}
          <circle
            cx={center}
            cy={2}
            r={4}
            fill="var(--primary)"
            style={{ filter: "drop-shadow(0 0 6px var(--primary))" }}
          />
        </svg>
        <div className="absolute inset-0 grid place-items-center text-center">
          <div>
            <div className="font-mono text-[27px] font-semibold tabular-nums">
              {Math.round(runsPerDay).toLocaleString("en-US")}
            </div>
            <div className="mt-0.5 text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
              Runs a day
            </div>
          </div>
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.08em] text-primary-text">
          <span className="size-1.5 rounded-full bg-primary shadow-[0_0_10px_var(--primary)]" />
          LIVE
        </div>
        <div className="mt-3.5 text-[40px] font-semibold leading-none tracking-[-0.035em]">
          {running} {running === 1 ? "loop" : "loops"} running
        </div>
        <div className="mt-2.5 text-sm text-muted-foreground">
          {cloud} in Cloud · {running - cloud} on this Mac · every ring is a
          loop, every tick a run
        </div>
        <div className="mt-7 grid grid-cols-3 gap-6">
          <OrbitStat
            label="Runs so far"
            value={totalRuns.toLocaleString("en-US")}
            hint="All time, all loops"
            bar={
              <div className="h-full bg-linear-to-r from-transparent to-primary" />
            }
          />
          <OrbitStat
            label="On their own"
            value={ownPercent === null ? "—" : `${ownPercent}%`}
            hint="No human needed"
            bar={
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${ownPercent ?? 0}%` }}
              />
            }
          />
          <OrbitStat
            label="Need you"
            value={<span className="text-warning-text">{needsYou}</span>}
            hint={
              <span
                className={
                  failedToday > 0 ? "text-destructive-text" : undefined
                }
              >
                {failedToday} failed today
              </span>
            }
            bar={
              <div
                className="h-full rounded-full bg-warning-text"
                style={{
                  width: `${ownPercent === null ? 0 : 100 - ownPercent}%`,
                }}
              />
            }
            onClick={onReview}
          />
        </div>
        {next ? (
          <div className="mt-6 truncate border-t border-foreground/10 pt-4 text-sm text-muted-foreground">
            Next up:{" "}
            <span className="font-medium text-foreground">
              {next.name} {formatTimeUntil(next.at, now)}
            </span>
          </div>
        ) : null}
      </div>
      <div className="absolute bottom-4 left-8 flex gap-3.5 text-[11px] text-muted-foreground">
        {(
          [
            ["On its own", "bg-primary"],
            ["Needed you", "bg-warning-text"],
            ["Failed", "bg-destructive-text"],
          ] as const
        ).map(([label, color]) => (
          <span key={label} className="flex items-center gap-1.5">
            <span className={cn("h-[3px] w-2 rounded-full", color)} />
            {label}
          </span>
        ))}
      </div>
    </section>
  );
}

function LoopLocation({ cloud }: { cloud: boolean }) {
  return (
    <>
      <span
        className={cn(
          "flex shrink-0 items-center gap-1",
          cloud ? "text-primary-text" : "text-muted-foreground",
        )}
      >
        <Icon
          name={cloud ? "Cloud" : "Laptop"}
          className="size-3.5"
          aria-hidden
        />
        {cloud ? "Cloud" : "Local"}
      </span>
      <span aria-hidden className="text-muted-foreground/40">
        ·
      </span>
    </>
  );
}

type RunTick = Exclude<OrbitTick, null>;

const CARD_RUNS = 10;
const RUN_DOT = {
  done: "bg-foreground/70",
  "needs-you": "bg-warning-text/80",
  failed: "bg-destructive-text/80",
} as const;

function LoopRunDots({ runs }: { runs: readonly RunTick[] }) {
  const last = runs.slice(-CARD_RUNS);
  const done = runs.filter((run) => run === "done").length;
  return (
    <>
      <span
        role="img"
        aria-label={`Last ${last.length} runs`}
        className="flex shrink-0 items-center gap-1"
      >
        {[...Array<null>(CARD_RUNS - last.length).fill(null), ...last].map(
          (run, index) => (
            <span
              key={index}
              className={cn(
                "size-1.5 rounded-full",
                run === null ? "bg-foreground/10" : RUN_DOT[run],
              )}
            />
          ),
        )}
      </span>
      {runs.length >= 3 ? (
        <span className="tabular-nums">
          {Math.round((100 * done) / runs.length)}%
        </span>
      ) : null}
    </>
  );
}

function LoopRepoTag({
  projectId,
  label,
  github,
}: {
  projectId: string | null | undefined;
  label: string;
  github: string | null;
}) {
  return (
    <>
      <span aria-hidden className="text-muted-foreground/40">
        ·
      </span>
      <AutomationMetadataItem
        icon={github ? "GithubLogo" : "Laptop"}
        iconLabel={
          github
            ? "GitHub repo"
            : projectId === PERSONAL_PROJECT_ID
              ? `Project: ${label}`
              : "Local project"
        }
        title={github ?? label}
      >
        {label}
      </AutomationMetadataItem>
    </>
  );
}

function LoopBadges({
  status,
  lastError,
  needsYou,
}: {
  status: AutomationResponse["lastRunStatus"];
  lastError: string | null;
  needsYou: number;
}) {
  const failed = status === "failed" || (status === "skipped" && !!lastError);
  if (!failed && needsYou === 0) return null;
  return (
    <span className="relative flex shrink-0 items-center gap-1.5">
      {failed ? (
        <FailedBadge error={lastError} waiting={status === "skipped"} />
      ) : null}
      <NeedsYouBadge count={needsYou} />
    </span>
  );
}

function LoopCard({
  name,
  cloud,
  agent,
  badges,
  report,
  schedule,
  nextRun,
  nextRunAt,
  muted,
  repo,
  runs,
  actions,
  toggle,
  onOpen,
}: {
  name: string;
  cloud: boolean;
  agent: ReactNode;
  badges: ReactNode;
  report: string | null;
  schedule: string;
  nextRun: string;
  nextRunAt: number | null;
  muted: boolean;
  repo?: ReactNode;
  runs: readonly RunTick[];
  actions?: ReactNode;
  toggle: ReactNode;
  onOpen: () => void;
}) {
  return (
    <div
      data-loop-card=""
      className={cn(
        "group/card relative flex min-w-0 flex-col rounded-xl border border-foreground/10 bg-surface-raised px-[18px] pt-[18px] pb-4 transition-colors hover:border-foreground/20 [contain-intrinsic-size:auto_220px] [content-visibility:auto]",
        muted && "opacity-60",
      )}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 cursor-pointer text-left text-lg font-semibold leading-snug tracking-[-0.015em] text-foreground after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-1 focus-visible:after:ring-ring"
        >
          <span className="line-clamp-2">{name}</span>
        </button>
        <div className="relative flex shrink-0 items-center gap-0.5">
          {actions ? (
            <span className="flex items-center opacity-0 transition-opacity group-focus-within/card:opacity-100 group-hover/card:opacity-100">
              {actions}
            </span>
          ) : null}
          {toggle}
        </div>
      </div>
      <div className="mt-2.5 flex min-w-0 items-center gap-2">
        <span className="inline-flex min-w-0 items-center rounded-full border border-foreground/10 bg-foreground/[0.06] py-1 pr-2.5 pl-2 text-[12.5px] font-medium text-foreground/85">
          {agent}
        </span>
        {badges}
      </div>
      <p
        className={cn(
          "mt-3 line-clamp-2 text-[13.5px] leading-normal",
          report === null
            ? "italic text-subtle-foreground"
            : "text-muted-foreground",
        )}
      >
        {report ?? "No reviewed runs yet."}
      </p>
      <div className="flex-1" />
      <div className="mt-3 flex min-w-0 items-center gap-1.5 text-xs text-subtle-foreground">
        <LoopLocation cloud={cloud} />
        <span className="min-w-0 truncate">{schedule}</span>
        {repo}
      </div>
      <div className="mt-3 flex items-center gap-2 border-t border-foreground/[0.06] pt-3 text-xs text-subtle-foreground">
        <LoopRunDots runs={runs} />
        <span
          className={cn(
            "relative ml-auto whitespace-nowrap font-mono tabular-nums",
            nextRun === "Running"
              ? "font-sans font-medium text-primary-text"
              : "text-muted-foreground",
          )}
          title={
            nextRunAt === null ? undefined : formatScheduleRunTime(nextRunAt)
          }
        >
          {nextRun}
        </span>
      </div>
    </div>
  );
}

export function OverviewRow({
  automation,
  scriptAgents,
  providers,
  now,
  needsYou = 0,
  leading,
  repo,
  runs = [],
  report = null,
  onNavigate,
  onEnabledChange,
}: {
  automation: AutomationResponse;
  scriptAgents: readonly AutomationAgentSummary[] | undefined;
  providers: ProviderList;
  now: number;
  needsYou?: number;
  leading?: ReactNode;
  repo?: ReactNode;
  runs?: readonly RunTick[];
  report?: string | null;
  onNavigate: (route: AutomationDetailRoute) => void;
  onEnabledChange: (
    enabled: boolean,
    route: AutomationDetailRoute,
  ) => Promise<void>;
}) {
  const [togglePending, setTogglePending] = useState(false);
  const route = routeOf(automation);
  const oneShotLifecycle = getOneShotLifecycle({
    enabled: automation.enabled,
    trigger: automation.trigger,
    runCount: automation.runCount,
    lastRunStatus: automation.lastRunStatus,
  });
  const lifecycleLocked = !oneShotLifecycleAllowsToggle(oneShotLifecycle);

  return (
    <LoopCard
      name={automation.name}
      cloud={false}
      agent={
        <AutomationAgentLine
          agents={automationAgents(automation, scriptAgents)}
          providers={providers}
          compact
          quiet
        />
      }
      badges={
        <LoopBadges
          status={automation.lastRunStatus}
          lastError={automation.lastError}
          needsYou={needsYou}
        />
      }
      report={report}
      schedule={formatAutomationTrigger(automation.trigger)}
      nextRun={automationNextRunText(automation, now)}
      nextRunAt={automation.nextRunAt}
      muted={lifecycleLocked || !automation.enabled}
      repo={repo}
      runs={runs}
      actions={leading}
      onOpen={() => onNavigate(route)}
      toggle={
        <AutomationLifecycleControl
          checked={automation.enabled && !lifecycleLocked}
          disabled={lifecycleLocked || togglePending}
          disabledReason={
            lifecycleLocked
              ? oneShotLifecycle === "expired"
                ? "Missed its run time. Edit to reschedule."
                : "Already ran. Edit to reschedule."
              : undefined
          }
          label={`${automation.enabled ? "Disable" : "Enable"} ${automation.name}`}
          onCheckedChange={(enabled) => {
            setTogglePending(true);
            void onEnabledChange(enabled, route).finally(() =>
              setTogglePending(false),
            );
          }}
        />
      }
    />
  );
}

export function CloudAutomationRow({
  automation,
  providers,
  now,
  needsYou = 0,
  leading,
  repo,
  runs = [],
  report = null,
  actions,
}: {
  automation: CloudAutomation;
  providers: ProviderList;
  now: number;
  needsYou?: number;
  leading?: ReactNode;
  repo?: ReactNode;
  runs?: readonly RunTick[];
  report?: string | null;
  actions: CloudAutomationActions;
}) {
  const nextRunAt =
    automation.next_run_at === null ? null : Date.parse(automation.next_run_at);
  return (
    <LoopCard
      name={automation.name}
      cloud
      agent={
        <AutomationAgentLine
          agents={[
            automation.agent ?? {
              providerId: null,
              model: null,
              reasoningLevel: null,
            },
          ]}
          providers={providers}
          compact
          quiet
        />
      }
      badges={
        <LoopBadges
          status={
            automation.last_error?.startsWith("Skipped: ")
              ? "skipped"
              : automation.last_error !== null
                ? "failed"
                : null
          }
          lastError={automation.last_error}
          needsYou={needsYou}
        />
      }
      report={report}
      schedule={
        isCloudWebhook(automation)
          ? "On webhook"
          : automation.cron === null
            ? "One time"
            : formatAutomationTrigger({
                triggerType: "schedule",
                cron: automation.cron,
                timezone: automation.timezone,
              })
      }
      nextRun={
        !automation.enabled
          ? "Paused"
          : nextRunAt === null
            ? isCloudWebhook(automation)
              ? "Waits for a webhook"
              : "Starts soon"
            : formatTimeUntil(nextRunAt, now)
      }
      nextRunAt={nextRunAt}
      muted={!automation.enabled}
      repo={repo}
      runs={runs}
      onOpen={() => actions.onOpen(automation)}
      actions={
        <>
          {leading}
          {isCloudWebhook(automation) ? (
            <ResourceActionButton
              label="New webhook URL"
              icon="Link"
              onClick={() => actions.onNewUrl(automation)}
            />
          ) : (
            <ResourceActionButton
              label="Run now"
              icon="Play"
              onClick={() => actions.onRun(automation)}
            />
          )}
          <ResourceActionButton
            label="Delete"
            icon="Trash2"
            onClick={() => actions.onDelete(automation)}
          />
        </>
      }
      toggle={
        <AutomationLifecycleControl
          checked={automation.enabled}
          label={`${automation.enabled ? "Pause" : "Resume"} ${automation.name}`}
          onCheckedChange={(enabled) =>
            actions.onEnabledChange(automation, enabled)
          }
        />
      }
    />
  );
}

function AutomationProblemRow({
  automation,
  project,
  onNavigate,
}: {
  automation: AutomationReadProblem;
  project: OverviewEntry["project"];
  onNavigate: (
    route: AutomationDetailRoute,
    options?: AutomationDetailNavigationOptions,
  ) => void;
}) {
  const repairTarget =
    automation.problem === "missing-agent-prompt" ? automation : null;
  const problemLabel = automationProblemLabel(automation);
  const route = routeOf(automation);
  return (
    <ResourceRow
      leading={
        <Icon
          name={repairTarget !== null ? "AlertCircle" : "CircleX"}
          className={cn(
            repairTarget !== null ? "text-warning" : "text-destructive",
            COARSE_POINTER_ICON_SIZE_SHRINK_CLASS,
          )}
          aria-hidden
        />
      }
      title={automation.name}
      state={
        <span
          className={cn(
            "inline-flex shrink-0 self-center items-center whitespace-nowrap rounded-full px-2 py-0.5 text-2xs font-medium",
            repairTarget !== null
              ? "bg-warning/10 text-warning-text"
              : "bg-destructive/10 text-destructive-text",
          )}
        >
          {problemLabel}
        </span>
      }
      description={
        <AutomationRowMetadata automation={repairTarget} project={project} />
      }
      className={cn("items-start", OFFSCREEN_ROW_CLASSES)}
      onOpen={() =>
        onNavigate(route, repairTarget === null ? undefined : { editing: true })
      }
      persistentActions={
        repairTarget !== null ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onNavigate(route, { editing: true })}
          >
            Edit
          </Button>
        ) : undefined
      }
    />
  );
}

function automationProblemLabel(automation: AutomationReadProblem): string {
  return automation.problem === "missing-agent-prompt"
    ? "Prompt required"
    : "Invalid data";
}

function automationProblemSearchText(
  automation: AutomationReadProblem,
): string {
  return automation.problem === "missing-agent-prompt"
    ? `${automationProblemLabel(automation)} needs prompt missing prompt`
    : `${automationProblemLabel(automation)} invalid stored data`;
}

function automationSearchValues(
  automation: OverviewEntry["automation"],
  projectName: string,
): string[] {
  const values = [automation.name, projectName, "Local"];
  if ("problem" in automation) {
    values.push(automationProblemSearchText(automation));
    if (automation.problem === "invalid-stored-data") return values;
  }
  values.push(formatScheduleStatusLabel(automation));
  values.push(formatAutomationTrigger(automation.trigger));
  return values;
}

function isActiveEntry({ automation }: OverviewEntry): boolean {
  return (
    "problem" in automation ||
    matchesAutomationStatusFilters(automation, ["active"])
  );
}

type ListItem = {
  name: string;
  nextRunAt: number | null;
  rank: number;
  priority: LoopPriority;
  node: ReactNode;
};

function sortByNextRun(
  items: readonly ListItem[],
  direction: AutomationSortDirection,
): ListItem[] {
  return [...items].sort((left, right) =>
    applyAutomationSortDirection(
      (left.nextRunAt ?? Number.MAX_SAFE_INTEGER) -
        (right.nextRunAt ?? Number.MAX_SAFE_INTEGER) ||
        left.name.localeCompare(right.name),
      direction,
    ),
  );
}

function sortByName(
  items: readonly ListItem[],
  direction: AutomationSortDirection,
): ListItem[] {
  return [...items].sort(
    (left, right) =>
      left.rank - right.rank ||
      applyAutomationSortDirection(
        left.name.localeCompare(right.name),
        direction,
      ),
  );
}

function cloudLifecycleSortRank(automation: CloudAutomation): number {
  const once = automation.cron === null && !isCloudWebhook(automation);
  if (!automation.enabled) return once && automation.runs > 0 ? 3 : 2;
  return once ? 1 : 0;
}

function cloudNextRunAt(automation: CloudAutomation): number | null {
  return automation.next_run_at === null
    ? null
    : Date.parse(automation.next_run_at);
}

function NewLoopMenu({
  onCreateViaChat,
}: {
  onCreateViaChat: (prompt?: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          aria-label="New loop"
          className="ml-1 h-8 gap-1.5 px-2.5"
        >
          <Icon name="Plus" className="size-3.5" aria-hidden />
          New
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {NEW_LOOP_OPTIONS.map((option) => (
          <Fragment key={option.label}>
            {"divider" in option ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              className="items-start gap-2.5 py-2"
              onSelect={() => onCreateViaChat(option.prompt)}
            >
              <Icon name={option.icon} className="mt-0.5 size-4" aria-hidden />
              <span className="flex min-w-0 flex-col">
                <span className="flex items-center gap-1.5">
                  {option.label}
                  {"isNew" in option ? (
                    <span className="rounded-sm bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
                      New
                    </span>
                  ) : null}
                </span>
                <span className="text-xs text-muted-foreground">
                  {option.description}
                </span>
              </span>
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type LoopScope = "all" | "off" | `repo:${string}`;

const repoScope = (projectId: string | null | undefined): LoopScope =>
  `repo:${projectId ?? "none"}`;

export function AutomationOverviewView({
  entries,
  error,
  onRetry,
  onOpenDetail,
  onEnabledChange,
  onPriorityChange,
  onCreateViaChat,
  activeMode,
  onModeChange,
  cloud,
  review,
  templates,
  localDialog,
}: {
  entries: OverviewEntry[] | null;
  error: string | null;
  onRetry: () => void;
  onOpenDetail: (
    route: AutomationDetailRoute,
    options?: AutomationDetailNavigationOptions,
  ) => void;
  onEnabledChange: (
    enabled: boolean,
    route: AutomationDetailRoute,
  ) => Promise<void>;
  /** Saves a Local loop's priority; rejects when it couldn't. */
  onPriorityChange: (
    route: AutomationDetailRoute,
    priority: LoopPriority,
  ) => Promise<void>;
  onCreateViaChat: (prompt?: string) => void;
  activeMode: AutomationCollectionMode;
  onModeChange: (mode: AutomationCollectionMode) => void;
  cloud?: {
    rows: readonly CloudAutomation[];
    loaded?: boolean;
    actions: CloudAutomationActions;
  };
  review?: LoopReviewState;
  templates?: LoopTemplatesState;
  localDialog?: {
    projectId: string;
    automationId: string;
    render: (
      priority: LoopPriority,
      onPriorityChange: (priority: LoopPriority) => void,
    ) => ReactNode;
  };
}) {
  const [query, setQuery] = useState("");
  const [reviewLayout, setReviewLayout] = useState<ReviewLayout>("list");
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("to-review");
  const [scope, setScope] = useState<LoopScope>("all");
  const [sortMode, setSortMode] = useState<AutomationSortMode>("next");
  const [sortDirection, setSortDirection] =
    useState<AutomationSortDirection>("asc");
  const { chosen, choose } = useChosenPriorities(entries, cloud?.rows);
  const localPriority = (route: AutomationDetailRoute) => {
    const automation = entries?.find(
      (entry) => entry.automation.id === route.automationId,
    )?.automation;
    return (
      chosen[`local:${route.automationId}`] ??
      (automation && "priority" in automation
        ? (automation.priority as LoopPriority)
        : DEFAULT_LOOP_PRIORITY)
    );
  };
  const setLocalPriority = (
    route: AutomationDetailRoute,
    priority: LoopPriority,
  ) =>
    choose(`local:${route.automationId}`, priority, () =>
      onPriorityChange(route, priority),
    );
  const cloudPriority = (automation: CloudAutomation) =>
    chosen[`cloud:${automation.id}`] ??
    ((automation.priority ?? DEFAULT_LOOP_PRIORITY) as LoopPriority);
  const setCloudPriority = (
    automation: CloudAutomation,
    priority: LoopPriority,
  ) =>
    choose(`cloud:${automation.id}`, priority, () =>
      cloud
        ? cloud.actions.onPriorityChange(automation, priority)
        : Promise.resolve(),
    );
  const [openCloudId, setOpenCloudId] = useState<string | null>(null);
  const { providers } = useProviders();
  const now = useMinuteClock();

  const normalizedQuery = query.trim().toLowerCase();
  const projectBucketCount = useMemo(
    () => new Set((entries ?? []).map((entry) => entry.project.id)).size,
    [entries],
  );
  useEffect(() => {
    if (sortMode === "project" && projectBucketCount <= 1) {
      setSortMode("next");
      setSortDirection("asc");
    }
  }, [projectBucketCount, sortMode]);
  const filteredEntries = useMemo(() => {
    if (entries === null) return [];
    return entries.filter(
      ({ automation, project }) =>
        normalizedQuery.length === 0 ||
        automationSearchValues(automation, project.name).some((value) =>
          value.toLowerCase().includes(normalizedQuery),
        ),
    );
  }, [entries, normalizedQuery]);
  const visibleEntries = useMemo(() => {
    return [...filteredEntries].sort((left, right) => {
      if ("problem" in left.automation && "problem" in right.automation) {
        return applyAutomationSortDirection(
          left.automation.name.localeCompare(right.automation.name),
          sortDirection,
        );
      }
      if ("problem" in left.automation) return -1;
      if ("problem" in right.automation) return 1;
      const bothEnabled = left.automation.enabled && right.automation.enabled;
      const lifecycleOrder =
        automationLifecycleSortRank(left.automation) -
        automationLifecycleSortRank(right.automation);
      if (lifecycleOrder !== 0 && !(sortMode === "next" && bothEnabled)) {
        return lifecycleOrder;
      }
      const byName = left.automation.name.localeCompare(right.automation.name);
      const base =
        sortMode === "project"
          ? automationProjectLabel(left.project).localeCompare(
              automationProjectLabel(right.project),
            ) || byName
          : sortMode === "next"
            ? (left.automation.nextRunAt ?? Number.MAX_SAFE_INTEGER) -
                (right.automation.nextRunAt ?? Number.MAX_SAFE_INTEGER) ||
              byName
            : byName;
      return applyAutomationSortDirection(base, sortDirection);
    });
  }, [filteredEntries, sortDirection, sortMode]);
  const cloudRows = cloud?.rows ?? [];
  const openCloud = cloudRows.find((row) => row.id === openCloudId);
  const visibleCloud = cloudRows.filter(
    (automation) =>
      normalizedQuery === "" ||
      [automation.name, "Cloud"].some((value) =>
        value.toLowerCase().includes(normalizedQuery),
      ),
  );
  const handleSortChange = useCallback(
    (nextSort: string) => {
      if (
        nextSort !== "project" &&
        nextSort !== "alpha" &&
        nextSort !== "next"
      ) {
        return;
      }
      if (nextSort === "project" && projectBucketCount <= 1) return;
      if (nextSort === sortMode) {
        setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
        return;
      }
      setSortMode(nextSort);
      setSortDirection("asc");
    },
    [projectBucketCount, sortMode],
  );

  const repoOf = (projectId: string | null | undefined, fallback?: string) => {
    const project = templates?.projects?.find((item) => item.id === projectId);
    const github = project?.github ?? null;
    return {
      label: github?.split("/")[1] ?? project?.name ?? fallback ?? "Other",
      github,
    };
  };
  const repos = new Map<LoopScope, LoopMenuItem<LoopScope>>();
  let offCount = 0;
  const countRepo = (
    projectId: string | null | undefined,
    fallback?: string,
  ) => {
    const id = repoScope(projectId);
    const item = repos.get(id);
    if (item) {
      item.count += 1;
      return;
    }
    const repo = repoOf(projectId, fallback);
    repos.set(id, {
      id,
      label: repo.label,
      icon: repo.github ? "GithubLogo" : "Laptop",
      count: 1,
      title: repo.github ?? repo.label,
    });
  };
  for (const entry of entries ?? []) {
    if (isActiveEntry(entry)) countRepo(entry.project.id, entry.project.name);
    else offCount += 1;
  }
  for (const automation of cloudRows) {
    if (automation.enabled) countRepo(automation.project_id);
    else offCount += 1;
  }
  const repoItems = [...repos.values()].sort(
    (left, right) =>
      right.count - left.count || left.label.localeCompare(right.label),
  );
  const activeScope =
    scope === "all" || scope === "off" || repos.has(scope) ? scope : "all";
  const inScope = (projectId: string | null | undefined) =>
    activeScope === "all" ||
    activeScope === "off" ||
    activeScope === repoScope(projectId);

  let body: ReactNode;
  if (error !== null) {
    body = (
      <ResourceListState state="error" message={error} onRetry={onRetry} />
    );
  } else if (entries === null) {
    body = (
      <DelayedLoading>
        <ResourceListState state="loading" message="Loading loops" />
      </DelayedLoading>
    );
  } else if (entries.length === 0 && cloudRows.length === 0) {
    body = <ResourceListState state="empty" message="No loops yet." />;
  } else {
    const reviewItems = review?.data?.items ?? [];
    const scopedReview = reviewItems.filter((item) =>
      inScope(item.loop.projectId),
    );
    // Cloud runs carry no loop ID, only the name, and templates reuse names across repos.
    const reviewKey = (item: (typeof reviewItems)[number]) =>
      item.loop.id ?? cloudLoopKey(item.loop.projectId, item.loop.name);
    const needsYou = new Map<string, number>();
    for (const item of reviewItems) {
      if (item.status !== "needs-you" || item.reviewedAt !== null) continue;
      const key = reviewKey(item);
      needsYou.set(key, (needsYou.get(key) ?? 0) + 1);
    }
    const history = new Map<string, RunTick[]>();
    const reports = new Map<string, string>();
    for (const item of [...reviewItems].sort((a, b) => a.at - b.at)) {
      const key = reviewKey(item);
      if (item.report) reports.set(key, item.report);
      if (item.status === "running") continue;
      const runs = history.get(key) ?? [];
      runs.push(item.status);
      history.set(key, runs);
    }
    const showRepo = repoItems.length > 1 && !activeScope.startsWith("repo:");
    const repoTag = (
      projectId: string | null | undefined,
      fallback?: string,
    ) =>
      showRepo ? (
        <LoopRepoTag projectId={projectId} {...repoOf(projectId, fallback)} />
      ) : undefined;
    const renderEntry = ({
      automation,
      project,
      scriptAgents,
    }: OverviewEntry) =>
      "problem" in automation ? (
        <AutomationProblemRow
          key={automation.id}
          automation={automation}
          project={project}
          onNavigate={onOpenDetail}
        />
      ) : (
        <OverviewRow
          key={automation.id}
          automation={automation}
          scriptAgents={scriptAgents}
          providers={providers}
          now={now}
          needsYou={needsYou.get(automation.id) ?? 0}
          runs={history.get(automation.id)}
          report={reports.get(automation.id) ?? null}
          repo={repoTag(project.id, project.name)}
          leading={
            <LoopPriorityMenu
              priority={localPriority({
                projectId: automation.projectId,
                automationId: automation.id,
              })}
              name={automation.name}
              onChange={(priority) =>
                setLocalPriority(
                  {
                    projectId: automation.projectId,
                    automationId: automation.id,
                  },
                  priority,
                )
              }
            />
          }
          onNavigate={onOpenDetail}
          onEnabledChange={onEnabledChange}
        />
      );
    const localItem = (entry: OverviewEntry): ListItem => ({
      name: entry.automation.name,
      nextRunAt:
        "problem" in entry.automation ? null : entry.automation.nextRunAt,
      rank:
        "problem" in entry.automation
          ? 0
          : automationLifecycleSortRank(entry.automation),
      priority: localPriority({
        projectId: entry.project.id,
        automationId: entry.automation.id,
      }),
      node: renderEntry(entry),
    });
    const cloudItem = (automation: CloudAutomation): ListItem => ({
      name: automation.name,
      nextRunAt: cloudNextRunAt(automation),
      rank: cloudLifecycleSortRank(automation),
      priority: cloudPriority(automation),
      node: cloud ? (
        <CloudAutomationRow
          key={automation.id}
          automation={automation}
          providers={providers}
          now={now}
          needsYou={needsYou.get(cloudKey(automation)) ?? 0}
          runs={history.get(cloudKey(automation))}
          report={reports.get(cloudKey(automation)) ?? null}
          repo={repoTag(automation.project_id)}
          leading={
            <LoopPriorityMenu
              priority={cloudPriority(automation)}
              name={automation.name}
              onChange={(priority) => setCloudPriority(automation, priority)}
            />
          }
          actions={{
            ...cloud.actions,
            onOpen: (a) => setOpenCloudId(a.id),
          }}
        />
      ) : null,
    });
    const grid = (items: readonly ListItem[]) => (
      <div className="grid grid-cols-1 gap-3.5 @2xl:grid-cols-2">
        {items.map((item) => item.node)}
      </div>
    );
    let content: ReactNode;
    if (activeScope === "off") {
      const offRest = [
        ...visibleEntries
          .filter((entry) => !isActiveEntry(entry))
          .map(localItem),
        ...visibleCloud
          .filter((automation) => !automation.enabled)
          .map(cloudItem),
      ];
      const offItems =
        sortMode === "alpha" ? sortByName(offRest, sortDirection) : offRest;
      content =
        offItems.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-3 text-xs text-muted-foreground">
            {normalizedQuery === ""
              ? "No paused loops."
              : `No paused loops match "${query}".`}
          </div>
        ) : (
          <section aria-label="Off" className="-mt-6">
            <LoopGroupDivider
              label="Off"
              count={offItems.length}
              className="text-muted-foreground"
            />
            {grid(offItems)}
          </section>
        );
    } else {
      const activeEntries = visibleEntries.filter(
        (entry) => isActiveEntry(entry) && inScope(entry.project.id),
      );
      const problems = activeEntries.filter(
        (entry) => "problem" in entry.automation,
      );
      const activeLocal = activeEntries.flatMap((entry) =>
        "problem" in entry.automation ? [] : [entry.automation],
      );
      const activeCloud = visibleCloud.filter(
        (automation) => automation.enabled && inScope(automation.project_id),
      );
      const activeRest = [
        ...activeEntries
          .filter((entry) => !("problem" in entry.automation))
          .map(localItem),
        ...activeCloud.map(cloudItem),
      ];
      const activeItems =
        sortMode === "next"
          ? sortByNextRun(activeRest, sortDirection)
          : sortMode === "alpha"
            ? sortByName(activeRest, sortDirection)
            : activeRest;
      const nextRunAt = Math.min(
        ...activeItems.flatMap((item) => item.nextRunAt ?? []),
      );
      const startOfToday = new Date(now).setHours(0, 0, 0, 0);
      const failedToday = scopedReview.filter(
        (item) =>
          item.status === "failed" &&
          item.reviewedAt === null &&
          item.at >= startOfToday,
      ).length;
      const needsYouTotal = scopedReview.filter(
        (item) => item.status === "needs-you" && item.reviewedAt === null,
      ).length;
      const finished = scopedReview.filter((item) => item.status !== "running");
      const orbitLoops = [
        ...activeLocal.map((automation) => ({
          key: automation.id,
          perDay: cronRunsPerDay(
            automation.trigger.triggerType === "schedule"
              ? automation.trigger.cron
              : null,
          ),
        })),
        ...activeCloud.map((automation) => ({
          key: cloudKey(automation),
          perDay: cronRunsPerDay(automation.cron),
        })),
      ];
      const rings = orbitLoops
        .map((loop) => history.get(loop.key)?.slice(-ORBIT_TICKS) ?? [])
        .sort((a, b) => b.length - a.length)
        .slice(0, 5)
        .map((ticks) => [
          ...Array<OrbitTick>(ORBIT_TICKS - ticks.length).fill(null),
          ...ticks,
        ]);
      const nextItem = activeItems.find((item) => item.nextRunAt === nextRunAt);
      content = (
        <>
          <LoopOrbit
            rings={rings}
            running={activeItems.length}
            cloud={activeCloud.length}
            runsPerDay={orbitLoops.reduce((sum, loop) => sum + loop.perDay, 0)}
            totalRuns={
              entries.reduce(
                (sum, { automation, project }) =>
                  sum +
                  ("problem" in automation || !inScope(project.id)
                    ? 0
                    : automation.runCount),
                0,
              ) +
              cloudRows.reduce(
                (sum, automation) =>
                  sum + (inScope(automation.project_id) ? automation.runs : 0),
                0,
              )
            }
            ownPercent={
              finished.length === 0
                ? null
                : Math.round(
                    (100 *
                      finished.filter((item) => item.status === "done")
                        .length) /
                      finished.length,
                  )
            }
            needsYou={needsYouTotal}
            failedToday={failedToday}
            next={
              nextItem && Number.isFinite(nextRunAt)
                ? { name: nextItem.name, at: nextRunAt }
                : null
            }
            now={now}
            onReview={review ? () => onModeChange("review") : undefined}
          />
          {problems.length > 0 ? (
            <div className="mt-6 divide-y divide-foreground/10">
              {problems.map(renderEntry)}
            </div>
          ) : null}
          {activeItems.length === 0 ? (
            <div className="mt-8 rounded-lg border border-dashed border-border px-4 py-3 text-xs text-muted-foreground">
              {normalizedQuery === ""
                ? "No loops running."
                : `No loops match "${query}".`}
            </div>
          ) : (
            <div className="mt-2">
              {LOOP_PRIORITIES.map((priority) => {
                const group = activeItems.filter(
                  (item) => item.priority === priority,
                );
                if (group.length === 0) return null;
                return (
                  <section key={priority} aria-label={`Priority ${priority}`}>
                    <LoopGroupDivider
                      label={`P${priority}`}
                      count={group.length}
                      className={LOOP_PRIORITY_STYLE[priority].text}
                    />
                    {grid(group)}
                  </section>
                );
              })}
            </div>
          )}
        </>
      );
    }
    body = (
      <div className="@container">
        <div className="grid items-start gap-7 pb-6 @2xl:grid-cols-[10rem_minmax(0,1fr)]">
          <LoopSideMenu
            label="Repos"
            heading="Repos"
            value={activeScope}
            onChange={setScope}
            items={[
              {
                id: "all",
                label: "All",
                icon: "GridView",
                count: repoItems.reduce((sum, item) => sum + item.count, 0),
              },
              ...repoItems,
              {
                id: "off",
                label: "Off",
                icon: "Pause",
                count: offCount,
                separated: true,
              },
            ]}
          />
          <div className="@container min-w-0">{content}</div>
        </div>
      </div>
    );
  }
  // With no loops at all, Overview shows the templates. Only after both lists loaded without an error.
  const templatesInOverview =
    activeMode === "installed" &&
    error === null &&
    entries !== null &&
    entries.length === 0 &&
    cloud?.loaded === true &&
    cloudRows.length === 0;
  return (
    <ResourceCollectionPage
      id="automations-collection"
      underlineTabs
      modes={[
        {
          id: "installed",
          label: "Overview",
          count:
            entries === null ? undefined : entries.length + cloudRows.length,
        },
        {
          id: "review",
          label: "Review",
          count: review?.data?.toReview || undefined,
        },
        { id: "templates", label: "Templates" },
        { id: "scans", label: <ScansTabLabel /> },
      ]}
      activeMode={activeMode}
      onModeChange={onModeChange}
      actions={
        <>
          {activeMode === "installed" && !templatesInOverview ? (
            <>
              <div className="relative w-44 sm:w-56">
                <Icon
                  name="Search"
                  className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search loops"
                  aria-label="Search loops"
                  className="h-8 border-0 bg-muted/50 pl-8 text-sm"
                />
              </div>
              <ResourceSortMenu
                value={sortMode}
                direction={sortDirection}
                compact
                quiet
                options={[
                  { id: "next", label: "Next run" },
                  {
                    id: "project",
                    label: "Project",
                    disabled: projectBucketCount <= 1,
                  },
                  { id: "alpha", label: "Loop name" },
                ]}
                onChange={handleSortChange}
              />
            </>
          ) : activeMode === "review" && review ? (
            <ReviewToolbar
              layout={reviewLayout}
              filter={reviewFilter}
              markable={reviewableItems(review.data?.items ?? []).length}
              onLayoutChange={setReviewLayout}
              onFilterChange={setReviewFilter}
              onMarkAll={() =>
                review.onMark(
                  reviewableItems(review.data?.items ?? []).map(
                    (item) => item.id,
                  ),
                  true,
                )
              }
            />
          ) : null}
          {cloud ? <LoopLimitSwitch /> : null}
          <NewLoopMenu onCreateViaChat={onCreateViaChat} />
        </>
      }
    >
      {activeMode === "scans" ? (
        <ResourceCollectionViewport scrollId="automations-scans">
          <ScansView />
        </ResourceCollectionViewport>
      ) : activeMode === "review" && review ? (
        <ResourceCollectionViewport scrollId="automations-review-results">
          <LoopReviewView
            review={review.data}
            error={review.error}
            layout={reviewLayout}
            filter={reviewFilter}
            now={now}
            onRetry={review.onRetry}
            onOpenThread={review.onOpenThread}
            onMark={review.onMark}
          />
        </ResourceCollectionViewport>
      ) : (activeMode === "templates" || templatesInOverview) && templates ? (
        <ResourceCollectionViewport scrollId="automations-templates">
          <LoopTemplatesView
            entries={entries}
            cloudRows={cloudRows}
            templates={templates}
            renderAgent={(agent) => (
              <AutomationAgentLine
                agents={[agent]}
                providers={providers}
                compact
              />
            )}
          />
        </ResourceCollectionViewport>
      ) : (
        <ResourceCollectionViewport scrollId="automations-installed-results">
          {body}
        </ResourceCollectionViewport>
      )}
      {openCloud && cloud ? (
        <CloudLoopDialog
          automation={openCloud}
          priority={cloudPriority(openCloud)}
          onPriorityChange={(priority) => setCloudPriority(openCloud, priority)}
          actions={cloud.actions}
          onClose={() => setOpenCloudId(null)}
        />
      ) : null}
      {localDialog
        ? localDialog.render(localPriority(localDialog), (priority) =>
            setLocalPriority(localDialog, priority),
          )
        : null}
    </ResourceCollectionPage>
  );
}
