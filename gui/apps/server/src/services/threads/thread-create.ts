import { COMPUTER } from "@cloudroom/domain";
import { cloudExecution, cloudroom, isCloudThread } from "../cloudroom/commands.js";
import { prepareLocalFork, prepareLocalForkCode } from "../cloudroom/teleport-local.js";
import { FORK_HARNESSES, forkModel, forkTurn } from "../cloudroom/fork.js";
import { messagesSeed } from "./thread-harness-switch.js";
import { threadMessages } from "./thread-transcript.js";
import { ensureProjectCheckoutForThread } from "../projects/project-source-setup.js";
import { assertEnvironmentPathAvailable } from "../environments/path-admission.js";
import {
  deleteThread,
  getEnvironment,
  getLatestCompletedThreadContextClearSequence,
  getProjectSourceByHost,
  getThread,
} from "@cloudroom/db";
import type {
  ProjectExecutionDefaults,
  Project,
  PromptInput,
  Thread,
  ThreadOriginKind,
  ThreadVisibility,
} from "@cloudroom/domain";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { ApiError } from "../../errors.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import { buildExecutionOptions } from "./thread-commands.js";
import {
  copyForkSourceHistory,
  recordImportFork,
  recordTextImport,
  resolveThreadForkPoint,
  type ThreadForkHistory,
  type ThreadForkPoint,
} from "./thread-fork-history.js";
import {
  rememberProjectExecutionDefaultsForCreate,
  resolveProjectExecutionDefaultsForCreate,
} from "./project-execution-defaults.js";
import { validatePromptAttachmentReferences } from "../projects/attachments.js";
import {
  appendPluginMentionContext,
  captureUserMessageSentTelemetry,
} from "./thread-send.js";
import {
  attemptDispatch,
  hostIdForEnvironmentIntent,
  type PendingThreadStartContext,
} from "./dispatch-attempt.js";
import { setThreadStartupContext } from "@cloudroom/db";
import { emitPluginThreadDeleted } from "../plugins/plugin-thread-events.js";
import {
  createThreadRecord,
  getThreadSafe,
  requirePublicProjectForThreadCreate,
} from "./thread-create-helpers.js";
import {
  resolveStableThreadRequestEnvironment,
  type ResolvedStableThreadRequestEnvironment,
} from "./thread-request-eligibility.js";
import {
  requireEnvironmentPlacementHost,
  resolveThreadEnvironmentPlacement,
} from "./thread-environment-placement.js";
import {
  buildProviderThreadExecutionDefaults,
  resolveCreateThreadEnvironment,
} from "./thread-default-policy.js";
import { assertValidParentThread } from "./thread-parent.js";
import {
  type ThreadCreateServiceRequestInput,
  type ThreadCreateServiceRequest,
} from "./thread-create-request.js";
import { deriveTitleFallback } from "./title-generation.js";
import type { ThreadProvisionEnvironmentIntent } from "./thread-startup-store.js";
import { resolveSystemProviderModels } from "../system/execution-options.js";
import {
  getEnvironmentProvider,
  listEnvironmentCompositions,
} from "../plugins/plugin-environment-provider-registry.js";

type ThreadCreateDeps = LoggedPendingInteractionWorkSessionDeps;

interface ImportedText {
  history: ThreadForkHistory;
  seed: PromptInput[];
}

interface CreateProvisioningThreadArgs {
  deferFork: boolean;
  environmentId: string | null;
  executionDefaults: Parameters<
    typeof buildExecutionOptions
  >[2]["projectDefaults"];
  fork: ThreadForkPoint | null;
  importedText?: ImportedText;
  request: ThreadCreateServiceRequest;
  providerInput?: ThreadCreateServiceRequestInput["input"];
}

interface ResolveForkPointArgs {
  originKind: ThreadOriginKind | null;
  providerId: string;
  sourceSeqEnd: number | undefined;
  sourceThread: Thread | null;
}

interface ResolveCatalogExecutionDefaultsArgs {
  cwd?: string;
  executionDefaults: ProjectExecutionDefaults | null;
  hostId: string | null;
  providerId: string;
  providerFallbackCandidates: readonly string[];
  requestedModel: string | null;
}

async function loadCatalogDefaultForProvider(
  deps: ThreadCreateDeps,
  args: { cwd?: string; hostId: string; providerId: string },
): Promise<ProjectExecutionDefaults | ApiError> {
  const catalog = await resolveSystemProviderModels(deps, {
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
    hostId: args.hostId,
    providerId: args.providerId,
  });
  if (catalog.modelLoadError !== null) {
    return new ApiError(
      503,
      "model_catalog_unavailable",
      `Unable to load ${args.providerId} models to resolve the default. Try again once the host is connected and the provider is ready.`,
      {
        details: catalog.modelLoadError,
        retryable: true,
      },
    );
  }
  const defaultModel =
    catalog.models.find((model) => model.isDefault) ?? catalog.models[0];
  if (defaultModel === undefined) {
    return new ApiError(
      503,
      "model_catalog_unavailable",
      `The ${args.providerId} model catalog is empty, so no default model can be resolved.`,
      true,
    );
  }
  return buildProviderThreadExecutionDefaults(deps.providerRegistry, {
    providerId: args.providerId,
    model: defaultModel.model,
  });
}

async function resolveCatalogExecutionDefaults(
  deps: ThreadCreateDeps,
  args: ResolveCatalogExecutionDefaultsArgs,
): Promise<ProjectExecutionDefaults | null> {
  if (args.executionDefaults !== null || args.requestedModel !== null) {
    return args.executionDefaults;
  }

  if (args.hostId === null) {
    throw new ApiError(
      400,
      "model_required",
      "Pick a model: this environment provider has no machine yet to list a default from, and the project has no remembered one.",
    );
  }

  const candidates = [args.providerId, ...args.providerFallbackCandidates];
  let lastError: ApiError | null = null;
  for (const providerId of candidates) {
    const result = await loadCatalogDefaultForProvider(deps, {
      ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
      hostId: args.hostId,
      providerId,
    });
    if (!(result instanceof ApiError)) {
      return result;
    }
    lastError = result;
  }
  throw lastError;
}

function resolveForkPoint(
  deps: Pick<ThreadCreateDeps, "db" | "providerRegistry">,
  args: ResolveForkPointArgs,
): ThreadForkPoint | null {
  if (args.originKind === null || args.sourceThread === null) {
    return null;
  }
  if (!deps.providerRegistry.supportsFork(args.providerId)) {
    return null;
  }
  if (args.sourceThread.providerId !== args.providerId) {
    return null;
  }
  const sourceEnvironmentId = args.sourceThread.environmentId;
  if (sourceEnvironmentId === null) {
    return null;
  }
  const sourceEnvironment = getEnvironment(deps.db, sourceEnvironmentId);
  if (sourceEnvironment === null) {
    return null;
  }
  return resolveThreadForkPoint(deps, {
    sourceSeqEnd: args.sourceSeqEnd,
    sourceThread: args.sourceThread,
  });
}

function assertForkSourceHost(
  deps: Pick<ThreadCreateDeps, "db">,
  args: {
    childHostId: string | null;
    originKind: ThreadOriginKind | null;
    sourceThread: Thread | null;
  },
): void {
  if (args.originKind !== "fork" || args.sourceThread === null) {
    return;
  }
  const sourceEnvironment =
    args.sourceThread.environmentId === null
      ? null
      : getEnvironment(deps.db, args.sourceThread.environmentId);
  if (sourceEnvironment !== null && args.childHostId === null) {
    throw new ApiError(
      400,
      "invalid_request",
      `Fork environment must name the source thread's host (${sourceEnvironment.hostId})`,
    );
  }
  if (
    sourceEnvironment !== null &&
    sourceEnvironment.hostId !== args.childHostId
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      `Fork environment must use the source thread's host (${sourceEnvironment.hostId}), not ${args.childHostId}`,
    );
  }
}

function childHostIdForResolvedEnvironment(
  resolvedEnvironment: ResolvedStableThreadRequestEnvironment,
): string {
  switch (resolvedEnvironment.type) {
    case "reuse":
      return resolvedEnvironment.environment.hostId;
    case "host":
      return resolvedEnvironment.hostId;
    case "personal":
      return resolvedEnvironment.hostId;
  }
}

function projectCheckoutPathOnHost(
  deps: Pick<AppDeps, "db">,
  projectId: string,
  hostId: string,
): string | undefined {
  const source = getProjectSourceByHost(deps.db, projectId, hostId);
  return source?.type === "local_path" ? source.path : undefined;
}

function modelCatalogCwdForResolvedEnvironment(
  resolvedEnvironment: ResolvedStableThreadRequestEnvironment,
): string | undefined {
  switch (resolvedEnvironment.type) {
    case "reuse":
      return resolvedEnvironment.environment.path ?? undefined;
    case "host":
      return (
        resolvedEnvironment.unmanagedPath ??
        resolvedEnvironment.localSource?.path ??
        undefined
      );
    case "personal":
      return undefined;
  }
}

function requestUsesPersonalWorkspace(
  request: ThreadCreateServiceRequestInput,
): boolean {
  return (
    request.environment.type === "host" &&
    request.environment.workspace.type === "personal"
  );
}

function assertProjectWorkspaceCompatibility(
  project: Project,
  request: ThreadCreateServiceRequestInput,
): void {
  const personalWorkspace = requestUsesPersonalWorkspace(request);
  if (project.kind === "personal") {
    if (
      request.environment.type !== "reuse" &&
      request.environment.type !== "provider" &&
      request.environment.type !== "project-default" &&
      !(
        request.environment.type === "host" &&
        request.environment.workspace.type === "unmanaged" &&
        request.environment.workspace.path === null
      ) &&
      !personalWorkspace
    ) {
      throw new ApiError(
        400,
        "invalid_request",
        "Personal project threads must use a personal workspace",
      );
    }
    return;
  }

  if (personalWorkspace) {
    throw new ApiError(
      400,
      "invalid_request",
      "Personal workspaces are only supported for the personal project",
    );
  }
}

function requireLiveSourceThread(
  deps: Pick<ThreadCreateDeps, "db">,
  args: {
    projectId: string;
    sourceThreadId: string;
  },
): Thread {
  const sourceThread = getThread(deps.db, args.sourceThreadId);
  if (sourceThread === null) {
    throw new ApiError(400, "invalid_request", "sourceThreadId not found");
  }
  if (sourceThread.projectId !== args.projectId) {
    throw new ApiError(
      400,
      "invalid_request",
      "sourceThreadId must belong to the same project",
    );
  }
  if (sourceThread.archivedAt !== null) {
    throw new ApiError(
      400,
      "invalid_request",
      "sourceThreadId must reference an unarchived thread",
    );
  }
  if (sourceThread.deletedAt !== null) {
    throw new ApiError(
      400,
      "invalid_request",
      "sourceThreadId must reference a non-deleted thread",
    );
  }
  return sourceThread;
}

/**
 * Creates the thread row and hands its first message to the dispatch
 * checkpoint.
 *
 * This is the whole of thread creation's dispatch story now, and it replaced a
 * pair of near-identical functions — one that provisioned immediately and one
 * that queued the first turn — whose only real difference was
 * whether anything was allowed to run yet. That is a question the checkpoint
 * answers, so asking it here as well meant two code paths that had to be kept
 * in agreement about forks, execution defaults, telemetry and cleanup.
 *
 * The row inserts `pending`: created, with its provider resolved, and nothing
 * provisioned. Creation itself is unhooked — it is a cheap row — and admission
 * happens at the first message's attempt. A cleared attempt moves the thread
 * to `starting` and provisions with the message riding along; a queued one
 * leaves the thread exactly where it is, with the start context recorded so a
 * later drain (or a later server) can start it.
 */
async function createPendingThreadAndAttemptFirstDispatch(
  deps: ThreadCreateDeps,
  args: CreateProvisioningThreadArgs & {
    environmentIntent: ThreadProvisionEnvironmentIntent;
    sendAt: number | undefined;
  },
) {
  const environment =
    args.environmentId === null
      ? null
      : getEnvironment(deps.db, args.environmentId);
  if (environment !== null)
    assertEnvironmentPathAvailable(deps, { ...environment, threadId: null });
  const thread = createThreadRecord(deps, {
    request: args.request,
    environmentId: args.environmentId,
  });
  let execution: Awaited<ReturnType<typeof buildExecutionOptions>>;
  try {
    const history = args.fork?.history ?? args.importedText?.history ?? null;
    if (history !== null && args.request.visibility === "visible") {
      copyForkSourceHistory(deps, { fork: thread, history });
    }
    if (args.importedText) recordTextImport(deps, thread, args.importedText.seed);
    if (args.deferFork && args.fork !== null) {
      recordImportFork(
        deps,
        thread,
        args.fork.descriptor.sourceProviderThreadId,
      );
    }
    const executionPlanArgs = {
      projectDefaults: args.executionDefaults,
      hostId: hostIdForEnvironmentIntent(deps, args.environmentIntent),
      threadId: thread.id,
    };
    execution = await buildExecutionOptions(
      deps,
      args.request,
      executionPlanArgs,
    );
    const startContext: PendingThreadStartContext = {
      environmentIntent: args.environmentIntent,
      fork: args.deferFork ? null : (args.fork?.descriptor ?? null),
      ...(args.providerInput !== undefined
        ? { providerInput: args.providerInput }
        : {}),
      ...(args.deferFork ? { seedWithoutRun: true } : {}),
      startedOnBehalfOf: args.request.startedOnBehalfOf,
      titleProvided: Boolean(args.request.title),
    };
    const placementHostId = hostIdForEnvironmentIntent(
      deps,
      args.environmentIntent,
    );
    if (placementHostId !== null)
      requireEnvironmentPlacementHost(deps, placementHostId);
    setThreadStartupContext(deps.db, {
      threadId: thread.id,
      startupContext: JSON.stringify({ kind: "pending", ...startContext }),
    });

    await attemptDispatch(deps, {
      thread,
      payload: {
        input: args.request.input,
        mode: "start",
        model: execution.model,
        reasoningLevel: execution.reasoningLevel,
        serviceTier: execution.serviceTier,
        permissionMode: execution.permissionMode,
        ...(args.request.executionInputSources !== undefined
          ? { executionInputSources: args.request.executionInputSources }
          : {}),
        ...(args.sendAt !== undefined ? { sendAt: args.sendAt } : {}),
      },
      source: { kind: "inline" },
      queuePayload: { kind: "inline" },
      pluginSubmission: args.request.pluginSubmission ?? null,
      startContext,
      executionDefaults: executionPlanArgs,
      origin: args.request.origin,
      originPluginId: args.request.originPluginId ?? null,
      startedOnBehalfOf: args.request.startedOnBehalfOf,
      trigger: "user",
    });
  } catch (error) {
    emitPluginThreadDeleted({
      ...thread,
      deletedAt: Date.now(),
      updatedAt: Date.now(),
    });
    deleteThread(deps.db, deps.hub, thread.id);
    throw error;
  }
  rememberProjectExecutionDefaultsForCreate(deps, {
    execution,
    request: args.request,
  });
  return getThreadSafe(deps, thread.id);
}

interface ResolveCreateThreadVisibilityArgs {
  parentThread: Pick<Thread, "visibility"> | null;
  requestedVisibility: ThreadVisibility | undefined;
}

function resolveCreateThreadVisibility(
  args: ResolveCreateThreadVisibilityArgs,
): ThreadVisibility {
  if (args.requestedVisibility !== undefined) {
    return args.requestedVisibility;
  }
  return args.parentThread?.visibility ?? "visible";
}

function resolveCreateThreadPluginMetadata(
  request: Pick<
    ThreadCreateServiceRequestInput,
    "originPluginId" | "pluginMetadata"
  >,
): ThreadCreateServiceRequest["pluginMetadata"] {
  if (request.pluginMetadata === undefined) {
    return null;
  }
  if (request.originPluginId === undefined) {
    throw new ApiError(
      400,
      "invalid_request",
      'pluginMetadata requires origin "plugin"',
    );
  }
  return {
    pluginId: request.originPluginId,
    metadata: request.pluginMetadata,
  };
}

export async function createThreadFromRequest(
  deps: ThreadCreateDeps,
  rawRequestInput: ThreadCreateServiceRequestInput,
  options: {
    providerInput?: ThreadCreateServiceRequestInput["input"];
    forkSourceEnvironmentId?: string;
    freshFork?: true;
    importedFork?: ThreadForkPoint;
    importedText?: ImportedText;
    forkPoint?: ThreadForkPoint;
  } = {},
) {
  const project = requirePublicProjectForThreadCreate(
    deps,
    rawRequestInput.projectId,
  );
  const sourceId = rawRequestInput.sourceThreadId ?? rawRequestInput.parentThreadId;
  const source = sourceId ? getThread(deps.db, sourceId) : null;
  const cloudChild = source !== null && isCloudThread(source) && !rawRequestInput.sourceThreadId && !rawRequestInput.originKind;
  const cloudSourceFork = source !== null && isCloudThread(source) && rawRequestInput.originKind === "fork" && Boolean(rawRequestInput.sourceThreadId);
  const localFork = cloudSourceFork && rawRequestInput.executionTarget !== "cloud" && (rawRequestInput.executionTarget === "local" || rawRequestInput.environment.type !== "project-default");
  const cloudFork = cloudSourceFork && !localFork;
  const toCloud = rawRequestInput.executionTarget === "cloud" || (cloudSourceFork && !localFork);
  const textFork = source !== null && rawRequestInput.originKind === "fork" && Boolean(rawRequestInput.sourceThreadId) && !options.importedText && (
    (rawRequestInput.providerId !== undefined && rawRequestInput.providerId !== source.providerId) ||
    (toCloud && rawRequestInput.model !== undefined && rawRequestInput.model !== forkModel(deps, source.id)) ||
    (toCloud && !FORK_HARNESSES.includes(source.providerId)));
  if (source !== null && textFork && rawRequestInput.sourceThreadId) {
    if (toCloud && rawRequestInput.input.length === 0) {
      throw new ApiError(400, "invalid_request", "A Cloud fork needs a first message");
    }
    requireLiveSourceThread(deps, { projectId: rawRequestInput.projectId, sourceThreadId: source.id });
    assertValidParentThread(deps, { parentThreadId: source.id, cloudChild: isCloudThread(source) });
    const { endSequence } = forkTurn(deps.db, source.id, rawRequestInput.sourceSeqEnd);
    const cleared = getLatestCompletedThreadContextClearSequence(deps.db, { threadId: source.id });
    const seed = await messagesSeed(
      deps.config.dataDir,
      source.projectId,
      threadMessages(deps.db, source.id, { ...(cleared != null && cleared < endSequence ? { after: cleared } : {}), before: endSequence + 1 }),
      (rawRequestInput.providerId ?? source.providerId) === source.providerId
        ? `[Cloudroom] This conversation was forked from another thread. You are continuing it in a fresh ${source.providerId} session.`
        : `[Cloudroom] This conversation was forked from a thread with another agent (${source.providerId}). You are now continuing it as ${rawRequestInput.providerId}.`,
    );
    if (toCloud) {
      const { sourceSeqEnd: _sourceSeqEnd, ...cloudRequest } = rawRequestInput;
      const sameHarness = (rawRequestInput.providerId ?? source.providerId) === source.providerId;
      const model = rawRequestInput.model ?? (sameHarness ? forkModel(deps, source.id) : undefined);
      const thread = await cloudroom(deps).create({ ...cloudRequest, providerId: rawRequestInput.providerId ?? source.providerId, ...(model ? { model } : {}), origin: rawRequestInput.origin ?? "sdk", originKind: "fork", environment: { type: "project-default" }, input: [...seed, ...rawRequestInput.input] }, false, { sourceThreadId: source.id, endSequence });
      deps.telemetry.capture({ name: "thread_created", properties: { execution: cloudExecution(deps, thread.id), is_child_thread: false, provider: thread.providerId } });
      return thread;
    }
    const code = isCloudThread(source) ? await prepareLocalForkCode(deps as AppDeps, source, null, rawRequestInput.environment) : null;
    return createThreadFromRequest(deps, {
      ...rawRequestInput,
      executionTarget: "local",
      environment: code?.environment ?? rawRequestInput.environment,
      input: code && rawRequestInput.input.length > 0 ? [code.note, ...rawRequestInput.input] : rawRequestInput.input,
    }, { ...options, importedText: { history: { kind: "thread", sourceThreadId: source.id, endSequence }, seed } });
  }
  if (localFork && !options.forkPoint && !options.importedText) {
    requireLiveSourceThread(deps, { projectId: rawRequestInput.projectId, sourceThreadId: source.id });
    assertValidParentThread(deps, { parentThreadId: source.id, cloudChild: true });
    if (!deps.providerRegistry.supportsFork(source.providerId)) {
      throw new ApiError(400, "invalid_request", `Provider ${source.providerId} does not support thread forks on this ${COMPUTER}`);
    }
    const prepared = await prepareLocalFork(deps as AppDeps, source, { environment: rawRequestInput.environment, ...(rawRequestInput.sourceSeqEnd === undefined ? {} : { sourceSeqEnd: rawRequestInput.sourceSeqEnd }) });
    return createThreadFromRequest(deps, {
      ...rawRequestInput,
      executionTarget: "local",
      environment: prepared.environment,
      input: rawRequestInput.input.length > 0 ? [prepared.note, ...rawRequestInput.input] : rawRequestInput.input,
    }, { ...options, forkPoint: prepared.fork });
  }
  if (source && isCloudThread(source) && !cloudChild && !cloudSourceFork) {
    throw new ApiError(409, "cloudroom_unsupported", "Only forks and child threads can start from a Cloud thread; native fallback is blocked.");
  }
  if (rawRequestInput.executionTarget === "cloud" || cloudChild || cloudFork) {
    const thread = await cloudroom(deps).create({ ...rawRequestInput, origin: rawRequestInput.origin ?? "sdk", originKind: rawRequestInput.originKind ?? null });
    // Cloud threads count in the same anonymous usage events as local ones, tagged with where they run.
    const execution = cloudExecution(deps, thread.id);
    const isChildThread = thread.parentThreadId !== null;
    deps.telemetry.capture({ name: "thread_created", properties: { execution, is_child_thread: isChildThread, provider: thread.providerId } });
    if (rawRequestInput.input.length > 0) captureUserMessageSentTelemetry(deps, { execution, isChildThread, messageSource: "thread_create", providerId: thread.providerId, threadId: thread.id });
    return thread;
  }
  if (rawRequestInput.origin === "plugin") {
    if (rawRequestInput.originPluginId === undefined) {
      throw new ApiError(
        400,
        "invalid_request",
        'originPluginId is required when origin is "plugin"',
      );
    }
  } else if (rawRequestInput.originPluginId !== undefined) {
    throw new ApiError(
      400,
      "invalid_request",
      'originPluginId requires origin "plugin"',
    );
  }
  const pluginMetadata = resolveCreateThreadPluginMetadata(rawRequestInput);
  const requestInput = { ...rawRequestInput };
  requestInput.input = (
    await appendPluginMentionContext({ input: requestInput.input })
  ).input;
  assertProjectWorkspaceCompatibility(project, requestInput);
  const { environment } = requestInput;
  const checkoutHostId =
    environment.type === "provider" && environment.machine?.type === "existing"
      ? environment.machine.hostId
      : environment.type === "host" &&
          environment.workspace.type !== "personal" &&
          !(
            environment.workspace.type === "unmanaged" &&
            environment.workspace.path !== null
          )
        ? environment.hostId
        : undefined;
  if (checkoutHostId !== undefined) {
    await ensureProjectCheckoutForThread(deps, {
      project,
      hostId: checkoutHostId,
    });
  }
  const originKind = requestInput.originKind ?? null;
  const sourceThreadId =
    requestInput.sourceThreadId ??
    (originKind !== null ? requestInput.parentThreadId : undefined);
  const hierarchyParentThreadId =
    originKind === null ? requestInput.parentThreadId : undefined;
  const parentThread = hierarchyParentThreadId
    ? assertValidParentThread(deps, {
        parentThreadId: hierarchyParentThreadId,
      })
    : null;
  if (originKind === null && sourceThreadId !== undefined) {
    throw new ApiError(
      400,
      "invalid_request",
      "sourceThreadId requires an originKind",
    );
  }
  if (originKind === null && requestInput.sourceSeqEnd !== undefined) {
    throw new ApiError(
      400,
      "invalid_request",
      "sourceSeqEnd requires an originKind",
    );
  }
  const sourceThread = sourceThreadId
    ? requireLiveSourceThread(deps, {
        projectId: requestInput.projectId,
        sourceThreadId,
      })
    : null;
  if (originKind !== null && sourceThread !== null) {
    assertValidParentThread(deps, {
      parentThreadId: sourceThread.id,
      cloudChild: options.forkPoint !== undefined || options.importedText !== undefined,
    });
  }
  if (originKind !== null && sourceThread === null) {
    throw new ApiError(
      400,
      "invalid_request",
      "originKind requires a sourceThreadId",
    );
  }
  const forkSourceEnvironmentId =
    options.forkSourceEnvironmentId ??
    (originKind === "fork" &&
    sourceThread !== null &&
    sourceThread.environmentId !== null &&
    requestInput.environment.type === "reuse" &&
    requestInput.environment.environmentId === sourceThread.environmentId
      ? sourceThread.environmentId
      : undefined);
  if (requestInput.startedOnBehalfOf !== null) {
    const senderThread = sourceThread ?? parentThread;
    if (senderThread === null) {
      throw new ApiError(
        400,
        "invalid_request",
        "startedOnBehalfOf requires a sourceThreadId or parentThreadId",
      );
    }
    if (requestInput.startedOnBehalfOf.senderThreadId !== senderThread.id) {
      throw new ApiError(
        400,
        "invalid_request",
        sourceThread === null
          ? "startedOnBehalfOf.senderThreadId must match parentThreadId"
          : "startedOnBehalfOf.senderThreadId must match sourceThreadId",
      );
    }
  }
  await validatePromptAttachmentReferences({
    dataDir: deps.config.dataDir,
    input: requestInput.input,
    projectId: requestInput.projectId,
  });
  await deps.providerRegistry.whenRegistrationsSettled();
  // A typo like `--provider claude` used to spawn threads that all failed
  // later at setup (feedback #369).
  if (requestInput.providerId !== undefined) {
    await deps.providerRegistry.whenProviderRegistered(requestInput.providerId);
    if (deps.providerRegistry.get(requestInput.providerId) === null) {
      const known = deps.providerRegistry
        .list()
        .map((entry) => entry.info.id)
        .join(", ");
      throw new ApiError(
        400,
        "invalid_request",
        `Unknown provider "${requestInput.providerId}". Use one of: ${known}.`,
      );
    }
  }
  const {
    executionDefaults,
    providerId,
    providerFallbackCandidates,
    requestedModel,
  } = resolveProjectExecutionDefaultsForCreate(deps, {
    executionInputSources: requestInput.executionInputSources,
    model: requestInput.model,
    projectId: requestInput.projectId,
    providerId: requestInput.providerId,
  });
  const {
    originKind: _requestedOriginKind,
    parentThreadId: _requestedParentThreadId,
    pluginMetadata: _requestedPluginMetadata,
    sourceThreadId: _requestedSourceThreadId,
    ...requestRest
  } = requestInput;
  const requestedEnvironment = await resolveCreateThreadEnvironment(deps, {
    parentThread:
      forkSourceEnvironmentId !== undefined || options.forkPoint !== undefined || options.importedText !== undefined
        ? null
        : (sourceThread ?? parentThread),
    projectId: requestInput.projectId,
    requestedEnvironment: requestInput.environment,
  });
  if (
    requestedEnvironment.type === "provider" &&
    getEnvironmentProvider(requestedEnvironment.environmentProviderId) ===
      undefined &&
    !listEnvironmentCompositions().some(
      (record) =>
        record.composition.id === requestedEnvironment.environmentProviderId,
    )
  ) {
    throw new ApiError(400, "invalid_request", "unknown environment provider");
  }
  const request: ThreadCreateServiceRequest = {
    ...requestRest,
    ...(hierarchyParentThreadId
      ? { parentThreadId: hierarchyParentThreadId }
      : {}),
    ...(sourceThread ? { sourceThreadId: sourceThread.id } : {}),
    originKind,
    pluginMetadata,
    visibility: resolveCreateThreadVisibility({
      parentThread,
      requestedVisibility: requestInput.visibility,
    }),
    environment: requestedEnvironment,
    providerId,
    titleFallback: deriveTitleFallback(requestInput.input),
  };
  const resolvedEnvironment =
    requestedEnvironment.type === "provider"
      ? null
      : resolveStableThreadRequestEnvironment(deps, {
          allowUnmanagedPersonalProjectReuseEnvironmentId:
            forkSourceEnvironmentId,
          environment: requestedEnvironment,
          projectId: request.projectId,
        });
  const childHostId =
    resolvedEnvironment !== null
      ? childHostIdForResolvedEnvironment(resolvedEnvironment)
      : request.environment.type === "provider"
        ? request.environment.machine?.type === "existing"
          ? request.environment.machine.hostId
          : null
        : null;
  assertForkSourceHost(deps, {
    childHostId,
    originKind: request.originKind ?? null,
    sourceThread,
  });
  if (childHostId !== null) {
    await ensureHostSessionReadyForWork(deps, { hostId: childHostId });
  }
  const modelCatalogCwd =
    resolvedEnvironment !== null
      ? modelCatalogCwdForResolvedEnvironment(resolvedEnvironment)
      : request.environment.type === "provider" &&
          request.environment.machine?.type === "existing"
        ? projectCheckoutPathOnHost(
            deps,
            request.projectId,
            request.environment.machine.hostId,
          )
        : undefined;
  const resolvedExecutionDefaults = await resolveCatalogExecutionDefaults(
    deps,
    {
      ...(modelCatalogCwd !== undefined ? { cwd: modelCatalogCwd } : {}),
      executionDefaults,
      hostId: childHostId,
      providerId,
      providerFallbackCandidates,
      requestedModel,
    },
  );
  if (
    resolvedExecutionDefaults !== null &&
    resolvedExecutionDefaults.providerId !== request.providerId
  ) {
    if (options.importedFork || options.importedText) {
      throw new ApiError(
        409,
        "import_provider_unavailable",
        `Provider ${request.providerId} is unavailable for this import`,
      );
    }
    request.providerId = resolvedExecutionDefaults.providerId;
  }

  const { environmentId, environmentIntent } =
    await resolveThreadEnvironmentPlacement(deps, {
      ...(forkSourceEnvironmentId !== undefined
        ? {
            allowUnmanagedPersonalProjectReuseEnvironmentId:
              forkSourceEnvironmentId,
          }
        : {}),
      projectId: request.projectId,
      requestedEnvironment: request.environment,
    });

  const fork = options.freshFork
    ? null
    : (options.importedFork ??
    options.forkPoint ??
    (options.importedText ? null : resolveForkPoint(deps, {
      originKind: request.originKind ?? null,
      providerId: request.providerId,
      sourceSeqEnd: request.sourceSeqEnd,
      sourceThread,
    })));

  if (request.originKind !== null && fork === null && !options.importedText && !options.freshFork) {
    throw new ApiError(
      400,
      "fork_source_session_unavailable",
      "Cannot fork: source has no active session to clone",
    );
  }

  const createArgs = {
    deferFork:
      options.importedFork !== undefined ||
      (options.importedText !== undefined && request.originKind !== "fork"),
    environmentId,
    environmentIntent,
    executionDefaults: resolvedExecutionDefaults,
    fork,
    ...(options.importedText !== undefined
      ? { importedText: options.importedText }
      : {}),
    ...(options.providerInput !== undefined
      ? { providerInput: options.providerInput }
      : {}),
    request,
  };
  const thread = await createPendingThreadAndAttemptFirstDispatch(deps, {
    ...createArgs,
    sendAt: request.sendAt,
  });
  deps.telemetry.capture({
    name: "thread_created",
    properties: {
      execution: "local",
      is_child_thread: parentThread !== null,
      provider: request.providerId,
    },
  });
  if (
    (request.startedOnBehalfOf?.initiator ?? "user") === "user" &&
    request.input.length > 0
  ) {
    captureUserMessageSentTelemetry(deps, {
      isChildThread: parentThread !== null,
      messageSource: "thread_create",
      providerId: request.providerId,
      threadId: thread.id,
    });
  }
  return thread;
}
