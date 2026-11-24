import { randomUUID } from "node:crypto";
import type {
  SystemVoiceTranscriptionJobError,
  SystemVoiceTranscriptionJobResponse,
  SystemVoiceTranscriptionJobStartResponse,
} from "@cloudroom/server-contract";
import { ApiError } from "../../errors.js";
import type { LoggedWorkSessionDeps } from "../../types.js";
import type { AiServiceRegistry } from "./ai-service-registry.js";
import {
  assertValidVoiceAudioFile,
  transcribeVoiceInput,
} from "./voice-transcription.js";

type VoiceJobRecord =
  | {
      id: string;
      clientId?: string;
      status: "pending";
      createdAt: number;
      finishedAt: null;
    }
  | {
      id: string;
      clientId?: string;
      status: "completed";
      text: string;
      createdAt: number;
      finishedAt: number;
    }
  | {
      id: string;
      clientId?: string;
      status: "failed";
      error: SystemVoiceTranscriptionJobError;
      createdAt: number;
      finishedAt: number;
    };

const JOB_TTL_MS = 10 * 60_000;
const JOB_MAX_PENDING_AGE_MS = 15 * 60_000;
const MAX_PENDING_JOBS = 16;

const jobStores = new WeakMap<AiServiceRegistry, Map<string, VoiceJobRecord>>();

function getJobStore(aiServices: AiServiceRegistry): Map<string, VoiceJobRecord> {
  let store = jobStores.get(aiServices);
  if (!store) {
    store = new Map();
    jobStores.set(aiServices, store);
  }
  return store;
}

function sweepJobs(store: Map<string, VoiceJobRecord>, now: number): void {
  for (const [id, job] of store) {
    if (job.finishedAt !== null && now - job.finishedAt >= JOB_TTL_MS) {
      store.delete(id);
    } else if (
      job.finishedAt === null &&
      now - job.createdAt >= JOB_MAX_PENDING_AGE_MS
    ) {
      store.delete(id);
    }
  }
}

function toJobError(error: unknown): SystemVoiceTranscriptionJobError {
  if (error instanceof ApiError) {
    return {
      code: error.body.code,
      message: error.body.message,
      ...(error.body.retryable !== undefined
        ? { retryable: error.body.retryable }
        : {}),
    };
  }
  return {
    code: "transcription_failed",
    message:
      error instanceof Error && error.message.trim().length > 0
        ? error.message
        : "Voice transcription failed",
    retryable: true,
  };
}

/** Starts voice transcription in the background so relayed mobile requests never hit the 30 s HTTP response cap. */
export function startVoiceTranscriptionJob(
  deps: LoggedWorkSessionDeps,
  args: { file: File; prompt?: string; clientId?: string },
): SystemVoiceTranscriptionJobStartResponse {
  assertValidVoiceAudioFile(args.file);
  const store = getJobStore(deps.aiServices);
  const now = Date.now();
  sweepJobs(store, now);

  const clientId =
    args.clientId !== undefined && args.clientId.trim().length > 0
      ? args.clientId.trim().slice(0, 128)
      : undefined;
  if (clientId !== undefined) {
    for (const existing of store.values()) {
      // Re-attach to an in-flight or already completed job so retries never duplicate upstream calls.
      if (
        existing.clientId === clientId &&
        (existing.status === "pending" || existing.status === "completed")
      ) {
        return { id: existing.id };
      }
    }
  }

  let pendingCount = 0;
  for (const job of store.values()) {
    if (job.status === "pending") pendingCount += 1;
  }
  if (pendingCount >= MAX_PENDING_JOBS) {
    throw new ApiError(
      429,
      "too_many_requests",
      "Too many voice transcriptions in progress. Please try again in a moment.",
      true,
    );
  }

  const id = randomUUID();
  store.set(id, {
    id,
    clientId,
    status: "pending",
    createdAt: now,
    finishedAt: null,
  });

  void transcribeVoiceInput(deps, {
    file: args.file,
    prompt: args.prompt,
  }).then(
    (text) => {
      store.set(id, {
        id,
        clientId,
        status: "completed",
        text,
        createdAt: now,
        finishedAt: Date.now(),
      });
    },
    (error: unknown) => {
      store.set(id, {
        id,
        clientId,
        status: "failed",
        error: toJobError(error),
        createdAt: now,
        finishedAt: Date.now(),
      });
    },
  );

  return { id };
}

export function getVoiceTranscriptionJob(
  deps: Pick<LoggedWorkSessionDeps, "aiServices">,
  id: string,
): SystemVoiceTranscriptionJobResponse {
  const store = getJobStore(deps.aiServices);
  sweepJobs(store, Date.now());
  const job = store.get(id);
  if (!job) {
    throw new ApiError(
      404,
      "voice_job_not_found",
      "Voice transcription job not found",
    );
  }
  if (job.status === "pending") {
    return { id: job.id, status: "pending" };
  }
  if (job.status === "completed") {
    return { id: job.id, status: "completed", text: job.text };
  }
  return { id: job.id, status: "failed", error: job.error };
}
