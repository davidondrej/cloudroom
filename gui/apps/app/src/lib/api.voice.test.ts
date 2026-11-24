// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError, transcribeVoiceInput } from "./api";
import { retryTransient } from "./retry-transient";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sampleAudio(): File {
  return new File(["audio"], "recording.webm", { type: "audio/webm" });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("transcribeVoiceInput", () => {
  it("starts an async job with clientId, tolerates a transient poll 502, and resolves text", async () => {
    vi.useFakeTimers();
    let pollCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/system/voice-transcription/jobs") && init?.method === "POST") {
        const form = init.body as FormData;
        expect(form.get("clientId")).toBe("rec-42");
        expect(form.get("prompt")).toBe("ctx");
        return jsonResponse({ id: "job-1" }, 202);
      }
      if (url.endsWith("/api/v1/system/voice-transcription/jobs/job-1")) {
        pollCount += 1;
        if (pollCount === 1) return jsonResponse({ id: "job-1", status: "pending" });
        if (pollCount === 2) return jsonResponse({ message: "bad gateway" }, 502);
        return jsonResponse({ id: "job-1", status: "completed", text: "hello mobile" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = transcribeVoiceInput(sampleAudio(), "ctx", undefined, "rec-42");
    await vi.advanceTimersByTimeAsync(1_500 * 3);
    await expect(promise).resolves.toEqual({ text: "hello mobile" });
    expect(pollCount).toBe(3);
  });

  it("marks voice HTTP 504 as non-retryable while retryTransient still retries plain 504s", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: "Gateway timeout" }, 504),
    );
    vi.stubGlobal("fetch", fetchMock);

    let voiceCalls = 0;
    const voicePromise = retryTransient(() => {
      voiceCalls += 1;
      return transcribeVoiceInput(sampleAudio());
    });
    const voiceError = await voicePromise.catch((err: unknown) => err);
    expect(voiceError).toBeInstanceOf(HttpError);
    expect((voiceError as HttpError).status).toBe(504);
    expect((voiceError as HttpError).retryable).toBe(false);
    expect(voiceCalls).toBe(1);

    // Non-voice callers (like useCreateThread) still retry plain 504 errors.
    let threadCalls = 0;
    const threadPromise = retryTransient(async () => {
      threadCalls += 1;
      if (threadCalls === 1) {
        throw new HttpError({ status: 504, message: "Gateway timeout" });
      }
      return "created";
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(threadPromise).resolves.toBe("created");
    expect(threadCalls).toBe(2);
  });

  it("falls back to the legacy synchronous route on 404", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/system/voice-transcription/jobs")) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (url.endsWith("/api/v1/system/voice-transcription")) {
        return jsonResponse({ text: "legacy transcript" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(transcribeVoiceInput(sampleAudio())).resolves.toEqual({
      text: "legacy transcript",
    });
  });
});
