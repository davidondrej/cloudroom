import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { threads } from "@cloudroom/db";
import type { AppDeps } from "../../types.js";
import { ACTIVATION_STEPS, type ActivationStep } from "../system/telemetry.js";
import { cloudroom } from "./commands.js";

const file = (deps: AppDeps) => join(deps.config.dataDir, "cloudroom-activation.json");
const LOOP_CHECK_MS = 15 * 60_000;

interface ActivationState { done: Set<ActivationStep>; loopCheckedAt: number }
const states = new Map<string, Promise<ActivationState>>();

function load(deps: AppDeps): Promise<ActivationState> {
  let state = states.get(deps.config.dataDir);
  if (!state) {
    state = readFile(file(deps), "utf8").then((text) => JSON.parse(text) as { done?: unknown }, () => ({ done: [] }))
      .then((saved) => ({ done: new Set(ACTIVATION_STEPS.filter((step) => Array.isArray(saved.done) && saved.done.includes(step))), loopCheckedAt: 0 }));
    states.set(deps.config.dataDir, state);
  }
  return state;
}

async function markDone(deps: AppDeps, state: ActivationState, steps: ActivationStep[]) {
  const fresh = steps.filter((step) => !state.done.has(step));
  if (!fresh.length) return;
  for (const step of fresh) {
    state.done.add(step);
    deps.telemetry.capture({ name: "activation_step", properties: { step, action: "done" } });
  }
  await writeFile(file(deps), JSON.stringify({ done: [...state.done] }), { mode: 0o600 });
}

export async function notePhoneUse(deps: AppDeps): Promise<void> {
  const state = await load(deps);
  if (!state.done.has("phone")) await markDone(deps, state, ["phone"]);
}

const readImported = (deps: AppDeps, name: string) =>
  readFile(join(deps.config.dataDir, name), "utf8").then((text) => Object.values(JSON.parse(text) as Record<string, string>), () => []);

async function startedThreads(deps: AppDeps): Promise<number> {
  const imported = [...new Set((await Promise.all([readImported(deps, "session-imports.json"), readImported(deps, "bb-imports.json")])).flat())];
  const [row] = deps.db.select({ n: sql<number>`count(*)` }).from(threads)
    .where(and(isNull(threads.parentThreadId), isNull(threads.originPluginId), imported.length ? notInArray(threads.id, imported) : undefined)).all();
  return row?.n ?? 0;
}

export async function activation(deps: AppDeps): Promise<{ steps: Record<ActivationStep, boolean>; second: "codex" | "claude-code"; started: number }> {
  const state = await load(deps);
  const cloud = eq(threads.executionTarget, "cloud");
  const providers = deps.db.selectDistinct({ id: threads.providerId }).from(threads).where(cloud).limit(3).all().map((row) => row.id);
  const found: ActivationStep[] = [];
  if (providers.length) found.push("cloud");
  if (providers.length > 1) found.push("second");
  if (!state.done.has("subagents")) {
    const child = deps.db.select({ id: threads.id }).from(threads).where(and(cloud, isNotNull(threads.parentThreadId))).limit(1).get();
    const [count] = deps.db.select({ n: sql<number>`count(*)` }).from(threads).where(cloud).all();
    if (child || (count?.n ?? 0) >= 3) found.push("subagents");
  }
  if (!state.done.has("loop")) {
    const run = deps.db.select({ id: threads.id }).from(threads).where(eq(threads.originPluginId, "automations")).limit(1).get();
    if (run) found.push("loop");
    else if (Date.now() - state.loopCheckedAt >= LOOP_CHECK_MS) {
      state.loopCheckedAt = Date.now();
      void cloudroom(deps).sandboxes.automations({ action: "list" })
        .then((listed) => (listed as { automations?: unknown[] } | null)?.automations?.length ? markDone(deps, state, ["loop"]) : undefined)
        .catch(() => {});
    }
  }
  await markDone(deps, state, found);
  return {
    steps: Object.fromEntries(ACTIVATION_STEPS.map((step) => [step, state.done.has(step)])) as Record<ActivationStep, boolean>,
    second: providers.includes("codex") && !providers.includes("claude-code") ? "claude-code" : "codex",
    started: await startedThreads(deps),
  };
}
