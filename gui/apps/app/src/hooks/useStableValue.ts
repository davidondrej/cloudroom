import { useRef } from "react";

/**
 * Keeps the previous value (or its unchanged parts) when a recomputed value is
 * equal, so memoized children skip re-rendering. `reuse` returns `previous`
 * when nothing changed.
 */
export function useStableValue<T>(
  value: T,
  reuse: (previous: T, next: T) => T,
): T {
  const ref = useRef(value);
  // Safe during render: the ref only caches a value equal to the current one.
  // oxlint-disable-next-line react/refs
  if (ref.current !== value) ref.current = reuse(ref.current, value);
  // oxlint-disable-next-line react/refs
  return ref.current;
}

export function reuseSameMembers<S extends ReadonlySet<string>>(
  previous: S,
  next: S,
): S {
  if (previous.size !== next.size) return next;
  for (const value of next) {
    if (!previous.has(value)) return next;
  }
  return previous;
}

/** Reuses `previous` when both lists hold the same items in the same order. */
export function reuseSameItems<T extends readonly unknown[]>(
  previous: T | undefined,
  next: T,
): T {
  return previous !== undefined &&
    previous.length === next.length &&
    next.every((item, index) => previous[index] === item)
    ? previous
    : next;
}

/** Reuses each unchanged list, and the whole map when no list changed. */
export function reuseSameListsByKey<K, L extends readonly unknown[]>(
  previous: ReadonlyMap<K, L>,
  next: ReadonlyMap<K, L>,
): ReadonlyMap<K, L> {
  let changed = previous.size !== next.size;
  const merged = new Map<K, L>();
  for (const [key, list] of next) {
    const reused = reuseSameItems(previous.get(key), list);
    if (reused !== previous.get(key)) changed = true;
    merged.set(key, reused);
  }
  return changed ? merged : previous;
}

function haveSameEntries(left: object, right: object): boolean {
  const leftEntries = Object.entries(left);
  return (
    leftEntries.length === Object.keys(right).length &&
    leftEntries.every(
      ([key, value]) => (right as Record<string, unknown>)[key] === value,
    )
  );
}

/** Reuses each item that is shallow-equal to the item at the same index. */
export function reuseEqualObjects<T extends object>(
  previous: readonly T[] | undefined,
  next: readonly T[] | undefined,
): readonly T[] | undefined {
  if (previous === undefined || next === undefined) return next;
  return reuseSameItems(
    previous,
    next.map((item, index) => {
      const previousItem = previous[index];
      return previousItem !== undefined && haveSameEntries(previousItem, item)
        ? previousItem
        : item;
    }),
  );
}
