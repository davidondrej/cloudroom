import { PageShell } from "@/components/ui/page-shell.js";
import { EmptyStatePanel } from "@cloudroom/shared-ui/empty-state";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import { usePluginFrontendsSettled } from "@/lib/plugin-frontend-boot-state";
import { usePluginSlots } from "@/lib/plugin-slots";

const PLUGIN_PANEL_TOP_PADDING_CLASS =
  "room-zoom pt-[calc(var(--room-app-chrome-row-height)/var(--room-desktop-zoom,1)+1rem)] md:pt-[calc(var(--room-app-chrome-row-height)/var(--room-desktop-zoom,1)+1.25rem)]";

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
  const { navPanels, projectActions } = usePluginSlots();
  const pluginsSettled = usePluginFrontendsSettled();
  const panel =
    navPanels.find(
      (candidate) =>
        candidate.pluginId === pluginId && candidate.path === panelPath,
    ) ?? null;

  // A project action's page (`experimental_projectAction`) shares this route: its id is the path and the project's
  // id the sub-path. It has no sidebar entry, so it is not a nav panel.
  const projectAction =
    panel === null
      ? (projectActions.find(
          (candidate) =>
            candidate.pluginId === pluginId && candidate.id === panelPath,
        ) ?? null)
      : null;
  if (projectAction !== null && subPath !== "") {
    return (
      <div
        className="-m-4 flex min-h-0 flex-1 flex-col overflow-hidden md:-m-5"
        data-testid="plugin-project-action-body"
      >
        <PluginSlotMount
          key={`${projectAction.pluginId}/${projectAction.id}/${projectAction.generation}/${subPath}`}
          pluginId={projectAction.pluginId}
          slotKind="projectAction"
          slotId={projectAction.id}
          instanceId={subPath}
        >
          <projectAction.component projectId={subPath.split("/")[0] ?? ""} />
        </PluginSlotMount>
      </div>
    );
  }

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
