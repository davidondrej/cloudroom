// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { expect, it } from "vitest";
import { listenForComposerRange } from "./composer-text-range";
import { promptEditorExtensions } from "./prompt-editor-extensions";

function composer(element: HTMLElement, content: string) {
  const editor = new Editor({
    element,
    extensions: promptEditorExtensions({
      richTextEditing: true,
      getPlaceholder: () => "",
    }),
    content,
  });
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  listenForComposerRange(editor);
  return editor;
}

interface Range {
  before: string;
  replace(remove: number, text: string): boolean;
}
function capture(editor: Editor): Range {
  let range!: Range;
  editor.view.dom.dispatchEvent(
    new CustomEvent("cloudroom:composer-text-range", {
      detail: (value: Range) => {
        range = value;
      },
    }),
  );
  return range;
}

it.each(["<p>Draft !ok<br></p>", "<p>Draft !ok</p><p></p>"])(
  "expands across an inserted newline only in the originating draft",
  (content) => {
    const first = document.createElement("div"),
      second = document.createElement("div");
    document.body.append(first, second);
    const main = composer(first, content),
      queued = composer(second, "<p>Queued</p>");
    try {
      const range = capture(main);
      expect(range.before).toBe("Draft !ok\n");
      expect(range.replace(4, "Done")).toBe(true);
      expect(main.getText()).toBe("Draft Done");
      expect(queued.getText()).toBe("Queued");
      const stale = capture(main);
      main.commands.insertContent("!");
      expect(stale.replace(0, "Old argument")).toBe(false);
      expect(main.getText()).toBe("Draft Done!");
    } finally {
      main.destroy();
      queued.destroy();
      first.remove();
      second.remove();
    }
  },
);
