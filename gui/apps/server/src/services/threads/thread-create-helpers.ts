import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  createThread,
  events,
  getEnvironment,
  getThreadSectionById,
  getProjectSourceByHost,
  getProject,
  getThread,
  isSqliteForeignKeyConstraint,
  queuedThreadMessages,
} from "@cloudroom/db";
import type { DbNotifier } from "@cloudroom/db";
import type { HostDaemonCommand } from "@cloudroom/host-daemon-contract";
import {
  GENERATED_ID_ALPHABET,
  GENERATED_ID_SUFFIX_LENGTH,
  type LocalPathProjectSource,
  type PromptInput,
  type Thread,
} from "@cloudroom/domain";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { emitPluginThreadCreated } from "../plugins/plugin-thread-events.js";
import { uploadedAttachmentName } from "../projects/attachments.js";
import type {
  ThreadCreateServiceRequest,
  ThreadCreateServiceRequestInput,
} from "./thread-create-request.js";
import { sanitizeGeneratedBranchSlug } from "./title-generation.js";
import { queueThreadTitle } from "./thread-metadata-inference.js";

type EnvironmentProvisionCommand = Extract<
  HostDaemonCommand,
  { type: "environment.attach" }
>;
type EnvironmentProvisionCommandInitiator =
  EnvironmentProvisionCommand["initiator"];

interface SuggestedBranchNameArgs {
  branchPrefix: string;
  title: string | null;
  threadId: string;
}

/** Local and Cloud share one shape: <prefix><title-slug>-<last 4 chars of the thread ID> (docs/scopes/sandboxes.md). */
export function buildSuggestedBranchName(
  args: SuggestedBranchNameArgs,
): string {
  const branchSlug =
    (args.title === null ? null : sanitizeGeneratedBranchSlug(args.title)) ??
    "task";
  return `${args.branchPrefix}${branchSlug}-${args.threadId.replace(/^thr_/, "").slice(-4)}`;
}

export function requirePublicProjectForThreadCreate(
  deps: Pick<AppDeps, "db">,
  projectId: string,
) {
  const project = getProject(deps.db, projectId);
  if (!project || project.deletedAt !== null) {
    throw new ApiError(404, "project_not_found", "Project not found");
  }
  return project;
}

export function requireSourceForHost(
  deps: Pick<AppDeps, "db">,
  projectId: string,
  hostId: string,
): LocalPathProjectSource {
  const source = getProjectSourceByHost(deps.db, projectId, hostId);
  if (!source || source.type !== "local_path") {
    throw new ApiError(
      409,
      "invalid_request",
      "No project source configured for this host",
    );
  }
  return source;
}

interface EnvironmentProvisionCommandArgs {
  environmentId: string;
  hostId: string;
  initiator: EnvironmentProvisionCommandInitiator;
  path: string;
  setupScriptTimeoutMs: number | null;
}

export function buildEnvironmentProvisionCommand(
  args: EnvironmentProvisionCommandArgs,
): EnvironmentProvisionCommand {
  return {
    type: "environment.attach" as const,
    contributedEnv: [],
    environmentId: args.environmentId,
    initiator: args.initiator,
    path: args.path,
    setupScriptTimeoutMs: args.setupScriptTimeoutMs,
  };
}

/** A Local spawn's request ID names its thread within its project, so a retry
 *  after an unanswered request finds that thread instead of a duplicate (#860). */
export function requestThreadId(projectId: string, requestId: string): string {
  const digest = createHash("sha256")
    .update(`spawn:${projectId}:${requestId}`)
    .digest();
  const suffix = [...digest.subarray(0, GENERATED_ID_SUFFIX_LENGTH)].map(
    (byte) => GENERATED_ID_ALPHABET[byte % GENERATED_ID_ALPHABET.length],
  );
  return `thr_${suffix.join("")}`;
}

/** What a spawn asked for. A missing field was not given, so it never conflicts. */
export type SpawnIntent = Partial<
  Record<
    | "environmentId"
    | "hostId"
    | "model"
    | "parentId"
    | "prompt"
    | "providerId"
    | "reasoningLevel",
    string | null
  >
>;

/** The full visible prompt. A re-upload gets a new path, so files count by their uploaded name. */
function promptKey(input: readonly PromptInput[]): string | undefined {
  const parts = input
    .filter((part) => part.visibility !== "agent-only")
    .map((part) =>
      part.type === "text"
        ? part.text.trim()
        : `[${part.type} ${part.type === "image" ? part.url : uploadedAttachmentName(part.path)}]`,
    );
  return parts.join("\n").trim() || undefined;
}

export function spawnIntent(
  request: ThreadCreateServiceRequestInput,
): SpawnIntent {
  const { environment } = request;
  return {
    prompt: promptKey(request.input),
    providerId: request.providerId,
    model: request.model,
    reasoningLevel: request.reasoningLevel,
    hostId:
      environment.type === "host"
        ? environment.hostId
        : environment.type === "provider" &&
            environment.machine?.type === "existing"
          ? environment.machine.hostId
          : undefined,
    environmentId:
      environment.type === "reuse" ? environment.environmentId : undefined,
    parentId: request.originKind
      ? (request.sourceThreadId ?? request.parentThreadId)
      : request.parentThreadId,
  };
}

/** What the thread saved. A canceled scheduled first message leaves only the thread's own fields. */
export function savedSpawnIntent(
  deps: Pick<AppDeps, "db">,
  thread: Thread,
): SpawnIntent {
  const turn = deps.db
    .select({ data: events.data })
    .from(events)
    .where(
      and(
        eq(events.threadId, thread.id),
        eq(events.type, "client/turn/requested"),
      ),
    )
    .orderBy(asc(events.sequence))
    .limit(1)
    .get();
  const queued = turn
    ? undefined
    : deps.db
        .select()
        .from(queuedThreadMessages)
        .where(eq(queuedThreadMessages.threadId, thread.id))
        .orderBy(asc(queuedThreadMessages.createdAt))
        .limit(1)
        .get();
  const first: {
    input?: PromptInput[];
    execution?: { model?: string; reasoningLevel?: string };
  } | null = turn
    ? JSON.parse(turn.data)
    : queued
      ? { input: JSON.parse(queued.content), execution: queued }
      : null;
  // A fork's first saved turn may be its source's copied history.
  const fork = thread.originKind !== null;
  return {
    prompt: fork ? undefined : promptKey(first?.input ?? []),
    providerId: thread.providerId,
    model: fork ? undefined : first?.execution?.model,
    reasoningLevel: fork ? undefined : first?.execution?.reasoningLevel,
    hostId:
      thread.environmentId === null
        ? undefined
        : getEnvironment(deps.db, thread.environmentId)?.hostId,
    environmentId: thread.environmentId ?? undefined,
    parentId: (fork ? thread.sourceThreadId : thread.parentThreadId) ?? null,
  };
}

export function spawnConflicts(
  retry: SpawnIntent,
  first: SpawnIntent,
): boolean {
  return Object.entries(retry).some(([key, value]) => {
    const saved = first[key as keyof SpawnIntent];
    return value !== undefined && saved !== undefined && value !== saved;
  });
}

export function requestConflict(message = "with different content"): ApiError {
  return new ApiError(
    409,
    "request_conflict",
    `Request ID was already used ${message}`,
  );
}

export function createThreadRecord(
  deps: Pick<AppDeps, "db"> & { hub: DbNotifier },
  args: {
    environmentId: string | null;
    request: ThreadCreateServiceRequest;
    createdAt?: number;
    latestAttentionAt?: number;
  },
) {
  const sectionId = args.request.sectionId ?? null;
  if (sectionId !== null && !getThreadSectionById(deps.db, sectionId)) {
    throw new ApiError(404, "section_not_found", "Section not found");
  }

  try {
    const thread = createThread(deps.db, deps.hub, {
      ...(args.request.requestId
        ? {
            id: requestThreadId(args.request.projectId, args.request.requestId),
          }
        : {}),
      projectId: args.request.projectId,
      environmentId: args.environmentId,
      providerId: args.request.providerId,
      title: args.request.title ?? null,
      titleFallback: args.request.titleFallback,
      sectionId,
      parentThreadId: args.request.parentThreadId ?? null,
      sourceThreadId: args.request.sourceThreadId ?? null,
      originKind: args.request.originKind,
      originPluginId: args.request.originPluginId ?? null,
      pluginMetadata: args.request.pluginMetadata,
      visibility: args.request.visibility,
      createdAt: args.createdAt,
      latestAttentionAt: args.latestAttentionAt,
      // Every thread starts `pending`, with no exception to parameterise.
      // Creation is unhooked and provisions nothing; admission happens at the
      // first message's dispatch attempt, and clearing it is what moves the
      // thread to `starting`. A caller that could pass `starting` here would
      // be claiming a thread had been admitted before anything decided so.
      status: "pending",
    });
    queueThreadTitle(deps.db, thread.id, args.request.input);
    emitPluginThreadCreated(thread);
    return thread;
  } catch (error) {
    if (
      sectionId !== null &&
      error instanceof Error &&
      isSqliteForeignKeyConstraint(error) &&
      !getThreadSectionById(deps.db, sectionId)
    ) {
      throw new ApiError(404, "section_not_found", "Section not found");
    }
    throw error;
  }
}

export function getThreadSafe(deps: Pick<AppDeps, "db">, threadId: string) {
  const thread = getThread(deps.db, threadId);
  if (!thread) {
    throw new ApiError(500, "internal_error", "Thread was not created");
  }
  return thread;
}
