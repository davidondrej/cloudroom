import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import type { UsageMachine, UsageProvider } from "./usage-schema.js";

export const usageFeedbackMessages = {
  loading: "Loading usage…",
  noSources: "No usage sources available.",
  loadFailed: "Couldn’t load usage.",
  refreshFailed: "Couldn’t refresh usage. Showing the last available update.",
  unavailable: "Usage unavailable.",
} as const;

export function hasReportedUsage(providers: readonly UsageProvider[]): boolean {
  return providers.some((provider) => provider.usage !== null);
}

export function emptyUsageMessage(machine: UsageMachine): string {
  return machine.id.startsWith("source:")
    ? "No accounts report usage yet. Configure accounts in the source plugin’s settings."
    : "No providers report usage limits on this machine.";
}

export function offlineUsageMessage(
  machine: UsageMachine,
  hasUsage: boolean,
): string {
  return hasUsage
    ? `${machine.displayName} is offline. Showing the last available update.`
    : `${machine.displayName} is offline. Usage will refresh when it reconnects.`;
}

export function UsageFeedback({
  message,
  loading = false,
  compact = false,
}: {
  message: string;
  loading?: boolean;
  compact?: boolean;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex min-w-0 text-muted-foreground",
        compact ? "items-center gap-1.5 text-[10px]" : "items-start text-xs",
        !loading && !compact && "gap-2 rounded-md bg-muted/60 px-2.5 py-2",
      )}
    >
      {loading ? null : (
        <Icon
          name="Info"
          aria-hidden="true"
          className={cn("shrink-0", compact ? "size-3" : "mt-0.5 size-3.5")}
        />
      )}
      <span className="min-w-0 flex-1">{compact ? "Refresh failed · Showing saved usage" : message}</span>
    </div>
  );
}
