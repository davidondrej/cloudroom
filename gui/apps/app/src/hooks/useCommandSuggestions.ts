import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import type { PromptMentionCommandTrigger } from "@cloudroom/domain";
import { usePointerCoarse } from "@cloudroom/shared-ui/hooks/use-pointer-coarse";
import {
  createCommandSearchIndex,
  filterCommandSuggestions,
  toProviderCommandSuggestion,
  type ProviderCommandSuggestion,
} from "@cloudroom/client-core";
import {
  projectCommandsQueryOptions,
  useProjectCommands,
} from "./queries/project-queries";
import {
  commandCatalogCacheKey,
  readCachedCommandCatalog,
} from "@/lib/command-catalog-cache";
import { COPY_COMMAND_NAME } from "./useCopyCommand";

interface UseCommandSuggestionsArgs {
  projectId: string | undefined;
  providerId: string | undefined;
  commandScope: "new-thread" | "thread";
  skillsTrigger: PromptMentionCommandTrigger | null;
  promptActions?: readonly CommandSuggestionPromptAction[];
  environmentId: string | null;
  hostId?: string | null;
  query: string | null;
  composerFocused?: boolean;
  /** Set false when the caller indexes `catalog` directly so search runs only once. */
  filter?: boolean;
}

const COMMAND_CATALOG_PREFETCH_STALE_TIME_MS = 30_000;

const COPY_COMMAND_SUGGESTION: ProviderCommandSuggestion = {
  kind: "command",
  name: COPY_COMMAND_NAME,
  source: "command",
  origin: "builtin",
  description: "Copy the last agent response",
  argumentHint: null,
};

interface UseCommandSuggestionsResult {
  trigger: PromptMentionCommandTrigger | null;
  /** Full merged catalog before query filtering, for single-pass indexing downstream. */
  catalog: readonly ProviderCommandSuggestion[];
  suggestions: ProviderCommandSuggestion[];
  isLoading: boolean;
  isError: boolean;
}

interface CommandSuggestionPromptAction {
  text?: string;
  command?: {
    trigger: PromptMentionCommandTrigger;
    name: string;
    trailingText: string;
  };
}

function buildPromptActionCommands(
  promptActions: readonly CommandSuggestionPromptAction[] | undefined,
  trigger: PromptMentionCommandTrigger | null,
): ProviderCommandSuggestion[] {
  if (trigger === null || !promptActions?.length) {
    return [];
  }
  const commands: ProviderCommandSuggestion[] = [];
  for (const action of promptActions) {
    if (!action.command || action.command.trigger !== trigger) continue;
    commands.push({
      kind: "command",
      name: action.command.name,
      source: "command",
      origin: "user",
      description: null,
      argumentHint: null,
    });
  }
  return commands;
}

export function promptActionCommandSuggestions({
  promptActions,
  query,
  trigger,
}: {
  promptActions: readonly CommandSuggestionPromptAction[] | undefined;
  query: string;
  trigger: PromptMentionCommandTrigger | null;
}): ProviderCommandSuggestion[] {
  if (trigger === null) {
    return [];
  }
  return filterCommandSuggestions(
    buildPromptActionCommands(promptActions, trigger),
    query,
  );
}

function mergeCommandSuggestions(
  preferred: readonly ProviderCommandSuggestion[],
  fallback: readonly ProviderCommandSuggestion[],
): ProviderCommandSuggestion[] {
  const suggestions: ProviderCommandSuggestion[] = [];
  const seen = new Set<string>();

  for (const suggestion of preferred) {
    const key = `${suggestion.source}:${suggestion.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(suggestion);
  }
  for (const suggestion of fallback) {
    const key = `${suggestion.source}:${suggestion.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(suggestion);
  }

  return suggestions;
}

export function useCommandSuggestions(
  args: UseCommandSuggestionsArgs,
): UseCommandSuggestionsResult {
  const trigger = args.skillsTrigger;
  const isActive =
    args.projectId !== undefined &&
    args.providerId !== undefined &&
    trigger !== null &&
    args.query !== null;

  const trimmedQuery = args.query?.trim() ?? "";

  const commandsQuery = useProjectCommands(
    {
      projectId: args.projectId,
      providerId: args.providerId,
      environmentId: args.environmentId,
      hostId: args.hostId ?? null,
    },
    { enabled: isActive },
  );
  const queryClient = useQueryClient();
  const isPointerCoarse = usePointerCoarse();
  const shouldPrefetchCatalog =
    args.composerFocused === true &&
    args.projectId !== undefined &&
    args.providerId !== undefined &&
    trigger !== null;
  const prefetchProjectId = args.projectId;
  const prefetchProviderId = args.providerId;
  const prefetchEnvironmentId = args.environmentId;
  const prefetchHostId = args.hostId ?? null;
  useEffect(() => {
    if (!shouldPrefetchCatalog) {
      return;
    }
    const catalogQuery = projectCommandsQueryOptions({
      projectId: prefetchProjectId,
      providerId: prefetchProviderId,
      environmentId: prefetchEnvironmentId,
      hostId: prefetchHostId,
    });
    // Desktop composers autofocus on every mount, so warm only a project
    // with no saved list there.
    if (
      !isPointerCoarse &&
      readCachedCommandCatalog(
        commandCatalogCacheKey(prefetchProjectId, prefetchProviderId),
      ) !== null
    ) {
      return;
    }
    void queryClient.prefetchQuery({
      ...catalogQuery,
      retry: false,
      staleTime: COMMAND_CATALOG_PREFETCH_STALE_TIME_MS,
    });
  }, [
    isPointerCoarse,
    prefetchEnvironmentId,
    prefetchHostId,
    prefetchProjectId,
    prefetchProviderId,
    queryClient,
    shouldPrefetchCatalog,
  ]);

  // Assemble the full merged catalog once per fetch/scope change (not per keystroke).
  const catalog = useMemo<ProviderCommandSuggestion[]>(() => {
    if (trigger === null) {
      return [];
    }
    const actionCommands = buildPromptActionCommands(
      args.promptActions,
      trigger,
    );
    const actionNames = new Set(actionCommands.map(({ name }) => name));
    const discovered: ProviderCommandSuggestion[] = [];
    const ownNames = new Set<string>();
    for (const rawCommand of commandsQuery.data?.commands ?? []) {
      let suggestion = toProviderCommandSuggestion(rawCommand);
      if (
        args.commandScope !== "thread" &&
        suggestion.source === "command" &&
        suggestion.origin === "builtin" &&
        (suggestion.name === "compact" || suggestion.name === "teleport")
      ) {
        continue;
      }
      if (
        suggestion.source === "command" &&
        suggestion.origin !== "builtin" &&
        actionNames.has(suggestion.name)
      ) {
        suggestion = { ...suggestion, insertAsText: true as const };
        ownNames.add(suggestion.name);
      }
      discovered.push(suggestion);
    }

    const appCommands =
      args.commandScope === "thread" ? [COPY_COMMAND_SUGGESTION] : [];
    // The user's own command wins its name; the action stays in the + menu.
    const preferred = [
      ...appCommands,
      ...actionCommands.filter(({ name }) => !ownNames.has(name)),
    ];
    return mergeCommandSuggestions(preferred, discovered);
  }, [commandsQuery.data?.commands, args.commandScope, args.promptActions, trigger]);

  const shouldFilter = args.filter !== false;
  const searchIndex = useMemo(
    () => (shouldFilter ? createCommandSearchIndex(catalog) : null),
    [catalog, shouldFilter],
  );

  const suggestions = useMemo<ProviderCommandSuggestion[]>(() => {
    if (!isActive || !shouldFilter || searchIndex === null) {
      return [];
    }
    return searchIndex.search(trimmedQuery);
  }, [isActive, searchIndex, shouldFilter, trimmedQuery]);

  const isLoading =
    isActive &&
    (!shouldFilter || suggestions.length === 0) &&
    commandsQuery.data === undefined &&
    (commandsQuery.isPending || commandsQuery.isFetching);
  const isError =
    isActive && commandsQuery.isError && commandsQuery.data === undefined;

  return {
    trigger,
    catalog,
    suggestions,
    isLoading,
    isError,
  };
}
