import { setTimeout as delay } from "node:timers/promises";
import {
  findEnvironmentPathClaim,
  getPreparingEnvironment,
  type EnvironmentRow,
} from "@cloudroom/db";
import { canonicalizeHostPath, isAbsoluteHostPath } from "@cloudroom/domain";
import type { WorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  getHostPathFlavorForHost,
  invalidHostPathMessage,
} from "../lib/host-path.js";

export const CHECKOUT_BUSY_MESSAGE =
  "Cannot checkout branch while another thread is using this workspace";
const SIBLING_STARTING_MESSAGE =
  "Another thread is starting in this folder. Try again in a few seconds.";
const PATH_CLAIM_WAIT_MS = 15_000;

interface EnvironmentPathAdmissionArgs {
  hostId: string;
  path: string | null;
  threadId: string | null;
}

function environmentPathClaim(
  deps: WorkSessionDeps,
  args: EnvironmentPathAdmissionArgs,
): EnvironmentRow | null {
  if (args.path === null) return null;
  const flavor = getHostPathFlavorForHost(deps, args.hostId);
  if (flavor === "windows" && !isAbsoluteHostPath(args.path, flavor)) {
    throw new ApiError(400, "invalid_request", invalidHostPathMessage(flavor));
  }
  if (findEnvironmentPathClaim(deps.db, args.hostId, null, null) === null) {
    return null;
  }
  const path = canonicalizeHostPath(args.path, flavor);
  const provisioning =
    args.threadId === null
      ? null
      : getPreparingEnvironment(deps.db, args.threadId);
  return findEnvironmentPathClaim(deps.db, args.hostId, path, provisioning);
}

export function assertEnvironmentPathAvailable(
  deps: WorkSessionDeps,
  args: EnvironmentPathAdmissionArgs,
): void {
  if (environmentPathClaim(deps, args) !== null)
    throw new ApiError(409, "workspace_busy", CHECKOUT_BUSY_MESSAGE);
}

export async function waitForEnvironmentPathAvailable(
  deps: WorkSessionDeps,
  args: EnvironmentPathAdmissionArgs,
): Promise<void> {
  const deadline = Date.now() + PATH_CLAIM_WAIT_MS;
  let claim = environmentPathClaim(deps, args);
  while (claim !== null) {
    if (claim.status === "error" && claim.ownerThreadId !== null)
      throw new ApiError(
        409,
        "workspace_busy",
        `Thread ${claim.ownerThreadId} failed to set up in this folder and still holds it. Archive or retry it.`,
      );
    if (Date.now() >= deadline)
      throw new ApiError(409, "workspace_busy", SIBLING_STARTING_MESSAGE);
    await delay(250);
    claim = environmentPathClaim(deps, args);
  }
}
