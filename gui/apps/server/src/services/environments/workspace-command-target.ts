import type { EnvironmentStatus } from "@cloudroom/domain";
import type { WorkspaceContext } from "@cloudroom/host-daemon-contract";
import { ApiError } from "../../errors.js";
import { throwEnvironmentNotReady } from "../lib/lifecycle-api-errors.js";

export const WORKTREE_PARKED_MESSAGE =
  "Parked to save disk. Returns on your next message.";

interface WorkspaceCommandTargetEnvironment {
  hostId: string;
  id: string;
  path: string | null;
  status: EnvironmentStatus;
  parkedAt?: number | null;
}

interface WorkspaceCommandTargetPath {
  path: string;
}

export interface WorkspaceCommandTarget {
  environmentId: string;
  hostId: string;
  workspaceContext: WorkspaceContext;
}

export function workspaceContextFromPath(
  target: WorkspaceCommandTargetPath,
): WorkspaceContext {
  return {
    workspacePath: target.path,
  };
}

export function requireWorkspaceCommandTarget(
  environment: WorkspaceCommandTargetEnvironment,
): WorkspaceCommandTarget {
  if (environment.status !== "ready" || !environment.path) {
    throwEnvironmentNotReady(environment);
  }
  // Its folder is gone until the thread's next message rebuilds it.
  if (environment.parkedAt != null)
    throw new ApiError(409, "environment_parked", WORKTREE_PARKED_MESSAGE);

  return {
    environmentId: environment.id,
    hostId: environment.hostId,
    workspaceContext: workspaceContextFromPath({ path: environment.path }),
  };
}
