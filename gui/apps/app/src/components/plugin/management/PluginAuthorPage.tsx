import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Icon } from "@cloudroom/shared-ui/icon";
import {
  ResourceCollectionViewport,
  ResourceListState,
  ResourceToolbar,
} from "@cloudroom/shared-ui/resource-list";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  type PluginCatalogSearchEntry,
  usePluginCatalogSearch,
} from "@/hooks/queries/plugin-catalog-queries";
import { usePluginList } from "@/hooks/queries/plugin-settings-queries";
import { getPluginsRoutePath } from "@/lib/route-paths";
import type { AddPluginInitial } from "./AddPluginDialog";
import {
  PLUGINS_LIST_BAND_CLASSES,
  PLUGINS_LIST_SCROLL_CONTENT_CLASS,
  PluginRowGroups,
  useCatalogSearchMatches,
} from "./BrowsePluginsTab";
import { PluginAuthorAvatar } from "./PluginAuthorAvatar";
import {
  filterPluginRows,
  groupPluginRows,
  pluginListRows,
} from "./plugin-browse-discovery";
import {
  entriesByMarketplaceAuthor,
  pluginAuthorGithub,
} from "./plugin-marketplace-author";
import { formatUrlLabel } from "./plugin-ui";

function authorForEntries(
  entries: readonly PluginCatalogSearchEntry[],
): PluginCatalogSearchEntry["author"] {
  const nameCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.author === null) continue;
    nameCounts.set(
      entry.author.name,
      (nameCounts.get(entry.author.name) ?? 0) + 1,
    );
  }
  let selected: PluginCatalogSearchEntry["author"] = null;
  for (const entry of entries) {
    if (entry.author === null) continue;
    const candidateCount = nameCounts.get(entry.author.name) ?? 0;
    const selectedCount =
      selected === null ? 0 : (nameCounts.get(selected.name) ?? 0);
    if (
      selected === null ||
      candidateCount > selectedCount ||
      (candidateCount === selectedCount &&
        entry.author.name.length > selected.name.length)
    ) {
      selected = entry.author;
    }
  }
  return selected;
}

export function PluginAuthorPage({
  authorKey,
  selectedPluginId,
  onInstall,
  onOpenPlugin,
}: {
  authorKey: string;
  selectedPluginId: string | null;
  onInstall: (initial: AddPluginInitial) => void;
  onOpenPlugin: (pluginId: string, trigger: HTMLButtonElement) => void;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("query") ?? "";
  const catalogQuery = usePluginCatalogSearch("", { enabled: true });
  const listQuery = usePluginList({ enabled: true });
  const entries = useMemo(
    () =>
      entriesByMarketplaceAuthor(
        (catalogQuery.data?.entries ?? []).filter((entry) => entry.compatible),
        authorKey,
      ),
    [authorKey, catalogQuery.data?.entries],
  );
  const author = useMemo(() => authorForEntries(entries), [entries]);
  const catalogMatches = useCatalogSearchMatches(query);
  const groups = useMemo(
    () =>
      groupPluginRows(
        filterPluginRows(
          pluginListRows(entries, listQuery.data?.plugins ?? []).filter(
            (row) => row.entry !== null,
          ),
          "all",
          query,
          catalogMatches,
        ),
      ),
    [catalogMatches, entries, listQuery.data?.plugins, query],
  );
  const browseParams = new URLSearchParams(searchParams);
  browseParams.delete("author");
  const browseSearch = browseParams.toString();

  const setQuery = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === "") next.delete("query");
    else next.set("query", value);
    setSearchParams(next, { replace: true });
  };

  return (
    <ResourceCollectionViewport
      scrollId="plugin-author-results"
      contentClassName={PLUGINS_LIST_SCROLL_CONTENT_CLASS}
    >
      <div className={cn("space-y-6 pb-8", PLUGINS_LIST_BAND_CLASSES)}>
        <div className="space-y-2">
          <Link
            to={{
              pathname: getPluginsRoutePath(),
              search: browseSearch === "" ? "" : `?${browseSearch}`,
            }}
            className="-ml-1 inline-flex items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Icon name="ChevronLeft" className="size-3" aria-hidden />
            Browse plugins
          </Link>
          {author === null ? null : (
            <div className="flex items-center gap-3">
              <PluginAuthorAvatar
                name={author.name}
                github={pluginAuthorGithub(author)}
                size="page"
              />
              <div className="min-w-0 space-y-1">
                <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-foreground">
                  <span>{author.name}</span>
                  <span className="rounded-md bg-muted px-2 py-1 text-2xs font-medium tabular-nums text-subtle-foreground">
                    {entries.length.toLocaleString()}{" "}
                    {entries.length === 1 ? "plugin" : "plugins"}
                  </span>
                </h1>
                {author.url === null ? null : (
                  <a
                    href={author.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-sm text-xs text-subtle-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {formatUrlLabel(author.url)}
                    <Icon name="ExternalLink" className="size-3" aria-hidden />
                    <span className="sr-only">Opens in a new tab</span>
                  </a>
                )}
              </div>
            </div>
          )}
        </div>

        {catalogQuery.isPending ? (
          <ResourceListState state="loading" message="Loading author" />
        ) : catalogQuery.isError && entries.length === 0 ? (
          <ResourceListState
            state="error"
            message="The author catalog is not available."
            onRetry={() => void catalogQuery.refetch()}
          />
        ) : author === null ? (
          <ResourceListState state="empty" message="Author not found." />
        ) : (
          <section className="space-y-6">
            <ResourceToolbar
              searchValue={query}
              searchPlaceholder="Search plugins"
              onSearchChange={setQuery}
            />
            {catalogQuery.isError ? (
              <p className="text-xs text-warning-text" role="status">
                The latest search failed. The page shows saved catalog results.
              </p>
            ) : null}
            {groups.length === 0 ? (
              <ResourceListState
                state="empty"
                message="No plugins match this search."
              />
            ) : (
              <PluginRowGroups
                groups={groups}
                selectedPluginId={selectedPluginId}
                onInstall={onInstall}
                onOpenPlugin={onOpenPlugin}
              />
            )}
          </section>
        )}
      </div>
    </ResourceCollectionViewport>
  );
}
