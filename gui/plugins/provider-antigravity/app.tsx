import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@cloudroom/shared-ui/button";
import type {
  AntigravityLoginInput,
  AntigravityLoginStatus,
  antigravityLoginRpcContract,
} from "./src/login-contract.js";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Settings → Agents → Antigravity: the Google account the CLI is signed in
 * with on this computer. Sign-in opens Google's page, then takes the code it
 * shows; the plugin's host passes that code to `agy acp --login`.
 */
function GoogleAccount() {
  const rpc = useRpc<typeof antigravityLoginRpcContract>();
  const navigate = useBbNavigate();
  const [status, setStatus] = useState<AntigravityLoginStatus | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (input: AntigravityLoginInput) => {
      setBusy(true);
      setError(null);
      try {
        const next = await rpc.call("antigravityAccount", input);
        setStatus(next);
        if (next.state === "error") setError(next.message);
        return next;
      } catch (cause) {
        setError(errorText(cause));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [rpc],
  );
  useEffect(() => {
    void run({ action: "status" });
  }, [run]);

  const signIn = async () => {
    const next = await run({ action: "login", requestId: crypto.randomUUID() });
    if (next?.state === "waiting" && next.verification_url)
      navigate.openUrl(next.verification_url);
  };
  const state = status?.state;
  const waiting = state === "waiting" && status?.login_id ? status : null;
  const detail =
    status === null
      ? "Checking…"
      : state === "connected"
        ? "Signed in on this computer. Antigravity uses your Google AI plan."
        : waiting
          ? waiting.verification_url
            ? "Sign in with Google in your browser, then paste the code it shows."
            : "Getting the sign-in link…"
          : state === "unavailable"
            ? (status.message ??
              "Could not check Antigravity on this computer.")
            : "Signed out on this computer.";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border py-2.5 pl-3.5 pr-2 text-sm">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground">Google account</div>
          <div className="text-xs text-subtle-foreground">{detail}</div>
        </div>
        {status === null ? null : state === "connected" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void run({ action: "logout" })}
          >
            Sign out
          </Button>
        ) : waiting ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run({ action: "cancel", requestId: waiting.login_id! })
            }
          >
            Cancel
          </Button>
        ) : state === "unavailable" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void run({ action: "status" })}
          >
            Check again
          </Button>
        ) : (
          <Button size="sm" disabled={busy} onClick={() => void signIn()}>
            {busy ? "Opening sign-in…" : "Sign in with Google"}
          </Button>
        )}
      </div>
      {waiting?.verification_url ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const entered = code.trim();
            setCode("");
            if (entered)
              void run({
                action: "complete",
                requestId: waiting.login_id!,
                code: entered,
              });
          }}
        >
          <input
            type="password"
            maxLength={4096}
            autoComplete="off"
            spellCheck={false}
            placeholder="Code from Google"
            aria-label="Google sign-in code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
          />
          <Button type="submit" size="sm" disabled={busy || !code.trim()}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => navigate.openUrl(waiting.verification_url!)}
          >
            Open sign-in page
          </Button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  // Settings → Agents → Antigravity. The tab names the page, so the section has no title of its own.
  app.slots.settingsSection({
    id: "google-account",
    component: GoogleAccount,
  });
});
