import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PERSONAL_PROJECT_ID } from "@cloudroom/domain";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { AnalyticsTabs } from "@/components/settings/AnalyticsTabs";
import { creditsWaveKey, type CreditsWave } from "@/components/settings/CreditsUsageSection";
import { projectSkillsQueryKey, systemSkillUsageQueryKey, systemUsageAnalyticsQueryKey } from "@/hooks/queries/query-keys";
import { SettingsStoryChrome } from "../../../.ladle/story-settings-chrome";

// Settings → Analytics with sample data, one sub tab per stat. Add `&tab=models` to the story URL to open a tab.
export default { title: "settings/Credits usage" };

const rand = (i: number) => 0.8 + 0.4 * (((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1);
const work = (h: number) => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 1, 1.2, 0.8, 0.7, 1.2, 1.3, 1.2, 1, 0.7, 0.5][h] ?? 0;
const THREADS: [string, (d: number, h: number) => number][] = [
  ["Fix the billing webhook", (d, h) => (d <= 4 ? 190 * work(h) : 0)],
  ["Speed up cold starts", (d, h) => (d === 3 && h >= 20 && h <= 22 ? 520 : d <= 4 && (h >= 20 || h <= 0) ? 120 : 0)],
  ["Fine-tune the ranker", (d, h) => (d === 1 && h >= 14 && h <= 16 ? 900 : 0)],
  ["Write the checkout tests", (d, h) => (d <= 2 ? 110 * work(h) : 0)],
  ["nightly-tests", (_d, h) => (h === 2 ? 146 : 0)],
];
/** The last 7 days, Mon 12 AM to now, ending 7 days of whole hours ago from this hour. */
function sampleWave(): CreditsWave {
  const end = Math.floor(Date.now() / 3_600_000) * 3_600_000, start = end - 167 * 3_600_000;
  const hours = Array.from({ length: 168 }, (_, i) => {
    const top = THREADS.map(([name, at], k) => ({ name, credits: Math.round(at(Math.floor(i / 24), i % 24) * rand(i + k * 300)) }))
      .filter((thread) => thread.credits > 0).sort((a, b) => b.credits - a.credits);
    return { credits: top.reduce((sum, thread) => sum + thread.credits, 0), top: top.slice(0, 3) };
  });
  const days = Array.from({ length: 30 }, (_, i) => Math.round(1100 * (0.4 + rand(i * 7)) * ([0, 6].includes(new Date(Date.now() - (29 - i) * 86_400_000).getUTCDay()) ? 0.3 : 1)));
  return { start: new Date(start).toISOString(), hours, days, daysStart: new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10),
    standouts: [{ at: 24 + 15, name: "Fine-tune the ranker", credits: 2700 }, { at: 3 * 24 + 21, name: "Speed up cold starts", credits: 1560 }], standouts24h: [] };
}

const SKILLS: [string, number][] = [["self-archive", 1907], ["room-cli", 1503], ["read-prod-database", 1290], ["deepapi", 942], ["rename", 913], ["triage-bug-reports", 681], ["gpt-review", 490], ["state", 389]];
function skillUsage() {
  return {
    startDate: "2026-08-11",
    days: 90,
    skills: SKILLS.map(([name, total], s) => {
      const raw = Array.from({ length: 90 }, (_, d) => (d < 45 + s * 2 ? 0 : (1 + Math.sin(d / (3 + s) + s)) * rand(d + s * 90)));
      const sum = raw.reduce((a, b) => a + b, 0);
      return { name, total, daily: raw.map((v) => Math.round((v / sum) * total)) };
    }),
  };
}

const DAYS = 30, START = new Date(Date.now() - (DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
const days = (at: (day: number) => number) => Array.from({ length: DAYS }, (_, day) => at(day));
const MODELS: [string, number][] = [["Opus 5.5", 1840], ["GPT-6.1 Sol", 420], ["Sonnet 5.5", 180], ["Kimi K3.1 Pro", 64]];
/** The four stats worked out from thread history, as the server sends them. */
function usageAnalytics() {
  const base = { startDate: START, days: DAYS };
  return {
    agentHours: { ...base, agentHours: { local: days((d) => 9 * rand(d)), cloud: days((d) => (d === 22 ? 26 : 7 * rand(d + 50))), you: days((d) => (d === 22 ? 1.2 : 5 * rand(d + 90))) } },
    models: { ...base, models: { local: 1502, cloud: 1002, list: MODELS.map(([name, total], m) => ({ name, total, daily: days((d) => Math.round((total / DAYS) * rand(d + m * 40) * (m === 3 && d < 20 ? 0 : 1))) })) } },
    tokens: { ...base, tokens: { written: days((d) => Math.round(2_400_000 * rand(d) * (d === 12 ? 2.2 : 1))), read: 61_000_000, cached: 1_900_000_000,
      top: days((d) => d).map((d) => THREADS.slice(0, 3).map(([name], k) => ({ name, written: Math.round((d === 12 && k === 0 ? 3_100_000 : 700_000 / (k + 1)) * rand(d + k)) }))) } },
    prompts: { ...base, prompts: { daily: days((d) => Math.round(70 * rand(d))), hours: Array.from({ length: 168 }, (_, i) => Math.round(18 * work(i % 24) * rand(i) * (i >= 120 ? 0.3 : 1))) } },
  };
}

export function Analytics() {
  const client = useQueryClient(), navigate = useNavigate();
  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get("tab");
    if (tab) navigate(`?tab=${tab}`, { replace: true });
  }, [navigate]);
  useState(() => {
    client.setQueryData(["cloudroom-account"], { account: { id: "demo", email: "demo@example.invalid" }, planUsage: { plan: "pro", credits: 31_240, creditsLimit: 50_000, resetsAt: null, extraCredits: 0, extraCreditsTotal: 0, og: null } });
    client.setQueryData(creditsWaveKey("demo"), sampleWave());
    client.setQueryData(systemSkillUsageQueryKey("90"), skillUsage());
    client.setQueryData(projectSkillsQueryKey(PERSONAL_PROJECT_ID), { skills: SKILLS.map(([name]) => ({ name })) });
    for (const [metric, usage] of Object.entries(usageAnalytics())) client.setQueryData(systemUsageAnalyticsQueryKey(metric, "30"), usage);
    return null;
  });
  return (
    <SettingsStoryChrome activeSection="analytics">
      <div>
        <nav aria-label="Settings pages" className="mb-6 flex flex-wrap gap-1 border-b border-border pb-2">
          {["Account", "Analytics"].map((label) => (
            <span key={label} className={cn("rounded-md px-2.5 py-1 text-sm text-muted-foreground", label === "Analytics" && "bg-accent text-foreground")}>{label}</span>
          ))}
        </nav>
        <AnalyticsTabs />
      </div>
    </SettingsStoryChrome>
  );
}
