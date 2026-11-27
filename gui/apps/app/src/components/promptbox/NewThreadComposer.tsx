import { gitlabRepository } from "@cloudroom/domain";
import { AntigravityCloudLogin } from "@/components/AntigravityCloudLogin";
import { antigravityCloudState, useAntigravityCloud } from "@/lib/antigravity-cloud";
import { CONNECT_AGENT_IDS, ConnectAgentsButton } from "@/components/ConnectAgentsButton";
import { PromptDraftContextsContext } from "@/components/promptbox/editor/prompt-context-chip";
import {
  useCloudroomConnection,
  cloudHarness,
  cloudCanRunHarness,
  cloudCatalogKnown,
  cloudHarnessNames,
  cloudReasoningLevels,
  cloudOpenCodeCatalog,
  cloudOpenCodeModelIssue,
  partitionCloudOpenCodeModelOptions,
  cloudServiceTierSupported,
  cloudUltraFastSupported,
  cloudroomRequestId,
  clearCloudroomRequestId,
} from "@/hooks/queries/cloudroom-queries";
import { CLOUD_LOCKED_REASON, showCloudSignIn, useCloudLocked } from "@/hooks/useCloudLocked";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { useIsCompactViewport } from "@cloudroom/shared-ui/hooks/use-compact-viewport";
import { ProviderRequirementBanner } from "./banner/ProviderRequirementBanner";
import { CloudClaudeStrip, useCloudClaudeMissing } from "./banner/CloudClaudeStrip";
import { CloudCapacityCard, CloudLimitCard, CloudQueueCard, FreePlanTip } from "@/components/CloudQueue";
import { OneClickScans } from "@/components/ActivationChecklist";
import { TryCloudHint } from "@/components/promptbox/TryCloudHint";
import { CloudBranchPicker } from "./CloudBranchPicker";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import {
  getPluginConfigurationRoutePath,
  getSettingsRoutePath,
} from "@/lib/route-paths";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router";
import {
  findLocalPathProjectSourceForHost,
  PERSONAL_PROJECT_ID,
  type EnvironmentMachineSelection,
  type Host,
  type JsonValue,
  type PermissionMode,
  type ProjectExecutionDefaults,
  type ReasoningLevel,
  type ServiceTier,
} from "@cloudroom/domain";
import type {
  NewThreadRequest,
  PluginEnvironmentProviderInputsChange,
} from "@get-bb/plugin-sdk";
import type {
  CreateThreadRequest,
  CreateExecutionInputSources,
  SidebarBootstrapResponse,
  SystemEnvironmentProvider,
  SystemExecutionOptionsModelLoadError,
} from "@cloudroom/server-contract";
import type { ProjectSelectorCreateProjectConfig } from "@/components/pickers/ProjectSelector";
import {
  encodeReuseValue,
  encodeProviderValue,
  parseEnvironmentValue,
} from "@/components/pickers/environment-picker-value";
import { providerInputsControlRequired } from "@/components/pickers/environment-provider-inputs";
import { useMachineProviderInputs } from "@/components/pickers/machine-provider-inputs";
import { formatModelLoadErrorText } from "@/components/pickers/model-load-error-message";
import {
  NewThreadPromptBox,
  type NewThreadPromptBoxProps,
} from "@/components/promptbox/NewThreadPromptBox";
import { useComposerTypeahead } from "@/components/thread/embedded-chat/useComposerTypeahead";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import { type PluginComposerHost } from "@/components/plugin/plugin-composer-host";
import type { ExperimentalComposerSubmitOptions } from "@get-bb/plugin-sdk";
import { newThreadEnvironmentArgsToSeed } from "@/components/plugin/new-thread-environment-seed";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import { usePluginSlots } from "@/lib/plugin-slots";
import { useUploadPromptAttachment } from "@/hooks/mutations/project-mutations";
import { useSystemEnvironmentProviders } from "@/hooks/queries/environment-provider-queries";
import { useSystemMachineProviders } from "@/hooks/queries/machine-provider-queries";
import { usePluginList } from "@/hooks/queries/plugin-settings-queries";
import {
  selectHosts,
  selectPrimaryHost,
  useHosts,
} from "@/hooks/queries/host-queries";
import { useProjectDefaultExecutionOptions } from "@/hooks/queries/project-default-execution-options-query";
import {
  stripProjectThreads,
  useProjectPromptHistory,
  type SidebarProject,
} from "@/hooks/queries/project-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import {
  usePromptDraftStorage,
  type PromptDraftScope,
} from "@/hooks/usePromptDraftStorage";
import { usePromptBoxMachinePreference } from "@/hooks/thread-creation-options/persisted-selection-fields";
import { agentExecutionTarget, saveNewThreadMachine, saveStartedMachine, startingExecutionTarget } from "@/hooks/useStartingMachine";
import { useCloudVps, vpsSummary } from "@/components/settings/VpsSettings";

const CLOUD_TARGET_KEY = "cloudroom.cloudTarget";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import type { ExecutionPermissionConfig } from "@/components/promptbox/ExecutionControls";
import { PERMISSION_MODE_OPTIONS } from "@/lib/permission-mode-options";
import { useComposerTextEffects } from "@/lib/composer-text-effects";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { promptHistoryEntriesToDrafts } from "@/lib/prompt-history";
import { usePromptHistoryEnabled } from "@/hooks/usePromptHistoryEnabled";
import {
  arePromptDraftStatesEqual,
  getProjectStoredPromptAttachmentPaths,
  isPromptDraftEmpty,
  promptDraftToInput,
  type PromptDraftAttachment,
  type PromptDraftState,
} from "@cloudroom/client-core";
import {
  getProjectComposeRoutePath,
  getThreadRoutePath,
  isProjectlessProjectId,
} from "@/lib/route-paths";
import { sdk } from "@/lib/sdk";
import { reportCloudChoice, type CloudChoiceReason } from "@/lib/upgrade-prompt";
import {
  buildReuseThreadOptions,
  resolveHostEnvironmentProvider,
  resolveRootComposeEffectiveEnvironmentValue,
} from "@/views/root-compose-environment-selection";
import { resolveRootComposeThreadEnvironment } from "@/views/root-compose-thread-environment";
import {
  MACHINE_SERVER_ACCESS_TITLE,
  machineServerAccessBlockedReason,
} from "@/components/machines/machine-server-access";

type NewThreadComposerSelectionScope = "new-thread" | "component-local";

export interface NewThreadComposerSeed {
  providerId?: string;
  model?: string;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
  permissionMode?: PermissionMode;
  environment?: NewThreadRequest["environment"];
  /** A Cloud thread's fork starts in Cloud. Making a palette starts Local. */
  executionTarget?: "local" | "cloud";
  initialPrompt?: string;
}

interface NewThreadComposerLocks {
  project?: boolean;
  provider?: boolean;
  environment?: boolean;
  baseBranch?: boolean;
}

interface NewThreadComposerPromptOptions {
  id?: string;
  placeholder?: string;
  autoFocus?: boolean;
  allowSoftKeyboardAutoFocus?: boolean;
  banner?: ReactNode;
  header?: ReactNode;
  blockedReason?: string;
  resolveMentionLink?: PromptMentionLinkResolver;
  pluginComposerHost?: PluginComposerHost;
  textEffects?: NewThreadPromptBoxProps["textEffects"];
  allowNoProject?: boolean;
  createProject?: ProjectSelectorCreateProjectConfig;
  onRequestMachineSetup?: (host: Host) => void;
  locks?: NewThreadComposerLocks;
}

type PromptDraftController = ReturnType<typeof usePromptDraftStorage>;
type ParsedEnvironment = ReturnType<typeof parseEnvironmentValue>;
type PickedDraftEnvironment =
  | { target: "cloud" }
  | {
      target: "local";
      selectionValue?: string;
      machine?: EnvironmentMachineSelection | null;
    };

export interface NewThreadComposerState {
  connectionFooter?: ReactNode;
  projectId: string;
  isProjectless: boolean;
  projects: readonly SidebarProject[] | undefined;
  sidebarNavigation: SidebarBootstrapResponse | undefined;
  sidebarNavigationError: boolean;
  currentProject: SidebarProject | undefined;
  projectSources: SidebarProject["sources"];
  connectedHostIds: ReadonlySet<string>;
  primaryHostId: string | null;
  parsedEnvironment: ParsedEnvironment;
  projectHostId: string | null;
  panelThreadId: string | null;
  selectedProviderId: string;
  promptDraft: PromptDraftController;
  focusPromptBox: () => void;
  pluginComposerHost: PluginComposerHost;
  textEffects: NewThreadPromptBoxProps["textEffects"];
  isSubmitting: boolean;
  seedEnvironmentSelectionValue: (value: string) => void;
  setEnvironmentSelectionValue: (
    value: string,
    providerHostId?: string | null,
  ) => void;
  setProviderModelReasoning: (selection: {
    providerId: string;
    model: string;
    reasoningLevel: ReasoningLevel;
    serviceTier?: ServiceTier;
  }) => void;
  setPermissionMode: (value: PermissionMode) => void;
  setServiceTier: (value: ServiceTier | undefined) => void;
  renderPromptBox: (options: NewThreadComposerPromptOptions) => ReactNode;
}

export function resolveSubmittedExecutionSources(
  environment: NewThreadRequest["environment"],
  sources: CreateExecutionInputSources,
): CreateExecutionInputSources {
  return environment.type === "provider" &&
    environment.machine?.type !== "existing"
    ? { ...sources, model: "explicit" }
    : sources;
}

export interface NewThreadComposerSubmission extends NewThreadRequest {
  pluginSubmission?: CreateThreadRequest["pluginSubmission"];
  sendAt?: number;
  cloudTarget?: "vps" | "cloud";
}

export interface NewThreadComposerProps {
  projectId: string | null;
  onProjectChange: (projectId: string) => void | Promise<void>;
  draftStorage: PromptDraftScope;
  selectionScope: NewThreadComposerSelectionScope;
  seed?: NewThreadComposerSeed;
  resetKey?: string | number | null;
  preferReadyProviderWhenUnset?: boolean;
  onSubmit: (request: NewThreadComposerSubmission) => void | Promise<void>;
  focusRequest?: number;
  children: (state: NewThreadComposerState) => ReactNode;
}

function NewThreadComposerStateRenderer({
  render,
  state,
}: {
  render: NewThreadComposerProps["children"];
  state: NewThreadComposerState;
}) {
  return render(state);
}

type ProjectDefaultsState =
  | { status: "pending" }
  | { status: "error" }
  | { status: "resolved"; defaults: ProjectExecutionDefaults | null };

export interface ResolveNewThreadSubmitDisabledReasonArgs {
  environmentProviderInputsBlocker: string | null;
  environmentSetupRequiredReason: string | null;
  isCopyingAttachments: boolean;
  isLoadingModels: boolean;
  isSubmitting: boolean;
  isUploading: boolean;
  modelLoadError: SystemExecutionOptionsModelLoadError | null;
  projectDefaultsStatus: ProjectDefaultsState["status"];
  projectDefaultsUnavailable: boolean;
  permissionChoiceRequired?: boolean;
  promptInputEmpty: boolean;
  providerDisplayName: string;
  selectedProviderId: string;
  selectedThreadModel: string;
  submissionEnvironmentUnavailable: boolean;
}

export function resolveNewThreadSubmitDisabledReason({
  environmentProviderInputsBlocker,
  environmentSetupRequiredReason,
  isCopyingAttachments,
  isLoadingModels,
  isSubmitting,
  isUploading,
  modelLoadError,
  projectDefaultsStatus,
  projectDefaultsUnavailable,
  permissionChoiceRequired = false,
  promptInputEmpty,
  providerDisplayName,
  selectedProviderId,
  selectedThreadModel,
  submissionEnvironmentUnavailable,
}: ResolveNewThreadSubmitDisabledReasonArgs): string | null {
  if (isSubmitting) return "Starting thread...";
  if (isCopyingAttachments) {
    return "Moving attachments to the selected project...";
  }
  if (isUploading) return "Uploading attachments...";
  if (projectDefaultsUnavailable) {
    return projectDefaultsStatus === "error"
      ? "Could not load the project's execution defaults."
      : "Loading the project's execution defaults...";
  }
  if (!selectedProviderId) return "Select a provider.";
  if (isLoadingModels) {
    return "Loading models from the selected machine...";
  }

  const fatalModelLoadError =
    modelLoadError?.code === "provider_unavailable" ||
    modelLoadError?.code === "missing_executable" ||
    modelLoadError?.code === "auth_required";
  if (modelLoadError && (fatalModelLoadError || !selectedThreadModel)) {
    return formatModelLoadErrorText({
      error: modelLoadError,
      providerLabel: providerDisplayName || selectedProviderId,
    });
  }
  if (!selectedThreadModel) return "Select a model.";
  if (environmentSetupRequiredReason) return environmentSetupRequiredReason;
  if (environmentProviderInputsBlocker) return environmentProviderInputsBlocker;
  if (submissionEnvironmentUnavailable) return "Select an environment.";
  if (permissionChoiceRequired) return "Choose access first.";
  if (promptInputEmpty) return "Enter a prompt or attach a file.";
  return null;
}

const PERMISSION_CHOICE_DISPLAY = {
  label: "Choose access",
  compactLabel: "Choose",
  title: "This agent no longer offers the project's saved mode. Choose one to send.",
};
const UNOFFERED_PERMISSION_MODE_REASON =
  "This agent no longer offers it: a repo can skip its approvals.";

/**
 * The project's saved mode when this start would use it but its agent no longer offers it (Manual for OpenCode).
 * The server refuses that start, and moving to Full unseen would drop the user's Manual, so the composer asks
 * for a mode instead (#2166). Null when the start sends its own mode or the agent offers the saved one.
 */
export function resolveUnofferedProjectPermissionMode({
  offeredModes,
  projectDefaults,
  providerId,
  sendsPermissionMode,
}: {
  offeredModes: readonly PermissionMode[];
  projectDefaults: ProjectExecutionDefaults | null | undefined;
  providerId: string;
  sendsPermissionMode: boolean;
}): PermissionMode | null {
  if (
    sendsPermissionMode ||
    !projectDefaults ||
    projectDefaults.providerId !== providerId ||
    offeredModes.includes(projectDefaults.permissionMode)
  ) {
    return null;
  }
  return projectDefaults.permissionMode;
}

type NewThreadPermissionOptions = Pick<
  ReturnType<typeof useThreadCreationOptions>,
  | "executionInputSources"
  | "permissionMode"
  | "permissionModeIsVerified"
  | "permissionModeOptions"
  | "permissionModePicked"
  | "selectedProviderId"
  | "setPermissionMode"
  | "supportsPermissionModeSelection"
>;

/**
 * The new-thread access picker. While the project's saved mode is one the agent no longer offers, it shows that
 * mode disabled under "Choose access", and a pick counts even when it is the mode already shown (#2166).
 * Only live options decide that: a cached provider list can be out of date, so while it shows, this acts as main.
 */
export function useNewThreadPermissionControl({
  executionTarget,
  options,
  projectDefaults,
  seedPermissionMode,
  snapshot,
}: {
  executionTarget: "local" | "cloud";
  options: NewThreadPermissionOptions;
  projectDefaults: ProjectExecutionDefaults | null | undefined;
  seedPermissionMode: PermissionMode | undefined;
  snapshot: () => void;
}): { permission: ExecutionPermissionConfig; permissionChoiceRequired: boolean } {
  const unofferedMode =
    executionTarget === "local" && options.permissionModeIsVerified
      ? resolveUnofferedProjectPermissionMode({
          offeredModes: options.permissionModeOptions.map((option) => option.value),
          projectDefaults,
          providerId: options.selectedProviderId,
          // A plugin composer forces every source explicit once any field changes; only a real pick counts.
          sendsPermissionMode:
            (options.executionInputSources.permissionMode === "explicit"
              ? options.permissionModePicked
              : options.executionInputSources.permissionMode !== undefined) ||
            seedPermissionMode !== undefined,
        })
      : null;
  const onChange = useDraftPreservingOptionChange(
    options.permissionMode,
    options.setPermissionMode,
    snapshot,
    unofferedMode !== null,
  );
  const { permissionMode, permissionModeOptions, supportsPermissionModeSelection } = options;
  const permission = useMemo((): ExecutionPermissionConfig => {
    const unoffered = PERMISSION_MODE_OPTIONS.find((option) => option.value === unofferedMode);
    return unoffered
      ? {
          value: unoffered.value,
          options: [
            { ...unoffered, disabled: true, disabledReason: UNOFFERED_PERMISSION_MODE_REASON },
            ...permissionModeOptions,
          ],
          onChange,
          supported: true,
          displayOverride: PERMISSION_CHOICE_DISPLAY,
        }
      : {
          value: executionTarget === "cloud" ? "full" : permissionMode,
          options: permissionModeOptions,
          onChange,
          supported: executionTarget === "local" && supportsPermissionModeSelection,
        };
  }, [executionTarget, onChange, permissionMode, permissionModeOptions, supportsPermissionModeSelection, unofferedMode]);
  return { permission, permissionChoiceRequired: unofferedMode !== null };
}

export function resolveNewThreadProjectDefaultsState({
  cachedDefaults,
  projectFound,
  queryData,
  queryIsError,
  queryIsPlaceholderData,
  queryIsSuccess,
}: {
  cachedDefaults: ProjectExecutionDefaults | null | undefined;
  projectFound: boolean;
  queryData: ProjectExecutionDefaults | null | undefined;
  queryIsError: boolean;
  queryIsPlaceholderData: boolean;
  queryIsSuccess: boolean;
}): ProjectDefaultsState {
  if (cachedDefaults !== null && cachedDefaults !== undefined) {
    return { status: "resolved", defaults: cachedDefaults };
  }
  if (!projectFound) return { status: "pending" };
  if (queryIsSuccess && !queryIsPlaceholderData) {
    return { status: "resolved", defaults: queryData ?? null };
  }
  return queryIsError ? { status: "error" } : { status: "pending" };
}

export function mergeMissingPromptDraftAttachments(
  currentAttachments: readonly PromptDraftAttachment[],
  preservedAttachments: readonly PromptDraftAttachment[],
): PromptDraftAttachment[] | null {
  const existingPaths = new Set(
    currentAttachments.map((attachment) => attachment.path),
  );
  const missingAttachments = preservedAttachments.filter(
    (attachment) => !existingPaths.has(attachment.path),
  );
  return missingAttachments.length === 0
    ? null
    : [...currentAttachments, ...missingAttachments];
}

export function restorePromptDraftAfterOptionChange({
  currentDraft,
  preservedDraft,
}: {
  currentDraft: PromptDraftState;
  preservedDraft: PromptDraftState | null;
}): PromptDraftState | null {
  if (
    preservedDraft === null ||
    arePromptDraftStatesEqual(currentDraft, preservedDraft)
  ) {
    return null;
  }

  let restoredDraft = currentDraft;
  let changed = false;
  if (isPromptDraftEmpty(currentDraft) && !isPromptDraftEmpty(preservedDraft)) {
    restoredDraft = preservedDraft;
    changed = true;
  } else if (
    currentDraft.text === preservedDraft.text &&
    currentDraft.mentions !== preservedDraft.mentions &&
    JSON.stringify(currentDraft.mentions) !==
      JSON.stringify(preservedDraft.mentions)
  ) {
    restoredDraft = { ...restoredDraft, mentions: preservedDraft.mentions };
    changed = true;
  }

  const mergedAttachments = mergeMissingPromptDraftAttachments(
    restoredDraft.attachments,
    preservedDraft.attachments,
  );
  if (mergedAttachments !== null) {
    restoredDraft = { ...restoredDraft, attachments: mergedAttachments };
    changed = true;
  }
  return changed ? restoredDraft : null;
}

export function useDraftPreservingOptionChange<T>(
  current: T,
  setValue: (value: T) => void,
  snapshot: () => void,
  recordUnchanged = false,
): (value: T) => void {
  return useCallback(
    (value: T) => {
      const changed = !Object.is(current, value);
      if (!changed && !recordUnchanged) return;
      if (changed) snapshot();
      setValue(value);
    },
    [current, recordUnchanged, setValue, snapshot],
  );
}

function resolvePanelThreadId(
  environmentId: string | null,
  reuseThreadOptions: ReturnType<typeof buildReuseThreadOptions>,
): string | null {
  if (environmentId === null) return null;
  return (
    reuseThreadOptions.find((option) => option.environmentId === environmentId)
      ?.threads[0]?.id ?? null
  );
}

const SELECT_CLOUD_EVENT = "cloudroom:select-cloud";
export function selectCloudForNewThreads() {
  saveStartedMachine("cloud");
  window.dispatchEvent(new Event(SELECT_CLOUD_EVENT));
}

export function NewThreadComposer({
  projectId: requestedProjectId,
  onProjectChange,
  draftStorage,
  selectionScope,
  seed,
  resetKey,
  preferReadyProviderWhenUnset = false,
  onSubmit,
  focusRequest,
  children,
}: NewThreadComposerProps) {
  const navigate = useNavigate();
  const cloudConnection = useCloudroomConnection();
  const cloudLocked = useCloudLocked();
  const [storedExecutionTarget, setExecutionTarget] = useState<
    "local" | "cloud"
  >(
    () =>
      seed?.executionTarget ??
      (seed?.environment !== undefined
        ? "local"
        : startingExecutionTarget(selectionScope === "new-thread", requestedProjectId ?? PERSONAL_PROJECT_ID)),
  );
  const [cloudPicked, setCloudPicked] = useState(
    seed?.executionTarget === "cloud",
  );
  // Tracks an intentional environment pick in this draft so switching projects keeps it.
  const [pickedEnvironment, setPickedEnvironment] =
    useState<PickedDraftEnvironment | null>(null);
  const pickRevisionRef = useRef(0);
  const setUserPickedEnvironment = useCallback(
    (next: PickedDraftEnvironment | null) => {
      pickRevisionRef.current += 1;
      setPickedEnvironment(next);
    },
    [],
  );
  const vps = useCloudVps();
  const vpsConnected = vps.data?.connected === true;
  const [cloudTarget, setCloudTarget] = useState<"vps" | "cloud" | null>(() => {
    const saved = localStorage.getItem(CLOUD_TARGET_KEY);
    return saved === "vps" || saved === "cloud" ? saved : null;
  });
  const wantedCloudTarget = !vpsConnected ? "cloud" : cloudTarget ?? (vps.data?.useForCloud ? "vps" : "cloud");
  const vpsBusy = vpsConnected && (vps.data?.health === null || vps.data?.busy != null);
  const landsOnVps = wantedCloudTarget === "vps" && !(vpsBusy && vps.data?.fallback);
  const pickCloudTarget = (target: "vps" | "cloud") => {
    setCloudTarget(target);
    localStorage.setItem(CLOUD_TARGET_KEY, target);
  };
  const [cloudBranch, setCloudBranch] = useState<{
    projectId: string | null;
    branch: string | null;
  }>({ projectId: null, branch: null });
  useEffect(() => {
    const selectCloud = () => {
      setExecutionTarget("cloud");
      setUserPickedEnvironment(null);
    };
    window.addEventListener(SELECT_CLOUD_EVENT, selectCloud);
    return () => window.removeEventListener(SELECT_CLOUD_EVENT, selectCloud);
  }, [setUserPickedEnvironment]);
  const [localPromptBoxFocusRequest, setLocalPromptBoxFocusRequest] = useState<
    number | null
  >(null);
  const promptBoxFocusRequest =
    focusRequest === undefined && localPromptBoxFocusRequest === null
      ? undefined
      : `${focusRequest ?? ""}:${localPromptBoxFocusRequest ?? ""}`;

  const sidebarNavigationQuery = useSidebarNavigation();
  const projects = useMemo(
    () => sidebarNavigationQuery.data?.projects.map(stripProjectThreads),
    [sidebarNavigationQuery.data],
  );
  const requestedCandidate = requestedProjectId ?? PERSONAL_PROJECT_ID;
  const candidateKnown =
    isProjectlessProjectId(requestedCandidate) ||
    (projects?.some((project) => project.id === requestedCandidate) ?? false);
  const replayKnowsCandidate =
    !sidebarNavigationQuery.isPlaceholderData || candidateKnown;
  const sidebarNavigationSettled =
    sidebarNavigationQuery.isError ||
    (sidebarNavigationQuery.isSuccess && replayKnowsCandidate);
  const projectId = useMemo(() => {
    if (isProjectlessProjectId(requestedCandidate)) return PERSONAL_PROJECT_ID;
    if (!projects || !replayKnowsCandidate) return requestedCandidate;
    return candidateKnown ? requestedCandidate : PERSONAL_PROJECT_ID;
  }, [candidateKnown, projects, replayKnowsCandidate, requestedCandidate]);
  const isProjectless = isProjectlessProjectId(projectId);
  const currentProject = useMemo(() => {
    if (isProjectless) {
      const personalProject = sidebarNavigationQuery.data?.personalProject;
      return personalProject ? stripProjectThreads(personalProject) : undefined;
    }
    return projects?.find((project) => project.id === projectId);
  }, [isProjectless, projectId, projects, sidebarNavigationQuery.data]);
  const projectSources = useMemo(
    () => currentProject?.sources ?? [],
    [currentProject?.sources],
  );
  const projectOptions = useMemo(
    () =>
      sidebarNavigationQuery.data?.projects.map(({ id, name, updatedAt, threads }) => ({
        id,
        name,
        // Its newest thread: the picker lists recently used projects first.
        updatedAt: Math.max(updatedAt, ...threads.map((thread) => thread.updatedAt)),
      })) ?? [],
    [sidebarNavigationQuery.data],
  );

  const hostsQuery = useHosts();
  const availableHosts = useMemo(
    () => selectHosts(hostsQuery.data, "persistent"),
    [hostsQuery.data],
  );
  const systemConfigQuery = useSystemConfig();
  const primaryHostId =
    selectPrimaryHost(
      availableHosts,
      systemConfigQuery.data?.primaryHostId ?? null,
    )?.id ?? null;
  const knownHostIds = useMemo(
    () => new Set(availableHosts.map((host) => host.id)),
    [availableHosts],
  );
  const connectedHostIds = useMemo(
    () =>
      new Set(
        availableHosts
          .filter((host) => host.status === "connected")
          .map((host) => host.id),
      ),
    [availableHosts],
  );
  const worktreeHostNameById = useMemo(() => {
    const hosts = availableHosts;
    return hosts.length <= 1
      ? null
      : new Map(hosts.map((host) => [host.id, host.name]));
  }, [availableHosts]);
  const projectThreads = useMemo(() => {
    const navigation = sidebarNavigationQuery.data;
    if (!navigation) return undefined;
    if (isProjectless) return navigation.personalProject.threads;
    return navigation.projects.find((project) => project.id === projectId)
      ?.threads;
  }, [isProjectless, projectId, sidebarNavigationQuery.data]);
  const reuseThreadOptionsLoading =
    projectThreads === undefined && !sidebarNavigationSettled;
  const reuseThreadOptions = useMemo(
    () => buildReuseThreadOptions(projectThreads ?? [], worktreeHostNameById),
    [projectThreads, worktreeHostNameById],
  );

  const { providers: registeredEnvironmentProviders } =
    useSystemEnvironmentProviders();
  const environmentProviders = useMemo(
    () =>
      registeredEnvironmentProviders?.filter((provider) =>
        isProjectless
          ? !provider.requires.projectCheckout && !provider.requires.gitRemote
          : !provider.requires.projectless,
      ),
    [isProjectless, registeredEnvironmentProviders],
  );
  const { providers: projectEnvironmentProviders } =
    useSystemEnvironmentProviders({ projectId });
  const projectGitRemoteUrl = currentProject?.gitRemoteUrl;
  // Uploaded folders have no remote branches in Cloud.
  const gitlabProject = Boolean(gitlabRepository(projectGitRemoteUrl));
  const cloudBranchPickerShown =
    !isProjectless && (gitlabProject || /github\.com[/:]/.test(projectGitRemoteUrl ?? ""));
  const cloudBaseBranch =
    cloudBranchPickerShown && cloudBranch.projectId === projectId
      ? cloudBranch.branch
      : null;
  const environmentProvidersByHostId = useMemo(
    () =>
      new Map(
        availableHosts.map((host) => [
          host.id,
          (environmentProviders ?? [])
            .filter(
              (provider) =>
                !provider.machineProviderId &&
                // A project with a Git remote is cloned onto the machine on first use.
                (!(
                  provider.requires.projectCheckout ||
                  provider.requires.gitCheckout
                ) ||
                  findLocalPathProjectSourceForHost(projectSources, host.id) !==
                    undefined ||
                  projectGitRemoteUrl != null) &&
                (!provider.requires.gitRemote || projectGitRemoteUrl != null),
            )
            .map((provider) => ({
              ...provider,
              availability:
                projectEnvironmentProviders?.find(
                  (candidate) => candidate.id === provider.id,
                )?.machineAvailability[host.id] ?? null,
            })),
        ]),
      ),
    [
      availableHosts,
      environmentProviders,
      projectEnvironmentProviders,
      projectGitRemoteUrl,
      projectSources,
    ],
  );
  const { providers: machineProviders } = useSystemMachineProviders();
  const pluginList = usePluginList({ enabled: true });

  const composerSeedSignature = JSON.stringify([
    draftStorage,
    resetKey ?? null,
    seed?.providerId ?? null,
    seed?.model ?? null,
    seed?.reasoningLevel ?? null,
    seed?.serviceTier ?? null,
    seed?.permissionMode ?? null,
    seed?.environment ?? null,
    seed?.executionTarget ?? null,
  ]);
  const environmentSeed = useMemo(
    () =>
      seed?.environment === undefined
        ? null
        : newThreadEnvironmentArgsToSeed(seed.environment),
    [seed?.environment],
  );
  const { value: storedMachineId, setValue: setStoredMachineId } =
    usePromptBoxMachinePreference(projectId);
  const [activeComposerSeedSignature, setActiveComposerSeedSignature] =
    useState(composerSeedSignature);
  const [activeProjectId, setActiveProjectId] = useState(projectId);
  const [seedOverridden, setBranchSeedOverridden] = useState(false);
  const [pickedProviderMachine, setPickedProviderMachine] = useState<{
    selectionValue: string;
    machine: EnvironmentMachineSelection;
  } | null>(null);
  if (activeComposerSeedSignature !== composerSeedSignature) {
    const projectChanged = activeProjectId !== projectId;
    setActiveComposerSeedSignature(composerSeedSignature);
    setActiveProjectId(projectId);
    setBranchSeedOverridden(false);
    setPickedProviderMachine(null);
    setPickedEnvironment(null);
    if (seed?.executionTarget) setExecutionTarget(seed.executionTarget);
    else if (seed?.environment !== undefined) setExecutionTarget("local");
    else if (projectChanged && selectionScope === "new-thread") {
      setExecutionTarget(startingExecutionTarget(true, projectId));
    }
    setCloudPicked(seed?.executionTarget === "cloud");
  } else if (activeProjectId !== projectId) {
    setActiveProjectId(projectId);
    // Keep the previous project's seeded checkout path/branch from leaking onto the newly picked project.
    setBranchSeedOverridden(true);
    setPickedProviderMachine(null);
    if (pickedEnvironment === null) {
      if (
        selectionScope === "new-thread" &&
        seed?.executionTarget === undefined &&
        seed?.environment === undefined
      ) {
        setExecutionTarget(startingExecutionTarget(true, projectId));
        setCloudPicked(false);
      } else {
        if (seed?.executionTarget) setExecutionTarget(seed.executionTarget);
        else if (seed?.environment !== undefined) setExecutionTarget("local");
        setCloudPicked(seed?.executionTarget === "cloud");
      }
    }
  }

  const resolveProviderSelection = useCallback(
    (
      effectiveValue: string,
    ): {
      provider: SystemEnvironmentProvider;
      machine: EnvironmentMachineSelection | null;
    } | null => {
      const parsedValue = parseEnvironmentValue(effectiveValue);
      if (parsedValue?.type !== "provider") return null;
      const provider = environmentProviders?.find(
        (candidate) => candidate.id === parsedValue.environmentProviderId,
      );
      if (provider === undefined) return null;
      if (provider.machineProviderId) return { provider, machine: null };
      const usable = (hostId: string | null): boolean =>
        hostId !== null &&
        knownHostIds.has(hostId) &&
        (environmentProvidersByHostId
          .get(hostId)
          ?.some(
            (candidate) =>
              candidate.id === provider.id &&
              candidate.availability?.status !== "unavailable",
          ) ??
          false);
      const picked =
        pickedProviderMachine?.selectionValue === effectiveValue
          ? pickedProviderMachine.machine
          : null;
      if (picked !== null) return { provider, machine: picked };
      const carried =
        pickedEnvironment?.target === "local" &&
        pickedEnvironment.selectionValue === effectiveValue
          ? (pickedEnvironment.machine ?? null)
          : null;
      if (
        carried !== null &&
        (carried.type === "new" || knownHostIds.has(carried.hostId))
      ) {
        return { provider, machine: carried };
      }
      const seeded =
        !seedOverridden &&
        environmentSeed !== null &&
        environmentSeed.selectionValue === effectiveValue
          ? environmentSeed.providerMachine
          : null;
      const remembered: EnvironmentMachineSelection | null =
        selectionScope === "new-thread" && storedMachineId !== ""
          ? { type: "existing", hostId: storedMachineId }
          : null;
      const candidate = seeded ?? remembered;
      if (candidate?.type === "new") return { provider, machine: candidate };
      if (usable(candidate?.hostId ?? null)) {
        return { provider, machine: candidate };
      }
      const usableHostIds = [
        primaryHostId,
        ...availableHosts
          .filter((host) => connectedHostIds.has(host.id))
          .map((host) => host.id),
      ].filter((hostId): hostId is string => usable(hostId));
      const fallbackHostId =
        usableHostIds.find(
          (hostId) =>
            findLocalPathProjectSourceForHost(projectSources, hostId) !==
            undefined,
        ) ??
        usableHostIds[0] ??
        null;
      return {
        provider,
        machine:
          fallbackHostId === null
            ? null
            : { type: "existing", hostId: fallbackHostId },
      };
    },
    [
      availableHosts,
      connectedHostIds,
      projectSources,
      seedOverridden,
      environmentSeed,
      environmentProviders,
      environmentProvidersByHostId,
      knownHostIds,
      pickedEnvironment,
      pickedProviderMachine,
      selectionScope,
      storedMachineId,
      primaryHostId,
    ],
  );

  const resolveProviderRouting = useCallback(
    (environmentSelectionValue: string, providerId: string) => {
      const effectiveValue = resolveRootComposeEffectiveEnvironmentValue({
        environmentSelectionValue:
          pickedEnvironment?.target === "local" &&
          pickedEnvironment.selectionValue !== undefined
            ? pickedEnvironment.selectionValue
            : environmentSelectionValue,
        environmentProviders,
        isProjectless,
        knownHostIds,
        connectedHostIds,
        primaryHostId,
        projectGitRemoteUrl,
        projectSources,
        reuseThreadOptions,
        reuseThreadOptionsLoading,
      });
      const providerSelection = resolveProviderSelection(effectiveValue);
      if (providerSelection !== null) {
        if (providerSelection.machine?.type !== "existing") return {};
        const { hostId } = providerSelection.machine;
        // A Local thread lists where thread create checks its model, so a project's opencode.json applies (#1236).
        // A Cloud thread keeps this machine's list: the local project's config doesn't run there.
        const local =
          cloudLocked ||
          agentExecutionTarget(
            storedExecutionTarget,
            cloudPicked,
            providerId,
          ) === "local";
        return local ? { hostId, projectId } : { hostId };
      }
      const parsed = parseEnvironmentValue(effectiveValue);
      return parsed?.type === "reuse" && parsed.environmentId !== null
        ? { environmentId: parsed.environmentId }
        : {};
    },
    [
      cloudLocked,
      cloudPicked,
      connectedHostIds,
      environmentProviders,
      isProjectless,
      knownHostIds,
      pickedEnvironment,
      primaryHostId,
      projectGitRemoteUrl,
      projectId,
      projectSources,
      resolveProviderSelection,
      reuseThreadOptions,
      reuseThreadOptionsLoading,
      storedExecutionTarget,
    ],
  );
  const projectDefaultsQuery = useProjectDefaultExecutionOptions(
    { projectId },
    {
      enabled:
        currentProject !== undefined &&
        currentProject.defaultExecutionOptions === null,
    },
  );
  const projectDefaultsState = resolveNewThreadProjectDefaultsState({
    cachedDefaults: currentProject?.defaultExecutionOptions,
    projectFound: currentProject !== undefined,
    queryData: projectDefaultsQuery.data,
    queryIsError: projectDefaultsQuery.isError,
    queryIsPlaceholderData: projectDefaultsQuery.isPlaceholderData,
    queryIsSuccess: projectDefaultsQuery.isSuccess,
  });
  const isCompactViewport = useIsCompactViewport();
  const projectDefaults =
    projectDefaultsState.status === "resolved"
      ? projectDefaultsState.defaults
      : undefined;
  const projectDefaultsUnavailable =
    projectDefaultsState.status !== "resolved" &&
    (seed?.providerId === undefined ||
      seed?.model === undefined ||
      seed?.reasoningLevel === undefined ||
      seed?.permissionMode === undefined);
  const creationOptions = useThreadCreationOptions({
    cloud: !cloudLocked && storedExecutionTarget === "cloud",
    scope: selectionScope,
    preferenceProjectId: projectId,
    resetKey: `${projectId}\0${composerSeedSignature}`,
    resolveProviderRouting,
    initialProviderId: seed?.providerId ?? projectDefaults?.providerId,
    preferReadyProviderWhenUnset:
      preferReadyProviderWhenUnset && projectDefaults === null,
    initialModel: seed?.model ?? projectDefaults?.model,
    initialServiceTier: seed?.serviceTier ?? projectDefaults?.serviceTier,
    initialReasoningLevel:
      seed?.reasoningLevel ??
      (isCompactViewport ? "high" : projectDefaults?.reasoningLevel),
    initialPermissionMode:
      seed?.permissionMode ?? projectDefaults?.permissionMode,
    initialEnvironmentSelectionValue: environmentSeed?.selectionValue,
  });
  const {
    activeModel,
    executionInputSources,
    executionOptionsRouting,
    environmentSelectionValue,
    hasMultipleProviders,
    isLoadingModels,
    modelLoadError,
    modelLoadFailed,
    modelOptions,
    moreModelOptions,
    permissionMode,
    providerOptions,
    reasoningLevel,
    reasoningOptions,
    selectedModel,
    selectedProviderComposerActions,
    selectedProviderDisplayName,
    selectedProviderId,
    serviceTier,
    serviceTierSupportByProvider,
    serviceTierFastLabel,
    setEnvironmentSelectionValue: setCreationEnvironmentSelectionValue,
    setPermissionMode,
    setProviderModelReasoning,
    setReasoningLevel,
    setSelectedModel,
    setSelectedProviderId,
    setServiceTier,
    supportsServiceTier,
    supportsUltraFast,
    clearReuseEnvironment,
  } = creationOptions;
  const executionTarget = cloudLocked
    ? "local"
    : agentExecutionTarget(storedExecutionTarget, cloudPicked, selectedProviderId);
  useEffect(() => {
    if (executionTarget !== "cloud" || !cloudConnection.data?.ready) return;
    const select = () => void fetchWithAppSurface("/api/v1/cloudroom/account/project", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId }),
    }).catch(() => {});
    select();
    const timer = setInterval(() => { if (document.visibilityState === "visible") select(); }, 5 * 60_000);
    return () => clearInterval(timer);
  }, [executionTarget, projectId, cloudConnection.data?.ready]);
  const selectedThreadModel = activeModel?.model ?? selectedModel;
  const cloudLevels = cloudReasoningLevels(cloudConnection.data, selectedProviderId, selectedThreadModel);
  const cloudFastSupported = executionTarget === "cloud" && cloudServiceTierSupported(cloudConnection.data, selectedProviderId);
  // Cloud runs Ultra Fast only when its Core lists it for the model; otherwise the thread starts at standard speed.
  const ultraFast = supportsUltraFast && (executionTarget !== "cloud" || cloudUltraFastSupported(cloudConnection.data, selectedProviderId, selectedThreadModel));
  const threadTier = serviceTier === "ultrafast" && !ultraFast ? "default" : serviceTier;
  const cloudKnown = executionTarget === "cloud" && cloudCatalogKnown(cloudConnection.data);
  // The cloud queue (docs/scopes/public-launch.md): the card under the composer explains, and Send waits.
  const cloudQueue = executionTarget === "cloud" && !landsOnVps ? cloudConnection.data?.cloudQueue ?? null : null;
  // Metal low-capacity reserve (ADR 20261124-103714): show the banner clearly when this tier's new starts wait.
  const cloudCapacity = executionTarget === "cloud" && !landsOnVps && !cloudQueue ? cloudConnection.data?.cloudCapacity ?? null : null;
  // Free's Cloud used up (David, 2026-11-26): warn before the send, with Local one click away.
  const cloudLimit = executionTarget === "cloud" && !landsOnVps && !cloudQueue && !cloudCapacity ? cloudConnection.data?.cloudLimit ?? null : null;
  const agyCloud = executionTarget === "cloud" && selectedProviderId === "acp-antigravity";
  const agyLogin = useAntigravityCloud(agyCloud && !cloudConnection.data?.selfHosted);
  const agyState = agyCloud ? antigravityCloudState(cloudConnection, agyLogin) : "ready";
  const agyNeedsLogin = agyState !== "ready";
  const cloudAgentMissing = cloudKnown && !cloudHarness(cloudConnection.data, selectedProviderId);
  // Most first Cloud prompts that failed were Claude Code with no Claude login anywhere: the strip in the composer says so first.
  const claudeMissing = useCloudClaudeMissing(executionTarget === "cloud" && !vps.isLoading && !vps.isError && !landsOnVps && !cloudQueue && !cloudAgentMissing && selectedProviderId === "claude-code");
  const cloudChoiceReason: CloudChoiceReason | null = cloudLocked
    ? "signed_out"
    : storedExecutionTarget === "cloud" && executionTarget === "local"
      ? "agent_unsupported"
      : cloudAgentMissing
        ? "agent_not_in_cloud"
        : claudeMissing
          ? "claude_not_connected"
          : cloudQueue
            ? cloudQueue.regionBlocked ? "region" : "queue"
            : null;
  const cloudChoiceAction = selectionScope !== "new-thread" || cloudChoiceReason === null
    ? null
    : executionTarget === "cloud"
      ? "cloud_blocked"
      : storedExecutionTarget === "cloud"
        ? "forced_local"
        : null;
  useEffect(() => {
    if (cloudChoiceAction) reportCloudChoice(cloudChoiceAction, cloudChoiceReason);
  }, [cloudChoiceAction, cloudChoiceReason]);
  // Sandboxes upgrade to the Mac's harness version before the agent starts (ADR 0133), so a model the saved cloud
  // catalog lacks, such as one released today, keeps the Mac's levels; Core still rejects an unsupported one.
  const cloudFiltered = cloudKnown && cloudLevels.length > 0;
  const availableReasoningOptions = cloudFiltered ? reasoningOptions.filter((option) => cloudLevels.includes(option.value)) : reasoningOptions;
  const cloudOpenCodeModelsRef =
    executionTarget === "cloud" && selectedProviderId === "acp-opencode"
      ? cloudOpenCodeCatalog(cloudConnection.data)
      : null;
  const partitionedCloudModels = useMemo(
    () =>
      partitionCloudOpenCodeModelOptions(
        [...modelOptions, ...moreModelOptions],
        cloudOpenCodeModelsRef,
      ),
    [modelOptions, moreModelOptions, cloudOpenCodeModelsRef],
  );
  const effectiveModelOptions = partitionedCloudModels?.primary ?? modelOptions;
  const effectiveMoreModelOptions = partitionedCloudModels?.more ?? moreModelOptions;
  const cloudOpenCodeIssue = useMemo(
    () => cloudOpenCodeModelIssue(cloudOpenCodeModelsRef, selectedThreadModel),
    [cloudOpenCodeModelsRef, selectedThreadModel],
  );

  const promptDraft = usePromptDraftStorage(draftStorage);
  const textEffects = useComposerTextEffects(promptDraft.storageKey);
  const promptOptionDraftSnapshotRef = useRef<PromptDraftState | null>(null);
  const snapshotDraftBeforeOptionChange = useCallback(() => {
    const currentDraft = promptDraft.getCurrent();
    promptOptionDraftSnapshotRef.current = isPromptDraftEmpty(currentDraft)
      ? null
      : currentDraft;
  }, [promptDraft]);
  useEffect(() => {
    const preservedDraft = promptOptionDraftSnapshotRef.current;
    if (preservedDraft === null) return;
    promptOptionDraftSnapshotRef.current = null;
    const restoredDraft = restorePromptDraftAfterOptionChange({
      currentDraft: promptDraft.getCurrent(),
      preservedDraft,
    });
    if (restoredDraft !== null) promptDraft.setDraft(restoredDraft);
  });

  const activeEnvironmentSelectionValue =
    pickedEnvironment?.target === "local" &&
    pickedEnvironment.selectionValue !== undefined
      ? pickedEnvironment.selectionValue
      : environmentSelectionValue;
  const changeEnvironment = useCallback(
    (
      value: string,
      providerTarget: string | EnvironmentMachineSelection | null = null,
    ) => {
      const providerMachine =
        typeof providerTarget === "string"
          ? { type: "existing" as const, hostId: providerTarget }
          : providerTarget;
      const isProviderSelection =
        parseEnvironmentValue(value)?.type === "provider";
      if (isProviderSelection) {
        setExecutionTarget("local");
        setCloudPicked(false);
        setUserPickedEnvironment({
          target: "local",
          selectionValue: value,
          machine: providerMachine,
        });
      }
      const currentProviderMachine =
        pickedProviderMachine?.selectionValue === value
          ? pickedProviderMachine.machine
          : null;
      if (
        Object.is(activeEnvironmentSelectionValue, value) &&
        JSON.stringify(providerMachine) ===
          JSON.stringify(currentProviderMachine)
      ) {
        return;
      }
      snapshotDraftBeforeOptionChange();
      setBranchSeedOverridden(true);
      setPickedProviderMachine(
        providerMachine === null
          ? null
          : { selectionValue: value, machine: providerMachine },
      );
      if (selectionScope === "new-thread" && isProviderSelection) {
        setStoredMachineId(
          providerMachine?.type === "existing" ? providerMachine.hostId : "",
        );
      }
      setCreationEnvironmentSelectionValue(value);
    },
    [
      activeEnvironmentSelectionValue,
      pickedProviderMachine,
      setCreationEnvironmentSelectionValue,
      selectionScope,
      setStoredMachineId,
      setUserPickedEnvironment,
      snapshotDraftBeforeOptionChange,
    ],
  );
  const seedEnvironmentSelectionValue = useCallback(
    (value: string) => {
      setUserPickedEnvironment(null);
      setCreationEnvironmentSelectionValue(value);
    },
    [setCreationEnvironmentSelectionValue, setUserPickedEnvironment],
  );
  const effectiveEnvironmentValue = useMemo(
    () =>
      resolveRootComposeEffectiveEnvironmentValue({
        environmentSelectionValue: activeEnvironmentSelectionValue,
        environmentProviders,
        isProjectless,
        knownHostIds,
        connectedHostIds,
        primaryHostId,
        projectGitRemoteUrl,
        projectSources,
        reuseThreadOptions,
        reuseThreadOptionsLoading,
      }),
    [
      activeEnvironmentSelectionValue,
      connectedHostIds,
      environmentProviders,
      isProjectless,
      knownHostIds,
      primaryHostId,
      projectGitRemoteUrl,
      projectSources,
      reuseThreadOptions,
      reuseThreadOptionsLoading,
    ],
  );
  const parsedEnvironment = useMemo(
    () => parseEnvironmentValue(effectiveEnvironmentValue),
    [effectiveEnvironmentValue],
  );
  const providerSelection = useMemo(
    () => resolveProviderSelection(effectiveEnvironmentValue),
    [effectiveEnvironmentValue, resolveProviderSelection],
  );
  const selectedEnvironmentProvider = providerSelection?.provider;
  const inputEnvironmentProvider =
    selectedEnvironmentProvider?.environmentProviderId
      ? environmentProviders?.find(
          (provider) =>
            provider.id === selectedEnvironmentProvider.environmentProviderId,
        )
      : selectedEnvironmentProvider;
  const providerMachine = providerSelection?.machine ?? null;
  const providerHostId =
    providerMachine?.type === "existing" ? providerMachine.hostId : null;
  const selectedProviderMachineUnavailable =
    providerHostId !== null &&
    !(
      environmentProvidersByHostId
        .get(providerHostId)
        ?.some(
          (provider) =>
            provider.id === selectedEnvironmentProvider?.id &&
            provider.availability?.status !== "unavailable",
        ) ?? false
    );
  const selectCloudTarget = useCallback(() => {
    if (cloudLocked) return showCloudSignIn();
    snapshotDraftBeforeOptionChange();
    setExecutionTarget("cloud");
    setCloudPicked(true);
    setUserPickedEnvironment({ target: "cloud" });
  }, [cloudLocked, setUserPickedEnvironment, snapshotDraftBeforeOptionChange]);
  const handleSelectProvider = useCallback(
    (provider: SystemEnvironmentProvider, hostId: string | null) => {
      if (selectionScope === "new-thread" && executionTarget === "cloud") reportCloudChoice("picked_local", cloudChoiceReason);
      changeEnvironment(
        encodeProviderValue(provider.id),
        hostId === null ? null : { type: "existing" as const, hostId },
      );
    },
    [changeEnvironment, selectionScope, executionTarget, cloudChoiceReason],
  );
  const handleSelectHost = useCallback(
    (hostId: string) => {
      const provider = resolveHostEnvironmentProvider({
        currentProvider: selectedEnvironmentProvider ?? null,
        providers: environmentProvidersByHostId.get(hostId) ?? [],
      });
      if (provider === null) return;
      changeEnvironment(encodeProviderValue(provider.id), {
        type: "existing" as const,
        hostId,
      });
    },
    [
      changeEnvironment,
      environmentProvidersByHostId,
      selectedEnvironmentProvider,
    ],
  );
  const selectedMachineProvider =
    providerMachine?.type === "new"
      ? machineProviders?.find(
          (provider) => provider.id === providerMachine.machineProviderId,
        )
      : undefined;
  const configurationMachineProvider =
    selectedMachineProvider ??
    (selectedEnvironmentProvider?.machineProviderId === null ||
    selectedEnvironmentProvider?.machineProviderId === undefined
      ? undefined
      : machineProviders?.find(
          (provider) =>
            provider.id === selectedEnvironmentProvider.machineProviderId,
        ));
  const configurationPlugin =
    configurationMachineProvider === undefined
      ? undefined
      : pluginList.data?.plugins.find(
          (plugin) => plugin.id === configurationMachineProvider.pluginId,
        );
  const setupRequiredProvider =
    configurationPlugin?.status === "needs-configuration" &&
    configurationMachineProvider !== undefined
      ? configurationMachineProvider
      : null;
  const environmentSetupRequiredReason =
    setupRequiredProvider === null
      ? null
      : (configurationPlugin?.statusDetail ??
        `${setupRequiredProvider.displayName} needs setting up.`);
  const serverAccess = systemConfigQuery.data?.serverAccess;
  const machineServerAccessReason =
    selectedEnvironmentProvider?.machineProviderId == null
      ? null
      : machineServerAccessBlockedReason(serverAccess);
  const [environmentProviderInputsOverride, setProviderInputsOverride] =
    useState<{ scopeKey: string; value: JsonValue | null } | null>(null);
  const [environmentProviderInputsBlocked, setProviderInputsBlocked] =
    useState<{ scopeKey: string; reason: string } | null>(null);
  const environmentProviderInputsScopeKey = `${projectId}\0${effectiveEnvironmentValue}\0${providerHostId ?? ""}`;
  const handleProviderInputsChange = useCallback(
    (next: PluginEnvironmentProviderInputsChange) => {
      if (next.status === "blocked") {
        setProviderInputsBlocked((current) => {
          if (
            current?.scopeKey === environmentProviderInputsScopeKey &&
            current.reason === next.reason
          ) {
            return current;
          }
          return {
            scopeKey: environmentProviderInputsScopeKey,
            reason: next.reason,
          };
        });
        return;
      }
      setProviderInputsBlocked(null);
      setProviderInputsOverride((current) => {
        if (
          current?.scopeKey === environmentProviderInputsScopeKey &&
          JSON.stringify(current.value) === JSON.stringify(next.value)
        ) {
          return current;
        }
        return {
          scopeKey: environmentProviderInputsScopeKey,
          value: next.value,
        };
      });
    },
    [environmentProviderInputsScopeKey],
  );
  const activeProviderInputsOverride =
    environmentProviderInputsOverride !== null &&
    environmentProviderInputsOverride.scopeKey ===
      environmentProviderInputsScopeKey
      ? environmentProviderInputsOverride
      : null;
  const activeProviderInputsBlocked =
    environmentProviderInputsBlocked?.scopeKey ===
    environmentProviderInputsScopeKey
      ? environmentProviderInputsBlocked
      : null;
  const providerTakesInputs =
    inputEnvironmentProvider !== undefined &&
    inputEnvironmentProvider.inputs !== null;
  const pluginSlots = usePluginSlots();
  const environmentProviderInputsSlots = pluginSlots.environmentProviderInputs;
  const inputsControlProviderIds = useMemo(() => {
    const pluginIdByProviderId = new Map(
      (environmentProviders ?? []).map((provider) => [
        provider.id,
        provider.pluginId,
      ]),
    );
    const ids = new Set(
      environmentProviderInputsSlots
        .filter(
          (slot) =>
            pluginIdByProviderId.get(slot.environmentProviderId) ===
            slot.pluginId,
        )
        .map((slot) => slot.environmentProviderId),
    );
    for (const provider of environmentProviders ?? []) {
      if (
        provider.environmentProviderId &&
        ids.has(provider.environmentProviderId)
      )
        ids.add(provider.id);
    }
    return ids;
  }, [environmentProviderInputsSlots, environmentProviders]);
  const environmentProviderInputsRegistration = useMemo(() => {
    if (
      inputEnvironmentProvider === undefined ||
      inputEnvironmentProvider.inputs === null
    ) {
      return undefined;
    }
    return environmentProviderInputsSlots.find(
      (slot) =>
        slot.environmentProviderId === inputEnvironmentProvider.id &&
        slot.pluginId === inputEnvironmentProvider.pluginId,
    );
  }, [environmentProviderInputsSlots, inputEnvironmentProvider]);
  const controlRequiredForSelectedProvider =
    inputEnvironmentProvider !== undefined &&
    providerInputsControlRequired(inputEnvironmentProvider);
  const submissionProviderInputs = useMemo((): JsonValue | null => {
    if (!providerTakesInputs) return null;
    if (activeProviderInputsOverride !== null) {
      return activeProviderInputsOverride.value;
    }
    const seededInputs =
      !seedOverridden &&
      environmentSeed !== null &&
      effectiveEnvironmentValue === environmentSeed.selectionValue
        ? environmentSeed.providerInputs
        : null;
    if (seededInputs !== null) return seededInputs;
    return environmentProviderInputsRegistration === undefined &&
      !controlRequiredForSelectedProvider
      ? {}
      : null;
  }, [
    activeProviderInputsOverride,
    controlRequiredForSelectedProvider,
    seedOverridden,
    effectiveEnvironmentValue,
    environmentSeed,
    environmentProviderInputsRegistration,
    providerTakesInputs,
  ]);
  const environmentProviderInputsBlocker =
    inputEnvironmentProvider === undefined || !providerTakesInputs
      ? null
      : activeProviderInputsBlocked !== null
        ? activeProviderInputsBlocked.reason
        : environmentProviderInputsRegistration === undefined &&
            controlRequiredForSelectedProvider
          ? `${inputEnvironmentProvider.displayName} needs its plugin's control`
          : submissionProviderInputs === null
            ? `Configure ${inputEnvironmentProvider.displayName}`
            : null;
  const environmentProviderInputsSlot = useMemo(() => {
    if (environmentProviderInputsRegistration === undefined) return null;
    const InputsComponent = environmentProviderInputsRegistration.component;
    return (
      <PluginSlotMount
        pluginId={environmentProviderInputsRegistration.pluginId}
        slotKind="environmentProviderInputs"
        slotId={environmentProviderInputsRegistration.environmentProviderId}
      >
        <InputsComponent
          projectId={isProjectless ? null : projectId}
          target={
            providerHostId === null
              ? { kind: "new-host" }
              : { kind: "existing-host", hostId: providerHostId }
          }
          value={submissionProviderInputs}
          onChange={handleProviderInputsChange}
        />
      </PluginSlotMount>
    );
  }, [
    handleProviderInputsChange,
    isProjectless,
    projectId,
    providerHostId,
    submissionProviderInputs,
    environmentProviderInputsRegistration,
  ]);

  const compositionMachineProvider =
    selectedEnvironmentProvider?.machineProviderId === undefined ||
    selectedEnvironmentProvider.machineProviderId === null ||
    selectedEnvironmentProvider.machineInputs === undefined ||
    selectedEnvironmentProvider.machineAcceptsEmptyInputs === undefined ||
    selectedEnvironmentProvider.machineProviderPluginId === undefined
      ? null
      : {
          id: selectedEnvironmentProvider.machineProviderId,
          displayName: selectedEnvironmentProvider.displayName,
          pluginId: selectedEnvironmentProvider.machineProviderPluginId,
          inputs: selectedEnvironmentProvider.machineInputs,
          acceptsEmptyInputs:
            selectedEnvironmentProvider.machineAcceptsEmptyInputs,
        };
  const seededMachineInputs =
    !seedOverridden &&
    environmentSeed?.selectionValue === effectiveEnvironmentValue &&
    environmentSeed.providerMachine?.type === "new" &&
    environmentSeed.providerMachine.machineProviderId ===
      compositionMachineProvider?.id
      ? environmentSeed.providerMachine.inputs
      : undefined;
  const machineProviderInputs = useMachineProviderInputs({
    provider: compositionMachineProvider,
    initialValue: seededMachineInputs,
    instanceId: `new-thread-${projectId}`,
  });
  const compositionMachineProviderId = compositionMachineProvider?.id ?? null;
  const compositionMachineInputsSchema =
    compositionMachineProvider?.inputs ?? null;

  const selectedEnvironment = useMemo(
    () =>
      resolveRootComposeThreadEnvironment({
        environmentValue: effectiveEnvironmentValue,
        projectId,
        environmentProviders,
        providerMachine:
          compositionMachineProviderId !== null &&
          compositionMachineInputsSchema !== null
            ? {
                type: "new",
                machineProviderId: compositionMachineProviderId,
                inputs: machineProviderInputs.value,
              }
            : providerMachine,
        providerInputs: submissionProviderInputs,
      }),
    [
      effectiveEnvironmentValue,
      environmentProviders,
      projectId,
      submissionProviderInputs,
      compositionMachineInputsSchema,
      compositionMachineProviderId,
      machineProviderInputs.value,
      providerMachine,
    ],
  );

  const seedInitialPrompt = promptDraft.restoreIfEmpty;
  const focusPromptBox = useCallback(() => {
    setLocalPromptBoxFocusRequest((current) => (current ?? 0) + 1);
  }, []);
  useEffect(() => {
    if (!seed?.initialPrompt) return;
    seedInitialPrompt({
      text: seed.initialPrompt,
      mentions: [],
      attachments: [],
    });
  }, [seed?.initialPrompt, seedInitialPrompt]);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isCopyingAttachments, setIsCopyingAttachments] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isUploadingRef = useRef(false);
  const isCopyingAttachmentsRef = useRef(false);
  const isSubmittingRef = useRef(false);
  const uploadPromptAttachment = useUploadPromptAttachment();
  const uploadTargetKey = `${projectId}\0${promptDraft.storageKey}`;
  const currentUploadTargetRef = useRef(uploadTargetKey);
  useEffect(() => {
    currentUploadTargetRef.current = uploadTargetKey;
  }, [uploadTargetKey]);
  const handleAttachFiles = useCallback(
    async (files: File[]) => {
      if (!projectId || files.length === 0 || isUploadingRef.current) return;
      const capturedTarget = `${projectId}\0${promptDraft.storageKey}`;
      setComposerError(null);
      isUploadingRef.current = true;
      setIsUploading(true);
      try {
        for (const file of files) {
          try {
            const uploaded = await uploadPromptAttachment.mutateAsync({
              projectId,
              file,
            });
            if (currentUploadTargetRef.current !== capturedTarget) return;
            promptDraft.addAttachment(uploaded);
          } catch (error) {
            if (currentUploadTargetRef.current === capturedTarget) {
              setComposerError(
                getMutationErrorMessage({
                  error,
                  fallbackMessage: "Attachment upload failed",
                }),
              );
            }
            break;
          }
        }
      } finally {
        isUploadingRef.current = false;
        setIsUploading(false);
      }
    },
    [projectId, promptDraft, uploadPromptAttachment],
  );
  const handleProjectChange = useCallback(
    async (nextProjectId: string | null) => {
      const nextValue = nextProjectId ?? PERSONAL_PROJECT_ID;
      if (
        nextValue === projectId ||
        isCopyingAttachmentsRef.current ||
        isUploadingRef.current ||
        isSubmittingRef.current
      ) {
        return;
      }
      const attachmentPaths = getProjectStoredPromptAttachmentPaths(
        promptDraft.getCurrent().attachments,
      );
      isCopyingAttachmentsRef.current = true;
      setIsCopyingAttachments(true);
      try {
        if (attachmentPaths.length > 0) {
          setComposerError(null);
          try {
            await sdk.projects.attachments.copy({
              projectId: nextValue,
              sourceProjectId: projectId,
              paths: attachmentPaths,
            });
          } catch (error) {
            setComposerError(
              getMutationErrorMessage({
                error,
                fallbackMessage:
                  "Attachments could not be moved to the selected project",
              }),
            );
            return;
          }
        }
        snapshotDraftBeforeOptionChange();
        await onProjectChange(nextValue);
      } finally {
        isCopyingAttachmentsRef.current = false;
        setIsCopyingAttachments(false);
      }
    },
    [onProjectChange, projectId, promptDraft, snapshotDraftBeforeOptionChange],
  );

  const reuseEnvironmentId =
    parsedEnvironment?.type === "reuse"
      ? parsedEnvironment.environmentId
      : null;
  const projectHostId =
    reuseEnvironmentId !== null ? null : (providerHostId ?? primaryHostId);
  const panelThreadId = resolvePanelThreadId(
    reuseEnvironmentId,
    reuseThreadOptions,
  );
  const defaultMentionLinkResolver = useCallback<PromptMentionLinkResolver>(
    (resource) => {
      if (resource.kind === "thread") {
        const targetProjectId = resource.projectId ?? projectId;
        return () =>
          navigate(
            getThreadRoutePath({
              projectId: targetProjectId,
              threadId: resource.threadId,
            }),
          );
      }
      if (resource.kind === "project") {
        return () => navigate(getProjectComposeRoutePath(resource.projectId));
      }
      return null;
    },
    [navigate, projectId],
  );
  const { typeaheadConfig, promptActions } = useComposerTypeahead({
    projectId,
    hasMentionsProject: !isProjectless,
    providerId: selectedProviderId,
    commandScope: "new-thread",
    environmentId: reuseEnvironmentId,
    hostId: projectHostId,
    threadStorageThreadId: panelThreadId ?? undefined,
    selectedProviderComposerActions,
    resolveMentionLink: defaultMentionLinkResolver,
  });
  const promptHistoryEnabled = usePromptHistoryEnabled();
  const { data: projectPromptHistory = [] } = useProjectPromptHistory(
    projectId,
    { enabled: promptHistoryEnabled && sidebarNavigationSettled },
  );
  const promptHistoryDrafts = useMemo(
    () => promptHistoryEntriesToDrafts(projectPromptHistory),
    [projectPromptHistory],
  );
  const currentDraft = useMemo(
    () => ({
      text: promptDraft.text,
      mentions: promptDraft.mentions,
      attachments: promptDraft.attachments,
      contexts: promptDraft.contexts,
    }),
    [
      promptDraft.attachments,
      promptDraft.contexts,
      promptDraft.mentions,
      promptDraft.text,
    ],
  );
  const promptInput = useMemo(
    () => promptDraftToInput(currentDraft),
    [currentDraft],
  );
  const submitProgrammaticallyRef = useRef<
    (
      options: ExperimentalComposerSubmitOptions,
      pluginSubmission: NewThreadComposerSubmission["pluginSubmission"],
    ) => Promise<void>
  >(async () => {});
  const submitProgrammaticallyThroughRef = useCallback(
    (
      options: ExperimentalComposerSubmitOptions,
      pluginSubmission: NewThreadComposerSubmission["pluginSubmission"],
    ) => submitProgrammaticallyRef.current(options, pluginSubmission),
    [],
  );
  const pluginComposerHost = useMemo<PluginComposerHost>(
    () => ({
      scope: { kind: "new-thread", projectId },
      textEffectKey: promptDraft.storageKey,
      getCurrent: promptDraft.getCurrent,
      subscribeDraft: promptDraft.subscribe,
      setDraft: promptDraft.setDraft,
      focus: focusPromptBox,
      submit: submitProgrammaticallyThroughRef,
    }),
    [
      focusPromptBox,
      projectId,
      promptDraft.getCurrent,
      promptDraft.setDraft,
      promptDraft.storageKey,
      promptDraft.subscribe,
      submitProgrammaticallyThroughRef,
    ],
  );

  const seededExecutionInputSources = useMemo(
    (): CreateExecutionInputSources => ({
      ...(seed?.providerId !== undefined
        ? { providerId: "explicit" as const }
        : {}),
      ...(seed?.model !== undefined ? { model: "explicit" as const } : {}),
      ...(seed?.reasoningLevel !== undefined
        ? { reasoningLevel: "explicit" as const }
        : {}),
      ...(seed?.serviceTier !== undefined && supportsServiceTier && serviceTier
        ? { serviceTier: "explicit" as const }
        : {}),
      ...(seed?.permissionMode !== undefined
        ? { permissionMode: "explicit" as const }
        : {}),
    }),
    [
      seed?.model,
      seed?.permissionMode,
      seed?.providerId,
      seed?.reasoningLevel,
      seed?.serviceTier,
      serviceTier,
      supportsServiceTier,
    ],
  );
  const submissionEnvironment = useMemo(
    () => executionTarget === "cloud"
      ? { type: "project-default" as const }
      : selectedProviderMachineUnavailable
        ? null
        : (selectedEnvironment ??
          (selectionScope === "new-thread" ? seed?.environment : undefined) ??
          null),
    [
      executionTarget,
      selectedProviderMachineUnavailable,
      selectedEnvironment,
      selectionScope,
      seed?.environment,
    ],
  );
  const { permission: permissionConfig, permissionChoiceRequired } =
    useNewThreadPermissionControl({
      executionTarget,
      options: creationOptions,
      projectDefaults,
      seedPermissionMode: seed?.permissionMode,
      snapshot: snapshotDraftBeforeOptionChange,
    });
  const localSubmitDisabledReason = resolveNewThreadSubmitDisabledReason({
    environmentProviderInputsBlocker:
      machineProviderInputs.blockedReason ?? environmentProviderInputsBlocker,
    environmentSetupRequiredReason:
      environmentSetupRequiredReason ?? machineServerAccessReason,
    isCopyingAttachments,
    isLoadingModels,
    isSubmitting,
    isUploading,
    modelLoadError,
    projectDefaultsStatus: projectDefaultsState.status,
    projectDefaultsUnavailable,
    permissionChoiceRequired,
    promptInputEmpty: promptInput.length === 0,
    providerDisplayName: selectedProviderDisplayName,
    selectedProviderId,
    selectedThreadModel,
    submissionEnvironmentUnavailable: submissionEnvironment === null,
  });
  // Shown as a banner too, so an unavailable agent is never a silent greyed-out button.
  const cloudBlockedReason = !cloudAgentMissing
    ? null
    : selectedProviderId === "claude-code"
      ? "Claude Code is not configured in Cloud yet."
      : `${selectedProviderDisplayName ?? "This agent"} isn't available in Cloud. Available: ${cloudHarnessNames(cloudConnection.data)}.`;
  const submitDisabledReason = executionTarget === "cloud"
    ? (cloudBlockedReason
        ?? (agyState === "signed_out" ? "Connect Antigravity to send in Cloud"
        : agyState === "checking" ? "Checking Antigravity…"
        : agyState === "unavailable" ? "Couldn't check Antigravity"
        : claudeMissing ? "Connect Claude Code to send in Cloud"
        : cloudQueue ? (cloudQueue.regionBlocked ? "Cloud isn't available in your region yet" : "You're in the cloud queue")
        // Until the project list loads, the pick may be a removed project, even one the saved copy of the list
        // still shows: it would fail as "Project not found", then quietly turn into no project (#1347).
        : !isProjectless && (!sidebarNavigationSettled || sidebarNavigationQuery.isPlaceholderData)
          ? "Loading projects…"
        : !selectedThreadModel || isLoadingModels
          ? "Select a model"
          : cloudFiltered && !cloudLevels.includes(reasoningLevel)
            ? "Select a reasoning level supported by the cloud model"
          : isSubmitting || isUploading || isCopyingAttachments
            ? "Preparing your message"
            : promptInput.length === 0
              ? "Type a message first"
              : null))
    : localSubmitDisabledReason;
  const seededMachine =
    seed?.executionTarget !== undefined || seed?.environment !== undefined;
  // A Local pick counts only when Cloud could have taken the thread.
  const pickedLocal = pickedEnvironment?.target === "local" && !cloudLocked && cloudCanRunHarness(selectedProviderId);
  const submitDraft = useCallback(
    async (
      blockedReason: string | null,
      submitOptions: ExperimentalComposerSubmitOptions | null,
      pluginSubmission?: NewThreadComposerSubmission["pluginSubmission"],
    ) => {
      const submittedDraft = promptDraft.getCurrent();
      const input = promptDraftToInput(submittedDraft);
      if (
        blockedReason !== null ||
        submitDisabledReason !== null ||
        input.length === 0 ||
        isSubmittingRef.current ||
        (executionTarget === "local" && projectDefaultsUnavailable) ||
        submissionEnvironment === null ||
        !selectedProviderId ||
        !selectedThreadModel
      ) {
        throw new Error(
          blockedReason ??
            submitDisabledReason ??
            (input.length === 0
              ? "Type a message first."
              : "This composer is not ready to submit yet."),
        );
      }
      const sources: CreateExecutionInputSources = {
        ...executionInputSources,
        ...seededExecutionInputSources,
      };
      const request: NewThreadComposerSubmission = {
        projectId,
        providerId: selectedProviderId,
        model: selectedThreadModel,
        reasoningLevel,
        permissionMode: executionTarget === "cloud" ? "full" : permissionMode,
        ...(executionTarget === "cloud"
          ? { executionTarget, serviceTier: cloudFastSupported && threadTier ? threadTier : "default", ...(cloudBaseBranch ? { baseBranch: cloudBaseBranch } : {}), ...(vpsConnected ? { cloudTarget: wantedCloudTarget } : {}) }
          : supportsServiceTier && serviceTier
            ? { serviceTier }
            : {}),
        executionInputSources: resolveSubmittedExecutionSources(
          submissionEnvironment,
          sources,
        ),
        environment: submissionEnvironment,
        input,
        ...(submitOptions?.sendAt === undefined
          ? {}
          : { sendAt: submitOptions.sendAt }),
        ...(pluginSubmission === undefined ? {} : { pluginSubmission }),
      };
      if (executionTarget === "cloud")
        request.requestId = await cloudroomRequestId(
          promptDraft.storageKey,
          request,
        );
      const submittedPickRevision = pickRevisionRef.current;
      isSubmittingRef.current = true;
      setIsSubmitting(true);
      setComposerError(null);
      try {
        await onSubmit(request);
        promptDraft.clearIfCurrentMatches(submittedDraft);
        if (executionTarget === "cloud")
          clearCloudroomRequestId(promptDraft.storageKey);
        clearReuseEnvironment();
        if (selectionScope === "new-thread") {
          saveNewThreadMachine(projectId, seededMachine, storedExecutionTarget, executionTarget, pickedLocal);
        }
        if (pickRevisionRef.current === submittedPickRevision) {
          setUserPickedEnvironment(null);
          if (selectionScope === "new-thread") {
            if (
              pickedEnvironment?.target === "local" &&
              parseEnvironmentValue(effectiveEnvironmentValue)?.type === "provider"
            ) {
              setCreationEnvironmentSelectionValue(effectiveEnvironmentValue);
              setStoredMachineId(providerHostId ?? "");
            }
            setExecutionTarget(startingExecutionTarget(true, projectId));
            setCloudPicked(false);
          }
        }
      } catch (submitError) {
        setComposerError(
          getMutationErrorMessage({
            error: submitError,
            fallbackMessage: "Failed to create thread. Your prompt is saved.",
          }),
        );
        throw submitError;
      } finally {
        isSubmittingRef.current = false;
        setIsSubmitting(false);
      }
    },
    [
      clearReuseEnvironment,
      executionTarget,
      executionInputSources,
      onSubmit,
      permissionMode,
      projectDefaultsUnavailable,
      projectId,
      promptDraft,
      reasoningLevel,
      seededExecutionInputSources,
      selectionScope,
      submitDisabledReason,
      submissionEnvironment,
      selectedProviderId,
      selectedThreadModel,
      serviceTier,
      threadTier,
      supportsServiceTier,
      cloudFastSupported,
      cloudBaseBranch,
      vpsConnected,
      wantedCloudTarget,
      seededMachine,
      pickedLocal,
      storedExecutionTarget,
      pickedEnvironment,
      effectiveEnvironmentValue,
      providerHostId,
      setCreationEnvironmentSelectionValue,
      setStoredMachineId,
      setUserPickedEnvironment,
    ],
  );

  const handleSubmit = useCallback(
    async (blockedReason: string | null) => {
      try {
        await submitDraft(blockedReason, null);
      } catch {}
    },
    [submitDraft],
  );
  useEffect(() => {
    submitProgrammaticallyRef.current = async (
      submitOptions,
      pluginSubmission,
    ) => {
      await submitDraft(null, submitOptions, pluginSubmission);
    };
  }, [submitDraft]);

  const handleProviderChange = useDraftPreservingOptionChange(
    selectedProviderId,
    setSelectedProviderId,
    snapshotDraftBeforeOptionChange,
  );
  const codexOffered = providerOptions.some((option) => option.value === "codex");
  const switchToCodex = useCallback(() => {
    reportCloudChoice("switched_agent", "claude_not_connected");
    handleProviderChange("codex");
  }, [handleProviderChange]);
  const handleModelChange = useDraftPreservingOptionChange(
    selectedModel,
    setSelectedModel,
    snapshotDraftBeforeOptionChange,
  );
  // Clicking the displayed default still records it as the user's pick (#656).
  const handleReasoningChange = useDraftPreservingOptionChange(
    reasoningLevel,
    setReasoningLevel,
    snapshotDraftBeforeOptionChange,
    true,
  );
  const handleSelectModel = useCallback(
    (selection: { providerId: string; model: string }) => {
      snapshotDraftBeforeOptionChange();
      setProviderModelReasoning(selection);
    },
    [setProviderModelReasoning, snapshotDraftBeforeOptionChange],
  );
  const handleServiceTierChange = useDraftPreservingOptionChange(
    serviceTier,
    setServiceTier,
    snapshotDraftBeforeOptionChange,
  );
  const handleWorktreeChange = useCallback(
    (environmentId: string) => {
      setUserPickedEnvironment(null);
      changeEnvironment(encodeReuseValue(environmentId));
    },
    [changeEnvironment, setUserPickedEnvironment],
  );

  const renderPromptBox = useCallback(
    (options: NewThreadComposerPromptOptions) => {
      const locks = options.locks ?? {};
      const environmentLocked = Boolean(locks.environment || isSubmitting);
      const disabledReason = options.blockedReason ?? submitDisabledReason;
      return (
        <PromptDraftContextsContext.Provider value={currentDraft.contexts}>
        <NewThreadPromptBox
          id={options.id}
          focusRequest={promptBoxFocusRequest}
          value={promptDraft.text}
          mentionRanges={promptDraft.mentions}
          onChange={(text, mentions) => {
            // An edit can remove what the last error was about, so the old error must not linger.
            // Guarded: even a same-value setState can re-render the composer on every key.
            if (composerError !== null) setComposerError(null);
            promptDraft.setTextAndMentions(text, mentions);
          }}
          onSubmit={() => void handleSubmit(options.blockedReason ?? null)}
          voiceDraftScope={draftStorage}
          isSubmitting={isSubmitting}
          disabled={disabledReason !== null}
          disabledReason={disabledReason ?? undefined}
          placeholder={options.placeholder}
          autoFocus={options.autoFocus}
          allowSoftKeyboardAutoFocus={options.allowSoftKeyboardAutoFocus}
          pluginComposerHost={options.pluginComposerHost ?? pluginComposerHost}
          textEffects={options.textEffects ?? textEffects}
          history={{
            currentDraft,
            entries: promptHistoryDrafts,
            onSelectEntry: promptDraft.setDraft,
            resetKey: projectId,
          }}
          typeahead={
            options.resolveMentionLink
              ? { ...typeaheadConfig, resolveLink: options.resolveMentionLink }
              : typeaheadConfig
          }
          attachments={{
            items: promptDraft.attachments,
            projectId,
            onAttachFiles: handleAttachFiles,
            onRemove: promptDraft.removeAttachment,
            isAttaching: isUploading || isCopyingAttachments,
            error: composerError,
          }}
          promptActions={promptActions}
          modeConfig={{
            environment: {
              cloud: {
                selected: executionTarget === "cloud" && !landsOnVps,
                unavailableReason: null,
                ...(cloudLocked ? { note: CLOUD_LOCKED_REASON } : {}),
                onSelect: () => {
                  selectCloudTarget();
                  if (!cloudLocked) {
                    if (vpsConnected) pickCloudTarget("cloud");
                    else setCloudTarget("cloud");
                  }
                },
                ...(vpsConnected && vps.data
                  ? {
                      vps: {
                        selected: executionTarget === "cloud" && landsOnVps,
                        busy: vpsBusy,
                        description: vpsBusy
                          ? `${vpsSummary(vps.data)}. ${vps.data.fallback ? "New threads start in Cloud until it frees up." : "Pick Cloud, or turn on \"Use Cloud when it's busy\"."}`
                          : `${vps.data.name?.split(".")[0] ?? "VPS"} · ${vpsSummary(vps.data)}`,
                        onSelect: () => {
                          selectCloudTarget();
                          pickCloudTarget("vps");
                        },
                      },
                    }
                  : {}),
                onAddMachine: () => navigate(getSettingsRoutePath("machines")),
              },
              ...(executionTarget === "local" && !cloudLocked && !environmentLocked && cloudCanRunHarness(selectedProviderId)
                ? { hint: <TryCloudHint draftLength={promptDraft.text.trim().length} github={cloudBranchPickerShown} onUseCloud={selectCloudTarget} /> }
                : {}),
              value: effectiveEnvironmentValue,
              sources: projectSources,
              disabled: environmentLocked,
              isLoading: environmentProviders === undefined,
              providers: environmentProviders ?? [],
              providersByHostId: environmentProvidersByHostId,
              selectedProviderHostId: providerHostId,
              inputsControlProviderIds,
              onSelectProvider: handleSelectProvider,
              onSelectHost: handleSelectHost,
              ...(!isProjectless && options.onRequestMachineSetup
                ? { onRequestMachineSetup: options.onRequestMachineSetup }
                : {}),
            },
            worktree: {
              options: reuseThreadOptions,
              value: reuseEnvironmentId,
              onChange: handleWorktreeChange,
              disabled: environmentLocked,
            },
            permission: permissionConfig,
            environmentProviderInputsSlot,
            machineProviderInputsSlot: machineProviderInputs.control,
            cloudInputsSlot:
              cloudBranchPickerShown && !locks.baseBranch && projectId !== null ? (
                <CloudBranchPicker
                  gitlab={gitlabProject}
                  projectId={projectId}
                  hostId={primaryHostId}
                  fromRemote={
                    gitlabProject || !primaryHostId ||
                    !findLocalPathProjectSourceForHost(
                      projectSources,
                      primaryHostId,
                    )
                  }
                  value={cloudBaseBranch}
                  onChange={(branch) => setCloudBranch({ projectId, branch })}
                  disabled={environmentLocked}
                />
              ) : null,
            footer: cloudQueue ? (
              <CloudQueueCard
                queue={cloudQueue}
                onUseLocal={() => {
                  setExecutionTarget("local");
                  setCloudPicked(false);
                  setUserPickedEnvironment({ target: "local" });
                }}
              />
            ) : cloudCapacity ? (
              <CloudCapacityCard
                capacity={cloudCapacity}
                onUseLocal={() => {
                  setExecutionTarget("local");
                  setCloudPicked(false);
                  setUserPickedEnvironment({ target: "local" });
                }}
              />
            ) : cloudLimit ? (
              <CloudLimitCard
                limit={cloudLimit}
                onUseLocal={() => {
                  setExecutionTarget("local");
                  setCloudPicked(false);
                  setUserPickedEnvironment({ target: "local" });
                }}
              />
            ) : <>{executionTarget === "cloud" && wantedCloudTarget === "vps" && !landsOnVps && vps.data ? (
              <p className="flex items-center gap-1.5 px-3.5 pt-1.5 text-xs text-muted-foreground">
                <Icon name="AlertTriangle" className="size-3.5 shrink-0 text-warning-text" aria-hidden />
                {vps.data.health ? `Your VPS is busy (${vps.data.busy}), so this thread starts in Cloud.` : "Your VPS is offline, so this thread starts in Cloud."}
              </p>
            ) : null}{agyState !== "ready" && cloudBlockedReason === null ? <AntigravityCloudLogin state={agyState} /> : <OneClickScans fallback={<FreePlanTip />} />}</>,
            banner:
              executionTarget === "cloud" ? (
                cloudBlockedReason !== null ? (
                  <ProviderRequirementBanner title="Not available in Cloud" description={cloudBlockedReason} action={null} />
                ) : agyNeedsLogin ? null : cloudOpenCodeIssue !== null ? (
                  <ProviderRequirementBanner
                    title="Model not available in Cloud"
                    description={cloudOpenCodeIssue.message}
                    action={
                      cloudOpenCodeIssue.alternatives[0] ? (
                        <Button
                          type="button"
                          size="sm"
                          className="h-8 shrink-0 px-3"
                          onClick={() => handleModelChange(cloudOpenCodeIssue.alternatives[0])}
                        >
                          Use {cloudOpenCodeIssue.alternatives[0]}
                        </Button>
                      ) : null
                    }
                  />
                ) : null
              ) : (
                (options.banner ??
                (machineServerAccessReason !== null ? (
                  <ProviderRequirementBanner
                    title={MACHINE_SERVER_ACCESS_TITLE}
                    description={machineServerAccessReason}
                    action={
                      <Button
                        type="button"
                        size="sm"
                        className="h-8 shrink-0 px-3"
                        onClick={() =>
                          navigate(getSettingsRoutePath("machines"))
                        }
                      >
                        Set up machine access
                      </Button>
                    }
                  />
                ) : setupRequiredProvider === null ? null : (
                  <ProviderRequirementBanner
                    title={`${setupRequiredProvider.displayName} needs configuration`}
                    description={environmentSetupRequiredReason}
                    action={
                      <Button
                        type="button"
                        size="sm"
                        className="h-8 shrink-0 px-3"
                        onClick={() =>
                          navigate(
                            getPluginConfigurationRoutePath({
                              pluginId: setupRequiredProvider.pluginId,
                            }),
                          )
                        }
                      >
                        Configure {setupRequiredProvider.displayName}
                      </Button>
                    }
                  />
                )))
              ),
            header: claudeMissing ? (
              <>
                <CloudClaudeStrip onSwitchToCodex={codexOffered && !locks.provider ? switchToCodex : null} />
                {options.header}
              </>
            ) : options.header,
          }}
          project={{
            projects: projectOptions,
            value: options.allowNoProject && isProjectless ? null : projectId,
            onChange: handleProjectChange,
            allowNoProject: options.allowNoProject,
            createProject: options.createProject,
            isLoading: !sidebarNavigationSettled,
            disabled:
              locks.project ||
              isUploading ||
              isCopyingAttachments ||
              isSubmitting,
            showChevronWhenDisabled: !locks.project,
          }}
          execution={{
            providerRouting: executionOptionsRouting,
            provider: {
              options: providerOptions,
              selectedId: selectedProviderId,
              onChange: locks.provider ? undefined : handleProviderChange,
              hasMultiple: hasMultipleProviders,
            },
            model: {
              active: activeModel,
              selected: selectedModel,
              options: effectiveModelOptions,
              moreOptions: effectiveMoreModelOptions,
              isLoading: isLoadingModels,
              loadFailed: modelLoadFailed,
              loadError: modelLoadError,
              onChange: handleModelChange,
            },
            serviceTier: {
              value: executionTarget === "cloud" && !cloudFastSupported ? "default" : threadTier,
              onChange: handleServiceTierChange,
              supported: executionTarget === "cloud" ? cloudFastSupported : supportsServiceTier,
              supportByProvider: serviceTierSupportByProvider,
              fastLabel: serviceTierFastLabel,
              ultraFast,
            },
            reasoning: {
              value: reasoningLevel,
              options: availableReasoningOptions,
              onChange: handleReasoningChange,
            },
            selectModel: locks.provider ? undefined : handleSelectModel,
          }}
        />
        </PromptDraftContextsContext.Provider>
      );
    },
    [
      executionTarget,
      selectCloudTarget,
      cloudLocked,
      activeModel,
      composerError,
      currentDraft,
      draftStorage,
      effectiveEnvironmentValue,
      environmentProviders,
      environmentProvidersByHostId,
      executionOptionsRouting,
      handleAttachFiles,
      handleModelChange,
      handleProjectChange,
      handleProviderChange,
      handleReasoningChange,
      handleSelectModel,
      handleSelectProvider,
      handleSelectHost,
      handleServiceTierChange,
      handleSubmit,
      handleWorktreeChange,
      hasMultipleProviders,
      isCopyingAttachments,
      isLoadingModels,
      isProjectless,
      isSubmitting,
      isUploading,
      modelLoadError,
      modelLoadFailed,
      effectiveModelOptions,
      effectiveMoreModelOptions,
      cloudOpenCodeIssue,
      permissionConfig,
      projectId,
      projectOptions,
      projectSources,
      promptActions,
      promptBoxFocusRequest,
      promptDraft,
      promptHistoryDrafts,
      pluginComposerHost,
      typeaheadConfig,
      providerOptions,
      reasoningLevel,
      availableReasoningOptions,
      reuseEnvironmentId,
      reuseThreadOptions,
      selectedModel,
      selectedProviderId,
      threadTier,
      ultraFast,
      serviceTierSupportByProvider,
      sidebarNavigationSettled,
      supportsServiceTier,
      cloudFastSupported,
      submitDisabledReason,
      cloudBlockedReason, agyNeedsLogin, agyState,
      claudeMissing,
      codexOffered,
      switchToCodex,
      cloudQueue,
      cloudCapacity,
      cloudLimit,
      machineServerAccessReason,
      setupRequiredProvider,
      environmentSetupRequiredReason,
      navigate,
      environmentProviderInputsSlot,
      machineProviderInputs.control,
      cloudBranchPickerShown,
      gitlabProject,
      cloudBaseBranch,
      vps.data,
      vpsBusy,
      vpsConnected,
      landsOnVps,
      wantedCloudTarget,
      primaryHostId,
      inputsControlProviderIds,
      providerHostId,
      setUserPickedEnvironment,
      textEffects,
      serviceTierFastLabel,
    ],
  );

  return (
    <NewThreadComposerStateRenderer
      render={children}
      state={{
        // The Claude strip in the prompt box already offers Connect.
        connectionFooter: !claudeMissing && providerOptions.some((provider) => CONNECT_AGENT_IDS.includes(provider.value)) ? (
          <ConnectAgentsButton
            target={executionTarget}
            hostId={executionOptionsRouting.hostId}
            environmentId={executionOptionsRouting.environmentId}
            primaryHostId={primaryHostId}
            providerIds={providerOptions.map((provider) => provider.value)}
            selectedProviderId={selectedProviderId}
          />
        ) : null,
        projectId,
        isProjectless,
        projects,
        sidebarNavigation: sidebarNavigationQuery.data,
        sidebarNavigationError: sidebarNavigationQuery.isError,
        currentProject,
        projectSources,
        connectedHostIds,
        primaryHostId,
        parsedEnvironment,
        projectHostId,
        panelThreadId,
        selectedProviderId,
        promptDraft,
        focusPromptBox,
        pluginComposerHost,
        textEffects,
        isSubmitting,
        seedEnvironmentSelectionValue,
        setEnvironmentSelectionValue: changeEnvironment,
        setProviderModelReasoning,
        setPermissionMode,
        setServiceTier,
        renderPromptBox,
      }}
    />
  );
}
