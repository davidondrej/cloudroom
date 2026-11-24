import { z } from "zod";

export const PROVIDER_FORK_VALUES = ["none", "tip", "checkpoint"] as const;

export const providerForkSchema = z.enum(PROVIDER_FORK_VALUES);

export type ProviderFork = (typeof PROVIDER_FORK_VALUES)[number];

export const CLOUD_NATIVE_FORK_PROVIDERS: readonly string[] = ["claude-code", "codex"];

/** Every harness can fork (ADR 20261121-141157). A fork clones the source's own session only when the same harness can
 *  clone it at that point (`native`), and in Cloud only Claude Code or Codex on the same model. Otherwise it copies the
 *  chat as text. */
export function usesTextFork(
  sourceProvider: string, sourceModel: string | undefined,
  provider: string | undefined, model: string | undefined, toCloud: boolean, native: boolean,
): boolean {
  if (provider !== undefined && provider !== sourceProvider) return true;
  if (!native) return true;
  return toCloud && (!CLOUD_NATIVE_FORK_PROVIDERS.includes(sourceProvider) || (model !== undefined && model !== sourceModel));
}
