import { PageShell } from "@/components/ui/page-shell.js";
import { EmptyStatePanel } from "@cloudroom/shared-ui/empty-state";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import { usePluginFrontendsSettled } from "@/lib/plugin-frontend-boot-state";
import { usePluginSlots } from "@/lib/plugin-slots";

const PLUGIN_PANEL_TOP_PADDING_CLASS =
  "bb-zoom pt-[calc(var(--bb-app-chrome-row-height)/var(--bb-desktop-zoom,1)+1rem)] md:pt-[calc(var(--bb-app-chrome-row-height)/var(--bb-desktop-zoom,1)+1.25rem)]";

interface PluginPanelViewProps {
  pluginId: string;
  panelPath: string;
  subPath: string;
}

export function PluginPanelView({
  pluginId,
  panelPath,
  subPath,
}: PluginPanelViewProps) {
  const { navPanels } = usePluginSlots();
  const pluginsSettled = usePluginFrontendsSettled();
  const panel =
    navPanels.find(
      (candidate) =>
        candidate.pluginId === pluginId && candidate.path === panelPath,
    ) ?? null;

  if (panel === null) {
    if (!pluginsSettled) {
      return (
        <PageShell contentClassName={PLUGIN_PANEL_TOP_PADDING_CLASS}>
          {null}
        </PageShell>
      );
    }
    return (
      <PageShell contentClassName={PLUGIN_PANEL_TOP_PADDING_CLASS}>
        <EmptyStatePanel className="rounded-lg p-6 text-sm">
          This plugin panel is not available. The plugin may have been disabled
          or removed.
        </EmptyStatePanel>
      </PageShell>
    );
  }

  return (
    <div
      className="-m-4 flex min-h-0 flex-1 flex-col overflow-hidden md:-m-5"
      data-testid="plugin-panel-body"
    >
      <PluginSlotMount
        key={`${panel.pluginId}/${panel.id}/${panel.generation}`}
        pluginId={panel.pluginId}
        slotKind="navPanel"
        slotId={panel.id}
      >
        <panel.component subPath={subPath} />
      </PluginSlotMount>
    </div>
  );
}
