import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  createAutomation,
  createManualRun,
  decodeAutomationRow,
  deleteAutomation,
  getAutomation,
  getAutomationForProject,
  getAutomationRun,
  listWebhookAttempts,
  isAutomationSpawnedThread,
  listAllAutomations,
  listAutomationRuns,
  listAutomationsForProject,
  listRunningAutomationRunsByThread,
  linkRunThread,
  setAutomationEnabled,
  setReviewed,
  toAutomationResponse,
  toAutomationRunResponse,
  updateAutomation,
  closeAutomationRun,
  type AutomationRow,
  type AutomationRunRow,
  type Db,
} from "./data.js";
import { createAutomationId } from "./ids.js";
import {
  providerRoutingForEnvironment,
  resolvePermissionMode,
  requireReasoningLevel,
  requireServiceTier,
} from "./provider-permissions.js";
import { publishAutomationChange, REVIEW_SIGNAL_PROJECT } from "./realtime.js";
import {
  AUTOMATION_RUNS_LIMIT_MAX,
  automationRunListResponseSchema,
  automationsOverviewResponseSchema,
  type AgentExecutionUpdate,
  type AutomationAgentSummary,
  type AutomationExecution,
  type AutomationReadProblem,
  type AutomationReadResult,
  type AutomationRunListResponse,
  type AutomationRunRpcResponse,
  type AutomationResponse,
  type AutomationsOverviewResponse,
  type ResolvedCreateAutomationInput,
  type ResolvedAutomationRunsInput,
  type ReviewResponse,
  type RunAutomationInput,
  type UpdateAutomationInput,
} from "./rpc-types.js";
import { buildReview } from "./review.js";
import {
  computeInitialNextRunAt,
  computeNextScheduledTime,
  validateOnceDefinition,
  validateScheduleDefinition,
} from "./schedule-helpers.js";
import {
  automationScriptDir,
  deleteAutomationScriptDir,
  deleteAutomationScriptFile,
  readAutomationScript,
  scriptAgents,
  writeInlineAutomationScript,
} from "./script-files.js";
import { errorMessage, executeAgentRun, executeScriptRun } from "./run.js";
import { listLiveProjects } from "./sweep.js";

type ServiceApi = Pick<BbPluginApi, "realtime" | "log"> & {
  sdk: {
    projects: Pick<BbPluginApi["sdk"]["projects"], "get" | "list"> &
      Partial<Pick<BbPluginApi["sdk"]["projects"], "defaultExecutionOptions">>;
    providers: Pick<BbPluginApi["sdk"]["providers"], "list">;
    threads: Pick<BbPluginApi["sdk"]["threads"], "get" | "send" | "spawn"> &
      Partial<Pick<BbPluginApi["sdk"]["threads"], "output">>;
    // Webhook loops' URLs live on the website (ADR 0262).
    cloudroom?: Pick<BbPluginApi["sdk"]["cloudroom"], "automations">;
  };
};

export interface AutomationService {
  overview(): Promise<AutomationsOverviewResponse>;
  list(input: { projectId: string }): AutomationReadResult[];
  get(input: {
    projectId: string;
    automationId: string;
  }): Promise<AutomationReadResult>;
  create(input: ResolvedCreateAutomationInput): Promise<AutomationResponse>;
  update(input: UpdateAutomationInput): Promise<AutomationResponse>;
  delete(input: {
    projectId: string;
    automationId: string;
  }): Promise<{ ok: true }>;
  pause(input: { projectId: string; automationId: string }): AutomationResponse;
  resume(input: {
    projectId: string;
    automationId: string;
  }): AutomationResponse;
  run(input: RunAutomationInput): Promise<AutomationRunRpcResponse>;
  /** Runs a batch of webhook events. True once a run has taken them (its thread started or its script ran), so the
   *  batch can be acked; false while it must wait or try again. */
  runWebhook(input: {
    automationId: string;
    batch: string;
    events: string;
  }): Promise<boolean>;
  /** A webhook loop's new secret URL; the old one stops working. */
  newWebhookUrl(input: {
    projectId: string;
    automationId: string;
  }): Promise<AutomationResponse>;
  runs(input: ResolvedAutomationRunsInput): AutomationRunListResponse;
  review(): Promise<ReviewResponse>;
  markReviewed(input: { itemIds: string[]; reviewed: boolean }): { ok: true };
  linkThread(input: { runId: string; threadId: string }): { linked: boolean };
  /** `room-cli loop report` in a Local loop run: saved with Cloud runs on the website (ADR 0298). */
  report(input: LoopReport): Promise<{ reported: true }>;
}

export interface LoopReport {
  threadId: string;
  outcome: string;
  confidence: string;
  reason: string;
  actions: string[];
}

function requireProjectAutomation(
  db: Db,
  args: { projectId: string; automationId: string },
): AutomationRow {
  const automation = getAutomationForProject(db, args);
  if (!automation) throw new Error("Loop not found");
  return automation;
}

function validateTrigger(
  trigger: ResolvedCreateAutomationInput["trigger"],
  now = Date.now(),
): void {
  if (trigger.triggerType === "schedule") {
    validateScheduleDefinition({
      cron: trigger.cron,
      timezone: trigger.timezone,
    });
  } else if (trigger.triggerType === "once") {
    validateOnceDefinition({ runAt: trigger.runAt, now });
  }
}

function computeNextRunAt(
  trigger: ResolvedCreateAutomationInput["trigger"],
  now: number,
): number | null {
  if (trigger.triggerType === "webhook") return null;
  if (trigger.triggerType === "once") {
    return trigger.runAt;
  }
  return computeNextScheduledTime({
    cron: trigger.cron,
    timezone: trigger.timezone,
    now,
  });
}

function assertNotRecursiveCreation(
  db: Db,
  createdByThreadId: string | undefined,
): void {
  if (createdByThreadId === undefined) return;
  if (isAutomationSpawnedThread(db, createdByThreadId)) {
    throw new Error("Loop-spawned threads cannot create loops");
  }
}

type ResolvedStoredExecution = {
  execution: AutomationExecution;
  writtenScriptFile?: string;
};

async function resolveStoredExecution(args: {
  pluginDataDir: string;
  automationId: string;
  execution: AutomationExecution;
}): Promise<ResolvedStoredExecution> {
  if (args.execution.mode !== "script") {
    return { execution: args.execution };
  }
  if (args.execution.script !== undefined) {
    const scriptFile = await writeInlineAutomationScript({
      dataDir: args.pluginDataDir,
      automationId: args.automationId,
      content: args.execution.script,
      scriptFile: args.execution.scriptFile,
    });
    const { script: _script, ...rest } = args.execution;
    return {
      execution: { ...rest, scriptFile },
      writtenScriptFile: scriptFile,
    };
  }
  return { execution: args.execution };
}

async function discardUncommittedScript(args: {
  bb: Pick<ServiceApi, "log">;
  pluginDataDir: string;
  automationId: string;
  scriptFile: string | undefined;
}): Promise<void> {
  if (args.scriptFile === undefined) return;
  try {
    await deleteAutomationScriptFile({
      dataDir: args.pluginDataDir,
      automationId: args.automationId,
      scriptFile: args.scriptFile,
    });
  } catch (error) {
    args.bb.log.warn(
      `Failed to discard uncommitted script for automation ${args.automationId}: ${errorMessage(error)}`,
    );
  }
}

function withStoredScriptPath(
  pluginDataDir: string,
  automation: AutomationResponse,
): AutomationResponse {
  if (
    automation.execution.mode !== "script" ||
    automation.execution.scriptFile === undefined
  ) {
    return automation;
  }
  return {
    ...automation,
    execution: {
      ...automation.execution,
      storedScriptPath: join(
        automationScriptDir(pluginDataDir, automation.id),
        automation.execution.scriptFile,
      ),
    },
  };
}

type ProjectExecutionDefaults = Awaited<
  ReturnType<BbPluginApi["sdk"]["projects"]["defaultExecutionOptions"]>
>;

async function overviewScriptAgents(
  pluginDataDir: string,
  automation: AutomationReadResult,
  projectDefaults: (projectId: string) => Promise<ProjectExecutionDefaults>,
): Promise<AutomationAgentSummary[] | undefined> {
  if ("problem" in automation || automation.execution.mode !== "script") {
    return undefined;
  }
  const { script, scriptFile } = automation.execution;
  const source =
    script ??
    (scriptFile === undefined
      ? ""
      : await readAutomationScript({
          dataDir: pluginDataDir,
          automationId: automation.id,
          scriptFile,
        }).catch(() => ""));
  const agents = scriptAgents(source);
  if (agents.every((agent) => !Object.values(agent).includes(null))) {
    return agents;
  }
  const defaults = await projectDefaults(automation.projectId);
  if (defaults === null) return agents;
  return agents.map((agent) =>
    (agent.providerId ?? defaults.providerId) === defaults.providerId
      ? {
          providerId: defaults.providerId,
          model: agent.model ?? defaults.model,
          reasoningLevel: agent.reasoningLevel ?? defaults.reasoningLevel,
        }
      : agent,
  );
}

function toStoredAutomationResponse(
  pluginDataDir: string,
  row: AutomationRow,
): AutomationResponse {
  return withStoredScriptPath(pluginDataDir, toAutomationResponse(row));
}

type AutomationWriteOperation = "run" | "pause" | "resume" | "update";

const MISSING_PROMPT_OPERATION: Record<AutomationWriteOperation, string> = {
  run: "it can run",
  pause: "it can be paused",
  resume: "it can be resumed",
  update: "other fields can be updated",
};

const INVALID_DATA_OPERATION: Record<AutomationWriteOperation, string> = {
  run: "run",
  pause: "paused",
  resume: "resumed",
  update: "updated",
};

function automationWriteError(
  row: AutomationRow,
  operation: AutomationWriteOperation,
  problem: AutomationReadProblem["problem"],
): Error {
  return problem === "missing-agent-prompt"
    ? new Error(
        `Loop "${row.name}" requires a prompt before ${MISSING_PROMPT_OPERATION[operation]}. Edit it and add a prompt first.`,
      )
    : new Error(
        `Loop "${row.name}" has invalid stored data and cannot be ${INVALID_DATA_OPERATION[operation]}. Delete it and recreate it.`,
      );
}

function requireCanonicalAutomationForWrite(
  pluginDataDir: string,
  row: AutomationRow,
  operation: AutomationWriteOperation,
): AutomationResponse {
  const decoded = decodeAutomationRow(row);
  if ("error" in decoded) {
    throw automationWriteError(row, operation, decoded.automation.problem);
  }
  return withStoredScriptPath(pluginDataDir, decoded.automation);
}

function toStoredAutomationReadResult(
  bb: Pick<ServiceApi, "log">,
  pluginDataDir: string,
  row: AutomationRow,
): AutomationReadResult {
  const decoded = decodeAutomationRow(row);
  if (!("error" in decoded)) {
    return withStoredScriptPath(pluginDataDir, decoded.automation);
  }
  if (decoded.automation.problem === "invalid-stored-data") {
    bb.log.warn(
      `Malformed stored automation ${row.id}: ${decoded.error.message}`,
    );
  }
  return decoded.automation;
}

async function toEditableAutomationResponse(args: {
  pluginDataDir: string;
  automation: AutomationResponse;
}): Promise<AutomationResponse> {
  const { automation } = args;
  if (
    automation.execution.mode !== "script" ||
    automation.execution.scriptFile === undefined
  ) {
    return automation;
  }
  const { scriptFile, ...execution } = automation.execution;
  return {
    ...automation,
    execution: {
      ...execution,
      script: await readAutomationScript({
        dataDir: args.pluginDataDir,
        automationId: automation.id,
        scriptFile,
      }),
    },
  };
}

async function toEditableAutomationReadResult(args: {
  bb: Pick<ServiceApi, "log">;
  pluginDataDir: string;
  row: AutomationRow;
}): Promise<AutomationReadResult> {
  const automation = toStoredAutomationReadResult(
    args.bb,
    args.pluginDataDir,
    args.row,
  );
  if ("problem" in automation) return automation;
  return toEditableAutomationResponse({
    pluginDataDir: args.pluginDataDir,
    automation,
  });
}

async function cleanupSupersededScript(args: {
  bb: Pick<ServiceApi, "log">;
  pluginDataDir: string;
  automationId: string;
  previous: AutomationExecution;
  next: AutomationExecution;
}): Promise<void> {
  if (args.previous.mode !== "script") return;
  try {
    if (args.next.mode !== "script") {
      await deleteAutomationScriptDir({
        dataDir: args.pluginDataDir,
        automationId: args.automationId,
      });
      return;
    }
    if (
      args.previous.scriptFile !== undefined &&
      args.next.scriptFile !== undefined &&
      args.previous.scriptFile !== args.next.scriptFile
    ) {
      await deleteAutomationScriptFile({
        dataDir: args.pluginDataDir,
        automationId: args.automationId,
        scriptFile: args.previous.scriptFile,
      });
    }
  } catch (error) {
    args.bb.log.warn(
      `Failed to remove superseded script for automation ${args.automationId}: ${errorMessage(error)}`,
    );
  }
}

function encodeRunCursor(startedAt: number, id: string): string {
  return Buffer.from(`${startedAt}:${id}`, "utf8").toString("base64url");
}

function applyAgentExecutionUpdate(
  execution: AutomationExecution,
  update: AgentExecutionUpdate,
): Extract<AutomationExecution, { mode: "agent" }> {
  if (execution.mode !== "agent") {
    throw new Error(
      "Agent execution options can only update agent automations",
    );
  }

  const next = {
    ...execution,
    ...(update.prompt !== undefined ? { prompt: update.prompt } : {}),
    ...(update.providerId !== undefined
      ? { providerId: update.providerId }
      : {}),
    ...(update.model !== undefined ? { model: update.model } : {}),
    ...(update.reasoningLevel !== undefined
      ? { reasoningLevel: update.reasoningLevel }
      : {}),
    ...(update.permissionMode !== undefined
      ? { permissionMode: update.permissionMode }
      : {}),
  };
  if (update.serviceTier === null) {
    delete next.serviceTier;
  } else if (update.serviceTier !== undefined) {
    next.serviceTier = update.serviceTier;
  }
  if (update.target === undefined) return next;
  if (update.target.type === "target-thread") {
    return { ...next, targetThreadId: update.target.threadId };
  }
  const { targetThreadId: _targetThreadId, ...withoutTargetThread } = next;
  return {
    ...withoutTargetThread,
    environment: update.target.environment,
  };
}

function parseRunCursor(
  cursor: string | undefined,
): { startedAt: number; id: string } | null {
  if (cursor === undefined) return null;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator <= 0) throw new Error("Invalid runs cursor");
  const startedAt = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (!Number.isFinite(startedAt) || id.length === 0) {
    throw new Error("Invalid runs cursor");
  }
  return { startedAt, id };
}

async function projectNameById(
  bb: Pick<ServiceApi, "sdk" | "log">,
): Promise<Map<string, string>> {
  try {
    return new Map(
      (await listLiveProjects(bb)).map((project) => [
        project.id,
        project.name ?? project.id,
      ]),
    );
  } catch (error) {
    bb.log.warn(
      `Failed to list projects for automations overview: ${errorMessage(error)}`,
    );
    return new Map();
  }
}

const projectAvailableSchema = z.object({ id: z.string() }).passthrough();

async function requireProjectAvailable(
  bb: Pick<ServiceApi, "sdk">,
  projectId: string,
): Promise<void> {
  try {
    projectAvailableSchema.parse(await bb.sdk.projects.get({ projectId }));
  } catch (error) {
    throw new Error(
      `Project ${projectId} is not available: ${errorMessage(error)}`,
    );
  }
}

/** A webhook run has taken its events once its agent's thread started or its script finished; a script's silent
 *  tick counts. A run cut off before either, or that failed, has not. */
function tookEvents(run: AutomationRunRow): boolean {
  return (
    run.status === "succeeded" ||
    (run.status === "running" && run.threadId !== null) ||
    (run.status === "skipped" && run.exitCode === 0)
  );
}

/** A Local webhook loop's URL from the website, which keeps the events while this Mac is off (ADR 0262). */
async function webhookUrl(
  bb: ServiceApi,
  automationId: string,
): Promise<string> {
  if (!bb.sdk.cloudroom)
    throw new Error("Webhook loops need a Cloudroom account.");
  const { url } = await bb.sdk.cloudroom.automations({
    action: "hook",
    local: automationId,
  });
  if (!url) throw new Error("The website returned no webhook URL.");
  return url;
}

export function createAutomationService(args: {
  bb: ServiceApi;
  db: Db;
  pluginDataDir: string;
  serverUrl: string;
}): AutomationService {
  const { bb, db, pluginDataDir, serverUrl } = args;

  /** Runs a claimed manual or webhook run: until an agent's thread starts, or a script ends. Webhook events reach
   *  the agent or script as data. */
  async function dispatchRun(
    automation: AutomationRow,
    run: AutomationRunRow,
    execution: AutomationExecution,
    events?: string,
  ): Promise<void> {
    publishAutomationChange(
      bb,
      automation.projectId,
      "automation-runs-changed",
    );
    const closeFailedRun = (error: unknown): void => {
      closeAutomationRun(db, {
        runId: run.id,
        status: "failed",
        error: errorMessage(error),
        now: Date.now(),
      });
    };
    try {
      if (execution.mode === "agent") {
        await executeAgentRun(bb, db, {
          automation,
          run,
          execution,
          onFailure: closeFailedRun,
          ...(events === undefined ? {} : { events }),
        });
      } else {
        await executeScriptRun(bb, db, {
          pluginDataDir,
          automation,
          run,
          execution,
          onFailure: closeFailedRun,
          serverUrl,
          ...(events === undefined ? {} : { events }),
        });
      }
    } catch (error) {
      closeFailedRun(error);
      bb.log.error(
        `Automation run ${run.id} failed unexpectedly: ${errorMessage(error)}`,
      );
      publishAutomationChange(bb, automation.projectId, [
        "automations-changed",
        "automation-runs-changed",
      ]);
    }
  }

  return {
    async overview() {
      const projects = await projectNameById(bb);
      const defaultsByProject = new Map<
        string,
        Promise<ProjectExecutionDefaults>
      >();
      const projectDefaults = (projectId: string) => {
        const cached =
          defaultsByProject.get(projectId) ??
          (
            bb.sdk.projects.defaultExecutionOptions?.({ projectId }) ??
            Promise.resolve(null)
          ).catch(() => null);
        defaultsByProject.set(projectId, cached);
        return cached;
      };
      const automations: AutomationsOverviewResponse["automations"] = [];
      for (const row of listAllAutomations(db)) {
        const projectName = projects.get(row.projectId);
        if (projects.size > 0 && projectName === undefined) continue;
        const automation = toStoredAutomationReadResult(bb, pluginDataDir, row);
        const agents = await overviewScriptAgents(
          pluginDataDir,
          automation,
          projectDefaults,
        );
        automations.push({
          automation,
          project: {
            id: row.projectId,
            name: projectName ?? row.projectId,
          },
          ...(agents === undefined ? {} : { scriptAgents: agents }),
        });
      }
      return automationsOverviewResponseSchema.parse({ automations });
    },

    list(input) {
      return listAutomationsForProject(db, input.projectId).map((row) =>
        toStoredAutomationReadResult(bb, pluginDataDir, row),
      );
    },

    get(input) {
      return toEditableAutomationReadResult({
        bb,
        pluginDataDir,
        row: requireProjectAutomation(db, input),
      });
    },

    async create(payload) {
      await requireProjectAvailable(bb, payload.projectId);
      const now = Date.now();
      validateTrigger(payload.trigger, now);
      assertNotRecursiveCreation(db, payload.createdByThreadId);
      if (payload.execution.mode === "agent") {
        await resolvePermissionMode(
          bb,
          payload.execution.providerId,
          payload.execution.permissionMode,
          providerRoutingForEnvironment(payload.execution.environment),
        );
      }
      const automationId = createAutomationId();
      // A Local webhook loop lets anyone with its URL prompt an agent on this Mac, so one an agent makes starts
      // paused until a person turns it on in the Loops panel (ADR 0260, 0262).
      const webhook = payload.trigger.triggerType === "webhook";
      const enabled =
        payload.enabled && !(webhook && payload.origin === "agent");
      const stored = await resolveStoredExecution({
        pluginDataDir,
        automationId,
        execution: payload.execution,
      });
      let created: AutomationRow;
      try {
        created = createAutomation(db, {
          id: automationId,
          projectId: payload.projectId,
          name: payload.name,
          enabled,
          trigger: payload.trigger,
          runMode: stored.execution.mode,
          execution: stored.execution,
          origin: payload.origin,
          createdByThreadId: payload.createdByThreadId ?? null,
          ...(payload.priority !== undefined ? { priority: payload.priority } : {}),
          nextRunAt: computeInitialNextRunAt({
            trigger: payload.trigger,
            enabled,
            now,
          }),
        });
      } catch (error) {
        await discardUncommittedScript({
          bb,
          pluginDataDir,
          automationId,
          scriptFile: stored.writtenScriptFile,
        });
        throw error;
      }
      // Its URL is shown only now. A loop that can't get one isn't kept.
      let url: string | undefined;
      if (webhook) {
        try {
          url = await webhookUrl(bb, created.id);
        } catch (error) {
          deleteAutomation(db, {
            projectId: payload.projectId,
            automationId: created.id,
          });
          await deleteAutomationScriptDir({
            dataDir: pluginDataDir,
            automationId: created.id,
          });
          throw error;
        }
      }
      publishAutomationChange(bb, payload.projectId, "automations-changed");
      return {
        ...toStoredAutomationResponse(pluginDataDir, created),
        ...(url ? { webhookUrl: url } : {}),
      };
    },

    async update(input) {
      await requireProjectAvailable(bb, input.projectId);
      const current = requireProjectAutomation(db, input);
      const currentAutomation = decodeAutomationRow(current).automation;
      if (
        "problem" in currentAutomation &&
        currentAutomation.problem === "invalid-stored-data"
      ) {
        throw automationWriteError(
          current,
          "update",
          currentAutomation.problem,
        );
      }
      if (input.execution !== undefined && input.agent !== undefined) {
        throw new Error("execution and agent updates cannot be combined");
      }
      const now = Date.now();
      const currentExecution = currentAutomation.execution;
      let stagedScriptFile: string | undefined;
      const patch: Parameters<typeof updateAutomation>[1]["patch"] = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.priority !== undefined) patch.priority = input.priority;
      if (input.trigger !== undefined) {
        if (
          (input.trigger.triggerType === "webhook") !==
          (current.triggerType === "webhook")
        ) {
          throw new Error(
            "A loop can't switch to or from a webhook trigger. Create a new loop instead.",
          );
        }
        validateTrigger(input.trigger, now);
        patch.trigger = input.trigger;
        patch.nextRunAt = current.enabled
          ? computeNextRunAt(input.trigger, now)
          : null;
      }
      if (input.execution !== undefined) {
        if (input.execution.mode === "agent") {
          await resolvePermissionMode(
            bb,
            input.execution.providerId,
            input.execution.permissionMode,
            providerRoutingForEnvironment(input.execution.environment),
          );
        }
        const stored = await resolveStoredExecution({
          pluginDataDir,
          automationId: current.id,
          execution: input.execution,
        });
        patch.execution = stored.execution;
        stagedScriptFile = stored.writtenScriptFile;
      }
      if (input.agent !== undefined) {
        const updatedExecution = applyAgentExecutionUpdate(
          currentExecution,
          input.agent,
        );
        if (
          input.agent.providerId !== undefined ||
          input.agent.permissionMode !== undefined ||
          input.agent.target?.type === "environment"
        ) {
          await resolvePermissionMode(
            bb,
            updatedExecution.providerId,
            updatedExecution.permissionMode,
            providerRoutingForEnvironment(updatedExecution.environment),
          );
        }
        if (
          input.agent.providerId !== undefined ||
          input.agent.reasoningLevel !== undefined
        ) {
          await requireReasoningLevel(
            bb,
            updatedExecution.providerId,
            updatedExecution.reasoningLevel,
            providerRoutingForEnvironment(updatedExecution.environment),
          );
        }
        if (
          input.agent.providerId !== undefined ||
          input.agent.serviceTier !== undefined
        ) {
          await requireServiceTier(
            bb,
            updatedExecution.providerId,
            updatedExecution.serviceTier,
            providerRoutingForEnvironment(updatedExecution.environment),
          );
        }
        patch.execution = updatedExecution;
      }
      if (
        "problem" in currentAutomation &&
        currentAutomation.problem === "missing-agent-prompt" &&
        (patch.execution === undefined ||
          (patch.execution.mode === "agent" && patch.execution.prompt === ""))
      ) {
        throw automationWriteError(
          current,
          "update",
          currentAutomation.problem,
        );
      }
      let updated: AutomationRow | null;
      try {
        updated = updateAutomation(db, {
          projectId: input.projectId,
          automationId: input.automationId,
          patch,
        });
      } catch (error) {
        await discardUncommittedScript({
          bb,
          pluginDataDir,
          automationId: current.id,
          scriptFile: stagedScriptFile,
        });
        throw error;
      }
      if (!updated) {
        await discardUncommittedScript({
          bb,
          pluginDataDir,
          automationId: current.id,
          scriptFile: stagedScriptFile,
        });
        throw new Error("Loop not found");
      }
      if (patch.execution !== undefined) {
        await cleanupSupersededScript({
          bb,
          pluginDataDir,
          automationId: current.id,
          previous: currentExecution,
          next: patch.execution,
        });
      }
      publishAutomationChange(bb, input.projectId, "automations-changed");
      return toStoredAutomationResponse(pluginDataDir, updated);
    },

    async delete(input) {
      const automation = requireProjectAutomation(db, input);
      deleteAutomation(db, input);
      // Its URL and waiting events go too; the website expires them in 7 days if this fails.
      if (automation.triggerType === "webhook") {
        await bb.sdk.cloudroom
          ?.automations({ action: "unhook", local: automation.id })
          .catch((error: unknown) =>
            bb.log.warn(
              `Webhook URL of deleted loop ${automation.id} not removed: ${errorMessage(error)}`,
            ),
          );
      }
      await deleteAutomationScriptDir({
        dataDir: pluginDataDir,
        automationId: automation.id,
      });
      publishAutomationChange(bb, input.projectId, [
        "automations-changed",
        "automation-runs-changed",
      ]);
      return { ok: true };
    },

    pause(input) {
      const current = requireProjectAutomation(db, input);
      requireCanonicalAutomationForWrite(pluginDataDir, current, "pause");
      const updated = setAutomationEnabled(db, {
        projectId: input.projectId,
        automationId: current.id,
        enabled: false,
        nextRunAt: null,
      });
      if (!updated) throw new Error("Loop not found");
      publishAutomationChange(bb, input.projectId, "automations-changed");
      return toStoredAutomationResponse(pluginDataDir, updated);
    },

    resume(input) {
      const current = requireProjectAutomation(db, input);
      const canonical = requireCanonicalAutomationForWrite(
        pluginDataDir,
        current,
        "resume",
      );
      const { trigger } = canonical;
      const now = Date.now();
      validateTrigger(trigger, now);
      const updated = setAutomationEnabled(db, {
        projectId: input.projectId,
        automationId: current.id,
        enabled: true,
        nextRunAt: computeNextRunAt(trigger, now),
        lastError: null,
        resetConsecutiveFailures: true,
      });
      if (!updated) throw new Error("Loop not found");
      publishAutomationChange(bb, input.projectId, "automations-changed");
      return toStoredAutomationResponse(pluginDataDir, updated);
    },

    async run(input) {
      const automation = requireProjectAutomation(db, input);
      const { execution } = requireCanonicalAutomationForWrite(
        pluginDataDir,
        automation,
        "run",
      );
      const now = Date.now();
      const { run, deduped } = createManualRun(db, {
        automationId: automation.id,
        runMode: automation.runMode,
        idempotencyKey: input.idempotencyKey ?? null,
        now,
      });
      if (!deduped) void dispatchRun(automation, run, execution);
      return { run: toAutomationRunResponse(run) };
    },

    async runWebhook(input) {
      const automation = getAutomation(db, input.automationId);
      if (automation?.triggerType !== "webhook" || !automation.enabled)
        return false;
      const { execution } = requireCanonicalAutomationForWrite(
        pluginDataDir,
        automation,
        "run",
      );
      // Each attempt at a batch is a run named after it, so a batch the website hands out again never runs twice.
      // One that took the events confirms it; a failed attempt is tried again with the next name. Three failures in a
      // row pause the loop, and the batch waits on the website until it is resumed.
      const key = `webhook:${input.batch}`;
      const attempts = listWebhookAttempts(db, automation.id, key);
      if (attempts.some(tookEvents)) return true;
      if (attempts.some((attempt) => attempt.status === "running"))
        return false;
      const { run, deduped } = createManualRun(db, {
        automationId: automation.id,
        runMode: automation.runMode,
        idempotencyKey:
          attempts.length === 0 ? key : `${key}:${attempts.length + 1}`,
        trigger: "webhook",
        now: Date.now(),
      });
      // Another run is going: the batch waits for the next ask.
      if (deduped) return false;
      await dispatchRun(automation, run, execution, input.events);
      const settled = getAutomationRun(db, run.id);
      return settled !== null && tookEvents(settled);
    },

    async newWebhookUrl(input) {
      const automation = requireProjectAutomation(db, input);
      if (automation.triggerType !== "webhook")
        throw new Error("Only webhook loops have a URL.");
      return {
        ...toStoredAutomationResponse(pluginDataDir, automation),
        webhookUrl: await webhookUrl(bb, automation.id),
      };
    },

    runs(input) {
      requireProjectAutomation(db, input);
      const limit = Math.min(input.limit, AUTOMATION_RUNS_LIMIT_MAX);
      const runs = listAutomationRuns(db, {
        automationId: input.automationId,
        limit: limit + 1,
        cursor: parseRunCursor(input.cursor),
      });
      const hasMore = runs.length > limit;
      const page = hasMore ? runs.slice(0, limit) : runs;
      const last = page[page.length - 1];
      return automationRunListResponseSchema.parse({
        runs: page.map(toAutomationRunResponse),
        nextCursor:
          hasMore && last ? encodeRunCursor(last.startedAt, last.id) : null,
      });
    },

    review() {
      return buildReview(bb, db);
    },

    markReviewed(input) {
      setReviewed(db, { ...input, now: Date.now() });
      publishAutomationChange(
        bb,
        REVIEW_SIGNAL_PROJECT,
        "automation-runs-changed",
      );
      return { ok: true };
    },

    async report(input) {
      const run = listRunningAutomationRunsByThread(db, input.threadId)[0];
      const automation = run ? getAutomation(db, run.automationId) : null;
      if (!run || !automation) throw new Error("This thread is not a running loop run, so there is nothing to report.");
      if (!bb.sdk.cloudroom) throw new Error("Sign in to Cloudroom to save loop reports.");
      await bb.sdk.cloudroom.automations({
        action: "report",
        local: automation.id,
        run: run.id,
        thread: input.threadId,
        name: automation.name,
        started_at: new Date(run.startedAt).toISOString(),
        outcome: input.outcome,
        confidence: input.confidence,
        reason: input.reason,
        actions: input.actions,
      });
      return { reported: true };
    },

    linkThread(input) {
      const automation = linkRunThread(db, { ...input, now: Date.now() });
      if (automation) {
        publishAutomationChange(
          bb,
          automation.projectId,
          "automation-runs-changed",
        );
      }
      return { linked: automation !== null };
    },
  };
}
