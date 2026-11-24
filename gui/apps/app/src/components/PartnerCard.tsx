import { useEffect, useState } from "react";
import { Icon } from "@cloudroom/shared-ui/icon";
import { useCorner } from "@cloudroom/shared-ui/lib/corner";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { getLocalStorage } from "@/lib/browser-storage";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

// The Partner card at the top right (docs/scopes/affiliate.md): once a month it tells accounts that pay about the
// affiliate program. Same size and place as the Wrapped card. The corner module decides when it may show
// (docs/scopes/corner-cards.md). A click opens the page where people apply, and ends the card for good: only people
// who close it see it again next month. Settings → Account always shows the program.
/** Where people apply to the affiliate program. */
export const PARTNER_URL = "https://partners.dub.co/cloudroom";
/** The card asks after Wrapped (20 s) and Scan (30 s), so it never shows first and then gives way to them. */
const WAIT_MS = 45_000;
/** Set once the card was clicked on this computer. The account remembers the click too, but only its last 12 corner cards. */
const OPENED_KEY = "cloudroom.partner.opened";
/** This month in local time, `2026-11`: the card's key, so it shows once per month. */
function thisMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export function PartnerCard() {
  const plan = useCloudroomAccount().data?.plan;
  const [month, setMonth] = useState(thisMonth);
  const [waited, setWaited] = useState(false);
  /** The month answered in this app run, so the card stops asking for the corner. */
  const [answered, setAnswered] = useState("");
  const [opened, setOpened] = useState(() => getLocalStorage()?.getItem(OPENED_KEY) === "true");
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), WAIT_MS);
    // An app left open over the 1st notices the new month when its window is shown again.
    const check = () => { if (document.visibilityState === "visible") setMonth(thisMonth()); };
    document.addEventListener("visibilitychange", check);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", check); };
  }, []);
  // Accounts that pay themselves: not Free, and not a Business seat their company pays for.
  const paying = Boolean(plan) && plan !== "free" && plan !== "business";
  const corner = useCorner("partner", waited && paying && !opened && answered !== month ? month : null);
  if (!corner) return null;
  const done = (answer: "opened" | "closed") => {
    corner.answer(answer);
    setAnswered(month);
    if (answer !== "opened") return;
    getLocalStorage()?.setItem(OPENED_KEY, "true");
    setOpened(true);
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
