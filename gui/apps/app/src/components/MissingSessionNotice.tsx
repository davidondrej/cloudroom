import { useMutation } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import type { Thread } from "@cloudroom/domain";
import type { TimelineRow } from "@cloudroom/server-contract";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { sdk } from "@/lib/sdk";

const MISSING_SESSION = /\bno rollout found for thread id\b/i;

function latestErrorIsMissingSession(rows: readonly TimelineRow[]): boolean {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind === "turn")
      return latestErrorIsMissingSession(row.children ?? []);
    if (row?.kind === "system" && row.systemKind === "error") {
      // A fork or import that can't open its source fails in thread.start, with no failed turn to start fresh from.
      return (
        row.title !== "Command thread.start failed" &&
        MISSING_SESSION.test(row.detail ?? row.title)
      );
    }
  }
  return false;
}

/** Whether Codex runs the failed thread and its latest failure is a session Codex can no longer find (#335). */
export function hasMissingSession(
  thread: Pick<Thread, "providerId" | "status">,
  rows: readonly TimelineRow[],
): boolean {
  return (
    thread.status === "error" &&
    thread.providerId === "codex" &&
    latestErrorIsMissingSession(rows)
  );
}

/** A real conversation whose saved session is gone continues only when the user asks: it loses tool output. */
export function MissingSessionNotice({ threadId }: { threadId: string }) {
  const startFresh = useMutation({
    mutationFn: () =>
      sdk.threads.retry({
        threadId,
        reason: "Start fresh",
        freshSession: true,
      }),
  });
  return (
    <PromptStackCard
      ariaLabel="Start fresh"
      className="w-full max-w-md justify-self-center p-3 text-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Codex lost this conversation</p>
          <p className="text-muted-foreground">
            A new session gets the messages so far, not earlier tool output.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          className="h-7 shrink-0 text-xs"
          disabled={startFresh.isPending}
          onClick={() => startFresh.mutate()}
        >
          {startFresh.isPending ? "Starting…" : "Start fresh with the history"}
        </Button>
      </div>
      {startFresh.error && (
        <p role="alert" className="mt-2 text-destructive">
          {startFresh.error.message.replace(/^HTTP \d+: /, "")}
        </p>
      )}
    </PromptStackCard>
  );
}
