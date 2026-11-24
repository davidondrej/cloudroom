import {
  type EnvironmentDisplayInfo,
  type EnvironmentDisplayProviderLookup,
  formatEnvironmentDisplay,
} from "@cloudroom/core-ui";
import { BbRequestTimeoutError, type BbSdk } from "@cloudroom/sdk";
import { getErrorMessage } from "./helpers.js";

export interface ThreadEnvironmentInfo {
  display: EnvironmentDisplayInfo;
  hostId: string;
}

async function resolveEnvironmentProvider(args: {
  environmentProviderId: string | null;
  sdk: BbSdk;
}): Promise<EnvironmentDisplayProviderLookup> {
  if (args.environmentProviderId === null) {
    return { status: "loaded", provider: null };
  }
  // Provider names are optional display metadata and need caller proof, so a
  // failed lookup keeps the environment and falls back to the raw provider ID.
  const providers = await args.sdk.environments
    .listProviders()
    .catch((error: unknown) => {
      if (error instanceof BbRequestTimeoutError) throw error;
      return [];
    });
  const provider = providers.find(
    (candidate) => candidate.id === args.environmentProviderId,
  );
  return {
    status: "loaded",
    provider:
      provider === undefined
        ? null
        : {
            id: provider.id,
            displayName: provider.displayName,
            icon: provider.icon,
          },
  };
}

export async function fetchEnvironmentInfo(args: {
  environmentId: string;
  sdk: BbSdk;
}): Promise<ThreadEnvironmentInfo | null> {
  try {
    const env = await args.sdk.environments.get({
      environmentId: args.environmentId,
    });
    return {
      display: formatEnvironmentDisplay({
        environment: env,
        host: {
          locality: "local",
          identity: null,
        },
        providerLookup: await resolveEnvironmentProvider({
          environmentProviderId: env.environmentProviderId,
          sdk: args.sdk,
        }),
      }),
      hostId: env.hostId,
    };
  } catch (error) {
    if (error instanceof BbRequestTimeoutError) throw error;
    console.error(
      `Warning: could not load environment ${args.environmentId}: ${getErrorMessage(error)}`,
    );
    return null;
  }
}

export function printEnvironmentInfo(env: ThreadEnvironmentInfo): void {
  console.log(`  Environment: ${env.display.modeLabel} (${env.display.id})`);
}
