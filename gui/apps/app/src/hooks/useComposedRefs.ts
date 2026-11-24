import { useCallback, type Ref, type RefCallback } from "react";

type PossibleRef<T> = Ref<T> | undefined;

function setRef<T>(ref: PossibleRef<T>, node: T | null) {
  if (typeof ref === "function") return ref(node);
  if (ref) ref.current = node;
}

/** One stable ref callback that sets both refs, React 19 ref cleanups included, as Radix's useComposedRefs does. */
export function useComposedRefs<T>(
  first: PossibleRef<T>,
  second: PossibleRef<T>,
): RefCallback<T> {
  return useCallback(
    (node: T | null) => {
      const firstCleanup = setRef(first, node);
      const secondCleanup = setRef(second, node);
      if (
        typeof firstCleanup !== "function" &&
        typeof secondCleanup !== "function"
      )
        return;
      return () => {
        if (typeof firstCleanup === "function") firstCleanup();
        else setRef(first, null);
        if (typeof secondCleanup === "function") secondCleanup();
        else setRef(second, null);
      };
    },
    [first, second],
  );
}
