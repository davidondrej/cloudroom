import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@cloudroom/shared-ui/button";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { Icon } from "@cloudroom/shared-ui/icon";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@cloudroom/shared-ui/popover";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { CopyableInlineLabel } from "@/components/ui/copy-button";
import { useRefreshOnClaudeConnect } from "./ClaudeConnection";

export const ANTIGRAVITY_PROVIDER_ID = "antigravity";

/** The machine Antigravity signs in on; the primary one when neither is given. */
export interface AntigravityConnectionTarget {
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
        url.origin === "https://accounts.google.com"
      );
    } catch {
      return false;
    }
  }, "Unexpected Google sign-in URL.");
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
  host_id: z.string().optional(),
});
type Status = z.infer<typeof schema>;
type Action = {
  action: "login" | "cancel" | "complete" | "logout";
  requestId?: string;
  code?: string;
};

export const antigravityConnectionQueryKey = [
  "antigravity-connection",
] as const;

/** Google sign-in for the Antigravity CLI on one machine, run by the Antigravity plugin as `agy acp --login`. */
function request(
  target: AntigravityConnectionTarget,
  input?: Action,
  signal?: AbortSignal,
): Promise<Status> {
  return sdk.plugins.callRpc({
    pluginId: "provider-antigravity",
    method: "antigravityAccount",
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

export function signOutOfAntigravity(target: AntigravityConnectionTarget = {}) {
  return request(target, { action: "logout" });
}

export function useAntigravityConnection(
  target: AntigravityConnectionTarget = {},
  enabled = true,
) {
  return useQuery({
    queryKey: [
      ...antigravityConnectionQueryKey,
      target.environmentId ?? target.hostId ?? "primary",
    ],
    queryFn: ({ signal }) => request(target, undefined, signal),
    enabled,
    retry: false,
    staleTime: 30_000,
    refetchInterval: (query) =>
      query.state.data?.state === "waiting" ? 1500 : 60_000,
  });
}

export function AntigravityConnectionButton({
  hostId,
  environmentId,
  className,
  text,
  onConnected,
}: AntigravityConnectionTarget & {
  className?: string;
  text?: string;
  onConnected?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const auth = useAntigravityConnection({ hostId, environmentId });
  const connected = useRefreshOnClaudeConnect(
    auth.data?.state === "connected",
    onConnected,
  );
  if (auth.isPending || connected) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn("h-7 px-2.5 text-xs", className)}
          aria-label="Connect Antigravity"
        >
          {text ?? (auth.data?.state === "waiting" ? "Finish" : "Connect")}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={6}
        mobileTitle="Connect Antigravity"
        className="w-72 p-3"
      >
        <AntigravityConnectionPanel
          target={{ hostId, environmentId }}
          onClose={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

/** For a message that waits on sign-in: the sign-in, then Continue once it is done. */
export function AntigravitySignIn({
  target,
  onContinue,
  continuing,
}: {
  target: AntigravityConnectionTarget;
  onContinue?: () => void;
  continuing: boolean;
}) {
  const auth = useAntigravityConnection(target);
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
        <span>Antigravity is connected.</span>
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
    <AntigravityConnectionPanel
      target={target}
      heading={
        <div>
          <p className="text-sm font-medium">
            Sign in to Antigravity to continue
          </p>
          <p className="text-muted-foreground">Your message is saved.</p>
        </div>
      }
    />
  );
}

export function AntigravityConnectionPanel({
  target,
  onClose,
  heading,
}: {
  target: AntigravityConnectionTarget;
  onClose?: () => void;
  heading?: ReactNode;
}) {
  const [code, setCode] = useState("");
  const client = useQueryClient();
  const auth = useAntigravityConnection(target);
  const action = useMutation({
    mutationFn: async (kind: "login" | "cancel" | "complete") => {
      const codeInput = code.trim();
      setCode("");
      const requestId =
        kind === "login" ? crypto.randomUUID() : auth.data?.login_id;
      if (!requestId) throw new Error("Sign-in expired. Start again.");
      if (kind === "complete" && !codeInput)
        throw new Error("Paste the code from Google's page.");
      const result = await request(target, {
        action: kind,
        requestId,
        ...(kind === "complete" ? { code: codeInput } : {}),
      });
      if (kind === "login" && result.verification_url)
        openUrlInExternalBrowser(result.verification_url);
      if (result.state === "error")
        throw new Error(result.message ?? "Antigravity sign-in failed.");
      return result;
    },
    meta: { showErrorToast: false },
    onSettled: () =>
      client.invalidateQueries({ queryKey: antigravityConnectionQueryKey }),
  });
  const state = auth.data?.state;
  const error = (auth.error?.message ?? action.error?.message)?.replace(
    /^HTTP \d+: /,
    "",
  );
  const link = auth.data?.verification_url;
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        {heading ?? <p className="text-sm font-medium">Connect Antigravity</p>}
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
      {auth.data?.message && state !== "error" && (
        <p role="status" className="text-muted-foreground">
          {auth.data.message}
        </p>
      )}
      {state === "waiting" ? (
        <>
          <p className="text-muted-foreground">
            {link
              ? "Sign in with Google in your browser, then paste the code it shows."
              : "Getting the sign-in link…"}
          </p>
          {link && (
            <div className="space-y-0.5">
              <p className="text-muted-foreground">
                Browser didn't open? Copy this link:
              </p>
              <div className="rounded-md border border-input px-2 py-1">
                <CopyableInlineLabel
                  text={link}
                  label="Copy sign-in link"
                  successMessage="Sign-in link copied."
                />
              </div>
            </div>
          )}
          {link && (
            <form
              className="flex gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                action.mutate("complete");
              }}
            >
              <input
                type="password"
                maxLength={4096}
                autoComplete="off"
                spellCheck={false}
                placeholder="Code from Google"
                aria-label="Google sign-in code"
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
              disabled={!link}
              onClick={() => {
                if (link) openUrlInExternalBrowser(link);
              }}
            >
              Open sign-in page
            </Button>
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
        <Button
          size="sm"
          className="h-7 w-full text-xs"
          disabled={action.isPending}
          onClick={() => action.mutate("login")}
        >
          {action.isPending ? "Opening sign-in…" : "Sign in with Google"}
        </Button>
      )}
    </div>
  );
}
