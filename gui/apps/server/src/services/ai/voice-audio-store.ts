import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import type { AiServiceRegistry } from "./ai-service-registry.js";

interface StoredVoiceAudio {
  bytes: Buffer;
  mimeType: string;
  expiresAt: number;
}

const VOICE_AUDIO_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;
const stores = new WeakMap<AiServiceRegistry, Map<string, StoredVoiceAudio>>();

function getStore(aiServices: AiServiceRegistry): Map<string, StoredVoiceAudio> {
  let store = stores.get(aiServices);
  if (!store) {
    store = new Map();
    stores.set(aiServices, store);
  }
  return store;
}

function sweepExpired(store: Map<string, StoredVoiceAudio>, now: number): void {
  for (const [token, entry] of store) {
    if (entry.expiresAt <= now) {
      store.delete(token);
    }
  }
}

export interface VoiceAudioLease {
  token: string;
  path: string;
  revoke(): void;
}

/** Issues a single-use capability path so a host plugin can pull audio bytes without blowing the 8 MiB RPC JSON cap. */
export function issueVoiceAudioToken(
  aiServices: AiServiceRegistry,
  args: { bytes: Buffer; mimeType: string; ttlMs: number },
): VoiceAudioLease {
  const store = getStore(aiServices);
  const now = Date.now();
  sweepExpired(store, now);
  const token = randomBytes(32).toString("hex");
  store.set(token, {
    bytes: args.bytes,
    mimeType: args.mimeType,
    expiresAt: now + Math.max(1_000, args.ttlMs),
  });
  return {
    token,
    path: `/internal/voice-audio/${token}`,
    revoke: () => {
      store.delete(token);
    },
  };
}

export function consumeVoiceAudioToken(
  aiServices: AiServiceRegistry,
  token: string,
): { bytes: Buffer; mimeType: string } | null {
  if (!VOICE_AUDIO_TOKEN_PATTERN.test(token)) {
    return null;
  }
  const store = getStore(aiServices);
  const entry = store.get(token);
  if (!entry) {
    return null;
  }
  store.delete(token);
  if (entry.expiresAt <= Date.now()) {
    return null;
  }
  return { bytes: entry.bytes, mimeType: entry.mimeType };
}

export function registerInternalVoiceAudioRoutes(
  app: Hono,
  deps: Pick<AppDeps, "aiServices">,
): void {
  app.get("/voice-audio/:token", (context) => {
    const audio = consumeVoiceAudioToken(
      deps.aiServices,
      context.req.param("token"),
    );
    if (!audio) {
      throw new ApiError(404, "voice_audio_not_found", "Voice audio not found");
    }
    return new Response(new Uint8Array(audio.bytes), {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": audio.mimeType,
        "content-length": String(audio.bytes.byteLength),
      },
    });
  });
}
