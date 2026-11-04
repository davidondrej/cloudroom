import { useReducer } from "react";
import { COMPUTER, type Thread } from "@cloudroom/domain";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { GithubFaviconIcon } from "@/components/pull-request/GithubFaviconIcon";
import { PROMPT_STACK_CARD_ROW_HEIGHT, PROMPT_STACK_INLAY_SEGMENT_CLASS, PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { BannerActionSlot, PromptBannerActionButton } from "@/components/promptbox/banner/prompt-banner-actions";
import { FixPrompt } from "@/components/ui/fix-prompt";
import { useRetryProjectCopy } from "@/hooks/queries/cloudroom-queries";
import { useThisComputer } from "@/hooks/useHostDaemon";
import { projectFilesFixPrompt } from "@/lib/fix-prompts";

const megabytes = (bytes: number) => Math.max(1, Math.round(bytes / 1e6));
export const timeLeft = (seconds: number) => seconds < 60 ? "under a minute left" : `about ${Math.round(seconds / 60)} min left`;

export function ProjectCopyNotice({ thread }: { thread: Thread }) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const retry = useRetryProjectCopy(thread.id);
  const computer = useThisComputer() === "this PC" ? "your PC" : `your ${COMPUTER}`;
  const progress = thread.projectCopy;
  const dismissKey = `cloudroom.project-copy.dismissed.${thread.id}`;
  if (!progress || progress.phase === "complete") return null;
  const failed = progress.phase === "error";
  const waiting = progress.phase === "waiting";
  if (failed && window.localStorage.getItem(dismissKey)) return null;
  if (!failed) {
    const cloning = progress.phase === "cloning";
    const [title, detail] = waiting
      ? ["Copy paused", "Resumes when this thread wakes"]
      : cloning
        ? ["Cloning from GitHub", "New Cloud project"]
        : progress.total
          ? [`Copying from ${computer}`, `${megabytes(progress.completed)} of ${megabytes(progress.total)} MB${progress.secondsLeft === undefined ? "" : ` · ${timeLeft(progress.secondsLeft)}`}`]
          : [`Preparing files on ${computer}`, "New Cloud project"];
    return (
      <PromptStackCard ariaLabel="Project copy progress" className="ml-auto mr-3 w-fit max-w-[calc(100%-1.5rem)] overflow-hidden sm:mr-4">
        <div role="status" className="flex min-w-0 items-center gap-2.5 px-3 py-2 text-sm">
          {cloning ? <GithubFaviconIcon className="text-foreground" /> : <Icon name={waiting ? "FolderSync" : "Laptop"} aria-hidden className="size-4 shrink-0 text-foreground" />}
          <span className="shrink-0 font-medium text-foreground">{title}</span>
          <span aria-hidden className="text-subtle-foreground">·</span>
          <span className="truncate text-muted-foreground">{detail}</span>
          {!waiting && (
            <svg viewBox="0 0 16 16" aria-hidden className="ml-1 size-3.5 shrink-0 animate-spin">
              <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2" className="stroke-border" />
              <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2" strokeLinecap="round" strokeDasharray="10 40" className="stroke-primary" />
            </svg>
          )}
        </div>
        {!waiting && (
          <div className="h-px overflow-hidden bg-border">
            {progress.total
              ? <div className="h-full bg-primary transition-[width] duration-500" style={{ width: `${Math.max(4, (progress.completed / progress.total) * 100)}%` }} />
              : <div className="h-full w-1/3 animate-indeterminate-progress bg-gradient-to-r from-transparent via-primary to-transparent" />}
          </div>
        )}
      </PromptStackCard>
    );
  }
  return (
    <PromptStackCard ariaLabel="Project copy progress" className="ml-auto mr-3 w-fit max-w-[calc(100%-1.5rem)] overflow-hidden sm:mr-4" style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}>
      <div className="flex items-center gap-0.5 p-0.5 text-xs">
        <div role="status" className={cn("flex min-w-0 items-center gap-1.5", PROMPT_STACK_INLAY_SEGMENT_CLASS)}>
          <Icon name="AlertTriangle" aria-hidden className="size-3.5 shrink-0 text-warning" />
          <span className="shrink-0 text-foreground">Files didn't copy</span>
          <span className="min-w-0 truncate text-muted-foreground" title={progress.error}>Your agent can still pull them</span>
        </div>
        <BannerActionSlot hideInTiny={false}>
          {!thread.teleport && <PromptBannerActionButton disabled={retry.isPending} onClick={() => retry.mutate()}>Try again</PromptBannerActionButton>}
          <FixPrompt iconOnly prompt={projectFilesFixPrompt(thread.id, progress.error)} />
          <button type="button" aria-label="Dismiss" className="flex size-5 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground" onClick={() => { window.localStorage.setItem(dismissKey, "1"); rerender(); }}>
            <Icon name="X" className="size-3" aria-hidden />
          </button>
        </BannerActionSlot>
      </div>
    </PromptStackCard>
  );
}
