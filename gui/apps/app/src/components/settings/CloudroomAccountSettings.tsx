import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@cloudroom/shared-ui/dropdown-menu";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { SETTINGS_CARD_CLASS, SETTINGS_CARD_ROW_CLASS, SettingsSection } from "@/components/ui/settings-section";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { MacAccessMenuItems, useMacAccessLevel, MAC_ACCESS_TITLE } from "@/components/sidebar/MacAccessChip";
import { FixPrompt } from "@/components/ui/fix-prompt";
import { ConfirmDeleteDialog, ConfirmDeleteDialogContent } from "@/components/dialogs/ConfirmDeleteDialog";
import { cloudUnavailableFixPrompt, syncFixPrompt } from "@/lib/fix-prompts";
import { SelfHostedCoreForm } from "./SelfHostedCoreForm";

function useRefreshCloudroom() {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ["cloudroom-account"] }), queryClient.invalidateQueries({ queryKey: ["cloudroom-connection"] })]);
  };
}

export function CloudroomAccountSettings() {
  const queryClient = useQueryClient();
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const status = useCloudroomAccount();
  const refresh = useRefreshCloudroom();
  const action = useMutation({
    mutationFn: async (kind: "sign-in" | "cancel") => {
      if (kind === "sign-in") {
        const { url } = await sdk.cloudroom.signIn();
        setSignInUrl(url);
        openUrlInExternalBrowser(url);
      } else {
        await sdk.cloudroom[kind]();
        setSignInUrl(null);
      }
    },
    onSuccess: refresh,
  });
  const check = useMutation({
    mutationFn: async () => {
      await sdk.cloudroom.checkPreviews();
      for (let second = 0; second < 12; second++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if ((await sdk.cloudroom.status()).previews?.state === "connected") return await refresh();
      }
    },
    onSettled: refresh,
  });
  const account = status.data?.account;
  const ready = status.data?.ready;
  useEffect(() => { void queryClient.invalidateQueries({ queryKey: ["cloudroom-connection"] }); }, [queryClient, account?.id, ready]);
  const error = action.error instanceof Error ? action.error.message : status.data?.signInError;
  const sync = status.data?.sync;
  const syncBroken = ready && sync && (sync.issue || sync.state === "offline" || sync.state === "conflict");
  const previews = status.data?.previews;
  const resetCheck = check.reset;
  useEffect(() => { if (previews?.state === "connected") resetCheck(); }, [previews?.state, resetCheck]);
  const signedIn = account && !status.data?.signingIn;
  return <>
    {signedIn ? <section className="flex flex-col items-center gap-3 text-center">
      <h2 className="sr-only">Cloudroom account</h2>
      <span aria-hidden className="grid size-14 place-items-center rounded-full bg-primary text-xl font-semibold text-primary-foreground">{account.email.charAt(0).toUpperCase()}</span>
      <div className="min-w-0 max-w-full">
        <p className="truncate text-base font-semibold text-foreground">{account.email}</p>
        <div className="mt-1.5 flex flex-wrap justify-center gap-x-4 gap-y-1">
          <StatusPill ok={Boolean(ready)}>{ready ? "Cloud connected" : status.data?.error ?? "Cloud is unavailable. Your VM may still be working."}</StatusPill>
          {previews && <StatusPill ok={previews.state === "connected"} title={previews.issue ?? previews.message ?? undefined}>{previews.state === "connected" ? "Previews ready" : "Previews reconnecting"}</StatusPill>}
          {sync && <StatusPill ok={sync.state === "synced"} title="Skills and portable agent settings sync automatically.">{sync.state === "synced" ? "Synced" : `Sync: ${sync.state}`}</StatusPill>}
        </div>
      </div>
      <div className="w-full space-y-3 text-left empty:hidden">
        {!ready && <FixPrompt prompt={cloudUnavailableFixPrompt(status.data?.error)} />}
        {sync && (sync.issue || sync.conflicts) ? <p role="status" className="text-sm">{sync.issue ?? `${sync.conflicts} conflicting files need review.`}</p> : null}
        {previews?.explained && previews.state !== "connected" && previews.message ? <div role="status" className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-center text-sm">
          <p className="flex items-center justify-center gap-1.5 font-medium text-foreground"><Icon name="AlertTriangle" className="size-4 shrink-0 text-warning-text" aria-hidden />{MAC_ACCESS_TITLE} and previews can't connect</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {previews.message}{" "}
            {check.isPending ? "Checking…" : <>{check.isSuccess && "Still can't connect. "}<Button variant="link" className="h-auto p-0 align-baseline text-xs font-normal text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => check.mutate()}>Check now</Button></>}
          </p>
        </div> : null}
        {sync && syncBroken && <FixPrompt prompt={syncFixPrompt(sync.state, sync.issue)} />}
        {error && <p role="alert" className="text-sm">{error}</p>}
      </div>
    </section> : <SettingsSection title="Cloudroom account" description="Sign in to connect your existing cloud VM. Local execution stays available.">
      <div className="space-y-3 text-sm">
        <p>{account ? account.email : "Not signed in to Cloudroom"}</p>
        {status.isError && <p role="alert">Could not reach the local Cloudroom backend.</p>}
        {error && <p role="alert">{error}</p>}
        {status.data?.signingIn ? <>
          <p role="status">Finish signing in and confirm your account in the browser.</p>
          <div className="flex gap-2">{signInUrl && <Button variant="outline" onClick={() => openUrlInExternalBrowser(signInUrl)}>Open browser again</Button>}<Button variant="outline" disabled={action.isPending} onClick={() => action.mutate("cancel")}>Cancel sign-in</Button></div>
        </> : !status.data?.selfHosted && <div className="flex gap-2"><Button disabled={action.isPending || status.isPending || status.isError} onClick={() => action.mutate("sign-in")}>Sign in to Cloudroom</Button></div>}
        {status.data && !account && !status.data.signingIn && <SelfHostedCoreForm connected={status.data.selfHosted === true} ready={status.data.ready} error={status.data.error} />}
      </div>
    </SettingsSection>}
    {signedIn && <BillingRow />}
  </>;
}

function StatusPill({ ok, title, children }: { ok: boolean; title?: string; children: ReactNode }) {
  return <span role="status" title={title} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
    <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", ok ? "bg-success" : "bg-warning")} />
    {children}
  </span>;
}

// Plan, usage, and invoices live on the website (web/app/billing).
function BillingRow() {
  return <div className={SETTINGS_CARD_CLASS}>
    <div className={SETTINGS_CARD_ROW_CLASS}>
      <div className="min-w-0 flex-1">
        <p className="text-foreground">Plan & billing</p>
        <p className="text-xs text-subtle-foreground/75">Your plan, usage, and invoices.</p>
      </div>
      <Button variant="ghost" size="sm" className="text-muted-foreground" aria-label="Open plan and billing" onClick={() => openUrlInExternalBrowser("https://www.cloudroom.dev/billing")}>Open<Icon name="ExternalLink" aria-hidden /></Button>
    </div>
  </div>;
}

export function MacAccessControl() {
  const status = useCloudroomAccount();
  const { current, select, saving } = useMacAccessLevel();
  if (!status.data?.account || status.data.signingIn || status.data.macAccessSupported === false) return null;
  return <div className="flex shrink-0 items-center gap-2">
    <span className="text-xs text-subtle-foreground/75 max-sm:hidden">{MAC_ACCESS_TITLE}</span>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`${MAC_ACCESS_TITLE}: ${current.label}`} disabled={saving}>{current.label}<Icon name="ChevronDown" className="text-muted-foreground" aria-hidden /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" mobileTitle={MAC_ACCESS_TITLE} className="w-72 p-1.5"><MacAccessMenuItems current={current} select={select} /></DropdownMenuContent>
    </DropdownMenu>
  </div>;
}

// Bottom of the Account page. The confirm step keeps sign-out from being a single stray click.
export function CloudroomSignOut() {
  const status = useCloudroomAccount();
  const [open, setOpen] = useState(false);
  if (!status.data?.account || status.data.signingIn) return null;
  return <div className="flex flex-col items-center gap-2">
    <Button variant="outline" size="sm" onClick={() => setOpen(true)}>Sign out</Button>
    <SignOutDialog open={open} onOpenChange={setOpen} />
  </div>;
}

export function SignOutDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const refresh = useRefreshCloudroom();
  const logout = useMutation({ mutationFn: () => sdk.cloudroom.logout(), onSuccess: async () => { onOpenChange(false); await refresh(); } });
  const resetLogout = logout.reset;
  useEffect(() => { if (open) resetLogout(); }, [open, resetLogout]);
  return <ConfirmDeleteDialog open={open} onOpenChange={onOpenChange}>
    <ConfirmDeleteDialogContent
      title="Sign out of this app?"
      description={<>Cloud agents keep running and local history stays. To switch accounts, sign out first. Existing cloud threads stay on their original account and VM.{logout.error instanceof Error && <span role="alert" className="mt-2 block text-destructive">{logout.error.message}</span>}</>}
      confirmLabel="Sign out"
      pending={logout.isPending}
      onConfirm={() => logout.mutate()}
      onCancel={() => onOpenChange(false)}
    />
  </ConfirmDeleteDialog>;
}
