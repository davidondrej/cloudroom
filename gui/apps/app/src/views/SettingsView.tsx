import { AutoDeleteSettingsSection } from "@/components/settings/AutoDeleteSettingsSection";
import { CloudEnvironmentSettingsSection } from "@/components/settings/CloudEnvironmentSettingsSection";
import { DefaultsSettingsSection } from "@/components/settings/DefaultsSettingsSection";
import { MachineEnvironmentSettings } from "@/components/settings/MachineEnvironmentSettings";
import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  Link,
  Navigate,
  useNavigate,
  useLocation,
  matchPath,
} from "react-router-dom";
import "@cloudroom/shared-ui/icon-extended";
import {
  builtInThemes,
  defaultAppSettings,
  defaultAppTheme,
  defaultExperiments,
  experimentKeys,
  managedBranchPrefixSchema,
  type AppTheme,
  type WorktreeRetention,
  type ExperimentKey,
  type Experiments,
  type FaviconColorPreference,
  type PluginThemeMeta,
} from "@cloudroom/domain";
import type {
  WorkspaceOpenTarget,
  WorkspaceOpenTargetId,
} from "@cloudroom/host-daemon-contract";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Input } from "@cloudroom/shared-ui/input";
import { Switch } from "@cloudroom/shared-ui/switch";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@cloudroom/shared-ui/coarse-pointer-sizing";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import { PageShell } from "@/components/ui/page-shell.js";
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_CARD_ROW_CLASS,
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section.js";
import { WorkspaceOpenTargetIcon } from "@/components/workspace-open-target/WorkspaceOpenTargetIcon";
import {
  setPreferredTheme,
  useThemePreference,
  type ThemePreference,
} from "@/hooks/useTheme";
import { useHostDaemon, useLocalHostDaemonAccess } from "@/hooks/useHostDaemon";
import { useAppThemePreview } from "@/hooks/useAppThemePreview";
import { useCorners, type Corners } from "@/hooks/useCorners";
import {
  ProviderTurnDisplaySection,
  ProvidersSettingsSection,
} from "@/components/settings/ProvidersSettingsSection";
import { CodeRendererSettings } from "@/components/settings/CodeRendererSettings";
import { CollapseSubagentsSetting } from "@/components/settings/CollapseSubagentsSetting";
import { SidebarThreadListSetting } from "@/components/settings/SidebarThreadListSetting";
import { SidebarFooterSettings } from "@/components/settings/SidebarFooterSettings";
import { SidebarNavigationSetting } from "@/components/settings/SidebarNavigationSetting";
import { SplitDimmingSetting } from "@/components/settings/SplitDimmingSetting";
import { StarterPromptsSetting } from "@/components/ActivationChecklist";
import { HarnessIconsSetting } from "@/components/settings/HarnessIconsSetting";
import { useSettingsNavState } from "@/components/settings/settings-nav";
import { useRevealSettingsTarget } from "@/components/settings/settings-search";
import {
  findSettingsNavGroup,
  getSettingsGroupLinks,
  type SettingsNavLink,
} from "@/components/settings/settings-sections";
import { PluginsOverview } from "@/components/plugin/PluginsOverview";
import { PluginDetailPaneView } from "@/views/ToolsView";
import { SETTINGS_PLUGIN_ROUTE_PATH } from "@/lib/route-paths";
import { PluginSettingsPage } from "@/components/plugin/PluginSettings";
import { PluginSettingsSections } from "@/components/plugin/PluginSettingsSections";
import { FileOpenersSettingsSection } from "@/components/settings/FileOpenersSettingsSection";
import { VoiceInputSettingsSection } from "@/components/settings/VoiceInputSettingsSection";
import {
  ProjectNudgeSettingsSection,
  ThreadNamingSettingsSection,
  ThreadPurposeSettingsSection,
} from "@/components/settings/ThreadNamingSettingsSection";
import { CommunitySettingsSection } from "@/components/settings/CommunitySettingsSection";
import { UpdatesSettingsSection } from "@/components/settings/UpdatesSettingsSection";
import { KeyboardSettingsSection } from "@/components/settings/KeyboardSettingsSection";
import { BrowserSettingsSection } from "@/components/settings/BrowserSettingsSection";
import { AdvancedMachineSettings, MachinesSettingsSection } from "@/components/settings/MachinesSettingsSection";
import { CloudroomAccountSettings } from "@/components/settings/CloudroomAccountSettings";
import { InviteSettingsCard } from "@/components/InviteOffer";
import { ProjectsSettingsSection } from "@/components/settings/ProjectsSettingsSection";
import { ArchivedThreadsSettingsSection } from "@/components/settings/ArchivedThreadsSettingsSection";
import { ImportChatsSettingsSection } from "@/components/settings/ImportChats";
import { ExportChatsSettingsSection } from "@/components/settings/ExportChats";
import { CliSkillsSettingsSection } from "@/components/settings/CliSkillsSettingsSection";
import { MarketplacesSettingsSection } from "@/components/settings/MarketplacesSettingsSection";
import {
  useUpdateGeneralSettings,
  useUpdateAppearance,
  useUpdateExperiments,
} from "@/hooks/mutations/settings-mutations";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useWorkspaceOpenTargets } from "@/hooks/useWorkspaceOpenTargets";
import { isDesktopBrowserAvailable } from "@/lib/bb-desktop";
import {
  FAVICON_COLOR_VALUES,
  getFaviconGlyphHref,
} from "@/lib/favicon-color-preference";
import { useOpenLinksInAppBrowserPreference } from "@/lib/in-app-browser-link-preference";
import { useRewriteLocalhostLinksPreference } from "@/lib/localhost-link-rewrite-preference";
import { useRichTextEditingPreference } from "@/lib/rich-text-editing-preference";
import {
  SETTINGS_ROUTE_PATH,
  getRootComposeRoutePath,
} from "@/lib/route-paths";
import { useNavigateToThreadAfterCreatePreference } from "@/lib/root-compose-create-preference";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  resolvePreferredWorkspaceOpenTarget,
  supportsWorkspaceOpenTargetCapability,
  useFileOpenTargetPreference,
  useWorkspaceOpenTargetPreference,
  type StoredWorkspaceOpenTargetPreference,
  type WorkspaceOpenTargetCapability,
} from "@/lib/workspace-open-target-preference";
import { getWorkspaceOpenTargetFallbackLabel } from "@/components/workspace-open-target/workspace-open-target-display";
import type { LocalHostDaemonAccessState } from "@/lib/local-host-daemon-access";

interface ThemePreferenceOption {
  label: string;
  value: ThemePreference;
}

interface FaviconColorOption {
  label: string;
  value: FaviconColorPreference;
}

interface LocalOpenTargetPreferenceDefinition {
  capability: WorkspaceOpenTargetCapability;
  emptyDescription: string;
  label: string;
}

interface LocalOpenTargetPreferenceControlProps {
  definition: LocalOpenTargetPreferenceDefinition;
  onTargetChange: (targetId: WorkspaceOpenTargetId) => void;
  preferredTargetId: StoredWorkspaceOpenTargetPreference;
  targets: WorkspaceOpenTarget[];
}

export interface LocalOpenTargetSettingsSectionProps {
  accessState: LocalHostDaemonAccessState;
  directoryTargetId: StoredWorkspaceOpenTargetPreference;
  fileTargetId: StoredWorkspaceOpenTargetPreference;
  hasDaemon: boolean;
  onDirectoryTargetChange: (targetId: WorkspaceOpenTargetId) => void;
  onFileTargetChange: (targetId: WorkspaceOpenTargetId) => void;
  onRequestAccess: () => Promise<boolean>;
  targets: WorkspaceOpenTarget[];
}

interface FaviconColorSettingsControlProps {
  disabled: boolean;
  faviconColor: FaviconColorPreference;
  onFaviconColorChange: (faviconColor: FaviconColorPreference) => void;
}

interface AppearanceSettingsSectionProps {
  agentQuestionsEnabled: boolean;
  appearance: AppTheme;
  appearanceDisabled: boolean;
  customThemes: readonly string[];
  pluginThemes: readonly PluginThemeMeta[];
  faviconColor: FaviconColorPreference;
  generalSettingsDisabled: boolean;
  onAgentQuestionsEnabledChange: (enabled: boolean) => void;
  onAppearanceThemeChange: (themeId: string) => void;
  onAppearanceThemePrefetch: (themeIds: readonly string[]) => void;
  onAppearanceThemePreview: (themeId: string | null) => void;
  onCreatePalette: () => void;
  onFaviconColorChange: (faviconColor: FaviconColorPreference) => void;
  onThemePreferenceChange: (themePreference: ThemePreference) => void;
  themePreference: ThemePreference;
}

interface GeneralSettingsSectionProps {
  desktopBrowserAvailable: boolean;
  generalSettingsDisabled: boolean;
  managedBranchPrefix: string;
  navigateToThreadAfterCreate: boolean;
  onManagedBranchPrefixChange: (prefix: string) => Promise<void> | void;
  onNavigateToThreadAfterCreateChange: (enabled: boolean) => void;
  onOpenLinksInAppBrowserChange: (enabled: boolean) => void;
  onRewriteLocalhostLinksChange: (enabled: boolean) => void;
  onRichTextEditingChange: (enabled: boolean) => void;
  onSteerActiveThreadOnEnterChange: (enabled: boolean) => void;
  onWorktreeRetentionChange: (retention: WorktreeRetention) => void;
  openLinksInAppBrowser: boolean;
  rewriteLocalhostLinks: boolean;
  richTextEditing: boolean;
  steerActiveThreadOnEnter: boolean;
  worktreeRetention: WorktreeRetention;
}

interface PrivacySettingsSectionProps {
  onStreamerModeChange: (enabled: boolean) => void;
  streamerMode: boolean;
  telemetryEnabled: boolean;
  onTelemetryEnabledChange: (enabled: boolean) => void;
  bugReportsEnabled: boolean;
  onBugReportsEnabledChange: (enabled: boolean) => void;
  disabled: boolean;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}

function appPaletteLabel(
  appearance: AppTheme,
  pluginThemes: readonly PluginThemeMeta[],
): string {
  const meta = builtInThemes.find((entry) => entry.id === appearance.themeId);
  return (
    meta?.name ??
    pluginThemes.find((entry) => entry.id === appearance.themeId)?.name ??
    appearance.themeId
  );
}

interface ExperimentsSettingsSectionProps {
  disabled: boolean;
  experiments: Experiments;
  onExperimentChange: (key: ExperimentKey, enabled: boolean) => void;
}

const THEME_PREFERENCE_OPTIONS: ReadonlyArray<ThemePreferenceOption> = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

const THEME_PREFERENCE_LABELS: Record<ThemePreference, string> = {
  dark: "Dark",
  light: "Light",
  system: "System",
};

const FAVICON_COLOR_OPTIONS: ReadonlyArray<FaviconColorOption> = [
  { label: "Default", value: "default" },
  { label: "Red", value: "red" },
  { label: "Orange", value: "orange" },
  { label: "Yellow", value: "yellow" },
  { label: "Green", value: "green" },
  { label: "Teal", value: "teal" },
  { label: "Blue", value: "blue" },
  { label: "Purple", value: "purple" },
  { label: "Pink", value: "pink" },
];

const FAVICON_COLOR_LABELS: Record<FaviconColorPreference, string> = {
  blue: "Blue",
  default: "Default",
  green: "Green",
  orange: "Orange",
  pink: "Pink",
  purple: "Purple",
  red: "Red",
  teal: "Teal",
  yellow: "Yellow",
};

const SETTINGS_DROPDOWN_TRIGGER_CLASS =
  "h-7 w-full justify-between border-border/60 bg-card px-2 text-xs sm:w-36";
const SETTINGS_DROPDOWN_CONTENT_CLASS =
  "min-w-[var(--radix-dropdown-menu-trigger-width)]";

const CREATE_CUSTOM_PALETTE_PROMPT =
  "Create a custom Cloudroom palette. First run `room-cli theme dir` to find the custom theme directory. Ask me for the palette name and visual direction, then create `<theme-dir>/<name>/theme.css` with light and dark theme variables compatible with Cloudroom's theme tokens.";
const PALETTE_SETTING_DESCRIPTION =
  "Palettes change Cloudroom's colors, including syntax colors in diffs and file previews. Choose a built-in palette or create one from a prompt.";

interface PaletteMenuItemProps {
  active: boolean;
  children: ReactNode;
  onPreview: (themeId: string | null) => void;
  onSelect: (themeId: string) => void;
  themeId: string;
}

function PaletteMenuItem({
  active,
  children,
  onPreview,
  onSelect,
  themeId,
}: PaletteMenuItemProps) {
  return (
    <DropdownMenuItem
      onFocus={() => onPreview(themeId)}
      onBlur={() => onPreview(null)}
      onSelect={() => onSelect(themeId)}
    >
      {children}
      <Icon
        name="Check"
        className={cn(
          "ml-auto",
          !active && "opacity-0",
          COARSE_POINTER_ICON_SIZE_CLASS,
        )}
      />
    </DropdownMenuItem>
  );
}

function FaviconColorPreview({ value }: { value: FaviconColorPreference }) {
  return (
    <span
      aria-hidden
      className={cn("size-4 shrink-0", value === "default" && "bg-foreground")}
      style={{
        mask: `url("${getFaviconGlyphHref()}") center / contain no-repeat`,
        ...(value === "default"
          ? undefined
          : { backgroundColor: FAVICON_COLOR_VALUES[value] }),
      }}
    />
  );
}

function FaviconColorSettingsControl({
  disabled,
  faviconColor,
  onFaviconColorChange,
}: FaviconColorSettingsControlProps) {
  return (
    <SettingsWithControl
      label="Favicon color"
      description="Tint browser tabs to tell instances apart."
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
            aria-label="Favicon color"
            disabled={disabled}
          >
            <span className="flex min-w-0 items-center gap-2">
              <FaviconColorPreview value={faviconColor} />
              <span className="min-w-0 truncate">
                {FAVICON_COLOR_LABELS[faviconColor]}
              </span>
            </span>
            <Icon
              name="ChevronDown"
              className="size-3.5 text-muted-foreground"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className={SETTINGS_DROPDOWN_CONTENT_CLASS}
        >
          {FAVICON_COLOR_OPTIONS.map((option) => (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => onFaviconColorChange(option.value)}
            >
              <FaviconColorPreview value={option.value} />
              {option.label}
              <Icon
                name="Check"
                className={cn(
                  "ml-auto",
                  faviconColor !== option.value && "opacity-0",
                  COARSE_POINTER_ICON_SIZE_CLASS,
                )}
              />
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsWithControl>
  );
}

const CORNERS_OPTIONS: ReadonlyArray<{ label: string; value: Corners }> = [
  { label: "Rounded", value: "rounded" },
  { label: "Sharp", value: "sharp" },
];

function CornersSetting() {
  const [corners, setCorners] = useCorners();
  return (
    <SettingsWithControl label="Corners">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
            aria-label="Corners"
          >
            {corners === "sharp" ? "Sharp" : "Rounded"}
            <Icon
              name="ChevronDown"
              className="size-3.5 text-muted-foreground"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className={SETTINGS_DROPDOWN_CONTENT_CLASS}
        >
          {CORNERS_OPTIONS.map((option) => (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => setCorners(option.value)}
            >
              {option.label}
              <Icon
                name="Check"
                className={cn(
                  "ml-auto",
                  corners !== option.value && "opacity-0",
                  COARSE_POINTER_ICON_SIZE_CLASS,
                )}
              />
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsWithControl>
  );
}

const DIRECTORY_TARGET_PREFERENCE: LocalOpenTargetPreferenceDefinition = {
  capability: "openDirectory",
  emptyDescription: "No local app can open directories.",
  label: "Directory default",
};

const FILE_TARGET_PREFERENCE: LocalOpenTargetPreferenceDefinition = {
  capability: "openFile",
  emptyDescription: "No local app can open files.",
  label: "File default",
};

function LocalOpenTargetPreferenceControl({
  definition,
  onTargetChange,
  preferredTargetId,
  targets,
}: LocalOpenTargetPreferenceControlProps) {
  const compatibleTargets = useMemo(
    () =>
      targets.filter((target) =>
        supportsWorkspaceOpenTargetCapability({
          capability: definition.capability,
          target,
        }),
      ),
    [definition.capability, targets],
  );
  const resolvedTarget = useMemo(
    () =>
      resolvePreferredWorkspaceOpenTarget({
        capability: definition.capability,
        preferredTargetId,
        targets,
      }),
    [definition.capability, preferredTargetId, targets],
  );
  const unavailableMessage =
    compatibleTargets.length === 0 ? definition.emptyDescription : null;
  const selectedTargetId = resolvedTarget?.id ?? preferredTargetId;
  const buttonLabel =
    resolvedTarget?.label ??
    (preferredTargetId
      ? getWorkspaceOpenTargetFallbackLabel(preferredTargetId)
      : "Unavailable");

  return (
    <SettingsWithControl label={definition.label}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
            aria-label={definition.label}
          >
            <span className="flex min-w-0 items-center gap-2">
              {selectedTargetId ? (
                <WorkspaceOpenTargetIcon
                  {...(resolvedTarget
                    ? { target: resolvedTarget }
                    : { targetId: selectedTargetId })}
                  className="size-5"
                />
              ) : null}
              <span className="min-w-0 truncate">{buttonLabel}</span>
            </span>
            <Icon
              name="ChevronDown"
              className="size-3.5 text-muted-foreground"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className={SETTINGS_DROPDOWN_CONTENT_CLASS}
        >
          {unavailableMessage ? (
            <div
              role="note"
              className="px-2 py-[0.3125rem] text-xs leading-snug text-foreground"
            >
              {unavailableMessage}
            </div>
          ) : (
            compatibleTargets.map((target) => (
              <DropdownMenuItem
                key={target.id}
                onSelect={() => onTargetChange(target.id)}
              >
                <WorkspaceOpenTargetIcon target={target} className="size-5" />
                <span className="min-w-0 truncate">{target.label}</span>
                <Icon
                  name="Check"
                  className={cn(
                    "ml-auto",
                    resolvedTarget?.id !== target.id && "opacity-0",
                    COARSE_POINTER_ICON_SIZE_CLASS,
                  )}
                />
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsWithControl>
  );
}

export function LocalOpenTargetSettingsSection({
  accessState,
  directoryTargetId,
  fileTargetId,
  hasDaemon,
  onDirectoryTargetChange,
  onFileTargetChange,
  onRequestAccess,
  targets,
}: LocalOpenTargetSettingsSectionProps) {
  const [accessRequestPending, setAccessRequestPending] = useState(false);

  if (accessState === "unavailable") {
    return null;
  }

  const handleRequestAccess = async () => {
    setAccessRequestPending(true);
    try {
      await onRequestAccess();
    } finally {
      setAccessRequestPending(false);
    }
  };

  if (!hasDaemon) {
    const accessDenied = accessState === "denied";
    const accessAvailable = accessState === "available";
    const descriptionText = accessDenied
      ? "Your browser blocked access to Cloudroom on this device. Allow local network access for this site in browser settings, then reload Cloudroom."
      : accessAvailable
        ? "Cloudroom couldn’t connect to its local editor helper. Make sure the Cloudroom desktop app or CLI is running on this device, then retry. If it is already running, a remote browser origin may need to be configured."
        : "Connect this browser to Cloudroom on this device so it can discover installed editors. Cloudroom only contacts the local helper after you choose Enable; your browser may ask for local network access.";
    const buttonLabel = accessRequestPending
      ? accessAvailable
        ? "Retrying…"
        : "Enabling…"
      : accessDenied
        ? "Blocked"
        : accessAvailable
          ? "Retry"
          : "Enable";

    return (
      <SettingsSection title="File Preferences">
        <SettingsWithControl
          label="Local editor integration"
          description={descriptionText}
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={accessRequestPending || accessDenied}
            onClick={handleRequestAccess}
          >
            {buttonLabel}
          </Button>
        </SettingsWithControl>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="File Preferences">
      <div className="space-y-5">
        <LocalOpenTargetPreferenceControl
          definition={DIRECTORY_TARGET_PREFERENCE}
          onTargetChange={onDirectoryTargetChange}
          preferredTargetId={directoryTargetId}
          targets={targets}
        />
        <LocalOpenTargetPreferenceControl
          definition={FILE_TARGET_PREFERENCE}
          onTargetChange={onFileTargetChange}
          preferredTargetId={fileTargetId}
          targets={targets}
        />
      </div>
    </SettingsSection>
  );
}

const IN_APP_BROWSER_LINK_SETTING_LABEL = "Open links in the in-app browser";
const REWRITE_LOCALHOST_LINKS_SETTING_LABEL = "Rewrite localhost links";
const NAVIGATE_TO_THREAD_AFTER_CREATE_SETTING_LABEL =
  "Navigate to threads on creation";
const RICH_TEXT_EDITING_SETTING_LABEL = "Markdown formatting in prompt box";
const DIAGNOSTIC_EVENTS_SETTING_LABEL = "Show diagnostic events";
const FOLLOW_UP_BEHAVIOR_SETTING_LABEL = "Default thread followup behavior";
const FOLLOW_UP_BEHAVIOR_OPTIONS = [
  {
    steerOnEnter: false,
    label: "Queue",
    description:
      "Enter adds a follow-up. It runs when the agent stops. Command+Enter (Ctrl+Enter on Windows and Linux) steers the run.",
  },
  {
    steerOnEnter: true,
    label: "Steer",
    description:
      "Enter steers the run now. Command+Enter (Ctrl+Enter on Windows and Linux) adds a follow-up for later.",
  },
] as const;
const STREAMER_MODE_SETTING_LABEL = "Streamer mode";
const MANAGED_BRANCH_PREFIX_SETTING_LABEL = "New branch prefix";
const MANAGED_BRANCH_PREFIX_EXAMPLE_SLUG = "fix-login-flow-thr_ab12cd34ef";
const WORKTREE_RETENTION_SETTING_LABEL = "Delete archived worktrees after";
const WORKTREE_RETENTION_LABELS: Record<WorktreeRetention, string> = {
  "5m": "5 minutes",
  "1h": "1 hour",
  "1d": "1 day",
  "7d": "7 days",
  "21d": "21 days",
  "30d": "30 days",
  never: "Never",
};

interface ManagedBranchPrefixSettingProps {
  disabled: boolean;
  onChange: (prefix: string) => Promise<void> | void;
  value: string;
}

function ManagedBranchPrefixSetting({
  disabled,
  onChange,
  value,
}: ManagedBranchPrefixSettingProps) {
  const [draft, setDraft] = useState(value);
  const [committedValue, setCommittedValue] = useState(value);
  if (value !== committedValue) {
    setCommittedValue(value);
    setDraft(value);
  }

  const valid = managedBranchPrefixSchema.safeParse(draft).success;
  const commit = () => {
    if (!valid) {
      setDraft(value);
      return;
    }
    if (draft !== value) {
      void Promise.resolve(onChange(draft)).catch(() => setDraft(value));
    }
  };

  return (
    <SettingsWithControl
      label={MANAGED_BRANCH_PREFIX_SETTING_LABEL}
      description={
        valid ? (
          `Cloudroom puts this in front of every branch it creates for a worktree, such as ${draft}${MANAGED_BRANCH_PREFIX_EXAMPLE_SLUG}. Leave it empty for no prefix.`
        ) : (
          <span className="text-destructive" role="alert">
            This prefix cannot start a valid git branch name.
          </span>
        )
      }
      controlPlacement="below"
    >
      <Input
        value={draft}
        aria-label={MANAGED_BRANCH_PREFIX_SETTING_LABEL}
        aria-invalid={!valid}
        disabled={disabled}
        placeholder="No prefix"
        className={cn(
          "h-8 font-mono text-xs",
          !valid && "border-destructive focus-visible:ring-destructive",
        )}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setDraft(value);
          }
        }}
      />
    </SettingsWithControl>
  );
}

export function AppearanceSettingsSection({
  agentQuestionsEnabled,
  appearance,
  appearanceDisabled,
  customThemes,
  pluginThemes,
  faviconColor,
  generalSettingsDisabled,
  onAgentQuestionsEnabledChange,
  onAppearanceThemeChange,
  onAppearanceThemePrefetch,
  onAppearanceThemePreview,
  onFaviconColorChange,
  onCreatePalette,
  onThemePreferenceChange,
  themePreference,
}: AppearanceSettingsSectionProps) {
  const paletteSelectedRef = useRef(false);
  const previewPalette = (themeId: string | null) => {
    if (themeId === null && paletteSelectedRef.current) return;
    onAppearanceThemePreview(themeId);
  };
  const selectPalette = (themeId: string) => {
    paletteSelectedRef.current = true;
    onAppearanceThemeChange(themeId);
  };
  return (
    <SettingsSection title="Appearance">
      <div className="space-y-5">
        <SidebarThreadListSetting />
        <SidebarNavigationSetting />
        <CollapseSubagentsSetting />
        <HarnessIconsSetting />
        <CodeRendererSettings />
        <SettingsWithControl label="Theme">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
                aria-label="Theme"
              >
                {THEME_PREFERENCE_LABELS[themePreference]}
                <Icon
                  name="ChevronDown"
                  className="size-3.5 text-muted-foreground"
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className={SETTINGS_DROPDOWN_CONTENT_CLASS}
            >
              {THEME_PREFERENCE_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option.value}
                  onSelect={() => onThemePreferenceChange(option.value)}
                >
                  {option.label}
                  <Icon
                    name="Check"
                    className={cn(
                      "ml-auto",
                      themePreference !== option.value && "opacity-0",
                      COARSE_POINTER_ICON_SIZE_CLASS,
                    )}
                  />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </SettingsWithControl>
        <CornersSetting />

        <SettingsWithControl
          label="Palette"
          description={PALETTE_SETTING_DESCRIPTION}
        >
          <DropdownMenu
            onOpenChange={(open) => {
              if (open) {
                paletteSelectedRef.current = false;
                onAppearanceThemePrefetch([
                  ...builtInThemes.map((entry) => entry.id),
                  ...customThemes,
                  ...pluginThemes.map((theme) => theme.id),
                ]);
                return;
              }
              previewPalette(null);
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
                aria-label="Palette"
                disabled={appearanceDisabled}
              >
                <span className="min-w-0 truncate">
                  {appPaletteLabel(appearance, pluginThemes)}
                </span>
                <Icon
                  name="ChevronDown"
                  className="size-3.5 text-muted-foreground"
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className={SETTINGS_DROPDOWN_CONTENT_CLASS}
            >
              {builtInThemes.map((entry) => (
                <PaletteMenuItem
                  key={entry.id}
                  themeId={entry.id}
                  active={appearance.themeId === entry.id}
                  onPreview={previewPalette}
                  onSelect={selectPalette}
                >
                  {entry.name}
                </PaletteMenuItem>
              ))}
              {customThemes.map((name) => (
                <PaletteMenuItem
                  key={`custom:${name}`}
                  themeId={name}
                  active={appearance.themeId === name}
                  onPreview={previewPalette}
                  onSelect={selectPalette}
                >
                  {name}
                </PaletteMenuItem>
              ))}
              {pluginThemes.map((theme) => (
                <PaletteMenuItem
                  key={theme.id}
                  themeId={theme.id}
                  active={appearance.themeId === theme.id}
                  onPreview={previewPalette}
                  onSelect={selectPalette}
                >
                  {theme.name}
                  <span className="text-muted-foreground">
                    ({theme.pluginId})
                  </span>
                </PaletteMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onCreatePalette}>
                <Icon name="Plus" className={COARSE_POINTER_ICON_SIZE_CLASS} />
                Create
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SettingsWithControl>

        <FaviconColorSettingsControl
          disabled={appearanceDisabled}
          faviconColor={faviconColor}
          onFaviconColorChange={onFaviconColorChange}
        />
        <SplitDimmingSetting />
        <SidebarFooterSettings />
        <SettingsWithControl
          label="Question cards"
          description="Let agents ask you multiple-choice questions. Applies to new sessions."
        >
          <Switch
            checked={agentQuestionsEnabled}
            disabled={generalSettingsDisabled}
            onCheckedChange={onAgentQuestionsEnabledChange}
            aria-label="Question cards"
          />
        </SettingsWithControl>
        <StarterPromptsSetting />
      </div>
    </SettingsSection>
  );
}

export function GeneralSettingsSection({
  desktopBrowserAvailable,
  generalSettingsDisabled,
  managedBranchPrefix,
  navigateToThreadAfterCreate,
  onManagedBranchPrefixChange,
  onNavigateToThreadAfterCreateChange,
  onOpenLinksInAppBrowserChange,
  onRewriteLocalhostLinksChange,
  onRichTextEditingChange,
  onSteerActiveThreadOnEnterChange,
  onWorktreeRetentionChange,
  openLinksInAppBrowser,
  rewriteLocalhostLinks,
  richTextEditing,
  steerActiveThreadOnEnter,
  worktreeRetention,
}: GeneralSettingsSectionProps) {
  return (
    <>
      <PluginSettingsSections pluginId="time-in-cloudroom" />
      <SettingsSection title="Threads & editing">
        <div className="space-y-5">
          <SettingsWithControl
            label={NAVIGATE_TO_THREAD_AFTER_CREATE_SETTING_LABEL}
          >
            <Switch
              checked={navigateToThreadAfterCreate}
              onCheckedChange={onNavigateToThreadAfterCreateChange}
              aria-label={NAVIGATE_TO_THREAD_AFTER_CREATE_SETTING_LABEL}
            />
          </SettingsWithControl>

          <SettingsWithControl label={RICH_TEXT_EDITING_SETTING_LABEL}>
            <Switch
              checked={richTextEditing}
              onCheckedChange={onRichTextEditingChange}
              aria-label={RICH_TEXT_EDITING_SETTING_LABEL}
            />
          </SettingsWithControl>

          <SettingsWithControl
            label={FOLLOW_UP_BEHAVIOR_SETTING_LABEL}
            description="What Enter does in the prompt box while the thread runs."
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
                  disabled={generalSettingsDisabled}
                  aria-label={FOLLOW_UP_BEHAVIOR_SETTING_LABEL}
                >
                  {steerActiveThreadOnEnter ? "Steer" : "Queue"}
                  <Icon
                    name="ChevronDown"
                    className="size-3.5 text-muted-foreground"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className={cn(SETTINGS_DROPDOWN_CONTENT_CLASS, "max-w-72")}
              >
                {FOLLOW_UP_BEHAVIOR_OPTIONS.map((option) => (
                  <DropdownMenuItem
                    key={option.label}
                    className="items-start"
                    onSelect={() =>
                      onSteerActiveThreadOnEnterChange(option.steerOnEnter)
                    }
                  >
                    <span className="min-w-0">
                      <span className="block">{option.label}</span>
                      <span className="block text-2xs leading-snug text-subtle-foreground">
                        {option.description}
                      </span>
                    </span>
                    <Icon
                      name="Check"
                      className={cn(
                        "ml-auto",
                        steerActiveThreadOnEnter !== option.steerOnEnter &&
                          "opacity-0",
                        COARSE_POINTER_ICON_SIZE_CLASS,
                      )}
                    />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </SettingsWithControl>
        </div>
      </SettingsSection>
      <SettingsSection title="Links">
        <div className="space-y-5">
          {desktopBrowserAvailable ? (
            <SettingsWithControl
              label={IN_APP_BROWSER_LINK_SETTING_LABEL}
              description="Open web links inside Cloudroom."
            >
              <Switch
                checked={openLinksInAppBrowser}
                onCheckedChange={onOpenLinksInAppBrowserChange}
                aria-label={IN_APP_BROWSER_LINK_SETTING_LABEL}
              />
            </SettingsWithControl>
          ) : null}

          <SettingsWithControl
            label={REWRITE_LOCALHOST_LINKS_SETTING_LABEL}
            description="Point localhost links at this host."
          >
            <Switch
              checked={rewriteLocalhostLinks}
              onCheckedChange={onRewriteLocalhostLinksChange}
              aria-label={REWRITE_LOCALHOST_LINKS_SETTING_LABEL}
            />
          </SettingsWithControl>
        </div>
      </SettingsSection>
      <SettingsSection title="Git">
        <div className="space-y-5">
          <ManagedBranchPrefixSetting
            value={managedBranchPrefix}
            disabled={generalSettingsDisabled}
            onChange={onManagedBranchPrefixChange}
          />
          <SettingsWithControl
            label={WORKTREE_RETENTION_SETTING_LABEL}
            description="Removes the worktree folder once its last thread is archived or deleted. The branch stays, but uncommitted changes are lost."
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
                  disabled={generalSettingsDisabled}
                  aria-label={WORKTREE_RETENTION_SETTING_LABEL}
                >
                  {WORKTREE_RETENTION_LABELS[worktreeRetention]}
                  <Icon
                    name="ChevronDown"
                    className="size-3.5 text-muted-foreground"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className={SETTINGS_DROPDOWN_CONTENT_CLASS}
              >
                {Object.entries(WORKTREE_RETENTION_LABELS).map(
                  ([retention, label]) => (
                    <DropdownMenuItem
                      key={retention}
                      onSelect={() =>
                        onWorktreeRetentionChange(
                          retention as WorktreeRetention,
                        )
                      }
                    >
                      {label}
                      <Icon
                        name="Check"
                        className={cn(
                          "ml-auto",
                          retention !== worktreeRetention && "opacity-0",
                          COARSE_POINTER_ICON_SIZE_CLASS,
                        )}
                      />
                    </DropdownMenuItem>
                  ),
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </SettingsWithControl>
        </div>
      </SettingsSection>
    </>
  );
}

export function PrivacySettingsSection({
  disabled,
  enabled,
  onEnabledChange,
  streamerMode,
  onStreamerModeChange,
  telemetryEnabled,
  onTelemetryEnabledChange,
  bugReportsEnabled,
  onBugReportsEnabledChange,
}: PrivacySettingsSectionProps) {
  return (
    <SettingsSection title="Privacy & diagnostics">
      <div className="space-y-5">
        <SettingsWithControl
          label={STREAMER_MODE_SETTING_LABEL}
          description="Hide the custom models from config.json in every model picker, so a screen share does not show them."
        >
          <Switch
            checked={streamerMode}
            disabled={disabled}
            onCheckedChange={onStreamerModeChange}
            aria-label={STREAMER_MODE_SETTING_LABEL}
          />
        </SettingsWithControl>

        <SettingsWithControl
          label="Share usage data and setup errors"
          description="Send app starts, thread and message counts, plugin installs, and short letters-only settings searches that find nothing to help improve Cloudroom. Failed agent connects and installs are saved with your account so we can fix them. Turning this off takes effect immediately for this server. Details: cloudroom.dev/privacy."
        >
          <Switch
            checked={telemetryEnabled}
            disabled={disabled}
            onCheckedChange={onTelemetryEnabledChange}
            aria-label="Share usage data and setup errors"
          />
        </SettingsWithControl>

        <SettingsWithControl
          label="Send agent feedback"
          description="Let your agents send Cloudroom bugs, friction, and ideas straight to our founder, so we can fix them fast. Never your code or secrets."
        >
          <Switch
            checked={bugReportsEnabled}
            disabled={disabled}
            onCheckedChange={onBugReportsEnabledChange}
            aria-label="Send agent feedback"
          />
        </SettingsWithControl>

        <SettingsWithControl
          label={DIAGNOSTIC_EVENTS_SETTING_LABEL}
          description="Show provider environment resolution and unhandled provider events for troubleshooting."
        >
          <Switch
            checked={enabled}
            disabled={disabled}
            onCheckedChange={onEnabledChange}
            aria-label={DIAGNOSTIC_EVENTS_SETTING_LABEL}
          />
        </SettingsWithControl>
      </div>
    </SettingsSection>
  );
}

const EXPERIMENT_DEFINITIONS: Record<
  Exclude<ExperimentKey, "mobileApp">,
  { label: string; description: string }
> = {
  changelogPreview: {
    label: "Changelog preview",
    description:
      "Show the latest release notes as a compact preview on the Updates page.",
  },
  multiMachinePicker: {
    label: "Multi-machine picker",
    description:
      "Use searchable, target-first environment and machine pickers when many machines are available.",
  },
  sidebarProgressiveDisclosure: {
    label: "Sidebar progressive disclosure",
    description:
      "In By project and By machine, show the first five groups in the current sort order, keep attention groups visible, and reveal ten more per click. Manually is unchanged.",
  },
  timelineWindowing: {
    label: "Timeline windowing",
    description:
      "Mount only nearby rows in long timelines and expanded timeline details.",
  },
};
export function ExperimentsSettingsSection({
  disabled,
  experiments,
  onExperimentChange,
}: ExperimentsSettingsSectionProps) {
  return (
    <SettingsSection
      title="Experiments"
      description="Early features that are off by default. Opt in to try them."
    >
      <div className="space-y-5">
        {experimentKeys.map((experimentKey) => {
          if (experimentKey === "mobileApp") return null;
          const definition = EXPERIMENT_DEFINITIONS[experimentKey];
          return (
            <SettingsWithControl
              key={experimentKey}
              label={definition.label}
              description={definition.description}
            >
              <Switch
                checked={experiments[experimentKey]}
                disabled={disabled}
                onCheckedChange={(enabled) =>
                  onExperimentChange(experimentKey, enabled)
                }
                aria-label={definition.label}
              />
            </SettingsWithControl>
          );
        })}
      </div>
    </SettingsSection>
  );
}

const SETTINGS_CONTENT_ID = "settings-content";

export function SettingsView() {
  const navigate = useNavigate();
  const themePreference = useThemePreference();
  const systemConfigQuery = useSystemConfig();
  const { hasDaemon } = useHostDaemon();
  const { accessState, requestAccess } = useLocalHostDaemonAccess();
  const { workspaceOpenTargets } = useWorkspaceOpenTargets({
    enabled: hasDaemon,
  });
  const [directoryTargetId, setDirectoryTargetId] =
    useWorkspaceOpenTargetPreference(workspaceOpenTargets);
  const [fileTargetId, setFileTargetId] =
    useFileOpenTargetPreference(workspaceOpenTargets);
  const [openLinksInAppBrowser, setOpenLinksInAppBrowser] =
    useOpenLinksInAppBrowserPreference();
  const [rewriteLocalhostLinks, setRewriteLocalhostLinks] =
    useRewriteLocalhostLinksPreference();
  const [navigateToThreadAfterCreate, setNavigateToThreadAfterCreate] =
    useNavigateToThreadAfterCreatePreference();
  const [richTextEditing, setRichTextEditing] = useRichTextEditingPreference();
  const [desktopBrowserAvailable] = useState(isDesktopBrowserAvailable);
  const experiments = systemConfigQuery.data?.experiments ?? defaultExperiments;
  const updateExperimentsMutation = useUpdateExperiments();
  const generalSettings =
    systemConfigQuery.data?.generalSettings ?? defaultAppSettings;
  const updateGeneralSettingsMutation = useUpdateGeneralSettings();
  const appearance = systemConfigQuery.data?.appearance ?? defaultAppTheme;
  const updateAppearanceMutation = useUpdateAppearance();
  const appThemePreview = useAppThemePreview();
  const location = useLocation();
  const navigation = useSettingsNavState();
  const { activePluginId, activeSection, hasUnknownSection } = navigation;
  const searchTargetKey = useRevealSettingsTarget(SETTINGS_CONTENT_ID);
  if (hasUnknownSection) {
    return <Navigate to={SETTINGS_ROUTE_PATH} replace />;
  }
  const groupTabs = (
    <SettingsGroupTabs
      links={getSettingsGroupLinks(
        findSettingsNavGroup(activeSection, activePluginId),
        navigation,
      )}
    />
  );

  if (activeSection === "plugins") {
    const pluginId = matchPath(SETTINGS_PLUGIN_ROUTE_PATH, location.pathname)
      ?.params.pluginId;
    return (
      <div
        key={searchTargetKey}
        id={SETTINGS_CONTENT_ID}
        className="-mx-4 -mt-4 flex min-h-0 flex-1 flex-col overflow-hidden md:-mx-5 md:-mt-5"
      >
        <div className="shrink-0 px-4 pt-4 md:px-5 md:pt-5">{groupTabs}</div>
        {pluginId ? (
          <PluginDetailPaneView pluginId={pluginId} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col pt-4 md:pt-5">
            <PluginsOverview mode="installed" />
          </div>
        )}
      </div>
    );
  }

  let content: ReactNode = null;
  if (activePluginId !== null) {
    content = (
      <PluginSettingsPage pluginId={activePluginId}>
        <ProviderTurnDisplaySection
          disabled={
            systemConfigQuery.data === undefined ||
            updateGeneralSettingsMutation.isPending
          }
          generalSettings={generalSettings}
          onGeneralSettingsChange={(next) =>
            updateGeneralSettingsMutation.mutateAsync(next)
          }
          pluginId={activePluginId}
        />
      </PluginSettingsPage>
    );
  } else if (activeSection === "defaults") {
    content = <DefaultsSettingsSection />;
  } else if (activeSection === "cloud-environment") {
    content = <CloudEnvironmentSettingsSection />;
  } else if (activeSection === "auto-delete") {
    content = <AutoDeleteSettingsSection />;
  } else if (activeSection === "providers") {
    content = (
      <ProvidersSettingsSection
        disabled={
          systemConfigQuery.data === undefined ||
          updateGeneralSettingsMutation.isPending
        }
        generalSettings={generalSettings}
        onGeneralSettingsChange={(next) =>
          updateGeneralSettingsMutation.mutateAsync(next)
        }
      />
    );
  } else if (activeSection === "appearance") {
    content = (
      <AppearanceSettingsSection
        agentQuestionsEnabled={generalSettings.agentQuestionsEnabled}
        appearance={appearance}
        appearanceDisabled={
          systemConfigQuery.data === undefined ||
          updateAppearanceMutation.isPending
        }
        customThemes={systemConfigQuery.data?.customThemes ?? []}
        pluginThemes={systemConfigQuery.data?.pluginThemes ?? []}
        faviconColor={appearance.faviconColor}
        generalSettingsDisabled={
          systemConfigQuery.data === undefined ||
          updateGeneralSettingsMutation.isPending
        }
        onAgentQuestionsEnabledChange={(enabled) =>
          updateGeneralSettingsMutation.mutate({
            ...generalSettings,
            agentQuestionsEnabled: enabled,
          })
        }
        themePreference={themePreference}
        onAppearanceThemeChange={(themeId) =>
          updateAppearanceMutation.mutate(
            {
              themeId,
              faviconColor: appearance.faviconColor,
            },
            { onError: () => appThemePreview.previewTheme(null) },
          )
        }
        onAppearanceThemePrefetch={appThemePreview.prefetchThemes}
        onAppearanceThemePreview={appThemePreview.previewTheme}
        onCreatePalette={() =>
          navigate(getRootComposeRoutePath(), {
            state: {
              focusPrompt: true,
              initialPrompt: CREATE_CUSTOM_PALETTE_PROMPT,
              executionTarget: "local",
            },
          })
        }
        onFaviconColorChange={(faviconColor) =>
          updateAppearanceMutation.mutate({
            themeId: appearance.themeId,
            faviconColor,
          })
        }
        onThemePreferenceChange={setPreferredTheme}
      />
    );
  } else if (activeSection === "keyboard") {
    content = <KeyboardSettingsSection />;
  } else if (activeSection === "browser") {
    content = <BrowserSettingsSection />;
  } else if (activeSection === "files") {
    content = (
      <>
        <LocalOpenTargetSettingsSection
          accessState={accessState}
          directoryTargetId={directoryTargetId}
          fileTargetId={fileTargetId}
          hasDaemon={hasDaemon}
          onDirectoryTargetChange={setDirectoryTargetId}
          onFileTargetChange={setFileTargetId}
          onRequestAccess={requestAccess}
          targets={workspaceOpenTargets}
        />
        <FileOpenersSettingsSection />
      </>
    );
  } else if (activeSection === "projects") {
    content = <ProjectsSettingsSection />;
  } else if (activeSection === "account") {
    content = <CloudroomAccountSettings />;
  } else if (activeSection === "machines") {
    content = <MachinesSettingsPage />;
  } else if (activeSection === "updates") {
    content = (
      <UpdatesSettingsSection
        showChangelogPreview={experiments.changelogPreview}
      />
    );
  } else if (activeSection === "experiments") {
    content = (
      <ExperimentsSettingsSection
        disabled={
          systemConfigQuery.data === undefined ||
          updateExperimentsMutation.isPending
        }
        experiments={experiments}
        onExperimentChange={(key, enabled) =>
          updateExperimentsMutation.mutate({ ...experiments, [key]: enabled })
        }
      />
    );
  } else if (activeSection === "command-guard") {
    content = (
      <SettingsSection title="Command Guard" description="For Codex and Pi (Local and Cloud), plus Local Claude Code. Start a new session after changing this setting. This is not a sandbox; running commands and personal guards are unchanged.">
        <SettingsWithControl label="Command Guard" description="Helps prevent whole-home deletion, disk wipes, hosted repository deletion, and fork bombs.">
          <Switch
            checked={generalSettings.commandGuardEnabled}
            disabled={systemConfigQuery.data === undefined || updateGeneralSettingsMutation.isPending}
            onCheckedChange={(enabled) => updateGeneralSettingsMutation.mutate({ ...generalSettings, commandGuardEnabled: enabled })}
            aria-label="Command Guard"
          />
        </SettingsWithControl>
        {updateGeneralSettingsMutation.error && <p role="alert">{updateGeneralSettingsMutation.error.message}</p>}
      </SettingsSection>
    );
  } else if (activeSection === "system-prompt") {
    content = (
      <SettingsSection title="System prompt" description="Cloudroom's built-in instructions for every Local and Cloud agent: how Cloudroom works, Git rules, and building defaults. Project and custom instructions still apply. Start a new session after changing this setting.">
        <SettingsWithControl label="Cloudroom system prompt" description="Recommended. Turn off only if your own instructions cover this.">
          <Switch
            checked={generalSettings.systemPromptEnabled}
            disabled={systemConfigQuery.data === undefined || updateGeneralSettingsMutation.isPending}
            onCheckedChange={(enabled) => updateGeneralSettingsMutation.mutate({ ...generalSettings, systemPromptEnabled: enabled })}
            aria-label="Cloudroom system prompt"
          />
        </SettingsWithControl>
        {updateGeneralSettingsMutation.error && <p role="alert">{updateGeneralSettingsMutation.error.message}</p>}
      </SettingsSection>
    );
  } else if (activeSection === "marketplaces") {
    content = <MarketplacesSettingsSection />;
  } else if (activeSection === "community") {
    content = <CommunitySettingsSection />;
  } else if (activeSection === "archived") {
    content = <ArchivedThreadsSettingsSection />;
  } else if (activeSection === "import") {
    content = <ImportChatsSettingsSection />;
  } else if (activeSection === "export") {
    content = <ExportChatsSettingsSection />;
  } else {
    content = (
      <>
        <InviteSettingsCard />
        <GeneralSettingsSection
          desktopBrowserAvailable={desktopBrowserAvailable}
          generalSettingsDisabled={
            systemConfigQuery.data === undefined ||
            updateGeneralSettingsMutation.isPending
          }
          managedBranchPrefix={generalSettings.managedBranchPrefix}
          onManagedBranchPrefixChange={async (prefix) => {
            await updateGeneralSettingsMutation.mutateAsync({
              ...generalSettings,
              managedBranchPrefix: prefix,
            });
          }}
          navigateToThreadAfterCreate={navigateToThreadAfterCreate}
          openLinksInAppBrowser={openLinksInAppBrowser}
          rewriteLocalhostLinks={rewriteLocalhostLinks}
          richTextEditing={richTextEditing}
          steerActiveThreadOnEnter={generalSettings.steerActiveThreadOnEnter}
          onNavigateToThreadAfterCreateChange={setNavigateToThreadAfterCreate}
          onOpenLinksInAppBrowserChange={setOpenLinksInAppBrowser}
          onRewriteLocalhostLinksChange={setRewriteLocalhostLinks}
          onRichTextEditingChange={setRichTextEditing}
          onSteerActiveThreadOnEnterChange={(enabled) =>
            updateGeneralSettingsMutation.mutate({
              ...generalSettings,
              steerActiveThreadOnEnter: enabled,
            })
          }
          worktreeRetention={generalSettings.worktreeRetention}
          onWorktreeRetentionChange={(retention) =>
            updateGeneralSettingsMutation.mutate({
              ...generalSettings,
              worktreeRetention: retention,
            })
          }
        />
        <CliSkillsSettingsSection />
        <ThreadNamingSettingsSection />
        <ThreadPurposeSettingsSection />
        <ProjectNudgeSettingsSection />
        <VoiceInputSettingsSection />
        <PrivacySettingsSection
          telemetryEnabled={generalSettings.telemetryEnabled}
          onTelemetryEnabledChange={(enabled) =>
            updateGeneralSettingsMutation.mutate({
              ...generalSettings,
              telemetryEnabled: enabled,
            })
          }
          bugReportsEnabled={generalSettings.bugReportsEnabled}
          onBugReportsEnabledChange={(enabled) =>
            updateGeneralSettingsMutation.mutate({
              ...generalSettings,
              bugReportsEnabled: enabled,
            })
          }
          streamerMode={generalSettings.streamerMode}
          onStreamerModeChange={(enabled) =>
            updateGeneralSettingsMutation.mutate({
              ...generalSettings,
              streamerMode: enabled,
            })
          }
          enabled={generalSettings.showDiagnosticEvents}
          disabled={
            systemConfigQuery.data === undefined ||
            updateGeneralSettingsMutation.isPending
          }
          onEnabledChange={(enabled) =>
            updateGeneralSettingsMutation.mutate({
              ...generalSettings,
              showDiagnosticEvents: enabled,
            })
          }
        />
      </>
    );
  }

  return (
    <PageShell contentClassName="pt-4 md:pt-5">
      <div className="mx-auto w-full max-w-3xl">
        {groupTabs}
        <div key={searchTargetKey} id={SETTINGS_CONTENT_ID} className="space-y-10">
          {content}
        </div>
      </div>
    </PageShell>
  );
}

export function MachinesSettingsPage() {
  const location = useLocation();
  return (
    <div className="space-y-6">
      <MachinesSettingsSection />
      <div className={SETTINGS_CARD_CLASS}>
        <details
          id="advanced-machine-settings"
          open={location.hash === "#advanced-machine-settings" || undefined}
          className="group"
        >
          <summary
            className={cn(
              SETTINGS_CARD_ROW_CLASS,
              "cursor-pointer list-none text-foreground hover:bg-state-hover [&::-webkit-details-marker]:hidden",
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block">Advanced</span>
              <span className="block text-xs text-subtle-foreground/75">
                Connection method, SSH and Tailscale machines.
              </span>
            </span>
            <Icon
              name="ChevronRight"
              className="size-4 text-muted-foreground transition-transform group-open:rotate-90"
            />
          </summary>
          <div className="space-y-6 border-t border-border px-4 py-4">
            <AdvancedMachineSettings />
            <MachineEnvironmentSettings />
          </div>
        </details>
      </div>
    </div>
  );
}

function SettingsGroupTabs({ links }: { links: readonly SettingsNavLink[] }) {
  if (links.length < 2) return null;
  return (
    <nav
      aria-label="Settings pages"
      className="mb-6 flex flex-wrap gap-1 border-b border-border pb-2"
    >
      {links.map((link) => (
        <Link
          key={link.key}
          to={link.to}
          aria-current={link.active ? "page" : undefined}
          className={cn(
            "rounded-md px-2.5 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground",
            link.active && "bg-accent text-foreground",
          )}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
