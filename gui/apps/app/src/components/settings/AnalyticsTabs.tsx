import type { ReactNode } from "react";
import { useIsFetching } from "@tanstack/react-query";
import { useLocation, useSearchParams } from "react-router-dom";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { AgentHoursSection } from "@/components/settings/AgentHoursSection";
import { CreditsUsageSection, creditsWaveKey } from "@/components/settings/CreditsUsageSection";
import { ModelsSection } from "@/components/settings/ModelsSection";
import { PromptsSection } from "@/components/settings/PromptsSection";
import { SkillUsageSection } from "@/components/settings/SkillUsageSection";
import { TokensSection } from "@/components/settings/TokensSection";
import { WrappedButton } from "@/components/Wrapped";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { systemSkillUsageQueryKey, systemUsageAnalyticsQueryKey } from "@/hooks/queries/query-keys";

// Settings → Analytics: one sub tab per stat, so the page stays short (docs/scopes/settings-analytics.md).
// Every tab draws its last saved result at once and refreshes behind it; the spinner shows that refresh.
const TABS: { id: string; label: string; content: () => ReactNode }[] = [
  { id: "tokens", label: "Tokens", content: () => <TokensSection /> },
  { id: "skills", label: "Skills", content: () => <SkillUsageSection /> },
  { id: "credits", label: "Cloud Credits", content: () => <CreditsUsageSection /> },
  { id: "models", label: "Models", content: () => <ModelsSection /> },
  { id: "agent-hours", label: "Agent hours", content: () => <AgentHoursSection /> },
  { id: "prompts", label: "Prompts", content: () => <PromptsSection /> },
];
const QUERY_KEYS: unknown[] = [creditsWaveKey("")[0], systemSkillUsageQueryKey("")[0], systemUsageAnalyticsQueryKey("", "")[0]];

export function AnalyticsTabs() {
  const [params, setParams] = useSearchParams();
  // Cloud Credits needs an account.
  const signedIn = Boolean(useCloudroomAccount().data?.account?.id);
  const tabs = TABS.filter((tab) => tab.id !== "credits" || signedIn);
  // Settings search opens the tab it found: it passes the tab's label along (settings-search.ts).
  const state: unknown = useLocation().state;
  const searched = typeof state === "object" && state !== null && "settingsTarget" in state ? state.settingsTarget : null;
  const active = tabs.find((tab) => tab.id === params.get("tab")) ?? tabs.find((tab) => tab.label === searched) ?? tabs[0]!;
  const updating = useIsFetching({ predicate: (query) => QUERY_KEYS.includes(query.queryKey[0]) }) > 0;
  return (
    <div>
      {/* Underlined, unlike the pills above, so these read as pages inside Analytics. */}
      <div className="mb-7 flex items-center border-b border-border">
        <nav aria-label="Analytics" className="flex flex-wrap gap-x-6">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-current={tab === active ? "page" : undefined}
              onClick={() => setParams({ tab: tab.id }, { replace: true })}
              className={cn("-mb-px border-b-2 border-transparent pb-2.5 text-[13px] text-muted-foreground hover:text-foreground", tab === active && "border-primary text-foreground")}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <span className="mb-2 ml-auto flex shrink-0 items-center gap-2">
          {updating ? (
            <span role="status" aria-label="Updating">
              <Icon name="Spinner" className="size-4 animate-spin text-muted-foreground" />
            </span>
          ) : null}
          <WrappedButton />
        </span>
      </div>
      {active.content()}
    </div>
  );
}
