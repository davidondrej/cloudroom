// @vitest-environment jsdom

import { useSyncExternalStore } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadListEntry } from "@cloudroom/domain";
import { makeThreadListEntry } from "@cloudroom/test-helpers/domain-fixtures";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import { getThreadRoutePath } from "@/lib/route-paths";
import { ThreadTitleMentionResourcesProvider } from "@/components/thread/ThreadTitleMentions";
import { getSidebarThreadShortcutTargets } from "./sidebarThreadShortcuts";
import { getNeedsYouThreads, SidebarNeedsYou } from "./SidebarNeedsYou";

const live = vi.hoisted(() => {
  let navigation: unknown = undefined;
  const listeners = new Set<() => void>();
  return {
    get: () => navigation,
    set: (next: unknown) => {
      navigation = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: () => ({
    data: useSyncExternalStore(live.subscribe, live.get),
  }),
}));

// Opening a shortcut must never answer, approve or dismiss anything: any SDK call fails the test.
const sdkCalls = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/sdk", () => {
  const record = (path: string): unknown =>
    new Proxy(() => {}, {
      get: (_target, key) => record(`${path}.${String(key)}`),
      apply: () => {
        sdkCalls.push(path);
        return Promise.resolve([]);
      },
    });
  return { sdk: record("sdk") };
});

afterEach(() => {
  cleanup();
  live.set(undefined);
  sdkCalls.length = 0;
});

function thread(
  id: string,
  projectId: string,
  overrides: Partial<ThreadListEntry> = {},
): ThreadListEntry {
  return makeThreadListEntry({
    id,
    projectId,
    title: `Thread ${id}`,
    titleFallback: null,
    latestAttentionAt: 1,
    ...overrides,
  });
}

/** Two projects and Personal, with a child that needs the user under a parent that doesn't. */
function navigation(pendingIds: readonly string[]) {
  const pending = (id: string, projectId: string, extra = {}) =>
    thread(id, projectId, {
      hasPendingInteraction: pendingIds.includes(id),
      ...extra,
    });
  return makeSidebarBootstrapResponse({
    projects: [
      makeProjectWithThreadsResponse({
        id: "proj_a",
        name: "Alpha",
        threads: [
          pending("thr_a1", "proj_a", { latestAttentionAt: 30 }),
          pending("thr_parent", "proj_a", { latestAttentionAt: 20 }),
          pending("thr_child", "proj_a", {
            parentThreadId: "thr_parent",
            latestAttentionAt: 10,
          }),
        ],
      }),
      makeProjectWithThreadsResponse({
        id: "proj_b",
        name: "Beta",
        threads: [pending("thr_b1", "proj_b", { latestAttentionAt: 40 })],
      }),
    ],
    personalProject: makeProjectWithThreadsResponse({
      id: "proj_personal",
      kind: "personal",
      name: "Personal",
      threads: [pending("thr_p1", "proj_personal", { latestAttentionAt: 5 })],
    }),
  });
}

const PROJECT_NAMES = new Map([
  ["proj_a", "Alpha"],
  ["proj_b", "Beta"],
  ["proj_personal", "Personal"],
]);

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function renderNeedsYou(onNavigate = vi.fn(), initialPath = "/") {
  const view = render(
    <JotaiProvider store={createStore()}>
      <QueryClientProvider client={new QueryClient()}>
        <ThreadTitleMentionResourcesProvider
          sectionNamesById={new Map()}
          projectNamesById={PROJECT_NAMES}
          threadById={new Map()}
        >
          <MemoryRouter initialEntries={[initialPath]}>
            <div data-testid="sidebar-root">
              <SidebarNeedsYou onNavigate={onNavigate} />
            </div>
            <LocationProbe />
          </MemoryRouter>
        </ThreadTitleMentionResourcesProvider>
      </QueryClientProvider>
    </JotaiProvider>,
  );
  return { ...view, onNavigate };
}

function section() {
  return screen.queryByRole("region", { name: /^Needs you/ });
}

function shortcutIds(): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>("[data-needs-you-thread-id]"),
  ].map((link) => link.dataset.needsYouThreadId ?? "");
}

describe("getNeedsYouThreads", () => {
  it("lists each pending thread once across projects, newest first, including children", () => {
    const nav = navigation(["thr_a1", "thr_child", "thr_b1", "thr_p1"]);
    // The same thread reported twice (e.g. listed under two groups) still counts once.
    nav.projects[0]!.threads.push(nav.projects[0]!.threads[0]!);
    expect(getNeedsYouThreads(nav).map((entry) => entry.id)).toEqual([
      "thr_b1",
      "thr_a1",
      "thr_child",
      "thr_p1",
    ]);
  });

  it("ignores unread, hidden and archived threads", () => {
    const nav = navigation(["thr_a1", "thr_b1"]);
    nav.projects[0]!.threads[0] = {
      ...nav.projects[0]!.threads[0]!,
      visibility: "hidden",
    };
    nav.projects[1]!.threads[0] = {
      ...nav.projects[1]!.threads[0]!,
      archivedAt: 99,
    };
    nav.personalProject.threads[0] = {
      ...nav.personalProject.threads[0]!,
      lastReadAt: null,
      status: "idle",
    };
    expect(getNeedsYouThreads(nav)).toEqual([]);
    expect(getNeedsYouThreads(undefined)).toEqual([]);
  });
});

describe("SidebarNeedsYou", () => {
  it("mounts only while requests are pending and comes back for a new one", () => {
    live.set(navigation([]));
    renderNeedsYou();
    expect(screen.getByTestId("sidebar-root").innerHTML).toBe("");

    act(() => live.set(navigation(["thr_a1"])));
    expect(section()?.getAttribute("aria-label")).toBe("Needs you, 1 thread");

    act(() => live.set(navigation(["thr_a1", "thr_child", "thr_b1"])));
    expect(section()?.getAttribute("aria-label")).toBe("Needs you, 3 threads");
    expect(section()?.textContent).toContain("Needs you·3");

    // Answering one thread removes only its shortcut.
    act(() => live.set(navigation(["thr_a1", "thr_b1"])));
    expect(shortcutIds()).toEqual(["thr_b1", "thr_a1"]);
    expect(section()?.getAttribute("aria-label")).toBe("Needs you, 2 threads");

    act(() => live.set(navigation([])));
    expect(section()).toBeNull();
    expect(screen.getByTestId("sidebar-root").innerHTML).toBe("");

    act(() => live.set(navigation(["thr_p1"])));
    expect(shortcutIds()).toEqual(["thr_p1"]);
  });

  it("opens the exact original thread, even a child, without touching the request", () => {
    live.set(navigation(["thr_a1", "thr_child"]));
    const { onNavigate } = renderNeedsYou();

    const link = screen.getByRole("link", {
      name: "Open Thread thr_child in Alpha (needs you)",
    });
    fireEvent.click(link);

    expect(screen.getByTestId("location").textContent).toBe(
      getThreadRoutePath({ projectId: "proj_a", threadId: "thr_child" }),
    );
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(sdkCalls).toEqual([]);
    // Still listed (and marked current) until the request is actually resolved.
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(shortcutIds()).toEqual(["thr_a1", "thr_child"]);
  });

  it("uses real links in tab order and stays out of the thread list shortcuts", () => {
    live.set(navigation(["thr_a1", "thr_b1"]));
    renderNeedsYou();

    for (const link of screen.getAllByRole("link")) {
      expect(link.tagName).toBe("A");
      expect(link.getAttribute("href")).toMatch(/thr_/);
      expect(link.getAttribute("tabindex")).toBeNull();
    }
    expect(screen.getByRole("list").children).toHaveLength(2);
    // Cmd+1-9 and next/previous thread read rows from the list; shortcuts must not add duplicates.
    expect(
      getSidebarThreadShortcutTargets(screen.getByTestId("sidebar-root")),
    ).toEqual([]);
  });

  it("shows every pending thread, with no cap, inner scroll or show-more", () => {
    const ids = ["thr_a1", "thr_parent", "thr_child", "thr_b1", "thr_p1"];
    live.set(navigation(ids));
    renderNeedsYou();

    const panel = screen.getByTestId("sidebar-needs-you");
    expect(shortcutIds()).toHaveLength(ids.length);
    for (const element of [panel, ...panel.querySelectorAll("*")]) {
      expect(element.className.toString()).not.toMatch(
        /max-h-|overflow-(y-)?(auto|scroll|hidden)/,
      );
    }
    expect(screen.queryByRole("button")).toBeNull();
  });
});
