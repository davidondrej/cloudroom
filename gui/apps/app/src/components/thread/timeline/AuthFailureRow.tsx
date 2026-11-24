import { createContext, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { PROVIDER_AUTH_FAILED_TITLE, type ThreadTimelineViewRow } from "@cloudroom/thread-view";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  ClaudeInlineSignIn,
  useClaudeConnection,
  useInstallPercent,
  type ClaudeConnectionTarget,
} from "@/components/ClaudeConnection";
import { useCloudroomThread, useRetryCloudStart } from "@/hooks/queries/cloudroom-queries";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { useThread } from "@/hooks/queries/thread-queries";
import { getProviderIconInfo, getProviderIconTintStyle } from "@/lib/provider-icon";
import { sdk } from "@/lib/sdk";

/** The latest auth-failure error row at the tail of a stopped thread. */
export const LatestAuthFailureRowIdContext = createContext<string | null>(null);

const LOGIN_COMMANDS: Record<string, string> = {
  "acp-cursor": "cursor-agent login",
};

const SHORT_NAMES: Record<string, string> = {
  "claude-code": "Claude",
  codex: "Codex",
  "acp-cursor": "Cursor",
};

export function isAuthFailureRow(row: ThreadTimelineViewRow): boolean {
  return (
    row.kind === "system" &&
    row.systemKind === "error" &&
    row.title === PROVIDER_AUTH_FAILED_TITLE
  );
}

/** Returns the tail auth-failure row id while the thread is stopped. */
export function findLatestAuthFailureRowId(
  rows: readonly ThreadTimelineViewRow[],
  running: boolean,
): string | null {
  if (running) return null;
  let candidates = rows;
  for (;;) {
    const last = candidates[candidates.length - 1];
    if (last?.kind === "turn" && last.children) {
      candidates = last.children;
      continue;
    }
    return last && isAuthFailureRow(last) ? last.id : null;
  }
}

/** Signs in on this Mac; a missing Codex installs first, and `onInstall` gets when that began (ADR 20261111-123959). */
async function signInMacCodex(
  onInstall: (since: number | null) => void,
): Promise<void> {
  const call = async (method: "GET" | "POST") => {
    const response = await fetch(
      "/api/v1/cloudroom/mac/codex-login",
      method === "POST"
        ? { method, headers: { "content-type": "application/json" }, body: "{}" }
        : {},
    );
    if (!response.ok) throw new Error("Codex sign-in could not start.");
    return (await response.json()) as {
      state: string;
      message?: string;
      installing_since?: number | null;
    };
  };
  let status = await call("POST");
  while (status.state === "waiting") {
    onInstall(status.installing_since ?? null);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    status = await call("GET");
  }
  if (status.state === "error") {
    throw new Error(status.message ?? "Codex sign-in failed.");
  }
}

function CodexInlineSignIn({
  onSignedIn,
  continuing,
}: {
  onSignedIn: () => void;
  continuing: boolean;
}) {
  const [waiting, setWaiting] = useState(false);
  const [installingSince, setInstallingSince] = useState<number | null>(null);
  const installing = useInstallPercent(installingSince);
  const [error, setError] = useState("");
  const signIn = () => {
    setWaiting(true);
    setError("");
    signInMacCodex(setInstallingSince)
      .then(onSignedIn, (cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => {
        setWaiting(false);
        setInstallingSince(null);
      });
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="tabular-nums"
          disabled={waiting || continuing}
          onClick={signIn}
        >
          {waiting || continuing ? (
            <Icon name="Spinner" className="size-3.5 animate-spin" aria-hidden />
          ) : null}
          {continuing
            ? "Starting…"
            : installing !== null
              ? `Installing ${installing}%`
              : waiting
                ? "Waiting…"
                : "Sign in"}
        </Button>
      </div>
      {installing !== null || waiting ? (
        <p className="text-xs text-muted-foreground">
          {installing !== null
            ? "Installing Codex first."
            : "Finish signing in in your browser."}
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

/**
 * Inline auth-failure row in the timeline (Option A, David 2026-11-21): replaces the raw
 * "Provider authorization failed" error box and the old floating sign-in card above the composer.
 */
export function AuthFailureRow({
  row,
  latest,
  className,
}: {
  row: ThreadTimelineViewRow;
  latest: boolean;
  className?: string;
}) {
  const thread = useThread(row.threadId).data;
  const environment = useEnvironment(thread?.environmentId).data;
  const providers = useSystemProviders().data;
  const isCloud = thread?.executionTarget === "cloud";
  const cloudState = useCloudroomThread(row.threadId, latest && isCloud).data;
  const retryCloudStart = useRetryCloudStart(row.threadId);
  const retry = useMutation({
    mutationFn: () =>
      sdk.threads.retry({ threadId: row.threadId, reason: "Signed in again" }),
    meta: { showErrorToast: false },
  });
  const [showDetail, setShowDetail] = useState(false);

  const providerId = thread?.providerId ?? "claude-code";
  const provider = providers?.find((entry) => entry.id === providerId) ?? null;
  const name = SHORT_NAMES[providerId] ?? provider?.displayName ?? providerId;
  const Logo = getProviderIconInfo("agent", providerId, provider).icon;
  const tint = provider ? getProviderIconTintStyle(provider) : undefined;
  const detail = row.kind === "system" ? row.detail : null;

  const isClaude = providerId === "claude-code";
  const claudeTarget: ClaudeConnectionTarget = isCloud
    ? { target: "cloud" }
    : {
        target: "local",
        hostId: environment?.hostId ?? null,
        environmentId: thread?.environmentId ?? null,
      };
  const stopped =
    !thread || thread.status === "idle" || thread.status === "error";
  const active = latest && stopped;
  const claudeAuth = useClaudeConnection(claudeTarget, active && isClaude, false, true);
  const claudeConnected = isClaude && claudeAuth.data?.state === "connected";

  if (!active) {
    return (
      <p
        className={cn(
          "flex items-center gap-2 py-1 text-sm text-muted-foreground",
          className,
        )}
      >
        <span className="inline-flex shrink-0" style={tint}>
          <Logo className="size-3.5" />
        </span>
        {name} login expired
      </p>
    );
  }

  const useCloudRetry = isCloud && Boolean(cloudState?.failedStart || cloudState?.authRequired);
  const onContinue = () => {
    if (useCloudRetry) retryCloudStart.mutate();
    else retry.mutate();
  };
  const continuing = useCloudRetry ? retryCloudStart.isPending : retry.isPending;
  const retryError = useCloudRetry ? retryCloudStart.error : retry.error;
  const command = LOGIN_COMMANDS[providerId];

  return (
    <div className={cn("flex flex-col gap-3 py-1", className)}>
      <p className="flex flex-wrap items-center gap-2.5 text-base font-semibold text-foreground">
        <span className="inline-flex shrink-0" style={tint}>
          <Logo className="size-[18px]" />
        </span>
        <span>{name} login expired</span>
        {claudeConnected ? (
          <span className="inline-flex items-center gap-1 text-sm font-normal text-muted-foreground">
            <Icon name="Check" className="size-3.5 text-success" aria-hidden />
            Connected
          </span>
        ) : null}
      </p>
      <div className="pl-7">
        {isClaude ? (
          <ClaudeInlineSignIn
            target={claudeTarget}
            onContinue={onContinue}
            continuing={continuing}
            fresh
          />
        ) : providerId === "codex" && !isCloud ? (
          <CodexInlineSignIn onSignedIn={onContinue} continuing={continuing} />
        ) : (
          <div className="flex flex-col gap-2">
            {command ? (
              <p className="text-xs text-muted-foreground">
                Run <code className="font-mono text-foreground">{command}</code> in your terminal, then continue.
              </p>
            ) : null}
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={continuing}
                onClick={onContinue}
              >
                <Icon name="RotateCcw" className="size-3.5" aria-hidden />
                {continuing ? "Retrying…" : "Continue"}
              </Button>
            </div>
          </div>
        )}
        {retryError ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {retryError.message.replace(/^HTTP \d+: /, "")}
          </p>
        ) : null}
      </div>
      {detail ? (
        <div className="pl-7">
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setShowDetail((open) => !open)}
          >
            <span>{name}'s message</span>
            <Icon
              name={showDetail ? "ChevronDown" : "ChevronRight"}
              className="size-3.5"
              aria-hidden
            />
          </button>
          {showDetail ? (
            <p className="mt-2 max-w-[620px] whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted-foreground">
              {detail}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Inline sign-in row for cases with no timeline error row yet:
 * - a pending local Claude thread when Claude isn't signed in on this host, or
 * - a Cloud Claude thread waiting on auth without a CloudLoginRow / AuthFailureRow.
 */
export function PendingClaudeSignInRow({
  threadId,
  isCloud,
  hostId,
  environmentId,
  className,
}: {
  threadId: string;
  isCloud: boolean;
  hostId?: string | null;
  environmentId?: string | null;
  className?: string;
}) {
  const providers = useSystemProviders().data;
  const retryCloudStart = useRetryCloudStart(threadId);
  const target: ClaudeConnectionTarget = isCloud
    ? { target: "cloud" }
    : { target: "local", hostId: hostId ?? null, environmentId: environmentId ?? null };
  const auth = useClaudeConnection(target, true, false, isCloud);
  const connected = auth.data?.state === "connected";
  if (
    !isCloud &&
    (connected || !auth.data || auth.data.state === "unavailable")
  ) {
    return null;
  }

  const provider = providers?.find((entry) => entry.id === "claude-code") ?? null;
  const Logo = getProviderIconInfo("agent", "claude-code", provider).icon;
  const tint = provider ? getProviderIconTintStyle(provider) : undefined;

  return (
    <div className={cn("flex flex-col gap-3 py-1", className)}>
      <p className="flex flex-wrap items-center gap-2.5 text-base font-semibold text-foreground">
        <span className="inline-flex shrink-0" style={tint}>
          <Logo className="size-[18px]" />
        </span>
        <span>
          {isCloud ? "Claude disconnected in Cloud" : "Sign in to Claude to continue"}
        </span>
        {connected ? (
          <span className="inline-flex items-center gap-1 text-sm font-normal text-muted-foreground">
            <Icon name="Check" className="size-3.5 text-success" aria-hidden />
            Connected
          </span>
        ) : null}
      </p>
      <div className="pl-7">
        <ClaudeInlineSignIn
          target={target}
          onContinue={isCloud ? () => retryCloudStart.mutate() : undefined}
          continuing={isCloud ? retryCloudStart.isPending : false}
        />
        {isCloud && retryCloudStart.error ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {retryCloudStart.error.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
