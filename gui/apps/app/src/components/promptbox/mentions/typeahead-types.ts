import type { ComponentType } from "react";
import type { ReasoningLevel } from "@cloudroom/domain";
import type {
  CommandMenuState,
  PromptMentionSuggestion,
  ProviderCommandSuggestion,
  TypeaheadMenuState,
} from "@cloudroom/client-core";

export interface ReasoningCommandSuggestion {
  kind: "reasoning";
  name: ReasoningLevel;
  description: string;
}

export interface FastModeCommandSuggestion {
  kind: "fast-mode";
  name: "fast" | "ultrafast";
  description: string;
}

export interface ModelShortcutCommandSuggestion {
  kind: "model-shortcut";
  name: string;
  description: string;
  icon?: ComponentType<{ className?: string }>;
}

export interface LocationCommandSuggestion {
  kind: "location";
  name: "local" | "worktree" | "cloud";
  description: string;
}

export type ComposerCommandSuggestion =
  | ProviderCommandSuggestion
  | ReasoningCommandSuggestion
  | FastModeCommandSuggestion
  | ModelShortcutCommandSuggestion
  | LocationCommandSuggestion;

export type ComposerCommandMenuState =
  | Exclude<CommandMenuState, { kind: "results" }>
  | { kind: "results"; suggestions: readonly ComposerCommandSuggestion[] };

export type ComposerTypeaheadMenuState =
  | Extract<TypeaheadMenuState, { trigger: "mention" }>
  | { trigger: "command"; state: ComposerCommandMenuState };

export type TypeaheadSuggestion =
  | PromptMentionSuggestion
  | ComposerCommandSuggestion;

export function getMentionKey(item: PromptMentionSuggestion): string {
  switch (item.kind) {
    case "path":
      return `path\0${item.source}\0${item.entryKind}\0${item.path}`;
    case "plugin":
      return `plugin\0${item.pluginId}\0${item.providerId}\0${item.itemId}`;
    case "thread":
      return `thread\0${item.threadId}`;
    case "project":
      return `project\0${item.projectId}`;
    case "section":
      return `section\0${item.sectionId}`;
  }
}

export function getCommandKey(item: ProviderCommandSuggestion): string {
  return `command\0${item.source}\0${item.origin}\0${item.pluginId ?? ""}\0${item.name}`;
}

export function typeaheadSuggestionKey(item: TypeaheadSuggestion): string {
  if (
    item.kind === "reasoning" ||
    item.kind === "fast-mode" ||
    item.kind === "model-shortcut" ||
    item.kind === "location"
  ) {
    return `${item.kind}\0${item.name}`;
  }
  return item.kind === "command" ? getCommandKey(item) : getMentionKey(item);
}
