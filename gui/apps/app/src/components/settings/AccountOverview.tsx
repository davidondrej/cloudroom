import type { CSSProperties, ReactNode } from "react";
import { useGitlabConnection } from "@/hooks/useGitlabConnection";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import type { CloudroomStatus } from "@cloudroom/sdk/browser";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon, type IconName } from "@cloudroom/shared-ui/icon";
import { hideEmail, usePrivacyMode } from "@cloudroom/shared-ui/lib/privacy-mode";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { useClaudeConnection } from "@/components/ClaudeConnection";
import { useCloudLogin } from "@/components/CodexConnectionPanel";
import { CreditsBar, refillText } from "@/components/CloudQueue";
import { PARTNER_URL } from "@/components/PartnerCard";
import { RoomLogo } from "@/components/ui/cloudroom-logo";
import { SETTINGS_CARD_CLASS, SETTINGS_CARD_ROW_CLASS } from "@/components/ui/settings-section";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { getProviderIconInfo, getProviderIconTintStyle } from "@/lib/provider-icon";
import { CLOUD_CREDITS_SETTINGS_PATH } from "@/lib/route-paths";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { getSettingsSectionRoutePath } from "./settings-sections";

type PlanUsage = NonNullable<CloudroomStatus["planUsage"]>;
const BILLING_URL = "https://www.cloudroom.dev/billing";
const TILE_CLASS = "grid size-8 shrink-0 place-items-center rounded-lg bg-foreground/8";
const openBilling = () => openUrlInExternalBrowser(BILLING_URL);
/** The one booking page for paying customers (docs/scopes/calls.md#one-booking-page). The website picks the calendar. */
const CALL_URL = "https://www.cloudroom.dev/call?from=app";
/** The cheque's paper, like the invite tickets'. */
const PAPER: CSSProperties = { backgroundColor: "#f3ecdb", backgroundImage: "repeating-linear-gradient(90deg, transparent 0 22px, rgba(120,100,60,.05) 22px 23px)" };
const count = (value: number) => Math.floor(value).toLocaleString("en-US");

export function StatusPill({ ok, title, children }: { ok: boolean; title?: string; children: ReactNode }) {
  return <span role="status" title={title} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
    <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", ok ? "bg-success" : "bg-warning")} />
    {children}
  </span>;
}

export function AccountOverview({ email: real, onSignOut }: { email: string; onSignOut: () => void }) {
  const [privacy] = usePrivacyMode();
  const email = hideEmail(real, privacy);
  const status = useCloudroomAccount().data;
  const accountId = status?.account?.id;
  const github = useQuery({ queryKey: ["cloudroom-github-auth", accountId], enabled: Boolean(accountId) && status?.ready === true, retry: false, queryFn: ({ signal }) => sdk.cloudroom.githubAuth(signal) }).data?.state;
  const githubUser = useQuery({ queryKey: ["cloudroom-github-account"], enabled: github === "connected", retry: false, queryFn: ({ signal }) => sdk.cloudroom.githubAccount(signal) }).data;
  const claude = useClaudeConnection({ target: "cloud" }, Boolean(accountId)).data?.state;
  const codex = useCloudLogin("codex").data?.state;
  const lab = useGitlabConnection().state;
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
        {paid && <ActionRow icon="Calendar" title="Book a 1:1 call" detail="30 minutes with our team" external onClick={() => openUrlInExternalBrowser(CALL_URL)} />}
        <ActionRow icon="LogOut" title="Sign out" detail="Cloud agents keep running" onClick={onSignOut} />
      </div>
    </div>
    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.45fr)]">
      <ConnectedCard rows={[
        ["GitHub", <span className={cn(TILE_CLASS, "text-foreground")}><Icon name="Github" className="size-4" aria-hidden /></span>, github],
        ...(lab?.login ? [["GitLab", <span className={TILE_CLASS}><img src="/gitlab.svg" alt="" className="size-4"/></span>, lab.expired ? "expired" : "connected"] as [string, ReactNode, string]] : []),
        ["Claude Code", <AgentLogo id="claude-code" />, claude],
        ["Codex", <AgentLogo id="codex" />, codex],
      ]} />
      <PartnerCheque email={email} />
    </div>
  </>;
}

function MembershipCard({ email, plan, login, usage }: { email: string; plan: string | null; login: string | null; usage: PlanUsage | null }) {
  const left = usage && usage.credits !== null ? Math.max(0, usage.creditsLimit - usage.credits) : null;
  // Plan credits left plus extra credits (packs, ADR 0317), like /billing.
  const extra = Math.max(0, usage?.extraCredits ?? 0);
  return <div className="relative flex min-h-64 flex-col overflow-hidden rounded-2xl bg-primary p-6 text-primary-foreground shadow-[0_24px_60px_-28px_var(--primary)]">
    <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_100%_0%,rgb(255_255_255/0.32),transparent_55%),repeating-linear-gradient(115deg,rgb(0_0_0/0.035)_0_2px,transparent_2px_9px)]" />
    <div className="relative flex items-center gap-2">
      <RoomLogo className="size-7 rounded-md" />
      <span className="text-xs font-bold tracking-[0.22em]">CLOUDROOM</span>
      <span className="ml-auto rounded-full bg-primary-foreground px-2.5 py-1 text-2xs font-bold tracking-[0.14em] text-primary">MEMBER</span>
    </div>
    {plan && <p className="relative mt-5 text-5xl leading-none font-extrabold tracking-tight">{plan.charAt(0).toUpperCase() + plan.slice(1)}</p>}
    <p className="relative mt-3 truncate text-sm font-semibold">{email}</p>
    {login && <p className="relative mt-0.5 truncate text-xs opacity-70">@{login}</p>}
    {usage && left !== null && <div className="relative mt-auto pt-5">
      <p className="flex justify-between gap-3 text-xs font-semibold tabular-nums">
        <span>{count(left + extra)} Cloud Credits left</span>
        {extra > 0 ? null : <span className="opacity-65">of {count(usage.creditsLimit)}</span>}
      </p>
      <CreditsBar className="mt-2 h-1.5 bg-primary-foreground/15" plan={left} limit={usage.creditsLimit} extra={extra} extraTotal={usage.extraCreditsTotal ?? 0} planClassName="bg-primary-foreground" edgeClassName="border-primary" />
      <p className="mt-1.5 flex items-center justify-between gap-3 text-2xs tabular-nums">
        {extra > 0
          ? <><span className="font-semibold">{count(extra)} extra · used last</span><span className="ml-auto font-semibold opacity-65">{count(left)} of {count(usage.creditsLimit)} plan</span></>
          : <span className="opacity-65">{refillText(usage.resetsAt)}</span>}
        <SeeUsage />
      </p>
    </div>}
  </div>;
}

/** Opens Analytics → Cloud Credits, which shows the threads that used the credits. */
function SeeUsage() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(CLOUD_CREDITS_SETTINGS_PATH)}
    className="-my-1 inline-flex shrink-0 items-center gap-1 rounded-full bg-primary-foreground px-2.5 py-1 font-semibold text-primary hover:brightness-125">
    See usage<Icon name="ArrowRight" className="size-3" aria-hidden />
  </button>;
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

/** The affiliate program, as a cheque made out to the member (David, 2026-11-16). Always shown, to every account: it
 *  is the program's home in the app. The button opens the page where people apply. */
function PartnerCheque({ email }: { email: string }) {
  return <div data-testid="account-partner-cheque" className="flex overflow-hidden rounded-2xl text-[#1c1a15]" style={PAPER}>
    <div className="flex min-w-0 flex-1 flex-col px-5 py-4">
      <p className="font-mono text-[10px] font-semibold tracking-[0.2em] text-[#7d735f] uppercase">Partner program · Pay to</p>
      <p className="mt-3 truncate border-b-[1.5px] border-[#1c1a15]/35 pb-2 font-serif text-[22px] leading-none tracking-[-0.02em]">{email}</p>
      <p className="mt-2 text-[13px] text-[#6f6655]">of every plan payment your link brings.</p>
      <div className="mt-auto flex pt-3">
        <button type="button" onClick={() => openUrlInExternalBrowser(PARTNER_URL)}
          className="flex h-8 items-center gap-1.5 rounded-md bg-[#1c1a15] px-3 text-xs font-semibold text-[#f3ecdb] hover:brightness-125">
          Become a partner<Icon name="ArrowUpRight" className="size-3.5" aria-hidden />
        </button>
      </div>
    </div>
    <div className="flex w-[124px] shrink-0 flex-col items-center justify-center border-l-2 border-dashed border-[#b9ad8f] bg-[#e9dfc6]">
      <p className="font-serif text-[54px] leading-none font-semibold tracking-[-0.04em]">40<span className="text-[32px]">%</span></p>
      <p className="mt-2 -rotate-[4deg] border-2 border-[#1c1a15] bg-[#bfff00] px-2 py-0.5 font-mono text-[10px] font-bold tracking-[0.18em]">FOR LIFE</p>
    </div>
  </div>;
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
          : state && <Button variant="outline" size="sm" onClick={() => navigate(getSettingsSectionRoutePath("cloud-environment"))}>{state === "expired" ? "Reconnect" : "Connect"}</Button>}
      </div>)}
    </div>
  </div>;
}

function AgentLogo({ id }: { id: string }) {
  const provider = useSystemProviders().data?.find((entry) => entry.id === id);
  const Logo = getProviderIconInfo("agent", id, provider ?? null).icon;
  return <span className={cn(TILE_CLASS, "text-foreground")} style={getProviderIconTintStyle(provider)}><Logo className="size-4" /></span>;
}
