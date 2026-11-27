import { useContext } from "react";
import { PluginContext } from "@/components/plugin/plugin-context";

export function usePortalScopeProps(): {
  "data-room-portaled-overlay": "";
  "data-room-plugin-root"?: "";
  "data-room-plugin"?: string;
  "data-bb-plugin-root"?: "";
  "data-bb-plugin"?: string;
} {
  const pluginId = useContext(PluginContext);
  return pluginId === null
    ? { "data-room-portaled-overlay": "" }
    : {
        "data-room-portaled-overlay": "",
        "data-room-plugin-root": "",
        "data-room-plugin": pluginId,
        // Compat: third-party BB plugins scope their CSS to [data-bb-plugin*].
        "data-bb-plugin-root": "",
        "data-bb-plugin": pluginId,
      };
}
