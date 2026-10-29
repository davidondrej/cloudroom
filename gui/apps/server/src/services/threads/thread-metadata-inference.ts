import {
  appSettingsValues,
  getThread,
  type DbConnection,
  type DbTransaction,
} from "@cloudroom/db";
import {
  promptInputSchema,
  type PromptInput,
  type ProvisioningTranscriptEntry,
} from "@cloudroom/domain";
import { eq, like } from "drizzle-orm";
import { z } from "zod";
import type { LoggedWorkSessionDeps } from "../../types.js";
import type { CommandResultSideEffectsDeps } from "../../internal/command-result-side-effects.js";
import { appendThreadProvisioningEvent } from "./thread-events.js";
import {
  applyGeneratedThreadTitle,
  cleanPromptText,
  generateThreadMetadataWithOutcome,
  type ThreadMetadataGenerationOutcome,
} from "./title-generation.js";
import { runtimeErrorLogFields } from "../lib/error-log-fields.js";
import { INFERENCE_POLICY } from "../ai/inference.js";
import { noteGeneratedTitle } from "./title-recheck.js";
import { noteFirstThreadMessage } from "./thread-purpose.js";
import { syncGeneratedTitleToProvider } from "./thread-commands.js";

const TITLE_RETRY_PREFIX = "threadTitleRetry:";
const TITLE_RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 120_000, 300_000];
const pendingTitleSchema = z.object({
  input: z.array(promptInputSchema),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.number(),
});
type PendingTitle = z.infer<typeof pendingTitleSchema>;
const inFlight = new WeakMap<
  DbConnection,
  Map<string, Promise<ThreadMetadataInferenceResult>>
>();

function readPendingTitle(
  db: DbConnection,
  threadId: string,
): PendingTitle | null {
  const row = db
    .select()
    .from(appSettingsValues)
    .where(eq(appSettingsValues.key, TITLE_RETRY_PREFIX + threadId))
    .get();
  return row ? pendingTitleSchema.parse(JSON.parse(row.value)) : null;
}

export function cancelThreadTitleRetry(
  db: DbConnection,
  threadId: string,
): void {
  db.delete(appSettingsValues)
    .where(eq(appSettingsValues.key, TITLE_RETRY_PREFIX + threadId))
    .run();
}

export function queueThreadTitle(
  db: DbConnection | DbTransaction,
  threadId: string,
  input: PromptInput[],
): void {
  const thread = getThread(db, threadId);
  if (
    !thread ||
    thread.title !== null ||
    thread.deletedAt !== null ||
    thread.archivedAt !== null
  )
    return;
  const text =
    cleanPromptText(input) ||
    input
      .filter((part) => part.type !== "text")
      .map((part) =>
        part.type === "image"
          ? "image attachment"
          : `${part.type === "localImage" ? "image" : "file"} attachment: ${part.path.split(/[\\/]/u).pop()}`,
      )
      .join(" ") ||
    "New conversation";
  db.insert(appSettingsValues)
    .values({
      key: TITLE_RETRY_PREFIX + threadId,
      value: JSON.stringify({
        input: [{ type: "text", text, mentions: [] }],
        attempts: 0,
        nextAttemptAt: 0,
      }),
      updatedAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
}

function savePendingTitle(
  db: DbConnection,
  threadId: string,
  pending: PendingTitle,
): void {
  db.update(appSettingsValues)
    .set({ value: JSON.stringify(pending), updatedAt: Date.now() })
    .where(eq(appSettingsValues.key, TITLE_RETRY_PREFIX + threadId))
    .run();
}

export function sweepThreadTitleRetries(
  deps: CommandResultSideEffectsDeps,
  now = Date.now(),
): void {
  const rows = deps.db
    .select()
    .from(appSettingsValues)
    .where(like(appSettingsValues.key, `${TITLE_RETRY_PREFIX}%`))
    .orderBy(appSettingsValues.updatedAt)
    .all();
  for (const row of rows) {
    const threadId = row.key.slice(TITLE_RETRY_PREFIX.length);
    const thread = getThread(deps.db, threadId);
    if (
      !thread ||
      thread.title !== null ||
      thread.deletedAt !== null ||
      thread.archivedAt !== null
    ) {
      cancelThreadTitleRetry(deps.db, threadId);
      continue;
    }
    const pending = pendingTitleSchema.parse(JSON.parse(row.value));
    if (pending.nextAttemptAt > now || inFlight.get(deps.db)?.has(threadId))
      continue;
    void inferThreadMetadata(deps, {
      input: pending.input,
      provisioningId: threadId,
      threadId,
      writeTranscript: false,
    })
      .then((metadata) => {
        if (metadata.titleApplied && metadata.title)
          syncGeneratedTitleToProvider(deps, threadId, metadata.title);
      })
      .catch((error: unknown) => {
        deps.logger.warn(
          { threadId, ...runtimeErrorLogFields(deps.config, error) },
          "Thread title retry failed",
        );
      });
    break;
  }
}

interface ThreadMetadataInferenceArgs {
  input: PromptInput[];
  provisioningId: string;
  threadId: string;
  writeTranscript: boolean;
}

interface ThreadMetadataInferenceResult {
  titleApplied: boolean;
  title: string | null;
}

interface MetadataCompletedEntryArgs {
  outcome: ThreadMetadataGenerationOutcome;
  startedAt: number;
}

function metadataCompletedEntry(
  args: MetadataCompletedEntryArgs,
): ProvisioningTranscriptEntry {
  const titleGenerated = Boolean(args.outcome.metadata?.title);
  return {
    type: "step",
    key: "metadata-completed",
    text: titleGenerated ? "Generated title" : "No title generated",
    status: "completed",
    startedAt: args.startedAt,
    metadata: {
      durationMs: args.outcome.durationMs,
      titleGenerated,
      ...(args.outcome.reason ? { reason: args.outcome.reason } : {}),
    },
  };
}

export function inferThreadMetadata(
  deps: LoggedWorkSessionDeps,
  args: ThreadMetadataInferenceArgs,
): Promise<ThreadMetadataInferenceResult> {
  let requests = inFlight.get(deps.db);
  if (!requests) {
    requests = new Map();
    inFlight.set(deps.db, requests);
  }
  const existing = requests.get(args.threadId);
  if (existing) return existing;
  const request = inferPendingThreadMetadata(deps, args).finally(() => {
    requests.delete(args.threadId);
  });
  requests.set(args.threadId, request);
  return request;
}

async function inferPendingThreadMetadata(
  deps: LoggedWorkSessionDeps,
  args: ThreadMetadataInferenceArgs,
): Promise<ThreadMetadataInferenceResult> {
  const startedAt = Date.now();
  const thread = getThread(deps.db, args.threadId);
  if (
    !thread ||
    thread.title !== null ||
    thread.deletedAt !== null ||
    thread.archivedAt !== null
  ) {
    cancelThreadTitleRetry(deps.db, args.threadId);
    return { title: null, titleApplied: false };
  }
  queueThreadTitle(deps.db, args.threadId, args.input);
  const pending = readPendingTitle(deps.db, args.threadId);
  if (!pending || pending.nextAttemptAt > startedAt)
    return { title: null, titleApplied: false };
  pending.attempts += 1;
  pending.nextAttemptAt =
    startedAt +
    (INFERENCE_POLICY.threadMetadata.timeoutMs +
      INFERENCE_POLICY.hostRpcGraceMs) *
      INFERENCE_POLICY.threadMetadata.maxAttempts +
    INFERENCE_POLICY.threadMetadata.retryDelayMs;
  savePendingTitle(deps.db, args.threadId, pending);
  try {
    return await completeThreadMetadata(deps, args, startedAt);
  } finally {
    if (readPendingTitle(deps.db, args.threadId)) {
      const thread = getThread(deps.db, args.threadId);
      if (
        !thread ||
        thread.title !== null ||
        thread.deletedAt !== null ||
        thread.archivedAt !== null
      ) {
        cancelThreadTitleRetry(deps.db, args.threadId);
      } else {
        const delay =
          TITLE_RETRY_DELAYS_MS[
            Math.min(pending.attempts - 1, TITLE_RETRY_DELAYS_MS.length - 1)
          ]!;
        pending.nextAttemptAt = Date.now() + delay;
        savePendingTitle(deps.db, args.threadId, pending);
        deps.logger.info(
          {
            threadId: args.threadId,
            attempts: pending.attempts,
            nextAttemptAt: pending.nextAttemptAt,
          },
          "Thread title retry scheduled",
        );
      }
    }
  }
}

async function completeThreadMetadata(
  deps: LoggedWorkSessionDeps,
  args: ThreadMetadataInferenceArgs,
  startedAt: number,
): Promise<ThreadMetadataInferenceResult> {
  const provisioningId = args.provisioningId;
  if (args.writeTranscript) {
    appendThreadProvisioningEvent(deps, {
      threadId: args.threadId,
      environmentId: null,
      provisioningId,
      status: "active",
      entries: [
        {
          type: "step",
          key: "metadata-started",
          text: "Generating title",
          status: "started",
          startedAt,
        },
      ],
    });
  }

  const outcome = await generateThreadMetadataWithOutcome(deps, {
    input: readPendingTitle(deps.db, args.threadId)?.input ?? args.input,
    threadId: args.threadId,
    timeoutMaxAttempts: INFERENCE_POLICY.threadMetadata.maxAttempts,
    timeoutMs: INFERENCE_POLICY.threadMetadata.timeoutMs,
  });

  if (args.writeTranscript) {
    appendThreadProvisioningEvent(deps, {
      threadId: args.threadId,
      environmentId: null,
      provisioningId,
      status: "active",
      entries: [metadataCompletedEntry({ outcome, startedAt })],
    });
  }

  let titleApplied = false;
  if (outcome.metadata?.title && readPendingTitle(deps.db, args.threadId)) {
    try {
      titleApplied = applyGeneratedThreadTitle(deps, {
        threadId: args.threadId,
        title: outcome.metadata.title,
      });
      if (titleApplied) {
        noteGeneratedTitle(args.threadId, outcome.metadata.title, args.input);
        noteFirstThreadMessage(args.threadId, cleanPromptText(args.input));
      }
    } catch (error) {
      deps.logger.warn(
        {
          threadId: args.threadId,
          ...runtimeErrorLogFields(deps.config, error),
        },
        "Failed to apply generated thread title",
      );
    }
  }

  return {
    title: outcome.metadata?.title ?? null,
    titleApplied,
  };
}
