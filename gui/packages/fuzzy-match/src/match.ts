import { Fzf, type FzfResultItem } from "fzf";

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

function byStart(
  left: FzfResultItem<Searchable>,
  right: FzfResultItem<Searchable>,
) {
  return left.start - right.start;
}

function byLength(
  left: FzfResultItem<Searchable>,
  right: FzfResultItem<Searchable>,
) {
  return left.item.text.length - right.item.text.length;
}

export function createFinder<T extends Searchable>(
  items: readonly T[],
  casing: "smart-case" | "case-insensitive",
): (query: string) => Hit<T>[] {
  const fzf = new Fzf<readonly Searchable[]>(items, {
    selector: (item: Searchable) => item.text,
    casing,
    forward: true,
    tiebreakers: [byStart, byLength],
  });
  return (query) => {
    const results: FzfResultItem<Searchable>[] = fzf.find(query);
    return results.map(({ item, score, start, positions }) => ({
      item: item as T,
      score,
      start,
      positions,
    }));
  };
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
