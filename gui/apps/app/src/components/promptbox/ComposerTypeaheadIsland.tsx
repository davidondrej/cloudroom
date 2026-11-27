// Self-contained typeahead island: owns menu state and live suggestion hooks so
// typing `/` or `@` and pressing arrows never re-renders PromptBoxInternal or parent composers.
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { useCommandSuggestions } from "@/hooks/useCommandSuggestions";
import { usePromptMentions } from "@/hooks/usePromptMentions";
import { MentionMenu } from "./mentions/MentionMenu";
import type {
  ControlledTypeaheadConfig,
  LiveTypeaheadConfig,
  PromptBoxAction,
  TypeaheadConfig,
} from "./prompt-box-types";
import { useReportTypeaheadLayout } from "./PromptBoxView";
import type { PromptDocument } from "./usePromptEditor";
import {
  usePromptTypeahead,
  type CommandSources,
  type TypeaheadBridge,
} from "./usePromptTypeahead";

export interface ComposerTypeaheadIslandProps extends CommandSources {
  bridge: TypeaheadBridge;
  editor: PromptDocument;
  scopeKey: string;
  typeahead: TypeaheadConfig;
  promptActions: readonly PromptBoxAction[] | undefined;
  hidden: boolean;
  mentionMenuPlacement: "top" | "bottom";
  isPointerCoarse: boolean;
}

interface InnerIslandProps extends Omit<ComposerTypeaheadIslandProps, "typeahead"> {
  typeahead: ControlledTypeaheadConfig;
}

function TypeaheadMenuIsland({
  bridge,
  editor,
  scopeKey,
  typeahead,
  promptActions,
  hidden,
  mentionMenuPlacement,
  isPointerCoarse,
  reasoning,
  fastMode,
  modelShortcuts,
  locationCommands,
}: InnerIslandProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const promptTypeahead = usePromptTypeahead({
    editor,
    scopeKey,
    typeahead,
    promptActions,
    hidden,
    reasoning,
    fastMode,
    modelShortcuts,
    locationCommands,
  });

  const bridgeTarget = {
    typeahead: promptTypeahead,
    onEditorFocus: typeahead.command.onEditorFocus,
  };
  bridge.connect(bridgeTarget);
  useLayoutEffect(() => {
    bridge.connect(bridgeTarget);
    return () => {
      bridge.connect(null);
    };
  });

  useReportTypeaheadLayout(menuRef, promptTypeahead.isOpen);

  if (!promptTypeahead.isOpen) {
    return null;
  }

  return (
    <div
      ref={menuRef}
      data-promptbox-typeahead-menu=""
      className={cn(
        "absolute -left-px -right-px z-20",
        mentionMenuPlacement === "top" ? "bottom-full mb-2" : "top-full mt-2",
      )}
    >
      <MentionMenu
        state={promptTypeahead.menuState}
        selectedIndex={promptTypeahead.selectedIndex}
        onApply={promptTypeahead.apply}
        onDismiss={isPointerCoarse ? promptTypeahead.dismiss : undefined}
      />
    </div>
  );
}

function LiveTypeaheadIsland({
  typeahead: live,
  ...rest
}: Omit<ComposerTypeaheadIslandProps, "typeahead"> & {
  typeahead: LiveTypeaheadConfig;
}) {
  const [commandQuery, setCommandQuery] = useState<string | null>(null);
  const [hasComposerFocused, setHasComposerFocused] = useState(false);
  const handleEditorFocus = useCallback(() => {
    setHasComposerFocused(true);
  }, []);

  const promptMentions = usePromptMentions(live.mentionsProjectId, {
    currentThreadId: live.currentThreadId,
    environmentId: live.environmentId,
    hostId: live.hostId ?? null,
    threadStorageThreadId: live.threadStorageThreadId,
  });

  const commandSuggestions = useCommandSuggestions({
    projectId: live.projectId,
    providerId: live.providerId,
    commandScope: live.commandScope,
    skillsTrigger: live.skillsTrigger,
    promptActions: live.promptActions,
    environmentId: live.environmentId,
    hostId: live.hostId ?? null,
    query: commandQuery,
    composerFocused: hasComposerFocused,
    filter: false,
  });

  const controlled = useMemo<ControlledTypeaheadConfig>(
    () => ({
      mention: {
        triggers: promptMentions.triggers,
        results: promptMentions.results,
        isLoading: promptMentions.isLoading,
        isError: promptMentions.isError,
        onQueryChange: promptMentions.setQuery,
        resolveLink: live.resolveLink,
      },
      command: {
        trigger: commandSuggestions.trigger,
        catalog: commandSuggestions.catalog,
        suggestions: commandSuggestions.suggestions,
        isLoading: commandSuggestions.isLoading,
        isError: commandSuggestions.isError,
        onQueryChange: setCommandQuery,
        onEditorFocus: handleEditorFocus,
      },
    }),
    [
      commandSuggestions.catalog,
      commandSuggestions.isError,
      commandSuggestions.isLoading,
      commandSuggestions.suggestions,
      commandSuggestions.trigger,
      handleEditorFocus,
      live.resolveLink,
      promptMentions.isError,
      promptMentions.isLoading,
      promptMentions.results,
      promptMentions.setQuery,
      promptMentions.triggers,
    ],
  );

  return <TypeaheadMenuIsland {...rest} typeahead={controlled} />;
}

export const ComposerTypeaheadIsland = memo(function ComposerTypeaheadIsland({
  typeahead,
  ...rest
}: ComposerTypeaheadIslandProps) {
  if (typeahead.kind === "live") {
    return <LiveTypeaheadIsland {...rest} typeahead={typeahead} />;
  }
  return <TypeaheadMenuIsland {...rest} typeahead={typeahead} />;
});
