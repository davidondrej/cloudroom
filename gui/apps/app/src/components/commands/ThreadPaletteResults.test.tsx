// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadListEntry } from "@cloudroom/domain";
import type {
  ThreadSearchMatch,
  ThreadSearchResponse,
  SidebarBootstrapResponse,
} from "@cloudroom/server-contract";
import {
  useThreadSearch,
  type UseThreadSearchResult,
} from "@/hooks/queries/thread-queries";
import {
  ThreadPaletteResults,
  type ThreadPaletteNavigationItem,
} from "./ThreadPaletteResults";
import { makeThreadListEntry } from "@cloudroom/test-helpers/domain-fixtures";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";

const navigation = vi.hoisted(() => ({
  data: undefined as SidebarBootstrapResponse | undefined,
  isLoading: false,
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  hasThreadSearchableQuery: (value: string) =>
    value.replace(/\s/g, "").length >= 2,
  THREAD_SEARCH_LIMIT_PER_GROUP: 20,
  useThreadSearch: vi.fn(),
}));

vi.mock("@/lib/sdk", () => ({
  sdk: { cloudroom: { searchRank: () => new Promise(() => {}) } },
}));

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: () => navigation,
}));

vi.mock("@/components/thread/ThreadTitleMentions", () => ({
  useThreadTitleMentionResources: () => ({
    projectNamesById: new Map<string, string>(),
  }),
}));

const mockUseThreadSearch = vi.mocked(useThreadSearch);

function createThreadListEntry({
  id,
  title,
}: {
  id: string;
  title: string;
}): ThreadListEntry {
  return makeThreadListEntry({
    createdAt: 1000,
    id,
    lastReadAt: null,
    latestAttentionAt: 1000,
    projectId: "proj_search",
    title,
    updatedAt: 1000,
  });
}

function createSearchResponse(
  thread: ThreadListEntry,
  matches: readonly ThreadSearchMatch[] = [],
): ThreadSearchResponse {
  return {
    active: { results: [{ matches: [...matches], thread }], total: 1 },
    archived: { results: [], total: 0 },
  };
}

function mockThreadSearch(result: UseThreadSearchResult): void {
  mockUseThreadSearch.mockReturnValue(result);
}

function renderResults({
  onNavigationItemsChange = vi.fn(),
  onSelect = vi.fn(),
  query,
}: {
  onNavigationItemsChange?: (
    items: readonly ThreadPaletteNavigationItem[],
  ) => void;
  onSelect?: (item: ThreadPaletteNavigationItem) => void;
  query: string;
}) {
  return render(
    <ThreadPaletteResults
      activeIndex={0}
      onActiveIndexChange={vi.fn()}
      onNavigationItemsChange={onNavigationItemsChange}
      onSelect={onSelect}
      optionIdPrefix="palette-option"
      query={query}
    />,
  );
}

afterEach(() => {
  cleanup();
  navigation.data = undefined;
  window.localStorage.clear();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("ThreadPaletteResults", () => {
  it("clears stale rows while the visible query is debouncing", () => {
    mockThreadSearch({
      data: createSearchResponse(
        createThreadListEntry({ id: "thr_previous", title: "Previous needle" }),
      ),
      debouncedQuery: "needle",
      hasSearchableQuery: true,
      isDebouncing: true,
      isError: false,
      isFetching: false,
      isLoading: false,
    });

    renderResults({ query: "needle updated" });

    expect(screen.getByText("Searching threads...")).not.toBeNull();
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("uses the palette option prefix for the active row", () => {
    mockThreadSearch({
      data: createSearchResponse(
        createThreadListEntry({ id: "thr_current", title: "Current needle" }),
      ),
      debouncedQuery: "needle",
      hasSearchableQuery: true,
      isDebouncing: false,
      isError: false,
      isFetching: false,
      isLoading: false,
    });

    renderResults({ query: "needle" });

    expect(screen.getByRole("option").id).toBe(
      "palette-option-thread:thr_current",
    );
  });

  it("keeps the matched message sequence in its navigation item", async () => {
    const onNavigationItemsChange = vi.fn();
    const messageMatch: ThreadSearchMatch = {
      highlightRanges: [{ start: 0, end: 6 }],
      sourceKind: "user_message",
      sourceSeq: 7,
      text: "Needle in a message",
    };
    mockThreadSearch({
      data: createSearchResponse(
        createThreadListEntry({ id: "thr_message", title: "Message match" }),
        [messageMatch],
      ),
      debouncedQuery: "needle",
      hasSearchableQuery: true,
      isDebouncing: false,
      isError: false,
      isFetching: false,
      isLoading: false,
    });

    renderResults({ onNavigationItemsChange, query: "needle" });

    expect(
      screen.getByRole("option").querySelector("mark.bg-destructive"),
    ).toBeNull();
    expect(screen.getByRole("option").querySelector("mark")?.textContent).toBe(
      "Needle",
    );
    await waitFor(() =>
      expect(onNavigationItemsChange).toHaveBeenLastCalledWith([
        expect.objectContaining({ threadId: "thr_message", messageSeq: 7 }),
      ]),
    );
  });

  it.each([
    { sourceKind: "title", withSnippet: true, archived: false },
    { sourceKind: "title_fallback", withSnippet: true, archived: true },
    { sourceKind: "title", withSnippet: false, archived: false },
    { sourceKind: "title_fallback", withSnippet: false, archived: true },
  ] as const)(
    "highlights $sourceKind in bold (snippet: $withSnippet, archived: $archived)",
    ({ sourceKind, withSnippet, archived }) => {
      const title = "Claude Code support";
      const thread = createThreadListEntry({ id: "thr_title", title });
      if (sourceKind === "title_fallback") {
        thread.title = null;
        thread.titleFallback = title;
      }
      const highlightRanges = [
        { start: 0, end: 6 },
        { start: 7, end: 11 },
      ];
      const matches: ThreadSearchMatch[] = [
        { sourceKind, sourceSeq: null, text: title, highlightRanges },
      ];
      if (withSnippet) {
        matches.push({
          sourceKind: "assistant_message",
          sourceSeq: 7,
          text: "Claude Code adapter support",
          highlightRanges,
        });
      }
      const data = createSearchResponse(thread, matches);
      if (archived) {
        thread.archivedAt = 1000;
        data.archived = data.active;
        data.active = { results: [], total: 0 };
      }
      mockThreadSearch({
        data,
        debouncedQuery: "claude code",
        hasSearchableQuery: true,
        isDebouncing: false,
        isError: false,
        isFetching: false,
        isLoading: false,
      });

      renderResults({ query: "claude code" });

      const row = screen.getByRole("option");
      expect(row.textContent).toContain(title);
      if (archived) expect(row.textContent).toContain("Archived");
      const marks = [...row.querySelectorAll("mark")];
      expect(marks.every((mark) => mark.classList.contains("font-semibold"))).toBe(true);
      expect(marks.map((mark) => mark.textContent)).toEqual(
        withSnippet ? ["Claude", "Code", "Claude", "Code"] : ["Claude", "Code"],
      );
    },
  );

  it("lists a server title hit inside a word", () => {
    const title = "CloudRoom UI — design evolution · coordinator";
    const start = title.indexOf("oord");
    const contentMatch: ThreadSearchMatch = {
      sourceKind: "assistant_message",
      sourceSeq: 7,
      text: "The coordinator merged it",
      highlightRanges: [{ start: 5, end: 9 }],
    };
    const data = createSearchResponse(
      createThreadListEntry({ id: "thr_inside", title }),
      [
        {
          sourceKind: "title",
          sourceSeq: null,
          text: title,
          highlightRanges: [{ start, end: start + 4 }],
        },
        contentMatch,
      ],
    );
    data.active.results.push({
      thread: createThreadListEntry({ id: "thr_chat", title: "Other work" }),
      matches: [contentMatch],
    });
    data.active.total = 2;
    mockThreadSearch({
      data,
      debouncedQuery: "oord",
      hasSearchableQuery: true,
      isDebouncing: false,
      isError: false,
      isFetching: false,
      isLoading: false,
    });

    renderResults({ query: "oord" });

    expect(screen.getAllByRole("option").map((row) => row.id)).toEqual([
      "palette-option-thread:thr_inside",
      "palette-option-thread:thr_chat",
    ]);
  });

  it("lists projects before threads, each with its navigation target", async () => {
    const onNavigationItemsChange = vi.fn();
    const onSelect = vi.fn();
    const thread = createThreadListEntry({
      id: "thr_needle",
      title: "Needle thread",
    });
    navigation.data = makeSidebarBootstrapResponse({
      projects: [
        makeProjectWithThreadsResponse({
          id: "proj_match",
          name: "Needle project",
        }),
        makeProjectWithThreadsResponse({ id: "proj_other", name: "Other" }),
      ],
    });
    const highlightRanges = [{ start: 0, end: 6 }];
    const contentMatch: ThreadSearchMatch = {
      sourceKind: "user_message",
      sourceSeq: 7,
      text: "Needle message",
      highlightRanges,
    };
    const data = createSearchResponse(thread, [
      {
        sourceKind: "title",
        sourceSeq: null,
        text: thread.title!,
        highlightRanges,
      },
      contentMatch,
    ]);
    data.active.results.unshift({
      thread: createThreadListEntry({
        id: "thr_content",
        title: "Other conversation",
      }),
      matches: [contentMatch],
    });
    data.active.total = 2;
    mockThreadSearch({
      data,
      debouncedQuery: "needle",
      hasSearchableQuery: true,
      isDebouncing: false,
      isError: false,
      isFetching: false,
      isLoading: false,
    });

    renderResults({ query: "needle", onNavigationItemsChange, onSelect });

    const rows = screen.getAllByRole("option");
    expect(rows[0]?.textContent).toContain("Needle project");
    expect(rows[1]?.textContent).toContain("Other conversation");
    expect(rows[2]?.textContent).toContain("Needle thread");
    await waitFor(() =>
      expect(onNavigationItemsChange).toHaveBeenLastCalledWith([
        expect.objectContaining({
          projectId: "proj_match",
          threadId: null,
          messageSeq: null,
        }),
        expect.objectContaining({ threadId: "thr_content", messageSeq: 7 }),
        expect.objectContaining({ threadId: "thr_needle", messageSeq: null }),
      ]),
    );
    fireEvent.click(rows[0]!);
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectId: "proj_match", threadId: null }),
    );
    fireEvent.click(rows[1]!);
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadId: "thr_content", messageSeq: 7 }),
    );
    fireEvent.click(rows[2]!);
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadId: "thr_needle", messageSeq: null }),
    );
  });

  it.each(["debouncing", "failed", "empty"])(
    "keeps project matches when thread search is %s",
    (state) => {
      navigation.data = makeSidebarBootstrapResponse({
        projects: [makeProjectWithThreadsResponse({ name: "Needle project" })],
      });
      mockThreadSearch({
        data: {
          active: { results: [], total: 0 },
          archived: { results: [], total: 0 },
        },
        debouncedQuery: state === "debouncing" ? "previous" : "needle",
        hasSearchableQuery: true,
        isDebouncing: state === "debouncing",
        isError: state === "failed",
        isFetching: false,
        isLoading: false,
      });
      renderResults({ query: "needle" });
      expect(screen.getByRole("option").textContent).toContain("Needle project");
      expect(screen.queryByText("No results")).toBeNull();
      if (state === "failed")
        expect(screen.getByText("Search failed.")).not.toBeNull();
    },
  );

  it("shows an archived overflow count", () => {
    const archivedThread = createThreadListEntry({
      id: "thr_archived",
      title: "Archived cleanup",
    });
    archivedThread.archivedAt = 1000;
    mockThreadSearch({
      data: {
        active: { results: [], total: 0 },
        archived: {
          results: [{ matches: [], thread: archivedThread }],
          total: 3,
        },
      },
      debouncedQuery: "cleanup",
      hasSearchableQuery: true,
      isDebouncing: false,
      isError: false,
      isFetching: false,
      isLoading: false,
    });

    renderResults({ query: "cleanup" });

    expect(screen.getByRole("option").textContent).toContain("Archived · ");
    expect(
      screen.getByText("Showing 1 of 3 threads. Refine your search."),
    ).not.toBeNull();
  });
});
