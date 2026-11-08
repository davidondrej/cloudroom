import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PERSONAL_PROJECT_ID } from "@cloudroom/domain";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { CreditsUsageSection, creditsWaveKey, type CreditsWave } from "@/components/settings/CreditsUsageSection";
import { SkillUsageSection } from "@/components/settings/SkillUsageSection";
import { projectSkillsQueryKey, systemSkillUsageQueryKey } from "@/hooks/queries/query-keys";
import { SettingsStoryChrome } from "../../../.ladle/story-settings-chrome";

// Settings → Analytics with sample data: Cloud Credits above Skills (design A, David 2026-11-08).
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

export function Analytics() {
  const client = useQueryClient();
  useState(() => {
    client.setQueryData(["cloudroom-account"], { account: { id: "demo", email: "demo@example.invalid" }, planUsage: { plan: "pro", credits: 31_240, creditsLimit: 50_000, resetsAt: null, extraCredits: 0, extraCreditsTotal: 0, og: null } });
    client.setQueryData(creditsWaveKey("demo"), sampleWave());
    client.setQueryData(systemSkillUsageQueryKey("90"), skillUsage());
    client.setQueryData(projectSkillsQueryKey(PERSONAL_PROJECT_ID), { skills: SKILLS.map(([name]) => ({ name })) });
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
        <CreditsUsageSection />
      </div>
      <SkillUsageSection />
    </SettingsStoryChrome>
  );
}
