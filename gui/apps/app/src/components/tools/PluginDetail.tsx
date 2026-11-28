import { useSyncExternalStore, type ReactNode } from "react";
import {
  ResourceActivitySection,
  ResourceDetailPage,
  ResourceDetailReleaseSection,
  ResourceDetailStack,
  ResourceInstallControl,
  ResourceOverflowMenu,
  type ResourceOverflowMenuItem,
} from "@cloudroom/shared-ui/resource-list";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@cloudroom/shared-ui/tooltip";
import { formatHomePathForDisplay } from "@cloudroom/shared-ui/lib/utils";
import { Icon } from "@cloudroom/shared-ui/icon";
import { PluginSettingsContent } from "@/components/plugin/PluginSettings";
import { CheckPluginUpdatesButton } from "@/components/plugin/management/CheckPluginUpdatesButton";
import {
  PluginDetailReleaseControl,
  PluginDetailReleaseStatus,
  pluginHasUpdateSurfaces,
} from "@/components/plugin/management/PluginUpdatesCard";
import {
  CatalogEntryIconChip,
  formatAbsoluteDate,
  pluginInstallCountPresentation,
} from "@/components/plugin/management/plugin-ui";
import {
  PluginMarketplaceCategoryPill,
  PluginMarketplaceHeaderMetadata,
  PluginMarketplaceListingSections,
  PluginMoreFromAuthorSection,
} from "@/components/plugin/management/PluginMarketplaceListing";
import { pluginRuntimeStatusPresentation } from "@/components/plugin/management/plugin-status";
import { PluginAuthorLink } from "@/components/plugin/management/PluginAuthorLink";
import { pluginImprovedByCloudroom } from "@/components/plugin/management/plugin-marketplace-author";
import {
  PluginHealthBanner,
  PluginIncludes,
  PluginSchedules,
  PluginServices,
} from "@/components/tools/PluginCapabilities";
import {
  PluginDetailFieldRow,
  PluginDetailTable,
} from "@/components/tools/plugin-detail-table";
import { PluginBannerBar } from "@/components/tools/plugin-detail-banner";
import {
  usePluginSource,
  type PluginCatalogSearchEntry,
} from "@/hooks/queries/plugin-catalog-queries";
import type { PluginListItem } from "@/hooks/queries/plugin-settings-queries";
import {
  getPluginFrontendDiagnostics,
  subscribePluginFrontendDiagnostics,
  type PluginFrontendDiagnostic,
} from "@/lib/plugin-frontend";
import { useClipboardCopy } from "@/lib/clipboard";

export function pluginIsLocalSource(plugin: PluginListItem): boolean {
  return plugin.source.startsWith("path:");
}

export function pluginRemovalLabel(plugin: PluginListItem): string {
  return pluginIsLocalSource(plugin) ? "Remove from Cloudroom" : "Uninstall";
}

export function pluginRemovalDescription(plugin: PluginListItem): string {
  return pluginIsLocalSource(plugin)
    ? `Remove "${plugin.id}" from Cloudroom and delete its settings, secrets, and schedules? Its source files stay on disk. To move it to another directory, install the new path instead; that keeps its settings.`
    : `Uninstall "${plugin.id}" and delete its managed files, settings, secrets, and schedules?`;
}

function PluginPath({ path }: { path: string }) {
  const { copied, copy } = useClipboardCopy({
    text: path,
    errorMessage: "Failed to copy path.",
  });

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`Copy plugin path: ${path}`}
            onClick={() => void copy()}
            className="group -ml-1.5 mt-0.5 inline-flex max-w-full cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-subtle-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <span className="min-w-0 truncate text-left font-mono">
              {formatHomePathForDisplay(path)}
            </span>
            <Icon
              name={copied ? "Check" : "Copy"}
              className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
              aria-hidden
            />
          </button>
        </TooltipTrigger>
        <TooltipContent>{copied ? "Copied" : "Copy path"}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function CatalogPluginDetail({
  entry,
  onInstall,
  catalogEntries,
  onOpenPlugin,
}: {
  entry: PluginCatalogSearchEntry;
  onInstall: (entry: PluginCatalogSearchEntry) => void;
  catalogEntries: readonly PluginCatalogSearchEntry[];
  onOpenPlugin: (pluginId: string, marketplace?: string) => void;
}) {
  const count = pluginInstallCountPresentation(entry.installs);
  return (
    <ResourceDetailPage
      maxWidthClassName="max-w-5xl"
      leading={<CatalogEntryIconChip entry={entry} />}
      leadingClassName="size-10"
      title={entry.displayName}
      titleMeta={<PluginMarketplaceCategoryPill entry={entry} />}
      metadata={<PluginMarketplaceHeaderMetadata entry={entry} />}
      actions={
        <ResourceInstallControl
          accessibleLabel={`Install ${entry.displayName}`}
          disabled={!entry.compatible}
          count={count}
          onAction={() => onInstall(entry)}
        />
      }
    >
      <ResourceDetailStack>
        <PluginMarketplaceListingSections entry={entry} />
        <PluginMoreFromAuthorSection
          entry={entry}
          catalogEntries={catalogEntries}
          onOpenPlugin={onOpenPlugin}
        />
      </ResourceDetailStack>
    </ResourceDetailPage>
  );
}

export function CatalogPluginDetailBanner({
  entry,
}: {
  entry: PluginCatalogSearchEntry;
}) {
  if (entry.incompatibleReason === null) return null;
  return (
    <PluginBannerBar
      tone="warning"
      icon="AlertTriangle"
      title="Update Cloudroom to install this plugin"
      detail={entry.incompatibleReason}
    />
  );
}

function pluginHealthBannerState(
  plugin: PluginListItem,
  frontendDiagnostic: PluginFrontendDiagnostic | undefined,
): { plugin: PluginListItem } | null {
  if (!plugin.enabled) return null;
  if (pluginRuntimeStatusPresentation(plugin) !== null) return { plugin };

  if (pluginFrontendDiagnosticRequiresFailureBanner(frontendDiagnostic)) {
    return {
      plugin: {
        ...plugin,
        status: "error",
        statusDetail: null,
      },
    };
  }
  return null;
}

export function pluginFrontendDiagnosticRequiresFailureBanner(
  diagnostic: PluginFrontendDiagnostic | undefined,
): boolean {
  return diagnostic?.status === "failed";
}

export function PluginDetailBanners({ plugin }: { plugin: PluginListItem }) {
  const frontendDiagnostics = useSyncExternalStore(
    subscribePluginFrontendDiagnostics,
    getPluginFrontendDiagnostics,
    getPluginFrontendDiagnostics,
  );
  const frontendDiagnostic = frontendDiagnostics.get(plugin.id);
  const banner = pluginHealthBannerState(plugin, frontendDiagnostic);
  if (banner === null) return null;
  return (
    <PluginHealthBanner
      plugin={banner.plugin}
      runtimeStatus={pluginRuntimeStatusPresentation(banner.plugin)}
    />
  );
}

export function PluginDetail({
  plugin,
  pending,
  openSourceDisabled,
  onEdit,
  onOpenSource,
  onDelete,
  catalogEntry,
  catalogEntries,
  onOpenPlugin,
  settings,
}: {
  /** Extra settings the app adds for this plugin, drawn under the plugin's own. */
  settings?: ReactNode;
  plugin: PluginListItem;
  pending: boolean;
  openSourceDisabled: boolean;
  onEdit: (plugin: PluginListItem) => void;
  onOpenSource: (plugin: PluginListItem) => void;
  onDelete: (plugin: PluginListItem) => void;
  catalogEntry?: PluginCatalogSearchEntry;
  catalogEntries: readonly PluginCatalogSearchEntry[];
  onOpenPlugin: (pluginId: string, marketplace?: string) => void;
}) {
  const sourceQuery = usePluginSource(plugin.id, {
    enabled: pluginHasUpdateSurfaces(plugin),
  });
  const hasUpdateManagement = pluginHasUpdateSurfaces(plugin);
  const canEditSource = pluginIsLocalSource(plugin);
  const updatesWithRoom = plugin.source.startsWith("builtin:");
  const installedAt = sourceQuery.data?.installedAt ?? null;
  const installedValue = updatesWithRoom
    ? "Updates with Cloudroom"
    : installedAt !== null
      ? formatAbsoluteDate(installedAt)
      : sourceQuery.isPending
        ? "Loading…"
        : "Install date unavailable";
  const hasReleaseControl =
    hasUpdateManagement && plugin.updateState.availableVersion !== null;
  const hasReleaseUpdate =
    hasUpdateManagement &&
    (plugin.updateState.availableVersion !== null ||
      plugin.updateState.blockedVersion !== null ||
      plugin.updateState.lastFailure !== null);
  const pluginName = plugin.name ?? plugin.id;
  const overflowItems: ResourceOverflowMenuItem[] = [
    ...(canEditSource
      ? [
          {
            label: "Edit",
            icon: "Edit" as const,
            disabled: pending,
            onSelect: () => onEdit(plugin),
          },
          {
            label: "Open source",
            icon: "ExternalLink" as const,
            disabled: pending || openSourceDisabled,
            disabledReason: openSourceDisabled
              ? "No editor configured"
              : undefined,
            onSelect: () => onOpenSource(plugin),
          },
        ]
      : []),
    {
      label: pluginRemovalLabel(plugin),
      icon: "Trash2" as const,
      tone: "destructive" as const,
      disabled: pending || plugin.provenance === "builtin",
      disabledReason:
        plugin.alwaysEnabled
          ? "Built into Cloudroom; always on."
          : plugin.provenance === "builtin"
            ? "Included with Cloudroom; disable this plugin instead."
            : undefined,
      onSelect: () => onDelete(plugin),
    },
  ];
  const releaseAndCapabilities = (
    <>
      <ResourceDetailReleaseSection
        label="Release"
        actions={
          hasReleaseControl ? (
            <PluginDetailReleaseControl plugin={plugin} />
          ) : hasUpdateManagement ? (
            <CheckPluginUpdatesButton
              pluginId={plugin.id}
              appearance="inline"
            />
          ) : undefined
        }
      >
        <PluginDetailTable>
          <PluginDetailFieldRow
            label={updatesWithRoom ? "Delivery" : "Installed"}
            labelClassName="font-medium"
          >
            {installedValue}
          </PluginDetailFieldRow>
          <PluginDetailFieldRow label="Version" labelClassName="font-medium">
            <span className="font-mono text-xs">{plugin.version}</span>
          </PluginDetailFieldRow>
          {hasReleaseUpdate ? (
            <PluginDetailFieldRow label="Update" stackOnNarrow>
              <PluginDetailReleaseStatus plugin={plugin} />
            </PluginDetailFieldRow>
          ) : null}
          {plugin.publisherLabel !== null ? (
            <PluginDetailFieldRow label="Publisher" labelClassName="font-medium">
              {plugin.publisherLabel}
            </PluginDetailFieldRow>
          ) : null}
          {catalogEntry !== undefined &&
          catalogEntry.author !== null &&
          !pluginImprovedByCloudroom(catalogEntry) ? (
            <PluginDetailFieldRow label="Author" labelClassName="font-medium">
              <PluginAuthorLink
                entry={catalogEntry}
                className="rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {catalogEntry.author.name}
              </PluginAuthorLink>
            </PluginDetailFieldRow>
          ) : null}
          <PluginDetailFieldRow label="Location" labelClassName="font-medium">
            <PluginPath path={plugin.rootDir} />
          </PluginDetailFieldRow>
        </PluginDetailTable>
      </ResourceDetailReleaseSection>
      <PluginIncludes plugin={plugin} />
      {plugin.services.length > 0 ? (
        <ResourceActivitySection label="Background services">
          <PluginServices plugin={plugin} />
        </ResourceActivitySection>
      ) : null}
      {plugin.schedules.length > 0 ? (
        <ResourceActivitySection label="Scheduled jobs">
          <PluginSchedules plugin={plugin} />
        </ResourceActivitySection>
      ) : null}
    </>
  );
  return (
    <PluginSettingsContent
      plugin={plugin}
      headerActions={
        <ResourceOverflowMenu
          label={`${pluginName} actions`}
          items={overflowItems}
        />
      }
      detailSections={
        <>
          {catalogEntry === undefined ? null : (
            <>
              <PluginMarketplaceListingSections
                entry={catalogEntry}
                lead={false}
              />
              <PluginMoreFromAuthorSection
                entry={catalogEntry}
                catalogEntries={catalogEntries}
                onOpenPlugin={onOpenPlugin}
              />
            </>
          )}
          {releaseAndCapabilities}
        </>
      }
    >
      {settings}
    </PluginSettingsContent>
  );
}
