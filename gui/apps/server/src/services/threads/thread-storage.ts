import { getLatestSessionForHost } from "@cloudroom/db";
import { ApiError } from "../../errors.js";
import { joinHostPathSegments } from "../lib/host-path.js";
import type { WorkSessionDeps } from "../../types.js";
import { requireConnectedHostSession } from "../lib/entity-lookup.js";

interface RequireThreadStoragePathArgs {
  hostId: string;
  threadId: string;
}

export async function requireThreadStoragePath(
  deps: WorkSessionDeps,
  args: RequireThreadStoragePathArgs,
): Promise<string> {
  const session = getLatestSessionForHost(deps.db, { hostId: args.hostId });
  if (session === null) {
    throw new ApiError(
      502,
      "host_unavailable",
      "The host has no known storage location",
      false,
    );
  }
  return joinHostPathSegments(session.dataDir, "thread-storage", args.threadId);
}

export async function requireLiveThreadStoragePath(
  deps: Pick<WorkSessionDeps, "db" | "hub">,
  args: RequireThreadStoragePathArgs,
): Promise<string> {
  const session = requireConnectedHostSession(deps, args.hostId);
  return joinHostPathSegments(session.dataDir, "thread-storage", args.threadId);
}
