import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useLatestRef } from "./useLatestRef";

interface ElementSize {
  width: number | undefined;
  height: number | undefined;
}

type ObservedBox = "border-box" | "content-box";

const UNKNOWN_SIZE: ElementSize = { width: undefined, height: undefined };

function readSize(entry: ResizeObserverEntry, box: ObservedBox): ElementSize {
  const size = (
    box === "border-box" ? entry.borderBoxSize : entry.contentBoxSize
  )?.[0];
  if (size) return { width: size.inlineSize, height: size.blockSize };
  // Browsers without box sizes still report the content box.
  return box === "content-box"
    ? { width: entry.contentRect.width, height: entry.contentRect.height }
    : UNKNOWN_SIZE;
}

/** Watches `ref` from mount. With `onResize`, it calls it instead of re-rendering. */
export function useResizeObserver<T extends Element>({
  ref,
  box = "content-box",
  onResize,
}: {
  ref: RefObject<T | null>;
  box?: ObservedBox;
  onResize?: (size: ElementSize) => void;
}): ElementSize {
  const [size, setSize] = useState(UNKNOWN_SIZE);
  const previousSize = useRef(UNKNOWN_SIZE);
  const onResizeRef = useLatestRef(onResize);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const next = readSize(entry, box);
      const previous = previousSize.current;
      if (next.width === previous.width && next.height === previous.height) {
        return;
      }
      previousSize.current = next;
      if (onResizeRef.current) onResizeRef.current(next);
      else setSize(next);
    });
    observer.observe(element, { box });
    return () => observer.disconnect();
  }, [box, onResizeRef, ref]);

  return size;
}

/** Pass `ref` to the element. A removed element reads as `initialIsIntersecting` again. */
export function useIntersectionObserver({
  initialIsIntersecting = false,
  rootMargin = "0%",
  threshold = 0,
}: {
  initialIsIntersecting?: boolean;
  rootMargin?: string;
  threshold?: number;
} = {}) {
  const [node, setNode] = useState<Element | null>(null);
  const [isIntersecting, setIsIntersecting] = useState(initialIsIntersecting);
  const ref = useCallback(
    (element: Element | null) => {
      setNode(element);
      if (!element) setIsIntersecting(initialIsIntersecting);
    },
    [initialIsIntersecting],
  );

  useEffect(() => {
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          setIsIntersecting(
            entry.isIntersecting && entry.intersectionRatio >= threshold,
          );
        }
      },
      { rootMargin, threshold },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, rootMargin, threshold]);

  return { ref, isIntersecting };
}
