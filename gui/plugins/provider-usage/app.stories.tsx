import { StoryCard, StoryRow } from "../../apps/app/.ladle/story-card.js";
import {
  ProviderUsageStatusContent,
  UsagePageContent,
  type UsageStoreSnapshot,
} from "./app.js";
import { fromCredits, type PlanSummary } from "./plan-usage.js";
import type {
  ProviderUsage,
  UsageMachine,
  UsageProvider,
  UsageSnapshot,
} from "./usage-schema.js";

export default { title: "plugins/Provider usage" };

const codexLogoUrl = new URL(
  "../provider-codex/icons/codex.svg",
  import.meta.url,
).href;
const claudeCodeLogoUrl = new URL(
  "../provider-claude-code/icons/claude-code.svg",
  import.meta.url,
).href;

type ScenarioName =
  | "local"
  | "credits"
  | "healthy"
  | "emptyPool"
  | "loading"
  | "offline"
  | "authentication"
  | "missingProvider"
  | "failedRefresh";

function futureIso(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60_000).toISOString();
}

function provider(
  id: string,
  providerId: string,
  usage: ProviderUsage | null,
): UsageProvider {
  const isClaude = providerId === "claude-code";
  const displayName = isClaude ? "Claude Code" : "Codex";
  return {
    id,
    providerId,
    accountLabel: `${id}@example.com`,
    displayName,
    logoUrl: isClaude ? claudeCodeLogoUrl : codexLogoUrl,
    icon: null,
    strings: {
      iconTint: isClaude ? { light: "#D97757", dark: "#E38A6E" } : null,
    },
    signInHint: "Sign in to this account in the provider’s settings.",
    expiredHint: "Sign in again in the provider’s settings.",
    usage,
  };
}

function measured(
  email: string,
  usedPercent: number,
  planLabel: string,
): ProviderUsage {
  return {
    status: "ok",
    accountEmail: email,
    planLabel,
    windows: [
      {
        label: "Weekly limit",
        usedPercent,
        resetsAt: futureIso(usedPercent > 90 ? 18 : 83),
        cost: null,
      },
    ],
  };
}

function machine(
  id: string,
  displayName: string,
  providers: UsageProvider[],
  overrides: Partial<UsageMachine> = {},
): UsageMachine {
  return {
    id,
    displayName,
    status: "connected",
    providers,
    error: null,
    ...overrides,
  };
}

function local(
  providerId: string,
  fiveHour: number,
  weekly: number,
): UsageProvider {
  return {
    ...provider(providerId, providerId, {
      status: "ok",
      accountEmail: "david@example.com",
      planLabel: "Max",
      windows: [
        {
          label: "Five-hour limit",
          usedPercent: fiveHour,
          resetsAt: futureIso(1),
          cost: null,
        },
        {
          label: "Weekly limit",
          usedPercent: weekly,
          resetsAt: futureIso(40),
          cost: null,
        },
      ],
    }),
    accountLabel: null,
  };
}

const healthyPool = machine("source:account-pool", "Account Pooler", [
  provider("alex-codex", "codex", measured("alex@example.com", 28, "Pro")),
  provider("sam-codex", "codex", measured("sam@example.com", 86, "Team")),
  provider(
    "team-claude",
    "claude-code",
    measured("team@example.com", 97, "Max (20x)"),
  ),
]);
const healthyMachine = machine("host-m4", "Michael-M4", [
  provider("local-codex", "codex", measured("local@example.com", 17, "Pro")),
]);

const scenarios: Record<Exclude<ScenarioName, "loading">, UsageSnapshot> = {
  local: {
    machines: [
      machine("host-mbp", "macbook pro", [
        local("claude-code", 21, 74),
        local("codex", 12, 86),
      ]),
    ],
  },
  credits: {
    machines: [
      machine("host-mbp", "macbook", [
        {
          ...local("claude-code", 10, 100),
          usage: {
            ...(local("claude-code", 10, 100).usage as ProviderUsage & {
              status: "ok";
            }),
            credits: { detail: "€29.57 / €300" },
          },
        },
        local("codex", 12, 9),
      ]),
    ],
  },
  healthy: { machines: [healthyMachine, healthyPool] },
  emptyPool: {
    machines: [
      healthyMachine,
      machine("source:account-pool", "Account Pooler", []),
    ],
  },
  offline: {
    machines: [
      machine("host-studio", "Studio", [healthyMachine.providers[0]!], {
        status: "disconnected",
      }),
    ],
  },
  authentication: {
    machines: [
      machine("source:account-pool", "Account Pooler", [
        provider("signed-out", "codex", { status: "unauthenticated" }),
        provider("expired", "codex", { status: "expired" }),
      ]),
    ],
  },
  missingProvider: {
    machines: [
      machine("host-m4", "Michael-M4", [
        provider("missing", "codex", { status: "not_installed" }),
      ]),
    ],
  },
  failedRefresh: {
    machines: [
      machine("source:account-pool", "Account Pooler", [
        provider("cached", "codex", measured("cached@example.com", 64, "Pro")),
      ]),
    ],
  },
};

function storySnapshot(name: ScenarioName): UsageStoreSnapshot {
  if (name === "loading") {
    return { data: null, error: null, isRefreshing: true };
  }
  return {
    data: scenarios[name],
    error: name === "failedRefresh" ? "Couldn’t refresh usage." : null,
    isRefreshing: false,
  };
}

function SettingsPreview({ scenario }: { scenario: ScenarioName }) {
  return (
    <div className="w-full max-w-3xl rounded-lg bg-background p-5">
      <UsagePageContent
        snapshot={storySnapshot(scenario)}
        plan={fromCredits(plans[1]!)}
        refreshEnabled={false}
      />
    </div>
  );
}

function FooterPreview({
  scenario,
  plan = null,
  width = 303,
}: {
  scenario: ScenarioName;
  plan?: PlanSummary | null;
  width?: number;
}) {
  return (
    <div style={{ width }} className="overflow-hidden rounded-xl border border-sidebar-border bg-sidebar text-sidebar-foreground">
      <ProviderUsageStatusContent
        dismiss={() => {}}
        snapshot={storySnapshot(scenario)}
        threadMachineId={null}
        plan={plan}
        refreshEnabled={false}
      />
    </div>
  );
}

const descriptions: Record<ScenarioName, string> = {
  local: "Every local provider at once, with 5h and 7d limits.",
  credits: "A plan at 100% now bills usage credits at API pricing.",
  healthy: "Multiple pooled accounts grouped by provider.",
  emptyPool: "Account Pooler is enabled and selectable but has no accounts.",
  loading: "The initial usage request has not completed.",
  offline: "The selected persistent machine is currently disconnected.",
  authentication: "Signed-out and expired accounts remain distinct.",
  missingProvider: "The selected machine does not have the provider installed.",
  failedRefresh:
    "The latest refresh failed while cached measurements remain visible.",
};

const storyRows: readonly { label: string; scenario: ScenarioName }[] = [
  { label: "local machine", scenario: "local" },
  { label: "usage credits", scenario: "credits" },
  { label: "healthy", scenario: "healthy" },
  { label: "empty account pool", scenario: "emptyPool" },
  { label: "loading", scenario: "loading" },
  { label: "offline machine", scenario: "offline" },
  { label: "authentication", scenario: "authentication" },
  { label: "missing provider", scenario: "missingProvider" },
  { label: "failed refresh", scenario: "failedRefresh" },
];

export function Settings() {
  return (
    <StoryCard labelWidth="180px">
      {storyRows.map(({ label, scenario }) => (
        <StoryRow key={scenario} label={label} hint={descriptions[scenario]}>
          <SettingsPreview scenario={scenario} />
        </StoryRow>
      ))}
    </StoryCard>
  );
}

export function Disclosure() {
  return (
    <StoryCard labelWidth="180px">
      {storyRows.map(({ label, scenario }) => (
        <StoryRow key={scenario} label={label} hint={descriptions[scenario]}>
          <FooterPreview scenario={scenario} />
        </StoryRow>
      ))}
    </StoryCard>
  );
}

const plans = [
  { plan: "free", credits: 2_460, creditsLimit: 3_000 },
  { plan: "pro", credits: 19_000, creditsLimit: 50_000 },
  { plan: "business", credits: 89_000, creditsLimit: 100_000 },
  { plan: "super", credits: 121_800, creditsLimit: 150_000 },
  { plan: "ultra", credits: 128_000, creditsLimit: 500_000 },
];

export function CloudroomPlan() {
  return (
    <StoryCard labelWidth="180px">
      {plans.map((usage) => (
        <StoryRow key={usage.plan} label={usage.plan} hint="Cloud Credits used in the last 30 days.">
          <FooterPreview scenario="local" plan={fromCredits(usage)} />
        </StoryRow>
      ))}
    </StoryCard>
  );
}

export function SidebarWidths() {
  const plan = fromCredits(plans[4]!);
  return (
    <StoryCard labelWidth="180px">
      {[400, 303, 260, 220, 190].map((width) => (
        <StoryRow key={width} label={`${width}px`} hint="Bars shrink first so the percent and detail stay visible.">
          <FooterPreview scenario="local" plan={plan} width={width} />
        </StoryRow>
      ))}
    </StoryCard>
  );
}
