import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { CustomProviderModel } from "@cloudroom/config/app-managed-config";
import { DEFAULTS } from "@cloudroom/config/defaults";
import { getInstalledPlugin, type DbConnection } from "@cloudroom/db";
import { readOrCreateSecretFile } from "@cloudroom/secret-storage";
import type { AppSurface, RequestAppSurface } from "@cloudroom/config/app-surface";
import type { ServerLogger } from "../../types.js";
import { isPublicPlugin } from "../plugins/plugin-registration.js";
import type { ProviderRegistryService } from "../providers/provider-registry.js";
import { modelName } from "./usage-analytics.js";

export const TELEMETRY_ID_FILE_NAME = "telemetry-id";
/** Events wait in memory and reach our own server through the website in batches (ADR 20261102-201050). */
const BATCH_SIZE = 100, MAX_QUEUED = 1_000, FIRST_FLUSH_MS = 10_000, FLUSH_MS = 60_000;

const telemetryAppSurfaceStorage = new AsyncLocalStorage<RequestAppSurface>();

/** Where a thread runs: on this computer, in its own cloud sandbox, or on the older shared cloud VM. */
export type TelemetryExecution = "local" | "cloud_sandbox" | "cloud_vm";

/** The desktop app's first-run setup funnel: which step people see, act on, finish, skip, or leave. */
export const SETUP_STEPS = ["account", "agent", "github", "project"] as const;
export const SETUP_ACTIONS = ["viewed", "started", "done", "skipped", "closed", "detected", "waitlist"] as const;
export const SETUP_AGENTS = ["pi", "opencode", "cursor", "hermes", "grok", "devin", "droid", "kimi", "antigravity", "fx", "openclaw", "agent-zero"] as const;
export const SETUP_DETAILS = ["github", "gitlab", "google", "email", "claude", "codex", "both", "none", "existing", "found", "folder", "recent_folder", "bb_import", "chat_import", "auto", "manual", "repos", "mac", ...SETUP_AGENTS] as const;

export type TelemetryValue = string | number | boolean | null;

export type TelemetryEvent =
  | { name: "app_started"; properties?: { update_needs_password: boolean } }
  /** Onboarding telemetry (ADR 0198); built in services/cloudroom/setup-telemetry.ts. */
  | { name: "setup_snapshot" | "agent_connect" | "cli_install" | "account_sign_in_failed" | "update_install" | "update_ready" | "app_crash" | "windows_install"; properties: Record<string, TelemetryValue> }
  | {
      name: "thread_created";
      properties: {
        execution: TelemetryExecution;
        is_child_thread: boolean;
        provider: string;
        /** An imported chat's first message: its agent starts now, not at import. */
        imported?: true;
      };
    }
  /** A thread moved to another harness or model in place (ADR 0211). */
  | {
      name: "harness_switched";
      properties: {
        execution: TelemetryExecution;
        from: string;
        to: string;
        resend: boolean;
      };
    }
  | {
      name: "user_message_sent";
      properties: {
        execution: TelemetryExecution;
        is_child_thread: boolean;
        message_source: "queued_message" | "thread_create" | "thread_send";
        provider: string;
        /** A message the user typed in the first agent's thread (services/system/first-agent.ts). */
        first_agent?: true;
      };
    }
  | {
      name: "first_response";
      properties: {
        /** The first agent's reply. */
        first_agent?: true;
        execution: TelemetryExecution;
        is_child_thread: boolean;
        message_source: "queued_message" | "thread_create" | "thread_send";
        ms: number;
        provider: string;
        sandbox_woke: boolean | null;
        startup_source?: string | null;
        sandbox_start_ms?: number | null;
        model?: string | null;
        reasoning_level?: string | null;
        service_tier?: string | null;
        harness_version?: string | null;
        /** Local threads: the environment provider, like `git-worktree` for Local Worktree. */
        environment_provider?: string | null;
        /** How long the provider took to create the workspace, on the message whose send created it. */
        workspace_create_ms?: number | null;
        seconds_since_first_launch?: number;
      };
    }
  | {
      name: "provider_auth_failed";
      properties: {
        execution: TelemetryExecution;
        provider: string;
        provider_code: string | null;
        running_threads: number;
      };
    }
  | {
      name: "setup_step";
      properties: {
        step: (typeof SETUP_STEPS)[number];
        action: (typeof SETUP_ACTIONS)[number];
        detail: (typeof SETUP_DETAILS)[number] | null;
        agents?: string;
        seconds_since_first_launch?: number;
        copy_logins?: boolean | null;
        mac_access?: string | null;
      };
    }
  | { name: "settings_search_no_results"; properties: { query: string } }
  | { name: "bug_report_clicked" }
  /** Thread share links (docs/scopes/thread-share-links.md#tracking). `share_id` is a hash of the link's token, never
   *  the token, and null while the thread has no link. */
  | { name: "share"; properties: { action: ShareAction; share_id: string | null; provider?: string; execution?: TelemetryExecution } }
  | {
      name: "plugin_installed";
      properties: {
        plugin_id: string | null;
        provenance: "builtin" | "catalog" | "direct";
        marketplace: string | null;
        source_kind: "builtin" | "git" | "npm" | "path";
      };
    }
  /** Plugin use counts and which plugins are on; built in services/plugins/plugin-usage-telemetry.ts. */
  | { name: "plugin_usage"; properties: { plugin_id: string; tool: number; cli: number; mention: number; ui: number } }
  | { name: "plugins_snapshot"; properties: { enabled: string; disabled: string } }
  /** Local threads' tokens per UTC `day`, agent and model; built in token-telemetry.ts. `input` excludes cache reads. */
  | {
      name: "token_usage";
      properties: { day: string; provider: string; model: string; is_child_thread: boolean; input: number; cached: number; cache_write: number; output: number; turns: number };
    }
  /** Skills run and agents started on this computer per finished UTC `day`; built in skill-telemetry.ts. */
  | { name: "skill_usage"; properties: { day: string; skill_runs: number; threads: number } }
  | {
      /** A sent message that got no reply and no error (first-response-telemetry.ts). */
      name: "turn_silent";
      properties: {
        /** `no_reply`: no output 10 minutes after the send. `empty`: the turn ended as completed with no output. */
        reason: "no_reply" | "empty"; ms: number; execution: TelemetryExecution; is_child_thread: boolean;
        message_source: "queued_message" | "thread_create" | "thread_send"; provider: string; model: string | null;
        /** The thread's status at that moment, and whether the agent started a turn for the message. */
        thread_status: string; turn_started: boolean;
        started_by?: string; first_agent?: true;
      };
    }
  | {
      name: "turn_failed";
      properties: {
        /** The provider's category, else Cloud's, else our own code (`host-disconnected`, `rpc-timeout`), else `unknown`. */
        execution: TelemetryExecution; is_child_thread: boolean; provider: string; error_category: string; error_message: string | null; first_agent?: true;
        /** The provider's HTTP status and code, when it gave them. */
        http_status?: number; provider_code?: string;
        /** `person` (typed in the app), `script` (API or CLI), `agent`, or `system`; absent when the request didn't record it. */
        started_by?: string;
        /** A Cloud prompt Cloud refused (auth-failure-telemetry.ts): Core's code, this computer's logins, and the default agent. */
        cloud_code?: string | null; local_logins?: string; default_agent?: string;
      };
    }
  /** A thread a plan limit stopped runs again (plan-limit-telemetry.ts): how long it waited, and what got it going. */
  | {
      name: "plan_limit_resolved";
      properties: { provider: string; execution: TelemetryExecution; is_child_thread: boolean; how: "account_switch" | "agent_switch" | "retry" | "user"; blocked_ms: number };
    }
  /** The plan-limit card showed, once per limit per app run. Its clicks are `account_switch` (`where: limit_card`) and `harness_switched` (`resend`). */
  | { name: "limit_card"; properties: { provider: string; execution: TelemetryExecution; can_switch_account: boolean; other_agents: number } }
  | { name: "upgrade_prompt"; properties: { where: (typeof UPGRADE_PROMPTS)[number]; action: "viewed" | "clicked" } }
  | { name: "activation_step"; properties: { step: ActivationStep; action: "clicked" | "done" | "hidden" } }
  | { name: "popup"; properties: { popup: Popup; action: "viewed" | "closed" | PopupDetail } }
  /** A card at the top right (docs/scopes/corner-cards.md). `viewed`: a new showing started. `key` names the showing; `variant` is its design. */
  | { name: "corner"; properties: { card: CornerCard; key: string; action: "viewed" | CornerAnswer; variant?: string } }
  /** Monthly Wrapped (docs/scopes/wrapped.md): the top-right card and the Story it opens. `month` is `2026-10`. */
  | { name: "wrapped"; properties: { month: string; action: (typeof WRAPPED_ACTIONS)[number] } }
  | { name: "prompt_suggestion"; properties: { action: "shown" | "accepted"; provider: string } }
  /** The "save as skill" card on a thread that repeats a job (docs/scopes/skill-suggestions.md). */
  | { name: "skill_suggestion"; properties: { action: "shown" | "accepted" | "dismissed" } }
  | { name: "cloud_choice"; properties: { action: (typeof CLOUD_CHOICE_ACTIONS)[number]; reason: (typeof CLOUD_CHOICE_REASONS)[number] | null } }
  /** A Local message the queue failed or dropped (services/threads/queue-drain-failure.ts). */
  | { name: "queue_delivery"; properties: { outcome: "failed" | "dropped"; message: string; waiting_on: string | null; thread_status: string | null; error: string | null; detail: string | null } };

/** `opened` is a click on the Share button and `copied` one on Copy. The website adds what viewers do. */
export const SHARE_CLICKS = ["opened", "copied"] as const;
export type ShareAction = (typeof SHARE_CLICKS)[number] | "created" | "updated" | "stopped" | "continued";
/** `viewed`: the card showed. `opened`: the Story opened. `closed`: the card's X. Then the Story's three buttons. */
export const WRAPPED_ACTIONS = ["viewed", "opened", "closed", "saved", "copied", "shared"] as const;
export const CLOUD_CHOICE_ACTIONS = ["picked_local", "cloud_blocked", "forced_local", "switched_agent"] as const;
export const CLOUD_CHOICE_REASONS = ["signed_out", "agent_unsupported", "agent_not_in_cloud", "claude_not_connected", "queue", "region"] as const;
export const UPGRADE_PROMPTS = ["limit_notice", "queue", "queue_badge", "capacity_card", "capacity_badge", "limit_link", "plan_card", "free_tip", "auto_delete", "try_cloud", "new_thread_cloud", "limit_notice_pack", "mac_battery", "mac_cpu", "mac_memory", "mac_heat", "mac_disk", "mac_network", "moment_slept", "moment_quit", "moment_crowded", "one_click_scan"] as const;
export const ACTIVATION_STEPS = ["cloud", "subagents", "second", "phone", "loop"] as const;
export type ActivationStep = (typeof ACTIVATION_STEPS)[number];
export const POPUPS = ["credits", "star", "install", "star_card", "cloud_card"] as const;
export type Popup = (typeof POPUPS)[number];
export const POPUP_DETAILS = ["starred", "opened", "already", "migrated"] as const;
export type PopupDetail = (typeof POPUP_DETAILS)[number];
/** The cards at the top right, as the app's corner module lists them (packages/shared-ui/src/lib/corner.ts).
 *  `build` is the "build next" note on the chat input (docs/scopes/build-next.md): it never shows at the top right,
 *  and only keeps its showings and answers in the same record. Its `variant` is the bet the user ticked. */
export const CORNER_CARDS = ["invite", "call", "checklist", "wrapped", "scan", "partner", "build"] as const;
export type CornerCard = (typeof CORNER_CARDS)[number];
export const CORNER_ANSWERS = ["opened", "closed"] as const;
export type CornerAnswer = (typeof CORNER_ANSWERS)[number];
const PLANS = ["free", "pro", "super", "ultra"];

export type PluginTelemetryProperties = Record<string, TelemetryValue>;

/** Where batches go. Signed-in apps add their login, so the website can save the verified account with the events. */
export type TelemetryTarget = { website: string; authorization?: string };

/** Masks custom/non-public model names and private/custom provider IDs before events leave this computer. */
export interface TelemetryPrivacyFilter {
  isPrivateModel(model: string): boolean;
  isPrivateProvider(provider: string): boolean;
}

const PUBLIC_MODEL_VENDORS = new Set([
  "openrouter", "anthropic", "openai", "google", "google-ai", "google-vertex", "google-gemini-cli",
  "xai", "x-ai", "grok", "moonshot", "moonshotai", "moonshotai-cn", "kimi", "kimi-for-coding",
  "deepseek", "qwen", "qwen-portal", "alibaba", "alibaba-coding-plan", "dashscope",
  "meta", "meta-llama", "mistral", "mistralai", "mistral-ai", "zhipu", "zhipuai", "zai", "z-ai",
  "zai-coding-plan", "minimax", "minimax-cn", "cursor", "cohere", "perplexity",
  "amazon", "amazon-bedrock", "aws-bedrock", "bedrock", "vertex", "azure", "azure-openai",
  "nvidia", "microsoft", "huggingface", "together", "fireworks", "groq", "cerebras", "sambanova",
  "vercel", "opencode", "opencode-go", "opencode-zen", "github-copilot", "copilot", "codex", "claude",
  "gemini", "antigravity", "droid", "factory", "devin", "hermes", "fx", "amp",
  "kilo", "kilo-auto", "cline", "openclaw", "agent-zero", "stepfun", "bytedance", "bytedance-seed",
  "xiaomi", "ai21", "nousresearch", "nous", "allenai", "inflection", "inception", "arcee-ai",
  "featherless", "chutes", "nebius", "novita", "deepinfra", "baseten", "replicate", "cloudflare",
  "synthetic", "venice",
]);
const PUBLIC_MODEL_SENTINELS = new Set(["auto", "default", "best", "unknown", "opusplan"]);
const KILO_AUTO_MODES = new Set(["free", "frontier", "balanced", "efficient"]);
const PUBLIC_MODEL_SUFFIX = /:(?:free|thinking|beta|exacto|nitro|floor|online|extended|high|medium|low|max|fast)$/i;
const PUBLIC_MODEL_FAMILY =
  /^(?:(?:claude|opus|sonnet|haiku|fable|gpt|chatgpt|codex|gemini|gemma|grok|kimi|moonshot|deepseek|qwen|qwq|llama|muse|mistral|mixtral|codestral|devstral|pixtral|ministral|magistral|glm|minimax|composer|nova|command|sonar|phi|nemotron|granite|trinity|mercury|doubao|seed|step|swe|devin|jamba|hermes|mimo|big-pickle)(?:$|[0-9._ -])|o[134](?:$|[- .]))/;

/** Allowlist for public model names (raw IDs or normalized display names). Anything else becomes "custom". */
export function isPublicModel(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 120) return false;
  const cleaned = trimmed.replace(/\[\d+[km]\]$/i, "").replace(PUBLIC_MODEL_SUFFIX, "");
  // Reject ARNs, fine-tune IDs (`ft:...`), Ollama tags, or other private qualifiers.
  if (cleaned.includes(":")) return false;
  const parts = cleaned.split("/");
  if (parts.length > 3 || parts.some((part) => !part)) return false;
  const prefixes = parts.slice(0, -1).map((part) => part.toLowerCase());
  if (!prefixes.every((prefix) => PUBLIC_MODEL_VENDORS.has(prefix))) return false;
  const base = parts[parts.length - 1]!.toLowerCase();
  if (!/^[a-z0-9][a-z0-9._ -]{0,80}$/.test(base)) return false;
  if (PUBLIC_MODEL_SENTINELS.has(base)) return true;
  if (prefixes[prefixes.length - 1] === "kilo-auto" && KILO_AUTO_MODES.has(base)) return true;
  return PUBLIC_MODEL_FAMILY.test(base);
}

export function createTelemetryPrivacyFilter(args: {
  db: DbConnection;
  getCustomModels: () => readonly CustomProviderModel[];
  providerRegistry: Pick<ProviderRegistryService, "get" | "list">;
}): TelemetryPrivacyFilter {
  return {
    isPrivateModel(model: string): boolean {
      const customModels = args.getCustomModels();
      if (customModels.length > 0) {
        const normalized = modelName(model);
        const configured = customModels.some(
          (entry) =>
            entry.model === model ||
            entry.displayName === model ||
            (normalized !== "Unknown" && modelName(entry.model) === normalized),
        );
        if (configured) return true;
      }
      return !isPublicModel(model);
    },
    isPrivateProvider(provider: string): boolean {
      if (!provider || provider === "none") return false;
      const registration = args.providerRegistry.get(provider);
      if (registration !== null) {
        if (registration.bridgeOptions.customAgent === true) return true;
        const plugin = getInstalledPlugin(args.db, registration.pluginId);
        return (
          plugin !== undefined &&
          !isPublicPlugin(plugin.provenance, plugin.catalogMarketplaceName ?? undefined)
        );
      }
      // Once ACP providers are loaded, every shipped ACP agent is registered; any other `acp-*` ID is a removed custom one.
      if (
        provider.startsWith("acp-") &&
        args.providerRegistry.list().some((entry) => entry.info.family === "acp")
      ) {
        return true;
      }
      return false;
    },
  };
}

function sanitizeTelemetryProperties(
  name: string,
  eventProperties: Record<string, unknown>,
  filter: TelemetryPrivacyFilter | null,
): Record<string, unknown> {
  let patched: Record<string, unknown> | null = null;
  const set = (key: string, value: string): void => {
    patched ??= { ...eventProperties };
    patched[key] = value;
  };
  let privateProvider = false;
  if (filter) {
    const providerKeys = name === "harness_switched" ? ["from", "to"] : ["provider", "default_agent"];
    for (const key of providerKeys) {
      const value = eventProperties[key];
      if (typeof value === "string" && filter.isPrivateProvider(value)) {
        set(key, "custom");
        if (key === "provider") privateProvider = true;
      }
    }
  }
  const model = eventProperties.model;
  if (typeof model === "string" && model.trim().length > 0 && (privateProvider || (filter ? filter.isPrivateModel(model) : !isPublicModel(model)))) {
    set("model", "custom");
  }
  return patched ?? eventProperties;
}

export interface TelemetryService {
  capture(event: TelemetryEvent): void;
  capturePlugin(pluginId: string, name: string, properties: PluginTelemetryProperties): void;
  flush(): Promise<void>;
  setEnabled(enabled: boolean): void;
  setPlanSource(source: () => string | null): void;
  setPrivacyFilter(filter: TelemetryPrivacyFilter): void;
  setTargetSource(source: () => Promise<TelemetryTarget>): void;
}

interface CreateTelemetryServiceArgs {
  appSurface: AppSurface;
  appVersion: string;
  dataDir: string;
  /** Cloudroom release stamp, like "v66". Unset outside the desktop app. */
  desktopVersion?: string | undefined;
  enabled: boolean;
  telemetryEnabled: boolean;
  logger: ServerLogger;
}

const noopTelemetryService: TelemetryService = {
  capture: () => {},
  capturePlugin: () => {},
  flush: () => Promise.resolve(),
  setEnabled: () => {},
  setPlanSource: () => {},
  setPrivacyFilter: () => {},
  setTargetSource: () => {},
};

export function createNoopTelemetryService(): TelemetryService {
  return noopTelemetryService;
}

/** The surface of the request being handled (`desktop`, `web`, `mobile`, `api`); undefined outside a request. */
export function currentAppSurface(): RequestAppSurface | undefined {
  return telemetryAppSurfaceStorage.getStore();
}

export function runWithTelemetryAppSurface<T>(
  appSurface: RequestAppSurface,
  callback: () => T,
): T {
  return telemetryAppSurfaceStorage.run(appSurface, callback);
}

export async function createTelemetryService(
  args: CreateTelemetryServiceArgs,
): Promise<TelemetryService> {
  if (!args.enabled || args.appVersion === DEFAULTS.appVersion) {
    return noopTelemetryService;
  }
  let distinctId: Promise<string> | null = null;
  const readDistinctId = () => (distinctId ??= readOrCreateSecretFile({
    bytes: 16,
    dataDir: args.dataDir,
    encoding: "hex",
    fileName: TELEMETRY_ID_FILE_NAME,
  }).catch((error: unknown) => {
    distinctId = null;
    throw error;
  }));
  let telemetryEnabled = args.telemetryEnabled;
  let planSource: () => string | null = () => null;
  let privacyFilter: TelemetryPrivacyFilter | null = null;
  let targetSource: (() => Promise<TelemetryTarget>) | null = null;
  const queue: { id: string; name: string; at: string; properties: object }[] = [];
  let flushing: Promise<void> | null = null;
  let optOuts = 0;
  const sendBatches = async (): Promise<void> => {
    while (targetSource && queue.length > 0) {
      const startedAt = optOuts;
      const batch = queue.slice(0, BATCH_SIZE);
      const { website, authorization } = await targetSource();
      if (optOuts !== startedAt) return; // Turned off during that wait: this copy of the batch must not leave.
      const installId = await readDistinctId();
      if (optOuts !== startedAt) return;
      const response = await fetch(`${website}/api/desktop/events`, {
        body: JSON.stringify({ install_id: installId, events: batch }),
        headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      // A 400 will never succeed. Anything else stays queued for the next flush, and the event IDs drop any duplicates.
      if (optOuts !== startedAt || (!response.ok && response.status !== 400)) return;
      queue.splice(0, batch.length);
    }
  };
  const flush = (): Promise<void> => {
    flushing ??= sendBatches()
      .catch((error: unknown) => { args.logger.debug({ err: error }, "Telemetry batch send failed"); })
      .finally(() => { flushing = null; });
    return flushing;
  };
  setTimeout(() => void flush(), FIRST_FLUSH_MS).unref();
  setInterval(() => void flush(), FLUSH_MS).unref();
  const commonProperties = {
    app_version: args.appVersion,
    arch: process.arch,
    cloudroom_version: args.desktopVersion ?? null,
    platform: process.platform,
  };
  const send = (name: string, eventProperties: Record<string, unknown>): void => {
    if (!telemetryEnabled) return;
    const appSurface = telemetryAppSurfaceStorage.getStore() ?? args.appSurface;
    const plan = planSource();
    const sanitized = sanitizeTelemetryProperties(name, eventProperties, privacyFilter);
    const properties = {
      ...commonProperties,
      ...sanitized,
      app_surface: appSurface,
      plan: plan && PLANS.includes(plan) ? plan : null,
    };
    const timestamp = new Date().toISOString();
    if (queue.length >= MAX_QUEUED) queue.shift();
    queue.push({ id: randomUUID(), name, at: timestamp, properties });
    if (queue.length >= BATCH_SIZE) void flush();
  };
  return {
    flush,
    setEnabled(enabled: boolean): void {
      telemetryEnabled = enabled;
      if (!enabled) {
        optOuts += 1;
        queue.length = 0;
      }
    },
    setPlanSource(source): void {
      planSource = source;
    },
    setPrivacyFilter(filter): void {
      privacyFilter = filter;
    },
    setTargetSource(source): void {
      targetSource = source;
    },
    capturePlugin(pluginId, name, properties): void {
      send(name, { ...properties, plugin_id: pluginId });
    },
    capture(event: TelemetryEvent): void {
      send(event.name, ("properties" in event ? event.properties : undefined) ?? {});
    },
  };
}
