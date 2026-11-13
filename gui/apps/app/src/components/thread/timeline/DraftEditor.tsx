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
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { useClipboardCopy } from "@/lib/clipboard";
import { requestComposerFocus } from "@/lib/composer-focus-requests";
import {
  draftStorageKey,
  diffWords,
  readDraft,
  wordCount,
  writeDraft,
  type DraftNote,
} from "@/lib/draft-edits";

export interface DraftMessage {
  messageId: string;
  threadId: string;
  projectId: string | null;
  streaming: boolean;
}

const DraftMessageContext = createContext<DraftMessage | null>(null);

export const DraftMessageProvider = DraftMessageContext.Provider;

export function useDraftMessage(): DraftMessage | null {
  return useContext(DraftMessageContext);
}

interface Selected {
  start: number;
  end: number;
  top: number;
  bottom: number;
  left: number;
  above: boolean;
}

interface Target extends Selected {
  text: string;
}

interface Choice {
  text: string;
  label: string;
}

type Busy = null | "options" | "shorter";

const NOTE_HIGHLIGHT = "cloudroom-draft-note";
let warnedAboutStorage = false;
let noteHighlight: Highlight | null | undefined;

function noteHighlights(): Highlight | null {
  if (noteHighlight === undefined) {
    noteHighlight =
      typeof Highlight === "function" &&
      typeof CSS !== "undefined" &&
      "highlights" in CSS
        ? new Highlight()
        : null;
    if (noteHighlight !== null)
      CSS.highlights.set(NOTE_HIGHLIGHT, noteHighlight);
  }
  return noteHighlight;
}

function insertText(value: string): boolean {
  try {
    return document.execCommand("insertText", false, value);
  } catch {
    return false;
  }
}

function withBoundarySpace(selected: string, rewrite: string): string {
  const lead = /^\s*/u.exec(selected)?.[0] ?? "";
  const trail = /\s*$/u.exec(selected)?.[0] ?? "";
  return lead + rewrite.trim() + trail;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

function pointAt(pieces: Piece[], position: number): [Node, number] | null {
  for (const piece of pieces) {
    if (position < piece.start || position > piece.start + piece.length)
      continue;
    if (piece.node.nodeType === Node.TEXT_NODE)
      return [piece.node, position - piece.start];
    const parent = piece.node.parentNode;
    if (parent === null) continue;
    const at = Array.prototype.indexOf.call(
      parent.childNodes,
      piece.node,
    ) as number;
    return [parent, position === piece.start ? at : at + 1];
  }
  return null;
}

function selectOffsets(root: HTMLElement, start: number, end: number): boolean {
  const { pieces } = linearize(root);
  const from = pointAt(pieces, start);
  const to = pointAt(pieces, end);
  if (from === null || to === null) return false;
  const range = document.createRange();
  range.setStart(from[0], from[1]);
  range.setEnd(to[0], to[1]);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return true;
}

function visibleTop(element: HTMLElement): number {
  let top = 0;
  for (
    let node = element.parentElement;
    node !== null;
    node = node.parentElement
  ) {
    if (getComputedStyle(node).overflowY !== "visible") {
      top = Math.max(top, node.getBoundingClientRect().top);
    }
  }
  return top;
}

async function requestRewrite(
  mode: "options" | "shorter",
  draft: string,
  selected: string,
  avoid: readonly string[],
) {
  const response = await fetchWithAppSurface(
    "/api/v1/cloudroom/draft-rewrite",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, draft, selected, avoid }),
    },
  );
  const body = (await response.json().catch(() => null)) as {
    options?: Choice[];
    error?: { message?: string };
  } | null;
  if (!response.ok || !body?.options?.length) {
    throw new Error(body?.error?.message ?? "The rewrite failed. Try again.");
  }
  return body.options;
}

function ToolbarButton({
  icon,
  label,
  busy,
  onClick,
}: {
  icon: string;
  label: string;
  busy?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      disabled={busy}
      className="flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-foreground transition-colors hover:bg-state-hover disabled:cursor-default"
    >
      <Icon
        name={(busy ? "Loading" : icon) as "Loading"}
        fallback="Zap"
        className={
          busy
            ? "size-3.5 animate-spin text-muted-foreground"
            : "size-3.5 text-muted-foreground"
        }
      />
      {label}
    </button>
  );
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
  const composer =
    message.projectId === null
      ? null
      : getPromptDraftAccessor({
          kind: "thread",
          projectId: message.projectId,
          threadId: message.threadId,
        });
  const cardRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const textRef = useRef(original);
  const originalRef = useRef(original);
  const notesRef = useRef<DraftNote[]>([]);
  const rangesRef = useRef<Range[]>([]);
  const selectedRef = useRef<Target | null>(null);
  const seenRef = useRef<string[]>([]);
  const requestRef = useRef(0);
  const [text, setText] = useState(original);
  const [revision, setRevision] = useState(0);
  const [selected, setSelectedState] = useState<Target | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const { copied, copy } = useClipboardCopy({ text, resetMs: 4000 });

  const setSelected = useCallback((next: Target | null) => {
    selectedRef.current = next;
    seenRef.current = [];
    setSelectedState(next);
  }, []);

  const cancelRewrite = useCallback(() => {
    requestRef.current += 1;
    setBusy(null);
    setChoices(null);
    setPreview(null);
  }, []);

  const clearHighlights = useCallback(() => {
    const highlights = noteHighlights();
    for (const range of rangesRef.current) highlights?.delete(range);
    rangesRef.current = [];
  }, []);

  const drawHighlights = useCallback(() => {
    clearHighlights();
    const element = editorRef.current;
    const highlights = noteHighlights();
    if (element === null || highlights === null) return;
    const { pieces } = linearize(element);
    for (const note of notesRef.current) {
      const from = pointAt(pieces, note.start);
      const to = pointAt(pieces, note.end);
      if (from === null || to === null) continue;
      const range = document.createRange();
      range.setStart(from[0], from[1]);
      range.setEnd(to[0], to[1]);
      highlights.add(range);
      rangesRef.current.push(range);
    }
  }, [clearHighlights]);

  const persist = useCallback(() => {
    const previous = readDraft(key);
    const next = {
      original,
      text: textRef.current,
      sent: previous?.sent ?? null,
      notes: notesRef.current,
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
    notesRef.current = saved?.notes ?? [];
    if (saved !== null && saved.text !== textRef.current) {
      setFromOutside(saved.text);
    } else {
      setRevision((value) => value + 1);
    }
  }, [key, setFromOutside, streaming]);

  useEffect(() => {
    if (composer === null || streaming) return;
    return composer.subscribe(() => {
      const draftText = composer.getCurrent().text;
      const kept = notesRef.current.filter((note) =>
        draftText.includes(`<${note.tag}>`),
      );
      if (kept.length === notesRef.current.length) return;
      notesRef.current = kept;
      drawHighlights();
      persist();
    });
  }, [composer, drawHighlights, persist, streaming]);

  useEffect(
    () => () => {
      requestRef.current += 1;
      clearHighlights();
    },
    [clearHighlights],
  );

  useLayoutEffect(() => {
    const element = editorRef.current;
    if (element !== null && readEditor(element) !== textRef.current) {
      element.textContent = textRef.current;
    }
    drawHighlights();
  }, [drawHighlights, revision, streaming]);

  const updateSelection = useCallback(() => {
    const element = editorRef.current;
    const card = cardRef.current;
    const selection = window.getSelection();
    if (
      element === null ||
      card === null ||
      selection === null ||
      selection.rangeCount === 0
    ) {
      return;
    }
    const range = selection.getRangeAt(0);
    if (
      range.collapsed ||
      !element.contains(range.startContainer) ||
      !element.contains(range.endContainer)
    ) {
      if (selectedRef.current !== null) {
        cancelRewrite();
        setSelected(null);
      }
      return;
    }
    const start = textOffset(element, range.startContainer, range.startOffset);
    const end = textOffset(element, range.endContainer, range.endOffset);
    const current = selectedRef.current;
    if (current !== null && current.start === start && current.end === end) {
      return;
    }
    const selectedText = textRef.current.slice(start, end);
    if (selectedText.trim().length === 0) return;
    const box = range.getBoundingClientRect();
    const frame = card.getBoundingClientRect();
    cancelRewrite();
    setSelected({
      start,
      end,
      text: selectedText,
      top: box.top - frame.top,
      bottom: box.bottom - frame.top,
      left: Math.max(8, Math.min(box.left - frame.left, frame.width - 300)),
      above: box.top - visibleTop(card) > 260,
    });
  }, [cancelRewrite, setSelected]);

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
    notesRef.current = notesRef.current.flatMap((note, index) => {
      const range = rangesRef.current[index];
      if (range === undefined) return [note];
      const start = textOffset(
        element,
        range.startContainer,
        range.startOffset,
      );
      const end = textOffset(element, range.endContainer, range.endOffset);
      return end > start ? [{ ...note, start, end }] : [];
    });
    drawHighlights();
    persist();
    if (selectedRef.current !== null) {
      cancelRewrite();
      setSelected(null);
    }
  }, [cancelRewrite, drawHighlights, persist, setSelected]);

  const replaceSelected = (target: Target, rewrite: string) => {
    const element = editorRef.current;
    if (element === null) return;
    setSelected(null);
    setChoices(null);
    setPreview(null);
    if (textRef.current.slice(target.start, target.end) !== target.text) {
      toast.error("The draft changed. Select the text again.");
      return;
    }
    const value = withBoundarySpace(target.text, rewrite);
    element.focus();
    if (
      !selectOffsets(element, target.start, target.end) ||
      !insertText(value)
    ) {
      const current = textRef.current;
      setFromOutside(
        current.slice(0, target.start) + value + current.slice(target.end),
      );
      persist();
    }
  };

  const rewrite = async (mode: "options" | "shorter", more = false) => {
    const target = selectedRef.current;
    if (target === null || busy !== null) return;
    requestRef.current += 1;
    const request = requestRef.current;
    setBusy(mode);
    if (mode === "options") setChoices(null);
    try {
      const options = await requestRewrite(
        mode,
        textRef.current,
        target.text.trim(),
        more ? seenRef.current.slice(-30) : [],
      );
      if (request !== requestRef.current) return;
      setBusy(null);
      seenRef.current = [
        ...seenRef.current,
        ...options.map((option) => option.text),
      ];
      if (mode === "shorter") setPreview(options[0]!.text);
      else setChoices(options);
    } catch (error) {
      if (request !== requestRef.current) return;
      setBusy(null);
      toast.error(
        mode === "options"
          ? "Could not write options"
          : "Could not shorten the text",
        { description: errorMessage(error) },
      );
    }
  };

  const addNote = () => {
    const target = selectedRef.current;
    if (target === null || composer === null) return;
    const quote = target.text.trim();
    const start = target.start + target.text.indexOf(quote);
    const draft = composer.getCurrent();
    const used = [...draft.text.matchAll(/<note(\d+)>/gu)].map((match) =>
      Number(match[1]),
    );
    const tag = `note${Math.max(0, ...used) + 1}`;
    const gap =
      draft.text.length === 0 || draft.text.endsWith("\n\n")
        ? ""
        : draft.text.endsWith("\n")
          ? "\n"
          : "\n\n";
    notesRef.current = [
      ...notesRef.current,
      { tag, text: quote, start, end: start + quote.length },
    ];
    composer.setDraft({
      ...draft,
      text: `${draft.text}${gap}<${tag}>${quote}</${tag}>\n`,
    });
    drawHighlights();
    persist();
    setSelected(null);
    requestComposerFocus(composer.storageKey);
  };

  const reset = () => {
    cancelRewrite();
    setSelected(null);
    notesRef.current = [];
    setFromOutside(original);
    persist();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      cancelRewrite();
      setSelected(null);
    }
    const target = selectedRef.current;
    if (
      preview !== null &&
      target !== null &&
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      replaceSelected(target, preview);
      return;
    }
    if (
      choices !== null &&
      target !== null &&
      ["1", "2", "3"].includes(event.key) &&
      !event.metaKey &&
      !event.ctrlKey
    ) {
      const choice = choices[Number(event.key) - 1];
      if (choice !== undefined) {
        event.preventDefault();
        replaceSelected(target, choice.text);
      }
    }
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
          aria-label="Draft. Click to edit. Select text to add a note or rewrite it."
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
      {selected !== null && choices === null && preview === null ? (
        <div
          className="absolute z-20 flex items-center gap-0.5 rounded-[10px] border border-foreground/10 bg-popover p-1 text-[13px] shadow-lg"
          style={{ top: Math.max(4, selected.top - 46), left: selected.left }}
        >
          {composer === null ? null : (
            <ToolbarButton
              icon="MessageSquarePlus"
              label="Note"
              onClick={addNote}
            />
          )}
          <ToolbarButton
            icon="AiContentGenerator01"
            label={busy === "options" ? "Writing…" : "Options"}
            busy={busy === "options"}
            onClick={() => void rewrite("options")}
          />
          <ToolbarButton
            icon="Minimize2"
            label={busy === "shorter" ? "Shortening…" : "Shorter"}
            busy={busy === "shorter"}
            onClick={() => void rewrite("shorter")}
          />
        </div>
      ) : null}
      {selected !== null && preview !== null ? (
        <div
          className="absolute inset-x-3 z-20 rounded-xl border border-foreground/10 bg-popover px-3.5 pb-2.5 pt-3 shadow-lg"
          style={
            selected.above
              ? { bottom: `calc(100% - ${selected.top - 8}px)` }
              : { top: selected.bottom + 8 }
          }
          onMouseDown={(event) => event.preventDefault()}
        >
          <div className="flex items-center gap-1.5 text-xs text-subtle-foreground">
            <Icon
              name={"Minimize2" as "Zap"}
              className="size-3.5 text-primary-text"
            />
            Shorter version · {wordCount(selected.text)} → {wordCount(preview)}{" "}
            words
          </div>
          <div className="mb-3 mt-1.5 whitespace-pre-wrap break-words leading-relaxed text-foreground">
            {diffWords(selected.text, preview).map((part, position) =>
              part.kind === "same" ? (
                <span key={position}>{part.text}</span>
              ) : part.kind === "del" ? (
                <del
                  key={position}
                  className="rounded-[3px] bg-destructive/15 px-px text-destructive-text decoration-[1.5px]"
                >
                  {part.text}
                </del>
              ) : (
                <ins
                  key={position}
                  className={cn(
                    "rounded-[3px] bg-primary/20 px-px no-underline",
                    !part.text.startsWith(" ") && "ml-0.5",
                  )}
                >
                  {part.text}
                </ins>
              ),
            )}
          </div>
          <div className="flex items-center gap-1.5 border-t border-foreground/10 pt-2.5 text-[12.5px]">
            <button
              type="button"
              onClick={() => replaceSelected(selected, preview)}
              className="flex cursor-pointer items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 font-semibold text-primary-foreground"
            >
              <Icon name="Check" className="size-3.5" />
              Replace
              <span className="rounded bg-black/15 px-1 text-[10.5px]">⏎</span>
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void rewrite("shorter", true)}
              className="flex cursor-pointer items-center gap-1.5 rounded-md bg-state-hover px-2.5 py-1 text-foreground disabled:cursor-default"
            >
              {busy === "shorter" ? (
                <Icon name="Loading" className="size-3.5 animate-spin" />
              ) : null}
              Try again
            </button>
            <button
              type="button"
              onClick={() => {
                cancelRewrite();
                setSelected(null);
              }}
              className="flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-foreground hover:bg-state-hover"
            >
              Cancel
              <span className="rounded bg-foreground/10 px-1 text-[10.5px] text-muted-foreground">
                Esc
              </span>
            </button>
          </div>
        </div>
      ) : null}
      {selected !== null && choices !== null ? (
        <div
          className="absolute z-20 w-[min(470px,calc(100%-16px))] rounded-xl border border-foreground/10 bg-popover p-1.5 shadow-lg"
          style={
            selected.above
              ? {
                  bottom: `calc(100% - ${selected.top - 8}px)`,
                  left: Math.min(selected.left, 8),
                }
              : { top: selected.bottom + 8, left: Math.min(selected.left, 8) }
          }
          onMouseDown={(event) => event.preventDefault()}
        >
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-subtle-foreground">
            <Icon
              name={"AiContentGenerator01" as "Zap"}
              className="size-3.5 text-primary-text"
            />
            {choices.length} rewrites for the selected text
          </div>
          {choices.map((choice, position) => (
            <button
              key={position}
              type="button"
              onClick={() => replaceSelected(selected, choice.text)}
              className="flex w-full cursor-pointer gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-state-hover"
            >
              <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-md bg-surface-recessed text-[11px] text-muted-foreground">
                {position + 1}
              </span>
              <span>
                <span className="block text-foreground">{choice.text}</span>
                <span className="mt-0.5 block text-xs text-subtle-foreground">
                  {choice.label}
                </span>
              </span>
            </button>
          ))}
          <div className="mt-1 flex items-center justify-between border-t border-foreground/10 px-2.5 pb-0.5 pt-1.5 text-xs text-subtle-foreground">
            <span>Click one to replace the selection, or press 1, 2 or 3.</span>
            <button
              type="button"
              onClick={() => void rewrite("options", true)}
              className="cursor-pointer rounded-md px-1.5 py-0.5 hover:bg-state-hover hover:text-foreground"
            >
              3 more
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
