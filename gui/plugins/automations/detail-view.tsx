import { useLayoutEffect, useRef, useState } from "react";
import type { UIEvent } from "react";
import type {
  AgentEnvironment,
  AutomationExecution,
  AutomationRunResponse,
  AutomationRunStatus,
} from "./src/rpc-types";
import type { ExperimentalProviderModelPickerRouting } from "@get-bb/plugin-sdk/app";
import { RUN_STATE_PRESENTATION } from "@cloudroom/domain/update-state";
import { COARSE_POINTER_HOVER_REVEAL_VISIBLE_CLASS } from "@cloudroom/shared-ui/coarse-pointer-visibility";
import { Icon, type IconName } from "@cloudroom/shared-ui/icon";
import { ResourceDetailPanel } from "@cloudroom/shared-ui/resource-list";
import { Switch } from "@cloudroom/shared-ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@cloudroom/shared-ui/tooltip";
import { cn, formatHomePathForDisplay } from "@cloudroom/shared-ui/lib/utils";
import { formatScheduleRunTime } from "./lib/format-schedule";

export function providerModelRouting(
  environment: AgentEnvironment,
): ExperimentalProviderModelPickerRouting | undefined {
  if (environment.type === "reuse") {
    return { kind: "environment", environmentId: environment.environmentId };
  }
  if (environment.type === "host" && environment.hostId !== undefined) {
    return { kind: "host", hostId: environment.hostId };
  }
  return undefined;
}

interface AutomationLifecycleControlProps {
  checked: boolean;
  disabled?: boolean;
  disabledReason?: string;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}

export function AutomationLifecycleControl({
  checked,
  disabled = false,
  disabledReason,
  label,
  onCheckedChange,
}: AutomationLifecycleControlProps) {
  const control = (
    <Switch
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onCheckedChange={onCheckedChange}
    />
  );

  if (!disabled || disabledReason === undefined) return control;

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex cursor-not-allowed rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            tabIndex={0}
            aria-label={`${label}. ${disabledReason}`}
          >
            {control}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-64">
          {disabledReason}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const SCRIPT_SCROLLBAR_IDLE_DELAY_MS = 600;

export function AutomationScriptContent({ content }: { content: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollbarIdleTimeoutRef = useRef<number | null>(null);
  const [hasMoreBelow, setHasMoreBelow] = useState(false);

  useLayoutEffect(() => {
    const scrollArea = scrollRef.current;
    if (!scrollArea) return;

    const updateOverflow = () => {
      setHasMoreBelow(
        scrollArea.scrollTop + scrollArea.clientHeight <
          scrollArea.scrollHeight - 1,
      );
    };
    updateOverflow();

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updateOverflow);
    resizeObserver?.observe(scrollArea);

    return () => {
      resizeObserver?.disconnect();
      if (scrollbarIdleTimeoutRef.current !== null) {
        window.clearTimeout(scrollbarIdleTimeoutRef.current);
      }
    };
  }, [content]);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const scrollArea = event.currentTarget;
    setHasMoreBelow(
      scrollArea.scrollTop + scrollArea.clientHeight <
        scrollArea.scrollHeight - 1,
    );
    scrollArea.dataset.scrollbarScrolling = "true";
    if (scrollbarIdleTimeoutRef.current !== null) {
      window.clearTimeout(scrollbarIdleTimeoutRef.current);
    }
    scrollbarIdleTimeoutRef.current = window.setTimeout(() => {
      scrollbarIdleTimeoutRef.current = null;
      scrollArea.removeAttribute("data-scrollbar-scrolling");
    }, SCRIPT_SCROLLBAR_IDLE_DELAY_MS);
  };

  return (
    <div className="relative isolate min-w-0">
      <div
        ref={scrollRef}
        role="region"
        aria-label="Script contents"
        tabIndex={0}
        data-automation-script-scroll=""
        onScroll={handleScroll}
        className="transient-scrollbar max-h-64 min-w-0 overflow-auto px-3 py-3"
      >
        <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">
          {content}
        </pre>
      </div>
      {hasMoreBelow ? (
        <div
          aria-hidden
          data-automation-script-fade="below"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-b from-transparent to-background"
        />
      ) : null}
    </div>
  );
}

function AutomationEnvironmentVariables({
  environment,
}: {
  environment: Record<string, string>;
}) {
  const names = Object.keys(environment).sort();
  if (names.length === 0) return null;
  const label = `${names.length} env ${names.length === 1 ? "var" : "vars"}`;

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex items-center gap-1.5"
            tabIndex={0}
            aria-label={`${names.length} environment ${names.length === 1 ? "variable" : "variables"}: ${names.join(", ")}`}
          >
            <Icon name="Code" className="size-3.5" aria-hidden />
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-80">
          {names.join(", ")}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function automationEnvironmentLabel(
  execution: Extract<AutomationExecution, { mode: "agent" }>,
): string {
  const environment = execution.environment;
  if (environment.type === "reuse") return "Reuse environment";
  if (environment.type === "project-default") return "Fresh copy of main";
  if (environment.workspace.type === "managed-worktree") return "New worktree";
  if (environment.workspace.type === "personal") return "Personal workspace";
  return environment.workspace.path == null
    ? "Workspace"
    : formatHomePathForDisplay(environment.workspace.path);
}

function formatRunDuration(run: AutomationRunResponse): string | null {
  if (run.finishedAt === null) return null;
  const seconds = (run.finishedAt - run.startedAt) / 1000;
  if (seconds < 0) return null;
  return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
}

function isSilentRun(run: AutomationRunResponse): boolean {
  return (
    run.status === "succeeded" &&
    run.runMode === "script" &&
    (run.output === null || run.output.trim().length === 0)
  );
}

const AUTOMATION_RUN_STATUS_VISUALS: Record<
  AutomationRunStatus,
  {
    label: string;
    icon: IconName;
    className: string;
  }
> = {
  running: {
    label: "Running",
    icon: RUN_STATE_PRESENTATION["in-progress"].icon as IconName,
    className: "animate-spin text-muted-foreground",
  },
  failed: {
    label: RUN_STATE_PRESENTATION.failed.label,
    icon: RUN_STATE_PRESENTATION.failed.icon as IconName,
    className: "text-destructive",
  },
  skipped: {
    label: RUN_STATE_PRESENTATION.skipped.label,
    icon: RUN_STATE_PRESENTATION.skipped.icon as IconName,
    className: "text-subtle-foreground",
  },
  succeeded: {
    label: RUN_STATE_PRESENTATION.succeeded.label,
    icon: RUN_STATE_PRESENTATION.succeeded.icon as IconName,
    className: "text-success",
  },
};

export function RunRow({
  run,
  onOpenThread,
}: {
  run: AutomationRunResponse;
  onOpenThread: (threadId: string) => void;
}) {
  const duration = formatRunDuration(run);
  const silent = isSilentRun(run);
  const showOutput =
    run.runMode === "script" &&
    (run.output !== null || run.error !== null || silent);
  const visual = AUTOMATION_RUN_STATUS_VISUALS[run.status];
  const running = run.status === "running";
  const openable = run.runMode === "agent" && run.threadId !== null;
  const RowTag = openable ? "button" : "div";
  const line = (
    <RowTag
      {...(openable
        ? {
            type: "button" as const,
            onClick: () => onOpenThread(run.threadId!),
          }
        : {})}
      className={cn(
        "group/run flex w-full min-w-0 items-center gap-2.5 rounded-sm px-2 py-1.5 text-left",
        openable &&
          "cursor-pointer hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default",
        running && "bg-surface-recessed/40",
      )}
    >
      <span
        role="img"
        aria-label={visual.label}
        className="inline-flex shrink-0"
      >
        <Icon
          name={visual.icon}
          className={cn(
            "size-3.5",
            visual.className,
            running && "animate-shine-icon",
          )}
          aria-hidden
        />
      </span>
      <span
        className={cn(
          "min-w-0 shrink-0 text-sm",
          running ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {formatScheduleRunTime(run.startedAt)}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-xs",
          running
            ? "animate-shine text-muted-foreground"
            : "text-subtle-foreground",
        )}
      >
        {running ? `${visual.label}\u2026` : (duration ?? "")}
        {run.skipReason ? `${duration ? " · " : ""}${run.skipReason}` : ""}
      </span>
      {openable ? (
        <Icon
          name="ChevronRight"
          className={cn(
            "size-3.5 shrink-0 text-subtle-foreground opacity-0 transition-opacity group-hover/run:opacity-100 group-focus-visible/run:opacity-100",
            COARSE_POINTER_HOVER_REVEAL_VISIBLE_CLASS,
          )}
          aria-hidden
        />
      ) : null}
    </RowTag>
  );
  return (
    <div className="overflow-hidden rounded-sm">
      {line}
      {showOutput ? (
        <pre
          className={cn(
            "mx-2 mb-2 whitespace-pre-wrap rounded-md bg-surface-recessed/70 px-3 py-2 font-mono text-xs leading-relaxed",
            "text-foreground",
            silent && "italic text-subtle-foreground",
          )}
        >
          {run.error ??
            (silent
              ? "no output — silent gate, nothing surfaced"
              : (run.output ?? ""))}
        </pre>
      ) : null}
    </div>
  );
}

export function ScriptAutomationDefinition({
  execution,
}: {
  execution: Extract<AutomationExecution, { mode: "script" }>;
}) {
  return (
    <ResourceDetailPanel
      surface="flat"
      className="rounded-md border border-border bg-background"
    >
      {execution.script ? (
        <AutomationScriptContent content={execution.script} />
      ) : (
        <div className="px-3 py-3 text-xs text-muted-foreground">
          Script content unavailable.
        </div>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border bg-surface-recessed/55 px-3 py-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Icon name="ComputerTerminal01" className="size-3.5" aria-hidden />
          {execution.interpreter ?? "bash"}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Icon name="Clock" className="size-3.5" aria-hidden />
          {Math.round(execution.timeoutMs / 1000)}s timeout
        </span>
        {execution.env ? (
          <AutomationEnvironmentVariables environment={execution.env} />
        ) : null}
      </div>
    </ResourceDetailPanel>
  );
}
