// What each key does in the prompt. Handlers run in order; the first one that takes the key wins.
import type { Editor } from "@tiptap/react";
import { blurPromptEditor } from "./ComposerEditorSlot";
import {
  exitTrailingBlockquoteBreak,
  insertParagraphBeforeBlockquote,
} from "./editor/prompt-editor-blockquote";
import { exitHeading } from "./editor/prompt-editor-heading";
import { applyPromptListNewline } from "./editor/prompt-editor-list";
import { applyPromptParagraphNewline } from "./editor/prompt-editor-paragraph";
import { isModifierSubmitKeyEvent } from "./modifier-submit-shortcut";
import type { PromptHistory } from "./usePromptHistory";
import type { PromptTypeahead } from "./usePromptTypeahead";

export interface PromptKeyContext {
  event: KeyboardEvent;
  editor: Editor | null;
  /** False on touch keyboards, where Enter starts a new line. */
  enterSubmits: boolean;
  typeahead: PromptTypeahead;
  history: PromptHistory;
  ghostText: string | null;
  acceptGhostText: () => void;
  onEscape: (() => void) | undefined;
  /** Runs before Enter submits. Returning true keeps the prompt unsent. */
  onEnterKey: (() => boolean) | undefined;
  /** App-wide shortcuts get the key before the prompt does. */
  runAppShortcut: (event: KeyboardEvent) => boolean;
  submit: () => void;
  /** Submits once the draft typed so far has reached the parent. */
  submitAfterRender: () => void;
  /** Absent when the box has no Cmd+Enter action. */
  submitWithModifier: (() => void) | undefined;
}

type PromptKeyHandler = (context: PromptKeyContext) => boolean;

const hasModifier = (event: KeyboardEvent) =>
  event.shiftKey || event.altKey || event.metaKey || event.ctrlKey;

/** Arrow keys recall history only from the end of the draft, so they still move the caret inside it. */
function browsesHistory({ event, editor, history }: PromptKeyContext): boolean {
  if (!history.canBrowse || hasModifier(event) || !editor) return false;
  const { selection, doc } = editor.state;
  return selection.empty && selection.from >= doc.content.size - 1;
}

const typeaheadKeys: PromptKeyHandler = (context) => {
  const { event, typeahead } = context;
  if (!typeahead.isOpen) return false;
  const hasRows = typeahead.suggestions.length > 0;
  // An open menu always owns the arrows. History never competes for them:
  // recalling a prompt closes the menu (see `closeAt`).
  const movesSelection = hasRows && !hasModifier(event);

  if (event.key === "ArrowDown" && movesSelection) {
    typeahead.selectNext();
  } else if (event.key === "ArrowUp" && movesSelection) {
    typeahead.selectPrevious();
  } else if ((event.key === "Enter" || event.key === "Tab") && hasRows) {
    const picked = typeahead.applySelected();
    // A built-in command such as /compact has no arguments, so Enter also sends it.
    if (
      event.key === "Enter" &&
      picked?.kind === "command" &&
      picked.origin === "builtin"
    ) {
      context.submitAfterRender();
    }
  } else if (event.key === "Escape") {
    typeahead.dismiss();
  } else {
    return false;
  }
  event.preventDefault();
  return true;
};

const ghostTextKey: PromptKeyHandler = ({
  event,
  editor,
  ghostText,
  acceptGhostText,
}) => {
  const accepts = event.key === "Tab" || event.key === "ArrowRight";
  if (!ghostText || !accepts || hasModifier(event) || !editor?.isEmpty)
    return false;
  event.preventDefault();
  acceptGhostText();
  return true;
};

const escapeKey: PromptKeyHandler = ({ event, editor, onEscape }) => {
  if (event.key !== "Escape") return false;
  if (onEscape) onEscape();
  else blurPromptEditor(editor);
  return true;
};

const historyKeys: PromptKeyHandler = (context) => {
  const { event, history } = context;
  const recalled =
    browsesHistory(context) &&
    ((event.key === "ArrowUp" && history.showOlder()) ||
      (event.key === "ArrowDown" && history.showNewer()));
  if (recalled) event.preventDefault();
  return recalled;
};

const modifierSubmitKey: PromptKeyHandler = ({ event, submitWithModifier }) => {
  if (!submitWithModifier || !isModifierSubmitKeyEvent(event)) return false;
  event.preventDefault();
  submitWithModifier();
  return true;
};

/** Enter as a new line: Shift+Enter anywhere, and plain Enter where Enter does not submit. */
const newlineKey: PromptKeyHandler = ({ event, editor, enterSubmits }) => {
  if (
    event.key !== "Enter" ||
    event.metaKey ||
    event.altKey ||
    event.ctrlKey ||
    !editor
  ) {
    return false;
  }
  const leftBlock =
    event.shiftKey &&
    (applyPromptListNewline(editor) ||
      insertParagraphBeforeBlockquote(editor) ||
      exitTrailingBlockquoteBreak(editor));
  const brokeLine =
    leftBlock ||
    ((event.shiftKey || !enterSubmits) &&
      (exitHeading(editor) || applyPromptParagraphNewline(editor)));
  if (brokeLine) event.preventDefault();
  return brokeLine;
};

const submitKey: PromptKeyHandler = ({
  event,
  enterSubmits,
  onEnterKey,
  submit,
}) => {
  if (!enterSubmits || event.key !== "Enter" || event.shiftKey) return false;
  event.preventDefault();
  if (!onEnterKey?.()) submit();
  return true;
};

const HANDLERS: readonly PromptKeyHandler[] = [
  typeaheadKeys,
  ghostTextKey,
  escapeKey,
  historyKeys,
  modifierSubmitKey,
  newlineKey,
  submitKey,
];

/** Returns true when the key was handled and the editor must not act on it. */
export function handlePromptKey(context: PromptKeyContext): boolean {
  return (
    context.runAppShortcut(context.event) ||
    HANDLERS.some((handle) => handle(context))
  );
}
