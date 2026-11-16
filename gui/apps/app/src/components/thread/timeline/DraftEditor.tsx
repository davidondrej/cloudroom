import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { useClipboardCopy } from "@/lib/clipboard";
import { draftStorageKey, readDraft, writeDraft } from "@/lib/draft-edits";

export interface DraftMessage {
  messageId: string;
  threadId: string;
  streaming: boolean;
  /** Quotes selected draft text into the composer, like Reply in the chat selection menu. */
  onAddToChat?: (text: string) => void;
}

const DraftMessageContext = createContext<DraftMessage | null>(null);

export const DraftMessageProvider = DraftMessageContext.Provider;

export function useDraftMessage(): DraftMessage | null {
  return useContext(DraftMessageContext);
}

interface Selected {
  start: number;
  end: number;
  text: string;
  bottom: number;
  left: number;
}

let warnedAboutStorage = false;

interface Piece {
  node: Node;
  start: number;
  length: number;
}

const BLOCK_TAGS = new Set(["DIV", "P", "LI"]);

function linearize(root: HTMLElement): { text: string; pieces: Piece[] } {
  const pieces: Piece[] = [];
  let text = "";
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? "";
      pieces.push({ node, start: text.length, length: value.length });
      text += value;
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === "BR") {
      pieces.push({ node, start: text.length, length: 1 });
      text += "\n";
      return;
    }
    if (
      BLOCK_TAGS.has(node.tagName) &&
      text.length > 0 &&
      !text.endsWith("\n")
    ) {
      text += "\n";
    }
    node.childNodes.forEach(visit);
  };
  root.childNodes.forEach(visit);
  return { text, pieces };
}

function readEditor(element: HTMLElement): string {
  return linearize(element).text.replace(/\n$/u, "");
}

function textOffset(root: HTMLElement, node: Node, offset: number): number {
  const { text, pieces } = linearize(root);
  if (node.nodeType === Node.TEXT_NODE) {
    const piece = pieces.find((candidate) => candidate.node === node);
    return piece === undefined
      ? text.length
      : piece.start + Math.min(offset, piece.length);
  }
  const child = node.childNodes[offset];
  if (child !== undefined) {
    const piece = pieces.find(
      (candidate) => candidate.node === child || child.contains(candidate.node),
    );
    if (piece !== undefined) return piece.start;
  }
  const last = pieces
    .filter((candidate) => node.contains(candidate.node))
    .at(-1);
  return last === undefined ? text.length : last.start + last.length;
}

function ActionButton({
  children,
  onClick,
  label,
  className,
}: {
  children: ReactNode;
  onClick: () => void;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

const SELECTION_BUTTON_CLASS =
  "flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-foreground transition-colors hover:bg-state-hover";

/** Copy and Reply for the selected text. Keyed by the selection, so a new selection starts fresh. */
function SelectionMenu({
  text,
  top,
  left,
  onAddToChat,
}: {
  text: string;
  top: number;
  left: number;
  onAddToChat?: () => void;
}) {
  const { copied, copy } = useClipboardCopy({ text, resetMs: 1500 });
  return (
    <div
      className="absolute z-20 flex items-center gap-0.5 rounded-lg border border-foreground/10 bg-popover p-0.5 text-[12px] shadow-lg"
      style={{ top, left }}
    >
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void copy()}
        className={SELECTION_BUTTON_CLASS}
      >
        <Icon
          name={copied ? "Check" : "Copy"}
          className={cn(
            "size-3.5",
            copied ? "text-success" : "text-muted-foreground",
          )}
        />
        {copied ? "Copied" : "Copy"}
      </button>
      {onAddToChat ? (
        <>
          <span aria-hidden="true" className="h-4 w-px bg-border" />
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onAddToChat}
            className={SELECTION_BUTTON_CLASS}
          >
            <Icon
              name="ArrowTurnDown"
              className="size-3.5 text-muted-foreground"
            />
            Reply
          </button>
        </>
      ) : null}
    </div>
  );
}

/** A ```draft block in an agent reply: text the user sends themselves, editable in place. */
export function DraftEditor({
  block,
  code,
  message,
}: {
  block: string;
  code: string;
  message: DraftMessage;
}) {
  const original = code.replace(/\n+$/u, "");
  const key = draftStorageKey(
    message.threadId,
    message.messageId,
    original,
    block,
  );
  const streaming = message.streaming;
  const cardRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const textRef = useRef(original);
  const originalRef = useRef(original);
  const selectedRef = useRef<Selected | null>(null);
  const [text, setText] = useState(original);
  const [revision, setRevision] = useState(0);
  const [selected, setSelectedState] = useState<Selected | null>(null);
  const { copied, copy } = useClipboardCopy({ text, resetMs: 4000 });

  const setSelected = useCallback((next: Selected | null) => {
    selectedRef.current = next;
    setSelectedState(next);
  }, []);

  const persist = useCallback(() => {
    const previous = readDraft(key);
    const next = {
      original,
      text: textRef.current,
      sent: previous?.sent ?? null,
    };
    if (!writeDraft(key, next) && !warnedAboutStorage) {
      warnedAboutStorage = true;
      toast.error("Could not save your draft edits on this device", {
        description:
          "They still go with your next message, but they are lost if you reload.",
      });
    }
  }, [key, original]);

  const setFromOutside = useCallback((next: string) => {
    textRef.current = next;
    setText(next);
    setRevision((value) => value + 1);
  }, []);

  useLayoutEffect(() => {
    const previous = originalRef.current;
    if (previous === original) return;
    originalRef.current = original;
    if (textRef.current === previous) setFromOutside(original);
  }, [original, setFromOutside]);

  useEffect(() => {
    if (streaming) return;
    const saved = readDraft(key);
    if (saved !== null && saved.text !== textRef.current) {
      setFromOutside(saved.text);
    }
  }, [key, setFromOutside, streaming]);

  useLayoutEffect(() => {
    const element = editorRef.current;
    if (element !== null && readEditor(element) !== textRef.current) {
      element.textContent = textRef.current;
    }
  }, [revision, streaming]);

  const updateSelection = useCallback(() => {
    const element = editorRef.current;
    const card = cardRef.current;
    const current = window.getSelection();
    if (
      element === null ||
      card === null ||
      current === null ||
      current.rangeCount === 0
    ) {
      return;
    }
    const range = current.getRangeAt(0);
    if (
      range.collapsed ||
      !element.contains(range.startContainer) ||
      !element.contains(range.endContainer)
    ) {
      if (selectedRef.current !== null) setSelected(null);
      return;
    }
    const start = textOffset(element, range.startContainer, range.startOffset);
    const end = textOffset(element, range.endContainer, range.endOffset);
    const previous = selectedRef.current;
    if (previous !== null && previous.start === start && previous.end === end) {
      return;
    }
    const selectedText = textRef.current.slice(start, end);
    if (selectedText.trim().length === 0) return;
    const box = range.getBoundingClientRect();
    const frame = card.getBoundingClientRect();
    setSelected({
      start,
      end,
      text: selectedText,
      bottom: box.bottom - frame.top,
      left: Math.max(8, Math.min(box.left - frame.left, frame.width - 160)),
    });
  }, [setSelected]);

  useEffect(() => {
    if (streaming) return;
    document.addEventListener("selectionchange", updateSelection);
    return () =>
      document.removeEventListener("selectionchange", updateSelection);
  }, [streaming, updateSelection]);

  const onInput = useCallback(() => {
    const element = editorRef.current;
    if (element === null) return;
    textRef.current = readEditor(element);
    setText(textRef.current);
    persist();
    if (selectedRef.current !== null) setSelected(null);
  }, [persist, setSelected]);

  const reset = () => {
    setSelected(null);
    setFromOutside(original);
    persist();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") setSelected(null);
  };

  const edited = !streaming && text !== original;

  return (
    <div
      ref={cardRef}
      className="relative my-3 flex min-h-[88px] items-start gap-1 rounded-lg border border-foreground/10 bg-surface-recessed py-2 pl-4 pr-2"
    >
      {streaming ? (
        <div className="min-w-0 flex-1 whitespace-pre-wrap break-words py-1.5 text-foreground">
          {original}
        </div>
      ) : (
        <div
          ref={editorRef}
          role="textbox"
          aria-multiline="true"
          aria-label="Draft. Click to edit."
          contentEditable="plaintext-only"
          suppressContentEditableWarning
          spellCheck
          onInput={onInput}
          onKeyDown={onKeyDown}
          onDrop={(event) => event.preventDefault()}
          className="draft-caret min-w-0 flex-1 cursor-text whitespace-pre-wrap break-words py-1.5 text-foreground outline-none selection:bg-timeline-accent/40"
        />
      )}
      <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
        {edited ? (
          <ActionButton label="Undo all my edits" onClick={reset}>
            <Icon
              name={"ArrowTurnBackward" as "Zap"}
              fallback="X"
              className="size-3.5"
            />
          </ActionButton>
        ) : null}
        <ActionButton
          label={copied ? "Copied" : "Copy the draft"}
          onClick={() => void copy()}
          className={copied ? "text-success hover:text-success" : undefined}
        >
          <Icon name={copied ? "Check" : "Copy"} className="size-3.5" />
        </ActionButton>
      </div>
      {selected !== null ? (
        <SelectionMenu
          key={`${selected.start}:${selected.end}`}
          text={selected.text}
          top={selected.bottom + 6}
          left={selected.left}
          onAddToChat={
            message.onAddToChat
              ? () => {
                  message.onAddToChat?.(selected.text);
                  window.getSelection()?.removeAllRanges();
                  setSelected(null);
                }
              : undefined
          }
        />
      ) : null}
    </div>
  );
}
