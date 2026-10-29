import { useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  buildProviderCliIssue,
  hasProviderCliAction,
  useProviderCliInstallRunner,
} from "@/components/provider-cli/provider-cli-install";
import { autoStartProviderCliInstall, providerCliJobKey } from "@/components/provider-cli/provider-cli-install-store";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import { useHostProviderCliStatus } from "@/hooks/queries/system-queries";
import { useThread } from "@/hooks/queries/thread-queries";
import { useThisComputer } from "@/hooks/useHostDaemon";
import { sdk } from "@/lib/sdk";

const MISSING_CLI = /Cloudroom could not find the (Claude Code|Codex) CLI/;
const PROVIDERS = { "Claude Code": "claude-code", Codex: "codex" } as const;

export function missingProviderCli(detail: string | null) {
  const name = detail?.match(MISSING_CLI)?.[1] as
    | keyof typeof PROVIDERS
    | undefined;
  return name ? { name, provider: PROVIDERS[name] } : null;
}

export function MissingProviderCliRow({
  threadId,
  name,
  provider,
  className,
}: {
  threadId: string;
  name: string;
  provider: string;
  className?: string;
}) {
  const thread = useThread(threadId);
  const here = useThisComputer();
  const environment = useEnvironment(thread.data?.environmentId);
  const hostId = environment.data?.hostId ?? null;
  const cliStatus = useHostProviderCliStatus({ hostId });
  const status = cliStatus.data?.[provider];
  const issue = status ? buildProviderCliIssue({ provider, status }) : null;
  const { runningJobKey, queuedJobKeys, failuresByJobKey, startInstall } =
    useProviderCliInstallRunner();
  const jobKey = hostId ? providerCliJobKey(hostId, provider) : null;
  const installing =
    jobKey !== null && (runningJobKey === jobKey || queuedJobKeys.has(jobKey));
  const installFailed = jobKey !== null && failuresByJobKey.has(jobKey);
  const failed = thread.data?.status === "error";
  const retry = useMutation({
    mutationFn: () =>
      sdk.threads.retry({ threadId, reason: `Installed ${name} CLI` }),
    meta: { showErrorToast: false },
  });
  const { mutate: retryNow } = retry;
  const retryAfterInstall = useRef(false);
  // Install silently, then retry (ADR 0193). The button is only a fallback when that fails.
  useEffect(() => {
    if (!hostId || !issue || status?.installed || !hasProviderCliAction(issue)) return;
    retryAfterInstall.current = true;
    autoStartProviderCliInstall({ hostId, issue });
  }, [hostId, issue, status?.installed]);
  useEffect(() => {
    if (status?.installed && retryAfterInstall.current) {
      retryAfterInstall.current = false;
      if (failed) retryNow();
    }
  }, [status?.installed, failed, retryNow]);

  return (
    <div className={cn("flex flex-col gap-3 py-1", className)}>
      <p className="flex items-center gap-2.5 text-base font-semibold text-foreground">
        <Icon
          name={status?.installed ? "CircleCheck" : "AlertCircle"}
          className={cn(
            "size-[18px] shrink-0",
            status?.installed ? "text-muted-foreground" : "text-attention",
          )}
          aria-hidden
        />
        {status?.installed
          ? `${name} CLI is installed`
          : installing
            ? `Installing ${name} CLI on ${here}…`
            : `${name} CLI isn't installed on ${here}`}
      </p>
      <div className="flex flex-wrap items-center gap-2 pl-7">
        {hostId &&
          issue &&
          installFailed &&
          !status?.installed &&
          hasProviderCliAction(issue) && (
            <Button
              type="button"
              size="sm"
              disabled={installing}
              onClick={() => {
                retryAfterInstall.current = true;
                startInstall({ hostId, issue });
              }}
            >
              <Icon
                name={installing ? "Spinner" : "Download"}
                className={cn("size-3.5", installing && "animate-spin")}
                aria-hidden
              />
              {installing ? `Installing ${name} CLI…` : `Install ${name} CLI`}
            </Button>
          )}
        {failed && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={retry.isPending || installing}
            onClick={() => retryNow()}
          >
            <Icon name="RotateCcw" className="size-3.5" aria-hidden />
            {retry.isPending ? "Retrying…" : "Retry"}
          </Button>
        )}
      </div>
      {retry.error && (
        <p role="alert" className="pl-7 text-xs text-destructive">
          {retry.error.message.replace(/^HTTP \d+: /, "")}
        </p>
      )}
    </div>
  );
}
