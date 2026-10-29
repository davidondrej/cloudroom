import { useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  ResourceCollectionViewport,
  ResourceInstallControl,
  ResourceListState,
  ResourceToolbar,
} from "@cloudroom/shared-ui/resource-list";
import { Switch } from "@cloudroom/shared-ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@cloudroom/shared-ui/toggle-group";
import {
  PluginSafeModeBanner,
  PluginSafeModeButton,
} from "@/components/plugin/management/PluginSafeMode";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { usePluginCatalogSearch } from "@/hooks/queries/plugin-catalog-queries";
import {
  usePluginList,
  type PluginListItem,
} from "@/hooks/queries/plugin-settings-queries";
import {
  addPluginInitialFromEntry,
  type AddPluginInitial,
} from "./AddPluginDialog";
import { usePluginEnabledToggle } from "./InstalledPluginsTab";
import { PluginRowSignalView } from "./PluginRowSignal";
import { UpdatePluginDialog } from "./UpdatePluginDialog";
import {
  catalogEntryKey,
  filterPluginRows,
  groupPluginRows,
  pluginListFilter,
  pluginListRows,
  pluginRowHasUpdate,
  type PluginListFilter,
  type PluginListGroup,
  type PluginListRow,
} from "./plugin-browse-discovery";
import { pluginRowSignal } from "./plugin-status";
import { CatalogEntryIconChip, PluginLogoChip } from "./plugin-ui";

export const PLUGINS_LIST_BAND_CLASSES =
  "mx-auto w-full max-w-3xl px-4 md:px-5";
export const PLUGINS_LIST_SCROLL_CONTENT_CLASS = "[&>div]:block!";

type OpenPlugin = (pluginId: string, trigger: HTMLButtonElement) => void;

const EMPTY_MESSAGES: Record<PluginListFilter, string> = {
  all: "No plugins match this search.",
  installed: "No installed plugins match this search.",
  updates: "All plugins are up to date.",
};

export function BrowsePluginsTab({
  actions,
  selectedPluginId,
  onInstall,
  onOpenPlugin,
}: {
  actions: ReactNode;
  selectedPluginId: string | null;
  onInstall: (initial: AddPluginInitial) => void;
  onOpenPlugin: OpenPlugin;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("query") ?? "";
  const filter = pluginListFilter(searchParams.get("view"));
  const catalogQuery = usePluginCatalogSearch("", { enabled: true });
  const listQuery = usePluginList({ enabled: true });
  const rows = useMemo(
    () =>
      pluginListRows(
        catalogQuery.data?.entries ?? [],
        listQuery.data?.plugins ?? [],
      ),
    [catalogQuery.data?.entries, listQuery.data?.plugins],
  );
  const catalogMatches = useCatalogSearchMatches(query);
  const updateCount = rows.filter(pluginRowHasUpdate).length;
  const groups = useMemo(
    () =>
      groupPluginRows(filterPluginRows(rows, filter, query, catalogMatches)),
    [catalogMatches, filter, query, rows],
  );

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  let content: ReactNode;
  if (catalogQuery.isPending && rows.length === 0) {
    content = <ResourceListState state="loading" message="Loading plugins" />;
  } else if (catalogQuery.isError && rows.length === 0) {
    content = (
      <ResourceListState
        state="error"
        message="The plugin catalog is not available."
        onRetry={() => void catalogQuery.refetch()}
      />
    );
  } else if (groups.length === 0) {
    content = (
      <ResourceListState state="empty" message={EMPTY_MESSAGES[filter]} />
    );
  } else {
    content = (
      <PluginRowGroups
        groups={groups}
        selectedPluginId={selectedPluginId}
        onInstall={onInstall}
        onOpenPlugin={onOpenPlugin}
      />
    );
  }

  return (
    <ResourceCollectionViewport
      scrollId="plugins-browse-results"
      contentClassName={PLUGINS_LIST_SCROLL_CONTENT_CLASS}
      bandClassName={PLUGINS_LIST_BAND_CLASSES}
      toolbar={
        <ResourceToolbar
          searchValue={query}
          searchPlaceholder="Search plugins"
          onSearchChange={(value) => setParam("query", value)}
          controls={
            <>
              <PluginFilterToggle
                value={filter}
                updateCount={updateCount}
                onChange={(next) =>
                  setParam("view", next === "all" ? null : next)
                }
              />
              <PluginSafeModeButton />
            </>
          }
          action={actions}
        />
      }
    >
      <div className={cn("space-y-3 pb-8", PLUGINS_LIST_BAND_CLASSES)}>
        <PluginSafeModeBanner />
        {catalogQuery.isError && rows.length > 0 ? (
          <p className="px-3 text-xs text-warning-text" role="status">
            The plugin catalog is not available. Showing installed plugins.
          </p>
        ) : null}
        {content}
      </div>
    </ResourceCollectionViewport>
  );
}

export function useCatalogSearchMatches(
  query: string,
): ReadonlySet<string> | null {
  const debouncedQuery = useDebouncedValue(query.trim(), 300);
  const searchQuery = usePluginCatalogSearch(debouncedQuery, {
    enabled: debouncedQuery !== "",
  });
  return useMemo(
    () =>
      debouncedQuery === "" || searchQuery.data === undefined
        ? null
        : new Set(searchQuery.data.entries.map(catalogEntryKey)),
    [debouncedQuery, searchQuery.data],
  );
}

function PluginFilterToggle({
  value,
  updateCount,
  onChange,
}: {
  value: PluginListFilter;
  updateCount: number;
  onChange: (value: PluginListFilter) => void;
}) {
  const options: { value: PluginListFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "installed", label: "Installed" },
    {
      value: "updates",
      label: updateCount > 0 ? `Updates ${updateCount}` : "Updates",
    },
  ];
  return (
    <ToggleGroup
      type="single"
      aria-label="Filter plugins"
      value={value}
      onValueChange={(next) => {
        if (next !== "") onChange(pluginListFilter(next));
      }}
      className="h-8 gap-0.5 rounded-md border border-input bg-background p-0.5"
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          className="h-6 rounded-sm px-2.5 text-xs font-medium text-muted-foreground shadow-none hover:bg-state-hover hover:text-foreground data-[state=on]:bg-state-active data-[state=on]:text-foreground data-[state=on]:hover:bg-state-active"
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function PluginRowGroups({
  groups,
  selectedPluginId,
  onInstall,
  onOpenPlugin,
}: {
  groups: readonly PluginListGroup[];
  selectedPluginId: string | null;
  onInstall: (initial: AddPluginInitial) => void;
  onOpenPlugin: OpenPlugin;
}) {
  const [updateTargetId, setUpdateTargetId] = useState<string | null>(null);
  const updateTarget =
    updateTargetId === null
      ? null
      : (groups
          .flatMap((group) => group.rows)
          .find((row) => row.plugin?.id === updateTargetId)?.plugin ?? null);
  return (
    <>
      <div className="space-y-5" data-testid="plugin-list">
        {groups.map((group) => (
          <section key={group.key} aria-label={group.label}>
            <h2 className="px-3 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              {group.label}
            </h2>
            <div className="space-y-0.5">
              {group.rows.map((row) => (
                <PluginRow
                  key={row.key}
                  row={row}
                  selected={row.pluginId === selectedPluginId}
                  onInstall={onInstall}
                  onOpenPlugin={onOpenPlugin}
                  onUpdate={setUpdateTargetId}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
      {updateTarget !== null ? (
        <UpdatePluginDialog
          plugin={updateTarget}
          open
          onOpenChange={(open) => {
            if (!open) setUpdateTargetId(null);
          }}
        />
      ) : null}
    </>
  );
}

function PluginRow({
  row,
  selected,
  onInstall,
  onOpenPlugin,
  onUpdate,
}: {
  row: PluginListRow;
  selected: boolean;
  onInstall: (initial: AddPluginInitial) => void;
  onOpenPlugin: OpenPlugin;
  onUpdate: (pluginId: string) => void;
}) {
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const open = () => {
    if (openButtonRef.current !== null) {
      onOpenPlugin(row.pluginId, openButtonRef.current);
    }
  };
  return (
    <div
      data-testid={`plugin-row-${row.pluginId}`}
      data-selected={selected || undefined}
      className={cn(
        "group flex min-w-0 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-state-hover",
        selected &&
          "bg-state-active shadow-[inset_2px_0_0_var(--primary)] hover:bg-state-active",
      )}
      onClick={(event) => {
        if ((event.target as Element).closest("button, a, [data-row-action]")) {
          return;
        }
        open();
      }}
    >
      <PluginRowIcon row={row} onStatusClick={open} />
      <div className="min-w-0 flex-1">
        <button
          ref={openButtonRef}
          type="button"
          aria-label={`Open ${row.title} details`}
          aria-current={selected ? "true" : undefined}
          onClick={open}
          className="block max-w-full truncate rounded-sm text-left text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {row.title}
        </button>
        {row.description === "" ? null : (
          <p className="truncate text-xs text-muted-foreground">
            {row.description}
          </p>
        )}
      </div>
      <div
        data-row-action
        className="flex shrink-0 cursor-default items-center gap-1.5"
      >
        {row.plugin !== null ? (
          <InstalledPluginControls
            plugin={row.plugin}
            title={row.title}
            onUpdate={() => onUpdate(row.plugin?.id ?? row.pluginId)}
          />
        ) : row.entry !== null && !row.installed ? (
          <ResourceInstallControl
            accessibleLabel={`Install ${row.title}`}
            className="h-7 px-2.5 text-xs"
            onAction={() =>
              row.entry && onInstall(addPluginInitialFromEntry(row.entry))
            }
          />
        ) : null}
      </div>
    </div>
  );
}

function PluginRowIcon({
  row,
  onStatusClick,
}: {
  row: PluginListRow;
  onStatusClick: () => void;
}) {
  const signal = row.plugin === null ? null : pluginRowSignal(row.plugin);
  return (
    <span className="relative shrink-0">
      {row.entry !== null ? (
        <CatalogEntryIconChip
          entry={row.entry}
          className="size-8"
          iconClassName="size-4"
        />
      ) : row.plugin !== null ? (
        <PluginLogoChip
          plugin={row.plugin}
          className="size-8"
          iconClassName="size-4"
        />
      ) : null}
      {signal?.kind === "status" ? (
        <span className="absolute -bottom-1 -right-1">
          <PluginRowSignalView
            signal={signal}
            statusPresentation="badge"
            onUpdateClick={() => {}}
            onStatusClick={onStatusClick}
          />
        </span>
      ) : null}
    </span>
  );
}

function InstalledPluginControls({
  plugin,
  title,
  onUpdate,
}: {
  plugin: PluginListItem;
  title: string;
  onUpdate: () => void;
}) {
  const { toggle, enabled } = usePluginEnabledToggle(plugin);
  const signal = pluginRowSignal(plugin);
  return (
    <>
      {signal?.kind === "update" ? (
        <PluginRowSignalView
          signal={signal}
          onUpdateClick={onUpdate}
          onStatusClick={() => {}}
        />
      ) : null}
      <Switch
        checked={enabled}
        disabled={toggle.isPending}
        onCheckedChange={(next) => toggle.mutate(next)}
        aria-label={`${enabled ? "Disable" : "Enable"} ${title}`}
      />
    </>
  );
}
