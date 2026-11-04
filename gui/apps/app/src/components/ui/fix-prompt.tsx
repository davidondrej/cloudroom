import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { useClipboardCopy } from "@/lib/clipboard";

/** A quiet button that copies a prompt for the user's own AI agent (ADR 0131). The prompt stays out of sight;
 *  `iconOnly` fits it into a one-line banner. */
export function FixPrompt({ prompt, className, iconOnly = false }: { prompt: string; className?: string; iconOnly?: boolean }) {
  const { copied, copy } = useClipboardCopy({ text: prompt });
  return (
    <button
      type="button"
      aria-label="Copy fix prompt for your AI agent"
      className={cn("inline-flex shrink-0 cursor-pointer items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground", iconOnly && "size-5 justify-center", className)}
      onClick={() => void copy()}
    >
      <Icon name={copied ? "Check" : "Copy"} aria-hidden className="size-3" />
      {!iconOnly && (copied ? "Copied" : "Copy fix prompt")}
    </button>
  );
}
