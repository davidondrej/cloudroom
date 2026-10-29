import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { PROMPT_STACK_CARD_HEADER_BUTTON_CLASS, PromptStackCard, PromptStackCardChevron } from "@/components/promptbox/banner/PromptStackCard";
import { useCloudroomAccount, type CloudDisk } from "@/hooks/queries/cloudroom-queries";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { openUpgrade, useUpgradePromptViewed } from "@/lib/upgrade-prompt";

async function askForMoreUsage() {
  const response = await fetchWithAppSurface("/api/v1/cloudroom/account/more-usage", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const value = await response.json().catch(() => null) as { message?: string } | null;
  if (!response.ok) throw new Error(value?.message ?? `The request for more usage failed (HTTP ${response.status}).`);
}

/** The next plan up at a cloud limit (docs/scopes/pricing.md). Ultra has none, so it only asks the team. */
const UPGRADES: Record<string, { name: string; price: string; pitch: string }> = {
  free: { name: "Pro", price: "$50/mo", pitch: "Pro gives you 50,000 Cloud Credits a month." },
  pro: { name: "Super", price: "$150/mo", pitch: "Super gives you 3× more Cloud Credits." },
  super: { name: "Ultra", price: "$500/mo", pitch: "Ultra gives you 3× more Cloud Credits." },
};

/** Free only upgrades. Paid plans also buy a one-time pack (ADR 0317): the link starts its checkout on the website.
 *  Plans with no upgrade (Ultra, Business) still ask the team. No pack or ask until the plan is known, so a Free
 *  account never sees them while its plan loads. */
export function CloudUsageLimitNotice() {
  const ask = useMutation({ mutationFn: askForMoreUsage });
  const plan = useCloudroomAccount().data?.plan ?? null;
  const upgrade = plan ? UPGRADES[plan] : undefined;
  const paid = Boolean(plan && plan !== "free");
  useUpgradePromptViewed(upgrade ? "limit_notice" : null);
  return (
    <PromptStackCard ariaLabel="Cloud usage limit" className="space-y-2 p-3 text-xs">
      <p className="text-sm font-medium">{plan === "free" ? "You hit the Free plan's cloud limit." : "You hit your plan's cloud limit."}</p>
      <p className="text-muted-foreground">Your messages are saved, and Local threads still work. {upgrade?.pitch ?? "Older usage stops counting after 30 days."}</p>
      <div className="flex flex-wrap items-center gap-2">
        {upgrade && (
          <Button type="button" size="sm" onClick={() => openUpgrade("limit_notice")}>
            Upgrade to {upgrade.name}<span className="font-normal opacity-70">{upgrade.price}</span><Icon name="ArrowRight" aria-hidden />
          </Button>
        )}
        {paid && (
          <Button type="button" size="sm" variant={upgrade ? "outline" : "default"} onClick={() => openUpgrade("limit_notice_pack", "https://www.cloudroom.dev/billing?buy=50000")}>
            Buy 50,000 credits<span className="font-normal opacity-70">$50 once</span>
          </Button>
        )}
        {paid && !upgrade && (ask.isSuccess
          ? <p role="status" className="text-muted-foreground">Sent. The Cloudroom team will reach out to set up a quick call.</p>
          : <Button type="button" size="sm" variant="outline" disabled={ask.isPending} onClick={() => ask.mutate()}>Ask for more usage</Button>)}
      </div>
      {paid && <p className="text-muted-foreground">One-time credits never refill. They last 12 months and are used after your plan's credits.</p>}
      {ask.error && <p role="alert" className="text-destructive">{ask.error.message}</p>}
    </PromptStackCard>
  );
}

const gb = (bytes: number) => Number((bytes / 1e9).toFixed(1));

/** A full cloud disk: one live card instead of a chat row per pause and resume. No upgrade: every plan has the same disk (ADR 0282). */
export function CloudDiskNotice({ disk }: { disk: CloudDisk }) {
  const [open, setOpen] = useState(false);
  const measured = disk.reason === "disk_capacity";
  const total = measured && disk.usedBytes !== null && disk.totalBytes ? disk.totalBytes : null;
  return (
    <PromptStackCard ariaLabel="Cloud disk full" className="overflow-hidden border-attention/50 text-xs">
      <div className="flex items-center">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={cn(PROMPT_STACK_CARD_HEADER_BUTTON_CLASS, "gap-2")}>
          <Icon name="AlertTriangle" className="size-3.5 shrink-0 text-warning-text" aria-hidden />
          <span className="shrink-0 font-medium">{measured ? "Cloud disk full" : "Can't check cloud disk"}</span>
          <span className="min-w-0 truncate text-muted-foreground">{!measured ? "Work is paused until disk space can be measured" : disk.paused ? "Work is paused until space frees up" : "Work resumed, but space is still low"}</span>
          {total !== null && (
            <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums text-muted-foreground">
              <span className="h-1 w-[72px] overflow-hidden rounded-full bg-foreground/10">
                <span className="block h-full rounded-full bg-warning" style={{ width: `${Math.min(100, (disk.usedBytes ?? 0) / total * 100)}%` }} />
              </span>
              {gb(disk.usedBytes ?? 0)} / {gb(total)} GB
            </span>
          )}
          <PromptStackCardChevron isExpanded={open} className={cn("text-muted-foreground", total === null && "ml-auto")} />
        </button>
      </div>
      {open && (
        <p className="px-3 pb-2.5 text-muted-foreground">
          {measured ? "Cloudroom stops the command filling the disk within 30 seconds, then work resumes. Then ask the agent to delete what it no longer needs, like build output, caches, or node_modules." : "Your files and history are kept. Work resumes once the disk can be checked again."}
        </p>
      )}
    </PromptStackCard>
  );
}
