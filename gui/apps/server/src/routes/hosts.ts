import { COMPUTER } from "@cloudroom/domain";
import { serverAccess } from "../services/machines/server-access.js";
import { getNonDestroyedHost, updateHost } from "@cloudroom/db";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@cloudroom/server-contract";
import type { Hono } from "hono";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@cloudroom/host-daemon-contract";
import type { AppDeps } from "../types.js";
import {
  getProviderInstallations,
  runProviderCliInstall,
} from "../services/system/provider-installations.js";
import type { PluginService } from "../services/plugins/plugin-service.js";
import { COMMAND_TIMEOUT_MS } from "../constants.js";
import { ApiError } from "../errors.js";
import { reportCliInstall } from "../services/cloudroom/setup-telemetry.js";
import {
  getGateAuthKind,
  type GateAuthHeaderReader,
} from "../request-context.js";
import {
  listPublicHostsWithStatus,
  requireNonDestroyedHostWithStatus,
  requirePublicStandardProject,
} from "../services/lib/entity-lookup.js";
import {
  assertUsableHostId,
  resolvePrimaryHostId,
} from "../services/hosts/primary-host.js";
import { issueHostEnrollKey } from "../services/hosts/host-enrollment.js";
import {
  callHostOnlineRpcForWork,
  callHostRetryableOnlineRpc,
} from "../services/hosts/online-rpc.js";
import { handleHostRemoved } from "../internal/session-owner-side-effects.js";
import {
  submitMachine,
  requestMachineRemoval,
  startMachineResume,
  startMachineSuspension,
  startMachineReconciliation,
  retryMachineCleanup,
  sweepProviderMachine,
} from "../services/machines/provider-orchestration.js";
import { getMachineEnrollmentService } from "../services/machines/machine-services.js";
import { manualHostCommand } from "../services/machines/manual-provider.js";

const FOLDER_PICKER_TIMEOUT_MS = 10 * 60 * 1000;

function providerCliInstallEventsToNdjson(events: readonly unknown[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}

function requireMutableHost(deps: AppDeps, hostId: string) {
  const host = getNonDestroyedHost(deps.db, hostId);
  if (!host) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }
  return host;
}

function assertHostManagementAllowed(context: GateAuthHeaderReader): void {
  if (getGateAuthKind(context) === "machine") {
    throw new ApiError(
      403,
      "machine_host_management_forbidden",
      "Machine credentials cannot manage hosts",
    );
  }
}

async function revokeConnectMachineCredential(
  deps: AppDeps,
  plugins: PluginService,
  machineId: string,
): Promise<void> {
  try {
    const connectPlugin = plugins
      .list()
      .find((plugin) => plugin.source === "builtin:connect");
    if (!connectPlugin) throw new Error("connect plugin is not installed");
    const handler = plugins.getRpcHandler(connectPlugin.id, "revokeMachine");
    if (handler.outcome !== "found") {
      throw new Error(`connect plugin revoke handler is ${handler.outcome}`);
    }
    const result = await plugins.invokeRpcHandler(
      connectPlugin.id,
      "revokeMachine",
      handler.value,
      { machineId },
      { kind: "client" },
    );
    if (!result.ok) throw new Error(result.error.message);
  } catch (error) {
    deps.logger.error(
      { err: error, machineId },
      `Host was removed locally, but its Cloudroom Connect machine credential could not be revoked. Its relay access stays until the ${COMPUTER} signs out of Cloudroom.`,
    );
  }
}

export function registerHostRoutes(
  app: Hono,
  deps: AppDeps,
  plugins: PluginService,
): void {
  const { del, get, patch, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });
  const routes = publicApiRoutes.hosts;

  post(routes.create, async (context, payload) => {
    assertHostManagementAllowed(context);
    return context.json(await submitMachine(deps, payload), 201);
  });

  post(routes.createJoinCode, async (context, payload) => {
    assertHostManagementAllowed(context);
    const issued = await issueHostEnrollKey(deps, {
      enrollSource: "public-multi-machine",
    });
    return context.json(
      {
        joinCode: issued.enrollKey.key,
        hostId: issued.hostId,
        expiresAt: issued.enrollKey.expiresAt,
      },
      201,
    );
  });

  get(routes.list, (context, query) =>
    context.json(
      listPublicHostsWithStatus(deps, {
        includeCreating: query.includeCreating === "true",
      }),
    ),
  );

  get(routes.get, (context) =>
    context.json({
      ...requireNonDestroyedHostWithStatus(deps, context.req.param("id")),
      connectMachineId: requireMutableHost(deps, context.req.param("id"))
        .connectMachineId,
    }),
  );

  get(routes.enrollmentCommand, async (context) => {
    assertHostManagementAllowed(context);
    requireMutableHost(deps, context.req.param("id"));
    return context.json(
      await manualHostCommand(
        getMachineEnrollmentService(deps),
        context.req.param("id"),
      ),
    );
  });

  patch(routes.update, (context, payload) => {
    assertHostManagementAllowed(context);
    const hostId = context.req.param("id");
    requireMutableHost(deps, hostId);
    const updated = updateHost(deps.db, deps.hub, hostId, {
      name: payload.name,
    });
    if (!updated) {
      throw new ApiError(404, "host_not_found", "Host not found");
    }
    deps.hub.notifyHost(hostId, ["host-connected"]);
    return context.json(requireNonDestroyedHostWithStatus(deps, updated.id));
  });

  patch(routes.updatePermissionCeiling, (context, payload) => {
    assertHostManagementAllowed(context);
    const hostId = context.req.param("id");
    requireMutableHost(deps, hostId);
    const updated = updateHost(deps.db, deps.hub, hostId, {
      maxPermissionMode: payload.maxPermissionMode,
    });
    if (!updated) {
      throw new ApiError(404, "host_not_found", "Host not found");
    }
    deps.hub.notifyHost(hostId, ["host-connected"]);
    return context.json(requireNonDestroyedHostWithStatus(deps, updated.id));
  });

  post(routes.retryUpdate, (context) => {
    assertHostManagementAllowed(context);
    const hostId = context.req.param("id");
    const host = requireMutableHost(deps, hostId);
    if (host.lastRejectedProtocolVersion === null) {
      throw new ApiError(
        409,
        "host_update_not_needed",
        "The machine is not waiting for a protocol update",
      );
    }
    if (host.lastRejectedProtocolVersion >= HOST_DAEMON_PROTOCOL_VERSION) {
      throw new ApiError(
        409,
        "host_cannot_self_update",
        "The machine daemon is not older than this server",
      );
    }
    deps.hub.requestHostProtocolUpdateRetry(hostId);
    return context.json({ ok: true as const });
  });

  post(routes.reconcile, (context) => {
    assertHostManagementAllowed(context);
    const hostId = context.req.param("id");
    startMachineReconciliation(deps, hostId);
    return context.json(requireNonDestroyedHostWithStatus(deps, hostId), 202);
  });

  post(routes.suspend, (context) => {
    assertHostManagementAllowed(context);
    const hostId = context.req.param("id");
    startMachineSuspension(deps, hostId);
    return context.json(requireNonDestroyedHostWithStatus(deps, hostId), 202);
  });

  post(routes.resume, (context) => {
    assertHostManagementAllowed(context);
    const hostId = context.req.param("id");
    startMachineResume(deps, hostId);
    return context.json(requireNonDestroyedHostWithStatus(deps, hostId), 202);
  });

  post(routes.retryCleanup, async (context) => {
    assertHostManagementAllowed(context);
    await retryMachineCleanup(deps, context.req.param("id"));
    return context.json({ ok: true as const });
  });

  del(routes.delete, async (context) => {
    assertHostManagementAllowed(context);
    const hostId = context.req.param("id");
    const host = requireMutableHost(deps, hostId);
    if (resolvePrimaryHostId(deps) === hostId) {
      throw new ApiError(
        400,
        "primary_host_removal_refused",
        "The primary host cannot be removed",
      );
    }

    if (host.machineProviderId !== null) {
      if (!requestMachineRemoval(deps, hostId)) {
        throw new ApiError(
          409,
          "machine_has_live_threads",
          "Archive or delete every thread on this machine before removing it",
        );
      }
      await sweepProviderMachine(deps, hostId);
      return context.json({ ok: true });
    }

    await serverAccess.release(deps, { key: hostId, hostId });
    await deps.machineAuth.revokeHostAuthKeys({
      hostId,
    });
    const sessionId = deps.hub.getDaemonSessionIdForHost(hostId);
    if (sessionId) {
      handleHostRemoved(deps, { hostId, sessionId });
    }
    updateHost(deps.db, deps.hub, hostId, { destroyedAt: Date.now() });
    deps.lifecycleDedupers.providerModelCatalogs.forgetHost(deps, hostId);
    if (host.connectMachineId !== null) {
      await revokeConnectMachineCredential(
        deps,
        plugins,
        host.connectMachineId,
      );
    }
    return context.json({ ok: true });
  });

  get(routes.directory, async (context, query) => {
    const hostId = context.req.param("id");
    assertUsableHostId(deps, { hostId });
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.browse_directory",
        ...(query.path ? { path: query.path } : {}),
      },
    });
    return context.json(result);
  });

  get(routes.cloneDefaultPath, async (context, query) => {
    const hostId = context.req.param("id");
    assertUsableHostId(deps, { hostId });
    const project = requirePublicStandardProject(deps.db, query.projectId);
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "project.clone_default_path",
        projectSlug: project.name,
      },
    });
    return context.json(result);
  });

  post(routes.pathsExist, async (context, payload) => {
    const hostId = context.req.param("id");
    assertUsableHostId(deps, { hostId });
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.paths_exist",
        paths: payload.paths,
      },
    });
    return context.json(result);
  });

  post(routes.pickFolder, async (context, payload) => {
    const hostId = context.req.param("id");
    assertUsableHostId(deps, { hostId });
    if (payload.clientHostId !== hostId) {
      throw new ApiError(
        409,
        "native_picker_unavailable",
        "Native folder picker is only available when the browser helper and work host are on the same machine",
      );
    }
    const result = await callHostOnlineRpcForWork(deps, {
      hostId,
      timeoutMs: FOLDER_PICKER_TIMEOUT_MS,
      command: {
        type: "host.pick_folder",
      },
    });
    return context.json(result);
  });

  get(routes.providerCliStatus, async (context) => {
    const hostId = context.req.param("id");
    assertUsableHostId(deps, { hostId });
    const result = await getProviderInstallations(deps, { hostId });
    return context.json(result);
  });

  post(routes.providerCliInstall, async (context, payload) => {
    const hostId = context.req.param("id");
    assertUsableHostId(deps, { hostId });
    const started = Date.now();
    const events = await runProviderCliInstall(deps, {
      hostId,
      provider: payload.provider,
      actionKind: payload.actionKind,
    });
    // A second "started" means the normal command failed and the provider's fallback installer ran.
    const done = events.filter((event) => event.type === "completed").at(-1);
    const failure = events.filter((event) => event.type === "error").at(-1);
    const repair =
      events.filter((event) => event.type === "started").length > 1;
    if (payload.provider === "claude-code" || payload.provider === "codex") {
      reportCliInstall(
        payload.provider === "codex" ? "codex" : "claude",
        repair ? "repair" : "local_thread",
        done && "success" in done && done.success ? "ok" : "failed",
        Date.now() - started,
        failure && "message" in failure ? failure.message : null,
      );
    }
    return new Response(providerCliInstallEventsToNdjson(events), {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  });
}
