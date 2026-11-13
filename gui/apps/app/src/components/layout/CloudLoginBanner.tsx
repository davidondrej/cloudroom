import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { cloudLoginTitle, type CloudLoginProvider } from "@cloudroom/domain";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { publishBannerHeight } from "./DesktopUpdateBanner";
import { useCloudLogins, useCloudroomAccount, useCloudroomThread } from "@/hooks/queries/cloudroom-queries";
import { DeviceCode } from "@/components/thread/timeline/CloudLoginRow";
import { CLOUD_LOGIN_FIXED_EVENT, RECONNECT_EVENT, reconnectCloud, useCloudReconnect } from "@/lib/cloud-reconnect";

// The X hides it until the app restarts (David, 2026-11-09).
let dismissed = false;
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Codex disconnected in Cloud" on every screen, until Cloud accepts the login again. Hidden where the page already
 *  shows Reconnect: a thread waiting for its login, and Loops. Also answers plugins' Reconnect requests. */
export function CloudLoginBanner({ threadId, onLoops }: { threadId: string | null; onLoops: boolean }) {
  const account = useCloudroomAccount();
  const issues = useCloudLogins(account.data?.ready === true).data ?? [];
  // Reads the thread view's own status poll; never fetches.
  const threadWaiting = useCloudroomThread(threadId ?? "", false).data?.authRequired === true;
  const [hidden, setHidden] = useState(dismissed);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  useEffect(() => {
    const reconnect = (event: Event) => {
      const provider = (event as CustomEvent<CloudLoginProvider>).detail;
      reconnectCloud(provider, () => navigate(`/settings/providers/${provider}`));
    };
    const fixed = () => {
      void queryClient.invalidateQueries({ queryKey: ["cloud-logins"] });
      void queryClient.invalidateQueries({ queryKey: ["cloudroom-thread"] });
    };
    window.addEventListener(RECONNECT_EVENT, reconnect);
    window.addEventListener(CLOUD_LOGIN_FIXED_EVENT, fixed);
    return () => {
      window.removeEventListener(RECONNECT_EVENT, reconnect);
      window.removeEventListener(CLOUD_LOGIN_FIXED_EVENT, fixed);
    };
  }, [navigate, queryClient]);
  if (hidden || threadWaiting || onLoops || issues.length === 0) return null;
  return (
    <div ref={publishBannerHeight} role="alert" className="flex shrink-0 flex-col border-b border-destructive/30 bg-destructive/10">
      {issues.map((issue) => (
        <IssueLine key={issue.provider} issue={issue} onDismiss={() => { dismissed = true; setHidden(true); }} />
      ))}
    </div>
  );
}

function IssueLine({ issue, onDismiss }: { issue: { provider: CloudLoginProvider; threads: number; loops: number }; onDismiss: () => void }) {
  const state = useCloudReconnect(issue.provider);
  const waiting = [issue.loops ? count(issue.loops, "loop paused", "loops paused") : null, issue.threads ? count(issue.threads, "thread waiting", "threads waiting") : null].filter(Boolean).join(", ");
  return (
    <div className="flex items-center gap-3 px-4 py-2 text-sm">
      <Icon name="AlertTriangle" className="size-4 shrink-0 text-destructive" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        <strong>{cloudLoginTitle(issue.provider)}.</strong>{" "}
        <span className={state.error ? "text-destructive-text" : "text-muted-foreground"}>{state.error ?? (waiting ? `${waiting}.` : "")}</span>
      </span>
      {state.waiting && state.code ? <DeviceCode code={state.code} /> : null}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={state.waiting}
        className="border-primary/35 text-primary hover:border-primary/70 hover:bg-primary/15"
        onClick={() => window.dispatchEvent(new CustomEvent(RECONNECT_EVENT, { detail: issue.provider }))}
      >
        {state.waiting ? <><Icon name="Spinner" className="size-3.5 animate-spin" aria-hidden />Waiting for sign-in</> : "Reconnect"}
      </Button>
      <Button size="icon" variant="ghost" aria-label="Hide until Cloudroom restarts" onClick={onDismiss}>
        <Icon name="X" className="size-4" />
      </Button>
    </div>
  );
}
