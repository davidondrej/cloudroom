import { randomUUID } from "node:crypto";
import { Command } from "commander";
import {
  jsonValueSchema,
  looksLikePath,
  PERSONAL_PROJECT_ID,
  threadVisibilitySchema,
  type GitBranchSelection,
  type EnvironmentMachineSelection,
  type Thread,
  type JsonValue,
} from "@cloudroom/domain";
import type { CreateThreadEnvironmentArgs } from "@cloudroom/server-contract";
import {
  BbRequestTimeoutError,
  DEFAULT_BB_REQUEST_TIMEOUT_MS,
} from "@cloudroom/sdk/node";
import { action } from "../../action.js";
import { CLI_READ_TIMEOUT_MS, createCliRoomSdk } from "../../client.js";
import {
  resolveExplicitIdFlag,
  resolveContextThreadId,
} from "../../context-env.js";
import { resolveLocalHostId } from "../../daemon.js";
import {
  resolveMachineHostId,
  resolveMachineTargetOption,
} from "../machine.js";
import {
  addPromptFileOption,
  collectOption,
  getErrorMessage,
  outputJson,
  parseReasoningLevel,
  prependErrorContext,
} from "../helpers.js";
import {
  parsePermissionMode,
  buildPromptInputs,
  requirePromptContent,
  uploadClientAttachmentInputs,
  PERMISSION_MODE_HELP,
  PLAN_HELP,
  parseServiceTier,
} from "./helpers.js";
import { SEND_AT_HELP, parseSendAt } from "./send-time.js";

const SPAWN_ATTEMPTS = 3;

const PROVIDER_HELP =
  "Provider ID for the thread, such as claude-code or codex. Required with --machine cloud; otherwise omit to use the project's remembered provider choice";

interface ThreadSpawnCommandOptions {
  prompt: string;
  requestId?: string;
  json?: boolean;
  project?: string;
  environment?: string;
  newEnvironment?: string;
  environmentProvider?: string;
  environmentInputs?: string;
  baseBranch?: string;
  parentThread?: string;
  provider?: string;
  model?: string;
  reasoningLevel?: string;
  title?: string;
  serviceTier?: string;
  permissionMode?: string;
  plan?: boolean;
  parentSelf?: boolean;
  machine?: string;
  host?: string;
  newMachine?: string;
  machineInputs?: string;
  file?: string[];
  image?: string[];
  section?: string;
  originKind?: string;
  sourceThread?: string;
  sourceSeqEnd?: string;
  visibility?: string;
  sendAt?: string;
}

export { looksLikePath };

export function requireHostId(hostId: string | null): string {
  if (!hostId) {
    throw new Error("Cannot reach local host daemon. Is it running?");
  }
  return hostId;
}

export function resolveSpawnEnvironmentValue(
  flagValue?: string,
): string | undefined {
  const trimmedValue = flagValue?.trim();
  if (!trimmedValue) return undefined;
  if (looksLikePath(trimmedValue)) return trimmedValue;
  return resolveExplicitIdFlag({
    flagName: "--environment flag",
    value: trimmedValue,
  });
}

// Agents copy the short Claude ID from their system prompt (claude-opus-5-5),
// which silently picks the 200K model. Keep the caller's exact 1M variant.
async function preferCallerModel(
  sdk: ReturnType<typeof createCliRoomSdk>,
  model: string,
): Promise<string> {
  const threadId = resolveContextThreadId();
  if (!threadId) return model;
  try {
    const own = await sdk.threads.defaultExecutionOptions({ threadId });
    return own?.model === `${model}[1m]` ? own.model : model;
  } catch (error) {
    if (error instanceof BbRequestTimeoutError) throw error;
    return model;
  }
}

function resolveSpawnParentThreadId(args: {
  parentSelf?: boolean;
  parentThread?: string;
}): string | undefined {
  const explicitParentThreadId = resolveExplicitIdFlag({
    flagName: "--parent-thread",
    value: args.parentThread,
  });
  if (explicitParentThreadId && args.parentSelf) {
    throw new Error("Cannot combine --parent-thread with --parent-self.");
  }
  if (args.parentSelf) {
    const selfThreadId = resolveContextThreadId();
    if (!selfThreadId) {
      throw new Error("--parent-self requires ROOM_THREAD_ID to be set.");
    }
    return selfThreadId;
  }
  return explicitParentThreadId;
}

export function buildSpawnEnvironment(args: {
  defaultPersonalWorkspace: boolean;
  environmentValue?: string;
  newEnvironmentKind?: string;
  hostId: string | null;
  baseBranch?: string;
}): CreateThreadEnvironmentArgs {
  const environmentValue = args.environmentValue?.trim();
  const newEnvironmentKind = args.newEnvironmentKind?.trim();
  const trimmedBaseBranch = args.baseBranch?.trim();
  const baseBranch: GitBranchSelection = trimmedBaseBranch
    ? { kind: "named", name: trimmedBaseBranch }
    : { kind: "default" };

  if (environmentValue && newEnvironmentKind) {
    throw new Error("Cannot combine --environment with --new-environment.");
  }
  if (trimmedBaseBranch && newEnvironmentKind !== "worktree") {
    throw new Error("--base-branch requires --new-environment worktree.");
  }
  if (newEnvironmentKind) {
    if (newEnvironmentKind === "personal") {
      return {
        type: "host",
        hostId: requireHostId(args.hostId),
        workspace: { type: "personal" },
      };
    }
    if (newEnvironmentKind === "worktree") {
      return {
        type: "host",
        hostId: requireHostId(args.hostId),
        workspace: { type: "managed-worktree", baseBranch },
      };
    }
    throw new Error(
      `Unknown environment kind '${newEnvironmentKind}'. Supported: personal, worktree.`,
    );
  }
  if (!environmentValue) {
    if (args.hostId !== null) {
      return {
        type: "host",
        hostId: args.hostId,
        workspace: args.defaultPersonalWorkspace
          ? { type: "personal" }
          : { type: "unmanaged", path: null },
      };
    }
    return { type: "project-default" };
  }
  if (looksLikePath(environmentValue)) {
    return {
      type: "host",
      hostId: requireHostId(args.hostId),
      workspace: { type: "unmanaged", path: environmentValue },
    };
  }
  return {
    type: "reuse",
    environmentId: environmentValue,
  };
}

function parseJsonFlag(
  flagValue: string | undefined,
  flagName: "--environment-inputs" | "--machine-inputs",
): JsonValue | null {
  if (flagValue === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(flagValue);
  } catch {
    throw new Error(`${flagName} must be valid JSON.`);
  }
  return jsonValueSchema.parse(parsed);
}

async function buildProviderSpawnEnvironment(args: {
  serverUrl: string;
  environmentProvider: string;
  environmentInputs: string | undefined;
  environmentValue: string | undefined;
  newEnvironmentKind: string | undefined;
  baseBranch: string | undefined;
  machineHostId: string | null;
  machine: EnvironmentMachineSelection | null;
  machineInputs: JsonValue | null;
  machineInputsProvided: boolean;
  projectId: string;
  resolveDefaultHostId: () => Promise<string | null>;
}): Promise<CreateThreadEnvironmentArgs> {
  if (args.environmentValue || args.newEnvironmentKind) {
    throw new Error(
      "Cannot combine --environment-provider with --environment or --new-environment.",
    );
  }
  if (args.baseBranch?.trim()) {
    throw new Error(
      "--base-branch requires --new-environment worktree; an --environment-provider takes its branch through --environment-inputs.",
    );
  }
  const requested = args.environmentProvider.trim();
  const providers = await createCliRoomSdk(
    args.serverUrl,
    CLI_READ_TIMEOUT_MS,
  ).environments.listProviders({ projectId: args.projectId });
  const match = providers.find((provider) => provider.id === requested);
  if (match === undefined) {
    const available = providers.map((provider) => provider.id).join(", ");
    throw new Error(
      `Unknown environment provider '${requested}'.${available ? ` Available: ${available}.` : ""}`,
    );
  }
  let inputs = parseJsonFlag(args.environmentInputs, "--environment-inputs");
  if (match.inputs !== null && inputs === null) {
    if (match.acceptsEmptyInputs) {
      inputs = {};
    } else {
      throw new Error(
        `The '${match.id}' environment provider needs --environment-inputs <json>; \`room-cli environment providers --json\` shows its schema.`,
      );
    }
  }
  if (match.inputs === null && inputs !== null) {
    throw new Error(
      `The '${match.id}' environment provider takes no --environment-inputs.`,
    );
  }
  if (match.machineProviderId) {
    if (args.machine !== null || args.machineHostId !== null)
      throw new Error(
        "This environment provider chooses its own new machine; omit machine selectors.",
      );
    let machineInputs = args.machineInputs;
    if (match.machineInputs !== undefined) {
      if (match.machineInputs !== null && machineInputs === null) {
        if (match.machineAcceptsEmptyInputs) machineInputs = {};
        else {
          throw new Error(
            `The '${match.machineProviderId}' machine provider needs --machine-inputs <json>; \`room-cli environment providers --json\` shows its schema.`,
          );
        }
      }
      if (match.machineInputs === null && machineInputs !== null) {
        throw new Error(
          `The '${match.machineProviderId}' machine provider takes no --machine-inputs.`,
        );
      }
    }
    return {
      type: "provider",
      environmentProviderId: match.id,
      ...(match.machineInputs === undefined || match.machineInputs === null
        ? {}
        : {
            machine: {
              type: "new" as const,
              machineProviderId: match.machineProviderId,
              inputs: machineInputs,
            },
          }),
      inputs,
    };
  }
  if (args.machineInputsProvided && args.machine === null) {
    throw new Error(
      "--machine-inputs requires --new-machine <provider-id> or a composed --environment-provider.",
    );
  }
  const machine = args.machine ?? {
    type: "existing" as const,
    hostId: requireHostId(
      args.machineHostId ?? (await args.resolveDefaultHostId()),
    ),
  };
  return {
    type: "provider",
    environmentProviderId: match.id,
    machine,
    inputs,
  };
}

export function registerSpawnCommand(
  parent: Command,
  getUrl: () => string,
): void {
  addPromptFileOption(
    parent
      .command("spawn")
      .description(
        "Spawn a new thread; omitted execution flags use remembered project defaults, then the target provider catalog default",
      )
      .requiredOption("--prompt <prompt>", "Initial prompt for the thread"),
  )
    .option(
      "--request-id <id>",
      "Stable request ID; after an unanswered spawn, re-run with it to get that thread instead of a duplicate",
    )
    .option("--json", "Print machine-readable JSON output")
    .requiredOption("--project <id>", "Project ID")
    .option(
      "--environment <id-or-path>",
      "Existing environment ID or unmanaged workspace path",
    )
    .option(
      "--new-environment <kind>",
      "Create a fresh environment of the given kind (personal or worktree)",
    )
    .option(
      "--base-branch <branch>",
      "Exact Git ref; omit for Cloudroom's project default (use origin/<branch> for a remote ref). With --machine cloud: a pushed GitHub branch name",
    )
    .option(
      "--machine <id-or-name>",
      "local, cloud (Rust core), or an existing native machine ID/name",
    )
    .option("--host <id-or-name>", "Alias for --machine")
    .option(
      "--new-machine <provider-id>",
      "Create the thread on a new machine from this machine provider",
    )
    .option(
      "--machine-inputs <json>",
      "Persisted non-secret inputs for --new-machine or a composed --environment-provider; store credentials in plugin settings",
    )
    .option("--parent-thread <id>", "Parent thread ID for worker thread links")
    .option("--parent-self", "Parent the new thread to ROOM_THREAD_ID")
    .option("--provider <id>", PROVIDER_HELP)
    .option(
      "--model <model>",
      "Model ID for the thread. Omit to use the project's remembered default for the resolved provider",
    )
    .option(
      "--reasoning-level <level>",
      "Reasoning level: low, medium, high, xhigh, max (provider-dependent)",
    )
    .option("--title <title>", "Thread title")
    .option("--service-tier <tier>", "Service tier: fast or default")
    .option("--permission-mode <mode>", PERMISSION_MODE_HELP)
    .option("--plan", PLAN_HELP)
    .option(
      "--file <path>",
      "Upload an absolute path or file: URL from this CLI machine or pass an uploaded attachment path (repeatable)",
      collectOption,
      [],
    )
    .option(
      "--image <path>",
      "Upload an absolute path or file: URL from this CLI machine or pass an uploaded attachment path (repeatable)",
      collectOption,
      [],
    )
    .option("--section <id>", "Create the thread in a section")
    .option(
      "--visibility <visibility>",
      "Thread visibility: visible or hidden (a child inherits its parent)",
    )
    .option(
      "--environment-provider <id>",
      "Run on an environment provider by id (list them with `room-cli environment providers`)",
    )
    .option(
      "--environment-inputs <json>",
      "JSON value for an --environment-provider that declares inputs (`room-cli environment providers --json` shows the schema)",
    )
    .option("--send-at <when>", SEND_AT_HELP)
    .option("--origin-kind <kind>", "Thread origin: fork")
    .option("--source-thread <id>", "Source thread for a fork")
    .option(
      "--source-seq-end <seq>",
      "Fork after the source turn containing this event sequence",
    )
    .action(
      action(async (opts: ThreadSpawnCommandOptions) => {
        if (opts.originKind === undefined) {
          requirePromptContent({
            message: opts.prompt,
            files: opts.file,
            images: opts.image,
          });
        }
        const projectId = resolveExplicitIdFlag({
          flagName: "--project flag",
          value: opts.project,
        });
        if (!projectId) {
          throw new Error("Missing required option --project <id>.");
        }
        const environmentValue = resolveSpawnEnvironmentValue(opts.environment);
        if (
          opts.environmentInputs !== undefined &&
          !opts.environmentProvider &&
          !opts.newMachine
        ) {
          throw new Error(
            "--environment-inputs requires --environment-provider <id>.",
          );
        }
        const machineTarget = resolveMachineTargetOption(opts);
        const cloudTarget = machineTarget === "cloud";
        if (cloudTarget && (environmentValue || opts.newEnvironment || opts.environmentProvider || opts.newMachine || opts.machineInputs || opts.environmentInputs)) throw new Error("Cloud uses its prepared repository; native environment and machine options cannot be combined with --machine cloud.");
        if (cloudTarget && !opts.provider?.trim()) throw new Error("Select a provider with --provider for Cloud, such as claude-code or codex.");
        if (cloudTarget && !opts.model) throw new Error("Select a model with --model for Cloud.");
        if (machineTarget && opts.newMachine) {
          throw new Error(
            "Cannot combine --new-machine with --machine or --host.",
          );
        }
        if (opts.machineInputs !== undefined && !opts.newMachine) {
          if (!opts.environmentProvider)
            throw new Error(
              "--machine-inputs requires --new-machine <provider-id> or a composed --environment-provider.",
            );
        }
        if (
          machineTarget &&
          environmentValue &&
          !looksLikePath(environmentValue)
        ) {
          throw new Error(
            "Cannot combine --machine or --host with an existing environment ID; that environment already selects its machine.",
          );
        }
        const machineProvider = opts.newMachine
          ? (
              await createCliRoomSdk(
                getUrl(),
                CLI_READ_TIMEOUT_MS,
              ).hosts.experimental_listProviders()
            ).find((provider) => provider.id === opts.newMachine?.trim())
          : undefined;
        if (opts.newMachine && machineProvider === undefined) {
          throw new Error(
            `Unknown machine provider '${opts.newMachine.trim()}'.`,
          );
        }
        let machineInputs = parseJsonFlag(
          opts.machineInputs,
          "--machine-inputs",
        );
        if (
          machineProvider &&
          machineProvider.inputs !== null &&
          machineInputs === null
        ) {
          if (machineProvider.acceptsEmptyInputs) machineInputs = {};
          else {
            throw new Error(
              `The '${machineProvider?.id}' machine provider needs --machine-inputs <json>; \`room-cli machine providers --json\` shows its schema.`,
            );
          }
        }
        if (
          machineProvider &&
          machineProvider.inputs === null &&
          machineInputs !== null
        ) {
          throw new Error(
            `The '${machineProvider.id}' machine provider takes no --machine-inputs.`,
          );
        }
        const newMachineSelection =
          machineProvider === undefined
            ? null
            : {
                type: "new" as const,
                machineProviderId: machineProvider.id,
                inputs: machineInputs,
              };
        const selectedEnvironmentProvider = opts.environmentProvider;
        if (machineProvider && selectedEnvironmentProvider === undefined) {
          throw new Error(
            `The '${machineProvider.id}' machine provider requires an environment provider; combine --new-machine with --environment-provider <id>.`,
          );
        }
        const needsHostId =
          !opts.environmentProvider &&
          !opts.newMachine &&
          (Boolean(opts.newEnvironment) ||
            (environmentValue !== undefined &&
              looksLikePath(environmentValue)));
        const hostId = cloudTarget ? null : machineTarget === "local" ? await resolveLocalHostId() : machineTarget
          ? await resolveMachineHostId({
              serverUrl: getUrl(),
              target: machineTarget,
            })
          : needsHostId
            ? await resolveLocalHostId()
            : null;
        const environment = cloudTarget ? { type: "project-default" as const } : selectedEnvironmentProvider
          ? await buildProviderSpawnEnvironment({
              serverUrl: getUrl(),
              environmentProvider: selectedEnvironmentProvider,
              environmentInputs: opts.environmentInputs,
              environmentValue,
              newEnvironmentKind: opts.newEnvironment,
              baseBranch: opts.baseBranch,
              machineHostId: hostId,
              machine: newMachineSelection,
              machineInputs,
              machineInputsProvided: opts.machineInputs !== undefined,
              projectId,
              resolveDefaultHostId: resolveLocalHostId,
            })
          : buildSpawnEnvironment({
              defaultPersonalWorkspace: projectId === PERSONAL_PROJECT_ID,
              environmentValue,
              newEnvironmentKind: opts.newEnvironment,
              hostId,
              baseBranch: opts.baseBranch,
            });
        const reasoningLevel = parseReasoningLevel(opts.reasoningLevel);
        const serviceTier = parseServiceTier(opts.serviceTier);
        const permissionMode = parsePermissionMode(opts.permissionMode);
        const visibility =
          opts.visibility === undefined
            ? undefined
            : threadVisibilitySchema.parse(opts.visibility);
        const parentThreadId = resolveSpawnParentThreadId({
          parentSelf: opts.parentSelf,
          parentThread: opts.parentThread,
        });
        if (opts.originKind !== undefined && opts.originKind !== "fork") {
          throw new Error("--origin-kind must be fork.");
        }
        const sourceSeqEnd =
          opts.sourceSeqEnd === undefined
            ? undefined
            : Number(opts.sourceSeqEnd);
        if (
          sourceSeqEnd !== undefined &&
          (!Number.isInteger(sourceSeqEnd) || sourceSeqEnd < 0)
        ) {
          throw new Error("--source-seq-end must be a non-negative integer.");
        }
        const sendAt =
          opts.sendAt === undefined ? undefined : parseSendAt(opts.sendAt);
        const providerId = opts.provider?.trim();
        const startedOnBehalfOf =
          !cloudTarget &&
          opts.originKind === undefined &&
          parentThreadId !== undefined &&
          parentThreadId === resolveContextThreadId()
            ? { initiator: "agent" as const, senderThreadId: parentThreadId }
            : null;

        // The calling agent, so the website can tell which agent starts Cloud threads (docs/scopes/credit-burn.md).
        const launcherThreadId = resolveContextThreadId();
        // Sent on every spawn, so an unanswered one can be retried without a duplicate.
        const requestId = opts.requestId ?? randomUUID();
        let thread: Thread;
        try {
          const sdk = createCliRoomSdk(getUrl(), DEFAULT_BB_REQUEST_TIMEOUT_MS);
          const model = opts.model && (await preferCallerModel(sdk, opts.model));
          const input = await uploadClientAttachmentInputs({
            input: buildPromptInputs({
              message: opts.prompt,
              plan: opts.plan,
              files: opts.file,
              images: opts.image,
            }),
            resolveProjectId: async () => projectId,
            sdk,
          });
          const spawnArgs: Parameters<typeof sdk.threads.spawn>[0] = {
            requestId,
            ...(cloudTarget
              ? {
                  executionTarget: "cloud" as const,
                  ...(opts.baseBranch?.trim()
                    ? { baseBranch: opts.baseBranch.trim() }
                    : {}),
                }
              : {}),
            origin: "cli",
            projectId,
            ...(providerId ? { providerId } : {}),
            ...(model ? { model } : {}),
            input,
            ...(reasoningLevel ? { reasoningLevel } : {}),
            ...(opts.title ? { title: opts.title } : {}),
            ...(serviceTier ? { serviceTier } : {}),
            ...(permissionMode ? { permissionMode } : {}),
            ...(visibility ? { visibility } : {}),
            environment,
            startedOnBehalfOf,
            ...(launcherThreadId && /^thr_[a-z0-9]{1,40}$/.test(launcherThreadId) ? { launcherThreadId } : {}),
            originKind: opts.originKind ?? null,
            ...(parentThreadId ? { parentThreadId } : {}),
            ...(opts.section ? { sectionId: opts.section } : {}),
            ...(opts.sourceThread ? { sourceThreadId: opts.sourceThread } : {}),
            ...(sourceSeqEnd !== undefined ? { sourceSeqEnd } : {}),
            ...(sendAt !== undefined ? { sendAt } : {}),
          };
          let unconfirmed = false;
          for (let attempt = 1; ; attempt += 1) {
            try {
              thread = await sdk.threads.spawn(spawnArgs);
              break;
            } catch (error) {
              // Only a timeout or a dropped connection leaves the outcome unknown.
              const timedOut = error instanceof BbRequestTimeoutError;
              const unknown = timedOut || error instanceof TypeError;
              const reason = timedOut
                ? `no answer within ${DEFAULT_BB_REQUEST_TIMEOUT_MS / 1000} seconds; it may be busy`
                : getErrorMessage(error);
              // Said at once: an agent's command timeout can stop this before the last attempt.
              if (unknown && !unconfirmed)
                console.error(
                  `Cloudroom at ${getUrl()} has not confirmed the spawn (${reason}); retrying. If this command stops, re-run it with --request-id ${requestId} to get the thread instead of a duplicate.`,
                );
              unconfirmed ||= unknown;
              if (!unconfirmed) throw error;
              // The same request ID joins a slow create still running (a first clone, a waking machine).
              if (unknown && attempt < SPAWN_ATTEMPTS) continue;
              throw new Error(
                `Cloudroom at ${getUrl()} did not confirm the spawn (${reason}). The thread may already exist: re-run with --request-id ${requestId} to get it instead of a duplicate.`,
              );
            }
          }
          const loopRunId = process.env.BB_AUTOMATION_RUN_ID?.trim();
          if (loopRunId) {
            await sdk.plugins
              .callRpc({
                pluginId: "automations",
                method: "automations_link_thread",
                input: { runId: loopRunId, threadId: thread.id },
                outputSchema: jsonValueSchema,
              })
              .catch(() => undefined);
          }
        } catch (err: unknown) {
          throw prependErrorContext("Failed to create thread", err);
        }

        if (outputJson(opts, thread)) return;
        console.log(`Thread spawned: ${thread.id}`);
        if (sendAt !== undefined) {
          console.log(
            `First message scheduled for ${new Date(sendAt).toLocaleString()}; the thread stays pending until then.`,
          );
        }
        // A hidden child reports to its parent too, so the promise follows the
        // parent link alone.
        if (
          thread.parentThreadId &&
          thread.parentThreadId === resolveContextThreadId()
        ) {
          console.log("You will be notified when this thread is done.");
        }
        printThread(thread);
      }),
    );
}

function printThread(thread: Thread): void {
  console.log("");
  console.log(`  ID:       ${thread.id}`);
  console.log(
    `  Project:  ${thread.projectId === PERSONAL_PROJECT_ID ? "-" : thread.projectId}`,
  );
  console.log(`  Status:   ${thread.status}`);
  if (thread.visibility === "hidden") {
    console.log("  Visibility: hidden");
  }
  if (thread.archivedAt !== null) {
    console.log(`  Archived: ${new Date(thread.archivedAt).toLocaleString()}`);
  }
  console.log(`  Created:  ${new Date(thread.createdAt).toLocaleString()}`);
  console.log(`  Updated:  ${new Date(thread.updatedAt).toLocaleString()}`);
  console.log("");
}
