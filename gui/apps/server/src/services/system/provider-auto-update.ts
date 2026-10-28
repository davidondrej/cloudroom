import { getAppSettings, listActiveHostThreads } from "@cloudroom/db";
import type { WorkSessionDeps } from "../../types.js";
import { listPublicHostsWithStatus } from "../lib/entity-lookup.js";
import {
  getProviderInstallations,
  runProviderCliInstall,
} from "./provider-installations.js";

export const PROVIDER_AUTO_UPDATE_FIRST_RUN_MS = 60_000;
export const PROVIDER_AUTO_UPDATE_INTERVAL_MS = 60 * 60_000;

const attemptedUpdates = new Set<string>();
let running = false;

function hostIsBusy(deps: WorkSessionDeps, hostId: string): boolean {
  return listActiveHostThreads(deps.db, { hostId }).length > 0;
}

async function updateHostProviders(
  deps: WorkSessionDeps,
  hostId: string,
  providers: readonly string[],
): Promise<void> {
  if (hostIsBusy(deps, hostId)) return;
  const statuses = await getProviderInstallations(deps, { hostId });
  for (const provider of providers) {
    const status = statuses[provider];
    if (status?.installAction?.kind !== "update") continue;
    const attemptKey = `${hostId}:${provider}:${status.latestVersion ?? status.currentVersion}`;
    if (attemptedUpdates.has(attemptKey) || hostIsBusy(deps, hostId)) continue;
    attemptedUpdates.add(attemptKey);
    const events = await runProviderCliInstall(deps, {
      hostId,
      provider,
      actionKind: "update",
    });
    deps.logger.info(
      {
        hostId,
        providerId: provider,
        success: events.some(
          (event) => event.type === "completed" && event.success,
        ),
      },
      "Provider auto-update finished",
    );
  }
}

export async function runProviderAutoUpdates(
  deps: WorkSessionDeps,
): Promise<void> {
  const providers = getAppSettings(deps.db).providerAutoUpdate;
  if (running || providers.length === 0) return;
  running = true;
  try {
    for (const host of listPublicHostsWithStatus(deps)) {
      if (host.type !== "persistent" || host.status !== "connected") continue;
      await updateHostProviders(deps, host.id, providers).catch(
        (error: unknown) => {
          deps.logger.warn(
            { err: error, hostId: host.id },
            "Provider auto-update failed",
          );
        },
      );
    }
  } finally {
    running = false;
  }
}
