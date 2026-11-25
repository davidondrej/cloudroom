import { useEffect } from "react";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

export type UpgradePrompt = "limit_notice" | "queue" | "queue_badge" | "capacity_card" | "capacity_badge" | "limit_link" | "plan_card" | "free_tip" | "auto_delete" | "try_cloud" | "new_thread_cloud" | "limit_notice_pack" | "mac_battery" | "mac_cpu" | "mac_memory" | "mac_heat" | "mac_disk" | "mac_network" | "moment_slept" | "moment_quit" | "moment_crowded" | "one_click_scan";

export type CloudChoiceReason = "signed_out" | "agent_unsupported" | "agent_not_in_cloud" | "claude_not_connected" | "queue" | "region";
export type CloudChoiceAction = "picked_local" | "cloud_blocked" | "forced_local" | "switched_agent";

export function reportUpgradePromptClick(where: UpgradePrompt): void {
  report(where, "clicked");
}

export function reportCloudChoice(action: CloudChoiceAction, reason: CloudChoiceReason | null): void {
  post("/api/v1/cloudroom/cloud-choice", { action, reason });
}

function report(where: UpgradePrompt, action: "viewed" | "clicked"): void {
  post("/api/v1/cloudroom/upgrade-prompt", { where, action });
}

function post(path: string, body: object): void {
  void fetchWithAppSurface(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

export function useUpgradePromptViewed(where: UpgradePrompt | null): void {
  useEffect(() => {
    if (where) report(where, "viewed");
  }, [where]);
}

const BILLING_URL = /(?: at)?\s*(?:https?:\/\/)?(?:www\.)?cloudroom\.dev\/billing\b/gi;

/** Detects a website billing URL in a limit message and strips the raw URL so UI can show a clickable Upgrade button. */
export function splitUpgradeLink(message: string): { text: string; hasLink: boolean } {
  if (!BILLING_URL.test(message)) return { text: message, hasLink: false };
  BILLING_URL.lastIndex = 0;
  return { text: message.replace(BILLING_URL, "").replace(/\s+([.,;:])/g, "$1").trim(), hasLink: true };
}

export function openUpgrade(where: UpgradePrompt, url = "https://www.cloudroom.dev/billing"): void {
  report(where, "clicked");
  openUrlInExternalBrowser(url);
}
