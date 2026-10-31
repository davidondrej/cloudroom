import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { AutomationRow } from "./data.js";
import type {
  AutomationExecution,
  ReasoningLevel,
  ServiceTier,
} from "./rpc-types.js";

type AgentExecution = Extract<AutomationExecution, { mode: "agent" }>;
type Level = {
  claude: string;
  claudeModel: string;
  claudeEfforts: ReasoningLevel[];
  codex: string;
  codexModel: string;
};
export type FallbackSdk = {
  system?: Pick<BbPluginApi["sdk"]["system"], "usageLimits">;
  cloudroom?: Pick<BbPluginApi["sdk"]["cloudroom"], "automations">;
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
const LEVELS: Level[] = [
  {
    claude: "fable",
    claudeModel: "claude-fable-5-1",
    claudeEfforts: ["low", "medium", "high", "xhigh", "max"],
    codex: "astra",
    codexModel: "gpt-6-astra",
  },
  {
    claude: "opus",
    claudeModel: "claude-opus-5-5",
    claudeEfforts: ["low", "medium", "high", "xhigh", "max"],
    codex: "sol",
    codexModel: "gpt-6.1-sol",
  },
  {
    claude: "sonnet",
    claudeModel: "claude-sonnet-5-5",
    claudeEfforts: ["low", "medium", "high", "max"],
    codex: "terra",
    codexModel: "gpt-6.1-terra",
  },
  {
    claude: "haiku",
    claudeModel: "claude-haiku-5-5",
    claudeEfforts: [],
    codex: "luna",
    codexModel: "gpt-6-luna",
  },
];
const CODEX_EFFORTS: ReasoningLevel[] = ["low", "medium", "high", "xhigh"];
const USAGE_CACHE_MS = 60_000;
const LIMIT_SUSPECT_MS = 10 * 60_000;
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
    LEVELS.find((entry) =>
      model.includes(toCodex ? entry.claude : entry.codex),
    ) ?? LEVELS[1]!;
  const efforts = toCodex ? CODEX_EFFORTS : level.claudeEfforts;
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
    !(await fallbackOn(sdk))
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
