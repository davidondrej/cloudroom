import { useSetPluginEnabled } from "@/components/plugin/useSetPluginEnabled";
import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UPDATE_ACTION_ICON } from "@cloudroom/domain/update-state";
import { Button } from "@cloudroom/shared-ui/button";
import { EmptyState } from "@cloudroom/shared-ui/empty-state";
import { Icon } from "@cloudroom/shared-ui/icon";
import { PROJECT_LIST_ACTION_BUTTON_CLASS } from "@/components/sidebar/ProjectList";
import { appToast } from "@/components/ui/app-toast.js";
import { invalidatePluginList } from "@/hooks/cache-owners/plugin-cache-owner";
import type { PluginListItem } from "@/hooks/queries/plugin-settings-queries";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { pluginRowSignal } from "./plugin-status";
import { PluginLogo, UPDATE_ICON_STYLE } from "./plugin-ui";

/** The installed plugins as sidebar rows: icon and name. The selected one opens beside the list. */
export function InstalledPluginsTab({
  plugins,
  selectedPluginId,
  onOpenPlugin,
}: {
  plugins: readonly PluginListItem[];
  selectedPluginId: string | null;
  onOpenPlugin: (pluginId: string) => void;
}) {
  if (plugins.length === 0) {
    return (
      <EmptyState message="No plugins installed. Browse the catalog, create a plugin, or run room-cli plugin install <source>." />
    );
  }

  return (
    <div className="space-y-0.5">
      {plugins.map((plugin) => (
        <InstalledPluginRow
          key={plugin.id}
          plugin={plugin}
          selected={plugin.id === selectedPluginId}
          onOpen={() => onOpenPlugin(plugin.id)}
        />
      ))}
    </div>
  );
}

export function InstalledPluginRow({
  plugin,
  selected,
  onOpen,
}: {
  plugin: PluginListItem;
  selected: boolean;
  onOpen: () => void;
}) {
  const rowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  const signal = pluginRowSignal(plugin);
  const name = plugin.name ?? plugin.id;
  return (
    <Button
      ref={rowRef}
      size="sm"
      variant="ghost"
      data-testid={`plugin-row-${plugin.id}`}
      aria-label={`${name} plugin details`}
      aria-current={selected ? "page" : undefined}
      className={cn(
        PROJECT_LIST_ACTION_BUTTON_CLASS,
        "w-full",
        selected && "bg-sidebar-accent text-sidebar-foreground",
      )}
      onClick={onOpen}
    >
      <PluginLogo
        plugin={plugin}
        className={cn("size-4", !plugin.enabled && "opacity-60")}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-left",
          !plugin.enabled && "opacity-60",
        )}
      >
        {name}
      </span>
      {!plugin.enabled ? (
        <span className="shrink-0 text-2xs text-subtle-foreground">Off</span>
      ) : signal?.kind === "status" ? (
        <span
          data-testid={`plugin-runtime-status-${plugin.id}`}
          className={cn(
            "shrink-0 text-2xs font-medium",
            signal.tone === "error"
              ? "text-destructive-text"
              : signal.tone === "warning"
                ? "text-warning-text"
                : "text-muted-foreground",
          )}
        >
          {signal.label}
        </span>
      ) : signal?.kind === "update" ? (
        <Icon
          name={UPDATE_ACTION_ICON}
          className="size-4 shrink-0"
          style={UPDATE_ICON_STYLE}
          aria-label="Update available"
        />
      ) : null}
    </Button>
  );
}

export function usePluginEnabledToggle(plugin: PluginListItem) {
  const queryClient = useQueryClient();
  const setEnabled = useSetPluginEnabled();
  const toggle = useMutation({
    meta: { showErrorToast: false },
    mutationFn: (enabled: boolean) => setEnabled(plugin.id, enabled),
    onError: (error, enabled) => {
      appToast.error(
        `${enabled ? "Enabling" : "Disabling"} ${plugin.id} failed`,
        {
          description: error instanceof Error ? error.message : String(error),
        },
      );
    },
    onSettled: () => invalidatePluginList({ queryClient }),
  });
  return {
    toggle,
    enabled: toggle.isPending ? toggle.variables : plugin.enabled,
  };
}
