import { useAtom } from "jotai";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";
import { z } from "zod";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Switch } from "@cloudroom/shared-ui/switch";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { PARTNER_URL } from "@/components/PartnerCard";
import { StatusPill } from "@/components/settings/AccountOverview";
import { Stat } from "@/components/settings/UsageSection";
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_CARD_ROW_CLASS,
} from "@/components/ui/settings-section";
import { useCloseMobileSidebar } from "@/components/ui/sidebar.js";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { createBooleanPreferenceAtom } from "@/lib/browser-storage";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { getSettingsSectionRoutePath } from "./settings-sections";

const referralsSchema = z.object({
  available: z.boolean().default(true),
  joined: z.boolean(),
  link: z.string().nullable(),
  monthlyCents: z.number().default(0),
  totalEarnedCents: z.number().default(0),
  pendingCents: z.number().default(0),
  payingCount: z.number().default(0),
  signupsCount: z.number().default(0),
  recent: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(["sale", "lead"]),
        earningsCents: z.number(),
        status: z.string(),
        createdAt: z.string(),
      }),
    )
    .default([]),
});

export type ReferralsSummary = z.infer<typeof referralsSchema>;

const REFERRALS_KEY = ["cloudroom-referrals"] as const;

export const autoCreditWrappedAtom = createBooleanPreferenceAtom(
  "cloudroom.referrals.autoCreditWrapped",
  true,
);

async function requestReferrals(method: "GET" | "POST", signal?: AbortSignal) {
  const response = await fetchWithAppSurface("/api/v1/cloudroom/account/referrals", {
    method,
    signal,
    ...(method === "POST"
      ? { headers: { "Content-Type": "application/json" }, body: "{}" }
      : {}),
  });
  const value = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(
      (value as { message?: string } | null)?.message ??
        "Referrals are unavailable right now.",
    );
  }
  return referralsSchema.parse(value);
}

export function formatReferralDollars(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars)
    ? `$${dollars.toLocaleString("en-US")}`
    : `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function useReferrals() {
  const account = useCloudroomAccount().data;
  const accountId = account?.account?.id ?? "";
  const enabled = Boolean(accountId && !account?.signingIn && account?.ready);
  return useQuery({
    queryKey: [...REFERRALS_KEY, accountId],
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
    queryFn: ({ signal }) => requestReferrals("GET", signal),
  });
}

/** Always-visible card in the Settings left sidebar linking to Settings → Account → Referrals. */
export function EarnSidebarCard() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const closeOnMobile = useCloseMobileSidebar();
  const referrals = useReferrals().data;
  const to = getSettingsSectionRoutePath("referrals");
  const active = pathname === to;
  const badge =
    referrals && referrals.monthlyCents > 0
      ? `${formatReferralDollars(referrals.monthlyCents)}/mo`
      : "40%";

  return (
    <div className="mt-2 border-t border-sidebar-border pt-2">
      <button
        type="button"
        data-testid="settings-earn-card"
        aria-current={active ? "page" : undefined}
        onClick={() => {
          navigate(to);
          closeOnMobile();
        }}
        className={cn(
          "flex h-9 w-full items-center justify-between gap-2 rounded-md px-2 text-sm font-medium text-sidebar-foreground transition-colors",
          active
            ? "bg-primary/20 dark:bg-primary/15"
            : "bg-primary/15 hover:bg-primary/25 dark:bg-primary/10 dark:hover:bg-primary/15",
        )}
      >
        <span className="flex min-w-0 items-center gap-2.5 truncate">
          <Icon name="Link" className="size-4 shrink-0 text-primary" aria-hidden />
          <span className="truncate">Refer &amp; earn</span>
        </span>
        <span className="shrink-0 font-mono text-xs font-semibold text-primary tabular-nums">
          {badge}
        </span>
      </button>
    </div>
  );
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

export function ReferralsSettingsSection() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const account = useCloudroomAccount().data;
  const signedIn = Boolean(account?.account && !account?.signingIn);
  const accountId = account?.account?.id ?? "";
  const query = useReferrals();
  const [autoCreditWrapped, setAutoCreditWrapped] = useAtom(autoCreditWrappedAtom);

  const enroll = useMutation({
    mutationFn: () => requestReferrals("POST"),
    onSuccess: (summary) => {
      queryClient.setQueryData([...REFERRALS_KEY, accountId], summary);
    },
  });

  if (!signedIn) {
    return (
      <section className="space-y-5" data-testid="referrals-tab">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Refer a friend, earn 40% for life
          </h2>
          <p className="mt-0.5 text-xs text-subtle-foreground/75">
            1 Pro friend = $20/mo. 1 Ultra friend = $200/mo. Paid every month they stay.
          </p>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-xl bg-surface-recessed px-4 py-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              Sign in to get your referral link
            </p>
            <p className="mt-0.5 text-xs text-subtle-foreground/75">
              Works on Free and Paid accounts.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            className="h-8 shrink-0 gap-1.5 px-3.5 text-xs"
            onClick={() => navigate(getSettingsSectionRoutePath("account"))}
          >
            Sign in
            <Icon name="ArrowRight" className="size-3.5" aria-hidden />
          </Button>
        </div>
      </section>
    );
  }

  const data = query.data;
  const joined = Boolean(data?.joined);
  const link = data?.link ?? null;
  const displayLink = link?.replace(/^https?:\/\//, "") ?? null;
  const monthlyCents = data?.monthlyCents ?? 0;
  const totalEarnedCents = data?.totalEarnedCents ?? 0;
  const pendingCents = data?.pendingCents ?? 0;
  const payingCount = data?.payingCount ?? 0;
  const signupsCount = data?.signupsCount ?? 0;
  const recent = data?.recent ?? [];

  const handleGetLink = () => {
    if (query.isError || data?.available === false) {
      openUrlInExternalBrowser(PARTNER_URL);
      return;
    }
    enroll.mutate();
  };

  return (
    <section className="space-y-5" data-testid="referrals-tab">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">
            Refer a friend, earn 40% for life
          </h2>
          <p className="mt-0.5 text-xs text-subtle-foreground/75">
            1 Pro friend = $20/mo. 1 Ultra friend = $200/mo. Paid every month they stay.
          </p>
        </div>
        {joined ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1.5 text-xs"
            onClick={() => openUrlInExternalBrowser(PARTNER_URL)}
          >
            Payouts in Dub
            <Icon name="ExternalLink" className="size-3" aria-hidden />
          </Button>
        ) : null}
      </div>

      {joined && link ? (
        <div className="flex items-center gap-3 rounded-xl bg-surface-recessed px-4 py-3">
          <Icon name="Link" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">
            {displayLink}
          </span>
          <Button
            type="button"
            size="sm"
            className="h-8 shrink-0 gap-1.5 px-3 text-xs"
            onClick={() =>
              void copyToClipboardWithToast(link, {
                successMessage: "Referral link copied",
              })
            }
          >
            <Icon name="Copy" className="size-3.5" aria-hidden />
            Copy link
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-4 rounded-xl bg-surface-recessed px-4 py-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              Get your instant referral link
            </p>
            <p className="mt-0.5 text-xs text-subtle-foreground/75">
              No application form. Open Dub only later when you want to cash out ($50 min).
            </p>
            {enroll.error ? (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {enroll.error instanceof Error
                  ? enroll.error.message
                  : "Could not create your referral link."}{" "}
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={() => openUrlInExternalBrowser(PARTNER_URL)}
                >
                  Open Dub instead
                </button>
              </p>
            ) : null}
          </div>
          <Button
            type="button"
            size="sm"
            disabled={enroll.isPending || query.isPending}
            className="h-8 shrink-0 gap-1.5 px-3.5 text-xs"
            onClick={handleGetLink}
          >
            {enroll.isPending ? "Creating…" : "Get my link"}
            <Icon name="ArrowRight" className="size-3.5" aria-hidden />
          </Button>
        </div>
      )}

      <div className="flex gap-3">
        <Stat
          label="Recurring"
          value={`${formatReferralDollars(monthlyCents)}/mo`}
          sub={monthlyCents >= 5_000 ? "covers Pro" : "1 Pro = $20/mo"}
        />
        <Stat
          label="Paying friends"
          value={payingCount.toLocaleString("en-US")}
          sub={
            signupsCount > 0
              ? `of ${signupsCount.toLocaleString("en-US")} signed up`
              : "0 signed up"
          }
        />
        <Stat
          label="Total earned"
          value={formatReferralDollars(totalEarnedCents)}
          sub={
            pendingCents > 0
              ? `${formatReferralDollars(pendingCents)} pending`
              : "$50 min payout"
          }
        />
      </div>

      <div className={SETTINGS_CARD_CLASS}>
        <div className={SETTINGS_CARD_ROW_CLASS}>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-foreground">Auto-credit Monthly Wrapped</p>
            <p className="text-xs text-subtle-foreground/75">
              Include your referral link when you share Wrapped on X.
            </p>
          </div>
          <Switch
            checked={autoCreditWrapped}
            onCheckedChange={setAutoCreditWrapped}
            aria-label="Auto-credit Monthly Wrapped"
          />
        </div>
      </div>

      {joined ? (
        <div className="overflow-hidden rounded-xl bg-surface-recessed">
          <p className="px-4 pt-3.5 pb-1 text-2xs font-medium tracking-[0.08em] text-subtle-foreground uppercase">
            Recent
          </p>
          {recent.length > 0 ? (
            <div className="divide-y divide-border">
              {recent.map((item) => (
                <div key={item.id} className={SETTINGS_CARD_ROW_CLASS}>
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {item.kind === "sale" ? "Subscription" : "New sign-up"}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {shortDate(item.createdAt)}
                    {item.kind === "sale" && item.earningsCents > 0
                      ? ` · ${formatReferralDollars(item.earningsCents)}`
                      : ""}
                  </span>
                  {item.kind === "sale" ? (
                    <StatusPill ok={item.status === "paid" || item.status === "processed"}>
                      {item.status === "paid"
                        ? "Paid"
                        : item.status === "pending" || item.status === "hold"
                          ? "Pending"
                          : "Paying"}
                    </StatusPill>
                  ) : (
                    <span className="text-xs text-muted-foreground">Signed up</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="px-4 py-5 text-xs text-muted-foreground">
              No referrals yet. Copy your link above or share your Monthly Wrapped.
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
