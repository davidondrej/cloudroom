// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSidebarThreadNavigationTargets,
  getSidebarThreadShortcutTargets,
  revealSidebarThread,
} from "./sidebarThreadShortcuts";

function makeRect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 240,
    width: 240,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function createScrollableSidebar(options: {
  viewportHeight: number;
  contentHeight: number;
  initialScrollTop?: number;
}) {
  const root = document.createElement("aside");
  const scroller = document.createElement("div");
  scroller.dataset.sidebar = "content";
  scroller.scrollTop = options.initialScrollTop ?? 0;
  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    value: options.viewportHeight,
  });
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    value: options.contentHeight,
  });
  scroller.getBoundingClientRect = () => makeRect(0, options.viewportHeight);
  root.append(scroller);

  const addRow = (threadId: string, contentTop: number, height = 30) => {
    const row = appendShortcutTarget(scroller, threadId);
    row.getBoundingClientRect = () =>
      makeRect(contentTop - scroller.scrollTop, height);
    return row;
  };

  const addStickyTier = (
    tier: string,
    contentTop: number,
    stickyTop: number,
    height: number,
  ) => {
    const el = document.createElement("div");
    el.dataset.sidebarStickyTier = tier;
    el.style.top = `${stickyTop}px`;
    el.getBoundingClientRect = () =>
      makeRect(Math.max(stickyTop, contentTop - scroller.scrollTop), height);
    scroller.append(el);
    return el;
  };

  const addPlaceholder = (
    encoded: string,
    contentTop: number,
    height = 30,
  ) => {
    const placeholder = document.createElement("div");
    placeholder.setAttribute("data-sidebar-windowed-nav", encoded);
    placeholder.getBoundingClientRect = () =>
      makeRect(contentTop - scroller.scrollTop, height);
    scroller.append(placeholder);
    return placeholder;
  };

  return { root, scroller, addRow, addStickyTier, addPlaceholder };
}

function appendShortcutTarget(root: HTMLElement, threadId?: string) {
  const target = document.createElement("a");
  target.dataset.sidebarThreadShortcutTarget = "";
  if (threadId) {
    target.dataset.sidebarThreadId = threadId;
  }
  root.append(target);
  return target;
}

describe("sidebar thread shortcuts", () => {
  it("assigns 1 through 9 in rendered row order", () => {
    const root = document.createElement("aside");
    appendShortcutTarget(root);
    const elements = Array.from({ length: 10 }, (_, index) =>
      appendShortcutTarget(root, `thr_${index + 1}`),
    );

    const targets = getSidebarThreadShortcutTargets(root);

    expect(targets).toHaveLength(9);
    expect(
      targets.map(({ element, key, threadId }) => ({ element, key, threadId })),
    ).toEqual(
      elements.slice(0, 9).map((element, index) => ({
        element,
        key: String(index + 1),
        threadId: `thr_${index + 1}`,
      })),
    );
    expect(getSidebarThreadNavigationTargets(root)).toHaveLength(10);
  });

  it("includes windowed-out placeholder threads in navigation order", () => {
    const root = document.createElement("aside");
    appendShortcutTarget(root, "thr_a");
    const placeholder = document.createElement("div");
    placeholder.setAttribute(
      "data-sidebar-windowed-nav",
      "thr_b:proj_1 thr_c:proj_2",
    );
    root.append(placeholder);
    appendShortcutTarget(root, "thr_d");

    const navigation = getSidebarThreadNavigationTargets(root);
    expect(
      navigation.map(({ threadId, projectId, element }) => ({
        threadId,
        projectId,
        mounted: element !== null,
      })),
    ).toEqual([
      { threadId: "thr_a", projectId: null, mounted: true },
      { threadId: "thr_b", projectId: "proj_1", mounted: false },
      { threadId: "thr_c", projectId: "proj_2", mounted: false },
      { threadId: "thr_d", projectId: null, mounted: true },
    ]);

    expect(
      getSidebarThreadShortcutTargets(root).map((target) => target.threadId),
    ).toEqual(["thr_a", "thr_d"]);
  });

  describe("revealSidebarThread", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("centers an off-screen row below the viewport under sticky headers", () => {
      const { root, scroller, addRow, addStickyTier } = createScrollableSidebar(
        { viewportHeight: 600, contentHeight: 1600 },
      );
      addStickyTier("top-slot", 0, 0, 40);
      addStickyTier("label", 40, 40, 20);
      const row = addRow("thr_last_pinned", 700, 30);

      revealSidebarThread(root, "thr_last_pinned");

      // Unobstructed viewport is [60, 600], midpoint = 330.
      // Row center (contentTop 700 + 15 = 715) lands at 330 => scrollTop = 385.
      expect(scroller.scrollTop).toBe(385);
      expect(row.getBoundingClientRect().top).toBe(315);
    });

    it("centers an off-screen row above the viewport and clamps near-top rows to 0", () => {
      const { root, scroller, addRow } = createScrollableSidebar({
        viewportHeight: 600,
        contentHeight: 1600,
        initialScrollTop: 900,
      });
      addRow("thr_top", 60, 30);
      addRow("thr_mid", 500, 30);

      revealSidebarThread(root, "thr_mid");
      expect(scroller.scrollTop).toBe(215);

      scroller.scrollTop = 900;
      revealSidebarThread(root, "thr_top");
      expect(scroller.scrollTop).toBe(0);
    });

    it("does not scroll when the target row is already fully visible", () => {
      const { root, scroller, addRow } = createScrollableSidebar({
        viewportHeight: 600,
        contentHeight: 1600,
        initialScrollTop: 100,
      });
      addRow("thr_visible", 580, 30);

      revealSidebarThread(root, "thr_visible");

      expect(scroller.scrollTop).toBe(100);
    });

    it("centers a row that is 100% covered by a sticky header", () => {
      const { root, scroller, addRow, addStickyTier } = createScrollableSidebar(
        { viewportHeight: 600, contentHeight: 1600, initialScrollTop: 500 },
      );
      addStickyTier("top-slot", 0, 0, 40);
      addRow("thr_covered", 510, 30);

      revealSidebarThread(root, "thr_covered");

      // Unobstructed viewport is [40, 600], midpoint = 320.
      // Row center (525) lands at 320 => scrollTop = 205.
      expect(scroller.scrollTop).toBe(205);
    });

    it("nudges a partly clipped bottom row without jumping to center", () => {
      const { root, scroller, addRow } = createScrollableSidebar({
        viewportHeight: 600,
        contentHeight: 1600,
        initialScrollTop: 100,
      });
      // Viewport bottom is 600; row sits at [575, 605] (5px clipped).
      addRow("thr_bottom_clipped", 675, 30);

      revealSidebarThread(root, "thr_bottom_clipped");

      expect(scroller.scrollTop).toBe(105);
    });

    it("nudges a row partly covered by a sticky header without jumping to center", () => {
      const { root, scroller, addRow, addStickyTier } = createScrollableSidebar(
        { viewportHeight: 600, contentHeight: 1600, initialScrollTop: 300 },
      );
      addStickyTier("top-slot", 0, 0, 40);
      // Sticky header ends at 40; row sits at [35, 65] (5px covered).
      addRow("thr_top_clipped", 335, 30);

      revealSidebarThread(root, "thr_top_clipped");

      expect(scroller.scrollTop).toBe(295);
    });

    it("centers a windowed placeholder once and recenters once the row mounts", () => {
      let queuedFrame: FrameRequestCallback | null = null;
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
        queuedFrame = cb;
        return 42;
      });
      const cancelSpy = vi
        .spyOn(window, "cancelAnimationFrame")
        .mockImplementation(() => {});

      const { root, scroller, addRow, addPlaceholder } =
        createScrollableSidebar({
          viewportHeight: 600,
          contentHeight: 2000,
        });
      const placeholder = addPlaceholder("thr_far:proj_1", 1000, 120);

      revealSidebarThread(root, "thr_far");

      // Placeholder center is 1060 -> scrolled to 760.
      expect(scroller.scrollTop).toBe(760);
      expect(queuedFrame).not.toBeNull();

      // If the row hasn't mounted on the next frame, do not fight manual scroll.
      scroller.scrollTop = 700;
      const secondFrame = queuedFrame!;
      queuedFrame = null;
      secondFrame(16);
      expect(scroller.scrollTop).toBe(700);
      expect(queuedFrame).not.toBeNull();

      // Simulate SidebarWindowedItems mounting the actual row slightly below placeholder center.
      placeholder.remove();
      addRow("thr_far", 1090, 30);
      queuedFrame!(32);

      // Real row center (1105) snaps to viewport center (300) -> scrollTop = 805.
      expect(scroller.scrollTop).toBe(805);

      // Cancelling an in-flight reveal cancels its pending animation frame.
      queuedFrame = null;
      const cancelPending = revealSidebarThread(root, "thr_missing");
      cancelPending();
      expect(cancelSpy).toHaveBeenCalledWith(42);
    });
  });
});
