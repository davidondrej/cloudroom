import { COMPUTER } from "@cloudroom/domain";
import { useEffect, useState, type ReactNode } from "react";
import { atom, useAtom } from "jotai";
import { Icon } from "@cloudroom/shared-ui/icon";
import { PROMPT_STACK_ON_INPUT_CLASS, PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { useCloudroomConnection } from "@/hooks/queries/cloudroom-queries";
import { LAPTOP_HINT_PROMPT, useLaptopHint, type LaptopHint } from "@/lib/laptop-hints";
import { useCard, useCardBudget } from "@/lib/popups";
import { reportUpgradePromptClick, useUpgradePromptViewed } from "@/lib/upgrade-prompt";

const DISMISSED_KEY = "cloudroom.tryCloud.dismissed";
const SHOW_AFTER_MS = 5 * 60_000;
const activeSince = new Map<string, number>();
// The account's weekly budget paid for a Cloud card (ADR 20261111-222457). It stays paid until closed or used.
const paidAtom = atom(false);
let claiming = false;
const HOT = "bg-warning-text";
const DIM = "bg-muted-foreground/40";
const OWN_MACHINE = "In Cloud this thread gets its own machine.";

/** A small bar chart. Each bar is its height in percent and whether it is lit. */
function Bars({ bars, wide = false }: { bars: (readonly [number, boolean])[]; wide?: boolean }) {
  return (
    <span className={cn("flex h-6 items-end", wide ? "gap-[3px]" : "gap-[2.5px]")} aria-hidden="true">
      {bars.map(([height, lit], index) => <span key={index} className={cn("rounded-[1.5px]", wide ? "w-2" : "w-1", lit ? HOT : DIM)} style={{ height: `${Math.max(12, Math.min(100, height))}%` }} />)}
    </span>
  );
}

/** The big reading, its picture, and the two lines of a laptop hint's card (docs/scopes/laptop-hints.md). */
function laptopCard(hint: LaptopHint, laptop: ReturnType<typeof useLaptopHint>): { value: string; unit?: string; picture: ReactNode; title: string; benefit: string } {
  const { vitals, drops, dropsAt, working, now } = laptop;
  const minutes = (since: number | null | undefined) => Math.max(1, Math.floor((now - (since ?? now)) / 60_000));
  switch (hint) {
    case "slept":
    case "quit": {
      const lost = Math.round(((vitals?.pause?.to ?? 0) - (vitals?.pause?.from ?? 0)) / 60_000);
      const [value, unit, words] = lost < 60 ? [lost, "m", `${lost} min`] : [Math.round(lost / 60), "h", `${Math.round(lost / 60)} h`];
      // Work, the gap, then work again.
      const picture = <Bars bars={Array.from({ length: 14 }, (_, index) => (index > 2 && index < 11 ? [28, true] : [100, false]))} />;
      return hint === "slept"
        ? { value: String(value), unit, picture, title: `This agent paused ${words} while your ${COMPUTER} slept`, benefit: "In Cloud it keeps working with the lid closed." }
        : { value: String(value), unit, picture, title: `This agent stopped ${words} while Cloudroom was closed`, benefit: "In Cloud it keeps working after you quit." };
    }
    case "crowded": return { value: String(working), title: `${working} agents are working on your ${COMPUTER}`, benefit: "In Cloud each one gets its own machine.", picture: <Bars wide bars={Array.from({ length: Math.min(working, 12) }, () => [100, true])} /> };
    case "battery": return {
      value: String(vitals?.battery ?? ""), unit: "%", title: "Battery is running low", benefit: `Cloud keeps going if your ${COMPUTER} dies.`,
      picture: (
        <span className="flex items-center gap-0.5" aria-hidden="true">
          <span className="flex h-5 w-[42px] rounded-md border-[1.5px] border-muted-foreground/40 p-0.5"><span className={cn("rounded-[3px]", HOT)} style={{ width: `${vitals?.battery ?? 0}%` }} /></span>
          <span className={cn("h-2 w-[2.5px] rounded-r-sm", DIM)} />
        </span>
      ),
    };
    case "cpu": return { value: String(vitals?.cpu?.at(-1) ?? "High"), unit: vitals?.cpu?.length ? "%" : undefined, title: `CPU maxed out for ${minutes(vitals?.cpuBusySince)} minutes`, benefit: OWN_MACHINE, picture: <Bars bars={(vitals?.cpu ?? []).map((percent) => [percent, percent >= 90])} /> };
    case "memory": return { value: "High", title: `Your ${COMPUTER} is low on memory`, benefit: OWN_MACHINE, picture: <Bars bars={(vitals?.memory ?? []).map((level) => [25 * level, level >= 4])} /> };
    case "heat": return { value: "Hot", title: `Your ${COMPUTER} is running hot`, benefit: OWN_MACHINE, picture: <Bars wide bars={[1, 2, 3, 4].map((step) => [20 + 20 * step, step <= (vitals?.heat ?? 3)])} /> };
    case "disk": {
      const used = vitals?.diskTotalGb ? 100 * (1 - (vitals.diskFreeGb ?? 0) / vitals.diskTotalGb) : null;
      return {
        value: String(vitals?.diskFreeGb ?? ""), unit: "GB", title: "Your disk is almost full", benefit: "A Cloud thread uses none of your disk.",
        picture: used === null ? null : <span className={cn("block h-2 w-[76px] overflow-hidden rounded-full", DIM)} aria-hidden="true"><span className={cn("block h-full rounded-full", HOT)} style={{ width: `${used}%` }} /></span>,
      };
    }
    case "network": {
      // One bar per minute of the last 15. A short lit bar is a minute the internet dropped in.
      const dropped = new Set(dropsAt.map((at) => 14 - Math.floor((now - at) / 60_000)));
      return { value: String(drops), unit: "×", title: `Internet dropped ${drops} times in 15 min`, benefit: "Cloud keeps working through it.", picture: <Bars bars={Array.from({ length: 15 }, (_, minute) => (dropped.has(minute) ? [28, true] : [100, false]))} /> };
    }
  }
}

export function TryCloudCard({ threadId, active, attached, onMove }: { threadId: string; active: boolean; attached: boolean; onMove: () => void }) {
  const connection = useCloudroomConnection().data;
  const [closed, setClosed] = useState(false);
  const [laptopSeen, setLaptopSeen] = useState(false);
  const budget = useCardBudget();
  const [paid, setPaid] = useAtom(paidAtom);
  const affordable = paid || budget.left === true;
  // A laptop hint counts as shown only once it is on screen: first in line, and paid for.
  const [first, setFirst] = useState(false);
  const laptop = useLaptopHint("running", { enabled: active && !closed && affordable, commit: first && paid, threadId });
  if (laptop.hint && !laptopSeen) setLaptopSeen(true);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY) === "1");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) {
      activeSince.delete(threadId);
      return;
    }
    if (!activeSince.has(threadId)) activeSince.set(threadId, Date.now());
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [active, threadId]);
  const started = activeSince.get(threadId);
  const show = !closed && !laptopSeen && active && !dismissed && affordable && started !== undefined && now - started >= SHOW_AFTER_MS
    && connection?.ready === true && connection.teleport && !connection.usedCloud && !connection.cloudQueue;
  const wants = laptop.hint ? LAPTOP_HINT_PROMPT[laptop.hint] : show ? "try_cloud" : null;
  const isFirst = useCard("cloud", wants !== null ? true : budget.left === null || laptop.loading ? null : false);
  if (isFirst !== first) setFirst(isFirst);
  useEffect(() => {
    if (!isFirst || paid || claiming) return;
    claiming = true;
    void budget.claim("cloud_card").then((claimed) => { if (claimed) setPaid(true); }).finally(() => { claiming = false; });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `budget` is new on every render
  }, [isFirst, paid, setPaid]);
  const where = isFirst && paid ? wants : null;
  useUpgradePromptViewed(where);
  if (!where) return null;
  // Takes the card off this thread, then frees its payment. In that order, or the card still on screen pays again.
  const hide = () => {
    setClosed(true);
    setPaid(false);
    if (laptop.hint) laptop.dismiss();
  };
  const close = () => {
    hide();
    if (laptop.hint) return;
    localStorage.setItem(DISMISSED_KEY, "1");
    setDismissed(true);
  };
  const move = () => {
    reportUpgradePromptClick(where);
    hide();
    onMove();
  };
  const dismissButton = (
    <button
      type="button"
      aria-label="Dismiss"
      className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
      onClick={close}
    >
      <Icon name="X" className="size-3.5" aria-hidden="true" />
    </button>
  );
  const shell = cn("mx-3 overflow-hidden rounded-xl border-muted-foreground/15 sm:mx-4", attached && PROMPT_STACK_ON_INPUT_CLASS);
  if (laptop.hint) {
    const card = laptopCard(laptop.hint, laptop);
    return (
      <PromptStackCard ariaLabel="Move to Cloud" className={shell}>
        <div data-testid="laptop-card" className="flex items-center gap-3 py-2 pr-2 pl-3.5">
          <span className="shrink-0 text-2xl leading-none font-semibold text-warning-text tabular-nums">
            {card.value}{card.unit && <span className="ml-px text-[13px]">{card.unit}</span>}
          </span>
          {card.picture && <span className="shrink-0">{card.picture}</span>}
          <span className="h-7 w-px shrink-0 bg-muted-foreground/20" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-[12.5px] leading-[1.35]">
            <span className="block truncate font-medium text-foreground">{card.title}</span>
            <span className="block truncate text-muted-foreground">{card.benefit}</span>
          </span>
          <button type="button" className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-2.5 text-[12.5px] font-semibold text-primary-foreground transition-opacity hover:opacity-90" onClick={move}>
            <Icon name="Cloud" className="size-3.5" aria-hidden="true" />
            Move to Cloud
          </button>
          {dismissButton}
        </div>
      </PromptStackCard>
    );
  }
  const minutes = Math.floor((now - (started ?? now)) / 60_000);
  return (
    <PromptStackCard ariaLabel="Move to Cloud" className={shell}>
      <div className="flex min-h-8 items-center gap-1.5 px-3 py-1.5 text-xs">
        <Icon name="Laptop" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="shrink-0 text-muted-foreground">Working {minutes}m on your {COMPUTER}</span>
        <span className="shrink-0 text-muted-foreground/60" aria-hidden="true">·</span>
        <span className="min-w-0 flex-1 truncate text-foreground">Move it to Cloud so you can close your laptop</span>
        <button
          type="button"
          className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md bg-primary px-2 py-0.5 font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          onClick={move}
        >
          <Icon name="Cloud" className="size-3.5" aria-hidden="true" />
          Move
        </button>
        {dismissButton}
      </div>
    </PromptStackCard>
  );
}
