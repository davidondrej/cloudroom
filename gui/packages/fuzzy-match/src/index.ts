import { rankPaths } from "./paths.js";
import { rankText } from "./text.js";

interface FuzzyMatch<T> {
  item: T;
  score: number;
  positions: number[];
}

interface FuzzyMatchPathsArgs<T> {
  items: readonly T[];
  query: string;
  getPath: (item: T) => string;
  limit: number;
}

interface FuzzyMatchTextArgs<T> {
  items: readonly T[];
  query: string;
  getText: (item: T) => string;
  getAliases?: (item: T) => readonly string[];
  limit: number;
}

export const FUZZY_MATCH_QUERY_MAX_LENGTH = 256;

function firstItems<T>(items: readonly T[], limit: number): FuzzyMatch<T>[] {
  return items
    .slice(0, limit)
    .map((item) => ({ item, score: 0, positions: [] }));
}

function topMatches<T>(
  matches: readonly FuzzyMatch<T>[],
  limit: number,
): FuzzyMatch<T>[] {
  return matches
    .slice(0, limit)
    .map(({ item, score, positions }) => ({ item, score, positions }));
}

export function fuzzyMatchPaths<T>(
  args: FuzzyMatchPathsArgs<T>,
): FuzzyMatch<T>[] {
  if (args.limit <= 0) return [];
  if (!args.query) return firstItems(args.items, args.limit);
  const query = args.query.replaceAll("\\", "/");
  if (query.length > FUZZY_MATCH_QUERY_MAX_LENGTH) return [];
  const entries = args.items.map((item) => ({
    item,
    path: args.getPath(item).replaceAll("\\", "/"),
  }));
  return topMatches(rankPaths(entries, query), args.limit);
}

export function fuzzyMatchText<T>(
  args: FuzzyMatchTextArgs<T>,
): FuzzyMatch<T>[] {
  if (args.limit <= 0) return [];
  const query = args.query.trim();
  if (!query) return firstItems(args.items, args.limit);
  if (query.length > FUZZY_MATCH_QUERY_MAX_LENGTH) return [];
  return topMatches(
    rankText(args.items, query, args.getText, args.getAliases),
    args.limit,
  );
}
