import { useState } from "react";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { WaveformVisualizer } from "./WaveformVisualizer.js";

interface VoiceRecordingBarProps {
  state: "recording" | "transcribing";
  stream: MediaStream | null;
  onConfirm: () => void;
  // When set, shows a Stop button (insert only) and a Send button.
  onSend?: () => void;
  onCancel: () => void;
}

const CONTROL_BUTTON_CLASS =
  "size-8 rounded-full p-0 max-md:pointer-coarse:size-10";

export function VoiceRecordingBar({
  state,
  stream,
  onConfirm,
  onSend,
  onCancel,
}: VoiceRecordingBarProps) {
  const isTranscribing = state === "transcribing";
  const [sendPressed, setSendPressed] = useState(false);
  const spinner = <Icon name="Spinner" className="size-4 animate-spin" />;

  return (
    <div className="flex flex-row items-center gap-2 px-2 py-1.5">
      <Button
        type="button"
        size="icon"
        variant={onSend ? "secondary" : "ghost"}
        aria-label={
          isTranscribing ? "Cancel transcription" : "Cancel recording"
        }
        onClick={onCancel}
        className={CONTROL_BUTTON_CLASS}
      >
        <Icon name="X" className="size-4" />
      </Button>
      <div className="relative flex min-w-0 flex-1 items-center">
        <div
          className={cn("h-7 w-full", isTranscribing && "animate-shine-icon")}
        >
          <WaveformVisualizer stream={stream} active={!isTranscribing} />
        </div>
        <span className="sr-only" aria-live="polite">
          {isTranscribing ? "Transcribing" : "Recording"}
        </span>
      </div>
      {onSend ? (
        <>
          <Button
            type="button"
            size="icon"
            variant="secondary"
            aria-label="Stop and transcribe recording"
            disabled={isTranscribing}
            onClick={() => {
              setSendPressed(false);
              onConfirm();
            }}
            className={CONTROL_BUTTON_CLASS}
          >
            {isTranscribing && !sendPressed ? (
              spinner
            ) : (
              <Icon
                name="Square"
                className="size-3.5 fill-current [&_*]:stroke-0"
              />
            )}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="default"
            aria-label="Stop and send recording"
            disabled={isTranscribing}
            onClick={() => {
              setSendPressed(true);
              onSend();
            }}
            className={CONTROL_BUTTON_CLASS}
          >
            {isTranscribing && sendPressed ? (
              spinner
            ) : (
              <Icon name="Send" className="size-4" />
            )}
          </Button>
        </>
      ) : (
        <Button
          type="button"
          size="icon"
          variant="default"
          aria-label={
            isTranscribing
              ? "Transcribing voice input"
              : "Stop and transcribe recording"
          }
          disabled={isTranscribing}
          onClick={onConfirm}
          className={CONTROL_BUTTON_CLASS}
        >
          {isTranscribing ? spinner : <Icon name="Check" className="size-4" />}
        </Button>
      )}
    </div>
  );
}
