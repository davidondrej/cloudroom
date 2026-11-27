import { fuzzyMatchText } from "@cloudroom/fuzzy-match";
import {
  providerCommandSection,
  providerCommandSectionRank,
  type ProviderCommand,
  type ProviderCommandOrigin,
  type ProviderCommandSection,
  type ProviderCommandSource,
} from "@cloudroom/server-contract";
import type { PromptMentionCommandTrigger } from "@cloudroom/domain";
import type { ThreadListIndicatorState } from "../../thread/thread-activity.js";
import type { PluginMentionTrigger } from "./plugin-mention-triggers.js";
import type { OrderedMentionSuggestions } from "./mention-candidates.js";

type PromptPathMentionSource = "workspace" | "thread-storage";
type PromptPathMentionEntryKind = "file" | "directory";

export type PromptMentionSuggestion =
  | {
      kind: "path";
      source: PromptPathMentionSource;
      entryKind: PromptPathMentionEntryKind;
      path: string;
      name: string;
      replacement: string;
    }
  | {
      kind: "thread";
      path: string;
      replacement: string;
      projectId: string;
      projectName?: string;
      threadId: string;
      title?: string;
      executionTarget?: "local" | "cloud";
      indicator?: ThreadListIndicatorState;
      lastActivityAt?: number;
    }
  | {
      kind: "project";
      path: string;
      replacement: string;
      projectId: string;
      name: string;
    }
  | {
      kind: "section";
      path: string;
      replacement: string;
      sectionId: string;
      name: string;
    }
  | {
      kind: "plugin";
      pluginId: string;
      providerId: string;
      itemId: string;
      providerLabel: string;
      title: string;
      subtitle: string | null;
      icon: string | null;
      replacement: string;
    };

export interface ProviderCommandSuggestion {
  kind: "command";
  name: string;
  source: ProviderCommandSource;
  origin: ProviderCommandOrigin;
  description: string | null;
  argumentHint: string | null;
  pluginId?: string;
  usage?: number;
  /** Named like a Cloudroom action (`/plan`), so it goes in as typed text the action can't claim. */
  insertAsText?: true;
}

export function toProviderCommandSuggestion(
  command: ProviderCommand,
): ProviderCommandSuggestion {
  return {
    kind: "command",
    name: command.name,
    source: command.source,
    origin: command.origin,
    description: command.description,
    argumentHint: command.argumentHint,
    ...(command.pluginId !== undefined ? { pluginId: command.pluginId } : {}),
    ...(command.usage !== undefined ? { usage: command.usage } : {}),
  };
}

// Usage only counts in steps of 3, so one stray pick never reorders the menu
// and two equally used rows don't swap back and forth.
const COMMAND_USAGE_STEP = 3;

interface IndexedCommand {
  suggestion: ProviderCommandSuggestion;
  lowerName: string;
  bareName: string | null;
  lowerDescription: string;
  lowerArgumentHint: string;
  usageRank: number;
  section: ProviderCommandSection;
  sectionRank: number;
}

export interface CommandSearchIndex {
  readonly entries: readonly IndexedCommand[];
  search(query: string): ProviderCommandSuggestion[];
}

function indexCommandSuggestion(
  suggestion: ProviderCommandSuggestion,
): IndexedCommand {
  const lowerName = suggestion.name.toLowerCase();
  const separatorIndex =
    suggestion.source === "skill" ? lowerName.lastIndexOf(":") : -1;
  const bareName =
    separatorIndex < 0 ? null : lowerName.slice(separatorIndex + 1);
  return {
    suggestion,
    lowerName,
    bareName,
    lowerDescription: suggestion.description?.toLowerCase() ?? "",
    lowerArgumentHint: suggestion.argumentHint?.toLowerCase() ?? "",
    usageRank: Math.floor((suggestion.usage ?? 0) / COMMAND_USAGE_STEP),
    section: providerCommandSection(suggestion),
    sectionRank: providerCommandSectionRank(suggestion),
  };
}

function matchingIndexedCommands(
  entries: readonly IndexedCommand[],
  normalizedQuery: string,
): Set<IndexedCommand> {
  return new Set(
    fuzzyMatchText({
      items: entries,
      query: normalizedQuery,
      getText: (entry) => entry.lowerName,
      limit: entries.length,
    }).map((match) => match.item),
  );
}

function indexedMatchRank(
  entry: IndexedCommand,
  normalizedQuery: string,
  nameMatches: ReadonlySet<IndexedCommand> | null,
): number {
  if (entry.lowerName === normalizedQuery) return 0;
  // Keep the room-cli skill first for partial queries like "/r".
  if (
    (entry.lowerName === "room-cli" || entry.bareName === "room-cli") &&
    "room-cli".startsWith(normalizedQuery)
  ) {
    return 0.5;
  }
  if (entry.bareName === normalizedQuery) return 1;
  if (
    entry.lowerName.startsWith(normalizedQuery) ||
    (entry.bareName !== null && entry.bareName.startsWith(normalizedQuery))
  ) {
    return 2;
  }
  if (
    entry.lowerName.includes(normalizedQuery) ||
    (entry.bareName !== null && entry.bareName.includes(normalizedQuery))
  ) {
    return 3;
  }
  return nameMatches?.has(entry) ? 4 : 5;
}

function groupBySectionOrder(
  entries: readonly IndexedCommand[],
): ProviderCommandSuggestion[] {
  const bySection = new Map<
    ProviderCommandSection,
    ProviderCommandSuggestion[]
  >();
  for (const entry of entries) {
    const existing = bySection.get(entry.section);
    if (existing) {
      existing.push(entry.suggestion);
      continue;
    }
    bySection.set(entry.section, [entry.suggestion]);
  }
  return [...bySection.values()].flat();
}

function rankIndexedCommands(
  entries: readonly IndexedCommand[],
  normalizedQuery: string,
  filterNonMatches: boolean,
): ProviderCommandSuggestion[] {
  if (entries.length === 0) return [];
  if (normalizedQuery.length === 0) {
    const ordered = [...entries].sort(
      (left, right) =>
        right.usageRank - left.usageRank || left.sectionRank - right.sectionRank,
    );
    return groupBySectionOrder(ordered);
  }

  const nameMatches = matchingIndexedCommands(entries, normalizedQuery);
  const scored: Array<{ entry: IndexedCommand; matchRank: number }> = [];
  for (const entry of entries) {
    const matchedName = nameMatches.has(entry);
    if (
      filterNonMatches &&
      !matchedName &&
      !entry.lowerDescription.includes(normalizedQuery) &&
      !entry.lowerArgumentHint.includes(normalizedQuery)
    ) {
      continue;
    }
    scored.push({
      entry,
      matchRank: indexedMatchRank(entry, normalizedQuery, nameMatches),
    });
  }

  scored.sort(
    (left, right) =>
      left.matchRank - right.matchRank ||
      right.entry.usageRank - left.entry.usageRank ||
      left.entry.sectionRank - right.entry.sectionRank,
  );
  return groupBySectionOrder(scored.map(({ entry }) => entry));
}

/** Precomputes lowercased fields once per catalog so each keystroke filters + ranks in a single pass. */
export function createCommandSearchIndex(
  suggestions: readonly ProviderCommandSuggestion[],
): CommandSearchIndex {
  const entries = suggestions.map(indexCommandSuggestion);
  return {
    entries,
    search(query: string): ProviderCommandSuggestion[] {
      return rankIndexedCommands(entries, query.trim().toLowerCase(), true);
    },
  };
}

export function filterCommandSuggestions(
  suggestions: readonly ProviderCommandSuggestion[],
  query: string,
): ProviderCommandSuggestion[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return [...suggestions];
  }
  const entries = suggestions.map(indexCommandSuggestion);
  const nameMatches = matchingIndexedCommands(entries, normalizedQuery);
  return entries
    .filter(
      (entry) =>
        nameMatches.has(entry) ||
        entry.lowerDescription.includes(normalizedQuery) ||
        entry.lowerArgumentHint.includes(normalizedQuery),
    )
    .map((entry) => entry.suggestion);
}

export function orderCommandSuggestions(
  suggestions: readonly ProviderCommandSuggestion[],
  query: string,
): ProviderCommandSuggestion[] {
  const normalizedQuery = query.trim().toLowerCase();
  const entries = suggestions.map(indexCommandSuggestion);
  return rankIndexedCommands(entries, normalizedQuery, false);
}

export type TypeaheadTrigger =
  | { char: PluginMentionTrigger; kind: "mention" }
  | { char: PromptMentionCommandTrigger; kind: "command" };

export type ActiveTrigger =
  | {
      char: PluginMentionTrigger;
      kind: "mention";
      query: string;
      from: number;
      to: number;
    }
  | {
      char: PromptMentionCommandTrigger;
      kind: "command";
      query: string;
      from: number;
      to: number;
    };

export type MentionMenuState =
  | { kind: "hint" }
  | { kind: "loading" }
  | { kind: "error" }
  | {
      kind: "results";
      results: OrderedMentionSuggestions;
    };

export type CommandMenuState =
  | { kind: "loading" }
  | { kind: "error" }
  | {
      kind: "results";
      suggestions: readonly ProviderCommandSuggestion[];
    };

export type TypeaheadMenuState =
  | { trigger: "mention"; state: MentionMenuState }
  | { trigger: "command"; state: CommandMenuState };
