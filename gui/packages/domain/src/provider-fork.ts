import { z } from "zod";

export const PROVIDER_FORK_VALUES = ["none", "tip", "checkpoint"] as const;

export const providerForkSchema = z.enum(PROVIDER_FORK_VALUES);

export type ProviderFork = (typeof PROVIDER_FORK_VALUES)[number];

export const CLOUD_NATIVE_FORK_PROVIDERS: readonly string[] = ["claude-code", "codex"];

export function usesTextFork(
  sourceProvider: string, sourceModel: string | undefined,
  provider: string | undefined, model: string | undefined, toCloud: boolean,
): boolean {
  if (provider !== undefined && provider !== sourceProvider) return true;
  return toCloud && (!CLOUD_NATIVE_FORK_PROVIDERS.includes(sourceProvider) ||
    (model !== undefined && model !== sourceModel));
}
