import { PERSONAL_PROJECT_ID, reasoningLevelSchema, serviceTierSchema } from "@cloudroom/domain";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { KEEP_LEARNING, askFirst, learnedSchema, lessonsFor, lessonsText, type Learned } from "./src/learn.js";
import { RECENT_MS, pickThread } from "./src/pick.js";
import { DEFAULT_PING, DEFAULT_ROLE, INTRO, pingText, roleChange, titleOf } from "./src/prompt.js";

/** The app refetches when this fires. */
export const CHANGED = "changed";
/** How often the timer looks at the clock. */
const TICK_MS = 30_000;
/** The website is asked for the lessons at most this often; a change made on this computer comes back with its own answer. */
const SYNC_MS = 10 * 60_000;
/** The first ping comes soon after the timer is turned on, so the user sees it work. */
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
  /** Learn from the user's corrections, and ask before acting until the Director is taught. Lessons are saved with the Cloudroom account. */
  learning: z.boolean(),
  /** An app icon name, or an emoji. */
  icon: z.string().min(1).max(16),
  /** A CSS color; empty uses the app's accent. */
  color: z.string().max(64),
});
export type Config = z.infer<typeof configSchema>;

export const DEFAULTS: Config = {
  // Off until the user turns the timer on (David, 2026-11-22).
  ping: false,
  minutes: 60,
  role: DEFAULT_ROLE,
  prompt: DEFAULT_PING,
  agent: { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" },
  projectIds: null,
  watchLoops: false,
  learning: true,
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
  /** The thread the Director was last handed. `open`: it proposed and waits for the user's answer. */
  subject: z.object({ threadId: z.string(), title: z.string(), project: z.string(), at: z.number(), open: z.boolean() }).nullable().default(null),
});
type State = z.infer<typeof stateSchema>;
/** The website's answer, kept so a ping needs no network. It belongs to one account. */
const savedSchema = learnedSchema.extend({ account: z.string(), at: z.number() });

const viewSchema = z.object({
  config: configSchema,
  threadId: z.string().nullable(),
  nextAt: z.number(),
  last: stateSchema.shape.last,
  /** The Director wrote something the user has not opened yet. */
  unread: z.boolean(),
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
  defaults: z.object({ role: z.string(), prompt: z.string() }),
  /** What the Director learned, or null while the user is signed out of Cloudroom. */
  learned: learnedSchema.nullable(),
  /** It proposed something and waits for the user's answer. */
  waiting: z.boolean(),
});

export const directorRpc = defineRpcContract({
  get: { input: z.null(), output: viewSchema },
  save: { input: configSchema, output: viewSchema },
  /** The Director's thread, started first if there is none. */
  open: { input: z.null(), output: z.object({ threadId: z.string() }) },
  pingNow: { input: z.null(), output: viewSchema },
  /** Archive the Director's thread; the next ping or open starts a new one. */
  fresh: { input: z.null(), output: viewSchema },
  /** Delete one lesson. */
  forget: { input: z.object({ id: z.string().min(1).max(16) }), output: viewSchema },
  /** Stop waiting for an answer to the open proposal; nothing is counted. */
  skip: { input: z.null(), output: viewSchema },
});

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** `--name value` or `--name=value`; undefined when the flag is missing or has no value. */
function flag(args: string[], name: string): string | undefined {
  const joined = args.find((arg) => arg.startsWith(`--${name}=`));
  if (joined !== undefined) return joined.slice(name.length + 3);
  const value = args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined;
  return value?.startsWith("--") ? undefined : value;
}

export default async function directorPlugin(room: BbPluginApi): Promise<void> {
  const kv = room.storage.kv;
  let config = configSchema.catch(DEFAULTS).parse({ ...DEFAULTS, ...((await kv.get<object>("config")) ?? {}) });
  let state: State = stateSchema
    .catch({ threadId: null, role: null, seen: {}, nextAt: Date.now() + FIRST_PING_MS, last: null, subject: null })
    .parse(await kv.get<unknown>("state"));

  async function setState(change: Partial<State>): Promise<void> {
    state = { ...state, ...change };
    await kv.set("state", state);
    room.realtime.publish(CHANGED, { at: Date.now() });
  }

  // What the Director learned lives with the Cloudroom account (docs/scopes/director.md#learning).
  let saved = savedSchema.nullable().catch(null).parse((await kv.get<unknown>("learned")) ?? null);
  const account = async () => (await room.sdk.cloudroom.status().catch(() => null))?.account?.id ?? null;
  async function keep(answer: unknown, owner: string): Promise<Learned> {
    saved = { ...learnedSchema.parse(answer), account: owner, at: Date.now() };
    await kv.set("learned", saved);
    room.realtime.publish(CHANGED, { at: Date.now() });
    return saved;
  }
  /** The one read in flight, shared by every caller; a failed one is not tried again for a minute. */
  let reading: Promise<Learned> | null = null, failedAt = 0;
  /** The lessons and the meter, or null: learning is off, or nobody is signed in. An old copy answers at once while a
   *  fresh one is fetched; its answer redraws the app. Only the very first read is waited for. */
  async function learned(): Promise<Learned | null> {
    const owner = config.learning ? await account() : null;
    if (owner === null) return null;
    const mine = saved?.account === owner ? saved : null, now = Date.now();
    if (mine !== null && now - mine.at < SYNC_MS) return mine;
    if (reading === null && now - failedAt >= 60_000) {
      reading = room.sdk.cloudroom.director({ action: "read" }).then((answer) => keep(answer, owner));
      reading.catch(() => (failedAt = Date.now())).finally(() => (reading = null));
    }
    // Unreachable and never read: nothing taught, so it asks before it acts.
    const nothing = { reviewed: 0, approved: 0, goal: 50, lessons: [] };
    return mine ?? (reading ? reading.catch(() => nothing) : nothing);
  }
  /** Count an answered turn, save a lesson, or forget one. The website answers with the whole record. */
  async function teach(event: "approved" | "corrected" | "lesson" | "forget", lesson?: Record<string, unknown>): Promise<Learned> {
    const owner = config.learning ? await account() : null;
    if (owner === null) throw new Error(config.learning ? "Sign in to Cloudroom to teach the Director." : "Learning is off. Turn it on in the Director's settings.");
    return keep(await room.sdk.cloudroom.director({ action: "teach", event, ...(lesson ? { lesson } : {}) }), owner);
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
    // A new thread never saw the old proposal, so nothing waits for an answer.
    await setState({ threadId: spawned.id, role, subject: null });
    return spawned.id;
  }

  /** It proposed something and waits for the user's answer, for a day at most. A new Director thread never saw the
   *  proposal, and a failed turn may never have shown it, so neither waits. */
  const waiting = (known: Learned | null, live: { status: string } | null) =>
    known !== null && known.reviewed < known.goal && live !== null && live.status !== "error" && state.subject?.open === true && Date.now() - state.subject.at <= RECENT_MS;

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
        // Until the user answers a proposal, it asks about nothing else.
        const known = await learned(), teaching = known !== null && known.reviewed < known.goal;
        if (waiting(known, live)) return done(`Waiting for your answer on "${state.subject?.title}"`);
        const rows = await room.sdk.threads.list({ archived: false, hasParent: false, sort: "updated", limit: 300 });
        // Stops older than the window can't be picked again, so their marks go.
        const seen = Object.fromEntries(Object.entries(state.seen).filter(([, at]) => now - at <= RECENT_MS));
        const pick = pickThread(rows, { now, seen, projectIds: config.projectIds, watchLoops: config.watchLoops });
        if (pick === null) return done("Nothing new", { seen });
        const project = (await projects()).find(({ id }) => id === pick.projectId)?.name ?? "a project";
        const lessons = known === null ? "" : lessonsText(lessonsFor(known.lessons, { id: pick.id, project })) + (teaching ? askFirst(known.reviewed + 1, known.goal) : KEEP_LEARNING);
        await say(pingText(config.prompt, pick, project, now) + lessons);
        const subject = { threadId: pick.id, title: titleOf(pick), project, at: now, open: teaching };
        return done(`${teaching ? "Asked you about" : "Checked"} "${titleOf(pick)}"`, { subject, seen: { ...seen, [pick.id]: pick.latestAttentionAt } });
      });
    } catch (error) {
      room.log.warn(`Director ping failed: ${message(error)}`);
      await done(`Ping failed: ${message(error)}`);
    } finally {
      pinging = false;
    }
  }

  async function view(): Promise<z.infer<typeof viewSchema>> {
    const [live, all, known] = await Promise.all([director(), projects().catch(() => []), learned()]);
    return {
      config,
      threadId: live?.id ?? null,
      nextAt: state.nextAt,
      last: state.last,
      unread: live !== null && (live.status === "idle" || live.status === "error") && (live.lastReadAt ?? 0) < live.latestAttentionAt,
      projects: all.map(({ id, name }) => ({ id, name })),
      defaults: { role: DEFAULT_ROLE, prompt: DEFAULT_PING },
      learned: known,
      waiting: waiting(known, live),
    };
  }

  async function apply(next: Config): Promise<void> {
      const sooner = Date.now() + next.minutes * 60_000;
      const turnedOn = next.ping && !config.ping;
      config = next;
      // The default role and ping message are not stored, so a better default reaches everyone who never edited theirs.
      const { role, prompt, ...rest } = config;
      await kv.set("config", { ...rest, ...(role === DEFAULT_ROLE ? {} : { role }), ...(prompt === DEFAULT_PING ? {} : { prompt }) });
      // Turning the timer on pings soon. A shorter interval applies now, not after the old one runs out.
      await setState({ nextAt: turnedOn ? Date.now() + FIRST_PING_MS : Math.min(state.nextAt, sooner) });
  }
  const open = () => inTurn(async () => ({ threadId: (await director())?.id ?? (await say(INTRO)) }));
  const fresh = () =>
    inTurn(async () => {
      if (state.threadId !== null) await room.sdk.threads.archive({ threadId: state.threadId }).catch(() => {});
      await setState({ threadId: null, subject: null });
    });
  const count = (lessons: unknown[]) => `${lessons.length} lesson${lessons.length === 1 ? "" : "s"}`;
  /** The Director records the user's answer to its proposal, or a correction given at any time. Runs one at a time with
   *  pings, so the thread it names is the one the last ping handed over. */
  const learn = (step: string, args: string[]) => inTurn(() => answer(step, args));
  async function answer(step: string, args: string[]): Promise<string> {
    const subject = state.subject;
    if (step === "forget") {
      await teach("forget", { id: args[0] ?? "" });
      return "Forgotten.";
    }
    if (step === "skip") {
      if (subject?.open) await setState({ subject: { ...subject, open: false } });
      return "Skipped. Nothing was counted.";
    }
    if (step === "approve") {
      if (!subject?.open) throw new Error("No proposal is waiting for an answer, so there is nothing to approve.");
      const known = await teach("approved");
      await setState({ subject: { ...subject, open: false } });
      return `Counted: ${known.reviewed} of ${known.goal} turns taught.`;
    }
    if (step !== "correct") throw new Error("Use approve, correct, skip or forget.");
    const scope = flag(args, "scope") ?? "thread", words = flag(args, "words");
    if (scope !== "general" && scope !== "project" && scope !== "thread") throw new Error("--scope is thread, project or general.");
    if (!words?.trim()) throw new Error('Give the user\'s exact words: --words "<their words>".');
    // The place comes from the thread the ping named, never from the caller.
    const target = scope === "general" ? null : scope === "project" ? subject?.project : subject?.threadId;
    if (target === undefined) throw new Error("No ping named a thread yet, so only --scope general can be saved.");
    const known = await teach(subject?.open ? "corrected" : "lesson", { scope, target, words, meaning: flag(args, "meaning") ?? "" });
    if (subject?.open) await setState({ subject: { ...subject, open: false } });
    const place = scope === "general" ? "for every thread" : scope === "project" ? `for project "${subject?.project}"` : `for thread "${subject?.title}"`;
    return `Saved ${place}. ${count(known.lessons)}, ${known.reviewed} of ${known.goal} turns taught.`;
  }

  room.rpc.register(directorRpc, {
    get: view,
    async save(next) {
      await apply(next);
      return view();
    },
    open,
    async pingNow() {
      await ping();
      return view();
    },
    async fresh() {
      await fresh();
      return view();
    },
    async forget({ id }) {
      await teach("forget", { id });
      return view();
    },
    async skip() {
      await learn("skip", []);
      return view();
    },
  });

  // Every setting is also a `room-cli director set` away, so agents and scripts can configure it.
  const onOff = (value: string) => ({ on: true, off: false })[value];
  const orDefault = (value: string, fallback: string) => (value === "default" ? fallback : value);
  const SETTINGS: Record<string, (value: string) => Partial<Config>> = {
    ping: (value) => ({ ping: onOff(value) as boolean }),
    minutes: (value) => ({ minutes: Number(value) }),
    // A model belongs to one harness, so a new harness needs its model too.
    provider: (value) => {
      const [providerId = "", model = ""] = value.split(/\s+/);
      return { agent: { ...config.agent, providerId, model } };
    },
    model: (model) => ({ agent: { ...config.agent, model } }),
    effort: (value) => ({ agent: { ...config.agent, reasoningLevel: value as Config["agent"]["reasoningLevel"] } }),
    tier: (value) => ({ agent: { ...config.agent, serviceTier: value as Config["agent"]["serviceTier"] } }),
    projects: (value) => ({ projectIds: value === "all" ? null : value.split(",") }),
    loops: (value) => ({ watchLoops: onOff(value) as boolean }),
    learning: (value) => ({ learning: onOff(value) as boolean }),
    icon: (icon) => ({ icon }),
    color: (value) => ({ color: orDefault(value, "") }),
    role: (value) => ({ role: orDefault(value, DEFAULT_ROLE) }),
    prompt: (value) => ({ prompt: orDefault(value, DEFAULT_PING) }),
  };
  const USAGE = `Usage:
  room-cli director [status] [--json]          Show the settings and the last ping
  room-cli director set <setting> <value>      Change one setting
  room-cli director ping                       Ping now
  room-cli director open                       Print the Director's thread ID, starting it if needed
  room-cli director new                        Archive its thread; the next ping starts a new one
  room-cli director lessons [--json]           Show what it learned from you
  room-cli director learn approve|skip         Answer its proposal (the Director runs these for you)
  room-cli director learn correct --scope thread|project|general --words <your words> [--meaning <its reading>]
  room-cli director learn forget <lesson-id>   Delete one lesson
Settings:
  ping on|off · minutes 5-1440 · provider <id> <model> · model <id> · effort <level> · tier default|fast|ultrafast
  projects all|<id,id> · loops on|off · learning on|off · icon <name or emoji> · color <CSS color|default>
  role <text|default> · prompt <text|default>
`;
  room.cli.register({
    name: "director",
    summary: "Configure and run the Director",
    commands: [
      { name: "status", summary: "Show the settings and the last ping", usage: "room-cli director [status] [--json]" },
      { name: "set", summary: "Change one setting", usage: "room-cli director set <setting> <value>" },
      { name: "ping", summary: "Ping now", usage: "room-cli director ping" },
      { name: "open", summary: "Print the Director's thread ID, starting it if needed", usage: "room-cli director open" },
      { name: "new", summary: "Archive the Director's thread", usage: "room-cli director new" },
      { name: "lessons", summary: "Show what the Director learned from you", usage: "room-cli director lessons [--json]" },
      { name: "learn", summary: "Answer a proposal, save a correction, or forget a lesson", usage: "room-cli director learn approve|correct|skip|forget" },
    ],
    async run(argv, context) {
      const [command = "status", key = "", ...rest] = argv.filter((arg) => arg !== "--json");
      const status = async () => {
        const { config: settings, threadId, nextAt, last, learned: known } = await view();
        if (argv.includes("--json")) return { exitCode: 0, stdout: `${JSON.stringify({ ...settings, threadId, nextAt, last, learned: known }, null, 2)}\n` };
        const { agent, role, prompt, ...plain } = settings;
        const lines = Object.entries({ ...plain, provider: agent.providerId, model: agent.model, effort: agent.reasoningLevel, tier: agent.serviceTier ?? "default", projects: plain.projectIds?.join(",") ?? "all", loops: plain.watchLoops }).filter(([name]) => name !== "projectIds" && name !== "watchLoops");
        const text = [...lines.map(([name, value]) => `${name}: ${typeof value === "boolean" ? (value ? "on" : "off") : value || "default"}`), `role: ${role === DEFAULT_ROLE ? "default" : "custom"}`, `prompt: ${prompt === DEFAULT_PING ? "default" : prompt}`, `thread: ${threadId ?? "none"}`, `last ping: ${last?.text ?? "none"}`, `taught: ${known ? `${Math.min(known.reviewed, known.goal)} of ${known.goal} turns, ${count(known.lessons)}` : settings.learning ? "sign in to Cloudroom to teach it" : "off"}`];
        return { exitCode: 0, stdout: `${text.join("\n")}\n` };
      };
      if (command === "--help" || command === "-h" || command === "help") return { exitCode: 0, stdout: USAGE };
      if (command === "status") return status();
      if (command === "lessons") {
        const known = await learned();
        if (argv.includes("--json")) return { exitCode: 0, stdout: `${JSON.stringify(known, null, 2)}\n` };
        if (known === null) return { exitCode: 0, stdout: config.learning ? "Sign in to Cloudroom to teach the Director.\n" : "Learning is off.\n" };
        const lines = known.lessons.map((lesson) => `${lesson.id}  ${lesson.scope}${lesson.target ? ` ${lesson.target}` : ""}  "${lesson.words}"`);
        return { exitCode: 0, stdout: `${Math.min(known.reviewed, known.goal)} of ${known.goal} turns taught, ${known.approved} right first time\n${lines.join("\n") || "No lessons yet."}\n` };
      }
      if (command === "learn") {
        // Another agent's thread never teaches the Director: only its own thread, or the user in a terminal.
        if (context.threadId && context.threadId !== state.threadId) return { exitCode: 1, stderr: "Only the Director's own thread can teach it.\n" };
        return learn(key, rest).then((stdout) => ({ exitCode: 0, stdout: `${stdout}\n` }), (error: unknown) => ({ exitCode: 1, stderr: `${message(error)}\n` }));
      }
      // Its own thread reads other threads' logs, so a prompt injection there must not rewrite its settings.
      if (command === "set" && context.threadId && context.threadId === state.threadId) return { exitCode: 1, stderr: "The Director can't change its own settings. Ask the user to.\n" };
      if (command === "ping") await ping();
      else if (command === "new") await fresh();
      else if (command === "open") return { exitCode: 0, stdout: `${(await open()).threadId}\n` };
      else if (command === "set" && SETTINGS[key] && rest.length > 0) {
        const next = configSchema.safeParse({ ...config, ...SETTINGS[key](rest.join(" ")) });
        if (!next.success) return { exitCode: 2, stderr: `Not a valid value for ${key}.\n${USAGE}` };
        await apply(next.data);
      } else return { exitCode: 2, stderr: USAGE };
      return status();
    },
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
