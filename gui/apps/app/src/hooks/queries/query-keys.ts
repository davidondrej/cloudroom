import type { WorkspaceDiffTarget } from "@cloudroom/domain";
import type { ThreadListFilters, ThreadSearchFilters } from "@cloudroom/client-core";
import type { EnvironmentFilePreviewSource } from "@cloudroom/client-core";
import {
  DEFAULT_THREAD_STORAGE_FILE_LIST_OPTIONS,
  type ThreadStorageFileListOptions,
} from "@/lib/thread-storage-files";
import {
  DEFAULT_FILE_ONLY_PATH_LIST_OPTIONS,
  type PathListOptions,
} from "@/lib/path-list-options";

const HOSTS_QUERY_KEY = "hosts";
const HOST_QUERY_KEY = "host";
const HOST_DIRECTORY_QUERY_KEY = "hostDirectory";
const HOST_CLONE_DEFAULT_PATH_QUERY_KEY = "hostCloneDefaultPath";
const PROJECTS_QUERY_KEY = "projects";
const PROJECT_PATHS_QUERY_KEY = "projectPaths";
const PROJECT_FILE_PREVIEW_QUERY_KEY = "projectFilePreview";
export const PROJECT_SOURCE_BRANCHES_QUERY_KEY = "projectSourceBranches";
const PROJECT_DEFAULT_EXECUTION_OPTIONS_QUERY_KEY =
  "projectDefaultExecutionOptions";
const PROJECT_PROMPT_HISTORY_QUERY_KEY = "projectPromptHistory";
export const SIDEBAR_NAVIGATION_QUERY_KEY = "sidebarNavigation";
export const THREADS_QUERY_KEY = "threads";
const THREAD_SEARCH_QUERY_KEY = "threadSearch";
const THREADS_DISABLED_QUERY_KEY = "threadsDisabled";
export const THREAD_QUERY_KEY = "thread";
const THREAD_TABS_QUERY_KEY = "threadTabs";
const THREAD_DETAIL_BOOTSTRAP_QUERY_KEY = "threadDetailBootstrap";
const THREAD_DEFAULT_EXECUTION_OPTIONS_QUERY_KEY =
  "threadDefaultExecutionOptions";
const THREAD_QUEUED_MESSAGES_QUERY_KEY = "threadQueuedMessages";
const THREAD_PROMPT_HISTORY_QUERY_KEY = "threadPromptHistory";
const THREAD_PENDING_INTERACTIONS_QUERY_KEY = "threadPendingInteractions";
const TERMINALS_QUERY_KEY = "terminals";
const PROJECT_COMMANDS_QUERY_KEY = "projectCommands";
const THREAD_STORAGE_FILES_QUERY_KEY = "threadStorageFiles";
const THREAD_STORAGE_LOCATION_QUERY_KEY = "threadStorageLocation";
const THREAD_STORAGE_PATHS_QUERY_KEY = "threadStoragePaths";
const THREAD_STORAGE_FILE_PREVIEW_QUERY_KEY = "threadStorageFilePreview";
const THREAD_HOST_FILE_PREVIEW_QUERY_KEY = "threadHostFilePreview";
const HOST_FILE_PREVIEW_QUERY_KEY = "hostFilePreview";
const ENVIRONMENT_QUERY_KEY = "environment";
export const ENVIRONMENT_WORK_STATUS_QUERY_KEY = "environmentWorkStatus";
const ENVIRONMENT_PULL_REQUEST_QUERY_KEY = "environmentPullRequest";
export const ENVIRONMENT_MERGE_BASE_BRANCHES_QUERY_KEY =
  "environmentMergeBaseBranches";
export const ENVIRONMENT_DIFF_FILES_QUERY_KEY = "environmentDiffFiles";
const ENVIRONMENT_DIFF_PATCH_QUERY_KEY = "environmentDiffPatch";
const ENVIRONMENT_DIFF_FILE_QUERY_KEY = "environmentDiffFile";
const ENVIRONMENT_FILE_PREVIEW_QUERY_KEY = "environmentFilePreview";
const ENVIRONMENT_PATHS_QUERY_KEY = "environmentPaths";
export const THREAD_TIMELINE_QUERY_KEY = "threadTimeline";
const THREAD_CONVERSATION_OUTLINE_QUERY_KEY = "threadConversationOutline";
const THREAD_TIMELINE_TURN_SUMMARY_DETAILS_QUERY_KEY =
  "threadTimelineTurnSummaryDetails";
const SYSTEM_PROVIDERS_QUERY_KEY = "systemProviders";
const SYSTEM_MACHINE_PROVIDERS_QUERY_KEY = "systemMachineProviders";
const SYSTEM_INSTALLABLE_PROVIDERS_QUERY_KEY = "systemInstallableProviders";
const MACHINE_ENVIRONMENT_QUERY_KEY = "machine-environment";
const SYSTEM_CONFIG_QUERY_KEY = "systemConfig";
const UI_PREFERENCES_QUERY_KEY = "uiPreferences";
const SYSTEM_THEME_QUERY_KEY = "systemTheme";
export const SYSTEM_EXECUTION_OPTIONS_QUERY_KEY = "systemExecutionOptions";
const SYSTEM_CLI_SKILLS_QUERY_KEY = "systemCliSkills";
const SYSTEM_WORKTREE_STORAGE_QUERY_KEY = "systemWorktreeStorage";
const SYSTEM_SKILL_USAGE_QUERY_KEY = "systemSkillUsage";
const SYSTEM_VERSION_QUERY_KEY = "systemVersion";
const HOST_PROVIDER_CLI_STATUS_QUERY_KEY = "hostProviderCliStatus";
const SYSTEM_USAGE_LIMITS_QUERY_KEY = "systemUsageLimits";
const SYSTEM_PROVIDER_STATES_QUERY_KEY = "systemProviderStates";
const HOST_PATH_EXISTENCE_QUERY_KEY = "hostPathExistence";
const THREAD_FILE_EXISTENCE_QUERY_KEY = "threadFileExistence";
const PROJECT_SKILLS_QUERY_KEY = "projectSkills";
export const SKILL_CONTENT_QUERY_KEY = "skillContent";
export const SKILL_FILES_QUERY_KEY = "skillFiles";
const PLUGIN_LIST_QUERY_KEY = "plugin-list";
const PLUGIN_SAFE_MODE_QUERY_KEY = "plugin-safe-mode";
const PLUGIN_SETTINGS_VIEW_QUERY_KEY = "plugin-settings-view";
const PLUGIN_CONTRIBUTIONS_QUERY_KEY = "plugin-contributions";
const PLUGIN_SDK_SETTINGS_QUERY_KEY = "plugin-settings";
const PLUGIN_SOURCE_QUERY_KEY = "plugin-source";
const PLUGIN_CATALOG_SEARCH_QUERY_KEY = "plugin-catalog-search";
const PLUGIN_CATALOG_INSTALL_PLAN_QUERY_KEY = "plugin-catalog-install-plan";
const PLUGIN_MARKETPLACES_QUERY_KEY = "plugin-marketplaces";
export interface ThreadListQueryFilters {
  projectId?: string;
  hasParent?: ThreadListFilters["hasParent"];
  parentThreadId?: string;
  sourceThreadId?: string;
  originKind?: ThreadListFilters["originKind"];
  archived: boolean;
  limit?: number;
}

interface ThreadSearchQueryFilters {
  query: ThreadSearchFilters["query"];
  limitPerGroup: NonNullable<ThreadSearchFilters["limitPerGroup"]>;
  projectId?: ThreadSearchFilters["projectId"];
  hasParent?: ThreadSearchFilters["hasParent"];
}

export type ArchivedThreadsKindFilter = "all" | "root" | "child";

export interface ArchivedThreadsListFilters {
  projectId?: string;
  kind?: ArchivedThreadsKindFilter;
}

export const ARCHIVED_THREADS_LIST_KIND = "archivedList";

type HostQueryId = string | null | undefined;

export type TerminalQueryScope =
  | { kind: "thread"; threadId: string }
  | { kind: "environment"; environmentId: string }
  | { kind: "host_path"; cwd?: string; hostId: string };

export interface ThreadTimelineTurnSummaryDetailsQueryIdentity {
  sourceSeqEnd: number;
  sourceSeqStart: number;
  threadId: string;
  turnId: string;
}

interface ProjectDefaultExecutionOptionsQueryKeyArgs {
  projectId: string;
}

export function hostsQueryKey(includeCreating = false) {
  return includeCreating
    ? ([HOSTS_QUERY_KEY, true] as const)
    : ([HOSTS_QUERY_KEY] as const);
}

export function hostQueryKey(hostId: HostQueryId) {
  return [HOST_QUERY_KEY, hostId] as const;
}

export function allHostQueryKeyPrefix() {
  return [HOST_QUERY_KEY] as const;
}

export function hostDirectoryQueryKey(
  hostId: HostQueryId,
  path: string | null,
) {
  return [HOST_DIRECTORY_QUERY_KEY, hostId, path] as const;
}

export function hostCloneDefaultPathQueryKey(
  hostId: HostQueryId,
  projectId: string | null,
) {
  return [HOST_CLONE_DEFAULT_PATH_QUERY_KEY, hostId, projectId] as const;
}

export function projectsQueryKey() {
  return [PROJECTS_QUERY_KEY] as const;
}

export function hiddenProjectsQueryKey() {
  return [PROJECTS_QUERY_KEY, "hidden"] as const;
}

export function projectPathsQueryKey(
  projectId: string | undefined,
  environmentId: string | null,
  hostId: string | null,
  query: string,
  limit: number,
  includeFiles: boolean,
  includeDirectories: boolean,
) {
  return [
    PROJECT_PATHS_QUERY_KEY,
    projectId,
    environmentId,
    hostId,
    query,
    limit,
    includeFiles,
    includeDirectories,
  ] as const;
}

export function projectFilePreviewQueryKey(
  projectId: string | undefined,
  environmentId: string | null,
  hostId: string | null,
  path: string | null,
) {
  return [
    PROJECT_FILE_PREVIEW_QUERY_KEY,
    projectId,
    environmentId,
    hostId,
    path,
  ] as const;
}

export function allProjectPathsQueryKeyPrefix() {
  return [PROJECT_PATHS_QUERY_KEY] as const;
}

export function environmentPathsQueryKey(
  environmentId: string | undefined,
  query: string,
  limit: number,
  includeFiles: boolean,
  includeDirectories: boolean,
) {
  return [
    ENVIRONMENT_PATHS_QUERY_KEY,
    environmentId,
    query,
    limit,
    includeFiles,
    includeDirectories,
  ] as const;
}

export function environmentPathsQueryKeyPrefix(environmentId: string) {
  return [ENVIRONMENT_PATHS_QUERY_KEY, environmentId] as const;
}

export function projectPromptHistoryQueryKey(
  projectId: string | null | undefined,
) {
  return [PROJECT_PROMPT_HISTORY_QUERY_KEY, projectId] as const;
}

export function projectDefaultExecutionOptionsQueryKey({
  projectId,
}: ProjectDefaultExecutionOptionsQueryKeyArgs) {
  return [PROJECT_DEFAULT_EXECUTION_OPTIONS_QUERY_KEY, projectId] as const;
}

export function projectPromptHistoryQueryKeyPrefix() {
  return [PROJECT_PROMPT_HISTORY_QUERY_KEY] as const;
}

export function projectPathsQueryKeyPrefix(projectId: string) {
  return [PROJECT_PATHS_QUERY_KEY, projectId] as const;
}

export function projectSourceBranchesQueryKey(
  projectId: string,
  hostId: string,
  query = "",
  limit = 50,
  selectedBranch = "",
) {
  return [
    PROJECT_SOURCE_BRANCHES_QUERY_KEY,
    projectId,
    hostId,
    query,
    limit,
    selectedBranch,
  ] as const;
}

export function allProjectSourceBranchesQueryKeyPrefix() {
  return [PROJECT_SOURCE_BRANCHES_QUERY_KEY] as const;
}

export function projectSourceBranchesQueryKeyPrefix(projectId: string) {
  return [PROJECT_SOURCE_BRANCHES_QUERY_KEY, projectId] as const;
}

export function sidebarNavigationQueryKey() {
  return [SIDEBAR_NAVIGATION_QUERY_KEY] as const;
}

export type SidebarNavigationQueryKey = ReturnType<
  typeof sidebarNavigationQueryKey
>;

export function threadsQueryKey() {
  return [THREADS_QUERY_KEY] as const;
}

export function threadListQueryKey(filters: ThreadListQueryFilters) {
  return [THREADS_QUERY_KEY, filters] as const;
}

export function threadSearchQueryKey(filters: ThreadSearchQueryFilters) {
  return [THREAD_SEARCH_QUERY_KEY, filters] as const;
}

export function threadSearchQueryKeyPrefix() {
  return [THREAD_SEARCH_QUERY_KEY] as const;
}

export function archivedThreadsListQueryKey(
  filters: ArchivedThreadsListFilters,
) {
  return [THREADS_QUERY_KEY, ARCHIVED_THREADS_LIST_KIND, filters] as const;
}

/**
 * Sits under the archived list's own key, so everything that refreshes that
 * list (a mutation here, an archive elsewhere) refreshes its totals too.
 */
export function archivedThreadCountsQueryKey(
  filters: ArchivedThreadsListFilters,
) {
  return [...archivedThreadsListQueryKey(filters), "count"] as const;
}

export function disabledThreadListQueryKey(
  filters?: ThreadListQueryFilters,
): readonly [typeof THREADS_DISABLED_QUERY_KEY, ThreadListQueryFilters?] {
  return filters
    ? [THREADS_DISABLED_QUERY_KEY, filters]
    : [THREADS_DISABLED_QUERY_KEY];
}

export function threadQueryKey(threadId: string) {
  return [THREAD_QUERY_KEY, threadId] as const;
}

export function threadTabsQueryKey(threadId: string) {
  return [THREAD_TABS_QUERY_KEY, threadId] as const;
}

export function threadDetailBootstrapQueryKey(threadId: string) {
  return [THREAD_DETAIL_BOOTSTRAP_QUERY_KEY, threadId] as const;
}

export function allThreadDetailBootstrapQueryKeyPrefix() {
  return [THREAD_DETAIL_BOOTSTRAP_QUERY_KEY] as const;
}

export function allThreadQueryKeyPrefix() {
  return [THREAD_QUERY_KEY] as const;
}

export function threadReasoningSaveKey(threadId: string) {
  return ["thread-reasoning", threadId];
}

export function threadDefaultExecutionOptionsQueryKey(threadId: string) {
  return [THREAD_DEFAULT_EXECUTION_OPTIONS_QUERY_KEY, threadId] as const;
}

export function allThreadDefaultExecutionOptionsQueryKeyPrefix() {
  return [THREAD_DEFAULT_EXECUTION_OPTIONS_QUERY_KEY] as const;
}

export function threadQueuedMessagesQueryKey(threadId: string) {
  return [THREAD_QUEUED_MESSAGES_QUERY_KEY, threadId] as const;
}

export function allThreadQueuedMessagesQueryKeyPrefix() {
  return [THREAD_QUEUED_MESSAGES_QUERY_KEY] as const;
}

export function threadPromptHistoryQueryKey(threadId: string) {
  return [THREAD_PROMPT_HISTORY_QUERY_KEY, threadId] as const;
}

export function threadPromptHistoryQueryKeyPrefix() {
  return [THREAD_PROMPT_HISTORY_QUERY_KEY] as const;
}

export function threadPendingInteractionsQueryKey(threadId: string) {
  return [THREAD_PENDING_INTERACTIONS_QUERY_KEY, threadId] as const;
}

export function allThreadPendingInteractionsQueryKeyPrefix() {
  return [THREAD_PENDING_INTERACTIONS_QUERY_KEY] as const;
}

export function terminalsQueryKey(scope: TerminalQueryScope) {
  return [TERMINALS_QUERY_KEY, scope] as const;
}

export function allTerminalsQueryKeyPrefix() {
  return [TERMINALS_QUERY_KEY] as const;
}

export function projectCommandsQueryKey(
  projectId: string | undefined,
  providerId: string | undefined,
  environmentId: string | null,
  hostId: string | null,
) {
  return [
    PROJECT_COMMANDS_QUERY_KEY,
    projectId,
    providerId,
    environmentId,
    hostId,
  ] as const;
}

export function allProjectCommandsQueryKeyPrefix() {
  return [PROJECT_COMMANDS_QUERY_KEY] as const;
}

export function threadStorageFilesQueryKey(
  threadId: string,
  options: ThreadStorageFileListOptions = DEFAULT_THREAD_STORAGE_FILE_LIST_OPTIONS,
) {
  return [THREAD_STORAGE_FILES_QUERY_KEY, threadId, options] as const;
}

export function threadStorageLocationQueryKey(threadId: string) {
  return [THREAD_STORAGE_LOCATION_QUERY_KEY, threadId] as const;
}

export function allThreadStorageLocationsQueryKeyPrefix() {
  return [THREAD_STORAGE_LOCATION_QUERY_KEY] as const;
}

export function threadStoragePathsQueryKey(
  threadId: string,
  options: PathListOptions = DEFAULT_FILE_ONLY_PATH_LIST_OPTIONS,
) {
  return [THREAD_STORAGE_PATHS_QUERY_KEY, threadId, options] as const;
}

export function allThreadStorageFilesQueryKeyPrefix() {
  return [THREAD_STORAGE_FILES_QUERY_KEY] as const;
}

export function allThreadStoragePathsQueryKeyPrefix() {
  return [THREAD_STORAGE_PATHS_QUERY_KEY] as const;
}

export function threadStorageFilesForThreadQueryKeyPrefix(threadId: string) {
  return [THREAD_STORAGE_FILES_QUERY_KEY, threadId] as const;
}

export function threadStoragePathsForThreadQueryKeyPrefix(threadId: string) {
  return [THREAD_STORAGE_PATHS_QUERY_KEY, threadId] as const;
}

export function threadStorageFilePreviewQueryKey(
  threadId: string,
  path: string | null,
) {
  return [THREAD_STORAGE_FILE_PREVIEW_QUERY_KEY, threadId, path] as const;
}

export function allThreadStorageFilePreviewQueryKeyPrefix() {
  return [THREAD_STORAGE_FILE_PREVIEW_QUERY_KEY] as const;
}

export function threadStorageFilePreviewQueryKeyPrefix(threadId: string) {
  return [THREAD_STORAGE_FILE_PREVIEW_QUERY_KEY, threadId] as const;
}

export function threadHostFilePreviewQueryKey(
  threadId: string,
  environmentId: string | null | undefined,
  path: string | null,
) {
  return [
    THREAD_HOST_FILE_PREVIEW_QUERY_KEY,
    threadId,
    environmentId,
    path,
  ] as const;
}

export function hostFilePreviewQueryKey(
  hostId: string | null,
  path: string | null,
) {
  return [HOST_FILE_PREVIEW_QUERY_KEY, hostId, path] as const;
}

export function allThreadHostFilePreviewQueryKeyPrefix() {
  return [THREAD_HOST_FILE_PREVIEW_QUERY_KEY] as const;
}

export function allEnvironmentQueryKeyPrefix() {
  return [ENVIRONMENT_QUERY_KEY] as const;
}

export function environmentQueryKey(environmentId: string | null | undefined) {
  return [ENVIRONMENT_QUERY_KEY, environmentId] as const;
}

export function environmentWorkStatusQueryKey(
  environmentId: string | null | undefined,
  mergeBaseBranch: string | null,
) {
  return [
    ENVIRONMENT_WORK_STATUS_QUERY_KEY,
    environmentId,
    mergeBaseBranch,
  ] as const;
}

export type EnvironmentWorkStatusQueryKey = ReturnType<
  typeof environmentWorkStatusQueryKey
>;

export function allEnvironmentWorkStatusQueryKeyPrefix() {
  return [ENVIRONMENT_WORK_STATUS_QUERY_KEY] as const;
}

export function environmentWorkStatusQueryKeyPrefix(environmentId: string) {
  return [ENVIRONMENT_WORK_STATUS_QUERY_KEY, environmentId] as const;
}

export function environmentPullRequestQueryKey(
  environmentId: string | null | undefined,
) {
  return [ENVIRONMENT_PULL_REQUEST_QUERY_KEY, environmentId] as const;
}

export function environmentMergeBaseBranchesQueryKey(
  environmentId: string,
  query = "",
  limit = 50,
  selectedBranch = "",
) {
  return [
    ENVIRONMENT_MERGE_BASE_BRANCHES_QUERY_KEY,
    environmentId,
    query,
    limit,
    selectedBranch,
  ] as const;
}

export function allEnvironmentMergeBaseBranchesQueryKeyPrefix() {
  return [ENVIRONMENT_MERGE_BASE_BRANCHES_QUERY_KEY] as const;
}

export function environmentMergeBaseBranchesQueryKeyPrefix(
  environmentId: string,
) {
  return [ENVIRONMENT_MERGE_BASE_BRANCHES_QUERY_KEY, environmentId] as const;
}

export function threadTimelineQueryKey(threadId: string) {
  return [THREAD_TIMELINE_QUERY_KEY, threadId] as const;
}

export function threadConversationOutlineQueryKey(threadId: string) {
  return [THREAD_CONVERSATION_OUTLINE_QUERY_KEY, threadId] as const;
}

export function threadConversationOutlineQueryKeyPrefix(threadId: string) {
  return [THREAD_CONVERSATION_OUTLINE_QUERY_KEY, threadId] as const;
}

export function allThreadConversationOutlineQueryKeyPrefix() {
  return [THREAD_CONVERSATION_OUTLINE_QUERY_KEY] as const;
}

export function threadTimelineTurnSummaryDetailsQueryKey({
  sourceSeqEnd,
  sourceSeqStart,
  threadId,
  turnId,
}: ThreadTimelineTurnSummaryDetailsQueryIdentity) {
  return [
    THREAD_TIMELINE_TURN_SUMMARY_DETAILS_QUERY_KEY,
    threadId,
    turnId,
    sourceSeqStart,
    sourceSeqEnd,
  ] as const;
}

export function threadTimelineQueryKeyPrefix(threadId: string) {
  return [THREAD_TIMELINE_QUERY_KEY, threadId] as const;
}

export function allThreadTimelineQueryKeyPrefix() {
  return [THREAD_TIMELINE_QUERY_KEY] as const;
}

export function threadTimelineTurnSummaryDetailsQueryKeyPrefix(
  threadId: string,
) {
  return [THREAD_TIMELINE_TURN_SUMMARY_DETAILS_QUERY_KEY, threadId] as const;
}

export function allThreadTimelineTurnSummaryDetailsQueryKeyPrefix() {
  return [THREAD_TIMELINE_TURN_SUMMARY_DETAILS_QUERY_KEY] as const;
}

export function environmentDiffTargetKey(
  target: WorkspaceDiffTarget | null | undefined,
): string | null {
  switch (target?.type) {
    case "commit":
      return target.sha;
    case "branch_committed":
    case "all":
      return target.mergeBaseBranch;
    default:
      return null;
  }
}

export function environmentDiffFilesQueryKey(
  environmentId: string,
  targetType: string | null,
  targetKey: string | null,
) {
  return [
    ENVIRONMENT_DIFF_FILES_QUERY_KEY,
    environmentId,
    targetType,
    targetKey,
  ] as const;
}

export function allEnvironmentDiffFilesQueryKeyPrefix() {
  return [ENVIRONMENT_DIFF_FILES_QUERY_KEY] as const;
}

export function environmentDiffFilesQueryKeyPrefix(environmentId: string) {
  return [ENVIRONMENT_DIFF_FILES_QUERY_KEY, environmentId] as const;
}

export function environmentDiffPatchQueryKey(
  environmentId: string,
  targetType: string | null,
  targetKey: string | null,
  path: string,
) {
  return [
    ENVIRONMENT_DIFF_PATCH_QUERY_KEY,
    environmentId,
    targetType,
    targetKey,
    path,
  ] as const;
}

export function allEnvironmentDiffPatchQueryKeyPrefix() {
  return [ENVIRONMENT_DIFF_PATCH_QUERY_KEY] as const;
}

export function environmentDiffPatchQueryKeyPrefix(environmentId: string) {
  return [ENVIRONMENT_DIFF_PATCH_QUERY_KEY, environmentId] as const;
}

export function environmentDiffFileQueryKey(
  environmentId: string,
  targetType: string,
  targetKey: string | null,
  path: string,
  side: "old" | "new",
) {
  return [
    ENVIRONMENT_DIFF_FILE_QUERY_KEY,
    environmentId,
    targetType,
    targetKey,
    path,
    side,
  ] as const;
}

export function environmentFilePreviewQueryKey(
  environmentId: string | null | undefined,
  path: string | null,
  source: EnvironmentFilePreviewSource | null,
) {
  return [
    ENVIRONMENT_FILE_PREVIEW_QUERY_KEY,
    environmentId,
    path,
    source,
  ] as const;
}

export function allEnvironmentFilePreviewQueryKeyPrefix() {
  return [ENVIRONMENT_FILE_PREVIEW_QUERY_KEY] as const;
}

export function environmentFilePreviewQueryKeyPrefix(environmentId: string) {
  return [ENVIRONMENT_FILE_PREVIEW_QUERY_KEY, environmentId] as const;
}

interface SystemProvidersQueryKeyArgs {
  capability?: "usage" | null;
  environmentId?: string | null;
  hostId?: string | null;
}

export function systemProvidersQueryKey(
  args: SystemProvidersQueryKeyArgs = {},
) {
  return [
    SYSTEM_PROVIDERS_QUERY_KEY,
    args.environmentId ?? null,
    args.hostId ?? null,
    args.capability ?? null,
  ] as const;
}

export function allSystemProvidersQueryKeyPrefix() {
  return [SYSTEM_PROVIDERS_QUERY_KEY] as const;
}

export function systemInstallableProvidersQueryKey(hostId: string | null) {
  return [SYSTEM_INSTALLABLE_PROVIDERS_QUERY_KEY, hostId] as const;
}

export function allSystemInstallableProvidersQueryKeyPrefix() {
  return [SYSTEM_INSTALLABLE_PROVIDERS_QUERY_KEY] as const;
}

export function systemMachineProvidersQueryKey() {
  return [SYSTEM_MACHINE_PROVIDERS_QUERY_KEY] as const;
}

export function allSystemMachineProvidersQueryKeyPrefix() {
  return [SYSTEM_MACHINE_PROVIDERS_QUERY_KEY] as const;
}

export function machineEnvironmentQueryKey() {
  return [MACHINE_ENVIRONMENT_QUERY_KEY] as const;
}

export function systemCliSkillsQueryKey() {
  return [SYSTEM_CLI_SKILLS_QUERY_KEY] as const;
}

export function systemSkillUsageQueryKey(
  days: string,
): readonly [typeof SYSTEM_SKILL_USAGE_QUERY_KEY, string] {
  return [SYSTEM_SKILL_USAGE_QUERY_KEY, days];
}

export const SYSTEM_USAGE_ANALYTICS_QUERY_KEY = "systemUsageAnalytics";
export function systemUsageAnalyticsQueryKey(metric: string, days: string) {
  return [SYSTEM_USAGE_ANALYTICS_QUERY_KEY, metric, days] as const;
}

export function systemWorktreeStorageQueryKey() {
  return [SYSTEM_WORKTREE_STORAGE_QUERY_KEY] as const;
}

export function systemConfigQueryKey() {
  return [SYSTEM_CONFIG_QUERY_KEY] as const;
}

export function uiPreferencesQueryKey() {
  return [UI_PREFERENCES_QUERY_KEY] as const;
}

export function systemThemeQueryKey(themeId: string) {
  return [SYSTEM_THEME_QUERY_KEY, themeId] as const;
}

export function allSystemThemesQueryKeyPrefix() {
  return [SYSTEM_THEME_QUERY_KEY] as const;
}

export function systemVersionQueryKey() {
  return [SYSTEM_VERSION_QUERY_KEY] as const;
}

export function hostProviderCliStatusQueryKey(hostId: string | null) {
  return [HOST_PROVIDER_CLI_STATUS_QUERY_KEY, hostId] as const;
}

export function systemUsageLimitsQueryKey(
  hostId: string | null,
  providerId: string | null = null,
) {
  return [SYSTEM_USAGE_LIMITS_QUERY_KEY, hostId, providerId] as const;
}

export function systemProviderStatesQueryKey(
  args: Pick<SystemExecutionOptionsQueryKeyArgs, "environmentId" | "hostId">,
) {
  return [
    SYSTEM_PROVIDER_STATES_QUERY_KEY,
    args.environmentId,
    args.hostId,
  ] as const;
}

interface SystemExecutionOptionsQueryKeyArgs {
  environmentId: string | null;
  hostId: string | null;
  providerId: string | null;
  projectId?: string | null;
}

export function systemExecutionOptionsQueryKey({
  environmentId,
  hostId,
  providerId,
  projectId = null,
}: SystemExecutionOptionsQueryKeyArgs) {
  return [
    SYSTEM_EXECUTION_OPTIONS_QUERY_KEY,
    environmentId,
    hostId,
    providerId,
    projectId,
  ] as const;
}

export function allSystemExecutionOptionsQueryKeyPrefix() {
  return [SYSTEM_EXECUTION_OPTIONS_QUERY_KEY] as const;
}

export function systemExecutionOptionsEnvironmentQueryKeyPrefix(
  environmentId: string | null,
) {
  return [SYSTEM_EXECUTION_OPTIONS_QUERY_KEY, environmentId] as const;
}

export function hostPathExistenceQueryKey(
  hostId: string | null,
  paths: readonly string[],
) {
  return [HOST_PATH_EXISTENCE_QUERY_KEY, hostId, paths] as const;
}

export function threadFileExistenceQueryKeyPrefix(threadId: string) {
  return [THREAD_FILE_EXISTENCE_QUERY_KEY, threadId] as const;
}

export function threadFileExistenceQueryKey(
  threadId: string | null,
  path: string | null,
) {
  return [THREAD_FILE_EXISTENCE_QUERY_KEY, threadId, path] as const;
}

export function hostPathExistenceQueryKeyPrefix() {
  return [HOST_PATH_EXISTENCE_QUERY_KEY] as const;
}

export function projectSkillsQueryKey(projectId: string) {
  return [PROJECT_SKILLS_QUERY_KEY, projectId] as const;
}

export function skillContentQueryKey(
  projectId: string,
  skillId: string,
  path: string,
) {
  return [SKILL_CONTENT_QUERY_KEY, projectId, skillId, path] as const;
}

export function skillFilesQueryKey(projectId: string, skillId: string) {
  return [SKILL_FILES_QUERY_KEY, projectId, skillId] as const;
}

export function pluginListQueryKey(enabled: boolean) {
  return [PLUGIN_LIST_QUERY_KEY, enabled] as const;
}

export function allPluginListQueryKeyPrefix() {
  return [PLUGIN_LIST_QUERY_KEY] as const;
}

export function pluginSafeModeQueryKey() {
  return [PLUGIN_SAFE_MODE_QUERY_KEY] as const;
}

/** The one-click scan cards' last scan thread per kind; a deleted thread must refresh it. */
export function oneClickScanStateQueryKey() {
  return ["one-click-scans", "state"] as const;
}

/** Plugin installs and updates waiting for a click in the app (ADR 0260). */
export function humanClickRequestsQueryKey() {
  return ["human-clicks"] as const;
}

export function pluginSettingsViewQueryKey(pluginId: string) {
  return [PLUGIN_SETTINGS_VIEW_QUERY_KEY, pluginId] as const;
}

export function allPluginSettingsViewQueryKeyPrefix() {
  return [PLUGIN_SETTINGS_VIEW_QUERY_KEY] as const;
}

export function pluginContributionsQueryKey() {
  return [PLUGIN_CONTRIBUTIONS_QUERY_KEY] as const;
}

export function allPluginContributionsQueryKeyPrefix() {
  return [PLUGIN_CONTRIBUTIONS_QUERY_KEY] as const;
}

export function pluginSdkSettingsQueryKey(pluginId: string) {
  return [PLUGIN_SDK_SETTINGS_QUERY_KEY, pluginId] as const;
}

export function allPluginSettingsQueryKeyPrefix() {
  return [PLUGIN_SDK_SETTINGS_QUERY_KEY] as const;
}

export function pluginSourceQueryKey(pluginId: string) {
  return [PLUGIN_SOURCE_QUERY_KEY, pluginId] as const;
}

export function allPluginSourceQueryKeyPrefix() {
  return [PLUGIN_SOURCE_QUERY_KEY] as const;
}

export function pluginCatalogSearchQueryKey(query: string) {
  return [PLUGIN_CATALOG_SEARCH_QUERY_KEY, query] as const;
}

export function allPluginCatalogSearchQueryKeyPrefix() {
  return [PLUGIN_CATALOG_SEARCH_QUERY_KEY] as const;
}

export function pluginCatalogInstallPlanQueryKey(args: {
  entryId: string;
  marketplace?: string;
}) {
  return [
    PLUGIN_CATALOG_INSTALL_PLAN_QUERY_KEY,
    args.marketplace ?? "",
    args.entryId,
  ] as const;
}

export function pluginMarketplacesQueryKey() {
  return [PLUGIN_MARKETPLACES_QUERY_KEY] as const;
}
