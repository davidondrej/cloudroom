import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULTS } from "@cloudroom/config/defaults";
import { readOrCreateSecretFile } from "@cloudroom/secret-storage";
import type { AppSurface, RequestAppSurface } from "@cloudroom/config/app-surface";
import type { ServerLogger } from "../../types.js";

const POSTHOG_INGESTION_URL = "https://us.i.posthog.com/capture/";
export const TELEMETRY_ID_FILE_NAME = "telemetry-id";

const telemetryAppSurfaceStorage = new AsyncLocalStorage<RequestAppSurface>();

/** Where a thread runs: on this computer, in its own cloud sandbox, or on the older shared cloud VM. */
export type TelemetryExecution = "local" | "cloud_sandbox" | "cloud_vm";

/** The desktop app's first-run setup funnel: which step people see, act on, finish, skip, or leave. */
export const SETUP_STEPS = ["account", "agent", "github", "project"] as const;
export const SETUP_ACTIONS = ["viewed", "started", "done", "skipped", "closed", "detected", "waitlist"] as const;
export const SETUP_AGENTS = ["pi", "opencode", "cursor", "hermes", "grok", "devin", "droid", "fx", "openclaw"] as const;
export const SETUP_DETAILS = ["github", "google", "email", "claude", "codex", "both", "none", "existing", "found", "folder", "recent_folder", "bb_import", "chat_import", ...SETUP_AGENTS] as const;

export type TelemetryValue = string | number | boolean | null;

export type TelemetryEvent =
  | { name: "app_started"; properties?: { update_needs_password: boolean } }
  /** Onboarding telemetry (ADR 0198); built in services/cloudroom/setup-telemetry.ts. */
  | { name: "setup_snapshot" | "agent_connect" | "cli_install" | "account_sign_in_failed" | "update_install" | "app_crash"; properties: Record<string, TelemetryValue> }
  | {
      name: "thread_created";
      properties: {
        execution: TelemetryExecution;
        is_child_thread: boolean;
        provider: string;
      };
    }
  /** A thread moved to another harness or model in place (ADR 0211). */
  | {
      name: "harness_switched";
      properties: { execution: TelemetryExecution; from: string; to: string };
    }
  | {
      name: "user_message_sent";
      properties: {
        execution: TelemetryExecution;
        is_child_thread: boolean;
        message_source: "queued_message" | "thread_create" | "thread_send";
        provider: string;
      };
    }
  | {
      name: "first_response";
      properties: {
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
  | {
      name: "turn_failed";
      properties: { execution: TelemetryExecution; is_child_thread: boolean; provider: string; error_category: string; error_message?: string | null };
    }
  | { name: "upgrade_prompt"; properties: { where: (typeof UPGRADE_PROMPTS)[number]; action: "viewed" | "clicked" } }
  | { name: "activation_step"; properties: { step: ActivationStep; action: "clicked" | "done" | "hidden" } }
  | { name: "starter_prompt"; properties: { starter: StarterPrompt } }
  | { name: "popup"; properties: { popup: Popup; action: "viewed" | "closed" | PopupDetail } }
  | { name: "cloud_choice"; properties: { action: (typeof CLOUD_CHOICE_ACTIONS)[number]; reason: (typeof CLOUD_CHOICE_REASONS)[number] | null } };

export const CLOUD_CHOICE_ACTIONS = ["picked_local", "cloud_blocked", "forced_local"] as const;
export const CLOUD_CHOICE_REASONS = ["signed_out", "agent_unsupported", "agent_not_in_cloud", "queue", "region"] as const;
export const UPGRADE_PROMPTS = ["limit_notice", "queue", "queue_badge", "plan_card", "free_tip", "auto_delete", "try_cloud", "new_thread_cloud", "og_letter", "limit_notice_pack"] as const;
export const ACTIVATION_STEPS = ["cloud", "subagents", "second", "phone", "loop"] as const;
export type ActivationStep = (typeof ACTIVATION_STEPS)[number];
export const STARTER_PROMPTS = ["security", "keys", "packages", "mac"] as const;
export type StarterPrompt = (typeof STARTER_PROMPTS)[number];
export const POPUPS = ["credits", "star", "install"] as const;
export type Popup = (typeof POPUPS)[number];
export const POPUP_DETAILS = ["starred", "opened", "already", "migrated"] as const;
export type PopupDetail = (typeof POPUP_DETAILS)[number];
const PLANS = ["free", "pro", "super", "ultra"];

export type PluginTelemetryProperties = Record<string, TelemetryValue>;

export interface TelemetryService {
  capture(event: TelemetryEvent): void;
  capturePlugin(pluginId: string, name: string, properties: PluginTelemetryProperties): void;
  setEnabled(enabled: boolean): void;
  setPlanSource(source: () => string | null): void;
}

interface CreateTelemetryServiceArgs {
  apiKey: string;
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
  setEnabled: () => {},
  setPlanSource: () => {},
};

export function createNoopTelemetryService(): TelemetryService {
  return noopTelemetryService;
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
  if (
    !args.enabled ||
    args.apiKey.length === 0 ||
    args.appVersion === DEFAULTS.appVersion
  ) {
    return noopTelemetryService;
  }
  const distinctId = await readOrCreateSecretFile({
    bytes: 16,
    dataDir: args.dataDir,
    encoding: "hex",
    fileName: TELEMETRY_ID_FILE_NAME,
  });
  let telemetryEnabled = args.telemetryEnabled;
  let planSource: () => string | null = () => null;
  const commonProperties = {
    app_version: args.appVersion,
    arch: process.arch,
    cloudroom_version: args.desktopVersion ?? null,
    platform: process.platform,
  };
  const send = (name: string, eventProperties: object): void => {
    if (!telemetryEnabled) return;
    const appSurface = telemetryAppSurfaceStorage.getStore() ?? args.appSurface;
    const plan = planSource();
    const body = JSON.stringify({
      api_key: args.apiKey,
      distinct_id: distinctId,
      event: name,
      properties: {
        ...commonProperties,
        ...eventProperties,
        app_surface: appSurface,
        plan: plan && PLANS.includes(plan) ? plan : null,
      },
      timestamp: new Date().toISOString(),
    });
    fetch(POSTHOG_INGESTION_URL, {
      body,
      headers: { "content-type": "application/json" },
      method: "POST",
    }).catch((error: unknown) => {
      args.logger.debug(
        { app_surface: appSurface, err: error, event: name },
        "Telemetry event send failed",
      );
    });
  };
  return {
    setEnabled(enabled: boolean): void {
      telemetryEnabled = enabled;
    },
    setPlanSource(source): void {
      planSource = source;
    },
    capturePlugin(pluginId, name, properties): void {
      send(name, { ...properties, plugin_id: pluginId });
    },
    capture(event: TelemetryEvent): void {
      send(event.name, ("properties" in event ? event.properties : undefined) ?? {});
    },
  };
}
