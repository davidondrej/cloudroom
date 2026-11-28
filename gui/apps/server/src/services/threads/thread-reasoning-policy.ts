import {
  ACP_AGENT_MANAGED_REASONING_EFFORT,
  reconcileReasoningLevel,
  type AvailableModel,
  type ReasoningLevel,
} from "@cloudroom/domain";
import type { ProviderRegistryService } from "../providers/provider-registry.js";

export function getSupportedReasoningLevelsForProvider(
  registry: ProviderRegistryService,
  providerId: string,
): readonly ReasoningLevel[] {
  return registry.getServerCapabilities(providerId)?.reasoningLevels ?? [];
}

export function resolveSupportedReasoningLevelsForModel(
  registry: ProviderRegistryService,
  args: {
    model?: AvailableModel | undefined;
    providerId: string;
  },
): readonly ReasoningLevel[] {
  const efforts = args.model?.supportedReasoningEfforts ?? [];
  // An ACP agent that manages effort itself lists one placeholder level, which says nothing about the model (#2692).
  const agentManaged =
    efforts.length === 1 &&
    efforts[0]!.description === ACP_AGENT_MANAGED_REASONING_EFFORT.description;
  if (efforts.length > 0 && !agentManaged) {
    return efforts.map((effort) => effort.reasoningEffort);
  }
  return getSupportedReasoningLevelsForProvider(registry, args.providerId);
}

export function reconcileInheritedReasoningLevel(
  registry: ProviderRegistryService,
  args: {
    level: ReasoningLevel;
    model?: AvailableModel | undefined;
    providerId: string;
  },
): ReasoningLevel {
  const supported = resolveSupportedReasoningLevelsForModel(registry, args);
  if (supported.length === 0 || supported.includes(args.level)) {
    return args.level;
  }
  return reconcileReasoningLevel(args.level, supported);
}
