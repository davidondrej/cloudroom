import { useId, useState } from "react";
import type { MessageContextBlockSegment } from "@cloudroom/client-core";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";

function QuoteGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className="size-3 shrink-0 self-center opacity-60"
    >
      <path d="M7 7h4v4H8.5c0 2 1 3 2.5 3.5V17C8 16.5 6 14.5 6 11V8a1 1 0 0 1 1-1Zm8 0h4v4h-2.5c0 2 1 3 2.5 3.5V17c-3-.5-5-2.5-5-6V8a1 1 0 0 1 1-1Z" />
    </svg>
  );
}

function countWords(text: string): number {
  return text.split(/\s+/u).filter(Boolean).length;
}

interface MessageContextChipProps {
  messageNumber: number | null;
  text: string;
}

/**
 * Collapsible context chip shown in sent user messages.
 * Stays compact by default and unfolds into a contained card on click.
 */
export function MessageContextChip({
  messageNumber,
  text,
}: MessageContextChipProps) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const excerpt = text.replace(/\s+/gu, " ").trim();
  const words = countWords(text);
  const heading =
    messageNumber !== null ? `Message #${messageNumber}` : "Quoted context";
  const toggleLabel = expanded
    ? `Collapse ${heading.toLowerCase()}`
    : `Expand ${heading.toLowerCase()}`;

  return (
    <div
      data-message-context-chip={expanded ? undefined : ""}
      data-message-context-card={expanded ? "" : undefined}
      className={
        expanded
          ? "basis-full w-full overflow-hidden rounded-lg border border-foreground/[0.08] bg-foreground/[0.05] dark:border-foreground/[0.1] dark:bg-foreground/[0.07]"
          : "inline-flex max-w-[min(100%,21.5rem)]"
      }
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
        aria-label={toggleLabel}
        onClick={() => setExpanded((current) => !current)}
        className={
          expanded
            ? "flex w-full cursor-pointer select-none items-center gap-1.5 px-3 py-1.5 text-left text-xs transition-colors hover:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            : "inline-flex min-w-0 max-w-full cursor-pointer select-none items-center gap-1.5 rounded-md bg-foreground/[0.06] py-1 pl-2 pr-1.5 text-xs leading-4 text-foreground transition-colors hover:bg-foreground/[0.09] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring dark:bg-foreground/[0.08] dark:hover:bg-foreground/[0.12]"
        }
      >
        <QuoteGlyph />
        {expanded ? (
          <>
            <span className="font-medium text-muted-foreground">{heading}</span>
            <span className="text-muted-foreground/55">
              · {words} {words === 1 ? "word" : "words"}
            </span>
            <Icon
              name="ChevronUp"
              aria-hidden
              className="ml-auto size-3.5 shrink-0 text-muted-foreground"
            />
          </>
        ) : (
          <>
            <span className="truncate italic">{excerpt}</span>
            {messageNumber !== null ? (
              <span className="shrink-0 text-muted-foreground">
                #{messageNumber}
              </span>
            ) : null}
            <span className="ml-0.5 inline-flex items-center border-l border-foreground/10 pl-1.5 text-muted-foreground">
              <Icon
                name="ChevronDown"
                aria-hidden
                className="size-3 shrink-0"
              />
            </span>
          </>
        )}
      </button>
      {expanded ? (
        <div
          id={bodyId}
          className="max-h-72 overflow-y-auto border-t border-foreground/[0.07] px-3 py-2 text-xs leading-relaxed text-foreground/80 whitespace-pre-wrap break-words"
        >
          {text}
        </div>
      ) : null}
    </div>
  );
}

interface MessageContextGroupProps {
  className?: string;
  items: readonly Pick<MessageContextBlockSegment, "messageNumber" | "text">[];
}

export function MessageContextGroup({
  className,
  items,
}: MessageContextGroupProps) {
  return (
    <div className={cn("flex flex-wrap items-start gap-1.5", className)}>
      {items.map((item, index) => (
        <MessageContextChip
          key={`${item.messageNumber ?? "ctx"}-${index}`}
          messageNumber={item.messageNumber}
          text={item.text}
        />
      ))}
    </div>
  );
}
