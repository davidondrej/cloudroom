import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  useRpc,
  type ExperimentalProviderModelPickerRouting,
  type ExperimentalProviderModelPickerValue,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@cloudroom/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@cloudroom/shared-ui/dialog";
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
  formatTimeUntil,
  isCloudWebhook,
} from "./lib/format-schedule.js";
import { LOOP_PRIORITY_STYLE } from "./templates-view.js";
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

function scheduleLabel(cron: string, timezone: string): string {
  return formatAutomationTrigger({ triggerType: "schedule", cron, timezone });
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
  usageKey?: { automationId: string } | { cloudId: string };
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

function useDraft<T>(saved: T, same: (a: T, b: T) => boolean) {
  const [draft, setDraft] = useState(saved);
  const [base, setBase] = useState(saved);
  if (!same(base, saved)) {
    setBase(saved);
    if (same(draft, base)) setDraft(saved);
  }
  return [draft, setDraft] as const;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function ReadOnlyField({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-9 min-w-0 items-center gap-1.5 rounded-md bg-muted/50 px-3 text-sm text-muted-foreground">
      {children}
    </div>
  );
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

export function LoopDialog({
  loop,
  priority,
  onPriorityChange,
  onEnabledChange,
  onRun,
  onDelete,
  onSave,
  onClose,
  body,
  children,
}: {
  loop: LoopDialogLoop;
  priority: Priority;
  onPriorityChange: (priority: Priority) => void;
  onEnabledChange: (enabled: boolean) => void;
  onRun: () => void;
  onDelete: () => void;
  onSave: (changes: LoopDialogChanges) => Promise<boolean>;
  onClose: () => void;
  body?: ReactNode;
  children?: ReactNode;
}) {
  const sameAgentValue = (
    a: ExperimentalProviderModelPickerValue | null,
    b: ExperimentalProviderModelPickerValue | null,
  ) => sameAgent(a, b, !loop.cloud);
  const [prompt, setPrompt] = useDraft(loop.prompt ?? "", Object.is);
  const [cron, setCron] = useDraft(loop.cron, Object.is);
  const [agent, setAgent] = useDraft(loop.agent, sameAgentValue);
  const [pending, setPending] = useState(false);

  const scheduleOptions =
    loop.cron === null || SCHEDULE_PRESETS.includes(loop.cron)
      ? SCHEDULE_PRESETS
      : [loop.cron, ...SCHEDULE_PRESETS];
  const usage = useLoopUsage(loop.usageKey, scheduleOptions);
  const changes: LoopDialogChanges = {};
  if (loop.prompt !== undefined && prompt.trim() !== loop.prompt.trim())
    changes.prompt = prompt.trim();
  if (cron !== null && cron !== loop.cron) changes.cron = cron;
  if (agent !== null && !sameAgentValue(agent, loop.agent))
    changes.agent = agent;
  const dirty = Object.keys(changes).length > 0;
  const location = loop.cloud ? "Cloud" : "Local";

  const save = async () => {
    setPending(true);
    const saved = await onSave(changes);
    setPending(false);
    if (saved) onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        className="max-h-[90vh] max-w-xl gap-5 overflow-y-auto"
        overlayClassName="bg-black/50 backdrop-blur-sm"
      >
        <DialogHeader className="pr-8">
          <div className="flex min-w-0 items-center gap-2.5">
            <PriorityRing level={priority} />
            <DialogTitle className="min-w-0 flex-1 truncate">
              {loop.name}
            </DialogTitle>
            <Switch
              checked={loop.enabled}
              aria-label={`${loop.enabled ? "Pause" : "Resume"} ${loop.name}`}
              onCheckedChange={onEnabledChange}
            />
          </div>
          <DialogDescription className="flex items-center gap-1.5">
            <span
              className={cn(
                "flex items-center gap-1",
                loop.cloud && "text-primary-text",
              )}
            >
              <Icon
                name={loop.cloud ? "Cloud" : "Laptop"}
                className="size-3.5"
                aria-hidden
              />
              {location}
            </span>
            <span aria-hidden>·</span>
            <span className="truncate">
              {!loop.enabled
                ? "Paused"
                : loop.nextRunAt === null
                  ? loop.webhook
                    ? "On webhook"
                    : "Starts soon"
                  : `Next run ${formatTimeUntil(loop.nextRunAt)}`}
              {` · ${loop.runs} runs`}
            </span>
          </DialogDescription>
        </DialogHeader>

        {body ??
          (loop.prompt === undefined ? null : (
            <Field label="Prompt">
              <Textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                aria-label="Loop prompt"
                disabled={pending}
                className="h-40 resize-none text-sm leading-relaxed"
              />
            </Field>
          ))}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Schedule">
            {loop.webhook || cron === null ? (
              <ReadOnlyField>
                {loop.webhook ? "On webhook" : "One time"}
              </ReadOnlyField>
            ) : (
              <Select value={cron} onValueChange={setCron} disabled={pending}>
                <SelectTrigger className="w-full">
                  <SelectValue>{scheduleLabel(cron, loop.timezone)}</SelectValue>
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
          </Field>
          <Field label="Agent">
            {agent === null ? (
              <ReadOnlyField>Set by the loop</ReadOnlyField>
            ) : (
              <div className="flex h-9 min-w-0 items-center rounded-md border border-input px-2">
                <ProviderModelPicker
                  value={agent}
                  onChange={setAgent}
                  {...(loop.agentRouting === undefined
                    ? {}
                    : { routing: loop.agentRouting })}
                  allowProviderChange
                  disabled={pending || !loop.agentEditable}
                  className="h-6 max-w-full"
                />
              </div>
            )}
          </Field>
          <Field label="Runs on">
            <ReadOnlyField>
              <Icon
                name={loop.cloud ? "Cloud" : "Laptop"}
                className={cn("size-3.5 shrink-0", loop.cloud && "text-primary-text")}
                aria-hidden
              />
              <span className="truncate">{loop.runsOn}</span>
            </ReadOnlyField>
          </Field>
          <Field label="Priority">
            <Select
              value={String(priority)}
              onValueChange={(value) => onPriorityChange(Number(value) as Priority)}
            >
              <SelectTrigger className="w-full">
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
          </Field>
        </div>

        {children}

        <DialogFooter className="items-center sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            disabled={pending}
            onClick={onDelete}
          >
            Delete
          </Button>
          <div className="flex items-center gap-2">
            {loop.webhook ? null : (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={onRun}
              >
                <Icon name="Play" className="size-3.5" aria-hidden />
                Run now
              </Button>
            )}
            <Button
              type="button"
              disabled={
                pending ||
                !dirty ||
                (loop.prompt !== undefined && prompt.trim().length === 0)
              }
              onClick={() => void save()}
            >
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CloudLoopDialog({
  automation,
  priority,
  onPriorityChange,
  actions,
  onClose,
}: {
  automation: CloudAutomation;
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
      usageKey: { cloudId: automation.id },
    }),
    [automation],
  );
  return (
    <LoopDialog
      loop={loop}
      priority={priority}
      onPriorityChange={onPriorityChange}
      onEnabledChange={(enabled) => actions.onEnabledChange(automation, enabled)}
      onRun={() => actions.onRun(automation)}
      onDelete={() => actions.onDelete(automation)}
      onSave={(changes) => {
        const cloudChanges: CloudAutomationChanges = {};
        if (changes.prompt !== undefined) cloudChanges.prompt = changes.prompt;
        if (changes.cron !== undefined) cloudChanges.cron = changes.cron;
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
