// @vitest-environment jsdom

import { useSyncExternalStore } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@cloudroom/shared-ui/tooltip";
import { makeThreadListEntry } from "@cloudroom/test-helpers/domain-fixtures";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import { ProjectList } from "./ProjectList";
import { collapsedProjectIdsAtom } from "./sidebarCollapsedAtoms";

const live = vi.hoisted(() => {
  let state = { navigation: undefined as unknown, threadId: "thr_open" };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (next: Partial<typeof state>) => {
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

function useLive() {
  return useSyncExternalStore(live.subscribe, live.get);
}

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: () => ({
    data: useLive().navigation,
    isFetching: false,
    isLoadingError: false,
    error: null,
  }),
}));
vi.mock("@/hooks/useRouteState", () => ({
  useRouteState: () => ({ threadId: useLive().threadId }),
}));
vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({ data: [] }),
  usePrimaryHost: () => undefined,
}));
vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({ data: undefined }),
  useSystemProviders: () => ({ data: undefined }),
  useUiPreferences: () => ({ data: {}, isError: false }),
}));
vi.mock("./ThreadRow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ThreadRow")>()),
  ThreadRow: () => null,
}));

function makeNavigation(runningUpdatedAt: number) {
  return makeSidebarBootstrapResponse({
    projects: [
      makeProjectWithThreadsResponse({
        id: "proj_music",
        threads: ["thr_open", "thr_other", "thr_running"].map((id) =>
          makeThreadListEntry({
            id,
            projectId: "proj_music",
            updatedAt: id === "thr_running" ? runningUpdatedAt : 1,
          }),
        ),
      }),
    ],
  });
}

function renderSidebar() {
  const store = createStore();
  const sidebar = (
    <JotaiProvider store={store}>
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <TooltipProvider>
            <ProjectList />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </JotaiProvider>
  );
  const view = render(sidebar);
  const collapse = () =>
    act(() => store.set(collapsedProjectIdsAtom, ["proj_music"]));
  return {
    collapse,
    collapsed: () => store.get(collapsedProjectIdsAtom),
    remount: () => {
      view.unmount();
      render(sidebar);
    },
  };
}

afterEach(() => {
  cleanup();
  live.set({ navigation: undefined, threadId: "thr_open" });
});

describe("revealing the open thread in the sidebar", () => {
  it("keeps its collapsed project shut through live updates and remounts", () => {
    live.set({ navigation: makeNavigation(1) });
    const sidebar = renderSidebar();
    sidebar.collapse();

    act(() => live.set({ navigation: makeNavigation(2) }));
    expect(sidebar.collapsed()).toEqual(["proj_music"]);

    sidebar.remount();
    expect(sidebar.collapsed()).toEqual(["proj_music"]);
  });

  it("expands the project when another of its threads is opened", () => {
    live.set({ navigation: makeNavigation(1) });
    const sidebar = renderSidebar();
    sidebar.collapse();

    act(() => live.set({ threadId: "thr_other" }));
    expect(sidebar.collapsed()).toEqual([]);
  });
});
