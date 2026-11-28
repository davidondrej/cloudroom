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
  RouteAnchor,
  RouteNavigationProvider,
  useIsRouteNavigationPending,
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
