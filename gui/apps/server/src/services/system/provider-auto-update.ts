import { getAppSettings } from "@cloudroom/db";
import type {
  ProviderCliStatus,
  ProviderCliStatusResponse,
} from "@cloudroom/host-daemon-contract";
import type { WorkSessionDeps } from "../../types.js";
import { listPublicHostsWithStatus } from "../lib/entity-lookup.js";
import {
  getProviderInstallations,
  runProviderCliInstall,
} from "./provider-installations.js";

export const PROVIDER_AUTO_UPDATE_INTERVAL_MS = 2 * 60_000;
const REPEATED_FAILURE_RETRY_MS = 60 * 60_000;

interface Attempt {
  target: string | null;
  state: NonNullable<ProviderCliStatus["autoUpdateState"]> | "verified";
  failures: number;
  retryAt: number;
}

const workers = new WeakMap<
  WorkSessionDeps["db"],
  {
    attempts: Map<string, Attempt>;
    checking: Set<string>;
  }
>();

function workerFor(deps: WorkSessionDeps) {
  let worker = workers.get(deps.db);
  if (!worker) {
    worker = { attempts: new Map(), checking: new Set() };
    workers.set(deps.db, worker);
  }
  return worker;
}

async function install(
  deps: WorkSessionDeps,
  hostId: string,
  provider: string,
  attempt: Attempt,
) {
  let success = false;
  try {
    const events = await runProviderCliInstall(deps, {
      hostId,
      provider,
      actionKind: "update",
      automatic: true,
    });
    success = events.some(
      (event) => event.type === "completed" && event.success,
    );
    deps.logger.info(
      {
        hostId,
        providerId: provider,
        success,
        errors: events.flatMap((event) =>
          event.type === "error" ? [event.message] : [],
        ),
      },
      "Provider auto-update finished",
    );
  } catch (err) {
    deps.logger.warn(
      { err, hostId, providerId: provider },
      "Provider auto-update failed",
    );
  } finally {
    attempt.failures = success ? 0 : attempt.failures + 1;
    attempt.state = success
      ? "verified"
      : attempt.failures === 1
        ? "retrying"
        : "failed";
    // A late status response can still describe the version we just replaced.
    attempt.retryAt =
      Date.now() +
      (attempt.failures >= 2
        ? REPEATED_FAILURE_RETRY_MS
        : PROVIDER_AUTO_UPDATE_INTERVAL_MS);
    deps.hub.notifyHost(hostId, ["provider-cli-status-changed"]);
  }
}

// The host inventory and the background sweep can discover the same update.
// Claim it before starting any async work so both see the same attempt.
export function observeProviderUpdates(
  deps: WorkSessionDeps,
  hostId: string,
  statuses: ProviderCliStatusResponse,
) {
  const { attempts } = workerFor(deps);
  for (const provider of getAppSettings(deps.db).providerAutoUpdate) {
    const status = statuses[provider];
    if (!status?.installed) continue;
    const key = `${hostId}:${provider}`;
    const previous = attempts.get(key);
    if (status.installAction?.kind !== "update") {
      // A provider can finish its own update between Cloudroom's retries.
      if (
        previous &&
        previous.failures > 0 &&
        previous.state !== "updating" &&
        status.latestVersion &&
        status.currentVersion &&
        !status.needsUpdate &&
        !status.versionUnsupported
      ) {
        attempts.delete(key);
        deps.hub.notifyHost(hostId, ["provider-cli-status-changed"]);
      }
      continue;
    }
    const target =
      status.latestVersion ??
      status.minimumSupportedVersion ??
      status.currentVersion;
    if (
      previous &&
      (previous.state === "updating" ||
        (previous.target === target && Date.now() < previous.retryAt))
    ) {
      status.autoUpdateState =
        previous.state === "verified" ? "updating" : previous.state;
      continue;
    }
    const failures = previous?.target === target ? previous.failures : 0;
    const attempt: Attempt = {
      target,
      failures,
      state: "updating",
      retryAt: 0,
    };
    attempts.set(key, attempt);
    status.autoUpdateState = "updating";
    void install(deps, hostId, provider, attempt);
    deps.hub.notifyHost(hostId, ["provider-cli-status-changed"]);
  }
}

export async function runProviderAutoUpdates(
  deps: WorkSessionDeps,
  onlyHostId?: string,
): Promise<void> {
  const providers = getAppSettings(deps.db).providerAutoUpdate;
  if (!providers.length) return;
  const { checking } = workerFor(deps);
  for (const host of listPublicHostsWithStatus(deps)) {
    if (
      host.type !== "persistent" ||
      host.status !== "connected" ||
      host.lifecycle.phase !== "active" ||
      (onlyHostId && host.id !== onlyHostId) ||
      checking.has(host.id)
    )
      continue;
    checking.add(host.id);
    try {
      const statuses = await getProviderInstallations(deps, {
        hostId: host.id,
        providerIds: providers,
      });
      observeProviderUpdates(deps, host.id, statuses);
    } catch (err) {
      deps.logger.warn(
        { err, hostId: host.id },
        "Provider auto-update check failed",
      );
    } finally {
      checking.delete(host.id);
    }
  }
}
