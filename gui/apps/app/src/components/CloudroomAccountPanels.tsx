import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { getRoomDesktopInfo } from "@/lib/room-desktop";
import { clearPendingBillingReturn, hasPendingBillingReturn } from "@/lib/url-open-routing";
import { CodexConnectionPanel, CursorConnectionPanel } from "./CodexConnectionPanel";

export function CloudroomAccountPanels() {
  const client = useQueryClient();
  const status = useCloudroomAccount();
  const signingIn = status.data?.signingIn;
  const accountId = status.data?.account?.id;
  const plan = status.data?.plan ?? null;
  const usage = status.data?.planUsage;
  const creditsLeft = usage && usage.credits !== null
    ? Math.max(0, usage.creditsLimit - usage.credits) + Math.max(0, usage.extraCredits ?? 0)
    : null;
  const wasSigningIn = useRef(false);
  const lastBalance = useRef<{ plan: string | null; creditsLeft: number | null }>({ plan: null, creditsLeft: null });
  // Bring the app back in front of the browser once sign-in finishes there.
  useEffect(() => {
    if (signingIn) wasSigningIn.current = true;
    else if (wasSigningIn.current && accountId) {
      wasSigningIn.current = false;
      getRoomDesktopInfo()?.focusWindow?.();
      // Signed in again: look for the picked Mac now, not at the next minute's check (ADR 20261113-210101).
      getRoomDesktopInfo()?.refreshComputers?.();
    }
  }, [signingIn, accountId]);
  // Stop refreshing on focus once a plan change or top-up has landed.
  useEffect(() => {
    const prev = lastBalance.current;
    if ((prev.plan && plan && plan !== prev.plan) || (prev.creditsLeft !== null && creditsLeft !== null && creditsLeft > prev.creditsLeft)) {
      clearPendingBillingReturn();
    }
    lastBalance.current = { plan, creditsLeft };
  }, [plan, creditsLeft]);
  // Returning from /billing refreshes credits right away instead of waiting up to 10 minutes.
  useEffect(() => {
    if (!accountId) return;
    let inFlight = false;
    const refresh = () => {
      if (inFlight || document.visibilityState === "hidden" || !hasPendingBillingReturn()) return;
      inFlight = true;
      void fetchWithAppSurface("/api/v1/cloudroom/account/refresh-usage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
        .then(() => client.invalidateQueries({ queryKey: ["cloudroom-account"] }))
        .catch(() => {})
        .finally(() => { inFlight = false; });
    };
    const onVisibility = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [accountId, client]);
  if (!accountId) return null;
  return <><CodexConnectionPanel /><CursorConnectionPanel /></>;
}
