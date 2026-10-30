import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type { CloudroomStatus } from "@cloudroom/sdk/browser";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon, type IconName } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { useClaudeConnection } from "@/components/ClaudeConnection";
import { useCloudLogin } from "@/components/CodexConnectionPanel";
import { InviteTicketCard } from "@/components/InviteOffer";
import { BbLogo } from "@/components/ui/bb-logo";
import { SETTINGS_CARD_CLASS, SETTINGS_CARD_ROW_CLASS } from "@/components/ui/settings-section";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { getProviderIconInfo, getProviderIconTintStyle } from "@/lib/provider-icon";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { getSettingsSectionRoutePath } from "./settings-sections";

type PlanUsage = NonNullable<CloudroomStatus["planUsage"]>;
const BILLING_URL = "https://www.cloudroom.dev/billing";
const TILE_CLASS = "grid size-8 shrink-0 place-items-center rounded-lg bg-foreground/8";
const openBilling = () => openUrlInExternalBrowser(BILLING_URL);
const count = (value: number) => Math.floor(value).toLocaleString("en-US");

export function StatusPill({ ok, title, children }: { ok: boolean; title?: string; children: ReactNode }) {
  return <span role="status" title={title} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
    <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", ok ? "bg-success" : "bg-warning")} />
    {children}
  </span>;
}

export function AccountOverview({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const status = useCloudroomAccount().data;
  const accountId = status?.account?.id;
  const github = useQuery({ queryKey: ["cloudroom-github-auth", accountId], enabled: Boolean(accountId) && status?.ready === true, retry: false, queryFn: ({ signal }) => sdk.cloudroom.githubAuth(signal) }).data?.state;
  const githubUser = useQuery({ queryKey: ["cloudroom-github-account"], enabled: github === "connected", retry: false, queryFn: ({ signal }) => sdk.cloudroom.githubAccount(signal) }).data;
  const claude = useClaudeConnection({ target: "cloud" }, Boolean(accountId)).data?.state;
  const codex = useCloudLogin("codex").data?.state;
  const paid = Boolean(status?.plan && status.plan !== "free");
  return <>
    <div className="grid gap-4 sm:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
      <MembershipCard email={email} plan={status?.plan ?? null} login={githubUser?.login ?? null} usage={status?.planUsage ?? null} />
      <div className={cn(SETTINGS_CARD_CLASS, "flex flex-col")}>
        <ActionRow icon="CreditCard" title="Manage plan" detail="Upgrade, change, or cancel" external onClick={openBilling} />
        {paid
          ? <ActionRow icon="Plus" title="Buy credits" detail="$50 for 50,000 · $100 for 100,000" onClick={openBilling} />
          : <ActionRow icon="Plus" title="Upgrade to Pro" detail="50,000 Cloud Credits every 30 days" onClick={openBilling} />}
        <ActionRow icon="FileText" title="Invoices" detail="Receipts for every payment" external onClick={openBilling} />
        <ActionRow icon="LogOut" title="Sign out" detail="Cloud agents keep running" onClick={onSignOut} />
      </div>
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      <ConnectedCard rows={[
        ["GitHub", <span className={cn(TILE_CLASS, "text-foreground")}><Icon name="Github" className="size-4" aria-hidden /></span>, github],
        ["Claude Code", <AgentLogo id="claude-code" />, claude],
        ["Codex", <AgentLogo id="codex" />, codex],
      ]} />
      <InviteTicketCard />
    </div>
  </>;
}

function MembershipCard({ email, plan, login, usage }: { email: string; plan: string | null; login: string | null; usage: PlanUsage | null }) {
  const left = usage && usage.credits !== null ? Math.max(0, usage.creditsLimit - usage.credits) : null;
  return <div className="relative flex min-h-64 flex-col overflow-hidden rounded-2xl bg-primary p-6 text-primary-foreground shadow-[0_24px_60px_-28px_var(--primary)]">
    <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_100%_0%,rgb(255_255_255/0.32),transparent_55%),repeating-linear-gradient(115deg,rgb(0_0_0/0.035)_0_2px,transparent_2px_9px)]" />
    <div className="relative flex items-center gap-2">
      <BbLogo className="size-7 rounded-md" />
      <span className="text-xs font-bold tracking-[0.22em]">CLOUDROOM</span>
      <span className="ml-auto rounded-full bg-primary-foreground px-2.5 py-1 text-2xs font-bold tracking-[0.14em] text-primary">MEMBER</span>
    </div>
    {plan && <p className="relative mt-5 text-5xl leading-none font-extrabold tracking-tight">{plan.charAt(0).toUpperCase() + plan.slice(1)}</p>}
    <p className="relative mt-3 truncate text-sm font-semibold">{email}</p>
    {login && <p className="relative mt-0.5 truncate text-xs opacity-70">@{login}</p>}
    {usage && left !== null && <div className="relative mt-auto pt-5">
      <p className="flex justify-between gap-3 text-xs font-semibold tabular-nums">
        <span>{count(left)} Cloud Credits left</span>
        <span className="opacity-65">of {count(usage.creditsLimit)}</span>
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-primary-foreground/15">
        <div className="h-full rounded-full bg-primary-foreground" style={{ width: `${usage.creditsLimit > 0 ? Math.min(100, (left / usage.creditsLimit) * 100) : 0}%` }} />
      </div>
      <p className="mt-1.5 text-2xs opacity-65">Refills every rolling 30 days{usage.extraCredits ? ` · ${count(usage.extraCredits)} extra credits left` : ""}</p>
    </div>}
  </div>;
}

function ActionRow({ icon, title, detail, external, onClick }: { icon: IconName; title: string; detail: string; external?: boolean; onClick: () => void }) {
  return <button type="button" aria-label={title} onClick={onClick} className={cn(SETTINGS_CARD_ROW_CLASS, "w-full flex-1 text-left hover:bg-state-hover")}>
    <span className={cn(TILE_CLASS, "text-muted-foreground")}><Icon name={icon} className="size-4" aria-hidden /></span>
    <span className="min-w-0 flex-1">
      <span className="block text-foreground">{title}</span>
      <span className="block text-xs text-subtle-foreground/75">{detail}</span>
    </span>
    <Icon name={external ? "ExternalLink" : "ChevronRight"} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
  </button>;
}

function ConnectedCard({ rows }: { rows: [string, ReactNode, string | undefined][] }) {
  const navigate = useNavigate();
  return <div className="overflow-hidden rounded-xl bg-surface-recessed">
    <p className="px-4 pt-3.5 pb-1 text-2xs font-medium tracking-[0.08em] text-subtle-foreground uppercase">Connected</p>
    <div className="divide-y divide-border">
      {rows.map(([name, logo, state]) => <div key={name} className={SETTINGS_CARD_ROW_CLASS}>
        {logo}
        <span className="min-w-0 flex-1 truncate text-foreground">{name}</span>
        {state === "connected"
          ? <StatusPill ok>Connected</StatusPill>
          : state && <Button variant="outline" size="sm" onClick={() => navigate(getSettingsSectionRoutePath("cloud-environment"))}>Connect</Button>}
      </div>)}
    </div>
  </div>;
}

function AgentLogo({ id }: { id: string }) {
  const provider = useSystemProviders().data?.find((entry) => entry.id === id);
  const Logo = getProviderIconInfo("agent", id, provider ?? null).icon;
  return <span className={cn(TILE_CLASS, "text-foreground")} style={getProviderIconTintStyle(provider)}><Logo className="size-4" /></span>;
}
