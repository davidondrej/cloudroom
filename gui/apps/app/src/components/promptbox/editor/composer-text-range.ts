import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { TextSelection } from "@tiptap/pm/state";
import { Fragment } from "@tiptap/pm/model";

// The Snippets plugin requests the current selection before opening its picker. A later insert
// can restore focus, but must never overwrite typing that happened while a form was open.
export function listenForComposerRange(editor: Editor) {
  const dom = editor.view.dom;
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
    const leaf = (node: typeof doc) =>
      node.type.name === "hardBreak" ? "\n" : "\uFFFC";
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
      selectedText: doc.textBetween(from, to, "\n"),
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
        const nodes = text
          .split("\n")
          .flatMap((line, index) => [
            ...(index ? [editor.schema.nodes.hardBreak.create()] : []),
            ...(line ? [editor.schema.text(line)] : []),
          ]);
        const start =
          from - remove - (remove > 0 && previous?.isTextblock ? 1 : 0);
        const tr = closeHistory(editor.state.tr).replaceWith(
          start,
          to,
          Fragment.fromArray(nodes),
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
  const onUpdate = ({
    transaction,
  }: {
    transaction: import("@tiptap/pm/state").Transaction;
  }) => {
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
  };
}
