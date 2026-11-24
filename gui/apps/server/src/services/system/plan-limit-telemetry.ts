import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { events, getLatestThreadSequence, getThread, type DbConnection } from "@cloudroom/db";
import { THREAD_ACCOUNT_SWITCH_OPERATION } from "@cloudroom/domain";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import type { ServerLogger } from "../../types.js";
import type { TelemetryService } from "./telemetry.js";

/** Core's plan-limit error (PLAN_LIMIT in core/src/runtime/mod.rs). Cloud threads get no error category of their own. */
export const CORE_PLAN_LIMIT = "plan limit (not Cloudroom's)";
/** The website's loop that continues a Cloud thread once its plan limit resets (ADR 0212). */
export const LIMIT_RESUME = /^\[Cloudroom automation "Resume after .+ plan limit/;

const FILE = "cloudroom-plan-limits.json";
const KEEP_MS = 30 * 24 * 60 * 60_000;
const MAX_THREADS = 2_000;

const limitSchema = z.object({
  at: z.number(),
  sequence: z.number(),
  provider: z.string(),
  execution: z.enum(["local", "cloud_sandbox", "cloud_vm"]),
  child: z.boolean(),
  // When the latest turn since the limit started. The wait ends there once that turn gets through.
  resumedAt: z.number().optional(),
});
type Limit = z.infer<typeof limitSchema>;
export type PlanLimitHow = "account_switch" | "agent_switch" | "retry" | "user";

interface Deps {
  db: DbConnection;
  telemetry: TelemetryService;
  dataDir: string;
  logger: ServerLogger;
}
interface State {
  deps: Deps;
  file: string;
  limits: Map<string, Limit>;
  saving: Promise<void>;
}

let current: State | null = null;

/**
 * Blocked time (docs/scopes/multiple-subscriptions.md#tracking): from a plan limit stopping a thread to the start of the
 * turn that got through, and what got it going. A turn that hits the limit again keeps the same wait. Waits are saved
 * in the data folder, so an app restart or update in between keeps them. Cloud passes Core's clock (`at`), so a limit
 * hit while the Mac slept counts from when it happened.
 */
export function installPlanLimitTelemetry(deps: Deps): () => void {
  const state: State = { deps, file: join(deps.dataDir, FILE), limits: new Map(), saving: Promise.resolve() };
  current = state;
  void readFile(state.file, "utf8")
    .then((text) => {
      const saved = z.record(z.string(), limitSchema).catch({}).parse(JSON.parse(text));
      for (const [threadId, limit] of Object.entries(saved))
        if (!state.limits.has(threadId) && Date.now() - limit.at < KEEP_MS) state.limits.set(threadId, limit);
    })
    .catch(() => {});
  return () => {
    if (current === state) current = null;
  };
}

/** A plan limit stopped this thread. A wait already open stays open: its retry hit the limit again. */
export function notePlanLimit(threadId: string, limit: Pick<Limit, "provider" | "execution" | "child">, at = Date.now()): void {
  const state = current;
  if (!state) return;
  const sequence = getLatestThreadSequence(state.deps.db, { threadId });
  const open = state.limits.get(threadId);
  if (open) {
    const { resumedAt: _, ...waiting } = open;
    state.limits.set(threadId, { ...waiting, sequence });
  } else {
    for (const [id, old] of state.limits)
      if (Date.now() - old.at > KEEP_MS || state.limits.size >= MAX_THREADS) state.limits.delete(id);
    state.limits.set(threadId, { ...limit, at, sequence });
  }
  save(state);
}

/** A status change: a turn starts (`active`), or one ends fine (`idle`). A thread no limit stopped costs a map lookup. */
export function notePlanLimitStatus(threadId: string, status: string, at = Date.now()): void {
  const state = current;
  const limit = state?.limits.get(threadId);
  if (!state || !limit) return;
  if (status === "idle") return notePlanLimitEnded(threadId);
  if (status !== "active" || limit.resumedAt !== undefined) return;
  state.limits.set(threadId, { ...limit, resumedAt: at });
  save(state);
}

/** The turn since the limit ended without hitting it again: the wait is over. Read now, the switch that got it going is
 *  already in the thread's events. */
export function notePlanLimitEnded(threadId: string): void {
  const state = current;
  const limit = state?.limits.get(threadId);
  if (!state || limit?.resumedAt === undefined) return;
  state.limits.delete(threadId);
  save(state);
  try {
    state.deps.telemetry.capture({
      name: "plan_limit_resolved",
      properties: {
        provider: limit.provider,
        execution: limit.execution,
        is_child_thread: limit.child,
        how: resumedBy(state.deps.db, threadId, limit),
        blocked_ms: Math.max(0, limit.resumedAt - limit.at),
      },
    });
  } catch (error) {
    state.deps.logger.warn({ err: error, threadId }, "Plan limit telemetry failed");
  }
}

function resumedBy(db: DbConnection, threadId: string, limit: Limit): PlanLimitHow {
  const thread = getThread(db, threadId);
  if (thread && thread.providerId !== limit.provider) return "agent_switch";
  const rows = db
    .select({ type: events.type, data: events.data })
    .from(events)
    .where(and(eq(events.threadId, threadId), gt(events.sequence, limit.sequence), inArray(events.type, ["system/operation", "client/turn/requested"])))
    .orderBy(asc(events.sequence))
    .limit(100)
    .all();
  if (rows.some((row) => row.type === "system/operation" && row.data.includes(`"${THREAD_ACCOUNT_SWITCH_OPERATION}"`))) return "account_switch";
  const request = rows.find((row) => row.type === "client/turn/requested");
  if (!request) return "user";
  const data = z
    .object({ retryOfRequestId: z.string().optional(), input: z.array(z.object({ text: z.string().optional() }).passthrough()).optional() })
    .catch({})
    .parse(JSON.parse(request.data));
  // A retry of the stopped turn: after the reset, by hand, or the website's resume loop in Cloud.
  return data.retryOfRequestId || LIMIT_RESUME.test(data.input?.[0]?.text ?? "") ? "retry" : "user";
}

function save(state: State): void {
  const text = JSON.stringify(Object.fromEntries(state.limits));
  state.saving = state.saving
    .then(() => writeFile(state.file, text, { mode: 0o600 }))
    .catch((error: unknown) => state.deps.logger.warn({ err: error }, "Plan limit telemetry not saved"));
}
