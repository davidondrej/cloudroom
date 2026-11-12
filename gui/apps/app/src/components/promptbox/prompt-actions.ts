// Plus-menu actions ("Plan", "Goal", "Skills"...): what each one inserts, and where.
import {
  findActiveTrigger,
  type ProviderCommandSuggestion,
  type TypeaheadTrigger,
} from "@cloudroom/client-core";
import type {
  PromptMentionCommandTrigger,
  PromptTextMention,
} from "@cloudroom/domain";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/react";
import {
  parsePromptEditorMentionAttrs,
  promptCommandResourceFromSuggestion,
} from "./editor/prompt-editor-serialization";
import type { PromptBoxAction } from "./PromptBoxActionsMenu";

/** An action that inserts a command pill such as `/plan`. */
export interface PromptActionCommand {
  serializedText: string;
  trailingText: string;
  trigger: PromptMentionCommandTrigger;
  suggestion: ProviderCommandSuggestion;
}

interface DocRange {
  from: number;
  to: number;
}

/** Null for actions that insert plain text (and for "Skills", which only types `/`). */
export function promptActionCommand(
  action: PromptBoxAction,
): PromptActionCommand | null {
  if (action.kind === "skills" || !action.command) return null;
  const { trigger, name, trailingText } = action.command;
  return {
    serializedText: `${trigger}${name}`,
    trailingText,
    trigger,
    suggestion: {
      kind: "command",
      name,
      source: "command",
      origin: "user",
      description: null,
      argumentHint: null,
    },
  };
}

export function promptActionCommandMention(
  command: PromptActionCommand,
  start: number,
): PromptTextMention {
  return {
    start,
    end: start + command.serializedText.length,
    resource: promptCommandResourceFromSuggestion({
      suggestion: command.suggestion,
      trigger: command.trigger,
    }),
  };
}

/** The triggers to scan with, so an action's own trigger counts even with no `/` menu. */
export function triggersForPromptAction(
  triggers: readonly TypeaheadTrigger[],
  command: PromptActionCommand | null,
): readonly TypeaheadTrigger[] {
  const known =
    command === null ||
    triggers.some(
      ({ kind, char }) => kind === "command" && char === command.trigger,
    );
  return known
    ? triggers
    : [...triggers, { kind: "command", char: command.trigger }];
}

export function textBeforeCursor(editor: Editor): string {
  const { doc, selection } = editor.state;
  return doc.textBetween(0, selection.from, "\n", "\n");
}

/** True when the caret already sits right after this action's text. */
export function isPromptActionAtCursor(
  editor: Editor,
  action: PromptBoxAction,
): boolean {
  return (
    editor.state.selection.empty &&
    textBeforeCursor(editor).endsWith(action.text)
  );
}

/**
 * The action just before the caret (only spaces may sit between), so picking
 * another action replaces it instead of stacking a second one.
 */
function previousActionRange(
  editor: Editor,
  actions: readonly PromptBoxAction[],
): DocRange | null {
  const { $from, from: caret } = editor.state.selection;
  const blockStart = $from.start();
  let offset = $from.parentOffset;

  while (offset > 0) {
    const { node, offset: nodeStart } = $from.parent.childBefore(offset);
    if (!node) return null;
    const lengthBeforeOffset = offset - nodeStart;

    if (!node.isText) {
      const isWholeActionPill =
        lengthBeforeOffset === node.nodeSize &&
        isActionCommandPill(node, actions);
      return isWholeActionPill
        ? { from: blockStart + nodeStart, to: caret }
        : null;
    }

    const text = (node.text ?? "").slice(0, lengthBeforeOffset);
    const typed = actions.find(
      (action) =>
        !action.command && action.text.length > 0 && text.endsWith(action.text),
    );
    if (typed) {
      const from = blockStart + nodeStart + text.length - typed.text.length;
      return { from, to: caret };
    }
    if (/\S/u.test(text)) return null;
    offset = nodeStart;
  }
  return null;
}

function isActionCommandPill(
  node: ProseMirrorNode,
  actions: readonly PromptBoxAction[],
): boolean {
  if (node.type.name !== "mention") return false;
  const attrs = parsePromptEditorMentionAttrs(node.attrs);
  if (!attrs || attrs.resource.kind !== "command") return false;
  const { trigger, name } = attrs.resource;
  return actions.some(
    ({ command }) =>
      command !== undefined &&
      command.trigger === trigger &&
      command.name === name &&
      attrs.serializedText === `${command.trigger}${command.name}`,
  );
}

/**
 * Where an action's text goes. Null means nothing to insert: "Skills" was
 * picked and its `/` is already typed at the caret.
 */
export function promptActionInsertionRange({
  editor,
  action,
  actions,
  triggers,
}: {
  editor: Editor;
  action: PromptBoxAction;
  actions: readonly PromptBoxAction[];
  triggers: readonly TypeaheadTrigger[];
}): DocRange | null {
  const { selection } = editor.state;
  const atSelection = { from: selection.from, to: selection.to };
  if (!selection.empty) return atSelection;

  const previous = previousActionRange(editor, actions);
  if (previous) return previous;

  const typed = findActiveTrigger(editor, triggers);
  const typedCommand =
    typed?.kind === "command" && typed.to === selection.from ? typed : null;
  if (action.kind === "skills") {
    return typedCommand?.char === action.text ? null : atSelection;
  }
  return typedCommand
    ? { from: typedCommand.from, to: typedCommand.to }
    : atSelection;
}
