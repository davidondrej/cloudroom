import { Button } from "@cloudroom/shared-ui/button";
import { openChildSignIn } from "@/components/CodexConnectionPanel";
import { useThread } from "@/hooks/queries/thread-queries";
import { sdk } from "@/lib/sdk";

/** A child that failed because its harness login broke. `signIn` is the login the error text names, when it names
 *  one; `notStarted` marks a child whose cloud start was refused, so it can be retried as is. */
export interface ChildLoginFailure { signIn: SignIn | null; notStarted: boolean }
type SignIn = "codex" | "cursor";

// Core's spawn refusals (core/src/session/mod.rs) and the app's cloud-start rejections (server cloudroom/client.ts).
const SIGN_IN: ReadonlyArray<readonly [SignIn, RegExp]> = [
  ["codex", /connect Codex before starting cloud work|Connect your ChatGPT subscription/i],
  ["cursor", /connect Cursor before starting cloud work|Connect your Cursor account/i],
];
const EXPIRED = /connect Claude Code before starting cloud work|Connect your Claude subscription|refresh_token_reused|OAuth refresh failed|token refresh failed|\(401\)|401 Unauthorized|(?:sign|log)(?:ging)? in again/i;
// The app's notice for a child whose cloud start was rejected ends with this (server cloudroom/commands.ts).
const NOT_STARTED = /It did not start\.$/;

export function childLoginFailure(cause: string): ChildLoginFailure | null {
  const match = SIGN_IN.find(([, pattern]) => pattern.test(cause));
  if (!match && !EXPIRED.test(cause)) return null;
  return { signIn: match?.[0] ?? null, notStarted: NOT_STARTED.test(cause.trim()) };
}

/** The child's own harness decides the login; the error text decides only while the thread is unknown. Pi, Claude,
 *  and the rest keep their logins where only the user can fix them. */
function signInFor(providerId: string | undefined, guess: SignIn | null): SignIn | null {
  if (providerId === undefined) return guess;
  return providerId === "codex" ? "codex" : providerId === "acp-cursor" ? "cursor" : null;
}

const NAMES = { codex: ["Codex", "ChatGPT"], cursor: ["Cursor", "Cursor"] } as const;

/** Design 1 ("fix row"): one plain sentence and one button under a child that failed on a login. A child that never
 *  started is retried as is; any other is rerun by the parent after sign-in. */
export function ChildLoginFix({ failure, childThreadId, childTitle, parentThreadId }: { failure: ChildLoginFailure; childThreadId: string | null; childTitle: string | null; parentThreadId?: string }) {
  const child = useThread(childThreadId ?? "", { enabled: childThreadId !== null });
  const signIn = signInFor(child.data?.providerId, failure.signIn);
  const label = childTitle ? `"${childTitle}"${childThreadId ? ` (${childThreadId})` : ""}` : (childThreadId ?? "the failed task");
  const startSignIn = () => {
    if (!signIn) return;
    if (failure.notStarted && childThreadId) openChildSignIn(signIn, { child: childThreadId });
    else if (parentThreadId) openChildSignIn(signIn, { parent: parentThreadId, label });
  };
  const useClaude = () => {
    if (parentThreadId) void sdk.threads.send({ threadId: parentThreadId, mode: "auto", input: [{ type: "text", text: `Run ${label} with Claude Code instead, same prompt.`, mentions: [] }] });
  };
  return (
    <div className="space-y-2 pl-2 text-sm leading-relaxed">
      <p className="text-foreground">
        {signIn
          ? `Your ${NAMES[signIn][1]} login in Cloud is missing or expired, so ${NAMES[signIn][0]} couldn't run.`
          : "This agent's login expired or was rejected. Sign in to it again, then retry."}
      </p>
      <div className="flex items-center gap-2">
        {signIn ? <Button size="sm" onClick={startSignIn}>Sign in to {NAMES[signIn][1]}</Button> : null}
        {parentThreadId ? <Button size="sm" variant="ghost" className={signIn ? undefined : "-ml-3"} onClick={useClaude}>Run with Claude instead</Button> : null}
      </div>
      {signIn ? <p className="text-xs text-muted-foreground">The task restarts on its own after you sign in.</p> : null}
    </div>
  );
}
