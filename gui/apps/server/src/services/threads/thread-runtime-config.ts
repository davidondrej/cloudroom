import {
  cloudClaudeLoginEnvironment,
  resolveHostEnvironment,
  mergeHostAndProviderEnvironment,
} from "../hosts/host-environment.js";
import { getAppSettings, getEnvironment, getHost, getProject } from "@cloudroom/db";
import type {
  DynamicTool,
  InstructionMode,
  Thread,
  EnvironmentStatus,
} from "@cloudroom/domain";
import type {
  HostDaemonContributedEnvEntry,
  HostDaemonInjectedSkillSource,
} from "@cloudroom/host-daemon-contract";
import { ApiError } from "../../errors.js";
import { cloudroom } from "../cloudroom/commands.js";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { throwEnvironmentNotReady } from "../lib/lifecycle-api-errors.js";
import { requireLiveThreadStoragePath } from "./thread-storage.js";
import {
  listPluginAgentTools,
  listPluginInstructionContributions,
  getPluginSkillRootContributions,
  resolvePluginAgentConfiguration,
  resolvePluginProviderEnv,
} from "../plugins/plugin-agent-contributions.js";
import { resolveSkillCatalog } from "../skills/skill-catalog.js";
import { discoverPluginSkillIds } from "../skills/injected-skills.js";
import { resolveWorkspaceProjectSkills } from "../skills/workspace-skills.js";
import { resolveSharedSkills } from "../skills/shared-skills.js";
import { UPDATE_ENVIRONMENT_DIRECTORY_TOOL } from "./thread-environment-directory.js";
import {
  DATA_DIR_AGENT_INSTRUCTIONS_RELATIVE_PATH,
  WORKSPACE_AGENT_INSTRUCTIONS_RELATIVE_PATH,
  readDataDirAgentInstructions,
  readWorkspaceAgentInstructions,
} from "./workspace-agent-instructions.js";
import { resolveDeprecatedWorkspaceProvisionType } from "../environments/environment-response.js";

import {
  cloudroomSystemPrompt,
  CUSTOM_INSTRUCTIONS_PLUGIN_ID,
  pluginInstructionMaxChars,
} from "./custom-instructions.js";

// Claude Code's native question tool and the ask-user-question plugin tool
// share this name, so one setting hides question cards for every provider.
const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";

const UPDATE_ENVIRONMENT_DIRECTORY_INSTRUCTIONS =
  "If the user asks you to move this thread to a new worktree, run `room-cli thread worktree` and follow its output; never create a worktree yourself. If they ask to move it to another existing checkout or directory, make sure it exists, then call `update_environment_directory` with its absolute path. After it succeeds, stop work in the current turn; future turns will run in the updated environment. If they ask to move it to another Cloudroom project, run `room-cli thread move --self --project PROJECT` and end your turn.";

export interface ThreadRuntimeCommandEnvironment {
  hostId: string;
  id: string;
  path: string | null;
  status: EnvironmentStatus;
}

interface ResolveThreadRuntimeCommandConfigArgs {
  environment: ThreadRuntimeCommandEnvironment;
  model: string;
  thread: Thread;
}

export interface ResolvedThreadRuntimeCommandConfig {
  contributedEnv: HostDaemonContributedEnvEntry[];
  disallowedTools?: string[];
  dynamicTools: DynamicTool[];
  injectedSkillSources: HostDaemonInjectedSkillSource[];
  instructionMode: InstructionMode;
  instructions: string;
  projectId: string;
  providerId: string;
  threadStoragePath: string;
  workspacePath: string;
}

function requireWorkspacePath(
  environment: ThreadRuntimeCommandEnvironment,
): string {
  if (!environment.path) {
    throwEnvironmentNotReady(environment);
  }

  return environment.path;
}

interface DynamicToolContribution {
  tool: DynamicTool;
  instructions: string | null;
  pluginId: string | null;
}

function resolveDynamicTools(
  pluginTools: ReturnType<typeof listPluginAgentTools>,
): DynamicToolContribution[] {
  return [
    {
      tool: UPDATE_ENVIRONMENT_DIRECTORY_TOOL,
      instructions: UPDATE_ENVIRONMENT_DIRECTORY_INSTRUCTIONS,
      pluginId: null,
    },
    ...pluginTools.map((contribution) => ({
      tool: contribution.tool,
      instructions: contribution.instructions,
      pluginId: contribution.pluginId,
    })),
  ];
}

export async function resolveThreadRuntimeCommandConfig(
  deps: LoggedWorkSessionDeps,
  args: ResolveThreadRuntimeCommandConfigArgs,
): Promise<ResolvedThreadRuntimeCommandConfig> {
  const workspacePath = requireWorkspacePath(args.environment);
  const project = getProject(deps.db, args.thread.projectId);
  if (!project) {
    throw new ApiError(404, "project_not_found", "Project not found");
  }
  const environment = getEnvironment(deps.db, args.environment.id);
  if (!environment) {
    throw new ApiError(404, "environment_not_found", "Environment not found");
  }
  const host = getHost(deps.db, args.environment.hostId);
  if (!host) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }

  const [projectSkillSources, sharedSkills, workspaceAgentInstructions] =
    await Promise.all([
      resolveWorkspaceProjectSkills(deps, {
        hostId: args.environment.hostId,
        workspacePath,
      }),
      resolveSharedSkills(deps, {
        hostId: args.environment.hostId,
        cwd: workspacePath,
      }),
      readWorkspaceAgentInstructions(deps, {
        hostId: args.environment.hostId,
        workspacePath,
      }),
    ]);
  const pluginSkillRoots = getPluginSkillRootContributions();
  const skillIdsByPlugin = discoverPluginSkillIds(deps.logger, {
    pluginSkillRoots,
    skillTreeRegistry: deps.skillTreeRegistry,
  });
  const conditionalConfiguration = await resolvePluginAgentConfiguration({
    context: {
      thread: {
        id: args.thread.id,
        title: args.thread.title,
        parentThreadId: args.thread.parentThreadId,
        sourceThreadId: args.thread.sourceThreadId,
      },
      project: {
        id: project.id,
        kind: project.kind,
        name: project.name,
        gitRemoteUrl: project.gitRemoteUrl,
      },
      environment: {
        id: environment.id,
        name: environment.name,
        path: environment.path,
        branchName: environment.branchName,
        workspaceProvisionType: resolveDeprecatedWorkspaceProvisionType(
          environment.environmentProviderId,
        ),
      },
      host: { id: host.id, name: host.name },
      provider: {
        id: args.thread.providerId,
        model: args.model,
        capabilities: {
          supportsNativeUserQuestion:
            deps.providerRegistry.get(args.thread.providerId)?.info.capabilities
              .supportsNativeUserQuestion ?? false,
        },
      },
      origin: {
        kind: args.thread.originKind,
        pluginId: args.thread.originPluginId,
      },
    },
    skillIdsByPlugin,
  });
  const contributedEnv = mergeHostAndProviderEnvironment(
    [
      ...(await resolveHostEnvironment(deps, {
        hostId: host.id,
        projectId: project.id,
      })),
      ...cloudClaudeLoginEnvironment(deps, {
        hostId: host.id,
        providerId: args.thread.providerId,
      }),
      ...(args.thread.providerId === "codex"
        ? await cloudroom(deps).codexAccounts.environment()
        : []),
    ],
    await resolvePluginProviderEnv({
      providerId: args.thread.providerId,
      context: {
        threadId: args.thread.id,
        projectId: project.id,
        hostId: host.id,
      },
    }),
  );
  const injectedSkillSources = resolveSkillCatalog(deps, {
    projectSkillSources,
    sharedSkillSources: sharedSkills.runtimeSources,
    pluginSkillSelections: conditionalConfiguration.selectedSkillIdsByPlugin,
  }).map((entry) => entry.runtimeSource);
  const dataDirAgentInstructions = readDataDirAgentInstructions(
    deps.logger,
    deps.config.dataDir,
  );
  const questionsEnabled = getAppSettings(deps.db).agentQuestionsEnabled;
  const dynamicToolContributions = resolveDynamicTools(
    questionsEnabled
      ? conditionalConfiguration.tools
      : conditionalConfiguration.tools.filter(
          (contribution) =>
            contribution.tool.name !== ASK_USER_QUESTION_TOOL_NAME,
        ),
  );
  const dynamicTools = dynamicToolContributions.map(
    (contribution) => contribution.tool,
  );
  const systemPrompt = cloudroomSystemPrompt(deps.db);
  const instructionSections: string[] = systemPrompt ? [systemPrompt] : [];
  for (const contribution of dynamicToolContributions) {
    if (!contribution.instructions) continue;
    if (contribution.pluginId === null) {
      instructionSections.push(contribution.instructions);
    } else {
      instructionSections.push(
        `The following instructions come from the Cloudroom plugin "${contribution.pluginId}" for its tool "${contribution.tool.name}":`,
        contribution.instructions,
      );
    }
  }
  for (const contribution of listPluginInstructionContributions()) {
    if (contribution.pluginId === CUSTOM_INSTRUCTIONS_PLUGIN_ID) continue;
    let text: string | null;
    try {
      text = contribution.provider({
        threadId: args.thread.id,
        projectId: args.thread.projectId,
      });
    } catch (error) {
      deps.logger.warn(
        {
          err: error,
          pluginId: contribution.pluginId,
          threadId: args.thread.id,
        },
        "Plugin instruction contribution threw; skipping",
      );
      continue;
    }
    if (text === null || text.trim().length === 0) continue;
    if (text.length > pluginInstructionMaxChars(contribution.pluginId)) {
      text = text.slice(0, pluginInstructionMaxChars(contribution.pluginId));
    }
    instructionSections.push(
      `The following instructions come from the Cloudroom plugin "${contribution.pluginId}":`,
      text,
    );
  }
  for (const contribution of conditionalConfiguration.dynamicInstructions) {
    instructionSections.push(
      `The following dynamic instructions come from the Cloudroom plugin "${contribution.pluginId}":`,
      contribution.text,
    );
  }
  if (dataDirAgentInstructions) {
    instructionSections.push(
      `The following user instructions come from <dataDir>/${DATA_DIR_AGENT_INSTRUCTIONS_RELATIVE_PATH}:`,
      dataDirAgentInstructions,
    );
  }
  if (workspaceAgentInstructions) {
    instructionSections.push(
      `The following workspace instructions come from ${WORKSPACE_AGENT_INSTRUCTIONS_RELATIVE_PATH}:`,
      workspaceAgentInstructions,
    );
  }
  const instructions = instructionSections.join("\n\n");
  const threadStoragePath = await requireLiveThreadStoragePath(deps, {
    hostId: args.environment.hostId,
    threadId: args.thread.id,
  });
  return {
    contributedEnv,
    ...(questionsEnabled
      ? {}
      : { disallowedTools: [ASK_USER_QUESTION_TOOL_NAME] }),
    dynamicTools,
    injectedSkillSources,
    instructionMode: "append",
    instructions,
    projectId: args.thread.projectId,
    providerId: args.thread.providerId,
    threadStoragePath,
    workspacePath,
  };
}
