import { assertEnvironmentPathAvailable } from "../environments/path-admission.js";
import { z } from "zod";
import {
  createEnvironment,
  type EnvironmentRow,
  createEventId,
  findProjectEnvironmentByHostPath,
  getEnvironment,
  getThread,
  updateThread,
} from "@cloudroom/db";
import {
  canonicalizeHostPath,
  isAbsoluteHostPath,
  isHostPathRoot,
  isHostPathWithin,
  turnScope,
  type HostPathFlavor,
} from "@cloudroom/domain";
import type { DynamicTool, Thread, ToolCallResponse } from "@cloudroom/domain";
import type { AppDeps } from "../../types.js";
import { runLiveHostCommand } from "../hosts/live-command.js";
import { appendThreadEventInTransaction } from "./thread-events.js";
import { buildEnvironmentProvisionCommand } from "./thread-create-helpers.js";
import { findHostDataDir } from "../lib/entity-lookup.js";
import { foreignProviderOwnedPathRefusal } from "./workspace-path-claims.js";
import { resolveExistingThreadPermissionMode } from "./thread-execution-plan.js";
import {
  getHostPathFlavorForHost,
  invalidHostPathMessage,
} from "../lib/host-path.js";

export const UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME =
  "update_environment_directory";

const UPDATE_ENVIRONMENT_DIRECTORY_TIMEOUT_MS = 5 * 60 * 1000;

const updateEnvironmentDirectoryInputSchema = z
  .object({
    path: z.string().trim().min(1),
  })
  .strict();

export const UPDATE_ENVIRONMENT_DIRECTORY_TOOL: DynamicTool = {
  name: UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME,
  description:
    "Move this cloudroom thread to a different working directory for subsequent turns. Use this when the user asks to switch to another existing checkout or local directory. For a new worktree, run `room-cli thread worktree` instead; never create one yourself, because Cloudroom never cleans up unmanaged folders. The path must be an absolute existing directory on the current host. The tool reuses this project's existing cloudroom environment for that host/path, otherwise it creates an unmanaged environment after validating the path. Another project may hold its own environment for the same directory; that is allowed, except for a bb-managed worktree owned by another project, which this tool refuses. After a successful switch, stop the current turn because the running provider cwd will not change until the next turn.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path to an existing directory on the current host.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  presentation: {
    label: {
      pending: "Moving the thread directory",
      completed: "Moved the thread directory",
    },
    icon: { glyph: "FolderOpen" },
  },
};

interface HandleUpdateEnvironmentDirectoryToolCallArgs {
  currentEnvironment: EnvironmentRow;
  input: unknown;
  thread: Thread;
  turnId: string;
}

type ReadyEnvironment = EnvironmentRow & { path: string; status: "ready" };

type AttachEnvironmentResult =
  | { kind: "attached"; changed: boolean }
  | { kind: "environment_changed" }
  | { kind: "thread_unavailable"; message: string };

function toolCallTextResponse(
  success: boolean,
  text: string,
): ToolCallResponse {
  return {
    success,
    contentItems: [{ type: "inputText", text }],
  };
}

function toolCallFailure(text: string): ToolCallResponse {
  return toolCallTextResponse(false, text);
}

function toolCallSuccess(text: string): ToolCallResponse {
  return toolCallTextResponse(true, text);
}

function normalizeDirectoryPath(
  path: string,
  flavor: HostPathFlavor,
): string {
  const trimmed = path.trim();
  if (flavor === "windows") {
    return canonicalizeHostPath(trimmed, flavor);
  }
  return trimmed === "/" ? trimmed : trimmed.replace(/\/+$/u, "");
}

function validateDirectoryPath(
  path: string,
  flavor: HostPathFlavor,
): string | null {
  if (!isAbsoluteHostPath(path, flavor)) {
    return invalidHostPathMessage(flavor);
  }
  if (flavor === "windows" ? isHostPathRoot(path) : path === "/") {
    return "Path must name a project directory, not the filesystem root.";
  }
  if (path.includes("\0")) {
    return "Path must not contain NUL bytes.";
  }
  return null;
}

function threadWritableFailure(thread: Thread): string | null {
  if (thread.deletedAt !== null) {
    return "Cannot update the environment directory for a deleted thread.";
  }
  if (thread.archivedAt !== null) {
    return "Cannot update the environment directory for an archived thread.";
  }
  return null;
}

function workspaceScopeFailure(
  deps: AppDeps,
  args: { hostId: string; path: string; threadId: string },
): string | null {
  let permissionMode: string;
  try {
    permissionMode = resolveExistingThreadPermissionMode(deps, args.threadId);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (permissionMode !== "full") {
    return "This thread runs in the workspace sandbox, so it can't move itself to another directory. Ask the user to move it, or to switch it to Full access.";
  }
  const dataDir = findHostDataDir(deps, args.hostId);
  if (
    dataDir !== null &&
    isHostPathWithin({ rootPath: args.path, candidatePath: dataDir })
  ) {
    return "This directory contains Cloudroom's data folder. Use a different directory.";
  }
  return null;
}

export function resolveReadyEnvironment(
  environment: EnvironmentRow,
): ReadyEnvironment | { failure: string } {
  if (environment.status !== "ready") {
    return {
      failure: `Environment at this path is ${environment.status}, not ready.`,
    };
  }
  if (!environment.path) {
    return {
      failure: "Environment at this path does not have a resolved directory.",
    };
  }
  return {
    ...environment,
    path: environment.path,
    status: environment.status,
  };
}

function successMessage(path: string): string {
  return `Environment directory updated to ${path}. This applies to future turns; stop work in this turn so the next turn can run from the updated directory.`;
}

function attachReadyEnvironment(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    currentEnvironment: EnvironmentRow;
    createdEnvironment: boolean;
    targetEnvironment: ReadyEnvironment;
    thread: Thread;
    turnId: string;
  },
): AttachEnvironmentResult {
  const result = deps.db.transaction(
    (tx): AttachEnvironmentResult => {
      const latestThread = getThread(tx, args.thread.id);
      if (!latestThread || latestThread.deletedAt !== null) {
        return {
          kind: "thread_unavailable",
          message: "Thread no longer exists.",
        };
      }

      const writableFailure = threadWritableFailure(latestThread);
      if (writableFailure) {
        return { kind: "thread_unavailable", message: writableFailure };
      }

      if (latestThread.environmentId === args.targetEnvironment.id) {
        return { kind: "attached", changed: false };
      }

      if (latestThread.environmentId !== args.currentEnvironment.id) {
        return { kind: "environment_changed" };
      }

      updateThread(tx, deps.hub, latestThread.id, {
        environmentId: args.targetEnvironment.id,
      });
      appendThreadEventInTransaction(tx, {
        threadId: latestThread.id,
        environmentId: args.targetEnvironment.id,
        type: "system/operation",
        scope: turnScope(args.turnId),
        data: {
          operation: "environment_directory_update",
          operationId: createEventId(),
          status: "completed",
          message: `Updated environment directory to ${args.targetEnvironment.path}`,
          metadata: {
            createdEnvironment: args.createdEnvironment,
            previousEnvironmentId: args.currentEnvironment.id,
            previousPath: args.currentEnvironment.path,
            nextEnvironmentId: args.targetEnvironment.id,
            nextPath: args.targetEnvironment.path,
          },
        },
      });
      return { kind: "attached", changed: true };
    },
    { behavior: "immediate" },
  );

  if (result.kind === "attached" && result.changed) {
    deps.hub.notifyThread(args.thread.id, ["events-appended"], {
      eventTypes: ["system/operation"],
    });
  }

  return result;
}

export async function provisionUnmanagedEnvironmentForPath(
  deps: AppDeps,
  args: { hostId: string; path: string; projectId: string },
): Promise<ReadyEnvironment | { failure: string }> {
  const refusal = foreignProviderOwnedPathRefusal(deps.db, {
    dataDir: findHostDataDir(deps, args.hostId),
    hostId: args.hostId,
    path: args.path,
    projectId: args.projectId,
  });
  if (refusal !== null) {
    return { failure: `${refusal}. Use a different directory.` };
  }
  const environment = createEnvironment(deps.db, deps.hub, {
    projectId: args.projectId,
    hostId: args.hostId,
    providerOwnsPath: false,
    status: "provisioning",
    environmentProvider: null,
  });
  const command = buildEnvironmentProvisionCommand({
    environmentId: environment.id,
    hostId: args.hostId,
    initiator: null,
    path: args.path,
    setupScriptTimeoutMs: null,
  });

  try {
    await runLiveHostCommand(deps, {
      hostId: args.hostId,
      command,
      timeoutMs: UPDATE_ENVIRONMENT_DIRECTORY_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      failure: `Could not update environment directory to ${args.path}: ${message}`,
    };
  }

  const readyEnvironment = getEnvironment(deps.db, environment.id);
  if (!readyEnvironment) {
    return { failure: "Prepared environment no longer exists." };
  }
  return resolveReadyEnvironment(readyEnvironment);
}

export async function handleUpdateEnvironmentDirectoryToolCall(
  deps: AppDeps,
  args: HandleUpdateEnvironmentDirectoryToolCallArgs,
): Promise<ToolCallResponse> {
  const input = updateEnvironmentDirectoryInputSchema.safeParse(args.input);
  if (!input.success) {
    return toolCallFailure(
      "Invalid arguments. Provide an object with an absolute path string.",
    );
  }

  const flavor = getHostPathFlavorForHost(deps, args.currentEnvironment.hostId);
  const normalizedPath = normalizeDirectoryPath(input.data.path, flavor);
  const pathFailure = validateDirectoryPath(normalizedPath, flavor);
  if (pathFailure) {
    return toolCallFailure(pathFailure);
  }

  const writableFailure = threadWritableFailure(args.thread);
  if (writableFailure) {
    return toolCallFailure(writableFailure);
  }

  const scopeFailure = workspaceScopeFailure(deps, {
    hostId: args.currentEnvironment.hostId,
    path: normalizedPath,
    threadId: args.thread.id,
  });
  if (scopeFailure) {
    return toolCallFailure(scopeFailure);
  }

  try {
    assertEnvironmentPathAvailable(deps, {
      hostId: args.currentEnvironment.hostId,
      path: normalizedPath,
      threadId: args.thread.id,
    });
  } catch (error) {
    return toolCallFailure(
      error instanceof Error ? error.message : String(error),
    );
  }

  if (
    getEnvironment(deps.db, args.currentEnvironment.id)?.path === normalizedPath
  ) {
    return toolCallSuccess(
      `This thread is already using ${normalizedPath} as its environment directory.`,
    );
  }

  const existingEnvironment = findProjectEnvironmentByHostPath(
    deps.db,
    args.thread.projectId,
    args.currentEnvironment.hostId,
    normalizedPath,
  );
  let createdEnvironment = false;
  let targetEnvironment: ReadyEnvironment;

  if (existingEnvironment) {
    const ready = resolveReadyEnvironment(existingEnvironment);
    if ("failure" in ready) {
      return toolCallFailure(ready.failure);
    }
    targetEnvironment = ready;
  } else {
    const provisionedEnvironment = await provisionUnmanagedEnvironmentForPath(
      deps,
      {
        hostId: args.currentEnvironment.hostId,
        path: normalizedPath,
        projectId: args.thread.projectId,
      },
    );
    if ("failure" in provisionedEnvironment) {
      return toolCallFailure(provisionedEnvironment.failure);
    }
    targetEnvironment = provisionedEnvironment;
    createdEnvironment = true;
  }

  let attachResult: AttachEnvironmentResult;
  try {
    assertEnvironmentPathAvailable(deps, {
      ...targetEnvironment,
      threadId: args.thread.id,
    });
    attachResult = attachReadyEnvironment(deps, {
      currentEnvironment: args.currentEnvironment,
      createdEnvironment,
      targetEnvironment,
      thread: args.thread,
      turnId: args.turnId,
    });
  } catch (error) {
    return toolCallFailure(
      error instanceof Error ? error.message : String(error),
    );
  }

  switch (attachResult.kind) {
    case "attached":
      return toolCallSuccess(successMessage(targetEnvironment.path));
    case "environment_changed":
      return toolCallFailure(
        "Thread environment changed while preparing the new directory. Try again with the desired path.",
      );
    case "thread_unavailable":
      return toolCallFailure(attachResult.message);
  }
}
