import type { TelemetryService } from "../system/telemetry.js";
import { isPublicPlugin } from "./plugin-registration.js";

/** Real use of a plugin. Timers, event hooks, and install handlers are not use. */
export type PluginUsageKind = "tool" | "cli" | "mention" | "ui";

type Counts = Record<PluginUsageKind, number>;

interface PluginRow {
  id: string;
  enabled: boolean;
  provenance: "builtin" | "catalog" | "direct";
  catalogMarketplaceName?: string | undefined;
}

const FLUSH_MS = 60 * 60_000;
const SNAPSHOT_MS = 24 * 60 * 60_000;

/**
 * Counts plugin use in memory and sends anonymous totals: one `plugin_usage`
 * event per used plugin each hour, plus a daily `plugins_snapshot` of which
 * plugins are on. Plugins outside Cloudroom's own catalogs are reported as
 * "other", so private plugin names never leave the computer.
 */
export function createPluginUsageTelemetry(args: {
  telemetry: TelemetryService;
  list: () => PluginRow[];
}) {
  let counts = new Map<string, Counts>();
  const timers: NodeJS.Timeout[] = [];
  const publicId = (row: PluginRow | undefined, id: string) =>
    row !== undefined &&
    isPublicPlugin(row.provenance, row.catalogMarketplaceName)
      ? id
      : "other";

  function flush(): void {
    if (counts.size === 0) return;
    const rows = new Map(args.list().map((row) => [row.id, row]));
    const totals = new Map<string, Counts>();
    for (const [id, used] of counts) {
      const key = publicId(rows.get(id), id);
      const total = totals.get(key) ?? { tool: 0, cli: 0, mention: 0, ui: 0 };
      for (const kind of Object.keys(used) as PluginUsageKind[]) {
        total[kind] += used[kind];
      }
      totals.set(key, total);
    }
    counts = new Map();
    for (const [plugin_id, total] of totals) {
      args.telemetry.capture({
        name: "plugin_usage",
        properties: { plugin_id, ...total },
      });
    }
  }

  function snapshot(): void {
    const rows = args.list();
    const ids = (enabled: boolean) =>
      rows
        .filter((row) => row.enabled === enabled)
        .map((row) => publicId(row, row.id))
        .sort()
        .join(",");
    args.telemetry.capture({
      name: "plugins_snapshot",
      properties: { enabled: ids(true), disabled: ids(false) },
    });
  }

  return {
    record(id: string, kind: PluginUsageKind): void {
      const used = counts.get(id) ?? { tool: 0, cli: 0, mention: 0, ui: 0 };
      used[kind] += 1;
      counts.set(id, used);
    },
    start(): void {
      if (timers.length > 0) return;
      snapshot();
      timers.push(
        setInterval(flush, FLUSH_MS),
        setInterval(snapshot, SNAPSHOT_MS),
      );
      for (const timer of timers) timer.unref();
    },
    stop(): void {
      for (const timer of timers.splice(0)) clearInterval(timer);
      flush();
    },
  };
}
