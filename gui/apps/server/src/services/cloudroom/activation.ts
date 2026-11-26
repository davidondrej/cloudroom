import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, isNotNull, isNull, ne, notExists, notInArray, sql } from "drizzle-orm";
import { threadPluginMetadata, threads } from "@cloudroom/db";
import type { AppDeps } from "../../types.js";
import type { PluginService } from "../plugins/plugin-service.js";
import { firstAgentThreadId } from "../system/first-agent.js";
import { ACTIVATION_STEPS, type ActivationStep } from "../system/telemetry.js";
import { cloudroom, importedThreadIds } from "./commands.js";

const file = (deps: AppDeps) => join(deps.config.dataDir, "cloudroom-activation.json");
const CHECK_MS = 15 * 60_000;
const LEGACY_STEPS = ["cloud", "subagents", "second", "phone", "loop"] as const;

interface ActivationState { done: Set<ActivationStep>; completedStarted: number | null; loopCheckedAt: number; phoneCheckedAt: number }
const states = new Map<string, Promise<ActivationState>>();

function load(deps: AppDeps): Promise<ActivationState> {
  let state = states.get(deps.config.dataDir);
  if (!state) {
    state = readFile(file(deps), "utf8").then((text) => JSON.parse(text) as { done?: unknown; completedStarted?: unknown }, () => ({ done: [], completedStarted: null }))
      .then((saved) => {
        const savedDone = Array.isArray(saved.done) ? saved.done : [];
        const done = new Set<ActivationStep>(ACTIVATION_STEPS.filter((step) => savedDone.includes(step)));
        // Installs that already completed the earlier 5-step checklist stay completed after `second` became `skill`.
        if (LEGACY_STEPS.every((step) => savedDone.includes(step))) done.add("skill");
        return {
          done,
          completedStarted: typeof saved.completedStarted === "number" && Number.isFinite(saved.completedStarted) ? saved.completedStarted : null,
          loopCheckedAt: 0,
          phoneCheckedAt: 0,
        };
      });
    states.set(deps.config.dataDir, state);
  }
  return state;
}

async function markDone(deps: AppDeps, state: ActivationState, steps: ActivationStep[], started?: number) {
  const fresh = steps.filter((step) => !state.done.has(step));
  if (!fresh.length) return;
  for (const step of fresh) {
    state.done.add(step);
    deps.telemetry.capture({ name: "activation_step", properties: { step, action: "done" } });
  }
  if (state.completedStarted === null && ACTIVATION_STEPS.every((step) => state.done.has(step))) {
    const count = started ?? await startedThreads(deps);
    if (state.completedStarted === null) state.completedStarted = count;
  }
  const saved = { done: [...state.done], ...(state.completedStarted !== null ? { completedStarted: state.completedStarted } : {}) };
  await writeFile(file(deps), JSON.stringify(saved), { mode: 0o600 });
}

export async function notePhoneUse(deps: AppDeps): Promise<void> {
  const state = await load(deps);
  if (!state.done.has("phone")) await markDone(deps, state, ["phone"]);
}

export async function noteSkillDone(deps: AppDeps): Promise<void> {
  const state = await load(deps);
  if (!state.done.has("skill")) await markDone(deps, state, ["skill"]);
}

async function hasUserSkill(root: string): Promise<boolean> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const exists = await stat(join(root, entry.name, "SKILL.md")).then((info) => info.isFile(), () => false);
    if (exists) return true;
  }
  return false;
}

function hasSkillUse(deps: AppDeps): boolean {
  const first = firstAgentThreadId(deps.db);
  const skipThread = first ? sql`AND t.id != ${first}` : sql``;
  const skipEvent = first ? sql`AND thread_id != ${first}` : sql``;
  const row = deps.db.get<{ hit: number }>(sql`
    SELECT 1 AS hit FROM (
      SELECT 1 FROM threads AS t
        CROSS JOIN events AS e ON e.thread_id = t.id AND e.type = 'client/turn/requested',
        json_each(e.data, '$.input') AS item,
        json_each(item.value, '$.mentions') AS mention
      WHERE json_extract(e.data, '$.retryAttempt') IS NULL
        ${skipThread}
        AND json_extract(mention.value, '$.resource.kind') = 'command'
        AND json_extract(mention.value, '$.resource.source') = 'skill'
      UNION ALL
      SELECT 1 FROM events
      WHERE type = 'item/completed'
        AND item_kind IN ('toolCall', 'fileRead', 'commandExecution')
        ${skipEvent}
        AND CASE item_kind
          WHEN 'toolCall' THEN json_extract(data, '$.item.tool') = 'Skill'
            OR (json_extract(data, '$.item.tool') IN ('Read', 'Bash') AND instr(data, 'SKILL.md') > 0)
          ELSE instr(data, 'SKILL.md') > 0 END
      LIMIT 1
    ) LIMIT 1
  `);
  return row !== undefined;
}

/** Asks Cloudroom Connect, so a phone set up before this checklist, used only while this Mac sleeps, or pointed at another Mac counts. */
async function signedInPhone(plugins: PluginService): Promise<boolean> {
  const connect = plugins.list().find((plugin) => plugin.source === "builtin:connect");
  const handler = connect ? plugins.getRpcHandler(connect.id, "hasPhone") : null;
  if (!connect || handler?.outcome !== "found") return false;
  const result = await plugins.invokeRpcHandler(connect.id, "hasPhone", handler.value, null, { kind: "client" });
  return result.ok && (result.result as { phone?: unknown }).phone === true;
}

/** The first agent (ADR 20261111-220912) is a thread Cloudroom started, not the user: no step and no count includes it. */
const notFirstAgent = (deps: AppDeps) => {
  const id = firstAgentThreadId(deps.db);
  return id ? ne(threads.id, id) : undefined;
};

async function startedThreads(deps: AppDeps): Promise<number> {
  const imported = await importedThreadIds(deps);
  const [row] = deps.db.select({ n: sql<number>`count(*)` }).from(threads)
    .where(and(isNull(threads.parentThreadId), isNull(threads.originPluginId), notFirstAgent(deps), imported.length ? notInArray(threads.id, imported) : undefined)).all();
  return row?.n ?? 0;
}

export async function activation(deps: AppDeps, plugins: PluginService): Promise<{ steps: Record<ActivationStep, boolean>; started: number; completedStarted: number | null }> {
  const state = await load(deps);
  const cloud = and(eq(threads.executionTarget, "cloud"), notFirstAgent(deps));
  const found: ActivationStep[] = [];
  if (!state.done.has("cloud") && deps.db.select({ id: threads.id }).from(threads).where(cloud).limit(1).get()) {
    found.push("cloud");
  }
  if (!state.done.has("skill") && (hasSkillUse(deps) || await hasUserSkill(deps.config.userSkillsRootPath))) {
    found.push("skill");
  }
  if (!state.done.has("subagents")) {
    const child = deps.db.select({ id: threads.id }).from(threads).where(and(cloud, isNotNull(threads.parentThreadId))).limit(1).get();
    const [count] = deps.db.select({ n: sql<number>`count(*)` }).from(threads).where(cloud).all();
    if (child || (count?.n ?? 0) >= 3) found.push("subagents");
  }
  if (!state.done.has("loop")) {
    // Scans start from the Loops plugin too, but a scan is not a loop.
    const scan = deps.db.select({ id: threadPluginMetadata.threadId }).from(threadPluginMetadata)
      .where(and(eq(threadPluginMetadata.threadId, threads.id), sql`json_extract(${threadPluginMetadata.metadataJson}, '$.workflowScan') is not null`));
    const run = deps.db.select({ id: threads.id }).from(threads).where(and(eq(threads.originPluginId, "automations"), notExists(scan))).limit(1).get();
    if (run) found.push("loop");
    else if (Date.now() - state.loopCheckedAt >= CHECK_MS) {
      state.loopCheckedAt = Date.now();
      void cloudroom(deps).sandboxes.automations({ action: "list" })
        .then((listed) => (listed as { automations?: unknown[] } | null)?.automations?.length ? markDone(deps, state, ["loop"]) : undefined)
        .catch(() => {});
    }
  }
  if (!state.done.has("phone") && Date.now() - state.phoneCheckedAt >= CHECK_MS) {
    state.phoneCheckedAt = Date.now();
    void signedInPhone(plugins).then((phone) => (phone ? markDone(deps, state, ["phone"]) : undefined)).catch(() => {});
  }
  const started = await startedThreads(deps);
  await markDone(deps, state, found, started);
  return {
    steps: Object.fromEntries(ACTIVATION_STEPS.map((step) => [step, state.done.has(step)])) as Record<ActivationStep, boolean>,
    started,
    completedStarted: state.completedStarted,
  };
}
