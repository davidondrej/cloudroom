import { describe, expect, it } from "vitest";
import { parseMarketplaceManifest } from "../../../src/services/plugin-catalog/marketplace-manifest.js";

// #1935: kept apart from marketplace-manifest.test.ts, which reads published schema files.
function listedGitUrl(schemaVersion: 1 | 2, url: string): string {
  const parsed = parseMarketplaceManifest(
    {
      schemaVersion,
      name: "bb-community",
      displayName: "BB Community",
      plugins: [
        {
          id: "widgets",
          displayName: "Acme Widgets",
          description: "Widgets for threads.",
          icon: "Zap",
          author: { name: "Acme" },
          source: { git: { url, ref: "v1" } },
        },
      ],
    },
    "manifest",
  );
  const source = parsed.plugins[0]?.source;
  if (source === undefined || !("git" in source)) throw new Error("no git");
  return source.git.url;
}

describe("marketplace git url credentials", () => {
  it("drops every login git would send", () => {
    const clean = "https://github.com/acme/plugins.git";
    for (const version of [1, 2] as const) {
      for (const url of [
        "https://u:ghp_FAKE123@github.com/acme/plugins.git",
        "https://do\\main\\u:ghp_FAKE123@github.com/acme/plugins.git",
        "https://:@github.com/acme/plugins.git",
      ]) {
        expect(listedGitUrl(version, url)).toBe(clean);
      }
      expect(listedGitUrl(version, clean)).toBe(clean);
    }
    expect(
      listedGitUrl(2, "https://u:ghp_FAKE123@github.com:bad/acme/plugins.git"),
    ).toBe("https://github.com:bad/acme/plugins.git");
    expect(
      listedGitUrl(2, "https://u:pa\\ss@github.com/acme/plugins.git"),
    ).toBe(clean);
  });
});
