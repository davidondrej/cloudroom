import { useReducer } from "react";
import { COMPUTER, type Thread } from "@cloudroom/domain";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { GithubFaviconIcon } from "@/components/pull-request/GithubFaviconIcon";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { useRetryProjectCopy } from "@/hooks/queries/cloudroom-queries";
import { useThisComputer } from "@/hooks/useHostDaemon";
import { useClipboardCopy } from "@/lib/clipboard";
import { projectFilesFixPrompt } from "@/lib/fix-prompts";

const megabytes = (bytes: number) => Math.max(1, Math.round(bytes / 1e6));
const timeLeft = (seconds: number) => seconds < 60 ? "under a minute left" : `about ${Math.round(seconds / 60)} min left`;

export function ProjectCopyNotice({ thread }: { thread: Thread }) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const retry = useRetryProjectCopy(thread.id);
  const computer = useThisComputer() === "this PC" ? "your PC" : `your ${COMPUTER}`;
  const progress = thread.projectCopy;
  const fixPrompt = useClipboardCopy({ text: projectFilesFixPrompt(thread.id, progress?.error) });
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
    <PromptStackCard ariaLabel="Project copy progress" className="ml-auto mr-3 w-fit max-w-[calc(100%-1.5rem)] overflow-hidden sm:mr-4">
      <div role="status" className="flex items-start gap-3 p-3">
        <div className="grid size-7 shrink-0 place-items-center rounded-lg bg-warning/15 text-warning">
          <Icon name="AlertTriangle" aria-hidden className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">Project files didn't copy</p>
          <p className="text-xs text-muted-foreground">Your agent can still work and pull files itself.</p>
          <div className="mt-2.5 flex gap-2">
            {!thread.teleport && <Button size="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>Try again</Button>}
            <Button size="sm" variant="outline" onClick={() => void fixPrompt.copy()}>{fixPrompt.copied ? "Copied" : "Copy fix prompt"}</Button>
          </div>
        </div>
        <button type="button" aria-label="Dismiss" className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground" onClick={() => { window.localStorage.setItem(dismissKey, "1"); rerender(); }}>
          <Icon name="X" className="size-4" aria-hidden />
        </button>
      </div>
    </PromptStackCard>
  );
}
