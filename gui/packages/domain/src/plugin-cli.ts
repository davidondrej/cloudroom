export const RESERVED_BB_CLI_COMMANDS: readonly string[] = [
  "browser",
  "cloud",
  "environment",
  "file",
  "guide",
  "help",
  "import",
  "machine",
  "manager",
  "marketplace",
  "plugin",
  "project",
  "provider",
  "report",
  "settings",
  "skill",
  "status",
  "terminal",
  "theme",
  "thread",
  "updates",
  "vm",
  "voice",
];

export function pluginCliCall(pluginId: string, name: string): string {
  if (RESERVED_BB_CLI_COMMANDS.includes(name))
    return `room-cli plugin run ${pluginId}`;
  return `room-cli ${name}`;
}
