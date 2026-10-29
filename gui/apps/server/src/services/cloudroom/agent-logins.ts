import { getAppSettings, setAppSettings } from "@cloudroom/db";
import type { AppSettings } from "@cloudroom/domain";
import { execPortableFile, findCliExecutable } from "@cloudroom/process-utils";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import type { PluginService } from "../plugins/plugin-service.js";
import { macClaudeSignedIn } from "./claude-token.js";
import { cloudroom } from "./commands.js";
import { hasMacCodexLogin, removeMacCodexLogin, type SandboxLogin } from "./sandboxes.js";
import { loginMarkers, markLogin } from "./sync.js";

type SignOut = { command: readonly [string, ...string[]]; signedIn: () => Promise<boolean>; withoutCli?: () => Promise<void> };

/** Each agent's login in Cloud, and how to sign its CLI out on this computer. */
const AGENTS: Record<string, { login: Exclude<SandboxLogin, "mcp" | "github">; signOut?: SignOut }> = {
  "claude-code": { login: "claude", signOut: { command: ["claude", "auth", "logout"], signedIn: async () => await macClaudeSignedIn() === true } },
  codex: { login: "codex", signOut: { command: ["codex", "logout"], signedIn: hasMacCodexLogin, withoutCli: removeMacCodexLogin } },
  pi: { login: "pi" },
  "acp-opencode": { login: "opencode" },
  "acp-hermes-agent": { login: "hermes" },
  "acp-devin": { login: "devin" },
  "acp-openclaw": { login: "openclaw" },
  "acp-cursor": { login: "cursor" },
};

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
let operations: Promise<unknown> = Promise.resolve();
const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
  const run = operations.then(work);
  operations = run.catch(() => {});
  return run;
};

/** Disconnect (ADR 0327), in an order that fails safe: block syncing, delete the Cloud login (nothing else changes if
 *  the website refuses), remove added accounts, then sign the CLI out. Remove also hides the agent. */
export function disconnectAgent(deps: AppDeps, plugins: PluginService, providerId: string, remove: boolean): Promise<void> {
  return oneAtATime(async () => {
    requireAgent(deps, providerId);
    const agent = AGENTS[providerId];
    if (!remove && !agent?.signOut) throw new ApiError(400, "agent_not_disconnectable", "Only Claude Code and Codex can be disconnected. Remove the agent instead.");
    const settings = remove ? withHidden(deps, providerId, true) : null;
    const clearAccounts = agent?.signOut ? accountsClearer(plugins) : null;
    if (agent) {
      const sandboxes = cloudroom(deps).sandboxes;
      await sandboxes.withLogins(async () => {
        const before = (await loginMarkers(deps))[agent.login] ?? null;
        await markLogin(deps, agent.login, "blocked");
        if (await sandboxes.account()) {
          await sandboxes.removeLogin(agent.login).catch(async (error: unknown) => {
            await markLogin(deps, agent.login, before);
            throw new ApiError(503, "agent_disconnect_unavailable", `Nothing changed. The Cloud login could not be removed: ${message(error)}`);
          });
        }
        if (!agent.signOut || !clearAccounts) return;
        await clearAccounts(providerId).catch((error: unknown) => {
          throw new ApiError(502, "agent_accounts_not_removed", `The Cloud login is removed, but the added accounts are not: ${message(error)} Try again.`);
        });
        await signOut(agent.signOut);
        await markLogin(deps, agent.login, "signed-out");
      });
    }
    if (settings) saveSettings(deps, settings);
  });
}

/** Add back: shows the agent again and lets its login copy again. */
export function restoreAgent(deps: AppDeps, providerId: string): Promise<void> {
  return oneAtATime(async () => {
    requireAgent(deps, providerId);
    const agent = AGENTS[providerId];
    if (agent) await markLogin(deps, agent.login, null);
    saveSettings(deps, withHidden(deps, providerId, false));
  });
}

function requireAgent(deps: AppDeps, providerId: string): void {
  if (!deps.providerRegistry.get(providerId)) throw new ApiError(404, "agent_not_found", `Unknown agent "${providerId}".`);
}

/** Added accounts live in the Accounts plugin, which removes them, the one in use last. */
function accountsClearer(plugins: PluginService): (provider: string) => Promise<void> {
  const plugin = plugins.list().find((entry) => entry.source === "builtin:accounts");
  const handler = plugin ? plugins.getRpcHandler(plugin.id, "accounts.clear") : null;
  if (!plugin || handler?.outcome !== "found") throw new ApiError(503, "accounts_unavailable", "Nothing changed. Accounts isn't running; restart Cloudroom and try again.");
  return async (provider) => {
    const result = await plugins.invokeRpcHandler(plugin.id, "accounts.clear", handler.value, { provider }, { kind: "client" });
    if (!result.ok) throw new Error(result.error.message);
  };
}

async function signOut({ command: [command, ...args], signedIn, withoutCli }: SignOut): Promise<void> {
  const executable = findCliExecutable(command);
  const failed = (detail: string) => new ApiError(502, "agent_sign_out_failed", `The Cloud login and added accounts are removed, but \`${[command, ...args].join(" ")}\` failed on this computer: ${detail}`);
  if (executable) await execPortableFile(executable, args, { timeoutMs: 30_000, maxBuffer: 64 * 1024 }).catch((error: unknown) => { throw failed(message(error)); });
  else await withoutCli?.();
  if (await signedIn()) throw failed("it is still signed in.");
}

/** A hidden agent can't stay the default, so the next visible one takes over. At least one agent stays visible. */
function withHidden(deps: AppDeps, providerId: string, hidden: boolean): AppSettings {
  const settings = getAppSettings(deps.db);
  const hiddenProviderIds = hidden
    ? [...new Set([...settings.hiddenProviderIds, providerId])]
    : settings.hiddenProviderIds.filter((id) => id !== providerId);
  const ids = deps.providerRegistry.list().map((entry) => entry.info.id);
  const visible = ids.filter((id) => !hiddenProviderIds.includes(id));
  if (visible.length === 0) throw new ApiError(409, "last_agent", "Keep at least one agent.");
  const current = settings.defaultProviderId ?? ids[0];
  const defaultProviderId = hidden && current === providerId ? visible[0]! : settings.defaultProviderId;
  return { ...settings, hiddenProviderIds, defaultProviderId };
}

function saveSettings(deps: AppDeps, settings: AppSettings): void {
  const current = getAppSettings(deps.db);
  setAppSettings(deps.db, { ...current, hiddenProviderIds: settings.hiddenProviderIds, defaultProviderId: settings.defaultProviderId });
  deps.hub.notifySystem(["config-changed"]);
}
