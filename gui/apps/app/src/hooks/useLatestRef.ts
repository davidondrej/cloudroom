import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  // oxlint-disable-next-line react/refs
  ref.current = value;
  return ref;
}

/** Holds the value from the last render React put on screen; a render React drops never leaks into event handlers. */
export function useCommittedRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** Fixed identity, always calls the latest committed `callback`. For event handlers, never during render. */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const ref = useCommittedRef(callback);
  return useCallback((...args: Args) => ref.current(...args), [ref]);
}
