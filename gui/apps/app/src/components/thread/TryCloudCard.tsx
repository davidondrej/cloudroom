import { COMPUTER } from "@cloudroom/domain";
import { useEffect, useState } from "react";
import { Icon } from "@cloudroom/shared-ui/icon";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { useCloudroomConnection } from "@/hooks/queries/cloudroom-queries";
import { reportUpgradePromptClick, useUpgradePromptViewed } from "@/lib/upgrade-prompt";

const DISMISSED_KEY = "cloudroom.tryCloud.dismissed";
const SHOW_AFTER_MS = 5 * 60_000;
const activeSince = new Map<string, number>();

export function TryCloudCard({ threadId, active, attached, onMove }: { threadId: string; active: boolean; attached: boolean; onMove: () => void }) {
  const connection = useCloudroomConnection().data;
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY) === "1");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) {
      activeSince.delete(threadId);
      return;
    }
    if (!activeSince.has(threadId)) activeSince.set(threadId, Date.now());
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [active, threadId]);
  const started = activeSince.get(threadId);
  const show = active && !dismissed && started !== undefined && now - started >= SHOW_AFTER_MS
    && connection?.ready === true && connection.teleport && !connection.usedCloud && !connection.cloudQueue;
  useUpgradePromptViewed(show ? "try_cloud" : null);
  if (!show) return null;
  const minutes = Math.floor((now - (started ?? now)) / 60_000);
  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, "1");
    setDismissed(true);
  };
  return (
    <PromptStackCard ariaLabel="Move to Cloud" className={cn("mx-3 overflow-hidden rounded-xl border-muted-foreground/15 sm:mx-4", attached && "relative z-10 -mb-5 rounded-b-none border-b-0 pb-3")}>
      <div className="flex min-h-8 items-center gap-1.5 px-3 py-1.5 text-xs">
        <Icon name="Laptop" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="shrink-0 text-muted-foreground">Working {minutes}m on your {COMPUTER}</span>
        <span className="shrink-0 text-muted-foreground/60" aria-hidden="true">·</span>
        <span className="min-w-0 flex-1 truncate text-foreground">Move it to Cloud so you can close your laptop</span>
        <button
          type="button"
          className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md bg-primary px-2 py-0.5 font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          onClick={() => {
            reportUpgradePromptClick("try_cloud");
            onMove();
          }}
        >
          <Icon name="Cloud" className="size-3.5" aria-hidden="true" />
          Move
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
          onClick={dismiss}
        >
          <Icon name="X" className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </PromptStackCard>
  );
}
