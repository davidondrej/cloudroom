import {
  assertEnvironmentPathAvailable,
  waitForEnvironmentPathAvailable,
} from "../environments/path-admission.js";
import type { EnvironmentRow } from "@cloudroom/db";
import type { Thread } from "@cloudroom/domain";
import type { DbConnection } from "@cloudroom/db";
import type { WorkSessionDeps } from "../../types.js";
import { requireEnvironment } from "../lib/entity-lookup.js";
import {
  goneThreadEnvironmentDetails,
  threadEnvironmentUnavailableDetails,
  throwThreadEnvironmentUnavailable,
} from "../lib/lifecycle-api-errors.js";

type ThreadCommandEnvironmentSource = Pick<Thread, "environmentId">;

interface RequireThreadCommandEnvironmentArgs {
  thread: ThreadCommandEnvironmentSource & Pick<Thread, "id">;
  waitForPathClaim?: boolean;
}

interface RequireThreadHostCommandEnvironmentArgs {
  db: DbConnection;
  thread: ThreadCommandEnvironmentSource;
}

interface ThreadHostCommandEnvironment {
  hostId: string;
  id: string;
}

export function resolveThreadHostCommandEnvironment(
  args: RequireThreadHostCommandEnvironmentArgs,
): ThreadHostCommandEnvironment | null {
  if (args.thread.environmentId === null) {
    return null;
  }
  const environment = requireEnvironment(args.db, args.thread.environmentId);
  return {
    id: environment.id,
    hostId: environment.hostId,
  };
}

export function requireThreadHostCommandEnvironment(
  args: RequireThreadHostCommandEnvironmentArgs,
): ThreadHostCommandEnvironment {
  const environment = resolveThreadHostCommandEnvironment(args);
  if (environment !== null) {
    return environment;
  }

  throwThreadEnvironmentUnavailable(
    threadEnvironmentUnavailableDetails("never_attached", null),
  );
}

export async function requireThreadCommandEnvironment(
  deps: WorkSessionDeps,
  args: RequireThreadCommandEnvironmentArgs,
): Promise<EnvironmentRow> {
  if (args.thread.environmentId !== null) {
    const environment = requireEnvironment(deps.db, args.thread.environmentId);
    const goneDetails = goneThreadEnvironmentDetails(environment);
    if (goneDetails && environment.environmentProviderId === null) {
      throwThreadEnvironmentUnavailable(goneDetails);
    }
    const admission = { ...environment, threadId: args.thread.id };
    if (args.waitForPathClaim === true) {
      await waitForEnvironmentPathAvailable(deps, admission);
      return requireEnvironment(deps.db, environment.id);
    }
    assertEnvironmentPathAvailable(deps, admission);
    return environment;
  }

  throwThreadEnvironmentUnavailable(
    threadEnvironmentUnavailableDetails("never_attached", null),
  );
}
