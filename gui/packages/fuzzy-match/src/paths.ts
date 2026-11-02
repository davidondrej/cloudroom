import {
  bestPerKey,
  createFinder,
  isSubsequence,
  range,
  sorted,
  type Hit,
  type Searchable,
} from "./match.js";

export interface PathEntry<T> {
  item: T;
  path: string;
}

export interface PathMatch<T> extends PathEntry<T> {
  score: number;
  start: number;
  positions: number[];
}

interface Segment {
  text: string;
  start: number;
  isFileName: boolean;
}

const TIER = {
  plain: 0,
  folderName: 1_000_000,
  slashPath: 2_000_000,
  folderPrefix: 3_000_000,
};
const SCORE = {
  folderNameExact: 30_000,
  folderNamePrefix: 25_000,
  rootFolder: 5_000,
  nextSegment: 5_000,
  leafSegment: 50_000,
  baseNameContains: 10_000,
  baseNameSubsequence: 5_000,
  pathContains: 1_000,
  repeatedHit: 500,
};
const MIN_FOLDER_NAME_QUERY = 2;
const MAX_SLASH_SEGMENTS = 8;

function smartCase(query: string, value: string): string {
  return query === query.toLowerCase() ? value.toLowerCase() : value;
}

function comparePaths<T>(left: PathMatch<T>, right: PathMatch<T>): number {
  return (
    right.score - left.score ||
    left.start - right.start ||
    (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  );
}

function splitSegments(path: string): Segment[] {
  const parts = path.split("/");
  let start = 0;
  return parts.map((text, index) => {
    const segment = { text, start, isFileName: index === parts.length - 1 };
    start += text.length + 1;
    return segment;
  });
}

function pathRelevance(path: string, query: string): number {
  const value = smartCase(query, path);
  const baseName = value.slice(value.lastIndexOf("/") + 1);
  return (
    (baseName.includes(query) ? SCORE.baseNameContains : 0) +
    (isSubsequence(query, baseName) ? SCORE.baseNameSubsequence : 0) +
    (value.includes(query) ? SCORE.pathContains : 0) +
    (value.split(query).length - 1) * SCORE.repeatedHit
  );
}

function plainMatches<T>(
  entries: readonly PathEntry<T>[],
  query: string,
): PathMatch<T>[] {
  const find = createFinder(
    entries.map((entry) => ({ entry, text: entry.path })),
    "smart-case",
  );
  return find(query).map(({ item: { entry }, score, start, positions }) => ({
    ...entry,
    positions: sorted(positions),
    score: TIER.plain + score + pathRelevance(entry.path, query),
    start,
  }));
}

function folderNameMatch<T>(
  entry: PathEntry<T>,
  query: string,
): PathMatch<T> | null {
  let best: { score: number; start: number } | null = null;
  for (const segment of splitSegments(entry.path)) {
    if (segment.isFileName) continue;
    const text = smartCase(query, segment.text);
    let score: number;
    if (text === query) {
      score = SCORE.folderNameExact;
    } else if (text.startsWith(query)) {
      score =
        SCORE.folderNamePrefix -
        Math.max(segment.text.length - query.length, 0);
    } else {
      continue;
    }
    if (segment.start === 0) score += SCORE.rootFolder;
    if (best === null || score > best.score) {
      best = { score, start: segment.start };
    }
  }
  if (best === null) return null;
  return {
    ...entry,
    positions: range(best.start, query.length),
    score: TIER.folderName + best.score,
    start: best.start,
  };
}

function folderPrefixMatches<T>(
  entries: readonly PathEntry<T>[],
  query: string,
): PathMatch<T>[] {
  const cut = query.lastIndexOf("/") + 1;
  const prefix = query.slice(0, cut);
  const leaf = query.slice(cut);
  const inFolder = entries.filter((entry) =>
    smartCase(prefix, entry.path).startsWith(prefix),
  );
  if (!leaf) {
    return inFolder.map((entry) => ({
      ...entry,
      positions: range(0, cut),
      score: TIER.folderPrefix,
      start: 0,
    }));
  }
  const find = createFinder(
    inFolder.map((entry) => ({ entry, text: entry.path.slice(cut) })),
    "smart-case",
  );
  return find(leaf).map(({ item: { entry, text }, score, positions }) => ({
    ...entry,
    positions: [...range(0, cut), ...sorted(positions, cut)],
    score: TIER.folderPrefix + score + pathRelevance(text, leaf),
    start: 0,
  }));
}

function bestSegment(
  segments: readonly Segment[],
  from: number,
  skipFileName: boolean,
  hits: ReadonlyMap<string, Hit<Searchable>>,
) {
  let best: { index: number; segment: Segment; hit: Hit<Searchable> } | null =
    null;
  for (let index = from; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const hit =
      skipFileName && segment.isFileName ? undefined : hits.get(segment.text);
    if (hit === undefined) continue;
    if (
      best === null ||
      hit.score > best.hit.score ||
      (hit.score === best.hit.score &&
        (hit.start < best.hit.start ||
          (hit.start === best.hit.start &&
            segment.text.length < best.segment.text.length)))
    ) {
      best = { index, segment, hit };
    }
  }
  return best;
}

function slashPathMatches<T>(
  entries: readonly PathEntry<T>[],
  query: string,
): PathMatch<T>[] {
  const parts = query.split("/").filter(Boolean);
  if (parts.length === 0 || parts.length > MAX_SLASH_SEGMENTS) return [];
  const trailingSlash = query.endsWith("/");
  const segmentsByEntry = entries.map((entry) => splitSegments(entry.path));
  const texts = [
    ...new Set(
      segmentsByEntry.flatMap((segments) => segments.map((s) => s.text)),
    ),
  ];
  const findText = createFinder(
    texts.map((text) => ({ text })),
    "smart-case",
  );
  const hitsByPart = new Map<string, Map<string, Hit<Searchable>>>();
  for (const part of parts) {
    if (hitsByPart.has(part)) continue;
    const hits = findText(part);
    hitsByPart.set(part, new Map(hits.map((hit) => [hit.item.text, hit])));
  }
  const leafHits = hitsByPart.get(parts[parts.length - 1]!)!;

  const matches: PathMatch<T>[] = [];
  entries.forEach((entry, entryIndex) => {
    const segments = segmentsByEntry[entryIndex]!;
    const positions: number[] = [];
    let score = 0;
    let start: number | null = null;
    let next = 0;
    for (const [partIndex, part] of parts.entries()) {
      const skipFileName = trailingSlash && partIndex === parts.length - 1;
      const best = bestSegment(
        segments,
        next,
        skipFileName,
        hitsByPart.get(part)!,
      );
      if (best === null) return;
      const segmentStart = best.segment.start;
      positions.push(...sorted(best.hit.positions, segmentStart));
      start = Math.min(start ?? Infinity, segmentStart + best.hit.start);
      score += best.hit.score + (best.index === next ? SCORE.nextSegment : 0);
      next = best.index + 1;
    }
    const leafHit = leafHits.get(segments[segments.length - 1]!.text);
    if (leafHit !== undefined) score += SCORE.leafSegment + leafHit.score;
    matches.push({
      ...entry,
      positions: sorted(positions),
      score: TIER.slashPath + score,
      start: start ?? 0,
    });
  });
  return matches;
}

export function rankPaths<T>(
  entries: readonly PathEntry<T>[],
  query: string,
): PathMatch<T>[] {
  const best = (matches: PathMatch<T>[]) =>
    bestPerKey(matches, (match) => match.path, comparePaths);
  if (/^\/+$/u.test(query)) return [];
  if (!query.includes("/")) {
    const folderNames =
      query.length < MIN_FOLDER_NAME_QUERY
        ? []
        : entries
            .map((entry) => folderNameMatch(entry, query))
            .filter((match) => match !== null);
    return best([...plainMatches(entries, query), ...folderNames]);
  }
  const prefixMatches = folderPrefixMatches(entries, query);
  if (prefixMatches.length > 0 && query.endsWith("/")) {
    return best(prefixMatches);
  }
  const slashMatches = slashPathMatches(entries, query);
  return best([
    ...(prefixMatches.length > 0
      ? prefixMatches
      : plainMatches(entries, query)),
    ...slashMatches,
  ]);
}
