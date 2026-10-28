import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import type { PromptMentionCommandTrigger } from "@cloudroom/domain";
import { usePointerCoarse } from "@cloudroom/shared-ui/hooks/use-pointer-coarse";
import {
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
  suggestions: ProviderCommandSuggestion[];
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
}

interface CommandSuggestionPromptAction {
  text?: string;
  command?: {
    trigger: PromptMentionCommandTrigger;
    name: string;
    trailingText: string;
  };
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
    (promptActions ?? []).flatMap((action): ProviderCommandSuggestion[] => {
      if (!action.command || action.command.trigger !== trigger) {
        return [];
      }
      return [
        {
          kind: "command",
          name: action.command.name,
          source: "command",
          origin: "user",
          description: null,
          argumentHint: null,
        },
      ];
    }),
    query,
  );
}

function mergeCommandSuggestions(
  preferred: readonly ProviderCommandSuggestion[],
  fallback: readonly ProviderCommandSuggestion[],
): ProviderCommandSuggestion[] {
  const suggestions: ProviderCommandSuggestion[] = [];
  const seen = new Set<string>();

  for (const suggestion of [...preferred, ...fallback]) {
    const key = `${suggestion.source}:${suggestion.name}`;
    if (seen.has(key)) {
      continue;
    }
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
  const promptActionSuggestions = useMemo(
    () =>
      isActive
        ? promptActionCommandSuggestions({
            promptActions: args.promptActions,
            query: trimmedQuery.toLowerCase(),
            trigger,
          })
        : [],
    [args.promptActions, isActive, trigger, trimmedQuery],
  );

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

  const suggestions = useMemo<ProviderCommandSuggestion[]>(() => {
    if (!isActive) {
      return [];
    }
    const discoveredSuggestions = filterCommandSuggestions(
      (commandsQuery.data?.commands ?? [])
        .map(toProviderCommandSuggestion)
        .filter(
          (suggestion) =>
            args.commandScope === "thread" ||
            suggestion.source !== "command" ||
            suggestion.origin !== "builtin" ||
            !["compact", "teleport"].includes(suggestion.name),
        ),
      trimmedQuery,
    );
    const appSuggestions =
      args.commandScope === "thread"
        ? filterCommandSuggestions([COPY_COMMAND_SUGGESTION], trimmedQuery)
        : [];
    return mergeCommandSuggestions(
      [...appSuggestions, ...promptActionSuggestions],
      discoveredSuggestions,
    );
  }, [
    commandsQuery.data?.commands,
    args.commandScope,
    isActive,
    promptActionSuggestions,
    trimmedQuery,
  ]);

  const isLoading =
    isActive &&
    suggestions.length === 0 &&
    commandsQuery.data === undefined &&
    (commandsQuery.isPending || commandsQuery.isFetching);
  const isError =
    isActive && commandsQuery.isError && commandsQuery.data === undefined;

  return {
    trigger,
    suggestions,
    isLoading,
    isError,
    hasMore: false,
    isLoadingMore: false,
    loadMore: () => {},
  };
}
