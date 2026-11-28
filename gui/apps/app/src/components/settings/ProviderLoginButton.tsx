import { useEffect, useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TerminalSession } from "@cloudroom/server-contract";
import { Button } from "@cloudroom/shared-ui/button";
import { PersistentResponsiveDrawerShell } from "@cloudroom/shared-ui/responsive-overlay";
import { AntigravityLoginPlace } from "@/components/AntigravityCloudLogin";
import { restartProviderModels } from "@/components/pickers/ModelUnavailable";
import { appToast } from "@/components/ui/app-toast";
import { ThreadTerminalView } from "@/components/thread/terminal/ThreadTerminalView";
import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
} from "@/components/thread/terminal/useThreadTerminalController";
import { COMPUTER } from "@cloudroom/domain/computer-name";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { callPluginRpc } from "@/lib/plugin-sdk-hooks";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

// A login that just ended may be new: copy it to Cloud now, not at this computer's
// next wake (#1708). An older server answers 404, which changes nothing.
function copyLoginsToCloud(): void {
  void fetchWithAppSurface("/api/v1/cloudroom/mac/logins", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).catch(() => undefined);
}

function closeTerminal(terminalId: string | null): void {
  if (terminalId === null) return;
  void sdk.terminals
    .close({ terminalId, mode: "force" })
    .catch(() => undefined);
}

// Antigravity on this computer signs in with the same paste-the-code field as Cloud and added accounts, through the
// Accounts plugin, never a terminal. Another machine, and Windows (no sign-in terminal there yet), keep the terminal.
const ANTIGRAVITY_LOGIN = /^agy acp --login\b/;
const WINDOWS = typeof navigator !== "undefined" && navigator.platform.startsWith("Win");

/** Runs a provider's login command in a terminal drawer. `start` can be called from any trigger. */
export function useProviderLogin(hostId: string | null, onDone: () => void) {
  const titleId = useId();
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [starting, setStarting] = useState(false);
  const [antigravity, setAntigravity] = useState(false);
  const primaryHostId = useSystemConfig().data?.primaryHostId ?? null;
  const terminalId = useRef<string | null>(null);
  useEffect(() => () => closeTerminal(terminalId.current), []);

  const start = (command: string, name: string, onHost = hostId) => {
    if (onHost === null) {
      appToast.error(`Couldn't find the machine to log in to ${name}. Try again in a moment.`);
      return;
    }
    setDisplayName(name);
    if (ANTIGRAVITY_LOGIN.test(command) && onHost === primaryHostId && !WINDOWS) {
      setAntigravity(true);
      return;
    }
    setStarting(true);
    sdk.terminals
      .create({
        scope: { kind: "host_path", hostId: onHost, cwd: null },
        cols: DEFAULT_TERMINAL_COLS,
        rows: DEFAULT_TERMINAL_ROWS,
        start: { mode: "command", command },
        title: `Log in to ${name}`,
      })
      .then(
        (created) => {
          terminalId.current = created.id;
          setSession(created);
        },
        (error: unknown) =>
        appToast.error(
          error instanceof Error ? error.message : "Couldn't start the login.",
        ),
      )
      .finally(() => setStarting(false));
  };
  const close = () => {
    closeTerminal(terminalId.current);
    terminalId.current = null;
    setSession(null);
    copyLoginsToCloud();
    onDone();
  };

  const drawer = antigravity ? (
    <AntigravityMacSignIn
      onClose={(signedIn) => {
        setAntigravity(false);
        if (signedIn) appToast.success(`Logged in to ${displayName}`);
        onDone();
      }}
    />
  ) : (
    <PersistentResponsiveDrawerShell
      open={session !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      labelledBy={titleId}
      backdropClassName="bg-black/25 backdrop-blur-xs"
      contentClassName="inset-0 m-auto h-fit w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-xl p-6 shadow-2xl data-[state=closed]:invisible [&>[data-persistent-drawer-handle]]:hidden"
    >
      <div className="space-y-4">
        <div className="space-y-1">
          <h2 id={titleId} className="text-lg font-semibold">
            Log in to {displayName}
          </h2>
          <p className="text-sm text-muted-foreground">
            Follow the steps below. Your browser may open to finish signing in.
          </p>
        </div>
        <div className="h-80 overflow-hidden rounded-md border border-border bg-sidebar">
          {session ? (
            <ThreadTerminalView
              autoFocus
              isPanelOpen
              session={session}
              onSessionChange={(next) => {
                setSession(next);
                // The exit arrives twice (session update, then exit message).
                if (next.status !== "exited" || terminalId.current === null) return;
                if (next.exitCode === 0) {
                  appToast.success(`Logged in to ${displayName}`);
                  close();
                  return;
                }
                copyLoginsToCloud();
                onDone();
              }}
            />
          ) : null}
        </div>
        <Button className="w-full" onClick={close}>
          Done
        </Button>
      </div>
    </PersistentResponsiveDrawerShell>
  );
  return { start, starting, drawer };
}

const accountsRpc = (method: string, input: unknown) => callPluginRpc(fetch, "accounts", method, input);

/** This computer's Antigravity login: open Google, paste the code back. Cloud and added accounts sign in apart. */
function AntigravityMacSignIn({ onClose }: { onClose: (signedIn: boolean) => void }) {
  const titleId = useId();
  const [attempt, setAttempt] = useState<{ sessionId: string; url: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  const open = useRef<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const closed = useRef(false);
  useEffect(() => {
    if (attempt) input.current?.focus();
  }, [attempt]);
  useEffect(() => {
    let cancelled = false;
    accountsRpc("antigravity.start", { mac: true }).then(
      (result) => {
        const next = result as { sessionId: string; authorizeUrl: string };
        if (cancelled) {
          void accountsRpc("antigravity.cancel", { sessionId: next.sessionId }).catch(() => {});
          return;
        }
        open.current = next.sessionId;
        setAttempt({ sessionId: next.sessionId, url: next.authorizeUrl });
        openUrlInExternalBrowser(next.authorizeUrl);
      },
      (cause: unknown) => !cancelled && setError(cause instanceof Error ? cause.message : "Sign-in didn't start."),
    );
    return () => {
      cancelled = true;
      if (open.current) void accountsRpc("antigravity.cancel", { sessionId: open.current }).catch(() => {});
      open.current = null;
    };
  }, [tries]);
  const submit = () => {
    if (!attempt || !code.trim() || busy) return;
    setBusy(true);
    setError(null);
    accountsRpc("antigravity.complete", { sessionId: attempt.sessionId, code: code.trim() }).then(
      () => {
        open.current = null;
        if (!closed.current) onClose(true);
      },
      (cause: unknown) => {
        if (closed.current) return;
        const message = cause instanceof Error ? cause.message : "Sign-in failed.";
        // A mistyped code keeps the sign-in open; any other error ends it.
        if (!message.startsWith("Paste the code")) {
          open.current = null;
          setAttempt(null);
        }
        setError(message);
        setBusy(false);
      },
    );
  };
  // Cancel works even while connecting: the effect's cleanup ends the sign-in.
  const cancel = () => {
    closed.current = true;
    onClose(false);
  };
  const again = () => {
    setAttempt(null);
    setCode("");
    setError(null);
    setTries((count) => count + 1);
  };
  return (
    <PersistentResponsiveDrawerShell
      open
      onOpenChange={(next) => {
        if (!next) cancel();
      }}
      labelledBy={titleId}
      backdropClassName="bg-black/25 backdrop-blur-xs"
      contentClassName="inset-0 m-auto h-fit w-[calc(100%-2rem)] max-w-sm overflow-y-auto rounded-xl p-8 shadow-2xl data-[state=closed]:invisible [&>[data-persistent-drawer-handle]]:hidden"
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <AntigravityLoginPlace cloud={false} />
          <h2 id={titleId} className="text-xl font-semibold">
            Sign in to Antigravity on this {COMPUTER}
          </h2>
          <p className="text-sm text-muted-foreground">
            Sign in with Google in your browser, then paste the code Google shows. This login runs{" "}
            <strong className="font-semibold text-foreground">Local threads only</strong>.{" "}
            <strong className="font-semibold text-foreground">Cloud threads</strong> sign in separately.
          </p>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive-text">
            {error}
          </p>
        ) : null}
        <div className="space-y-3">
          <input
            ref={input}
            autoFocus
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label="Google sign-in code"
            placeholder={attempt ? "Paste the Google code" : error ? "Sign-in ended" : "Opening Google sign-in…"}
            value={code}
            disabled={busy || !attempt}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              event.stopPropagation();
              submit();
            }}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          {attempt || busy ? (
            <Button type="button" className="w-full" disabled={busy || !code.trim()} onClick={submit}>
              {busy ? "Connecting…" : "Connect"}
            </Button>
          ) : error ? (
            <Button type="button" className="w-full" onClick={again}>
              Start sign-in again
            </Button>
          ) : null}
          {attempt ? (
            <Button type="button" variant="outline" className="w-full" onClick={() => openUrlInExternalBrowser(attempt.url)}>
              Open Google
            </Button>
          ) : null}
          <Button type="button" variant="ghost" className="w-full" onClick={cancel}>
            Cancel
          </Button>
        </div>
      </div>
    </PersistentResponsiveDrawerShell>
  );
}

export function ProviderLoginButton({
  className,
  command,
  displayName,
  hostId,
  onDone,
}: {
  className?: string;
  command: string;
  displayName: string;
  hostId: string;
  onDone: () => void;
}) {
  const login = useProviderLogin(hostId, onDone);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className={className}
        aria-label={`Log in to ${displayName}`}
        disabled={login.starting}
        onClick={() => login.start(command, displayName)}
      >
        {login.starting ? "Starting…" : "Log in"}
      </Button>
      {login.drawer}
    </>
  );
}

/** Plugins ask for a sign-in with `cloudroom:provider-login` (detail: providerId, hostId, onDone), like the
 *  Usage popup's "sign in". It runs that machine's own login command here, the same as the model picker's. */
export const PROVIDER_LOGIN_EVENT = "cloudroom:provider-login";
type ProviderLoginRequest = { providerId: string; hostId: string; onDone?: () => void };

export function ProviderLoginListener() {
  const queryClient = useQueryClient();
  const request = useRef<ProviderLoginRequest | null>(null);
  const login = useProviderLogin(null, () => {
    const done = request.current;
    if (done === null) return;
    void restartProviderModels(queryClient, done.providerId, { hostId: done.hostId }).catch(() => undefined);
    done.onDone?.();
  });
  const start = useRef(login.start);
  start.current = login.start;
  useEffect(() => {
    const onRequest = (event: Event) => {
      const next = (event as CustomEvent<ProviderLoginRequest>).detail;
      sdk.system.providerStates({ hostId: next.hostId }).then(
        ({ providers }) => {
          const state = providers.find((provider) => provider.providerId === next.providerId);
          if (!state?.loginCommand) {
            appToast.error("Couldn't find how to sign in to this agent. Try Settings → Agents.");
            return;
          }
          request.current = next;
          start.current(state.loginCommand, state.displayName, next.hostId);
        },
        () => appToast.error("Couldn't start the login. Try again."),
      );
    };
    window.addEventListener(PROVIDER_LOGIN_EVENT, onRequest);
    return () => window.removeEventListener(PROVIDER_LOGIN_EVENT, onRequest);
  }, []);
  return login.drawer;
}
