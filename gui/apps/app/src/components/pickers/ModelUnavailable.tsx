import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  SystemExecutionOptionsModelLoadError,
  SystemProvidersQuery,
} from "@cloudroom/server-contract";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
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
import { useUrlAnchorClickHandler } from "@/lib/url-open-routing";
import { formatModelLoadErrorText } from "./model-load-error-message";

function shortReason(error: SystemExecutionOptionsModelLoadError | null) {
  if (error?.code === "missing_executable") return "Not installed";
  if (error?.code === "auth_required") return "Sign in required";
  if (error?.code === "timeout") return "Timed out";
  return "Not available";
}

const signInsInProgress = new Set<string>();

/** The machine a provider's models are checked on: the route's host, its environment's, or the primary. */
export function useRoutedHostId(
  routing: SystemProvidersQuery | undefined,
  enabled: boolean,
): string | null {
  const environment = useEnvironment(routing?.environmentId, { enabled });
  const config = useSystemConfig({ enabled });
  return (
    routing?.hostId ??
    (routing?.environmentId
      ? (environment.data?.hostId ?? null)
      : (config.data?.primaryHostId ?? null))
  );
}

/** The install Cloudroom can run for a provider whose CLI is missing or broken on the routed machine. */
function useProviderCliFix(
  providerId: string,
  routing: SystemProvidersQuery | undefined,
  enabled: boolean,
) {
  const hostId = useRoutedHostId(routing, enabled);
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
  onSignIn,
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
  /** Runs `signInCommand` on the machine this route checks models on. */
  onSignIn?: () => void;
}) {
  const queryClient = useQueryClient();
  const identity = {
    providerId,
    environmentId: routing?.environmentId ?? null,
    hostId: routing?.hostId ?? null,
  };
  const signInKey = `${providerId}:${identity.environmentId ?? identity.hostId ?? ""}`;
  const [signInOpened, setSignInOpened] = useState(() =>
    signInsInProgress.has(signInKey),
  );
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
    // The sign-in steps show the error inline; a toast would repeat it.
    meta: { showErrorToast: !needsSignIn },
    mutationFn: async (restart: boolean) => {
      const queryKey = systemExecutionOptionsQueryKey(identity);
      if (!restart) {
        await queryClient.refetchQueries({ queryKey, exact: true });
        return;
      }
      const result = await restartProviderModels(queryClient, providerId, routing);
      if (result.modelLoadError?.code === "auth_required") {
        throw new Error(`Still signed out of ${providerLabel}.`);
      }
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
    signInsInProgress.add(signInKey);
    setSignInOpened(true);
    onSignIn?.();
  };

  if (needsSignIn) {
    // A CLI that reports auth_required only needs its own login; an empty
    // catalog (Pi) needs the provider's extra steps, e.g. "type /login".
    const note = error?.code === "auth_required" ? undefined : signInHint;
    return (
      <SignInSteps
        providerLabel={providerLabel}
        ProviderIcon={ProviderIcon}
        opened={signInOpened}
        checking={retry.isPending}
        problem={retry.isError ? retry.error.message : undefined}
        note={note}
        onSignIn={startSignIn}
        onReload={() => retry.mutate(true)}
      />
    );
  }

  const label = cliFix?.broken
    ? `${providerLabel} install is broken`
    : failed || error
      ? shortReason(error)
      : "No models";
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
      {cliFix ? (
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
      <span className="sr-only" role={retry.isError ? "alert" : undefined}>
        {detail}
      </span>
      <button
        type="button"
        aria-label={`Retry loading ${providerLabel} models`}
        disabled={retry.isPending}
        onClick={() => retry.mutate(error?.canRestart === true)}
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

function SignInStep({
  n,
  done = false,
  title,
  hint,
  children,
}: {
  n: number;
  done?: boolean;
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3">
      {done ? (
        <Icon name="CircleCheck" className="size-6 shrink-0 text-success" aria-label="Done" />
      ) : (
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border font-medium text-foreground">
          {n}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium text-foreground">{title}</span>
        <span>{hint}</span>
      </span>
      {children}
    </li>
  );
}

/** Signed out: 1) run the provider's login in a terminal, 2) reload its models. */
function SignInSteps({
  providerLabel,
  ProviderIcon,
  opened,
  checking,
  problem,
  note,
  onSignIn,
  onReload,
}: {
  providerLabel: string;
  ProviderIcon: ComponentType<{ className?: string }> | undefined;
  opened: boolean;
  checking: boolean;
  problem: string | undefined;
  note: string | undefined;
  onSignIn: () => void;
  onReload: () => void;
}) {
  return (
    <div className="flex min-h-40 flex-1 flex-col justify-center gap-4 px-4 py-6 text-xs text-muted-foreground">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        {ProviderIcon ? <ProviderIcon className="size-4 shrink-0" /> : null}
        Connect {providerLabel} in 2 steps
      </div>
      <ol className="flex flex-col gap-3.5">
        <SignInStep
          n={1}
          done={opened}
          title="Sign in"
          hint={opened ? "Login opened" : "Opens a login window"}
        >
          <Button
            size="sm"
            variant={opened ? "outline" : "default"}
            className="h-7 px-3"
            aria-label={`Sign in to ${providerLabel}`}
            onClick={onSignIn}
          >
            Sign in
          </Button>
        </SignInStep>
        <SignInStep n={2} title="Load models" hint="After you sign in">
          <Button
            size="sm"
            variant={opened ? "default" : "outline"}
            className="h-7 gap-1.5 px-2.5"
            disabled={checking}
            onClick={onReload}
          >
            <Icon
              name={checking ? "Spinner" : "RotateCcw"}
              className={checking ? "size-3.5 animate-spin" : "size-3.5"}
              aria-hidden
            />
            {checking ? "Checking…" : "Reload"}
          </Button>
        </SignInStep>
      </ol>
      {problem ? (
        <span role="alert" className="text-warning-text">
          {problem}
        </span>
      ) : null}
      {note ? (
        <span>
          {note.split("`").map((part, index) =>
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
    </div>
  );
}
