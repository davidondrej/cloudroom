import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  useRpc,
  type ExperimentalProviderModelPickerRouting,
  type ExperimentalProviderModelPickerValue,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@cloudroom/shared-ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@cloudroom/shared-ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@cloudroom/shared-ui/select";
import { Switch } from "@cloudroom/shared-ui/switch";
import { Textarea } from "@cloudroom/shared-ui/textarea";
import type {
  CloudAutomation,
  CloudAutomationActions,
  CloudAutomationChanges,
} from "./cloud-view.js";
import {
  formatAutomationTrigger,
  formatScheduleRunTime,
  formatTimeUntil,
  isCloudWebhook,
} from "./lib/format-schedule.js";
import { SecretsPicker } from "./secrets-picker.js";
import { LOOP_PRIORITY_STYLE } from "./templates-view.js";
import type { ReviewItemStatus } from "./src/rpc-types.js";
import type { automationRpcContract } from "./src/rpc.js";
import type { LoopUsage } from "./src/usage.js";

const PRIORITIES = [1, 2, 3, 4] as const;
export type Priority = (typeof PRIORITIES)[number];

const SCHEDULE_PRESETS = [
  "*/30 * * * *",
  "0 * * * *",
  "0 */2 * * *",
  "0 */4 * * *",
  "0 */8 * * *",
  "0 9 * * *",
];

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/u.test(navigator.userAgent);
const SAVE_KEY = IS_MAC ? "⌘S" : "Ctrl+S";
const RECENT_RUNS = 4;
const QUIET_CONTROL =
  "h-8 min-w-0 rounded-md border-0 bg-transparent px-2 shadow-none hover:bg-state-hover dark:bg-transparent [&>svg]:opacity-40";

function scheduleLabel(cron: string, timezone: string): string {
  return formatAutomationTrigger({ triggerType: "schedule", cron, timezone });
}

export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export type RunTick = "done" | "needs-you" | "failed";

const CARD_RUNS = 10;
const RUN_DOT = {
  done: "bg-foreground/70",
  "needs-you": "bg-warning-text/80",
  failed: "bg-destructive-text/80",
} as const;

export function runSharePercent(runs: readonly RunTick[]): number | null {
  if (runs.length < 3) return null;
  return Math.round(
    (100 * runs.filter((run) => run === "done").length) / runs.length,
  );
}

export function LoopRunDots({
  runs,
  showPercent = true,
}: {
  runs: readonly RunTick[];
  showPercent?: boolean;
}) {
  const last = runs.slice(-CARD_RUNS);
  const percent = runSharePercent(runs);
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
      {showPercent && percent !== null ? (
        <span className="tabular-nums">{percent}%</span>
      ) : null}
    </>
  );
}

/** Each schedule's rough share of the weekly Claude or Codex limit (docs/scopes/loops.md), or null without enough data. */
function useLoopUsage(
  key: LoopDialogLoop["usageKey"],
  crons: string[],
): LoopUsage {
  const rpc = useRpc<typeof automationRpcContract>();
  const [usage, setUsage] = useState<LoopUsage>(null);
  const request = key ? JSON.stringify({ ...key, crons }) : null;
  useEffect(() => {
    if (!request) return;
    let live = true;
    rpc.call("automations_usage", JSON.parse(request)).then(
      (result) => live && setUsage(result),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [rpc, request]);
  return usage;
}

function shareLabel(percent: number | undefined): string | null {
  if (percent === undefined) return null;
  return percent < 1 ? "<1%" : `~${Math.round(percent)}%`;
}

function cloudAgentValue(
  automation: CloudAutomation,
): ExperimentalProviderModelPickerValue | null {
  const agent = automation.agent;
  if (!agent?.providerId || !agent.model) return null;
  return {
    providerId: agent.providerId,
    model: agent.model,
    reasoningLevel: (agent.reasoningLevel ??
      undefined) as ExperimentalProviderModelPickerValue["reasoningLevel"],
  };
}

export type LoopDialogChanges = {
  prompt?: string;
  cron?: string;
  agent?: ExperimentalProviderModelPickerValue;
  secrets?: string[];
};

export type LoopDialogLoop = {
  name: string;
  enabled: boolean;
  cloud: boolean;
  nextRunAt: number | null;
  runs: number;
  prompt?: string;
  cron: string | null;
  timezone: string;
  webhook: boolean;
  agent: ExperimentalProviderModelPickerValue | null;
  agentEditable: boolean;
  agentRouting?: ExperimentalProviderModelPickerRouting;
  runsOn: string;
  /** A fresh-thread Cloud loop's picked API keys and `.env` (null: all of them, ADR 0342), or what other loops get. */
  secrets: { picked: string[] | null } | { fixed: string };
  usageKey?: { automationId: string } | { cloudId: string };
};

export type LoopDialogRepo = { label: string; github: string | null };

/** One recent run, newest first: Review items for Local and Cloud, or a Local loop's own runs. */
export type LoopDialogRun = {
  id: string;
  at: number;
  status: ReviewItemStatus;
  text: string;
  threadId: string | null;
};

/** What the Loops panel knows about a loop beyond its settings. */
export type LoopDialogContext = {
  repo?: LoopDialogRepo;
  runs: readonly LoopDialogRun[] | null;
  onOpenThread?: (threadId: string) => void;
  onOpenReview?: () => void;
};

function sameAgent(
  a: ExperimentalProviderModelPickerValue | null,
  b: ExperimentalProviderModelPickerValue | null,
  compareServiceTier: boolean,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.providerId === b.providerId &&
    a.model === b.model &&
    a.reasoningLevel === b.reasoningLevel &&
    (!compareServiceTier ||
      (a.serviceTier ?? "default") === (b.serviceTier ?? "default"))
  );
}

function sameSecrets(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((name) => b.includes(name));
}

function useDraft<T>(saved: T, same: (a: T, b: T) => boolean) {
  const [draft, setDraft] = useState(saved);
  const [base, setBase] = useState(saved);
  if (!same(base, saved)) {
    setBase(saved);
    if (same(draft, base)) setDraft(saved);
  }
  return [draft, setDraft] as const;
}

function PriorityRing({ level }: { level: Priority }) {
  return (
    <span
      className={cn(
        "size-3.5 shrink-0 rounded-full border-2",
        LOOP_PRIORITY_STYLE[level].ring,
      )}
    />
  );
}

function SettingRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-8 min-w-0 items-center gap-1">
      <span className="w-[72px] shrink-0 text-xs text-subtle-foreground">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
    </div>
  );
}

function ReadOnlyValue({ children }: { children: ReactNode }) {
  return (
    <span className="flex h-8 min-w-0 items-center gap-1.5 px-2 text-sm text-muted-foreground">
      {children}
    </span>
  );
}

const RUN_CLOCK = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const RUN_DAY = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

function runTime(at: number, now: number): string {
  return new Date(at).toDateString() === new Date(now).toDateString()
    ? RUN_CLOCK.format(at)
    : RUN_DAY.format(at);
}

function RecentRuns({
  total,
  runs,
  now,
  onOpenThread,
  onOpenReview,
}: {
  total: number;
  runs: readonly LoopDialogRun[] | null;
  now: number;
  onOpenThread?: (threadId: string) => void;
  onOpenReview?: () => void;
}) {
  const ticks = (runs ?? [])
    .flatMap((run) => (run.status === "running" ? [] : [run.status]))
    .reverse();
  const percent = runSharePercent(ticks);
  return (
    <section aria-label="Runs" className="flex min-w-0 flex-col">
      <div className="flex items-center gap-2 text-xs text-subtle-foreground">
        <span className="font-medium text-foreground">Runs</span>
        <span className="flex-1" />
        <span className="tabular-nums">
          {total}
          {percent === null
            ? ` run${total === 1 ? "" : "s"}`
            : ` · ${percent}% on its own`}
        </span>
      </div>
      {runs === null ? null : runs.length === 0 ? (
        <p className="mt-3 text-xs text-subtle-foreground">
          No runs in the last 7 days.
        </p>
      ) : (
        <>
          <div className="mt-3 flex">
            <LoopRunDots runs={ticks} showPercent={false} />
          </div>
          <ul className="-mx-2 mt-1.5">
            {runs.slice(0, RECENT_RUNS).map((run) => {
              const open =
                run.threadId !== null && onOpenThread
                  ? () => onOpenThread(run.threadId!)
                  : undefined;
              return (
                <li key={run.id}>
                  <button
                    type="button"
                    disabled={!open}
                    onClick={open}
                    className="flex h-7 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left text-xs enabled:cursor-pointer enabled:hover:bg-state-hover"
                  >
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        run.status === "running"
                          ? "animate-pulse bg-primary-text"
                          : RUN_DOT[run.status],
                      )}
                    />
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate",
                        run.status === "running"
                          ? "animate-shine text-muted-foreground"
                          : "text-foreground/85",
                      )}
                    >
                      {run.text}
                    </span>
                    <span className="shrink-0 tabular-nums text-subtle-foreground">
                      {runTime(run.at, now)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {onOpenReview ? (
        <button
          type="button"
          onClick={onOpenReview}
          className="mt-1.5 flex w-fit cursor-pointer items-center gap-1 text-xs text-subtle-foreground hover:text-foreground"
        >
          Open all in Review
          <Icon name="ArrowRight" className="size-3" aria-hidden />
        </button>
      ) : null}
    </section>
  );
}

function nextRunText(loop: LoopDialogLoop, schedule: string, now: number) {
  if (!loop.enabled) return { label: "Status", big: "Paused", small: schedule };
  if (loop.webhook)
    return {
      label: "Trigger",
      big: "On webhook",
      small: "Runs on each POST to its URL",
    };
  if (loop.nextRunAt === null)
    return { label: "Next run", big: "Starts soon", small: schedule };
  return {
    label: "Next run",
    big: formatTimeUntil(loop.nextRunAt, now),
    small: `${formatScheduleRunTime(loop.nextRunAt)} · ${schedule}`,
  };
}

export function LoopDialog({
  loop,
  context,
  priority,
  onPriorityChange,
  onEnabledChange,
  onRun,
  onDelete,
  onSave,
  onClose,
  script,
}: {
  loop: LoopDialogLoop;
  context: LoopDialogContext;
  priority: Priority;
  onPriorityChange: (priority: Priority) => void;
  onEnabledChange: (enabled: boolean) => void;
  onRun: () => void;
  onDelete: () => void;
  onSave: (changes: LoopDialogChanges) => Promise<boolean>;
  onClose: () => void;
  script?: ReactNode;
}) {
  const sameAgentValue = (
    a: ExperimentalProviderModelPickerValue | null,
    b: ExperimentalProviderModelPickerValue | null,
  ) => sameAgent(a, b, !loop.cloud);
  const [prompt, setPrompt] = useDraft(loop.prompt ?? "", Object.is);
  const [cron, setCron] = useDraft(loop.cron, Object.is);
  const [agent, setAgent] = useDraft(loop.agent, sameAgentValue);
  const [secrets, setSecrets] = useDraft(
    "picked" in loop.secrets ? loop.secrets.picked : null,
    sameSecrets,
  );
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [savedPrompt, setSavedPrompt] = useState<string | null>(null);
  const [seenPrompt, setSeenPrompt] = useState(loop.prompt);
  if (seenPrompt !== loop.prompt) {
    setSeenPrompt(loop.prompt);
    setSavedPrompt(null);
  }
  const basePrompt = savedPrompt ?? loop.prompt?.trim();
  const contentRef = useRef<HTMLDivElement>(null);
  const now = useMinuteClock();

  const scheduleOptions =
    loop.cron === null || SCHEDULE_PRESETS.includes(loop.cron)
      ? SCHEDULE_PRESETS
      : [loop.cron, ...SCHEDULE_PRESETS];
  const usage = useLoopUsage(loop.usageKey, scheduleOptions);
  const trimmed = prompt.trim();
  const promptDirty = basePrompt !== undefined && trimmed !== basePrompt;
  const schedule = loop.webhook
    ? "On webhook"
    : cron === null
      ? "One time"
      : scheduleLabel(cron, loop.timezone);
  const next = nextRunText(loop, schedule, now);

  const apply = (changes: LoopDialogChanges, undo: () => void) =>
    void onSave(changes).then((saved) => saved || undo());

  const savePrompt = async () => {
    if (!promptDirty || trimmed.length === 0 || savingPrompt) return;
    setSavingPrompt(true);
    const saved = await onSave({ prompt: trimmed });
    setSavingPrompt(false);
    if (saved) setSavedPrompt(trimmed);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void savePrompt();
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        ref={contentRef}
        hideCloseButton
        tabIndex={-1}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
        onKeyDown={onKeyDown}
        className="flex flex-col gap-0 border-foreground/10 outline-none sm:rounded-2xl md:h-[min(680px,90vh)] md:w-[calc(100vw-2rem)] md:max-w-[980px] md:flex-row md:overflow-hidden md:p-0"
        overlayClassName="bg-black/50 backdrop-blur-sm"
      >
        <section className="flex min-w-0 shrink-0 flex-col md:min-h-0 md:flex-1 md:shrink md:px-8 md:pt-6">
          {context.repo ? (
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-subtle-foreground">
              <Icon
                name={context.repo.github ? "GithubLogo" : "Laptop"}
                className="size-3.5 shrink-0"
                aria-hidden
              />
              <span className="truncate">
                {context.repo.github ?? context.repo.label}
              </span>
              <span aria-hidden className="text-muted-foreground/40">
                /
              </span>
              <span className="shrink-0">Loops</span>
            </div>
          ) : null}
          <DialogTitle className="mt-3 line-clamp-3 shrink-0 text-balance text-[22px] font-semibold leading-snug tracking-[-0.02em] text-foreground">
            {loop.name}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {loop.cloud ? "Cloud" : "Local"} loop. {next.big}.
          </DialogDescription>
          {script || loop.prompt !== undefined ? (
            <div className="mt-6 flex items-center gap-2 text-xs font-medium text-subtle-foreground">
              {script ? "Script" : "Prompt"}
              <span aria-hidden className="h-px flex-1 bg-foreground/[0.07]" />
            </div>
          ) : null}
          {script ? (
            <div className="mt-3 max-h-72 overflow-y-auto md:max-h-none md:min-h-40 md:flex-1">
              {script}
            </div>
          ) : loop.prompt !== undefined ? (
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              aria-label="Loop prompt"
              disabled={savingPrompt}
              className="mt-3 h-56 resize-none rounded-none md:h-auto md:min-h-40 md:flex-1 border-0 bg-transparent px-0 py-0 text-[14.5px] leading-[1.7] text-foreground/90 shadow-none focus-visible:ring-0 disabled:opacity-100 dark:bg-transparent"
            />
          ) : (
            <div className="flex-1" />
          )}
          <div className="mt-3 flex h-12 shrink-0 items-center gap-2 border-t border-foreground/[0.07] text-xs text-subtle-foreground">
            {promptDirty || savingPrompt ? (
              <>
                <span className="text-foreground">
                  {savingPrompt ? "Saving…" : "Unsaved prompt changes"}
                </span>
                <span className="flex-1" />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={savingPrompt}
                  onClick={() => setPrompt(basePrompt ?? "")}
                >
                  Discard
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={savingPrompt || trimmed.length === 0}
                  onClick={() => void savePrompt()}
                >
                  Save
                  <span className="text-primary-foreground/60">{SAVE_KEY}</span>
                </Button>
              </>
            ) : (
              <>
                <Icon name="Check" className="size-3.5" aria-hidden />
                <span className="text-muted-foreground">Saved</span>
                <span aria-hidden className="text-muted-foreground/40">
                  ·
                </span>
                <span className="truncate">Settings apply right away</span>
                {loop.prompt !== undefined ? (
                  <>
                    <span className="flex-1" />
                    <kbd className="rounded border border-b-2 border-foreground/10 px-1.5 font-mono text-[10.5px] text-muted-foreground max-md:hidden">
                      {SAVE_KEY}
                    </kbd>
                    <span className="shrink-0 max-md:hidden">
                      saves prompt edits
                    </span>
                  </>
                ) : null}
              </>
            )}
          </div>
        </section>

        <aside className="flex w-full shrink-0 flex-col md:min-h-0 border-foreground/[0.07] max-md:border-t md:w-[352px] md:border-l md:bg-sidebar">
          <div className="flex items-center gap-2.5 pt-3 md:px-5 md:pt-4">
            <Switch
              size="default"
              checked={loop.enabled}
              aria-label={`${loop.enabled ? "Pause" : "Resume"} ${loop.name}`}
              onCheckedChange={onEnabledChange}
            />
            <span className="text-sm text-foreground">
              {loop.enabled ? "Active" : "Paused"}
            </span>
            <span className="flex-1" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground"
                  aria-label="More actions"
                >
                  <Icon name="MoreHorizontal" className="size-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                  <Icon name="Trash2" className="size-4" aria-hidden />
                  Delete loop
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground max-md:hidden"
                aria-label="Close"
              >
                <Icon name="X" className="size-4" aria-hidden />
              </Button>
            </DialogClose>
          </div>

          <div className="md:min-h-0 md:flex-1 md:overflow-y-auto md:px-5">
            <div className="pt-5">
              <div className="text-xs text-subtle-foreground">{next.label}</div>
              <div className="mt-1 text-[26px] font-semibold leading-tight tracking-[-0.025em] text-foreground tabular-nums">
                {next.big}
              </div>
              <div className="mt-0.5 truncate text-xs text-subtle-foreground">
                {next.small}
              </div>
            </div>

            <div className="mt-4 flex flex-col border-t border-foreground/[0.07] py-2">
              <SettingRow label="Schedule">
                {loop.webhook || cron === null ? (
                  <ReadOnlyValue>{schedule}</ReadOnlyValue>
                ) : (
                  <Select
                    value={cron}
                    onValueChange={(value) => {
                      const previous = cron;
                      setCron(value);
                      apply({ cron: value }, () => setCron(previous));
                    }}
                  >
                    <SelectTrigger
                      aria-label="Schedule"
                      className={QUIET_CONTROL}
                    >
                      <SelectValue>{schedule}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {scheduleOptions.map((option) => (
                        <SelectItem
                          key={option}
                          value={option}
                          className="[&>span:last-child]:flex-1"
                        >
                          <span className="flex items-center justify-between gap-6">
                            {scheduleLabel(option, loop.timezone)}
                            {usage && (
                              <span className="tabular-nums text-muted-foreground/70">
                                {shareLabel(usage.percents[option])}
                              </span>
                            )}
                          </span>
                        </SelectItem>
                      ))}
                      {usage && (
                        <div className="mx-2 mt-1 border-t border-foreground/10 pb-1 pt-2 text-xs text-muted-foreground/70">
                          Share of your weekly {usage.limit} limit
                        </div>
                      )}
                    </SelectContent>
                  </Select>
                )}
              </SettingRow>
              <SettingRow label="Agent">
                {agent === null ? (
                  <ReadOnlyValue>Set by the loop</ReadOnlyValue>
                ) : (
                  <div className="flex h-8 min-w-0 items-center rounded-md px-1 hover:bg-state-hover">
                    <ProviderModelPicker
                      value={agent}
                      onChange={(value) => {
                        const previous = agent;
                        setAgent(value);
                        apply({ agent: value }, () => setAgent(previous));
                      }}
                      {...(loop.agentRouting === undefined
                        ? {}
                        : { routing: loop.agentRouting })}
                      allowProviderChange
                      disabled={!loop.agentEditable}
                      className="h-6 max-w-full"
                    />
                  </div>
                )}
              </SettingRow>
              <SettingRow label="Runs on">
                <ReadOnlyValue>
                  <Icon
                    name={loop.cloud ? "Cloud" : "Laptop"}
                    className="size-3.5 shrink-0"
                    aria-hidden
                  />
                  <span className="truncate">{loop.runsOn}</span>
                </ReadOnlyValue>
              </SettingRow>
              <SettingRow label="Secrets">
                {"fixed" in loop.secrets ? (
                  <ReadOnlyValue>
                    <Icon
                      name={loop.cloud ? "Lock" : "Laptop"}
                      className="size-3.5 shrink-0"
                      aria-hidden
                    />
                    <span className="truncate">{loop.secrets.fixed}</span>
                  </ReadOnlyValue>
                ) : (
                  <SecretsPicker
                    picked={secrets}
                    className={QUIET_CONTROL}
                    onChange={(value) => {
                      const previous = secrets;
                      setSecrets(value);
                      apply({ secrets: value }, () => setSecrets(previous));
                    }}
                  />
                )}
              </SettingRow>
              <SettingRow label="Priority">
                <Select
                  value={String(priority)}
                  onValueChange={(value) =>
                    onPriorityChange(Number(value) as Priority)
                  }
                >
                  <SelectTrigger
                    aria-label="Priority"
                    className={QUIET_CONTROL}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map((level) => (
                      <SelectItem key={level} value={String(level)}>
                        <span className="flex items-center gap-2">
                          <PriorityRing level={level} />P{level}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>
            </div>

            <div className="border-t border-foreground/[0.07] pt-3.5 pb-3">
              <RecentRuns
                total={loop.runs}
                runs={context.runs}
                now={now}
                {...(context.onOpenThread
                  ? { onOpenThread: context.onOpenThread }
                  : {})}
                {...(context.onOpenReview
                  ? { onOpenReview: context.onOpenReview }
                  : {})}
              />
            </div>
          </div>

          {loop.webhook ? null : (
            <div className="pb-1 pt-3 md:px-5 md:pb-5">
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                onClick={onRun}
              >
                <Icon name="Play" className="size-3.5" aria-hidden />
                Run now
              </Button>
            </div>
          )}
        </aside>
      </DialogContent>
    </Dialog>
  );
}

export function CloudLoopDialog({
  automation,
  context,
  priority,
  onPriorityChange,
  actions,
  onClose,
}: {
  automation: CloudAutomation;
  context: LoopDialogContext;
  priority: Priority;
  onPriorityChange: (priority: Priority) => void;
  actions: CloudAutomationActions;
  onClose: () => void;
}) {
  const loop = useMemo<LoopDialogLoop>(
    () => ({
      name: automation.name,
      enabled: automation.enabled,
      cloud: true,
      nextRunAt:
        automation.next_run_at === null
          ? null
          : Date.parse(automation.next_run_at),
      runs: automation.runs,
      prompt: automation.prompt,
      cron: automation.cron,
      timezone: automation.timezone,
      webhook: isCloudWebhook(automation),
      agent: cloudAgentValue(automation),
      agentEditable: automation.new_thread === true,
      runsOn: automation.new_thread
        ? "Cloud · new thread each run"
        : "Cloud · same thread",
      secrets: automation.new_thread
        ? { picked: automation.secrets ?? null }
        : { fixed: "Same as its thread" },
      usageKey: { cloudId: automation.id },
    }),
    [automation],
  );
  return (
    <LoopDialog
      loop={loop}
      context={context}
      priority={priority}
      onPriorityChange={onPriorityChange}
      onEnabledChange={(enabled) =>
        actions.onEnabledChange(automation, enabled)
      }
      onRun={() => actions.onRun(automation)}
      onDelete={() => actions.onDelete(automation)}
      onSave={(changes) => {
        const cloudChanges: CloudAutomationChanges = {};
        if (changes.prompt !== undefined) cloudChanges.prompt = changes.prompt;
        if (changes.cron !== undefined) cloudChanges.cron = changes.cron;
        if (changes.secrets !== undefined)
          cloudChanges.secrets = changes.secrets;
        if (changes.agent !== undefined) {
          cloudChanges.harness = changes.agent.providerId;
          cloudChanges.model = changes.agent.model;
          if (changes.agent.reasoningLevel)
            cloudChanges.reasoning = changes.agent.reasoningLevel;
        }
        return actions.onSave(automation, cloudChanges);
      }}
      onClose={onClose}
    />
  );
}
