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

const catalogs: Record<string, AvailableModel[]> = {
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
): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false, staleTime: Infinity },
    },
  });
  client.setQueryData(hostsQueryKey(), []);
  client.setQueryData(
    ["plan-limit-accounts", "claude-code"],
    withAccounts ? accounts : [],
  );
  client.setQueryData(systemConfigQueryKey(), makeSystemConfig());
  client.setQueryData(
    threadQueryKey(THREAD_ID),
    makeThreadResponse({
      id: THREAD_ID,
      status: "error",
      providerId: "claude-code",
      environmentId: null,
    }),
  );
  client.setQueryData<ResolvedThreadExecutionOptions>(
    threadDefaultExecutionOptionsQueryKey(THREAD_ID),
    {
      model: "claude-opus-5-5[1m]",
      reasoningLevel: "max",
      serviceTier: "default",
      permissionMode: "full",
      source: "client/turn/requested",
    },
  );
  const used: Record<string, number> = {
    "claude-code": 100,
    codex: othersUsedPercent,
    "acp-cursor": othersUsedPercent,
  };
  for (const provider of providers) {
    client.setQueryData<SystemExecutionOptionsResponse>(
      systemExecutionOptionsQueryKey({
        environmentId: null,
        hostId: null,
        providerId: provider.id,
      }),
      {
        providers,
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
}: {
  othersUsedPercent: number;
  withAccounts?: boolean;
}) {
  const [client] = useState(() =>
    seededClient(othersUsedPercent, withAccounts),
  );
  return (
    <QueryClientProvider client={client}>
      <div className="w-full max-w-[760px]">
        <ThreadTimelineRows
          threadRuntimeDisplayStatus="idle"
          workspaceRootPath={undefined}
          timelineRows={rows}
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
    </StoryCard>
  );
}
