import {
  automationListResponseSchema,
  automationReadResultSchema,
  automationResponseSchema,
  automationRunListResponseSchema,
  automationRunRpcResponseSchema,
  automationRunsInputSchema,
  automationsOverviewResponseSchema,
  type AutomationAgentSummary,
  createAutomationInputSchema,
  linkThreadInputSchema,
  listAutomationsInputSchema,
  loopPrioritySchema,
  projectAutomationInputSchema,
  reasoningLevelSchema,
  reviewMarkInputSchema,
  reviewResponseSchema,
  runAutomationInputSchema,
  updateAutomationInputSchema,
} from "./rpc-types.js";
import { z } from "zod";
import { PERSONAL_PROJECT_ID } from "@cloudroom/domain";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { AutomationService } from "./service.js";
import type { Db } from "./data.js";
import type { TrackScan } from "./rpc-types.js";
import { cloudLoopUsage, localLoopUsage, templateUsage } from "./usage.js";
import { enablePlanLoops, planLoops, planLoopsEnableInputSchema, planLoopsEnableOutputSchema, planLoopsEventInputSchema, planLoopsEvent, planLoopsSchema, type PlanLoopsDeps } from "./plan-loops.js";
import { agentSessions, agentSessionsSchema } from "./agent-sessions.js";
import {
  forgetCloud,
  newestLoopAt,
  pausedCloud,
  pausedLocal,
  pausedLoopSchema,
} from "./paused.js";

const cloudAutomationInputSchema = z
  .object({
    // "history": a Jev loop's runs for its dialog; they start no thread, so Review has none of them.
    action: z.enum(["list", "create", "update", "run", "delete", "hook", "settings", "history"]),
  })
  .passthrough();

const loopUsageInputSchema = z
  .object({
    automationId: z.string().min(1).optional(),
    cloudId: z.string().min(1).optional(),
    crons: z.array(z.string().min(1).max(120)).min(1).max(20),
  })
  .strict();

const cloudTemplateInputSchema = z
  .object({
    projectId: z.string().min(1),
    name: z.string().min(1),
    prompt: z.string().min(1),
    cron: z.string().min(1),
    timezone: z.string().min(1),
    providerId: z.string().min(1),
    model: z.string().min(1),
    reasoningLevel: reasoningLevelSchema,
    priority: loopPrioritySchema,
    secrets: z.array(z.string().min(1)).optional(),
  })
  .strict();

/** Which scan to start; null is the Workflow scan (older apps send null). */
/** `source`: the one-click scans under the new-thread box. The Scans tab sends none. */
const scanSourceSchema = z.literal("new_thread").optional();
const scanKindSchema = z.enum(["workflow", "cyber"]);
const scanStartInputSchema = z.object({ kind: scanKindSchema, source: scanSourceSchema }).strict().nullable();
/** Per kind: the last scan thread started on this computer, if it still exists, and whether one ever started here. */
const scanStateSchema = z.object({ thread: z.string().nullable(), used: z.boolean() }).strict();

export const automationRpcContract = defineRpcContract({
  automations_overview: {
    input: z.null(),
    output: automationsOverviewResponseSchema,
  },
  automations_list: {
    input: listAutomationsInputSchema,
    output: automationListResponseSchema,
  },
  automations_get: {
    input: projectAutomationInputSchema,
    output: automationReadResultSchema,
  },
  automations_create: {
    input: createAutomationInputSchema,
    output: automationResponseSchema,
  },
  automations_update: {
    input: updateAutomationInputSchema,
    output: automationResponseSchema,
  },
  automations_delete: {
    input: projectAutomationInputSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  automations_pause: {
    input: projectAutomationInputSchema,
    output: automationResponseSchema,
  },
  automations_resume: {
    input: projectAutomationInputSchema,
    output: automationResponseSchema,
  },
  automations_run: {
    input: runAutomationInputSchema,
    output: automationRunRpcResponseSchema,
  },
  // A webhook loop's new secret URL (ADR 0262), shown once.
  automations_new_webhook_url: {
    input: projectAutomationInputSchema,
    output: automationResponseSchema,
  },
  automations_runs: {
    input: automationRunsInputSchema,
    output: automationRunListResponseSchema,
  },
  automations_review: {
    input: z.null(),
    output: reviewResponseSchema,
  },
  automations_review_mark: {
    input: reviewMarkInputSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  automations_link_thread: {
    input: linkThreadInputSchema,
    output: z.object({ linked: z.boolean() }).strict(),
  },
  // Cloud automations (ADR 0212) live on the website; the app passes requests through.
  cloud_automations: {
    input: cloudAutomationInputSchema,
    output: z.unknown(),
  },
  // The API key names in Settings → Cloud environment, for a Cloud loop's Secrets picker (ADR 0342).
  cloud_keys: {
    input: z.null(),
    output: z.object({ names: z.array(z.string()) }).strict(),
  },
  // Loops their own failures paused, local and Cloud, for the sidebar's paused label (ADR 20261101-191413).
  paused_loops: {
    input: z.object({ fresh: z.literal(true) }).strict().nullable(),
    output: z.object({ loops: z.array(pausedLoopSchema) }).strict(),
  },
  // Usage estimates (docs/scopes/loops.md): each schedule's rough share of the weekly Claude or Codex limit.
  automations_usage: {
    input: loopUsageInputSchema,
    output: z
      .object({ limit: z.string(), percents: z.record(z.string(), z.number()) })
      .strict()
      .nullable(),
  },
  templates_usage: {
    input: z.null(),
    output: z.record(z.string(), z.object({ limit: z.string(), percent: z.number() }).strict()),
  },
  cloud_template_add: {
    input: cloudTemplateInputSchema,
    output: z.unknown(),
  },
  account_plan: {
    input: z.null(),
    output: z.object({ plan: z.string().nullable() }).strict(),
  },
  scans_agent_sessions: {
    input: z.object({ source: scanSourceSchema }).strict().nullable(),
    output: agentSessionsSchema,
  },
  scans_start: {
    input: scanStartInputSchema,
    output: z.object({ threadId: z.string() }).strict(),
  },
  scans_upgrade_clicked: {
    input: z.null(),
    output: z.null(),
  },
  scans_state: {
    input: z.null(),
    output: z.object({ workflow: scanStateSchema, cyber: scanStateSchema }).strict(),
  },
  scans_card: {
    input: z.null(),
    output: z.object({ show: z.boolean() }).strict(),
  },
  // The pop-up after buying a plan (plan-loops.ts): what it shows or null, turning its loops on, and its stats.
  plan_loops: { input: z.null(), output: planLoopsSchema.nullable() },
  plan_loops_enable: { input: planLoopsEnableInputSchema, output: planLoopsEnableOutputSchema },
  plan_loops_event: { input: planLoopsEventInputSchema, output: z.null() },
});

type Sdk = Pick<BbPluginApi["sdk"], "cloudroom" | "system" | "threads">;
type Cloud = Sdk["cloudroom"];
type CloudAutomation = NonNullable<
  Awaited<ReturnType<Cloud["automations"]>>["automation"]
>;

type CloudThread = Awaited<ReturnType<Sdk["threads"]["get"]>>;

async function cloudThreadAgent(
  threads: Sdk["threads"],
  thread: CloudThread,
): Promise<AutomationAgentSummary | null> {
  try {
    const options = await threads.defaultExecutionOptions({
      threadId: thread.id,
    });
    return {
      providerId: "providerId" in thread ? thread.providerId : null,
      model: options?.model ?? null,
      reasoningLevel: options?.reasoningLevel ?? null,
    };
  } catch {
    return null;
  }
}

async function withCloudAgents(threads: Sdk["threads"], result: unknown) {
  const { automations = [] } = result as {
    automations?: (Pick<CloudAutomation, "thread_id" | "agent" | "agents"> & {
      project_id?: string | null;
    })[];
  };
  return {
    ...(result as object),
    // A fresh-thread loop's own saved agent; otherwise its thread's, which it uses. Its project is its thread's, or the website's once that thread is deleted.
    automations: await Promise.all(
      automations.map(async (automation) => {
        const summary = (agent: NonNullable<CloudAutomation["agent"]>) => ({
          providerId: agent.provider,
          model: agent.model,
          reasoningLevel: agent.reasoning,
        });
        // A project loop's home is its project (no thread hosts it).
        const home = automation.thread_id.startsWith("proj_") ? automation.thread_id : null;
        const thread = home
          ? null
          : await threads.get({ threadId: automation.thread_id }).catch(() => null);
        return {
          ...automation,
          project_id:
            home ??
            (thread && "projectId" in thread
              ? thread.projectId
              : (automation.project_id ?? null)),
          // A loop with several agents lists them in turn order.
          ...(automation.agents?.length
            ? { agents: automation.agents.map(summary) }
            : {}),
          agent: automation.agent
            ? summary(automation.agent)
            : thread
              ? await cloudThreadAgent(threads, thread)
              : null,
        };
      }),
    ),
  };
}

const connected = (auth: { state: string } | null) =>
  auth?.state === "connected" || auth?.state === "limited";

type Kv = BbPluginApi["storage"]["kv"];
const SCAN_TITLE = "Workflow scan";
const LAST_SCAN_KEY = "scans.lastStartedAt";
/** The top-right Scan card wants to show when no scan started on this computer for this long (docs/scopes/corner-cards.md). */
const SCAN_CARD_DAYS = 45;
/** And when no new loop was created for this long: someone who just made a loop needs no nudge (David, 2026-11-16). */
const NO_NEW_LOOP_DAYS = 10;

type ScanKind = z.output<typeof scanKindSchema>;
/** The last scan thread of each kind started here. Its presence also means a Free plan's one free scan of that kind
 *  is used (David, 2026-11-19: "the first scan of each kind is free"). Per computer. */
const scanThreadKey = (kind: ScanKind) => `scans.thread.${kind}`;

async function scanState(sdk: Sdk, kv: Kv, kind: ScanKind): Promise<z.output<typeof scanStateSchema>> {
  const id = await kv.get<string>(scanThreadKey(kind)).catch(() => undefined);
  if (typeof id !== "string") return { thread: null, used: false };
  return { thread: await sdk.threads.get({ threadId: id }).then(() => id, () => null), used: true };
}

/** When the last Workflow scan started on this computer, or 0. A scan from before this was saved is found once, by its thread. */
async function lastScanAt(sdk: Sdk, kv: Kv, pluginId: string): Promise<number> {
  const saved = await kv.get<number>(LAST_SCAN_KEY).catch(() => undefined);
  if (typeof saved === "number") return saved;
  const threads = z
    .array(z.object({ title: z.string().nullable(), createdAt: z.number() }).passthrough())
    .catch([])
    .parse(await sdk.threads.list({ projectId: PERSONAL_PROJECT_ID, originPluginId: pluginId, sort: "created", limit: 50 }).catch(() => []));
  const found = threads.find((thread) => thread.title === SCAN_TITLE)?.createdAt ?? 0;
  await kv.set(LAST_SCAN_KEY, found).catch(() => {});
  return found;
}

export function createRpcHandlers(
  service: AutomationService,
  sdk?: Sdk,
  db?: Db,
  trackScan: TrackScan = () => {},
  scans?: { kv: Kv; pluginId: string },
  plan?: PlanLoopsDeps,
) {
  return {
    async plan_loops() {
      return plan ? planLoops(plan) : null;
    },
    async plan_loops_enable(input: z.output<typeof planLoopsEnableInputSchema>) {
      if (!plan) throw new Error("Cloud loops are unavailable.");
      return enablePlanLoops(plan, input);
    },
    async plan_loops_event(input: z.output<typeof planLoopsEventInputSchema>) {
      return plan ? planLoopsEvent(plan, input.event) : null;
    },
    async automations_usage(input: z.output<typeof loopUsageInputSchema>) {
      if (!sdk) return null;
      if (input.cloudId) return cloudLoopUsage(sdk, input.cloudId, input.crons);
      if (input.automationId && db)
        return localLoopUsage(sdk, db, input.automationId, input.crons);
      return null;
    },
    async templates_usage() {
      return sdk ? templateUsage(sdk) : {};
    },
    async cloud_automations(
      input: z.output<typeof cloudAutomationInputSchema>,
    ) {
      if (!sdk) throw new Error("Cloud automations are unavailable.");
      const result = await sdk.cloudroom.automations(
        input as Parameters<Cloud["automations"]>[0],
      );
      if (input.action !== "list") forgetCloud();
      return input.action === "list"
        ? withCloudAgents(sdk.threads, result)
        : result;
    },
    async cloud_keys() {
      if (!sdk) throw new Error("Cloud loops are unavailable.");
      const { variables } = await sdk.cloudroom.environment();
      return { names: variables.map((variable) => variable.name) };
    },
    async paused_loops(input: { fresh: true } | null) {
      // Right after a reconnect the website retried its paused loops: read it again, not the 15-minute copy.
      if (input?.fresh) forgetCloud();
      const now = Date.now();
      const loops = [
        ...(db ? pausedLocal(db, now) : []),
        ...(sdk ? await pausedCloud(sdk.cloudroom, now) : []),
      ];
      return { loops: loops.sort((a, b) => b.at - a.at) };
    },
    async cloud_template_add(
      input: z.output<typeof cloudTemplateInputSchema>,
    ) {
      if (!sdk) throw new Error("Cloud loops are unavailable.");
      return sdk.cloudroom.automations({
        action: "create",
        // A Cloud loop belongs to its project; no thread hosts it (ADR 20261101-004659).
        project: input.projectId,
        name: input.name,
        prompt: input.prompt,
        cron: input.cron,
        timezone: input.timezone,
        harness: input.providerId,
        model: input.model,
        reasoning: input.reasoningLevel,
        priority: input.priority,
        ...(input.secrets !== undefined ? { secrets: input.secrets } : {}),
      });
    },
    // The Scans tab asks for these once each time it opens.
    async scans_agent_sessions(input: { source?: "new_thread" } | null) {
      const sessions = await agentSessions();
      trackScan("viewed", {
        ...(input?.source ? { source: input.source } : {}),
        agents: sessions.agents.length,
        sessions: sessions.agents.reduce((sum, agent) => sum + agent.sessions, 0),
      });
      return sessions;
    },
    scans_upgrade_clicked() {
      trackScan("upgrade_clicked");
      return null;
    },
    async scans_state() {
      const none = { thread: null, used: false };
      if (!sdk || !scans) return { workflow: none, cyber: none };
      const [workflow, cyber] = await Promise.all([scanState(sdk, scans.kv, "workflow"), scanState(sdk, scans.kv, "cyber")]);
      return { workflow, cyber };
    },
    async scans_start(input: z.output<typeof scanStartInputSchema>) {
      if (!sdk) throw new Error("Scans are unavailable.");
      const kind = input?.kind ?? "workflow";
      const cyber = kind === "cyber";
      const source: { source?: string } = input?.source ? { source: input.source } : {};
      const plan = (await sdk.cloudroom.status().catch(() => null))?.plan;
      const freeScan = plan === "free" && scans !== undefined && (await scans.kv.get(scanThreadKey(kind)).catch(() => "unknown")) == null;
      if (!plan || (plan === "free" && !freeScan)) {
        trackScan("start_failed", { reason: plan ? "free" : "no_plan", kind, ...source });
        throw new Error(
          "Scans need a paid plan. Upgrade at https://www.cloudroom.dev/billing",
        );
      }
      const [claude, codex] = await Promise.all([
        sdk.cloudroom.claudeAuth().catch(() => null),
        sdk.cloudroom.codexAuth().catch(() => null),
      ]);
      const lead =
        !connected(claude) && connected(codex)
          ? { providerId: "codex", model: "gpt-6.1-sol" }
          : { providerId: "claude-code", model: "claude-opus-5-5" };
      const spawned = await sdk.threads.spawn({
          projectId: PERSONAL_PROJECT_ID,
          executionTarget: "local",
          environment: { type: "project-default" },
          ...lead,
          reasoningLevel: "xhigh",
          title: cyber ? "Cyber scan" : SCAN_TITLE,
          prompt: cyber
            ? "Run a cyber scan of my computer and active repos. Follow the cyber-scan skill."
            : "Scan my workflow. Follow the workflow-scan skill.",
          // Both scans share the progress card's metadata; `kind` picks the Cyber scan's labels.
          pluginMetadata: { workflowScan: cyber ? { stage: "finding", kind } : { stage: "finding" } },
        }).catch((error: unknown) => {
          trackScan("start_failed", { reason: "spawn", kind, ...source });
          throw error;
        });
      const thread = z.object({ id: z.string() }).passthrough().parse(spawned);
      trackScan("started", { lead: lead.providerId, kind, ...source, ...(freeScan ? { free: true } : {}) });
      await scans?.kv.set(scanThreadKey(kind), thread.id).catch(() => {});
      await sdk.threads.pin({ threadId: thread.id }).catch(() => null);
      if (!cyber) await scans?.kv.set(LAST_SCAN_KEY, Date.now()).catch(() => {});
      return { threadId: thread.id };
    },
    /** Whether the top-right Scan card wants to show: signed in, on any plan, no scan started here in the last
     *  45 days, and no new loop (Local or Cloud) in the last 10 days. Free plans see it too: the Scans tab then
     *  asks them to upgrade (David, 2026-11-16). Unknown Cloud loops count as a no. */
    async scans_card() {
      if (!sdk || !scans || !db) return { show: false };
      const plan = (await sdk.cloudroom.status().catch(() => null))?.plan;
      if (!plan) return { show: false };
      const now = Date.now(), day = 86_400_000;
      if (now - (await lastScanAt(sdk, scans.kv, scans.pluginId)) <= SCAN_CARD_DAYS * day) return { show: false };
      const newest = await newestLoopAt(db, sdk.cloudroom, now);
      return { show: newest !== null && now - newest > NO_NEW_LOOP_DAYS * day };
    },
    async account_plan() {
      const status = await sdk?.cloudroom.status().catch(() => null);
      return { plan: status?.plan ?? null };
    },
    automations_overview() {
      return service.overview();
    },
    automations_list(input: z.output<typeof listAutomationsInputSchema>) {
      return service.list(input);
    },
    automations_get(input: z.output<typeof projectAutomationInputSchema>) {
      return service.get(input);
    },
    automations_create(input: z.output<typeof createAutomationInputSchema>) {
      return service.create(input);
    },
    automations_update(input: z.output<typeof updateAutomationInputSchema>) {
      return service.update(input);
    },
    automations_delete(input: z.output<typeof projectAutomationInputSchema>) {
      return service.delete(input);
    },
    automations_pause(input: z.output<typeof projectAutomationInputSchema>) {
      return service.pause(input);
    },
    automations_resume(input: z.output<typeof projectAutomationInputSchema>) {
      return service.resume(input);
    },
    automations_run(input: z.output<typeof runAutomationInputSchema>) {
      return service.run(input);
    },
    automations_new_webhook_url(
      input: z.output<typeof projectAutomationInputSchema>,
    ) {
      return service.newWebhookUrl(input);
    },
    automations_runs(input: z.output<typeof automationRunsInputSchema>) {
      return service.runs(input);
    },
    automations_review() {
      return service.review();
    },
    automations_review_mark(input: z.output<typeof reviewMarkInputSchema>) {
      return service.markReviewed(input);
    },
    automations_link_thread(input: z.output<typeof linkThreadInputSchema>) {
      return service.linkThread(input);
    },
  };
}
