// Turns what is on the clipboard into prompt text plus mention pills. No React, no editor state.
import type { PromptTextMention } from "@cloudroom/domain";
import type { Schema, Slice } from "@tiptap/pm/model";
import {
  promptEditorValueFromSlice,
  type PromptEditorValue,
} from "./editor/prompt-editor-serialization";
import { parsePromptMentionClipboardElement } from "./mentions/prompt-mention-clipboard";
import {
  promptActionCommand,
  promptActionCommandMention,
} from "./prompt-actions";
import type { PromptBoxAction } from "./PromptBoxActionsMenu";

/** A quote is pasted as blocks; everything else is pasted inline at the caret. */
export interface PromptPaste {
  kind: "quote" | "inline";
  value: PromptEditorValue;
}

// Tags that start and end a line of their own.
const BLOCK_TAGS = new Set(
  "ADDRESS ARTICLE ASIDE BLOCKQUOTE DIV DD DL DT FIGCAPTION FIGURE FOOTER FORM H1 H2 H3 H4 H5 H6 HEADER HR MAIN NAV P SECTION TABLE TBODY TD TFOOT TH THEAD TR".split(
    " ",
  ),
);
const SKIPPED_TAGS = new Set(
  "HEAD LINK META NOSCRIPT SCRIPT STYLE TITLE".split(" "),
);

const byPosition = (left: PromptTextMention, right: PromptTextMention) =>
  left.start - right.start || left.end - right.end;

const unixNewlines = (text: string) => text.replace(/\r\n?/gu, "\n");

export function clipboardFiles(clipboard: DataTransfer | null): File[] {
  return Array.from(clipboard?.items ?? [])
    .map((item) => (item.kind === "file" ? item.getAsFile() : null))
    .filter((file): file is File => file !== null);
}

export function trimTrailingPromptNewlines(
  value: PromptEditorValue,
): PromptEditorValue {
  const text = value.text.replace(/\n+$/u, "");
  if (text.length === value.text.length) return value;
  return {
    text,
    mentions: value.mentions.filter(({ end }) => end <= text.length),
  };
}

/** Decides how a paste lands. Null means the clipboard holds no text for the prompt. */
export function readPromptPaste({
  clipboard,
  slice,
  schema,
  actions,
}: {
  clipboard: DataTransfer | null;
  slice: Slice;
  schema: Schema;
  actions: readonly PromptBoxAction[] | undefined;
}): PromptPaste | null {
  const plain = clipboard?.getData("text/plain") ?? "";
  if (sliceHasQuote(slice)) {
    const quoted = promptEditorValueFromSlice(slice, schema);
    return { kind: "quote", value: trimTrailingPromptNewlines(quoted) };
  }
  if (hasQuoteLine(plain)) {
    const quoted = valueFromPlainText(plain, actions);
    return { kind: "quote", value: trimTrailingPromptNewlines(quoted) };
  }

  // Rich text wins only when it carries our own mention pills.
  const html = clipboard?.getData("text/html") ?? "";
  const rich = html.trim().length > 0 ? valueFromHtml(html) : null;
  if (rich?.hasPills) {
    return {
      kind: "inline",
      value: withActionCommandPills(rich.value, actions),
    };
  }
  if (plain.length > 0) {
    return { kind: "inline", value: valueFromPlainText(plain, actions) };
  }
  return rich ? { kind: "inline", value: rich.value } : null;
}

function sliceHasQuote(slice: Slice): boolean {
  let found = false;
  slice.content.descendants((node) => {
    found ||= node.type.name === "blockquote";
    return !found;
  });
  return found;
}

function hasQuoteLine(text: string): boolean {
  return unixNewlines(text)
    .split("\n")
    .some((line) => line === ">" || line.startsWith("> "));
}

function valueFromPlainText(
  text: string,
  actions: readonly PromptBoxAction[] | undefined,
): PromptEditorValue {
  return withActionCommandPills(
    { text: unixNewlines(text), mentions: [] },
    actions,
  );
}

/** Pasted text such as "/plan do it" gets its command back as a pill. */
function withActionCommandPills(
  value: PromptEditorValue,
  actions: readonly PromptBoxAction[] | undefined,
): PromptEditorValue {
  const { text } = value;
  const isBoundary = (char: string | undefined) =>
    char === undefined || /\s/u.test(char);
  const found: PromptTextMention[] = [];
  for (const action of actions ?? []) {
    const command = promptActionCommand(action);
    if (!command) continue;
    const token = command.serializedText;
    for (
      let start = text.indexOf(token);
      start !== -1;
      start = text.indexOf(token, start + token.length)
    ) {
      if (
        isBoundary(text[start - 1]) &&
        isBoundary(text[start + token.length])
      ) {
        found.push(promptActionCommandMention(command, start));
      }
    }
  }
  if (found.length === 0) return value;

  // Mentions the paste already carried win over a command found at the same spot.
  const mentions = [...value.mentions].sort(byPosition);
  for (const mention of found.sort(byPosition)) {
    const overlaps = mentions.some(
      ({ start, end }) => mention.start < end && mention.end > start,
    );
    if (!overlaps) mentions.push(mention);
  }
  return { ...value, mentions: mentions.sort(byPosition) };
}

/** Flattens copied HTML to plain lines, keeping any mention pills copied from a prompt. */
function valueFromHtml(html: string): {
  value: PromptEditorValue;
  hasPills: boolean;
} {
  let text = "";
  const mentions: PromptTextMention[] = [];

  const endLine = () => {
    text = text.replace(/[ \t]+$/u, "");
    if (text.length > 0 && !text.endsWith("\n")) text += "\n";
  };
  const addInlineText = (raw: string) => {
    const collapsed = raw.replace(/\s+/gu, " ");
    if (collapsed.trim().length > 0) {
      text += collapsed;
    } else if (text.length > 0 && !/\s$/u.test(text)) {
      text += " ";
    }
  };
  const addLine = (write: () => void) => {
    endLine();
    write();
    endLine();
  };
  const visitChildren = (parent: Node) => parent.childNodes.forEach(visit);
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      return addInlineText(node.textContent ?? "");
    }
    if (!(node instanceof Element)) return visitChildren(node);

    const tag = node.tagName.toUpperCase();
    if (SKIPPED_TAGS.has(tag)) return;
    const pill = parsePromptMentionClipboardElement({ element: node });
    if (pill) {
      const start = text.length;
      text += pill.serializedText;
      mentions.push({ start, end: text.length, resource: pill.resource });
    } else if (tag === "BR") {
      endLine();
    } else if (tag === "PRE") {
      addLine(() => (text += unixNewlines(node.textContent ?? "")));
    } else if (tag === "LI") {
      addLine(() => {
        text += "- ";
        visitChildren(node);
      });
    } else if (BLOCK_TAGS.has(tag)) {
      addLine(() => visitChildren(node));
    } else {
      visitChildren(node);
    }
  };
  visitChildren(new DOMParser().parseFromString(html, "text/html").body);

  if (mentions.length > 0) {
    const trimmed = text.replace(/\n+$/u, "");
    const kept = mentions.filter(
      ({ start, end }) => end > start && end <= trimmed.length,
    );
    return { value: { text: trimmed, mentions: kept }, hasPills: true };
  }
  const tidy = text
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/^\n+|\n+$/gu, "");
  return { value: { text: tidy, mentions: [] }, hasPills: false };
}
