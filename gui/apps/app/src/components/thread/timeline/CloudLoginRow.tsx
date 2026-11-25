import { createContext, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import {
  cloudLoginName,
  cloudLoginProvider,
  cloudLoginTitle,
  COMPUTER_TITLE,
  isCloudGithubLoginError,
  type CloudLoginProvider,
  type ProjectCopyProgress,
} from "@cloudroom/domain";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  useCloudroomAccount,
  useCloudroomThread,
  useRetryCloudStart,
  useRetryProjectCopy,
  useSetCopyLogins,
} from "@/hooks/queries/cloudroom-queries";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { useThisComputer } from "@/hooks/useHostDaemon";
import { ClaudeInlineSignIn, useClaudeConnection } from "@/components/ClaudeConnection";
import { connectCursorKey, reconnectCloud, useCloudReconnect } from "@/lib/cloud-reconnect";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { getProviderIconInfo, getProviderIconTintStyle } from "@/lib/provider-icon";
import { sdk } from "@/lib/sdk";
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

function openGithubPage(url: string | null | undefined): void {
  if (!url) return;
  try {
    if (new URL(url).origin === "https://github.com") openUrlInExternalBrowser(url);
  } catch {
    // Ignore malformed URLs.
  }
}

/** Whether a thread's project copy failed because Cloud needs a working GitHub login. */
export function isCloudGithubLoginMissing(projectCopy: ProjectCopyProgress | null | undefined): boolean {
  return Boolean(
    projectCopy &&
      projectCopy.phase === "error" &&
      projectCopy.gitHost !== "gitlab" &&
      isCloudGithubLoginError(projectCopy.error),
  );
}

/** "Codex disconnected in Cloud" with one Reconnect, or inline copy-logins recovery when login copying is off.
 *  While the start retries it says so; once the thread started, it is one quiet line. Older refusals show nothing. */
export function CloudLoginRow({ row, provider, latest, className }: { row: ThreadTimelineViewRow; provider: CloudLoginProvider; latest: boolean; className?: string }) {
  const status = useCloudroomThread(row.threadId, latest).data;
  const account = useCloudroomAccount(latest).data;
  const setCopyLogins = useSetCopyLogins();
  const retryCloudStart = useRetryCloudStart(row.threadId);
  const state = useCloudReconnect(provider);
  const navigate = useNavigate();
  const here = useThisComputer();
  const computerTitle = here === "this PC" ? "PC" : COMPUTER_TITLE;
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);
  const agent = useSystemProviders().data?.find((entry) => entry.id === provider) ?? null;
  const Logo = getProviderIconInfo("agent", provider, agent).icon;
  const claudeAuth = useClaudeConnection({ target: "cloud" }, latest && provider === "claude-code" && !status?.sessionId);
  const copyOffCandidate = provider === "codex" && Boolean(account?.account) && account?.copyLogins !== true;
  const codexAccounts = useQuery({
    queryKey: ["cloudroom-codex-accounts"],
    queryFn: ({ signal }) => sdk.cloudroom.codexAccounts({ action: "list" }, signal),
    enabled: latest && copyOffCandidate && Boolean(status?.authRequired) && !status?.sessionId,
    retry: false,
  });
  if (!latest || !status) return null;
  if (status.sessionId) {
    return (
      <p className={cn("flex items-center gap-2 py-1 text-sm text-muted-foreground", className)}>
        <Icon name="Check" className="size-3.5 text-success" aria-hidden />
        {cloudLoginName(provider)} reconnected in Cloud
      </p>
    );
  }
  const websiteCodexAccount =
    Boolean(codexAccounts.data && "accounts" in codexAccounts.data && codexAccounts.data.accounts.some((entry) => entry.inUse));
  const copyOff = copyOffCandidate && !codexAccounts.isPending && !websiteCodexAccount;
  const busy = enabling
    ? `Copying ${computerTitle} logins`
    : state.waiting
      ? `Waiting for ${provider === "codex" ? "ChatGPT" : cloudLoginName(provider)} sign-in`
      : status.authRequired
        ? null
        : `Starting ${cloudLoginName(provider)}`;
  const claudeConnected = provider === "claude-code" && claudeAuth.data?.state === "connected";
  const foundLine = copyOff && account?.localLogins?.codex
    ? `Found Codex on ${here}. Login copying stays off until you allow it.`
    : null;
  const handleCopyAndRetry = async () => {
    setEnabling(true);
    setEnableError(null);
    try {
      await setCopyLogins.mutateAsync(true);
      reconnectCloud(provider, () => navigate(`/settings/providers/${provider}`));
      void sdk.cloudroom.copyLoginsNow().catch(() => {});
    } catch (error) {
      setEnableError(error instanceof Error ? error.message : String(error));
    } finally {
      setEnabling(false);
    }
  };
  return (
    <div className={cn("flex flex-col gap-3 py-1", className)}>
      <p className="flex flex-wrap items-center gap-2.5 text-base font-semibold text-foreground">
        <span className="inline-flex shrink-0" style={agent ? getProviderIconTintStyle(agent) : undefined}>
          <Logo className="size-[18px] text-muted-foreground" />
        </span>
        <span>{copyOff ? `Cloud needs your ${cloudLoginName(provider)} login` : cloudLoginTitle(provider)}</span>
        {claudeConnected && !busy ? (
          <span className="inline-flex items-center gap-1 text-sm font-normal text-muted-foreground">
            <Icon name="Check" className="size-3.5 text-success" aria-hidden />
            Connected
          </span>
        ) : null}
      </p>
      {copyOff && !busy ? (
        <p className="-mt-1.5 pl-7 text-sm text-muted-foreground">
          {foundLine ?? `Login copying is off on ${here}. Allow it to connect ${cloudLoginName(provider)} and retry.`}
        </p>
      ) : null}
      {provider === "claude-code" && !busy ? (
        <div className="pl-7">
          <ClaudeInlineSignIn
            target={{ target: "cloud" }}
            onContinue={() => retryCloudStart.mutate()}
            continuing={retryCloudStart.isPending}
          />
          {retryCloudStart.error ? (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {retryCloudStart.error.message}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 pl-7">
          {busy ? (
            <Button type="button" size="sm" variant="outline" disabled>
              <Icon name="Spinner" className="size-3.5 animate-spin" aria-hidden />
              {busy}
            </Button>
          ) : copyOff ? (
            <>
              <Button type="button" size="sm" variant="default" onClick={() => void handleCopyAndRetry()}>
                Copy {computerTitle} logins &amp; retry
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => navigate("/settings/cloud-environment")}>
                Cloud settings
              </Button>
            </>
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
      {enableError || (state.error && status.authRequired) ? (
        <p role="alert" className="-mt-1 pl-7 text-sm text-destructive-text">
          {enableError ?? state.error}
        </p>
      ) : null}
      {provider === "acp-cursor" && state.error && status.authRequired && !busy ? <CursorKeyForm /> : null}
    </div>
  );
}

/** Inline timeline recovery when a private GitHub clone fails for a missing or rejected Cloud GitHub login. */
export function CloudGithubLoginRow({
  threadId,
  projectCopy,
  className,
}: {
  threadId: string;
  projectCopy: ProjectCopyProgress | null | undefined;
  className?: string;
}) {
  const dismissKey = `cloudroom.project-copy.dismissed.${threadId}`;
  const missing = isCloudGithubLoginMissing(projectCopy);
  const [dismissed, setDismissed] = useState(() => typeof window !== "undefined" && Boolean(window.localStorage.getItem(dismissKey)));
  const [engaged, setEngaged] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [startingGithub, setStartingGithub] = useState(false);
  const [copyingMac, setCopyingMac] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retryOutcome, setRetryOutcome] = useState<"cloning" | "copied" | "folder_not_empty" | null>(null);
  const requestId = useRef<string | null>(null);
  const hadCode = useRef(false);
  const retryTriggered = useRef(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const here = useThisComputer();
  const computerTitle = here === "this PC" ? "PC" : COMPUTER_TITLE;
  const retryCopy = useRetryProjectCopy(threadId, { showToast: false });
  const phase = projectCopy?.phase;
  const transitioning = engaged && (phase === "cloning" || phase === "uploading" || phase === "waiting" || (phase === "complete" && retryOutcome !== null));
  const visible = !dismissed && (missing || transitioning);
  const account = useCloudroomAccount(visible).data;
  const githubStatus = useQuery({
    queryKey: ["cloudroom-github-auth"],
    queryFn: ({ signal }) => sdk.cloudroom.githubAuth(signal),
    enabled: visible,
    retry: false,
    refetchInterval: (query) => (connecting && (!query.state.data || query.state.data.state === "waiting") ? 1500 : false),
  });

  const ghState = connecting ? githubStatus.data?.state : undefined;
  const ghWaiting = connecting && (!ghState || ghState === "waiting");
  const code = ghState === "waiting" ? githubStatus.data?.user_code : null;
  const url = ghState === "waiting" ? githubStatus.data?.verification_url : null;
  const ghError =
    connecting &&
    (ghState === "error" || ghState === "expired" || (ghState === "connected" && Boolean(githubStatus.data?.message)))
      ? (githubStatus.data?.message ?? "GitHub sign-in didn't finish. Try again.")
      : null;

  useEffect(() => {
    if (!ghWaiting) return;
    if (code) {
      hadCode.current = true;
      return;
    }
    if (url && hadCode.current) {
      hadCode.current = false;
      openGithubPage(url);
    }
  }, [ghWaiting, code, url]);

  useEffect(() => {
    if (!connecting || ghState !== "connected" || githubStatus.data?.message) return;
    void queryClient.invalidateQueries({ queryKey: ["cloudroom-github-auth"] });
    void queryClient.invalidateQueries({ queryKey: ["cloudroom-github-account"] });
    if (!retryTriggered.current) {
      retryTriggered.current = true;
      retryCopy.mutate(undefined, {
        onSuccess: (result) => setRetryOutcome(result?.status ?? "cloning"),
        onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
      });
    }
  }, [connecting, ghState, githubStatus.data?.message, queryClient, retryCopy]);

  if (!visible) return null;
  if (engaged && phase === "complete" && retryOutcome !== null) {
    return (
      <p className={cn("flex items-center gap-2 py-1 text-sm text-muted-foreground", className)}>
        <Icon name="Check" className="size-3.5 text-success" aria-hidden />
        {retryOutcome === "folder_not_empty" ? (
          <span>
            GitHub connected — folder already has files. Start a new thread or run{" "}
            <code className="font-mono text-foreground">git clone</code>.
          </span>
        ) : (
          "GitHub connected and repository cloned"
        )}
      </p>
    );
  }

  const githubUser = account?.localLogins?.githubUser ?? null;
  const canCopyMac = Boolean(account?.account) && account?.localLogins?.github === true;
  const expiredError = /rejected the cloud's GitHub login/i.test(projectCopy?.error ?? "");
  const alreadyConnected = !connecting && !expiredError && githubStatus.data?.state === "connected" && !githubStatus.data.message;
  const foundLine = alreadyConnected
    ? "GitHub is connected in Cloud. Retry to clone this repository."
    : canCopyMac
      ? `Found GitHub CLI${githubUser ? ` (@${githubUser})` : ""} on ${here}. Nothing is uploaded until you allow it.`
      : null;
  const cloning = phase === "cloning" || phase === "uploading" || phase === "waiting";
  const busyLabel = copyingMac
    ? `Connecting ${githubUser ? `@${githubUser}` : `${computerTitle} GitHub`}`
    : startingGithub
      ? "Starting GitHub sign-in"
      : retryCopy.isPending || cloning
        ? "Retrying…"
        : null;

  const runRetry = async () => {
    const result = await retryCopy.mutateAsync();
    setRetryOutcome(result?.status ?? "cloning");
  };

  const handleRetryOnly = async () => {
    setEngaged(true);
    setActionError(null);
    setRetryOutcome(null);
    try {
      await runRetry();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleCopyMacAndRetry = async () => {
    setEngaged(true);
    setConnecting(false);
    setCopyingMac(true);
    setActionError(null);
    setRetryOutcome(null);
    try {
      await sdk.cloudroom.copyMacGithub(githubUser);
      void queryClient.invalidateQueries({ queryKey: ["cloudroom-github-auth"] });
      void queryClient.invalidateQueries({ queryKey: ["cloudroom-github-account"] });
      await runRetry();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setCopyingMac(false);
    }
  };

  const startGithubLogin = async (repos: boolean) => {
    setEngaged(true);
    setStartingGithub(true);
    setActionError(null);
    setRetryOutcome(null);
    retryTriggered.current = false;
    hadCode.current = false;
    try {
      const id = crypto.randomUUID();
      requestId.current = id;
      const result = await sdk.cloudroom.githubLogin(id, repos);
      if (result.state === "waiting" && result.verification_url) {
        if (new URL(result.verification_url).origin !== "https://github.com") {
          throw new Error("Unexpected GitHub sign-in page.");
        }
        queryClient.setQueryData(["cloudroom-github-auth"], result);
        setConnecting(true);
        if (result.user_code) {
          hadCode.current = true;
          void copyToClipboardWithToast(result.user_code, { successMessage: "Code copied. Paste it on github.com." });
        }
        openGithubPage(result.verification_url);
      } else if (result.state === "connected") {
        await runRetry();
      } else {
        throw new Error(result.message ?? "GitHub sign-in could not start. Try again.");
      }
    } catch (error) {
      setConnecting(false);
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setStartingGithub(false);
    }
  };

  const cancelGithubLogin = async () => {
    setConnecting(false);
    const id = requestId.current ?? githubStatus.data?.login_id ?? "";
    if (id) await sdk.cloudroom.cancelGithubLogin(id).catch(() => {});
    void queryClient.invalidateQueries({ queryKey: ["cloudroom-github-auth"] });
  };

  const dismiss = () => {
    window.localStorage.setItem(dismissKey, "1");
    setDismissed(true);
  };

  return (
    <div className={cn("flex flex-col gap-3 py-1", className)}>
      <p className="flex flex-wrap items-center gap-2.5 text-base font-semibold text-foreground">
        <Icon name="Github" className="size-[18px] shrink-0 text-muted-foreground" aria-hidden />
        <span>{alreadyConnected ? "GitHub clone failed" : "Cloud needs your GitHub login"}</span>
      </p>
      {!busyLabel && !ghWaiting ? (
        <p className="-mt-1.5 pl-7 text-sm text-muted-foreground">
          {foundLine ?? "Cloud has no working GitHub login for private repositories."}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 pl-7">
        {busyLabel ? (
          <Button type="button" size="sm" variant="outline" disabled>
            <Icon name="Spinner" className="size-3.5 animate-spin" aria-hidden />
            {busyLabel}
          </Button>
        ) : ghWaiting && code ? (
          <>
            <DeviceCode code={code} />
            {url ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void copyToClipboardWithToast(code, { successMessage: "Code copied. Paste it on github.com." });
                  openGithubPage(url);
                }}
              >
                <Icon name="ExternalLink" className="size-3.5" aria-hidden />
                Open GitHub
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="ghost" onClick={() => void cancelGithubLogin()}>
              Cancel
            </Button>
          </>
        ) : ghWaiting && url ? (
          <>
            <span className="text-sm text-muted-foreground">Pick the repos Cloud may use on GitHub.</span>
            <Button type="button" size="sm" variant="outline" onClick={() => openGithubPage(url)}>
              <Icon name="Github" className="size-3.5" aria-hidden />
              Pick repos on GitHub
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => void cancelGithubLogin()}>
              Cancel
            </Button>
          </>
        ) : ghWaiting ? (
          <>
            <Button type="button" size="sm" variant="outline" disabled>
              <Icon name="Spinner" className="size-3.5 animate-spin" aria-hidden />
              Waiting for GitHub sign-in
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => void cancelGithubLogin()}>
              Cancel
            </Button>
          </>
        ) : alreadyConnected ? (
          <>
            <Button type="button" size="sm" variant="default" onClick={() => void handleRetryOnly()}>
              Retry clone
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void startGithubLogin(true)}>
              Only specific repos
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => void startGithubLogin(false)}>
              Another account
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => navigate("/settings/cloud-environment")}>
              Cloud settings
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={dismiss}>
              Dismiss
            </Button>
          </>
        ) : canCopyMac ? (
          <>
            <Button type="button" size="sm" variant="default" onClick={() => void handleCopyMacAndRetry()}>
              Use {githubUser ? `@${githubUser}` : `${computerTitle} GitHub`} &amp; retry
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void startGithubLogin(true)}>
              Only specific repos
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => void startGithubLogin(false)}>
              Another account
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => navigate("/settings/cloud-environment")}>
              Cloud settings
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={dismiss}>
              Dismiss
            </Button>
          </>
        ) : (
          <>
            <Button type="button" size="sm" variant="default" onClick={() => void startGithubLogin(false)}>
              <Icon name="Github" className="size-3.5" aria-hidden />
              Connect GitHub
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void startGithubLogin(true)}>
              Only specific repos
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => navigate("/settings/cloud-environment")}>
              Cloud settings
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={dismiss}>
              Dismiss
            </Button>
          </>
        )}
      </div>
      {actionError || ghError ? (
        <p role="alert" className="-mt-1 pl-7 text-sm text-destructive-text">
          {actionError ?? ghError}
        </p>
      ) : null}
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
