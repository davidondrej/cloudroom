import { useMemo } from "react";
import type { LiveTypeaheadConfig } from "@/components/promptbox/PromptBoxInternal";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import type { PromptBoxAction } from "@/components/promptbox/PromptBoxActionsMenu";
import { withAppPromptActions } from "@/components/promptbox/PromptBoxActionsMenu";
import type { ProviderComposerAction } from "@cloudroom/domain";
import { buildProviderPromptActionProps } from "@cloudroom/client-core";

interface UseComposerTypeaheadArgs {
  projectId: string | undefined;
  mentionsProjectId?: string | undefined;
  /** When false, skips project-scoped mention sources (e.g. projectless new-thread drafts). */
  hasMentionsProject?: boolean;
  providerId: string | undefined;
  commandScope?: "new-thread" | "thread";
  environmentId: string | null;
  hostId?: string | null;
  currentThreadId?: string;
  threadStorageThreadId?: string | undefined;
  selectedProviderComposerActions:
    | readonly ProviderComposerAction[]
    | undefined;
  resolveMentionLink: PromptMentionLinkResolver;
}

interface UseComposerTypeaheadResult {
  typeaheadConfig: LiveTypeaheadConfig;
  promptActions: readonly PromptBoxAction[];
}

export function useComposerTypeahead({
  projectId,
  mentionsProjectId,
  hasMentionsProject = true,
  providerId,
  commandScope = "thread",
  environmentId,
  hostId = null,
  currentThreadId,
  threadStorageThreadId,
  selectedProviderComposerActions,
  resolveMentionLink,
}: UseComposerTypeaheadArgs): UseComposerTypeaheadResult {
  const providerPromptActions = useMemo(
    () => buildProviderPromptActionProps(selectedProviderComposerActions ?? []),
    [selectedProviderComposerActions],
  );
  const promptActions = useMemo(
    () => withAppPromptActions(providerPromptActions.promptActions),
    [providerPromptActions.promptActions],
  );
  const resolvedMentionsProjectId = hasMentionsProject
    ? (mentionsProjectId ?? projectId)
    : undefined;
  // Cloud threads have no environment, so no thread storage on this host.
  const resolvedThreadStorageId =
    threadStorageThreadId !== undefined
      ? threadStorageThreadId
      : environmentId
        ? currentThreadId
        : undefined;

  const typeaheadConfig = useMemo<LiveTypeaheadConfig>(
    () => ({
      kind: "live",
      projectId,
      mentionsProjectId: resolvedMentionsProjectId,
      providerId,
      commandScope,
      environmentId,
      hostId,
      currentThreadId,
      threadStorageThreadId: resolvedThreadStorageId,
      skillsTrigger: providerPromptActions.skillsTrigger,
      promptActions,
      resolveLink: resolveMentionLink,
    }),
    [
      commandScope,
      currentThreadId,
      environmentId,
      hostId,
      projectId,
      promptActions,
      providerId,
      providerPromptActions.skillsTrigger,
      resolvedMentionsProjectId,
      resolvedThreadStorageId,
      resolveMentionLink,
    ],
  );

  return { typeaheadConfig, promptActions };
}
