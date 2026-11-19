import type { DocumentFileFormat } from "@cloudroom/client-core";
import { formatFileSize } from "@/lib/format-file-size";
import { inflate, listTar, listZip, type ArchiveEntry } from "./archive";
import {
  convertPresentation,
  convertWordDocument,
  convertWorkbook,
  fitsPageView,
  type DocumentPart,
} from "./office";

export interface DocumentPreview {
  label: string;
  detail: string | null;
  textKind: "csv" | "markdown" | null;
  parts: DocumentPart[];
  /** Word and PowerPoint that may be drawn as pages; slides in saved order. */
  pageView?: { slideOrder: string[] };
}

interface ArchiveFolder {
  folders: Map<string, ArchiveFolder>;
  files: { name: string; size: number }[];
  fileCount: number;
  size: number;
}

interface ListingLine {
  label: string;
  fileCount: number | null;
  size: number;
}

const MAX_LISTED_LINES = 2000;
const MAX_LABEL_WIDTH = 48;
const byName = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

function newFolder(): ArchiveFolder {
  return { folders: new Map(), files: [], fileCount: 0, size: 0 };
}

function sumFolder(root: ArchiveFolder): void {
  const folders = [root];
  for (let index = 0; index < folders.length; index += 1) {
    for (const child of folders[index]?.folders.values() ?? [])
      folders.push(child);
  }
  for (let index = folders.length - 1; index >= 0; index -= 1) {
    const folder = folders[index];
    if (!folder) continue;
    folder.fileCount = folder.files.length;
    folder.size = folder.files.reduce((total, file) => total + file.size, 0);
    for (const child of folder.folders.values()) {
      folder.fileCount += child.fileCount;
      folder.size += child.size;
    }
  }
}

function* listFolder(root: ArchiveFolder): Generator<ListingLine> {
  const stack: (
    | { folder: ArchiveFolder; depth: number }
    | { line: ListingLine }
  )[] = [{ folder: root, depth: 0 }];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) break;
    if ("line" in next) {
      yield next.line;
      continue;
    }
    const { folder, depth } = next;
    const indent = "  ".repeat(depth);
    const files = [...folder.files].sort((a, b) =>
      byName.compare(a.name, b.name),
    );
    for (const file of files.reverse()) {
      stack.push({
        line: {
          label: `${indent}${file.name}`,
          fileCount: null,
          size: file.size,
        },
      });
    }
    const folders = [...folder.folders].sort(([a], [b]) =>
      byName.compare(a, b),
    );
    for (const [name, child] of folders.reverse()) {
      stack.push({ folder: child, depth: depth + 1 });
      stack.push({
        line: {
          label: `${indent}${name}/`,
          fileCount: child.fileCount,
          size: child.size,
        },
      });
    }
  }
}

export function archivePreview(
  entries: ArchiveEntry[],
  truncated: boolean,
): DocumentPreview {
  const root = newFolder();
  for (const entry of entries) {
    const parts = entry.name.replace(/^\.\//u, "").split("/").filter(Boolean);
    if (
      parts.length === 0 ||
      parts[0] === "__MACOSX" ||
      parts.at(-1) === ".DS_Store"
    )
      continue;
    const folderNames = entry.isDirectory ? parts : parts.slice(0, -1);
    let folder = root;
    for (const name of folderNames) {
      const next = folder.folders.get(name) ?? newFolder();
      folder.folders.set(name, next);
      folder = next;
    }
    if (!entry.isDirectory)
      folder.files.push({ name: parts.at(-1) ?? "", size: entry.size });
  }
  sumFolder(root);
  const lines: ListingLine[] = [];
  let omittedLines = 0;
  let maxLabelLength = 0;
  for (const line of listFolder(root)) {
    maxLabelLength = Math.max(maxLabelLength, line.label.length);
    if (lines.length < MAX_LISTED_LINES) lines.push(line);
    else omittedLines += 1;
  }
  const width = Math.min(MAX_LABEL_WIDTH, maxLabelLength) + 2;
  const text = lines.map((line) =>
    [
      line.label.padEnd(width),
      (line.fileCount === null ? "" : plural(line.fileCount, "file")).padStart(
        11,
      ),
      formatFileSize(line.size).padStart(10),
    ]
      .join("")
      .trimEnd(),
  );
  if (omittedLines > 0) text.push(`… ${plural(omittedLines, "more line")}`);
  if (truncated) text.push("… Only the first 50 MB of this archive was read.");
  return {
    label: "What's inside",
    detail: `${plural(root.fileCount, "file")} · ${formatFileSize(root.size)}`,
    textKind: null,
    parts: [
      {
        name: "Files",
        text: text.length > 0 ? text.join("\n") : "This archive is empty.",
      },
    ],
  };
}

export async function convertDocument(
  format: DocumentFileFormat,
  bytes: Uint8Array,
): Promise<DocumentPreview> {
  switch (format) {
    case "xlsx": {
      const parts = await convertWorkbook(bytes);
      return {
        label: "Shown as text · from Excel",
        detail: parts.length === 1 ? (parts[0]?.name ?? null) : null,
        textKind: "csv",
        parts,
      };
    }
    case "docx": {
      const { markdown, words } = await convertWordDocument(bytes);
      return {
        label: "Shown as text · from Word",
        detail: plural(words, "word"),
        textKind: "markdown",
        parts: [{ name: "Document", text: markdown }],
        ...(fitsPageView(bytes) ? { pageView: { slideOrder: [] } } : {}),
      };
    }
    case "pptx": {
      const { markdown, slides, slidePaths } = await convertPresentation(bytes);
      return {
        label: "Shown as text · from PowerPoint",
        detail: plural(slides, "slide"),
        textKind: "markdown",
        parts: [{ name: "Slides", text: markdown }],
        ...(fitsPageView(bytes) ? { pageView: { slideOrder: slidePaths } } : {}),
      };
    }
    case "zip":
      return archivePreview(listZip(bytes), false);
    case "tar":
      return archivePreview(listTar(bytes), false);
    case "tgz": {
      const { bytes: tar, truncated } = await inflate(bytes, "gzip", {
        allowTruncation: true,
      });
      return archivePreview(listTar(tar), truncated);
    }
  }
}
