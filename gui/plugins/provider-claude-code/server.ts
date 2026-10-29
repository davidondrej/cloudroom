import {
  claudeLoginHostContract,
  claudeLoginRpcContract,
} from "./src/login-contract.js";
import { registerUsageSource } from "./src/usage-source.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  CLAUDE_CODE_ACTIVE_CATALOG_DATA,
  CLAUDE_XHIGH_CAPABLE_REASONING_EFFORT_DATA,
  DEFAULT_CLAUDE_CODE_MODEL,
  claudeModelLabel,
} from "./src/model-catalog-data.js";
import { CLAUDE_NATIVE_ROOTS_DECLARATION } from "./src/native-roots.js";

export default function plugin(bb: BbPluginApi) {
  registerUsageSource(bb);
  bb.experimental_aiServices.register({
    id: "claude-code",
    displayName: "Claude Code",
    kinds: ["inference"],
  });
  const host = bb.hosts.experimental_client({
    contract: claudeLoginHostContract,
  });
  bb.rpc.register(claudeLoginRpcContract, {
    async claudeAccount({ hostId, environmentId, ...input }) {
      const target = environmentId
        ? (await bb.sdk.environments.get({ environmentId })).hostId
        : (hostId ?? (await bb.sdk.system.config()).primaryHostId);
      if (!target) throw new Error("No local machine is connected.");
      const status = await host.call("account", input, { hostId: target });
      if (status.state !== "missing" || input.action !== "status") return status;
      return (await hasSuppliedClaudeLogin(bb, target))
        ? { ...status, state: "connected" as const }
        : status;
    },
  });
  bb.settings.define({
    memoryEnabled: {
      type: "boolean",
      label: "Claude Code memory",
      description:
        "Allow Claude Code to read and write its native auto-memory for Cloudroom threads.",
      default: true,
    },
    subagentsDisabled: {
      type: "boolean",
      label: "Disable provider subagents",
      description:
        "Hide Claude Code's native Task tool so agents use Cloudroom for delegation.",
      default: true,
    },
    workflowsDisabled: {
      type: "boolean",
      label: "Disable Workflow tool",
      description: "Hide Claude Code's native Workflow tool for Cloudroom threads.",
      default: false,
    },
    chromeEnabled: {
      type: "boolean",
      label: "Claude in Chrome",
      description:
        "Start Claude Code with the Claude in Chrome browser tools. Needs the Chrome extension and a claude.ai login on the host.",
      default: false,
    },
    claudeAiConnectorsEnabled: {
      type: "boolean",
      label: "claude.ai connectors",
      description:
        "Load connectors from your claude.ai account, like Gmail and Google Drive. Applies to new Claude sessions.",
      default: false,
    },
  });

  bb.providers.register({
    id: "claude-code",
    displayName: "Claude Code",
    icon: "./icons/claude-code.svg",
    strings: {
      signInHint: "Run `claude` on the machine to sign in.",
      expiredHint: "Your Claude session expired. Run `claude`, then reload.",
      installUrl: "https://claude.com/claude-code",
      brandPrefix: "Claude ",
      planModeCopy:
        "Claude Code will plan without normal full-access execution.",
      iconTint: { light: "#D97757", dark: "#D97757" },
    },
    ...CLAUDE_NATIVE_ROOTS_DECLARATION,
    maintenance: { health: true, usage: true, installation: true },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: true,
      fork: "checkpoint",
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "auto", "full"],
      reasoningLevels: ["low", "medium", "high", "xhigh", "ultracode", "max"],
    },
    reasoningLevels: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
      {
        id: "ultracode",
        label: "Ultracode",
        description: "Extra-high effort plus standing workflow orchestration.",
      },
      { id: "max", label: "Max" },
    ],
    composerActions: ["plan"],
    completedTurnDisplay: "flat",
    env: { passthrough: ["BB_CLAUDE_CODE_EXECUTABLE"] },
    models: {
      scope: "host",
      fallback: CLAUDE_CODE_ACTIVE_CATALOG_DATA.map((entry) => ({
        id: entry.model,
        displayName: claudeModelLabel(entry.model) ?? entry.model,
        description: entry.description,
        supportedReasoningEfforts: CLAUDE_XHIGH_CAPABLE_REASONING_EFFORT_DATA,
        defaultReasoningEffort: entry.defaultReasoningEffort,
        isDefault: entry.model === DEFAULT_CLAUDE_CODE_MODEL,
      })),
    },
    deriveProviderOptions(context) {
      return {
        memoryEnabled: context.settings.memoryEnabled !== false,
        providerSubagentsEnabled: context.settings.subagentsDisabled !== true,
        workflowsEnabled: context.settings.workflowsDisabled !== true,
        chromeEnabled: context.settings.chromeEnabled === true,
        claudeAiConnectorsEnabled:
          context.settings.claudeAiConnectorsEnabled === true,
        ...(context.promptMode === "plan"
          ? { claudeCodePermissionMode: "plan" }
          : {}),
      };
    },
  });
}

/** `claude auth status` sees only the Mac's own login. Threads can also run on a login Cloudroom supplies, like the
 *  account's cloud Claude login (ADR 0175); provider health counts those. */
async function hasSuppliedClaudeLogin(
  bb: BbPluginApi,
  hostId: string,
): Promise<boolean> {
  try {
    const { providers } = await bb.sdk.system.providerStates({ hostId });
    return providers.some(
      (provider) => provider.providerId === "claude-code" && provider.status === "ready",
    );
  } catch {
    return false;
  }
}
