import type { BbPluginApi, JsonValue } from "@get-bb/plugin-sdk";

// Cloudroom Agent (docs/scopes/cloudroom-agent.md): Pi, on a model Cloudroom hosts and sells for Cloud Credits. This
// side registers the agent and keeps a token that can only buy inference. The token rides to the computer that runs
// the thread with every command, and src/host.ts hands it to Pi there.

export const PROVIDER_ID = "cloudroom-agent";
/** Often, so a sign-in or an account change counts at once. The app's server answers from memory and asks the website
 *  once a day (apps/server/src/services/cloudroom/sandboxes.ts). */
const CHECK_MS = 5_000;

type Grant = { token: string; expiresAt: number; baseUrl: string; model: { id: string } & Record<string, JsonValue> };

function parseGrant(value: unknown): Grant {
  const grant = value as Partial<Grant> | null;
  if (typeof grant?.token !== "string" || typeof grant.expiresAt !== "number" || typeof grant.baseUrl !== "string" || typeof grant.model?.id !== "string") {
    throw new Error("Cloudroom sent no token.");
  }
  return { token: grant.token, expiresAt: grant.expiresAt, baseUrl: grant.baseUrl, model: grant.model };
}

export default function plugin(room: BbPluginApi): void {
  let grant: Grant | null = null;
  let problem = "Cloudroom Agent is still starting. Try again in a moment.";
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      grant = parseGrant(await room.sdk.cloudroom.inference());
    } catch (error) {
      // Signed out, or no token for this account: never keep another sign-in's.
      grant = null;
      problem = `Cloudroom Agent isn't ready: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      checking = false;
    }
  };
  void check();
  const timer = setInterval(() => void check(), CHECK_MS);
  timer.unref?.();

  const registered = room.providers.register({
    id: PROVIDER_ID,
    displayName: "Cloudroom Agent",
    icon: "Cloud",
    strings: {
      signInHint: "Sign in to Cloudroom to use Cloudroom Agent.",
      expiredHint: "Sign in to Cloudroom again to use Cloudroom Agent.",
      installUrl: "https://cloudroom.dev",
      iconTint: { light: "#5C7A00", dark: "#BFFF00" },
    },
    experimental_modelDiscoveryRestart: true,
    maintenance: { health: true, usage: false, installation: true },
    env: { passthrough: ["BB_PI_BRIDGE_COMMAND", "BB_PI_BRIDGE_ARGS"] },
    // The same on every folder of a computer: Cloudroom Agent has one model, and no project can add more.
    models: {
      scope: "host",
      fallback: [{
        id: "cloudroom/cloudroom-agent",
        displayName: "Cloudroom Agent",
        description: "Frontier open source models",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fast" },
          { reasoningEffort: "medium", description: "Balanced" },
          { reasoningEffort: "high", description: "Thorough" },
        ],
        defaultReasoningEffort: "medium",
        isDefault: true,
      }],
    },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "checkpoint",
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["full"],
      reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    },
    reasoningLevels: [
      { id: "none", label: "None" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
      { id: "max", label: "Max" },
    ],
    composerActions: [],
    deriveProviderOptions: () => {
      if (!grant || grant.expiresAt <= Date.now()) {
        void check();
        throw new Error(problem);
      }
      return { cloudroomAgent: grant };
    },
  });
  room.onDispose(() => {
    clearInterval(timer);
    registered.dispose();
  });
}
