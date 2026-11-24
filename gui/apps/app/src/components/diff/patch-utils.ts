import {
  parsePatchFiles,
  processFile,
  type FileContents,
  type SelectedLineRange,
  type SelectionSide,
} from "@pierre/diffs";
import type { GitDiffFileChangeKind } from "@cloudroom/server-contract";

export type ParsedGitDiffFile = ReturnType<
  typeof parsePatchFiles
>[number]["files"][number];

export interface GitDiffStats {
  deletions: number;
  filesCount: number;
  insertions: number;
}

const IMAGE_EXTS = new Set([
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "webp",
]);

export function normalizeGitDiffPath(
  path: string | undefined,
): string | undefined {
  const trimmed = path?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function parseGitDiffFiles(diff: string): ParsedGitDiffFile[] {
  if (diff.trim().length === 0) return [];
  try {
    return parsePatchFiles(diff).flatMap((p) => p.files);
  } catch {
    return [];
  }
}

export function normalizeFilePatch(args: {
  patch: string;
  path: string;
}): { file: ParsedGitDiffFile; patch: string } | null {
  const clean = args.patch.replace(/\r\n/g, "\n").trimEnd();
  if (clean.length === 0) return null;
  const p = normalizeGitDiffPath(args.path) ?? args.path;
  const patch = clean.startsWith("diff --git")
    ? `${clean}\n`
    : `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n${clean}\n`;
  const file = parseGitDiffFiles(patch)[0];
  return file && file.hunks.length > 0 ? { patch, file } : null;
}

const stripCr = (line: string | undefined) =>
  line?.endsWith("\r\n") ? `${line.slice(0, -2)}\n` : (line ?? "");

function sliceMatches(
  expected: string[],
  eStart: number,
  actual: string[],
  aStart: number,
  count: number,
): boolean {
  if (
    eStart < 0 ||
    aStart < 0 ||
    count < 0 ||
    eStart + count > expected.length ||
    aStart + count > actual.length
  ) {
    return false;
  }
  for (let i = 0; i < count; i += 1) {
    if (stripCr(expected[eStart + i]) !== stripCr(actual[aStart + i]))
      return false;
  }
  return true;
}

export function enrichGitDiffFileForContext(args: {
  fileDiff: ParsedGitDiffFile;
  newFile: FileContents;
  oldFile: FileContents;
  patchText?: string;
}): ParsedGitDiffFile {
  const { fileDiff, oldFile, newFile, patchText } = args;
  const expNew = normalizeGitDiffPath(fileDiff.name);
  const expOld = normalizeGitDiffPath(fileDiff.prevName) ?? expNew;
  if (
    !patchText ||
    !expNew ||
    !expOld ||
    normalizeGitDiffPath(oldFile.name) !== expOld ||
    normalizeGitDiffPath(newFile.name) !== expNew
  ) {
    return fileDiff;
  }
  const enriched = processFile(patchText, { oldFile, newFile });
  if (!enriched || enriched.isPartial) return fileDiff;
  const ok = fileDiff.hunks.every(
    (h) =>
      sliceMatches(
        fileDiff.deletionLines,
        h.deletionLineIndex,
        enriched.deletionLines,
        h.deletionStart - 1,
        h.deletionCount,
      ) &&
      sliceMatches(
        fileDiff.additionLines,
        h.additionLineIndex,
        enriched.additionLines,
        h.additionStart - 1,
        h.additionCount,
      ),
  );
  return ok ? enriched : fileDiff;
}

export function summarizeGitDiffFile(
  file: ParsedGitDiffFile,
): Pick<GitDiffStats, "deletions" | "insertions"> {
  let insertions = 0;
  let deletions = 0;
  for (const h of file.hunks) {
    insertions += h.additionLines;
    deletions += h.deletionLines;
  }
  return { insertions, deletions };
}

export function getGitDiffFileChangeKind(
  file: ParsedGitDiffFile,
): GitDiffFileChangeKind {
  switch (file.type) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    case "change":
      return "modified";
  }
}

export function formatGitDiffFileLabel(file: ParsedGitDiffFile): string {
  const name = normalizeGitDiffPath(file.name) ?? file.name;
  const prev = normalizeGitDiffPath(file.prevName);
  return prev && prev !== name ? `${prev} -> ${name}` : name;
}

export function isPreviewableImagePath(path: string | undefined): boolean {
  const clean = normalizeGitDiffPath(path);
  const ext = clean?.split(".").pop()?.toLowerCase();
  return ext !== undefined && IMAGE_EXTS.has(ext);
}

export function isSvgGitDiffFile(file: ParsedGitDiffFile): boolean {
  return (normalizeGitDiffPath(file.name) ?? file.name)
    .toLowerCase()
    .endsWith(".svg");
}

export function getOpenableGitDiffPath(file: ParsedGitDiffFile): string | null {
  for (const raw of [file.name, file.prevName]) {
    const clean = normalizeGitDiffPath(raw);
    if (!clean || clean === "/dev/null") continue;
    let p = clean.startsWith("./") ? clean.slice(2) : clean;
    if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
    if (p.length > 0) return p;
  }
  return null;
}

// --- Patch Text Extraction & Line Selection ---

interface PatchLine {
  hunkIndex: number;
  newLine: number | null;
  oldLine: number | null;
  prefix: " " | "+" | "-";
  side: SelectionSide | null;
  splitIdx: number;
  text: string;
  unifiedIdx: number;
}

const chomp = (s: string) => s.replace(/(?:\r\n|\n|\r)$/u, "");
const prefixPath = (p: string, side: "a" | "b") =>
  p === "/dev/null" || p.startsWith(`${side}/`) ? p : `${side}/${p}`;

function flattenPatchLines(fileDiff: ParsedGitDiffFile): PatchLine[] {
  const out: PatchLine[] = [];
  fileDiff.hunks.forEach((hunk, hunkIndex) => {
    let u = hunk.unifiedLineStart;
    let s = hunk.splitLineStart;
    let dIdx = hunk.deletionLineIndex;
    let aIdx = hunk.additionLineIndex;
    for (const block of hunk.hunkContent) {
      if (block.type === "context") {
        for (let i = 0; i < block.lines; i += 1) {
          const text =
            fileDiff.additionLines[aIdx + i] ??
            fileDiff.deletionLines[dIdx + i];
          if (text === undefined) continue;
          out.push({
            hunkIndex,
            oldLine: hunk.deletionStart + (dIdx + i - hunk.deletionLineIndex),
            newLine: hunk.additionStart + (aIdx + i - hunk.additionLineIndex),
            prefix: " ",
            side: null,
            unifiedIdx: u + i,
            splitIdx: s + i,
            text: chomp(text),
          });
        }
        u += block.lines;
        s += block.lines;
        dIdx += block.lines;
        aIdx += block.lines;
      } else {
        for (let i = 0; i < block.deletions; i += 1) {
          const text = fileDiff.deletionLines[dIdx + i];
          if (text === undefined) continue;
          out.push({
            hunkIndex,
            oldLine: hunk.deletionStart + (dIdx + i - hunk.deletionLineIndex),
            newLine: null,
            prefix: "-",
            side: "deletions",
            unifiedIdx: u + i,
            splitIdx: s + i,
            text: chomp(text),
          });
        }
        for (let i = 0; i < block.additions; i += 1) {
          const text = fileDiff.additionLines[aIdx + i];
          if (text === undefined) continue;
          out.push({
            hunkIndex,
            oldLine: null,
            newLine: hunk.additionStart + (aIdx + i - hunk.additionLineIndex),
            prefix: "+",
            side: "additions",
            unifiedIdx: u + block.deletions + i,
            splitIdx: s + i,
            text: chomp(text),
          });
        }
        u += block.deletions + block.additions;
        s += Math.max(block.deletions, block.additions);
        dIdx += block.deletions;
        aIdx += block.additions;
      }
    }
  });
  return out;
}

function renderUnifiedPatch(
  fileDiff: ParsedGitDiffFile,
  lines: PatchLine[],
): string {
  const cur = normalizeGitDiffPath(fileDiff.name) ?? fileDiff.name;
  const prev = normalizeGitDiffPath(fileDiff.prevName) ?? cur;
  const gitOld = prev === "/dev/null" ? cur : prev;
  const gitNew = cur === "/dev/null" ? prev : cur;
  const out = [
    `diff --git ${prefixPath(gitOld, "a")} ${prefixPath(gitNew, "b")}`,
    `--- ${fileDiff.type === "new" ? "/dev/null" : prefixPath(prev, "a")}`,
    `+++ ${fileDiff.type === "deleted" ? "/dev/null" : prefixPath(cur, "b")}`,
  ];
  const groups: PatchLine[][] = [];
  for (const line of lines) {
    const last = groups.at(-1);
    if (last?.at(-1)?.hunkIndex === line.hunkIndex) last.push(line);
    else groups.push([line]);
  }
  const fmtRange = (start: number, count: number) =>
    count === 1 ? String(start) : `${start},${count}`;
  for (const group of groups) {
    const oldNums = group
      .map((l) => l.oldLine)
      .filter((n): n is number => n !== null);
    const newNums = group
      .map((l) => l.newLine)
      .filter((n): n is number => n !== null);
    const oldMin = oldNums.length > 0 ? Math.min(...oldNums) : null;
    const newMin = newNums.length > 0 ? Math.min(...newNums) : null;
    const oldStart = oldMin ?? Math.max(0, (newMin ?? 1) - 1);
    const newStart = newMin ?? Math.max(0, (oldMin ?? 1) - 1);
    out.push(
      `@@ -${fmtRange(oldStart, oldNums.length)} +${fmtRange(newStart, newNums.length)} @@`,
    );
    for (const l of group) out.push(`${l.prefix}${l.text}`);
  }
  return out.join("\n");
}

function selectPatchLines(args: {
  displayStyle: "unified" | "split";
  fileDiff: ParsedGitDiffFile;
  range: SelectedLineRange;
}): PatchLine[] {
  const all = flattenPatchLines(args.fileDiff);
  const idxOf = (line: PatchLine) =>
    args.displayStyle === "split" ? line.splitIdx : line.unifiedIdx;
  const findEndpoint = (num: number, side: SelectionSide | undefined) => {
    for (const candidate of side
      ? [side]
      : (["additions", "deletions"] as const)) {
      const hit = all.find((l) =>
        candidate === "additions" ? l.newLine === num : l.oldLine === num,
      );
      if (hit) return idxOf(hit);
    }
    return null;
  };
  const a = findEndpoint(args.range.start, args.range.side);
  const b = findEndpoint(args.range.end, args.range.endSide ?? args.range.side);
  if (a === null || b === null) return [];
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const startSide = args.range.side ?? args.range.endSide ?? "additions";
  const endSide = args.range.endSide ?? startSide;
  return all.filter((l) => {
    const idx = idxOf(l);
    if (idx < lo || idx > hi) return false;
    return (
      args.displayStyle === "unified" ||
      startSide !== endSide ||
      l.side === null ||
      l.side === startSide
    );
  });
}

export function buildFileDiffPatchText(fileDiff: ParsedGitDiffFile): string {
  return renderUnifiedPatch(fileDiff, flattenPatchLines(fileDiff));
}

export function buildDiffLineSelectionText(args: {
  displayStyle: "unified" | "split";
  fileDiff: ParsedGitDiffFile;
  range: SelectedLineRange;
}): string | null {
  const lines = selectPatchLines(args);
  return lines.length > 0 ? renderUnifiedPatch(args.fileDiff, lines) : null;
}

export function buildDiffLineCopyText(args: {
  displayStyle: "unified" | "split";
  fileDiff: ParsedGitDiffFile;
  range: SelectedLineRange;
}): string | null {
  const lines = selectPatchLines(args);
  return lines.length > 0 ? lines.map((l) => l.text).join("\n") : null;
}

export function getDiffShadowRoots(el: HTMLElement | null): ShadowRoot[] {
  if (!el) return [];
  return Array.from(el.querySelectorAll("diffs-container"))
    .map((c) => c.shadowRoot)
    .filter((r): r is ShadowRoot => r !== null);
}

export function buildDiffDomSelectionText(args: {
  containerElement: HTMLElement | null;
  fileDiff: ParsedGitDiffFile;
}): string | null {
  if (!args.containerElement) return null;
  const byKey = new Map<string, PatchLine>();
  for (const root of getDiffShadowRoots(args.containerElement)) {
    for (const row of root.querySelectorAll<HTMLElement>(
      "[data-selected-line][data-line]",
    )) {
      const [uStr, sStr] = (row.dataset.lineIndex ?? "").split(",");
      const unifiedIdx = Number.parseInt(uStr ?? "", 10);
      const splitIdx = Number.parseInt(sStr ?? "", 10);
      if (!Number.isFinite(unifiedIdx) || !Number.isFinite(splitIdx)) continue;
      const lineNum = Number.parseInt(row.dataset.line ?? "", 10);
      const num = Number.isFinite(lineNum) ? lineNum : null;
      const prefix: " " | "+" | "-" =
        row.dataset.lineType === "change-deletion"
          ? "-"
          : row.dataset.lineType === "change-addition"
            ? "+"
            : " ";
      const codeEl = row.closest("[data-deletions],[data-additions]");
      const side: SelectionSide = codeEl?.hasAttribute("data-deletions")
        ? "deletions"
        : codeEl?.hasAttribute("data-additions")
          ? "additions"
          : row.dataset.lineType === "change-deletion"
            ? "deletions"
            : "additions";
      const text = (row.textContent ?? "").trimEnd();
      const line: PatchLine = {
        hunkIndex: 0,
        unifiedIdx,
        splitIdx,
        prefix,
        side: prefix === " " ? null : side,
        text,
        newLine:
          num !== null &&
          (prefix === "+" || (prefix === " " && side === "additions"))
            ? num
            : null,
        oldLine:
          num !== null &&
          (prefix === "-" || (prefix === " " && side === "deletions"))
            ? num
            : null,
      };
      const key = `${unifiedIdx}:${splitIdx}:${prefix}:${text}`;
      const existing = byKey.get(key);
      byKey.set(
        key,
        existing && prefix === " "
          ? {
              ...existing,
              newLine: existing.newLine ?? line.newLine,
              oldLine: existing.oldLine ?? line.oldLine,
            }
          : (existing ?? line),
      );
    }
  }
  const sorted = Array.from(byKey.values()).sort(
    (a, b) => a.unifiedIdx - b.unifiedIdx || a.prefix.localeCompare(b.prefix),
  );
  return sorted.length > 0 ? renderUnifiedPatch(args.fileDiff, sorted) : null;
}
