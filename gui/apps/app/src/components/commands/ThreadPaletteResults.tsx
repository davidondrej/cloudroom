import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import type { ThreadListEntry } from "@cloudroom/domain";
import { PERSONAL_PROJECT_ID } from "@cloudroom/domain";
import { fuzzyMatchText } from "@cloudroom/fuzzy-match";
import type { ThreadSearchMatch } from "@cloudroom/server-contract";
import {
  resolveThreadListIndicator,
  threadListIndicatorStateForThread,
} from "@cloudroom/client-core";
import { CHROME_SECTION_LABEL_CLASS } from "@cloudroom/shared-ui/chrome-style-tokens";
import { Icon, type IconName } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_TEXT_SM_CLASS,
} from "@cloudroom/shared-ui/coarse-pointer-sizing";
import { useThreadTitleMentionResources } from "@/components/thread/ThreadTitleMentions";
import { ThreadStatusGlyph } from "@/components/sidebar/ThreadRow";
import {
  hasThreadSearchableQuery,
  THREAD_SEARCH_LIMIT_PER_GROUP,
  useThreadSearch,
} from "@/hooks/queries/thread-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { usePromptDraftHasInput } from "@/hooks/usePromptDraftStorage";
import { formatRelativeTime } from "@/lib/relative-time";
import { getThreadDisplayTitle } from "@/lib/thread-title";

export interface ThreadPaletteNavigationItem {
  id: string;
  optionId: string;
  projectId: string;
  threadId: string | null;
  messageSeq: number | null;
}

interface ThreadPaletteResultsProps {
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onNavigationItemsChange: (
    items: readonly ThreadPaletteNavigationItem[],
  ) => void;
  onSelect: (item: ThreadPaletteNavigationItem) => void;
  optionIdPrefix: string;
  query: string;
}

interface ThreadSearchRenderableRow {
  kind: "thread";
  id: string;
  matches: readonly ThreadSearchMatch[];
  thread: ThreadListEntry;
}

interface ProjectSearchRenderableRow {
  kind: "project";
  id: string;
  project: { id: string; name: string };
}

interface ThreadSearchSection {
  id: "recent" | "projects" | "titles" | "contents";
  label: string;
  rows: readonly (ThreadSearchRenderableRow | ProjectSearchRenderableRow)[];
}

const RECENT_THREAD_LIMIT = 20;
const EMPTY_MATCHES: readonly ThreadSearchMatch[] = [];
const RESULT_ROW_CLASS =
  "flex min-h-10 w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none";

function searchWords(text: string): string[] {
  return (
    text
      .normalize("NFD")
      .replace(/\p{Mark}/gu, "")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}_]+/gu) ?? []
  );
}

function positionsToRanges(
  positions: readonly number[],
): ThreadSearchMatch["highlightRanges"] {
  const ranges: ThreadSearchMatch["highlightRanges"] = [];
  for (const position of [...new Set(positions)].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last !== undefined && last.end === position) last.end = position + 1;
    else ranges.push({ start: position, end: position + 1 });
  }
  return ranges;
}

function isThreadTitleMatch(match: ThreadSearchMatch): boolean {
  return match.sourceKind === "title" || match.sourceKind === "title_fallback";
}

function getMessageMatchSeq(
  matches: readonly ThreadSearchMatch[],
): number | null {
  for (const match of matches) {
    if (!isThreadTitleMatch(match) && match.sourceSeq !== null) {
      return match.sourceSeq;
    }
  }
  return null;
}

function toNavigationItem(
  row: ThreadSearchRenderableRow | ProjectSearchRenderableRow,
  optionIdPrefix: string,
): ThreadPaletteNavigationItem {
  return {
    id: row.id,
    optionId: `${optionIdPrefix}-${row.id}`,
    projectId: row.kind === "project" ? row.project.id : row.thread.projectId,
    threadId: row.kind === "project" ? null : row.thread.id,
    messageSeq: row.kind === "project" ? null : getMessageMatchSeq(row.matches),
  };
}

function ThreadSearchMessage({
  iconName,
  isLoading = false,
  text,
}: {
  iconName: IconName;
  isLoading?: boolean;
  text: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-2 text-muted-foreground",
        COARSE_POINTER_TEXT_SM_CLASS,
      )}
    >
      <Icon
        name={iconName}
        className={cn(
          COARSE_POINTER_ICON_SIZE_CLASS,
          isLoading && "animate-spin",
        )}
      />
      <span>{text}</span>
    </div>
  );
}

function flattenRecentThreads(
  navigation: ReturnType<typeof useSidebarNavigation>["data"],
): ThreadListEntry[] {
  if (!navigation) return [];
  return [
    ...navigation.projects.flatMap((project) => project.threads),
    ...navigation.personalProject.threads,
  ];
}

export function ThreadPaletteResults({
  activeIndex,
  onActiveIndexChange,
  onNavigationItemsChange,
  onSelect,
  optionIdPrefix,
  query,
}: ThreadPaletteResultsProps) {
  const navigationQuery = useSidebarNavigation();
  const recentThreads = useMemo(
    () => flattenRecentThreads(navigationQuery.data),
    [navigationQuery.data],
  );
  const { projectNamesById } = useThreadTitleMentionResources();
  const trimmedQuery = query.trim();
  const hasQuery = trimmedQuery.length > 0;
  const liveQueryIsSearchable = hasThreadSearchableQuery(trimmedQuery);
  const threadSearch = useThreadSearch({ active: true, query });
  const searchResultsAreCurrent =
    liveQueryIsSearchable && threadSearch.debouncedQuery === trimmedQuery;
  const sections = useMemo<ThreadSearchSection[]>(() => {
    if (!hasQuery) {
      const rows = [...recentThreads]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, RECENT_THREAD_LIMIT)
        .map((thread): ThreadSearchRenderableRow => ({
          kind: "thread",
          id: `recent:${thread.id}`,
          matches: EMPTY_MATCHES,
          thread,
        }));
      return [{ id: "recent", label: "Recent", rows }];
    }

    const projects = navigationQuery.data
      ? [...navigationQuery.data.projects, navigationQuery.data.personalProject]
      : [];
    const queryWords = searchWords(trimmedQuery);
    const projectRows = projects
      .filter((project) => {
        const nameWords = searchWords(project.name);
        return (
          queryWords.length > 0 &&
          queryWords.every((word) =>
            nameWords.some((nameWord) => nameWord.includes(word)),
          )
        );
      })
      .map((project): ProjectSearchRenderableRow => ({
        kind: "project",
        id: `project:${project.id}`,
        project,
      }));
    const titleRows: ThreadSearchRenderableRow[] = fuzzyMatchText({
      items: recentThreads,
      query: trimmedQuery,
      // NFC keeps match positions aligned with the shown title (the matcher folds accents per character).
      getText: (thread) => getThreadDisplayTitle(thread).normalize("NFC"),
      limit: recentThreads.length,
    })
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.item.updatedAt - left.item.updatedAt,
      )
      .slice(0, THREAD_SEARCH_LIMIT_PER_GROUP)
      .map(({ item: thread, positions }) => ({
        kind: "thread",
        id: `title:${thread.id}`,
        thread,
        matches: [
          {
            sourceKind: "title",
            text: getThreadDisplayTitle(thread).normalize("NFC"),
            highlightRanges: positionsToRanges(positions),
            sourceSeq: null,
          },
        ],
      }));
    const localTitleIds = new Set(titleRows.map((row) => row.thread.id));
    const contentRows: ThreadSearchRenderableRow[] = [];
    if (searchResultsAreCurrent && threadSearch.data) {
      for (const { thread, matches } of [
        ...threadSearch.data.active.results,
        ...threadSearch.data.archived.results,
      ]) {
        const title = getThreadDisplayTitle(thread);
        const titleMatch = getTitleMatch(title, matches);
        const nameWords = searchWords(title);
        const fullNameMatch =
          queryWords.length > 0 &&
          queryWords.every((word) =>
            nameWords.some((nameWord) => nameWord.startsWith(word)),
          );
        const snippetMatch = getSnippetMatch(matches);
        if (
          fullNameMatch &&
          (titleMatch || !snippetMatch) &&
          !localTitleIds.has(thread.id)
        ) {
          titleRows.push({
            kind: "thread",
            id: `title:${thread.id}`,
            thread,
            matches: titleMatch ? [titleMatch] : EMPTY_MATCHES,
          });
        }
        if (snippetMatch) {
          contentRows.push({
            kind: "thread",
            id: `content:${thread.id}`,
            thread,
            matches,
          });
        }
      }
    }
    return [
      { id: "projects", label: "Projects", rows: projectRows },
      { id: "titles", label: "Thread names", rows: titleRows },
      { id: "contents", label: "Conversation content", rows: contentRows },
    ];
  }, [
    hasQuery,
    navigationQuery.data,
    recentThreads,
    searchResultsAreCurrent,
    threadSearch.data,
    trimmedQuery,
  ]);
  const rows = useMemo(
    () => sections.flatMap((section) => section.rows),
    [sections],
  );
  const navigationItems = useMemo(
    () => rows.map((row) => toNavigationItem(row, optionIdPrefix)),
    [optionIdPrefix, rows],
  );

  useEffect(() => {
    onNavigationItemsChange(navigationItems);
  }, [navigationItems, onNavigationItemsChange]);

  const isLoading =
    liveQueryIsSearchable &&
    (!searchResultsAreCurrent ||
      threadSearch.isDebouncing ||
      (threadSearch.isLoading && threadSearch.data === undefined));
  const hasRows = rows.length > 0;
  const showRecentLoading = !hasQuery && navigationQuery.isLoading;
  const showError = liveQueryIsSearchable && threadSearch.isError && !isLoading;
  const showNoSearchResults = hasQuery && !isLoading && !showError && !hasRows;
  const showTypeToSearch =
    !hasQuery && !showRecentLoading && recentThreads.length === 0;
  const searchGroups = threadSearch.data
    ? [threadSearch.data.active, threadSearch.data.archived]
    : [];
  const shownThreadCount = searchGroups.reduce(
    (count, group) => count + group.results.length,
    0,
  );
  const totalThreadCount = searchGroups.reduce(
    (count, group) => count + group.total,
    0,
  );
  let startIndex = 0;

  return (
    <div className="space-y-3 pb-2">
      {showRecentLoading ? (
        <ThreadSearchMessage
          iconName="Spinner"
          isLoading
          text="Loading threads..."
        />
      ) : null}
      {isLoading && !hasRows ? (
        <ThreadSearchMessage
          iconName="Spinner"
          isLoading
          text="Searching threads..."
        />
      ) : null}
      {showError ? (
        <ThreadSearchMessage iconName="AlertCircle" text="Search failed." />
      ) : null}
      {showNoSearchResults ? (
        <ThreadSearchMessage
          iconName="MessageQuestion"
          text="No matching results"
        />
      ) : null}
      {showTypeToSearch ? (
        <ThreadSearchMessage
          iconName="Search"
          text="Search projects, thread names, and conversations."
        />
      ) : null}
      {sections.map((section) => {
        const sectionStartIndex = startIndex;
        startIndex += section.rows.length;
        if (section.rows.length === 0) return null;
        return (
          <section
            key={section.id}
            role="group"
            aria-label={section.label}
            className="space-y-1"
          >
            <div
              className={cn(
                CHROME_SECTION_LABEL_CLASS,
                "sticky top-0 z-10 flex items-center gap-2 rounded-none bg-popover px-2",
              )}
            >
              <span className="min-w-0 truncate">{section.label}</span>
            </div>
            <div className="space-y-0.5">
              {section.rows.map((row, rowIndex) => {
                const index = sectionStartIndex + rowIndex;
                const item = navigationItems[index];
                if (!item) return null;
                if (row.kind === "project") {
                  return (
                    <button
                      key={row.id}
                      id={item.optionId}
                      type="button"
                      role="option"
                      aria-selected={activeIndex === index}
                      className={cn(
                        RESULT_ROW_CLASS,
                        activeIndex === index &&
                          "bg-state-hover text-foreground",
                      )}
                      onMouseEnter={() => onActiveIndexChange(index)}
                      onFocus={() => onActiveIndexChange(index)}
                      onClick={() => onSelect(item)}
                    >
                      <Icon
                        name="Folder"
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      <span className="min-w-0 truncate font-medium">
                        {row.project.name}
                      </span>
                    </button>
                  );
                }
                return (
                  <ThreadPaletteResultRow
                    key={row.id}
                    id={item.optionId}
                    isActive={activeIndex === index}
                    matches={row.matches}
                    projectName={projectNamesById.get(row.thread.projectId)}
                    thread={row.thread}
                    onActive={() => onActiveIndexChange(index)}
                    onSelect={() => onSelect(item)}
                  />
                );
              })}
            </div>
          </section>
        );
      })}
      {liveQueryIsSearchable &&
      searchResultsAreCurrent &&
      shownThreadCount < totalThreadCount ? (
        <p className="px-2 text-xs text-muted-foreground">
          Showing {shownThreadCount} of {totalThreadCount} threads. Refine your
          search.
        </p>
      ) : null}
    </div>
  );
}

function clampRange(
  range: ThreadSearchMatch["highlightRanges"][number],
  textLength: number,
): ThreadSearchMatch["highlightRanges"][number] | null {
  const start = Math.max(0, Math.min(range.start, textLength));
  const end = Math.max(start, Math.min(range.end, textLength));
  return end > start ? { start, end } : null;
}

function HighlightedText({
  ranges,
  text,
  isTitle = false,
}: {
  ranges: ThreadSearchMatch["highlightRanges"];
  text: string;
  isTitle?: boolean;
}) {
  if (ranges.length === 0 || text.length === 0) return text;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  const sortedRanges = ranges
    .map((range) => clampRange(range, text.length))
    .filter((range): range is NonNullable<typeof range> => range !== null)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  for (const range of sortedRanges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) nodes.push(text.slice(cursor, range.start));
    nodes.push(
      <mark
        key={`${range.start}:${range.end}`}
        className={cn(
          "rounded-sm px-0",
          isTitle
            ? "bg-destructive text-destructive-foreground"
            : "bg-state-selected text-foreground",
        )}
      >
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function getTitleMatch(
  title: string,
  matches: readonly ThreadSearchMatch[],
): ThreadSearchMatch | undefined {
  const normalize = (text: string) => text.trim().replace(/\s+/gu, " ");
  return matches.find(
    (match) =>
      isThreadTitleMatch(match) && normalize(match.text) === normalize(title),
  );
}

function getSnippetMatch(
  matches: readonly ThreadSearchMatch[],
): ThreadSearchMatch | undefined {
  return matches.find((match) => !isThreadTitleMatch(match));
}

function isNonEmptyMetadataPart(value: string | null): value is string {
  return value !== null && value.length > 0;
}

function ThreadPaletteResultRowComponent({
  id,
  isActive,
  matches,
  onActive,
  onSelect,
  projectName,
  thread,
}: {
  id: string;
  isActive: boolean;
  matches: readonly ThreadSearchMatch[];
  onActive: () => void;
  onSelect: () => void;
  projectName: string | undefined;
  thread: ThreadListEntry;
}) {
  const title = getThreadDisplayTitle(thread);
  const titleMatch = getTitleMatch(title, matches);
  const snippetMatch = getSnippetMatch(matches);
  const primaryMatch = snippetMatch ?? titleMatch;
  const primaryText = primaryMatch?.text ?? title;
  const primaryHighlightRanges = primaryMatch?.highlightRanges ?? [];
  const hasUnsubmittedDraft = usePromptDraftHasInput({
    kind: "thread",
    projectId: thread.projectId,
    threadId: thread.id,
  });
  const indicatorState = threadListIndicatorStateForThread(
    thread,
    hasUnsubmittedDraft,
  );
  const indicatorKind = resolveThreadListIndicator(indicatorState);
  const projectMetadata =
    thread.projectId !== PERSONAL_PROJECT_ID && projectName
      ? projectName
      : null;
  const relativeTime = formatRelativeTime({
    timestamp: thread.updatedAt,
    now: Date.now(),
  });
  const metadataSuffix = [
    projectMetadata,
    thread.archivedAt !== null ? "Archived" : null,
    relativeTime,
  ]
    .filter(isNonEmptyMetadataPart)
    .join(" · ");
  const metadataText = [snippetMatch ? title : null, metadataSuffix]
    .filter(isNonEmptyMetadataPart)
    .join(" · ");
  const handleMouseEnter = useCallback<MouseEventHandler<HTMLButtonElement>>(
    () => onActive(),
    [onActive],
  );

  return (
    <button
      id={id}
      type="button"
      role="option"
      aria-selected={isActive}
      className={cn(
        RESULT_ROW_CLASS,
        isActive && "bg-state-hover text-foreground",
      )}
      onMouseEnter={handleMouseEnter}
      onFocus={onActive}
      onClick={onSelect}
    >
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="block min-w-0 truncate">
          <HighlightedText
            text={primaryText}
            ranges={primaryHighlightRanges}
            isTitle={!snippetMatch}
          />
        </span>
        <span
          className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground"
          title={metadataText}
        >
          {snippetMatch ? (
            <Icon
              name="MessageSquare"
              className="size-3 shrink-0 text-subtle-foreground"
              aria-hidden="true"
            />
          ) : projectMetadata ? (
            <Icon name="Folder" className="size-3.5 shrink-0" aria-hidden />
          ) : null}
          <span className="min-w-0 truncate">
            {snippetMatch ? (
              <>
                <HighlightedText
                  text={titleMatch?.text ?? title}
                  ranges={titleMatch?.highlightRanges ?? []}
                  isTitle
                />
                {metadataSuffix ? " · " : null}
              </>
            ) : null}
            {metadataSuffix}
          </span>
        </span>
      </span>
      {indicatorKind !== "none" ? (
        <span className="inline-flex size-4 shrink-0 items-center justify-center">
          <ThreadStatusGlyph {...indicatorState} />
        </span>
      ) : null}
    </button>
  );
}

const ThreadPaletteResultRow = memo(ThreadPaletteResultRowComponent);
