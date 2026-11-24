import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import { environments, listQuietOpenEnvironments } from "@cloudroom/db";
import type { ThreadProvisioningDeps } from "../threads/thread-provisioning-environment.js";
import { readPrimaryHostIdFromDataDir } from "../hosts/primary-host.js";
import { parkQuietWorktree } from "./environment-engine.js";
import { DEFAULT_ENVIRONMENT_PROVIDER_ID } from "./environment-provider-ids.js";
import { localFreeBytes } from "./worktree-storage.js";

const START_BELOW_BYTES = 30e9;
const STOP_AT_BYTES = 50e9;
const BATCH_SIZE = 20;
const DUE_SOON_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/**
 * A worktree open threads hold is parked once nobody used it this long: its
 * work is saved, its folder removed, and the next message rebuilds it.
 * `lowDisk` applies while the disk is nearly full, `timer` always. Pinning a
 * thread keeps its worktree.
 */
export const QUIET_PARK = {
  lowDisk: { on: true, afterMs: DAY_MS },
  timer: { on: false, afterMs: 7 * DAY_MS },
};
// A park removes gigabytes, so they run one at a time, a few per minute. One
// that didn't park writes its row, so it isn't picked again before the cutoff.
const PARK_BATCH_SIZE = 5;

let cleaning = false;
let parking = false;

type Deps = ThreadProvisioningDeps;

export function runLowDiskWorktreeCleanup(deps: Deps, now: number): void {
  const free = localFreeBytes(deps);
  if (free === null) return;
  cleaning = free < (cleaning ? STOP_AT_BYTES : START_BELOW_BYTES);
  const hostId = readPrimaryHostIdFromDataDir({ dataDir: deps.config.dataDir });
  if (hostId === null) return;
  if (cleaning) removeWaitingWorktrees(deps, hostId, free, now);
  // Windows can't list what runs in a folder, so a park could stop a dev server.
  if (process.platform === "win32") return;
  const lowDisk = cleaning && QUIET_PARK.lowDisk.on;
  const rule = lowDisk
    ? QUIET_PARK.lowDisk
    : QUIET_PARK.timer.on
      ? QUIET_PARK.timer
      : null;
  if (rule !== null) parkQuietWorktrees(deps, hostId, now - rule.afterMs, lowDisk);
}

function removeWaitingWorktrees(
  deps: Deps,
  hostId: string,
  free: number,
  now: number,
): void {
  const waiting = deps.db
    .select({ id: environments.id })
    .from(environments)
    .where(
      and(
        eq(environments.hostId, hostId),
        eq(
          environments.environmentProviderId,
          DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree,
        ),
        isNull(environments.ownerThreadId),
        isNull(environments.teardownStatus),
        gt(environments.retireAt, now + DUE_SOON_MS),
      ),
    )
    .orderBy(asc(environments.retireAt))
    .limit(BATCH_SIZE);
  const due = deps.db
    .update(environments)
    .set({ retireAt: now })
    .where(inArray(environments.id, waiting))
    .returning({ id: environments.id })
    .all();
  if (due.length === 0) return;
  for (const { id } of due)
    deps.hub.notifyEnvironment(id, ["metadata-changed"]);
  deps.logger.info(
    { freeBytes: free, worktrees: due.length },
    "Low disk: removing waiting worktrees now",
  );
}

function parkQuietWorktrees(
  deps: Deps,
  hostId: string,
  quietSince: number,
  lowDisk: boolean,
): void {
  if (parking) return;
  const quiet = listQuietOpenEnvironments(deps.db, {
    hostId,
    providerId: DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree,
    since: quietSince,
    limit: PARK_BATCH_SIZE,
  });
  if (quiet.length === 0) return;
  parking = true;
  void (async () => {
    for (const environmentId of quiet) {
      // Each park frees space: stop once there is enough.
      if (lowDisk && (localFreeBytes(deps) ?? 0) >= STOP_AT_BYTES) break;
      const parked = await parkQuietWorktree(
        deps,
        environmentId,
        quietSince,
      ).catch(() => false);
      deps.logger.info({ environmentId, parked, lowDisk }, "Quiet worktree park");
    }
  })().finally(() => {
    parking = false;
  });
}
