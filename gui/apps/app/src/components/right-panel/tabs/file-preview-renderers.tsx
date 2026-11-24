import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@cloudroom/shared-ui/button";
import { EmptyStatePanel } from "@cloudroom/shared-ui/empty-state";
import { Icon } from "@cloudroom/shared-ui/icon";
import type { FilePreviewLineRange } from "@cloudroom/client-core";
import { SourceLoadingSkeleton } from "@/components/code/code-loading-skeletons";
import { SourceCodeHost } from "@/components/code/SourceCodeHost";
import { ImageLightbox } from "@/components/ui/image-lightbox.js";
import type { MarkdownLinkRouting } from "@/components/ui/markdown-link-routing.js";
import { MarkdownPreview } from "@/components/ui/markdown-preview.js";
import type { CodeOverflowMode } from "@/lib/code-overflow-mode";
import { formatFileSize } from "@/lib/format-file-size";
import { AgentEditCursor } from "./agent-file-edit";
import { useImageTabLightbox } from "./image-lightbox";
import OfficeDocumentFrame, {
  type OfficeDocumentFormat,
} from "./OfficeDocumentFrame";
import { SecondaryPanelSelectionActions } from "./selection-actions";

export interface FilePreviewFile {
  cacheKey?: string;
  name: string;
  contents: string;
}

export type TextFilePreviewKind = "csv" | "markdown";
export type FilePreviewToggleKind = "csv" | "html" | "markdown";
export type FilePreviewViewMode = "preview" | "source";

export interface IframeFilePreviewTarget {
  sandbox: "allow-scripts";
  title: string;
  url: string;
}

export type FilePreviewState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "not-found" }
  | { kind: "error"; message?: string }
  | { kind: "image"; url: string }
  | { kind: "video"; url: string }
  | { kind: "audio"; url: string; sizeBytes: number | null }
  | ({ kind: "iframe" } & IframeFilePreviewTarget)
  | {
      kind: "html";
      file: FilePreviewFile;
      iframe: IframeFilePreviewTarget;
      lineRange: FilePreviewLineRange | null;
    }
  | {
      kind: "ready";
      file: FilePreviewFile;
      lineRange: FilePreviewLineRange | null;
      textPreviewKind: TextFilePreviewKind | null;
      document?: {
        format: OfficeDocumentFormat;
        bytes: Uint8Array;
        slideOrder: string[];
      };
    };

export interface CsvPreviewData {
  columnCount: number;
  rows: string[][];
  truncatedColumns: boolean;
  truncatedRows: boolean;
}

const CSV_MAX_COLUMNS = 100;
const CSV_MAX_DATA_ROWS = 500;
const CSV_ROW_ESTIMATE_PX = 29;
const CSV_OVERSCAN = 8;
const CSV_MIN_COL_CH = 6;
const CSV_MAX_COL_CH = 36;

const IFRAME_STYLE: CSSProperties = {
  width: "100%",
  height: "100%",
  border: 0,
};
const IFRAME_LOADING_DELAY_MS = 160;

const MARKDOWN_DOCUMENT_CLASS =
  "mx-auto max-w-[46rem] text-[15px] leading-[1.7] [&_h1]:mb-3 [&_h1]:text-[1.65rem] [&_h1]:leading-tight [&_h1]:tracking-tight [&_h2:not(:first-child)]:mt-8 [&_h2]:mb-2.5 [&_h2]:text-[1.2rem] [&_h2]:tracking-tight [&_h3:not(:first-child)]:mt-6 [&_h3]:text-base [&_li]:mb-1.5 [&_p]:mb-3";

function parseCsvLimited(
  contents: string,
  maxRows: number,
): { rows: string[][]; truncatedRows: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let wasQuoted = false;
  let justBrokeLine = false;

  for (let i = 0; i < contents.length; i += 1) {
    const ch = contents[i]!;
    justBrokeLine = false;

    if (inQuotes) {
      if (ch === '"') {
        if (contents[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"' && cell.length === 0) {
      inQuotes = true;
      wasQuoted = true;
      continue;
    }

    if (ch === ",") {
      row.push(cell);
      cell = "";
      wasQuoted = false;
      continue;
    }

    if (ch === "\n" || ch === "\r") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      wasQuoted = false;
      justBrokeLine = true;
      if (ch === "\r" && contents[i + 1] === "\n") i += 1;
      if (rows.length >= maxRows) {
        return { rows, truncatedRows: i + 1 < contents.length };
      }
      continue;
    }

    cell += ch;
  }

  if (cell.length > 0 || row.length > 0 || wasQuoted || !justBrokeLine) {
    row.push(cell);
    rows.push(row);
  }

  return { rows, truncatedRows: false };
}

export function buildCsvPreviewData(contents: string): CsvPreviewData {
  const { rows, truncatedRows } = parseCsvLimited(
    contents,
    CSV_MAX_DATA_ROWS + 1,
  );
  let widest = 0;
  for (const row of rows) {
    if (row.length > widest) widest = row.length;
  }
  return {
    columnCount: Math.min(widest, CSV_MAX_COLUMNS),
    rows,
    truncatedColumns: widest > CSV_MAX_COLUMNS,
    truncatedRows,
  };
}

export function getCsvTruncationNote(
  preview: CsvPreviewData,
  dataRowCount: number,
): string | null {
  const parts: string[] = [];
  if (preview.truncatedRows)
    parts.push(`${dataRowCount.toLocaleString()} rows`);
  if (preview.truncatedColumns)
    parts.push(`${preview.columnCount.toLocaleString()} columns`);
  return parts.length > 0 ? `Showing the first ${parts.join(" and ")}.` : null;
}

export function FilePreviewMessage({
  message,
  role,
  children,
}: {
  message: string;
  role?: "alert";
  children?: ReactNode;
}) {
  return (
    <EmptyStatePanel role={role} className="mx-4 mt-4 rounded-lg">
      {message}
      {children ? <div>{children}</div> : null}
    </EmptyStatePanel>
  );
}

export function DownloadFallbackButton({
  path,
  onDownload,
}: {
  path: string;
  onDownload?: (path: string) => void;
}) {
  if (!onDownload) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="mt-3"
      onClick={() => onDownload(path)}
    >
      <Icon name="Download" aria-hidden />
      Save to Downloads
    </Button>
  );
}

export function FilePreviewCode({
  file,
  lineOverflowMode,
  lineRange,
  onSelectionAddToChat,
  path,
}: {
  file: FilePreviewFile;
  lineOverflowMode: CodeOverflowMode;
  lineRange: FilePreviewLineRange | null;
  onSelectionAddToChat?: (text: string) => void;
  path: string;
}) {
  const highlightedLines = useMemo(
    () =>
      lineRange
        ? { start: lineRange.startLineNumber, end: lineRange.endLineNumber }
        : null,
    [lineRange],
  );
  return (
    <SourceCodeHost
      content={file.contents}
      path={path}
      cacheKey={file.cacheKey ?? file.name}
      overflow={lineOverflowMode}
      highlightedLines={highlightedLines}
      scrollToHighlightedLines
      fallback={<SourceLoadingSkeleton />}
      onSelectionAddToChat={onSelectionAddToChat}
    />
  );
}

export function MarkdownFilePreview({
  file,
  markdownLinkRouting,
  onSelectionAddToChat,
}: {
  file: FilePreviewFile;
  markdownLinkRouting?: MarkdownLinkRouting;
  onSelectionAddToChat?: (text: string) => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <SecondaryPanelSelectionActions onSelectionAddToChat={onSelectionAddToChat}>
      <div className="relative flex-auto bg-background px-6 pb-12 pt-5">
        <div ref={contentRef}>
          <MarkdownPreview
            allowHtml
            className={MARKDOWN_DOCUMENT_CLASS}
            content={file.contents}
            linkRouting={markdownLinkRouting}
          />
        </div>
        <AgentEditCursor contentRef={contentRef} contents={file.contents} />
      </div>
    </SecondaryPanelSelectionActions>
  );
}

export function CsvFilePreview({
  file,
  onSelectionAddToChat,
}: {
  file: FilePreviewFile;
  onSelectionAddToChat?: (text: string) => void;
}) {
  const preview = useMemo(
    () => buildCsvPreviewData(file.contents),
    [file.contents],
  );
  const headerRow = preview.rows[0] ?? [];
  const bodyRows = useMemo(() => preview.rows.slice(1), [preview.rows]);

  const colWidths = useMemo(() => {
    const header = preview.rows[0] ?? [];
    const sample = preview.rows.slice(1, 101);
    return Array.from({ length: preview.columnCount }, (_, col) => {
      let maxLen = Math.max(
        CSV_MIN_COL_CH,
        (header[col] || `Column ${col + 1}`).length,
      );
      for (const row of sample) {
        const len = (row[col] ?? "").length;
        if (len > maxLen) maxLen = len;
      }
      return Math.min(CSV_MAX_COL_CH, maxLen + 2);
    });
  }, [preview]);

  const totalChars = colWidths.reduce((sum, w) => sum + w, 0);
  const tableWidth = `max(100%, calc(3rem + ${totalChars}ch + ${preview.columnCount}rem))`;
  const truncationNote = getCsvTruncationNote(preview, bodyRows.length);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: bodyRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CSV_ROW_ESTIMATE_PX,
    overscan: CSV_OVERSCAN,
  });

  const items = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();
  const padTop = items[0]?.start ?? 0;
  const lastItem = items[items.length - 1];
  const padBottom = lastItem ? totalHeight - lastItem.end : totalHeight;
  const colSpan = preview.columnCount + 1;

  return (
    <SecondaryPanelSelectionActions onSelectionAddToChat={onSelectionAddToChat}>
      <div className="flex min-h-0 flex-auto flex-col bg-surface-raised px-4 py-4">
        <div
          ref={scrollRef}
          className="persistent-scrollbar min-h-0 overflow-auto overscroll-contain rounded-md border border-border bg-background"
        >
          <table
            className="min-w-full table-fixed border-separate border-spacing-0 font-mono text-xs leading-5"
            aria-label={`${file.name} CSV preview`}
            style={{ width: tableWidth }}
          >
            <colgroup>
              <col className="w-12" />
              {colWidths.map((chars, col) => (
                <col key={col} style={{ width: `calc(${chars}ch + 1rem)` }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th
                  scope="col"
                  className="sticky left-0 top-0 z-30 w-12 min-w-12 border-b border-r border-border bg-surface-recessed-solid px-2 py-1 text-right font-medium text-muted-foreground"
                >
                  #
                </th>
                {colWidths.map((_, col) => {
                  const label = headerRow[col] ?? "";
                  return (
                    <th
                      key={col}
                      scope="col"
                      className="sticky top-0 z-20 border-b border-r border-border bg-surface-recessed-solid px-2 py-1 text-left font-medium text-foreground"
                      title={label}
                    >
                      <span className="block max-w-full truncate">
                        {label || `Column ${col + 1}`}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {padTop > 0 ? (
                <tr aria-hidden style={{ height: padTop }}>
                  <td colSpan={colSpan} className="p-0" />
                </tr>
              ) : null}
              {items.map((vRow) => {
                const row = bodyRows[vRow.index] ?? [];
                return (
                  <tr
                    key={vRow.key}
                    data-index={vRow.index}
                    ref={virtualizer.measureElement}
                  >
                    <th
                      scope="row"
                      className="sticky left-0 z-10 w-12 min-w-12 border-b border-r border-border bg-surface-recessed-solid px-2 py-1 text-right font-medium text-muted-foreground"
                    >
                      {vRow.index + 2}
                    </th>
                    {colWidths.map((_, col) => {
                      const cell = row[col] ?? "";
                      return (
                        <td
                          key={col}
                          className="overflow-hidden border-b border-r border-border px-2 py-1 align-top text-foreground"
                          title={cell}
                        >
                          <span className="block max-w-full truncate">
                            {cell}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {padBottom > 0 ? (
                <tr aria-hidden style={{ height: padBottom }}>
                  <td colSpan={colSpan} className="p-0" />
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {truncationNote ? (
          <p className="mt-2 shrink-0 text-xs leading-5 text-muted-foreground">
            {truncationNote}
          </p>
        ) : null}
      </div>
    </SecondaryPanelSelectionActions>
  );
}

export function FilePreviewImage({
  url,
  alt,
  path,
  onDownload,
}: {
  url: string;
  alt: string;
  path: string;
  onDownload?: (path: string) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const sharedLightbox = useImageTabLightbox();

  useLayoutEffect(() => {
    if (sharedLightbox?.isOpen) {
      sharedLightbox.update({ alt, src: url });
    }
  }, [alt, sharedLightbox, url]);

  if (failedUrl === url) {
    return (
      <FilePreviewMessage message="Failed to load image." role="alert">
        <DownloadFallbackButton path={path} onDownload={onDownload} />
      </FilePreviewMessage>
    );
  }

  return (
    <div className="pt-4">
      <button
        type="button"
        className="block w-full cursor-zoom-in"
        aria-label={`Open ${alt} in full screen preview`}
        onClick={() => {
          if (sharedLightbox) {
            sharedLightbox.open({ alt, src: url });
          } else {
            setLocalOpen(true);
          }
        }}
      >
        <img
          src={url}
          alt={alt}
          className="mx-auto block h-auto max-w-full"
          onError={() => setFailedUrl(url)}
        />
      </button>
      {sharedLightbox === null ? (
        <ImageLightbox
          title={alt}
          imageSrc={localOpen ? url : null}
          imageAlt={alt}
          onClose={() => setLocalOpen(false)}
        />
      ) : null}
    </div>
  );
}

function formatAudioDuration(seconds: number): string {
  const total = Math.round(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  return hrs > 0
    ? `${hrs}:${String(mins).padStart(2, "0")}:${secs}`
    : `${mins}:${secs}`;
}

export function FilePreviewAudio({
  url,
  path,
  sizeBytes,
  onDownload,
}: {
  url: string;
  path: string;
  sizeBytes: number | null;
  onDownload?: (path: string) => void;
}) {
  const [duration, setDuration] = useState<number | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (failedUrl === url) {
    return (
      <FilePreviewMessage message="Failed to load audio." role="alert">
        <DownloadFallbackButton path={path} onDownload={onDownload} />
      </FilePreviewMessage>
    );
  }

  const ext = path.split(".").at(-1)?.toUpperCase() ?? null;
  const meta: [string, string][] = [];
  if (duration !== null && Number.isFinite(duration)) {
    meta.push(["Length", formatAudioDuration(duration)]);
  }
  if (ext) meta.push(["Format", ext]);
  if (sizeBytes !== null) meta.push(["Size", formatFileSize(sizeBytes)]);

  return (
    <div className="px-4 pt-5">
      <audio
        src={url}
        aria-label={path}
        className="block w-full"
        controls
        preload="metadata"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onError={() => setFailedUrl(url)}
      />
      <dl className="mt-5 grid grid-cols-[6rem_1fr] gap-y-2 text-sm">
        {meta.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function FilePreviewVideo({
  url,
  title,
  path,
  onDownload,
}: {
  url: string;
  title: string;
  path: string;
  onDownload?: (path: string) => void;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (failedUrl === url) {
    return (
      <FilePreviewMessage message="Failed to load video." role="alert">
        <DownloadFallbackButton path={path} onDownload={onDownload} />
      </FilePreviewMessage>
    );
  }

  return (
    <div className="pt-4">
      <video
        src={url}
        title={title}
        className="block max-h-[34rem] w-full bg-black"
        controls
        preload="metadata"
        onError={() => setFailedUrl(url)}
      />
    </div>
  );
}

export function IframeFilePreview({
  sandbox,
  title,
  url,
}: IframeFilePreviewTarget) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(
    "loading",
  );
  const [showSpinner, setShowSpinner] = useState(false);

  useEffect(() => {
    setStatus("loading");
  }, [url]);

  useEffect(() => {
    if (status !== "loading") {
      setShowSpinner(false);
      return;
    }
    setShowSpinner(false);
    const id = window.setTimeout(
      () => setShowSpinner(true),
      IFRAME_LOADING_DELAY_MS,
    );
    return () => window.clearTimeout(id);
  }, [status, url]);

  if (status === "error") {
    return (
      <div className="min-h-0 flex-1 overflow-hidden">
        <FilePreviewMessage
          message="Failed to load HTML preview."
          role="alert"
        />
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      {status === "loading" && showSpinner ? (
        <div className="absolute inset-x-0 top-0 z-10">
          <SourceLoadingSkeleton />
        </div>
      ) : null}
      <iframe
        title={title}
        src={url}
        sandbox={sandbox}
        style={IFRAME_STYLE}
        onLoad={() => setStatus("loaded")}
        onError={() => setStatus("error")}
      />
    </div>
  );
}

export function HtmlFilePreviewBody({
  state,
  viewMode,
  lineOverflowMode,
  onSelectionAddToChat,
}: {
  state: Extract<FilePreviewState, { kind: "html" }>;
  viewMode: FilePreviewViewMode;
  lineOverflowMode: CodeOverflowMode;
  onSelectionAddToChat?: (text: string) => void;
}) {
  const showRendered = viewMode === "preview";
  return (
    <>
      <div
        className={showRendered ? "contents" : "hidden"}
        aria-hidden={showRendered ? undefined : true}
      >
        <IframeFilePreview
          key={state.file.cacheKey}
          sandbox={state.iframe.sandbox}
          title={state.iframe.title}
          url={state.iframe.url}
        />
      </div>
      <div
        className={showRendered ? "hidden" : "contents"}
        aria-hidden={showRendered ? true : undefined}
      >
        <FilePreviewCode
          file={state.file}
          lineOverflowMode={lineOverflowMode}
          lineRange={state.lineRange}
          onSelectionAddToChat={onSelectionAddToChat}
          path={state.file.name}
        />
      </div>
    </>
  );
}

export function ReadyDocumentPreview({
  state,
  markdownLinkRouting,
  onSelectionAddToChat,
}: {
  state: Extract<FilePreviewState, { kind: "ready" }>;
  markdownLinkRouting?: MarkdownLinkRouting;
  onSelectionAddToChat?: (text: string) => void;
}) {
  const markdown = (
    <MarkdownFilePreview
      file={state.file}
      markdownLinkRouting={markdownLinkRouting}
      onSelectionAddToChat={onSelectionAddToChat}
    />
  );
  return state.document ? (
    <OfficeDocumentFrame {...state.document} fallback={markdown} />
  ) : (
    markdown
  );
}

export function appendMediaRefreshParam(url: string, count: number): string {
  if (count <= 0 || /^(?:blob|data):/iu.test(url)) return url;
  const hashIdx = url.indexOf("#");
  const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const hash = hashIdx >= 0 ? url.slice(hashIdx) : "";
  return `${base}${base.includes("?") ? "&" : "?"}v=${count}${hash}`;
}
