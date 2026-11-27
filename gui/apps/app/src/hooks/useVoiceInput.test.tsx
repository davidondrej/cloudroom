// @vitest-environment jsdom

import { emptyPromptDraftState } from "@cloudroom/client-core";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptBoxHandle } from "@/components/promptbox/PromptBoxInternal";
import { usePromptVoice } from "@/components/promptbox/usePromptVoice";
import { appToast } from "@/components/ui/app-toast";
import { transcribeVoiceInput } from "@/lib/api";
import { getPromptDraftAccessor } from "./usePromptDraftStorage";
import {
  deleteVoiceRecording,
  downloadVoiceRecording,
  loadVoiceRecordings,
  startVoiceRecording,
} from "@/lib/voice-recording-backup";
import { useVoiceInput } from "./useVoiceInput";

vi.mock("@/lib/api", () => ({
  transcribeVoiceInput: vi.fn(),
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: {
    error: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
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

  it.each(["closes", "moves to another thread"])(
    "sends a voice message to the thread it was recorded in when the composer %s mid-transcription",
    async (leave) => {
      const voice = renderThreadVoice();
      await recordAndSend(voice);
      expect(voice.result.current.state).toBe("transcribing");

      if (leave === "closes") {
        voice.unmount();
        voice.promptBoxRef.current = null;
      } else {
        voice.rerender({ threadId: "t2" });
        expect(voice.result.current.state).toBe("idle");
      }
      await act(async () => {
        voice.finish("ship it");
        await vi.runAllTimersAsync();
      });

      expect(originDraftText()).toBe("ship it");
      expect(voice.send).toHaveBeenCalledOnce();
      expect(appToast.success).toHaveBeenCalledWith("Voice message sent", {});
      expect(voice.promptBox.insertTextAtCursor).not.toHaveBeenCalled();
      expect(deleteVoiceRecording).toHaveBeenCalledWith(1_763_731_200_000);
    },
  );

  it("finishes a recording in the background without touching the next thread's recording", async () => {
    vi.mocked(startVoiceRecording)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(2);
    const voice = renderThreadVoice();
    await recordAndSend(voice);
    voice.rerender({ threadId: "t2" });
    await act(() => voice.result.current.start());
    expect(voice.result.current.state).toBe("recording");

    await act(async () => {
      voice.finish("ship it");
      await vi.runAllTimersAsync();
    });

    expect(originDraftText()).toBe("ship it");
    expect(voice.send).toHaveBeenCalledOnce();
    expect(
      voice.promptBox.playVoiceCompletionTransition,
    ).not.toHaveBeenCalled();
    expect(voice.promptBox.insertTextAtCursor).not.toHaveBeenCalled();
    expect(voice.result.current.state).toBe("recording");
  });

  it("closes the mic if the user switches threads while it is opening", async () => {
    let openMic: (stream: MediaStream) => void = () => {};
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementationOnce(
      () => new Promise((resolve) => (openMic = resolve)),
    );
    const stopTrack = vi.fn();
    const voice = renderThreadVoice();
    let starting: void | Promise<void> = undefined;
    act(() => {
      starting = voice.result.current.start();
    });
    voice.rerender({ threadId: "t2" });

    await act(async () => {
      openMic({
        getTracks: () => [{ stop: stopTrack }],
      } as unknown as MediaStream);
      await starting;
    });

    expect(stopTrack).toHaveBeenCalledOnce();
    expect(startVoiceRecording).not.toHaveBeenCalled();
    expect(voice.result.current.state).toBe("idle");
  });
});

const ORIGIN = { kind: "thread", projectId: "p1", threadId: "t1" } as const;

const originDraftText = () => getPromptDraftAccessor(ORIGIN).getCurrent().text;

/** A thread composer's voice input, with a transcription that waits for `finish`. */
function renderThreadVoice() {
  let resolveTranscript: (text: string) => void = () => {};
  vi.mocked(transcribeVoiceInput).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveTranscript = (text) => resolve({ text });
      }),
  );
  getPromptDraftAccessor(ORIGIN).setDraft(emptyPromptDraftState());
  const send = vi.fn(async () => true);
  const promptBox = {
    attachFiles: vi.fn(),
    captureHeightForLayoutChange: vi.fn(),
    focus: vi.fn(),
    focusEnd: vi.fn(),
    getTextBeforeCursor: vi.fn(),
    insertTextAtCursor: vi.fn(),
    submit: vi.fn(),
    playVoiceCompletionTransition: vi.fn(async () => {}),
  } satisfies PromptBoxHandle;
  const promptBoxRef: { current: PromptBoxHandle | null } = {
    current: promptBox,
  };
  const hook = renderHook(
    ({ threadId }) =>
      usePromptVoice(promptBoxRef, {
        draftScope: { ...ORIGIN, threadId },
        send: threadId === ORIGIN.threadId ? send : vi.fn(async () => true),
      }),
    { initialProps: { threadId: ORIGIN.threadId as string } },
  );
  return {
    ...hook,
    send,
    promptBox,
    promptBoxRef,
    finish: (text: string) => resolveTranscript(text),
  };
}

async function recordAndSend(voice: ReturnType<typeof renderThreadVoice>) {
  await act(() => voice.result.current.start());
  vi.advanceTimersByTime(1_500);
  await act(async () => {
    voice.result.current.stopAndSend?.();
    await Promise.resolve();
  });
}
