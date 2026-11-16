import { useEffect, useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TerminalSession } from "@cloudroom/server-contract";
import { Button } from "@cloudroom/shared-ui/button";
import { PersistentResponsiveDrawerShell } from "@cloudroom/shared-ui/responsive-overlay";
import { restartProviderModels } from "@/components/pickers/ModelUnavailable";
import { appToast } from "@/components/ui/app-toast";
import { ThreadTerminalView } from "@/components/thread/terminal/ThreadTerminalView";
import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
} from "@/components/thread/terminal/useThreadTerminalController";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { sdk } from "@/lib/sdk";

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

/** Runs a provider's login command in a terminal drawer. `start` can be called from any trigger. */
export function useProviderLogin(hostId: string | null, onDone: () => void) {
  const titleId = useId();
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [starting, setStarting] = useState(false);
  const terminalId = useRef<string | null>(null);
  useEffect(() => () => closeTerminal(terminalId.current), []);

  const start = (command: string, name: string, onHost = hostId) => {
    if (onHost === null) {
      appToast.error(`Couldn't find the machine to log in to ${name}. Try again in a moment.`);
      return;
    }
    setDisplayName(name);
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

  const drawer = (
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
