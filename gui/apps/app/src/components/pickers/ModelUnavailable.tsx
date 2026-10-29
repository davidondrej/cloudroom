import type { ComponentType } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  SystemExecutionOptionsModelLoadError,
  SystemProvidersQuery,
} from "@cloudroom/server-contract";
import { Icon } from "@cloudroom/shared-ui/icon";
import { systemExecutionOptionsQueryKey } from "@/hooks/queries/query-keys";
import {
  modelCatalogCacheKey,
  writeCachedModelCatalog,
} from "@/lib/model-catalog-cache";
import { sdk } from "@/lib/sdk";
import { useUrlAnchorClickHandler } from "@/lib/url-open-routing";
import { formatModelLoadErrorText } from "./model-load-error-message";

function shortReason(error: SystemExecutionOptionsModelLoadError | null) {
  if (error?.code === "missing_executable") return "Not installed";
  if (error?.code === "auth_required") return "Sign in required";
  if (error?.code === "timeout") return "Timed out";
  return "Not available";
}

export function ModelUnavailable({
  providerId,
  providerLabel,
  providerIcon: ProviderIcon,
  routing,
  error,
  failed,
  installUrl,
}: {
  providerId: string;
  providerLabel: string;
  providerIcon?: ComponentType<{ className?: string }>;
  routing?: SystemProvidersQuery;
  error: SystemExecutionOptionsModelLoadError | null;
  failed: boolean;
  installUrl?: string;
}) {
  const queryClient = useQueryClient();
  const identity = {
    providerId,
    environmentId: routing?.environmentId ?? null,
    hostId: routing?.hostId ?? null,
  };
  const helpUrl = error?.code === "missing_executable" ? installUrl : undefined;
  const handleHelpLinkClick = useUrlAnchorClickHandler(helpUrl);
  const retry = useMutation({
    mutationFn: async () => {
      const queryKey = systemExecutionOptionsQueryKey(identity);
      if (error?.canRestart !== true) {
        await queryClient.refetchQueries({ queryKey, exact: true });
        return;
      }
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
      writeCachedModelCatalog(modelCatalogCacheKey(identity), {
        models: result.models,
        selectedOnlyModels: result.selectedOnlyModels,
      });
    },
  });

  const label = failed || error ? shortReason(error) : "No models";
  const detail = retry.isError
    ? retry.error.message
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
      {helpUrl ? (
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
      <span className="sr-only" role={retry.isError ? "alert" : undefined}>
        {detail}
      </span>
      <button
        type="button"
        aria-label={`Retry loading ${providerLabel} models`}
        title="Retry"
        disabled={retry.isPending}
        onClick={() => retry.mutate()}
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
