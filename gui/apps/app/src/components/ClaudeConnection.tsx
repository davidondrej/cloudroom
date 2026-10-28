import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@cloudroom/shared-ui/button";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@cloudroom/shared-ui/popover";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { ClaudeApiKeyForm } from "./ClaudeApiKeyForm";

export interface ClaudeConnectionTarget {
  target: "local" | "cloud";
  hostId?: string | null;
  environmentId?: string | null;
}
const signInUrl = z
  .string()
  .max(8192)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        !url.username &&
        !url.password &&
        [
          "https://claude.ai",
          "https://claude.com",
          "https://platform.claude.com",
        ].includes(url.origin) &&
        ["/oauth/authorize", "/cai/oauth/authorize"].includes(url.pathname)
      );
    } catch {
      return false;
    }
  }, "Unexpected Claude sign-in URL.");
const schema = z.object({
  state: z.enum([
    "missing",
    "waiting",
    "connected",
    "unavailable",
    "error",
    "expired",
  ]),
  message: z.string().nullable(),
  login_id: z.string().nullable(),
  verification_url: signInUrl.nullable(),
  manual_url: signInUrl.nullable().optional(),
});
type Status = z.infer<typeof schema>;
const returnsToMac = (url: string) => new URL(url).searchParams.get("redirect_uri")?.startsWith("http://localhost") === true;
type Action = {
  action?: "login" | "cancel" | "complete" | "setup-token";
  requestId?: string;
  code?: string;
  state?: string;
};

async function request(
  target: ClaudeConnectionTarget,
  input?: Action,
  signal?: AbortSignal,
): Promise<Status> {
  if (target.target === "cloud")
    return schema.parse(await sdk.cloudroom.claudeAuth(input, signal));
  return sdk.plugins.callRpc({
    pluginId: "provider-claude-code",
    method: "claudeAccount",
    input: {
      ...(target.hostId ? { hostId: target.hostId } : {}),
      ...(target.environmentId ? { environmentId: target.environmentId } : {}),
      action: input?.action ?? "status",
      ...input,
    },
    outputSchema: schema,
    signal,
  });
}
export function useClaudeConnection(
  target: ClaudeConnectionTarget,
  enabled = true,
) {
  const account = useCloudroomAccount();
  return useQuery({
    queryKey: [
      "claude-connection",
      target.target,
      target.environmentId ?? target.hostId ?? "primary",
      target.target === "cloud" ? account.data?.account?.id : null,
    ],
    queryFn: ({ signal }) => request(target, undefined, signal),
    enabled:
      enabled && (target.target === "local" || account.data?.ready === true),
    retry: false,
    staleTime: 30_000,
    refetchInterval: (query) =>
      query.state.data?.state === "waiting" ? 1500 : 60_000,
  });
}

export function ClaudeConnectionButton({
  target,
  hostId,
  environmentId,
  presentation = "footer",
  className,
  text,
  onConnected,
}: ClaudeConnectionTarget & {
  presentation?: "settings" | "footer" | "inline";
  className?: string;
  text?: string;
  onConnected?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const auth = useClaudeConnection({ target, hostId, environmentId });
  const connected = auth.data?.state === "connected";
  useEffect(() => {
    if (!connected) return;
    void client.invalidateQueries({ queryKey: ["systemExecutionOptions"] });
    onConnected?.();
  }, [connected, client, onConnected]);
  if (auth.isPending || connected) return null;
  const label =
    auth.isError || auth.data?.state === "unavailable"
      ? "Check Claude connection"
      : auth.data?.state === "waiting"
        ? "Finish connecting Claude"
        : "Connect Claude";
  const popover = (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={presentation === "settings" ? "default" : presentation === "inline" ? "outline" : "ghost"}
          size={presentation === "settings" ? "default" : "sm"}
          className={cn(
            presentation === "footer"
              ? "h-7 text-xs text-muted-foreground hover:text-foreground"
              : presentation === "inline"
                ? "h-7 px-2.5 text-xs"
                : "shrink-0",
            className,
          )}
          aria-label={`${label} · ${target === "cloud" ? "Cloud" : "Local"}`}
        >
          {text ?? (presentation === "inline" ? (auth.data?.state === "waiting" ? "Finish" : "Connect") : label)}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={6}
        mobileTitle="Connect Claude"
        className="w-72 p-3"
      >
        <ClaudeConnectionPanel
          target={{ target, hostId, environmentId }}
          onClose={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
  if (presentation === "settings")
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4">
        <div>
          <p className="text-sm font-medium">
            Claude Code ·{" "}
            {target === "cloud" ? "Cloud" : "Local"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Use your existing Claude subscription.
          </p>
        </div>
        {popover}
      </div>
    );
  return popover;
}

export function ClaudeSignIn({
  target,
  onContinue,
  continuing,
}: {
  target: ClaudeConnectionTarget;
  onContinue?: () => void;
  continuing: boolean;
}) {
  const auth = useClaudeConnection(target);
  const connected = auth.data?.state === "connected";
  const sawSignedOut = useRef(false);
  useEffect(() => {
    if (auth.data && !connected) sawSignedOut.current = true;
    else if (connected && sawSignedOut.current) {
      sawSignedOut.current = false;
      onContinue?.();
    }
  }, [auth.data, connected, onContinue]);
  if (connected && !onContinue) return null;
  if (connected)
    return (
      <div className="flex items-center justify-between gap-2 text-sm">
        <span>Claude is connected.</span>
        <Button
          type="button"
          size="sm"
          className="h-7 text-xs"
          disabled={continuing}
          onClick={onContinue}
        >
          {continuing ? "Starting…" : "Continue"}
        </Button>
      </div>
    );
  return (
    <ClaudeConnectionPanel
      target={target}
      heading={
        <div>
          <p className="text-sm font-medium">Sign in to Claude to continue</p>
          <p className="text-muted-foreground">Your message is saved.</p>
        </div>
      }
    />
  );
}

function ClaudeConnectionPanel({
  target,
  onClose,
  heading,
}: {
  target: ClaudeConnectionTarget;
  onClose?: () => void;
  heading?: ReactNode;
}) {
  const [code, setCode] = useState("");
  const [manual, setManual] = useState(false);
  const client = useQueryClient();
  const auth = useClaudeConnection(target);
  const action = useMutation({
    mutationFn: async (kind: "login" | "cancel" | "complete") => {
      const codeInput = code.trim();
      setCode("");
      const requestId =
        kind === "login" ? crypto.randomUUID() : auth.data?.login_id;
      if (!requestId) throw new Error("Sign-in expired. Start again.");
      const openSignIn = (result: Status) => {
        if (result.state === "error") throw new Error(result.message ?? "Claude sign-in failed.");
        if (result.state === "waiting" && result.verification_url) openUrlInExternalBrowser(result.verification_url);
        return result;
      };
      // Cloud first tries a one-year token made on this Mac (ADR 0121); the VM code flow is the fallback.
      // Sandboxes have no fallback, so its error must not hide why the token failed.
      let tokenError: unknown = null;
      if (kind === "login" && target.target === "cloud") {
        const result = await request(target, {
          action: "setup-token",
          requestId,
        }).catch((error: unknown) => {
          tokenError = error;
          return null;
        });
        if (result && result.state !== "error") return openSignIn(result);
        if (result) tokenError = new Error(result.message ?? "Claude sign-in failed.");
      }
      let input: Action = { action: kind, requestId };
      if (kind === "complete") {
        const [authorizationCode, state] = codeInput.split("#");
        const expected = new URL(
          (manual ? auth.data?.manual_url : auth.data?.verification_url) ?? "",
        ).searchParams.get("state");
        if (
          !authorizationCode ||
          !expected ||
          (state && state !== expected) ||
          codeInput.startsWith("sk-ant-")
        )
          throw new Error(
            "Paste the one-time code from this sign-in, not a token or API key.",
          );
        input = { ...input, code: authorizationCode, state: expected };
      }
      const result = await request(target, input).catch((error: unknown) => {
        throw tokenError ?? error;
      });
      if (kind === "login" && result.verification_url) {
        setManual(false);
        openUrlInExternalBrowser(result.verification_url);
      }
      if (
        result.state === "error" ||
        (kind === "complete" && result.state === "waiting" && result.message)
      )
        throw new Error(result.message ?? "Claude sign-in failed.");
      return result;
    },
    meta: { showErrorToast: false },
    onSettled: () =>
      client.invalidateQueries({ queryKey: ["claude-connection"] }),
  });
  const state = auth.data?.state;
  const error = (auth.error?.message ?? action.error?.message)?.replace(/^HTTP \d+: /, "");
  const signInUrl = manual ? auth.data?.manual_url : auth.data?.verification_url;
  const pasteCode = target.target === "cloud" ? Boolean(signInUrl) && !returnsToMac(signInUrl!) : manual;
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        {heading ?? (
          <p className="text-sm font-medium">
            Connect Claude{" "}
            <span className="font-normal text-muted-foreground">
              · {target.target === "cloud" ? "Cloud" : "Local"}
            </span>
          </p>
        )}
        {onClose && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close"
            className="size-6 shrink-0"
            onClick={onClose}
          >
            <Icon name="X" className="size-3.5" />
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {auth.data?.message && (
        <p role="status" className="text-muted-foreground">
          {auth.data.message}
        </p>
      )}
      {state === "waiting" ? (
        <>
          <p className="text-muted-foreground">
            {pasteCode
              ? "Approve in your browser, then paste the one-time code."
              : "Approve in your browser. This updates automatically."}
          </p>
          {pasteCode && (
            <form
              className="flex gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                action.mutate("complete");
              }}
            >
              <input
                type="password"
                maxLength={2048}
                autoComplete="off"
                spellCheck={false}
                placeholder="One-time code"
                aria-label="One-time sign-in code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1"
              />
              <Button
                type="submit"
                size="sm"
                className="h-7 text-xs"
                disabled={!code.trim() || action.isPending}
              >
                {action.isPending ? "…" : "Connect"}
              </Button>
            </form>
          )}
          <div className="flex flex-wrap gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={!signInUrl}
              onClick={() => {
                if (signInUrl) openUrlInExternalBrowser(signInUrl);
              }}
            >
              Open sign-in page
            </Button>
            {target.target === "local" && !manual && auth.data?.manual_url && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground"
                onClick={() => {
                  setManual(true);
                  openUrlInExternalBrowser(auth.data!.manual_url!);
                }}
              >
                Use a code
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground"
              disabled={action.isPending}
              onClick={() => action.mutate("cancel")}
            >
              Cancel
            </Button>
          </div>
        </>
      ) : auth.isError || state === "unavailable" ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 w-full text-xs"
          disabled={auth.isFetching}
          onClick={() => void auth.refetch()}
        >
          Check again
        </Button>
      ) : (
        <>
          <Button
            size="sm"
            className="h-7 w-full text-xs"
            disabled={action.isPending}
            onClick={() => action.mutate("login")}
          >
            {action.isPending ? "Opening sign-in…" : "Sign in with Claude"}
          </Button>
          {target.target === "cloud" && <ClaudeApiKeyForm />}
        </>
      )}
    </div>
  );
}
