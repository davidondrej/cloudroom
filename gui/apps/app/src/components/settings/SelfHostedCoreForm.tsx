import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import { Input } from "@cloudroom/shared-ui/input";
import { sdk } from "@/lib/sdk";

/** Connects a core the user hosts, by URL and token, without a Cloudroom account (core docs/setup.md). */
export function SelfHostedCoreForm({ connected, ready, error }: { connected: boolean; ready: boolean; error: string | null }) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const change = useMutation({
    mutationFn: (action: "connect" | "disconnect") => action === "connect" ? sdk.cloudroom.connect({ url: url.trim(), token: token.trim() }) : sdk.cloudroom.logout(),
    onSuccess: () => {
      setToken("");
      void queryClient.invalidateQueries({ queryKey: ["cloudroom-account"] });
      void queryClient.invalidateQueries({ queryKey: ["cloudroom-connection"] });
    },
  });
  const failure = change.error instanceof Error ? change.error.message : null;
  if (connected) {
    return <div className="space-y-2 border-t pt-3">
      <p role="status">{ready ? "Connected to your own Core." : error ?? "Your Core is not reachable right now."}</p>
      {failure && <p role="alert">{failure}</p>}
      <Button variant="outline" disabled={change.isPending} onClick={() => change.mutate("disconnect")}>Disconnect</Button>
    </div>;
  }
  return <form className="space-y-2 border-t pt-3" onSubmit={(event) => { event.preventDefault(); change.mutate("connect"); }}>
    <p>Or connect your own Core</p>
    <p className="text-xs text-muted-foreground">Use its HTTPS address and the API token from /etc/cloudroom/core.env. No account needed.</p>
    <Input aria-label="Core URL" placeholder="https://my-core.example.ts.net" value={url} onChange={(event) => setUrl(event.target.value)} autoComplete="off" spellCheck={false} />
    <Input aria-label="Core API token" type="password" placeholder="API token" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" />
    {failure && <p role="alert">{failure}</p>}
    <Button type="submit" variant="outline" disabled={change.isPending || !url.trim() || !token.trim()}>{change.isPending ? "Connecting…" : "Connect"}</Button>
  </form>;
}
