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

function seededClient(othersUsedPercent: number): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false, staleTime: Infinity },
    },
  });
  client.setQueryData(hostsQueryKey(), []);
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

function Preview({ othersUsedPercent }: { othersUsedPercent: number }) {
  const [client] = useState(() => seededClient(othersUsedPercent));
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
        label="another agent has room"
        hint="Continue picks Codex on the same-level model (Opus 5.5 → GPT-6.1 Sol, Max → Extra High); the arrow lists every agent"
      >
        <Preview othersUsedPercent={36} />
      </StoryRow>
      <StoryRow
        label="every agent is at its limit"
        hint="no button; the row only says when the limit resets"
      >
        <Preview othersUsedPercent={100} />
      </StoryRow>
    </StoryCard>
  );
}
