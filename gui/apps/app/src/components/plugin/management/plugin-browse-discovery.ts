import { PLUGIN_CATALOG_CATEGORIES, pluginCatalogCategory } from "@cloudroom/domain";
import type { PluginCatalogSearchEntry } from "@/hooks/queries/plugin-catalog-queries";
import type { PluginListItem } from "@/hooks/queries/plugin-settings-queries";

export type PluginListFilter = "all" | "installed" | "updates";

export function pluginListFilter(value: string | null): PluginListFilter {
  return value === "installed" || value === "updates" ? value : "all";
}

export interface PluginListRow {
  key: string;
  pluginId: string;
  title: string;
  description: string;
  installed: boolean;
  entry: PluginCatalogSearchEntry | null;
  plugin: PluginListItem | null;
}

export interface PluginListGroup {
  key: string;
  label: string;
  rows: PluginListRow[];
}

const UNCATEGORIZED_GROUP = { key: "uncategorized", label: "More plugins" };
const NOT_IN_CATALOG_GROUP = { key: "not-in-catalog", label: "Your plugins" };

export function catalogEntryKey(entry: PluginCatalogSearchEntry): string {
  return `${entry.marketplace}/${entry.entryId}`;
}

function installedPluginForEntry(
  entry: PluginCatalogSearchEntry,
  plugins: readonly PluginListItem[],
): PluginListItem | null {
  if (!entry.installed) return null;
  return (
    plugins.find(
      (plugin) =>
        plugin.id === entry.pluginId &&
        plugin.catalogEntryId === entry.entryId &&
        plugin.catalogMarketplaceName === entry.marketplace,
    ) ??
    plugins.find((plugin) => plugin.id === entry.pluginId) ??
    null
  );
}

export function pluginListRows(
  entries: readonly PluginCatalogSearchEntry[],
  plugins: readonly PluginListItem[],
): PluginListRow[] {
  const matchedPluginIds = new Set<string>();
  const rows: PluginListRow[] = [];
  for (const entry of entries) {
    if (!entry.compatible) continue;
    const plugin = installedPluginForEntry(entry, plugins);
    if (plugin !== null) matchedPluginIds.add(plugin.id);
    rows.push({
      key: catalogEntryKey(entry),
      pluginId: entry.pluginId,
      title: entry.displayName,
      description: entry.description,
      installed: entry.installed,
      entry,
      plugin,
    });
  }
  const notInCatalog = plugins
    .filter((plugin) => !matchedPluginIds.has(plugin.id))
    .sort((left, right) =>
      (left.name ?? left.id).localeCompare(right.name ?? right.id),
    );
  for (const plugin of notInCatalog) {
    rows.push({
      key: `installed/${plugin.id}`,
      pluginId: plugin.id,
      title: plugin.name ?? plugin.id,
      description: plugin.description ?? "",
      installed: true,
      entry: null,
      plugin,
    });
  }
  return rows;
}

export function pluginRowHasUpdate(row: PluginListRow): boolean {
  return row.plugin?.updateState.availableVersion != null;
}

export function filterPluginRows(
  rows: readonly PluginListRow[],
  filter: PluginListFilter,
  query: string,
  catalogMatches: ReadonlySet<string> | null = null,
): PluginListRow[] {
  const needle = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter === "installed" && !row.installed) return false;
    if (filter === "updates" && !pluginRowHasUpdate(row)) return false;
    if (needle === "") return true;
    if (row.entry !== null && catalogMatches?.has(row.key)) return true;
    return [
      row.title,
      row.description,
      row.pluginId,
      row.entry?.category ?? "",
      row.entry?.author?.name ?? "",
      row.entry?.publisherLabel ?? row.plugin?.publisherLabel ?? "",
    ]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });
}

function rowGroup(row: PluginListRow): Omit<PluginListGroup, "rows"> {
  if (row.entry === null) return NOT_IN_CATALOG_GROUP;
  const { categoryId, category } = row.entry;
  if (categoryId === undefined || category === undefined) {
    return UNCATEGORIZED_GROUP;
  }
  return {
    key: categoryId,
    label: pluginCatalogCategory(categoryId)?.displayName ?? category,
  };
}

const KNOWN_CATEGORY_RANK = new Map<string, number>(
  PLUGIN_CATALOG_CATEGORIES.map((category, index) => [category.id, index]),
);

function groupRank(key: string): number {
  if (key === NOT_IN_CATALOG_GROUP.key) return Number.MAX_SAFE_INTEGER;
  if (key === UNCATEGORIZED_GROUP.key) return Number.MAX_SAFE_INTEGER - 1;
  return KNOWN_CATEGORY_RANK.get(key) ?? PLUGIN_CATALOG_CATEGORIES.length;
}

export function groupPluginRows(
  rows: readonly PluginListRow[],
): PluginListGroup[] {
  const groups = new Map<string, PluginListGroup>();
  for (const row of rows) {
    const group = rowGroup(row);
    const existing = groups.get(group.key);
    if (existing === undefined) {
      groups.set(group.key, { ...group, rows: [row] });
    } else {
      existing.rows.push(row);
    }
  }
  return [...groups.values()].sort(
    (left, right) => groupRank(left.key) - groupRank(right.key),
  );
}
