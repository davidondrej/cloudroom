import type { ReactNode } from "react";
import type { TerminalSession } from "@cloudroom/server-contract";
import { COARSE_POINTER_COMPACT_ICON_SIZE_CLASS } from "@cloudroom/shared-ui/coarse-pointer-sizing";
import { Icon, type IconName } from "@cloudroom/shared-ui/icon";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import { getBrowserUrlHost } from "@/lib/browser-url";
import type { SecondaryFileFixedPanelTab } from "@/lib/fixed-panel-tabs-state";
import type { PluginThreadPanelActionSlot } from "@/lib/plugin-slots";
import { RightPanelFileTabIcon } from "./RightPanelFileTabIcon";
import type {
  SecondaryPanelPaneRenderContext,
  SecondaryPanelRenderableTab,
} from "./secondaryPanelTab";

interface BuildSecondaryPanelTabsOptions {
  tabs: readonly SecondaryFileFixedPanelTab[];
  pluginActions: readonly Pick<
    PluginThreadPanelActionSlot,
    "pluginId" | "id" | "icon" | "layout"
  >[];
  terminalsById: ReadonlyMap<string, TerminalSession>;
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  activateTerminal: (terminalId: string) => void;
  closeTerminal: (terminalId: string) => void;
  renderContent: (
    tab: SecondaryFileFixedPanelTab,
    pane: SecondaryPanelPaneRenderContext,
  ) => ReactNode;
  renderWorkspaceFileIcon?: (path: string) => ReactNode;
}

function tabIcon(name: IconName) {
  return (
    <Icon
      name={name}
      className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
      aria-hidden
    />
  );
}

function fileIcon(path: string) {
  return <RightPanelFileTabIcon path={path} />;
}

function filenameOf(path: string) {
  return path.split("/").at(-1) ?? path;
}

export function buildSecondaryPanelTabs({
  tabs,
  pluginActions,
  terminalsById,
  activateTab,
  closeTab,
  activateTerminal,
  closeTerminal,
  renderContent,
  renderWorkspaceFileIcon = fileIcon,
}: BuildSecondaryPanelTabsOptions): readonly SecondaryPanelRenderableTab[] {
  return tabs.map((tab): SecondaryPanelRenderableTab => {
    const shared = {
      tab,
      contentFillsRegion: false,
      statusLabel: null,
      onSelect: () => activateTab(tab.id),
      onClose: () => closeTab(tab.id),
      renderContent: (pane: SecondaryPanelPaneRenderContext) =>
        renderContent(tab, pane),
    };
    switch (tab.kind) {
      case "browser":
        return {
          ...shared,
          label: (tab.title ?? getBrowserUrlHost(tab.url)) || "Browser",
          leadingVisual: tabIcon("Globe"),
        };
      case "terminal": {
        const session = terminalsById.get(tab.terminalId);
        return {
          ...shared,
          label: session?.title ?? "Terminal",
          leadingVisual: tabIcon("Terminal"),
          statusLabel:
            session === undefined || session.status === "running"
              ? null
              : session.status,
          onSelect: () => activateTerminal(tab.terminalId),
          onClose: () => closeTerminal(tab.terminalId),
        };
      }
      case "workspace-file-preview":
        return {
          ...shared,
          label: filenameOf(tab.path),
          leadingVisual: renderWorkspaceFileIcon(tab.path),
          statusLabel: tab.statusLabel,
        };
      case "host-file-preview":
        return {
          ...shared,
          label: filenameOf(tab.path),
          leadingVisual: fileIcon(tab.path),
        };
      case "thread-storage-file-preview":
        return {
          ...shared,
          label: filenameOf(tab.path),
          isPinned: tab.isPinned,
          leadingVisual: fileIcon(tab.path),
        };
      case "new-tab":
        return {
          ...shared,
          label: "New tab",
          leadingVisual: tabIcon("NewTab"),
        };
      case "plugin-panel": {
        const action = pluginActions.find(
          (action) =>
            action.pluginId === tab.pluginId && action.id === tab.actionId,
        );
        return {
          ...shared,
          label: tab.title,
          contentFillsRegion:
            tab.fileOpenerOwner !== undefined || action?.layout === "flush",
          leadingVisual: (
            <PluginIcon
              pluginId={tab.pluginId}
              icon={action?.icon ?? null}
              className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
            />
          ),
        };
      }
    }
  });
}
