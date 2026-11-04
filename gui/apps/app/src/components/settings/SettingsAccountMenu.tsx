import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import { Icon, type IconName } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { CreditsBar } from "@/components/CloudQueue";
import { useCloseMobileSidebar } from "@/components/ui/sidebar.js";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { getPluginConfigurationRoutePath } from "@/lib/route-paths";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { SignOutDialog } from "./CloudroomAccountSettings";
import { getSettingsSectionRoutePath } from "./settings-sections";

const BILLING_URL = "https://www.cloudroom.dev/billing";
const ROW_CLASS =
  "flex w-full items-center gap-2.5 rounded-md px-2 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent";

function Avatar({
  email,
  ready,
  inMenu,
}: {
  email: string;
  ready: boolean;
  inMenu?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-full bg-foreground/15 font-semibold text-foreground",
        inMenu ? "size-8 text-xs" : "size-6 text-[11px]",
      )}
    >
      {email.charAt(0).toUpperCase()}
      <span
        className={cn(
          "absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2",
          ready ? "bg-success" : "bg-warning",
          inMenu ? "ring-popover" : "ring-sidebar",
        )}
      />
    </span>
  );
}

function MenuItem({
  icon,
  label,
  detail,
  onSelect,
}: {
  icon: IconName;
  label: string;
  detail?: ReactNode;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem className="gap-2.5 py-1.5" onSelect={onSelect}>
      <Icon
        name={icon}
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail}
    </DropdownMenuItem>
  );
}

export function SettingsAccountMenu({ usagePage }: { usagePage: boolean }) {
  const status = useCloudroomAccount().data;
  const navigate = useNavigate();
  const closeOnMobile = useCloseMobileSidebar();
  const [signOutOpen, setSignOutOpen] = useState(false);
  const email = status?.signingIn ? undefined : status?.account?.email;
  const account = getSettingsSectionRoutePath("account");

  if (!email) {
    return (
      <Link
        to={account}
        onClick={closeOnMobile}
        data-testid="settings-account-card"
        className={cn(ROW_CLASS, "border-t border-foreground/10 py-2")}
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground/15">
          <Icon name="UserRound" className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">Sign in to Cloudroom</span>
          <span className="block truncate text-xs text-muted-foreground">
            Local threads only
          </span>
        </span>
        <Icon
          name="ChevronRight"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      </Link>
    );
  }

  const ready = status?.ready === true;
  const plan = status?.plan
    ? `${status.plan.charAt(0).toUpperCase()}${status.plan.slice(1)} plan`
    : null;
  const connection = ready ? "Cloud connected" : "Cloud unavailable";
  const usage = status?.planUsage;
  // Plan credits left plus extra credits (packs, ADR 0317), like /billing.
  const extra = Math.max(0, Math.floor(usage?.extraCredits ?? 0));
  const creditsLeft =
    usage && usage.credits !== null
      ? Math.max(0, Math.floor(usage.creditsLimit - usage.credits)) + extra
      : null;
  const go = (to: string) => {
    navigate(to);
    closeOnMobile();
  };

  return (
    <div className="border-t border-foreground/10 pt-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="settings-account-card"
            title={connection}
            className={cn(
              ROW_CLASS,
              "h-10 data-[state=open]:bg-sidebar-accent",
            )}
          >
            <Avatar email={email} ready={ready} />
            <span className="min-w-0 flex-1 truncate">{email}</span>
            <Icon
              name="ChevronsUpDown"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          mobileTitle="Account"
          className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-60 border-foreground/10 p-1.5"
        >
          <div className="flex items-center gap-2.5 px-2 pt-1.5 pb-2">
            <Avatar email={email} ready={ready} inMenu />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-foreground">
                {email}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {plan ? `${plan} · ${connection}` : connection}
              </span>
            </span>
          </div>
          {/* Paid plans see their credits and buy packs or upgrade on the billing page (ADR 0317). */}
          {usage && usage.plan !== "free" && creditsLeft !== null && (
            <div className="px-2 pb-2.5">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="text-muted-foreground tabular-nums">
                  <span className="font-semibold text-foreground">
                    {creditsLeft.toLocaleString("en-US")}
                  </span>{" "}
                  {extra > 0 ? "credits left" : `of ${usage.creditsLimit.toLocaleString("en-US")} credits left`}
                </span>
                <button
                  type="button"
                  className="shrink-0 border border-primary/60 px-1.5 leading-5 text-primary-text hover:bg-primary/10"
                  onClick={() => openUrlInExternalBrowser(BILLING_URL)}
                >
                  + buy more
                </button>
              </div>
              <CreditsBar
                className="mt-1.5 h-1 bg-foreground/10"
                plan={creditsLeft - extra}
                limit={usage.creditsLimit}
                extra={extra}
                extraTotal={usage.extraCreditsTotal ?? 0}
                planClassName="bg-primary"
                edgeClassName="border-popover"
              />
              {extra > 0 && (
                <p className="mt-1.5 flex gap-3 text-2xs text-muted-foreground tabular-nums">
                  <span className="flex items-center gap-1">
                    <span className="size-1.5 bg-sky-400" />
                    <span className="text-sky-600 dark:text-sky-400">{extra.toLocaleString("en-US")}</span> extra
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="size-1.5 bg-primary" />
                    {(creditsLeft - extra).toLocaleString("en-US")} plan
                  </span>
                </p>
              )}
            </div>
          )}
          <DropdownMenuSeparator />
          <MenuItem
            icon="UserRound"
            label="Account"
            onSelect={() => go(account)}
          />
          {usage && (
            <MenuItem
              icon="ChartColumn"
              label="Usage"
              detail={
                creditsLeft === null ? null : (
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {creditsLeft.toLocaleString("en-US")} credits left
                  </span>
                )
              }
              onSelect={() =>
                usagePage
                  ? go(
                      getPluginConfigurationRoutePath({
                        pluginId: "provider-usage",
                      }),
                    )
                  : openUrlInExternalBrowser(BILLING_URL)
              }
            />
          )}
          <MenuItem
            icon="CreditCard"
            label="Plan & billing"
            detail={
              <Icon
                name="ExternalLink"
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden
              />
            }
            onSelect={() => openUrlInExternalBrowser(BILLING_URL)}
          />
          <DropdownMenuSeparator />
          <MenuItem
            icon="LogOut"
            label="Sign out"
            onSelect={() => setSignOutOpen(true)}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <SignOutDialog open={signOutOpen} onOpenChange={setSignOutOpen} />
    </div>
  );
}
