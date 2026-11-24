import { beforeEach, describe, expect, it } from "vitest";
import { LOOP_TEMPLATES } from "../templates.js";
import { agentFor, enablePlanLoops, planLoops, planLoopsEvent, planLoopsSchema, type PlanLoopsDeps } from "./plan-loops.js";

// Who sees the pop-up after buying a plan, and what one click turns on (docs/scopes/loops.md#after-buying-a-plan).
const T0 = Date.UTC(2026, 10, 21, 12), DAY = 86_400_000;
const ALL = ["security-sweep", "dependency-sweep", "side-effects-review"];
const NAMES = ["Security sweep", "Supply-chain security sweep", "Side effects review"];
const CLAUDE = { id: "claude-code", displayName: "Claude Code", available: true, reasoningLevels: [{ id: "max", label: "Max" }, { id: "xhigh", label: "XHigh" }] };
const CODEX = { id: "codex", displayName: "Codex", available: true, reasoningLevels: [{ id: "max", label: "Max" }] };
const PROJECTS = [
  { id: "proj_personal", name: "Personal", gitRemoteUrl: null, updatedAt: 9 },
  { id: "p_local", name: "notes", gitRemoteUrl: null, updatedAt: 8 },
  { id: "p_gitlab", name: "lab", gitRemoteUrl: "https://gitlab.com/a/lab", updatedAt: 7 },
  { id: "p_old", name: "old", gitRemoteUrl: "git@github.com:a/old", updatedAt: 1 },
  { id: "p_new", name: "app", gitRemoteUrl: "https://github.com/a/app", updatedAt: 5 },
];

function world() {
  const state = {
    plan: "free" as string | null, user: "u1", projects: PROJECTS, providers: [CLAUDE, CODEX] as unknown[], harnesses: [{ id: "claude-code" }, { id: "codex" }, { id: "pi" }] as { id: string }[] | undefined,
    defaults: null as { providerId: string; model: string; reasoningLevel: string } | null, cloud: [] as { name: string; thread_id: string; project_id?: string | null }[],
    local: {} as Record<string, string[]>, failCreate: null as string | null, failList: false,
    kv: new Map<string, unknown>(), created: [] as Record<string, unknown>[], tracked: [] as Record<string, unknown>[], lists: 0,
  };
  const deps = {
    kv: { get: async (key: string) => state.kv.get(key), set: async (key: string, value: unknown) => void state.kv.set(key, value) },
    service: { list: ({ projectId }: { projectId: string }) => (state.local[projectId] ?? []).map((name) => ({ name })) },
    track: (action: string, properties: object = {}) => state.tracked.push({ action, ...properties }),
    sdk: {
      cloudroom: {
        status: async () => ({ plan: state.plan, account: state.plan ? { id: state.user, email: "" } : null, ...(state.harnesses ? { harnesses: state.harnesses } : {}) }),
        automations: async (input: Record<string, unknown>) => {
          if (input.action !== "create") {
            state.lists += 1;
            if (state.failList) throw new Error("offline");
            return { automations: state.cloud };
          }
          if (input.name === state.failCreate) throw new Error("boom");
          state.created.push(input);
          state.cloud.push({ name: input.name as string, thread_id: input.project as string });
          return {};
        },
      },
      projects: { list: async () => state.projects, defaultExecutionOptions: async () => state.defaults },
      providers: { list: async () => state.providers },
    },
  } as unknown as PlanLoopsDeps;
  return { state, deps };
}

describe("the pop-up after buying a plan", () => {
  let state: ReturnType<typeof world>["state"], deps: PlanLoopsDeps;
  beforeEach(() => ({ state, deps } = world()));
  const upgrade = async (to = "pro") => {
    await planLoops(deps, T0);
    state.plan = to;
  };

  it("shows only after the plan went up on this computer", async () => {
    expect(await planLoops(deps, T0)).toBeNull();
    expect(await planLoops(deps, T0 + 1)).toBeNull();
    state.plan = "pro";
    const shown = planLoopsSchema.parse(await planLoops(deps, T0 + 2));
    expect(shown).toMatchObject({ account: "u1", plan: "pro", day: 1 });
    expect(shown.loops.map((loop) => [loop.id, loop.runsPerDay])).toEqual([["security-sweep", 12], ["dependency-sweep", 24], ["side-effects-review", 6]]);
    expect(state.lists).toBe(1);
  });

  it("never shows to an account that already paid, on Business, or signed out", async () => {
    for (const plan of ["super", "business", null]) {
      state.plan = plan;
      expect(await planLoops(deps, T0)).toBeNull();
      expect(await planLoops(deps, T0 + DAY)).toBeNull();
    }
    expect(state.lists).toBe(0);
  });

  it("offers only GitHub repos, the one worked on last first", async () => {
    await upgrade();
    expect((await planLoops(deps, T0))?.projects.map((project) => project.id)).toEqual(["p_new", "p_old"]);
  });

  it("waits for a GitHub repo without asking the website, then shows", async () => {
    state.projects = PROJECTS.slice(0, 3);
    await upgrade();
    expect(await planLoops(deps, T0)).toBeNull();
    expect(state.lists).toBe(0);
    state.projects = PROJECTS;
    expect(await planLoops(deps, T0 + DAY)).toMatchObject({ day: 2 });
  });

  it("stops after 7 days", async () => {
    await upgrade();
    expect(await planLoops(deps, T0)).toMatchObject({ day: 1 });
    expect(await planLoops(deps, T0 + 6 * DAY)).toMatchObject({ day: 7 });
    expect(await planLoops(deps, T0 + 7 * DAY + 1)).toBeNull();
  });

  it("throws when the loops can't be read, and shows on the next try", async () => {
    await upgrade();
    state.failList = true;
    await expect(planLoops(deps, T0)).rejects.toThrow("offline");
    state.failList = false;
    expect(await planLoops(deps, T0 + 1)).not.toBeNull();
  });

  it("marks the loops a repo already runs: Local, its own Cloud loops, and Cloud loops a thread hosts", async () => {
    state.local = { p_new: [NAMES[0]!] };
    state.cloud = [{ name: NAMES[1]!, thread_id: "thr_1", project_id: "p_new" }, { name: NAMES[2]!, thread_id: "p_old" }];
    await upgrade();
    expect((await planLoops(deps, T0))?.projects.map((project) => [project.id, project.on])).toEqual([["p_new", ALL.slice(0, 2)], ["p_old", ALL.slice(2)]]);
  });

  it("is over once every repo runs every loop", async () => {
    state.local = { p_new: NAMES, p_old: NAMES };
    await upgrade();
    expect(await planLoops(deps, T0)).toBeNull();
    state.local = {};
    expect(await planLoops(deps, T0 + 1)).toBeNull();
  });

  it("turns on the picked loops once, with the template's agent, and is answered", async () => {
    await upgrade();
    state.cloud = [{ name: NAMES[1]!, thread_id: "thr_1", project_id: "p_new" }];
    expect(await enablePlanLoops(deps, { projectId: "p_new", templates: ALL, timezone: "Europe/Warsaw" })).toEqual({ added: 2, failed: 0, error: null });
    expect(state.created.map((loop) => [loop.project, loop.name, loop.cron, loop.timezone, loop.harness, loop.model, loop.reasoning, loop.priority])).toEqual([
      ["p_new", NAMES[0], "0 */2 * * *", "Europe/Warsaw", "claude-code", "claude-opus-5-5", "max", 1],
      ["p_new", NAMES[2], "0 */4 * * *", "Europe/Warsaw", "codex", "gpt-6.1-sol", "max", 1],
    ]);
    expect(await planLoops(deps, T0 + 1)).toBeNull();
    expect(state.tracked).toEqual([{ action: "enabled", plan: "pro", added: 2, failed: 0 }]);
  });

  it("stays open when every loop failed, and refuses a Free plan", async () => {
    await expect(enablePlanLoops(deps, { projectId: "p_new", templates: ALL, timezone: "UTC" })).rejects.toThrow("paid plan");
    await upgrade();
    state.failCreate = NAMES[0]!;
    expect(await enablePlanLoops(deps, { projectId: "p_new", templates: ALL.slice(0, 1), timezone: "UTC" })).toEqual({ added: 0, failed: 1, error: "boom" });
    expect(await planLoops(deps, T0 + 1)).not.toBeNull();
  });

  it("ends for this plan when closed, and shows again after the next upgrade", async () => {
    await upgrade();
    await planLoopsEvent(deps, "viewed");
    expect(await planLoops(deps, T0 + 1)).not.toBeNull();
    await planLoopsEvent(deps, "later");
    expect(await planLoops(deps, T0 + 2)).toBeNull();
    state.plan = "free";
    expect(await planLoops(deps, T0 + 3)).toBeNull();
    state.plan = "ultra";
    expect(await planLoops(deps, T0 + 4)).toMatchObject({ plan: "ultra", day: 1 });
  });

  it("keeps each account's record apart", async () => {
    await upgrade();
    state.user = "u2";
    expect(await planLoops(deps, T0)).toBeNull();
    state.user = "u1";
    expect(await planLoops(deps, T0)).toMatchObject({ account: "u1" });
  });
});

describe("the agent a ticket's loop gets", () => {
  const [security] = LOOP_TEMPLATES, status = { harnesses: [{ id: "claude-code" }, { id: "hermes" }, { id: "pi" }] } as never;
  const pick = (providers: unknown[], defaults: unknown, cloud = status) => agentFor(security!, providers as never, defaults as never, cloud)?.providerId ?? null;
  const off = [{ ...CLAUDE, available: false }];

  it("is the template's own when it is set up here", () => {
    expect(pick([CLAUDE], { providerId: "acp-hermes-agent", model: "m", reasoningLevel: "high" })).toBe("claude-code");
  });
  it("is else the repo's default, only when Cloud runs it", () => {
    expect(pick(off, { providerId: "acp-hermes-agent", model: "m", reasoningLevel: "high" })).toBe("acp-hermes-agent");
    expect(pick(off, { providerId: "acp-antigravity", model: "m", reasoningLevel: "high" })).toBeNull();
    expect(pick(off, { providerId: "acp-antigravity", model: "m", reasoningLevel: "high" }, {} as never)).toBe("acp-antigravity");
    expect(pick(off, { providerId: "pi", model: "haiku", reasoningLevel: "high" })).toBeNull();
    expect(pick(off, { providerId: "pi", model: "anthropic/claude-haiku-5-5", reasoningLevel: "high" })).toBe("pi");
  });
  it("is none without either", () => expect(pick(off, null)).toBeNull());

  it("shows on the ticket and is sent on create, the same one", async () => {
    const { state, deps } = world();
    await planLoops(deps, T0);
    state.plan = "pro";
    state.providers = [off[0], CODEX];
    state.defaults = { providerId: "pi", model: "anthropic/claude-haiku-5-5", reasoningLevel: "high" };
    const shown = await planLoops(deps, T0);
    expect(shown?.projects[0]?.agents).toMatchObject({ "security-sweep": { providerId: "pi", model: "Haiku 5.5", level: "high" }, "side-effects-review": { providerId: "codex" } });
    expect(shown?.loops[0]?.needs).toBe("Claude Code");
    await enablePlanLoops(deps, { projectId: "p_new", templates: ["security-sweep"], timezone: "UTC" });
    expect(state.created[0]).toMatchObject({ harness: "pi", model: "anthropic/claude-haiku-5-5", reasoning: "high" });
    state.defaults = null;
    expect(await enablePlanLoops(deps, { projectId: "p_old", templates: ["security-sweep"], timezone: "UTC" })).toMatchObject({ added: 0, failed: 1, error: "Security sweep needs an agent that runs in the Cloud." });
  });
});
