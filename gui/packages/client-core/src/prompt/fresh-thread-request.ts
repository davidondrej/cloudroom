import type { Thread } from "@cloudroom/domain";
import type { AppCreateThreadRequest } from "../api-types.js";
import type { FollowUpExecutionSelection } from "./threadDetailPromptSubmission.js";

const CONTINUE_PREFIX = "Continue from ";
const CONTINUE_REST =
  ". Its context was getting full, so this is a fresh start. Read that thread with room-cli first, then pick up where it left off. If nothing was in progress, say where things stand and wait.";

/**
 * "Fresh thread" on the context card: a new thread in the same folder, with the
 * same agent, model, name, and sidebar section, whose first message points the
 * agent at the thread that ran out of context. Null until a model is known.
 */
export function buildFreshThreadRequest({
  thread,
  providerId,
  execution,
}: {
  thread: Pick<
    Thread,
    "id" | "projectId" | "environmentId" | "title" | "titleFallback" | "sectionId"
  >;
  providerId: string;
  execution: FollowUpExecutionSelection;
}): AppCreateThreadRequest | null {
  if (execution === null || execution.model.length === 0) return null;
  const mention = `@thread:${thread.id}`;
  const serviceTier = execution.supportsServiceTier
    ? execution.serviceTier
    : undefined;
  return {
    projectId: thread.projectId,
    providerId,
    environment:
      thread.environmentId === null
        ? { type: "project-default" }
        : { type: "reuse", environmentId: thread.environmentId },
    input: [
      {
        type: "text",
        text: `${CONTINUE_PREFIX}${mention}${CONTINUE_REST}`,
        mentions: [
          {
            start: CONTINUE_PREFIX.length,
            end: CONTINUE_PREFIX.length + mention.length,
            resource: {
              kind: "thread",
              projectId: thread.projectId,
              threadId: thread.id,
              label: thread.title ?? thread.titleFallback ?? mention,
            },
          },
        ],
      },
    ],
    ...(thread.title ? { title: thread.title } : {}),
    ...(thread.sectionId ? { sectionId: thread.sectionId } : {}),
    model: execution.model,
    reasoningLevel: execution.reasoningLevel,
    permissionMode: execution.permissionMode,
    ...(serviceTier ? { serviceTier } : {}),
    executionInputSources: {
      providerId: "explicit",
      model: "explicit",
      reasoningLevel: "explicit",
      permissionMode: "explicit",
      ...(serviceTier ? { serviceTier: "explicit" as const } : {}),
    },
  };
}
