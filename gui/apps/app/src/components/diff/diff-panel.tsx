import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAtom } from "jotai";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DiffFileEntry, DiffPatchEntry } from "@cloudroom/server-contract";
import type { WorkspaceDiffTarget } from "@cloudroom/domain";
import { Button } from "@cloudroom/shared-ui/button";
import {
  COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
  COARSE_POINTER_TEXT_SM_CLASS,
} from "@cloudroom/shared-ui/coarse-pointer-sizing";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import type { DiffPresentation } from "@/components/code/code-rendering";
import { DiffStatsTally } from "@/components/ui/diff-stats-tally.js";
import {
  formatChangeSummary,
  renderChangeSummary,
} from "@/components/workspace/workspace-change-summary";
import { useResizeObserver } from "@/hooks/useElementObservers";
import {
  useEnvironmentDiffPatches,
  type DiffPatchState,
  type LoadDiffPatchPath,
  type RetryDiffPatchPath,
} from "@/hooks/queries/use-environment-diff-patches";
import {
  getNextCodeOverflowMode,
  type CodeOverflowMode,
  type CodeOverflowModeChangeHandler,
} from "@/lib/code-overflow-mode";
import { DiffFileCard } from "./diff-card";
import {
  diffFileCardStateAtomFamily,
  estimateCardHeight,
  resolveCardCollapsed,
  resolveDiffFileCardInitialState,
  type GitDiffDisplayMode,
  type GitDiffDisplayModeChangeHandler,
  type GitDiffSelectionOption,
  type RequestDiffFileContents,
} from "./diff-store";
import type { GitDiffStats } from "./patch-utils";

const GAP_PX = 8;

// --- Virtualized Diff File List ---

export function DiffFilesPanel({
  environmentId,
  target,
  diffIdentity,
  files,
  initialPatches,
  filesUpdatedAt,
  presentation,
  filePathRoot,
  isPanelOpen,
  isPlaceholderData,
  scrollToPath,
  onScrolledToPath,
  onOpenFileInEditor,
  onOpenFilePreview,
  onRequestFileContents,
  onSelectionAddToChat,
}: {
  diffIdentity: string;
  environmentId: string;
  filePathRoot?: string | null;
  files: DiffFileEntry[];
  filesUpdatedAt: number;
  initialPatches: DiffPatchEntry[];
  isPanelOpen: boolean;
  isPlaceholderData?: boolean;
  onOpenFileInEditor?: (path: string) => void;
  onOpenFilePreview?: (path: string) => void;
  onRequestFileContents?: RequestDiffFileContents;
  onScrolledToPath?: () => void;
  onSelectionAddToChat?: (text: string) => void;
  presentation: DiffPresentation;
  scrollToPath?: string | null;
  target: WorkspaceDiffTarget;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const {
    requestPaths,
    getPatchState,
    retry,
    loadPath,
    seedInitialPatches,
    prunePaths,
  } = useEnvironmentDiffPatches(environmentId, { target });

  useEffect(() => {
    if (initialPatches.length > 0) seedInitialPatches(initialPatches);
  }, [seedInitialPatches, initialPatches, filesUpdatedAt]);

  useEffect(() => {
    prunePaths(files.map((f) => f.path));
  }, [files, prunePaths]);

  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const entry = files[i];
      if (!entry) return 0;
      const { collapsed } = resolveDiffFileCardInitialState({
        entry,
        fileCount: files.length,
      });
      return estimateCardHeight({ entry, collapsed }) + GAP_PX;
    },
    getItemKey: (i) => files[i]?.path ?? i,
    overscan: 4,
  });

  const items = virtualizer.getVirtualItems();
  const { startIndex, endIndex } = virtualizer.range ?? {
    startIndex: 0,
    endIndex: -1,
  };
  const { visiblePaths, overscanPaths } = useMemo(() => {
    const visible: string[] = [];
    const overscan: string[] = [];
    for (const item of items) {
      const entry = files[item.index];
      if (!entry || entry.loadMode !== "auto") continue;
      if (item.index >= startIndex && item.index <= endIndex)
        visible.push(entry.path);
      else overscan.push(entry.path);
    }
    return { visiblePaths: visible, overscanPaths: overscan };
  }, [items, files, startIndex, endIndex]);

  const visibleKey = visiblePaths.join("\n");
  const overscanKey = overscanPaths.join("\n");
  useEffect(() => {
    if (isPanelOpen)
      requestPaths({ visible: visiblePaths, overscan: overscanPaths });
    // oxlint-disable-next-line react/exhaustive-deps
  }, [isPanelOpen, requestPaths, visibleKey, overscanKey, filesUpdatedAt]);

  useEffect(() => {
    if (!scrollToPath || isPlaceholderData) return;
    const idx = files.findIndex((f) => f.path === scrollToPath);
    if (idx < 0) return;
    virtualizer.scrollToIndex(idx, { align: "start" });
    onScrolledToPath?.();
  }, [scrollToPath, files, isPlaceholderData, virtualizer, onScrolledToPath]);

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pb-3"
    >
      <div
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {items.map((item) => {
          const entry = files[item.index];
          if (!entry) return null;
          return (
            <div
              key={entry.path}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 w-full"
              style={{ top: item.start, paddingBottom: GAP_PX }}
            >
              <DiffFileRow
                entry={entry}
                diffIdentity={diffIdentity}
                fileCount={files.length}
                presentation={presentation}
                filePathRoot={filePathRoot}
                patchState={getPatchState(entry.path)}
                loadPath={loadPath}
                retry={retry}
                onOpenFileInEditor={onOpenFileInEditor}
                onOpenFilePreview={onOpenFilePreview}
                onRequestFileContents={onRequestFileContents}
                onSelectionAddToChat={onSelectionAddToChat}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DiffFileRow({
  entry,
  diffIdentity,
  fileCount,
  presentation,
  filePathRoot,
  patchState,
  loadPath,
  retry,
  onOpenFileInEditor,
  onOpenFilePreview,
  onRequestFileContents,
  onSelectionAddToChat,
}: {
  diffIdentity: string;
  entry: DiffFileEntry;
  fileCount: number;
  filePathRoot?: string | null;
  loadPath: LoadDiffPatchPath;
  onOpenFileInEditor?: (path: string) => void;
  onOpenFilePreview?: (path: string) => void;
  onRequestFileContents?: RequestDiffFileContents;
  onSelectionAddToChat?: (text: string) => void;
  patchState: DiffPatchState;
  presentation: DiffPresentation;
  retry: RetryDiffPatchPath;
}) {
  const stateAtom = useMemo(
    () => diffFileCardStateAtomFamily({ diffIdentity, path: entry.path }),
    [diffIdentity, entry.path],
  );
  const [cardState, setCardState] = useAtom(stateAtom);
  const collapsed = resolveCardCollapsed(cardState, entry, fileCount);

  const onToggle = useCallback(() => {
    setCardState((prev) => {
      const cur = prev ?? resolveDiffFileCardInitialState({ entry, fileCount });
      return { ...cur, collapsed: !cur.collapsed };
    });
  }, [entry, fileCount, setCardState]);
  const onLoad = useCallback(
    () => loadPath(entry.path),
    [entry.path, loadPath],
  );
  const onRetry = useCallback(() => retry(entry.path), [entry.path, retry]);

  return (
    <DiffFileCard
      entry={entry}
      presentation={presentation}
      filePathRoot={filePathRoot}
      isCollapsed={collapsed}
      onToggleCollapsed={onToggle}
      patchState={patchState}
      onLoadPatch={onLoad}
      onRetry={onRetry}
      onOpenFileInEditor={onOpenFileInEditor}
      onOpenFilePreview={onOpenFilePreview}
      onRequestFileContents={onRequestFileContents}
      onSelectionAddToChat={onSelectionAddToChat}
    />
  );
}

// --- Diff Toolbar ---

export function GitDiffToolbar({
  selectionValue,
  selectionOptions,
  onSelectionChange,
  isSelectorDisabled,
  stats,
  isTruncated,
  areAllFilesCollapsed,
  isCollapseAllDisabled,
  onToggleAllCollapsed,
  displayMode,
  onDisplayModeChange,
  lineOverflowMode,
  onLineOverflowModeChange,
}: {
  areAllFilesCollapsed: boolean;
  displayMode: GitDiffDisplayMode;
  isCollapseAllDisabled: boolean;
  isSelectorDisabled: boolean;
  isTruncated: boolean;
  lineOverflowMode: CodeOverflowMode;
  onDisplayModeChange: GitDiffDisplayModeChangeHandler;
  onLineOverflowModeChange: CodeOverflowModeChangeHandler;
  onSelectionChange: (value: string) => void;
  onToggleAllCollapsed: () => void;
  selectionOptions: readonly GitDiffSelectionOption[];
  selectionValue: string;
  stats: GitDiffStats;
}) {
  const rootRef = useRef<HTMLDivElement>(null!);
  const { width: rootWidth = 0 } = useResizeObserver({
    ref: rootRef,
    box: "content-box",
  });
  const selected = selectionOptions.find((o) => o.value === selectionValue);
  const tally = { ...stats, lineStatsComplete: true };
  const hasLines = stats.insertions > 0 || stats.deletions > 0;
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? "" : "s"}`;

  return (
    <div ref={rootRef} className="px-4 pb-3 pt-3">
      <div
        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2"
        data-testid="git-diff-toolbar-layout"
      >
        <div
          className="min-w-0 basis-48 grow-[999]"
          data-testid="git-diff-toolbar-selector-slot"
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={isSelectorDisabled}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isSelectorDisabled}
                className={cn(
                  "h-8 w-full min-w-0 justify-between gap-2 rounded-lg border border-border bg-transparent px-2.5 font-normal max-md:pointer-coarse:h-10",
                  COARSE_POINTER_TEXT_SM_CLASS,
                  isSelectorDisabled && "opacity-60",
                )}
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  {selected?.monoPrefix ? (
                    <span className="shrink-0 font-mono text-muted-foreground">
                      {selected.monoPrefix}
                    </span>
                  ) : null}
                  <span className="truncate">
                    {selected?.label ?? selectionValue}
                  </span>
                </span>
                <Icon
                  name="ChevronDown"
                  className={cn(
                    COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
                    "text-muted-foreground",
                  )}
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="min-w-[var(--radix-dropdown-menu-trigger-width)]"
              style={{
                maxWidth: `min(var(--radix-popper-available-width), max(20rem, ${rootWidth}px))`,
              }}
            >
              {selectionOptions.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onSelect={() => onSelectionChange(opt.value)}
                  className="flex items-center justify-between gap-2"
                >
                  <span
                    className="flex min-w-0 items-baseline gap-2"
                    title={
                      opt.monoPrefix
                        ? `${opt.monoPrefix} ${opt.label}`
                        : opt.label
                    }
                  >
                    {opt.monoPrefix ? (
                      <span className="shrink-0 font-mono text-muted-foreground">
                        {opt.monoPrefix}
                      </span>
                    ) : null}
                    <span className="truncate">{opt.label}</span>
                  </span>
                  <Icon
                    name="Check"
                    className={cn(
                      COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
                      opt.value === selectionValue
                        ? "opacity-100"
                        : "opacity-0",
                    )}
                  />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div
          className="flex min-w-0 flex-1 basis-auto items-center"
          data-testid="git-diff-toolbar-details"
        >
          <span
            className={cn(
              "min-w-0 shrink truncate pl-2.5 text-muted-foreground",
              COARSE_POINTER_TEXT_SM_CLASS,
            )}
            data-testid="git-diff-toolbar-summary"
            title={
              isTruncated
                ? `Showing the first ${plural(stats.filesCount, "changed file")}; shown slice: ${plural(stats.insertions, "insertion")}, ${plural(stats.deletions, "deletion")}`
                : formatChangeSummary(tally)
            }
          >
            {isTruncated ? (
              <>
                {`${stats.filesCount}+ file${stats.filesCount === 1 ? "" : "s"}`}
                {hasLines ? (
                  <>
                    {" · shown "}
                    <DiffStatsTally
                      insertions={stats.insertions}
                      deletions={stats.deletions}
                    />
                  </>
                ) : null}
              </>
            ) : (
              renderChangeSummary(tally)
            )}
          </span>

          <div
            className="ml-auto flex min-w-0 shrink-0 items-center justify-end gap-1"
            data-testid="git-diff-toolbar-actions"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
                "text-muted-foreground",
              )}
              onClick={onToggleAllCollapsed}
              disabled={isCollapseAllDisabled}
              aria-label={
                areAllFilesCollapsed ? "Expand all files" : "Collapse all files"
              }
            >
              <Icon
                name={areAllFilesCollapsed ? "ChevronsDown" : "ChevronsUp"}
              />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
                "text-muted-foreground",
              )}
              onClick={() =>
                onLineOverflowModeChange(
                  getNextCodeOverflowMode(lineOverflowMode),
                )
              }
              aria-label={
                lineOverflowMode === "wrap"
                  ? "Disable diff line wrap"
                  : "Wrap diff lines"
              }
              aria-pressed={lineOverflowMode === "wrap"}
            >
              <Icon name="TextWrap" />
            </Button>
            <div
              className="inline-flex items-center gap-1 rounded-lg border border-border p-0.5"
              role="tablist"
              aria-label="Diff view mode"
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn(
                  COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
                  "text-muted-foreground",
                )}
                onClick={() => onDisplayModeChange("unified")}
                aria-label="Stacked diff view"
                aria-pressed={displayMode === "unified"}
              >
                <Icon name="Rows2" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn(
                  COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
                  "text-muted-foreground",
                )}
                onClick={() => onDisplayModeChange("split")}
                aria-label="Split diff view"
                aria-pressed={displayMode === "split"}
              >
                <Icon name="Columns2" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
