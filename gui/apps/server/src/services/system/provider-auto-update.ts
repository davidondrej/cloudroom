import { getAppSettings } from "@cloudroom/db";
import type { WorkSessionDeps } from "../../types.js";
import { listPublicHostsWithStatus } from "../lib/entity-lookup.js";
import {
  getProviderInstallations,
  runProviderCliInstall,
} from "./provider-installations.js";

export const PROVIDER_AUTO_UPDATE_FIRST_RUN_MS = 60_000;
export const PROVIDER_AUTO_UPDATE_INTERVAL_MS = 10 * 60_000;
const PROVIDER_AUTO_UPDATE_RETRY_MS = 60 * 60_000;

const lastAttemptAt = new Map<string, number>();
let running = false;

async function updateHostProviders(
  deps: WorkSessionDeps,
  hostId: string,
  providers: readonly string[],
): Promise<void> {
  const statuses = await getProviderInstallations(deps, {
    hostId,
    providerIds: providers,
  });
  for (const provider of providers) {
    const status = statuses[provider];
    if (status?.installAction?.kind !== "update") continue;
    const attemptKey = `${hostId}:${provider}:${status.latestVersion ?? status.currentVersion}`;
    const lastAttempt = lastAttemptAt.get(attemptKey);
    if (
      lastAttempt !== undefined &&
      Date.now() - lastAttempt < PROVIDER_AUTO_UPDATE_RETRY_MS
    )
      continue;
    lastAttemptAt.set(attemptKey, Date.now());
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
        errors: events.flatMap((event) =>
          event.type === "error" ? [event.message] : [],
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
