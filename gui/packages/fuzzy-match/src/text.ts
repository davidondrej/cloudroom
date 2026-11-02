import { bestPerKey, createFinder, isSubsequence, sorted } from "./match.js";

interface Candidate<T> {
  item: T;
  itemIndex: number;
  text: string;
  textIndex: number;
}

export interface TextMatch<T> extends Candidate<T> {
  score: number;
  start: number;
  positions: number[];
}

const SCORE = {
  primaryText: 1_000_000,
  exact: 20_000,
  prefix: 15_000,
  contains: 10_000,
  subsequence: 5_000,
};

function textRelevance(text: string, query: string): number {
  const value = text.toLowerCase();
  const needle = query.toLowerCase();
  if (value === needle) return SCORE.exact;
  if (value.startsWith(needle)) return SCORE.prefix;
  if (value.includes(needle)) return SCORE.contains;
  if (isSubsequence(needle, value)) return SCORE.subsequence;
  return 0;
}

function compareText<T>(left: TextMatch<T>, right: TextMatch<T>): number {
  return (
    right.score - left.score ||
    left.start - right.start ||
    left.textIndex - right.textIndex ||
    left.text.length - right.text.length ||
    (left.text < right.text ? -1 : left.text > right.text ? 1 : 0) ||
    left.itemIndex - right.itemIndex
  );
}

export function rankText<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => string,
  getAliases?: (item: T) => readonly string[],
): TextMatch<T>[] {
  const candidates: Candidate<T>[] = [];
  items.forEach((item, itemIndex) => {
    const text = getText(item);
    if (text) candidates.push({ item, itemIndex, text, textIndex: 0 });
    getAliases?.(item).forEach((alias, aliasIndex) => {
      if (alias) {
        candidates.push({
          item,
          itemIndex,
          text: alias,
          textIndex: aliasIndex + 1,
        });
      }
    });
  });
  const find = createFinder(candidates, "case-insensitive");
  const [firstWord = "", ...otherWords] = query.split(/\s+/);
  const otherHits = otherWords.map(
    (word) => new Map(find(word).map((hit) => [hit.item, hit])),
  );

  const matches: TextMatch<T>[] = [];
  for (const firstHit of find(firstWord)) {
    const hits = [firstHit];
    for (const wordHits of otherHits) {
      const hit = wordHits.get(firstHit.item);
      if (hit === undefined) break;
      hits.push(hit);
    }
    if (hits.length <= otherHits.length) continue;
    const candidate = firstHit.item;
    matches.push({
      ...candidate,
      positions: sorted(hits.flatMap((hit) => [...hit.positions])),
      score:
        hits.reduce((total, hit) => total + hit.score, 0) +
        textRelevance(candidate.text, query) +
        (candidate.textIndex === 0 ? SCORE.primaryText : 0),
      start: Math.min(...hits.map((hit) => hit.start)),
    });
  }
  return bestPerKey(matches, (match) => match.itemIndex, compareText);
}
