import { type ReactNode, useEffect } from "react";
import type { WorkspaceDiffTarget } from "@cloudroom/domain";
import { EmptyStatePanel } from "@cloudroom/shared-ui/empty-state";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { Skeleton } from "@cloudroom/shared-ui/skeleton";
import type { DiffPresentation } from "@/components/code/code-rendering";
import { DiffFilesPanel } from "@/components/diff/diff-panel";
import {
  buildGitDiffIdentity,
  clearDiffFileCardStates,
  useDiffFileContentsRequester,
} from "@/components/diff/diff-store";
import { useEnvironmentDiffFiles } from "@/hooks/queries/environment-queries";
import { PANEL_SCROLL_SLOT_CLASS } from "./panel-tokens";

function StatusContainer({ children }: { children: ReactNode }) {
  return (
    <div className={cn(PANEL_SCROLL_SLOT_CLASS, "px-4 pb-3")}>{children}</div>
  );
}

export function GitDiffTabContent({
  environmentId,
  target,
  isPanelOpen,
  gitDiffPresentation,
  onClearPendingGitDiffIntent,
  onOpenFileInEditor,
  onOpenFilePreview,
  onSelectionAddToChat,
  pendingGitDiffScrollPath,
  workspaceRootPath,
}: {
  environmentId?: string;
  target: WorkspaceDiffTarget | undefined;
  isPanelOpen: boolean;
  gitDiffPresentation: DiffPresentation;
  onClearPendingGitDiffIntent?: () => void;
  onOpenFileInEditor?: (path: string) => void;
  onOpenFilePreview?: (path: string) => void;
  onSelectionAddToChat?: (text: string) => void;
  pendingGitDiffScrollPath?: string | null;
  workspaceRootPath?: string | null;
}) {
  const enabled = isPanelOpen && Boolean(environmentId) && target !== undefined;
  const query = useEnvironmentDiffFiles(environmentId ?? "", {
    enabled,
    target,
  });
  const resp = query.data;
  const mergeBaseRef = resp?.outcome === "available" ? resp.mergeBaseRef : null;
  const identity = buildGitDiffIdentity({
    environmentId,
    mergeBaseRef,
    target,
  });
  const requestContents = useDiffFileContentsRequester({
    environmentId,
    target,
    mergeBaseRef,
  });

  useEffect(() => {
    clearDiffFileCardStates(identity);
  }, [identity]);

  if (
    enabled &&
    (query.isLoading || (resp === undefined && query.error === null))
  ) {
    return (
      <StatusContainer>
        <div className="space-y-2 pt-2">
          {[0, 1, 2].map((n) => (
            <div
              key={n}
              className="rounded-lg border border-border bg-surface-raised"
            >
              <div className="border-b border-border bg-surface-recessed px-3 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <Skeleton className="size-4 shrink-0 rounded-sm" />
                    <Skeleton className="h-3 w-48 max-w-full rounded-sm" />
                  </div>
                  <Skeleton className="h-3 w-14 shrink-0 rounded-sm" />
                </div>
              </div>
              <div className="space-y-1.5 px-2.5 py-2">
                <Skeleton className="h-3 w-full rounded-sm" />
                <Skeleton className="h-3 w-[94%] rounded-sm" />
                <Skeleton className="h-3 w-[90%] rounded-sm" />
                <Skeleton className="h-3 w-[86%] rounded-sm" />
              </div>
            </div>
          ))}
        </div>
      </StatusContainer>
    );
  }

  if (query.error) {
    return (
      <StatusContainer>
        <div className="rounded-lg border border-surface-destructive-border bg-surface-destructive px-3 py-2 text-xs text-destructive">
          <p>
            {query.error instanceof Error
              ? query.error.message
              : "Failed to load git diff"}
          </p>
        </div>
      </StatusContainer>
    );
  }

  if (!resp) {
    return (
      <StatusContainer>
        <EmptyStatePanel className="rounded-lg">
          No diff to display.
        </EmptyStatePanel>
      </StatusContainer>
    );
  }

  if (resp.outcome === "unavailable") {
    return (
      <StatusContainer>
        <div className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Workspace unavailable</p>
          <p className="mt-1 leading-5">{resp.failure.message}</p>
        </div>
      </StatusContainer>
    );
  }

  if (resp.outcome === "not_applicable") {
    return (
      <StatusContainer>
        <div className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-xs text-muted-foreground">
          <p className="mt-1 leading-5">{resp.message}</p>
        </div>
      </StatusContainer>
    );
  }

  if (resp.files.length === 0 || !environmentId || target === undefined) {
    return (
      <StatusContainer>
        <EmptyStatePanel className="rounded-lg">
          No diff to display.
        </EmptyStatePanel>
      </StatusContainer>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {resp.truncated ? (
        <div
          role="status"
          className="mx-4 mb-2 rounded-lg border border-border bg-surface-raised px-3 py-2 text-xs text-muted-foreground"
        >
          Showing the first {resp.files.length} changed files. Additional
          changes are omitted.
        </div>
      ) : null}
      <DiffFilesPanel
        environmentId={environmentId}
        target={target}
        diffIdentity={identity}
        files={resp.files}
        initialPatches={resp.initialPatches}
        filesUpdatedAt={query.dataUpdatedAt}
        presentation={gitDiffPresentation}
        filePathRoot={workspaceRootPath}
        isPanelOpen={isPanelOpen}
        isPlaceholderData={query.isPlaceholderData}
        scrollToPath={pendingGitDiffScrollPath}
        onScrolledToPath={onClearPendingGitDiffIntent}
        onOpenFileInEditor={onOpenFileInEditor}
        onOpenFilePreview={onOpenFilePreview}
        onRequestFileContents={requestContents}
        onSelectionAddToChat={onSelectionAddToChat}
      />
    </div>
  );
}
