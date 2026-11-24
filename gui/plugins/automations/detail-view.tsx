import { useLayoutEffect, useRef, useState } from "react";
import type { UIEvent } from "react";
import type { AgentEnvironment, AutomationExecution } from "./src/rpc-types";
import type { ExperimentalProviderModelPickerRouting } from "@get-bb/plugin-sdk/app";
import { Icon } from "@cloudroom/shared-ui/icon";
import { ResourceDetailPanel } from "@cloudroom/shared-ui/resource-list";
import { Switch } from "@cloudroom/shared-ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@cloudroom/shared-ui/tooltip";
import { formatHomePathForDisplay } from "@cloudroom/shared-ui/lib/utils";

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
