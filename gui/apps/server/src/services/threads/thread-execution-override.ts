import {
  getProjectExecutionDefaults,
  getThreadExecutionOverride,
  setThreadExecutionOverride,
  type ThreadExecutionOverride,
} from "@cloudroom/db";
import {
  reconcileReasoningLevel,
  type AvailableModel,
  type CallerExecutionInputSource,
  type ReasoningLevel,
  type Thread,
} from "@cloudroom/domain";
import type { SystemExecutionOptionsModelLoadError } from "@cloudroom/server-contract";
import { ApiError } from "../../errors.js";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { isHostUnavailableApiError } from "../hosts/online-rpc.js";
import type { ProviderRegistryService } from "../providers/provider-registry.js";
import {
  providerSetupError,
  resolveSystemExecutionOptionsForValidation,
} from "../system/execution-options.js";
import { getLastExecutionOptions } from "./thread-events.js";
import { getSupportedReasoningLevelsForProvider } from "./thread-reasoning-policy.js";

interface ThreadExecutionOverridePatch {
  model?: string | null;
  reasoningLevel?: ReasoningLevel | null;
}

interface ResolveThreadExecutionOverrideUpdateArgs {
  existing: ThreadExecutionOverride;
  patch: ThreadExecutionOverridePatch;
  models: readonly AvailableModel[];
  providerId: string;
  fallbackModel: string | null;
}

interface ApplyThreadExecutionOverrideArgs {
  thread: Thread;
  patch: ThreadExecutionOverridePatch;
}

interface RecoverThreadModelOverrideArgs {
  model: string | undefined;
  modelSource: CallerExecutionInputSource | undefined;
  reasoningLevel: ReasoningLevel | undefined;
  reasoningLevelSource: CallerExecutionInputSource | undefined;
  thread: Thread;
}

export function resolveThreadExecutionOverrideUpdate(
  registry: ProviderRegistryService,
  args: ResolveThreadExecutionOverrideUpdateArgs,
): ThreadExecutionOverride {
  const { existing, patch, models, providerId, fallbackModel } = args;

  const modelChanged = "model" in patch;
  let nextModel = existing.modelOverride;
  if (modelChanged) {
    if (patch.model === null || patch.model === undefined) {
      nextModel = null;
    } else {
      const target = models.find(
        (candidate) => candidate.model === patch.model,
      );
      if (!target) {
        throw new ApiError(
          400,
          "invalid_request",
          `Model "${patch.model}" is not available in this thread's ${providerId} model catalog. Choose a model offered by ${providerId}.`,
        );
      }
      nextModel = patch.model;
    }
  }

  const effectiveModel = nextModel ?? fallbackModel;
  const effectiveModelEntry = effectiveModel
    ? models.find((candidate) => candidate.model === effectiveModel)
    : undefined;
  const supportedReasoning: readonly ReasoningLevel[] = effectiveModelEntry
    ? effectiveModelEntry.supportedReasoningEfforts.map(
        (effort) => effort.reasoningEffort,
      )
    : getSupportedReasoningLevelsForProvider(registry, providerId);

  let nextReasoning = existing.reasoningLevelOverride;
  if ("reasoningLevel" in patch) {
    if (patch.reasoningLevel === null || patch.reasoningLevel === undefined) {
      nextReasoning = null;
    } else {
      if (
        supportedReasoning.length > 0 &&
        !supportedReasoning.includes(patch.reasoningLevel)
      ) {
        throw new ApiError(
          400,
          "invalid_request",
          `Reasoning level "${patch.reasoningLevel}" is not supported by ${
            effectiveModel
              ? `model "${effectiveModel}"`
              : `provider ${providerId}`
          }. Supported reasoning levels: ${supportedReasoning.join(", ")}.`,
        );
      }
      nextReasoning = patch.reasoningLevel;
    }
  } else if (
    nextReasoning !== null &&
    supportedReasoning.length > 0 &&
    !supportedReasoning.includes(nextReasoning)
  ) {
    nextReasoning = reconcileReasoningLevel(nextReasoning, supportedReasoning);
  }

  return { modelOverride: nextModel, reasoningLevelOverride: nextReasoning };
}

export async function applyThreadExecutionOverride(
  deps: LoggedWorkSessionDeps,
  args: ApplyThreadExecutionOverrideArgs,
): Promise<void> {
  const { thread, patch } = args;

  const models = await loadThreadProviderModels(
    deps,
    thread,
    typeof patch.model === "string" ? patch.model : null,
  );
  const existing = getThreadExecutionOverride(deps.db, thread.id) ?? {
    modelOverride: null,
    reasoningLevelOverride: null,
  };

  const next = resolveThreadExecutionOverrideUpdate(deps.providerRegistry, {
    existing,
    patch,
    models,
    providerId: thread.providerId,
    fallbackModel: resolveFallbackModel(deps, thread),
  });

  setThreadExecutionOverride(deps.db, {
    threadId: thread.id,
    modelOverride: next.modelOverride,
    reasoningLevelOverride: next.reasoningLevelOverride,
  });
}

/** A harness switch (ADR 0211) checks the model against the new harness's catalog and starts its overrides fresh. */
export async function resolveHarnessSwitchOverride(
  deps: LoggedWorkSessionDeps,
  thread: Thread,
  target: { providerId: string; model: string; reasoningLevel: ReasoningLevel | null },
): Promise<ThreadExecutionOverride> {
  return resolveThreadExecutionOverrideUpdate(deps.providerRegistry, {
    existing: { modelOverride: null, reasoningLevelOverride: null },
    patch: { model: target.model, reasoningLevel: target.reasoningLevel },
    models: await loadThreadProviderModels(
      deps,
      { ...thread, providerId: target.providerId },
      target.model,
      true,
    ),
    providerId: target.providerId,
    fallbackModel: null,
  });
}

export async function recoverThreadModelOverride(
  deps: LoggedWorkSessionDeps,
  args: RecoverThreadModelOverrideArgs,
): Promise<void> {
  const existing = getThreadExecutionOverride(deps.db, args.thread.id);
  const patch: ThreadExecutionOverridePatch = {};
  if (
    args.model !== undefined &&
    args.modelSource === "explicit" &&
    existing?.modelOverride != null &&
    existing.modelOverride !== args.model
  ) {
    patch.model = args.model;
  }
  if (
    args.reasoningLevel !== undefined &&
    args.reasoningLevelSource === "explicit" &&
    existing?.reasoningLevelOverride != null &&
    existing.reasoningLevelOverride !== args.reasoningLevel
  ) {
    patch.reasoningLevel = args.reasoningLevel;
  }
  if (patch.model === undefined && patch.reasoningLevel === undefined) return;

  await applyThreadExecutionOverride(deps, {
    thread: args.thread,
    patch,
  });
}

async function loadThreadProviderModels(
  deps: LoggedWorkSessionDeps,
  thread: Thread,
  requiredModel: string | null,
  acceptFallback = false,
): Promise<readonly AvailableModel[]> {
  const result = await resolveSystemExecutionOptionsForValidation(
    deps,
    {
      providerId: thread.providerId,
      ...(thread.environmentId !== null
        ? { environmentId: thread.environmentId }
        : {}),
    },
    requiredModel,
  ).catch((error: unknown) => {
    throw isHostUnavailableApiError(error)
      ? modelCatalogUnavailable(deps, thread.providerId, null)
      : error;
  });
  const models = [...result.models, ...result.selectedOnlyModels];
  const error = result.modelLoadError;
  // A switch accepts a built-in fallback model when listing fails or times out (Marko, 2026-11-10).
  const fallback =
    acceptFallback &&
    (error?.code === "timeout" || error?.code === "failed") &&
    models.some((model) => model.model === requiredModel);
  if (error !== null && !fallback) {
    throw modelCatalogUnavailable(deps, thread.providerId, error);
  }
  return models;
}

/** Says why the model couldn't be checked; only an offline host (`null`) gets reconnect advice (#1291). */
function modelCatalogUnavailable(
  deps: LoggedWorkSessionDeps,
  providerId: string,
  error: SystemExecutionOptionsModelLoadError | null,
): ApiError {
  const setup = error === null ? null : providerSetupError(deps, error);
  if (setup !== null) return setup;
  const name =
    deps.providerRegistry.get(providerId)?.info.displayName ?? providerId;
  const reason =
    error === null
      ? "Try again once the host is connected."
      : error.code === "provider_unavailable"
        ? `${name}'s provider plugin failed to load. Reinstall or re-enable it, then try again.`
        : error.code === "timeout"
          ? `${name} took too long to list its models on this host. Try again.`
          : `${name} failed to list its models on this host. Try again in a minute.`;
  return new ApiError(
    503,
    "model_catalog_unavailable",
    `Unable to load ${name} models to validate the change. ${reason}`,
    error === null ? undefined : { details: error },
  );
}

function resolveFallbackModel(
  deps: LoggedWorkSessionDeps,
  thread: Thread,
): string | null {
  const lastExecution = getLastExecutionOptions(deps, thread.id);
  if (lastExecution?.model) {
    return lastExecution.model;
  }
  const projectDefaults = getProjectExecutionDefaults(deps.db, {
    projectId: thread.projectId,
  });
  return projectDefaults?.model ?? null;
}
