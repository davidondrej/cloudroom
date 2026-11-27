// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  type NavigateFunction,
} from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppBrowserRouter,
  PluginDetailRouteNavigationProvider,
  RouteAnchor,
  RouteNavigationProvider,
  useIsRouteNavigationPending,
  useRouteAnchorDelegate,
} from "./app-route-anchor";

const openPaneContentInSplit = vi.hoisted(() => vi.fn());

vi.mock("@/lib/split-layout/openPaneContentInSplit", () => ({
  openPaneContentInSplit,
}));

afterEach(() => {
  cleanup();
  openPaneContentInSplit.mockReset();
});

interface NavigationSample {
  isPending: boolean;
  pathname: string;
}

const samples: NavigationSample[] = [];

function NavigationSampler() {
  const isPending = useIsRouteNavigationPending();
  const { pathname } = useLocation();
  samples.push({ isPending, pathname });
  return null;
}

function PluginDetailLinkDelegate() {
  const onRouteAnchorClick = useRouteAnchorDelegate();
  return (
    <div onClick={onRouteAnchorClick}>
      <a href="/plugins/secrets">Open Secrets plugin</a>
    </div>
  );
}

function CurrentPath() {
  return <output data-testid="current-path">{useLocation().pathname}</output>;
}

describe("RouteAnchor transition navigation", () => {
  it("swaps the route in a later commit than the tap and signals pending in between", () => {
    samples.length = 0;
    render(
      <MemoryRouter initialEntries={["/threads/thr-old"]}>
        <RouteNavigationProvider>
          <NavigationSampler />
          <RouteAnchor href="/threads/thr-new">open thr-new</RouteAnchor>
        </RouteNavigationProvider>
      </MemoryRouter>,
    );
    expect(samples).toEqual([
      { isPending: false, pathname: "/threads/thr-old" },
    ]);

    fireEvent.click(screen.getByRole("link", { name: "open thr-new" }));

    expect(samples).toContainEqual({
      isPending: true,
      pathname: "/threads/thr-old",
    });
    expect(samples.at(-1)).toEqual({
      isPending: false,
      pathname: "/threads/thr-new",
    });
  });
});

describe("AppBrowserRouter", () => {
  it.each([
    ["project", "/projects/p/threads"],
    ["projectless", "/threads"],
  ])(
    "commits a slow %s thread route change while a sync store ticks faster than it renders",
    async (_, base) => {
      const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
      const usedAct = env.IS_REACT_ACT_ENVIRONMENT;
      env.IS_REACT_ACT_ENVIRONMENT = false; // act() would flush the transition at once
      window.history.replaceState(null, "", `${base}/a`);
      let tick = 0;
      let onTick = () => {};
      const timer = setInterval(() => {
        tick += 1;
        onTick();
      }, 40);
      let navigate: NavigateFunction | undefined;
      let committedAt = 0;
      function Navigator() {
        const current = useNavigate();
        useLayoutEffect(() => void (navigate = current));
        return null;
      }
      function Ticker() {
        return useSyncExternalStore(
          (listener) => ((onTick = listener), () => {}),
          () => tick,
        );
      }
      function SlowRow() {
        const end = performance.now() + 1;
        while (performance.now() < end);
        return null;
      }
      function SlowPage() {
        useLayoutEffect(() => void (committedAt = performance.now()), []);
        return Array.from({ length: 150 }, (_, i) => <SlowRow key={i} />);
      }
      const root = createRoot(document.createElement("div"));
      root.render(
        <AppBrowserRouter>
          <Navigator />
          <Ticker />
          <Routes>
            <Route path={`${base}/a`} element={null} />
            <Route path={`${base}/b`} element={<SlowPage />} />
          </Routes>
        </AppBrowserRouter>,
      );
      await vi.waitFor(() => expect(navigate).toBeDefined());
      const startedAt = performance.now();
      void navigate?.(`${base}/b`);
      // React restarts the transition on every tick; without a fallback it waits for its 5 s expiry.
      await vi.waitFor(() => expect(committedAt).toBeGreaterThan(0), {
        timeout: 6_000,
      });
      clearInterval(timer);
      root.unmount();
      env.IS_REACT_ACT_ENVIRONMENT = usedAct;
      expect(committedAt - startedAt).toBeLessThan(2_000);
    },
  );
});

describe("useRouteAnchorDelegate plugin-detail links", () => {
  it("opens plugin-detail links in a split when no plugin-detail navigation is provided", () => {
    render(
      <MemoryRouter initialEntries={["/threads/thr-current"]}>
        <RouteNavigationProvider>
          <CurrentPath />
          <PluginDetailLinkDelegate />
        </RouteNavigationProvider>
      </MemoryRouter>,
    );

    const notPrevented = fireEvent.click(
      screen.getByRole("link", { name: "Open Secrets plugin" }),
    );

    expect(notPrevented).toBe(false);
    expect(openPaneContentInSplit).toHaveBeenCalledTimes(1);
    expect(openPaneContentInSplit).toHaveBeenCalledWith(
      expect.objectContaining({
        content: { kind: "plugin-detail", pluginId: "secrets" },
        route: "/plugins/secrets",
      }),
    );
    expect(screen.getByTestId("current-path").textContent).toBe(
      "/threads/thr-current",
    );
  });

  it("lets a plugin-detail navigation provider handle the link without opening a split", () => {
    const onOpenPluginDetail = vi.fn(() => true);
    render(
      <MemoryRouter initialEntries={["/threads/thr-current"]}>
        <RouteNavigationProvider>
          <CurrentPath />
          <PluginDetailRouteNavigationProvider
            onOpenPluginDetail={onOpenPluginDetail}
          >
            <PluginDetailLinkDelegate />
          </PluginDetailRouteNavigationProvider>
        </RouteNavigationProvider>
      </MemoryRouter>,
    );

    const notPrevented = fireEvent.click(
      screen.getByRole("link", { name: "Open Secrets plugin" }),
    );

    expect(notPrevented).toBe(false);
    expect(onOpenPluginDetail).toHaveBeenCalledWith("secrets");
    expect(openPaneContentInSplit).not.toHaveBeenCalled();
    expect(screen.getByTestId("current-path").textContent).toBe(
      "/threads/thr-current",
    );
  });
});
