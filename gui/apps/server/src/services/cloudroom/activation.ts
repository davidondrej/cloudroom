import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, isNotNull, isNull, ne, notExists, notInArray, sql } from "drizzle-orm";
import { threadPluginMetadata, threads } from "@cloudroom/db";
import type { AppDeps } from "../../types.js";
import type { PluginService } from "../plugins/plugin-service.js";
import { firstAgentThreadId } from "../system/first-agent.js";
import { skillNameFromUse, type SkillUseRow } from "../system/skill-usage.js";
import { ACTIVATION_STEPS, type ActivationStep } from "../system/telemetry.js";
import { cloudroom, importedThreadIds } from "./commands.js";
import { cloudSkills } from "./sync.js";

const file = (deps: AppDeps) => join(deps.config.dataDir, "cloudroom-activation.json");
const CHECK_MS = 15 * 60_000;
const SKILL_CURSOR_OVERLAP_MS = 1_000;
const LEGACY_STEPS = ["cloud", "subagents", "second", "phone", "loop"] as const;

interface ActivationState {
  done: Set<ActivationStep>;
  completedStarted: number | null;
  loopCheckedAt: number;
  phoneCheckedAt: number;
  skillEventCursor: number;
  saveVersion: number;
  persistedVersion: number;
  saveQueue: Promise<void>;
}
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
          skillEventCursor: 0,
          saveVersion: 0,
          persistedVersion: 0,
          saveQueue: Promise.resolve(),
        };
      });
    states.set(deps.config.dataDir, state);
  }
  return state;
}

function persist(deps: AppDeps, state: ActivationState): Promise<void> {
  const run = state.saveQueue.catch(() => {}).then(async () => {
    const version = state.saveVersion;
    if (state.persistedVersion >= version) return;
    const saved = { done: [...state.done], ...(state.completedStarted !== null ? { completedStarted: state.completedStarted } : {}) };
    const target = file(deps);
    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(saved), { mode: 0o600 });
      await rename(tmp, target);
      state.persistedVersion = Math.max(state.persistedVersion, version);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  });
  state.saveQueue = run.catch(() => {});
  return run;
}

async function markDone(deps: AppDeps, state: ActivationState, steps: ActivationStep[], started?: number) {
  const fresh = steps.filter((step) => !state.done.has(step));
  for (const step of fresh) {
    state.done.add(step);
    deps.telemetry.capture({ name: "activation_step", properties: { step, action: "done" } });
  }
  if (fresh.length) {
    if (state.completedStarted === null && ACTIVATION_STEPS.every((step) => state.done.has(step))) {
      const count = started ?? await startedThreads(deps);
      if (state.completedStarted === null) state.completedStarted = count;
    }
    state.saveVersion += 1;
  }
  if (state.persistedVersion < state.saveVersion) await persist(deps, state);
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

async function hasCloudSkillSelection(deps: AppDeps): Promise<boolean> {
  const choice = await cloudSkills(deps).catch(() => null);
  return choice !== null && Object.values(choice.chosen).some(Boolean);
}

function hasSkillUse(deps: AppDeps, state: ActivationState): boolean {
  const now = Date.now();
  const since = state.skillEventCursor;
  const first = firstAgentThreadId(deps.db);
  const skipThread = first ? sql`AND t.id != ${first}` : sql``;
  const skipEvent = first ? sql`AND thread_id != ${first}` : sql``;
  const rows = deps.db.all<Pick<SkillUseRow, "kind" | "value">>(sql`
    SELECT 'name' AS kind,
      json_extract(mention.value, '$.resource.name') AS value
    FROM threads AS t
      CROSS JOIN events AS e ON e.thread_id = t.id AND e.type = 'client/turn/requested',
      json_each(e.data, '$.input') AS item,
      json_each(item.value, '$.mentions') AS mention
    WHERE e.created_at >= ${since}
      AND json_extract(e.data, '$.retryAttempt') IS NULL
      ${skipThread}
      AND json_extract(mention.value, '$.resource.kind') = 'command'
      AND json_extract(mention.value, '$.resource.source') = 'skill'
    UNION ALL
    SELECT CASE
        WHEN item_kind = 'toolCall' AND json_extract(data, '$.item.tool') = 'Skill' THEN 'name'
        WHEN item_kind = 'fileRead' OR json_extract(data, '$.item.tool') = 'Read' THEN 'path'
        ELSE 'command' END AS kind,
      CASE item_kind
        WHEN 'fileRead' THEN json_extract(data, '$.item.path')
        WHEN 'commandExecution' THEN json_extract(data, '$.item.command')
        ELSE coalesce(
          json_extract(data, '$.item.arguments.skill'),
          json_extract(data, '$.item.arguments.file_path'),
          json_extract(data, '$.item.arguments.command')) END AS value
    FROM events
    WHERE type = 'item/completed'
      AND item_kind IN ('toolCall', 'fileRead', 'commandExecution')
      AND created_at >= ${since}
      ${skipEvent}
      AND CASE item_kind
        WHEN 'toolCall' THEN json_extract(data, '$.item.tool') = 'Skill'
          OR (json_extract(data, '$.item.tool') IN ('Read', 'Bash') AND instr(data, 'SKILL.md') > 0)
        ELSE instr(data, 'SKILL.md') > 0 END
  `);
  state.skillEventCursor = Math.max(since, now - SKILL_CURSOR_OVERLAP_MS);
  return rows.some((row) => skillNameFromUse(row) !== null);
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
  if (
    !state.done.has("skill") &&
    (await hasUserSkill(deps.config.userSkillsRootPath) ||
      await hasCloudSkillSelection(deps) ||
      hasSkillUse(deps, state))
  ) {
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
