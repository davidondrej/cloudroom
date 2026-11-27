import { Buffer } from "node:buffer";
import { jsonValueSchema, type JsonObject, type JsonValue } from "@cloudroom/domain";
import {
  parseProviderModelConfig,
  type ProviderModelInfo,
} from "@cloudroom/config/inference-model";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { requireConnectedPrimaryHostId } from "../hosts/primary-host.js";
import { cloudroom } from "../cloudroom/commands.js";
import { runtimeErrorLogFields } from "../lib/error-log-fields.js";
import { AiServiceCallError } from "./ai-service-call.js";
import type { AiServiceRegistration } from "./ai-service-registry.js";
import { issueVoiceAudioToken } from "./voice-audio-store.js";
import {
  INFERENCE_POLICY,
  inferenceCompleteWithFallback,
} from "./inference.js";
import { Type } from "@earendil-works/pi-ai";

interface TranscribeVoiceInputArgs {
  file: File;
  prompt?: string;
  /** Came through the Connect relay (phone), which gives the Mac only 30 s to answer. */
  relayed?: boolean;
}

type OptionalJsonValue = JsonValue | null | undefined;

const OPENAI_TRANSCRIPTION_PROVIDER = "openai";
const VOICE_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;
// Above 5 MB, base64-encoded JSON nears the 8 MiB host RPC cap, so larger clips pull over a one-time internal URL.
const AI_SERVICE_INLINE_AUDIO_MAX_BYTES = 5 * 1024 * 1024;
const BACKUP_VOICE_MAX_BYTES = VOICE_TRANSCRIPTION_MAX_BYTES;
// Per attempt: 10 s plus 30 s per MB, at most 3 minutes. A 7-minute (3.7 MB) recording gets about 2 minutes (#1338).
// Relayed requests keep 10 s per attempt, as before, so a fast backup still answers inside the relay's 30 s.
const VOICE_TIMEOUT_MS_PER_MB = 30_000;
const VOICE_MAX_TIMEOUT_MS = 180_000;
const voiceTranscriptionSchema = Type.Object({ text: Type.String() });

function voiceTimeoutMs(args: TranscribeVoiceInputArgs): number {
  const baseMs = INFERENCE_POLICY.voiceTranscription.timeoutMs;
  if (args.relayed === true) return baseMs;
  const perMb = (VOICE_TIMEOUT_MS_PER_MB * args.file.size) / (1024 * 1024);
  return Math.min(VOICE_MAX_TIMEOUT_MS, Math.round(baseMs + perMb));
}

function parseTranscriptionModel(model: string): ProviderModelInfo {
  return parseProviderModelConfig({
    name: "BB_TRANSCRIPTION",
    value: model,
  });
}

function voiceService(
  deps: LoggedWorkSessionDeps,
  modelInfo: ProviderModelInfo,
): AiServiceRegistration | null {
  const service = deps.aiServices.get(modelInfo.provider);
  return service !== null && service.kinds?.includes("voice") === true ? service : null;
}

function isPrimaryHostConnected(deps: LoggedWorkSessionDeps): boolean {
  try {
    requireConnectedPrimaryHostId(deps);
    return true;
  } catch {
    return false;
  }
}

export function resolveVoiceTranscriptionEnabled(
  deps: LoggedWorkSessionDeps,
): boolean {
  const modelInfo = parseTranscriptionModel(deps.config.transcriptionModel);
  if (modelInfo.provider === OPENAI_TRANSCRIPTION_PROVIDER) {
    return deps.config.openAiApiKey.length > 0;
  }
  if (voiceService(deps, modelInfo) !== null) {
    return isPrimaryHostConnected(deps);
  }
  return false;
}

function trimPrompt(prompt: string | undefined): string | null {
  const trimmed = prompt?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function jsonObjectFromValue(value: OptionalJsonValue): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

function jsonStringProperty(
  value: OptionalJsonValue,
  propertyName: string,
): string | null {
  const object = jsonObjectFromValue(value);
  const propertyValue = object?.[propertyName];
  return typeof propertyValue === "string" ? propertyValue : null;
}

function openAiErrorMessage(payload: OptionalJsonValue): string {
  const object = jsonObjectFromValue(payload);
  const error = object?.error;
  return jsonStringProperty(error, "message") ?? "Voice transcription failed";
}

async function readJsonValue(response: Response): Promise<JsonValue | null> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return null;
  }
  try {
    return jsonValueSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

function buildTranscriptionTimeoutError(): ApiError {
  return new ApiError(
    504,
    "transcription_timeout",
    "Voice transcription timed out",
    true,
  );
}

function buildTranscriptionUnavailableError(): ApiError {
  return new ApiError(
    503,
    "transcription_unavailable",
    "Voice transcription is temporarily unavailable. Please try again in a moment.",
    true,
  );
}

async function transcribeWithAiService(
  deps: LoggedWorkSessionDeps,
  service: AiServiceRegistration,
  modelInfo: ProviderModelInfo,
  args: TranscribeVoiceInputArgs,
): Promise<string> {
  const hostId = requireConnectedPrimaryHostId(deps);
  const audioBytes = Buffer.from(await args.file.arrayBuffer());
  const mimeType = args.file.type || "application/octet-stream";
  const filename = args.file.name || "voice-input";
  const inlineBase64 =
    audioBytes.byteLength <= AI_SERVICE_INLINE_AUDIO_MAX_BYTES
      ? audioBytes.toString("base64")
      : null;
  const prompt = trimPrompt(args.prompt) ?? "";
  const transcriptionModel = `${modelInfo.provider}/${modelInfo.modelId}`;
  const transcription = await inferenceCompleteWithFallback(deps, {
    ...INFERENCE_POLICY.voiceTranscription,
    timeoutMs: voiceTimeoutMs(args),
    complete: async (model, attemptPrompt, timeoutMs) => {
      const attemptModel = parseTranscriptionModel(model);
      const rpcTimeoutMs = timeoutMs + INFERENCE_POLICY.hostRpcGraceMs;
      const audioLease =
        inlineBase64 === null
          ? issueVoiceAudioToken(deps.aiServices, {
              bytes: audioBytes,
              mimeType,
              ttlMs: rpcTimeoutMs,
            })
          : null;
      try {
        const result = await service.transcribeVoice(
          {
            serviceId: service.id,
            model: attemptModel.modelId,
            ...(inlineBase64 !== null
              ? { audioBase64: inlineBase64 }
              : { audioUrl: audioLease!.path }),
            mimeType,
            filename,
            prompt: trimPrompt(attemptPrompt),
            timeoutMs,
          },
          { hostId, timeoutMs: rpcTimeoutMs },
        );
        if (!result.ok) {
          throw new AiServiceCallError(service.id, result.code, result.message);
        }
        return { text: result.text };
      } finally {
        audioLease?.revoke();
      }
    },
    fallbackModel: transcriptionModel,
    label: "Voice transcription",
    primaryModel: transcriptionModel,
    prompt,
    schema: voiceTranscriptionSchema,
  }).catch((error: Error) => error);
  if (!(transcription instanceof Error) && transcription) {
    return transcription.text;
  }
  if (!(transcription instanceof Error)) {
    throw buildTranscriptionUnavailableError();
  }
  if (
    (transcription instanceof AiServiceCallError &&
      transcription.code === "timeout") ||
    (transcription instanceof ApiError &&
      transcription.body.code === "command_timeout")
  ) {
    throw buildTranscriptionTimeoutError();
  }
  if (
    transcription instanceof AiServiceCallError &&
    (transcription.code === "rate_limited" ||
      transcription.code === "service_unavailable")
  ) {
    throw buildTranscriptionUnavailableError();
  }
  throw transcription;
}

async function transcribeWithOpenAi(
  deps: LoggedWorkSessionDeps,
  modelInfo: ProviderModelInfo,
  args: TranscribeVoiceInputArgs,
): Promise<string> {
  if (!deps.config.openAiApiKey) {
    throw new ApiError(
      501,
      "not_configured",
      "Voice transcription requires OPENAI_API_KEY for openai/* transcription",
    );
  }

  const formData = new FormData();
  formData.set("model", modelInfo.modelId);
  formData.set("file", args.file, args.file.name);
  const prompt = trimPrompt(args.prompt);
  if (prompt) {
    formData.set("prompt", prompt);
  }

  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, voiceTimeoutMs(args));
  timer.unref();

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${deps.config.openAiApiKey}`,
      },
      body: formData,
      signal: abortController.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw buildTranscriptionTimeoutError();
    }
    deps.logger.warn(
      runtimeErrorLogFields(deps.config, error),
      "OpenAI voice transcription request failed",
    );
    throw new ApiError(
      502,
      "provider_rpc_error",
      "Voice transcription request failed",
    );
  } finally {
    clearTimeout(timer);
  }

  const payload = await readJsonValue(response);
  if (!response.ok) {
    throw new ApiError(502, "provider_rpc_error", openAiErrorMessage(payload));
  }

  const text = jsonStringProperty(payload, "text");
  if (!text) {
    throw new ApiError(502, "provider_rpc_error", "Voice transcription failed");
  }

  return text;
}

export function assertValidVoiceAudioFile(file: File): void {
  if (file.size === 0) {
    throw new ApiError(400, "invalid_request", "Audio file must not be empty");
  }
  if (file.size > VOICE_TRANSCRIPTION_MAX_BYTES) {
    throw new ApiError(400, "invalid_request", "Audio file exceeds 25MB limit");
  }
}

export async function transcribeVoiceInput(
  deps: LoggedWorkSessionDeps,
  args: TranscribeVoiceInputArgs,
): Promise<string> {
  assertValidVoiceAudioFile(args.file);

  try {
    const text = await transcribeWithConfiguredModel(deps, args);
    if (text.trim()) return text;
    throw new ApiError(
      422,
      "empty_transcript",
      "Voice transcription returned an empty result.",
    );
  } catch (error) {
    const backup =
      args.file.size <= BACKUP_VOICE_MAX_BYTES
        ? await cloudroom(deps)
            .sandboxes.transcribe(args.file)
            .catch((backupError: unknown) => {
              deps.logger.warn(
                runtimeErrorLogFields(deps.config, backupError),
                "Backup voice transcription failed",
              );
              return null;
            })
        : null;
    if (backup === null) throw error;
    deps.logger.info(
      runtimeErrorLogFields(deps.config, error),
      "Voice transcription used the Cloudroom backup",
    );
    return backup;
  }
}

async function transcribeWithConfiguredModel(
  deps: LoggedWorkSessionDeps,
  args: TranscribeVoiceInputArgs,
): Promise<string> {
  const modelInfo = parseTranscriptionModel(deps.config.transcriptionModel);
  if (modelInfo.provider === OPENAI_TRANSCRIPTION_PROVIDER) {
    return transcribeWithOpenAi(deps, modelInfo, args);
  }
  const service = voiceService(deps, modelInfo);
  if (service !== null) {
    return transcribeWithAiService(deps, service, modelInfo, args);
  }

  // Off, uninstalled, or failed to load: a retry alone can't fix it, so say where to look (#2665).
  const plugin =
    modelInfo.provider.charAt(0).toUpperCase() + modelInfo.provider.slice(1);
  throw new ApiError(
    501,
    "not_configured",
    `Voice input uses the ${plugin} plugin, which isn't loaded. Turn it on in Settings → Plugins, then press Retry.`,
  );
}
