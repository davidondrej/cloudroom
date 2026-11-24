import { extractErrorMessage, toRecord } from "@cloudroom/core-ui";
import type {
  SystemVoiceTranscriptionJobResponse,
  SystemVoiceTranscriptionJobStartResponse,
  SystemVoiceTranscriptionResponse,
} from "@cloudroom/server-contract";
import { apiClient, toRelativeUrl } from "./api-server";
import { appSurfaceRequestInit } from "./app-surface";
import {
  buildDirectMediaFilePreview,
  buildFilePreview,
  normalizeFilePreviewMimeType,
  type FilePreview,
  type FilePreviewTarget,
} from "@cloudroom/client-core";
import {
  buildThreadHostFileContentUrl,
  buildThreadStorageContentUrl,
} from "./file-content-urls";

const HTML_DOCUMENT_PATTERN = /<!doctype html|<html[\s>]/i;

function normalizeErrorText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export function requestOptions(signal?: AbortSignal) {
  return signal ? { init: { signal } } : undefined;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body?: unknown;
  readonly retryable?: boolean;

  constructor(args: {
    status: number;
    message: string;
    code?: string;
    body?: unknown;
    retryable?: boolean;
  }) {
    super(`HTTP ${args.status}: ${args.message}`);
    this.name = "HttpError";
    this.status = args.status;
    this.code = args.code;
    this.body = args.body;
    this.retryable = args.retryable;
  }
}

function parseHttpError(
  status: number,
  statusText: string,
  rawBody: string,
  contentType: string | null,
): { message: string; body: unknown } {
  const normalized = normalizeErrorText(rawBody);
  if (normalized.length === 0) {
    return { message: statusText || "Request failed", body: undefined };
  }
  const shouldParseAsJson =
    (contentType?.includes("application/json") ?? false) ||
    normalized.startsWith("{") ||
    normalized.startsWith("[");
  let body: unknown;
  if (shouldParseAsJson) {
    try {
      body = JSON.parse(normalized);
      const message = extractErrorMessage(body);
      if (message) {
        return { message, body };
      }
    } catch {}
  }
  if (HTML_DOCUMENT_PATTERN.test(normalized)) {
    if (status === 401 || status === 403) {
      return { message: "Authentication failed", body };
    }
    return { message: statusText || "Request failed", body };
  }
  return {
    message:
      (extractErrorMessage(normalized) ?? statusText) || "Request failed",
    body,
  };
}

function extractErrorCode(value: unknown): string | undefined {
  const record = toRecord(value);
  if (!record) {
    return undefined;
  }
  return typeof record.code === "string" && record.code.trim().length > 0
    ? record.code
    : undefined;
}

async function throwHttpError(res: Response): Promise<never> {
  const rawBody = await res.text().catch(() => "");
  const { message, body } = parseHttpError(
    res.status,
    res.statusText,
    rawBody,
    res.headers.get("content-type"),
  );
  throw new HttpError({
    status: res.status,
    message,
    code: extractErrorCode(body),
    body,
  });
}

async function requestResponse(
  responsePromise: Promise<Response>,
): Promise<Response> {
  const res = await responsePromise;
  if (!res.ok) {
    await throwHttpError(res);
  }
  return res;
}

export async function request<T>(
  responsePromise: Promise<Response>,
): Promise<T> {
  const res = await requestResponse(responsePromise);
  const text = await res.text();
  return JSON.parse(text) as T;
}

async function loadFilePreview(
  target: FilePreviewTarget,
  signal?: AbortSignal,
): Promise<FilePreview> {
  const directMedia = buildDirectMediaFilePreview(target);
  if (directMedia !== null) {
    return directMedia;
  }
  const response = await requestResponse(
    fetch(
      target.url,
      appSurfaceRequestInit({
        method: "GET",
        signal,
      }),
    ),
  );
  const contentBytes = new Uint8Array(await response.arrayBuffer());
  return buildFilePreview({
    contentBytes,
    mimeType: normalizeFilePreviewMimeType(
      response.headers.get("content-type"),
    ),
    name: target.name,
    path: target.path,
    url: target.url,
  });
}

async function postMultipart<T>(
  url: URL,
  file: File,
  signal?: AbortSignal,
  fields?: Record<string, string>,
): Promise<T> {
  const formData = new FormData();
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      formData.set(key, value);
    }
  }
  formData.set("file", file, file.name);
  return request<T>(
    fetch(
      toRelativeUrl(url),
      appSurfaceRequestInit({
        method: "POST",
        body: formData,
        signal,
      }),
    ),
  );
}

const VOICE_JOB_POLL_INTERVAL_MS = 1_500;
// Covers the server's worst case on >4 MB clips: two 3-min tries plus ~3 min R2 backup.
const VOICE_JOB_MAX_WAIT_MS = 10 * 60_000;
const VOICE_JOB_MAX_CONSECUTIVE_POLL_ERRORS = 5;

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isTransientPollError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return false;
  if (error instanceof HttpError) return error.status >= 502;
  return error instanceof TypeError;
}

function nonRetryableVoice504(error: unknown): unknown {
  if (error instanceof HttpError && error.status === 504) {
    return new HttpError({
      status: error.status,
      message: error.message.replace(/^HTTP 504:\s*/i, ""),
      code: error.code,
      body: error.body,
      retryable: false,
    });
  }
  return error;
}

export async function transcribeVoiceInput(
  file: File,
  prompt?: string,
  signal?: AbortSignal,
  clientId?: string,
): Promise<SystemVoiceTranscriptionResponse> {
  const trimmedPrompt = prompt?.trim();
  const trimmedClientId = clientId?.trim();
  const fields: Record<string, string> = {};
  if (trimmedPrompt) fields.prompt = trimmedPrompt;
  if (trimmedClientId) fields.clientId = trimmedClientId;
  const postFields = Object.keys(fields).length > 0 ? fields : undefined;

  let jobId: string;
  try {
    const started = await postMultipart<SystemVoiceTranscriptionJobStartResponse>(
      apiClient.system["voice-transcription"].jobs.$url(),
      file,
      signal,
      postFields,
    );
    jobId = started.id;
  } catch (error) {
    // Fall back to the legacy synchronous route when talking to an older desktop server.
    if (error instanceof HttpError && error.status === 404) {
      try {
        return await postMultipart<SystemVoiceTranscriptionResponse>(
          apiClient.system["voice-transcription"].$url(),
          file,
          signal,
          trimmedPrompt ? { prompt: trimmedPrompt } : undefined,
        );
      } catch (legacyError) {
        throw nonRetryableVoice504(legacyError);
      }
    }
    throw nonRetryableVoice504(error);
  }

  const pollUrl = toRelativeUrl(
    apiClient.system["voice-transcription"].jobs[":id"].$url({
      param: { id: jobId },
    }),
  );
  const deadline = Date.now() + VOICE_JOB_MAX_WAIT_MS;
  let consecutivePollErrors = 0;

  while (Date.now() < deadline) {
    await sleepWithAbort(VOICE_JOB_POLL_INTERVAL_MS, signal);
    let job: SystemVoiceTranscriptionJobResponse;
    try {
      job = await request<SystemVoiceTranscriptionJobResponse>(
        fetch(pollUrl, appSurfaceRequestInit({ method: "GET", signal })),
      );
      consecutivePollErrors = 0;
    } catch (error) {
      if (
        isTransientPollError(error) &&
        ++consecutivePollErrors <= VOICE_JOB_MAX_CONSECUTIVE_POLL_ERRORS
      ) {
        continue;
      }
      throw error;
    }

    if (job.status === "completed") {
      return { text: job.text };
    }
    if (job.status === "failed") {
      throw new HttpError({
        status: job.error.code === "transcription_timeout" ? 504 : 502,
        message: job.error.message,
        code: job.error.code,
        body: job.error,
        // The server already ran its primary retries and backup fallback; avoid auto-re-uploading.
        retryable: false,
      });
    }
  }

  throw new HttpError({
    status: 504,
    message: "Voice transcription timed out",
    code: "transcription_timeout",
    retryable: false,
  });
}

export async function getThreadStorageFilePreview(
  id: string,
  path: string,
  signal?: AbortSignal,
): Promise<FilePreview> {
  return loadFilePreview(
    {
      path,
      url: buildThreadStorageContentUrl(id, path),
    },
    signal,
  );
}

export async function getThreadHostFilePreview(
  id: string,
  path: string,
  signal?: AbortSignal,
): Promise<FilePreview> {
  return loadFilePreview(
    {
      name: path.split("/").at(-1),
      path,
      url: buildThreadHostFileContentUrl(id, path),
    },
    signal,
  );
}
