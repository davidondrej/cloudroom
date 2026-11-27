import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BundledPluginDefinition {
  name: string;
  pluginId: string;
  autoInstall: boolean;
  defaultEnabled: boolean;
  alwaysEnabled?: boolean;
  refuseMachineCli?: boolean;
  refuseMachineCliSubcommands?: readonly string[];
  relayRefusedRpcs?: Readonly<Record<string, "machine" | "all">>;
  relayRefusedSettings?: Readonly<Record<string, "machine" | "all">>;
}

export interface BundledPluginRegistration extends BundledPluginDefinition {
  rootDir: string;
}

interface ResolveBuiltinPluginRootPathArgs {
  moduleDir: string;
  name: string;
}

export const BUILTIN_PLUGINS_DIRECTORY_NAME = "builtin-plugins";

export const ALWAYS_ENABLED_PLUGIN_ERROR = "This built-in plugin is always on.";

const REPO_PLUGINS_DIRECTORY_NAME = "plugins";

/**
 * Built-in plugins that changed id. On start, an install that still has the old
 * id is moved to the new one, with its on/off state and settings.
 */
export const RENAMED_BUILTIN_PLUGINS = [
  // No BB naming in the app (ADR 20261111-160828).
  { from: "bb-guide", to: "cloudroom-guide", settingKeys: { bbCli: "roomCli" } },
];

// Computer use has no Windows driver, so Windows hides it (docs/scopes/windows.md).
export const WINDOWS_HIDDEN_PLUGIN_NAMES: readonly string[] =
  process.platform === "win32" ? ["computer-use"] : [];

const builtinDefinitions: Omit<BundledPluginDefinition, "autoInstall">[] = [
  {
    name: "cloudroom-guide",
    pluginId: "cloudroom-guide",
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    name: "accounts",
    pluginId: "accounts",
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    name: "ask-user-question",
    pluginId: "ask-user-question",
    defaultEnabled: false,
  },
  {
    name: "automations",
    pluginId: "automations",
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    name: "connect",
    pluginId: "connect",
    defaultEnabled: true,
    alwaysEnabled: true,
    refuseMachineCliSubcommands: ["sign-out-phones"],
    relayRefusedRpcs: {
      relayCredential: "all",
      revokeMachine: "all",
      remoteAccess: "all",
      macs: "machine",
      listSessions: "machine",
      revokeSession: "machine",
      signOutPhones: "machine",
      runSetupJob: "machine",
      setupJobStatus: "machine",
    } as const,
    relayRefusedSettings: {
      enabled: "all",
    } as const,
  },
  {
    name: "environment-project-checkout",
    pluginId: "environment-project-checkout",
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    name: "environment-git-worktree",
    pluginId: "environment-git-worktree",
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    name: "environment-personal-workspace",
    pluginId: "environment-personal-workspace",
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    name: "custom-instructions",
    pluginId: "custom-instructions",
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    name: "plugin-api-tester",
    pluginId: "plugin-api-tester",
    defaultEnabled: false,
  },
  // RepoSync (docs/scopes/repo-sync.md): off until the user turns it on.
  {
    name: "repo-sync",
    pluginId: "repo-sync",
    defaultEnabled: false,
  },
  {
    name: "inline-vis",
    pluginId: "inline-vis",
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    name: "monaco-editor",
    pluginId: "monaco-editor",
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    name: "pdf-preview",
    pluginId: "pdf-preview",
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    name: "provider-codex",
    pluginId: "provider-codex",
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    name: "provider-claude-code",
    pluginId: "provider-claude-code",
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    name: "provider-pi",
    pluginId: "provider-pi",
    defaultEnabled: true,
  },
  // Off until the user turns it on (David, 2026-11-18, docs/scopes/cloudroom-agent.md).
  {
    name: "provider-cloudroom-agent",
    pluginId: "provider-cloudroom-agent",
    defaultEnabled: false,
  },
  {
    name: "provider-usage",
    pluginId: "provider-usage",
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    name: "organization",
    pluginId: "organization",
    defaultEnabled: false,
  },
  // Shared projects (docs/scopes/shared-projects.md): on for everyone, so "Share project" is in every project's menu.
  {
    name: "shared-projects",
    pluginId: "shared-projects",
    defaultEnabled: true,
  },
  {
    name: "time-in-cloudroom",
    pluginId: "time-in-cloudroom",
    defaultEnabled: true,
  },
  {
    name: "wallpaper",
    pluginId: "wallpaper",
    defaultEnabled: true,
  },
  {
    name: "provider-acp",
    pluginId: "provider-acp",
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    name: "computer-use",
    pluginId: "computer-use",
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    name: "gpu",
    pluginId: "gpu",
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    name: "keep-awake",
    pluginId: "keep-awake",
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    name: "machine-ssh",
    pluginId: "machine-ssh",
    defaultEnabled: true,
  },
  {
    name: "plugin-api-docs",
    pluginId: "plugin-api-docs",
    defaultEnabled: false,
  },
  {
    name: "provider-retry",
    pluginId: "provider-retry",
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    name: "internet-watch",
    pluginId: "internet-watch",
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    name: "push-notifications",
    pluginId: "push-notifications",
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    name: "secrets",
    pluginId: "secrets",
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    name: "drafts",
    pluginId: "drafts",
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    name: "snippets",
    pluginId: "snippets",
    defaultEnabled: true,
    relayRefusedRpcs: { view: "machine", run: "machine" },
    refuseMachineCli: true,
  },
  {
    name: "scheduled-send",
    pluginId: "scheduled-send",
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    name: "side-chat",
    pluginId: "side-chat",
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    name: "workflows",
    pluginId: "workflows",
    defaultEnabled: false,
  },
  // Off while the team uses it internally (docs/scopes/director.md).
  {
    name: "director",
    pluginId: "director",
    defaultEnabled: false,
    // Another computer can't steer this one's Director; the phone can (a session, not a machine).
    relayRefusedRpcs: { save: "machine", open: "machine", pingNow: "machine", fresh: "machine", forget: "machine", skip: "machine" },
    refuseMachineCli: true,
  },
];

export const BUILTIN_PLUGINS = builtinDefinitions
  .filter((plugin) => !WINDOWS_HIDDEN_PLUGIN_NAMES.includes(plugin.name))
  .map((plugin): BundledPluginDefinition => ({
    ...plugin,
    autoInstall: true,
  }));

export const OFFICIAL_PLUGINS = [
  {
    name: "github",
    pluginId: "github",
    defaultEnabled: true,
  },
  {
    name: "tasks",
    pluginId: "tasks",
    defaultEnabled: true,
  },
  {
    name: "theme-preview",
    pluginId: "theme-preview",
    defaultEnabled: true,
  },
].map((plugin): BundledPluginDefinition => ({
  ...plugin,
  autoInstall: false,
}));

export const BUNDLED_PLUGINS: readonly BundledPluginDefinition[] = [
  ...BUILTIN_PLUGINS,
  ...OFFICIAL_PLUGINS,
];

/**
 * Bundled plugins the app used to ship. On start, an installed copy is marked
 * removed, so nothing loads or lists it. Its settings and data stay on disk.
 * Add a name here whenever a bundled plugin is deleted. Windows also removes
 * the plugins it hides.
 */
export const RETIRED_BUNDLED_PLUGIN_NAMES: ReadonlySet<string> = new Set([
  ...WINDOWS_HIDDEN_PLUGIN_NAMES,
  "account-pool",
  "browser-automation",
  "concurrency-limit",
  "docs",
  "environment-modal-sandbox",
  "memory",
]);

const builtinPluginsModuleDir = path.dirname(fileURLToPath(import.meta.url));

export function builtinPluginSource(name: string): string {
  return `builtin:${name}`;
}

export function resolveBuiltinPluginRootPathForModuleDir(
  args: ResolveBuiltinPluginRootPathArgs,
): string {
  const preparedCandidate = path.resolve(
    args.moduleDir,
    "../../../packages/bundled-plugins/dist",
    args.name,
  );
  if (existsSync(preparedCandidate)) return preparedCandidate;

  const packagedCandidate = path.resolve(
    args.moduleDir,
    BUILTIN_PLUGINS_DIRECTORY_NAME,
    args.name,
  );
  if (existsSync(packagedCandidate)) return packagedCandidate;

  const builtCheckoutCandidate = path.resolve(
    args.moduleDir,
    "../../..",
    REPO_PLUGINS_DIRECTORY_NAME,
    args.name,
  );
  if (existsSync(builtCheckoutCandidate)) return builtCheckoutCandidate;

  return path.resolve(
    args.moduleDir,
    "../../../../..",
    REPO_PLUGINS_DIRECTORY_NAME,
    args.name,
  );
}

export function resolveBuiltinPluginRootPath(name: string): string {
  return resolveBuiltinPluginRootPathForModuleDir({
    moduleDir: builtinPluginsModuleDir,
    name,
  });
}

export function listBundledPluginRegistrations(): BundledPluginRegistration[] {
  return BUNDLED_PLUGINS.map((plugin) => ({
    ...plugin,
    rootDir: resolveBuiltinPluginRootPath(plugin.name),
  }));
}
