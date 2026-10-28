import type {
  HostDaemonContributedEnvEntry,
  ProviderUsage,
  ProviderUsageResponse,
} from "@cloudroom/host-daemon-contract";
import type { SystemUsageLimitsQuery } from "@cloudroom/server-contract";
import type { AppDeps } from "../../types.js";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { cloudClaudeLoginEnvironment } from "../hosts/host-environment.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import {
  assertUsableHostId,
  requirePrimaryHostId,
} from "../hosts/primary-host.js";
import { resolvePluginProviderEnvHealth } from "../plugins/plugin-agent-contributions.js";
import { listSystemProviderInfos } from "./execution-options.js";
import { resolveBridgeLaunchForProviderId } from "./provider-bridge-launch.js";
import { mapProviderMaintenanceRequests } from "./provider-maintenance-concurrency.js";

export async function getProviderUsageLimits(
  deps: AppDeps,
  query: SystemUsageLimitsQuery,
): Promise<ProviderUsageResponse> {
  const hostId = query.hostId ?? requirePrimaryHostId(deps);
  assertUsableHostId(deps, { hostId });
  const providers = (
    await listSystemProviderInfos(deps, { hostId, capability: "usage" })
  ).filter(
    (provider) =>
      query.providerId === undefined || provider.id === query.providerId,
  );
  const entries = await mapProviderMaintenanceRequests(
    providers,
    async (provider): Promise<[string, ProviderUsage] | null> => {
      if (!provider.maintenance.usage) return null;
      const bridgeLaunch = resolveBridgeLaunchForProviderId(deps, provider.id);
      if (bridgeLaunch === null) return null;
      try {
        const result = await callHostRetryableOnlineRpc(deps, {
          hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "provider.usage",
            providerId: provider.id,
            bridgeLaunch,
          },
        });
        if (!result.supported) return null;
        const usage = result.usage;
        if (usage.status !== "unauthenticated" && usage.status !== "expired")
          return [provider.id, usage];
        const contributed = await resolvePluginProviderEnvHealth({
          providerId: provider.id,
          hostId,
        });
        if (contributed !== null)
          return [
            provider.id,
            {
              status: "error",
              message: contributed.statusMessage,
              planLabel: contributed.label,
              accountEmail: null,
            },
          ];
        const cloud = cloudClaudeLoginEnvironment(deps, {
          hostId,
          providerId: provider.id,
        });
        return [
          provider.id,
          cloud.length ? await cloudClaudeUsage(cloud) : usage,
        ];
      } catch {
        return [
          provider.id,
          {
            status: "error",
            message: "Provider usage could not be loaded.",
            planLabel: null,
            accountEmail: null,
          },
        ];
      }
    },
  );
  return Object.fromEntries(
    entries.filter((entry): entry is [string, ProviderUsage] => entry !== null),
  );
}

const LIMITS = "anthropic-ratelimit-unified";

function claudeCreditsInUse(
  headers: Headers,
  windows: readonly { usedPercent: number }[],
): boolean {
  if (headers.get(`${LIMITS}-overage-in-use`) === "true") return true;
  const overage = headers.get(`${LIMITS}-overage-status`);
  return (
    (overage === "allowed" || overage === "allowed_warning") &&
    (headers.get(`${LIMITS}-status`) === "rejected" ||
      windows.some((window) => window.usedPercent >= 100))
  );
}

function resetIso(value: string | null): string | null {
  if (!value) return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A signed-out Mac's Claude threads use the account's cloud Claude login (ADR 0175), so its usage comes from that login.
 *  One-year setup tokens can't read /api/oauth/usage, but every Claude reply carries the limits in its headers, even a 429.
 *  OAuth replies need the Claude Code system prompt, or Anthropic answers 429. */
export async function cloudClaudeUsage(
  environment: readonly HostDaemonContributedEnvEntry[],
): Promise<ProviderUsage> {
  const env = new Map(
    environment.flatMap((entry) =>
      typeof entry.value === "string" ? [[entry.name, entry.value]] : [],
    ),
  );
  const plan = env.get("CLAUDE_CODE_SUBSCRIPTION_TYPE");
  const known = {
    accountEmail: null,
    planLabel: plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null,
  };
  const token = env.get("CLAUDE_CODE_OAUTH_TOKEN");
  if (!token)
    return {
      status: "error",
      message:
        "Using your cloud Claude API key. API keys have no usage limits to show.",
      ...known,
    };
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-5-5",
        max_tokens: 1,
        system: "You are Claude Code, Anthropic's official CLI for Claude.",
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel();
    if (response.status === 401) return { status: "expired" };
    const windows = (
      [
        ["Current session", "5h", "five-hour"],
        ["Weekly limit", "7d", "weekly"],
      ] as const
    ).flatMap(([label, key, kind]) => {
      const used = Number(
        response.headers.get(`${LIMITS}-${key}-utilization`) ?? NaN,
      );
      if (!Number.isFinite(used)) return [];
      return [
        {
          label,
          kind,
          usedPercent: Math.min(100, Math.max(0, used * 100)),
          resetsAt: resetIso(response.headers.get(`${LIMITS}-${key}-reset`)),
        },
      ];
    });
    return windows.length
      ? {
          status: "ok",
          ...known,
          windows,
          credits: claudeCreditsInUse(response.headers, windows)
            ? { detail: null }
            : null,
        }
      : {
          status: "error",
          message: `Claude usage request failed (HTTP ${response.status}).`,
          ...known,
        };
  } catch {
    return {
      status: "error",
      message: "Claude usage could not be loaded.",
      ...known,
    };
  }
}
