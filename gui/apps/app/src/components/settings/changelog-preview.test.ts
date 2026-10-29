import { afterEach, describe, expect, it, vi } from "vitest";
import { parseChangelog } from "../../../../../changelog-parser";
import {
  CHANGELOG_ENTRIES,
  CHANGELOG_LINKS,
  fetchLatestChangelogEntry,
  LATEST_CHANGELOG_ENTRY,
  RELEASE_META,
} from "./changelog-preview";

const SAMPLE = `# Changelog

## 0.37.0

A much faster app on your phone, and a long list of fixes.

### Mobile is much faster

Every tap used to make bb measure the whole page.

- Taps answer at once.
- The sidebar keeps its scroll position.

### Edit a message you already sent

Turn on **Edit messages** in Settings → Experiments.

## 0.36.0

- Fixed a [crash](https://example.test) on launch.
- Tidied \`bb status\` output.
`;

describe("parseChangelog", () => {
  it("keeps a release's sections out of its version list", () => {
    const entries = parseChangelog(SAMPLE);

    expect(entries.map((entry) => entry.version)).toEqual(["0.37.0", "0.36.0"]);
    expect(entries[0].sections.map((section) => section.title)).toEqual([
      "Mobile is much faster",
      "Edit a message you already sent",
    ]);
  });

  it("keeps the website's paragraphs and lists in their release sections", () => {
    const [latest] = parseChangelog(SAMPLE);

    expect(latest.lede).toEqual([
      {
        kind: "paragraph",
        text: "A much faster app on your phone, and a long list of fixes.",
      },
    ]);
    expect(latest.sections[0]).toEqual({
      title: "Mobile is much faster",
      blocks: [
        {
          kind: "paragraph",
          text: "Every tap used to make bb measure the whole page.",
        },
        {
          kind: "list",
          items: [
            "Taps answer at once.",
            "The sidebar keeps its scroll position.",
          ],
        },
      ],
    });
  });

  it("keeps release-level bullets when there are no sections", () => {
    const [, previous] = parseChangelog(SAMPLE);

    expect(previous.sections).toEqual([]);
    expect(previous.lede).toEqual([
      {
        kind: "list",
        items: [
          "Fixed a [crash](https://example.test) on launch.",
          "Tidied `bb status` output.",
        ],
      },
    ]);
  });

  it("joins wrapped paragraph lines and indented bullet continuations", () => {
    const [entry] = parseChangelog(`## 0.0.30

This release introduces multi-machine workflows.
It also adds more ways to customize bb.

- bb Connect lets you securely access bb from other devices
  and share previews from any enrolled machine.
`);

    expect(entry.lede).toEqual([
      {
        kind: "paragraph",
        text: "This release introduces multi-machine workflows. It also adds more ways to customize bb.",
      },
      {
        kind: "list",
        items: [
          "bb Connect lets you securely access bb from other devices and share previews from any enrolled machine.",
        ],
      },
    ]);
  });
});

describe("Cloudroom changelog", () => {
  afterEach(() => {
    CHANGELOG_LINKS.page = null;
    CHANGELOG_LINKS.source = null;
  });

  it("does not present inherited BB releases as Cloudroom updates", () => {
    expect(CHANGELOG_ENTRIES).toEqual([]);
    expect(LATEST_CHANGELOG_ENTRY).toBeNull();
    expect(RELEASE_META).toEqual({});
  });

  it("does not fetch until a Cloudroom source is configured", async () => {
    CHANGELOG_LINKS.source = null;
    const fetchFn = vi.fn(async () => new Response("## 12\n\nA Cloudroom release."));
    expect(await fetchLatestChangelogEntry(fetchFn)).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reads a configured Cloudroom source and reports unusable responses", async () => {
    CHANGELOG_LINKS.source = "https://example.test/cloudroom/changelog.md";
    const signal = new AbortController().signal;
    const fetchFn = vi.fn(async () => new Response("## 12\n\nA Cloudroom release."));
    expect(await fetchLatestChangelogEntry(fetchFn, signal)).toEqual({
      version: "12",
      lede: [{ kind: "paragraph", text: "A Cloudroom release." }],
      sections: [],
    });
    expect(fetchFn).toHaveBeenCalledExactlyOnceWith(CHANGELOG_LINKS.source, {
      signal,
    });
    fetchFn.mockResolvedValueOnce(new Response("", { status: 503 }));
    await expect(fetchLatestChangelogEntry(fetchFn)).rejects.toThrow(
      "Changelog request failed (503)",
    );
    fetchFn.mockResolvedValueOnce(new Response(""));
    await expect(fetchLatestChangelogEntry(fetchFn)).rejects.toThrow(
      "The changelog has no releases",
    );
  });
});
