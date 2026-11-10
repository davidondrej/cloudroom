import { createContext, useState } from "react";
import { useNavigate } from "react-router-dom";
import { cloudLoginName, cloudLoginProvider, cloudLoginTitle, type CloudLoginProvider } from "@cloudroom/domain";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { useCloudroomThread } from "@/hooks/queries/cloudroom-queries";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { connectCursorKey, reconnectCloud, useCloudReconnect } from "@/lib/cloud-reconnect";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { getProviderIconInfo, getProviderIconTintStyle } from "@/lib/provider-icon";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import type { ThreadTimelineViewRow } from "@cloudroom/thread-view";

/** The last failed Cloud start that Cloud refused for an agent's login. It replaces the "Provisioning thread failed" log. */
export const LatestCloudLoginRowIdContext = createContext<string | null>(null);

// A failed Cloud start: its provisioning operation (or an error row with the same title), with the start's log as detail.
const failedStart = (row: ThreadTimelineViewRow) =>
  row.kind === "system" && (row.systemKind === "operation" || row.systemKind === "error") && row.title === "Provisioning thread failed";

export function cloudLoginRowProvider(row: ThreadTimelineViewRow): CloudLoginProvider | null {
  return failedStart(row) && row.kind === "system" ? cloudLoginProvider(row.detail) : null;
}

/** The newest failed start, when Cloud refused it for a login; null when a later start failed for another reason. */
export function findLatestCloudLoginRowId(rows: readonly ThreadTimelineViewRow[]): string | null | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    const nested = row.kind === "turn" && row.children ? findLatestCloudLoginRowId(row.children) : undefined;
    if (nested !== undefined) return nested;
    if (failedStart(row)) return cloudLoginRowProvider(row) ? row.id : null;
  }
  return undefined;
}

/** "Codex disconnected in Cloud" with one Reconnect, like the plan-limit row: one title, one button, no small text.
 *  While the start retries it says so; once the thread started, it is one quiet line. Older refusals show nothing. */
export function CloudLoginRow({ row, provider, latest, className }: { row: ThreadTimelineViewRow; provider: CloudLoginProvider; latest: boolean; className?: string }) {
  const status = useCloudroomThread(row.threadId, latest).data;
  const state = useCloudReconnect(provider);
  const navigate = useNavigate();
  const agent = useSystemProviders().data?.find((entry) => entry.id === provider) ?? null;
  const Logo = getProviderIconInfo("agent", provider, agent).icon;
  if (!latest || !status) return null;
  if (status.sessionId) {
    return (
      <p className={cn("flex items-center gap-2 py-1 text-sm text-muted-foreground", className)}>
        <Icon name="Check" className="size-3.5 text-success" aria-hidden />
        {cloudLoginName(provider)} reconnected in Cloud
      </p>
    );
  }
  const busy = state.waiting ? `Waiting for ${provider === "codex" ? "ChatGPT" : cloudLoginName(provider)} sign-in` : status.authRequired ? null : `Starting ${cloudLoginName(provider)}`;
  return (
    <div className={cn("flex flex-col gap-3 py-1", className)}>
      <p className="flex items-center gap-2.5 text-base font-semibold text-foreground">
        <span className="inline-flex shrink-0" style={agent ? getProviderIconTintStyle(agent) : undefined}>
          <Logo className="size-[18px] text-muted-foreground" />
        </span>
        {cloudLoginTitle(provider)}
      </p>
      {/* Claude Code signs in with its own card above the composer. */}
      {provider === "claude-code" && !busy ? null : (
        <div className="flex flex-wrap items-center gap-2 pl-7">
          {busy ? (
            <Button type="button" size="sm" variant="outline" disabled>
              <Icon name="Spinner" className="size-3.5 animate-spin" aria-hidden />
              {busy}
            </Button>
          ) : (
            <Button type="button" size="sm" variant="outline" onClick={() => reconnectCloud(provider, () => navigate(`/settings/providers/${provider}`))}>
              Reconnect
            </Button>
          )}
          {state.waiting && state.code ? <DeviceCode code={state.code} /> : null}
          {state.waiting && state.url ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => openUrlInExternalBrowser(state.url!)}>
              <Icon name="ExternalLink" className="size-3.5" aria-hidden />
              Open again
            </Button>
          ) : null}
        </div>
      )}
      {state.error && status.authRequired ? <p role="alert" className="-mt-1 pl-7 text-sm text-destructive-text">{state.error}</p> : null}
      {provider === "acp-cursor" && state.error && status.authRequired && !busy ? <CursorKeyForm /> : null}
    </div>
  );
}

/** The code OpenAI's device page asks for (a cloud VM's sign-in). It was copied when the page opened. */
export function DeviceCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
      Enter code
      <code className="rounded border border-border px-1.5 py-0.5 font-mono text-foreground tracking-wider">{code}</code>
      <Button type="button" size="sm" variant="ghost" onClick={() => void copyToClipboardWithToast(code, { successMessage: null, errorMessage: "Copy failed. Select the code and copy it." }).then(setCopied)}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </span>
  );
}

/** Cursor's other way in when this Mac has no Cursor login: a user API key, sent to Cloud and never kept here. */
function CursorKeyForm() {
  const [key, setKey] = useState("");
  return (
    <form className="-mt-1 flex items-center gap-2 pl-7" onSubmit={(event) => { event.preventDefault(); void connectCursorKey(key); setKey(""); }}>
      <input type="password" autoComplete="off" aria-label="Cursor API key" placeholder="Or paste a Cursor API key" value={key} onChange={(event) => setKey(event.target.value)} className="h-8 w-64 rounded-md border bg-background px-2.5 text-sm" />
      <Button type="submit" size="sm" variant="outline" disabled={!key.trim()}>Connect</Button>
    </form>
  );
}
