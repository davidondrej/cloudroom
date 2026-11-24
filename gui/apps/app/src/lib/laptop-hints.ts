import { useEffect, useId, useState } from "react";
import { isBusyThread } from "@cloudroom/client-core";
import type { RoomDesktopInfo, RoomDesktopVitals } from "@cloudroom/desktop-contract";
import type { ThreadListEntry } from "@cloudroom/domain";
import { getRoomDesktopInfo } from "@/lib/room-desktop";
import { useCloudroomAccount, useCloudroomConnection } from "@/hooks/queries/cloudroom-queries";
import { useSidebarNavigationThreadSelection } from "@/hooks/queries/sidebar-navigation-query";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import type { UpgradePrompt } from "@/lib/upgrade-prompt";

// The first six are limits of the Mac. The last three are moments: they happen to everyone, with no limit hit (ADR 20261113-000129).
export type LaptopHint = "battery" | "memory" | "heat" | "cpu" | "network" | "disk" | "slept" | "quit" | "crowded";
export type LaptopKind = "battery" | "load" | "network" | "disk" | "paused" | "crowded";
export type LaptopPlace = "new-thread" | "running";
export interface LaptopShown { kind: LaptopKind; at: number }

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WEEK = 7 * 24 * HOUR;
const DROP_WINDOW = 15 * MINUTE;
const SHOWN_KEY = "cloudroom.laptopHints.shown";

export const LAPTOP_HINT_PROMPT: Record<LaptopHint, UpgradePrompt> = { battery: "mac_battery", memory: "mac_memory", heat: "mac_heat", cpu: "mac_cpu", network: "mac_network", disk: "mac_disk", slept: "moment_slept", quit: "moment_quit", crowded: "moment_crowded" };
const CROWDED = 3;

export function laptopHintKind(hint: LaptopHint): LaptopKind {
  return hint === "memory" || hint === "heat" || hint === "cpu" ? "load" : hint === "slept" || hint === "quit" ? "paused" : hint;
}

function atLimit({ vitals, drops, online, place, github, threadId, working, now }: LaptopInput): LaptopHint[] {
  const lasted = (since: number | null, ms: number) => since !== null && now - since >= ms;
  // `?? null`: readings from a desktop app older than this field must never break the chat input.
  const pause = vitals.pause ?? null;
  const hints: (LaptopHint | false)[] = [
    vitals.battery !== null && vitals.battery <= 30 && "battery",
    lasted(vitals.memoryRedSince, 1.5 * MINUTE) && "memory",
    lasted(vitals.hotSince, 1.5 * MINUTE) && "heat",
    lasted(vitals.cpuBusySince, 3 * MINUTE) && "cpu",
    online && drops >= 3 && (place === "running" || github) && "network",
    vitals.diskFreeGb !== null && vitals.diskFreeGb < 15 && "disk",
    // A sleep or quit stopped this thread, and it is back at work within the hour.
    place === "running" && pause !== null && threadId !== null && pause.threads.includes(threadId) && now - pause.to < HOUR && (pause.why === "sleep" ? "slept" : "quit"),
    working >= CROWDED && "crowded",
  ];
  return hints.filter((hint): hint is LaptopHint => hint !== false);
}

export interface LaptopInput {
  vitals: RoomDesktopVitals;
  drops: number;
  online: boolean;
  place: LaptopPlace;
  github: boolean;
  /** Threads the user started in the last 30 days, by where they run. */
  recentThreads: { local: number; cloud: number };
  /** The thread the hint would show on, or null on the new-thread screen. */
  threadId: string | null;
  /** How many Local agents are working on this computer right now. */
  working: number;
  shown: readonly LaptopShown[];
  active: LaptopKind | null;
  now: number;
}

/** Hints go to people who mostly use Local: 85%+ of their last 30 days' threads, 10 threads or more (ADR 20261111-222458). */
export function mostlyLocal({ local, cloud }: { local: number; cloud: number }): boolean {
  return local + cloud >= 10 && local >= 0.85 * (local + cloud);
}

export function pickLaptopHint(input: LaptopInput): LaptopHint | null {
  const { now, active } = input;
  if (!mostlyLocal(input.recentThreads)) return null;
  const recent = input.shown.filter((entry) => now - entry.at < WEEK);
  const allowed = (hint: LaptopHint) => {
    const kind = laptopHintKind(hint);
    return kind === active || (recent.length < 2 && !recent.some((entry) => entry.kind === kind));
  };
  return atLimit(input).find(allowed) ?? null;
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

/** Undefined while the desktop app's info is still being read. Null when there is none. */
function useDesktopInfo(): RoomDesktopInfo | null | undefined {
  const [info, setInfo] = useState<RoomDesktopInfo | null | undefined>(() => (getRoomDesktopInfo() ? undefined : null));
  useEffect(() => {
    const api = getRoomDesktopInfo();
    if (!api) return;
    let mounted = true;
    void api.getInfo().then((next) => mounted && setInfo(next), () => mounted && setInfo(null));
    const unsubscribe = api.onChange(setInfo);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  return info;
}

const countWorkingLocal = (threads: ThreadListEntry[]) => threads.filter((thread) => thread.executionTarget !== "cloud" && isBusyThread(thread)).length;

/** `commit` false only picks a hint. It counts as shown, and takes the one place a hint shows in, once `commit` is true. */
export function useLaptopHint(place: LaptopPlace, { enabled, github = false, commit = true, threadId = null }: { enabled: boolean; github?: boolean; commit?: boolean; threadId?: string | null }) {
  const id = useId();
  const working = useSidebarNavigationThreadSelection(countWorkingLocal).data ?? 0;
  const info = useDesktopInfo();
  const connectionQuery = useCloudroomConnection();
  const accountQuery = useCloudroomAccount();
  const configQuery = useSystemConfig();
  const connection = connectionQuery.data;
  const account = accountQuery.data;
  const hidden = configQuery.data?.experiments?.hideLaptopHints !== false;
  const loading = info === undefined || connectionQuery.isPending || accountQuery.isPending || configQuery.isPending;
  const [now, setNow] = useState(Date.now);
  const vitals = info?.computers?.viewing ? undefined : info?.vitals;
  // The clock must not restart on each new reading: a busy Mac sends one every 15 seconds, and it would never tick.
  const hasVitals = !!vitals;
  useEffect(() => {
    if (!hasVitals) return;
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
  }, [hasVitals]);
  const usage = account?.planUsage;
  const outOfCredits = !!usage && usage.credits !== null && usage.credits >= usage.creditsLimit && !usage.extraCredits;
  const dropsAt = dropTimes.filter((at) => now - at < DROP_WINDOW);
  const drops = dropsAt.length;
  const online = typeof navigator === "undefined" || navigator.onLine;
  const ready = !!vitals && enabled && !hidden && !!account && connection?.ready === true && !connection.cloudQueue
    && connection.recentThreads !== undefined && !outOfCredits && (place === "new-thread" || connection.teleport);
  const mine = owner?.id === id ? owner.kind : null;
  const hint = ready && (!owner || mine) ? pickLaptopHint({ vitals, drops, online, place, github, recentThreads: connection.recentThreads ?? { local: 0, cloud: 0 }, threadId, working, shown: readShown(), active: mine, now }) : null;
  const kind = hint && laptopHintKind(hint);
  useEffect(() => {
    if (!kind || !commit) return;
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
  }, [kind, id, commit]);
  return { hint, vitals, drops, dropsAt, working, now, loading, dismiss: () => setOwner(null) };
}
