import { CliExitError } from "../../action.js";
import type { createCliBbSdk } from "../../client.js";
import { getErrorMessage, outputJson, requireThreadId } from "../helpers.js";

interface ArchiveManyArgs {
  ids: readonly string[];
  json?: boolean;
  sdk: ReturnType<typeof createCliBbSdk>;
  self?: boolean;
}

/**
 * Archives several threads in one call. One failure does not stop the rest;
 * the command reports every thread it could not archive and exits 1.
 */
export async function archiveMany(args: ArchiveManyArgs): Promise<void> {
  if (args.self) {
    throw new Error("Cannot combine thread IDs with --self.");
  }
  const threadIds = [...new Set(args.ids.map((id) => requireThreadId(id)))];
  const archived = new Set<string>();
  const keptLiveThreadIds: string[] = [];
  const failed: { threadId: string; error: string }[] = [];
  for (const threadId of threadIds) {
    // Archiving a parent takes its idle children along.
    if (archived.has(threadId)) continue;
    try {
      const result = await args.sdk.threads.archive({ threadId });
      for (const id of result.archivedThreadIds) archived.add(id);
      keptLiveThreadIds.push(...(result.keptLiveThreadIds ?? []));
    } catch (err: unknown) {
      failed.push({ threadId, error: getErrorMessage(err) });
    }
  }

  const archivedThreadIds = [...archived];
  const printed = outputJson(args, {
    ok: failed.length === 0,
    archivedThreadIds,
    keptLiveThreadIds,
    failed,
  });
  if (!printed) {
    console.log(`Archived ${archivedThreadIds.length} threads`);
    if (keptLiveThreadIds.length > 0) {
      console.log(
        `Left ${keptLiveThreadIds.length} live child thread(s) open: ${keptLiveThreadIds.join(", ")}`,
      );
    }
    for (const { threadId, error } of failed) {
      console.log(`Failed to archive thread ${threadId}: ${error}`);
    }
  }
  if (failed.length > 0) {
    throw new CliExitError(
      `${failed.length} of ${threadIds.length} threads were not archived.`,
      1,
    );
  }
}
