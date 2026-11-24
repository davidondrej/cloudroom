/** What the picker reads from a thread list row. */
export interface Row {
  id: string;
  title: string | null;
  titleFallback: string | null;
  projectId: string;
  status: string;
  parentThreadId: string | null;
  visibility: string;
  archivedAt: number | null;
  originPluginId: string | null;
  executionTarget?: "local" | "cloud" | undefined;
  /** When its last turn stopped. Unlike `updatedAt`, reading, pinning or renaming a thread does not move it. */
  latestAttentionAt: number;
  hasPendingInteraction: boolean;
  queuedWork: string;
}

export interface PickOptions {
  now: number;
  /** Each thread's `latestAttentionAt` when the Director last looked at it. */
  seen: Readonly<Record<string, number>>;
  /** null watches every project. */
  projectIds: readonly string[] | null;
  watchLoops: boolean;
}

/** A thread must be stopped this long first: the user may still be typing to it. */
export const QUIET_MS = 3 * 60_000;
/** Older stops are stale, so a first ping never digs through months of threads. */
export const RECENT_MS = 24 * 60 * 60_000;
const LOOPS = "automations";

/**
 * The one thread this ping checks, or null when nothing stopped since the Director last looked.
 * A failed thread first, then the most recent stop. Threads waiting on a prompt, a form or their
 * own queue are skipped: the Director can't answer those.
 */
export function pickThread(rows: readonly Row[], { now, seen, projectIds, watchLoops }: PickOptions): Row | null {
  const open = rows.filter(
    (row) =>
      (row.status === "idle" || row.status === "error") &&
      row.parentThreadId === null &&
      row.visibility === "visible" &&
      row.archivedAt === null &&
      !row.hasPendingInteraction &&
      row.queuedWork === "none" &&
      (projectIds === null || projectIds.includes(row.projectId)) &&
      (watchLoops || row.originPluginId !== LOOPS) &&
      row.latestAttentionAt > (seen[row.id] ?? 0) &&
      now - row.latestAttentionAt >= QUIET_MS &&
      now - row.latestAttentionAt <= RECENT_MS,
  );
  const failed = (row: Row) => (row.status === "error" ? 1 : 0);
  return open.sort((a, b) => failed(b) - failed(a) || b.latestAttentionAt - a.latestAttentionAt)[0] ?? null;
}
