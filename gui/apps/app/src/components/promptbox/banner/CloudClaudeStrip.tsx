import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@cloudroom/shared-ui/icon";
import { ClaudeConnectionButton, useClaudeConnection } from "@/components/ClaudeConnection";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { sdk } from "@/lib/sdk";

/** True when a Cloud send to Claude Code would be refused ("connect Claude Code before starting cloud work"): Cloud has
 *  no Claude login. The Mac's own Claude login never reaches Cloud by itself; only Connect sends one. Unknown never blocks.
 *  Once shown, it stays through sign-in ("waiting", or "error" if it failed) until Claude connects or the user moves on. */
export function useCloudClaudeMissing(active: boolean): boolean {
  const state = useClaudeConnection({ target: "cloud" }, active, true).data?.state;
  const missing = active && (state === "missing" || state === "expired");
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (missing) setShown(true);
    else if (!active || state === "connected") setShown(false);
  }, [missing, active, state]);
  return missing || (active && shown && state !== "connected");
}

/** Inside the composer, above the prompt: Send waits, and the prompt stays, until Claude connects or the user switches. */
export function CloudClaudeStrip({ onSwitchToCodex }: { onSwitchToCodex: (() => void) | null }) {
  const account = useCloudroomAccount().data;
  const accountId = account?.account?.id;
  // Setup's own Codex check (Onboarding.tsx), asked only while this strip shows.
  const codex = useQuery({
    queryKey: ["cloudroom-codex-auth", accountId],
    enabled: onSwitchToCodex !== null && (Boolean(accountId) || account?.selfHosted === true) && account?.ready === true,
    queryFn: ({ signal }) => sdk.cloudroom.codexAuth(signal),
    retry: false,
  });
  return (
    <div role="alert" className="flex items-center gap-2 rounded-md bg-warning/10 px-2.5 py-1.5 text-xs">
      <Icon name="AlertTriangle" className="size-3.5 shrink-0 text-warning-text" aria-hidden />
      <span className="min-w-0 flex-1 text-foreground">Claude Code isn't connected, so this can't send yet.</span>
      <ClaudeConnectionButton
        target="cloud"
        quiet
        className="h-auto border-0 bg-transparent p-0 font-medium text-primary-text shadow-none hover:bg-transparent hover:underline"
      />
      {onSwitchToCodex && codex.data?.state === "connected" ? (
        <>
          <span className="text-muted-foreground/50" aria-hidden>·</span>
          <button type="button" className="font-medium text-foreground/80 hover:underline" onClick={onSwitchToCodex}>
            Switch to Codex
          </button>
        </>
      ) : null}
    </div>
  );
}
