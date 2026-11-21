// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appToast } from "@/components/ui/app-toast";
import {
  deleteVoiceRecording,
  downloadVoiceRecording,
  loadVoiceRecordings,
} from "@/lib/voice-recording-backup";
import { useVoiceInput } from "./useVoiceInput";

vi.mock("@/components/ui/app-toast", () => ({
  appToast: {
    error: vi.fn(),
    warning: vi.fn(),
    isOpen: vi.fn(() => false),
  },
}));

vi.mock("@/lib/audio-input-device-preference", () => ({
  buildAudioInputConstraints: vi.fn(() => ({ audio: true })),
  useAudioInputDevicePreferenceValue: vi.fn(() => null),
}));

vi.mock("@/lib/voice-recording-backup", () => ({
  createRecordingFile: vi.fn(
    (chunks: BlobPart[], mimeType: string) =>
      new File(chunks, "recording.webm", { type: mimeType }),
  ),
  deleteVoiceRecording: vi.fn(async () => {}),
  downloadVoiceRecording: vi.fn(),
  loadVoiceRecordings: vi.fn(async () => []),
  releaseVoiceRecording: vi.fn(),
  saveVoiceChunk: vi.fn(async () => {}),
  startVoiceRecording: vi.fn(() => 1_763_731_200_000),
}));

vi.mock("./voice-input-support", () => ({
  readVoiceSupportEnvironment: vi.fn(() => ({})),
  resolveVoiceSupport: vi.fn(() => ({ isSupported: true, reason: null })),
  voiceUnsupportedMessage: vi.fn(() => "Unsupported"),
}));

class FakeMediaRecorder {
  state: RecordingState = "inactive";
  mimeType = "audio/webm";
  onstart: (() => void) | null = null;
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: (() => void) | null = null;

  static isTypeSupported() {
    return true;
  }

  start() {
    this.state = "recording";
    this.onstart?.();
    this.ondataavailable?.({
      data: new Blob(["voice-bytes"], { type: "audio/webm" }),
    } as BlobEvent);
  }

  stop() {
    this.state = "inactive";
    this.onstop?.();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-21T12:00:00Z"));
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [{ stop: vi.fn() }],
      })),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("useVoiceInput", () => {
  it("preserves IndexedDB and shows Transcribe, Download, and Discard when cancelled while transcribing", async () => {
    vi.mocked(loadVoiceRecordings).mockResolvedValue([]);
    let capturedSignal: AbortSignal | undefined;
    let capturedClientId: string | undefined;
    const onTranscribe = vi.fn(
      ({ signal, clientId }: { signal?: AbortSignal; clientId?: string }) => {
        capturedSignal = signal;
        capturedClientId = clientId;
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      },
    );

    const { result } = renderHook(() =>
      useVoiceInput({ onTranscript: vi.fn(), onTranscribe }),
    );

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("recording");

    // Advance past the 1 s minimum recording duration, then stop to begin transcribing.
    vi.advanceTimersByTime(1_500);
    await act(async () => {
      result.current.stop();
      await Promise.resolve();
    });
    expect(result.current.state).toBe("transcribing");
    expect(capturedClientId).toBe("1763731200000");

    // Cancel while transcribing: aborts the request, keeps IndexedDB intact, and offers recovery actions.
    await act(async () => {
      result.current.cancel();
      await Promise.resolve();
    });

    expect(capturedSignal?.aborted).toBe(true);
    expect(result.current.state).toBe("idle");
    expect(deleteVoiceRecording).not.toHaveBeenCalled();

    expect(appToast.warning).toHaveBeenCalledWith(
      "Unsent voice recording",
      expect.objectContaining({
        duration: Infinity,
        action: expect.objectContaining({ label: "Transcribe" }),
        extraActions: [expect.objectContaining({ label: "Download" })],
        cancel: expect.objectContaining({ label: "Discard" }),
      }),
    );

    const toastOptions = vi.mocked(appToast.warning).mock.calls[0]?.[1];
    expect(toastOptions?.onClose).toBeUndefined();

    // Clicking Download keeps the toast open (preventDefault) and downloads the recording.
    const preventDefault = vi.fn();
    toastOptions?.extraActions?.[0]?.onClick({
      preventDefault,
    } as unknown as React.MouseEvent<HTMLButtonElement>);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(downloadVoiceRecording).toHaveBeenCalledOnce();
    expect(deleteVoiceRecording).not.toHaveBeenCalled();

    // Only explicit Discard deletes the recording from IndexedDB.
    toastOptions?.cancel?.onClick({} as React.MouseEvent<HTMLButtonElement>);
    expect(deleteVoiceRecording).toHaveBeenCalledWith(1_763_731_200_000);
  });
});
