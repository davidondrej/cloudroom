import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import {
  agyLoginQueryKey,
  antigravityLogin,
  useAntigravityCloud,
} from "@/lib/antigravity-cloud";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { CLOUD_LOGIN_FIXED_EVENT } from "@/lib/cloud-reconnect";

/** `composer` is the one line under the new-thread composer; without it, the buttons in Settings. */
export function AntigravityCloudLogin({ composer = false }: { composer?: boolean }) {
  const account = useCloudroomAccount().data?.account?.id;
  return account ? <Login key={account} account={account} composer={composer} /> : null;
}

function Login({ account, composer }: { account: string; composer: boolean }) {
  const query = useQueryClient(),
    status = useAntigravityCloud(true);
  const [mode, setMode] = useState<"code" | "key" | null>(null);
  const [attempt, setAttempt] = useState<{
    ticket: string;
    url: string;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null),
    pending = useRef(false);
  const submittedCode = useRef("");
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);
  async function submit(
    action: "begin" | "complete" | "key" | "cancel" | "disconnect",
  ) {
    if (pending.current) return;
    const value = input.current?.value.trim() || (action === "complete" ? submittedCode.current : "");
    if ((action === "complete" || action === "key") && !value) return;
    if (action === "complete") submittedCode.current = value;
    const operation = new AbortController();
    inFlight.current = operation;
    pending.current = true;
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
        setAttempt({ ticket: result.ticket, url: result.url });
        setMode("code");
        openUrlInExternalBrowser(result.url);
      } else {
        submittedCode.current = "";
        if (result.restart) setError("Google could not verify this sign-in. Start sign-in again.");
        setMode(null);
        setAttempt(null);
        if (typeof result.connected === "boolean") {
          await query.cancelQueries({ queryKey: agyLoginQueryKey(account) });
          query.setQueryData(agyLoginQueryKey(account), result);
          void query.invalidateQueries({ queryKey: ["cloudroom-connection"] });
          if (result.connected)
            window.dispatchEvent(
              new CustomEvent(CLOUD_LOGIN_FIXED_EVENT, {
                detail: "acp-antigravity",
              }),
            );
        }
      }
    } catch (e) {
      if (operation.signal.aborted) return;
      setError(e instanceof Error ? e.message : "Sign-in failed.");
      if (action !== "complete" || /expired|start sign-in again/i.test(e instanceof Error ? e.message : "")) {
        submittedCode.current = "";
        setAttempt(null);
        setMode(null);
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const quiet = (label: string, onClick: () => void, disabled = busy) =>
    composer ? (
      <button type="button" className="font-medium text-foreground/80 hover:underline disabled:opacity-50" disabled={disabled} onClick={onClick}>
        {label}
      </button>
    ) : (
      <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onClick}>
        {label}
      </Button>
    );
  const dot = composer ? <span className="text-muted-foreground/50" aria-hidden>·</span> : null;
  return (
    <div
      className={
        composer
          ? "flex flex-wrap items-center gap-1.5 px-[18px] pt-2 text-xs text-muted-foreground"
          : "flex flex-wrap items-center gap-2 p-2 text-sm"
      }
    >
      {!mode ? (
        <>
          {composer ? (
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
            </>
          ) : (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void submit("begin")}>
              {busy
                ? "Connecting…"
                : status.data?.connected
                  ? "Switch Google account"
                  : "Sign in with Google"}
            </Button>
          )}
          {status.data?.connected && quiet("Disconnect", () => void submit("disconnect"))}
          {dot}
          {quiet(composer ? "Use API key" : "Use Gemini API key", () => {
            setError("");
            setMode("key");
          })}
        </>
      ) : (
        <>
          <input
            ref={input}
            autoFocus={composer}
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
            className={
              composer
                ? "h-7 w-56 rounded-md border border-input bg-transparent px-2 text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                : "rounded border border-border bg-background px-2 py-1"
            }
          />
          <Button
            type="button"
            size="sm"
            className={composer ? "h-7 px-2.5 text-xs" : undefined}
            disabled={busy}
            onClick={() => void submit(mode === "code" ? "complete" : "key")}
          >
            {busy ? "Connecting…" : submittedCode.current ? "Retry sign-in" : "Connect"}
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
