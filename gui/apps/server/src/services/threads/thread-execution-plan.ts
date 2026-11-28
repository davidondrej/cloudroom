import {
  getEnvironment,
  getProjectExecutionDefaults,
  getStoredProviderModelCatalog,
  getThread,
  type EnvironmentRow,
} from "@cloudroom/db";
import {
  availableModelSchema,
  providerModelCatalogDependsOnWorkspace,
  type AvailableModel,
  type CallerExecutionInputSource,
  type PermissionMode,
  type ProjectExecutionDefaults,
  type ReasoningLevel,
  type ResolvedThreadExecutionOptions,
  type ServiceTier,
  type ThreadExecutionSource,
} from "@cloudroom/domain";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import type { ProviderRegistryService } from "../providers/provider-registry.js";
import {
  clampPermissionModeToHost,
  isHostPermissionCeilingConflictError,
  resolveEnvironmentHostId,
} from "../hosts/permission-ceiling.js";
import {
  DEFAULT_REASONING_LEVEL,
  DEFAULT_SERVICE_TIER,
  resolveThreadExecutionPermissionMode,
} from "./thread-default-policy.js";
import { getLastExecutionOptions } from "./thread-events.js";
import {
  getSupportedReasoningLevelsForProvider,
  reconcileInheritedReasoningLevel,
} from "./thread-reasoning-policy.js";

interface ExecutionPlanFieldInput<TValue> {
  source: CallerExecutionInputSource;
  value: TValue;
}

interface ExistingThreadExecutionInput {
  model?: ExecutionPlanFieldInput<string>;
  permissionMode?: ExecutionPlanFieldInput<PermissionMode>;
  reasoningLevel?: ExecutionPlanFieldInput<ReasoningLevel>;
  serviceTier?: ExecutionPlanFieldInput<ServiceTier>;
}

export interface ExistingThreadExecutionInputRequest {
  model?: string;
  permissionMode?: PermissionMode;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
  executionInputSources?: ExistingThreadExecutionInputRequestSources;
}

interface ExistingThreadExecutionInputRequestSources {
  model?: CallerExecutionInputSource;
  permissionMode?: CallerExecutionInputSource;
  reasoningLevel?: CallerExecutionInputSource;
  serviceTier?: CallerExecutionInputSource;
}

interface ResolveExistingThreadExecutionPlanArgs {
  executionSource: ThreadExecutionSource;
  hostId?: string | null;
  input: ExistingThreadExecutionInput;
  projectDefaults?: ProjectExecutionDefaults | null;
  threadId: string;
}

interface ExistingThreadExecutionPlan {
  resolvedExecution: ResolvedThreadExecutionOptions;
}

export function resolveExistingThreadPermissionMode(
  deps: Pick<AppDeps, "db" | "providerRegistry">,
  threadId: string,
): PermissionMode {
  const thread = getThread(deps.db, threadId);
  if (!thread) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }
  const projectDefaults = getProjectExecutionDefaults(deps.db, {
    projectId: thread.projectId,
  });
  const projectExecution =
    projectDefaults?.providerId === thread.providerId ? projectDefaults : null;
  const parentThread =
    thread.parentThreadId !== null
      ? getThread(deps.db, thread.parentThreadId)
      : null;
  const lastExecutionPermissionMode = getLastExecutionOptions(
    deps,
    thread.id,
  )?.permissionMode;
  const permissionMode = clampPermissionModeToHost(deps, {
    hostId: resolveEnvironmentHostId(deps, thread.environmentId),
    permissionMode: resolveThreadExecutionPermissionMode(
      deps.providerRegistry,
      {
        lastExecutionPermissionMode,
        parentThread,
        parentThreadExecutionPermissionMode:
          parentThread !== null
            ? getLastExecutionOptions(deps, parentThread.id)?.permissionMode
            : undefined,
        projectExecutionPermissionMode: projectExecution?.permissionMode,
        thread,
      },
    ),
    providerId: thread.providerId,
  });
  validateProviderPermissionMode(
    deps.providerRegistry,
    thread.providerId,
    permissionMode,
  );
  return permissionMode;
}

function createMissingThreadExecutionModelError(threadId: string): ApiError {
  return new ApiError(
    500,
    "internal_error",
    `Thread ${threadId} has no stored execution model`,
  );
}

class ProviderCapabilityValidationError extends ApiError {}

function isMissingThreadExecutionModelError(
  error: unknown,
  threadId: string,
): boolean {
  return (
    error instanceof ApiError &&
    error.body.code === "internal_error" &&
    error.body.message === `Thread ${threadId} has no stored execution model`
  );
}

function isProviderCapabilityValidationError(
  error: unknown,
): error is ProviderCapabilityValidationError {
  return error instanceof ProviderCapabilityValidationError;
}

function hasExecutionInput(input: ExistingThreadExecutionInput): boolean {
  return (
    input.model !== undefined ||
    input.permissionMode !== undefined ||
    input.reasoningLevel !== undefined ||
    input.serviceTier !== undefined
  );
}

function toRequestInputField<TValue>(
  value: TValue | undefined,
  source: CallerExecutionInputSource | undefined,
): ExecutionPlanFieldInput<TValue> | undefined {
  if (value === undefined || source === undefined) {
    return undefined;
  }
  return { source, value };
}

function resolveRequestInputSource(
  sources: ExistingThreadExecutionInputRequestSources | undefined,
  field: keyof ExistingThreadExecutionInputRequestSources,
): CallerExecutionInputSource | undefined {
  if (sources === undefined) {
    return "explicit";
  }
  return sources[field];
}

export function buildExistingThreadExecutionInput(
  request: ExistingThreadExecutionInputRequest,
): ExistingThreadExecutionInput {
  const sources = request.executionInputSources;
  const model = toRequestInputField(
    request.model,
    resolveRequestInputSource(sources, "model"),
  );
  const serviceTier = toRequestInputField(
    request.serviceTier,
    resolveRequestInputSource(sources, "serviceTier"),
  );
  const reasoningLevel = toRequestInputField(
    request.reasoningLevel,
    resolveRequestInputSource(sources, "reasoningLevel"),
  );
  const permissionMode = toRequestInputField(
    request.permissionMode,
    resolveRequestInputSource(sources, "permissionMode"),
  );
  return {
    ...(model ? { model } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(reasoningLevel ? { reasoningLevel } : {}),
    ...(permissionMode ? { permissionMode } : {}),
  };
}

function validateProviderPermissionMode(
  registry: ProviderRegistryService,
  providerId: string,
  permissionMode: PermissionMode,
): void {
  const supported = registry.getSupportedPermissionModes(providerId);
  if (!supported || supported.includes(permissionMode)) {
    return;
  }

  throw new ProviderCapabilityValidationError(
    400,
    "invalid_request",
    `Provider ${providerId} only supports ${supported.join(", ")} permission mode.`,
  );
}

function validateProviderReasoningLevel(
  registry: ProviderRegistryService,
  providerId: string,
  reasoningLevel: ReasoningLevel,
  readKnownModel?: () => AvailableModel | undefined,
): void {
  const supportedLevels = getSupportedReasoningLevelsForProvider(
    registry,
    providerId,
  );
  if (
    supportedLevels.length === 0 ||
    supportedLevels.includes(reasoningLevel)
  ) {
    return;
  }
  const modelSupportsLevel =
    readKnownModel?.()?.supportedReasoningEfforts.some(
      (effort) => effort.reasoningEffort === reasoningLevel,
    ) ?? false;
  if (modelSupportsLevel) {
    return;
  }

  throw new ProviderCapabilityValidationError(
    400,
    "invalid_request",
    `Provider ${providerId} does not support ${reasoningLevel} reasoning level. Supported reasoning levels: ${supportedLevels.join(", ")}.`,
  );
}

function resolveRequiredField<TValue>(
  candidates: readonly (TValue | undefined)[],
): TValue | null {
  for (const candidate of candidates) {
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return null;
}

function resolveFieldWithDefault<TValue>(
  candidates: readonly (TValue | undefined)[],
  defaultValue: TValue,
): TValue {
  return resolveRequiredField(candidates) ?? defaultValue;
}

function findModelInCatalogJson(
  json: string,
  modelId: string,
): AvailableModel | undefined {
  try {
    const raw: unknown = JSON.parse(json);
    if (!Array.isArray(raw)) return undefined;
    for (const item of raw) {
      if (
        typeof item === "object" &&
        item !== null &&
        "model" in item &&
        item.model === modelId
      ) {
        const parsed = availableModelSchema.safeParse(item);
        if (parsed.success) return parsed.data;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function findModelInStoredCatalog(
  deps: Pick<AppDeps, "db">,
  key: { hostId: string; providerId: string; scopeKey: string },
  modelId: string,
): AvailableModel | undefined {
  const row = getStoredProviderModelCatalog(deps.db, key);
  if (row === null) return undefined;
  return (
    findModelInCatalogJson(row.modelsJson, modelId) ??
    findModelInCatalogJson(row.selectedOnlyModelsJson, modelId)
  );
}

type ExistingThreadExecutionPlanDeps = Pick<
  AppDeps,
  "db" | "providerRegistry"
> &
  Partial<Pick<AppDeps, "lifecycleDedupers">>;

function findKnownProviderModel(
  deps: ExistingThreadExecutionPlanDeps,
  args: {
    getCwd: () => string | null;
    hostId: string | null;
    model: string;
    providerId: string;
  },
): AvailableModel | undefined {
  const registration = deps.providerRegistry.get(args.providerId);
  if (args.hostId !== null && registration !== null) {
    const cwd = providerModelCatalogDependsOnWorkspace(
      registration.info.capabilities.modelCatalogScope,
    )
      ? args.getCwd()
      : null;
    const catalogStore = deps.lifecycleDedupers?.providerModelCatalogs;
    const stored =
      catalogStore !== undefined
        ? catalogStore.findKnownModel(deps, {
            cwd,
            hostId: args.hostId,
            model: args.model,
            provider: registration.info,
          })
        : findModelInStoredCatalog(
            deps,
            {
              hostId: args.hostId,
              providerId: args.providerId,
              scopeKey: cwd ?? "",
            },
            args.model,
          );
    if (stored !== undefined) return stored;
  }
  return registration?.fallbackModels.find(
    (candidate) => candidate.model === args.model,
  );
}

export async function resolveExistingThreadExecutionPlan(
  deps: ExistingThreadExecutionPlanDeps,
  args: ResolveExistingThreadExecutionPlanArgs,
): Promise<ExistingThreadExecutionPlan> {
  const lastExecution = getLastExecutionOptions(deps, args.threadId);
  const thread = getThread(deps.db, args.threadId);
  if (!thread) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }
  const rawProjectExecution =
    args.projectDefaults === undefined
      ? getProjectExecutionDefaults(deps.db, {
          projectId: thread.projectId,
        })
      : args.projectDefaults;
  const projectExecution =
    rawProjectExecution?.providerId === thread.providerId
      ? rawProjectExecution
      : null;
  const parentThread =
    thread.parentThreadId !== null
      ? getThread(deps.db, thread.parentThreadId)
      : null;
  const parentExecution =
    parentThread !== null
      ? getLastExecutionOptions(deps, parentThread.id)
      : null;
  const model = resolveRequiredField<string>([
    args.input.model?.value,
    thread.modelOverride ?? undefined,
    lastExecution?.model,
    projectExecution?.model,
  ]);
  if (!model) {
    throw createMissingThreadExecutionModelError(args.threadId);
  }

  let loadedEnvironment: EnvironmentRow | null | undefined;
  const readEnvironment = (): EnvironmentRow | null => {
    if (loadedEnvironment === undefined) {
      loadedEnvironment =
        thread.environmentId !== null
          ? getEnvironment(deps.db, thread.environmentId)
          : null;
    }
    return loadedEnvironment;
  };
  const hostId =
    args.hostId === undefined
      ? (readEnvironment()?.hostId ?? null)
      : args.hostId;
  const permissionMode = clampPermissionModeToHost(deps, {
    hostId,
    permissionMode: resolveThreadExecutionPermissionMode(
      deps.providerRegistry,
      {
        requestedPermissionMode: args.input.permissionMode?.value,
        lastExecutionPermissionMode: lastExecution?.permissionMode,
        parentThread,
        parentThreadExecutionPermissionMode: parentExecution?.permissionMode,
        projectExecutionPermissionMode: projectExecution?.permissionMode,
        thread,
      },
    ),
    providerId: thread.providerId,
  });
  validateProviderPermissionMode(
    deps.providerRegistry,
    thread.providerId,
    permissionMode,
  );

  const explicitReasoningLevel = args.input.reasoningLevel?.value;
  const fromThreadCreate = args.projectDefaults !== undefined;
  let reasoningLevel = resolveFieldWithDefault<ReasoningLevel>(
    [
      explicitReasoningLevel,
      thread.reasoningLevelOverride ?? undefined,
      lastExecution?.reasoningLevel,
      projectExecution?.reasoningLevel,
    ],
    DEFAULT_REASONING_LEVEL,
  );
  // Core checks a Cloud thread's level against its own catalog, which has levels the Mac's lacks ("none").
  if (thread.executionTarget !== "cloud") {
    let knownModel: AvailableModel | undefined;
    let knownModelLoaded = false;
    const readKnownModel = (): AvailableModel | undefined => {
      if (!knownModelLoaded) {
        knownModelLoaded = true;
        knownModel = findKnownProviderModel(deps, {
          getCwd: () => readEnvironment()?.path ?? null,
          hostId,
          model,
          providerId: thread.providerId,
        });
      }
      return knownModel;
    };
    // Inherited effort can outlive a harness or model switch; reconcile it while keeping explicit and create-time requests strict (#2239, #2692).
    if (explicitReasoningLevel === undefined && !fromThreadCreate) {
      reasoningLevel = reconcileInheritedReasoningLevel(deps.providerRegistry, {
        level: reasoningLevel,
        model: readKnownModel(),
        providerId: thread.providerId,
      });
    }
    validateProviderReasoningLevel(
      deps.providerRegistry,
      thread.providerId,
      reasoningLevel,
      fromThreadCreate ? undefined : readKnownModel,
    );
  }

  const supportsServiceTier =
    deps.providerRegistry.get(thread.providerId)?.info.capabilities
      .supportsServiceTier ?? true;
  const serviceTier = resolveFieldWithDefault<ServiceTier>(
    supportsServiceTier
      ? [
          args.input.serviceTier?.value,
          lastExecution?.serviceTier,
          projectExecution?.serviceTier,
        ]
      : // No fast mode (Antigravity): an older client's Fast runs at the default speed instead of failing.
        [],
    DEFAULT_SERVICE_TIER,
  );

  const resolvedExecution = {
    model,
    permissionMode,
    reasoningLevel,
    serviceTier,
    source: args.executionSource,
  };
  return {
    resolvedExecution,
  };
}

export async function tryResolveExistingThreadExecutionPlan(
  deps: ExistingThreadExecutionPlanDeps,
  args: ResolveExistingThreadExecutionPlanArgs,
): Promise<ExistingThreadExecutionPlan | null> {
  try {
    return await resolveExistingThreadExecutionPlan(deps, args);
  } catch (error) {
    if (isMissingThreadExecutionModelError(error, args.threadId)) {
      return null;
    }
    if (
      !hasExecutionInput(args.input) &&
      (isProviderCapabilityValidationError(error) ||
        isHostPermissionCeilingConflictError(error))
    ) {
      return null;
    }
    throw error;
  }
}
