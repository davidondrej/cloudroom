import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import { environments } from "@cloudroom/db";
import type { AppDeps } from "../../types.js";
import { readPrimaryHostIdFromDataDir } from "../hosts/primary-host.js";
import { DEFAULT_ENVIRONMENT_PROVIDER_ID } from "./environment-provider-ids.js";
import { localFreeBytes } from "./worktree-storage.js";

const START_BELOW_BYTES = 30e9;
const STOP_AT_BYTES = 50e9;
const BATCH_SIZE = 20;
const DUE_SOON_MS = 60 * 60_000;

let cleaning = false;

export function runLowDiskWorktreeCleanup(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger">,
  now: number,
): void {
  const free = localFreeBytes(deps);
  if (free === null) return;
  cleaning = free < (cleaning ? STOP_AT_BYTES : START_BELOW_BYTES);
  const hostId = readPrimaryHostIdFromDataDir({ dataDir: deps.config.dataDir });
  if (!cleaning || hostId === null) return;
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
