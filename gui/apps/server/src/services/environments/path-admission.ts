import {
  findEnvironmentPathClaim,
  getPreparingEnvironment,
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

export function assertEnvironmentPathAvailable(
  deps: WorkSessionDeps,
  args: { hostId: string; path: string | null; threadId: string | null },
): void {
  if (args.path === null) return;
  const flavor = getHostPathFlavorForHost(deps, args.hostId);
  if (flavor === "windows" && !isAbsoluteHostPath(args.path, flavor)) {
    throw new ApiError(400, "invalid_request", invalidHostPathMessage(flavor));
  }
  if (findEnvironmentPathClaim(deps.db, args.hostId, null, null) === null) {
    return;
  }
  const path = canonicalizeHostPath(args.path, flavor);
  const provisioning =
    args.threadId === null
      ? null
      : getPreparingEnvironment(deps.db, args.threadId);
  if (
    findEnvironmentPathClaim(deps.db, args.hostId, path, provisioning) !== null
  )
    throw new ApiError(409, "workspace_busy", CHECKOUT_BUSY_MESSAGE);
}
