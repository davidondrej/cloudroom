import { useEffect, useRef, useState } from "react";
import { Icon } from "@cloudroom/shared-ui/icon";
import { useCorner } from "@cloudroom/shared-ui/lib/corner";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { useSidebarNavigationThreadSelection } from "@/hooks/queries/sidebar-navigation-query";
import { getLocalStorage } from "@/lib/browser-storage";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

// The Partner card at the top right (docs/scopes/affiliate.md, ADR 20261126-170245): shown to paying users (paid
// plan or bought Cloud Credits) and active Free users (10+ threads). Same size and place as the Wrapped card.
// Repeats every 14 days when closed; after a click, comes back once more 30 days later in case they bounced, then
// stops. Settings → Account and /billing always show the program.
/** Where people get their affiliate link. */
export const PARTNER_URL = "https://partners.dub.co/cloudroom";
/** Asks after Wrapped (20 s) and before Scan (30 s), matching its priority in CORNER_CARDS. */
const WAIT_MS = 25_000;
/** Minimum threads for a Free user to count as active enough to see the card. */
const FREE_MIN_THREADS = 10;
/** Set on the first click so the next showing (30 days later) knows it is the final one. */
const OPENED_KEY = "cloudroom.partner.opened";
/** Set once that final post-click showing is answered, so this computer stops asking even if the account's 12-entry log rolls over. */
const DONE_KEY = "cloudroom.partner.done";
const hasActiveThreads = (threads: readonly unknown[]) => threads.length >= FREE_MIN_THREADS;

export function PartnerCard() {
  const status = useCloudroomAccount().data;
  const plan = status?.plan;
  const boughtCredits = (status?.planUsage?.extraCreditsTotal ?? 0) > 0;
  const activeFree = useSidebarNavigationThreadSelection(hasActiveThreads).data === true;
  const [waited, setWaited] = useState(false);
  const [doneLocally, setDoneLocally] = useState(() => getLocalStorage()?.getItem(DONE_KEY) === "true");
  const handled = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), WAIT_MS);
    return () => clearTimeout(timer);
  }, []);
  // Paying users (paid plan or bought credits, excluding company-paid Business seats) plus active Free users (10+ threads).
  const eligible = Boolean(plan) && plan !== "business" && (plan !== "free" || boughtCredits || activeFree);
  const corner = useCorner("partner", waited && eligible && !doneLocally ? "" : null);
  useEffect(() => { if (!corner) handled.current = false; }, [corner]);
  if (!corner) return null;
  const done = (answer: "opened" | "closed") => {
    if (handled.current) return;
    handled.current = true;
    corner.answer(answer);
    const storage = getLocalStorage();
    if (storage?.getItem(OPENED_KEY) === "true") {
      storage.setItem(DONE_KEY, "true");
      setDoneLocally(true);
    } else if (answer === "opened") {
      storage?.setItem(OPENED_KEY, "true");
    }
  };
  return (
    <div data-testid="partner-card" style={corner.style}
      className={cn(corner.className, "h-[176px] w-[340px] overflow-hidden rounded-[10px] bg-[#0c0c0c] text-[#F5F0E1] shadow-[0_18px_50px_rgba(0,0,0,.65),0_2px_8px_rgba(0,0,0,.5)] ring-1 ring-[#F5F0E1]/15 ring-inset")}>
      <button type="button" onClick={() => { done("opened"); openUrlInExternalBrowser(PARTNER_URL); }}
        className="absolute inset-0 flex cursor-pointer flex-col px-4 pt-[26px] text-left outline-none focus-visible:ring-2 focus-visible:ring-current focus-visible:ring-inset">
        {/* One column per month: each block is a customer who still pays. */}
        <span aria-hidden="true" className="pointer-events-none absolute -right-[30px] -bottom-[22px] flex origin-bottom-right -rotate-[14deg] items-end gap-[3px]">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((height) => (
            <span key={height} className="flex flex-col gap-[3px]">
              {Array.from({ length: height }, (_, block) => (
                <span key={block} className="size-[15px] rounded-[2.5px] bg-[#BFFF00]" style={{ opacity: block === 0 ? 1 : 0.22 + 0.5 * (height / 9) }} />
              ))}
            </span>
          ))}
        </span>
        <span className="relative block font-mono text-[10px] tracking-[0.16em] text-[#BFFF00] uppercase">Partner program</span>
        <span className="relative mt-2 block text-[27px] leading-[1.05] font-extrabold tracking-[-0.045em]">Earn 40%.<br />For life.</span>
        <span className="absolute bottom-4 left-4 flex h-8 items-center gap-[7px] rounded-[7px] bg-[#F5F0E1] px-3.5 text-[13px] font-semibold text-[#0a0a0a]">
          Become a partner<Icon name="ArrowRight" className="size-3.5" aria-hidden="true" />
        </span>
      </button>
      <button type="button" aria-label="Dismiss" onClick={() => done("closed")}
        className="absolute top-[22px] right-3 flex size-6 cursor-pointer items-center justify-center rounded hover:bg-current/10">
        <Icon name="X" className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
