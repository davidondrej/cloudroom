import { useEffect } from "react";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

export type UpgradePrompt = "limit_notice" | "queue" | "queue_badge" | "plan_card" | "free_tip" | "auto_delete" | "try_cloud" | "new_thread_cloud" | "og_letter";

export type CloudChoiceReason = "signed_out" | "agent_unsupported" | "agent_not_in_cloud" | "queue" | "region";
export type CloudChoiceAction = "picked_local" | "cloud_blocked" | "forced_local";

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

export function openUpgrade(where: UpgradePrompt, url = "https://www.cloudroom.dev/billing"): void {
  report(where, "clicked");
  openUrlInExternalBrowser(url);
}
