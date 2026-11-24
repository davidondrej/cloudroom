import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  AvailableModel,
  ReasoningLevel,
  ResolvedThreadExecutionOptions,
} from "@cloudroom/domain";
import type {
  SystemExecutionOptionsResponse,
  TimelineRow,
} from "@cloudroom/server-contract";
import { makeProviderInfo } from "@cloudroom/test-helpers/domain-fixtures";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import {
  hostsQueryKey,
  systemConfigQueryKey,
  systemExecutionOptionsQueryKey,
  systemUsageLimitsQueryKey,
  threadDefaultExecutionOptionsQueryKey,
  threadQueryKey,
} from "@/hooks/queries/query-keys";
import { makeSystemConfig } from "@/test/fixtures/system-config";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import {
  conversationRow,
  systemRow,
} from "@/test/fixtures/thread-timeline-rows";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";
import claudeLogo from "../../../../../../plugins/provider-claude-code/icons/claude-code.svg?url";
import codexLogo from "../../../../../../plugins/provider-codex/icons/codex.svg?url";
import cursorLogo from "../../../../../../plugins/provider-acp/icons/cursor.svg?url";

export default {
  title: "thread/timeline/rows/Plan limit",
};

const THREAD_ID = "thr_plan_limit";
const ALL_EFFORTS: ReasoningLevel[] = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS: ReasoningLevel[] = ["low", "medium", "high", "xhigh"];

const providers = [
  makeProviderInfo({
    id: "claude-code",
    displayName: "Claude Code",
    logoUrl: claudeLogo,
    strings: {
      brandPrefix: "Claude",
      signInHint: "",
      expiredHint: "",
      installUrl: "https://claude.com/claude-code",
      iconTint: { light: "#D97757", dark: "#D97757" },
    },
  }),
  makeProviderInfo({ id: "codex", displayName: "Codex", logoUrl: codexLogo }),
  makeProviderInfo({
    id: "acp-cursor",
    displayName: "Cursor",
    logoUrl: cursorLogo,
  }),
];

function model(
  id: string,
  displayName: string,
  efforts: ReasoningLevel[],
): AvailableModel {
  return {
    id,
    model: id,
    displayName,
    description: "",
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: reasoningEffort,
    })),
    defaultReasoningEffort: "medium",
    isDefault: false,
  };
}

// Its plugin is off by default (docs/scopes/cloudroom-agent.md): only the rows that turn it on list it.
const cloudroomAgent = makeProviderInfo({
  id: "cloudroom-agent",
  displayName: "Cloudroom Agent",
  icon: { glyph: "Cloud" },
  strings: {
    signInHint: "",
    expiredHint: "",
    installUrl: "https://cloudroom.dev",
    iconTint: { light: "#5C7A00", dark: "#BFFF00" },
  },
});

const catalogs: Record<string, AvailableModel[]> = {
  "cloudroom-agent": [
    model("cloudroom/cloudroom-agent", "Cloudroom Agent", [
      "low",
      "medium",
      "high",
    ]),
  ],
  "claude-code": [
    model("claude-opus-5-5[1m]", "Claude Opus 5.5 (1M)", ALL_EFFORTS),
  ],
  codex: [
    model("gpt-6.1-terra", "GPT-6.1 Terra", CODEX_EFFORTS),
    model("gpt-6.1-sol", "GPT-6.1 Sol", CODEX_EFFORTS),
  ],
  "acp-cursor": [model("composer-2.5", "Composer 2.5", [])],
};

const rows: TimelineRow[] = [
  conversationRow({
    id: "plan_limit_user",
    threadId: THREAD_ID,
    turnId: "turn_plan_limit",
    seq: 1,
    role: "user",
    text: "give /state",
  }),
  {
    ...systemRow({
      id: "plan_limit_error",
      threadId: THREAD_ID,
      turnId: null,
      sourceSeqStart: 2,
      sourceSeqEnd: 2,
      startedAt: 2,
      createdAt: 2,
      systemKind: "error",
      title: "System error",
      detail:
        "Claude's plan limit (not Cloudroom's). Resumes at 07:00 UTC, or as soon as you switch accounts.",
      status: "error",
    }),
    planLimit: true,
  },
];

// A Cloud Codex refusal (OpenAI's cybersecurity filter), as a loop run hit it on 2026-11-19.
const refusalRows: TimelineRow[] = [
  rows[0]!,
  {
    ...systemRow({
      id: "refusal_error",
      threadId: THREAD_ID,
      turnId: null,
      sourceSeqStart: 2,
      sourceSeqEnd: 2,
      startedAt: 2,
      createdAt: 2,
      systemKind: "error",
      title: "Codex error (cyberPolicy)",
      detail:
        "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.",
      status: "error",
    }),
    refusal: true,
  },
];

function usage(usedPercent: number, resetInMinutes: number) {
  return {
    status: "ok" as const,
    accountEmail: null,
    planLabel: null,
    windows: [
      {
        label: "5-hour",
        usedPercent,
        resetsAt: new Date(Date.now() + resetInMinutes * 60_000).toISOString(),
      },
    ],
  };
}

const accounts = [
  { id: "a1", email: "alex@acme.co", inUse: false, windows: [] },
  {
    id: "a2",
    email: "alex.backup@gmail.com",
    inUse: false,
    limitedUntil: Date.now() + 3_600_000,
    windows: [],
  },
  { id: "a3", email: "alex@gmail.com", inUse: true, windows: [] },
];

function seededClient(
  othersUsedPercent: number,
  withAccounts: boolean,
  refusal = false,
  withCloudroomAgent = false,
): QueryClient {
  const listed = withCloudroomAgent ? [...providers, cloudroomAgent] : providers;
  const client = new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false, staleTime: Infinity },
    },
  });
  client.setQueryData(hostsQueryKey(), []);
  client.setQueryData(
    ["plan-limit-accounts", refusal ? "codex" : "claude-code"],
    withAccounts ? accounts : [],
  );
  client.setQueryData(systemConfigQueryKey(), makeSystemConfig());
  client.setQueryData(
    threadQueryKey(THREAD_ID),
    makeThreadResponse({
      id: THREAD_ID,
      status: "error",
      providerId: refusal ? "codex" : "claude-code",
      environmentId: null,
    }),
  );
  client.setQueryData<ResolvedThreadExecutionOptions>(
    threadDefaultExecutionOptionsQueryKey(THREAD_ID),
    {
      model: refusal ? "gpt-6.1-sol" : "claude-opus-5-5[1m]",
      reasoningLevel: refusal ? "xhigh" : "max",
      serviceTier: "default",
      permissionMode: "full",
      source: "client/turn/requested",
    },
  );
  const used: Record<string, number> = {
    "claude-code": refusal ? othersUsedPercent : 100,
    codex: refusal ? 20 : othersUsedPercent,
    "acp-cursor": othersUsedPercent,
  };
  for (const provider of listed) {
    client.setQueryData<SystemExecutionOptionsResponse>(
      systemExecutionOptionsQueryKey({
        environmentId: null,
        hostId: null,
        providerId: provider.id,
      }),
      {
        providers: listed,
        models: catalogs[provider.id] ?? [],
        selectedOnlyModels: [],
        permissionCeiling: "full",
        modelLoadError: null,
      },
    );
    client.setQueryData(systemUsageLimitsQueryKey(null, provider.id), {
      [provider.id]: usage(
        used[provider.id] ?? 0,
        provider.id === "codex" ? 95 : 146,
      ),
    });
  }
  return client;
}

function Preview({
  othersUsedPercent,
  withAccounts = false,
  refusal = false,
  withCloudroomAgent = false,
}: {
  othersUsedPercent: number;
  withAccounts?: boolean;
  refusal?: boolean;
  withCloudroomAgent?: boolean;
}) {
  const [client] = useState(() =>
    seededClient(othersUsedPercent, withAccounts, refusal, withCloudroomAgent),
  );
  return (
    <QueryClientProvider client={client}>
      <div className="w-full max-w-[760px]">
        <ThreadTimelineRows
          threadRuntimeDisplayStatus="idle"
          workspaceRootPath={undefined}
          timelineRows={refusal ? refusalRows : rows}
        />
      </div>
    </QueryClientProvider>
  );
}

export function States() {
  return (
    <StoryCard>
      <StoryRow
        label="another account and another agent"
        hint="Switch account picks the next account with room; each arrow lists accounts or agents"
      >
        <Preview othersUsedPercent={36} withAccounts />
      </StoryRow>
      <StoryRow
        label="only another agent"
        hint="one Claude account; Continue picks Codex on the same-level model"
      >
        <Preview othersUsedPercent={36} />
      </StoryRow>
      <StoryRow
        label="only another account"
        hint="every other agent is at its limit; accounts at their limit still show"
      >
        <Preview othersUsedPercent={100} withAccounts />
      </StoryRow>
      <StoryRow
        label="nothing to switch to"
        hint="no button; the row only says when the limit resets"
      >
        <Preview othersUsedPercent={100} />
      </StoryRow>
      <StoryRow
        label="refusal"
        hint="Codex refused (OpenAI's filter): continue on another agent; no account switch, every account has the filter"
      >
        <Preview othersUsedPercent={36} refusal withAccounts />
      </StoryRow>
      <StoryRow
        label="Cloudroom Agent on"
        hint="its own button, after the account and agent buttons"
      >
        <Preview othersUsedPercent={36} withAccounts withCloudroomAgent />
      </StoryRow>
      <StoryRow
        label="Cloudroom Agent is the only way on"
        hint="its button, after the retry at the reset"
      >
        <Preview othersUsedPercent={100} withCloudroomAgent />
      </StoryRow>
    </StoryCard>
  );
}
