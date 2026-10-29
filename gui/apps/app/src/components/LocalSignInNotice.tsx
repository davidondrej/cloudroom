import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@cloudroom/shared-ui/button";
import { ClaudeSignIn, useClaudeConnection } from "@/components/ClaudeConnection";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { sdk } from "@/lib/sdk";

const loginCommands: Record<string, string> = {
  "acp-cursor": "cursor-agent login",
};

async function signInMacCodex(): Promise<void> {
  const call = async (method: "GET" | "POST") => {
    const response = await fetch("/api/v1/cloudroom/mac/codex-login", method === "POST" ? { method, headers: { "content-type": "application/json" }, body: "{}" } : {});
    if (!response.ok) throw new Error("Codex sign-in could not start.");
    return (await response.json()) as { state: string; message?: string };
  };
  let status = await call("POST");
  while (status.state === "waiting") {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    status = await call("GET");
  }
  if (status.state === "error") throw new Error(status.message ?? "Codex sign-in failed.");
}

function CodexSignIn({ onSignedIn, continuing }: { onSignedIn: () => void; continuing: boolean }) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState("");
  const signIn = () => {
    setWaiting(true);
    setError("");
    signInMacCodex().then(onSignedIn, (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setWaiting(false));
  };
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Sign in to Codex to continue</p>
          <p className="text-muted-foreground">{waiting ? "Finish signing in in your browser." : "Your login expired. Your message is saved."}</p>
        </div>
        <Button type="button" size="sm" className="h-7 shrink-0 text-xs" disabled={waiting || continuing} onClick={signIn}>
          {continuing ? "Starting…" : waiting ? "Waiting…" : "Sign in"}
        </Button>
      </div>
      {error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
    </>
  );
}

export function LocalSignInNotice({
  threadId,
  providerId,
  hostId,
  environmentId,
  authFailed,
  started,
}: {
  threadId: string;
  providerId: string;
  hostId?: string | null;
  environmentId?: string | null;
  authFailed: boolean;
  started: boolean;
}) {
  const claude = providerId === "claude-code";
  const target = { target: "local" as const, hostId, environmentId };
  // Once a thread has run, a real expiry shows up as a failed turn (authFailed).
  // `claude auth status` can say signed out while sessions still work.
  const auth = useClaudeConnection(target, claude && !started);
  const retry = useMutation({
    mutationFn: () => sdk.threads.retry({ threadId, reason: "Signed in again" }),
  });
  const signedOut = claude && !started && auth.data?.state === "missing";
  if (!authFailed && !signedOut) return null;
  const command = loginCommands[providerId];
  return (
    <PromptStackCard ariaLabel="Sign in" className="w-full max-w-sm justify-self-center p-3 text-xs">
      {claude ? (
        <ClaudeSignIn
          target={target}
          onContinue={authFailed ? () => retry.mutate() : undefined}
          continuing={retry.isPending}
        />
      ) : providerId === "codex" ? (
        <CodexSignIn onSignedIn={() => retry.mutate()} continuing={retry.isPending} />
      ) : (
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">Sign in to continue</p>
            <p className="text-muted-foreground">
              {command ? <>Run <code>{command}</code> in your terminal, then retry.</> : "Sign in to this provider, then retry."}
            </p>
          </div>
          <Button type="button" size="sm" className="h-7 text-xs" disabled={retry.isPending} onClick={() => retry.mutate()}>
            {retry.isPending ? "Retrying…" : "Retry"}
          </Button>
        </div>
      )}
      {retry.error && <p role="alert" className="mt-2 text-destructive">{retry.error.message}</p>}
    </PromptStackCard>
  );
}
