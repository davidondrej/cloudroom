import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  buildDirectMediaFilePreview,
  getMediaFilePreviewType,
  type EnvironmentFilePreviewSource,
  type FilePreview,
  type FilePreviewLineRange,
  type WorkspaceFilePreviewStatusLabel,
} from "@cloudroom/client-core";
import {
  AgentFileEditContext,
  useAgentFileEdit,
} from "@/components/right-panel/tabs/agent-file-edit";
import { SecondaryPanelFilePreview } from "@/components/right-panel/tabs/file-preview";
import {
  buildMarkdownFileImageRouting,
  buildMarkdownLeaseImageRouting,
} from "@/components/ui/markdown-file-image-routing";
import type { MarkdownLinkRouting } from "@/components/ui/markdown-link-routing.js";
import {
  useEnvironment,
  useEnvironmentFilePreview,
} from "@/hooks/queries/environment-queries";
import { useHostFilePreview } from "@/hooks/queries/host-file-preview-query";
import { useProjectFilePreview } from "@/hooks/queries/project-queries";
import {
  useThreadHostFilePreview,
  useThreadStorageFilePreview,
} from "@/hooks/queries/thread-queries";
import { getAbsoluteDirname } from "@/lib/absolute-file-path";
import {
  buildProjectFileContentUrl,
  buildRawFilesystemHtmlContentUrl,
  buildThreadHostFileContentUrl,
  buildThreadStorageRawContentUrl,
  buildThreadWorktreeRawContentUrl,
} from "@/lib/file-content-urls";

function toPreviewBinding(q: UseQueryResult<FilePreview>) {
  return {
    error: q.error,
    filePreview: q.data,
    isLoading: q.isLoading,
    isRefreshing: q.isFetching,
    onRefresh: () => void q.refetch(),
  };
}

export function WorkspaceFilePreviewTabContent({
  activePath,
  copyPath = null,
  environmentId,
  isPanelOpen,
  lineRange,
  markdownLinkRouting,
  onSelectionAddToChat,
  onOpenInEditor,
  onRevealInFinder,
  source,
  statusLabel,
  threadId,
}: {
  activePath: string;
  isPanelOpen: boolean;
  copyPath?: string | null;
  environmentId?: string | null;
  lineRange: FilePreviewLineRange | null;
  markdownLinkRouting?: MarkdownLinkRouting;
  onSelectionAddToChat?: (text: string) => void;
  onOpenInEditor?: (path: string) => void;
  onRevealInFinder?: (path: string) => void;
  source: EnvironmentFilePreviewSource | null;
  statusLabel: WorkspaceFilePreviewStatusLabel | null;
  threadId?: string | null;
}) {
  const workingTreeMedia =
    source?.kind === "working-tree" &&
    getMediaFilePreviewType(activePath) !== null;
  const envQuery = useEnvironment(environmentId ?? null, {
    enabled:
      environmentId != null &&
      (markdownLinkRouting?.localImage === undefined ||
        (!threadId && workingTreeMedia)),
    staleTime: 5_000,
  });
  const envRoot = envQuery.data?.path ?? null;
  const envProjectId = envQuery.data?.projectId;

  const mediaUrl = workingTreeMedia
    ? threadId
      ? buildThreadWorktreeRawContentUrl(threadId, activePath)
      : environmentId && envProjectId !== undefined
        ? buildProjectFileContentUrl(envProjectId, activePath, {
            environmentId,
          })
        : null
    : null;

  const directMedia = useMemo(
    () =>
      mediaUrl
        ? buildDirectMediaFilePreview({
            name: activePath.split("/").at(-1),
            path: activePath,
            url: mediaUrl,
          })
        : null,
    [activePath, mediaUrl],
  );

  const awaitingMediaUrl =
    workingTreeMedia &&
    !directMedia &&
    !threadId &&
    Boolean(environmentId) &&
    envQuery.isLoading;

  const activeEdit = useAgentFileEdit(threadId, activePath);
  const fileQuery = useEnvironmentFilePreview(
    environmentId,
    activePath,
    source,
    {
      enabled: isPanelOpen && !directMedia && !awaitingMediaUrl,
    },
  );

  const binding = directMedia
    ? {
        error: null,
        filePreview: directMedia,
        isLoading: false,
        isRefreshing: false,
        onRefresh: () => {},
      }
    : awaitingMediaUrl
      ? {
          error: null,
          filePreview: undefined,
          isLoading: true,
          isRefreshing: false,
          onRefresh: () => void envQuery.refetch(),
        }
      : toPreviewBinding(fileQuery);

  const routing = useMemo(() => {
    if (
      !source ||
      environmentId == null ||
      (!threadId && envProjectId === undefined)
    ) {
      return markdownLinkRouting;
    }
    return buildMarkdownFileImageRouting({
      path: activePath,
      rootPath: envRoot,
      threadId: threadId ?? null,
      linkRouting: markdownLinkRouting,
      resolveRelativeSrc: (rel) =>
        threadId && source.kind === "working-tree"
          ? buildThreadWorktreeRawContentUrl(threadId, rel)
          : envProjectId === undefined
            ? rel
            : buildProjectFileContentUrl(envProjectId, rel, { environmentId }),
    });
  }, [
    activePath,
    envProjectId,
    envRoot,
    environmentId,
    markdownLinkRouting,
    source,
    threadId,
  ]);

  return (
    <AgentFileEditContext.Provider value={activeEdit}>
      <SecondaryPanelFilePreview
        {...binding}
        activePath={activePath}
        copyPath={copyPath}
        htmlPreviewUrl={
          threadId && source?.kind === "working-tree"
            ? buildThreadWorktreeRawContentUrl(threadId, activePath)
            : null
        }
        lineRange={lineRange}
        markdownLinkRouting={routing}
        onSelectionAddToChat={onSelectionAddToChat}
        onOpenInEditor={onOpenInEditor}
        onRevealInFinder={onRevealInFinder}
        statusLabel={statusLabel}
      />
    </AgentFileEditContext.Provider>
  );
}

export function ProjectFilePreviewTabContent({
  activePath,
  copyPath = null,
  environmentId,
  hostId,
  isPanelOpen,
  lineRange,
  markdownLinkRouting,
  onSelectionAddToChat,
  onOpenInEditor,
  onRevealInFinder,
  projectId,
  rootPath = null,
  threadId = null,
}: {
  activePath: string;
  isPanelOpen: boolean;
  copyPath?: string | null;
  environmentId: string | null;
  hostId: string | null;
  lineRange: FilePreviewLineRange | null;
  markdownLinkRouting?: MarkdownLinkRouting;
  onSelectionAddToChat?: (text: string) => void;
  onOpenInEditor?: (path: string) => void;
  onRevealInFinder?: (path: string) => void;
  projectId: string;
  rootPath?: string | null;
  threadId?: string | null;
}) {
  const q = useProjectFilePreview(
    projectId,
    activePath,
    { environmentId, hostId },
    {
      enabled: isPanelOpen,
    },
  );
  const routing = useMemo(
    () =>
      buildMarkdownFileImageRouting({
        path: activePath,
        rootPath,
        threadId,
        linkRouting: markdownLinkRouting,
        resolveRelativeSrc: (rel) =>
          buildProjectFileContentUrl(
            projectId,
            rel,
            environmentId !== null
              ? { environmentId }
              : hostId !== null
                ? { hostId }
                : {},
          ),
      }),
    [
      activePath,
      environmentId,
      hostId,
      markdownLinkRouting,
      projectId,
      rootPath,
      threadId,
    ],
  );
  return (
    <SecondaryPanelFilePreview
      {...toPreviewBinding(q)}
      activePath={activePath}
      copyPath={copyPath}
      lineRange={lineRange}
      markdownLinkRouting={routing}
      onSelectionAddToChat={onSelectionAddToChat}
      onOpenInEditor={onOpenInEditor}
      onRevealInFinder={onRevealInFinder}
      statusLabel={null}
    />
  );
}

export function HostFilePreviewTabContent({
  activePath,
  copyPath,
  environmentId,
  isPanelOpen,
  lineRange,
  markdownLinkRouting,
  onSelectionAddToChat,
  onOpenInEditor,
  onRevealInFinder,
  onDownload,
  threadId,
}: {
  activePath: string;
  isPanelOpen: boolean;
  copyPath: string;
  environmentId?: string | null;
  lineRange: FilePreviewLineRange | null;
  markdownLinkRouting?: MarkdownLinkRouting;
  onSelectionAddToChat?: (text: string) => void;
  onOpenInEditor?: (path: string) => void;
  onRevealInFinder?: (path: string) => void;
  onDownload?: (path: string) => void;
  threadId: string;
}) {
  const q = useThreadHostFilePreview(threadId, environmentId, activePath, {
    enabled: isPanelOpen,
  });
  const routing = useMemo(
    () =>
      buildMarkdownFileImageRouting({
        path: activePath,
        rootPath:
          markdownLinkRouting?.localFile?.relativeLinks?.rootPath ??
          getAbsoluteDirname({ path: activePath }),
        threadId,
        linkRouting: markdownLinkRouting,
        resolveRelativeSrc: (_rel, full) =>
          buildThreadHostFileContentUrl(threadId, full),
      }),
    [activePath, markdownLinkRouting, threadId],
  );
  return (
    <SecondaryPanelFilePreview
      {...toPreviewBinding(q)}
      activePath={activePath}
      copyPath={copyPath}
      htmlPreviewUrl={buildRawFilesystemHtmlContentUrl(threadId, activePath)}
      lineRange={lineRange}
      markdownLinkRouting={routing}
      onSelectionAddToChat={onSelectionAddToChat}
      onOpenInEditor={onOpenInEditor}
      onRevealInFinder={onRevealInFinder}
      onDownload={onDownload}
      statusLabel={null}
    />
  );
}

export function HostScopedFilePreviewTabContent({
  activePath,
  hostId,
  isPanelOpen,
  lineRange,
  onOpenInEditor,
  onRevealInFinder,
}: {
  activePath: string;
  hostId: string;
  isPanelOpen: boolean;
  lineRange: FilePreviewLineRange | null;
  onOpenInEditor?: (path: string) => void;
  onRevealInFinder?: (path: string) => void;
}) {
  const q = useHostFilePreview(hostId, activePath, { enabled: isPanelOpen });
  const leaseUrl = q.data?.url;
  const routing = useMemo(
    () =>
      buildMarkdownLeaseImageRouting({
        path: activePath,
        rootPath: getAbsoluteDirname({ path: activePath }),
        previewUrl: leaseUrl,
      }),
    [activePath, leaseUrl],
  );
  return (
    <SecondaryPanelFilePreview
      {...toPreviewBinding(q)}
      activePath={activePath}
      copyPath={activePath}
      htmlPreviewUrl={leaseUrl ?? null}
      lineRange={lineRange}
      markdownLinkRouting={routing}
      onOpenInEditor={onOpenInEditor}
      onRevealInFinder={onRevealInFinder}
      statusLabel={null}
    />
  );
}

export function ThreadStorageFilePreviewTabContent({
  activePath,
  copyPath = null,
  isPanelOpen,
  lineRange,
  markdownLinkRouting,
  onSelectionAddToChat,
  onOpenInEditor,
  onRevealInFinder,
  threadId,
}: {
  activePath: string;
  isPanelOpen: boolean;
  copyPath?: string | null;
  lineRange: FilePreviewLineRange | null;
  markdownLinkRouting?: MarkdownLinkRouting;
  onSelectionAddToChat?: (text: string) => void;
  onOpenInEditor?: (path: string) => void;
  onRevealInFinder?: (path: string) => void;
  threadId: string;
}) {
  const q = useThreadStorageFilePreview(threadId, activePath, {
    enabled: isPanelOpen,
  });
  const routing = useMemo(
    () =>
      buildMarkdownFileImageRouting({
        path: activePath,
        rootPath: null,
        threadId,
        linkRouting: markdownLinkRouting,
        resolveRelativeSrc: (rel) =>
          buildThreadStorageRawContentUrl(threadId, rel),
      }),
    [activePath, markdownLinkRouting, threadId],
  );
  return (
    <SecondaryPanelFilePreview
      {...toPreviewBinding(q)}
      activePath={activePath}
      copyPath={copyPath}
      htmlPreviewUrl={buildThreadStorageRawContentUrl(threadId, activePath)}
      lineRange={lineRange}
      markdownLinkRouting={routing}
      onSelectionAddToChat={onSelectionAddToChat}
      onOpenInEditor={onOpenInEditor}
      onRevealInFinder={onRevealInFinder}
      statusLabel={null}
    />
  );
}
