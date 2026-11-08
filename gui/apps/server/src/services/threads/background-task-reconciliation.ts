import { z } from "zod";
import {
  listOpenBackgroundTaskItemRowsForHost,
  listOpenBackgroundTaskItemRowsForThread,
  type DbNotifier,
  type DbTransaction,
  type OpenBackgroundTaskItemRow,
} from "@cloudroom/db";
import {
  backgroundTaskItemStatus,
  isSettledBackgroundTaskStatus,
  threadEventBackgroundTaskItemSchema,
  threadScope,
} from "@cloudroom/domain";
import type { ThreadEventBackgroundTaskItem } from "@cloudroom/domain";
import type { AppDeps } from "../../types.js";
import { appendThreadEventsInTransaction } from "./thread-events.js";

interface SettleDanglingBackgroundTasksArgs {
  hostId: string;
}

type SettleDanglingBackgroundTasksDeps = Pick<AppDeps, "db" | "hub" | "logger">;
type SettleDanglingBackgroundTasksTransactionDeps = {
  db: DbTransaction;
  hub: DbNotifier;
  logger: AppDeps["logger"];
};

const storedBackgroundTaskEventDataSchema = z.object({
  item: threadEventBackgroundTaskItemSchema,
});

function parseStoredBackgroundTaskItem(
  row: OpenBackgroundTaskItemRow,
): ThreadEventBackgroundTaskItem | null {
  try {
    const parsed = storedBackgroundTaskEventDataSchema.safeParse(
      JSON.parse(row.data),
    );
    return parsed.success ? parsed.data.item : null;
  } catch {
    return null;
  }
}

/** Tasks this settlement ended while still running, by thread. */
export type LostBackgroundTasks = Map<
  string,
  { itemId: string; description: string }[]
>;

/** Settles the host's open background tasks. */
export function settleDanglingBackgroundTasks(
  deps: SettleDanglingBackgroundTasksDeps,
  args: SettleDanglingBackgroundTasksArgs,
): LostBackgroundTasks {
  const rows = listOpenBackgroundTaskItemRowsForHost(deps.db, {
    hostId: args.hostId,
  });
  if (rows.length === 0) {
    return new Map();
  }

  const settled = deps.db.transaction(
    (tx) =>
      appendDanglingBackgroundTaskCompletions(
        { db: tx, logger: deps.logger },
        rows,
      ),
    { behavior: "immediate" },
  );

  for (const threadId of settled.keys()) {
    deps.hub.notifyThread(threadId, ["events-appended"], {
      eventTypes: ["item/backgroundTask/completed"],
    });
  }
  return settled;
}

export function settleDanglingBackgroundTasksForStoppedThreadInTransaction(
  deps: SettleDanglingBackgroundTasksTransactionDeps,
  args: { threadId: string },
): void {
  const rows = listOpenBackgroundTaskItemRowsForThread(deps.db, args);
  const settled = appendDanglingBackgroundTaskCompletions(deps, rows);
  for (const threadId of settled.keys()) {
    deps.hub.notifyThread(threadId, ["events-appended"], {
      eventTypes: ["item/backgroundTask/completed"],
    });
  }
}

function appendDanglingBackgroundTaskCompletions(
  deps: Pick<SettleDanglingBackgroundTasksTransactionDeps, "db" | "logger">,
  rows: readonly OpenBackgroundTaskItemRow[],
): LostBackgroundTasks {
  const settled: LostBackgroundTasks = new Map();
  for (const row of rows) {
    const item = parseStoredBackgroundTaskItem(row);
    if (!item) {
      deps.logger.warn(
        { itemId: row.itemId, threadId: row.threadId },
        "Skipping dangling background task with unparsable item payload",
      );
      continue;
    }
    const providerThreadId = row.providerThreadId ?? "";
    const finished = isSettledBackgroundTaskStatus(item.taskStatus);
    const taskStatus = finished ? item.taskStatus : "stopped";
    appendThreadEventsInTransaction(deps.db, [
      {
        threadId: row.threadId,
        environmentId: row.environmentId,
        providerThreadId,
        type: "item/backgroundTask/completed",
        scope: threadScope(),
        data: {
          providerThreadId,
          item: {
            ...item,
            status: backgroundTaskItemStatus(taskStatus),
            taskStatus,
          },
        },
      },
    ]);
    settled.set(row.threadId, [
      ...(settled.get(row.threadId) ?? []),
      ...(finished
        ? []
        : [{ itemId: row.itemId, description: item.description }]),
    ]);
  }
  return settled;
}
