import { useEffect, useRef } from "react";
import type { ThreadRuntimeDisplayStatus } from "@cloudroom/domain";
import type { TimelineRow } from "@cloudroom/server-contract";
import { isRunningThreadRuntimeDisplayStatus } from "@cloudroom/client-core";
import { IMAGE_FILE_EXTENSIONS } from "@/components/right-panel/tabs/image-lightbox";
import {
  parseLocalFileHref,
  resolveRelativeLocalFileHref,
  type MarkdownPreviewLocalFileLink,
} from "@/components/ui/markdown-local-file-link";
import { normalizeAbsoluteFilePath } from "@/lib/absolute-file-path";
import { withLocalStorage } from "@/lib/browser-storage";

const MAX_AUTO_OPENED_IMAGES = 5;
const AUTO_OPENED_IMAGES_STORAGE_PREFIX = "bb.thread.autoOpenedImages";
const MARKDOWN_CODE_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;
// Allow one level of nested `[...]` inside link/image labels (e.g. `![chart [v2]](...)`).
const MARKDOWN_IMAGE_PATTERN =
  /!\[(?:\[[^\]]*\]|[^\]])*\]\(\s*(?:<([^>]+)>|([^)\s]+))/g;
// Plain links (not `![...]` embeds): embeds already show inline in the chat.
const MARKDOWN_LINK_PATTERN =
  /(?<!!)\[(?:\[[^\]]*\]|[^\]])*\]\(\s*(?:<([^>]+)>|([^)\s]+))/g;
const URI_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/u;
const TRUSTED_HOST = { kind: "trusted-host" } as const;

interface LinkedImage {
  key: string;
  link: MarkdownPreviewLocalFileLink;
}

interface FindLinkedImagesArgs {
  afterSeq: number;
  rows: readonly TimelineRow[];
  workspaceRootPath: string | null;
}

export interface UseAutoOpenGeneratedImagesArgs {
  enabled: boolean;
  isThreadStatusFresh: boolean;
  openImage: (link: MarkdownPreviewLocalFileLink) => boolean;
  rows: readonly TimelineRow[] | null;
  threadId: string;
  threadStatus: ThreadRuntimeDisplayStatus | null;
  workspaceRootPath: string | null;
}

interface AutoOpenState {
  afterSeq: number;
  historyLinkedPaths: Set<string>;
  pendingCompletion: boolean;
  sawLiveTurn: boolean;
  threadId: string;
  workspaceRootPath: string | null;
}

function storageKey(threadId: string): string {
  return `${AUTO_OPENED_IMAGES_STORAGE_PREFIX}-${encodeURIComponent(threadId)}`;
}

function readOpenedPaths(threadId: string): Set<string> {
  return withLocalStorage((storage) => {
    const raw = storage.getItem(storageKey(threadId));
    if (raw === null) return new Set<string>();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(
      parsed.filter((item): item is string => typeof item === "string"),
    );
  }, new Set<string>());
}

function persistOpenedPaths(
  threadId: string,
  paths: readonly string[],
): void {
  if (paths.length === 0) return;
  const merged = readOpenedPaths(threadId);
  for (const path of paths) merged.add(path);
  withLocalStorage((storage) => {
    storage.setItem(storageKey(threadId), JSON.stringify([...merged]));
  }, undefined);
}

function isImagePath(path: string): boolean {
  const clean = path.split(/[?#]/u, 1)[0] ?? path;
  const extension = clean.split(".").pop()?.toLowerCase();
  return extension !== undefined && IMAGE_FILE_EXTENSIONS.has(extension);
}

function normalizeLink(
  link: MarkdownPreviewLocalFileLink | null,
): MarkdownPreviewLocalFileLink | null {
  if (link === null) return null;
  const normalizedPath = normalizeAbsoluteFilePath({ path: link.path });
  return normalizedPath === null ? link : { ...link, path: normalizedPath };
}

function toLocalFileLink(
  href: string,
  workspaceRootPath: string | null,
): MarkdownPreviewLocalFileLink | null {
  const absolute = parseLocalFileHref({ absoluteLinks: TRUSTED_HOST, href });
  if (absolute !== null) return normalizeLink(absolute);
  if (workspaceRootPath === null) return null;
  const resolved = resolveRelativeLocalFileHref({
    baseDir: workspaceRootPath,
    href,
    rootPath: workspaceRootPath,
  });
  return resolved === null
    ? null
    : normalizeLink(
        parseLocalFileHref({ absoluteLinks: TRUSTED_HOST, href: resolved }),
      );
}

function isRelativeImageHref(href: string): boolean {
  if (
    href.length === 0 ||
    href.startsWith("/") ||
    href.startsWith("#") ||
    href.startsWith("?") ||
    href.startsWith("~") ||
    URI_SCHEME_PATTERN.test(href)
  ) {
    return false;
  }
  return isImagePath(href);
}

function visitRows(
  rows: readonly TimelineRow[],
  callback: (row: TimelineRow) => void,
): void {
  const visit = (row: TimelineRow): void => {
    callback(row);
    if (row.kind === "turn") {
      row.children?.forEach(visit);
    }
  };
  rows.forEach(visit);
}

function maxRowSeq(rows: readonly TimelineRow[]): number {
  let max = -1;
  visitRows(rows, (row) => {
    if (row.sourceSeqEnd > max) max = row.sourceSeqEnd;
  });
  return max;
}

function maxUserTurnRowSeq(rows: readonly TimelineRow[]): number {
  let max = -1;
  visitRows(rows, (row) => {
    if (
      row.kind === "conversation" &&
      row.role === "user" &&
      row.turnRequest.kind !== "steer" &&
      row.sourceSeqEnd > max
    ) {
      max = row.sourceSeqEnd;
    }
  });
  return max;
}

function hasCompletedTurnRowsAfter(
  rows: readonly TimelineRow[],
  afterSeq: number,
): boolean {
  let found = false;
  visitRows(rows, (row) => {
    if (found || row.sourceSeqEnd <= afterSeq) return;
    if (
      (row.kind === "conversation" && row.role === "assistant") ||
      row.kind === "turn"
    ) {
      found = true;
    }
  });
  return found;
}

function hasUnresolvedRelativeImageRefs(
  rows: readonly TimelineRow[],
  afterSeq: number,
): boolean {
  let found = false;
  visitRows(rows, (row) => {
    if (found || row.kind !== "conversation") return;
    const prose = row.text.replace(MARKDOWN_CODE_PATTERN, "");
    for (const match of prose.matchAll(MARKDOWN_IMAGE_PATTERN)) {
      if (isRelativeImageHref(match[1] ?? match[2] ?? "")) {
        found = true;
        return;
      }
    }
    if (row.role !== "assistant" || row.sourceSeqEnd <= afterSeq) return;
    for (const match of prose.matchAll(MARKDOWN_LINK_PATTERN)) {
      if (isRelativeImageHref(match[1] ?? match[2] ?? "")) {
        found = true;
        return;
      }
    }
  });
  return found;
}

function extractImageLinks(
  prose: string,
  pattern: RegExp,
  workspaceRootPath: string | null,
): MarkdownPreviewLocalFileLink[] {
  const links: MarkdownPreviewLocalFileLink[] = [];
  for (const match of prose.matchAll(pattern)) {
    const link = toLocalFileLink(
      match[1] ?? match[2] ?? "",
      workspaceRootPath,
    );
    if (link !== null && isImagePath(link.path)) {
      links.push(link);
    }
  }
  return links;
}

function recordLinkedImagesUpToSeq(
  target: Set<string>,
  rows: readonly TimelineRow[],
  maxSeq: number,
  workspaceRootPath: string | null,
): void {
  if (maxSeq < 0) return;
  visitRows(rows, (row) => {
    if (
      row.kind !== "conversation" ||
      row.role !== "assistant" ||
      row.sourceSeqEnd > maxSeq
    ) {
      return;
    }
    const prose = row.text.replace(MARKDOWN_CODE_PATTERN, "");
    for (const link of extractImageLinks(
      prose,
      MARKDOWN_LINK_PATTERN,
      workspaceRootPath,
    )) {
      target.add(link.path);
    }
  });
}

export function findLinkedImages({
  afterSeq,
  rows,
  workspaceRootPath,
}: FindLinkedImagesArgs): LinkedImage[] {
  const embeddedPaths = new Set<string>();
  const images: LinkedImage[] = [];
  const seenPaths = new Set<string>();

  visitRows(rows, (row) => {
    if (row.kind !== "conversation") return;
    const prose = row.text.replace(MARKDOWN_CODE_PATTERN, "");
    for (const link of extractImageLinks(
      prose,
      MARKDOWN_IMAGE_PATTERN,
      workspaceRootPath,
    )) {
      embeddedPaths.add(link.path);
    }
    for (const localImagePath of row.attachments?.localImagePaths ?? []) {
      const link = toLocalFileLink(localImagePath, workspaceRootPath);
      if (link !== null && isImagePath(link.path)) {
        embeddedPaths.add(link.path);
      }
    }
  });

  visitRows(rows, (row) => {
    if (
      row.kind !== "conversation" ||
      row.role !== "assistant" ||
      row.sourceSeqEnd <= afterSeq
    ) {
      return;
    }
    const prose = row.text.replace(MARKDOWN_CODE_PATTERN, "");
    for (const link of extractImageLinks(
      prose,
      MARKDOWN_LINK_PATTERN,
      workspaceRootPath,
    )) {
      if (embeddedPaths.has(link.path) || seenPaths.has(link.path)) continue;
      seenPaths.add(link.path);
      images.push({ key: link.path, link });
    }
  });

  return images;
}

export function useAutoOpenGeneratedImages({
  enabled,
  isThreadStatusFresh,
  openImage,
  rows,
  threadId,
  threadStatus,
  workspaceRootPath,
}: UseAutoOpenGeneratedImagesArgs): void {
  const stateRef = useRef<AutoOpenState | null>(null);

  useEffect(() => {
    if (rows === null) return;
    const currentMaxSeq = maxRowSeq(rows);
    const latestUserTurnSeq = maxUserTurnRowSeq(rows);
    const isTurnRunning =
      threadStatus !== null &&
      isRunningThreadRuntimeDisplayStatus(threadStatus);
    const state = stateRef.current;

    if (state === null || state.threadId !== threadId) {
      const canArm = isTurnRunning && isThreadStatusFresh;
      const baselineSeq =
        canArm && latestUserTurnSeq >= 0 ? latestUserTurnSeq : currentMaxSeq;
      const historyLinkedPaths = new Set<string>();
      recordLinkedImagesUpToSeq(
        historyLinkedPaths,
        rows,
        baselineSeq,
        workspaceRootPath,
      );
      stateRef.current = {
        afterSeq: baselineSeq,
        historyLinkedPaths,
        pendingCompletion: false,
        sawLiveTurn: canArm,
        threadId,
        workspaceRootPath,
      };
      return;
    }

    if (isTurnRunning) {
      if (!isThreadStatusFresh) {
        if (currentMaxSeq > state.afterSeq) {
          state.afterSeq = currentMaxSeq;
          recordLinkedImagesUpToSeq(
            state.historyLinkedPaths,
            rows,
            state.afterSeq,
            workspaceRootPath,
          );
        }
        state.workspaceRootPath = workspaceRootPath;
        return;
      }

      if (!state.sawLiveTurn) {
        state.sawLiveTurn = true;
        state.pendingCompletion = false;
        if (latestUserTurnSeq >= 0) {
          state.afterSeq = latestUserTurnSeq;
        }
      } else if (latestUserTurnSeq > state.afterSeq) {
        state.afterSeq = latestUserTurnSeq;
      }
      state.workspaceRootPath = workspaceRootPath;
      return;
    }

    if (threadStatus !== "idle") {
      // Non-completion statuses (`waiting-for-host`, `error`, `pending`, or loading)
      // must never trigger auto-open.
      state.sawLiveTurn = false;
      state.pendingCompletion = false;
      if (
        currentMaxSeq > state.afterSeq ||
        workspaceRootPath !== state.workspaceRootPath
      ) {
        state.afterSeq = Math.max(state.afterSeq, currentMaxSeq);
        state.workspaceRootPath = workspaceRootPath;
        recordLinkedImagesUpToSeq(
          state.historyLinkedPaths,
          rows,
          state.afterSeq,
          workspaceRootPath,
        );
      }
      return;
    }

    if (state.sawLiveTurn) {
      state.sawLiveTurn = false;
      state.pendingCompletion = true;
    }

    if (!state.pendingCompletion) {
      if (
        currentMaxSeq > state.afterSeq ||
        workspaceRootPath !== state.workspaceRootPath
      ) {
        state.afterSeq = Math.max(state.afterSeq, currentMaxSeq);
        state.workspaceRootPath = workspaceRootPath;
        recordLinkedImagesUpToSeq(
          state.historyLinkedPaths,
          rows,
          state.afterSeq,
          workspaceRootPath,
        );
      }
      return;
    }

    // Wait for the finished turn's timeline rows (and Cloud workspace root if relative
    // image links exist) before consuming the completion once.
    if (!hasCompletedTurnRowsAfter(rows, state.afterSeq)) return;
    if (
      workspaceRootPath === null &&
      hasUnresolvedRelativeImageRefs(rows, state.afterSeq)
    ) {
      return;
    }

    const persistedOpenedPaths = readOpenedPaths(threadId);
    const fresh = findLinkedImages({
      afterSeq: state.afterSeq,
      rows,
      workspaceRootPath,
    }).filter(
      (image) =>
        !persistedOpenedPaths.has(image.key) &&
        !state.historyLinkedPaths.has(image.key),
    );

    state.pendingCompletion = false;
    state.afterSeq = Math.max(state.afterSeq, currentMaxSeq);
    state.workspaceRootPath = workspaceRootPath;
    if (!enabled || fresh.length === 0) return;

    const candidates = fresh.slice(0, MAX_AUTO_OPENED_IMAGES);
    const opened: LinkedImage[] = [];
    for (const image of candidates) {
      if (openImage(image.link)) {
        opened.push(image);
      }
    }
    const [first] = opened;
    if (opened.length > 1 && first !== undefined) {
      openImage(first.link);
    }
    if (opened.length > 0) {
      persistOpenedPaths(
        threadId,
        opened.map((image) => image.key),
      );
    }
  }, [
    enabled,
    isThreadStatusFresh,
    openImage,
    rows,
    threadId,
    threadStatus,
    workspaceRootPath,
  ]);
}
