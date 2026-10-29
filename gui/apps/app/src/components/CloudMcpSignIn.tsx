import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Icon } from "@cloudroom/shared-ui/icon";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

/** This Mac's MCP servers, with which cloud ones still need a sign-in. Shared with Settings → Cloud environment. */
export const MAC_MCP_KEY = ["cloudroom-mac-mcp"];
const WAIT_MS = 5 * 60_000;

/** One-time cloud sign-ins to MCP servers: opens the server's sign-in page, then checks every 2 s until the cloud has it. */
export function useMcpSignIn() {
  const [waiting, setWaiting] = useState<{ name: string; until: number } | null>(null);
  const start = useMutation({
    mutationFn: (name: string) => sdk.cloudroom.startMcpSignIn(name),
    onSuccess: ({ url }, name) => {
      openUrlInExternalBrowser(url);
      setWaiting({ name, until: Date.now() + WAIT_MS });
    },
  });
  const servers = useQuery({
    queryKey: MAC_MCP_KEY,
    queryFn: ({ signal }) => sdk.cloudroom.macMcpServers(signal),
    refetchInterval: waiting ? 2_000 : false,
    retry: false,
  });
  const signedIn = servers.data?.servers.some((server) => server.name === waiting?.name && server.signIn === "done");
  useEffect(() => {
    if (!waiting) return;
    if (signedIn) return setWaiting(null);
    const timer = setTimeout(() => setWaiting(null), waiting.until - Date.now());
    return () => clearTimeout(timer);
  }, [waiting, signedIn]);
  return {
    start: (name: string) => start.mutate(name),
    /** The server whose sign-in is open in the browser. Clicking again starts it over. */
    waitingFor: start.isPending ? start.variables : waiting?.name ?? null,
    error: start.error,
  };
}

/** Cloud threads: one quiet line while a cloud MCP server still needs its one-time sign-in. */
export function CloudMcpSignInNotice() {
  const servers = useQuery({
    queryKey: MAC_MCP_KEY,
    queryFn: ({ signal }) => sdk.cloudroom.macMcpServers(signal),
    staleTime: 60_000,
    retry: false,
  });
  const signIn = useMcpSignIn();
  const needed = (servers.data?.servers ?? []).filter((server) => server.signIn === "needed").map((server) => server.name);
  if (!needed.length) return null;
  const names = needed.length === 1 ? needed[0] : `${needed.slice(0, -1).join(", ")} and ${needed.at(-1)}`;
  const next = needed[0];
  return (
    <div className="flex w-full max-w-full items-center gap-1.5 px-2 text-xs text-subtle-foreground" aria-label="MCP sign-in">
      <Icon name="Lock" className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">
        <span className="font-mono">{names}</span> {needed.length === 1 ? "isn't" : "aren't"} signed in for the cloud ·
      </span>
      <button
        type="button"
        className="shrink-0 cursor-pointer text-foreground underline underline-offset-2 hover:text-foreground/80 disabled:cursor-wait"
        disabled={signIn.waitingFor === next}
        onClick={() => signIn.start(next)}
      >
        {signIn.waitingFor === next ? "Waiting for your browser…" : needed.length === 1 ? "Sign in" : `Sign in to ${next}`}
      </button>
      {signIn.error && <span role="alert" className="min-w-0 truncate text-destructive-text">{signIn.error.message}</span>}
    </div>
  );
}
