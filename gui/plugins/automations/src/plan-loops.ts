import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { formatModelName, PERSONAL_PROJECT_ID } from "../lib/format-schedule.js";
import { LOOP_TEMPLATES, type LoopTemplate } from "../templates.js";
import { forgetCloud } from "./paused.js";
import type { AutomationService } from "./service.js";
import { runsBetween } from "./usage.js";

// The pop-up a new buyer sees when they come back to the app (docs/scopes/loops.md#after-buying-a-plan): "You're on
// Pro!" and the Essential templates as tickets, turned on in the Cloud with one click.
// This computer decides who sees it: it remembers each account's plan, and a higher plan than last time is a
// purchase. The first look only notes the plan, so accounts that paid before this version never see the pop-up.
// It shows for 7 days after the purchase, until it is answered, and only while a GitHub repo still lacks a loop.

export type PlanLoopsDeps = {
  sdk: Pick<BbPluginApi["sdk"], "cloudroom" | "projects" | "providers">;
  kv: BbPluginApi["storage"]["kv"];
  service: Pick<AutomationService, "list">;
  track: (action: "viewed" | "enabled" | "later" | "closed", properties?: Record<string, string | number>) => void;
};

const RANK: Record<string, number> = { free: 0, pro: 1, super: 2, ultra: 3 };
const DAY = 86_400_000;
const SHOW_DAYS = 7;
/** The pop-up's loops: three Essential templates that only read and report. The list is fixed, so a new Essential
 *  template (one that merges or edits, say) never joins a one-click bundle by itself. */
const TICKETS = ["security-sweep", "dependency-sweep", "side-effects-review"];
const ESSENTIAL = TICKETS.flatMap((id) => LOOP_TEMPLATES.filter((template) => template.id === id && !template.localOnly));
/** A Cloud loop needs a GitHub repo: the same rule as `githubRepository` in the app's server (project-copy.ts). */
const GITHUB = /^(?:https:\/\/github\.com\/|git@github\.com:)[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/?$/u;
type Seen = { plan: string; upgradedAt?: number; answered?: string };
const seenKey = (account: string) => `planLoops.${account}`;

const agentSchema = z.object({ providerId: z.string(), model: z.string(), level: z.string() }).strict();
export const planLoopsSchema = z
  .object({
    /** The account, so the app never shows one account's pop-up to another. */
    account: z.string(),
    plan: z.string(),
    /** Days since the purchase, from 1. */
    day: z.number(),
    /** `needs`: the name of the template's own agent, shown when a repo has no agent that can run the loop. */
    loops: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), runsPerDay: z.number(), needs: z.string() }).strict()),
    /** GitHub repos to run on, the best guess first. `on`: the loops it already runs. `agents`: the agent each loop
     *  would get there, by template ID; null when none can run it. */
    projects: z.array(z.object({ id: z.string(), name: z.string(), on: z.array(z.string()), agents: z.record(z.string(), agentSchema.nullable()) }).strict()),
  })
  .strict();
export type PlanLoops = z.output<typeof planLoopsSchema>;
export const planLoopsEnableInputSchema = z.object({ projectId: z.string().min(1), templates: z.array(z.string()).min(1).max(10), timezone: z.string().min(1) }).strict();
export const planLoopsEnableOutputSchema = z.object({ added: z.number(), failed: z.number(), error: z.string().nullable() }).strict();
export const planLoopsEventInputSchema = z.object({ event: z.enum(["viewed", "later", "closed"]) }).strict();

type Status = Awaited<ReturnType<PlanLoopsDeps["sdk"]["cloudroom"]["status"]>>;
type Providers = Awaited<ReturnType<PlanLoopsDeps["sdk"]["providers"]["list"]>>;
type Defaults = Awaited<ReturnType<PlanLoopsDeps["sdk"]["projects"]["defaultExecutionOptions"]>>;
type Agent = Pick<LoopTemplate, "providerId" | "model" | "reasoningLevel">;
type CloudLoop = { name: string; thread_id: string; project_id?: string | null };

/** The account and its plan, and what this computer remembers of it. Null: signed out, or a plan with no pop-up. */
async function account(deps: PlanLoopsDeps) {
  const status = await deps.sdk.cloudroom.status().catch(() => null);
  const plan = status?.plan, id = status?.account?.id;
  if (!status || !plan || !id || !Object.hasOwn(RANK, plan)) return null;
  const seen = await deps.kv.get<Seen>(seenKey(id)).then((value) => value ?? null, () => undefined);
  return seen === undefined ? null : { id, plan, seen, status };
}
type Account = NonNullable<Awaited<ReturnType<typeof account>>>;
const answer = (deps: PlanLoopsDeps, mine: Account) => deps.kv.set(seenKey(mine.id), { ...mine.seen, plan: mine.plan, answered: mine.plan });

/** The names of the loops a repo already runs, Cloud and Local. A loop made from a template keeps its name. A Cloud
 *  loop's repo is its home (ADR 20261101-004659) or, for one a thread hosts, that thread's project. */
const running = (deps: PlanLoopsDeps, cloud: CloudLoop[], projectId: string) =>
  new Set([...cloud.filter((loop) => loop.thread_id === projectId || loop.project_id === projectId).map((loop) => loop.name), ...deps.service.list({ projectId }).map((loop) => loop.name)]);

/** Whether Cloud runs this agent. The status lists what Cloud offers, named without the app's "acp-" prefix; the
 *  SDK's type leaves the list out. Unknown (a new account before its first sandbox): the sandbox decides. */
const harnessesSchema = z.object({ harnesses: z.array(z.object({ id: z.string() })) });
function inCloud(status: Status, providerId: string): boolean {
  const offered = harnessesSchema.safeParse(status);
  return !offered.success || offered.data.harnesses.some((harness) => providerId === harness.id || providerId.startsWith(`acp-${harness.id}`));
}

/** The agent a template's loop gets on a repo: the template's own when it is set up here, else the repo's default
 *  agent when Cloud can run it (Pi needs a `provider/model`). Null: none can. The ticket and the loop both use this. */
export function agentFor(template: LoopTemplate, providers: Providers, defaults: Defaults, status: Status): Agent | null {
  if (providers.some((provider) => provider.id === template.providerId && provider.available)) return template;
  if (!defaults || !inCloud(status, defaults.providerId) || (defaults.providerId === "pi" && !/^[^/]+\/.+/u.test(defaults.model))) return null;
  return defaults;
}

/** What the pop-up shows, or null when it should not show. Cheap while it stays hidden: no website call.
 *  A failed read throws, so the app asks again instead of taking it as "nothing to show". */
export async function planLoops(deps: PlanLoopsDeps, now = Date.now()): Promise<PlanLoops | null> {
  const mine = await account(deps);
  if (!mine) return null;
  const { plan } = mine;
  let seen = mine.seen;
  if (!seen || seen.plan !== plan) {
    seen = seen && RANK[plan] > (RANK[seen.plan] ?? 0) ? { plan, upgradedAt: now } : { plan };
    await deps.kv.set(seenKey(mine.id), seen);
  }
  if (!seen.upgradedAt || now - seen.upgradedAt > SHOW_DAYS * DAY || seen.answered === plan) return null;
  // No GitHub repo yet: nothing to offer now. It is asked again, so the pop-up shows once one is added.
  const repos = (await deps.sdk.projects.list())
    .filter((project) => project.id !== PERSONAL_PROJECT_ID && GITHUB.test(project.gitRemoteUrl ?? ""))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (repos.length === 0) return null;
  const [cloud, providers] = await Promise.all([deps.sdk.cloudroom.automations({ action: "list" }), deps.sdk.providers.list().catch(() => [])]);
  const own = ESSENTIAL.every((template) => agentFor(template, providers, null, mine.status));
  const projects = await Promise.all(
    repos.map(async (project) => {
      const names = running(deps, cloud.automations ?? [], project.id);
      // The repo's default agent matters only when a template's own agent is not set up here.
      const defaults = own ? null : await deps.sdk.projects.defaultExecutionOptions({ projectId: project.id }).catch(() => null);
      return {
        id: project.id,
        name: project.name,
        on: ESSENTIAL.filter((template) => names.has(template.name)).map((template) => template.id),
        agents: Object.fromEntries(ESSENTIAL.map((template) => {
          const agent = agentFor(template, providers, defaults, mine.status);
          const levels = providers.find((provider) => provider.id === agent?.providerId)?.reasoningLevels;
          return [template.id, agent && { providerId: agent.providerId, model: formatModelName(agent.model), level: levels?.find((level) => level.id === agent.reasoningLevel)?.label ?? agent.reasoningLevel }];
        })),
      };
    }),
  );
  const open = projects.filter((project) => project.on.length < ESSENTIAL.length);
  // Every repo already runs every loop: there is nothing to offer, so it is over for this plan.
  if (open.length === 0) {
    await answer(deps, { ...mine, seen });
    return null;
  }
  return {
    account: mine.id,
    plan,
    day: Math.floor((now - seen.upgradedAt) / DAY) + 1,
    loops: ESSENTIAL.map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description.split(". ")[0]!.replace(/\.?$/u, "."),
      // In UTC, so a day the clocks change still counts 24 hours.
      runsPerDay: runsBetween(template.cron, "UTC", now, now + DAY),
      needs: providers.find((provider) => provider.id === template.providerId)?.displayName ?? template.providerId,
    })),
    projects: [...open, ...projects.filter((project) => !open.includes(project))],
  };
}

/** Turns the picked loops on in the Cloud for one repo, like the Templates tab does. Loops the repo already runs are
 *  skipped. A loop with no agent that can run it counts as failed. */
export async function enablePlanLoops(deps: PlanLoopsDeps, input: z.output<typeof planLoopsEnableInputSchema>): Promise<z.output<typeof planLoopsEnableOutputSchema>> {
  const mine = await account(deps);
  if (!mine || mine.plan === "free") throw new Error("Loop templates need a paid plan.");
  const [cloud, providers, defaults] = await Promise.all([
    deps.sdk.cloudroom.automations({ action: "list" }),
    deps.sdk.providers.list().catch(() => []),
    deps.sdk.projects.defaultExecutionOptions({ projectId: input.projectId }).catch(() => null),
  ]);
  const names = running(deps, cloud.automations ?? [], input.projectId);
  const todo = ESSENTIAL.filter((template) => input.templates.includes(template.id) && !names.has(template.name));
  const results = await Promise.allSettled(
    todo.map(async (template) => {
      const agent = agentFor(template, providers, defaults, mine.status);
      if (!agent) throw new Error(`${template.name} needs an agent that runs in the Cloud.`);
      return deps.sdk.cloudroom.automations({
        action: "create", project: input.projectId, name: template.name, prompt: template.prompt, cron: template.cron, timezone: input.timezone,
        harness: agent.providerId, model: agent.model, reasoning: agent.reasoningLevel, priority: template.priority,
      });
    }),
  );
  forgetCloud();
  const failed = results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
  const added = results.length - failed.length;
  // The pop-up is done once a loop is on, or there was nothing left to add. When every one failed it stays, to try again.
  if (added > 0 || todo.length === 0) await answer(deps, mine);
  deps.track("enabled", { plan: mine.plan, added, failed: failed.length });
  return { added, failed: failed.length, error: failed[0] === undefined ? null : failed[0] instanceof Error ? failed[0].message : String(failed[0]) };
}

/** The pop-up showed, or was closed without turning anything on. Closing ends it for this plan. */
export async function planLoopsEvent(deps: PlanLoopsDeps, event: z.output<typeof planLoopsEventInputSchema>["event"]): Promise<null> {
  const mine = await account(deps);
  if (!mine) return null;
  if (event !== "viewed") await answer(deps, mine);
  deps.track(event, { plan: mine.plan });
  return null;
}
