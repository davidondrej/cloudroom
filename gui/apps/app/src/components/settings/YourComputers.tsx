import { COMPUTER } from "@cloudroom/domain";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { SETTINGS_CARD_ROW_CLASS } from "@/components/ui/settings-section";
import { appToast } from "@/components/ui/app-toast";
import { useDesktopUpdateInfo } from "@/hooks/useDesktopUpdateInfo";
import { publishBannerHeight } from "@/components/layout/DesktopUpdateBanner";
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

export function OpenMacButton({ mac }: { mac: YourMac }) {
  const { desktopApi, desktopInfo } = useDesktopUpdateInfo();
  const [opening, setOpening] = useState(false);
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
  if (!open || !mac.online) return null;
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

// Shown while this Mac stands in for your chosen Mac, which didn't answer at launch.
export function ComputerFallbackBanner() {
  const { desktopApi, desktopInfo } = useDesktopUpdateInfo();
  const fallback = desktopInfo?.computers?.fallback;
  const [retrying, setRetrying] = useState(false);
  if (!fallback || !desktopApi?.openComputer) return null;
  const retry = () => {
    setRetrying(true);
    void desktopApi
      .openComputer?.(fallback.handle)
      .finally(() => setRetrying(false));
  };
  return (
    <div
      ref={publishBannerHeight}
      role="status"
      className="flex shrink-0 items-center gap-3 border-b border-primary/30 bg-primary/10 px-4 py-2 text-sm"
    >
      <Icon
        name="Laptop"
        className="size-4 shrink-0 text-primary"
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">
        {fallback.back ? (
          <>
            <strong>{fallback.name} is back.</strong> Switch to keep working
            there.
          </>
        ) : (
          <>
            <strong>{fallback.name} is offline.</strong> You're using this {COMPUTER}
            until it's back.
          </>
        )}
      </span>
      <Button size="sm" disabled={retrying} onClick={retry}>
        {retrying ? "Opening…" : fallback.back ? "Switch" : "Retry"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void desktopApi.openComputer?.(null)}
      >
        Use this {COMPUTER}
      </Button>
    </div>
  );
}
