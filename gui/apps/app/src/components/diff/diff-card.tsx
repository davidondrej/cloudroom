import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefCallback,
} from "react";
import type {
  GitDiffFileChangeKind,
  DiffFileEntry,
} from "@cloudroom/server-contract";
import type { ExperimentalDiffFullFileContents } from "@get-bb/plugin-sdk";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { usePointerCoarse } from "@cloudroom/shared-ui/hooks/use-pointer-coarse";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { DiffLoadingSkeleton } from "@/components/code/code-loading-skeletons";
import { DiffHost } from "@/components/code/DiffHost";
import type { DiffPresentation } from "@/components/code/code-rendering";
import { CopyButton } from "@/components/ui/copy-button.js";
import { DiffStatsTally } from "@/components/ui/diff-stats-tally.js";
import { FilePathLink } from "@/components/ui/file-path-link.js";
import {
  IMAGE_TRANSPARENCY_CHECKER_STYLE,
  ImageLightbox,
  getWrappedImageIndex,
} from "@/components/ui/image-lightbox.js";
import { OpenInEditorButton } from "@/components/ui/open-in-editor-button.js";
import { TruncateStart } from "@/components/ui/truncate-start.js";
import { useIntersectionObserver } from "@/hooks/useElementObservers";
import type { DiffPatchState } from "@/hooks/queries/use-environment-diff-patches";
import { resolveAbsoluteFilePath } from "@/lib/absolute-file-path";
import type {
  DiffFileContentsResult,
  RequestDiffFileContents,
} from "./diff-store";
import {
  formatGitDiffFileLabel,
  getGitDiffFileChangeKind,
  getOpenableGitDiffPath,
  isPreviewableImagePath,
  isSvgGitDiffFile,
  normalizeGitDiffPath,
  parseGitDiffFiles,
  summarizeGitDiffFile,
  type ParsedGitDiffFile,
} from "./patch-utils";

// --- Shared Header & Stat Primitives ---

export interface GitDiffCardHeaderModel {
  changeKind: GitDiffFileChangeKind;
  deletions: number;
  insertions: number;
  label: string;
  openablePath: string | null;
  path: string;
}

export interface DiffImageSizeStat {
  addedBytes: number | null;
  removedBytes: number | null;
}

export interface GitDiffCardImagePreview {
  newImageUrl: string | null;
  oldImageUrl: string | null;
}

export type GitDiffCardSvgDisplayMode = "preview" | "raw";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export function getGitDiffCardImageSizeStat(
  preview: { newSizeBytes: number | null; oldSizeBytes: number | null },
  changeKind: GitDiffFileChangeKind,
): DiffImageSizeStat | null {
  const addedBytes = changeKind === "deleted" ? null : preview.newSizeBytes;
  const removedBytes = changeKind === "added" ? null : preview.oldSizeBytes;
  return addedBytes === null && removedBytes === null
    ? null
    : { addedBytes, removedBytes };
}

export function GitDiffCardImageSizeStat({
  stat,
}: {
  stat: DiffImageSizeStat;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs tabular-nums">
      {stat.addedBytes !== null ? (
        <span className="text-diff-added">{`+${formatBytes(stat.addedBytes)}`}</span>
      ) : null}
      {stat.removedBytes !== null ? (
        <span className="text-diff-removed">{`-${formatBytes(stat.removedBytes)}`}</span>
      ) : null}
    </span>
  );
}

export function GitDiffCardRawToggle({
  fileLabel,
  isRaw,
  onToggle,
}: {
  fileLabel: string;
  isRaw: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-pressed:bg-state-active aria-pressed:text-foreground"
      onClick={onToggle}
      aria-label={
        isRaw
          ? `Show image preview for ${fileLabel}`
          : `Show raw SVG diff for ${fileLabel}`
      }
      aria-pressed={isRaw}
    >
      <Icon name="Code" aria-hidden className="size-3.5" />
    </button>
  );
}

export function gitDiffCardHeaderWrapperClass(args: {
  isBodyHidden: boolean;
  isStuck: boolean;
  showStuckHeaderEdge?: boolean;
  stickyHeader: boolean;
}): string {
  return cn(
    "rounded-lg bg-background py-1.5 pl-2 pr-3 text-xs font-medium text-foreground",
    args.stickyHeader && "sticky top-0 z-30",
    !args.isBodyHidden && "rounded-b-none",
    args.isStuck && "rounded-t-none",
    args.isStuck &&
      (args.showStuckHeaderEdge ?? true) &&
      "shadow-[inset_0_1px_0_var(--border)]",
  );
}

export function GitDiffCardHeader({
  model,
  previousPath,
  filePathRoot,
  onOpenFileInEditor,
  onOpenFilePreview,
  isCollapsed,
  onToggleCollapsed,
  hasChanges,
  statSlot,
  actionSlot,
}: {
  actionSlot?: ReactNode;
  filePathRoot?: string | null;
  hasChanges: boolean;
  isCollapsed?: boolean;
  model: GitDiffCardHeaderModel;
  onOpenFileInEditor?: (path: string) => void;
  onOpenFilePreview?: (path: string) => void;
  onToggleCollapsed?: () => void;
  previousPath: string | null;
  statSlot?: ReactNode;
}) {
  const isAdded = model.changeKind === "added";
  const isDeleted = model.changeKind === "deleted";
  const rename =
    (model.changeKind === "renamed" || model.changeKind === "copied") &&
    previousPath &&
    previousPath !== model.path
      ? { from: previousPath, to: model.path }
      : null;
  const openable = model.openablePath;
  const copyPath = openable
    ? resolveAbsoluteFilePath({ path: openable, rootPath: filePathRoot })
    : null;
  const canCollapse =
    isCollapsed !== undefined && onToggleCollapsed !== undefined;

  return (
    <div className="flex w-full min-w-0 items-center justify-between gap-2">
      <span className="flex min-w-0 items-center">
        {canCollapse ? (
          <button
            type="button"
            className={cn(
              "inline-flex w-8 shrink-0 items-center justify-center text-muted-foreground transition-colors",
              hasChanges
                ? "hover:text-foreground"
                : "cursor-not-allowed opacity-40",
            )}
            onClick={hasChanges ? onToggleCollapsed : undefined}
            disabled={!hasChanges}
            aria-label={
              hasChanges
                ? `${isCollapsed ? "Expand" : "Collapse"} ${model.label}`
                : `${model.label} has no changes to expand`
            }
            aria-expanded={hasChanges ? !isCollapsed : undefined}
          >
            <Icon
              name="ChevronRight"
              className={cn(
                "size-3.5 shrink-0 transition-transform duration-150",
                hasChanges && !isCollapsed && "rotate-90",
              )}
            />
          </button>
        ) : null}
        <span className="flex min-w-0 items-center gap-1.5 pl-[1ch]">
          {rename ? (
            <>
              <TruncateStart
                className="min-w-0 font-mono text-xs leading-5 text-muted-foreground"
                title={rename.from}
              >
                {rename.from}
              </TruncateStart>
              <Icon
                name="ArrowRight"
                aria-hidden="true"
                className="size-3 shrink-0 text-subtle-foreground"
              />
            </>
          ) : null}
          <FilePathLink
            path={openable ?? model.path}
            displayName={rename ? rename.to : model.label}
            onClick={
              openable && onOpenFilePreview
                ? () => onOpenFilePreview(openable)
                : undefined
            }
            className="font-mono font-medium text-foreground"
          />
          {copyPath ? (
            <CopyButton
              text={copyPath}
              label={`Copy path for ${model.label}`}
              className="rounded-md hover:bg-state-hover"
            />
          ) : null}
          {openable && onOpenFileInEditor ? (
            <OpenInEditorButton
              onClick={() => onOpenFileInEditor(openable)}
              label={`Open ${model.label} in editor`}
            />
          ) : null}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {actionSlot}
        {statSlot ?? (
          <DiffStatsTally
            insertions={isDeleted ? 0 : model.insertions}
            deletions={isAdded ? 0 : model.deletions}
            hideZero={isAdded || isDeleted}
            className="text-xs"
          />
        )}
      </span>
    </div>
  );
}

// --- Image Diff Preview Body ---

export function GitDiffCardImagePreviewBody({
  preview,
  fileDiffLabel,
  fitToFrame = false,
}: {
  fileDiffLabel: string;
  fitToFrame?: boolean;
  preview: GitDiffCardImagePreview;
}) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const both = preview.oldImageUrl !== null && preview.newImageUrl !== null;
  const sides = [
    ...(preview.oldImageUrl
      ? [{ url: preview.oldImageUrl, caption: both ? "Old" : null }]
      : []),
    ...(preview.newImageUrl
      ? [{ url: preview.newImageUrl, caption: both ? "New" : null }]
      : []),
  ];
  if (sides.length === 0) {
    return (
      <div className="px-3 py-3 text-xs text-muted-foreground">
        No preview available for this image.
      </div>
    );
  }
  const altFor = (s: { caption: string | null }) =>
    s.caption ? `${fileDiffLabel} (${s.caption.toLowerCase()})` : fileDiffLabel;
  const active = expandedIdx === null ? undefined : sides[expandedIdx];

  return (
    <>
      <div
        className={
          fitToFrame
            ? sides.length > 1
              ? "grid grid-cols-1 gap-3 px-3 py-3 sm:grid-cols-2"
              : "grid grid-cols-1 gap-3 px-3 py-3"
            : "flex items-start gap-3 px-3 py-3"
        }
      >
        {sides.map((side, i) => (
          <figure key={side.url} className="min-w-0">
            <button
              type="button"
              className={
                fitToFrame
                  ? "flex h-64 w-full cursor-zoom-in items-center justify-center rounded-md border border-border bg-surface-recessed p-3"
                  : "block max-w-full cursor-zoom-in"
              }
              onClick={() => setExpandedIdx(i)}
            >
              <img
                src={side.url}
                alt={altFor(side)}
                style={IMAGE_TRANSPARENCY_CHECKER_STYLE}
                className={
                  fitToFrame
                    ? "block h-full w-full object-contain"
                    : "block max-h-80 max-w-full rounded-md border border-border object-contain"
                }
              />
            </button>
            {side.caption ? (
              <figcaption className="mt-1 text-xs text-muted-foreground">
                {side.caption}
              </figcaption>
            ) : null}
          </figure>
        ))}
      </div>
      <ImageLightbox
        title={`${fileDiffLabel} image preview`}
        imageSrc={active?.url ?? null}
        imageAlt={active ? altFor(active) : fileDiffLabel}
        hasMultipleImages={sides.length > 1}
        onPrevious={() =>
          setExpandedIdx((i) =>
            i === null
              ? null
              : getWrappedImageIndex({
                  currentIndex: i,
                  direction: "previous",
                  itemCount: sides.length,
                }),
          )
        }
        onNext={() =>
          setExpandedIdx((i) =>
            i === null
              ? null
              : getWrappedImageIndex({
                  currentIndex: i,
                  direction: "next",
                  itemCount: sides.length,
                }),
          )
        }
        onClose={() => setExpandedIdx(null)}
      />
    </>
  );
}

// --- Enrichment Hook & Diff Card Body ---

type EnrichmentState =
  | { status: "idle" | "loading" | "unavailable" | "error" }
  | { fullFileContents: ExperimentalDiffFullFileContents; status: "ready" }
  | {
      newImageUrl: string | null;
      newSizeBytes: number | null;
      oldImageUrl: string | null;
      oldSizeBytes: number | null;
      status: "ready-image";
    }
  | {
      fullFileContents: ExperimentalDiffFullFileContents;
      newImageUrl: string | null;
      oldImageUrl: string | null;
      status: "ready-svg";
    };

type ContextStatus = "unavailable" | "idle" | "loading" | "ready" | "error";

interface ContentSide {
  kind: "empty" | "request";
  path: string;
  side?: "old" | "new";
}

const BODY_STYLE: CSSProperties = {
  contain: "layout paint style",
  contentVisibility: "auto",
  containIntrinsicSize: "0 600px",
};

const NOTICE_CLASS =
  "flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-3 text-xs text-muted-foreground";

function svgDataUrl(text: string): string | null {
  const t = text.trim();
  return t.length > 0
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(t)}`
    : null;
}

function scheduleIdle(fn: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(fn, { timeout: 2_000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(fn, 200);
  return () => window.clearTimeout(id);
}

function resolveSide(
  side: ContentSide,
  fetcher: RequestDiffFileContents,
): Promise<DiffFileContentsResult | null> {
  return side.kind === "empty"
    ? Promise.resolve({ kind: "text", file: { name: side.path, contents: "" } })
    : fetcher(side.path, side.side!);
}

export interface GitDiffCardBodyState {
  bodySentinelRef: RefCallback<HTMLDivElement>;
  contextExpansion: { request: () => void; status: ContextStatus };
  enrichment: EnrichmentState;
  fileDiff: ParsedGitDiffFile;
  fileDiffLabel: string;
  fullFileContents: ExperimentalDiffFullFileContents | null;
  imageSizeStat: DiffImageSizeStat | null;
  isImageCard: boolean;
  isSvgPreviewCard: boolean;
  loadDeletedDiff: () => void;
  patchText: string | undefined;
  shouldGateDeletedDiff: boolean;
  shouldRenderDiffView: boolean;
}

export function useGitDiffCardBody(args: {
  changeKind: GitDiffFileChangeKind;
  fileDiff: ParsedGitDiffFile;
  onRequestFileContents: RequestDiffFileContents | undefined;
  patchText?: string;
}): GitDiffCardBodyState {
  const { fileDiff, changeKind, onRequestFileContents, patchText } = args;
  const isImageCard =
    fileDiff.hunks.length === 0 &&
    fileDiff.type !== "rename-pure" &&
    onRequestFileContents !== undefined &&
    isPreviewableImagePath(fileDiff.name);
  const isSvgCard =
    fileDiff.type !== "rename-pure" &&
    onRequestFileContents !== undefined &&
    isSvgGitDiffFile(fileDiff);
  const fileDiffLabel = useMemo(
    () => formatGitDiffFileLabel(fileDiff),
    [fileDiff],
  );

  const plan = useMemo(() => {
    const cur = normalizeGitDiffPath(fileDiff.name) ?? fileDiff.name;
    const prev = normalizeGitDiffPath(fileDiff.prevName) ?? cur;
    const oldSide: ContentSide =
      changeKind === "added"
        ? { kind: "empty", path: cur }
        : {
            kind: "request",
            path: changeKind === "renamed" ? prev : cur,
            side: "old",
          };
    const newSide: ContentSide =
      changeKind === "deleted"
        ? { kind: "empty", path: cur }
        : { kind: "request", path: cur, side: "new" };
    const hunks = fileDiff.hunks
      .map(
        (h) =>
          `${h.hunkSpecs ?? ""}:${h.additionStart}:${h.additionCount}:${h.deletionStart}:${h.deletionCount}`,
      )
      .join("|");
    return {
      identity: `${changeKind}:${oldSide.kind}:${oldSide.path}:${newSide.kind}:${newSide.path}:${hunks}:${patchText ?? ""}:${fileDiff.deletionLines.join("")}:${fileDiff.additionLines.join("")}`,
      old: oldSide,
      new: newSide,
    };
  }, [changeKind, fileDiff, patchText]);

  const { ref: bodySentinelRef, isIntersecting } = useIntersectionObserver({
    initialIsIntersecting: false,
    rootMargin: "200px",
  });
  const fetcherRef = useRef(onRequestFileContents);
  useLayoutEffect(() => {
    fetcherRef.current = onRequestFileContents;
  });

  const [enrichment, setEnrichment] = useState<EnrichmentState>({
    status: "idle",
  });
  const statusRef = useRef<EnrichmentState["status"]>("idle");
  const [entered, setEntered] = useState(false);
  const [loadedDeleted, setLoadedDeleted] = useState(false);
  const [contextReqVer, setContextReqVer] = useState(0);
  const isCoarse = usePointerCoarse();

  useEffect(() => {
    statusRef.current = "idle";
    setEnrichment({ status: "idle" });
    setLoadedDeleted(false);
    setContextReqVer(0);
  }, [plan.identity, isImageCard, isSvgCard]);

  useEffect(() => {
    if (isIntersecting) setEntered(true);
  }, [isIntersecting]);

  const shouldGateDeletedDiff =
    changeKind === "deleted" && !isImageCard && !isSvgCard && !loadedDeleted;
  const shouldRenderDiffView = entered && !shouldGateDeletedDiff;
  const needsContents = isImageCard || isSvgCard;
  const canExpand =
    !needsContents &&
    onRequestFileContents !== undefined &&
    patchText !== undefined &&
    fileDiff.hunks.length > 0 &&
    (changeKind === "modified" ||
      changeKind === "renamed" ||
      changeKind === "copied");

  useEffect(() => {
    if (isCoarse || !shouldRenderDiffView || !canExpand || contextReqVer > 0)
      return;
    return scheduleIdle(() => setContextReqVer((v) => (v === 0 ? 1 : v)));
  }, [canExpand, contextReqVer, isCoarse, shouldRenderDiffView]);

  const shouldFetch =
    shouldRenderDiffView && (needsContents || (canExpand && contextReqVer > 0));
  useEffect(() => {
    if (!shouldFetch || statusRef.current !== "idle") return;
    const fetcher = fetcherRef.current;
    if (!fetcher) return;
    let cancelled = false;
    statusRef.current = "loading";
    setEnrichment({ status: "loading" });

    void Promise.all([
      resolveSide(plan.old, fetcher),
      resolveSide(plan.new, fetcher),
    ])
      .then(([oldRes, newRes]) => {
        if (cancelled) return;
        const oldImg = oldRes?.kind === "image" ? oldRes : null;
        const newImg = newRes?.kind === "image" ? newRes : null;
        if (oldImg || newImg) {
          statusRef.current = "ready-image";
          setEnrichment({
            status: "ready-image",
            oldImageUrl: oldImg?.dataUrl ?? null,
            newImageUrl: newImg?.dataUrl ?? null,
            oldSizeBytes: oldImg?.sizeBytes ?? null,
            newSizeBytes: newImg?.sizeBytes ?? null,
          });
          return;
        }
        if (oldRes?.kind !== "text" || newRes?.kind !== "text") {
          statusRef.current = "unavailable";
          setEnrichment({ status: "unavailable" });
          return;
        }
        const fullFileContents: ExperimentalDiffFullFileContents = {
          old: { path: oldRes.file.name, content: oldRes.file.contents },
          new: { path: newRes.file.name, content: newRes.file.contents },
        };
        if (isSvgCard) {
          statusRef.current = "ready-svg";
          setEnrichment({
            status: "ready-svg",
            fullFileContents,
            oldImageUrl: svgDataUrl(oldRes.file.contents),
            newImageUrl: svgDataUrl(newRes.file.contents),
          });
          return;
        }
        statusRef.current = "ready";
        setEnrichment({ status: "ready", fullFileContents });
      })
      .catch(() => {
        if (!cancelled) {
          statusRef.current = "error";
          setEnrichment({ status: "error" });
        }
      });

    return () => {
      cancelled = true;
      if (statusRef.current === "loading") statusRef.current = "idle";
    };
  }, [contextReqVer, isSvgCard, plan, shouldFetch]);

  const requestContext = useCallback(() => {
    if (statusRef.current === "error") {
      statusRef.current = "idle";
      setEnrichment({ status: "idle" });
    }
    setContextReqVer((v) => v + 1);
  }, []);

  const ctxStatus: ContextStatus = !canExpand
    ? "unavailable"
    : enrichment.status === "idle"
      ? contextReqVer > 0
        ? "loading"
        : "idle"
      : enrichment.status === "loading" ||
          enrichment.status === "ready" ||
          enrichment.status === "error"
        ? enrichment.status
        : "unavailable";

  const contextExpansion = useMemo(
    () => ({ status: ctxStatus, request: requestContext }),
    [ctxStatus, requestContext],
  );
  const fullFileContents =
    enrichment.status === "ready" || enrichment.status === "ready-svg"
      ? enrichment.fullFileContents
      : null;
  const loadDeletedDiff = useCallback(() => {
    setLoadedDeleted(true);
    setEntered(true);
  }, []);
  const imageSizeStat =
    isImageCard && enrichment.status === "ready-image"
      ? getGitDiffCardImageSizeStat(enrichment, changeKind)
      : null;

  return {
    bodySentinelRef,
    contextExpansion,
    enrichment,
    fileDiff,
    fileDiffLabel,
    fullFileContents,
    imageSizeStat,
    isImageCard,
    isSvgPreviewCard: isSvgCard,
    loadDeletedDiff,
    patchText,
    shouldGateDeletedDiff,
    shouldRenderDiffView,
  };
}

function renderImageEnrichment(
  enrichment: EnrichmentState,
  label: string,
  fitToFrame = false,
) {
  if (enrichment.status === "idle" || enrichment.status === "loading")
    return <DiffLoadingSkeleton />;
  if (
    enrichment.status !== "ready-image" &&
    enrichment.status !== "ready-svg"
  ) {
    return (
      <div className="px-3 py-3 text-xs text-muted-foreground">
        No preview available for this image.
      </div>
    );
  }
  return (
    <GitDiffCardImagePreviewBody
      preview={{
        oldImageUrl: enrichment.oldImageUrl,
        newImageUrl: enrichment.newImageUrl,
      }}
      fileDiffLabel={label}
      fitToFrame={fitToFrame}
    />
  );
}

export function GitDiffCardBody({
  state,
  presentation,
  svgDisplayMode,
  reservesCollapseGutter,
  onSelectionAddToChat,
}: {
  onSelectionAddToChat?: (text: string) => void;
  presentation: DiffPresentation;
  reservesCollapseGutter: boolean;
  state: GitDiffCardBodyState;
  svgDisplayMode: GitDiffCardSvgDisplayMode;
}) {
  const {
    bodySentinelRef,
    enrichment,
    fileDiff,
    fileDiffLabel,
    isImageCard,
    isSvgPreviewCard,
    shouldGateDeletedDiff,
    shouldRenderDiffView,
    loadDeletedDiff,
    contextExpansion,
    fullFileContents,
    patchText,
  } = state;

  return (
    <div
      ref={bodySentinelRef}
      className="overflow-hidden rounded-b-lg bg-background"
      style={BODY_STYLE}
    >
      {shouldGateDeletedDiff ? (
        <div className="flex items-center py-3 pl-2 pr-3 text-xs text-muted-foreground">
          {reservesCollapseGutter ? (
            <span aria-hidden className="w-8 shrink-0" />
          ) : null}
          <span className="pl-[1ch]">
            <span>This file was deleted.</span>{" "}
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs underline underline-offset-4 hover:underline"
              onClick={loadDeletedDiff}
            >
              Load diff
            </Button>
          </span>
        </div>
      ) : !shouldRenderDiffView ? (
        <DiffLoadingSkeleton />
      ) : isImageCard ? (
        renderImageEnrichment(enrichment, fileDiffLabel)
      ) : isSvgPreviewCard && svgDisplayMode === "preview" ? (
        renderImageEnrichment(enrichment, fileDiffLabel, true)
      ) : (
        <>
          <DiffHost
            file={fileDiff}
            patchText={patchText}
            fullFileContents={fullFileContents}
            {...presentation}
            fallback={isSvgPreviewCard ? undefined : <DiffLoadingSkeleton />}
            onSelectionAddToChat={onSelectionAddToChat}
          />
          {!isSvgPreviewCard &&
          contextExpansion.status !== "unavailable" &&
          contextExpansion.status !== "ready" ? (
            <div className="flex items-center py-2 pl-2 pr-3 text-xs text-muted-foreground">
              {reservesCollapseGutter ? (
                <span aria-hidden className="w-8 shrink-0" />
              ) : null}
              <span className="pl-[1ch]">
                {contextExpansion.status === "loading" ? (
                  <span role="status">Loading context…</span>
                ) : (
                  <>
                    {contextExpansion.status === "error" ? (
                      <>
                        <span className="text-destructive">
                          Couldn&apos;t load surrounding context.
                        </span>{" "}
                      </>
                    ) : null}
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs underline underline-offset-4 hover:underline"
                      onClick={contextExpansion.request}
                    >
                      {contextExpansion.status === "error"
                        ? "Retry"
                        : "Expand context"}
                    </Button>
                  </>
                )}
              </span>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

// --- Inline Patch Card (Timeline & Plugin Diffs) ---

export const GitDiffCard = memo(function GitDiffCard({
  fileDiff,
  presentation,
  patchText,
  filePathRoot,
  onOpenFileInEditor,
  isCollapsed,
  onToggleCollapsed,
  stickyHeader = false,
  cardClassName,
  showStuckHeaderEdge = true,
  onRequestFileContents,
}: {
  cardClassName?: string;
  fileDiff: ParsedGitDiffFile;
  filePathRoot?: string | null;
  isCollapsed?: boolean;
  onOpenFileInEditor?: (path: string) => void;
  onRequestFileContents?: RequestDiffFileContents;
  onToggleCollapsed?: () => void;
  patchText?: string;
  presentation: DiffPresentation;
  showStuckHeaderEdge?: boolean;
  stickyHeader?: boolean;
}) {
  const headerModel = useMemo<GitDiffCardHeaderModel>(() => {
    const stats = summarizeGitDiffFile(fileDiff);
    return {
      label: formatGitDiffFileLabel(fileDiff),
      path: normalizeGitDiffPath(fileDiff.name) ?? fileDiff.name,
      openablePath: getOpenableGitDiffPath(fileDiff),
      changeKind: getGitDiffFileChangeKind(fileDiff),
      insertions: stats.insertions,
      deletions: stats.deletions,
    };
  }, [fileDiff]);
  const bodyState = useGitDiffCardBody({
    fileDiff,
    changeKind: headerModel.changeKind,
    onRequestFileContents,
    patchText,
  });
  const [svgMode, setSvgMode] = useState<GitDiffCardSvgDisplayMode>("preview");
  useEffect(() => setSvgMode("preview"), [fileDiff]);

  const hasChanges = fileDiff.hunks.length > 0 || bodyState.isImageCard;
  const supportsCollapse =
    isCollapsed !== undefined && onToggleCollapsed !== undefined;
  const isBodyHidden = !hasChanges || (supportsCollapse && isCollapsed);
  const { ref: stickyRef, isIntersecting } = useIntersectionObserver({
    initialIsIntersecting: true,
    threshold: 1,
  });

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-background",
        cardClassName,
      )}
    >
      {stickyHeader ? <div ref={stickyRef} className="h-0" /> : null}
      <div
        className={gitDiffCardHeaderWrapperClass({
          stickyHeader,
          isBodyHidden,
          isStuck: stickyHeader && !isIntersecting,
          showStuckHeaderEdge,
        })}
      >
        <GitDiffCardHeader
          model={headerModel}
          previousPath={normalizeGitDiffPath(fileDiff.prevName) ?? null}
          filePathRoot={filePathRoot}
          onOpenFileInEditor={onOpenFileInEditor}
          isCollapsed={isCollapsed}
          onToggleCollapsed={onToggleCollapsed}
          hasChanges={hasChanges}
          statSlot={
            bodyState.isImageCard ? (
              bodyState.imageSizeStat ? (
                <GitDiffCardImageSizeStat stat={bodyState.imageSizeStat} />
              ) : (
                <span />
              )
            ) : undefined
          }
          actionSlot={
            bodyState.isSvgPreviewCard && !isBodyHidden ? (
              <GitDiffCardRawToggle
                fileLabel={bodyState.fileDiffLabel}
                isRaw={svgMode === "raw"}
                onToggle={() =>
                  setSvgMode((m) => (m === "preview" ? "raw" : "preview"))
                }
              />
            ) : undefined
          }
        />
      </div>
      {!isBodyHidden ? (
        <GitDiffCardBody
          state={bodyState}
          presentation={presentation}
          svgDisplayMode={svgMode}
          reservesCollapseGutter={supportsCollapse}
        />
      ) : null}
    </div>
  );
});

// --- Virtualized Panel File Entry Card ---

export interface DiffFileCardProps {
  entry: DiffFileEntry;
  filePathRoot?: string | null;
  isCollapsed: boolean;
  onLoadPatch: () => void;
  onOpenFileInEditor?: (path: string) => void;
  onOpenFilePreview?: (path: string) => void;
  onRequestFileContents?: RequestDiffFileContents;
  onRetry: () => void;
  onSelectionAddToChat?: (text: string) => void;
  onToggleCollapsed: () => void;
  patchState: DiffPatchState;
  presentation: DiffPresentation;
}

type BinaryPreviewState =
  | { status: "idle" | "loading" | "unavailable" | "error" }
  | {
      preview: GitDiffCardImagePreview & {
        newSizeBytes: number | null;
        oldSizeBytes: number | null;
      };
      status: "ready";
    };

function useBinaryImagePreview(
  entry: DiffFileEntry,
  enabled: boolean,
  fetcher?: RequestDiffFileContents,
): BinaryPreviewState {
  const isBinaryImg =
    entry.binary &&
    (isPreviewableImagePath(entry.path) ||
      isPreviewableImagePath(entry.previousPath ?? undefined));
  const oldPath =
    entry.changeKind === "added" ? null : (entry.previousPath ?? entry.path);
  const newPath = entry.changeKind === "deleted" ? null : entry.path;
  const planId = isBinaryImg
    ? `${entry.changeKind}:${oldPath ?? ""}:${newPath ?? ""}`
    : "none";

  const [state, setState] = useState<BinaryPreviewState>({ status: "idle" });
  const statusRef = useRef<BinaryPreviewState["status"]>("idle");

  useEffect(() => {
    statusRef.current = "idle";
    setState({ status: "idle" });
  }, [planId, fetcher]);

  useEffect(() => {
    if (!enabled || !isBinaryImg || !fetcher || statusRef.current !== "idle")
      return;
    let cancelled = false;
    statusRef.current = "loading";
    setState({ status: "loading" });

    const fetchImg = async (p: string | null, side: "old" | "new") => {
      if (!p) return null;
      const res = await fetcher(p, side);
      return res?.kind === "image" ? res : null;
    };

    void Promise.all([fetchImg(oldPath, "old"), fetchImg(newPath, "new")])
      .then(([oldImg, newImg]) => {
        if (cancelled) return;
        if (!oldImg && !newImg) {
          statusRef.current = "unavailable";
          setState({ status: "unavailable" });
          return;
        }
        statusRef.current = "ready";
        setState({
          status: "ready",
          preview: {
            oldImageUrl: oldImg?.dataUrl ?? null,
            newImageUrl: newImg?.dataUrl ?? null,
            oldSizeBytes: oldImg?.sizeBytes ?? null,
            newSizeBytes: newImg?.sizeBytes ?? null,
          },
        });
      })
      .catch(() => {
        if (!cancelled) {
          statusRef.current = "error";
          setState({ status: "error" });
        }
      });

    return () => {
      cancelled = true;
      if (statusRef.current === "loading") statusRef.current = "idle";
    };
  }, [enabled, fetcher, isBinaryImg, newPath, oldPath]);

  return state;
}

function RenderedEntryBody(args: {
  entry: DiffFileEntry;
  onOpenFilePreview?: (path: string) => void;
  onRequestFileContents?: RequestDiffFileContents;
  onSelectionAddToChat?: (text: string) => void;
  parsedFile: ParsedGitDiffFile;
  patchText?: string;
  presentation: DiffPresentation;
  svgDisplayMode: GitDiffCardSvgDisplayMode;
  truncated: boolean;
}) {
  const bodyState = useGitDiffCardBody({
    fileDiff: args.parsedFile,
    changeKind: args.entry.changeKind,
    onRequestFileContents: args.onRequestFileContents,
    patchText: args.patchText,
  });
  return (
    <>
      <GitDiffCardBody
        state={bodyState}
        presentation={args.presentation}
        svgDisplayMode={args.svgDisplayMode}
        reservesCollapseGutter
        onSelectionAddToChat={args.onSelectionAddToChat}
      />
      {args.truncated ? (
        <div className={NOTICE_CLASS}>
          <span>This diff was truncated for display.</span>
          {args.onOpenFilePreview ? (
            <FilePathLink
              path={args.entry.path}
              displayName="Show full diff"
              onClick={() => args.onOpenFilePreview!(args.entry.path)}
              className="text-xs underline underline-offset-4"
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export const DiffFileCard = memo(
  function DiffFileCard({
    entry,
    presentation,
    filePathRoot,
    isCollapsed,
    onToggleCollapsed,
    patchState,
    onLoadPatch,
    onRetry,
    onOpenFileInEditor,
    onOpenFilePreview,
    onRequestFileContents,
    onSelectionAddToChat,
  }: DiffFileCardProps) {
    const label =
      (entry.changeKind === "renamed" || entry.changeKind === "copied") &&
      entry.previousPath &&
      entry.previousPath !== entry.path
        ? `${entry.previousPath} -> ${entry.path}`
        : entry.path;
    const headerModel = useMemo<GitDiffCardHeaderModel>(
      () => ({
        label,
        path: entry.path,
        openablePath: entry.path,
        changeKind: entry.changeKind,
        insertions: entry.additions,
        deletions: entry.deletions,
      }),
      [entry, label],
    );
    const parsedFile = useMemo(
      () =>
        patchState.status === "loaded" && patchState.patch !== undefined
          ? (parseGitDiffFiles(patchState.patch)[0] ?? null)
          : null,
      [patchState.patch, patchState.status],
    );
    const [svgMode, setSvgMode] =
      useState<GitDiffCardSvgDisplayMode>("preview");
    useEffect(
      () => setSvgMode("preview"),
      [entry.path, entry.previousPath, patchState.patch],
    );

    const changedLines = entry.additions + entry.deletions;
    const directBinaryImg =
      entry.binary &&
      onRequestFileContents !== undefined &&
      (isPreviewableImagePath(entry.path) ||
        isPreviewableImagePath(entry.previousPath ?? undefined));
    const binState = useBinaryImagePreview(
      entry,
      !isCollapsed && directBinaryImg,
      onRequestFileContents,
    );
    const binStat =
      binState.status === "ready"
        ? getGitDiffCardImageSizeStat(binState.preview, entry.changeKind)
        : null;
    const supportsSvgToggle =
      !isCollapsed &&
      parsedFile !== null &&
      parsedFile.type !== "rename-pure" &&
      onRequestFileContents !== undefined &&
      isSvgGitDiffFile(parsedFile);
    const { ref: stickyRef, isIntersecting } = useIntersectionObserver({
      initialIsIntersecting: true,
      threshold: 1,
    });

    const loadNotice = (
      <div className={NOTICE_CLASS}>
        <span>
          {entry.binary
            ? "Binary file."
            : `${changedLines.toLocaleString()} changed lines.`}
        </span>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs underline underline-offset-4 hover:underline"
          onClick={onLoadPatch}
        >
          Load diff
        </Button>
      </div>
    );

    const renderBody = () => {
      if (directBinaryImg) {
        if (binState.status === "idle" || binState.status === "loading")
          return <DiffLoadingSkeleton />;
        if (binState.status === "ready")
          return (
            <GitDiffCardImagePreviewBody
              preview={binState.preview}
              fileDiffLabel={label}
            />
          );
        if (patchState.status === "idle") return loadNotice;
      }
      if (patchState.status === "error") {
        return (
          <div className={NOTICE_CLASS}>
            <span className="text-destructive">
              {patchState.error ?? "Failed to load this file's diff."}
            </span>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs underline underline-offset-4 hover:underline"
              onClick={onRetry}
            >
              Retry
            </Button>
          </div>
        );
      }
      if (entry.loadMode === "too_large") {
        return (
          <div className={NOTICE_CLASS}>
            <span>{`Too large to display (${changedLines.toLocaleString()} changed lines).`}</span>
            {onOpenFilePreview ? (
              <FilePathLink
                path={entry.path}
                displayName="Open file"
                onClick={() => onOpenFilePreview(entry.path)}
                className="text-xs underline underline-offset-4"
              />
            ) : null}
          </div>
        );
      }
      if (entry.loadMode === "on_demand" && patchState.status === "idle")
        return loadNotice;
      if (parsedFile === null) {
        if (patchState.status === "loaded") {
          return (
            <div className={NOTICE_CLASS}>
              <span>No renderable diff for this file.</span>
              {onOpenFilePreview ? (
                <FilePathLink
                  path={entry.path}
                  displayName="Open file"
                  onClick={() => onOpenFilePreview(entry.path)}
                  className="text-xs underline underline-offset-4"
                />
              ) : null}
            </div>
          );
        }
        return <DiffLoadingSkeleton />;
      }
      return (
        <RenderedEntryBody
          entry={entry}
          parsedFile={parsedFile}
          patchText={patchState.truncated ? undefined : patchState.patch}
          presentation={presentation}
          svgDisplayMode={svgMode}
          truncated={patchState.truncated ?? false}
          onOpenFilePreview={onOpenFilePreview}
          onRequestFileContents={onRequestFileContents}
          onSelectionAddToChat={onSelectionAddToChat}
        />
      );
    };

    return (
      <div className="overflow-clip rounded-lg border border-border bg-background">
        <div ref={stickyRef} className="h-0" />
        <div
          className={cn(
            gitDiffCardHeaderWrapperClass({
              stickyHeader: true,
              isBodyHidden: isCollapsed,
              isStuck: !isIntersecting,
              showStuckHeaderEdge: false,
            }),
            "-mt-px border-t border-border",
          )}
        >
          <GitDiffCardHeader
            model={headerModel}
            previousPath={entry.previousPath}
            filePathRoot={filePathRoot}
            onOpenFileInEditor={onOpenFileInEditor}
            onOpenFilePreview={onOpenFilePreview}
            isCollapsed={isCollapsed}
            onToggleCollapsed={onToggleCollapsed}
            hasChanges
            statSlot={
              directBinaryImg ? (
                binStat ? (
                  <GitDiffCardImageSizeStat stat={binStat} />
                ) : (
                  <span />
                )
              ) : undefined
            }
            actionSlot={
              supportsSvgToggle ? (
                <GitDiffCardRawToggle
                  fileLabel={label}
                  isRaw={svgMode === "raw"}
                  onToggle={() =>
                    setSvgMode((m) => (m === "preview" ? "raw" : "preview"))
                  }
                />
              ) : undefined
            }
          />
        </div>
        {isCollapsed ? null : renderBody()}
      </div>
    );
  },
  (prev, next) =>
    prev.entry === next.entry &&
    prev.presentation === next.presentation &&
    prev.filePathRoot === next.filePathRoot &&
    prev.isCollapsed === next.isCollapsed &&
    prev.onToggleCollapsed === next.onToggleCollapsed &&
    prev.onLoadPatch === next.onLoadPatch &&
    prev.onRetry === next.onRetry &&
    prev.onOpenFileInEditor === next.onOpenFileInEditor &&
    prev.onOpenFilePreview === next.onOpenFilePreview &&
    prev.onRequestFileContents === next.onRequestFileContents &&
    prev.onSelectionAddToChat === next.onSelectionAddToChat &&
    prev.patchState.status === next.patchState.status &&
    prev.patchState.patch === next.patchState.patch &&
    prev.patchState.truncated === next.patchState.truncated &&
    prev.patchState.error === next.patchState.error,
);
