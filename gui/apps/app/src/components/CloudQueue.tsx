import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudroom/shared-ui/button";
import { Dialog, DialogContent, DialogTitle } from "@cloudroom/shared-ui/dialog";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cloudroom/shared-ui/tooltip";
import { SidebarMenuItem } from "@/components/ui/sidebar";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { appToast } from "@/components/ui/app-toast";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { UpgradeTip } from "@/components/UpgradeTip";
import { openUpgrade, useUpgradePromptViewed } from "@/lib/upgrade-prompt";

// The cloud queue (docs/scopes/public-launch.md): Free accounts wait in line to start Cloud threads. Everything else,
// including Local threads, works as usual. The website decides; these only show it.
export type CloudQueue = { position: number; total: number; regionBlocked: boolean };

/** Under the new-thread composer while Cloud is picked and the account waits. */
export function CloudQueueCard({ queue, onUseLocal }: { queue: CloudQueue; onUseLocal: () => void }) {
  const local = <Button type="button" size="sm" variant="outline" onClick={onUseLocal}><Icon name="Laptop" aria-hidden />Run it on Local</Button>;
  useUpgradePromptViewed(queue.regionBlocked ? null : "queue");
  if (queue.regionBlocked) {
    return (
      <section aria-label="Cloud unavailable" className="mt-3 flex gap-3 rounded-lg border border-foreground/10 bg-surface-raised-solid p-4">
        <Icon name="Cloud" className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <p className="text-sm font-medium text-foreground">Cloud isn't available in your region yet</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">We're adding cloud capacity region by region. Local threads work as usual.</p>
          </div>
          {local}
        </div>
      </section>
    );
  }
  // The share of the line behind you: it fills up as people ahead get in.
  const behind = queue.total > 0 ? Math.max(4, Math.round(((queue.total - queue.position + 1) / queue.total) * 100)) : 4;
  return (
    <section aria-label="Cloud queue" className="mt-3 flex gap-3 rounded-lg border border-foreground/10 bg-surface-raised-solid p-4">
      <Icon name="Cloud" className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-foreground">You're in the cloud queue</p>
          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">#{queue.position.toLocaleString("en-US")} in line</span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">We let people into the cloud in small batches so it stays fast. We'll tell you here when it's your turn. Local threads work right now.</p>
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-foreground/10"><div className="h-full rounded-full bg-primary" style={{ width: `${behind}%` }} /></div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={() => openUpgrade("queue")}><Icon name="Zap" aria-hidden />Skip the queue with Pro</Button>
          {local}
          <span className="text-xs text-muted-foreground">Pro is $50/month</span>
        </div>
      </div>
    </section>
  );
}

const share = (used: number, limit: number) => limit > 0 ? Math.min(used / limit, 1) : 1;

/** Free accounts always see their Cloud Credits left (ADR 0307). Paid plans see a quiet meter once 75% are used. */
export function PlanCard() {
  const usage = useCloudroomAccount().data?.planUsage ?? null;
  const used = usage?.credits ?? null, limit = usage?.creditsLimit ?? 0;
  const free = usage?.plan === "free";
  const hidden = !usage || used === null || (!free && share(used, limit) < 0.75);
  useUpgradePromptViewed(hidden ? null : "plan_card");
  if (!usage || used === null || hidden) return null;
  if (!free) return <PlanMeter plan={usage.plan} used={used} limit={limit} />;
  const low = share(used, limit) >= 0.8;
  return (
    <section aria-label="Free plan" className="rounded-lg border border-border bg-surface-raised-solid p-3">
      <p className="text-xs text-muted-foreground">Free plan</p>
      <div className="mt-2.5">
        <p className="mb-1.5 text-sm text-foreground"><span className={cn("font-semibold", low && "text-warning")}>{Math.max(0, Math.floor(limit - used)).toLocaleString("en-US")}</span> Cloud Credits left</p>
        <div className="h-1 overflow-hidden rounded-full bg-foreground/10"><div className={cn("h-full rounded-full", low ? "bg-warning" : "bg-primary")} style={{ width: `${share(used, limit) * 100}%` }} /></div>
      </div>
      <Button type="button" size="sm" className="mt-3 w-full justify-start" onClick={() => openUpgrade("plan_card")}>
        <span className="min-w-0 truncate">Upgrade to Pro</span><span className="ml-auto shrink-0 font-normal opacity-70">$50/mo</span><Icon name="ArrowRight" aria-hidden />
      </Button>
    </section>
  );
}

/** "Super 120,000 / 150,000 credits" over a thin bar: amber from 75%, red at the limit. Opens /billing. */
function PlanMeter({ plan, used, limit }: { plan: string; used: number; limit: number }) {
  const name = plan.charAt(0).toUpperCase() + plan.slice(1);
  const full = used >= limit;
  return (
    <button type="button" aria-label={`${name} plan usage`} className="w-full px-2 pb-1 text-left" onClick={() => openUpgrade("plan_card")}>
      <p className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{name}</span>
        <span><span className={cn("font-semibold", full ? "text-destructive" : "text-warning")}>{Math.floor(used).toLocaleString("en-US")}</span><span className="text-muted-foreground"> / {Math.round(limit).toLocaleString("en-US")} credits</span></span>
      </p>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-foreground/10"><div className={cn("h-full rounded-full", full ? "bg-destructive" : "bg-warning")} style={{ width: `${share(used, limit) * 100}%` }} /></div>
    </button>
  );
}

const EXPLAINER_SEEN_KEY = "cloudroom.creditsExplainerSeen";
const FREE_WITHOUT_CREDITS = ["starting new cloud threads", "idle cloud threads", "sleeping sandboxes", "waiting for your reply", "your ai tokens", "local threads", "chat history and files"];

/** Once per Mac, the first time a paying account opens the app with Cloud Credits (ADR 0307): what changed, the one
 *  thing that uses credits, and the one-time reset (ADR 0308). Free accounts and OGs on the free Pro never see it. */
export function CreditsExplainer() {
  const usage = useCloudroomAccount().data?.planUsage ?? null;
  const [seen, setSeen] = useState(() => localStorage.getItem(EXPLAINER_SEEN_KEY) === "1");
  if (!usage || usage.plan === "free" || usage.og || seen) return null;
  const close = () => { localStorage.setItem(EXPLAINER_SEEN_KEY, "1"); setSeen(true); };
  const used = usage.credits ?? 0, mono = "font-mono text-[11px] leading-[1.9]";
  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent hideCloseButton aria-describedby={undefined} className="max-w-[540px] gap-0 rounded-none border-white/15 p-0 sm:rounded-none">
        <div className="px-8 pb-7 pt-8">
          <DialogTitle className="text-3xl font-semibold tracking-tight">We simplified your usage</DialogTitle>
          <p className={cn("mt-5 flex items-center gap-2", mono)}>
            <span className="border border-white/15 px-2 text-muted-foreground line-through">agent hours</span>+
            <span className="border border-white/15 px-2 text-muted-foreground line-through">cloud agents</span>→
            <span className="border border-foreground/60 px-2">cloud credits</span>
          </p>
        </div>
        <div className="border-t border-white/10 px-8 py-7">
          <p className="flex items-baseline justify-between">
            <span className="flex items-baseline gap-2"><span className="text-5xl font-semibold tabular-nums tracking-tight">{usage.creditsLimit.toLocaleString("en-US")}</span><span className="text-sm text-muted-foreground">credits a month</span></span>
            <span className={cn("uppercase text-muted-foreground", mono)}>{usage.plan}</span>
          </p>
          <div className="mt-4 h-1 bg-foreground/10"><div className="h-full min-w-[3%] bg-primary" style={{ width: `${share(used, usage.creditsLimit) * 100}%` }} /></div>
          <p className={cn("mt-2.5 flex justify-between text-muted-foreground", mono)}><span>{Math.floor(used).toLocaleString("en-US")} used</span><span>refills on a rolling 30 days</span></p>
        </div>
        <div className={cn("grid grid-cols-[0.8fr_1.2fr] border-t border-white/10", mono)}>
          <div className="border-r border-dashed border-white/10 py-6 pl-8 pr-4">
            <p className="mb-2 flex items-center gap-2"><span className="bg-primary px-1.5 text-[10px] font-bold text-primary-foreground">PAID</span><span className="text-muted-foreground">uses credits</span></p>
            <p className="font-bold"><span className="font-normal text-muted-foreground">└ </span>agents actively running</p>
          </div>
          <div className="py-6 pl-6 pr-8">
            <p className="mb-2 flex items-center gap-2"><span className="bg-success px-1.5 text-[10px] font-bold text-background">FREE</span><span className="text-muted-foreground">0 credits</span></p>
            <ul>{FREE_WITHOUT_CREDITS.map((item, i) => <li key={item} className="flex justify-between gap-3"><span><span className="text-muted-foreground">{i === FREE_WITHOUT_CREDITS.length - 1 ? "└ " : "├ "}</span>{item}</span><span className="font-bold text-success">0</span></li>)}</ul>
          </div>
        </div>
        <p className="flex gap-3 border-t border-white/10 px-8 py-5 text-sm leading-relaxed">
          <Icon name="RotateCcw" className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span><span className="font-medium">One-time reset, on us.</span> <span className="text-muted-foreground">We set everyone's usage back to 0 for free when Cloud Credits launched. Your plan, price and monthly refill don't change.</span></span>
        </p>
        <div className="px-8 pb-8 pt-1"><Button type="button" className="w-full rounded-none" onClick={close}>Got it</Button></div>
      </DialogContent>
    </Dialog>
  );
}

const PRO_REASONS = [
  "Pro gives you 50,000 Cloud Credits a month. Free gives you 3,000.",
  "Pro keeps cloud agents awake 4× longer, so they reply faster.",
  "Pro cloud agents never get paused when the cloud gets busy.",
  "Pro keeps your chat history up to 1 year. Free keeps 7 days.",
];
let lastReason = Math.floor(Math.random() * PRO_REASONS.length);
const nextReason = () => PRO_REASONS[(lastReason = (lastReason + 1) % PRO_REASONS.length)];

export function FreePlanTip() {
  const usage = useCloudroomAccount().data?.planUsage ?? null;
  const [reason] = useState(nextReason);
  if (usage?.plan !== "free") return null;
  return <UpgradeTip where="free_tip" className="mt-3 px-3.5">{reason}</UpgradeTip>;
}

const OG_HIDDEN_KEY = "cloudroom.ogLetterHiddenUntil";
const HAND = { fontFamily: '"Bradley Hand", "Noteworthy", "Segoe Print", cursive' };

/** David's letter to OG beta testers under the new-thread composer (ADR 0218). The website sends `og` only to OGs still
 *  on the free Pro it gave them, never to Free, paying, or team accounts. "Not now" hides it for 3 days. */
export function OgLetter() {
  const og = useCloudroomAccount().data?.planUsage?.og ?? null;
  const [hidden, setHidden] = useState(() => Number(localStorage.getItem(OG_HIDDEN_KEY)) > Date.now());
  const show = Boolean(og) && !hidden;
  useUpgradePromptViewed(show ? "og_letter" : null);
  if (!og || !show) return null;
  const ends = new Date(og.endsAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const notNow = () => {
    localStorage.setItem(OG_HIDDEN_KEY, String(Date.now() + 3 * 86_400_000));
    setHidden(true);
  };
  return (
    <section aria-label="A note from David" className="mt-3 rounded-sm bg-[#f3eee2] px-6 pb-3.5 pt-3 text-[#2a2a28] shadow-lg [background-image:repeating-linear-gradient(180deg,transparent_0_29px,rgba(70,110,160,0.16)_29px_30px)] [background-position:0_13px]">
      <p className="text-lg leading-[30px]" style={HAND}>
        {og.name ? `Hey ${og.name},` : "Hey,"}<br />
        thanks for testing Cloudroom so early.<br />
        Free Pro ends {ends}, but you keep 50% off forever.
      </p>
      <p className="mb-2.5 text-2xl" style={{ fontFamily: '"Snell Roundhand", "Bradley Hand", cursive' }}>David</p>
      <div className="flex flex-wrap items-center gap-3 border-t border-black/10 pt-3">
        <span className="border-[1.5px] border-dashed border-[#2a2a28] px-2 py-0.5 font-mono text-xs font-bold tracking-widest">OG50</span>
        <span className="text-xs text-[#6b665b]">Only 39 people have this code</span>
        <button type="button" className="ml-auto text-xs text-[#6b665b] hover:text-[#2a2a28]" onClick={notNow}>Not now</button>
        <Button type="button" size="sm" className="border-[#1a1a1a] bg-[#1a1a1a] text-[#f3eee2] hover:bg-black" onClick={() => openUpgrade("og_letter", "https://www.cloudroom.dev/billing?keep=pro")}>
          Keep Pro for $25/mo
        </Button>
      </div>
    </section>
  );
}

/** Sidebar footer badge while the account waits. Says so once when the account gets in. */
export function CloudQueueChip() {
  const queue = useCloudroomAccount().data?.cloudQueue ?? null;
  const waited = useRef(false);
  useEffect(() => {
    if (queue && !queue.regionBlocked) waited.current = true;
    else if (!queue && waited.current) {
      waited.current = false;
      appToast.success("You're in! Cloud threads are ready.");
    }
  }, [queue]);
  useUpgradePromptViewed(queue && !queue.regionBlocked ? "queue_badge" : null);
  if (!queue || queue.regionBlocked) return null;
  return (
    <SidebarMenuItem data-footer-item="cloud-queue">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" aria-label={`Cloud queue: number ${queue.position}`} className="h-[26px] gap-1 rounded-md bg-primary/15 px-2 text-xs font-medium text-primary hover:bg-primary/25 hover:text-primary [&_[data-icon-root]]:size-3.5" onClick={() => openUpgrade("queue_badge")}>
            <Icon name="Cloud" aria-hidden />
            #{queue.position.toLocaleString("en-US")}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">You're #{queue.position.toLocaleString("en-US")} in the cloud queue. Get Pro to skip it.</TooltipContent>
      </Tooltip>
    </SidebarMenuItem>
  );
}
