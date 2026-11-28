import { type ReactNode } from "react";
import { Link } from "react-router";
import { appToast } from "@/components/ui/app-toast";
import {
  getPluginConfigurationRoutePath,
  getPluginDetailRoutePath,
} from "@/lib/route-paths";

interface PluginNotificationTarget {
  id: string;
  name: string | null;
}

/** "installed" links to the plugin's page in Settings, "catalog" to its listing. */
type PluginView = "catalog" | "installed";

function PluginNotificationLink({
  plugin,
  view,
}: {
  plugin: PluginNotificationTarget;
  view: PluginView;
}) {
  const to =
    view === "installed"
      ? getPluginConfigurationRoutePath({ pluginId: plugin.id })
      : getPluginDetailRoutePath({ pluginId: plugin.id });
  return (
    <Link
      to={to}
      className="rounded-sm underline underline-offset-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {plugin.name ?? plugin.id}
    </Link>
  );
}

export function pluginNotificationDescription(
  plugin: PluginNotificationTarget,
  view: PluginView,
  detail?: ReactNode,
): ReactNode {
  return (
    <>
      <PluginNotificationLink plugin={plugin} view={view} />
      {detail === undefined ? null : <> — {detail}</>}
    </>
  );
}

function createPluginToast(tone: "error" | "message" | "success") {
  return (
    title: ReactNode,
    plugin: PluginNotificationTarget,
    view: PluginView,
    detail?: ReactNode,
  ) =>
    appToast[tone](title, {
      description: pluginNotificationDescription(plugin, view, detail),
    });
}

export const pluginToast = {
  error: createPluginToast("error"),
  message: createPluginToast("message"),
  success: createPluginToast("success"),
};
