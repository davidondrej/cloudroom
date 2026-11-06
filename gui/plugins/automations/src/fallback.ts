import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { MODEL_LEVELS } from "@cloudroom/domain";
import type { AutomationRow } from "./data.js";
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
const CAN_RUN_TIMEOUT_MS = 5_000;
const usageCache = new Map<
  string,
  { at: number; windows: { usedPercent: number; model?: unknown }[] | null }
>();
const limitedUntil = new Map<string, number>();

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
  const full = windows.some(
    (window) =>
      window.usedPercent >= 100 &&
      (typeof window.model !== "string" ||
        model.toLowerCase().includes(window.model)),
  );
  if (full) limitedUntil.set(providerId, Date.now() + LIMIT_SUSPECT_MS);
  return full;
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

async function fallbackOn(sdk: FallbackSdk): Promise<boolean> {
  const settings = await safely(() =>
    sdk.cloudroom?.automations({ action: "settings" }),
  );
  return settings?.fallback !== false;
}

export async function loopAgent(
  sdk: FallbackSdk,
  automation: AutomationRow,
  execution: AgentExecution,
): Promise<LoopAgent> {
  const own: LoopAgent = {
    providerId: execution.providerId,
    model: execution.model,
    reasoningLevel: execution.reasoningLevel,
    ...(execution.serviceTier === undefined
      ? {}
      : { serviceTier: execution.serviceTier }),
  };
  const failed = automation.lastRunStatus === "failed";
  const suspect =
    failed || (limitedUntil.get(execution.providerId) ?? 0) > Date.now();
  if (
    !OTHER_PROVIDER[execution.providerId] ||
    !suspect ||
    (await atLimit(sdk, execution.providerId, execution.model, failed)) !== true
  )
    return own;
  const other = sameLevelAgent(execution);
  if (
    (await atLimit(sdk, other.providerId, other.model, false)) !== false ||
    !(await fallbackOn(sdk)) ||
    !(await canRun(sdk, other.providerId, execution.environment))
  )
    return own;
  const lastThreadId = automation.lastRunThreadId;
  const last =
    failed && lastThreadId
      ? await safely(() => sdk.threads.get?.({ threadId: lastThreadId }))
      : null;
  const lastStatus = (last as { status?: unknown } | null)?.status;
  if (lastThreadId && (lastStatus === "error" || lastStatus === "idle"))
    await safely(() => sdk.threads.stop?.({ threadId: lastThreadId }));
  return other;
}
