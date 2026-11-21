import type {
  PermissionMode,
  PromptInput,
  ReasoningLevel,
  ServiceTier,
  Thread,
} from "@cloudroom/domain";
import type { AppCreateThreadRequest } from "../api-types.js";

export const FORK_THREAD_CREATE_SEED_LOCATION_STATE_KEY =
  "forkThreadCreateSeed";

export interface ForkThreadCreateSeed {
  /** Null for a Cloud thread: its fork starts in a new cloud sandbox. */
  environmentId: string | null;
  model: string;
  permissionMode: PermissionMode;
  projectId: string;
  providerId: string;
  reasoningLevel: ReasoningLevel;
  serviceTier: ServiceTier | undefined;
  sourceSeqEnd: number | undefined;
  sourceThreadId: string;
  sourceThreadTitle: string;
}

interface BuildForkThreadRequestArgs extends ForkThreadCreateSeed {
  environment: AppCreateThreadRequest["environment"];
  executionTarget: AppCreateThreadRequest["executionTarget"];
  requestId?: string | undefined;
  input: PromptInput[];
  pluginSubmission: AppCreateThreadRequest["pluginSubmission"];
}

type ForkableThread = Pick<Thread, "archivedAt" | "environmentId" | "executionTarget">;

/** Every harness can fork; the server copies the chat as text when it can't clone the session (ADR 20261121-141157). */
export function isThreadForkable(sourceThread: ForkableThread | null): boolean {
  if (sourceThread === null || sourceThread.archivedAt !== null) {
    return false;
  }
  return sourceThread.executionTarget === "cloud" || sourceThread.environmentId !== null;
}

export function buildForkThreadRequest({
  environment,
  executionTarget,
  input,
  model,
  permissionMode,
  pluginSubmission,
  projectId,
  providerId,
  reasoningLevel,
  requestId,
  serviceTier,
  sourceSeqEnd,
  sourceThreadId,
}: BuildForkThreadRequestArgs): AppCreateThreadRequest {
  const cloud = executionTarget === "cloud";

  return {
    environment: cloud ? { type: "project-default" } : environment,
    executionTarget: cloud ? "cloud" : "local",
    ...(cloud && requestId ? { requestId } : {}),
    input,
    model,
    originKind: "fork",
    permissionMode: cloud ? "full" : permissionMode,
    ...(pluginSubmission === undefined ? {} : { pluginSubmission }),
    projectId,
    providerId,
    reasoningLevel,
    ...(serviceTier ? { serviceTier } : {}),
    ...(sourceSeqEnd !== undefined ? { sourceSeqEnd } : {}),
    sourceThreadId,
    startedOnBehalfOf: null,
  };
}
