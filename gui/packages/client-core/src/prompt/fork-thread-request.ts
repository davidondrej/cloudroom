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
  providerSupportsFork: boolean;
}

type ForkableThread = Pick<
  Thread,
  "archivedAt" | "environmentId" | "executionTarget" | "providerId"
>;

/** The harnesses a Cloud thread can fork (the server's FORK_HARNESSES). */
const CLOUD_FORK_PROVIDERS = new Set(["claude-code", "codex"]);

export function isThreadForkable(
  sourceThread: ForkableThread | null,
  providerSupportsFork: boolean,
): boolean {
  if (sourceThread === null || sourceThread.archivedAt !== null) {
    return false;
  }
  if (sourceThread.executionTarget === "cloud") {
    return CLOUD_FORK_PROVIDERS.has(sourceThread.providerId);
  }
  return sourceThread.environmentId !== null && providerSupportsFork;
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
  providerSupportsFork,
  reasoningLevel,
  requestId,
  serviceTier,
  sourceSeqEnd,
  sourceThreadId,
}: BuildForkThreadRequestArgs): AppCreateThreadRequest | null {
  const cloud = executionTarget === "cloud";
  if (!cloud && !providerSupportsFork) {
    return null;
  }

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
