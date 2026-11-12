// The `@` and `/` menus: which trigger is being typed, what to suggest, and how a pick lands in the editor.
import {
  commandPillDismissedRangeEnd,
  DEFAULT_PLUGIN_MENTION_TRIGGER,
  filterCommandSuggestions,
  findActiveTrigger,
  orderCommandSuggestions,
  type ActiveTrigger,
  type PromptMentionSuggestion,
  type ProviderCommandSuggestion,
  type TypeaheadTrigger,
} from "@cloudroom/client-core";
import type { PromptMentionResource } from "@cloudroom/domain";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  promptCommandResourceFromSuggestion,
  promptMentionResourceFromSuggestion,
} from "./editor/prompt-editor-serialization";
import {
  typeaheadSuggestionKey,
  type ComposerCommandMenuState,
  type ComposerTypeaheadMenuState,
  type ModelShortcutCommandSuggestion,
  type TypeaheadSuggestion,
} from "./mentions/MentionMenu";
import { canLoadMoreCommandResults } from "./mentions/mention-menu-scroll";
import {
  isPromptActionAtCursor,
  promptActionCommand,
  promptActionCommandMention,
  promptActionInsertionRange,
  triggersForPromptAction,
} from "./prompt-actions";
import type { PromptBoxAction, PromptBoxProps } from "./prompt-box-types";
import type { PromptDocument } from "./usePromptEditor";

/** A trigger the user closed. Its menu stays shut until the caret leaves this range and returns. */
interface Dismissal {
  start: number;
  end: number;
  caretLeft: boolean;
}

interface PillInsert {
  editor: Editor;
  range: { from: number; to: number };
  resource: PromptMentionResource;
  serializedText: string;
  trailingText: string;
  dismissal: Dismissal | null;
  clearQuery: () => void;
}

type CommandSources = Pick<
  PromptBoxProps,
  "reasoning" | "fastMode" | "modelShortcuts" | "locationCommands"
>;

/** A row of the `/` menu: a provider command or one of our own. */
type CommandSuggestion = Extract<
  ComposerCommandMenuState,
  { kind: "results" }
>["suggestions"][number];

const DEFAULT_MENTION_TRIGGERS = [DEFAULT_PLUGIN_MENTION_TRIGGER] as const;

/** A pill needs a space after it unless one is already there. */
function pillSpacer(doc: ProseMirrorNode, position: number): string {
  const next = doc.resolve(position).nodeAfter;
  const spaced = next?.isText
    ? /^\s/u.test(next.text ?? "")
    : next?.type.name === "hardBreak";
  return spaced ? "" : " ";
}

/**
 * Everything the `/` menu can list. Our own commands (place, fast, reasoning)
 * come first; model shortcuts rank among the provider's commands as skills, so
 * they lead only when they match best.
 */
function listCommands(
  query: string,
  provided: readonly ProviderCommandSuggestion[],
  { reasoning, fastMode, modelShortcuts, locationCommands }: CommandSources,
): { all: CommandSuggestion[]; hasOwn: boolean } {
  const needle = query.trim().toLowerCase();
  const matches = (...words: string[]) =>
    words.join(" ").toLowerCase().includes(needle);

  const own: CommandSuggestion[] = [];
  for (const { name, description } of locationCommands ?? []) {
    if (matches(name, description))
      own.push({ kind: "location", name, description });
  }
  if (fastMode && matches("fast", fastMode.label)) {
    const description = `Turn ${fastMode.enabled ? "off" : "on"} ${fastMode.label} mode`;
    own.push({ kind: "fast-mode", name: "fast", description });
  }
  for (const { value, label } of reasoning?.options ?? []) {
    if (matches(value, label)) {
      own.push({
        kind: "reasoning",
        name: value,
        description: `${label} reasoning`,
      });
    }
  }

  const shortcutBySkill = new Map<
    ProviderCommandSuggestion,
    ModelShortcutCommandSuggestion
  >();
  for (const { name, description, icon } of modelShortcuts ?? []) {
    shortcutBySkill.set(
      {
        kind: "command",
        name,
        source: "skill",
        origin: "user",
        description,
        argumentHint: null,
      },
      { kind: "model-shortcut", name, description, icon },
    );
  }
  const shortcutSkills = filterCommandSuggestions(
    [...shortcutBySkill.keys()],
    query,
  );
  const ranked = orderCommandSuggestions(
    [...provided, ...shortcutSkills],
    query,
  );
  return {
    all: [
      ...own,
      ...ranked.map((skill) => shortcutBySkill.get(skill) ?? skill),
    ],
    hasOwn: own.length > 0 || shortcutSkills.length > 0,
  };
}

export function usePromptTypeahead({
  editor: api,
  typeahead: { mention, command },
  promptActions,
  hidden,
  ...commandSources
}: CommandSources & {
  editor: PromptDocument;
  typeahead: PromptBoxProps["typeahead"];
  promptActions: readonly PromptBoxAction[] | undefined;
  /** Voice input covers the editor, so no menu shows. */
  hidden: boolean;
}) {
  const [active, setActive] = useState<ActiveTrigger | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Caret bookkeeping that must not re-render the composer on every key.
  const track = useRef({
    dismissal: null as Dismissal | null,
    /** True from a pill's insert until the editor has focus again. */
    restoringPill: false,
    /** Identity of the trigger the selection belongs to. */
    key: "",
    /** The last trigger `sync` showed. Other paths only ever clear the state. */
    shown: null as ActiveTrigger | null,
    refocusFrame: null as number | null,
  });
  useEffect(
    () => () => {
      if (track.current.refocusFrame !== null)
        cancelAnimationFrame(track.current.refocusFrame);
    },
    [track],
  );

  const { reasoning, fastMode, modelShortcuts, locationCommands } =
    commandSources;
  const mentionChars = mention.triggers ?? DEFAULT_MENTION_TRIGGERS;
  const hasOwnCommands = Boolean(
    reasoning?.options.length ||
    fastMode ||
    modelShortcuts?.length ||
    locationCommands?.length,
  );
  const commandChar = command.trigger ?? (hasOwnCommands ? "/" : null);
  const triggers = useMemo<TypeaheadTrigger[]>(
    () => [
      ...mentionChars.map((char) => ({ char, kind: "mention" as const })),
      ...(commandChar === null
        ? []
        : [{ char: commandChar, kind: "command" as const }]),
    ],
    [commandChar, mentionChars],
  );

  /** Tells the parent which query to search for. Null clears a kind's results. */
  const announce = (trigger: ActiveTrigger | null) => {
    const typed = trigger?.kind === "mention" ? trigger : null;
    mention.onQueryChange(typed?.query ?? null, typed?.char ?? null);
    command.onQueryChange(trigger?.kind === "command" ? trigger.query : null);
  };

  /** Re-reads the caret and opens, updates, or closes the menu to match. */
  const sync = (editor: Editor) => {
    const caret = editor.state.selection.from;
    const detected = findActiveTrigger(editor, triggers);
    const restoringPill =
      track.current.restoringPill && track.current.dismissal !== null;
    if (track.current.dismissal && !restoringPill) {
      let dismissal = track.current.dismissal;
      if (!dismissal.caretLeft && detected?.from === dismissal.start) {
        dismissal = { ...dismissal, end: Math.max(dismissal.end, caret) };
      }
      const inside = caret >= dismissal.start && caret <= dismissal.end;
      track.current.dismissal = !inside
        ? { ...dismissal, caretLeft: true }
        : dismissal.caretLeft
          ? null
          : dismissal;
    }
    const dismissal = track.current.dismissal;
    const staysShut =
      dismissal !== null &&
      !dismissal.caretLeft &&
      (restoringPill || (caret >= dismissal.start && caret <= dismissal.end));
    const next = staysShut ? null : detected;

    const key = next
      ? `${next.kind}:${next.from}:${next.to}:${next.query}`
      : "";
    if (key !== track.current.key) {
      track.current.key = key;
      setSelectedKey(null);
    }
    // Plain typing (no menu before, none now) must not set state: even a
    // same-value setState can re-render the whole composer on every key.
    if (next === null && track.current.shown === null) return;
    track.current.shown = next;
    setActive(next);
    announce(next);
  };

  /** Keeps a dismissed range on its text as the document changes around it. */
  const trackEdit = (transaction: Transaction) => {
    const dismissal = track.current.dismissal;
    if (!dismissal || !transaction.docChanged || track.current.restoringPill)
      return;
    const start = transaction.mapping.mapResult(dismissal.start, 1);
    track.current.dismissal = start.deleted
      ? null
      : {
          ...dismissal,
          start: start.pos,
          end: transaction.mapping.map(dismissal.end, -1),
        };
  };

  const close = () => {
    track.current.key = "";
    setActive(null);
    announce(null);
  };
  const closeOnBlur = () => {
    if (track.current.dismissal)
      track.current.dismissal = { ...track.current.dismissal, caretLeft: true };
    close();
  };
  const dismiss = () => {
    if (active) {
      track.current.dismissal = {
        start: active.from,
        end: active.to,
        caretLeft: false,
      };
    }
    close();
  };
  /**
   * Keeps the menu shut for a trigger the user did not just type, such as the
   * `@file` a recalled prompt ends in. It reopens like any dismissed trigger:
   * once the caret leaves it and comes back.
   */
  const closeAt = (editor: Editor) => {
    const typed = findActiveTrigger(editor, triggers);
    if (typed) {
      track.current.dismissal = {
        start: typed.from,
        end: typed.to,
        caretLeft: false,
      };
    }
    close();
  };
  /** The parent replaced the draft, so nothing remembered about the old text holds. */
  const forget = () => {
    track.current.dismissal = null;
    track.current.key = "";
  };

  /** Reports the edit, then returns focus to the editor on the next frame. */
  const settle = (editor: Editor) => {
    api.commit(editor);
    requestAnimationFrame(() => {
      const current = api.ref.current;
      if (current && !current.isDestroyed) {
        current.commands.focus();
        sync(current);
        api.reveal();
      }
      track.current.restoringPill = false;
    });
  };

  const insertPill = (pill: PillInsert) => {
    track.current.key = "";
    track.current.dismissal = pill.dismissal;
    track.current.restoringPill = true;
    setActive(null);
    setSelectedKey(null);
    pill.clearQuery();
    api.silently(() =>
      pill.editor
        .chain()
        .focus()
        .deleteRange(pill.range)
        .insertContent([
          {
            type: "mention",
            attrs: {
              resource: pill.resource,
              serializedText: pill.serializedText,
            },
          },
          ...(pill.trailingText
            ? [{ type: "text", text: pill.trailingText }]
            : []),
        ])
        .run(),
    );
    settle(pill.editor);
  };

  const applyMention = (item: PromptMentionSuggestion) => {
    const editor = api.ref.current;
    if (!editor || active?.kind !== "mention") return;
    const replacement = item.replacement.trim();
    insertPill({
      editor,
      range: { from: active.from, to: active.to },
      resource: promptMentionResourceFromSuggestion(item),
      serializedText: replacement.startsWith(active.char)
        ? replacement
        : `${active.char}${replacement}`,
      trailingText: pillSpacer(editor.state.doc, active.to),
      dismissal: { start: active.from, end: active.from + 2, caretLeft: false },
      clearQuery: () => mention.onQueryChange(null, null),
    });
  };

  const applyCommand = (item: ProviderCommandSuggestion) => {
    const editor = api.ref.current;
    if (!editor || active === null || active.char !== "/") return;
    const trailingText = pillSpacer(editor.state.doc, active.to);
    insertPill({
      editor,
      range: { from: active.from, to: active.to },
      resource: promptCommandResourceFromSuggestion({
        suggestion: item,
        trigger: active.char,
      }),
      serializedText: `${active.char}${item.name}`,
      trailingText,
      dismissal: {
        start: active.from,
        end: commandPillDismissedRangeEnd({
          triggerPosition: active.from,
          trailingText,
        }),
        caretLeft: false,
      },
      clearQuery: () => command.onQueryChange(null),
    });
  };

  // Our own commands change a setting instead of inserting text, so they only
  // remove what was typed.
  const runOwnCommand = (run: (() => void) | undefined) => {
    const editor = api.ref.current;
    if (!run || !editor?.isEditable || active?.kind !== "command") return;
    editor
      .chain()
      .focus()
      .deleteRange({ from: active.from, to: active.to })
      .run();
    run();
    api.reveal();
  };

  const apply = (item: TypeaheadSuggestion) => {
    switch (item.kind) {
      case "location":
        return runOwnCommand(
          locationCommands?.find(({ name }) => name === item.name)?.onSelect,
        );
      case "fast-mode":
        return runOwnCommand(fastMode?.onToggle);
      case "model-shortcut":
        return runOwnCommand(
          modelShortcuts?.find(({ name }) => name === item.name)?.onSelect,
        );
      case "reasoning":
        return runOwnCommand(
          reasoning?.options.some(({ value }) => value === item.name)
            ? () => reasoning.onChange(item.name)
            : undefined,
        );
      case "command":
        return applyCommand(item);
      default:
        return applyMention(item);
    }
  };

  const refocus = (editor: Editor) => {
    const run = () => {
      track.current.refocusFrame = null;
      if (editor.isDestroyed) return;
      editor.commands.focus();
      sync(editor);
      api.reveal();
    };
    if (typeof requestAnimationFrame !== "function") return run();
    if (track.current.refocusFrame !== null)
      cancelAnimationFrame(track.current.refocusFrame);
    track.current.refocusFrame = requestAnimationFrame(run);
  };

  /** A plus-menu pick: puts the action's text or command pill at the caret. */
  const insertAction = (action: PromptBoxAction) => {
    if (action.text.length === 0) return;
    const actionCommand = promptActionCommand(action);
    const editor = api.ref.current;
    if (!editor || editor.isDestroyed) {
      const { text, mentions, change } = api.draft();
      if (text.endsWith(action.text)) return;
      if (actionCommand) {
        const { serializedText, trailingText } = actionCommand;
        change(`${text}${serializedText}${trailingText}`, [
          ...mentions,
          promptActionCommandMention(actionCommand, text.length),
        ]);
      } else {
        change(`${text}${action.text}`, [...mentions]);
      }
      return;
    }

    if (isPromptActionAtCursor(editor, action)) return refocus(editor);
    const range = promptActionInsertionRange({
      editor,
      action,
      actions: promptActions ?? [],
      triggers: triggersForPromptAction(triggers, actionCommand),
    });
    if (!range) return refocus(editor);

    if (actionCommand) {
      return insertPill({
        editor,
        range,
        resource: promptCommandResourceFromSuggestion({
          suggestion: actionCommand.suggestion,
          trigger: actionCommand.trigger,
        }),
        serializedText: actionCommand.serializedText,
        trailingText: actionCommand.trailingText,
        dismissal: null,
        clearQuery: () => command.onQueryChange(null),
      });
    }
    forget();
    setSelectedKey(null);
    editor.chain().focus().deleteRange(range).insertContent(action.text).run();
    settle(editor);
  };

  const kind = active?.kind ?? null;
  const commandQuery = active?.kind === "command" ? active.query : "";
  const commands = useMemo(
    () =>
      listCommands(commandQuery, command.suggestions, {
        reasoning,
        fastMode,
        modelShortcuts,
        locationCommands,
      }),
    [
      command.suggestions,
      commandQuery,
      fastMode,
      locationCommands,
      modelShortcuts,
      reasoning,
    ],
  );
  const suggestions: readonly TypeaheadSuggestion[] =
    kind === "command"
      ? commands.all
      : kind === "mention"
        ? mention.results.suggestions
        : [];
  const selectedAt =
    selectedKey === null
      ? -1
      : suggestions.findIndex(
          (item) => typeaheadSuggestionKey(item) === selectedKey,
        );
  const selectedIndex = Math.max(0, selectedAt);
  const select = (index: number) => {
    const item = suggestions[index];
    if (item) setSelectedKey(typeaheadSuggestionKey(item));
  };

  const canLoadMore =
    kind === "command" &&
    canLoadMoreCommandResults({
      hasMore: command.hasMore,
      isError: command.isError,
      isLoadingMore: command.isLoadingMore,
    });
  const loadMore = command.loadMore;

  // The picked row left the list, so the first row is picked again.
  useEffect(() => {
    if (selectedKey !== null && selectedAt === -1) setSelectedKey(null);
  }, [selectedAt, selectedKey]);

  // Fetch the next page shortly before the selection reaches the end.
  const nearEnd =
    canLoadMore &&
    suggestions.length > 0 &&
    selectedIndex >= Math.max(0, suggestions.length - 3);
  useEffect(() => {
    if (nearEnd) loadMore();
  }, [loadMore, nearEnd, selectedIndex, suggestions.length]);

  const mentionQuery = active?.kind === "mention" ? active.query.trim() : "";
  const commandState: ComposerCommandMenuState =
    !commands.hasOwn && command.isLoading
      ? { kind: "loading" }
      : !commands.hasOwn && command.isError
        ? { kind: "error" }
        : { kind: "results", suggestions: commands.all };
  const menuState: ComposerTypeaheadMenuState =
    kind === "command"
      ? { trigger: "command", state: commandState }
      : {
          trigger: "mention",
          state:
            mentionQuery.length === 0
              ? { kind: "hint" }
              : mention.isLoading
                ? { kind: "loading" }
                : mention.isError
                  ? { kind: "error" }
                  : { kind: "results", results: mention.results },
        };

  // A `/` with nothing to offer is just a typed slash, and a plugin's own
  // trigger shows no hint until something follows it.
  const isPlainSlash =
    kind === "command" &&
    !command.isLoading &&
    !command.isError &&
    commands.all.length === 0;
  const isBarePluginTrigger =
    active?.kind === "mention" &&
    active.char !== DEFAULT_PLUGIN_MENTION_TRIGGER &&
    mentionQuery.length === 0;

  return {
    isOpen: !hidden && active !== null && !isPlainSlash && !isBarePluginTrigger,
    menuState,
    suggestions,
    selectedIndex,
    loadMore: canLoadMore ? loadMore : undefined,
    sync,
    trackEdit,
    closeOnBlur,
    closeAt,
    forget,
    dismiss,
    apply,
    insertAction,
    selectNext: () => {
      const atLast = selectedIndex >= suggestions.length - 1;
      const moreComing = command.hasMore || command.isLoadingMore;
      if (kind === "command" && !command.isError && atLast && moreComing) {
        if (canLoadMore) loadMore();
        return;
      }
      select((selectedIndex + 1) % suggestions.length);
    },
    selectPrevious: () =>
      select((selectedIndex + suggestions.length - 1) % suggestions.length),
    /** Applies the highlighted row and returns it. */
    applySelected: () => {
      const item = suggestions[selectedIndex] ?? suggestions[0];
      if (item) apply(item);
      return item;
    },
  };
}

export type PromptTypeahead = ReturnType<typeof usePromptTypeahead>;
