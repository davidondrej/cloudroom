import { describe, expect, it } from "vitest";
import type { PluginCatalogSearchEntry } from "@/hooks/queries/plugin-catalog-queries";
import { makePluginListItem } from "@/test/fixtures/plugins";
import {
  filterPluginRows,
  groupPluginRows,
  pluginListRows,
} from "./plugin-browse-discovery";

function entry(
  id: string,
  overrides: Partial<PluginCatalogSearchEntry> = {},
): PluginCatalogSearchEntry {
  return {
    entryId: id,
    pluginId: id,
    displayName: id,
    description: `${id} description`,
    icon: null,
    iconUrl: null,
    iconTinted: false,
    categoryId: "thread-content",
    category: "Thread Content",
    screenshots: [],
    collections: [],
    source: `builtin:${id}`,
    repositoryUrl: null,
    marketplace: "bb-official",
    marketplaceDisplayName: "Cloudroom Official",
    publisherKey: "bb-official",
    publisherLabel: "Cloudroom Official",
    official: true,
    author: null,
    installed: false,
    installs: null,
    compatible: true,
    incompatibleReason: null,
    ...overrides,
  };
}

describe("plugin list rows", () => {
  const github = entry("github", {
    categoryId: "code-and-reviews",
    category: "Code & Reviews",
    installed: true,
  });
  const theme = entry("theme", {
    categoryId: "themes-and-appearance",
    category: "Themes & Appearance",
  });
  const loose = entry("loose", { categoryId: undefined, category: undefined });
  const plugins = [
    makePluginListItem({
      id: "github",
      updateState: { availableVersion: "0.3.0" },
    }),
    makePluginListItem({ id: "my-tool", name: "My tool" }),
  ];
  const rows = pluginListRows([github, theme, loose], plugins);

  it("joins catalog entries with installed plugins and keeps local ones", () => {
    expect(
      rows.map((row) => [row.pluginId, row.installed, row.plugin?.id ?? null]),
    ).toEqual([
      ["github", true, "github"],
      ["theme", false, null],
      ["loose", false, null],
      ["my-tool", true, "my-tool"],
    ]);
  });

  it("groups by catalog category order, then uncategorized, then local", () => {
    expect(
      groupPluginRows(rows).map((group) => [
        group.label,
        group.rows.map((row) => row.pluginId),
      ]),
    ).toEqual([
      ["Themes & Appearance", ["theme"]],
      ["Code & Reviews", ["github"]],
      ["More plugins", ["loose"]],
      ["Your plugins", ["my-tool"]],
    ]);
  });

  it("filters by installed, updates, and search text", () => {
    const ids = (filtered: typeof rows) => filtered.map((row) => row.pluginId);
    expect(ids(filterPluginRows(rows, "installed", ""))).toEqual([
      "github",
      "my-tool",
    ]);
    expect(ids(filterPluginRows(rows, "updates", ""))).toEqual(["github"]);
    expect(ids(filterPluginRows(rows, "all", "THEMES"))).toEqual(["theme"]);
  });
});
