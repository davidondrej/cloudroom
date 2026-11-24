import { PERSONAL_PROJECT_ID, reasoningLevelSchema, serviceTierSchema } from "@cloudroom/domain";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { RECENT_MS, pickThread } from "./src/pick.js";
import { DEFAULT_PING, DEFAULT_ROLE, INTRO, pingText, roleChange, titleOf } from "./src/prompt.js";

/** The app refetches when this fires. */
export const CHANGED = "changed";
/** How often the timer looks at the clock. */
const TICK_MS = 30_000;
/** The first ping comes soon after the plugin is turned on, so the user sees it work. */
const FIRST_PING_MS = 60_000;

export const configSchema = z.object({
  ping: z.boolean(),
  minutes: z.number().int().min(5).max(24 * 60),
  /** The Director's role, added to its system prompt. */
  role: z.string().min(1).max(4096),
  /** What each ping asks. */
  prompt: z.string().min(1).max(2000),
  agent: z.object({
    providerId: z.string().min(1),
    model: z.string().min(1),
    reasoningLevel: reasoningLevelSchema,
    serviceTier: serviceTierSchema.optional(),
  }),
  /** null watches every project. */
  projectIds: z.array(z.string().min(1)).max(500).nullable(),
  watchLoops: z.boolean(),
  /** An app icon name, or an emoji. */
  icon: z.string().min(1).max(16),
  /** A CSS color; empty uses the app's accent. */
  color: z.string().max(64),
});
export type Config = z.infer<typeof configSchema>;

export const DEFAULTS: Config = {
  ping: true,
  minutes: 60,
  role: DEFAULT_ROLE,
  prompt: DEFAULT_PING,
  agent: { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" },
  projectIds: null,
  watchLoops: false,
  icon: "Target",
  color: "",
};

const stateSchema = z.object({
  threadId: z.string().nullable(),
  /** The role the Director's thread last got, so an edited one is sent again. */
  role: z.string().nullable().default(null),
  /** Each watched thread's `latestAttentionAt` when the Director last looked at it. */
  seen: z.record(z.string(), z.number()),
  nextAt: z.number(),
  last: z.object({ at: z.number(), text: z.string() }).nullable(),
});
type State = z.infer<typeof stateSchema>;

const viewSchema = z.object({
  config: configSchema,
  threadId: z.string().nullable(),
  nextAt: z.number(),
  last: stateSchema.shape.last,
  /** The Director wrote something the user has not opened yet. */
  unread: z.boolean(),
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
  defaults: z.object({ role: z.string(), prompt: z.string() }),
});

export const directorRpc = defineRpcContract({
  get: { input: z.null(), output: viewSchema },
  save: { input: configSchema, output: viewSchema },
  /** The Director's thread, started first if there is none. */
  open: { input: z.null(), output: z.object({ threadId: z.string() }) },
  pingNow: { input: z.null(), output: viewSchema },
  /** Archive the Director's thread; the next ping or open starts a new one. */
  fresh: { input: z.null(), output: viewSchema },
});

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default async function directorPlugin(room: BbPluginApi): Promise<void> {
  const kv = room.storage.kv;
  let config = configSchema.catch(DEFAULTS).parse({ ...DEFAULTS, ...((await kv.get<object>("config")) ?? {}) });
  let state: State = stateSchema
    .catch({ threadId: null, role: null, seen: {}, nextAt: Date.now() + FIRST_PING_MS, last: null })
    .parse(await kv.get<unknown>("state"));

  async function setState(change: Partial<State>): Promise<void> {
    state = { ...state, ...change };
    await kv.set("state", state);
    room.realtime.publish(CHANGED, { at: Date.now() });
  }

  // Only the Director's own thread gets the role.
  room.agents.configure(({ pluginMetadata }) => ({
    tools: [],
    skills: [],
    ...(pluginMetadata.role === "director" ? { instructions: config.role } : {}),
  }));

  /** The Director's thread, or null when it is gone or runs on another harness than the settings say. */
  async function director() {
    if (state.threadId === null) return null;
    const thread = await room.sdk.threads.get({ threadId: state.threadId }).catch(() => null);
    const live = thread !== null && thread.archivedAt === null && thread.deletedAt === null;
    return live && thread.providerId === config.agent.providerId ? thread : null;
  }

  /** Starting, pinging and replacing the Director's thread run one at a time, so there is never a second, lost thread. */
  let turn: Promise<unknown> = Promise.resolve();
  function inTurn<T>(job: () => Promise<T>): Promise<T> {
    const run = turn.then(job, job);
    turn = run.catch(() => {});
    return run;
  }

  /** Send to the Director's thread, starting it first if there is none. Call it inside `inTurn`. */
  async function say(text: string): Promise<string> {
    const { model, reasoningLevel, serviceTier } = config.agent;
    const { role } = config;
    const live = await director();
    if (live !== null) {
      const input = state.role === role ? text : roleChange(role) + text;
      await room.sdk.threads.send({ threadId: live.id, mode: "auto", model, reasoningLevel, serviceTier, input: [{ type: "text", text: input, mentions: [] }] });
      if (state.role !== role) await setState({ role });
      return live.id;
    }
    if (state.threadId !== null) await room.sdk.threads.archive({ threadId: state.threadId }).catch(() => {});
    const spawned = await room.sdk.threads.spawn({
      projectId: PERSONAL_PROJECT_ID,
      executionTarget: "local",
      environment: { type: "project-default" },
      ...config.agent,
      // It reads and messages threads with room-cli; a permission prompt would stop every ping.
      permissionMode: "full",
      // Hidden from the thread lists: the sidebar row is its only door.
      visibility: "hidden",
      title: "Director",
      pluginMetadata: { role: "director" },
      prompt: text,
    });
    await setState({ threadId: spawned.id, role });
    return spawned.id;
  }

  /** Every project, the Personal one included. */
  const projects = () => room.sdk.projects.list({ includePersonal: true });

  let pinging = false;
  /** One ping: pick one thread that stopped since the Director last looked, and hand it over. No pick, no model turn. */
  async function ping(): Promise<void> {
    if (pinging) return;
    pinging = true;
    const now = Date.now();
    const done = (text: string, change: Partial<State> = {}) =>
      setState({ ...change, nextAt: now + config.minutes * 60_000, last: { at: now, text } });
    try {
      await inTurn(async () => {
        const live = await director();
        if (live !== null && live.status !== "idle" && live.status !== "error") {
          return done("Skipped: the Director was still working");
        }
        const rows = await room.sdk.threads.list({ archived: false, hasParent: false, sort: "updated", limit: 300 });
        // Stops older than the window can't be picked again, so their marks go.
        const seen = Object.fromEntries(Object.entries(state.seen).filter(([, at]) => now - at <= RECENT_MS));
        const pick = pickThread(rows, { now, seen, projectIds: config.projectIds, watchLoops: config.watchLoops });
        if (pick === null) return done("Nothing new", { seen });
        const project = (await projects()).find(({ id }) => id === pick.projectId)?.name ?? "a project";
        await say(pingText(config.prompt, pick, project, now));
        return done(`Checked "${titleOf(pick)}"`, { seen: { ...seen, [pick.id]: pick.latestAttentionAt } });
      });
    } catch (error) {
      room.log.warn(`Director ping failed: ${message(error)}`);
      await done(`Ping failed: ${message(error)}`);
    } finally {
      pinging = false;
    }
  }

  async function view(): Promise<z.infer<typeof viewSchema>> {
    const [live, all] = await Promise.all([director(), projects().catch(() => [])]);
    return {
      config,
      threadId: live?.id ?? null,
      nextAt: state.nextAt,
      last: state.last,
      unread: live !== null && (live.status === "idle" || live.status === "error") && (live.lastReadAt ?? 0) < live.latestAttentionAt,
      projects: all.map(({ id, name }) => ({ id, name })),
      defaults: { role: DEFAULT_ROLE, prompt: DEFAULT_PING },
    };
  }

  room.rpc.register(directorRpc, {
    get: view,
    async save(next) {
      const sooner = Date.now() + next.minutes * 60_000;
      config = next;
      // The default role and ping message are not stored, so a better default reaches everyone who never edited theirs.
      const { role, prompt, ...rest } = config;
      await kv.set("config", { ...rest, ...(role === DEFAULT_ROLE ? {} : { role }), ...(prompt === DEFAULT_PING ? {} : { prompt }) });
      // A shorter interval applies now, not after the old one runs out.
      await setState({ nextAt: Math.min(state.nextAt, sooner) });
      return view();
    },
    open: () => inTurn(async () => ({ threadId: (await director())?.id ?? (await say(INTRO)) })),
    async pingNow() {
      await ping();
      return view();
    },
    fresh: () =>
      inTurn(async () => {
        if (state.threadId !== null) await room.sdk.threads.archive({ threadId: state.threadId }).catch(() => {});
        await setState({ threadId: null });
        return view();
      }),
  });

  // The row's unread dot follows the Director ending a turn, finished or failed.
  for (const event of ["thread.idle", "thread.failed"] as const) {
    room.events.on(event, ({ thread }) => {
      if (thread.id === state.threadId) room.realtime.publish(CHANGED, { at: Date.now() });
    });
  }

  room.background.service("ping", {
    async start(signal) {
      const timer = setInterval(() => {
        if (config.ping && Date.now() >= state.nextAt) void ping();
      }, TICK_MS);
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      clearInterval(timer);
    },
  });
}
