import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import { PersistentResponsiveDrawerShell } from "@cloudroom/shared-ui/responsive-overlay";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { BbHttpError, sdk } from "@/lib/sdk";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

const eventName = "cloudroom:connect-codex";
export function openCodexConnection(threadId?: string) {
  window.dispatchEvent(new CustomEvent(eventName, { detail: threadId ?? null }));
}

export function openCursorConnection(threadId?: string) {
  window.dispatchEvent(new CustomEvent("cloudroom:connect-cursor", { detail: threadId ?? null }));
}
export function openTeleportLogin(error: unknown, providerId: string): boolean {
  if (!(error instanceof BbHttpError) || error.code !== "teleport_login_required") return false;
  if (providerId === "acp-cursor") openCursorConnection();
  else if (providerId === "codex") openCodexConnection();
  else return false;
  return true;
}
export function useCloudLogin(provider: "codex" | "cursor") {
  const account = useCloudroomAccount();
  return useQuery({
    queryKey: [`cloudroom-${provider}-auth`, account.data?.account?.id],
    enabled: account.data?.ready === true,
    queryFn: ({ signal }) => provider === "cursor" ? sdk.cloudroom.cursorAuth(signal) : sdk.cloudroom.codexAuth(signal),
    retry: false,
    staleTime: 60_000,
  });
}
export function CodexConnectionPanel() { return <ConnectionPanel provider="codex" />; }
export function CursorConnectionPanel() { return <ConnectionPanel provider="cursor" />; }
function ConnectionPanel({ provider }: { provider: "codex" | "cursor" }) {
  const cursor = provider === "cursor";
  const name = cursor ? "Cursor" : "Codex";
  const events = cursor ? "cloudroom:connect-cursor" : eventName;
  const [apiKey, setApiKey] = useState("");
  const account = useCloudroomAccount();
  const queryClient = useQueryClient();
  const titleId = useId();
  const descriptionId = useId();
  const [open, setOpen] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const requestId = useRef<string | null>(null);
  const accountId = account.data?.account?.id;
  const queryKey = [`cloudroom-${provider}-auth`, accountId];
  const auth = useQuery({
    queryKey,
    enabled: Boolean(account.data?.ready && open),
    queryFn: ({ signal }) => cursor ? sdk.cloudroom.cursorAuth(signal) : sdk.cloudroom.codexAuth(signal),
    retry: false,
    // Fast only while a sign-in runs. Idle (missing) checks once a minute: each check costs database calls.
    refetchInterval: query => !open ? false : query.state.data?.state === "waiting" ? 1500 : query.state.data?.state === "missing" ? 60_000 : false,
  });
  useEffect(() => {
    const show = (event: Event) => {
      setThreadId((event as CustomEvent<string | null>).detail);
      setOpen(true);
      setCopied(false);
      setSignedIn(false);
    };
    window.addEventListener(events, show);
    return () => window.removeEventListener(events, show);
  }, [events]);
  const action = useMutation({
    mutationFn: async (kind: "login" | "cancel" | "continue" | "key") => {
      if (kind === "continue") {
        if (threadId) await sdk.cloudroom.retryStart(threadId);
        setOpen(false);
        setThreadId(null);
        await queryClient.invalidateQueries({ queryKey: ["cloudroom-thread"] });
        return;
      }
      if (kind === "cancel" && !auth.data?.login_id) return;
      requestId.current ??= crypto.randomUUID();
      const key = apiKey;
      setApiKey("");
      const result = cursor
        ? kind === "key" ? await sdk.cloudroom.cursorApiKey(requestId.current, key) : kind === "login" ? await sdk.cloudroom.cursorLogin(requestId.current) : await sdk.cloudroom.cancelCursorLogin(auth.data!.login_id!)
        : kind === "login" ? await sdk.cloudroom.codexLogin(requestId.current) : await sdk.cloudroom.cancelCodexLogin(auth.data!.login_id!);
      if (result.state === "error") throw new Error(result.message ?? `${name} sign-in failed`);
      setSignedIn(kind !== "cancel");
      queryClient.setQueryData(queryKey, result);
      if (result.state !== "waiting") requestId.current = null;
      // Without a device code, Codex is signing in on this Mac and has opened the browser itself.
      if (!cursor && kind === "login" && result.verification_url && result.user_code) openUrlInExternalBrowser(result.verification_url);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
  const state = auth.data?.state;
  const rejected = !cursor && Boolean(threadId) && !signedIn && state === "connected";
  const close = () => { setApiKey(""); setOpen(false); };
  if (!accountId || !account.data?.ready) return null;
  return <PersistentResponsiveDrawerShell
    open={open} onOpenChange={value => { if (!value) close(); }} labelledBy={titleId} describedBy={descriptionId}
    backdropClassName="bg-black/25 backdrop-blur-xs"
    contentClassName="inset-0 m-auto h-fit w-[calc(100%-2rem)] max-w-sm overflow-y-auto rounded-xl p-8 shadow-2xl data-[state=closed]:invisible [&>[data-persistent-drawer-handle]]:hidden"
  >
    <div className="space-y-5">
      <div className="space-y-2">
        <h2 id={titleId} className="text-xl font-semibold">Connect {name}</h2>
        <p id={descriptionId} className="text-sm text-muted-foreground">{cursor ? "Use your Cursor account on your cloud VM." : "Use your ChatGPT subscription on your cloud VM."}</p>
      </div>
      {(action.error || auth.error) && <p role="alert" className="text-sm text-destructive">{action.error?.message ?? auth.error?.message}</p>}
      {auth.isPending ? <p role="status">Checking cloud login…</p> : rejected ? <>
        <p role="status" className="text-sm text-muted-foreground">Codex in Cloud didn't accept your saved ChatGPT login. Sign in again to replace it.</p>
        <Button className="w-full" disabled={action.isPending} onClick={() => action.mutate("login")}>{action.isPending ? "Starting sign-in…" : "Sign in again"}</Button>
        <Button variant="outline" disabled={action.isPending} onClick={() => action.mutate("continue")}>Try again</Button>
      </> : state === "connected" ? <>
        <p role="status">Connected{auth.data?.email ? ` · ${auth.data.email}` : ""}</p>
        <Button className="w-full" disabled={action.isPending} onClick={() => action.mutate("continue")}>{threadId ? "Continue to task" : "Done"}</Button>
      </> : state === "waiting" ? <>
        <p role="status" className="text-sm">{cursor ? "Open Cursor’s sign-in page. Credentials will be saved on your cloud VM." : auth.data?.user_code ? "Enter this code on OpenAI’s sign-in page." : "Finish signing in to ChatGPT in your browser."}</p>
        {!cursor && auth.data?.user_code && <div className="flex items-center justify-between gap-3 border p-3">
          <code className="text-lg tracking-wider">{auth.data?.user_code}</code>
          <Button variant="outline" size="sm" onClick={() => void copyToClipboardWithToast(auth.data?.user_code ?? "", { successMessage: null, errorMessage: "Copy failed. Select the code and copy it manually." }).then(setCopied)}>{copied ? "Copied" : "Copy code"}</Button>
        </div>}
        <Button className="w-full" disabled={!auth.data?.verification_url} onClick={() => { if (auth.data?.verification_url) openUrlInExternalBrowser(auth.data.verification_url); }}>Open sign-in page</Button>
        <p className="text-sm text-muted-foreground">Waiting for sign-in. This panel updates automatically.</p>
        <Button variant="outline" disabled={action.isPending} onClick={() => action.mutate("cancel")}>Cancel sign-in</Button>
      </> : <>
        {auth.data?.message && <p role="status" className="text-sm text-muted-foreground">{auth.data.message}</p>}
        {(state !== "limited" || !cursor) && state !== "unavailable" && !auth.isError && <Button className="w-full" disabled={action.isPending} onClick={() => action.mutate("login")}>{action.isPending ? "Starting sign-in…" : cursor ? "Sign in with Cursor" : state === "limited" ? "Sign in with another account" : "Sign in with ChatGPT"}</Button>}
        {cursor && <details><summary className="cursor-pointer text-sm">Use a Cursor API key instead</summary><div className="mt-3 space-y-2">
          <label className="block text-sm">Cursor user API key<input type="password" autoComplete="off" value={apiKey} onChange={event => setApiKey(event.target.value)} className="mt-1 w-full rounded-md border bg-background px-3 py-2" /></label>
          <p className="text-xs text-muted-foreground">Sent securely to your VM. Not saved in this app or included in history.</p>
          <Button disabled={action.isPending || !apiKey.trim()} onClick={() => action.mutate("key")}>Connect with key</Button>
        </div></details>}
        {(auth.isError || state === "unavailable" || state === "limited") && <Button variant="outline" disabled={auth.isFetching} onClick={() => void auth.refetch()}>Check again</Button>}
      </>}
      {(state !== "connected" || rejected) && <Button variant="ghost" className="w-full" onClick={close}>Later</Button>}
    </div>
  </PersistentResponsiveDrawerShell>;
}
