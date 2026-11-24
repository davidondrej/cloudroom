import type { BbPluginApi } from "@get-bb/plugin-sdk";

type AutomationSignalKind = "automations-changed" | "automation-runs-changed";

export const REVIEW_SIGNAL_PROJECT = "review";

export function publishAutomationChange(
  room: Pick<BbPluginApi, "realtime">,
  projectId: string,
  kinds: AutomationSignalKind | AutomationSignalKind[],
): void {
  for (const kind of Array.isArray(kinds) ? kinds : [kinds]) {
    room.realtime.publish("automations", { projectId, kind });
  }
}
