import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  claimAutomationScheduledRun,
  closeAutomationRun,
  listDueAutomations,
  parseAutomationExecution,
  parseAutomationTrigger,
  setAutomationEnabled,
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
): Promise<void> {
  if (args.automation.nextRunAt === null) return;
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
    return;
  }

  if (execution.mode === "agent" && !args.agentHostsAvailable) {
    return;
  }

  const claim = claimAutomationScheduledRun(db, {
    automationId: args.automation.id,
    expectedNextRunAt,
    newNextRunAt,
    now: args.now,
  });
  if (!claim.advanced) return;
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
  const due = listDueAutomations(db, { now, limit: DUE_AUTOMATION_BATCH_SIZE });
  if (due.length === 0) return;
  const projectIds = await liveProjectIds(bb);
  const agentHostsAvailable = await hasConnectedHost(bb);
  for (const automation of due) {
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
      await processDueAutomation(bb, db, {
        pluginDataDir: args.pluginDataDir,
        automation,
        now,
        agentHostsAvailable,
        serverUrl: args.serverUrl,
      });
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
