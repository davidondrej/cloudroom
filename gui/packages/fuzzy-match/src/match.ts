import { createFzf, type Casing } from "./fzf.js";

export interface Hit<T> {
  item: T;
  score: number;
  start: number;
  positions: ReadonlySet<number>;
}

export interface Searchable {
  text: string;
}

const byNumber = (left: number, right: number) => left - right;

export function createFinder<T extends Searchable>(
  items: readonly T[],
  casing: Casing,
): (query: string) => Hit<T>[] {
  const find = createFzf(
    items.map((item) => item.text),
    casing,
  );
  return (query) =>
    find(query).map(({ index, score, start, positions }) => ({
      item: items[index]!,
      score,
      start,
      positions,
    }));
}

export function sorted(values: Iterable<number>, offset = 0): number[] {
  return [...new Set(values)].sort(byNumber).map((value) => value + offset);
}

export function range(start: number, length: number): number[] {
  return Array.from({ length }, (_, index) => start + index);
}

export function isSubsequence(query: string, value: string): boolean {
  let queryIndex = 0;
  for (const char of value) {
    if (char === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return true;
  }
  return query.length === 0;
}

export function bestPerKey<M>(
  matches: Iterable<M>,
  key: (match: M) => unknown,
  compare: (left: M, right: M) => number,
): M[] {
  const best = new Map<unknown, M>();
  for (const match of matches) {
    const current = best.get(key(match));
    if (current === undefined || compare(match, current) < 0) {
      best.set(key(match), match);
    }
  }
  return [...best.values()].sort(compare);
}
