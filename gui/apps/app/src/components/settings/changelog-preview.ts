import {
  parseChangelog,
  type ChangelogEntry,
} from "../../../../../changelog-parser";
export type { ChangelogBlock } from "../../../../../changelog-parser";

export const CHANGELOG_LINKS: { page: string | null; source: string | null } = {
  page: "https://www.cloudroom.dev/changelog",
  source: "https://www.cloudroom.dev/changelog/feed",
};
export const RELEASE_META: Record<string, { date: string; headline: string }> =
  {};
export const CHANGELOG_ENTRIES: ChangelogEntry[] = [];

export const LATEST_CHANGELOG_ENTRY: ChangelogEntry | null =
  CHANGELOG_ENTRIES[0] ?? null;

export async function fetchLatestChangelogEntry(
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<ChangelogEntry | null> {
  if (CHANGELOG_LINKS.source === null) return null;
  const response = await fetchFn(CHANGELOG_LINKS.source, { signal });
  if (!response.ok) {
    throw new Error(`Changelog request failed (${response.status})`);
  }
  const [entry] = parseChangelog(await response.text());
  if (entry === undefined) {
    throw new Error("The changelog has no releases");
  }
  return entry;
}
