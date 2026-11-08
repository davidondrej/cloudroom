import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  claimAutomationScheduledRun,
  closeAutomationRun,
  listDueAutomations,
  retryPausedAutomations,
  parseAutomationExecution,
  parseAutomationTrigger,
  setAutomationEnabled,
  lastRunFinishedAt,
  listAutomationRuns,
  type AutomationRow,
  type AutomationRunRow,
  type Db,
} from "./data.js";
import { publishAutomationChange } from "./realtime.js";
import { computeNextScheduledTime } from "./schedule-helpers.js";
import {
  errorMessage,
  executeAgentRun,
  executeScriptRun,
  type AgentRunApi,
} from "./run.js";

const DUE_AUTOMATION_BATCH_SIZE = 100;
export const SWEEP_INTERVAL_MS = 10_000;
export const OVERDUE_MS = 2 * 60_000;
export const OVERDUE_SPACING_MS = 60_000;
const lastOverdueStart = new WeakMap<Db, number>();
export const RECOVERY_WAIT_MS = 30 * 60_000;
const busyThreadSchema = z
  .object({ status: z.enum(["starting", "active"]), archivedAt: z.null(), deletedAt: z.null() })
  .passthrough();

const hostListSchema = z.array(
  z.object({ status: z.enum(["connected", "disconnected"]) }).passthrough(),
);
const projectListSchema = z.array(
  z
    .object({
      id: z.string(),
      name: z.string().optional(),
      deletedAt: z.number().nullish(),
    })
    .passthrough(),
);
type ProjectListApi = {
  sdk: {
    projects: {
      list(input: {
        includePersonal?: boolean;
        hidden?: boolean;
      }): Promise<unknown>;
    };
  };
};
type SweepApi = AgentRunApi &
  ProjectListApi & { sdk: { hosts: { list(): Promise<unknown> } } };

export async function listLiveProjects(bb: ProjectListApi) {
  const [visible, hidden] = await Promise.all([
    bb.sdk.projects.list({ includePersonal: true }),
    bb.sdk.projects.list({ hidden: true }),
  ]);
  return [
    ...projectListSchema.parse(visible),
    ...projectListSchema.parse(hidden),
  ].filter((project) => !project.deletedAt);
}

function buildScheduleFailureHandler(
  db: Db,
  args: {
    run: AutomationRunRow;
  },
): (error: unknown) => void {
  return (error) => {
    closeAutomationRun(db, {
      runId: args.run.id,
      status: "failed",
      error: errorMessage(error),
      now: Date.now(),
    });
  };
}

/** provider-retry can bring a failed run's thread back (an app restart cut its turn). Until it settles, for 30 minutes
 *  at most, the loop's next run waits instead of starting a second thread beside it (#887). Any doubt runs, as before. */
async function failedThreadBusy(bb: SweepApi, db: Db, automationId: string, now: number): Promise<boolean> {
  const [last] = listAutomationRuns(db, { automationId, limit: 1 });
  if (last?.status !== "failed" || !last.threadId || now - (last.finishedAt ?? 0) > RECOVERY_WAIT_MS) return false;
  const thread = await bb.sdk.threads.get({ threadId: last.threadId }).catch(() => null);
  return busyThreadSchema.safeParse(thread).success;
}

async function processDueAutomation(
  bb: SweepApi,
  db: Db,
  args: {
    pluginDataDir: string;
    automation: AutomationRow;
    now: number;
    agentHostsAvailable: boolean;
    serverUrl: string;
  },
): Promise<boolean> {
  if (args.automation.nextRunAt === null) return false;
  const expectedNextRunAt = args.automation.nextRunAt;
  let newNextRunAt: number | null;
  let execution;
  try {
    const trigger = parseAutomationTrigger(args.automation.triggerConfig);
    execution = parseAutomationExecution(args.automation.execution);
    newNextRunAt =
      trigger.triggerType !== "schedule"
        ? null
        : computeNextScheduledTime({
            cron: trigger.cron,
            now: args.now,
            timezone: trigger.timezone,
          });
  } catch (error) {
    bb.log.error(
      `Skipping due automation ${args.automation.id} with invalid stored configuration: ${errorMessage(error)}`,
    );
    return false;
  }

  if (execution.mode === "agent" && !args.agentHostsAvailable) {
    return false;
  }
  if (
    execution.mode === "agent" &&
    args.automation.targetThreadId === null &&
    (await failedThreadBusy(bb, db, args.automation.id, args.now))
  )
    return false;

  const claim = claimAutomationScheduledRun(db, {
    automationId: args.automation.id,
    expectedNextRunAt,
    newNextRunAt,
    now: args.now,
  });
  if (!claim.advanced) return false;
  publishAutomationChange(bb, args.automation.projectId, [
    "automations-changed",
    "automation-runs-changed",
  ]);
  const onFailure = buildScheduleFailureHandler(db, {
    run: claim.run,
  });
  if (execution.mode === "agent") {
    await executeAgentRun(bb, db, {
      automation: args.automation,
      run: claim.run,
      execution,
      onFailure,
    });
  } else {
    void executeScriptRun(bb, db, {
      pluginDataDir: args.pluginDataDir,
      automation: args.automation,
      run: claim.run,
      execution,
      onFailure,
      serverUrl: args.serverUrl,
    }).catch((error: unknown) => {
      bb.log.error(
        `Detached script automation ${args.automation.id} failed unexpectedly: ${errorMessage(error)}`,
      );
    });
  }
  return true;
}

async function hasConnectedHost(
  bb: Pick<BbPluginApi, "log"> & {
    sdk: { hosts: { list(): Promise<unknown> } };
  },
): Promise<boolean> {
  try {
    return hostListSchema
      .parse(await bb.sdk.hosts.list())
      .some((host) => host.status === "connected");
  } catch (error) {
    bb.log.warn(
      `Failed to list hosts for automation sweep: ${errorMessage(error)}`,
    );
    return false;
  }
}

// Empty when the list fails, so a failed lookup never pauses anything.
async function liveProjectIds(bb: SweepApi): Promise<Set<string>> {
  try {
    return new Set((await listLiveProjects(bb)).map((project) => project.id));
  } catch (error) {
    bb.log.warn(
      `Failed to list projects for automation sweep: ${errorMessage(error)}`,
    );
    return new Set();
  }
}

export async function sweepDueAutomations(
  bb: SweepApi,
  db: Db,
  args: {
    pluginDataDir: string;
    serverUrl: string;
    now?: number;
  },
): Promise<void> {
  const now = args.now ?? Date.now();
  const startedAt = Date.now();
  for (const projectId of retryPausedAutomations(db, now))
    publishAutomationChange(bb, projectId, "automations-changed");
  const due = listDueAutomations(db, {
    now,
    limit: DUE_AUTOMATION_BATCH_SIZE,
    overdueBefore: now - OVERDUE_MS,
  });
  if (due.length === 0) return;
  const projectIds = await liveProjectIds(bb);
  const agentHostsAvailable = await hasConnectedHost(bb);
  let overdueStarted =
    now - (lastOverdueStart.get(db) ?? -Infinity) < OVERDUE_SPACING_MS;
  for (const automation of due) {
    const nextRunAt = automation.nextRunAt ?? now;
    const overdue =
      now - nextRunAt > OVERDUE_MS &&
      now - Math.max(nextRunAt, lastRunFinishedAt(db, automation.id)) >
        OVERDUE_MS;
    if (overdue && overdueStarted) continue;
    // A deleted project's automations would run unseen, so pause them.
    if (projectIds.size > 0 && !projectIds.has(automation.projectId)) {
      setAutomationEnabled(db, {
        projectId: automation.projectId,
        automationId: automation.id,
        enabled: false,
        nextRunAt: null,
        lastError: "Paused because its project was deleted",
      });
      bb.log.warn(
        `Paused automation ${automation.id}: project ${automation.projectId} was deleted`,
      );
      continue;
    }
    try {
      const started = await processDueAutomation(bb, db, {
        pluginDataDir: args.pluginDataDir,
        automation,
        now,
        agentHostsAvailable,
        serverUrl: args.serverUrl,
      });
      if (overdue && started) {
        overdueStarted = true;
        lastOverdueStart.set(db, now + Date.now() - startedAt);
      }
    } catch (error) {
      bb.log.error(
        `Failed to process due automation ${automation.id}: ${errorMessage(error)}`,
      );
    }
  }
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const settle = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", settle);
      resolve();
    };
    const timeout = setTimeout(settle, ms);
    signal.addEventListener("abort", settle, { once: true });
  });
}
