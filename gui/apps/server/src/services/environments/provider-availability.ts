import { getProjectSourceByHost } from "@cloudroom/db";
import { isLocalPathProjectSource, PERSONAL_PROJECT_ID } from "@cloudroom/domain";
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

type GitCheckoutAvailability =
  | { status: "available" }
  | { status: "unavailable"; message: string };
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

const pendingGitInspections = new WeakMap<
  object,
  Map<string, Promise<GitCheckoutAvailability>>
>();

export function resolveGitCheckoutAvailability(
  deps: WorkSessionDeps,
  args: { hostId: string; path: string },
): Promise<GitCheckoutAvailability> {
  let pending = pendingGitInspections.get(deps.db);
  if (pending === undefined) {
    pending = new Map();
    pendingGitInspections.set(deps.db, pending);
  }
  const key = JSON.stringify([args.hostId, args.path]);
  const existing = pending.get(key);
  if (existing !== undefined) return existing;
  const result = inspectGitCheckoutAvailability(deps, args).finally(() =>
    pending.delete(key),
  );
  pending.set(key, result);
  return result;
}

async function inspectGitCheckoutAvailability(
  deps: WorkSessionDeps,
  args: { hostId: string; path: string },
): Promise<GitCheckoutAvailability> {
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
    const { checkout } = inspection;
    if (
      (checkout.kind === "unknown" || checkout.kind === "unborn") &&
      resolveDefaultWorktreeBaseBranch(inspection) === null
    ) {
      return {
        status: "unavailable",
        message:
          checkout.kind === "unborn"
            ? `The project folder ${args.path} has no commits to branch from. Make a first commit, or run it as a Cloud thread.`
            : `The project folder ${args.path} is missing or git can't read it (${checkout.reason}). Change the folder in project settings, or run it as a Cloud thread.`,
      };
    }
    return { status: "available" };
  } catch (error) {
    deps.logger.warn(
      { hostId: args.hostId, ...runtimeErrorLogFields(deps.config, error) },
      "Could not inspect the project checkout; allowing the environment",
    );
    return { status: "available" };
  }
}
