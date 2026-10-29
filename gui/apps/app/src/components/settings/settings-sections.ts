import type { IconName } from "@cloudroom/shared-ui/icon";
import {
  SETTINGS_ROUTE_PATH,
  getPluginConfigurationRoutePath,
  getSettingsRoutePath,
} from "@/lib/route-paths";
import type { PluginSettingsEntry } from "./plugin-settings-entries";

export const SETTINGS_NAV_SECTIONS = [
  { icon: "UserRound", id: "account", label: "Account" },
  { icon: "Settings", id: "general", label: "General" },
  { icon: "Star", id: "defaults", label: "Defaults" },
  { icon: "Cloud", id: "cloud-environment", label: "Cloud environment" },
  { icon: "Clock", id: "auto-delete", label: "Auto-delete" },
  { icon: "Bot", id: "providers", label: "Providers" },
  { icon: "Download", id: "import", label: "Import chats" },
  { icon: "FolderOpen", id: "export", label: "Export chats" },
  { icon: "Palette", id: "appearance", label: "Appearance" },
  { icon: "SlidersHorizontal", id: "keyboard", label: "Keyboard" },
  { icon: "Browser", id: "browser", label: "Browser" },
  { icon: "File", id: "files", label: "Files" },
  { icon: "FolderGit", id: "projects", label: "Projects" },
  { icon: "Laptop", id: "machines", label: "Machines" },
  { icon: "PackageReceive", id: "updates", label: "Updates" },
  { icon: "ElectricPlugs", id: "plugins", label: "Installed plugins" },
  { icon: "Puzzle", id: "marketplaces", label: "Plugin marketplaces" },
  { icon: "Lock", id: "command-guard", label: "Command Guard" },
  { icon: "Bot", id: "system-prompt", label: "System prompt" },
  { icon: "Beaker", id: "experiments", label: "Experiments" },
  { icon: "MessageSquare", id: "community", label: "Community" },
  { icon: "Archive", id: "archived", label: "Archived threads" },
] as const satisfies readonly {
  icon: IconName;
  id: string;
  label: string;
}[];

export type SettingsNavSection = (typeof SETTINGS_NAV_SECTIONS)[number];

export type SettingsSectionId = SettingsNavSection["id"];

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return SETTINGS_NAV_SECTIONS.some((section) => section.id === value);
}

export function getSettingsSectionRoutePath(
  sectionId: SettingsSectionId,
): string {
  return sectionId === "general"
    ? SETTINGS_ROUTE_PATH
    : getSettingsRoutePath(sectionId);
}

type SettingsGroupMember =
  | { kind: "section"; id: SettingsSectionId; label?: string }
  | { kind: "plugin"; id: string; label: string };

export interface SettingsNavGroup {
  icon: IconName;
  id: string;
  label: string;
  members: readonly SettingsGroupMember[];
}

export interface SettingsNavLink {
  active: boolean;
  key: string;
  label: string;
  to: string;
}

interface SettingsNavLinkState {
  activePluginId: string | null;
  activeSection: SettingsSectionId | null;
  pluginEntries: readonly PluginSettingsEntry[];
  sections: readonly SettingsNavSection[];
}

const section = (id: SettingsSectionId, label?: string): SettingsGroupMember =>
  ({ kind: "section", id, label });
const plugin = (id: string, label: string): SettingsGroupMember =>
  ({ kind: "plugin", id, label });

export const SETTINGS_NAV_GROUPS: readonly SettingsNavGroup[] = [
  {
    icon: "UserRound",
    id: "account",
    label: "Account",
    members: [section("account")],
  },
  {
    icon: "Settings",
    id: "general",
    label: "General",
    members: [
      section("general"),
      section("browser"),
      section("files"),
      plugin("push-notifications", "Notifications"),
      plugin("keep-awake", "Keep Awake"),
    ],
  },
  {
    icon: "Bot",
    id: "agents",
    label: "Agents",
    members: [
      section("providers"),
      section("defaults"),
      section("command-guard"),
      plugin("provider-claude-code", "Claude Code"),
      plugin("provider-codex", "Codex"),
      plugin("provider-acp", "ACP"),
      plugin("provider-usage", "Usage"),
      plugin("provider-retry", "Retry"),
    ],
  },
  {
    icon: "Edit",
    id: "instructions",
    label: "Instructions",
    members: [
      plugin("custom-instructions", "Custom instructions"),
      section("system-prompt"),
      plugin("bb-guide", "Cloudroom guide"),
    ],
  },
  {
    icon: "Cloud",
    id: "cloud",
    label: "Cloud",
    members: [section("cloud-environment"), section("auto-delete")],
  },
  {
    icon: "Laptop",
    id: "machines",
    label: "Machines",
    members: [section("machines"), plugin("connect", "Cloudroom Connect")],
  },
  {
    icon: "FolderGit",
    id: "projects",
    label: "Projects",
    members: [section("projects"), section("import"), section("export"), section("archived")],
  },
  {
    icon: "Palette",
    id: "appearance",
    label: "Appearance",
    members: [section("appearance")],
  },
  {
    icon: "SlidersHorizontal",
    id: "keyboard",
    label: "Keyboard",
    members: [section("keyboard")],
  },
  {
    icon: "ElectricPlugs",
    id: "plugins",
    label: "Plugins",
    members: [
      section("plugins", "Installed"),
      section("marketplaces", "Marketplaces"),
    ],
  },
  {
    icon: "PackageReceive",
    id: "updates",
    label: "Updates",
    members: [
      section("updates"),
      section("community"),
      section("experiments"),
    ],
  },
];

export function findSettingsNavGroup(
  activeSection: SettingsSectionId | null,
  activePluginId: string | null,
): SettingsNavGroup {
  const group = SETTINGS_NAV_GROUPS.find((candidate) =>
    candidate.members.some((member) =>
      activePluginId !== null
        ? member.kind === "plugin" && member.id === activePluginId
        : member.kind === "section" && member.id === activeSection,
    ),
  );
  const fallbackId = activePluginId !== null ? "plugins" : "general";
  return (
    group ?? SETTINGS_NAV_GROUPS.find((candidate) => candidate.id === fallbackId)!
  );
}

export function getSettingsGroupLinks(
  group: SettingsNavGroup,
  state: SettingsNavLinkState,
): SettingsNavLink[] {
  const links = group.members.flatMap((member): SettingsNavLink[] => {
    if (member.kind === "section") {
      const available = state.sections.find((entry) => entry.id === member.id);
      return available
        ? [
            {
              active:
                state.activePluginId === null &&
                state.activeSection === member.id,
              key: member.id,
              label: member.label ?? available.label,
              to: getSettingsSectionRoutePath(member.id),
            },
          ]
        : [];
    }
    return state.pluginEntries.some((entry) => entry.id === member.id)
      ? [
          {
            active: state.activePluginId === member.id,
            key: member.id,
            label: member.label,
            to: getPluginConfigurationRoutePath({ pluginId: member.id }),
          },
        ]
      : [];
  });
  const activePluginId = state.activePluginId;
  if (
    group.id === "plugins" &&
    activePluginId !== null &&
    !links.some((link) => link.active)
  ) {
    const entry = state.pluginEntries.find(({ id }) => id === activePluginId);
    links.push({
      active: true,
      key: activePluginId,
      label: entry?.label ?? activePluginId,
      to: getPluginConfigurationRoutePath({ pluginId: activePluginId }),
    });
  }
  return links;
}
