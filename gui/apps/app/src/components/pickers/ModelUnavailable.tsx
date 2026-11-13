import { useEffect, useState, type ComponentType } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  SystemExecutionOptionsModelLoadError,
  SystemProvidersQuery,
} from "@cloudroom/server-contract";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { useAppCommandRunner } from "@/components/commands/AppCommandProvider";
import {
  buildProviderCliIssue,
  hasProviderCliAction,
  useProviderCliInstallRunner,
} from "@/components/provider-cli/provider-cli-install";
import { providerCliJobKey } from "@/components/provider-cli/provider-cli-install-store";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import {
  useHostProviderCliStatus,
  useSystemConfig,
} from "@/hooks/queries/system-queries";
import { systemExecutionOptionsQueryKey } from "@/hooks/queries/query-keys";
import {
  modelCatalogCacheKey,
  writeCachedModelCatalog,
} from "@/lib/model-catalog-cache";
import { sdk } from "@/lib/sdk";
import { runInNewTerminal } from "@/lib/terminal-start-request";
import { useUrlAnchorClickHandler } from "@/lib/url-open-routing";
import { formatModelLoadErrorText } from "./model-load-error-message";

function shortReason(error: SystemExecutionOptionsModelLoadError | null) {
  if (error?.code === "missing_executable") return "Not installed";
  if (error?.code === "auth_required") return "Sign in required";
  if (error?.code === "timeout") return "Timed out";
  return "Not available";
}

const signInsInProgress = new Set<string>();

/** The install Cloudroom can run for a provider whose CLI is missing or broken on the routed machine. */
function useProviderCliFix(
  providerId: string,
  routing: SystemProvidersQuery | undefined,
  enabled: boolean,
) {
  const environment = useEnvironment(routing?.environmentId, { enabled });
  const config = useSystemConfig({ enabled });
  const hostId =
    routing?.hostId ??
    (routing?.environmentId
      ? (environment.data?.hostId ?? null)
      : (config.data?.primaryHostId ?? null));
  const cliStatus = useHostProviderCliStatus({ hostId, enabled });
  const status = cliStatus.data?.[providerId];
  const issue =
    enabled && status && !status.installed
      ? buildProviderCliIssue({ provider: providerId, status })
      : null;
  const { runningJobKey, queuedJobKeys, startInstall } =
    useProviderCliInstallRunner();
  if (hostId === null || issue === null || !hasProviderCliAction(issue)) {
    return null;
  }
  const jobKey = providerCliJobKey(hostId, providerId);
  return {
    // A CLI found on disk that can't run is broken, not missing.
    broken: issue.status.executablePath !== null,
    installing: runningJobKey === jobKey || queuedJobKeys.has(jobKey),
    install: () => startInstall({ hostId, issue }),
  };
}

/** Reloads a provider's models on its route, e.g. after a sign-in, and updates the picker's cache. */
export async function restartProviderModels(
  queryClient: QueryClient,
  providerId: string,
  routing?: SystemProvidersQuery,
) {
  const identity = {
    providerId,
    environmentId: routing?.environmentId ?? null,
    hostId: routing?.hostId ?? null,
  };
  const queryKey = systemExecutionOptionsQueryKey(identity);
  await queryClient.cancelQueries({ queryKey, exact: true });
  const result = await sdk.providers.restartModelDiscovery({
    providerId,
    ...(routing?.environmentId
      ? { environmentId: routing.environmentId }
      : routing?.hostId
        ? { hostId: routing.hostId }
        : {}),
  });
  queryClient.setQueryData(queryKey, result);
  if (!result.modelLoadError && result.models.length > 0)
    writeCachedModelCatalog(modelCatalogCacheKey(identity), {
      models: result.models,
      selectedOnlyModels: result.selectedOnlyModels,
    });
  return result;
}

export function ModelUnavailable({
  providerId,
  providerLabel,
  providerIcon: ProviderIcon,
  routing,
  error,
  failed,
  installUrl,
  signInCommand,
  signInHint,
}: {
  providerId: string;
  providerLabel: string;
  providerIcon?: ComponentType<{ className?: string }>;
  routing?: SystemProvidersQuery;
  error: SystemExecutionOptionsModelLoadError | null;
  failed: boolean;
  installUrl?: string;
  signInCommand?: string;
  signInHint?: string;
}) {
  const queryClient = useQueryClient();
  const commandRunner = useAppCommandRunner();
  const [terminalFailed, setTerminalFailed] = useState(false);
  const identity = {
    providerId,
    environmentId: routing?.environmentId ?? null,
    hostId: routing?.hostId ?? null,
  };
  const signInKey = `${providerId}:${identity.environmentId ?? identity.hostId ?? ""}`;
  const needsSignIn =
    signInCommand !== undefined &&
    (error ? error.code === "auth_required" : !failed);
  const cliFix = useProviderCliFix(
    providerId,
    routing,
    error?.code === "missing_executable",
  );
  const helpUrl =
    error?.code === "missing_executable" && cliFix === null
      ? installUrl
      : undefined;
  const handleHelpLinkClick = useUrlAnchorClickHandler(helpUrl);
  const retry = useMutation({
    mutationFn: async (restart: boolean) => {
      const queryKey = systemExecutionOptionsQueryKey(identity);
      if (!restart) {
        await queryClient.refetchQueries({ queryKey, exact: true });
        return;
      }
      const result = await restartProviderModels(queryClient, providerId, routing);
      if (result.modelLoadError) {
        throw new Error(
          formatModelLoadErrorText({
            error: result.modelLoadError,
            providerLabel,
          }),
        );
      }
      if (result.models.length === 0) {
        throw new Error(`${providerLabel} still returned no models.`);
      }
      signInsInProgress.delete(signInKey);
    },
  });
  const { mutate: retryLoad } = retry;
  useEffect(() => {
    if (needsSignIn && signInsInProgress.has(signInKey)) retryLoad(true);
  }, [needsSignIn, retryLoad, signInKey]);

  const startSignIn = () => {
    if (signInCommand === undefined) return;
    const opened = runInNewTerminal(
      {
        start: { mode: "command", command: signInCommand },
        title: `Sign in to ${providerLabel}`,
      },
      () => commandRunner.dispatch("terminal.open", null),
    );
    if (opened) signInsInProgress.add(signInKey);
    setTerminalFailed(!opened);
  };

  const label = cliFix?.broken
    ? `${providerLabel} install is broken`
    : failed || error
      ? shortReason(error)
      : "No models";
  const detail = retry.isError
    ? retry.error.message
    : needsSignIn
      ? `Sign in to a provider for ${providerLabel}.`
      : error
        ? formatModelLoadErrorText({ error, providerLabel })
        : failed
          ? `Could not load ${providerLabel} models.`
          : `${providerLabel} has no models.`;

  return (
    <div
      className="flex min-h-40 flex-1 flex-col items-center justify-center gap-3 px-4 py-6 text-xs text-muted-foreground"
      title={detail}
    >
      {ProviderIcon ? (
        <ProviderIcon className="size-7 text-subtle-foreground opacity-50" />
      ) : null}
      {needsSignIn ? (
        <>
          <span
            className="text-center text-foreground"
            role={retry.isError ? "alert" : undefined}
          >
            {detail}
          </span>
          <Button size="sm" onClick={startSignIn}>
            Sign in to {providerLabel}
          </Button>
          {terminalFailed || signInHint ? (
            <span className="text-center">
              {(terminalFailed
                ? `Could not open a terminal here. Run \`${signInCommand}\` in your own terminal.`
                : (signInHint ?? "")
              )
                .split("`")
                .map((part, index) =>
                  index % 2 === 1 ? (
                    <code key={index} className="font-mono text-foreground">
                      {part}
                    </code>
                  ) : (
                    part
                  ),
                )}
            </span>
          ) : null}
        </>
      ) : cliFix ? (
        <>
          <span className="text-center text-foreground">{label}</span>
          <Button size="sm" disabled={cliFix.installing} onClick={cliFix.install}>
            <Icon
              name={cliFix.installing ? "Spinner" : "Download"}
              className={cliFix.installing ? "size-3.5 animate-spin" : "size-3.5"}
              aria-hidden
            />
            {cliFix.installing
              ? `Installing ${providerLabel}…`
              : `${cliFix.broken ? "Reinstall" : "Install"} ${providerLabel}`}
          </Button>
        </>
      ) : helpUrl ? (
        <a
          href={helpUrl}
          target="_blank"
          rel="noreferrer"
          onClick={handleHelpLinkClick}
          className="underline underline-offset-2 hover:text-foreground"
        >
          {label}
        </a>
      ) : (
        <span>{label}</span>
      )}
      {needsSignIn ? null : (
        <span className="sr-only" role={retry.isError ? "alert" : undefined}>
          {detail}
        </span>
      )}
      <button
        type="button"
        aria-label={`Retry loading ${providerLabel} models`}
        disabled={retry.isPending}
        onClick={() => retry.mutate(error?.canRestart === true || needsSignIn)}
        className="flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-60"
      >
        <Icon
          name={retry.isPending ? "Spinner" : "RotateCcw"}
          className={retry.isPending ? "size-3.5 animate-spin" : "size-3.5"}
        />
      </button>
    </div>
  );
}
