import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CloudVps } from "@cloudroom/sdk/browser";
import { Button } from "@cloudroom/shared-ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@cloudroom/shared-ui/dialog";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Switch } from "@cloudroom/shared-ui/switch";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { MachineLaunchCommand } from "@/components/dialogs/AddMachineDialog";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import { SETTINGS_CARD_CLASS, SETTINGS_CARD_ROW_CLASS, SettingsBadge } from "@/components/ui/settings-section";
import { OsTile, osFromName, shortOsName } from "@/components/machines/OsTile";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { sdk } from "@/lib/sdk";

const KEY = ["cloudroom-vps"];
const GB = 1024 ** 3;
export function useCloudVps({ poll = false }: { poll?: boolean } = {}) {
  const account = useCloudroomAccount();
  return useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => sdk.cloudroom.vps(signal),
    enabled: Boolean(account.data?.account),
    retry: false,
    staleTime: 30_000,
    refetchInterval: poll ? 3_000 : false,
  });
}

export function vpsSummary(vps: CloudVps): string {
  if (!vps.health) return "Offline";
  if (vps.busy) return `Busy: ${vps.busy}`;
  return `CPU ${Math.round(vps.health.cpu * 100)}% · ${vps.health.running} ${vps.health.running === 1 ? "agent" : "agents"} running`;
}
export function VpsMachineRow() {
  const vps = useCloudVps();
  const [open, setOpen] = useState(false);
  if (!vps.data?.connected) return null;
  const { name, health, busy } = vps.data;
  const os = health?.os ?? null;
  const label = name?.split(".")[0] ?? "VPS";
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(SETTINGS_CARD_ROW_CLASS, "w-full text-left transition-colors hover:bg-state-hover")}
      >
        <OsTile os={osFromName(os) ?? "linux"} />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-sm text-foreground">{label}</span>
            <SettingsBadge>VPS</SettingsBadge>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-subtle-foreground/75">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <MachineStatusDot connected={health !== null} />
              <span className={cn("min-w-0 truncate", busy && "text-warning-text")}>{health === null ? "Offline" : busy ? `Busy: ${busy}` : "Online"}</span>
            </span>
            {os ? <span className="truncate">{shortOsName(os)}</span> : null}
            {health ? <span className="shrink-0">{health.running} {health.running === 1 ? "agent" : "agents"} running</span> : null}
          </div>
        </div>
        <Icon name="ChevronRight" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      <Dialog open={open} onOpenChange={setOpen} modal={false}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{name ?? "Your VPS"}</DialogTitle>
            <DialogDescription>Cloud threads start here first. When it's busy, they use Cloudroom Cloud.</DialogDescription>
          </DialogHeader>
          <VpsSettingsBody onDisconnected={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
export function ConnectVpsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const code = useMutation({
    mutationFn: () => sdk.cloudroom.vpsAction({ action: "code" }) as Promise<{ code: string; expiresAt: number; command: string }>,
  });
  const vps = useCloudVps({ poll: open && code.isSuccess });
  const start = code.mutate;
  useEffect(() => {
    if (open) start();
  }, [open, start]);
  const ready = code.isSuccess && vps.data?.connected === true && vps.data.health !== null;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) void queryClient.invalidateQueries({ queryKey: KEY }); onOpenChange(next); }} modal={false}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Connect your VPS</DialogTitle>
          <DialogDescription>Run Cloud threads on your own server. When it's busy, new threads use Cloudroom Cloud.</DialogDescription>
        </DialogHeader>
        <ol className="flex flex-col gap-4">
          <Step n={1} title="Open your VPS terminal" detail="Hostinger: hPanel → VPS → Browser terminal. Anywhere else: ssh root@your-server" />
          <Step n={2} title="Paste this command">
            {code.isError ? (
              <p role="alert" className="text-sm text-destructive-text">{getMutationErrorMessage({ error: code.error, fallbackMessage: "Couldn't make a code." })}</p>
            ) : code.isSuccess ? (
              <MachineLaunchCommand key={code.data.command} command={code.data.command} expiresAt={code.data.expiresAt} onRegenerate={() => start()} />
            ) : (
              <p role="status" className="text-sm text-muted-foreground">Making a one-time code…</p>
            )}
          </Step>
          <Step n={3} title="Cloudroom sets up the rest" detail="Ubuntu or Debian. Installs Docker and Cloudroom. No domain, open ports, or tokens.">
            <div className="flex items-center gap-2.5 rounded-md bg-muted/40 px-3 py-2.5">
              {ready ? <MachineStatusDot connected /> : <Icon name="Spinner" className="size-4 shrink-0 animate-spin text-muted-foreground" />}
              <span role="status" className="min-w-0 flex-1 truncate text-sm text-foreground">
                {ready ? `${vps.data?.name ?? "Your VPS"} is connected` : "Waiting for your VPS…"}
              </span>
              {ready ? <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => onOpenChange(false)}>Done</Button> : null}
            </div>
          </Step>
        </ol>
      </DialogContent>
    </Dialog>
  );
}

function Step({ n, title, detail, children }: { n: number; title: string; detail?: string; children?: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-px grid size-5.5 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{n}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div>
          <p className="text-sm text-foreground">{title}</p>
          {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
        </div>
        {children}
      </div>
    </li>
  );
}
function VpsSettingsBody({ onDisconnected }: { onDisconnected: () => void }) {
  const queryClient = useQueryClient();
  const vps = useCloudVps();
  const change = useMutation({
    mutationFn: (input: { action: "settings"; useForCloud?: boolean; fallback?: boolean } | { action: "disconnect" }) => sdk.cloudroom.vpsAction(input),
    onSuccess: async (_, input) => {
      await queryClient.invalidateQueries({ queryKey: KEY });
      if (input.action === "disconnect") onDisconnected();
    },
  });
  if (!vps.data?.connected) return null;
  const { useForCloud, fallback, health } = vps.data;
  return (
    <div className="flex flex-col gap-3">
      <div className={SETTINGS_CARD_CLASS}>
        <ToggleRow label="Start new Cloud threads here" description="New threads pick VPS by default. Cloud stays one click away." checked={useForCloud} disabled={change.isPending} onChange={(on) => change.mutate({ action: "settings", useForCloud: on })} />
        <ToggleRow label="Use Cloud when it's busy" description="If CPU is over 95%, or memory or disk is over 90%, new threads start in Cloudroom Cloud and use Cloud Credits." checked={fallback} disabled={change.isPending} onChange={(on) => change.mutate({ action: "settings", fallback: on })} />
        <div className={SETTINGS_CARD_ROW_CLASS}>
          {health ? (
            <div className="grid w-full grid-cols-3 gap-5 py-1">
              <Meter label="CPU" value={`${Math.round(health.cpu * 100)}%`} used={health.cpu} />
              <Meter label="Memory" value={`${(health.memory.used / GB).toFixed(1)} of ${Math.round(health.memory.total / GB)} GB`} used={health.memory.used / health.memory.total} />
              <Meter label="Disk" value={`${Math.round(health.disk.used / GB)} of ${Math.round(health.disk.total / GB)} GB`} used={health.disk.used / health.disk.total} />
            </div>
          ) : (
            <p className="text-xs text-warning-text">Your VPS is offline. New threads start in Cloud until it's back.</p>
          )}
        </div>
        <div className={SETTINGS_CARD_ROW_CLASS}>
          <div className="min-w-0 flex-1">
            <p className="text-foreground">Disconnect</p>
            <p className="text-xs text-subtle-foreground/75">Its threads stop waking. To remove Cloudroom from the VPS, run the install command with `uninstall`.</p>
          </div>
          <Button variant="outline" size="sm" disabled={change.isPending} onClick={() => change.mutate({ action: "disconnect" })}>Disconnect</Button>
        </div>
      </div>
      {change.isError ? <p role="alert" className="text-sm text-destructive-text">{getMutationErrorMessage({ error: change.error, fallbackMessage: "Couldn't save." })}</p> : null}
    </div>
  );
}

function ToggleRow({ label, description, checked, disabled, onChange }: { label: string; description: string; checked: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className={SETTINGS_CARD_ROW_CLASS}>
      <div className="min-w-0 flex-1">
        <p className="text-foreground">{label}</p>
        <p className="text-xs text-subtle-foreground/75">{description}</p>
      </div>
      <Switch aria-label={label} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

function Meter({ label, value, used }: { label: string; value: string; used: number }) {
  return (
    <div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="text-foreground">{value}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", used > 0.9 ? "bg-warning" : "bg-primary")} style={{ width: `${Math.min(100, Math.round(used * 100))}%` }} />
      </div>
    </div>
  );
}
