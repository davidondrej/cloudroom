import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { appToast } from "@/components/ui/app-toast";
import { useCloudroomAccount, type CloudDisk } from "@/hooks/queries/cloudroom-queries";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { sdk } from "@/lib/sdk";
import { openUpgrade, useUpgradePromptViewed } from "@/lib/upgrade-prompt";

async function askForMoreUsage() {
  const response = await fetchWithAppSurface("/api/v1/cloudroom/account/more-usage", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const value = await response.json().catch(() => null) as { message?: string } | null;
  if (!response.ok) throw new Error(value?.message ?? `The request for more usage failed (HTTP ${response.status}).`);
}

/** The next plan up at a cloud limit (docs/scopes/pricing.md). Ultra has none, so it only asks the team. */
const UPGRADES: Record<string, { name: string; price: string }> = {
  free: { name: "Pro", price: "$50/mo" },
  pro: { name: "Super", price: "$150/mo" },
  super: { name: "Ultra", price: "$500/mo" },
};
/** One-click amounts of extra credits, in dollars. $1 buys 1,000 credits. */
const AMOUNTS = [10, 25, 50];

/** Out of Cloud Credits, as a row in the chat where the work stopped (ADR 20261118-214337): one title, the next plan
 *  up, then one-click amounts of extra credits (ADR 20261112-235440). An amount opens its checkout on the website, and
 *  "Other" opens the billing page. Plans with no upgrade (Ultra, Business) can still ask the team. `launchCap` is
 *  Free's daily cap on new cloud threads: credits don't lift it, so it offers the upgrade only. No buttons until the
 *  plan is known. */
export function CloudUsageLimitNotice({ launchCap = false, className }: { launchCap?: boolean; className?: string }) {
  const ask = useMutation({ mutationFn: askForMoreUsage });
  const plan = useCloudroomAccount().data?.plan ?? null;
  const upgrade = plan ? UPGRADES[plan] : undefined;
  useUpgradePromptViewed(upgrade ? "limit_notice" : null);
  return (
    <div role="status" aria-label="Cloud usage limit" className={cn("flex flex-col gap-3 py-1", className)}>
      <p className="flex items-center gap-2.5 text-base font-semibold text-foreground">
        <Icon name="Cloud" className="size-[18px] shrink-0 text-muted-foreground" aria-hidden />
        {launchCap ? "You hit Free's daily limit of new Cloud threads" : "You're out of Cloud Credits"}
      </p>
      {plan && (
        <div className="flex flex-wrap items-center gap-2 pl-7">
          {upgrade && (
            <Button type="button" size="sm" onClick={() => openUpgrade("limit_notice")}>
              Upgrade to {upgrade.name}<span className="font-normal opacity-70">{upgrade.price}</span>
            </Button>
          )}
          {!launchCap && (
            <>
              <span className="px-1 text-sm text-muted-foreground">{upgrade ? "or add" : "Add credits"}</span>
              {AMOUNTS.map((usd) => (
                <Button key={usd} type="button" size="sm" variant="outline" aria-label={`Add $${usd} of credits`} onClick={() => openUpgrade("limit_notice_pack", `https://www.cloudroom.dev/billing?buy=${usd * 1000}`)}>${usd}</Button>
              ))}
              <Button type="button" size="sm" variant="outline" onClick={() => openUpgrade("limit_notice_pack")}>Other</Button>
            </>
          )}
          {plan !== "free" && !upgrade && (ask.isSuccess
            ? <p role="status" className="text-sm text-muted-foreground">Sent. The Cloudroom team will reach out to set up a quick call.</p>
            : <Button type="button" size="sm" variant="outline" disabled={ask.isPending} onClick={() => ask.mutate()}>Ask for more usage</Button>)}
        </div>
      )}
      {ask.error && <p role="alert" className="pl-7 text-sm text-destructive">{ask.error.message}</p>}
    </div>
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
