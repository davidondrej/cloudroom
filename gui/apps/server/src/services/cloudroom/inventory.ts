import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  cloudroomThreads,
  threadPluginMetadata,
  type DbQueryConnection,
} from "@cloudroom/db";
import {
  threadExecutionObservationSchema,
  type ThreadListEntry,
  type ThreadStatus,
  type ThreadExecutionObservation,
} from "@cloudroom/domain";
import type { SessionRecord } from "./client.js";
import { statusOf } from "./store.js";

// Internal metadata avoids a migration; it never changes lifecycle or execution ownership.
const NAMESPACE = "cloudroom.inventory";
const schema = z.object({
  parentThreadId: z.string().nullable().optional(),
  sessionId: z.string().optional(),
  sequence: z.number().default(0),
  modelSequence: z.number().default(0),
  effortSequence: z.number().default(0),
  execution: threadExecutionObservationSchema.optional(),
});
type Inventory = z.infer<typeof schema>;
function read(db: DbQueryConnection, threadId: string): Inventory {
  const row = db
    .select()
    .from(threadPluginMetadata)
    .where(
      and(
        eq(threadPluginMetadata.pluginId, NAMESPACE),
        eq(threadPluginMetadata.threadId, threadId),
      ),
    )
    .get();
  try {
    return schema.parse(row ? JSON.parse(row.metadataJson) : {});
  } catch {
    return { sequence: 0, modelSequence: 0, effortSequence: 0 };
  }
}
function save(db: DbQueryConnection, threadId: string, value: Inventory): void {
  const metadataJson = JSON.stringify(value);
  db.insert(threadPluginMetadata)
    .values({ threadId, pluginId: NAMESPACE, metadataJson })
    .onConflictDoUpdate({
      target: [threadPluginMetadata.threadId, threadPluginMetadata.pluginId],
      set: { metadataJson },
    })
    .run();
}
export function rememberCloudParent(
  db: DbQueryConnection,
  threadId: string,
  parentThreadId: string | null,
): void {
  const prior = read(db, threadId);
  if (prior.parentThreadId !== parentThreadId)
    save(db, threadId, { ...prior, parentThreadId });
}

/** Only explicit Core records are observations; configured model/effort are intentionally never read here. */
export function observeCloudRecord(
  db: DbQueryConnection,
  threadId: string,
  record: SessionRecord,
): void {
  if (
    ![
      "state",
      "native_identity",
      "model_fallback",
      "reasoning",
      "launch_reasoning",
    ].includes(record.kind)
  )
    return;
  const data = record.data as Record<string, unknown> | null;
  if (!data || typeof data !== "object") return;
  const prior = read(db, threadId);
  const same = prior.sessionId === record.session_id;
  const field =
    record.kind === "state"
      ? "sequence"
      : record.kind === "native_identity" || record.kind === "model_fallback"
        ? "modelSequence"
        : "effortSequence";
  if (same && record.sequence <= prior[field]) return;
  const execution =
    same && prior.execution
      ? { ...prior.execution }
      : {
          status: "idle" as const,
          source: "core" as const,
          freshness: "last-known" as const,
          observedAt: null,
          receivedAt: null,
          model: null,
          effort: null,
        };
  if (record.kind === "state") {
    const status = typeof data.state === "string" ? statusOf(data.state) : null;
    if (!status) return;
    execution.status = status;
    execution.observedAt = record.timestamp_ms ?? null;
    execution.receivedAt = Date.now();
  } else if (
    record.kind === "native_identity" ||
    record.kind === "model_fallback"
  ) {
    const model =
      record.kind === "model_fallback" ? data.fallback_model : data.model;
    execution.model = typeof model === "string" ? model : null;
  } else if (typeof data.reasoning === "string")
    execution.effort = data.reasoning;
  save(db, threadId, {
    ...prior,
    sessionId: record.session_id,
    sequence: same ? prior.sequence : 0,
    modelSequence: same ? prior.modelSequence : 0,
    effortSequence: same ? prior.effortSequence : 0,
    [field]: record.sequence,
    execution,
  });
}

export function withCloudInventory(
  db: DbQueryConnection,
  entries: ThreadListEntry[],
): ThreadListEntry[] {
  if (entries.length === 0) return entries;
  const ids = entries.map((entry) => entry.id);
  const metadata = new Map(
    db
      .select()
      .from(threadPluginMetadata)
      .where(
        and(
          eq(threadPluginMetadata.pluginId, NAMESPACE),
          inArray(threadPluginMetadata.threadId, ids),
        ),
      )
      .all()
      .map((row) => [row.threadId, row.metadataJson]),
  );
  const sessions = new Map(
    db
      .select({
        id: cloudroomThreads.threadId,
        session: cloudroomThreads.sessionId,
      })
      .from(cloudroomThreads)
      .where(inArray(cloudroomThreads.threadId, ids))
      .all()
      .map((row) => [row.id, row.session]),
  );
  return entries.map((entry) => {
    let saved: Inventory | null = null;
    try {
      saved = schema.parse(JSON.parse(metadata.get(entry.id) ?? "{}"));
    } catch {
      /* corrupt metadata supplies no evidence */
    }
    const sessionId = sessions.get(entry.id);
    const known =
      sessionId != null && saved?.sessionId === sessionId
        ? saved.execution
        : undefined;
    const execution = executionForStatus(entry.status, known);
    return {
      ...entry,
      status: execution.status,
      runtime:
        execution.source === "core"
          ? { ...entry.runtime, displayStatus: execution.status }
          : entry.runtime,
      parentThreadId: entry.parentThreadId ?? saved?.parentThreadId ?? null,
      execution,
    };
  });
}

/** A session read is execution evidence even when the event stream has no new records to replay. */
export function observeCloudSnapshot(
  db: DbQueryConnection,
  threadId: string,
  session: { session_id: string; state: string; last_sequence: number },
): void {
  const status = statusOf(session.state);
  if (!status) return;
  const prior = read(db, threadId);
  const same = prior.sessionId === session.session_id;
  if (same && session.last_sequence < prior.sequence) return;
  const now = Date.now();
  save(db, threadId, {
    ...prior,
    sessionId: session.session_id,
    sequence: session.last_sequence,
    modelSequence: same ? prior.modelSequence : 0,
    effortSequence: same ? prior.effortSequence : 0,
    execution: {
      status,
      source: "core",
      freshness: "last-known",
      observedAt: now,
      receivedAt: now,
      model: same ? (prior.execution?.model ?? null) : null,
      effort: same ? (prior.execution?.effort ?? null) : null,
    },
  });
}

/** Optional evidence carried with realtime patches; a session switch cannot reuse old observations. */
export function cloudExecutionObservation(
  db: DbQueryConnection,
  threadId: string,
  status: ThreadStatus,
) {
  const saved = read(db, threadId);
  const session = db
    .select({ id: cloudroomThreads.sessionId })
    .from(cloudroomThreads)
    .where(eq(cloudroomThreads.threadId, threadId))
    .get();
  return session?.id != null && session.id === saved.sessionId
    ? executionForStatus(status, saved.execution)
    : undefined;
}

// A settings record alone cannot establish execution state.
function executionForStatus(
  status: ThreadStatus,
  known?: ThreadExecutionObservation,
): ThreadExecutionObservation {
  return known?.receivedAt != null
    ? known
    : {
        status,
        source: "thread",
        freshness: "unknown",
        observedAt: null,
        receivedAt: null,
        model: known?.model ?? null,
        effort: known?.effort ?? null,
      };
}
