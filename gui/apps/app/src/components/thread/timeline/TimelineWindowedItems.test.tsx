// @vitest-environment jsdom

import {
  Activity,
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimelineWindowedItems } from "./TimelineWindowedItems.js";
import {
  TimelineWindowedItemsLoader,
  type TimelineWindowedItemRenderState,
} from "./TimelineWindowedItemsLoader.js";

const ITEM_KEYS = Array.from({ length: 100 }, (_, index) => `row-${index}`);

let scrollElement: HTMLDivElement;
let itemHeights = new Map<number, number>();

function rect(top: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: 320,
    top,
    width: 320,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

const activeResizeObservers = new Set<ResizeObserverStub>();

class ResizeObserverStub implements ResizeObserver {
  private readonly callback: ResizeObserverCallback;
  private readonly targets = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    activeResizeObservers.add(this);
  }

  disconnect(): void {
    this.targets.clear();
    activeResizeObservers.delete(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  trigger(target: Element): void {
    if (!this.targets.has(target)) return;
    const height = (target as HTMLElement).clientHeight;
    const width = (target as HTMLElement).clientWidth;
    this.callback(
      [
        {
          borderBoxSize: [{ blockSize: height, inlineSize: width }],
          contentBoxSize: [{ blockSize: height, inlineSize: width }],
          contentRect: rect(0, height),
          devicePixelContentBoxSize: [{ blockSize: height, inlineSize: width }],
          target,
        } as ResizeObserverEntry,
      ],
      this,
    );
  }
}

function triggerResizeObservers(target: Element): void {
  for (const observer of [...activeResizeObservers]) {
    observer.trigger(target);
  }
}

function renderWindowedItems(options?: {
  alwaysMountedKeys?: ReadonlySet<string>;
  clientHeight?: number;
  enabled?: boolean;
  measurements?: Map<string, number>;
}) {
  const measurements = options?.measurements ?? new Map<string, number>();
  Object.defineProperty(scrollElement, "clientHeight", {
    configurable: true,
    value: options?.clientHeight ?? 96,
  });
  Object.defineProperty(scrollElement, "offsetHeight", {
    configurable: true,
    value: options?.clientHeight ?? 96,
  });
  return {
    ...render(
      <TimelineWindowedItems
        enabled={options?.enabled ?? true}
        alwaysMountedKeys={options?.alwaysMountedKeys}
        estimateItemHeight={() => 32}
        gap={0}
        getScrollElement={() => scrollElement}
        itemKeys={ITEM_KEYS}
        measurements={measurements}
        renderItem={(index: number, state: TimelineWindowedItemRenderState) => (
          <div
            key={ITEM_KEYS[index]}
            ref={state.itemRef}
            data-index={state.itemIndex}
            data-testid={`wrapper-${index}`}
            data-timeline-window-key={ITEM_KEYS[index]}
            style={state.itemStyle}
          >
            <button type="button" data-testid={`content-${index}`}>
              row {index}
            </button>
          </div>
        )}
      />,
      { container: scrollElement },
    ),
    measurements,
  };
}

beforeEach(() => {
  activeResizeObservers.clear();
  itemHeights = new Map();
  scrollElement = document.createElement("div");
  document.body.append(scrollElement);
  Object.defineProperty(scrollElement, "clientWidth", {
    configurable: true,
    value: 320,
  });
  Object.defineProperty(scrollElement, "offsetWidth", {
    configurable: true,
    value: 320,
  });
  Object.defineProperty(scrollElement, "scrollHeight", {
    configurable: true,
    value: 3_200,
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const root =
        this.closest<HTMLElement>("[data-test-scroll-root]") ?? scrollElement;
      if (this === root) return rect(0, root.clientHeight);
      if (this.hasAttribute("data-timeline-virtual-spacer")) {
        return rect(
          -root.scrollTop,
          Number.parseFloat(this.style.height) || 0,
        );
      }
      const index = Number(this.dataset.index);
      if (Number.isInteger(index)) {
        return rect(
          index * 32 - root.scrollTop,
          itemHeights.get(index) ?? 32,
        );
      }
      return rect(0, Number.parseFloat(this.style.height) || 0);
    },
  );
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TimelineWindowedItems", () => {
  it("seeds exact heights while the lazy windowing implementation loads", () => {
    const measurements = new Map<string, number>();

    render(
      <TimelineWindowedItemsLoader
        enabled
        estimateItemHeight={() => 100}
        gap={0}
        getScrollElement={() => scrollElement}
        itemKeys={ITEM_KEYS}
        measurements={measurements}
        renderItem={(index, state) => (
          <div
            key={ITEM_KEYS[index]}
            ref={state.itemRef}
            data-index={state.itemIndex}
          />
        )}
      />,
      { container: scrollElement },
    );

    expect(measurements.get("row-0")).toBe(32);
    expect(measurements.get("row-99")).toBe(32);
  });

  it("keeps the control path fully mounted when the experiment is off", () => {
    renderWindowedItems({ enabled: false });

    expect(screen.getAllByTestId(/^content-/)).toHaveLength(100);
    expect(
      scrollElement.querySelector("[data-timeline-virtual-spacer]"),
    ).toBeNull();
  });

  it("mounts only the visible TanStack range and removes offscreen wrappers", async () => {
    renderWindowedItems();

    await waitFor(() => expect(screen.getByTestId("content-0")).toBeTruthy());
    expect(screen.getAllByTestId(/^wrapper-/).length).toBeLessThan(30);
    expect(screen.queryByTestId("wrapper-60")).toBeNull();
    expect(
      scrollElement.querySelector<HTMLElement>("[data-timeline-virtual-spacer]")
        ?.style.height,
    ).toBe("3200px");
  });

  it("changes ranges on scroll without retaining the old rich rows", async () => {
    renderWindowedItems();
    await waitFor(() => expect(screen.getByTestId("content-0")).toBeTruthy());

    scrollElement.scrollTop = 1_600;
    fireEvent.scroll(scrollElement);

    await waitFor(() => expect(screen.getByTestId("content-50")).toBeTruthy());
    expect(screen.queryByTestId("wrapper-0")).toBeNull();
  });

  it("preserves an existing scroll offset when a nested virtualizer mounts", async () => {
    scrollElement.scrollTop = 1_600;

    renderWindowedItems();

    await waitFor(() => expect(screen.getByTestId("content-50")).toBeTruthy());
    expect(scrollElement.scrollTop).toBe(1_600);
  });

  it("keeps search and interacted rows mounted outside the visible range", async () => {
    renderWindowedItems({ alwaysMountedKeys: new Set(["row-80"]) });
    await waitFor(() => expect(screen.getByTestId("content-80")).toBeTruthy());
    fireEvent.click(screen.getByTestId("content-0"));

    scrollElement.scrollTop = 1_600;
    fireEvent.scroll(scrollElement);

    await waitFor(() => expect(screen.getByTestId("content-50")).toBeTruthy());
    expect(screen.getByTestId("content-0")).toBeTruthy();
    expect(screen.getByTestId("content-80")).toBeTruthy();
  });

  it("re-attaches scroll tracking and stays windowed across React Activity hide/show", async () => {
    const MemoizedWindowedItems = memo(TimelineWindowedItems);
    const measurements = new Map<string, number>();
    const alwaysMountedKeys = new Set(["row-99"]);
    const estimateItemHeight = () => 32;
    const renderItem = (
      index: number,
      state: TimelineWindowedItemRenderState,
    ) => (
      <div
        key={ITEM_KEYS[index]}
        ref={state.itemRef}
        data-index={state.itemIndex}
        data-testid={`wrapper-${index}`}
        data-timeline-window-key={ITEM_KEYS[index]}
        style={state.itemStyle}
      >
        <button type="button" data-testid={`content-${index}`}>
          row {index}
        </button>
      </div>
    );

    let activeScrollEl: HTMLDivElement | null = null;
    let restoredScrollTop = 0;
    function setRootHeight(el: HTMLElement, height: number) {
      Object.defineProperty(el, "clientHeight", {
        configurable: true,
        value: height,
      });
      Object.defineProperty(el, "offsetHeight", {
        configurable: true,
        value: height,
      });
    }

    function ActivityHarness() {
      const [visible, setVisible] = useState(true);
      const scrollRef = useRef<HTMLDivElement>(null);
      const getScrollElement = useCallback(() => scrollRef.current, []);

      useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        activeScrollEl = el;
        setRootHeight(el, 96);
        Object.defineProperty(el, "clientWidth", {
          configurable: true,
          value: 320,
        });
        Object.defineProperty(el, "offsetWidth", {
          configurable: true,
          value: 320,
        });
        Object.defineProperty(el, "scrollHeight", {
          configurable: true,
          value: 3_200,
        });
        el.scrollTop = restoredScrollTop;
        return () => {
          // Simulate browser delivering a height-0 ResizeObserver callback
          // after display:none on hide, before passive useEffect cleanup runs.
          restoredScrollTop = el.scrollTop;
          setRootHeight(el, 0);
          triggerResizeObservers(el);
        };
      }, []);

      return (
        <>
          <button
            type="button"
            data-testid="toggle-activity"
            onClick={() => setVisible((prev) => !prev)}
          >
            toggle
          </button>
          <Activity mode={visible ? "visible" : "hidden"}>
            <div
              ref={scrollRef}
              data-test-scroll-root=""
              data-testid="activity-scroll-root"
            >
              <MemoizedWindowedItems
                enabled
                alwaysMountedKeys={alwaysMountedKeys}
                estimateItemHeight={estimateItemHeight}
                gap={0}
                getScrollElement={getScrollElement}
                itemKeys={ITEM_KEYS}
                measurements={measurements}
                renderItem={renderItem}
              />
            </div>
          </Activity>
        </>
      );
    }

    render(<ActivityHarness />);
    await waitFor(() => expect(screen.getByTestId("content-0")).toBeTruthy());

    // Scroll to row 50 before hiding.
    activeScrollEl!.scrollTop = 1_600;
    fireEvent.scroll(activeScrollEl!);
    await waitFor(() => expect(screen.getByTestId("content-50")).toBeTruthy());

    // Hide: height-0 ResizeObserver firing before passive cleanup must NOT
    // un-window the hidden pane into mounting all 100 rows.
    fireEvent.click(screen.getByTestId("toggle-activity"));
    expect(screen.getAllByTestId(/^wrapper-/).length).toBeLessThan(30);

    // Reveal: preserved scrollTop and visible range are intact right away.
    fireEvent.click(screen.getByTestId("toggle-activity"));
    expect(activeScrollEl!.scrollTop).toBe(1_600);
    expect(screen.getByTestId("content-50")).toBeTruthy();

    // Scrolling after reappear must update the visible range instead of
    // staying frozen on the pre-hide range.
    const root = activeScrollEl!;
    root.scrollTop = 0;
    fireEvent.scroll(root);

    await waitFor(() => expect(screen.getByTestId("content-0")).toBeTruthy());
    expect(screen.queryByTestId("wrapper-50")).toBeNull();
  });

  it("preserves scrollTop when a late parent ref starts at height 0 and later becomes usable", async () => {
    const measurements = new Map<string, number>();
    const scrollToSpy = vi.fn(
      (options?: ScrollToOptions | number, y?: number) => {
        if (activeScrollEl === null) return;
        const nextTop =
          typeof options === "number" ? (y ?? 0) : (options?.top ?? 0);
        activeScrollEl.scrollTop = nextTop;
      },
    );

    let activeScrollEl: HTMLDivElement | null = null;
    function ZeroHeightMountHarness() {
      const scrollRef = useRef<HTMLDivElement>(null);
      const getScrollElement = useCallback(() => scrollRef.current, []);

      useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        activeScrollEl = el;
        Object.defineProperty(el, "clientHeight", {
          configurable: true,
          value: 0,
        });
        Object.defineProperty(el, "offsetHeight", {
          configurable: true,
          value: 0,
        });
        Object.defineProperty(el, "clientWidth", {
          configurable: true,
          value: 320,
        });
        Object.defineProperty(el, "offsetWidth", {
          configurable: true,
          value: 320,
        });
        Object.defineProperty(el, "scrollHeight", {
          configurable: true,
          value: 3_200,
        });
        el.scrollTo = scrollToSpy as typeof el.scrollTo;
      }, []);

      return (
        <div
          ref={scrollRef}
          data-test-scroll-root=""
          data-testid="zero-height-scroll-root"
        >
          <TimelineWindowedItems
            enabled
            estimateItemHeight={() => 32}
            gap={0}
            getScrollElement={getScrollElement}
            itemKeys={ITEM_KEYS}
            measurements={measurements}
            renderItem={(index, state) => (
              <div
                key={ITEM_KEYS[index]}
                ref={state.itemRef}
                data-index={state.itemIndex}
                data-testid={`wrapper-${index}`}
                data-timeline-window-key={ITEM_KEYS[index]}
                style={state.itemStyle}
              >
                <button type="button" data-testid={`content-${index}`}>
                  row {index}
                </button>
              </div>
            )}
          />
        </div>
      );
    }

    render(<ZeroHeightMountHarness />);
    await waitFor(() =>
      expect(screen.getAllByTestId(/^content-/)).toHaveLength(100),
    );

    // Container becomes visible with a restored scroll offset.
    act(() => {
      const el = activeScrollEl!;
      Object.defineProperty(el, "clientHeight", {
        configurable: true,
        value: 96,
      });
      Object.defineProperty(el, "offsetHeight", {
        configurable: true,
        value: 96,
      });
      el.scrollTop = 1_600;
      triggerResizeObservers(el);
    });

    await waitFor(() =>
      expect(screen.getAllByTestId(/^wrapper-/).length).toBeLessThan(30),
    );
    expect(screen.getByTestId("content-50")).toBeTruthy();
    expect(activeScrollEl!.scrollTop).toBe(1_600);
    expect(scrollToSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ top: 0 }),
    );
  });

  it("attaches on initial mount with a late parent ref and preserves restored scrollTop", async () => {
    const measurements = new Map<string, number>();
    const scrollToSpy = vi.fn(
      (options?: ScrollToOptions | number, y?: number) => {
        if (activeScrollEl === null) return;
        const nextTop = typeof options === "number" ? (y ?? 0) : (options?.top ?? 0);
        activeScrollEl.scrollTop = nextTop;
      },
    );

    let activeScrollEl: HTMLDivElement | null = null;
    function LateParentRefHarness() {
      const scrollRef = useRef<HTMLDivElement>(null);
      const getScrollElement = useCallback(() => scrollRef.current, []);

      // Parent ref + layout effect run after child TimelineWindowedItems's
      // useLayoutEffect, mirroring BottomAnchoredScrollBody restoring scrollTop.
      useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        activeScrollEl = el;
        Object.defineProperty(el, "clientHeight", {
          configurable: true,
          value: 96,
        });
        Object.defineProperty(el, "offsetHeight", {
          configurable: true,
          value: 96,
        });
        Object.defineProperty(el, "clientWidth", {
          configurable: true,
          value: 320,
        });
        Object.defineProperty(el, "offsetWidth", {
          configurable: true,
          value: 320,
        });
        Object.defineProperty(el, "scrollHeight", {
          configurable: true,
          value: 3_200,
        });
        el.scrollTo = scrollToSpy as typeof el.scrollTo;
        el.scrollTop = 1_600;
      }, []);

      return (
        <div
          ref={scrollRef}
          data-test-scroll-root=""
          data-testid="late-scroll-root"
        >
          <TimelineWindowedItems
            enabled
            estimateItemHeight={() => 32}
            gap={0}
            getScrollElement={getScrollElement}
            itemKeys={ITEM_KEYS}
            measurements={measurements}
            renderItem={(index, state) => (
              <div
                key={ITEM_KEYS[index]}
                ref={state.itemRef}
                data-index={state.itemIndex}
                data-testid={`wrapper-${index}`}
                data-timeline-window-key={ITEM_KEYS[index]}
                style={state.itemStyle}
              >
                <button type="button" data-testid={`content-${index}`}>
                  row {index}
                </button>
              </div>
            )}
          />
        </div>
      );
    }

    render(<LateParentRefHarness />);

    await waitFor(() => expect(screen.getByTestId("content-50")).toBeTruthy());
    expect(activeScrollEl!.scrollTop).toBe(1_600);
    expect(scrollToSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ top: 0 }),
    );
  });

  it("seeds its size model from measurements retained by the thread", async () => {
    const measurements = new Map<string, number>([["row-50", 64]]);
    renderWindowedItems({ measurements });
    await waitFor(() =>
      expect(
        scrollElement.querySelector<HTMLElement>(
          "[data-timeline-virtual-spacer]",
        )?.style.height,
      ).toBe("3232px"),
    );
  });

  it("renders everything when its scrollport has no usable geometry", async () => {
    renderWindowedItems({ clientHeight: 0 });

    await waitFor(() =>
      expect(screen.getAllByTestId(/^content-/)).toHaveLength(100),
    );
  });
});
