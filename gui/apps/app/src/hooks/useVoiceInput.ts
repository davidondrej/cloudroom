import { useCallback, useEffect, useRef, useState } from "react";
import { appToast } from "@/components/ui/app-toast";
import {
  buildAudioInputConstraints,
  useAudioInputDevicePreferenceValue,
} from "@/lib/audio-input-device-preference";
import {
  isDocumentVisible,
  subscribeToDocumentVisibility,
} from "@/lib/document-visibility";
import {
  readVoiceSupportEnvironment,
  resolveVoiceSupport,
  voiceUnsupportedMessage,
  type VoiceUnsupportedReason,
} from "./voice-input-support";
import { useLatestRef } from "./useLatestRef";
import { retryTransient } from "@/lib/retry-transient";
import {
  createRecordingFile,
  deleteVoiceRecording,
  downloadVoiceRecording,
  loadVoiceRecordings,
  releaseVoiceRecording,
  saveVoiceChunk,
  startVoiceRecording,
} from "@/lib/voice-recording-backup";

type VoiceInputState = "idle" | "recording" | "transcribing" | "error";

/**
 * Puts one recording's text where it belongs. `submit`: the user tapped send.
 * `shown`: this composer still shows the recording, so the text can go in at the cursor.
 */
type TranscriptDelivery = (
  transcript: string,
  how: { submit: boolean; shown: boolean },
) => void;

interface UseVoiceInputOptions {
  /**
   * Read when the user stops recording (or at start, if the composer lets go first)
   * and kept for that recording, so its text lands where it was recorded even after
   * the composer unmounts or switches threads.
   */
  onTranscript: TranscriptDelivery;
  onTranscribe: (args: {
    file: File;
    promptContext?: string;
    signal?: AbortSignal;
    clientId?: string;
    isShown?: () => boolean;
  }) => Promise<string>;
  getPromptContext?: () => string | undefined;
}

/** The recording this composer is capturing right now. */
interface ActiveRecording {
  recorder: MediaRecorder;
  deliver: TranscriptDelivery;
  transcribe: boolean;
  submit: boolean;
}

const MIN_RECORDING_DURATION_MS = 1_000;
const CHUNK_TIMESLICE_MS = 2_000;
const RECORDING_BITS_PER_SECOND = 24_000;

const HTML_DOCUMENT_PATTERN = /<!doctype html|<html[\s>]/i;

const offeredRecordingIds = new Set<number>();
// Recordings with a live Retry. Retry sends to their own thread, so a new composer must not re-offer them.
const retryRecordingIds = new Set<number>();
const recordingToastId = (id: number) => `voice-recording-backup-${id}`;

function normalizeTranscript(rawText: string): string {
  return rawText.replace(/\s+/g, " ").trim();
}

function sanitizeErrorMessage(raw: string): string | null {
  let normalized = raw.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return null;
  }

  const htmlDocumentMatch = normalized.search(HTML_DOCUMENT_PATTERN);
  if (htmlDocumentMatch >= 0) {
    normalized = normalized.slice(0, htmlDocumentMatch).trim();
  }
  if (normalized.length === 0) {
    return null;
  }

  normalized = normalized.replace(/^HTTP\s+\d{3}:\s*/i, "").trim();
  if (normalized.length === 0) {
    return null;
  }

  return normalized;
}

function resolveRecordingErrorMessage(
  error: unknown,
  hasPreferredAudioInput = false,
): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Microphone permission denied";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return hasPreferredAudioInput
          ? "Selected microphone was not found"
          : "No microphone was found";
      case "NotReadableError":
      case "TrackStartError":
        return "Microphone is already in use";
      case "AbortError":
        return "Voice capture was aborted";
      default:
        return "Failed to start voice recording";
    }
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    const message = sanitizeErrorMessage(error.message);
    if (message) {
      return message;
    }
  }
  return "Voice input failed";
}

function resolvePreferredAudioMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = ["audio/webm", "audio/mp4", "audio/ogg"];
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function useVoiceInput(options: UseVoiceInputOptions) {
  const preferredAudioInputDeviceId = useAudioInputDevicePreferenceValue();
  const streamRef = useRef<MediaStream | null>(null);
  const recordingRef = useRef<ActiveRecording | null>(null);
  const transcriptionRef = useRef<{
    id: number;
    file: File;
    abort: AbortController;
  } | null>(null);
  // The recording whose progress this composer shows. Detaching clears it; the recording itself keeps going.
  const shownIdRef = useRef<number | null>(null);
  // Counts hand-offs, so a mic that finishes opening after the composer let go is closed again.
  const detachCountRef = useRef(0);
  const wakeLockSentinelRef = useRef<WakeLockSentinel | null>(null);
  const wakeLockRequestRef = useRef<Promise<void> | null>(null);
  const shouldHoldWakeLockRef = useRef(false);

  const [state, setState] = useState<VoiceInputState>("idle");
  const [isSupported, setIsSupported] = useState(false);
  const [unsupportedReason, setUnsupportedReason] =
    useState<VoiceUnsupportedReason | null>("unsupported-browser");
  const [stream, setStream] = useState<MediaStream | null>(null);

  const showError = useCallback(
    (
      message: string,
      recordingId?: number,
      retry?: { file: File; run: () => void },
    ) => {
      // A recording that finishes in the background must not flag the composer the user moved to.
      if (recordingId === undefined || shownIdRef.current === recordingId) {
        setState("error");
      }
      appToast.error("Voice input failed", {
        description: message,
        ...(retry && recordingId !== undefined
          ? {
              id: recordingToastId(recordingId),
              action: { label: "Retry", onClick: retry.run },
              extraActions: [
                {
                  label: "Download",
                  onClick: (event) => {
                    event.preventDefault();
                    downloadVoiceRecording(retry.file, recordingId);
                  },
                },
              ],
              cancel: {
                label: "Discard",
                onClick: () => {
                  retryRecordingIds.delete(recordingId);
                  void deleteVoiceRecording(recordingId);
                },
              },
              duration: Infinity,
            }
          : {}),
      });
    },
    [],
  );

  const transcribe = useCallback(
    async function transcribeRecording(
      recordingId: number,
      file: File,
      deliver: (transcript: string, shown: boolean) => void,
      promptContext?: string,
    ): Promise<void> {
      const isShown = () => shownIdRef.current === recordingId;
      const settle = (next: VoiceInputState) => {
        if (isShown()) setState(next);
      };
      const abortController = new AbortController();
      if (isShown()) {
        transcriptionRef.current = {
          id: recordingId,
          file,
          abort: abortController,
        };
      }
      settle("transcribing");
      try {
        const transcript = await retryTransient(() =>
          options.onTranscribe({
            file,
            promptContext,
            signal: abortController.signal,
            isShown,
            ...(recordingId > 0 ? { clientId: String(recordingId) } : {}),
          }),
        );
        const normalized = normalizeTranscript(transcript);
        if (normalized.length === 0) {
          throw new Error("Voice transcription returned an empty result.");
        }
        deliver(normalized, isShown());
        retryRecordingIds.delete(recordingId);
        void deleteVoiceRecording(recordingId);
        settle("idle");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          settle("idle");
          return;
        }
        offeredRecordingIds.add(recordingId);
        retryRecordingIds.add(recordingId);
        // Retry shows progress only if this composer still shows the recording.
        showError(resolveRecordingErrorMessage(error), recordingId, {
          file,
          run: () =>
            void transcribeRecording(recordingId, file, deliver, promptContext),
        });
      } finally {
        releaseVoiceRecording(recordingId);
        if (transcriptionRef.current?.abort === abortController) {
          transcriptionRef.current = null;
        }
      }
    },
    [options, showError],
  );
  const transcribeRef = useLatestRef(transcribe);
  const onTranscriptRef = useLatestRef(options.onTranscript);

  const showUnsentRecordingToast = useCallback(
    (id: number, file: File) => {
      offeredRecordingIds.add(id);
      retryRecordingIds.delete(id);
      appToast.warning("Unsent voice recording", {
        id: recordingToastId(id),
        description:
          id > 0
            ? `Recorded ${new Date(id).toLocaleString()}, never transcribed.`
            : "Your last recording was never transcribed.",
        duration: Infinity,
        action: {
          label: "Transcribe",
          onClick: () => {
            // Show progress here only if this composer is free; otherwise transcribe in the background.
            if (!recordingRef.current && !transcriptionRef.current) {
              shownIdRef.current = id;
            }
            void transcribeRef.current(id, file, (text, shown) =>
              onTranscriptRef.current(text, { submit: false, shown }),
            );
          },
        },
        extraActions: [
          {
            label: "Download",
            onClick: (event) => {
              event.preventDefault();
              downloadVoiceRecording(file, id);
            },
          },
        ],
        cancel: {
          label: "Discard",
          onClick: () => void deleteVoiceRecording(id),
        },
      });
    },
    [onTranscriptRef, transcribeRef],
  );

  useEffect(() => {
    void loadVoiceRecordings().then((saved) => {
      for (const { id, file } of saved) {
        if (retryRecordingIds.has(id)) continue;
        const toastId = recordingToastId(id);
        if (offeredRecordingIds.has(id) && !appToast.isOpen(toastId)) continue;
        showUnsentRecordingToast(id, file);
      }
    });
  }, [showUnsentRecordingToast]);

  const stopMediaStream = useCallback((target: MediaStream | null) => {
    target?.getTracks().forEach((track) => track.stop());
    if (streamRef.current !== target) return;
    streamRef.current = null;
    setStream(null);
  }, []);

  const requestRecordingWakeLock = useCallback(() => {
    if (
      typeof window === "undefined" ||
      typeof navigator === "undefined" ||
      typeof document === "undefined" ||
      !("wakeLock" in navigator) ||
      window.isSecureContext === false ||
      document.visibilityState !== "visible"
    ) {
      return;
    }

    const wakeLock = navigator.wakeLock;
    if (!wakeLock) {
      return;
    }

    const currentSentinel = wakeLockSentinelRef.current;
    if (currentSentinel && !currentSentinel.released) {
      return;
    }
    if (wakeLockRequestRef.current) {
      return;
    }

    wakeLockRequestRef.current = wakeLock
      .request("screen")
      .then((sentinel) => {
        if (!shouldHoldWakeLockRef.current) {
          if (!sentinel.released) {
            void sentinel.release().catch(() => {});
          }
          return;
        }

        wakeLockSentinelRef.current = sentinel;
        sentinel.addEventListener("release", () => {
          if (wakeLockSentinelRef.current === sentinel) {
            wakeLockSentinelRef.current = null;
          }
        });
      })
      .catch(() => {})
      .finally(() => {
        wakeLockRequestRef.current = null;
      });
  }, []);

  const releaseRecordingWakeLock = useCallback(() => {
    shouldHoldWakeLockRef.current = false;

    const sentinel = wakeLockSentinelRef.current;
    wakeLockSentinelRef.current = null;
    if (!sentinel || sentinel.released) {
      return;
    }

    void sentinel.release().catch(() => {});
  }, []);

  /**
   * Lets go of the current recording without losing it: recording stops,
   * transcription keeps going, and the text still goes where it started.
   * Only the user's Cancel throws a recording away.
   */
  const detach = useCallback(() => {
    detachCountRef.current += 1;
    shownIdRef.current = null;
    transcriptionRef.current = null;
    const recording = recordingRef.current;
    recordingRef.current = null;
    if (recording?.recorder.state === "recording") {
      try {
        recording.recorder.stop();
      } catch {}
    }
    releaseRecordingWakeLock();
    setState("idle");
  }, [releaseRecordingWakeLock]);

  useEffect(() => {
    const support = resolveVoiceSupport(readVoiceSupportEnvironment());
    setIsSupported(support.isSupported);
    setUnsupportedReason(support.reason);
  }, []);

  useEffect(() => detach, [detach]);

  useEffect(() => {
    return subscribeToDocumentVisibility(() => {
      if (isDocumentVisible() && shouldHoldWakeLockRef.current) {
        requestRecordingWakeLock();
      }
    });
  }, [requestRecordingWakeLock]);

  const start = useCallback(async () => {
    if (!isSupported) {
      showError(voiceUnsupportedMessage(unsupportedReason));
      return;
    }
    if (state === "recording" || state === "transcribing") {
      return;
    }

    const promptContext = options.getPromptContext?.();
    const detachCount = detachCountRef.current;
    let mediaStream: MediaStream | null = null;
    let recordingId: number | null = null;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia(
        buildAudioInputConstraints(preferredAudioInputDeviceId),
      );
      const stream = mediaStream;
      if (detachCountRef.current !== detachCount) {
        stopMediaStream(stream);
        return;
      }
      streamRef.current = stream;
      setStream(stream);
      shouldHoldWakeLockRef.current = true;
      requestRecordingWakeLock();

      const preferredMimeType = resolvePreferredAudioMimeType();
      const recorder = new MediaRecorder(stream, {
        audioBitsPerSecond: RECORDING_BITS_PER_SECOND,
        ...(preferredMimeType ? { mimeType: preferredMimeType } : {}),
      });
      const id = startVoiceRecording();
      recordingId = id;
      const recording: ActiveRecording = {
        recorder,
        deliver: options.onTranscript,
        transcribe: true,
        submit: false,
      };
      recordingRef.current = recording;
      shownIdRef.current = id;
      const chunks: Blob[] = [];
      const startedAtMs = Date.now();
      let chunkSeq = 0;

      recorder.onstart = () => {
        if (shownIdRef.current === id) setState("recording");
      };

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
          void saveVoiceChunk(id, chunkSeq++, event.data);
        }
      };

      recorder.onerror = () => {
        showError("Voice recording failed", id);
      };

      recorder.onstop = async () => {
        if (shownIdRef.current === id) releaseRecordingWakeLock();
        stopMediaStream(stream);
        if (recordingRef.current === recording) recordingRef.current = null;
        const discardRecording = () => {
          void deleteVoiceRecording(id);
          releaseVoiceRecording(id);
        };

        if (!recording.transcribe) {
          discardRecording();
          if (shownIdRef.current === id) setState("idle");
          return;
        }
        if (Date.now() - startedAtMs < MIN_RECORDING_DURATION_MS) {
          showError("Recording too short (minimum 1 second)", id);
          discardRecording();
          return;
        }
        if (chunks.length === 0) {
          showError("No audio was captured", id);
          discardRecording();
          return;
        }

        const recordedMimeType =
          recorder.mimeType || preferredMimeType || "audio/webm";
        const audioFile = createRecordingFile(chunks, recordedMimeType);
        const submit = recording.submit;
        await transcribe(
          id,
          audioFile,
          (text, shown) => recording.deliver(text, { submit, shown }),
          promptContext,
        );
      };

      recorder.start(CHUNK_TIMESLICE_MS);
    } catch (error) {
      if (detachCountRef.current !== detachCount) return;
      if (recordingId !== null) releaseVoiceRecording(recordingId);
      stopMediaStream(mediaStream);
      recordingRef.current = null;
      shownIdRef.current = null;
      releaseRecordingWakeLock();
      showError(
        resolveRecordingErrorMessage(
          error,
          preferredAudioInputDeviceId !== null,
        ),
      );
    }
  }, [
    isSupported,
    options,
    unsupportedReason,
    preferredAudioInputDeviceId,
    releaseRecordingWakeLock,
    requestRecordingWakeLock,
    showError,
    state,
    stopMediaStream,
    transcribe,
  ]);

  /** Stops recording and transcribes. `submit` sends the message once the text lands. */
  const stop = useCallback(
    (submit = false) => {
      const recording = recordingRef.current;
      if (state !== "recording" || recording?.recorder.state !== "recording") {
        return;
      }
      recording.submit = submit;
      // This render's settings: the thread may have finished loading since recording started.
      recording.deliver = onTranscriptRef.current;
      try {
        recording.recorder.stop();
      } catch (error) {
        showError(resolveRecordingErrorMessage(error));
      }
    },
    [onTranscriptRef, showError, state],
  );

  const cancel = useCallback(() => {
    if (state === "recording") {
      const recording = recordingRef.current;
      if (recording?.recorder.state === "recording") {
        recording.transcribe = false;
        try {
          recording.recorder.stop();
        } catch (error) {
          showError(resolveRecordingErrorMessage(error));
        }
      }
      return;
    }

    if (state === "transcribing") {
      const transcription = transcriptionRef.current;
      transcription?.abort.abort();
      transcriptionRef.current = null;
      shownIdRef.current = null;
      setState("idle");
      if (transcription) {
        showUnsentRecordingToast(transcription.id, transcription.file);
      }
    }
  }, [showError, showUnsentRecordingToast, state]);

  return {
    state,
    isSupported,
    unsupportedReason,
    stream,
    isRecording: state === "recording",
    isProcessing: state === "transcribing",
    isListening: state === "recording" || state === "transcribing",
    start,
    stop,
    cancel,
    detach,
  };
}
