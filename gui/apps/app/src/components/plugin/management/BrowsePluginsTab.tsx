import { useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  ResourceCollectionViewport,
  ResourceInstallControl,
  ResourceListState,
  ResourceToolbar,
} from "@cloudroom/shared-ui/resource-list";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Switch } from "@cloudroom/shared-ui/switch";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@cloudroom/shared-ui/toggle-group";
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
  popularPluginRows,
  type PluginListFilter,
  type PluginListGroup,
  type PluginListRow,
} from "./plugin-browse-discovery";
import { pluginRowSignal } from "./plugin-status";
import {
  CatalogEntryIconChip,
  PluginLogoChip,
  pluginInstallCountPresentation,
} from "./plugin-ui";

/** Plugins Cloudroom makes itself (docs/scopes/cloudroom-agent.md): its logo in color, and a "By Cloudroom" badge. */
const BY_CLOUDROOM = new Set(["provider-cloudroom-agent"]);
/** Our own plugins with a solid lime icon chip, like the agent's logo (Snippets: scissors, David 2026-11-26). */
const LIME_CHIP = new Set(["snippets"]);
import { PluginsFeatured } from "./PluginsFeatured";
import { PluginIcon } from "@/components/plugin/PluginIcon";

// As wide as the Skills page: the Made by Cloudroom cards need the room.
export const PLUGINS_LIST_BAND_CLASSES =
  "mx-auto w-full max-w-5xl px-4 md:px-5";
export const PLUGINS_LIST_SCROLL_CONTENT_CLASS = "[&>div]:block!";

type OpenPlugin = (pluginId: string, trigger: HTMLButtonElement) => void;

const EMPTY_MESSAGES: Record<PluginListFilter, string> = {
  all: "No plugins match this search.",
  installed: "No installed plugins match this search.",
  updates: "All plugins are up to date.",
  cloudroom: "No Cloudroom plugins match this search.",
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
  const category = searchParams.get("category");
  // The front page: our own plugins on top, then every plugin by popularity.
  const front = filter === "all" && query === "";
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
  } else if (front) {
    content = (
      <PopularPlugins
        groups={groups}
        category={category}
        onCategoryChange={(next) => setParam("category", next)}
        selectedPluginId={selectedPluginId}
        onInstall={onInstall}
        onOpenPlugin={onOpenPlugin}
      />
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
      <div
        className={cn(
          "pb-8",
          front ? "space-y-6" : "space-y-3",
          PLUGINS_LIST_BAND_CLASSES,
        )}
      >
        <PluginSafeModeBanner />
        {catalogQuery.isError && rows.length > 0 ? (
          <p className="px-3 text-xs text-warning-text" role="status">
            The plugin catalog is not available. Showing installed plugins.
          </p>
        ) : null}
        {front ? (
          <PluginsFeatured
            rows={rows}
            onInstall={onInstall}
            onOpenPlugin={onOpenPlugin}
            onSeeAll={() => setParam("view", "cloudroom")}
          />
        ) : null}
        {filter === "cloudroom" ? (
          <div className="flex items-center justify-between px-1">
            <h2 className="text-sm font-medium text-foreground">
              Made by Cloudroom
            </h2>
            <button
              type="button"
              onClick={() => setParam("view", null)}
              className="flex items-center gap-0.5 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Icon name="ChevronLeft" className="size-3.5" aria-hidden />
              All plugins
            </button>
          </div>
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
  const [setUpdateTargetId, updateDialog] = useUpdateDialog(
    groups.flatMap((group) => group.rows),
  );
  return (
    <>
      <div className="space-y-5" data-testid="plugin-list">
        {groups.map((group) => (
          <section
            key={group.key}
            aria-label={group.label}
            className="scroll-mt-3"
          >
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
      {updateDialog}
    </>
  );
}

/** The Update dialog of a list: call the setter with a plugin id, and render the node. */
function useUpdateDialog(rows: readonly PluginListRow[]) {
  const [targetId, setTargetId] = useState<string | null>(null);
  const target =
    targetId === null
      ? null
      : (rows.find((row) => row.plugin?.id === targetId)?.plugin ?? null);
  const dialog =
    target !== null ? (
      <UpdatePluginDialog
        plugin={target}
        open
        onOpenChange={(open) => {
          if (!open) setTargetId(null);
        }}
      />
    ) : null;
  return [setTargetId, dialog] as const;
}

const CATEGORY_PILL_CLASSES =
  "shrink-0 rounded-full border px-3 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function CategoryPill({
  label,
  count,
  selected,
  onSelect,
}: {
  label: string;
  count?: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={
        count === undefined
          ? label
          : `${label}, ${count} ${count === 1 ? "plugin" : "plugins"}`
      }
      onClick={onSelect}
      className={cn(
        CATEGORY_PILL_CLASSES,
        selected
          ? "border-transparent bg-state-active font-medium text-foreground"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      {count === undefined ? null : (
        <span className="ml-1 text-subtle-foreground">{count}</span>
      )}
    </button>
  );
}

/** Every plugin, most installed first. A category pill narrows the list to that category. */
function PopularPlugins({
  groups,
  category,
  onCategoryChange,
  selectedPluginId,
  onInstall,
  onOpenPlugin,
}: {
  groups: readonly PluginListGroup[];
  category: string | null;
  onCategoryChange: (category: string | null) => void;
  selectedPluginId: string | null;
  onInstall: (initial: AddPluginInitial) => void;
  onOpenPlugin: OpenPlugin;
}) {
  const selectedGroup = groups.find((group) => group.key === category);
  const rows = useMemo(
    () =>
      popularPluginRows(
        selectedGroup?.rows ?? groups.flatMap((group) => group.rows),
      ),
    [groups, selectedGroup],
  );
  const [setUpdateTargetId, updateDialog] = useUpdateDialog(rows);
  return (
    <section aria-label="Most popular" className="@container">
      <h2 className="px-1 pb-2 text-sm font-medium text-foreground">
        Most popular
      </h2>
      <div className="relative pb-3">
        <div
          role="group"
          aria-label="Plugin categories"
          className="flex gap-1.5 overflow-x-auto pr-16 [scrollbar-width:none]"
        >
          <CategoryPill
            label="All"
            selected={selectedGroup === undefined}
            onSelect={() => onCategoryChange(null)}
          />
          {groups.map((group) => (
            <CategoryPill
              key={group.key}
              label={group.label}
              count={group.rows.length}
              selected={group === selectedGroup}
              onSelect={() => onCategoryChange(group.key)}
            />
          ))}
        </div>
        <div className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-background to-transparent" />
      </div>
      <div
        className="grid grid-cols-1 gap-x-4 gap-y-0.5 @3xl:grid-cols-2"
        data-testid="plugin-list"
      >
        {rows.map((row, index) => (
          <PluginRow
            key={row.key}
            row={row}
            rank={index + 1}
            selected={row.pluginId === selectedPluginId}
            onInstall={onInstall}
            onOpenPlugin={onOpenPlugin}
            onUpdate={setUpdateTargetId}
          />
        ))}
      </div>
      {updateDialog}
    </section>
  );
}

function PluginRow({
  row,
  rank,
  selected,
  onInstall,
  onOpenPlugin,
  onUpdate,
}: {
  row: PluginListRow;
  /** Its place in the popularity list, which also shows the install count. */
  rank?: number;
  selected: boolean;
  onInstall: (initial: AddPluginInitial) => void;
  onOpenPlugin: OpenPlugin;
  onUpdate: (pluginId: string) => void;
}) {
  const installs =
    rank === undefined
      ? undefined
      : pluginInstallCountPresentation(row.entry?.installs ?? null);
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
      {rank === undefined ? null : (
        <span
          aria-hidden="true"
          className="w-5 shrink-0 text-right text-xs tabular-nums text-subtle-foreground"
        >
          {rank}
        </span>
      )}
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
          {BY_CLOUDROOM.has(row.pluginId) ? (
            <span className="ml-2 rounded-full bg-primary/15 px-1.5 py-0.5 align-middle text-2xs font-medium text-primary">
              By Cloudroom
            </span>
          ) : null}
        </button>
        {row.description === "" ? null : (
          <p className="truncate text-xs text-muted-foreground">
            {row.description}
          </p>
        )}
      </div>
      {installs === undefined ? null : (
        <span
          aria-label={installs.accessibleLabel}
          className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-subtle-foreground"
        >
          <Icon name="Download" className="size-3" aria-hidden />
          {installs.display}
        </span>
      )}
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
      {BY_CLOUDROOM.has(row.pluginId) ? (
        <img
          src="/icon-192.png?v=room"
          alt=""
          aria-hidden="true"
          className="size-8 rounded-[22%] object-cover"
        />
      ) : LIME_CHIP.has(row.pluginId) ? (
        <span
          aria-hidden="true"
          className="grid size-8 place-items-center rounded-[22%] bg-primary text-primary-foreground"
        >
          <PluginIcon
            pluginId={row.pluginId}
            icon={row.plugin?.icon ?? null}
            compactIconUrl={row.entry?.iconUrl ?? undefined}
            className="size-4.5"
          />
        </span>
      ) : row.entry !== null ? (
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
