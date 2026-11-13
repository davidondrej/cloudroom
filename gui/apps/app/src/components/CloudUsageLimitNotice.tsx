import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { appToast } from "@/components/ui/app-toast";
import { useCloudroomAccount, type CloudDisk } from "@/hooks/queries/cloudroom-queries";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { sdk } from "@/lib/sdk";
import { openUpgrade, useUpgradePromptViewed } from "@/lib/upgrade-prompt";
import { refillText } from "@/components/CloudQueue";

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
  const account = useCloudroomAccount().data, plan = account?.plan ?? null;
  const upgrade = plan ? UPGRADES[plan] : undefined;
  const paid = Boolean(plan && plan !== "free");
  useUpgradePromptViewed(upgrade ? "limit_notice" : null);
  return (
    <PromptStackCard ariaLabel="Cloud usage limit" className="space-y-2 p-3 text-xs">
      <p className="text-sm font-medium">{plan === "free" ? "You hit the Free plan's cloud limit." : "You hit your plan's cloud limit."}</p>
      <p className="text-muted-foreground">Your messages are saved, and Local threads still work. {refillText(account?.planUsage?.resetsAt)}{upgrade ? ` ${upgrade.pitch}` : ""}</p>
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

/** A full cloud disk, as one pill above the composer. No upgrade: every plan has the same disk (ADR 0282). Its button clears
 *  caches and builds while the agent is paused, and the waiting message then sends by itself. The server shows it only
 *  once Core has measured the disk. */
export function CloudDiskNotice({ threadId, disk }: { threadId: string; disk: CloudDisk }) {
  const client = useQueryClient();
  const [dismissed, setDismissed] = useState(false);
  const clear = useMutation({
    mutationFn: () => sdk.cloudroom.clearDisk(threadId),
    onSuccess: ({ freedBytes: freed }) => freed >= 5e8
      ? appToast.success(`Cleared ${gb(freed)} GB of caches and builds.`)
      : appToast.warning(`Only ${gb(freed)} GB of caches and builds to clear. The rest of the disk is other files.`),
    onError: (error) => appToast.error(error.message),
    onSettled: () => client.invalidateQueries({ queryKey: ["cloudroom-thread", threadId] }),
  });
  if (dismissed) return null;
  const measured = disk.reason === "disk_capacity";
  const used = measured ? disk.usedBytes : null;
  const total = used !== null && disk.totalBytes ? disk.totalBytes : null;
  const divider = <span aria-hidden className="h-3.5 w-px shrink-0 bg-border" />;
  return (
    <div role="alert" aria-label="Cloud disk full" className="flex min-w-0 max-w-full items-center gap-2 justify-self-center rounded-full border border-border bg-background py-1 pl-3 pr-1.5 text-xs text-muted-foreground">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
      <span className="truncate text-foreground">{!measured ? "Can't check cloud disk" : disk.paused ? "Cloud disk is full" : "Cloud disk is almost full"}</span>
      {used !== null && total !== null && <span className="shrink-0 tabular-nums">{gb(used)} / {gb(total)} GB</span>}
      {divider}
      {measured && (
        <>
          <button type="button" disabled={clear.isPending} onClick={() => clear.mutate()} className="flex shrink-0 cursor-pointer items-center gap-1 text-foreground underline underline-offset-2 disabled:opacity-50">
            <Icon name="Trash2" className="size-3" aria-hidden />{clear.isPending ? "Clearing…" : "Clear caches & builds"}
          </button>
          {divider}
        </>
      )}
      <button type="button" aria-label="Dismiss" className="flex size-5 shrink-0 cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground" onClick={() => setDismissed(true)}><Icon name="X" className="size-3" aria-hidden /></button>
    </div>
  );
}

/** During an outage (ADR 20261113-202742): continue from the thread's older copy instead of waiting. It asks once more,
 *  since newer work is lost. */
export function ContinueFromCopyButton({ threadId }: { threadId: string }) {
  const client = useQueryClient();
  const [sure, setSure] = useState(false);
  const pick = useMutation({
    mutationFn: () => sdk.cloudroom.continueFromCopy(threadId),
    onError: (error) => appToast.error(error.message),
    onSettled: () => client.invalidateQueries({ queryKey: ["cloudroom-thread", threadId] }),
  });
  return (
    <button type="button" disabled={pick.isPending} onClick={() => sure ? pick.mutate() : setSure(true)} className="shrink-0 cursor-pointer text-foreground underline underline-offset-2 disabled:opacity-50">
      {pick.isPending ? "Moving…" : sure ? "Newer changes are lost. Continue?" : "Continue from copy"}
    </button>
  );
}
