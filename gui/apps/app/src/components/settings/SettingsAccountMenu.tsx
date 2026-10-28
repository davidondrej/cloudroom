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
  const machines = getSettingsSectionRoutePath("machines");

  if (!email) {
    return (
      <Link
        to={machines}
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
  const creditsLeft =
    usage && usage.credits !== null
      ? Math.max(0, Math.floor(usage.creditsLimit - usage.credits))
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
          <DropdownMenuSeparator />
          <MenuItem
            icon="UserRound"
            label="Account & machines"
            onSelect={() => go(machines)}
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
