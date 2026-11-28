// Explicit opt-out for TanStack Virtual's mutable Virtualizer instance.
"use no memo";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type SyntheticEvent,
} from "react";
import { useComposedRefs } from "@/hooks/useComposedRefs";
import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
} from "@tanstack/react-virtual";
import {
  DEFAULT_WINDOWING_MIN_ITEM_COUNT,
  NOOP_ITEM_REF,
  recordTimelineMeasurement,
  type TimelineWindowedItemsProps,
} from "./TimelineWindowedItemsLoader.js";

const TIMELINE_WINDOW_OVERSCAN_ITEMS = 8;
const TIMELINE_WINDOW_MAX_INTERACTION_PINS = 24;

const EMPTY_KEY_SET: ReadonlySet<string> = new Set();
const GET_NO_SCROLL_ELEMENT = () => null;
const WINDOWED_ITEM_STYLE: CSSProperties = {
  position: "absolute",
  left: 0,
  width: "100%",
};

function measureBorderBox(
  element: HTMLElement,
  entry: ResizeObserverEntry | undefined,
): number {
  const observedHeight = entry?.borderBoxSize[0]?.blockSize;
  return observedHeight ?? element.getBoundingClientRect().height;
}

function findOwnedWindowKey(
  target: EventTarget | null,
  container: HTMLElement,
  indexByKey: ReadonlyMap<string, number>,
): string | null {
  let element = target instanceof Element ? target : null;
  while (element !== null && element !== container) {
    const key = element.getAttribute("data-timeline-window-key");
    if (key !== null && indexByKey.has(key)) return key;
    element = element.parentElement;
  }
  return null;
}

export function TimelineWindowedItems({
  enabled,
  alwaysMountedKeys = EMPTY_KEY_SET,
  estimateItemHeight,
  gap,
  getScrollElement,
  itemKeys,
  measurements,
  minItemCount = DEFAULT_WINDOWING_MIN_ITEM_COUNT,
  renderItem,
}: TimelineWindowedItemsProps) {
  const configured =
    enabled && itemKeys.length >= minItemCount && getScrollElement !== null;
  const [scrollRootUsable, setScrollRootUsable] = useState(true);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [interactionPins, setInteractionPins] = useState<readonly string[]>([]);
  const containerElementRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef(false);
  const windowingEnabled = configured && scrollRootUsable;
  const resolvedGetScrollElement = getScrollElement ?? GET_NO_SCROLL_ELEMENT;

  const indexByKey = useMemo(
    () => new Map(itemKeys.map((key, index) => [key, index])),
    [itemKeys],
  );
  const forcedIndexes = useMemo(() => {
    const indexes = new Set<number>();
    for (const key of alwaysMountedKeys) {
      const index = indexByKey.get(key);
      if (index !== undefined) indexes.add(index);
    }
    for (const key of interactionPins) {
      const index = indexByKey.get(key);
      if (index !== undefined) indexes.add(index);
    }
    return indexes;
  }, [alwaysMountedKeys, indexByKey, interactionPins]);

  const getItemKey = useCallback(
    (index: number) => itemKeys[index] ?? index,
    [itemKeys],
  );
  const estimateSize = useCallback(
    (index: number) => {
      const key = itemKeys[index];
      return key === undefined
        ? Math.max(1, estimateItemHeight(index))
        : (measurements.get(key) ?? Math.max(1, estimateItemHeight(index)));
    },
    [estimateItemHeight, itemKeys, measurements],
  );
  const measureElement = useCallback(
    (
      element: HTMLDivElement,
      entry: ResizeObserverEntry | undefined,
    ): number => {
      const index = Number(element.dataset.index);
      const height = measureBorderBox(element, entry);
      const key = Number.isInteger(index) ? itemKeys[index] : undefined;
      if (key !== undefined && height > 0) {
        recordTimelineMeasurement(measurements, key, height);
      }
      return height > 0 ? height : estimateSize(index);
    },
    [estimateSize, itemKeys, measurements],
  );
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = new Set(defaultRangeExtractor(range));
      for (const index of forcedIndexes) indexes.add(index);
      return [...indexes].sort((left, right) => left - right);
    },
    [forcedIndexes],
  );
  const initialOffset = useCallback(
    () => resolvedGetScrollElement()?.scrollTop ?? 0,
    [resolvedGetScrollElement],
  );

  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: itemKeys.length,
    directDomUpdates: true,
    directDomUpdatesMode: "position",
    enabled: windowingEnabled,
    estimateSize,
    gap,
    getItemKey,
    getScrollElement: resolvedGetScrollElement,
    initialOffset,
    measureElement,
    overscan: TIMELINE_WINDOW_OVERSCAN_ITEMS,
    rangeExtractor,
    scrollMargin,
    useFlushSync: false,
  });
  const containerRef = useComposedRefs(
    containerElementRef,
    virtualizer.containerRef,
  );

  const updateScrollGeometry = useCallback(() => {
    if (!configured) return;
    const container = containerElementRef.current;
    const scrollElement = resolvedGetScrollElement();
    if (container === null || scrollElement === null) return;
    const nextMargin =
      container.getBoundingClientRect().top -
      scrollElement.getBoundingClientRect().top +
      scrollElement.scrollTop -
      scrollElement.clientTop;
    setScrollMargin((previous) =>
      Math.abs(previous - nextMargin) < 0.5 ? previous : nextMargin,
    );
  }, [configured, resolvedGetScrollElement]);

  // Track active visibility in a layout effect so cleanup runs synchronously
  // during React <Activity mode="hidden"> before paint and before any
  // ResizeObserver height-0 callback can un-window a hidden thread.
  useLayoutEffect(() => {
    shownRef.current = true;
    return () => {
      shownRef.current = false;
    };
  }, []);

  // Passive effects run after ancestor refs (like BottomAnchoredScrollBody's
  // scrollAreaRef) attach and restore scrollTop — including after React
  // <Activity> transitions hidden -> visible, where child useLayoutEffect runs
  // before the parent ref re-attaches and TanStack Virtual's _willUpdate() sees
  // null. Re-sync scrollOffset and re-attach the virtualizer here so scroll
  // listeners never stay detached.
  useEffect(() => {
    if (!configured) return;
    let frame: number | null = null;
    let observer: ResizeObserver | null = null;

    const attach = (): boolean => {
      if (!shownRef.current) return false;
      const scrollElement = resolvedGetScrollElement();
      if (scrollElement === null) return false;

      const sync = () => {
        if (!shownRef.current) return;
        const usable = scrollElement.clientHeight > 0;
        setScrollRootUsable(usable);
        updateScrollGeometry();
        if (virtualizer.scrollElement !== scrollElement) {
          virtualizer.scrollOffset = scrollElement.scrollTop;
          if (usable && virtualizer.options.enabled) {
            virtualizer._willUpdate();
          }
        }
      };

      sync();
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(sync);
        observer.observe(scrollElement);
        const containerParent = containerElementRef.current?.parentElement;
        if (containerParent !== null && containerParent !== undefined) {
          observer.observe(containerParent);
        }
      }
      return true;
    };

    if (!attach()) {
      frame = requestAnimationFrame(() => {
        frame = null;
        attach();
      });
    }

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [configured, resolvedGetScrollElement, updateScrollGeometry, virtualizer]);

  useLayoutEffect(updateScrollGeometry);

  const retainInteractedItem = useCallback(
    (event: SyntheticEvent<HTMLDivElement>) => {
      const container = containerElementRef.current;
      if (container === null) return;
      const key = findOwnedWindowKey(event.target, container, indexByKey);
      if (key === null) return;
      setInteractionPins((previous) => {
        const next = previous.filter((candidate) => candidate !== key);
        next.push(key);
        return next.slice(-TIMELINE_WINDOW_MAX_INTERACTION_PINS);
      });
    },
    [indexByKey],
  );

  if (!windowingEnabled) {
    return (
      <>
        {itemKeys.map((_, index) =>
          renderItem(index, {
            itemIndex: undefined,
            itemRef: NOOP_ITEM_REF,
            itemStyle: undefined,
            windowingEnabled: false,
          }),
        )}
      </>
    );
  }

  const virtualItemsByIndex = new Map(
    virtualizer.getVirtualItems().map((item) => [item.index, item]),
  );
  for (const index of forcedIndexes) {
    const item = virtualizer.measurementsCache[index];
    if (item !== undefined) virtualItemsByIndex.set(index, item);
  }
  const virtualItems = [...virtualItemsByIndex.values()].sort(
    (left, right) => left.index - right.index,
  );
  return (
    <div
      ref={containerRef}
      className="relative w-full"
      data-timeline-virtual-spacer=""
      onClickCapture={retainInteractedItem}
      onFocusCapture={retainInteractedItem}
    >
      {virtualItems.map((item) =>
        renderItem(item.index, {
          itemIndex: item.index,
          itemRef: virtualizer.measureElement,
          itemStyle: WINDOWED_ITEM_STYLE,
          windowingEnabled: true,
        }),
      )}
    </div>
  );
}
