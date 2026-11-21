// @vitest-environment jsdom

import { Provider, createStore } from "jotai";
import { makeThread } from "@cloudroom/test-helpers/domain-fixtures";
import { createDeferredPromise } from "@cloudroom/test-helpers";
import { threadQueryKey, threadsQueryKey } from "@/hooks/queries/query-keys";
import { appToast } from "@/components/ui/app-toast";
import SplitWorkspaceRoute from "@/views/SplitWorkspaceRoute";
import type { SplitLayout } from "@/lib/split-layout";
import { maximizedPaneIdAtom, splitLayoutAtom } from "@/lib/split-layout/atoms";
import { memo, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RouteNavigationProvider,
  useRouteNavigate,
} from "@/components/ui/app-route-anchor";
import {
  ThreadActionsProvider,
  useThreadActions,
  type ThreadActionsContextValue,
} from "./ThreadActionsProvider";

vi.mock("@/views/thread-detail/ThreadDetailView", () => ({
  ThreadDetailView: ({ threadId }: { threadId: string }) => (
    <div>{threadId}</div>
  ),
}));
vi.mock("@/views/RootComposeView", () => ({
  RootComposeView: () => <div>Compose</div>,
}));
vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useThreadDetailRealtimeSubscription: () => undefined,
  useThreadListRealtimeSubscription: () => undefined,
}));
vi.mock("@/components/commands/AppCommandProvider", () => ({
  useAppCommandContext: () => undefined,
  useAppCommandHandler: () => undefined,
  useIndexedAppCommandHandlers: () => undefined,
  useAppCommandShortcut: () => null,
  useIsAppCommandModifierHeld: () => false,
}));
const archiveAll = vi.hoisted(() => vi.fn());
vi.mock("@/components/dialogs/ThreadDeleteDialog", () => ({
  ThreadDeleteDialog: () => null,
}));

vi.mock("@/components/dialogs/ThreadRenameDialog", () => ({
  ThreadRenameDialog: () => null,
}));

vi.mock("@/hooks/mutations/thread-state-mutations", () => {
  const mutationResult = { isPending: false, mutate: vi.fn() };
  const mutation = () => mutationResult;
  return {
    useArchiveThreadAndChildren: () => ({ mutateAsync: archiveAll }),
    useDeleteThread: mutation,
    useMarkThreadRead: mutation,
    useMarkThreadUnread: mutation,
    usePinThread: mutation,
    useUnarchiveThread: mutation,
    useUnpinThread: mutation,
    useUpdateThread: mutation,
  };
});

vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { get: () => new Promise(() => {}), childSummary: vi.fn() } },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

const consumerRenders: ThreadActionsContextValue[] = [];

const ActionsConsumer = memo(function ActionsConsumer() {
  consumerRenders.push(useThreadActions());
  return null;
});

const routeNavigateIdentities: ReturnType<typeof useRouteNavigate>[] = [];

const RouteNavigateConsumer = memo(function RouteNavigateConsumer() {
  routeNavigateIdentities.push(useRouteNavigate());
  return null;
});

function NavigationProbe() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <output data-testid="pathname">{location.pathname}</output>
      <button type="button" onClick={() => navigate("/projects/p1/threads/t2")}>
        go to t2
      </button>
    </>
  );
}

function navigateToT2(): void {
  fireEvent.click(screen.getByRole("button", { name: "go to t2" }));
}

function renderTree(children: ReactNode, queryClient = new QueryClient()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/projects/p1/threads/t1"]}>
        <RouteNavigationProvider>
          <NavigationProbe />
          {children}
        </RouteNavigationProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ThreadActionsProvider across navigations", () => {
  it("keeps the context value and memoized consumers stable when the route changes", () => {
    consumerRenders.length = 0;
    renderTree(
      <ThreadActionsProvider>
        <ActionsConsumer />
      </ThreadActionsProvider>,
    );
    expect(consumerRenders).toHaveLength(1);

    navigateToT2();
    expect(screen.getByTestId("pathname").textContent).toBe(
      "/projects/p1/threads/t2",
    );
    expect(consumerRenders).toHaveLength(1);
  });
});

describe("useRouteNavigate", () => {
  it("does not re-render its caller on navigation and navigates with options", () => {
    routeNavigateIdentities.length = 0;
    renderTree(<RouteNavigateConsumer />);
    expect(routeNavigateIdentities).toHaveLength(1);

    navigateToT2();
    expect(routeNavigateIdentities).toHaveLength(1);

    const navigate = routeNavigateIdentities[0];
    act(() => {
      navigate?.("/projects/p1/threads/t3", {
        replace: true,
        state: { focusPrompt: true },
      });
    });
    expect(screen.getByTestId("pathname").textContent).toBe(
      "/projects/p1/threads/t3",
    );
  });
});

it.each([
  { panes: "single", action: "cancel" },
  { panes: "family", action: "undo" },
  { panes: "family", action: "failure" },
  { panes: "survivor", action: "cancel" },
  { panes: "single", action: "navigate" },
  { panes: "survivors", action: "resize" },
])(
  "preserves the right route and panes after archive ($panes, $action)",
  async ({ panes, action }) => {
    const store = createStore();
    const queryClient = new QueryClient();
    const ids =
      panes === "single"
        ? ["t1"]
        : panes === "survivors"
          ? ["t1", "t2", "t3"]
          : ["t1", "t2"];
    const threads = ids.map((id) =>
      makeThread({
        id,
        projectId: "p1",
        executionTarget: "cloud",
        parentThreadId: panes === "family" && id === "t2" ? "t1" : null,
      }),
    );
    queryClient.setQueryData(threadsQueryKey(), threads);
    for (const thread of threads)
      queryClient.setQueryData(threadQueryKey(thread.id), thread);
    const children = ids.map((id) => ({
      type: "pane" as const,
      paneId: id,
      content: { kind: "thread" as const, projectId: "p1", threadId: id },
    }));
    const layout: SplitLayout = {
      root:
        ids.length === 1
          ? children[0]!
          : {
              type: "split",
              dir: "row",
              sizes: ids.map(() => 1 / ids.length),
              children,
            },
      focusedPaneId: "t1",
    };
    store.set(splitLayoutAtom, layout);
    store.set(maximizedPaneIdAtom, panes === "family" ? "t1" : null);
    const check = createDeferredPromise<Response>();
    vi.stubGlobal("fetch", () => check.promise);
    const loading = vi.spyOn(appToast, "loading");
    function Controls() {
      const actions = useThreadActions();
      return (
        <button onClick={() => actions.archiveThreadAndChildren(threads[0]!)}>
          Archive
        </button>
      );
    }
    renderTree(
      <Provider store={store}>
        <ThreadActionsProvider>
          <Controls />
          <SplitWorkspaceRoute />
        </ThreadActionsProvider>
      </Provider>,
      queryClient,
    );
    const before = store.get(splitLayoutAtom);
    const maximized = store.get(maximizedPaneIdAtom);
    fireEvent.click(screen.getByText("Archive"));
    const hasSurvivor = panes.startsWith("survivor");
    expect(screen.getByTestId("pathname").textContent).toBe(
      hasSurvivor ? "/projects/p1/threads/t2" : "/",
    );
    if (action === "navigate") navigateToT2();
    const remaining = store.get(splitLayoutAtom)!;
    if (action === "resize") {
      if (remaining.root.type !== "split")
        throw new Error("Expected two surviving panes");
      const resized = {
        ...remaining,
        root: { ...remaining.root, sizes: [0.7, 0.3] },
      };
      act(() => store.set(splitLayoutAtom, resized));
    }
    const afterUserAction = store.get(splitLayoutAtom);
    if (action === "undo") {
      const undo = loading.mock.calls.at(-1)?.[1]?.cancel;
      expect(undo?.label).toBe("Undo");
      act(() => undo!.onClick({} as React.MouseEvent<HTMLButtonElement>));
      await act(async () => check.resolve(Response.json({ running: [] })));
    } else if (action === "failure") {
      archiveAll.mockRejectedValueOnce(new Error("archive failed"));
      await act(async () => check.resolve(Response.json({ running: [] })));
    } else {
      await act(async () => check.resolve(Response.json({ running: ["t1"] })));
      fireEvent.click(await screen.findByText("Cancel"));
    }
    const edited = action === "navigate" || action === "resize";
    expect(screen.getByTestId("pathname").textContent).toBe(
      edited ? "/projects/p1/threads/t2" : "/projects/p1/threads/t1",
    );
    expect(store.get(splitLayoutAtom)).toEqual(
      edited ? afterUserAction : before,
    );
    expect(store.get(maximizedPaneIdAtom)).toBe(maximized);
  },
);
