import { createContext, type ComponentType } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  reasoningLevelSchema,
  sameLevelModel,
  type ProviderInfo,
  type ReasoningLevel,
} from "@cloudroom/domain";
import type { ThreadTimelineViewRow } from "@cloudroom/thread-view";
import { stripModelBrandPrefix } from "@/components/pickers/model-brand-prefix";
import { resolveModelCatalogSelection } from "@/hooks/thread-creation-options/model-catalog-selection";
import {
  cloudCanRunHarness,
  useCloudroomThread,
} from "@/hooks/queries/cloudroom-queries";
import {
  systemExecutionOptionsQueryOptions,
  useSystemExecutionOptions,
  useSystemProviderUsageLimits,
} from "@/hooks/queries/system-queries";
import { useThreadDefaultExecutionOptions } from "@/hooks/queries/thread-default-execution-options-query";
import { useThread } from "@/hooks/queries/thread-queries";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { reasoningLevelLabel } from "@/lib/reasoning-labels";

type ProviderIconComponent = ComponentType<{ className?: string }>;

export interface PlanLimitAgent {
  providerId: string;
  name: string;
  icon: ProviderIconComponent;
  model: string;
  modelLabel: string;
  reasoningLevel: ReasoningLevel;
  reasoningLabel: string;
  /** Set while this agent is at its own limit. */
  resetsAt: string | null;
}

/** The id of the timeline's last row, when a plan limit stopped that turn. */
export const LatestPlanLimitRowIdContext = createContext<string | null>(null);

export function findLatestPlanLimitRowId(
  rows: readonly ThreadTimelineViewRow[],
): string | null {
  let candidates = rows;
  for (;;) {
    const last = candidates[candidates.length - 1];
    if (last?.kind === "turn" && last.children) {
      candidates = last.children;
      continue;
    }
    return last?.kind === "system" &&
      last.systemKind === "error" &&
      last.planLimit
      ? last.id
      : null;
  }
}

const SIGNED_OUT = new Set(["not_installed", "unauthenticated", "expired"]);

/** Every other signed-in agent this thread can switch to, each on its matching model, the Claude ↔ Codex pair first. */
export function usePlanLimitAgents(threadId: string) {
  const thread = useThread(threadId).data;
  const isCloud = thread?.executionTarget === "cloud";
  const providerId = thread?.providerId ?? "";
  const environmentId = thread?.environmentId ?? null;
  const current = useSystemExecutionOptions({
    ...(environmentId ? { environmentId } : {}),
    providerId,
    enabled: Boolean(thread),
  });
  const cloud = useCloudroomThread(threadId, isCloud);
  const local = useThreadDefaultExecutionOptions(threadId, {
    enabled: !isCloud,
  });
  const currentModel = (isCloud ? cloud.data?.model : local.data?.model) ?? "";
  const currentReasoning = reasoningLevelSchema.safeParse(
    isCloud ? cloud.data?.reasoning : local.data?.reasoningLevel,
  ).data;
  const providers = current.data?.providers ?? [];
  const self = providers.find((provider) => provider.id === providerId);
  const others = providers.filter(
    (provider) =>
      provider.id !== providerId &&
      provider.available &&
      (!isCloud || cloudCanRunHarness(provider.id)),
  );
  const catalogs = useQueries({
    queries: others.map((provider) =>
      systemExecutionOptionsQueryOptions({
        environmentId,
        hostId: null,
        providerId: provider.id,
        writeLastKnown: false,
      }),
    ),
  });
  const { usage } = useSystemProviderUsageLimits({
    providerIds: [providerId, ...others.map((provider) => provider.id)],
    enabled: Boolean(thread),
  });
  const resetOf = (id: string, model: string): string | null => {
    const limits = usage[id];
    if (limits?.status !== "ok") return null;
    const full = limits.windows.filter(
      (window) =>
        window.usedPercent >= 100 &&
        (typeof window.model !== "string" ||
          model.toLowerCase().includes(window.model)),
    );
    if (full.length === 0) return null;
    return (
      full
        .map((window) => window.resetsAt ?? "")
        .sort()
        .at(-1) || ""
    );
  };
  const paired = (id: string) => sameLevelModel("", providerId, id) !== null;
  const agents = others
    .flatMap((provider, index): PlanLimitAgent[] => {
      const catalog = catalogs[index]?.data;
      if (
        !catalog ||
        catalog.modelLoadError !== null ||
        SIGNED_OUT.has(usage[provider.id]?.status ?? "")
      ) {
        return [];
      }
      const pick = resolveModelCatalogSelection({
        models: catalog.models,
        selectedOnlyModels: catalog.selectedOnlyModels,
        selectedModel:
          sameLevelModel(currentModel, providerId, provider.id) ?? "",
        preferredReasoningLevel: currentReasoning,
        provider,
        catalogIsVerified: true,
        formatModelLabel: (name) => name,
      });
      if (!pick.selectedModel) return [];
      const label = pick.activeModel?.displayName || pick.selectedModel;
      return [
        {
          providerId: provider.id,
          name: provider.displayName,
          icon: providerIcon(provider),
          model: pick.selectedModel,
          modelLabel: stripModelBrandPrefix(
            label,
            provider.strings?.brandPrefix,
          ),
          reasoningLevel: pick.reasoningLevel,
          reasoningLabel: reasoningLevelLabel(pick.reasoningLevel, provider),
          resetsAt: resetOf(provider.id, pick.selectedModel),
        },
      ];
    })
    .sort(
      (a, b) => Number(paired(b.providerId)) - Number(paired(a.providerId)),
    );
  return {
    thread,
    self: self ? { name: self.displayName, icon: providerIcon(self) } : null,
    selfResetsAt: resetOf(providerId, currentModel),
    agents,
    primary: agents.find((agent) => agent.resetsAt === null) ?? null,
  };
}

function providerIcon(provider: ProviderInfo): ProviderIconComponent {
  return getProviderIconInfo("agent", provider.id, provider).icon;
}
