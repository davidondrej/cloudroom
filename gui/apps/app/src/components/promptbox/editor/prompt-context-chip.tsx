import { createContext, useContext } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import {
  messageContextLine,
  type PromptDraftContext,
} from "@cloudroom/client-core";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@cloudroom/shared-ui/hover-card";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { PROMPT_MENTION_PILL_CLASS } from "@/components/promptbox/mentions/prompt-mention-display";
import { MessageContextQuoteGlyph } from "@/components/thread/timeline/MessageContextChip";

/** The draft's reply texts, so a reply chip can show its message. */
export const PromptDraftContextsContext = createContext<
  readonly PromptDraftContext[] | undefined
>(undefined);

function PromptContextChipNodeView({ node, selected }: NodeViewProps) {
  const contexts = useContext(PromptDraftContextsContext);
  const label = typeof node.attrs.label === "string" ? node.attrs.label : "";
  const text = contexts?.find((context) => context.label === label)?.text;
  const number = /#(\d+)/u.exec(label)?.[1];
  // "[message #11 - 9 words]" reads as "message #11 · 9 words".
  const heading = label.replace(/^\[|\]$/gu, "").replace(" - ", " · ");
  const excerpt =
    text?.replace(/\s+/gu, " ").trim() ?? heading.replace(/^m/u, "M");

  return (
    <NodeViewWrapper
      as="span"
      className={cn(
        PROMPT_MENTION_PILL_CLASS,
        "max-w-[min(100%,22rem)] select-none",
        selected && "prompt-mention-pill--selected",
      )}
      data-prompt-context="true"
    >
      <HoverCard openDelay={250} closeDelay={80}>
        <HoverCardTrigger asChild>
          <span className="inline-flex min-w-0 items-baseline gap-1.5">
            <MessageContextQuoteGlyph />
            <span className="truncate italic">{excerpt}</span>
            {number && text ? (
              <span className="shrink-0 text-muted-foreground">#{number}</span>
            ) : null}
          </span>
        </HoverCardTrigger>
        {text ? (
          <HoverCardContent
            side="top"
            align="start"
            className="w-[min(28rem,90vw)] p-3"
          >
            <div className="mb-1 text-[11px] text-muted-foreground">
              Replying to {heading}
            </div>
            <div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed">
              {text}
            </div>
          </HoverCardContent>
        ) : null}
      </HoverCard>
    </NodeViewWrapper>
  );
}

/** A reply chip: shows `<context> [message #7 - 494 words] </context>` as the message's first words. */
export const PromptContextExtension = Node.create({
  name: "promptContext",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { label: { default: "" } };
  },
  parseHTML() {
    return [
      {
        tag: "span[data-prompt-context]",
        getAttrs: (element) => ({
          label: element.getAttribute("data-label") ?? "",
        }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const label = String(node.attrs.label);
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-prompt-context": "true",
        "data-label": label,
      }),
      messageContextLine(label),
    ];
  },
  renderText({ node }) {
    return messageContextLine(String(node.attrs.label));
  },
  addNodeView() {
    return ReactNodeViewRenderer(PromptContextChipNodeView);
  },
});
