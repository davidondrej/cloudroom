import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { installPercent } from "@cloudroom/domain/install-progress";
import { Button } from "@cloudroom/shared-ui/button";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@cloudroom/shared-ui/popover";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { sdk } from "@/lib/sdk";
import { localHostDaemonHostIdAtom } from "@/lib/system-config-atoms";
import { useAsyncAtomState } from "@/lib/use-async-atom-value";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { ClaudeApiKeyForm } from "./ClaudeApiKeyForm";
import { CopyableInlineLabel } from "@/components/ui/copy-button";

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
  installing_since: z.number().nullable().optional(),
  host_id: z.string().optional(),
});
type Status = z.infer<typeof schema>;
const returnsToMac = (url: string) => new URL(url).searchParams.get("redirect_uri")?.startsWith("http://localhost") === true;
/** True when Claude signs in on another machine than the one this browser runs on (added over SSH, or the app on a phone).
 *  Its automatic link returns to that machine's localhost, so those sign-ins use the one-time code, as Cloud does (#1510). */
function useSignsInElsewhere() {
  const here = useAsyncAtomState(localHostDaemonHostIdAtom, null);
  return (status?: Status) =>
    Boolean(status?.host_id) &&
    !here.isLoading &&
    status?.host_id !== here.data;
}
type Action = {
  action?: "login" | "cancel" | "complete" | "setup-token";
  force?: boolean;
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
/** Sign-ins whose link came after Connect returned (Claude Code was still installing or starting); opened once it arrives. */
const openWhenReady = new Set<string>();

/** `quiet`: for screens open all day, like the composer. One check, then again only after a sign-in or 5 minutes
 *  (db-load-budget: no polling every app makes all the time). `fresh`: bust the host's 15 s status cache after an auth failure. */
export function useClaudeConnection(
  target: ClaudeConnectionTarget,
  enabled = true,
  quiet = false,
  fresh = false,
) {
  const account = useCloudroomAccount();
  const query = useQuery({
    queryKey: [
      "claude-connection",
      target.target,
      // Cloud's login is per account, never per host: one cache for every Cloud caller.
      target.target === "cloud" ? "primary" : target.environmentId ?? target.hostId ?? "primary",
      target.target === "cloud" ? account.data?.account?.id : null,
    ],
    queryFn: ({ signal }) =>
      request(
        target,
        fresh && target.target === "local" ? { force: true } : undefined,
        signal,
      ),
    enabled:
      enabled && (target.target === "local" || account.data?.ready === true),
    retry: false,
    staleTime: fresh ? 0 : quiet ? 5 * 60_000 : 30_000,
    refetchOnWindowFocus: !quiet,
    refetchInterval: (query) =>
      query.state.data?.state === "waiting" ? 1500 : quiet ? false : 60_000,
  });
  const { state, login_id: loginId, verification_url: url } = query.data ?? {};
  useEffect(() => {
    if (state === "waiting" && loginId && url && openWhenReady.delete(loginId)) openUrlInExternalBrowser(url);
  }, [state, loginId, url]);
  return query;
}

export function ClaudeConnectionButton({
  target,
  hostId,
  environmentId,
  className,
  text,
  onConnected,
  quiet = false,
}: ClaudeConnectionTarget & {
  className?: string;
  text?: string;
  onConnected?: () => void;
  /** See useClaudeConnection. The open panel still checks on its own. */
  quiet?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const auth = useClaudeConnection({ target, hostId, environmentId }, true, quiet);
  const connected = useRefreshOnClaudeConnect(auth.data?.state === "connected", onConnected);
  if (auth.isPending || connected) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn("h-7 px-2.5 text-xs", className)}
          aria-label={`Connect Claude · ${target === "cloud" ? "Cloud" : "Local"}`}
        >
          {text ?? (auth.data?.state === "waiting" ? "Finish" : "Connect")}
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
}

/** Once Claude connects, reloads the model lists so Claude's models show up. */
export function useRefreshOnClaudeConnect(connected: boolean, onConnected?: () => void) {
  const client = useQueryClient();
  useEffect(() => {
    if (!connected) return;
    void client.invalidateQueries({ queryKey: ["systemExecutionOptions"] });
    onConnected?.();
  }, [connected, client, onConnected]);
  return connected;
}

type SignInActionInput =
  | "login"
  | "cancel"
  | "complete"
  | { kind: "login" | "cancel" | "complete"; force?: boolean };

function useClaudeSignInFlow(target: ClaudeConnectionTarget, fresh = false) {
  const [code, setCode] = useState("");
  const [manual, setManual] = useState(false);
  const client = useQueryClient();
  const auth = useClaudeConnection(target, true, false, fresh);
  const elsewhere = useSignsInElsewhere();
  const codeFlow = manual || elsewhere(auth.data);
  const action = useMutation({
    mutationFn: async (raw: SignInActionInput) => {
      const kind = typeof raw === "string" ? raw : raw.kind;
      const force = typeof raw === "string" ? false : raw.force === true;
      const codeInput = code.trim();
      setCode("");
      const requestId =
        kind === "login" ? crypto.randomUUID() : auth.data?.login_id;
      if (!requestId) throw new Error("Sign-in expired. Start again.");
      const openSignIn = (result: Status) => {
        if (result.state === "error") throw new Error(result.message ?? "Claude sign-in failed.");
        if (result.state === "waiting" && result.verification_url) openUrlInExternalBrowser(result.verification_url);
        else if (result.state === "waiting") openWhenReady.add(result.login_id ?? requestId);
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
      let input: Action = {
        action: kind,
        requestId,
        ...(kind === "login" && force && target.target === "local"
          ? { force: true }
          : {}),
      };
      if (kind === "complete") {
        const [authorizationCode, state] = codeInput.split("#");
        const expected = new URL(
          (codeFlow ? auth.data?.manual_url : auth.data?.verification_url) ??
            "",
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
      const link = elsewhere(result)
        ? result.manual_url
        : result.verification_url;
      if (kind === "login" && link) {
        setManual(false);
        openUrlInExternalBrowser(link);
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
  const signInUrl = codeFlow
    ? auth.data?.manual_url
    : auth.data?.verification_url;
  const pasteCode =
    target.target === "cloud"
      ? Boolean(signInUrl) && !returnsToMac(signInUrl!)
      : codeFlow;
  return {
    auth,
    action,
    code,
    setCode,
    codeFlow,
    setManual,
    state,
    error,
    signInUrl,
    pasteCode,
  };
}

/** Inline Claude sign-in/continue controls for timeline rows (AuthFailureRow and CloudLoginRow). */
export function ClaudeInlineSignIn({
  target,
  onContinue,
  continuing = false,
  fresh = false,
}: {
  target: ClaudeConnectionTarget;
  onContinue?: () => void;
  continuing?: boolean;
  fresh?: boolean;
}) {
  const {
    auth,
    action,
    code,
    setCode,
    codeFlow,
    setManual,
    state,
    error,
    signInUrl,
    pasteCode,
  } = useClaudeSignInFlow(target, fresh);
  const connected = state === "connected";
  const sawSignedOut = useRef(false);
  useEffect(() => {
    if (auth.data && !connected) sawSignedOut.current = true;
    else if (connected && sawSignedOut.current) {
      sawSignedOut.current = false;
      onContinue?.();
    }
  }, [auth.data, connected, onContinue]);

  return (
    <div className="flex flex-col gap-2">
      {connected ? (
        <div className="flex flex-wrap items-center gap-2">
          {onContinue ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={continuing}
              onClick={onContinue}
            >
              <Icon name="RotateCcw" className="size-3.5" aria-hidden />
              {continuing ? "Starting…" : "Continue"}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            disabled={action.isPending}
            onClick={() => action.mutate({ kind: "login", force: true })}
          >
            {action.isPending ? "Opening sign-in…" : "Sign in again"}
          </Button>
        </div>
      ) : state === "waiting" && auth.data?.installing_since ? (
        <div className="flex flex-col gap-2">
          <div className="max-w-xs text-xs">
            <InstallProgress since={auth.data.installing_since} />
          </div>
          <div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              disabled={action.isPending}
              onClick={() => action.mutate("cancel")}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : state === "waiting" ? (
        <div className="flex flex-col gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!signInUrl}
              onClick={() => {
                if (signInUrl) openUrlInExternalBrowser(signInUrl);
              }}
            >
              <Icon name="ExternalLink" className="size-3.5" aria-hidden />
              {signInUrl ? "Open sign-in page" : "Getting sign-in link…"}
            </Button>
            {target.target === "local" && !codeFlow && auth.data?.manual_url ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => {
                  setManual(true);
                  openUrlInExternalBrowser(auth.data!.manual_url!);
                }}
              >
                Use a code
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              disabled={action.isPending}
              onClick={() => action.mutate("cancel")}
            >
              Cancel
            </Button>
          </div>
          <p className="text-muted-foreground">
            {!signInUrl
              ? "Getting the sign-in link…"
              : pasteCode
                ? "Approve in your browser, then paste the one-time code."
                : "Approve in your browser. This updates automatically."}
          </p>
          {signInUrl ? (
            <div className="max-w-sm rounded-md border border-input px-2 py-1">
              <CopyableInlineLabel
                text={signInUrl}
                label="Copy sign-in link"
                successMessage="Sign-in link copied."
              />
            </div>
          ) : null}
          {pasteCode ? (
            <form
              className="flex max-w-sm gap-1.5"
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
                variant="outline"
                disabled={!code.trim() || action.isPending}
              >
                {action.isPending ? "…" : "Connect"}
              </Button>
            </form>
          ) : null}
        </div>
      ) : auth.isError || state === "unavailable" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={auth.isFetching}
            onClick={() => void auth.refetch()}
          >
            Check again
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={action.isPending}
            onClick={() => action.mutate("login")}
          >
            {action.isPending ? "Opening sign-in…" : "Sign in with Claude"}
          </Button>
          {target.target === "cloud" ? <ClaudeApiKeyForm inline /> : null}
        </div>
      )}
      {auth.data?.message ? (
        <p role="status" className="text-xs text-muted-foreground">
          {auth.data.message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function ClaudeConnectionPanel({
  target,
  onClose,
  heading,
}: {
  target: ClaudeConnectionTarget;
  onClose?: () => void;
  heading?: ReactNode;
}) {
  const {
    auth,
    action,
    code,
    setCode,
    codeFlow,
    setManual,
    state,
    error,
    signInUrl,
    pasteCode,
  } = useClaudeSignInFlow(target);
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
      {state === "waiting" && auth.data?.installing_since ? (
        <>
          <InstallProgress since={auth.data.installing_since} />
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            disabled={action.isPending}
            onClick={() => action.mutate("cancel")}
          >
            Cancel
          </Button>
        </>
      ) : state === "waiting" ? (
        <>
          <p className="text-muted-foreground">
            {!signInUrl
              ? "Getting the sign-in link…"
              : pasteCode
                ? "Approve in your browser, then paste the one-time code."
                : "Approve in your browser. This updates automatically."}
          </p>
          {signInUrl && (
            <div className="space-y-0.5">
              <p className="text-muted-foreground">Browser didn't open? Copy this link:</p>
              <div className="rounded-md border border-input px-2 py-1">
                <CopyableInlineLabel
                  text={signInUrl}
                  label="Copy sign-in link"
                  successMessage="Sign-in link copied."
                />
              </div>
            </div>
          )}
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
            {target.target === "local" &&
              !codeFlow &&
              auth.data?.manual_url && (
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

/** The time, ticking every second while `since` is set. */
function useTicking(since: number | null | undefined): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!since) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return now;
}

/** A rough install percent that ticks every second while `since` is set, else null (ADR 20261111-123959). */
export function useInstallPercent(since: number | null | undefined): number | null {
  const now = useTicking(since);
  return since ? installPercent(since, now) : null;
}

/** Claude Code installs before Cloud sign-in when it's missing, and shows it (ADR 20261111-123959). */
function InstallProgress({ since }: { since: number }) {
  const now = useTicking(since);
  const percent = installPercent(since, now);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <div className="space-y-1.5">
      <p className="flex justify-between text-muted-foreground">
        <span>Installing Claude Code</span>
        <span className="tabular-nums">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>
      </p>
      <div role="progressbar" aria-label="Installing Claude Code" className="h-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-1000 ease-linear"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
