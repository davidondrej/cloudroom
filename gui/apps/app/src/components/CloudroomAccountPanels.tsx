import { useEffect, useRef } from "react";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { getRoomDesktopInfo } from "@/lib/room-desktop";
import { CodexConnectionPanel, CursorConnectionPanel } from "./CodexConnectionPanel";

export function CloudroomAccountPanels() {
  const status = useCloudroomAccount();
  const signingIn = status.data?.signingIn;
  const accountId = status.data?.account?.id;
  const wasSigningIn = useRef(false);
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
  if (!accountId) return null;
  return <><CodexConnectionPanel /><CursorConnectionPanel /></>;
}
