import {
  canHydrateRetainedEventOutputRowsWithinDataByteLimit,
  findStoredEventRow as findStoredEventRowRecord,
  getLatestThreadOutputEventRow,
  getLatestThreadSystemErrorEventRow,
  hydrateRetainedEventOutputRows,
  listStoredEventRows as listStoredEventRowRecords,
} from "@cloudroom/db";
import type { DbConnection, StoredEventRow } from "@cloudroom/db";
import { toRecord } from "@cloudroom/core-ui";
import {
  buildThreadEventRow,
  maskStoredShellEnvValues,
  parseStoredThreadEvent,
} from "@cloudroom/domain";
import { threadScope, turnScope } from "@cloudroom/domain";
import type {
  ThreadEvent,
  ThreadEventRow,
  ThreadEventScope,
  ThreadEventType,
} from "@cloudroom/domain";
import { ApiError } from "../../errors.js";

const THREAD_EVENT_RESPONSE_DATA_BYTE_LIMIT = 8 * 1024 * 1024;

type StoredEventPayloadRow = Pick<
  StoredEventRow,
  "data" | "sequence" | "threadId" | "type"
>;

interface ListThreadEventRowsArgs {
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
  order?: "asc" | "desc";
  threadId: string;
  types?: readonly ThreadEventType[];
}

interface FindThreadEventArgs {
  afterSeq?: number;
  threadId: string;
  type: ThreadEventType;
}

export function parseStoredEventPayload(
  row: StoredEventPayloadRow,
): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(row.data);
  } catch {
    throw new ApiError(
      500,
      "internal_error",
      `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} is not valid JSON`,
    );
  }

  const record = toRecord(data);
  if (!record) {
    throw new ApiError(
      500,
      "internal_error",
      `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} is malformed`,
    );
  }

  return maskStoredShellEnvValues(row.type, record);
}

function parseStoredEventScope(row: StoredEventRow): ThreadEventScope {
  switch (row.scopeKind) {
    case "thread":
      return threadScope();
    case "turn":
      if (row.turnId === null) {
        throw new ApiError(
          500,
          "internal_error",
          `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} has turn scope without turn_id`,
        );
      }
      return turnScope(row.turnId);
    default:
      throw new ApiError(
        500,
        "internal_error",
        `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} has invalid scope_kind`,
      );
  }
}

export function parseStoredEvent(row: StoredEventRow): ThreadEvent {
  return parseStoredThreadEvent({
    type: row.type,
    data: parseStoredEventPayload(row),
    threadId: row.threadId,
    providerThreadId: row.providerThreadId,
    scope: parseStoredEventScope(row),
  });
}

function parseStoredEventRow(row: StoredEventRow): ThreadEventRow {
  return buildThreadEventRow({
    id: row.id,
    scope: parseStoredEventScope(row),
    threadId: row.threadId,
    seq: row.sequence,
    createdAt: row.createdAt,
    event: parseStoredEvent(row),
  });
}

function hydrateRawThreadEventRows(
  db: DbConnection,
  rows: readonly StoredEventRow[],
): StoredEventRow[] {
  if (
    !canHydrateRetainedEventOutputRowsWithinDataByteLimit(
      db,
      rows,
      THREAD_EVENT_RESPONSE_DATA_BYTE_LIMIT,
    )
  ) {
    throw new ApiError(
      413,
      "event_data_too_large",
      "Event response exceeds the 8 MiB limit",
    );
  }
  return hydrateRetainedEventOutputRows(db, rows);
}

export function listThreadEventRows(
  db: DbConnection,
  args: ListThreadEventRowsArgs,
): ThreadEventRow[] {
  const rows = listStoredEventRowRecords(db, {
    afterSequence: args.afterSeq,
    beforeSequence: args.beforeSeq,
    limit: args.limit,
    order: args.order,
    threadId: args.threadId,
    types: args.types,
  });
  return hydrateRawThreadEventRows(db, rows).map((row) =>
    parseStoredEventRow(row),
  );
}

export function findThreadEvent(
  db: DbConnection,
  args: FindThreadEventArgs,
): ThreadEventRow | null {
  const row = findStoredEventRowRecord(db, {
    afterSequence: args.afterSeq,
    threadId: args.threadId,
    type: args.type,
  });
  if (!row) {
    return null;
  }
  const [hydrated] = hydrateRawThreadEventRows(db, [row]);
  return parseStoredEventRow(hydrated ?? row);
}

export function getLastThreadOutput(
  db: DbConnection,
  threadId: string,
  turnId?: string,
  includeEmpty = false,
): string | null {
  return threadOutputText(
    getLatestThreadOutputEventRow(db, {
      threadId,
      includeEmpty,
      ...(turnId === undefined ? {} : { turnId }),
    }),
  );
}

/** The text of a row `getLatestThreadOutputEventRow` returned. */
export function threadOutputText(row: StoredEventRow | null): string | null {
  if (!row) return null;

  const eventRow = parseStoredEventRow(row);

  if (eventRow.type === "system/manager/user_message") {
    return eventRow.data.text.length > 0 ? eventRow.data.text : null;
  }

  if (
    eventRow.type === "item/completed" &&
    eventRow.data.item.type === "agentMessage" &&
    eventRow.data.item.text.length > 0
  ) {
    return eventRow.data.item.text;
  }

  return null;
}

/** The latest error, in one turn when given, as "message: detail". */
export function getTurnErrorText(
  db: DbConnection,
  threadId: string,
  turnId?: string,
): string | null {
  const row = getLatestThreadSystemErrorEventRow(db, {
    threadId,
    includeProviderErrors: true,
    ...(turnId === undefined ? {} : { turnId }),
  });
  if (!row) return null;
  const eventRow = parseStoredEventRow(row);
  if (eventRow.type !== "system/error" && eventRow.type !== "provider/error")
    return null;
  return [eventRow.data.message, eventRow.data.detail]
    .filter((part) => part !== undefined && part.trim() !== "")
    .join(": ");
}

/** An open turn's silence warning (#977) or provider retry (#1853), while nothing has followed it. */
export function getOpenTurnWarning(
  db: DbConnection,
  threadId: string,
): string | null {
  // The raw row: a large command log is never hydrated or parsed.
  const [newest] = listStoredEventRowRecords(db, {
    threadId,
    order: "desc",
    limit: 1,
  });
  if (newest?.type !== "system/error" && newest?.type !== "provider/error")
    return null;
  const event = parseStoredEventRow(newest);
  if (event.type === "provider/error" && event.data.willRetry === true) {
    const retry = (event.data.detail ?? event.data.message).replace(
      /\s*\n\s*/gu,
      ": ",
    );
    return `The provider is retrying: ${retry}`;
  }
  return event.type === "system/error" &&
    event.data.code === "provider_turn_silent"
    ? event.data.message
    : null;
}

export function getLastThreadErrorMessage(
  db: DbConnection,
  threadId: string,
): string | null {
  const row = getLatestThreadSystemErrorEventRow(db, { threadId });
  if (!row) return null;
  const eventRow = parseStoredEventRow(row);
  return eventRow.type === "system/error" ? eventRow.data.message : null;
}
