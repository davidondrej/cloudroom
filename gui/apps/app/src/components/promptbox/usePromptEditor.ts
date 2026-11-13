// Owns the rich-text editor: creates it, keeps it in step with the `value` prop, and moves focus and the caret.
import type { PromptTextMention } from "@cloudroom/domain";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { useEditor, type Editor } from "@tiptap/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { flushPromptDraftNotifies } from "@/hooks/usePromptDraftStorage";
import { useRichTextEditingPreference } from "@/lib/rich-text-editing-preference";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { blurPromptEditor } from "./ComposerEditorSlot";
import { removeEmptyBlockquotes } from "./editor/prompt-editor-blockquote";
import {
  refreshPromptDecorations,
  type PromptDecorationSource,
  type PromptDraftObserver,
} from "./editor/prompt-decoration-extension";
import { promptEditorExtensions } from "./editor/prompt-editor-extensions";
import {
  promptEditorClipboardTextFromSlice,
  promptEditorContentFromValue,
  promptEditorInlineContentFromValue,
  promptEditorValueFromDoc,
  type PromptEditorValue,
} from "./editor/prompt-editor-serialization";
import { modifierSubmitShortcutAria } from "./modifier-submit-shortcut";
import { textBeforeCursor } from "./prompt-actions";
import {
  arePromptEditorValuesEqual,
  type PromptBoxAction,
} from "./prompt-box-types";
import {
  clipboardFiles,
  readPromptPaste,
  trimTrailingPromptNewlines,
} from "./prompt-paste";

const CARET_REVEAL_MARGIN_PX = 12;
// Safari re-sends the Enter that confirmed an IME word. Within this window it is not a submit.
const IME_CONFIRM_ENTER_WINDOW_MS = 500;
const KEYS_THAT_ACT_ON_THE_DRAFT = new Set([
  "Enter",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
]);

/**
 * The editor instance is created once, so its handlers cannot close over props.
 * They read the newest committed props through this ref instead.
 */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** The draft as plain text plus the ranges that are mention pills. */
export interface PromptValue {
  text: string;
  mentions: readonly PromptTextMention[];
}

/** The handle every feature edits the prompt through. */
export interface PromptDocument {
  ref: RefObject<Editor | null>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  /** Sends the editor's content up to the parent. */
  commit: (editor: Editor, value?: PromptEditorValue) => void;
  /** Runs an edit the parent only hears about through a later `commit`. */
  silently: (run: () => void) => void;
  /** Scrolls the caret into view on the next frame. */
  reveal: () => void;
  /** The parent's copy of the draft, for when no editor is mounted. */
  draft: () => {
    text: string;
    mentions: readonly PromptTextMention[];
    change: (text: string, mentions: PromptTextMention[]) => void;
  };
  /** The last value the editor and the parent agreed on. */
  agreed: RefObject<PromptValue | null>;
  isSilent: () => boolean;
}

export function usePromptDocument(
  text: string,
  mentions: readonly PromptTextMention[],
  onChange: (text: string, mentions: PromptTextMention[]) => void,
): PromptDocument {
  const latest = useLatest({ text, mentions, onChange });
  const ref = useRef<Editor | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const agreed = useRef<PromptValue | null>(null);
  const silent = useRef(false);
  const revealFrame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (revealFrame.current !== null)
        cancelAnimationFrame(revealFrame.current);
    },
    [],
  );

  return useMemo<PromptDocument>(() => {
    const revealNow = () => {
      const editor = ref.current;
      const container = scrollContainerRef.current;
      if (editor && !editor.isDestroyed && container)
        scrollCaretIntoView(editor, container);
    };
    return {
      ref,
      scrollContainerRef,
      agreed,
      isSilent: () => silent.current,
      commit: (editor, value = promptEditorValueFromDoc(editor.state.doc)) => {
        agreed.current = value;
        latest.current.onChange(value.text, value.mentions);
      },
      silently: (run) => {
        silent.current = true;
        try {
          run();
        } finally {
          silent.current = false;
        }
      },
      reveal: () => {
        if (typeof requestAnimationFrame !== "function") return revealNow();
        if (revealFrame.current !== null)
          cancelAnimationFrame(revealFrame.current);
        revealFrame.current = requestAnimationFrame(() => {
          revealFrame.current = null;
          revealNow();
        });
      },
      draft: () => {
        const { text, mentions, onChange } = latest.current;
        return { text, mentions, change: onChange };
      },
    };
  }, [latest]);
}

function scrollCaretIntoView(editor: Editor, container: HTMLElement): void {
  const box = container.getBoundingClientRect();
  if (box.height <= 0) return;
  let caret: { top: number; bottom: number };
  try {
    caret = editor.view.coordsAtPos(editor.state.selection.head);
  } catch {
    return;
  }
  const above = caret.top - box.top - CARET_REVEAL_MARGIN_PX;
  const below = caret.bottom - box.bottom + CARET_REVEAL_MARGIN_PX;
  if (above < 0) {
    container.scrollTop = Math.max(0, container.scrollTop + above);
  } else if (below > 0) {
    container.scrollTop += below;
  }
}

export function focusEditorAtEnd(editor: Editor): void {
  const { state, view } = editor;
  view.dispatch(
    state.tr.setSelection(TextSelection.atEnd(state.doc)).scrollIntoView(),
  );
  view.focus();
}

/** Links inside the prompt are text to edit, never somewhere to go. */
export function suppressPromptEditorAnchorActivation(event: Event): boolean {
  if (!(event.target instanceof Element) || !event.target.closest("a[href]"))
    return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

/**
 * Typing reaches React after paint (see usePromptDraftStorage). A key that acts
 * on the draft catches React up first, so it sees every typed letter.
 */
function flushTypedDraftBefore(event: KeyboardEvent): void {
  const isShortcut = (event.metaKey || event.ctrlKey) && event.key.length === 1;
  if (isShortcut || KEYS_THAT_ACT_ON_THE_DRAFT.has(event.key)) {
    flushSync(flushPromptDraftNotifies);
  }
}

function isIPadWebKit(): boolean {
  if (typeof navigator === "undefined") return false;
  const { vendor, userAgent, platform, maxTouchPoints } = navigator;
  const isIPad =
    platform === "iPad" || (platform === "MacIntel" && maxTouchPoints > 2);
  return (
    isIPad &&
    /Apple Computer/u.test(vendor) &&
    /\bAppleWebKit\//u.test(userAgent)
  );
}

export interface PromptEditorOptions {
  id: string | undefined;
  text: string;
  mentions: readonly PromptTextMention[];
  placeholder: string;
  hasModifierSubmit: boolean;
  editable: boolean;
  isPointerCoarse: boolean;
  autoFocus: boolean;
  allowSoftKeyboardAutoFocus: boolean;
  /** Changing either key moves focus: the scope key re-runs autofocus, the end key puts the caret last. */
  focusScopeKey: string | number | undefined;
  focusEndKey: string | number | undefined;
  minHeight: number;
  promptActions: readonly PromptBoxAction[] | undefined;
  /** Plugin text effects. A new object repaints them. */
  decorations: {
    sources: readonly PromptDecorationSource[];
    observers: readonly PromptDraftObserver[];
  };
  decorationScopeKey: string;
  /** Files found in a paste. Absent when the box takes no attachments. */
  onPasteFiles: ((files: File[]) => void) | undefined;
  onFocus: (() => void) | undefined;
  onBlur: () => void;
  /** Returns true when it handled the key. */
  onKeyDown: (event: KeyboardEvent, isIPadHardwareEnter: boolean) => boolean;
  onCaretMove: (editor: Editor) => void;
  onEdit: (transaction: Transaction) => void;
  /** The parent replaced the draft with a value the editor did not produce. */
  onValueReplaced: (editor: Editor) => void;
}

export function usePromptEditor(
  doc: PromptDocument,
  options: PromptEditorOptions,
) {
  const {
    text,
    mentions,
    placeholder,
    editable,
    isPointerCoarse,
    autoFocus,
    focusScopeKey,
    focusEndKey,
    minHeight,
    decorations,
    decorationScopeKey,
  } = options;
  const latest = useLatest(options);
  const [richText] = useRichTextEditingPreference();
  const [isIPad] = useState(isIPadWebKit);
  const enterKeyHint = isPointerCoarse ? "enter" : "send";
  const avoidSoftKeyboard =
    isPointerCoarse && !options.allowSoftKeyboardAutoFocus;
  const imeConfirmedAt = useRef(Number.NEGATIVE_INFINITY);
  const [imeConfirmKeys] = useState(() => new WeakSet<KeyboardEvent>());
  /** A focus-at-end request that arrived before the editor existed. */
  const wantsFocusAtEnd = useRef(false);

  const extensions = useMemo(
    () =>
      promptEditorExtensions({
        richTextEditing: richText,
        getPlaceholder: () => latest.current.placeholder,
        getDecorationSources: () => latest.current.decorations.sources,
        getDraftObservers: () => latest.current.decorations.observers,
      }),
    [latest, richText],
  );
  // Each editor instance starts from the draft as it was when the instance was made.
  const initial = useMemo(() => {
    const value = { text, mentions };
    return {
      value,
      content: promptEditorContentFromValue(value, {
        richTextMarkdown: richText,
      }),
    };
    // oxlint-disable-next-line react/exhaustive-deps -- later changes to the draft reach the editor through the sync effect below, not by remaking it.
  }, [richText]);

  const keyDown = (event: KeyboardEvent, isIPadHardwareEnter: boolean) => {
    const isComposing =
      event.isComposing || event.keyCode === 229 || imeConfirmKeys.has(event);
    return isComposing
      ? false
      : latest.current.onKeyDown(event, isIPadHardwareEnter);
  };

  const editor = useEditor(
    {
      extensions,
      content: initial.content,
      immediatelyRender: false,
      editorProps: {
        attributes: {
          "aria-label": placeholder,
          "data-placeholder": placeholder,
          ...(options.hasModifierSubmit
            ? { "aria-keyshortcuts": modifierSubmitShortcutAria() }
            : {}),
          autocomplete: "off",
          class: cn(
            "min-h-full whitespace-pre-wrap break-words outline-none",
            "placeholder:select-none placeholder:text-subtle-foreground",
          ),
          enterkeyhint: enterKeyHint,
          ...(options.id ? { id: options.id } : {}),
          role: "textbox",
        },
        clipboardTextSerializer: (slice, view) =>
          promptEditorClipboardTextFromSlice(slice, view.state.schema),
        handleDOMEvents: {
          auxclick: (_view, event) =>
            suppressPromptEditorAnchorActivation(event),
          click: (_view, event) => suppressPromptEditorAnchorActivation(event),
          focus: () => {
            latest.current.onFocus?.();
            return false;
          },
          blur: () => {
            latest.current.onBlur();
            return false;
          },
          cut: () => {
            // After the cut has removed its text, a quote may be left empty.
            queueMicrotask(() => {
              const current = doc.ref.current;
              if (current && !current.isDestroyed)
                removeEmptyBlockquotes(current);
            });
            return false;
          },
          compositionend: (view, event) => {
            if (view.composing) imeConfirmedAt.current = event.timeStamp;
            return false;
          },
          // Runs before the editor's own key handling, so it covers every key path.
          keydown: (view, event) => {
            flushTypedDraftBefore(event);
            // An iPad's hardware keyboard reports a coarse pointer, where Enter
            // would otherwise mean "new line". Its real Enter key still submits.
            const isHardwareEnter =
              isIPad &&
              view.editable &&
              event.key === "Enter" &&
              (event.code === "Enter" || event.code === "NumpadEnter") &&
              !view.composing &&
              !event.isComposing &&
              event.keyCode !== 229;
            if (!isHardwareEnter) return false;
            if (
              Math.abs(event.timeStamp - imeConfirmedAt.current) <
              IME_CONFIRM_ENTER_WINDOW_MS
            ) {
              imeConfirmedAt.current = Number.NEGATIVE_INFINITY;
              imeConfirmKeys.add(event);
              return false;
            }
            return keyDown(event, true);
          },
        },
        handleClick: () => {
          if (doc.ref.current) latest.current.onCaretMove(doc.ref.current);
          return false;
        },
        handleKeyDown: (_view, event) => keyDown(event, false),
        handlePaste: (view, event, slice) => {
          const { onPasteFiles, promptActions } = latest.current;
          const files = clipboardFiles(event.clipboardData);
          const tookFiles = onPasteFiles !== undefined && files.length > 0;
          if (tookFiles) {
            event.preventDefault();
            onPasteFiles(files);
          }
          const paste = readPromptPaste({
            clipboard: event.clipboardData,
            slice,
            schema: view.state.schema,
            actions: promptActions,
          });
          if (!paste) return tookFiles;
          event.preventDefault();
          const current = doc.ref.current;
          if (paste.value.text.length === 0 || !current) return true;

          const content =
            paste.kind === "quote"
              ? (promptEditorContentFromValue(paste.value, {
                  richTextMarkdown: richText,
                }).content ?? [])
              : promptEditorInlineContentFromValue(paste.value);
          current
            .chain()
            .focus()
            .insertContent(content)
            .setMeta("uiEvent", "paste")
            .run();
          if (paste.kind === "quote" && !current.isDestroyed) {
            // A pasted quote ends in an empty line the prompt should not keep.
            doc.commit(
              current,
              trimTrailingPromptNewlines(
                promptEditorValueFromDoc(current.state.doc),
              ),
            );
          }
          return true;
        },
      },
      onCreate({ editor: created }) {
        doc.ref.current = created;
        doc.agreed.current = initial.value;
      },
      onSelectionUpdate({ editor: moved, transaction }) {
        if (transaction.docChanged) return;
        latest.current.onCaretMove(moved);
        doc.reveal();
      },
      onUpdate({ editor: edited, transaction }) {
        if (doc.isSilent()) return;
        latest.current.onEdit(transaction);
        doc.commit(edited);
        latest.current.onCaretMove(edited);
        if (transaction.getMeta("uiEvent") !== undefined) doc.reveal();
      },
    },
    [richText],
  );

  useEffect(() => {
    doc.ref.current = editor;
  }, [doc, editor]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (editor.isEditable !== editable) editor.setEditable(editable);
    editor.view.dom.tabIndex = editable ? 0 : -1;
    if (editable) editor.view.dom.removeAttribute("aria-readonly");
    else editor.view.dom.setAttribute("aria-readonly", "true");
  }, [editable, editor]);

  useEffect(() => {
    if (editor && !editor.isDestroyed) refreshPromptDecorations(editor);
  }, [decorationScopeKey, decorations, editor]);

  const focusAtEnd = useCallback(
    (target: Editor) => {
      focusEditorAtEnd(target);
      doc.reveal();
    },
    [doc],
  );

  useLayoutEffect(() => {
    if (!wantsFocusAtEnd.current) return;
    if (isPointerCoarse) {
      wantsFocusAtEnd.current = false;
    } else if (editor) {
      wantsFocusAtEnd.current = false;
      focusAtEnd(editor);
    }
  }, [editor, focusAtEnd, isPointerCoarse]);

  // The attributes above are set once, at creation. These three follow the props.
  useLayoutEffect(() => {
    if (!editor) return;
    editor.view.dom.setAttribute("aria-label", placeholder);
    editor.view.dom.setAttribute("data-placeholder", placeholder);
    editor.view.dom.setAttribute("enterkeyhint", enterKeyHint);
    editor.view.dispatch(editor.state.tr);
  }, [editor, enterKeyHint, placeholder]);

  // Typing reaches the parent after paint, so a re-render can still carry an
  // older `text`. Only a prop that changed may overwrite the editor.
  const appliedProps = useRef<{
    editor: Editor;
    text: string;
    mentions: readonly PromptTextMention[];
  } | null>(null);
  useLayoutEffect(() => {
    if (!editor) return;
    const applied = appliedProps.current;
    if (
      applied?.editor === editor &&
      applied.text === text &&
      applied.mentions === mentions
    ) {
      return;
    }
    appliedProps.current = { editor, text, mentions };
    const next = { text, mentions };
    if (arePromptEditorValuesEqual(doc.agreed.current, next)) return;
    doc.silently(() => {
      editor.commands.setContent(
        promptEditorContentFromValue(next, { richTextMarkdown: richText }),
      );
      doc.agreed.current = next;
    });
    latest.current.onValueReplaced(editor);
    doc.reveal();
  }, [doc, editor, latest, mentions, richText, text]);

  const lastFocusEndKey = useRef(focusEndKey);
  useLayoutEffect(() => {
    if (focusEndKey === undefined || focusEndKey === lastFocusEndKey.current)
      return;
    if (!isPointerCoarse && !editor) return;
    lastFocusEndKey.current = focusEndKey;
    if (!isPointerCoarse && editor) focusAtEnd(editor);
  }, [editor, focusAtEnd, focusEndKey, isPointerCoarse]);

  useLayoutEffect(() => {
    doc.reveal();
  }, [doc, minHeight]);

  useEffect(() => {
    if (!editor) return;
    if (!autoFocus) {
      if (editor.view.dom.contains(document.activeElement))
        blurPromptEditor(editor);
      return;
    }
    if (avoidSoftKeyboard) return;
    const focusNow = () => {
      if (!editor.isDestroyed) focusAtEnd(editor);
    };
    if (typeof window.requestAnimationFrame !== "function") {
      focusNow();
      return;
    }
    const frame = window.requestAnimationFrame(focusNow);
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus, avoidSoftKeyboard, editor, focusAtEnd, focusScopeKey]);

  const focus = useCallback(() => {
    const current = doc.ref.current;
    if (!isPointerCoarse && current && !current.isDestroyed)
      current.commands.focus();
  }, [doc, isPointerCoarse]);

  /** Puts the caret at the end. Touch devices are left alone: focus there opens the keyboard. */
  const focusEnd = useCallback(() => {
    const current = doc.ref.current;
    const ready = current && !current.isDestroyed ? current : null;
    wantsFocusAtEnd.current = !isPointerCoarse && !ready;
    if (!isPointerCoarse && ready) focusAtEnd(ready);
  }, [doc, focusAtEnd, isPointerCoarse]);

  /** Inserts dictated or quoted text at the caret, padded with spaces where words would touch. */
  const insertText = useCallback(
    (raw: string) => {
      const words = raw.replace(/\s+/g, " ").trim();
      if (words.length === 0) return;
      const current = doc.ref.current;
      if (!current) {
        const draft = doc.draft();
        const gap =
          draft.text.length === 0 || /\s$/.test(draft.text) ? "" : " ";
        draft.change(`${draft.text}${gap}${words}`, [...draft.mentions]);
        return;
      }
      const { doc: content, selection } = current.state;
      const before = textBeforeCursor(current);
      const after = content.textBetween(
        selection.to,
        content.content.size,
        "\n",
        "\n",
      );
      const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
      const trail = after.length > 0 && !/^\s/.test(after) ? " " : "";
      const chain = current.chain();
      if (!isPointerCoarse) chain.focus();
      chain.insertContent(`${lead}${words}${trail}`).run();
      if (!isPointerCoarse) doc.reveal();
    },
    [doc, isPointerCoarse],
  );

  const getTextBeforeCursor = useCallback((): string | undefined => {
    const current = doc.ref.current;
    const before = (
      current ? textBeforeCursor(current) : doc.draft().text
    ).trim();
    return before.length > 0 ? before : undefined;
  }, [doc]);

  return { editor, focus, focusEnd, insertText, getTextBeforeCursor };
}
