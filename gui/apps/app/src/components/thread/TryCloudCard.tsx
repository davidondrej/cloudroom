import { COMPUTER } from "@cloudroom/domain";
import { useEffect, useState } from "react";
import { Icon } from "@cloudroom/shared-ui/icon";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { useCloudroomConnection } from "@/hooks/queries/cloudroom-queries";
import { LAPTOP_HINT_PROMPT, laptopHintKind, useLaptopHint } from "@/lib/laptop-hints";
import { reportUpgradePromptClick, useUpgradePromptViewed } from "@/lib/upgrade-prompt";

const DISMISSED_KEY = "cloudroom.tryCloud.dismissed";
const SHOW_AFTER_MS = 5 * 60_000;
const activeSince = new Map<string, number>();

export function TryCloudCard({ threadId, active, attached, onMove }: { threadId: string; active: boolean; attached: boolean; onMove: () => void }) {
  const connection = useCloudroomConnection().data;
  const [closed, setClosed] = useState(false);
  const [laptopSeen, setLaptopSeen] = useState(false);
  const laptop = useLaptopHint("running", { enabled: active && !closed });
  if (laptop.hint && !laptopSeen) setLaptopSeen(true);
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
  const show = !closed && !laptopSeen && active && !dismissed && started !== undefined && now - started >= SHOW_AFTER_MS
    && connection?.ready === true && connection.teleport && !connection.usedCloud && !connection.cloudQueue;
  const where = laptop.hint ? LAPTOP_HINT_PROMPT[laptopHintKind(laptop.hint)] : show ? "try_cloud" : null;
  useUpgradePromptViewed(where);
  if (!where) return null;
  const close = () => {
    setClosed(true);
    if (laptop.hint) {
      laptop.dismiss();
      return;
    }
    localStorage.setItem(DISMISSED_KEY, "1");
    setDismissed(true);
  };
  const move = () => {
    reportUpgradePromptClick(where);
    if (laptop.hint) close();
    onMove();
  };
  const dismissButton = (
    <button
      type="button"
      aria-label="Dismiss"
      className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
      onClick={close}
    >
      <Icon name="X" className="size-3.5" aria-hidden="true" />
    </button>
  );
  if (laptop.hint === "network") {
    return (
      <div role="status" className="flex items-center gap-2 justify-self-center rounded-full border border-border bg-background py-0.5 pr-1 pl-3 text-xs text-muted-foreground">
        <Icon name="WifiOff" className="size-3.5 shrink-0 text-warning-text" aria-hidden="true" />
        <span className="text-foreground">Your internet dropped {laptop.drops} times in 15 min</span>
        <span aria-hidden="true">·</span>
        <span>Cloud keeps working through it</span>
        <span aria-hidden="true">·</span>
        <button type="button" className="cursor-pointer font-medium text-primary hover:underline" onClick={move}>Continue in Cloud</button>
        {dismissButton}
      </div>
    );
  }
  const battery = laptop.hint === "battery";
  const minutes = Math.floor((now - (started ?? now)) / 60_000);
  return (
    <PromptStackCard ariaLabel="Move to Cloud" className={cn("mx-3 overflow-hidden rounded-xl border-muted-foreground/15 sm:mx-4", attached && "relative z-10 -mb-5 rounded-b-none border-b-0 pb-3")}>
      <div className="flex min-h-8 items-center gap-1.5 px-3 py-1.5 text-xs">
        <Icon name={battery ? "Battery" : "Laptop"} className={cn("size-3.5 shrink-0", battery ? "text-warning-text" : "text-muted-foreground")} aria-hidden="true" />
        <span className={cn("shrink-0", battery ? "font-medium text-foreground" : "text-muted-foreground")}>{battery ? `${laptop.vitals?.battery}% battery` : `Working ${minutes}m on your ${COMPUTER}`}</span>
        <span className="shrink-0 text-muted-foreground/60" aria-hidden="true">·</span>
        <span className={cn("min-w-0 flex-1 truncate", battery ? "text-muted-foreground" : "text-foreground")}>{battery ? `Cloud won't drain it, and this agent keeps going if your ${COMPUTER} dies.` : "Move it to Cloud so you can close your laptop"}</span>
        <button
          type="button"
          className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md bg-primary px-2 py-0.5 font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          onClick={move}
        >
          <Icon name="Cloud" className="size-3.5" aria-hidden="true" />
          {battery ? "Move to Cloud" : "Move"}
        </button>
        {dismissButton}
      </div>
    </PromptStackCard>
  );
}
