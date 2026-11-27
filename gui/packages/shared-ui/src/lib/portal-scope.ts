declare const __BB_PLUGIN_ID__: string | undefined;

export function usePortalScopeProps(): {
  "data-room-portaled-overlay": "";
  "data-room-plugin-root"?: "";
  "data-room-plugin"?: string;
  "data-bb-plugin-root"?: "";
  "data-bb-plugin"?: string;
} {
  const pluginId =
    typeof __BB_PLUGIN_ID__ === "string" ? __BB_PLUGIN_ID__ : undefined;
  return {
    "data-room-portaled-overlay": "",
    "data-room-plugin-root": "",
    ...(pluginId !== undefined ? { "data-room-plugin": pluginId } : {}),
    // Compat: third-party BB plugins scope their CSS to [data-bb-plugin*].
    "data-bb-plugin-root": "",
    ...(pluginId !== undefined ? { "data-bb-plugin": pluginId } : {}),
  };
}
