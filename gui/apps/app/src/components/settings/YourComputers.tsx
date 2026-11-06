import { COMPUTER } from "@cloudroom/domain";
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@cloudroom/shared-ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { SETTINGS_CARD_ROW_CLASS } from "@/components/ui/settings-section";
import { appToast } from "@/components/ui/app-toast";
import { DESKTOP_DOWNLOAD_URL, useDesktopUpdateInfo } from "@/hooks/useDesktopUpdateInfo";
import { OsTile } from "@/components/machines/OsTile";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { callPluginRpc } from "@/lib/plugin-sdk-hooks";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { sdk } from "@/lib/sdk";
import { isPhoneApp, openMacOnPhone } from "@/cloud/cloud-mode";

export interface YourMac {
  handle: string;
  name: string;
  online: boolean;
  self: boolean;
  hostId: string | null;
  settingUp: boolean;
}

const YOUR_MACS_KEY = ["connect", "macs"] as const;

// Every Mac signed in to this Cloudroom account, from the Connect plugin (ADR 0238).
export function useYourMacs() {
  return useQuery({
    queryKey: YOUR_MACS_KEY,
    queryFn: async () =>
      ((await callPluginRpc(fetch, "connect", "macs", null)) as { macs: YourMac[] }).macs,
    staleTime: 30_000,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.some((mac) => mac.settingUp) ? 3_000 : false,
  });
}

interface MacLike {
  name: string;
  online: boolean;
  self: boolean;
}

// Every install that ever signed in stays on the relay, so one Mac can show up
// several times. Keep this Mac and online Macs; keep one offline Mac per name.
export function withoutOldCopies<T extends MacLike>(macs: readonly T[]): T[] {
  const live = macs.filter((mac) => mac.self || mac.online);
  const seen = new Set(live.map((mac) => mac.name));
  return macs.filter((mac) => {
    if (mac.self || mac.online) return true;
    if (seen.has(mac.name)) return false;
    seen.add(mac.name);
    return true;
  });
}

// True when the "You're looking at" card can switch Macs, so rows skip their own Open buttons.
export function useMacSwitcher() {
  const { desktopApi, desktopInfo } = useDesktopUpdateInfo();
  return !isPhoneApp() && Boolean(desktopInfo?.computers && desktopApi?.openComputer);
}

export function OpenMacButton({ mac }: { mac: YourMac }) {
  const { desktopApi, desktopInfo } = useDesktopUpdateInfo();
  const [opening, setOpening] = useState(false);
  const switcher = useMacSwitcher();
  const computers = desktopInfo?.computers;
  const onScreen =
    computers?.viewing ??
    computers?.list.find((computer) => computer.self)?.handle;
  const open = isPhoneApp()
    ? mac.self
      ? null
      : () => openMacOnPhone(mac.handle)
    : desktopApi?.openComputer && mac.handle !== onScreen
      ? () => desktopApi.openComputer?.(mac.handle)
      : null;
  if (switcher || !open || !mac.online) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={opening}
      onClick={() => {
        setOpening(true);
        void Promise.resolve(open())
          .catch((error: unknown) =>
            appToast.error(getMutationErrorMessage({ error, fallbackMessage: `Couldn't open ${mac.name}.` })),
          )
          .finally(() => setOpening(false));
      }}
    >
      {opening ? "Opening…" : "Open"}
      <Icon name="ArrowRight" aria-hidden />
    </Button>
  );
}

// A Mac on your account that this Cloudroom doesn't run threads on yet.
export function YourMacRow({ mac }: { mac: YourMac }) {
  const queryClient = useQueryClient();
  const run = useMutation({
    meta: { showErrorToast: false },
    mutationFn: async () => {
      let host = await sdk.hosts.experimental_create({
        key: crypto.randomUUID(),
        machineProviderId: "mac",
        inputs: { handle: mac.handle },
        wait: false,
      });
      void queryClient.invalidateQueries({ queryKey: YOUR_MACS_KEY });
      while (host.lifecycle.phase === "creating") {
        await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
        host = await sdk.hosts.get({ hostId: host.id });
      }
      if (host.lifecycle.phase !== "active") {
        throw new Error(host.lifecycle.message ?? `Couldn't set up ${mac.name}.`);
      }
    },
    onSuccess: () => appToast.success(`${mac.name} can run threads now`),
    onError: (error) =>
      appToast.error(
        getMutationErrorMessage({ error, fallbackMessage: `Couldn't set up ${mac.name}.` }),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: YOUR_MACS_KEY }),
  });
  const busy = run.isPending || mac.settingUp;
  return (
    <div className={SETTINGS_CARD_ROW_CLASS}>
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-foreground",
          !mac.online && "opacity-55",
        )}
      >
        <Icon name="Laptop" className="size-4" aria-hidden />
      </span>
      <div className={cn("min-w-0 flex-1 space-y-0.5", !mac.online && "opacity-55")}>
        <span className="block min-w-0 truncate text-sm text-foreground">{mac.name}</span>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-subtle-foreground/75">
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                mac.online ? "bg-success" : "border border-subtle-foreground/75",
              )}
            />
            {mac.online ? "Online" : "Offline"}
          </span>
          <span>{busy ? "Setting up…" : "Not running threads yet"}</span>
        </div>
      </div>
      <OpenMacButton mac={mac} />
      <Button
        variant="outline"
        size="sm"
        disabled={!mac.online || busy}
        onClick={() => run.mutate()}
      >
        {busy ? "Setting up…" : "Run threads here"}
      </Button>
    </div>
  );
}

// A Mac you were using dropped: keep trying it for 30 seconds, then stay on this Mac (design C, 2026-11-06).
// Once it's back, a toast offers to switch. The app never switches by itself mid-work.
export function LostMacDialog() {
  const { desktopApi, desktopInfo } = useDesktopUpdateInfo();
  const fallback = desktopInfo?.computers?.fallback ?? null;
  const retryUntil = fallback?.retryUntil ?? null;
  const seconds = useSecondsLeft(retryUntil);
  const back = fallback?.back === true && retryUntil === null ? fallback : null;
  const backHandle = back?.handle ?? null;
  const backName = back?.name ?? null;
  const openComputer = desktopApi?.openComputer;

  useEffect(() => {
    if (backHandle === null || backName === null || !openComputer) return;
    const id = `mac-back-${backHandle}`;
    appToast.message(`${backName} is back`, {
      id,
      duration: Infinity,
      action: { label: "Switch", onClick: () => void openComputer(backHandle) },
    });
    return () => {
      appToast.dismiss(id);
    };
  }, [backHandle, backName, openComputer]);

  const reconnect = desktopApi?.reconnectComputer;
  if (fallback === null || retryUntil === null || !reconnect) return null;
  const stay = (event: Event) => event.preventDefault();
  return (
    <Dialog open>
      <DialogContent
        hideCloseButton
        className="max-w-[500px] justify-items-center gap-0 rounded-xl p-8 text-center"
        onOpenAutoFocus={stay}
        onEscapeKeyDown={stay}
        onPointerDownOutside={stay}
        onInteractOutside={stay}
      >
        <div className="flex items-start">
          <MacPicture name={fallback.name} lost />
          <div className="flex h-14 w-28 items-center px-1">
            <div className="w-full border-t-2 border-dashed border-warning" />
          </div>
          <MacPicture name={`This ${COMPUTER}`} />
        </div>
        <DialogTitle className="mt-6 text-2xl font-semibold">Lost {fallback.name}</DialogTitle>
        <DialogDescription className="mt-2 text-[15px] text-muted-foreground">
          Switching to this {COMPUTER} in {seconds} {seconds === 1 ? "second" : "seconds"}
        </DialogDescription>
        <div className="mt-6 flex gap-2.5">
          <Button variant="ghost" onClick={() => void reconnect(true)}>
            Keep trying
          </Button>
          <Button variant="outline" onClick={() => void reconnect(false)}>
            Use this {COMPUTER} now
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MacPicture({ name, lost = false }: { name: string; lost?: boolean }) {
  return (
    <div className={cn("flex w-32 flex-col items-center gap-2.5", lost && "opacity-45")}>
      <OsTile os={MAC_OS} className={BIG_TILE} />
      <span className="max-w-full truncate text-sm text-foreground">{name}</span>
    </div>
  );
}

function useSecondsLeft(until: number | null): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (until === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [until]);
  return until === null ? 0 : Math.max(0, Math.floor((until - now) / 1_000));
}

const MAC_OS = COMPUTER === "Mac" ? "macos" : "linux";
const BIG_TILE = "size-14 rounded-2xl [&_svg]:size-6";
const CARD_BUTTON = "h-9 px-3.5 text-[13px]";

// Settings → Machines: which Mac this window shows, and a switch to your other Macs (ADR 0261).
export function ViewingMacCard() {
  const { desktopApi, desktopInfo } = useDesktopUpdateInfo();
  const [opening, setOpening] = useState<string | null>(null);
  const computers = desktopInfo?.computers;
  const openComputer = desktopApi?.openComputer;
  const refreshComputers = desktopApi?.refreshComputers;
  // The desktop app's list of Macs can be minutes old: ask for a fresh one when this card opens.
  useEffect(() => refreshComputers?.(), [refreshComputers]);
  if (isPhoneApp() || !computers || !openComputer) return null;

  const macs = withoutOldCopies(computers.list);
  const self = computers.list.find((mac) => mac.self);
  const selfName = self?.name ?? `This ${COMPUTER}`;
  const onScreen = computers.viewing ?? self?.handle ?? null;
  const viewed = computers.list.find((mac) => !mac.self && mac.handle === computers.viewing);
  const others = macs.filter((mac) => !mac.self);
  const fallback = computers.fallback;
  const open = (handle: string | null, name: string) => {
    setOpening(name);
    void openComputer(handle)
      .catch((error: unknown) =>
        appToast.error(getMutationErrorMessage({ error, fallbackMessage: `Couldn't open ${name}.` })),
      )
      .finally(() => setOpening(null));
  };

  const switchMenu = others.length > 0 && (
    <DropdownMenu onOpenChange={(open) => open && refreshComputers?.()}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className={CARD_BUTTON}>
          Switch {COMPUTER}
          <Icon name="ChevronDown" className="text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-1.5">
        {macs.map((mac) => {
          const here = mac.handle === onScreen;
          const canOpen = !here && (mac.self || mac.online);
          return (
            <DropdownMenuItem
              key={mac.handle}
              disabled={!here && !canOpen}
              className="gap-2.5 px-2.5 py-2"
              onSelect={() => {
                if (canOpen) open(mac.self ? null : mac.handle, mac.name);
              }}
            >
              <OsTile os={MAC_OS} className={cn(!here && !canOpen && "opacity-55")} />
              <span className={cn("min-w-0 flex-1", !here && !canOpen && "opacity-55")}>
                <span className="block truncate text-sm text-foreground">{mac.name}</span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {!here && !mac.self ? <StatusDot online={mac.online} /> : null}
                  {here ? "Showing now" : mac.self ? `This ${COMPUTER}` : mac.online ? "Online" : "Offline"}
                </span>
              </span>
              {here ? (
                <Icon name="Check" className="text-primary" aria-hidden />
              ) : canOpen ? (
                <span className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground">
                  Open
                </span>
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  let label = "You’re looking at";
  let name = selfName;
  let detail: ReactNode = (
    <>
      <span className="inline-flex items-center gap-1.5">
        <StatusDot online />
        This {COMPUTER}
      </span>
      <span>
        {others.length === 0
          ? `No other ${COMPUTER}s yet`
          : `${others.length} other ${others.length === 1 ? COMPUTER : `${COMPUTER}s`} on your account`}
      </span>
    </>
  );
  let tone = "ring-primary/35";
  let actions: ReactNode = switchMenu || (
    <Button
      variant="outline"
      className={CARD_BUTTON}
      onClick={() => openUrlInExternalBrowser(DESKTOP_DOWNLOAD_URL)}
    >
      <Icon name="Plus" aria-hidden />
      Add another {COMPUTER}
    </Button>
  );

  if (opening !== null) {
    label = "Opening";
    name = opening;
    detail = (
      <span className="inline-flex items-center gap-1.5 text-primary">
        <Icon name="Spinner" className="size-3.5 animate-spin" aria-hidden />
        Connecting…
      </span>
    );
    actions = null;
  } else if (fallback?.back) {
    detail = (
      <>
        <span className="inline-flex items-center gap-1.5">
          <StatusDot online />
          This {COMPUTER}
        </span>
        <span className="text-primary">{fallback.name} is back online</span>
      </>
    );
    actions = (
      <>
        <Button variant="ghost" className={CARD_BUTTON} onClick={() => void openComputer(null)}>
          Stay here
        </Button>
        <Button className={CARD_BUTTON} onClick={() => open(fallback.handle, fallback.name)}>
          Switch to {fallback.name}
        </Button>
      </>
    );
  } else if (viewed) {
    label = `You’re looking at another ${COMPUTER}`;
    name = viewed.name;
    detail = (
      <>
        <span className="inline-flex items-center gap-1.5">
          <StatusDot online={viewed.online} />
          {viewed.online ? "Online" : "Offline"}
        </span>
        <span>You’re sitting at {selfName}</span>
      </>
    );
    tone = "ring-primary/70 bg-primary/[0.07]";
    actions = (
      <>
        <Button variant="outline" className={CARD_BUTTON} onClick={() => open(null, selfName)}>
          <Icon name="ArrowLeft" aria-hidden />
          Back to this {COMPUTER}
        </Button>
        {switchMenu}
      </>
    );
  }

  return (
    <div className={cn("flex items-center gap-4 rounded-xl bg-surface-recessed p-5 ring-1 ring-inset", tone)}>
      <OsTile os={MAC_OS} className={BIG_TILE} />
      <div className="min-w-0 flex-1">
        <div className="text-xs text-subtle-foreground/75">{label}</div>
        <div className="truncate text-base font-semibold text-foreground">{name}</div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-subtle-foreground/75">
          {detail}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

function StatusDot({ online }: { online: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        online ? "bg-success" : "border border-subtle-foreground/75",
      )}
    />
  );
}
