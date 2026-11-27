import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";

const TEXT_INPUT_REGISTRY_KEY = Symbol.for("cloudroom:composer-text-input");
const composerTextInputPluginKey = new PluginKey("cloudroomComposerTextInput");

export interface ComposerTextInputContext {
  dom: HTMLElement;
  text: string;
  before(maxLen: number): string;
  replace(remove: number, text: string, cursor?: number): boolean;
}
export type ComposerTextInputHandler = (
  input: ComposerTextInputContext,
) => boolean;

function getTextInputHandlers(): Set<ComposerTextInputHandler> | undefined {
  return (
    window as unknown as Record<
      symbol,
      Set<ComposerTextInputHandler> | undefined
    >
  )[TEXT_INPUT_REGISTRY_KEY];
}

function leaf(node: ProseMirrorNode) {
  return node.type.name === "hardBreak" ? "\n" : "\uFFFC";
}

function nodesFromText(schema: Editor["schema"], text: string) {
  if (!text) return [];
  if (!text.includes("\n")) return [schema.text(text)];
  return text
    .split("\n")
    .flatMap((line, index) => [
      ...(index ? [schema.nodes.hardBreak.create()] : []),
      ...(line ? [schema.text(line)] : []),
    ]);
}

// The Snippets plugin requests the current selection before opening its picker, and registers
// a synchronous handleTextInput hook for zero-flicker, single-transaction inline expansion.
export function listenForComposerRange(editor: Editor) {
  const dom = editor.view.dom;

  const textInputPlugin = new Plugin({
    key: composerTextInputPluginKey,
    props: {
      handleTextInput(view, from, to, text, deflt) {
        if (!editor.isEditable || view.composing || !text) return false;
        const handlers = getTextInputHandlers();
        if (!handlers || handlers.size === 0) return false;
        let cachedBefore: string | undefined;
        let cachedMax = -1;
        const input: ComposerTextInputContext = {
          dom: view.dom,
          text,
          before(maxLen: number) {
            if (cachedBefore !== undefined && maxLen <= cachedMax) {
              return cachedBefore;
            }
            const $from = view.state.doc.resolve(from);
            const offset = $from.parentOffset;
            cachedMax = maxLen;
            cachedBefore = $from.parent.textBetween(
              Math.max(0, offset - maxLen),
              offset,
              "\n",
              leaf,
            );
            return cachedBefore;
          },
          replace(remove: number, nextText: string, cursor = nextText.length) {
            if (
              !view.dom.isConnected ||
              editor.isDestroyed ||
              !editor.isEditable ||
              remove < 0
            )
              return false;
            const $from = view.state.doc.resolve(from);
            if (remove - text.length > $from.parentOffset) return false;
            // Commit the typed character first so Cmd+Z restores the raw keyword.
            const inserted = deflt();
            const end = inserted.mapping.map(to);
            const start = end - remove;
            view.dispatch(inserted);
            if (start < 0 || end > view.state.doc.content.size) return true;
            const tr = closeHistory(view.state.tr).replaceWith(
              start,
              end,
              Fragment.fromArray(nodesFromText(editor.schema, nextText)),
            );
            tr.setSelection(
              TextSelection.create(
                tr.doc,
                start + Math.max(0, Math.min(nextText.length, cursor)),
              ),
            );
            view.dispatch(tr.setMeta("snippet", true).scrollIntoView());
            return true;
          },
        };
        for (const handler of handlers) {
          if (handler(input)) return true;
        }
        return false;
      },
    },
  });
  editor.registerPlugin(textInputPlugin, (plugin, plugins) => [
    plugin,
    ...plugins,
  ]);

  function onRequest(event: Event) {
    const receive = (event as CustomEvent).detail;
    if (
      typeof receive !== "function" ||
      !editor.isEditable ||
      editor.view.composing
    )
      return;
    const owner = dom
      .closest("[data-promptbox]")
      ?.getAttribute("data-composer-key");
    const { doc, selection } = editor.state;
    const { from, to, $from } = selection;
    // Keywords are at most 128 characters. A paragraph boundary occupies two document positions.
    const offset = $from.parentOffset;
    let before = $from.parent.textBetween(
      Math.max(0, offset - 130),
      offset,
      "\n",
      leaf,
    );
    const sibling = $from.index(-1) - 1;
    const previous =
      offset === 0 && sibling >= 0 ? $from.node(-1).child(sibling) : null;
    if (previous?.isTextblock)
      before =
        previous.textBetween(
          Math.max(0, previous.content.size - 129),
          previous.content.size,
          "\n",
          leaf,
        ) + "\n";
    receive({
      before,
      selected: from !== to,
      selectedText: from === to ? "" : doc.textBetween(from, to, "\n"),
      replace(remove: number, text: string, cursor = text.length) {
        if (
          !dom.isConnected ||
          editor.isDestroyed ||
          !editor.isEditable ||
          owner !==
            dom
              .closest("[data-promptbox]")
              ?.getAttribute("data-composer-key") ||
          doc !== editor.state.doc ||
          !selection.eq(editor.state.selection) ||
          remove < 0 ||
          remove > before.length
        )
          return false;
        const start =
          from - remove - (remove > 0 && previous?.isTextblock ? 1 : 0);
        const tr = closeHistory(editor.state.tr).replaceWith(
          start,
          to,
          Fragment.fromArray(nodesFromText(editor.schema, text)),
        );
        tr.setSelection(
          TextSelection.create(
            tr.doc,
            start + Math.max(0, Math.min(text.length, cursor)),
          ),
        );
        editor.view.dispatch(tr.setMeta("snippet", true).scrollIntoView());
        editor.view.focus();
        return true;
      },
    });
  }
  dom.addEventListener("cloudroom:composer-text-range", onRequest);
  // Tiptap handles Shift+Enter itself, so the browser may never emit an input event.
  const onUpdate = ({ transaction }: { transaction: Transaction }) => {
    if (
      transaction.getMeta("snippet") ||
      !editor.isFocused ||
      editor.view.composing
    )
      return;
    const { $from, empty } = transaction.selection;
    if (
      empty &&
      ($from.parentOffset === 0 || $from.nodeBefore?.type.name === "hardBreak")
    )
      dom.dispatchEvent(
        new Event("cloudroom:composer-break", { bubbles: true }),
      );
  };
  editor.on("update", onUpdate);
  return () => {
    dom.removeEventListener("cloudroom:composer-text-range", onRequest);
    editor.off("update", onUpdate);
    if (!editor.isDestroyed)
      editor.unregisterPlugin(composerTextInputPluginKey);
  };
}
