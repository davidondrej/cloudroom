const DEFAULT_FILE_PREVIEW_MIME_TYPE = "application/octet-stream";
const textDecoder = new TextDecoder();
const strictUtf8TextDecoder = new TextDecoder("utf-8", { fatal: true });

const UTF8_TEXT_MIME_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/json",
  "application/ld+json",
  "application/sql",
  "application/toml",
  "application/typescript",
  "application/x-httpd-php",
  "application/x-sh",
  "application/x-typescript",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
]);

const MARKDOWN_FILE_EXTENSIONS = [".md", ".markdown"];
const MARKDOWN_MIME_TYPES = new Set(["text/markdown", "text/x-markdown"]);
const CSV_FILE_EXTENSIONS = [".csv"];
const CSV_MIME_TYPES = new Set(["application/csv", "text/csv"]);
const HTML_FILE_EXTENSION = ".html";
const AUDIO_FILE_EXTENSIONS = [
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".weba",
];
const DOCUMENT_FILE_EXTENSIONS: readonly (readonly [
  string,
  DocumentFileFormat,
])[] = [
  [".xlsx", "xlsx"],
  [".xlsm", "xlsx"],
  [".docx", "docx"],
  [".docm", "docx"],
  [".pptx", "pptx"],
  [".pptm", "pptx"],
  [".zip", "zip"],
  [".tar", "tar"],
  [".tar.gz", "tgz"],
  [".tgz", "tgz"],
];
const NULL_CHARACTER = "\u0000";

export interface FilePreviewTarget {
  name?: string;
  path: string;
  url: string;
}

export type DocumentFileFormat =
  | "docx"
  | "pptx"
  | "tar"
  | "tgz"
  | "xlsx"
  | "zip";

interface FilePreviewBase extends FilePreviewTarget {
  kind: "audio" | "document" | "image" | "text" | "unsupported" | "video";
  mimeType: string;
}

interface ImageFilePreview extends FilePreviewBase {
  kind: "image";
}

interface VideoFilePreview extends FilePreviewBase {
  kind: "video";
}

interface AudioFilePreview extends FilePreviewBase {
  kind: "audio";
  sizeBytes?: number;
}

export interface DocumentFilePreview extends FilePreviewBase {
  kind: "document";
  format: DocumentFileFormat;
  contentBytes: Uint8Array;
}

export interface TextFilePreview extends FilePreviewBase {
  kind: "text";
  content: string;
}

interface UnsupportedFilePreview extends FilePreviewBase {
  kind: "unsupported";
}

export type FilePreview =
  | AudioFilePreview
  | DocumentFilePreview
  | ImageFilePreview
  | VideoFilePreview
  | TextFilePreview
  | UnsupportedFilePreview;

export type EnvironmentFilePreviewSource =
  | { kind: "working-tree" }
  | { kind: "head" }
  | { kind: "merge-base"; ref: string };

export type WorkspaceFilePreviewStatusLabel = "deleted";

export interface FilePreviewLineRange {
  endLineNumber: number;
  startLineNumber: number;
}

interface CreateFilePreviewLineRangeArgs {
  endLineNumber: number;
  startLineNumber: number;
}

interface AreFilePreviewLineRangesEqualArgs {
  a: FilePreviewLineRange | null;
  b: FilePreviewLineRange | null;
}

interface GetFilePreviewLineRangeStartArgs {
  lineRange: FilePreviewLineRange | null;
}

export interface WorkspaceFileTabState {
  lineRange: FilePreviewLineRange | null;
  path: string;
  source: EnvironmentFilePreviewSource;
  statusLabel: WorkspaceFilePreviewStatusLabel | null;
}

export interface HostFileTabState {
  lineRange: FilePreviewLineRange | null;
  path: string;
}

export interface ThreadStorageFileTabState {
  lineRange: FilePreviewLineRange | null;
  path: string;
}

export function createFilePreviewLineRange({
  endLineNumber,
  startLineNumber,
}: CreateFilePreviewLineRangeArgs): FilePreviewLineRange | null {
  if (
    !Number.isSafeInteger(startLineNumber) ||
    !Number.isSafeInteger(endLineNumber) ||
    startLineNumber <= 0 ||
    endLineNumber <= 0 ||
    startLineNumber > endLineNumber
  ) {
    return null;
  }

  return {
    endLineNumber,
    startLineNumber,
  };
}

export function areFilePreviewLineRangesEqual({
  a,
  b,
}: AreFilePreviewLineRangesEqualArgs): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.startLineNumber === b.startLineNumber &&
    a.endLineNumber === b.endLineNumber
  );
}

export function getFilePreviewLineRangeStart({
  lineRange,
}: GetFilePreviewLineRangeStartArgs): number | null {
  return lineRange?.startLineNumber ?? null;
}

export function areEnvironmentFilePreviewSourcesEqual(
  a: EnvironmentFilePreviewSource,
  b: EnvironmentFilePreviewSource,
): boolean {
  if (a.kind !== b.kind) {
    return false;
  }

  switch (a.kind) {
    case "working-tree":
    case "head":
      return true;
    case "merge-base":
      return b.kind === "merge-base" && a.ref === b.ref;
    default: {
      const exhaustive: never = a;
      return exhaustive;
    }
  }
}

interface BuildFilePreviewArgs extends FilePreviewTarget {
  contentBytes: Uint8Array;
  mimeType: string;
}

function isKnownTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml") ||
    UTF8_TEXT_MIME_TYPES.has(mimeType)
  );
}

function decodeUtf8Text(contentBytes: Uint8Array): string | null {
  try {
    const content = strictUtf8TextDecoder.decode(contentBytes);
    return content.includes(NULL_CHARACTER) ? null : content;
  } catch {
    return null;
  }
}

function decodeDeclaredTextContent(contentBytes: Uint8Array): string | null {
  const content = textDecoder.decode(contentBytes);
  return content.includes(NULL_CHARACTER) ? null : content;
}

function hasMarkdownExtension(path: string): boolean {
  const normalizedPath = path.toLowerCase();
  return MARKDOWN_FILE_EXTENSIONS.some((extension) =>
    normalizedPath.endsWith(extension),
  );
}

function hasCsvExtension(path: string): boolean {
  const normalizedPath = path.toLowerCase();
  return CSV_FILE_EXTENSIONS.some((extension) =>
    normalizedPath.endsWith(extension),
  );
}

export function isAudioFilePreviewPath(path: string): boolean {
  const normalizedPath = path.toLowerCase();
  return AUDIO_FILE_EXTENSIONS.some((extension) =>
    normalizedPath.endsWith(extension),
  );
}

export function getDocumentFileFormat(path: string): DocumentFileFormat | null {
  const normalizedPath = path.toLowerCase();
  return (
    DOCUMENT_FILE_EXTENSIONS.find(([extension]) =>
      normalizedPath.endsWith(extension),
    )?.[1] ?? null
  );
}

export function isHtmlFilePreviewPath(path: string): boolean {
  return path.toLowerCase().endsWith(HTML_FILE_EXTENSION);
}

export function normalizeFilePreviewMimeType(value: string | null): string {
  const normalizedValue = value?.split(";")[0]?.trim().toLowerCase();
  return normalizedValue && normalizedValue.length > 0
    ? normalizedValue
    : DEFAULT_FILE_PREVIEW_MIME_TYPE;
}

export function isMarkdownFilePreview(preview: FilePreview): boolean {
  return (
    preview.kind === "text" &&
    (MARKDOWN_MIME_TYPES.has(preview.mimeType) ||
      hasMarkdownExtension(preview.path) ||
      (preview.name ? hasMarkdownExtension(preview.name) : false))
  );
}

export function isCsvFilePreview(preview: FilePreview): boolean {
  return (
    preview.kind === "text" &&
    (CSV_MIME_TYPES.has(preview.mimeType) ||
      hasCsvExtension(preview.path) ||
      (preview.name ? hasCsvExtension(preview.name) : false))
  );
}

export function buildFilePreview(args: BuildFilePreviewArgs): FilePreview {
  const base = {
    mimeType: args.mimeType,
    name: args.name,
    path: args.path,
    url: args.url,
  };

  if (args.mimeType.startsWith("image/")) {
    return {
      kind: "image",
      ...base,
    };
  }

  const fileName = args.name ?? args.path;
  if (isAudioFilePreviewPath(fileName)) {
    return {
      kind: "audio",
      ...base,
      sizeBytes: args.contentBytes.byteLength,
    };
  }

  const documentFormat = getDocumentFileFormat(fileName);
  if (documentFormat !== null) {
    return {
      kind: "document",
      ...base,
      contentBytes: args.contentBytes,
      format: documentFormat,
    };
  }

  if (isKnownTextMimeType(args.mimeType)) {
    const textContent = decodeDeclaredTextContent(args.contentBytes);
    if (textContent === null) {
      return {
        kind: "unsupported",
        ...base,
      };
    }
    return {
      kind: "text",
      ...base,
      content: textContent,
    };
  }

  const fallbackTextContent = decodeUtf8Text(args.contentBytes);
  if (fallbackTextContent !== null) {
    return {
      kind: "text",
      ...base,
      content: fallbackTextContent,
    };
  }

  if (args.mimeType.startsWith("video/")) {
    return {
      kind: "video",
      ...base,
    };
  }

  return {
    kind: "unsupported",
    ...base,
  };
}
