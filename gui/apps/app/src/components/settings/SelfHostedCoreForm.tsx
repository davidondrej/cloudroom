import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import { Input } from "@cloudroom/shared-ui/input";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { sdk } from "@/lib/sdk";

/** Connects a core the user hosts (or disconnects it, with null). Settings and first-run setup share it.
 *  `onConnected` runs here, not per call, so it still runs if the form unmounts first. */
export function useOwnCoreConnection(onConnected?: () => void) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    meta: { showErrorToast: false }, // Both forms show the error inline.
    mutationFn: (input: { url: string; token: string } | null) => {
      if (!input) return sdk.cloudroom.logout();
      const url = input.url.trim();
      // "my-core.example.ts.net" means https; a pasted `CLOUDROOM_TOKEN=…` line from core.env works too.
      return sdk.cloudroom.connect({ url: /^https?:\/\//i.test(url) ? url : `https://${url}`, token: input.token.trim().replace(/^CLOUDROOM_TOKEN=/, "") });
    },
    onSuccess: (_result, input) => {
      if (input) onConnected?.();
      void queryClient.invalidateQueries({ queryKey: ["cloudroom-account"] });
      void queryClient.invalidateQueries({ queryKey: ["cloudroom-connection"] });
    },
  });
  const failure = mutation.error ? getMutationErrorMessage({ error: mutation.error, fallbackMessage: "Couldn't connect to your Core. Try again." }) : null;
  return { ...mutation, failure };
}

/** Connects a core the user hosts, by URL and token, without a Cloudroom account (core docs/setup.md). */
export function SelfHostedCoreForm({ connected, ready, error }: { connected: boolean; ready: boolean; error: string | null }) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const change = useOwnCoreConnection(() => setToken(""));
  if (connected) {
    return <div className="space-y-2 border-t pt-3">
      <p role="status">{ready ? "Connected to your own Core." : error ?? "Your Core is not reachable right now."}</p>
      {change.failure && <p role="alert">{change.failure}</p>}
      <Button variant="outline" disabled={change.isPending} onClick={() => change.mutate(null)}>Disconnect</Button>
    </div>;
  }
  return <form className="space-y-2 border-t pt-3" onSubmit={(event) => { event.preventDefault(); change.mutate({ url, token }); }}>
    <p>Or connect your own Core</p>
    <p className="text-xs text-muted-foreground">Use its HTTPS address and the API token from /etc/cloudroom/core.env. No account needed.</p>
    <Input aria-label="Core URL" placeholder="https://my-core.example.ts.net" value={url} onChange={(event) => setUrl(event.target.value)} autoComplete="off" spellCheck={false} />
    <Input aria-label="Core API token" type="password" placeholder="API token" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" />
    {change.failure && <p role="alert">{change.failure}</p>}
    <Button type="submit" variant="outline" disabled={change.isPending || !url.trim() || !token.trim()}>{change.isPending ? "Connecting…" : "Connect"}</Button>
  </form>;
}
