import { Buffer } from "node:buffer";
import type {
  ExperimentalAiVoiceTranscribeInput,
  ExperimentalAiVoiceTranscribeOutput,
} from "@get-bb/plugin-sdk/ai-services";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/errors.js";
import {
  resolveVoiceTranscriptionEnabled,
  transcribeVoiceInput,
} from "../../src/services/ai/voice-transcription.js";
import { SandboxDirectory } from "../../src/services/cloudroom/sandboxes.js";
import {
  registerFakeAiService,
  type FakeAiServiceCall,
} from "../helpers/ai-services.js";
import { seedHostSession } from "../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type FetchResult = ReturnType<typeof fetch>;

interface ServiceTranscriptionHarness {
  app: TestAppHarness["app"];
  cleanup: TestAppHarness["cleanup"];
  deps: TestAppHarness["deps"];
  calls: FakeAiServiceCall<ExperimentalAiVoiceTranscribeInput>[];
}

function voiceFile(): File {
  return new File([Buffer.from("audio")], "prompt.webm", {
    type: "audio/webm",
  });
}

function emptyVoiceFile(): File {
  return new File([], "prompt.webm", { type: "audio/webm" });
}

async function createServiceTranscriptionHarness(
  transcribe: (
    input: ExperimentalAiVoiceTranscribeInput,
  ) =>
    | ExperimentalAiVoiceTranscribeOutput
    | Promise<ExperimentalAiVoiceTranscribeOutput>,
): Promise<ServiceTranscriptionHarness> {
  const harness = await createTestAppHarness({
    inferenceFallbackModel: "codex/gpt-5.4-mini",
    transcriptionModel: "codex/gpt-transcribe",
  });
  seedHostSession(harness.deps);
  const fake = registerFakeAiService(harness.deps.aiServices, {
    transcribeVoice: transcribe,
  });
  return {
    app: harness.app,
    cleanup: harness.cleanup,
    deps: harness.deps,
    calls: fake.voiceCalls,
  };
}

function expectRetryableApiError(
  error: unknown,
  expected: { code: string; status: number },
): void {
  expect(error).toBeInstanceOf(ApiError);
  if (!(error instanceof ApiError)) {
    throw new Error("Expected ApiError.");
  }
  expect(error.status).toBe(expected.status);
  expect(error.body).toMatchObject({
    code: expected.code,
    retryable: true,
  });
}

async function waitForSettledVoiceJob(
  app: TestAppHarness["app"],
  jobId: string,
): Promise<Record<string, unknown>> {
  return vi.waitFor(async () => {
    const res = await app.request(
      `/api/v1/system/voice-transcription/jobs/${jobId}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).not.toBe("pending");
    return body;
  });
}

describe("voice transcription", () => {
  it("rejects empty audio before calling the service", async () => {
    const harness = await createServiceTranscriptionHarness(() => {
      throw new Error("Empty audio must not reach the service");
    });
    try {
      const form = new FormData();
      form.set("file", emptyVoiceFile());
      const response = await harness.app.request(
        "/api/v1/system/voice-transcription",
        { body: form, method: "POST" },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "invalid_request",
        message: "Audio file must not be empty",
      });
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("reports openai/* enablement from the API key even when a service registered the openai id", async () => {
    const harness = await createTestAppHarness({
      transcriptionModel: "openai/gpt-4o-transcribe",
      openAiApiKey: "",
    });
    try {
      seedHostSession(harness.deps);
      registerFakeAiService(harness.deps.aiServices, { id: "openai" });
      expect(resolveVoiceTranscriptionEnabled(harness.deps)).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

  it("streams audio above 5MB to plugin-served transcription via a single-use internal URL", async () => {
    let pulledBytes = 0;
    let secondStatus = 0;
    let browserStatus = 0;
    const harness = await createServiceTranscriptionHarness(async (input) => {
      expect(input.audioBase64).toBeUndefined();
      expect(input.audioUrl).toMatch(/^\/internal\/voice-audio\/[a-f0-9]{64}$/);
      const browserBlocked = await harness.app.request(input.audioUrl!, {
        headers: { Origin: "https://evil.example" },
      });
      browserStatus = browserBlocked.status;
      const first = await harness.app.request(input.audioUrl!);
      expect(first.status).toBe(200);
      pulledBytes = (await first.arrayBuffer()).byteLength;
      const second = await harness.app.request(input.audioUrl!);
      secondStatus = second.status;
      return { ok: true, model: input.model, text: "long recording" };
    });
    try {
      const size = 5 * 1024 * 1024 + 1;
      const file = new File([Buffer.alloc(size, 7)], "long.webm", {
        type: "audio/webm",
      });
      await expect(
        transcribeVoiceInput(harness.deps, { file }),
      ).resolves.toBe("long recording");
      expect(pulledBytes).toBe(size);
      expect(browserStatus).toBe(403);
      expect(secondStatus).toBe(404);
      expect(harness.calls).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("runs async voice transcription jobs so clients can poll past relay timeouts", async () => {
    let resolveTranscription: ((value: ExperimentalAiVoiceTranscribeOutput) => void) | undefined;
    const harness = await createServiceTranscriptionHarness(
      () =>
        new Promise((resolve) => {
          resolveTranscription = resolve;
        }),
    );
    try {
      const form = new FormData();
      form.set("file", voiceFile());
      const startRes = await harness.app.request(
        "/api/v1/system/voice-transcription/jobs",
        { body: form, method: "POST" },
      );
      expect(startRes.status).toBe(202);
      const started = (await startRes.json()) as { id: string };
      expect(started.id.length).toBeGreaterThan(0);

      const pendingRes = await harness.app.request(
        `/api/v1/system/voice-transcription/jobs/${started.id}`,
      );
      expect(pendingRes.status).toBe(200);
      await expect(pendingRes.json()).resolves.toEqual({
        id: started.id,
        status: "pending",
      });

      resolveTranscription?.({
        ok: true,
        model: "gpt-transcribe",
        text: "async transcript",
      });

      await expect(
        waitForSettledVoiceJob(harness.app, started.id),
      ).resolves.toEqual({
        id: started.id,
        status: "completed",
        text: "async transcript",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("deduplicates pending and completed jobs by clientId and starts fresh after failure", async () => {
    let attempt = 0;
    let resolveFirst: ((value: ExperimentalAiVoiceTranscribeOutput) => void) | undefined;
    const harness = await createServiceTranscriptionHarness((input) => {
      attempt += 1;
      if (attempt === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return { ok: true, model: input.model, text: "retried transcript" };
    });
    try {
      const startWithClient = async (clientId: string) => {
        const form = new FormData();
        form.set("file", voiceFile());
        form.set("clientId", clientId);
        const res = await harness.app.request(
          "/api/v1/system/voice-transcription/jobs",
          { body: form, method: "POST" },
        );
        expect(res.status).toBe(202);
        return ((await res.json()) as { id: string }).id;
      };

      // Duplicate POST while pending returns the same job ID without starting a second call.
      const firstId = await startWithClient("rec-1");
      const dupPendingId = await startWithClient("rec-1");
      expect(dupPendingId).toBe(firstId);
      expect(harness.calls).toHaveLength(1);

      // Fail the first attempt; polling returns structured failed status.
      resolveFirst?.({
        ok: false,
        code: "auth_required",
        message: "Sign in required",
      });
      await expect(
        waitForSettledVoiceJob(harness.app, firstId),
      ).resolves.toMatchObject({
        id: firstId,
        status: "failed",
        error: { code: "ai_service_auth_required", retryable: false },
      });

      // Manual retry with the same clientId after a failure starts a fresh job.
      const retryId = await startWithClient("rec-1");
      expect(retryId).not.toBe(firstId);
      await expect(
        waitForSettledVoiceJob(harness.app, retryId),
      ).resolves.toEqual({
        id: retryId,
        status: "completed",
        text: "retried transcript",
      });

      // Duplicate POST after completion returns the completed job ID without re-running.
      const dupCompletedId = await startWithClient("rec-1");
      expect(dupCompletedId).toBe(retryId);
      expect(harness.calls).toHaveLength(2);
    } finally {
      await harness.cleanup();
    }
  });

  it("uploads >4MB backup audio via 3-step R2 presigned PUT in sandboxes.transcribe", async () => {
    const requests: { url: string; method: string; body?: unknown; contentLength?: string | null }[] = [];
    const fetchStub = vi.fn(async (input: FetchInput, init?: FetchInit): FetchResult => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "https://cloudroom.test/api/desktop/transcribe" && typeof init?.body === "string") {
        const parsed = JSON.parse(init.body) as { action: string; bytes?: number; key?: string };
        requests.push({ url, method, body: parsed });
        if (parsed.action === "upload") {
          return new Response(
            JSON.stringify({ key: "k-123", url: "https://r2.test/transcribe/v1/u1/k-123?sig=1" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ text: "from r2 backup" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://r2.test/transcribe/v1/u1/k-123?sig=1" && method === "PUT") {
        const headers = new Headers(init?.headers);
        requests.push({ url, method, contentLength: headers.get("content-length") });
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchStub);
    try {
      const sandboxes = new SandboxDirectory(async () => ({
        userId: "u1",
        token: "tok",
        website: "https://cloudroom.test",
      }));
      const size = 4 * 1024 * 1024 + 128;
      const bigFile = new File([Buffer.alloc(size, 3)], "long.webm", { type: "audio/webm" });
      await expect(sandboxes.transcribe(bigFile)).resolves.toBe("from r2 backup");
      expect(requests).toEqual([
        { url: "https://cloudroom.test/api/desktop/transcribe", method: "POST", body: { action: "upload", bytes: size } },
        { url: "https://r2.test/transcribe/v1/u1/k-123?sig=1", method: "PUT", contentLength: String(size) },
        {
          url: "https://cloudroom.test/api/desktop/transcribe",
          method: "POST",
          body: { action: "transcribe", key: "k-123", filename: "long.webm", mimeType: "audio/webm" },
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends openai/* to OpenAI directly even when a service registered the openai id", async () => {
    const harness = await createTestAppHarness({
      transcriptionModel: "openai/gpt-4o-transcribe",
    });
    seedHostSession(harness.deps);
    const fake = registerFakeAiService(harness.deps.aiServices, {
      id: "openai",
      transcribeVoice: () => {
        throw new Error("A registered openai service must not receive audio");
      },
    });
    const fetchStub = vi.fn(
      async (_input: FetchInput, _init?: FetchInit): FetchResult =>
        new Response(JSON.stringify({ text: "hello openai" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchStub);
    try {
      await expect(
        transcribeVoiceInput(harness.deps, { file: voiceFile() }),
      ).resolves.toBe("hello openai");
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(fake.voiceCalls).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
      await harness.cleanup();
    }
  });

  it("retries with the transcription model after service unavailability", async () => {
    let requestCount = 0;
    const harness = await createServiceTranscriptionHarness((input) => {
      requestCount += 1;
      if (requestCount === 1) {
        return {
          ok: false,
          code: "service_unavailable",
          message: "Codex transcription service unavailable",
        };
      }
      return { ok: true, model: input.model, text: "hello world" };
    });
    try {
      await expect(
        transcribeVoiceInput(harness.deps, { file: voiceFile() }),
      ).resolves.toBe("hello world");
      expect(harness.calls).toHaveLength(2);
      expect(harness.calls[0]?.input).toMatchObject({
        serviceId: "codex",
        model: "gpt-transcribe",
        timeoutMs: 10_000,
        mimeType: "audio/webm",
        filename: "prompt.webm",
      });
      expect(harness.calls[1]?.input).toMatchObject({
        model: "gpt-transcribe",
        timeoutMs: 10_000,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("returns retryable unavailable after exhausting rate limit retries", async () => {
    const harness = await createServiceTranscriptionHarness(() => ({
      ok: false,
      code: "rate_limited",
      message:
        "Codex transcription request failed with HTTP 429: Transcription is temporarily unavailable. Please try again later.",
    }));
    try {
      let thrown: unknown = null;
      try {
        await transcribeVoiceInput(harness.deps, { file: voiceFile() });
      } catch (error) {
        thrown = error;
      }

      expectRetryableApiError(thrown, {
        code: "transcription_unavailable",
        status: 503,
      });
      expect(harness.calls).toHaveLength(2);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns retryable timeout after exhausting timeout retries", async () => {
    const harness = await createServiceTranscriptionHarness(() => ({
      ok: false,
      code: "timeout",
      message: "Timed out waiting for the transcription",
    }));
    try {
      let thrown: unknown = null;
      try {
        await transcribeVoiceInput(harness.deps, { file: voiceFile() });
      } catch (error) {
        thrown = error;
      }

      expectRetryableApiError(thrown, {
        code: "transcription_timeout",
        status: 504,
      });
      expect(harness.calls).toHaveLength(2);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not retry non-retryable auth failures", async () => {
    const harness = await createServiceTranscriptionHarness(() => ({
      ok: false,
      code: "auth_required",
      message: "Codex transcription request failed with HTTP 401: Unauthorized",
    }));
    try {
      await expect(
        transcribeVoiceInput(harness.deps, { file: voiceFile() }),
      ).rejects.toMatchObject({
        body: {
          code: "ai_service_auth_required",
          retryable: false,
        },
        status: 502,
      });
      expect(harness.calls).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("scales the OpenAI transcription timeout with the audio size", async () => {
    const harness = await createTestAppHarness({
      transcriptionModel: "openai/gpt-4o-transcribe",
    });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const fetchStub = vi.fn(
      (_url: FetchInput, init?: FetchInit): FetchResult => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return Promise.resolve(
          new Response(JSON.stringify({ text: "hello openai" }), {
            status: 200,
          }),
        );
      },
    );
    vi.stubGlobal("fetch", fetchStub);
    try {
      await expect(
        transcribeVoiceInput(harness.deps, { file: voiceFile() }),
      ).resolves.toBe("hello openai");
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10_000);
      // Longer recordings get 30 s more per MB (#1338).
      const longFile = new File([Buffer.alloc(2 * 1024 * 1024)], "long.webm");
      await transcribeVoiceInput(harness.deps, { file: longFile });
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 70_000);
    } finally {
      vi.unstubAllGlobals();
      setTimeoutSpy.mockRestore();
      await harness.cleanup();
    }
  });
});
