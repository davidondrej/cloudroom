import { useEffect, useState } from "react";
import { atom, useAtom } from "jotai";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { useCloudroomConnection } from "@/hooks/queries/cloudroom-queries";
import { fetchWithAppSurface, getAppSurface } from "@/lib/app-surface";
import { getLocalStorage } from "@/lib/browser-storage";
import { useCard, useCardBudget } from "@/lib/popups";

// One round of the question. A new round needs a new `ROUND` and its own `BETS`: every account is then asked again.
const ROUND = "1";
const BETS = [
  { id: "models", name: "AI included", line: "Keep going when Claude runs out" },
  { id: "teams", name: "Teams", line: "Work in your teammates’ threads" },
  { id: "phone", name: "Phone app", line: "iPhone and Android, with alerts" },
  { id: "hosting", name: "Hosting", line: "Your app online, on our servers" },
] as const;
type Bet = (typeof BETS)[number]["id"];
/** The agent must have worked this long before the note comes, so a quick answer never flashes it. */
const WAIT_MS = 10_000;
/** Only people who know the app are asked: this many threads started in the last 30 days. */
const MIN_THREADS = 5;
/** New users are never asked: Cloudroom must have been used on this many different days, on this computer. */
const MIN_DAYS = 7;
/** An ignored note comes back at most once a day, and this many times in all. Then it gives up on this computer. */
const MAX_SHOWINGS = 3;
const DAY_MS = 86_400_000;
const THANKS_MS = 1_800;
const DONE_KEY = "cloudroom.build.done";
const SEEN_KEY = "cloudroom.build.seen";
/** When this round's note showed on this computer, oldest first. */
const readSeen = (): number[] => {
  try {
    const saved = JSON.parse(getLocalStorage()?.getItem(SEEN_KEY) ?? "null") as { round?: unknown; at?: unknown } | null;
    return saved?.round === ROUND && Array.isArray(saved.at) ? saved.at.filter((at): at is number => typeof at === "number") : [];
  } catch { return []; }
};
// null: not asked yet. "asking": the account is deciding. "open": it shows. A bet: just ticked. "done": gone until the app restarts.
const noteAtom = atom<null | "asking" | "open" | "done" | Bet>(null);

/** Claims the showing or saves the answer in the account's card record. null: it could not be reached. */
const send = async (event: "shown" | "opened" | "closed", variant?: Bet): Promise<boolean | null> => {
  const response = await fetchWithAppSurface("/api/v1/cloudroom/corner", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ card: "build", key: ROUND, event, ...(variant ? { variant } : {}) }),
  }).catch(() => null);
  return response?.ok ? (await response.json().catch(() => null) as { ok?: boolean } | null)?.ok === true : null;
};

/**
 * The sticky note on the chat input that asks which big bet to build next (docs/scopes/build-next.md). It comes
 * only while the agent works and nothing is queued. One tick answers it. Ignored, it leaves when the agent stops
 * and comes back at most once a day, 3 times in all.
 */
export function BuildNextCard({ working, attached }: { working: boolean; attached: boolean }) {
  const [note, setNote] = useAtom(noteAtom);
  // True once the agent worked long enough, and an ignored note may come back.
  const [due, setDue] = useState(false);
  const recent = useCloudroomConnection().data?.recentThreads;
  const budget = useCardBudget();
  useEffect(() => {
    if (!working) return;
    const timer = setTimeout(() => {
      const seen = readSeen();
      setDue(seen.length < MAX_SHOWINGS && Date.now() - (seen[seen.length - 1] ?? 0) >= DAY_MS);
    }, WAIT_MS);
    return () => { clearTimeout(timer); setDue(false); };
  }, [working]);
  const quiet = getAppSurface() !== "desktop" || !working || !due || !attached || note === "done" || getLocalStorage()?.getItem(DONE_KEY) === ROUND;
  const showing = note !== null && note !== "asking" && note !== "done";
  const regular = !!recent && recent.local + recent.cloud >= MIN_THREADS;
  // The days this computer was used are read only when the note could show, at most once an hour.
  const days = useQuery({
    queryKey: ["cloudroom-days-used"], enabled: !quiet && regular, staleTime: 60 * 60_000, retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetchWithAppSurface("/api/v1/cloudroom/time-in-app", { signal });
      if (!response.ok) throw new Error("The days used are unavailable.");
      return Object.keys((await response.json() as { days?: Record<string, number> }).days ?? {}).length;
    },
  });
  // While the budget or the days load, less important cards wait, so one never shows and then gives way.
  const first = useCard("build", quiet ? false : showing ? true : !regular || days.isError ? false
    : budget.left === null || days.data === undefined ? null : budget.left && days.data >= MIN_DAYS);
  useEffect(() => {
    if (!first || note !== null) return;
    setNote("asking");
    void send("shown").then((ok) => setNote(ok ? "open" : "done"));
  }, [first, note, setNote]);
  // One showing: it is counted when the note appears. It ends when the note leaves, and no new one starts in this work.
  const visible = first && showing;
  useEffect(() => {
    if (!visible) return;
    getLocalStorage()?.setItem(SEEN_KEY, JSON.stringify({ round: ROUND, at: [...readSeen(), Date.now()] }));
    return () => { setDue(false); setNote((current) => current === "open" ? null : current); };
  }, [visible, setNote]);
  if (!visible) return null;
  const answer = (bet: Bet | null) => {
    if (note !== "open") return;
    // A saved answer never asks again on this computer. An unsaved one asks again after the next start.
    void send(bet ? "opened" : "closed", bet ?? undefined).then((ok) => { if (ok) getLocalStorage()?.setItem(DONE_KEY, ROUND); });
    setNote(bet ?? "done");
    if (bet) setTimeout(() => setNote("done"), THANKS_MS);
  };
  return (
    <PromptStackCard ariaLabel="What should we build next"
      className="relative z-0 order-last mr-6 -mb-4 w-[292px] -rotate-[1.6deg] justify-self-end overflow-hidden rounded-[3px] border-transparent bg-[#f7f3e8] pb-4 text-[#29251e] shadow-[0_10px_24px_rgba(0,0,0,.5)] duration-300 animate-in fade-in-0 slide-in-from-bottom-3">
      <div data-testid="build-next-card" className="relative px-4 pt-3 pb-2.5">
        <button type="button" aria-label="Dismiss" onClick={() => answer(null)}
          className="absolute top-1.5 right-1.5 flex size-6 cursor-pointer items-center justify-center rounded text-[#7d735f] transition-colors hover:bg-[#29251e]/10 hover:text-[#29251e]">
          <Icon name="X" className="size-3.5" aria-hidden="true" />
        </button>
        <p className="font-serif text-[12px] leading-none text-[#6f6655] italic">While your agent works</p>
        <h2 className="mt-1.5 font-serif text-[19px] leading-[1.1] tracking-[-0.01em]">
          What should we <em className="bg-[linear-gradient(transparent_58%,#bfff00_58%,#bfff00_92%,transparent_92%)]">build next</em>?
        </h2>
        <div className="-mx-1.5 mt-1.5 grid">
          {BETS.map((bet) => (
            <button key={bet.id} type="button" role="checkbox" aria-checked={note === bet.id} disabled={note !== "open"} onClick={() => answer(bet.id)}
              className={cn("flex min-w-0 cursor-pointer items-start gap-2 rounded-[2px] px-1.5 py-1 text-left transition-[background-color,opacity] hover:bg-[#29251e]/10 disabled:cursor-default disabled:hover:bg-transparent",
                note !== "open" && note !== bet.id && "opacity-35")}>
              <span className="mt-[2px] flex size-3 shrink-0 items-center justify-center border-[1.5px] border-[#29251e]">
                {note === bet.id ? <Icon name="Check" className="size-2.5" aria-hidden="true" /> : null}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] leading-none font-semibold">{bet.name}</span>
                <span className="mt-1 block truncate text-[11px] leading-none text-[#7d735f]">{bet.line}</span>
              </span>
            </button>
          ))}
        </div>
        <p className="mt-1 flex items-baseline justify-between font-serif leading-none italic">
          <span className="text-[13px] text-[#6f6655]">{note === "open" ? "" : "Thank you."}</span>
          <span className="text-[17px]">David</span>
        </p>
      </div>
    </PromptStackCard>
  );
}
