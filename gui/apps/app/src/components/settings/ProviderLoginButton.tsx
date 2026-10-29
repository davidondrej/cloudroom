import { useEffect, useId, useRef, useState } from "react";
import type { TerminalSession } from "@cloudroom/server-contract";
import { Button } from "@cloudroom/shared-ui/button";
import { PersistentResponsiveDrawerShell } from "@cloudroom/shared-ui/responsive-overlay";
import { appToast } from "@/components/ui/app-toast";
import { ThreadTerminalView } from "@/components/thread/terminal/ThreadTerminalView";
import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
} from "@/components/thread/terminal/useThreadTerminalController";
import { sdk } from "@/lib/sdk";

function closeTerminal(terminalId: string | null): void {
  if (terminalId === null) return;
  void sdk.terminals
    .close({ terminalId, mode: "force" })
    .catch(() => undefined);
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
  const titleId = useId();
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [starting, setStarting] = useState(false);
  const terminalId = useRef<string | null>(null);
  useEffect(() => () => closeTerminal(terminalId.current), []);

  const start = () => {
    setStarting(true);
    sdk.terminals
      .create({
        scope: { kind: "host_path", hostId, cwd: null },
        cols: DEFAULT_TERMINAL_COLS,
        rows: DEFAULT_TERMINAL_ROWS,
        start: { mode: "command", command },
        title: `Log in to ${displayName}`,
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
    onDone();
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className={className}
        aria-label={`Log in to ${displayName}`}
        disabled={starting}
        onClick={start}
      >
        {starting ? "Starting…" : "Log in"}
      </Button>
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
                  if (next.status === "exited") onDone();
                }}
              />
            ) : null}
          </div>
          <Button className="w-full" onClick={close}>
            Done
          </Button>
        </div>
      </PersistentResponsiveDrawerShell>
    </>
  );
}
