import type { DocumentFileFormat } from "@cloudroom/client-core";
import { formatFileSize } from "@/lib/format-file-size";
import { inflate, listTar, listZip, type ArchiveEntry } from "./archive";
import {
  convertPresentation,
  convertWordDocument,
  convertWorkbook,
  type DocumentPart,
} from "./office";

export interface DocumentPreview {
  label: string;
  detail: string | null;
  textKind: "csv" | "markdown" | null;
  parts: DocumentPart[];
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

function sumFolder(folder: ArchiveFolder): void {
  folder.fileCount = folder.files.length;
  folder.size = folder.files.reduce((total, file) => total + file.size, 0);
  for (const child of folder.folders.values()) {
    sumFolder(child);
    folder.fileCount += child.fileCount;
    folder.size += child.size;
  }
}

function listFolder(
  folder: ArchiveFolder,
  depth: number,
  lines: ListingLine[],
): void {
  const indent = "  ".repeat(depth);
  for (const [name, child] of [...folder.folders].sort(([a], [b]) =>
    byName.compare(a, b),
  )) {
    lines.push({
      label: `${indent}${name}/`,
      fileCount: child.fileCount,
      size: child.size,
    });
    listFolder(child, depth + 1, lines);
  }
  for (const file of [...folder.files].sort((a, b) =>
    byName.compare(a.name, b.name),
  )) {
    lines.push({
      label: `${indent}${file.name}`,
      fileCount: null,
      size: file.size,
    });
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
  listFolder(root, 0, lines);
  const width =
    Math.min(
      MAX_LABEL_WIDTH,
      Math.max(0, ...lines.map((line) => line.label.length)),
    ) + 2;
  const text = lines
    .slice(0, MAX_LISTED_LINES)
    .map((line) =>
      [
        line.label.padEnd(width),
        (line.fileCount === null
          ? ""
          : plural(line.fileCount, "file")
        ).padStart(11),
        formatFileSize(line.size).padStart(10),
      ]
        .join("")
        .trimEnd(),
    );
  if (lines.length > MAX_LISTED_LINES)
    text.push(`… ${plural(lines.length - MAX_LISTED_LINES, "more line")}`);
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
      };
    }
    case "pptx": {
      const { markdown, slides } = await convertPresentation(bytes);
      return {
        label: "Shown as text · from PowerPoint",
        detail: plural(slides, "slide"),
        textKind: "markdown",
        parts: [{ name: "Slides", text: markdown }],
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
