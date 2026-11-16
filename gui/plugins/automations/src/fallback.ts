import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { MODEL_LEVELS } from "@cloudroom/domain";
import { listAutomationRuns, type AutomationRow, type Db } from "./data.js";
import type {
  AutomationExecution,
  ReasoningLevel,
  ServiceTier,
} from "./rpc-types.js";

type AgentExecution = Extract<AutomationExecution, { mode: "agent" }>;
export type FallbackSdk = {
  system?: Pick<BbPluginApi["sdk"]["system"], "usageLimits" | "providerStates">;
  cloudroom?: Pick<BbPluginApi["sdk"]["cloudroom"], "automations"> &
    Partial<Pick<BbPluginApi["sdk"]["cloudroom"], "status">>;
  threads: {
    get?(args: { threadId: string }): Promise<unknown>;
    stop?(args: { threadId: string }): Promise<unknown>;
  };
};
export interface LoopAgent {
  providerId: string;
  model: string;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
}

const OTHER_PROVIDER: Record<string, string> = {
  "claude-code": "codex",
  codex: "claude-code",
};
const CODEX_EFFORTS: ReasoningLevel[] = ["low", "medium", "high", "xhigh"];
const USAGE_CACHE_MS = 60_000;
const LIMIT_SUSPECT_MS = 10 * 60_000;
const SETTING_CACHE_MS = 10 * 60_000;
const CAN_RUN_TIMEOUT_MS = 5_000;
const usageCache = new Map<
  string,
  {
    at: number;
    windows:
      | { usedPercent: number; resetsAt: string | null; model?: unknown }[]
      | null;
  }
>();
// A provider seen at its limit stays suspect until the full window resets, or 10 minutes when the reset is unknown (#1807).
const limitedUntil = new Map<string, number>();
// Loops whose last run switched: the next one checks usage again, so an unknown reset can't send it back early.
const switched = new Set<string>();
// The Switch setting is on the website: one read, shared while it runs, serves every loop on this Mac for 10 minutes,
// so a change either way applies within 10 minutes.
let setting: { at: number; on: Promise<boolean> } | null = null;

async function safely<T>(
  call: () => Promise<T> | undefined,
): Promise<T | null> {
  try {
    return (await call()) ?? null;
  } catch {
    return null;
  }
}

export function sameLevelAgent(execution: AgentExecution): LoopAgent {
  const toCodex = execution.providerId === "claude-code";
  const model = execution.model.toLowerCase();
  const level =
    MODEL_LEVELS.find((entry) =>
      model.includes(toCodex ? entry.claude : entry.codex),
    ) ?? MODEL_LEVELS[1]!;
  const efforts: readonly ReasoningLevel[] = toCodex
    ? CODEX_EFFORTS
    : level.claudeEfforts;
  return {
    providerId: toCodex ? "codex" : "claude-code",
    model: toCodex ? level.codexModel : level.claudeModel,
    ...(efforts.includes(execution.reasoningLevel)
      ? { reasoningLevel: execution.reasoningLevel }
      : {}),
  };
}

async function atLimit(
  sdk: FallbackSdk,
  providerId: string,
  model: string,
  fresh: boolean,
): Promise<boolean | null> {
  const cached = usageCache.get(providerId);
  let windows = cached?.windows ?? null;
  if (fresh || !cached || Date.now() - cached.at >= USAGE_CACHE_MS) {
    const usage = (
      await safely(() => sdk.system?.usageLimits({ providerId }))
    )?.[providerId];
    windows = usage?.status === "ok" ? usage.windows : null;
    usageCache.set(providerId, { at: Date.now(), windows });
  }
  if (windows === null) return null;
  const full = windows.filter(
    (window) =>
      window.usedPercent >= 100 &&
      (typeof window.model !== "string" ||
        model.toLowerCase().includes(window.model)),
  );
  if (full.length)
    limitedUntil.set(
      providerId,
      Math.max(
        Date.now() + LIMIT_SUSPECT_MS,
        ...full.map((window) => Date.parse(window.resetsAt ?? "") || 0),
      ),
    );
  return full.length > 0;
}

// Usage shows without a CLI (a Mac with only a Cloud login), so only a provider ready on the loop's host takes over.
// Only that provider is checked, for at most 5 seconds; no answer in time means it doesn't take over.
async function canRun(
  sdk: FallbackSdk,
  providerId: string,
  environment: AgentExecution["environment"],
): Promise<boolean> {
  const where =
    environment.type === "reuse"
      ? { environmentId: environment.environmentId }
      : environment.type === "host" && environment.hostId
        ? { hostId: environment.hostId }
        : {};
  const states = await safely(() =>
    sdk.system?.providerStates({
      ...where,
      providerId,
      signal: AbortSignal.timeout(CAN_RUN_TIMEOUT_MS),
    }),
  );
  return (
    states?.providers.some(
      (state) => state.providerId === providerId && state.status === "ready",
    ) ?? false
  );
}

function fallbackOn(sdk: FallbackSdk): Promise<boolean> {
  if (setting && Date.now() - setting.at < SETTING_CACHE_MS) return setting.on;
  const read = {
    at: Date.now(),
    on: safely(() => sdk.cloudroom?.automations({ action: "settings" })).then(
      (settings) => {
        // A failed read isn't kept, so the next run reads again.
        if (!settings && setting === read) setting = null;
        return settings?.fallback !== false;
      },
    ),
  };
  setting = read;
  return read.on;
}

// run.ts skips a run its plan limit stopped (ADR 0344). The newest run is this one, still running.
function limitSkipped(db: Db, automationId: string): boolean {
  return (
    listAutomationRuns(db, { automationId, limit: 2 })
      .find((run) => run.status !== "running")
      ?.skipReason?.startsWith("plan limit:") === true
  );
}

/** A loop with several agents gives each run the next one (docs/scopes/loops.md), past any at its plan limit or not
 *  ready where the loop runs, unless all are. The run count is read before this run counts (a manual run never does). */
async function nextAgent(
  sdk: FallbackSdk,
  automation: AutomationRow,
  execution: AgentExecution & { agents: LoopAgent[] },
): Promise<LoopAgent> {
  const { agents } = execution;
  const turn = automation.runCount;
  const order = agents.map((_, index) => agents[(turn + index) % agents.length]!);
  for (const agent of order) {
    if (
      (await atLimit(sdk, agent.providerId, agent.model, false)) !== true &&
      (await canRun(sdk, agent.providerId, execution.environment))
    )
      return agent;
  }
  return order[0]!;
}

export async function loopAgent(
  sdk: FallbackSdk,
  db: Db,
  automation: AutomationRow,
  execution: AgentExecution,
): Promise<LoopAgent> {
  // A plan-limit skip counts as a failed run here, or a limit that never fails a run would never switch (#1807).
  const failed =
    automation.lastRunStatus === "failed" ||
    (automation.lastRunStatus === "skipped" && limitSkipped(db, automation.id));
  // Agents that take turns skip to their next one instead of falling back. A failed last run's retries would redo its
  // work on its own agent, so Stop cancels them first, as below; if it can't, this run stays on the last run's agent.
  if (execution.agents && execution.agents.length > 1) {
    const { agents } = execution;
    if (
      failed &&
      automation.triggerType !== "webhook" &&
      automation.lastRunThreadId &&
      !(await stopLastRun(sdk, automation.lastRunThreadId))
    )
      return agents[(automation.runCount + agents.length - 1) % agents.length]!;
    return nextAgent(sdk, automation, { ...execution, agents });
  }
  const own: LoopAgent = {
    providerId: execution.providerId,
    model: execution.model,
    reasoningLevel: execution.reasoningLevel,
    ...(execution.serviceTier === undefined
      ? {}
      : { serviceTier: execution.serviceTier }),
  };
  const suspect =
    switched.delete(automation.id) ||
    failed ||
    (limitedUntil.get(execution.providerId) ?? 0) > Date.now();
  if (
    !OTHER_PROVIDER[execution.providerId] ||
    !suspect ||
    (await atLimit(sdk, execution.providerId, execution.model, failed)) !== true
  )
    return own;
  const other = sameLevelAgent(execution);
  // Local checks first: the setting is read only when the other provider could take over.
  if (
    (await atLimit(sdk, other.providerId, other.model, false)) !== false ||
    !(await canRun(sdk, other.providerId, execution.environment)) ||
    !(await fallbackOn(sdk))
  )
    return own;
  // A webhook run's retry carries its own events, which the website no longer has: it stays, as on Cloud loops.
  if (
    failed &&
    automation.triggerType !== "webhook" &&
    automation.lastRunThreadId &&
    !(await stopLastRun(sdk, automation.lastRunThreadId))
  )
    return own;
  switched.add(automation.id);
  return other;
}

// The last run's retries would redo its work on the limited provider. As after a failed run, Stop cancels them all,
// claimed or not, and pauses what the user queued there (#1807). A busy thread may already run one: then, or with a
// message mid-dispatch or a failed read or Stop, the loop leaves the thread and keeps its provider this run.
async function stopLastRun(
  sdk: FallbackSdk,
  threadId: string,
): Promise<boolean> {
  const thread = (await safely(() => sdk.threads.get?.({ threadId }))) as {
    status?: unknown;
    dispatchingMessageCount?: unknown;
  } | null;
  return (
    (thread?.status === "idle" || thread?.status === "error") &&
    thread.dispatchingMessageCount === 0 &&
    (await safely(() => sdk.threads.stop?.({ threadId }))) !== null
  );
}
