import {
  useEffect,
  useMemo,
  useRef,
  useState,
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
import { sdk } from "@/lib/sdk";


export interface ThreadPaletteNavigationItem {
  id: string;
  optionId: string;
  projectId: string;
  threadId: string | null;
  messageSeq: number | null;
}

export interface SearchFilters {
  threads: boolean;
  projects: boolean;
  archived: boolean;
}

export type JevRankState = "off" | "thinking" | "done";

export interface ThreadPaletteSummary {
  counts: { threads: number; projects: number; archived: number } | null;
  jev: JevRankState;
}

interface ThreadPaletteResultsProps {
  activeIndex: number;
  filters?: SearchFilters;
  onActiveIndexChange: (index: number) => void;
  onIncludeArchived?: () => void;
  onNavigationItemsChange: (
    items: readonly ThreadPaletteNavigationItem[],
  ) => void;
  onSelect: (item: ThreadPaletteNavigationItem) => void;
  onSummaryChange?: (summary: ThreadPaletteSummary) => void;
  optionIdPrefix: string;
  query: string;
}

interface ThreadRowData {
  kind: "thread";
  id: string;
  matches: readonly ThreadSearchMatch[];
  thread: ThreadListEntry;
}

interface ProjectRowData {
  kind: "project";
  id: string;
  project: { id: string; name: string; threadCount: number };
}

type RowData = ThreadRowData | ProjectRowData;

const ALL_FILTERS: SearchFilters = { threads: true, projects: true, archived: true };
const RECENT_THREAD_LIMIT = 20;
const JEV_MIN_P = 0.03;
const JEV_TITLE_CHARS = 120;
const JEV_TEXT_CHARS = 300;
const JEV_BUDGET_CHARS = 190_000;
const JEV_MAX_CARDS = 1_500;
const JEV_CACHE_MS = 5 * 60_000;
const JEV_PAUSE_MS = 200;
const EMPTY_MATCHES: readonly ThreadSearchMatch[] = [];
const RESULT_ROW_CLASS =
  "relative flex min-h-10 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm outline-none";
const META_CLASS = "block truncate text-xs leading-4 text-subtle-foreground/70";

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
  row: RowData,
  optionIdPrefix: string,
): ThreadPaletteNavigationItem {
  return {
    id: row.id,
    optionId: `${optionIdPrefix}-${row.id}`,
    projectId: row.kind === "project" ? row.project.id : row.thread.projectId,
    threadId: row.kind === "project" ? null : row.thread.id,
    messageSeq: row.kind === "project" || row.matches.some(isThreadTitleMatch) ? null : getMessageMatchSeq(row.matches),
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

function lastInteraction(thread: ThreadListEntry): number {
  return Math.max(thread.lastReadAt ?? 0, thread.createdAt);
}

function jevItem(row: RowData, projectNames: ReadonlyMap<string, string>) {
  if (row.kind === "project") {
    return { id: row.id, title: row.project.name.slice(0, JEV_TITLE_CHARS), text: `A project with ${row.project.threadCount} open threads.` };
  }
  const project = projectNames.get(row.thread.projectId);
  const purpose = row.thread.purpose?.text;
  const snippet = getSnippetMatch(row.matches)?.text;
  return {
    id: row.id,
    title: getThreadDisplayTitle(row.thread).slice(0, JEV_TITLE_CHARS),
    text: [
      `Thread${project ? ` in project ${project}` : ""}${row.thread.archivedAt !== null ? ", archived" : ""}.`,
      purpose ? `Now: ${purpose}` : "",
      snippet ? `Matching message: ${snippet}` : "",
    ].filter(Boolean).join(" ").slice(0, JEV_TEXT_CHARS),
  };
}

type JevAnswer = { probabilities: Record<string, number>; ranked: string[] } | null;
const jevAnswers = new Map<string, { value: NonNullable<JevAnswer>; at: number }>();

function cardsHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function useJevRank(
  query: string,
  candidates: readonly RowData[],
  ready: boolean,
  projectNames: ReadonlyMap<string, string>,
): { answer: JevAnswer; state: JevRankState } {
  const [answer, setAnswer] = useState<{ key: string; value: JevAnswer } | null>(null);
  const items = useMemo(() => {
    const cards: ReturnType<typeof jevItem>[] = [];
    let chars = 0;
    for (const row of candidates) {
      if (cards.length >= JEV_MAX_CARDS) break;
      const card = jevItem(row, projectNames);
      chars += card.title.length + card.text.length;
      if (chars > JEV_BUDGET_CHARS) break;
      cards.push(card);
    }
    return cards;
  }, [candidates, projectNames]);
  const key = useMemo(
    () => (ready && items.length > 0 ? `${query}\n${items.length}:${cardsHash(JSON.stringify(items))}` : ""),
    [items, query, ready],
  );
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(() => {
    if (!key) return;
    const cached = jevAnswers.get(key);
    if (cached && Date.now() - cached.at < JEV_CACHE_MS) {
      setAnswer({ key, value: cached.value });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      sdk.cloudroom
        .searchRank({ query, items: itemsRef.current }, controller.signal)
        .then(({ probabilities, ranked }) => {
          const value = probabilities ? { probabilities, ranked } : null;
          if (value) {
            if (jevAnswers.size > 100) jevAnswers.clear();
            jevAnswers.set(key, { value, at: Date.now() });
          }
          setAnswer({ key, value });
        })
        .catch(() => {
          if (!controller.signal.aborted) setAnswer({ key, value: null });
        });
    }, JEV_PAUSE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, query]);
  if (!key) return { answer: null, state: "off" };
  if (answer?.key !== key) return { answer: null, state: "thinking" };
  return { answer: answer.value, state: answer.value ? "done" : "off" };
}

export function ThreadPaletteResults({
  activeIndex,
  filters = ALL_FILTERS,
  onActiveIndexChange,
  onIncludeArchived,
  onNavigationItemsChange,
  onSelect,
  onSummaryChange,
  optionIdPrefix,
  query,
}: ThreadPaletteResultsProps) {
  const navigationQuery = useSidebarNavigation();
  const recentThreads = useMemo(
    () => flattenRecentThreads(navigationQuery.data),
    [navigationQuery.data],
  );
  const { projectNamesById } = useThreadTitleMentionResources();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const trimmedQuery = query.trim();
  const hasQuery = trimmedQuery.length > 0;
  const liveQueryIsSearchable = hasThreadSearchableQuery(trimmedQuery);
  const threadSearch = useThreadSearch({ active: true, query });
  const searchResultsAreCurrent =
    liveQueryIsSearchable && threadSearch.debouncedQuery === trimmedQuery;

  const found = useMemo(() => {
    if (!hasQuery) return { projects: [], active: [], archived: [] as ThreadRowData[] };
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
      .map((project): ProjectRowData => ({
        kind: "project",
        id: `project:${project.id}`,
        project: { id: project.id, name: project.name, threadCount: project.threads.length },
      }));
    const byThread = new Map<string, ThreadRowData>();
    for (const { item: thread, positions } of fuzzyMatchText({
      items: recentThreads,
      query: trimmedQuery,
      getText: (thread) => getThreadDisplayTitle(thread).normalize("NFC"),
      limit: recentThreads.length,
    })
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.item.updatedAt - left.item.updatedAt,
      )
      .slice(0, THREAD_SEARCH_LIMIT_PER_GROUP)) {
      byThread.set(thread.id, {
        kind: "thread",
        id: `thread:${thread.id}`,
        thread,
        matches: [
          {
            sourceKind: "title",
            text: getThreadDisplayTitle(thread).normalize("NFC"),
            highlightRanges: positionsToRanges(positions),
            sourceSeq: null,
          },
        ],
      });
    }
    const archived: ThreadRowData[] = [];
    if (searchResultsAreCurrent && threadSearch.data) {
      for (const { thread, matches } of threadSearch.data.active.results) {
        const local = byThread.get(thread.id);
        const snippet = getSnippetMatch(matches);
        if (local) {
          if (snippet) byThread.set(thread.id, { ...local, matches: [...local.matches, snippet] });
          continue;
        }
        byThread.set(thread.id, { kind: "thread", id: `thread:${thread.id}`, thread, matches });
      }
      for (const { thread, matches } of threadSearch.data.archived.results) {
        archived.push({ kind: "thread", id: `thread:${thread.id}`, thread, matches });
      }
    }
    return { projects: projectRows, active: [...byThread.values()], archived };
  }, [
    hasQuery,
    navigationQuery.data,
    recentThreads,
    searchResultsAreCurrent,
    threadSearch.data,
    trimmedQuery,
  ]);

  const localRows = useMemo<RowData[]>(() => {
    if (!hasQuery) {
      return [...recentThreads]
        .sort((left, right) => lastInteraction(right) - lastInteraction(left))
        .slice(0, RECENT_THREAD_LIMIT)
        .map((thread) => ({
          kind: "thread",
          id: `recent:${thread.id}`,
          matches: EMPTY_MATCHES,
          thread,
        }));
    }
    return [
      ...(filters.projects ? found.projects : []),
      ...(filters.threads ? found.active : []),
      ...(filters.archived ? found.archived : []),
    ];
  }, [filters, found, hasQuery, recentThreads]);

  const isLoading =
    liveQueryIsSearchable &&
    (!searchResultsAreCurrent ||
      threadSearch.isDebouncing ||
      (threadSearch.isLoading && threadSearch.data === undefined));
  const candidates = useMemo<RowData[]>(() => {
    if (!hasQuery) return [];
    const seen = new Set(localRows.map((row) => row.id));
    const rest: RowData[] = [];
    if (filters.threads) {
      for (const thread of [...recentThreads].sort((left, right) => lastInteraction(right) - lastInteraction(left))) {
        const id = `thread:${thread.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        rest.push({ kind: "thread", id, thread, matches: EMPTY_MATCHES });
      }
    }
    if (filters.projects && navigationQuery.data) {
      for (const project of [...navigationQuery.data.projects, navigationQuery.data.personalProject]) {
        const id = `project:${project.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        rest.push({ kind: "project", id, project: { id: project.id, name: project.name, threadCount: project.threads.length } });
      }
    }
    return [...localRows, ...rest];
  }, [filters.projects, filters.threads, hasQuery, localRows, navigationQuery.data, recentThreads]);
  const jev = useJevRank(trimmedQuery, candidates, hasQuery && !isLoading, projectNamesById);
  const probabilities = jev.answer?.probabilities ?? null;

  const rows = useMemo(() => {
    const answer = jev.answer;
    if (!answer) return localRows;
    const byId = new Map(candidates.map((row) => [row.id, row]));
    const local = new Set(localRows.map((row) => row.id));
    const top = answer.ranked
      .filter((id) => id in answer.probabilities && (local.has(id) || (answer.probabilities[id] ?? 0) >= JEV_MIN_P))
      .flatMap((id) => byId.get(id) ?? []);
    const shown = new Set(top.map((row) => row.id));
    return [...top, ...localRows.filter((row) => !shown.has(row.id))];
  }, [candidates, jev.answer, localRows]);
  const navigationItems = useMemo(
    () => rows.map((row) => toNavigationItem(row, optionIdPrefix)),
    [optionIdPrefix, rows],
  );

  useEffect(() => {
    onNavigationItemsChange(navigationItems);
  }, [navigationItems, onNavigationItemsChange]);

  const archivedTotal = threadSearch.data?.archived.total ?? found.archived.length;
  const threadsTotal = hasQuery && !isLoading
    ? Math.max(found.active.length, threadSearch.data?.active.total ?? 0)
    : null;
  const projectsTotal = found.projects.length;
  useEffect(() => {
    onSummaryChange?.({
      counts: threadsTotal === null ? null : { threads: threadsTotal, projects: projectsTotal, archived: archivedTotal },
      jev: jev.state,
    });
  }, [archivedTotal, jev.state, onSummaryChange, projectsTotal, threadsTotal]);

  const hasRows = rows.length > 0;
  const showRecentLoading = !hasQuery && navigationQuery.isLoading;
  const showError = liveQueryIsSearchable && threadSearch.isError && !isLoading;
  const showNoSearchResults = hasQuery && !isLoading && !showError && !hasRows;
  const hiddenArchived = !filters.archived ? archivedTotal : 0;
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

  return (
    <div className="pb-1">
      {showRecentLoading ? (
        <ThreadSearchMessage iconName="Spinner" isLoading text="Loading threads..." />
      ) : null}
      {isLoading && !hasRows ? (
        <ThreadSearchMessage iconName="Spinner" isLoading text="Searching threads..." />
      ) : null}
      {showError ? (
        <ThreadSearchMessage iconName="AlertCircle" text="Search failed." />
      ) : null}
      {showNoSearchResults ? (
        <div className="flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground">
          <span>No results</span>
          {hiddenArchived > 0 && onIncludeArchived ? (
            <button
              type="button"
              className="text-xs text-foreground underline underline-offset-2"
              onMouseDown={(event) => event.preventDefault()}
              onClick={onIncludeArchived}
            >
              Include archived
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="space-y-0.5" onMouseLeave={() => setHoveredId(null)}>
        {rows.map((row, index) => {
          const item = navigationItems[index];
          if (!item) return null;
          const scored = probabilities?.[row.id];
          const p = scored === undefined ? null : Math.round(scored * 100);
          return (
            <ResultRow
              key={row.id}
              id={item.optionId}
              isActive={activeIndex === index}
              isHovered={hoveredId === row.id}
              p={p}
              projectName={row.kind === "thread" ? projectNamesById.get(row.thread.projectId) : undefined}
              row={row}
              onFocus={() => onActiveIndexChange(index)}
              onHover={() => setHoveredId(row.id)}
              onSelect={() => onSelect(item)}
            />
          );
        })}
      </div>
      {liveQueryIsSearchable &&
      searchResultsAreCurrent &&
      shownThreadCount < totalThreadCount ? (
        <p className="px-2 pt-1 text-xs text-subtle-foreground/70">
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
}: {
  ranges: ThreadSearchMatch["highlightRanges"];
  text: string;
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
        className="bg-transparent font-semibold text-foreground"
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

function SignalBars({ p }: { p: number }) {
  const on = p >= 50 ? 4 : p >= 15 ? 2 : p >= 5 ? 1 : 0;
  return (
    <span className="flex shrink-0 items-end gap-[1.5px]" aria-hidden>
      {[0, 1, 2, 3].map((bar) => (
        <span
          key={bar}
          className={cn("w-[3px] rounded-[1px]", bar < on ? "bg-primary" : "bg-state-hover")}
          style={{ height: 4 + bar * 2 }}
        />
      ))}
    </span>
  );
}

function LocationIcon({ thread }: { thread: ThreadListEntry }) {
  const cloud = thread.executionTarget === "cloud";
  return (
    <Icon
      name={cloud ? "Cloud" : "Laptop"}
      aria-label={cloud ? "Cloud thread" : "Local thread"}
      className={cn("size-4 shrink-0", cloud ? "text-primary [&_path]:stroke-[1.9]" : "text-muted-foreground opacity-50")}
    />
  );
}

function ThreadStatus({ thread }: { thread: ThreadListEntry }) {
  const hasUnsubmittedDraft = usePromptDraftHasInput({
    kind: "thread",
    projectId: thread.projectId,
    threadId: thread.id,
  });
  const indicatorState = threadListIndicatorStateForThread(thread, hasUnsubmittedDraft);
  if (resolveThreadListIndicator(indicatorState) === "none") return null;
  return (
    <span className="inline-flex size-4 shrink-0 items-center justify-center">
      <ThreadStatusGlyph {...indicatorState} />
    </span>
  );
}

function ResultRow({
  id,
  isActive,
  isHovered,
  onFocus,
  onHover,
  onSelect,
  p,
  projectName,
  row,
}: {
  id: string;
  isActive: boolean;
  isHovered: boolean;
  onFocus: () => void;
  onHover: () => void;
  onSelect: () => void;
  p: number | null;
  projectName: string | undefined;
  row: RowData;
}) {
  let icon: ReactNode;
  let title: ReactNode;
  let meta: ReactNode;
  if (row.kind === "project") {
    icon = <Icon name="Folder" className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
    title = row.project.name;
    meta = `Project · ${row.project.threadCount} threads`;
  } else {
    const { thread, matches } = row;
    const text = getThreadDisplayTitle(thread);
    const titleMatch = getTitleMatch(text, matches);
    const snippetMatch = getSnippetMatch(matches);
    icon = <LocationIcon thread={thread} />;
    title = <HighlightedText text={text} ranges={titleMatch?.highlightRanges ?? []} />;
    const parts = [
      thread.projectId !== PERSONAL_PROJECT_ID ? projectName : undefined,
      thread.archivedAt !== null ? "Archived" : undefined,
      formatRelativeTime({ timestamp: thread.updatedAt, now: Date.now() }),
    ].filter((part): part is string => Boolean(part));
    meta = (
      <>
        {parts.join(" · ")}
        {snippetMatch ? (
          <>
            {" · "}
            <HighlightedText text={snippetMatch.text} ranges={snippetMatch.highlightRanges} />
          </>
        ) : null}
      </>
    );
  }
  return (
    <button
      id={id}
      type="button"
      role="option"
      aria-selected={isActive}
      className={cn(
        RESULT_ROW_CLASS,
        isActive && "bg-state-hover text-foreground",
        isHovered && !isActive && "bg-state-hover/35",
      )}
      onMouseEnter={onHover}
      onFocus={onFocus}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{title}</span>
        <span className={META_CLASS}>{meta}</span>
      </span>
      {row.kind === "thread" ? <ThreadStatus thread={row.thread} /> : null}
      {p === null ? null : (
        <span className="flex shrink-0 items-center gap-2">
          {isHovered ? <span className="text-xs tabular-nums text-muted-foreground">{p}%</span> : null}
          <SignalBars p={p} />
        </span>
      )}
    </button>
  );
}

