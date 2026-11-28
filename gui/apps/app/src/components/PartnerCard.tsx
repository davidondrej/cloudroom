import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Icon } from "@cloudroom/shared-ui/icon";
import { useCorner } from "@cloudroom/shared-ui/lib/corner";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  isAffiliateInactiveError,
  isAffiliateShortLink,
  REFERRALS_KEY,
  requestReferrals,
} from "@/components/settings/ReferralsSettingsSection";
import { getSettingsSectionRoutePath } from "@/components/settings/settings-sections";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { getLocalStorage } from "@/lib/browser-storage";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

// The Partner card at the top right (docs/scopes/affiliate.md, ADR 20261126-170245): shown to paying users (paid
// plan or bought Cloud Credits) and active Free users (10+ lifetime started threads). Same size and place as the
// Wrapped card. Repeats every 14 days when closed; after a fallback browser open, comes back once more 30 days later
// in case they bounced, then stops. Once an instant link is created, the card stops and opens Settings → Referrals.
/** Dub's partner portal: fallback when instant link creation is unavailable, and where partners withdraw payouts. */
export const PARTNER_URL = "https://partners.dub.co/cloudroom";
/** Asks after Wrapped (20 s) and before Scan (30 s), matching its priority in CORNER_CARDS. */
const WAIT_MS = 25_000;
/** Minimum lifetime user-started threads for a Free user to count as active enough to see the card. */
const FREE_MIN_THREADS = 10;
/** Per-account flags so one account on a shared computer never suppresses or leaks into another. */
const openedKey = (id: string) => `cloudroom.partner.opened.${id}`;
const doneKey = (id: string) => `cloudroom.partner.done.${id}`;
const linkKey = (id: string) => `cloudroom.partner.link.${id}`;

export function PartnerCard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const status = useCloudroomAccount().data;
  const accountId = status?.account?.id ?? null;
  const plan = status?.plan;
  const boughtCredits = (status?.planUsage?.extraCreditsTotal ?? 0) > 0;
  const [waited, setWaited] = useState(false);
  const [doneAccount, setDoneAccount] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [errorState, setErrorState] = useState<{ accountId: string | null; message: string } | null>(null);
  const error = errorState?.accountId === accountId ? errorState.message : null;
  const handled = useRef(false);
  const pendingRef = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), WAIT_MS);
    return () => clearTimeout(timer);
  }, []);
  // Shares the ["cloudroom-activation"] query with ActivationChecklist: lifetime user-started threads (archived included).
  const { data: activation } = useQuery({
    queryKey: ["cloudroom-activation"],
    enabled: waited && Boolean(accountId) && plan === "free" && !boughtCredits,
    staleTime: 30_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetchWithAppSurface("/api/v1/cloudroom/activation", { signal });
      if (!response.ok) throw new Error("Activation is unavailable.");
      return await response.json() as { started?: number };
    },
  });
  const activeFree = (activation?.started ?? 0) >= FREE_MIN_THREADS;
  const savedLink = accountId ? getLocalStorage()?.getItem(linkKey(accountId)) : null;
  const doneLocally = !pending && Boolean(accountId) && (doneAccount === accountId || isAffiliateShortLink(savedLink) || getLocalStorage()?.getItem(doneKey(accountId!)) === "true");
  // Paying users (paid plan or bought credits, excluding company-paid Business seats) plus active Free users (10+ started threads).
  const eligible = Boolean(accountId) && Boolean(plan) && plan !== "business" && (plan !== "free" || boughtCredits || activeFree);
  const corner = useCorner("partner", waited && eligible && !doneLocally ? "" : null);
  useEffect(() => { if (!corner) handled.current = false; }, [corner]);
  if (!corner) return null;

  const done = (answer: "opened" | "closed", forever = false) => {
    if (handled.current) return;
    handled.current = true;
    corner.answer(answer);
    if (!accountId) return;
    const storage = getLocalStorage();
    if (forever || storage?.getItem(openedKey(accountId)) === "true") {
      storage?.setItem(doneKey(accountId), "true");
      setDoneAccount(accountId);
    } else if (answer === "opened") {
      storage?.setItem(openedKey(accountId), "true");
    }
  };

  const onGetLink = async () => {
    if (pendingRef.current || handled.current) return;
    if (!accountId) {
      openUrlInExternalBrowser(PARTNER_URL);
      done("opened");
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setErrorState(null);
    try {
      const summary = await requestReferrals("POST");
      if (handled.current) return;
      if (summary.available && isAffiliateShortLink(summary.link)) {
        getLocalStorage()?.setItem(linkKey(accountId), summary.link);
        queryClient.setQueryData([...REFERRALS_KEY, accountId], summary);
        void copyToClipboardWithToast(summary.link, { successMessage: "Referral link copied" });
        done("opened", true);
        navigate(getSettingsSectionRoutePath("referrals"));
        return;
      }
      openUrlInExternalBrowser(PARTNER_URL);
      done("opened");
    } catch (failure) {
      if (handled.current) return;
      if (isAffiliateInactiveError(failure)) {
        setErrorState({ accountId, message: failure.message });
        return;
      }
      openUrlInExternalBrowser(PARTNER_URL);
      done("opened");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <div data-testid="partner-card" style={corner.style}
      className={cn(corner.className, "h-[176px] w-[340px] overflow-hidden rounded-[10px] bg-[#0c0c0c] text-[#F5F0E1] shadow-[0_18px_50px_rgba(0,0,0,.65),0_2px_8px_rgba(0,0,0,.5)] ring-1 ring-[#F5F0E1]/15 ring-inset")}>
      <button type="button" disabled={pending || Boolean(error)} onClick={() => void onGetLink()}
        className="absolute inset-0 flex cursor-pointer flex-col px-4 pt-[26px] text-left outline-none disabled:cursor-default focus-visible:ring-2 focus-visible:ring-current focus-visible:ring-inset">
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
        <span className="relative block font-mono text-[10px] tracking-[0.16em] text-[#BFFF00] uppercase">Refer a friend</span>
        <span className="relative mt-2 block text-[27px] leading-[1.05] font-extrabold tracking-[-0.045em]">Earn 40%.<br />For life.</span>
        {error ? (
          <span role="alert" className="absolute right-4 bottom-4 left-4 line-clamp-2 text-[11px] leading-snug text-[#ff8f8f]">
            {error}
          </span>
        ) : (
          <span className="absolute bottom-4 left-4 flex h-8 items-center gap-[7px] rounded-[7px] bg-[#F5F0E1] px-3.5 text-[13px] font-semibold text-[#0a0a0a]">
            {pending ? "Creating link…" : <>Get your link<Icon name="ArrowRight" className="size-3.5" aria-hidden="true" /></>}
          </span>
        )}
      </button>
      <button type="button" aria-label="Dismiss" onClick={() => done("closed")}
        className="absolute top-[22px] right-3 flex size-6 cursor-pointer items-center justify-center rounded hover:bg-current/10">
        <Icon name="X" className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
