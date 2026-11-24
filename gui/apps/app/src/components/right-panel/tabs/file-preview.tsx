import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@cloudroom/shared-ui/button";
import { COARSE_POINTER_TEXT_SM_CLASS } from "@cloudroom/shared-ui/coarse-pointer-sizing";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@cloudroom/shared-ui/tooltip";
import {
  isCsvFilePreview,
  isHtmlFilePreviewPath,
  isMarkdownFilePreview,
  type FilePreview as ClientFilePreview,
  type FilePreviewLineRange,
  type TextFilePreview,
  type WorkspaceFilePreviewStatusLabel,
} from "@cloudroom/client-core";
import { SourceLoadingSkeleton } from "@/components/code/code-loading-skeletons";
import { hashSourceContents } from "@/components/code/source-code-budget";
import { useAppCommandShortcut } from "@/components/commands/AppCommandProvider";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import { CopyButton } from "@/components/ui/copy-button.js";
import type { MarkdownLinkRouting } from "@/components/ui/markdown-link-routing.js";
import { OpenInEditorButton } from "@/components/ui/open-in-editor-button.js";
import { TruncateStart } from "@/components/ui/truncate-start.js";
import { HttpError } from "@/lib/api";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import {
  DEFAULT_CODE_OVERFLOW_MODE,
  type CodeOverflowMode,
  type CodeOverflowModeChangeHandler,
} from "@/lib/code-overflow-mode";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import {
  CsvFilePreview,
  DownloadFallbackButton,
  FilePreviewAudio,
  FilePreviewCode,
  FilePreviewImage,
  FilePreviewMessage,
  FilePreviewVideo,
  HtmlFilePreviewBody,
  IframeFilePreview,
  ReadyDocumentPreview,
  appendMediaRefreshParam,
  buildCsvPreviewData,
  getCsvTruncationNote,
  type FilePreviewFile,
  type FilePreviewState,
  type FilePreviewToggleKind,
  type FilePreviewViewMode,
  type TextFilePreviewKind,
} from "./file-preview-renderers";
import { useDocumentFilePreview } from "./useDocumentFilePreview";

export { buildCsvPreviewData, getCsvTruncationNote };
export type { FilePreviewFile, FilePreviewState, TextFilePreviewKind };

const HEADER_ICON_BTN_CLASS =
  "h-5 w-5 rounded-sm p-0 [&_[data-icon-root]]:size-3 max-md:pointer-coarse:h-9 max-md:pointer-coarse:w-9 max-md:pointer-coarse:[&_[data-icon-root]]:size-5";
const VIEW_MODE_BTN_CLASS =
  "h-5 rounded-sm px-2 text-muted-foreground max-md:pointer-coarse:h-[30px]";

const HTML_IFRAME_SANDBOX = "allow-scripts" as const;
// Server HTML preview routes reject bodies above 5 MiB (HTTP 413); reserve 3 bytes for a stripped UTF-8 BOM.
const HTML_PREVIEW_MAX_BYTES = 5 * 1024 * 1024 - 3;

export function exceedsHtmlPreviewLimit(content: string): boolean {
  if (content.length * 3 <= HTML_PREVIEW_MAX_BYTES) return false;
  return (
    content.length > HTML_PREVIEW_MAX_BYTES ||
    new TextEncoder().encode(content).byteLength > HTML_PREVIEW_MAX_BYTES
  );
}

function resolveToggleKind(
  state: FilePreviewState,
): FilePreviewToggleKind | null {
  if (state.kind === "html") return "html";
  if (state.kind === "ready") return state.textPreviewKind;
  return null;
}

function resolveInitialViewMode(
  toggleKind: FilePreviewToggleKind | null,
  lineRange: FilePreviewLineRange | null,
): FilePreviewViewMode {
  if (toggleKind !== null) return "preview";
  return lineRange === null ? "preview" : "source";
}

function isCodeLayout(
  state: FilePreviewState,
  viewMode: FilePreviewViewMode,
): boolean {
  if (state.kind === "html") return viewMode === "source";
  if (state.kind !== "ready") return false;
  return state.textPreviewKind === null || viewMode === "source";
}

function getCopyLabel(kind: FilePreviewToggleKind | null): string {
  if (kind === "csv") return "Copy CSV";
  if (kind === "markdown") return "Copy markdown";
  if (kind === "html") return "Copy HTML source";
  return "Copy file contents";
}

function getToggleAriaLabel(kind: FilePreviewToggleKind): string {
  if (kind === "csv") return "CSV view mode";
  if (kind === "html") return "HTML view mode";
  return "Markdown view mode";
}

function toAbsoluteUrl(url: string): string {
  return typeof window === "undefined"
    ? url
    : new URL(url, window.location.href).toString();
}

function FilePreviewHeader({
  path,
  copyPath,
  rawContents,
  externalUrl,
  onOpenInEditor,
  onRevealInFinder,
  onDownload,
  onRefresh,
  isRefreshing,
  statusLabel,
  toggleKind,
  showWrapToggle,
  lineOverflowMode,
  onLineOverflowModeChange,
  viewMode,
  onViewModeChange,
}: {
  path: string;
  copyPath: string | null;
  rawContents: string | null;
  externalUrl: string | null;
  onOpenInEditor?: (path: string) => void;
  onRevealInFinder?: (path: string) => void;
  onDownload?: (path: string) => void;
  onRefresh?: () => void;
  isRefreshing: boolean;
  statusLabel: WorkspaceFilePreviewStatusLabel | null;
  toggleKind: FilePreviewToggleKind | null;
  showWrapToggle: boolean;
  lineOverflowMode: CodeOverflowMode;
  onLineOverflowModeChange: CodeOverflowModeChangeHandler;
  viewMode: FilePreviewViewMode;
  onViewModeChange: (mode: FilePreviewViewMode) => void;
}) {
  const openShortcut = useAppCommandShortcut("workspace.openPreferred");
  const copyContentsLabel = getCopyLabel(toggleKind);
  const wrapLabel =
    lineOverflowMode === "wrap" ? "Disable line wrap" : "Wrap lines";
  const editorLabel = openShortcut
    ? `Open in editor (${openShortcut.label})`
    : "Open in editor";

  return (
    <div className="sticky top-0 z-10 bg-sidebar">
      <div className="flex h-9 items-center gap-2 bg-surface-raised px-4">
        <TooltipProvider delayDuration={300}>
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <Icon
              name="File"
              className="size-3.5 shrink-0 text-subtle-foreground"
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "min-w-0 cursor-pointer rounded-sm text-left font-mono font-medium leading-5 text-file-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    COARSE_POINTER_TEXT_SM_CLASS,
                  )}
                  aria-label="Copy file path"
                  onClick={() => {
                    void copyToClipboardWithToast(copyPath ?? path, {
                      successMessage: "File path copied",
                      errorMessage: "Failed to copy file path",
                    });
                  }}
                >
                  <TruncateStart>{path}</TruncateStart>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Copy file path</TooltipContent>
            </Tooltip>

            {statusLabel ? (
              <span
                className={cn(
                  "shrink-0 leading-5 text-muted-foreground",
                  COARSE_POINTER_TEXT_SM_CLASS,
                )}
              >
                ({statusLabel})
              </span>
            ) : null}

            {onRefresh ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={cn(
                      HEADER_ICON_BTN_CLASS,
                      "shrink-0 text-muted-foreground hover:bg-state-hover hover:text-foreground",
                    )}
                    onClick={onRefresh}
                    disabled={isRefreshing}
                    aria-label={
                      isRefreshing ? "Refreshing file" : "Refresh file"
                    }
                  >
                    <Icon
                      name={isRefreshing ? "Spinner" : "RotateCcw"}
                      className={cn(isRefreshing && "animate-spin")}
                      aria-hidden
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {isRefreshing ? "Refreshing file" : "Refresh file"}
                </TooltipContent>
              </Tooltip>
            ) : null}

            {rawContents !== null ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <CopyButton
                    text={rawContents}
                    label={copyContentsLabel}
                    className={cn(
                      HEADER_ICON_BTN_CLASS,
                      "shrink-0 rounded-md hover:bg-state-hover hover:text-foreground",
                    )}
                  />
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {copyContentsLabel}
                </TooltipContent>
              </Tooltip>
            ) : null}

            {externalUrl !== null ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={cn(
                      HEADER_ICON_BTN_CLASS,
                      "shrink-0 text-muted-foreground hover:bg-state-hover hover:text-foreground",
                    )}
                    onClick={() =>
                      openUrlInExternalBrowser(toAbsoluteUrl(externalUrl))
                    }
                    aria-label="Open in external browser"
                  >
                    <Icon name="Globe" aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Open in external browser
                </TooltipContent>
              </Tooltip>
            ) : null}

            {onOpenInEditor ? (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <OpenInEditorButton
                      onClick={() => onOpenInEditor(path)}
                      className={HEADER_ICON_BTN_CLASS}
                      label={editorLabel}
                      aria-keyshortcuts={openShortcut?.ariaKeyshortcuts}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{editorLabel}</TooltipContent>
                </Tooltip>
                <AppCommandShortcutHint shortcut={openShortcut} />
              </>
            ) : null}

            {onDownload ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={cn(
                      HEADER_ICON_BTN_CLASS,
                      "shrink-0 text-muted-foreground hover:bg-state-hover hover:text-foreground",
                    )}
                    onClick={() => onDownload(path)}
                    aria-label="Save to Downloads"
                  >
                    <Icon name="Download" aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Save to Downloads</TooltipContent>
              </Tooltip>
            ) : null}

            {onRevealInFinder && copyPath ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={cn(
                      HEADER_ICON_BTN_CLASS,
                      "shrink-0 text-muted-foreground hover:bg-state-hover hover:text-foreground",
                    )}
                    onClick={() => onRevealInFinder(copyPath)}
                    aria-label="Open in Finder"
                  >
                    <Icon name="FolderOpen" aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Open in Finder</TooltipContent>
              </Tooltip>
            ) : null}
          </div>

          {showWrapToggle || toggleKind !== null ? (
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {showWrapToggle ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={cn(
                        HEADER_ICON_BTN_CLASS,
                        "text-muted-foreground",
                      )}
                      aria-label={wrapLabel}
                      aria-pressed={lineOverflowMode === "wrap"}
                      onClick={() =>
                        onLineOverflowModeChange(
                          lineOverflowMode === "wrap" ? "scroll" : "wrap",
                        )
                      }
                    >
                      <Icon name="TextWrap" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{wrapLabel}</TooltipContent>
                </Tooltip>
              ) : null}

              {toggleKind !== null ? (
                <div
                  className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5"
                  role="tablist"
                  aria-label={getToggleAriaLabel(toggleKind)}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn(
                      VIEW_MODE_BTN_CLASS,
                      COARSE_POINTER_TEXT_SM_CLASS,
                    )}
                    onClick={() => onViewModeChange("preview")}
                    aria-pressed={viewMode === "preview"}
                  >
                    Preview
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn(
                      VIEW_MODE_BTN_CLASS,
                      COARSE_POINTER_TEXT_SM_CLASS,
                    )}
                    onClick={() => onViewModeChange("source")}
                    aria-pressed={viewMode === "source"}
                  >
                    Raw
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </TooltipProvider>
      </div>
    </div>
  );
}

export interface FilePreviewProps {
  state: FilePreviewState;
  notice?: ReactNode;
  path: string;
  copyPath?: string | null;
  headerMode?: "file" | "none";
  onSelectionAddToChat?: (text: string) => void;
  onOpenInEditor?: (path: string) => void;
  onRevealInFinder?: (path: string) => void;
  onDownload?: (path: string) => void;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  markdownLinkRouting?: MarkdownLinkRouting;
  statusLabel?: WorkspaceFilePreviewStatusLabel | null;
}

export function FilePreview({
  state,
  notice,
  path,
  copyPath = null,
  headerMode = "file",
  onSelectionAddToChat,
  onOpenInEditor,
  onRevealInFinder,
  onDownload,
  onRefresh,
  isRefreshing = false,
  markdownLinkRouting,
  statusLabel = null,
}: FilePreviewProps) {
  const [mediaRefresh, setMediaRefresh] = useState({ count: 0, path });
  const mediaRefreshCount = mediaRefresh.path === path ? mediaRefresh.count : 0;

  const toggleKind = resolveToggleKind(state);
  const lineRange =
    state.kind === "html" || state.kind === "ready" ? state.lineRange : null;
  const rawContents =
    state.kind === "html" || state.kind === "ready"
      ? state.file.contents
      : null;
  const externalUrl =
    state.kind === "iframe"
      ? state.url
      : state.kind === "html"
        ? state.iframe.url
        : null;

  const [viewMode, setViewMode] = useState<FilePreviewViewMode>(() =>
    resolveInitialViewMode(toggleKind, lineRange),
  );
  const [lineOverflowMode, setLineOverflowMode] = useState<CodeOverflowMode>(
    DEFAULT_CODE_OVERFLOW_MODE,
  );

  useEffect(() => {
    setViewMode(resolveInitialViewMode(toggleKind, lineRange));
  }, [lineRange, path, toggleKind]);

  const bodyViewMode: FilePreviewViewMode =
    toggleKind === null ? "preview" : viewMode;
  const codeLayout = isCodeLayout(state, bodyViewMode);
  const iframeLayout =
    state.kind === "iframe" ||
    (state.kind === "html" && bodyViewMode === "preview");
  const csvLayout =
    state.kind === "ready" &&
    state.textPreviewKind === "csv" &&
    bodyViewMode === "preview";
  const markdownLayout =
    state.kind === "ready" &&
    state.textPreviewKind === "markdown" &&
    bodyViewMode === "preview";

  const rootClass =
    iframeLayout || csvLayout || codeLayout
      ? "@container/page flex h-full min-h-0 flex-col"
      : markdownLayout
        ? "@container/page flex min-h-full flex-col"
        : "@container/page min-h-full";

  const handleRefresh = onRefresh
    ? () => {
        setMediaRefresh((cur) => ({
          count: cur.path === path ? cur.count + 1 : 1,
          path,
        }));
        onRefresh();
      }
    : undefined;

  return (
    <div className={rootClass}>
      {notice}
      {headerMode === "file" ? (
        <FilePreviewHeader
          path={path}
          copyPath={copyPath}
          rawContents={rawContents}
          externalUrl={externalUrl}
          onOpenInEditor={onOpenInEditor}
          onRevealInFinder={onRevealInFinder}
          onDownload={onDownload}
          onRefresh={handleRefresh}
          isRefreshing={isRefreshing}
          statusLabel={statusLabel}
          toggleKind={toggleKind}
          showWrapToggle={codeLayout}
          lineOverflowMode={lineOverflowMode}
          onLineOverflowModeChange={setLineOverflowMode}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
        />
      ) : null}
      <FilePreviewBody
        state={state}
        path={path}
        lineOverflowMode={lineOverflowMode}
        viewMode={bodyViewMode}
        markdownLinkRouting={markdownLinkRouting}
        mediaRefreshCount={mediaRefreshCount}
        onSelectionAddToChat={onSelectionAddToChat}
        onDownload={onDownload}
      />
    </div>
  );
}

function FilePreviewBody({
  state,
  path,
  lineOverflowMode,
  viewMode,
  markdownLinkRouting,
  mediaRefreshCount,
  onSelectionAddToChat,
  onDownload,
}: {
  state: FilePreviewState;
  path: string;
  lineOverflowMode: CodeOverflowMode;
  viewMode: FilePreviewViewMode;
  markdownLinkRouting?: MarkdownLinkRouting;
  mediaRefreshCount: number;
  onSelectionAddToChat?: (text: string) => void;
  onDownload?: (path: string) => void;
}) {
  switch (state.kind) {
    case "loading":
      return <SourceLoadingSkeleton />;
    case "empty":
      return <FilePreviewMessage message="Empty file." />;
    case "not-found":
      return <FilePreviewMessage message="File not found." role="alert" />;
    case "error":
      return (
        <FilePreviewMessage
          message={state.message ?? "Failed to load file"}
          role={state.message === undefined ? "alert" : undefined}
        >
          <DownloadFallbackButton path={path} onDownload={onDownload} />
        </FilePreviewMessage>
      );
    case "image":
      return (
        <FilePreviewImage
          url={appendMediaRefreshParam(state.url, mediaRefreshCount)}
          alt={path}
          path={path}
          onDownload={onDownload}
        />
      );
    case "video":
      return (
        <FilePreviewVideo
          url={appendMediaRefreshParam(state.url, mediaRefreshCount)}
          title={path}
          path={path}
          onDownload={onDownload}
        />
      );
    case "audio":
      return (
        <FilePreviewAudio
          url={appendMediaRefreshParam(state.url, mediaRefreshCount)}
          path={path}
          sizeBytes={state.sizeBytes}
          onDownload={onDownload}
        />
      );
    case "iframe":
      return (
        <IframeFilePreview
          sandbox={state.sandbox}
          title={state.title}
          url={state.url}
        />
      );
    case "html":
      return (
        <HtmlFilePreviewBody
          state={state}
          viewMode={viewMode}
          lineOverflowMode={lineOverflowMode}
          onSelectionAddToChat={onSelectionAddToChat}
        />
      );
    case "ready":
      if (state.textPreviewKind === "csv" && viewMode === "preview") {
        return (
          <CsvFilePreview
            file={state.file}
            onSelectionAddToChat={onSelectionAddToChat}
          />
        );
      }
      if (state.textPreviewKind === "markdown" && viewMode === "preview") {
        return (
          <ReadyDocumentPreview
            state={state}
            markdownLinkRouting={markdownLinkRouting}
            onSelectionAddToChat={onSelectionAddToChat}
          />
        );
      }
      return (
        <FilePreviewCode
          file={state.file}
          lineOverflowMode={lineOverflowMode}
          lineRange={state.lineRange ?? null}
          onSelectionAddToChat={onSelectionAddToChat}
          path={path}
        />
      );
  }
}

function makeTextFile(
  activePath: string,
  preview: TextFilePreview,
): FilePreviewFile {
  const name = preview.name ?? activePath;
  return {
    cacheKey: [
      "file-preview",
      preview.url,
      preview.path,
      name,
      preview.mimeType,
      hashSourceContents(preview.content),
    ].join(":"),
    name,
    contents: preview.content,
  };
}

function resolvePreviewState(args: {
  activePath: string;
  error?: Error | null;
  filePreview: ClientFilePreview | undefined;
  htmlPreviewUrl: string | null;
  isLoading: boolean;
  lineRange: FilePreviewLineRange | null;
}): FilePreviewState {
  const {
    activePath,
    error,
    filePreview,
    htmlPreviewUrl,
    isLoading,
    lineRange,
  } = args;

  if (error) {
    return error instanceof HttpError && error.status === 404
      ? { kind: "not-found" }
      : { kind: "error", message: error.message };
  }

  if (isLoading || !filePreview || filePreview.path !== activePath) {
    return { kind: "loading" };
  }

  if (
    htmlPreviewUrl !== null &&
    isHtmlFilePreviewPath(activePath) &&
    !(
      filePreview.kind === "text" &&
      exceedsHtmlPreviewLimit(filePreview.content)
    )
  ) {
    const iframe = {
      sandbox: HTML_IFRAME_SANDBOX,
      title: activePath,
      url: htmlPreviewUrl,
    };
    return filePreview.kind === "text"
      ? {
          kind: "html",
          file: makeTextFile(activePath, filePreview),
          iframe,
          lineRange,
        }
      : { kind: "iframe", ...iframe };
  }

  switch (filePreview.kind) {
    case "text":
      if (filePreview.content.length === 0) return { kind: "empty" };
      return {
        kind: "ready",
        lineRange,
        textPreviewKind: isCsvFilePreview(filePreview)
          ? "csv"
          : isMarkdownFilePreview(filePreview)
            ? "markdown"
            : null,
        file: makeTextFile(activePath, filePreview),
      };
    case "image":
      return { kind: "image", url: filePreview.url };
    case "video":
      return { kind: "video", url: filePreview.url };
    case "audio":
      return {
        kind: "audio",
        url: filePreview.url,
        sizeBytes: filePreview.sizeBytes ?? null,
      };
    case "document":
      return { kind: "loading" };
    default:
      return {
        kind: "error",
        message: `Preview not available for ${filePreview.mimeType}.`,
      };
  }
}

export function SecondaryPanelFilePreview({
  activePath,
  copyPath = null,
  error,
  filePreview,
  htmlPreviewUrl = null,
  isLoading,
  isRefreshing = false,
  lineRange = null,
  markdownLinkRouting,
  onSelectionAddToChat,
  onOpenInEditor,
  onRevealInFinder,
  onDownload,
  onRefresh,
  statusLabel = null,
}: {
  activePath: string;
  copyPath?: string | null;
  error?: Error | null;
  filePreview: ClientFilePreview | undefined;
  htmlPreviewUrl?: string | null;
  isLoading: boolean;
  isRefreshing?: boolean;
  lineRange?: FilePreviewLineRange | null;
  markdownLinkRouting?: MarkdownLinkRouting;
  onSelectionAddToChat?: (text: string) => void;
  onOpenInEditor?: (path: string) => void;
  onRevealInFinder?: (path: string) => void;
  onDownload?: (path: string) => void;
  onRefresh?: () => void;
  statusLabel?: WorkspaceFilePreviewStatusLabel | null;
}) {
  const activeDocument =
    !error &&
    !isLoading &&
    filePreview?.kind === "document" &&
    filePreview.path === activePath
      ? filePreview
      : null;

  const docView = useDocumentFilePreview(activeDocument);
  const state =
    docView?.state ??
    resolvePreviewState({
      activePath,
      error,
      filePreview,
      htmlPreviewUrl,
      isLoading,
      lineRange,
    });

  return (
    <FilePreview
      notice={docView?.notice}
      path={activePath}
      copyPath={copyPath}
      onSelectionAddToChat={onSelectionAddToChat}
      onOpenInEditor={onOpenInEditor}
      onRevealInFinder={onRevealInFinder}
      onDownload={onDownload}
      onRefresh={onRefresh}
      isRefreshing={isRefreshing}
      markdownLinkRouting={
        state.kind === "ready" ? markdownLinkRouting : undefined
      }
      statusLabel={statusLabel}
      state={state}
    />
  );
}
