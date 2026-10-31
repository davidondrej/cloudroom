import { useEffect, useId, useState } from "react";
import type { BbDesktopInfo, BbDesktopVitals } from "@cloudroom/desktop-contract";
import { getBbDesktopInfo } from "@/lib/bb-desktop";
import { useCloudroomAccount, useCloudroomConnection } from "@/hooks/queries/cloudroom-queries";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import type { UpgradePrompt } from "@/lib/upgrade-prompt";

export type LaptopHint = "battery" | "memory" | "heat" | "cpu" | "network" | "disk";
export type LaptopKind = "battery" | "load" | "network" | "disk";
export type LaptopPlace = "new-thread" | "running";
export interface LaptopShown { kind: LaptopKind; at: number }

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WEEK = 7 * 24 * HOUR;
const DROP_WINDOW = 15 * MINUTE;
const SHOWN_KEY = "cloudroom.laptopHints.shown";

export const LAPTOP_HINT_PROMPT: Record<LaptopKind, UpgradePrompt> = { battery: "mac_battery", load: "mac_load", network: "mac_network", disk: "mac_disk" };

export function laptopHintKind(hint: LaptopHint): LaptopKind {
  return hint === "memory" || hint === "heat" || hint === "cpu" ? "load" : hint;
}

function atLimit(vitals: BbDesktopVitals, drops: number, online: boolean, place: LaptopPlace, github: boolean, now: number): LaptopHint[] {
  const lasted = (since: number | null, ms: number) => since !== null && now - since >= ms;
  const fresh = place === "new-thread";
  const hints: (LaptopHint | false)[] = [
    vitals.battery !== null && vitals.battery <= 30 && "battery",
    fresh && lasted(vitals.memoryRedSince, 1.5 * MINUTE) && "memory",
    fresh && lasted(vitals.hotSince, 1.5 * MINUTE) && "heat",
    fresh && lasted(vitals.cpuBusySince, 3 * MINUTE) && "cpu",
    online && drops >= 3 && (!fresh || github) && "network",
    fresh && vitals.diskFreeGb !== null && vitals.diskFreeGb < 15 && "disk",
  ];
  return hints.filter((hint): hint is LaptopHint => hint !== false);
}

export interface LaptopInput {
  vitals: BbDesktopVitals;
  drops: number;
  online: boolean;
  place: LaptopPlace;
  github: boolean;
  paid: boolean;
  lastNewCloudAt: number | null;
  shown: readonly LaptopShown[];
  active: LaptopKind | null;
  now: number;
}

export function pickLaptopHint(input: LaptopInput): LaptopHint | null {
  const { now, lastNewCloudAt, active } = input;
  if (lastNewCloudAt !== null && now - lastNewCloudAt < (input.paid ? 24 : 12) * HOUR) return null;
  const recent = input.shown.filter((entry) => now - entry.at < WEEK);
  const allowed = (hint: LaptopHint) => {
    const kind = laptopHintKind(hint);
    return kind === active || (recent.length < 2 && !recent.some((entry) => entry.kind === kind));
  };
  return atLimit(input.vitals, input.drops, input.online, input.place, input.github, now).find(allowed) ?? null;
}

const dropTimes: number[] = [];
let owner: { id: string; kind: LaptopKind } | null = null;
const listeners = new Set<() => void>();
if (typeof window !== "undefined") window.addEventListener("offline", () => dropTimes.push(Date.now()));

function setOwner(next: typeof owner) {
  owner = next;
  for (const listener of listeners) listener();
}

function readShown(): LaptopShown[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SHOWN_KEY) ?? "[]");
    return Array.isArray(value) ? (value as LaptopShown[]) : [];
  } catch {
    return [];
  }
}

function useDesktopInfo(): BbDesktopInfo | null {
  const [info, setInfo] = useState<BbDesktopInfo | null>(null);
  useEffect(() => {
    const api = getBbDesktopInfo();
    if (!api) return;
    let mounted = true;
    void api.getInfo().then((next) => mounted && setInfo(next)).catch(() => undefined);
    const unsubscribe = api.onChange(setInfo);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  return info;
}

export function useLaptopHint(place: LaptopPlace, { enabled, github = false }: { enabled: boolean; github?: boolean }) {
  const id = useId();
  const info = useDesktopInfo();
  const connection = useCloudroomConnection().data;
  const account = useCloudroomAccount().data;
  const hidden = useSystemConfig().data?.experiments?.hideLaptopHints !== false;
  const [now, setNow] = useState(Date.now);
  const vitals = info?.computers?.viewing ? undefined : info?.vitals;
  useEffect(() => {
    if (!vitals) return;
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 15_000);
    window.addEventListener("online", tick);
    window.addEventListener("offline", tick);
    listeners.add(tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", tick);
      window.removeEventListener("offline", tick);
      listeners.delete(tick);
    };
  }, [vitals]);
  const usage = account?.planUsage;
  const outOfCredits = !!usage && usage.credits !== null && usage.credits >= usage.creditsLimit && !usage.extraCredits;
  const drops = dropTimes.filter((at) => now - at < DROP_WINDOW).length;
  const online = typeof navigator === "undefined" || navigator.onLine;
  const ready = !!vitals && enabled && !hidden && !!account && connection?.ready === true && !connection.cloudQueue
    && connection.lastNewCloudAt !== undefined && !outOfCredits && (place === "new-thread" || connection.teleport);
  const mine = owner?.id === id ? owner.kind : null;
  const hint = ready && (!owner || mine) ? pickLaptopHint({ vitals, drops, online, place, github, paid: account.plan !== "free", lastNewCloudAt: connection.lastNewCloudAt ?? null, shown: readShown(), active: mine, now }) : null;
  const kind = hint && laptopHintKind(hint);
  useEffect(() => {
    if (!kind) return;
    if (owner && owner.id !== id) {
      setOwner(owner);
      return;
    }
    if (!owner) {
      localStorage.setItem(SHOWN_KEY, JSON.stringify([...readShown().filter((entry) => Date.now() - entry.at < WEEK), { kind, at: Date.now() }]));
      setOwner({ id, kind });
    }
    return () => {
      if (owner?.id === id) setOwner(null);
    };
  }, [kind, id]);
  return { hint, vitals, drops, dismiss: () => setOwner(null) };
}
