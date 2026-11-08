import { useEffect, useState, type ComponentType } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  SystemExecutionOptionsModelLoadError,
  SystemProvidersQuery,
} from "@cloudroom/server-contract";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { useAppCommandRunner } from "@/components/commands/AppCommandProvider";
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
  const helpUrl = error?.code === "missing_executable" ? installUrl : undefined;
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

  const label = failed || error ? shortReason(error) : "No models";
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
