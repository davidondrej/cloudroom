import { getProjectSourceByHost, type DbConnection } from "@cloudroom/db";
import {
  isLocalPathProjectSource,
  PERSONAL_PROJECT_ID,
  PLAIN_NON_GIT_DIRECTORY_REASON,
  type GitSourceInspection,
  type ProjectSource,
} from "@cloudroom/domain";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import type { WorkSessionDeps } from "../../types.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import { runtimeErrorLogFields } from "../lib/error-log-fields.js";
import {
  getNonDestroyedHostWithStatus,
  requirePublicProject,
  listPublicHostsWithStatus,
} from "../lib/entity-lookup.js";
import {
  acceptsEmptyInputs,
  parseProviderAvailabilityInvocation,
} from "../lib/provider-availability.js";
import {
  environmentProviderDecisionTimeoutMs,
  invokeEnvironmentProvider,
  type PluginEnvironmentProviderRecord,
} from "../plugins/plugin-environment-provider-registry.js";
import type {
  PluginEnvironmentProviderAvailability,
  PluginEnvironmentProviderAvailabilityContext,
} from "@get-bb/plugin-sdk/environment-provider";
import { resolveDefaultWorktreeBaseBranch } from "../projects/worktree-base-branch.js";
import { decideWithinBox } from "../threads/dispatch-hooks.js";

export type GitCheckoutUnavailableReason =
  | "unborn"
  | "non_git_directory"
  | "invalid";

export type GitCheckoutAvailability =
  | { status: "available" }
  | {
      status: "unavailable";
      reason: GitCheckoutUnavailableReason;
      message: string;
    };
export type EnvironmentProviderAvailabilityResolution =
  | { ok: true; availability: PluginEnvironmentProviderAvailability }
  | { ok: false; message: string };

export function environmentProviderAcceptsEmptyInputs(
  record: PluginEnvironmentProviderRecord,
): Promise<boolean> {
  return acceptsEmptyInputs(record.provider, (run) =>
    invokeEnvironmentProvider(
      record,
      `"${record.provider.id}" environment provider empty inputs`,
      run,
    ),
  );
}

export function environmentProviderMatchesContext(
  deps: WorkSessionDeps,
  record: PluginEnvironmentProviderRecord,
  query: { projectId: string; hostId?: string },
): boolean {
  const project = requirePublicProject(deps.db, query.projectId);
  const hosts =
    query.hostId === undefined
      ? listPublicHostsWithStatus(deps)
      : [getNonDestroyedHostWithStatus(deps, query.hostId)];
  return hosts.some((host) => {
    if (host === null) return false;
    const requires = record.provider.requires;
    if (requires.projectless !== (project.id === PERSONAL_PROJECT_ID)) {
      return false;
    }
    const source = getProjectSourceByHost(deps.db, project.id, host.id);
    const projectCheckout =
      source !== null && isLocalPathProjectSource(source)
        ? { path: source.path }
        : null;
    // A project with a Git remote is cloned onto the machine on first use.
    if (
      (requires.projectCheckout || requires.gitCheckout) &&
      projectCheckout === null &&
      project.gitRemoteUrl === null
    ) {
      return false;
    }
    if (requires.gitRemote && project.gitRemoteUrl === null) return false;
    return true;
  });
}

export async function resolvePluginEnvironmentProviderAvailability(
  record: PluginEnvironmentProviderRecord,
  context: PluginEnvironmentProviderAvailabilityContext,
): Promise<EnvironmentProviderAvailabilityResolution> {
  const availability = record.provider.availability;
  if (availability === null) {
    return { ok: true, availability: { status: "available" } };
  }
  const invocation = await invokeEnvironmentProvider(
    record,
    `"${record.provider.id}" environment provider availability`,
    () =>
      decideWithinBox(
        () => Promise.resolve(availability(context)),
        environmentProviderDecisionTimeoutMs(),
      ),
  );
  return parseProviderAvailabilityInvocation(record.pluginId, invocation);
}

export interface CheckoutInspectionCache {
  gitCheckoutAvailability: Map<string, Promise<GitCheckoutAvailability>>;
  projectSources: Map<string, ProjectSource | null>;
}

export function createCheckoutInspectionCache(): CheckoutInspectionCache {
  return {
    gitCheckoutAvailability: new Map(),
    projectSources: new Map(),
  };
}

export function getCachedProjectSourceByHost(
  db: DbConnection,
  args: {
    cache?: CheckoutInspectionCache;
    hostId: string;
    projectId: string;
  },
): ProjectSource | null {
  if (args.cache === undefined) {
    return getProjectSourceByHost(db, args.projectId, args.hostId);
  }
  const key = JSON.stringify([args.projectId, args.hostId]);
  if (args.cache.projectSources.has(key)) {
    return args.cache.projectSources.get(key) ?? null;
  }
  const source = getProjectSourceByHost(db, args.projectId, args.hostId);
  args.cache.projectSources.set(key, source);
  return source;
}

export function gitCheckoutAvailabilityKey(
  hostId: string,
  path: string,
): string {
  return JSON.stringify([hostId, path]);
}

interface InspectedGitCheckoutAvailability {
  availability: GitCheckoutAvailability;
  cacheable: boolean;
}

const pendingGitInspections = new WeakMap<
  object,
  Map<string, Promise<InspectedGitCheckoutAvailability>>
>();

export function resolveGitCheckoutAvailability(
  deps: WorkSessionDeps,
  args: {
    cache?: CheckoutInspectionCache;
    hostId: string;
    path: string;
  },
): Promise<GitCheckoutAvailability> {
  const key = gitCheckoutAvailabilityKey(args.hostId, args.path);
  const cached = args.cache?.gitCheckoutAvailability.get(key);
  if (cached !== undefined) return cached;
  let pending = pendingGitInspections.get(deps.db);
  if (pending === undefined) {
    pending = new Map();
    pendingGitInspections.set(deps.db, pending);
  }
  let inFlight = pending.get(key);
  if (inFlight === undefined) {
    inFlight = inspectGitCheckoutAvailability(deps, args).finally(() =>
      pending.delete(key),
    );
    pending.set(key, inFlight);
  }
  const cache = args.cache;
  return inFlight.then((inspected) => {
    if (cache !== undefined && inspected.cacheable) {
      cache.gitCheckoutAvailability.set(
        key,
        Promise.resolve(inspected.availability),
      );
    }
    return inspected.availability;
  });
}

export function classifyGitCheckoutAvailability(
  path: string,
  inspection: GitSourceInspection,
): GitCheckoutAvailability {
  const { checkout } = inspection;
  if (
    (checkout.kind === "unknown" || checkout.kind === "unborn") &&
    resolveDefaultWorktreeBaseBranch(inspection) === null
  ) {
    if (checkout.kind === "unborn") {
      return {
        status: "unavailable",
        reason: "unborn",
        message: `The project folder ${path} has no commits to branch from. Make a first commit, or run it as a Cloud thread.`,
      };
    }
    return {
      status: "unavailable",
      reason:
        checkout.reason === PLAIN_NON_GIT_DIRECTORY_REASON
          ? "non_git_directory"
          : "invalid",
      message: `The project folder ${path} is missing or git can't read it (${checkout.reason}). Change the folder in project settings, or run it as a Cloud thread.`,
    };
  }
  return { status: "available" };
}

async function inspectGitCheckoutAvailability(
  deps: WorkSessionDeps,
  args: { hostId: string; path: string },
): Promise<InspectedGitCheckoutAvailability> {
  try {
    const inspection = await callHostRetryableOnlineRpc(deps, {
      hostId: args.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.inspect_git_source",
        path: args.path,
        remoteRefresh: "background",
      },
    });
    return {
      availability: classifyGitCheckoutAvailability(args.path, inspection),
      cacheable: true,
    };
  } catch (error) {
    deps.logger.warn(
      { hostId: args.hostId, ...runtimeErrorLogFields(deps.config, error) },
      "Could not inspect the project checkout; allowing the environment",
    );
    return { availability: { status: "available" }, cacheable: false };
  }
}
