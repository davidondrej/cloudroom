import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Icon } from "@cloudroom/shared-ui/icon";
import { useCorner } from "@cloudroom/shared-ui/lib/corner";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { getSettingsSectionRoutePath } from "@/components/settings/settings-sections";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { getLocalStorage } from "@/lib/browser-storage";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

// The Partner card at the top right (docs/scopes/affiliate.md, ADR 20261126-170245): shown to paying users (paid
// plan or bought Cloud Credits) and active Free users (10+ lifetime started threads). Same size and place as the
// Wrapped card. Repeats every 14 days when closed; after a fallback browser open, comes back once more 30 days later
// in case they bounced, then stops. Once an instant link is created, the card stops and Settings → Account keeps it.
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
const AFFILIATE_LINK_EVENT = "cloudroom:affiliate-link";

function readSavedAffiliateLink(accountId: string | null): string | null {
  if (!accountId) return null;
  const value = getLocalStorage()?.getItem(linkKey(accountId));
  return value && value.startsWith("https://") ? value : null;
}

function saveAffiliateLink(accountId: string, url: string): void {
  getLocalStorage()?.setItem(linkKey(accountId), url);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AFFILIATE_LINK_EVENT));
}

function subscribeAffiliateLink(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(AFFILIATE_LINK_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(AFFILIATE_LINK_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function inactiveAffiliateMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { status?: unknown; code?: unknown; body?: unknown };
  if (candidate.status !== 403 || candidate.code !== "affiliate_inactive") return null;
  const body = candidate.body && typeof candidate.body === "object" ? candidate.body as { message?: unknown; error?: unknown } : null;
  if (typeof body?.message === "string" && body.message.trim()) return body.message;
  if (typeof body?.error === "string" && body.error.trim()) return body.error;
  return "Your affiliate account is not active. Contact support@cloudroom.dev.";
}

/** Shared 1-click affiliate link state for PartnerCard and Settings → Account's PartnerCheque. */
export function useAffiliateLink(accountId: string | null) {
  const link = useSyncExternalStore(subscribeAffiliateLink, () => readSavedAffiliateLink(accountId), () => null);
  const [pending, setPending] = useState(false);
  const [errorState, setErrorState] = useState<{ accountId: string | null; message: string } | null>(null);
  const error = errorState?.accountId === accountId ? errorState.message : null;
  const pendingRef = useRef(false);

  const getLink = useCallback(async (): Promise<{ url: string; instant: boolean } | null> => {
    if (pendingRef.current) return null;
    if (!accountId) {
      openUrlInExternalBrowser(PARTNER_URL);
      return { url: PARTNER_URL, instant: false };
    }
    pendingRef.current = true;
    setPending(true);
    setErrorState(null);
    try {
      const result = await sdk.cloudroom.affiliateLink();
      if (result.instant && result.url.startsWith("https://")) {
        saveAffiliateLink(accountId, result.url);
        void copyToClipboardWithToast(result.url, { successMessage: "Referral link copied" });
        return result;
      }
      const fallback = result.url.startsWith("https://") ? result.url : PARTNER_URL;
      openUrlInExternalBrowser(fallback);
      return { url: fallback, instant: false };
    } catch (failure) {
      const inactive = inactiveAffiliateMessage(failure);
      if (inactive) {
        setErrorState({ accountId, message: inactive });
        return null;
      }
      openUrlInExternalBrowser(PARTNER_URL);
      return { url: PARTNER_URL, instant: false };
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, [accountId]);

  const copyLink = useCallback(() => {
    if (link) void copyToClipboardWithToast(link, { successMessage: "Referral link copied" });
  }, [link]);

  return { link, pending, error, getLink, copyLink };
}

export function PartnerCard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const status = useCloudroomAccount().data;
  const accountId = status?.account?.id ?? null;
  const plan = status?.plan;
  const boughtCredits = (status?.planUsage?.extraCreditsTotal ?? 0) > 0;
  const [waited, setWaited] = useState(false);
  const [doneAccount, setDoneAccount] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const handled = useRef(false);
  const { link, pending, error, getLink } = useAffiliateLink(accountId);
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
  const doneLocally = !claiming && Boolean(accountId) && (doneAccount === accountId || Boolean(link) || getLocalStorage()?.getItem(doneKey(accountId!)) === "true");
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
    if (pending || handled.current) return;
    setClaiming(true);
    const result = await getLink();
    if (!result) {
      setClaiming(false);
      return;
    }
    if (result.instant) {
      done("opened", true);
      setClaiming(false);
      void queryClient.invalidateQueries({ queryKey: ["cloudroom-referrals"] });
      navigate(getSettingsSectionRoutePath("referrals"));
      return;
    }
    setClaiming(false);
    done("opened");
  };
  return (
    <div data-testid="partner-card" style={corner.style}
      className={cn(corner.className, "h-[176px] w-[340px] overflow-hidden rounded-[10px] bg-[#0c0c0c] text-[#F5F0E1] shadow-[0_18px_50px_rgba(0,0,0,.65),0_2px_8px_rgba(0,0,0,.5)] ring-1 ring-[#F5F0E1]/15 ring-inset")}>
      <button type="button" disabled={pending} onClick={() => void onGetLink()}
        className="absolute inset-0 flex cursor-pointer flex-col px-4 pt-[26px] text-left outline-none disabled:cursor-wait focus-visible:ring-2 focus-visible:ring-current focus-visible:ring-inset">
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
        {error && <span role="alert" className="relative mt-1.5 block max-w-[230px] truncate text-[11px] text-[#ff8f8f]">{error}</span>}
        <span className="absolute bottom-4 left-4 flex h-8 items-center gap-[7px] rounded-[7px] bg-[#F5F0E1] px-3.5 text-[13px] font-semibold text-[#0a0a0a]">
          {pending ? "Creating link…" : <>Get your link<Icon name="ArrowRight" className="size-3.5" aria-hidden="true" /></>}
        </span>
      </button>
      <button type="button" aria-label="Dismiss" onClick={() => done("closed")}
        className="absolute top-[22px] right-3 flex size-6 cursor-pointer items-center justify-center rounded hover:bg-current/10">
        <Icon name="X" className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
