import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@cloudroom/shared-ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cloudroom/shared-ui/tooltip";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { SidebarMenuItem } from "@/components/ui/sidebar";
import { appToast } from "@/components/ui/app-toast";
import { useOpenSetup, useSetupProgress } from "@/components/Onboarding";
import { useCloudroomAccount, useCloudroomSignIn } from "@/hooks/queries/cloudroom-queries";
import { getSettingsRoutePath } from "@/lib/route-paths";
import { sdk } from "@/lib/sdk";

const FOOTER_ICON_BUTTON_CLASS = "relative size-8 p-0 text-muted-foreground hover:text-sidebar-foreground [&_[data-icon-root]]:size-4";

export function CloudroomSignInButton() {
  const status = useCloudroomAccount();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const action = useCloudroomSignIn();
  const openSetup = useOpenSetup();
  const setupDone = useSetupProgress().complete;
  const [menuOpen, setMenuOpen] = useState(false);
  const logout = useMutation({
    mutationFn: () => sdk.cloudroom.logout(),
    onSuccess: () => {
      setMenuOpen(false);
      return queryClient.invalidateQueries({ queryKey: ["cloudroom-account"] });
    },
    onError: (error) => appToast.error(error.message),
  });
  const signInError = status.data?.signInError;
  const accountId = status.data?.account?.id;
  useEffect(() => { if (signInError) appToast.error(signInError); }, [signInError]);
  useEffect(() => { void queryClient.invalidateQueries({ queryKey: ["cloudroom-connection"] }); }, [queryClient, accountId]);
  const checking = status.isPending;
  const account = status.data?.account;
  const signingIn = status.data?.signingIn === true;
  const label = checking || account ? "Account" : signingIn ? "Cancel login" : "Set up Cloudroom";
  const tooltip = account ? `Account (${account.email})${setupDone ? "" : " · Finish setup"}` : signingIn ? "Cancel login" : checking ? "Checking your account" : "Set up Cloudroom";
  const button = <Button variant="ghost" className={cn(FOOTER_ICON_BUTTON_CLASS, "data-[state=open]:bg-state-active data-[state=open]:text-foreground")} aria-label={label} disabled={action.isPending || checking} onClick={account ? undefined : () => (signingIn ? action.mutate("cancel") : openSetup(true))}>
    {checking || signingIn || action.isPending ? <Icon name="Loading" className="animate-spin" aria-hidden /> : <Icon name="UserRound" aria-hidden />}
    {!checking && !signingIn && (!account || !setupDone) && <span className={cn("absolute right-1.5 top-1.5 size-1.5 rounded-full", account ? "bg-primary" : "bg-destructive")} aria-hidden />}
  </Button>;
  return <SidebarMenuItem data-footer-item="cloudroom-account">
    <Popover open={menuOpen} onOpenChange={setMenuOpen}>
      <Tooltip>
        <TooltipTrigger asChild>{account ? <PopoverTrigger asChild>{button}</PopoverTrigger> : button}</TooltipTrigger>
        <TooltipContent side="top">{tooltip}</TooltipContent>
      </Tooltip>
      {account && <PopoverContent side="top" align="start" sideOffset={6} mobileTitle="Account" aria-label="Account" className="w-64 p-3">
        <p className="text-xs text-muted-foreground">Signed in as</p>
        <p className="truncate text-sm font-medium">{account.email}</p>
        <p className="mt-1 text-xs text-muted-foreground">{status.data?.ready ? "Cloud connected" : "Cloud unavailable"}</p>
        <div className="mt-3 flex flex-col gap-1 border-t pt-2">
          <Button variant="ghost" size="sm" className="justify-start" onClick={() => { setMenuOpen(false); openSetup(true); }}>{setupDone ? "Setup" : "Finish setup"}</Button>
          <Button variant="ghost" size="sm" className="justify-start" onClick={() => { setMenuOpen(false); void navigate(getSettingsRoutePath("machines")); }}>Account settings</Button>
          <Button variant="ghost" size="sm" className="justify-start text-destructive hover:text-destructive" disabled={logout.isPending} onClick={() => logout.mutate()}>Log out</Button>
        </div>
      </PopoverContent>}
    </Popover>
  </SidebarMenuItem>;
}
