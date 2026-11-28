import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button } from "@cloudroom/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Input } from "@cloudroom/shared-ui/input";
import { ResourceListState } from "@cloudroom/shared-ui/resource-list";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { CreateWithTemplatesButton } from "@/components/create-via-prompt-examples";
import { CREATE_PLUGIN_PROMPT } from "@cloudroom/client-core";
import {
  AddPluginDialog,
  type AddPluginInitial,
} from "@/components/plugin/management/AddPluginDialog";
import {
  BrowsePluginsTab,
  type OpenPlugin,
} from "@/components/plugin/management/BrowsePluginsTab";
import { useCheckPluginUpdates } from "@/components/plugin/management/CheckPluginUpdatesButton";
import { InstalledPluginsTab } from "@/components/plugin/management/InstalledPluginsTab";
import {
  PluginSafeModeBanner,
  usePluginSafeModeToggle,
} from "@/components/plugin/management/PluginSafeMode";
import { PluginAuthorPage } from "@/components/plugin/management/PluginAuthorPage";
import {
  pluginPublisherFilterId,
  pluginPublisherFilterOptions,
} from "@/components/plugin/plugin-provenance";
import { pluginHasSettingsTab } from "@/components/settings/settings-sections";
import {
  usePluginList,
  type PluginListItem,
} from "@/hooks/queries/plugin-settings-queries";
import {
  getPluginConfigurationRoutePath,
  getPluginDetailRoutePath,
  getRootComposeRoutePath,
  getSettingsRoutePath,
} from "@/lib/route-paths";

export type InstalledPluginSort = "recent" | "name";

/** Recent puts the last plugin the user changed first. Ties, and the name sort, go A to Z. */
export function sortInstalledPlugins(
  plugins: readonly PluginListItem[],
  sort: InstalledPluginSort,
  changedAt: (plugin: PluginListItem) => number = (plugin) => plugin.changedAt,
): PluginListItem[] {
  const byName = (left: PluginListItem, right: PluginListItem) =>
    (left.name ?? left.id).localeCompare(right.name ?? right.id) ||
    left.id.localeCompare(right.id);
  return [...plugins].sort((left, right) =>
    sort === "name"
      ? byName(left, right)
      : changedAt(right) - changedAt(left) || byName(left, right),
  );
}

/** Everything the installed list used to keep in its toolbar, behind one button. */
function InstalledPluginsMenu({
  hasPlugins,
  sort,
  onSortChange,
  typeOptions,
  activeTypes,
  onTypesChange,
}: {
  hasPlugins: boolean;
  sort: InstalledPluginSort;
  onSortChange: (sort: InstalledPluginSort) => void;
  typeOptions: readonly { id: string; label: string }[];
  activeTypes: readonly string[];
  onTypesChange: (values: string[]) => void;
}) {
  const check = useCheckPluginUpdates();
  const { safeMode, toggle } = usePluginSafeModeToggle();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "size-7 shrink-0 p-0 text-muted-foreground hover:text-foreground",
            activeTypes.length > 0 && "bg-state-active text-foreground",
          )}
          aria-label={
            activeTypes.length > 0
              ? `Plugin list options: ${activeTypes.length} type filters on`
              : "Plugin list options"
          }
        >
          <Icon name="MoreHorizontal" className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-44"
        mobileTitle="Plugin list"
      >
        {hasPlugins ? (
          <DropdownMenuItem
            disabled={check.isPending}
            onSelect={() => check.mutate()}
          >
            <Icon name="RotateCcw" className="size-4" aria-hidden />
            Check for updates
          </DropdownMenuItem>
        ) : null}
        {safeMode === false ? (
          <DropdownMenuItem
            disabled={toggle.isPending}
            onSelect={() => toggle.mutate(true)}
          >
            <Icon name="SecurityCheck" className="size-4" aria-hidden />
            Turn on safe mode
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            onSortChange(sort === "recent" ? "name" : "recent");
          }}
        >
          <Icon name="ArrowUpDown" className="size-4" aria-hidden />
          {sort === "recent" ? "Sort by name" : "Sort by recent"}
        </DropdownMenuItem>
        {typeOptions.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-subtle-foreground">
              Type
            </DropdownMenuLabel>
            {typeOptions.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.id}
                checked={activeTypes.includes(option.id)}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(checked) =>
                  onTypesChange(
                    checked === true
                      ? [...activeTypes, option.id]
                      : activeTypes.filter((value) => value !== option.id),
                  )
                }
              >
                <span className="truncate text-xs">{option.label}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PluginsOverview({
  onOpenPlugin,
  selectedPluginId = null,
  mode = "browse",
  renderDetail,
}: {
  mode?: "installed" | "browse";
  /** Installed mode: the plugin in the URL. */
  selectedPluginId?: string | null;
  onOpenPlugin?: OpenPlugin;
  /** Installed mode: the selected plugin's page, drawn beside the list. */
  renderDetail?: (pluginId: string) => ReactNode;
} = {}) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const listQuery = usePluginList({ enabled: true });
  const plugins = useMemo(
    () => listQuery.data?.plugins ?? [],
    [listQuery.data?.plugins],
  );
  const authorKey = searchParams.get("author");
  const [installedQuery, setInstalledQuery] = useState("");
  const [installedSort, setInstalledSort] =
    useState<InstalledPluginSort>("recent");
  // The dates seen when the page opened, so a row the user just changed doesn't jump away.
  const [openedChangedAt] = useState(() => new Map<string, number>());
  const [typeFilters, setTypeFilters] = useState<string[]>([]);
  const typeFilterOptions = useMemo(
    () => pluginPublisherFilterOptions(plugins),
    [plugins],
  );
  const activeTypeFilters = useMemo(() => {
    const offered = new Set(typeFilterOptions.map((option) => option.id));
    return typeFilters.filter((value) => offered.has(value));
  }, [typeFilterOptions, typeFilters]);
  const normalizedInstalledQuery = installedQuery.trim().toLowerCase();
  const [addDialog, setAddDialog] = useState<{
    open: boolean;
    initial: AddPluginInitial | null;
  }>({ open: false, initial: null });

  const visiblePlugins = useMemo(() => {
    for (const plugin of plugins) {
      if (!openedChangedAt.has(plugin.id)) {
        openedChangedAt.set(plugin.id, plugin.changedAt);
      }
    }
    const matching = plugins.filter((plugin) => {
      if (
        activeTypeFilters.length > 0 &&
        !activeTypeFilters.includes(pluginPublisherFilterId(plugin))
      ) {
        return false;
      }
      if (normalizedInstalledQuery.length === 0) return true;
      return [
        plugin.id,
        plugin.name ?? "",
        plugin.description ?? "",
        plugin.version,
        plugin.sourceDisplay,
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedInstalledQuery);
    });
    return sortInstalledPlugins(
      matching,
      installedSort,
      (plugin) => openedChangedAt.get(plugin.id) ?? plugin.changedAt,
    );
  }, [
    activeTypeFilters,
    installedSort,
    normalizedInstalledQuery,
    openedChangedAt,
    plugins,
  ]);
  const startCreatePlugin = (prompt?: string) => {
    navigate(getRootComposeRoutePath(), {
      state: {
        focusPrompt: true,
        initialPrompt: prompt ?? CREATE_PLUGIN_PROMPT,
        replaceInitialPrompt: prompt !== undefined,
      },
    });
  };

  const createActions = (
    <>
      <CreateWithTemplatesButton
        kind="plugin"
        label="New plugin"
        menuActions={[
          {
            label: "Install from source",
            icon: "Download",
            onSelect: () => setAddDialog({ open: true, initial: null }),
          },
        ]}
        onCreate={startCreatePlugin}
      />
    </>
  );

  let content: ReactNode;
  if (mode === "browse") {
    const openPlugin =
      onOpenPlugin ??
      ((pluginId: string) => navigate(getPluginDetailRoutePath({ pluginId })));
    content =
      authorKey === null ? (
        <BrowsePluginsTab
          actions={createActions}
          onInstall={(initial) => setAddDialog({ open: true, initial })}
          onOpenPlugin={openPlugin}
        />
      ) : (
        <PluginAuthorPage
          authorKey={authorKey}
          onInstall={(initial) => setAddDialog({ open: true, initial })}
          onOpenPlugin={openPlugin}
        />
      );
  } else {
    // With no plugin in the URL, wide screens show the first one that opens beside the list
    // (a plugin with its own Settings tab opens there). Narrow screens show the list alone.
    const shownPluginId =
      selectedPluginId ??
      visiblePlugins.find((plugin) => !pluginHasSettingsTab(plugin.id))?.id ??
      null;
    content = (
      <div className="@container/plugins flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4 md:px-5">
        <PluginSafeModeBanner />
        <div className="flex min-h-0 flex-1 gap-3">
          <aside
            aria-label="Installed plugins"
            className={cn(
              "flex min-h-0 w-[17.5rem] shrink-0 flex-col rounded-[14px] bg-sidebar text-sidebar-foreground shadow-message @max-3xl/plugins:w-full",
              selectedPluginId !== null && "@max-3xl/plugins:hidden",
            )}
          >
            <div className="flex shrink-0 items-center gap-1 p-2">
              <div className="relative min-w-0 flex-1">
                <Icon
                  name="Search"
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-sidebar-foreground"
                />
                <Input
                  aria-label="Search installed plugins"
                  className="h-9 border-sidebar-border bg-sidebar-accent pl-9 text-sm"
                  placeholder="Search plugins…"
                  value={installedQuery}
                  onChange={(event) => setInstalledQuery(event.target.value)}
                />
              </div>
              <InstalledPluginsMenu
                hasPlugins={plugins.length > 0}
                sort={installedSort}
                onSortChange={setInstalledSort}
                typeOptions={typeFilterOptions}
                activeTypes={activeTypeFilters}
                onTypesChange={setTypeFilters}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {listQuery.isError ? (
                <ResourceListState
                  state="error"
                  message="Couldn't load plugins."
                  onRetry={() => void listQuery.refetch()}
                />
              ) : listQuery.isFetching && listQuery.data === undefined ? (
                <ResourceListState state="loading" message="Loading plugins" />
              ) : plugins.length > 0 && visiblePlugins.length === 0 ? (
                <ResourceListState
                  state="empty"
                  message={
                    normalizedInstalledQuery === ""
                      ? "No plugins match these filters."
                      : activeTypeFilters.length > 0
                        ? `No plugins match "${installedQuery}" with these filters.`
                        : `No plugins match "${installedQuery}"`
                  }
                />
              ) : (
                <InstalledPluginsTab
                  plugins={visiblePlugins}
                  selectedPluginId={shownPluginId}
                  onOpenPlugin={(pluginId) =>
                    navigate(getPluginConfigurationRoutePath({ pluginId }))
                  }
                />
              )}
            </div>
            <div className="shrink-0 border-t border-sidebar-border p-2 [&>div]:w-full [&>div>button:first-child]:flex-1">
              {createActions}
            </div>
          </aside>
          <div
            className={cn(
              "flex min-h-0 min-w-0 flex-1 flex-col",
              selectedPluginId === null && "@max-3xl/plugins:hidden",
            )}
          >
            <Link
              to={getSettingsRoutePath("plugins")}
              className="hidden shrink-0 items-center gap-1.5 px-4 pb-1 text-sm text-muted-foreground hover:text-foreground @max-3xl/plugins:flex"
            >
              <Icon name="ArrowLeft" className="size-4" aria-hidden />
              Installed plugins
            </Link>
            {shownPluginId !== null && renderDetail
              ? renderDetail(shownPluginId)
              : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">{content}</div>
      <AddPluginDialog
        open={addDialog.open}
        initial={addDialog.initial}
        onOpenChange={(open) =>
          setAddDialog((current) => ({ ...current, open }))
        }
        onInstalled={(plugin) =>
          navigate(getPluginConfigurationRoutePath({ pluginId: plugin.id }))
        }
      />
    </>
  );
}
