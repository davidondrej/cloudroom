import { useCallback, useEffect, useReducer } from "react";
import { COMPUTER_TITLE, type TeleportLocalStep, type Thread } from "@cloudroom/domain";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  PromptStackCard,
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PROMPT_STACK_INLAY_SEGMENT_CLASS,
} from "@/components/promptbox/banner/PromptStackCard";
import {
  BannerActionSlot,
  PROMPT_BANNER_ACTION_BUTTON_CLASS,
  PromptBannerActionButton,
} from "@/components/promptbox/banner/prompt-banner-actions";
import { useTeleportThread } from "@/hooks/queries/cloudroom-queries";
import { useStopThread } from "@/hooks/mutations/thread-runtime-mutations";
import { useThisComputer } from "@/hooks/useHostDaemon";
import { RouteAnchor } from "@/components/ui/app-route-anchor";
import { FixPrompt } from "@/components/ui/fix-prompt";
import { plainError, projectFilesFixPrompt } from "@/lib/fix-prompts";
import { timeLeft } from "./ProjectCopyNotice";
import { getThreadRoutePath } from "@/lib/route-paths";

export const teleportLocalSteps = (here: string): [TeleportLocalStep, string][] => [
  ["stopping", "Stop cloud agent"],
  ["downloading", "Download chat"],
  ["copying", "Copy code"],
  ["switching", here === "this PC" ? "Switch to PC" : `Switch to ${COMPUTER_TITLE}`],
];

export function TeleportLocalNotice({ step = "stopping" }: { step?: TeleportLocalStep }) {
  const steps = teleportLocalSteps(useThisComputer());
  const current = steps.findIndex(([id]) => id === step);
  return (
    <PromptStackCard
      ariaLabel="Teleport to Local progress"
      className="ml-auto mr-3 w-fit max-w-[calc(100%-1.5rem)] overflow-hidden sm:mr-4"
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <div
        role="status"
        aria-label={`Teleporting to Local: ${steps[current]?.[1]}`}
        className="p-0.5 text-xs"
      >
        <ol className={cn("flex min-w-0 items-center gap-1.5", PROMPT_STACK_INLAY_SEGMENT_CLASS)}>
          {steps.map(([id, label], index) => (
            <li
              key={id}
              className={cn(
                "flex shrink-0 items-center gap-1.5 transition-colors duration-300",
                index < current && "text-muted-foreground",
                index === current && "text-foreground",
                index > current && "text-muted-foreground/50",
              )}
            >
              {index > 0 && (
                <span
                  aria-hidden
                  className={cn(
                    "h-px w-4 transition-colors duration-300",
                    index <= current ? "bg-primary/60" : "bg-border",
                  )}
                />
              )}
              {index < current ? (
                <span className="grid size-3.5 place-items-center rounded-full bg-primary text-primary-foreground">
                  <Icon name="Check" aria-hidden className="size-2.5" />
                </span>
              ) : index === current ? (
                <Icon name="Spinner" aria-hidden className="size-3.5 animate-spin text-primary" />
              ) : (
                <span aria-hidden className="mx-0.5 size-2.5 rounded-full border border-current" />
              )}
              <span className={cn(index !== current && "hidden sm:inline")}>{label}</span>
            </li>
          ))}
        </ol>
      </div>
    </PromptStackCard>
  );
}

export function TeleportNotice({
  thread,
  pendingDelivery,
  paused,
  sending,
}: {
  thread: Thread;
  pendingDelivery?: number;
  paused?: boolean;
  sending?: boolean;
}) {
  const action = useTeleportThread(thread.id);
  const stop = useStopThread();
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const progress = thread.teleport;
  const dismissKey = `cloudroom.teleport.dismissed.${progress?.id}`;
  const dismiss = useCallback(() => {
    window.localStorage.setItem(dismissKey, "1");
    rerender();
  }, [dismissKey]);
  const handedOff =
    progress?.phase === "complete" && progress.owner === thread.id;
  const settled = handedOff && pendingDelivery === 0;
  useEffect(() => {
    if (!settled) return;
    const timer = window.setTimeout(dismiss, 15_000);
    return () => window.clearTimeout(timer);
  }, [settled, dismiss]);
  useEffect(() => {
    if (handedOff && sending) dismiss();
  }, [handedOff, sending, dismiss]);
  if (!progress || progress.phase === "cancelled") return null;
  const owner = progress.owner === thread.id;
  const complete = progress.phase === "complete";
  if (complete && window.localStorage.getItem(dismissKey)) return null;
  const failed =
    progress.phase === "error" || Boolean(action.error || stop.error);
  const error = action.error?.message ?? stop.error?.message ?? progress.error;
  const files = `${progress.completed} of ${progress.total} files`;
  // Megabytes, not files: one big chat file would sit at 0 until it lands. The server sends bytes for this stage.
  const remaining = progress.bytes === undefined ? undefined : progress.bytes - (progress.sent ?? 0);
  const seconds = progress.rate && remaining !== undefined ? remaining / progress.rate : undefined;
  const megabytes = progress.bytes
    ? `${Math.round((progress.sent ?? 0) / 1e6)} of ${Math.max(1, Math.round(progress.bytes / 1e6))} MB${seconds !== undefined && seconds >= 1 ? ` · ${timeLeft(seconds)}` : ""}`
    : undefined;
  const [icon, title, detail] = !owner
    ? ["Cloud", "Moved to Cloud", "The parent thread continues this work."]
    : complete
      ? [
          "CircleCheck",
          "Running in Cloud",
          pendingDelivery === 0
            ? "You can close your laptop."
            : "Checking delivery…",
        ]
      : failed
        ? ["AlertCircle", "Teleport paused", error ? plainError(error) : "Your chat is safe."]
        : progress.phase === "cancelling"
          ? ["Spinner", "Cancelling", "Keep your laptop online."]
          : progress.phase === "checking"
            ? ["Spinner", "Teleporting to Cloud", "Starting Cloud…"]
            : progress.phase === "stopping"
            ? ["Spinner", "Teleporting to Cloud", "Stopping local work…"]
            : progress.cloudStarted
              ? [
                  "Spinner",
                  paused ? "Cloud agent stopped" : "Agent working in Cloud",
                  progress.completed < progress.total
                    ? megabytes
                      ? `Uploading ${megabytes}`
                      : `Uploading ${files}. Keep your laptop online.`
                    : "Finishing handoff…",
                ]
              : [
                  "Spinner",
                  "Teleporting to Cloud",
                  megabytes ? `Sending chat · ${megabytes}` : "Sending the conversation…",
                ];
  const showBar = owner && !complete && !failed;
  const percent = progress.bytes
    ? Math.max(4, ((progress.sent ?? 0) / progress.bytes) * 100)
    : progress.total
      ? Math.max(4, (progress.completed / progress.total) * 100)
      : 4;
  // Only a slow upload gets a second line, so a long wait never looks broken.
  const slow =
    showBar && !error && progress.rate !== undefined && progress.rate < 500_000 && seconds !== undefined && seconds > 30
      ? `Slow upload (${((progress.rate * 8) / 1e6).toFixed(1)} Mbit/s). ${progress.cloudStarted ? "Keep your laptop online until it's done." : "Cloud starts as soon as the chat arrives."}`
      : null;
  return (
    <PromptStackCard
      ariaLabel="Teleport progress"
      className="ml-auto mr-3 w-fit max-w-[calc(100%-1.5rem)] overflow-hidden sm:mr-4"
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <div className="flex items-center gap-0.5 p-0.5 text-xs">
        <div
          role="status"
          className={cn(
            "flex min-w-0 items-center gap-1.5",
            PROMPT_STACK_INLAY_SEGMENT_CLASS,
          )}
        >
          <Icon
            name={icon}
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground",
              icon === "Spinner" && "animate-spin text-foreground",
              icon === "CircleCheck" && "text-primary",
              icon === "AlertCircle" && "text-destructive",
            )}
          />
          <span className="shrink-0 text-foreground">{title}</span>
          <span
            className="min-w-0 truncate text-muted-foreground"
            title={failed ? error : undefined}
          >
            {detail}
          </span>
        </div>
        <BannerActionSlot hideInTiny={false}>
          {!owner && (
            <RouteAnchor
              className={PROMPT_BANNER_ACTION_BUTTON_CLASS}
              href={getThreadRoutePath({
                projectId: thread.projectId,
                threadId: progress.owner,
              })}
            >
              Open parent
            </RouteAnchor>
          )}
          {owner && failed && (
            <PromptBannerActionButton
              disabled={action.isPending}
              onClick={() => action.mutate("start")}
            >
              Retry
            </PromptBannerActionButton>
          )}
          {owner && !complete && progress.cloudStarted && (
            <PromptBannerActionButton
              disabled={stop.isPending}
              onClick={() => stop.mutate(thread.id)}
            >
              Stop
            </PromptBannerActionButton>
          )}
          {owner && !complete && !progress.cloudStarted && (
            <PromptBannerActionButton
              disabled={action.isPending || progress.phase === "cancelling"}
              onClick={() => action.mutate("cancel")}
            >
              Cancel
            </PromptBannerActionButton>
          )}
          {owner && failed && (
            <FixPrompt iconOnly prompt={projectFilesFixPrompt(thread.id, error)} />
          )}
          {complete && (
            <button
              type="button"
              aria-label="Dismiss"
              className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
              onClick={dismiss}
            >
              <Icon name="CircleX" className="size-4" aria-hidden />
            </button>
          )}
        </BannerActionSlot>
      </div>
      {slow && (
        <p role="status" className="flex items-center gap-1.5 px-3 pb-2 text-xs text-muted-foreground">
          <Icon name="Clock" aria-hidden className="size-3 shrink-0" />
          {slow}
        </p>
      )}
      {error && !failed && (
        <p role="status" className="truncate px-3 pb-2 text-xs text-muted-foreground" title={error}>
          {plainError(error)}
        </p>
      )}
      {showBar && (
        <div className="h-0.5 bg-border">
          <div
            className="h-full bg-primary transition-[width] duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </PromptStackCard>
  );
}
