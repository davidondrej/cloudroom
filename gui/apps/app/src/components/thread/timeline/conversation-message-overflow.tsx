import { useLayoutEffect, useState, type Ref, type RefObject } from "react";
import { cn } from "@cloudroom/shared-ui/lib/utils";

interface UseOverflowMeasurementArgs {
  elementRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  measurementKey: string;
}

type OverflowMeasurement = "unmeasured" | "fits" | "overflowing";

type OverflowMeasurementListener = (
  measurement: Exclude<OverflowMeasurement, "unmeasured">,
) => void;

const overflowListenersByElement = new Map<
  HTMLElement,
  Set<OverflowMeasurementListener>
>();
let sharedOverflowResizeObserver: ResizeObserver | null = null;

function readOverflowMeasurement(
  element: HTMLElement,
): Exclude<OverflowMeasurement, "unmeasured"> {
  return element.scrollHeight > element.clientHeight + 1 ||
    element.scrollWidth > element.clientWidth + 1
    ? "overflowing"
    : "fits";
}

function measureOverflowElements(elements: readonly HTMLElement[]): void {
  const results = elements.map((element) => ({
    element,
    measurement: readOverflowMeasurement(element),
  }));
  for (const { element, measurement } of results) {
    for (const listener of overflowListenersByElement.get(element) ?? []) {
      listener(measurement);
    }
  }
}

function getSharedOverflowResizeObserver(): ResizeObserver {
  sharedOverflowResizeObserver ??= new ResizeObserver((entries) => {
    const connectedElements: HTMLElement[] = [];
    for (const entry of entries) {
      if (entry.target instanceof HTMLElement && entry.target.isConnected) {
        connectedElements.push(entry.target);
      }
    }
    measureOverflowElements(connectedElements);
  });
  return sharedOverflowResizeObserver;
}

function observeOverflow(
  element: HTMLElement,
  listener: OverflowMeasurementListener,
): () => void {
  let listeners = overflowListenersByElement.get(element);
  if (!listeners) {
    listeners = new Set();
    overflowListenersByElement.set(element, listeners);
    getSharedOverflowResizeObserver().observe(element);
  }
  listeners.add(listener);

  return () => {
    const currentListeners = overflowListenersByElement.get(element);
    currentListeners?.delete(listener);
    if (currentListeners?.size === 0) {
      overflowListenersByElement.delete(element);
      sharedOverflowResizeObserver?.unobserve?.(element);
      if (overflowListenersByElement.size === 0) {
        sharedOverflowResizeObserver?.disconnect?.();
        sharedOverflowResizeObserver = null;
      }
    }
  };
}

interface ConversationMessageOverflowToggleProps {
  buttonRef?: Ref<HTMLButtonElement>;
  expanded: boolean;
  onToggle: () => void;
}

interface ConversationMessageInlineOverflowToggleProps {
  buttonBackgroundClassName: string;
  fadeFromClassName: string;
  label: string;
  onToggle: () => void;
}

export function useOverflowMeasurement({
  elementRef,
  enabled,
  measurementKey,
}: UseOverflowMeasurementArgs): OverflowMeasurement {
  const [measurement, setMeasurement] =
    useState<OverflowMeasurement>("unmeasured");

  useLayoutEffect(() => {
    if (!enabled) {
      setMeasurement("fits");
      return;
    }

    const element = elementRef.current;
    if (!element) {
      setMeasurement("unmeasured");
      return;
    }

    const applyMeasurement: OverflowMeasurementListener = (nextMeasurement) => {
      if (!element.isConnected) return;
      setMeasurement(nextMeasurement);
    };
    if (typeof ResizeObserver === "undefined") {
      applyMeasurement(readOverflowMeasurement(element));
      return;
    }

    return observeOverflow(element, applyMeasurement);
  }, [elementRef, enabled, measurementKey]);

  return measurement;
}

export function useIsOverflowing(args: UseOverflowMeasurementArgs): boolean {
  return useOverflowMeasurement(args) === "overflowing";
}

/**
 * Lines hidden in a collapsed message, recounted whenever its size changes.
 * When only part of the text renders (`scale` > 1), its height is scaled up.
 */
export function useHiddenLineCount({
  elementRef,
  enabled,
  measurementKey,
  scale,
  visibleLines,
}: UseOverflowMeasurementArgs & {
  scale: number;
  visibleLines: number;
}): number | null {
  const [count, setCount] = useState<number | null>(null);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!enabled || !element) {
      setCount(null);
      return;
    }
    const measure = () => {
      if (!element.isConnected) return;
      const lineHeight = Number.parseFloat(
        getComputedStyle(element).lineHeight,
      );
      const lines =
        Math.round((element.scrollHeight * scale) / lineHeight) - visibleLines;
      setCount(Number.isFinite(lines) && lines > 0 ? lines : null);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    return observeOverflow(element, measure);
  }, [elementRef, enabled, measurementKey, scale, visibleLines]);

  return count;
}

export function ConversationMessageOverflowToggle({
  buttonRef,
  expanded,
  onToggle,
}: ConversationMessageOverflowToggleProps) {
  return (
    <div className="mt-1 flex justify-end">
      <button
        ref={buttonRef}
        type="button"
        onClick={onToggle}
        className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground"
        aria-expanded={expanded}
      >
        {expanded ? "Show less" : "Show more"}
      </button>
    </div>
  );
}

/** Sits between the start and the end of a collapsed message; click to expand. */
export function ConversationMessageCollapsedDivider({
  approximate,
  buttonRef,
  hiddenLines,
  onExpand,
}: {
  /** The count is estimated from part of the text. */
  approximate: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  hiddenLines: number | null;
  onExpand: () => void;
}) {
  return (
    <div className="flex h-[2lh] items-center">
      <span className="h-px flex-1 bg-gradient-to-l from-foreground/13 to-transparent" />
      <button
        ref={buttonRef}
        type="button"
        onClick={onExpand}
        className="mx-2 inline-flex h-5.5 cursor-pointer items-center whitespace-nowrap rounded-full bg-background px-2.5 text-xs font-medium text-muted-foreground ring-1 ring-foreground/13 ring-inset hover:text-foreground"
        aria-expanded={false}
      >
        {hiddenLines === null
          ? "Show more"
          : `${approximate ? "~" : ""}${hiddenLines.toLocaleString("en-US")} more ${hiddenLines === 1 ? "line" : "lines"}`}
      </button>
      <span className="h-px flex-1 bg-gradient-to-r from-foreground/13 to-transparent" />
    </div>
  );
}

export function ConversationMessageInlineOverflowToggle({
  buttonBackgroundClassName,
  fadeFromClassName,
  label,
  onToggle,
}: ConversationMessageInlineOverflowToggleProps) {
  return (
    <span className="pointer-events-none absolute inset-x-0 bottom-0 flex h-[1lh] items-stretch justify-end">
      <span
        className={cn(
          "w-12 bg-gradient-to-l to-transparent",
          fadeFromClassName,
        )}
      />
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "pointer-events-auto cursor-pointer whitespace-nowrap pl-1.5 text-xs font-medium text-muted-foreground hover:text-foreground",
          buttonBackgroundClassName,
        )}
        aria-expanded={false}
      >
        {label}
      </button>
    </span>
  );
}
