import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { PersistentResponsiveDrawerShell } from "@cloudroom/shared-ui/responsive-overlay";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import {
  agyLoginQueryKey,
  antigravityLogin,
  useAntigravityCloud,
} from "@/lib/antigravity-cloud";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { CLOUD_LOGIN_FIXED_EVENT } from "@/lib/cloud-reconnect";

export type AntigravityCloudDialogMode = "google" | "key";

async function applyAntigravityResult(
  query: QueryClient,
  account: string,
  result: Awaited<ReturnType<typeof antigravityLogin>>,
) {
  if (typeof result.connected !== "boolean") return;
  await query.cancelQueries({ queryKey: agyLoginQueryKey(account) });
  query.setQueryData(agyLoginQueryKey(account), result);
  void query.invalidateQueries({ queryKey: ["cloudroom-connection"] });
  if (result.connected) {
    window.dispatchEvent(
      new CustomEvent(CLOUD_LOGIN_FIXED_EVENT, {
        detail: "acp-antigravity",
      }),
    );
  }
}

export function useDisconnectAntigravityCloud() {
  const query = useQueryClient();
  const account = useCloudroomAccount().data?.account?.id;
  return useMutation({
    mutationFn: () => antigravityLogin({ action: "disconnect" }),
    onSuccess: async (result) => {
      if (account) await applyAntigravityResult(query, account, result);
      else void query.invalidateQueries({ queryKey: ["cloudroom-antigravity-login"] });
    },
  });
}

function useAntigravityCloudFlow(
  account: string,
  options?: { initialMode?: "key" | null; keepKeyOnError?: boolean; onConnected?: () => void },
) {
  const query = useQueryClient();
  const status = useAntigravityCloud(true);
  const [mode, setMode] = useState<"code" | "key" | null>(options?.initialMode ?? null);
  const [attempt, setAttempt] = useState<{ ticket: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [canRetryCode, setCanRetryCode] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const submittedCode = useRef("");
  const attemptTicket = useRef<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const onConnectedRef = useRef(options?.onConnected);

  useEffect(() => {
    onConnectedRef.current = options?.onConnected;
  }, [options?.onConnected]);

  useEffect(
    () => () => {
      inFlight.current?.abort();
      inFlight.current = null;
      const ticket = attemptTicket.current;
      attemptTicket.current = null;
      if (ticket) {
        void antigravityLogin({ action: "cancel", ticket }).catch(() => {});
      }
    },
    [],
  );

  async function submit(
    action: "begin" | "complete" | "key" | "cancel" | "disconnect",
  ) {
    if (inFlight.current) return;
    const value =
      input.current?.value.trim() ||
      (action === "complete" ? submittedCode.current : "");
    if ((action === "complete" || action === "key") && !value) return;
    if (action === "complete") {
      submittedCode.current = value;
      setCanRetryCode(true);
    }
    const operation = new AbortController();
    inFlight.current = operation;
    setBusy(true);
    setError("");
    if (input.current) input.current.value = "";
    try {
      const result = await antigravityLogin(
        {
          action,
          ...(action === "begin" || action === "key"
            ? { requestId: crypto.randomUUID() }
            : { ticket: attempt?.ticket }),
          ...(action === "complete"
            ? { code: value }
            : action === "key"
              ? { apiKey: value }
              : {}),
        },
        operation.signal,
      );
      if (operation.signal.aborted) return;
      if (result.ticket && result.url) {
        attemptTicket.current = result.ticket;
        setAttempt({ ticket: result.ticket, url: result.url });
        setMode("code");
        openUrlInExternalBrowser(result.url);
      } else {
        submittedCode.current = "";
        setCanRetryCode(false);
        attemptTicket.current = null;
        if (result.restart)
          setError("Google could not verify this sign-in. Start sign-in again.");
        setMode(null);
        setAttempt(null);
        await applyAntigravityResult(query, account, result);
        if (result.connected && !result.restart) onConnectedRef.current?.();
      }
    } catch (e) {
      if (operation.signal.aborted) return;
      setError(e instanceof Error ? e.message : "Sign-in failed.");
      const expired =
        action === "complete" &&
        /expired|start sign-in again/i.test(e instanceof Error ? e.message : "");
      if (action === "key" && options?.keepKeyOnError) {
        // Keep the Gemini API key dialog open so the user can fix and retry.
      } else if (action !== "complete" || expired) {
        submittedCode.current = "";
        setCanRetryCode(false);
        attemptTicket.current = null;
        setAttempt(null);
        setMode(null);
      }
    } finally {
      if (inFlight.current === operation) {
        inFlight.current = null;
        setBusy(false);
      }
    }
  }

  function abortAndCancel() {
    inFlight.current?.abort();
    inFlight.current = null;
    setBusy(false);
    const ticket = attemptTicket.current;
    attemptTicket.current = null;
    if (ticket) {
      void antigravityLogin({ action: "cancel", ticket }).catch(() => {});
    }
    submittedCode.current = "";
    setCanRetryCode(false);
    setAttempt(null);
    setMode(null);
    setError("");
  }

  return {
    status,
    mode,
    setMode,
    attempt,
    busy,
    error,
    setError,
    input,
    canRetryCode,
    submit,
    abortAndCancel,
  };
}

/** One-line Cloud sign-in bar under the new-thread composer. */
export function AntigravityCloudLogin({ state }: { state: "checking" | "unavailable" | "signed_out" }) {
  const accountQuery = useCloudroomAccount();
  const query = useQueryClient();
  const account = accountQuery.data?.account?.id;
  if (account) return <ComposerLogin key={account} account={account} state={state} />;
  // No account answer yet, so the status check can't run: still say why Send is blocked.
  if (accountQuery.isSuccess && state !== "unavailable") return null;
  return accountQuery.isError || state === "unavailable"
    ? <AgyCheckFailed onRetry={() => void retryAgyChecks(query)} />
    : <div className="px-[18px] pt-2 text-xs text-muted-foreground">Checking Antigravity…</div>;
}

function retryAgyChecks(query: QueryClient, status?: { refetch: () => Promise<unknown> }) {
  void status?.refetch();
  void query.invalidateQueries({ queryKey: ["cloudroom-account"] });
  return query.invalidateQueries({ queryKey: ["cloudroom-connection"] });
}

function AgyCheckFailed({ onRetry, inline }: { onRetry: () => void; inline?: boolean }) {
  const body = (
    <>
      <Icon name="AlertTriangle" className="size-3.5 shrink-0 text-warning-text" aria-hidden />
      Couldn't check Antigravity.
      <button type="button" className="font-medium text-primary-text hover:underline" onClick={onRetry}>
        Retry
      </button>
    </>
  );
  return inline ? body : <div className="flex flex-wrap items-center gap-1.5 px-[18px] pt-2 text-xs text-muted-foreground">{body}</div>;
}

// Stays mounted while the status rechecks, so a Google code being pasted isn't lost (#2637).
function ComposerLogin({ account, state }: { account: string; state: "checking" | "unavailable" | "signed_out" }) {
  const {
    status,
    mode,
    setMode,
    attempt,
    busy,
    error,
    setError,
    input,
    canRetryCode,
    submit,
  } = useAntigravityCloudFlow(account);
  const query = useQueryClient();
  const quiet = (label: string, onClick: () => void, disabled = busy) => (
    <button
      type="button"
      className="font-medium text-foreground/80 hover:underline disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
  const dot = (
    <span className="text-muted-foreground/50" aria-hidden>
      ·
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-[18px] pt-2 text-xs text-muted-foreground">
      {!mode && state === "checking" ? (
        "Checking Antigravity…"
      ) : !mode && state === "unavailable" ? (
        <AgyCheckFailed inline onRetry={() => void retryAgyChecks(query, status)} />
      ) : !mode ? (
        <>
          <Icon name="AlertTriangle" className="size-3.5 shrink-0 text-warning-text" aria-hidden />
          Antigravity isn't connected.
          <button
            type="button"
            className="font-medium text-primary-text hover:underline disabled:opacity-50"
            disabled={busy}
            onClick={() => void submit("begin")}
          >
            {busy ? "Connecting…" : "Sign in with Google"}
          </button>
          {status.data?.connected && quiet("Disconnect", () => void submit("disconnect"))}
          {dot}
          {quiet("Use API key", () => {
            setError("");
            setMode("key");
          })}
        </>
      ) : (
        <>
          <input
            ref={input}
            autoFocus
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              event.stopPropagation();
              void submit(mode === "code" ? "complete" : "key");
            }}
            type="password"
            autoComplete="off"
            aria-label={mode === "code" ? "Google sign-in code" : "Gemini API key"}
            placeholder={mode === "code" ? "Paste the Google code" : "Gemini API key"}
            className="h-7 w-56 rounded-md border border-input bg-transparent px-2 text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <Button
            type="button"
            size="sm"
            className="h-7 px-2.5 text-xs"
            disabled={busy}
            onClick={() => void submit(mode === "code" ? "complete" : "key")}
          >
            {busy ? "Connecting…" : canRetryCode ? "Retry sign-in" : "Connect"}
          </Button>
          {attempt && quiet("Open Google", () => openUrlInExternalBrowser(attempt.url), false)}
          {attempt && dot}
          {quiet("Cancel", () => {
            if (attempt) void submit("cancel");
            else setMode(null);
          })}
        </>
      )}
      {error && (
        <p role="alert" className="text-destructive-text">
          {error}
        </p>
      )}
    </div>
  );
}

/** Dialog opened from Settings → Harness when connecting Antigravity in Cloud. */
export function AntigravityCloudDialog({
  mode,
  onClose,
}: {
  mode: AntigravityCloudDialogMode | null;
  onClose: () => void;
}) {
  const account = useCloudroomAccount().data?.account?.id;
  if (!account || mode === null) return null;
  return (
    <AntigravityCloudDialogBody
      key={`${account}:${mode}`}
      account={account}
      initialMode={mode}
      onClose={onClose}
    />
  );
}

function AntigravityCloudDialogBody({
  account,
  initialMode,
  onClose,
}: {
  account: string;
  initialMode: AntigravityCloudDialogMode;
  onClose: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const [hasValue, setHasValue] = useState(false);
  const {
    status,
    mode,
    setMode,
    attempt,
    busy,
    error,
    setError,
    input,
    canRetryCode,
    submit,
    abortAndCancel,
  } = useAntigravityCloudFlow(account, {
    initialMode: initialMode === "key" ? "key" : null,
    keepKeyOnError: true,
    onConnected: onClose,
  });

  useEffect(() => {
    if (initialMode === "google") void submit("begin");
    // Start Google sign-in once when the dialog opens in Google mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMode]);

  const close = () => {
    abortAndCancel();
    onClose();
  };

  const showingKey = mode === "key";
  const showingCode = mode === "code";
  const startingGoogle = !showingKey && !showingCode && busy;
  const title = showingKey
    ? "Gemini API key"
    : status.data?.connected
      ? "Switch Google account"
      : "Sign in with Google";
  const description = showingKey
    ? "Use a Gemini API key for Antigravity in Cloud threads."
    : showingCode
      ? "Finish signing in with Google in your browser, then paste the code below."
      : "Connect your Google account for Antigravity in Cloud threads.";

  const canSubmit = showingCode ? hasValue || canRetryCode : hasValue;

  return (
    <PersistentResponsiveDrawerShell
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      labelledBy={titleId}
      describedBy={descriptionId}
      backdropClassName="bg-black/25 backdrop-blur-xs"
      contentClassName="inset-0 m-auto h-fit w-[calc(100%-2rem)] max-w-sm overflow-y-auto rounded-xl p-8 shadow-2xl data-[state=closed]:invisible [&>[data-persistent-drawer-handle]]:hidden"
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <h2 id={titleId} className="text-xl font-semibold">
            {title}
          </h2>
          <p id={descriptionId} className="text-sm text-muted-foreground">
            {description}
          </p>
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive-text">
            {error}
          </p>
        )}

        {startingGoogle ? (
          <div className="space-y-4">
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Icon name="Loading" className="size-4 shrink-0 animate-spin" aria-hidden />
              Opening Google sign-in…
            </p>
            <Button type="button" variant="outline" className="w-full" onClick={close}>
              Cancel
            </Button>
          </div>
        ) : showingCode || showingKey ? (
          <div className="space-y-3">
            <input
              ref={input}
              autoFocus
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label={showingCode ? "Google sign-in code" : "Gemini API key"}
              placeholder={showingCode ? "Paste the Google code" : "Gemini API key"}
              onChange={(event) => setHasValue(event.target.value.trim().length > 0)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                event.stopPropagation();
                if (canSubmit && !busy) {
                  setHasValue(false);
                  void submit(showingCode ? "complete" : "key");
                }
              }}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <Button
              type="button"
              className="w-full"
              disabled={busy || !canSubmit}
              onClick={() => {
                setHasValue(false);
                void submit(showingCode ? "complete" : "key");
              }}
            >
              {busy
                ? "Connecting…"
                : showingCode && canRetryCode
                  ? "Retry sign-in"
                  : "Connect"}
            </Button>
            {showingCode && attempt && (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => openUrlInExternalBrowser(attempt.url)}
              >
                Open Google
              </Button>
            )}
            <Button type="button" variant="ghost" className="w-full" onClick={close}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <Button
              type="button"
              className="w-full"
              disabled={busy}
              onClick={() => void submit("begin")}
            >
              Start sign-in again
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => {
                setError("");
                setHasValue(false);
                setMode("key");
              }}
            >
              Use Gemini API key
            </Button>
            <Button type="button" variant="ghost" className="w-full" onClick={close}>
              Cancel
            </Button>
          </div>
        )}
      </div>
    </PersistentResponsiveDrawerShell>
  );
}
