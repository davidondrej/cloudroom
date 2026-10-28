import { useSetPluginEnabled } from "@/components/plugin/useSetPluginEnabled";
import {
  Suspense,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { matchPath, useLocation, useNavigate } from "react-router-dom";
import "@cloudroom/shared-ui/icon-extended";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { useMutation } from "@tanstack/react-query";
import { buildPluginEditThreadPrompt } from "@cloudroom/shared-ui/resource-edit-prompt";
import { appToast } from "@/components/ui/app-toast";
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
import {
  CatalogPluginDetail,
  CatalogPluginDetailBanner,
  PluginDetail,
  PluginDetailBanners,
  pluginIsLocalSource,
  pluginRemovalDescription,
  pluginRemovalLabel,
} from "@/components/tools/PluginDetail";
import {
  usePluginCatalogSearch,
  type PluginCatalogSearchEntry,
} from "@/hooks/queries/plugin-catalog-queries";
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

function PluginsToolView({
  selectedPluginId,
  onOpenPlugin,
}: {
  selectedPluginId: string | null;
  onOpenPlugin: (pluginId: string, trigger: HTMLButtonElement) => void;
}) {
  return (
    <ResourceScrollPage fillViewport>
      <PluginsOverview
        selectedPluginId={selectedPluginId}
        onOpenPlugin={onOpenPlugin}
      />
    </ResourceScrollPage>
  );
}

function PluginDetailToolView({ pluginId }: { pluginId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [deleteTarget, setDeleteTarget] = useState<PluginListItem | null>(null);
  const [installTarget, setInstallTarget] =
    useState<PluginCatalogSearchEntry | null>(null);
  const listQuery = usePluginList({ enabled: true });
  const catalogQuery = usePluginCatalogSearch("", { enabled: true });
  const plugins = useMemo(
    () => listQuery.data?.plugins ?? [],
    [listQuery.data],
  );
  const {
    canOpenPreferredDirectoryTarget,
    openPathInPreferredDirectoryTarget,
  } = useLocalOpenTargets({
    enabled: plugins.some(
      (plugin) => pluginIsLocalSource(plugin) && plugin.rootDir !== null,
    ),
  });
  const setEnabled = useSetPluginEnabled();
  const pluginToggle = useMutation({
    meta: { showErrorToast: false },
    mutationFn: async (plugin: PluginListItem) => {
      const action = plugin.enabled ? "disable" : "enable";
      try {
        await setEnabled(plugin.id, !plugin.enabled);
      } catch {
        throw new Error(`Failed to ${action} plugin`);
      }
    },
    onSuccess: () => listQuery.refetch(),
    onError: (error) => {
      appToast.error(error instanceof Error ? error.message : String(error));
    },
  });
  const pluginDelete = useMutation({
    meta: { showErrorToast: false },
    mutationFn: (plugin: PluginListItem) => removePlugin(fetch, plugin.id),
    onSuccess: (_data, deletedPlugin) => {
      const isLocal = pluginIsLocalSource(deletedPlugin);
      pluginToast.success(
        isLocal ? "Plugin removed from Cloudroom" : "Plugin uninstalled",
        deletedPlugin,
        "catalog",
      );
      setDeleteTarget(null);
      navigate(
        isPluginsRoutePath(location.pathname)
          ? { pathname: getPluginsRoutePath(), search: location.search }
          : getToolsOwnedCollectionRoutePath("plugins"),
      );
      return listQuery.refetch();
    },
    onError: (error, plugin) => {
      const isLocal = pluginIsLocalSource(plugin);
      pluginToast.error(
        isLocal ? "Plugin removal failed" : "Plugin uninstall failed",
        plugin,
        "installed",
        pluginAdminErrorMessage(error),
      );
    },
  });
  const isLoading = listQuery.isFetching && listQuery.data === undefined;
  const selectedPlugin =
    plugins.find((plugin) => plugin.id === pluginId) ?? null;
  const selectedCatalogEntryId = selectedPlugin?.catalogEntryId ?? null;
  const selectedCatalogMarketplaceName =
    selectedPlugin?.catalogMarketplaceName ?? null;
  const selectedCatalogEntry =
    selectedPlugin === null
      ? (catalogQuery.data?.entries.find(
          (entry) => entry.pluginId === pluginId,
        ) ?? null)
      : selectedCatalogEntryId === null ||
          selectedCatalogMarketplaceName === null
        ? null
        : (catalogQuery.data?.entries.find(
            (entry) =>
              entry.pluginId === selectedPlugin.id &&
              entry.entryId === selectedCatalogEntryId &&
              entry.marketplace === selectedCatalogMarketplaceName,
          ) ?? null);
  useResourceRouteLabel(
    selectedPlugin?.name ??
      selectedPlugin?.id ??
      selectedCatalogEntry?.displayName ??
      null,
  );
  const pendingPluginId =
    pluginToggle.isPending && pluginToggle.variables
      ? pluginToggle.variables.id
      : pluginDelete.isPending && pluginDelete.variables
        ? pluginDelete.variables.id
        : null;
  const handleEditPlugin = useCallback(
    (plugin: PluginListItem) => {
      navigate(getRootComposeRoutePath(), {
        state: {
          focusPrompt: true,
          initialPrompt: buildPluginEditThreadPrompt({
            name: plugin.name ?? plugin.id,
            path: plugin.rootDir,
          }),
          replaceInitialPrompt: true,
        },
      });
    },
    [navigate],
  );
  const handleOpenPluginSource = useCallback(
    (plugin: PluginListItem) => {
      if (!canOpenPreferredDirectoryTarget) return;
      void openPathInPreferredDirectoryTarget({
        path: plugin.rootDir,
        lineNumber: null,
      });
    },
    [canOpenPreferredDirectoryTarget, openPathInPreferredDirectoryTarget],
  );
  const handleOpenCatalogPlugin = useCallback(
    (nextPluginId: string) => {
      navigate({
        pathname: getPluginDetailRoutePath({ pluginId: nextPluginId }),
        search: location.search,
      });
    },
    [location.search, navigate],
  );

  let detailContent: ReactNode;
  if (listQuery.isError) {
    detailContent = (
      <ResourceListState
        state="error"
        message="Couldn't load plugin."
        layout="detail"
        maxWidthClassName="max-w-5xl"
        onRetry={() => void listQuery.refetch()}
      />
    );
  } else if (isLoading) {
    detailContent = (
      <ResourceListState
        state="loading"
        message="Loading plugin"
        layout="detail"
        maxWidthClassName="max-w-5xl"
      />
    );
  } else if (selectedPlugin !== null) {
    detailContent = (
      <PluginDetail
        isLoading={false}
        plugin={selectedPlugin}
        pending={pendingPluginId === selectedPlugin.id}
        openSourceDisabled={!canOpenPreferredDirectoryTarget}
        onToggle={(target) => pluginToggle.mutate(target)}
        onEdit={handleEditPlugin}
        onOpenSource={handleOpenPluginSource}
        onDelete={setDeleteTarget}
        catalogEntry={selectedCatalogEntry ?? undefined}
        catalogEntries={catalogQuery.data?.entries ?? []}
        onOpenPlugin={handleOpenCatalogPlugin}
      />
    );
  } else if (selectedCatalogEntry !== null && !selectedCatalogEntry.installed) {
    detailContent = (
      <CatalogPluginDetail
        entry={selectedCatalogEntry}
        onInstall={setInstallTarget}
        catalogEntries={catalogQuery.data?.entries ?? []}
        onOpenPlugin={handleOpenCatalogPlugin}
      />
    );
  } else if (catalogQuery.isError) {
    detailContent = (
      <ResourceListState
        state="error"
        message="Couldn't load plugin."
        layout="detail"
        maxWidthClassName="max-w-5xl"
        onRetry={() => void catalogQuery.refetch()}
      />
    );
  } else if (catalogQuery.isFetching && catalogQuery.data === undefined) {
    detailContent = (
      <ResourceListState
        state="loading"
        message="Loading plugin"
        layout="detail"
        maxWidthClassName="max-w-5xl"
      />
    );
  } else if (selectedCatalogEntry?.installed) {
    detailContent = (
      <ResourceListState
        state="error"
        message="Couldn't load the installed plugin."
        layout="detail"
        maxWidthClassName="max-w-5xl"
        onRetry={() => void listQuery.refetch()}
      />
    );
  } else {
    detailContent = (
      <ResourceListState
        state="empty"
        message="Plugin not found."
        layout="detail"
        maxWidthClassName="max-w-5xl"
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {selectedPlugin !== null ? (
        <PluginDetailBanners plugin={selectedPlugin} />
      ) : selectedCatalogEntry !== null && !selectedCatalogEntry.installed ? (
        <CatalogPluginDetailBanner entry={selectedCatalogEntry} />
      ) : null}
      <div className="min-h-0 flex-1">
        <ResourceScrollPage>
          {detailContent}
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
          <AddPluginDialog
            open={installTarget !== null}
            initial={
              installTarget === null
                ? null
                : addPluginInitialFromEntry(installTarget)
            }
            onOpenChange={(open) => {
              if (!open) setInstallTarget(null);
            }}
            onInstalled={() => void listQuery.refetch()}
          />
        </ResourceScrollPage>
      </div>
    </div>
  );
}

export function PluginDetailPaneView({ pluginId }: { pluginId: string }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={<ResourceBodyFallback />}>
          <PluginDetailToolView pluginId={pluginId} />
        </Suspense>
      </div>
    </div>
  );
}

export function PluginsView({ pluginId }: { pluginId?: string } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const focusReturnRef = useRef<HTMLButtonElement | null>(null);
  const catalogQuery = usePluginCatalogSearch("", {
    enabled: pluginId !== undefined,
  });
  const listQuery = usePluginList({ enabled: pluginId !== undefined });

  const openPlugin = useCallback(
    (nextPluginId: string, trigger: HTMLButtonElement) => {
      focusReturnRef.current = trigger;
      navigate({
        pathname: getPluginDetailRoutePath({ pluginId: nextPluginId }),
        search: location.search,
      });
    },
    [location.search, navigate],
  );
  const closeCard = useCallback(() => {
    navigate({
      pathname: getPluginsRoutePath(),
      search: location.search,
    });
    const focusTarget = focusReturnRef.current;
    window.requestAnimationFrame(() => {
      if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
    });
  }, [location.search, navigate]);
  const label =
    catalogQuery.data?.entries.find((entry) => entry.pluginId === pluginId)
      ?.displayName ??
    listQuery.data?.plugins.find((plugin) => plugin.id === pluginId)?.name ??
    pluginId ??
    "Plugin";

  return (
    <div className="@container/plugins relative -mx-4 -mb-4 -mt-4 flex min-h-0 min-w-0 flex-1 overflow-hidden md:-mx-5 md:-mb-5 md:-mt-5">
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Suspense fallback={<ResourceBodyFallback />}>
          <PluginsToolView
            selectedPluginId={pluginId ?? null}
            onOpenPlugin={openPlugin}
          />
        </Suspense>
      </div>
      {pluginId === undefined ? null : (
        <aside
          aria-label={`${label} details`}
          className="flex w-[min(36rem,48%)] shrink-0 flex-col py-3 pr-3 @max-3xl/plugins:absolute @max-3xl/plugins:inset-0 @max-3xl/plugins:z-20 @max-3xl/plugins:w-full @max-3xl/plugins:bg-background @max-3xl/plugins:p-0"
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-lg @max-3xl/plugins:rounded-none @max-3xl/plugins:border-0 @max-3xl/plugins:shadow-none">
            <div className="flex h-10 shrink-0 items-center justify-end px-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-foreground"
                aria-label={`Close ${label}`}
                onClick={closeCard}
              >
                <Icon name="X" className="size-4" aria-hidden />
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <Suspense fallback={<ResourceBodyFallback />}>
                <PluginDetailToolView pluginId={pluginId} />
              </Suspense>
            </div>
          </div>
        </aside>
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
