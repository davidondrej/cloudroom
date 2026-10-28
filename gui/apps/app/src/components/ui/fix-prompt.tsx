import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@cloudroom/shared-ui/lib/utils";

export function FixPrompt({ prompt, className }: { prompt: string; className?: string }) {
  return (
    <div className={cn("rounded-md border border-border bg-background text-xs", className)}>
      <div className="flex items-center justify-between gap-2 px-2 pt-1.5 text-muted-foreground">
        <span>Stuck? Send this to your AI agent</span>
        <CopyButton text={prompt} label="Copy fix prompt" />
      </div>
      <p className="max-h-28 select-text overflow-y-auto whitespace-pre-wrap break-words px-2 pb-2 pt-1 font-mono text-foreground">
        {prompt}
      </p>
    </div>
  );
}
