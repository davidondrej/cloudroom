import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  matchPath,
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router";
import "@cloudroom/shared-ui/icon-extended";
import { Icon } from "@cloudroom/shared-ui/icon";
import { useMutation } from "@tanstack/react-query";
import { buildPluginEditThreadPrompt } from "@cloudroom/shared-ui/resource-edit-prompt";
import { OverflowFade } from "@/components/ui/overflow-fade";
import { useScrollOverflowState } from "@/components/thread/timeline/useScrollOverflowState";
import {
  ConfirmDeleteDialog,
  ConfirmDeleteDialogContent,
} from "@/components/dialogs/ConfirmDeleteDialog";
import {
  AddPluginDialog,
  addPluginInitialFromEntry,
} from "@/components/plugin/management/AddPluginDialog";
import {
  ResourceListState,
  useResourceRouteLabel,
} from "@cloudroom/shared-ui/resource-list";
import { Skeleton } from "@cloudroom/shared-ui/skeleton";
import { PluginsOverview } from "@/components/plugin/PluginsOverview";
import { PluginSettingsPage } from "@/components/plugin/PluginSettings";
import {
  CatalogPluginDetail,
  CatalogPluginDetailBanner,
  PluginDetail,
  PluginDetailBanners,
  pluginIsLocalSource,
  pluginRemovalDescription,
  pluginRemovalLabel,
} from "@/components/tools/PluginDetail";
import { usePluginCatalogSearch } from "@/hooks/queries/plugin-catalog-queries";
import { OFFICIAL_MARKETPLACE } from "@/components/plugin/management/plugin-browse-discovery";
import {
  removePlugin,
  usePluginList,
  type PluginListItem,
} from "@/hooks/queries/plugin-settings-queries";
import { useLocalOpenTargets } from "@/hooks/useLocalOpenTargets";
import { pluginAdminErrorMessage } from "@/lib/plugin-admin-error";
import {
  REGISTRY_SKILLS_ROUTE_PATH,
  SKILLS_ROUTE_PATH,
  getPluginConfigurationRoutePath,
  getPluginDetailRoutePath,
  getPluginsRoutePath,
  getRootComposeRoutePath,
  isPluginsRoutePath,
} from "@/lib/route-paths";
import { getToolsOwnedCollectionRoutePath } from "@/components/tools/tools-navigation";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { SkillsLibrary } from "@/components/tools/SkillsLibrary";
import { pluginToast } from "@/components/plugin/PluginNotificationDescription";

function ResourceBodyFallback() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 pb-4 pt-2 md:px-5">
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-24 w-full rounded-md" />
          <Skeleton className="h-24 w-full rounded-md" />
        </div>
      </div>
    </div>
  );
}

function ResourceScrollPage({
  children,
  fillViewport = false,
}: {
  children: ReactNode;
  fillViewport?: boolean;
}) {
  const {
    scrollRef,
    topSentinelRef,
    bottomSentinelRef,
    aboveOverflow,
    belowOverflow,
  } = useScrollOverflowState<HTMLDivElement>({ measureOverflow: true });
  if (fillViewport) {
    return (
      <div className="box-border h-full w-full pb-4 pt-3 md:pt-4">
        {children}
      </div>
    );
  }
  return (
    <div className="relative h-full overflow-hidden">
      <div ref={scrollRef} className="h-full overflow-y-auto">
        <div ref={topSentinelRef} aria-hidden className="h-0" />
        <div
          className={cn(
            "mx-auto box-border min-h-full w-full space-y-4 px-4 pb-4 pt-3 md:px-5 md:pt-4",
            "max-w-5xl",
          )}
        >
          {children}
        </div>
        <div ref={bottomSentinelRef} aria-hidden className="h-0" />
      </div>
      {aboveOverflow ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0">
          <OverflowFade placement="below" tone="background" />
        </div>
      ) : null}
      {belowOverflow ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-0">
          <OverflowFade placement="above" tone="background" />
        </div>
      ) : null}
    </div>
  );
}

/** Opens a plugin: its one page in Settings when installed, else its listing. */
export function useOpenPlugin(): (
  pluginId: string,
  marketplace?: string,
) => void {
  const navigate = useNavigate();
  const location = useLocation();
  const listQuery = usePluginList({ enabled: true });
  const plugins = listQuery.data?.plugins;
  return useCallback(
    (pluginId: string, marketplace?: string) => {
      if (plugins?.some((plugin) => plugin.id === pluginId)) {
        navigate(getPluginConfigurationRoutePath({ pluginId }));
        return;
      }
      // On the Plugins page, the way back keeps the list's search and filter.
      const search = new URLSearchParams(
        isPluginsRoutePath(location.pathname) ? location.search : "",
      );
      if (marketplace === undefined) search.delete(LISTING_MARKETPLACE_PARAM);
      else search.set(LISTING_MARKETPLACE_PARAM, marketplace);
      navigate({
        pathname: getPluginDetailRoutePath({ pluginId }),
        search: search.size === 0 ? "" : `?${search}`,
      });
    },
    [location.pathname, location.search, navigate, plugins],
  );
}

/** Picks the listing when two marketplaces list the same plugin ID. */
const LISTING_MARKETPLACE_PARAM = "marketplace";

function PluginPageState({
  state,
  message,
  onRetry,
}: {
  state: "loading" | "error" | "empty";
  message: string;
  onRetry?: () => void;
}) {
  return (
    <ResourceListState
      state={state}
      message={message}
      layout="detail"
      maxWidthClassName="max-w-5xl"
      onRetry={onRetry}
    />
  );
}

/** An installed plugin's one page: switch, settings, release and capabilities. Settings hosts it. */
export function PluginDetailPaneView({
  pluginId,
  settings,
  inFlow = false,
}: {
  pluginId: string;
  /** Extra settings the app adds for this plugin. */
  settings?: ReactNode;
  /** Flows inside a Settings tab instead of scrolling on its own. */
  inFlow?: boolean;
}) {
  const navigate = useNavigate();
  const openPlugin = useOpenPlugin();
  const [deleteTarget, setDeleteTarget] = useState<PluginListItem | null>(null);
  const listQuery = usePluginList({ enabled: true });
  const catalogQuery = usePluginCatalogSearch("", { enabled: true });
  const plugin =
    listQuery.data?.plugins.find((entry) => entry.id === pluginId) ?? null;
  const catalogEntry =
    plugin === null
      ? undefined
      : catalogQuery.data?.entries.find(
          (entry) =>
            entry.pluginId === plugin.id &&
            entry.entryId === plugin.catalogEntryId &&
            entry.marketplace === plugin.catalogMarketplaceName,
        );
  const {
    canOpenPreferredDirectoryTarget,
    openPathInPreferredDirectoryTarget,
  } = useLocalOpenTargets({
    enabled: plugin !== null && pluginIsLocalSource(plugin),
  });
  const pluginDelete = useMutation({
    meta: { showErrorToast: false },
    mutationFn: (target: PluginListItem) => removePlugin(fetch, target.id),
    onSuccess: (_data, deleted) => {
      pluginToast.success(
        pluginIsLocalSource(deleted)
          ? "Plugin removed from Cloudroom"
          : "Plugin uninstalled",
        deleted,
        "catalog",
      );
      setDeleteTarget(null);
      navigate(getToolsOwnedCollectionRoutePath("plugins"));
      return listQuery.refetch();
    },
    onError: (error, target) => {
      pluginToast.error(
        pluginIsLocalSource(target)
          ? "Plugin removal failed"
          : "Plugin uninstall failed",
        target,
        "installed",
        pluginAdminErrorMessage(error),
      );
    },
  });
  useResourceRouteLabel(plugin?.name ?? plugin?.id ?? null);

  let content: ReactNode;
  if (plugin !== null) {
    content = (
      <PluginDetail
        plugin={plugin}
        pending={pluginDelete.isPending}
        openSourceDisabled={!canOpenPreferredDirectoryTarget}
        onEdit={(target) =>
          navigate(getRootComposeRoutePath(), {
            state: {
              focusPrompt: true,
              initialPrompt: buildPluginEditThreadPrompt({
                name: target.name ?? target.id,
                path: target.rootDir,
              }),
              replaceInitialPrompt: true,
            },
          })
        }
        onOpenSource={(target) =>
          void openPathInPreferredDirectoryTarget({
            path: target.rootDir,
            lineNumber: null,
          })
        }
        onDelete={setDeleteTarget}
        catalogEntry={catalogEntry}
        catalogEntries={catalogQuery.data?.entries ?? []}
        onOpenPlugin={openPlugin}
        settings={settings}
      />
    );
  } else if (listQuery.isError) {
    content = (
      <PluginPageState
        state="error"
        message="Couldn't load plugin."
        onRetry={() => void listQuery.refetch()}
      />
    );
  } else if (listQuery.data === undefined) {
    // A Settings tab keeps its own skeleton, which Accounts skips: it has no header to flash.
    content = inFlow ? (
      <PluginSettingsPage pluginId={pluginId} />
    ) : (
      <PluginPageState state="loading" message="Loading plugin" />
    );
  } else {
    // A stale link to a plugin that is no longer installed opens its listing.
    content = <Navigate to={getPluginDetailRoutePath({ pluginId })} replace />;
  }

  const banner =
    plugin === null ? null : <PluginDetailBanners plugin={plugin} />;
  const removeDialog = (
    <ConfirmDeleteDialog
      open={deleteTarget !== null}
      onOpenChange={(open) => {
        if (!open && !pluginDelete.isPending) setDeleteTarget(null);
      }}
    >
      {deleteTarget ? (
        <ConfirmDeleteDialogContent
          title={
            pluginIsLocalSource(deleteTarget)
              ? "Remove plugin from Cloudroom?"
              : "Uninstall plugin?"
          }
          description={pluginRemovalDescription(deleteTarget)}
          confirmLabel={pluginRemovalLabel(deleteTarget)}
          pending={pluginDelete.isPending}
          onConfirm={() => pluginDelete.mutate(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      ) : null}
    </ConfirmDeleteDialog>
  );
  if (inFlow) {
    return (
      <div className="space-y-4">
        {banner}
        {content}
        {removeDialog}
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {banner}
      <div className="min-h-0 flex-1">
        <ResourceScrollPage>
          {content}
          {removeDialog}
        </ResourceScrollPage>
      </div>
    </div>
  );
}

/** The listing of a plugin that is not installed: what it does, and Install. */
function PluginListing({ pluginId }: { pluginId: string }) {
  const openPlugin = useOpenPlugin();
  const [searchParams] = useSearchParams();
  const [installOpen, setInstallOpen] = useState(false);
  const catalogQuery = usePluginCatalogSearch("", { enabled: true });
  const entries = catalogQuery.data?.entries ?? [];
  const marketplace = searchParams.get(LISTING_MARKETPLACE_PARAM);
  const matches = entries.filter(
    (candidate) => candidate.pluginId === pluginId,
  );
  // Without a marketplace in the URL, the official one wins, then the first listing.
  const entry =
    matches.find(
      (candidate) =>
        candidate.marketplace === (marketplace ?? OFFICIAL_MARKETPLACE),
    ) ?? (marketplace === null ? matches[0] : undefined);
  useResourceRouteLabel(entry?.displayName ?? null);

  if (entry?.installed) {
    return (
      <Navigate to={getPluginConfigurationRoutePath({ pluginId })} replace />
    );
  }

  if (entry === undefined) {
    return catalogQuery.isError ? (
      <PluginPageState
        state="error"
        message="Couldn't load plugin."
        onRetry={() => void catalogQuery.refetch()}
      />
    ) : catalogQuery.data === undefined ? (
      <PluginPageState state="loading" message="Loading plugin" />
    ) : (
      <PluginPageState state="empty" message="Plugin not found." />
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <CatalogPluginDetailBanner entry={entry} />
      <div className="min-h-0 flex-1">
        <ResourceScrollPage>
          <CatalogPluginDetail
            entry={entry}
            onInstall={() => setInstallOpen(true)}
            catalogEntries={entries}
            onOpenPlugin={openPlugin}
          />
          {/* Once installed, the Plugins page redirects to the plugin's page in Settings. */}
          <AddPluginDialog
            open={installOpen}
            initial={addPluginInitialFromEntry(entry)}
            onOpenChange={setInstallOpen}
          />
        </ResourceScrollPage>
      </div>
    </div>
  );
}

export function PluginsView({ pluginId }: { pluginId?: string } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const openPlugin = useOpenPlugin();
  const focusReturnRef = useRef<HTMLButtonElement | null>(null);
  const listQuery = usePluginList({ enabled: true });
  const isInstalled =
    pluginId !== undefined &&
    (listQuery.data?.plugins.some((plugin) => plugin.id === pluginId) ?? false);
  const backSearch = new URLSearchParams(location.search);
  backSearch.delete(LISTING_MARKETPLACE_PARAM);

  // Back at the list, focus returns to the row that opened the listing.
  useEffect(() => {
    if (pluginId !== undefined) return;
    const focusTarget = focusReturnRef.current;
    focusReturnRef.current = null;
    if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
  }, [pluginId]);

  // Old links to an installed plugin, and a plugin that was just installed.
  if (pluginId !== undefined && isInstalled) {
    return (
      <Navigate to={getPluginConfigurationRoutePath({ pluginId })} replace />
    );
  }

  return (
    <div className="relative -mx-4 -mb-4 -mt-4 flex min-h-0 min-w-0 flex-1 overflow-hidden md:-mx-5 md:-mb-5 md:-mt-5">
      {/* The list stays mounted under a listing, so the way back keeps its scroll and search. */}
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 overflow-hidden",
          pluginId !== undefined && "invisible",
        )}
      >
        <Suspense fallback={<ResourceBodyFallback />}>
          <ResourceScrollPage fillViewport>
            <PluginsOverview
              onOpenPlugin={(nextPluginId, trigger, marketplace) => {
                focusReturnRef.current = trigger;
                openPlugin(nextPluginId, marketplace);
              }}
            />
          </ResourceScrollPage>
        </Suspense>
      </div>
      {pluginId === undefined ? null : (
        <div className="absolute inset-0 flex flex-col bg-background">
          <div className="mx-auto w-full max-w-5xl shrink-0 px-4 pt-3 md:px-5 md:pt-4">
            <button
              type="button"
              className="-ml-1 inline-flex items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() =>
                navigate({
                  pathname: getPluginsRoutePath(),
                  search: backSearch.size === 0 ? "" : `?${backSearch}`,
                })
              }
            >
              <Icon name="ChevronLeft" className="size-3" aria-hidden />
              Browse plugins
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <Suspense fallback={<ResourceBodyFallback />}>
              {/* Until the installed list arrives, a listing could offer Install for an installed plugin. */}
              {listQuery.data === undefined && !listQuery.isError ? (
                <ResourceBodyFallback />
              ) : (
                <PluginListing key={pluginId} pluginId={pluginId} />
              )}
            </Suspense>
          </div>
        </div>
      )}
    </div>
  );
}

export function SkillsView() {
  const location = useLocation();
  const isCollection =
    matchPath(SKILLS_ROUTE_PATH, location.pathname) !== null ||
    location.pathname === REGISTRY_SKILLS_ROUTE_PATH;

  return (
    <div className="-mx-4 -mb-4 -mt-4 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:-mx-5 md:-mb-5 md:-mt-5">
      <div className="min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={<ResourceBodyFallback />}>
          <ResourceScrollPage fillViewport={isCollection}>
            <SkillsLibrary />
          </ResourceScrollPage>
        </Suspense>
      </div>
    </div>
  );
}
