import { randomUUID } from "node:crypto";
import { PERSONAL_PROJECT_ID, reasoningLevelSchema, serviceTierSchema } from "@cloudroom/domain";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { KEEP_LEARNING, LEARNING_MODE, askFirst, learnedSchema, lessonsFor, lessonsText, type Learned } from "./src/learn.js";
import { HOMES, checkModel, modelCheckSchema, type Listed } from "./src/models.js";
import { RECENT_MS, pickThreads } from "./src/pick.js";
import { DEFAULT_PING, DEFAULT_ROLE, INTRO, WELCOME_ONLY, WELCOME_THEN, pingText, roleChange, titleOf, welcome } from "./src/prompt.js";
import { MAX_SCAN_LESSONS, MAX_STORED_SCANS, buildScanDigest, parseScanProposal, scanPrompt, scansMapSchema, type ScanRecord } from "./src/scan.js";

/** The app refetches when this fires. */
export const CHANGED = "changed";
/** How often the timer looks at the clock. */
const TICK_MS = 5_000;
/** The website is asked for the lessons at most this often; a change made on this computer comes back with its own answer. */
const SYNC_MS = 10 * 60_000;
/** The first ping comes soon after the timer is turned on, so the user sees it work. */
const FIRST_PING_MS = 60_000;
/** A harness's model list is read again at most this often. */
const MODELS_MS = 10 * 60_000;

export const configSchema = z.object({
  ping: z.boolean(),
  minutes: z.number().int().min(1).max(24 * 60),
  /** Max stopped threads the Director can check and unblock in one ping (learning mode stays at 1). */
  maxThreads: z.number().int().min(1).max(20),
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
  /** Automatically compact the Director's thread once context usage reaches `autoCompactPercent`. */
  autoCompact: z.boolean(),
  /** Context usage percentage (30–95) that triggers automatic compaction of the Director's thread. */
  autoCompactPercent: z.number().int().min(30).max(95),
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
  maxThreads: 5,
  role: DEFAULT_ROLE,
  prompt: DEFAULT_PING,
  agent: { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" },
  projectIds: null,
  watchLoops: false,
  learning: true,
  // Auto-compact on by default at 50%, configurable 30–95% (David, 2026-11-28).
  autoCompact: true,
  autoCompactPercent: 50,
  // The Director's own star-and-chevrons icon, in violet (David, 2026-11-27).
  icon: "Rank",
  color: "#a78bfa",
};

const compactStateSchema = z.object({
  threadId: z.string(),
  attentionAt: z.number(),
  pending: z.boolean(),
  wasRead: z.boolean().default(false),
  failures: z.number().int().nonnegative().default(0),
  failedAttentionAt: z.number().nullable().default(null),
});

const stateSchema = z.object({
  threadId: z.string().nullable(),
  /** The role the Director's thread last got, so an edited one is sent again. */
  role: z.string().nullable().default(null),
  /** The role baked into the thread's system prompt at spawn, so edited roles can be restated after compaction. */
  spawnRole: z.string().nullable().default(null),
  /** Each watched thread's `latestAttentionAt` when the Director last looked at it. */
  seen: z.record(z.string(), z.number()),
  nextAt: z.number(),
  last: z.object({ at: z.number(), text: z.string() }).nullable(),
  /** The thread the Director was last handed. `open`: it proposed and waits for the user's answer. */
  subject: z.object({ threadId: z.string(), title: z.string(), project: z.string(), at: z.number(), open: z.boolean() }).nullable().default(null),
  /** The Director turn that already counted an answer, or that a ping started: known by the Director's
   *  `latestAttentionAt`, which changes only when a turn ends. At most one answer counts per turn. */
  spentTurn: z.number().nullable().default(null),
  /** Open scan window: allows the Director's own thread to save one draft scan card via `scan-propose`. */
  scanPending: z.object({ scannedThreads: z.number().int().nonnegative(), at: z.number() }).nullable().default(null),
  /** Tracks auto-compaction checks, in-flight compactions, and failures so compaction never loops or wedges. */
  compact: compactStateSchema.nullable().default(null),
});
type State = z.infer<typeof stateSchema>;
/** The website's answer, kept so a ping needs no network. It belongs to one account. */
const savedSchema = learnedSchema.extend({ account: z.string(), at: z.number() });
const SCAN_WINDOW_MS = 15 * 60_000;

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
  /** Whether its model is strong enough, or null until its harness's model list is read. */
  modelCheck: modelCheckSchema.nullable(),
  /** Recent scan proposals shown as inline cards in the Director's thread. */
  scans: scansMapSchema,
  /** False once the Director's harness is known not to support manual context compaction. */
  supportsAutoCompact: z.boolean(),
});

export const directorRpc = defineRpcContract({
  get: { input: z.null(), output: viewSchema },
  save: { input: configSchema, output: viewSchema },
  /** The Director's thread, started first if there is none. */
  open: { input: z.null(), output: z.object({ threadId: z.string() }) },
  pingNow: { input: z.null(), output: viewSchema },
  /** Run a fast one-turn scan of recent threads and propose learnings in the Director's thread. */
  scanNow: { input: z.null(), output: z.object({ threadId: z.string() }) },
  /** Save the user's kept learnings from an inline scan card. */
  saveScan: {
    input: z.object({ id: z.string().min(1).max(32), keptIds: z.array(z.string().min(1).max(16)).min(1).max(MAX_SCAN_LESSONS) }),
    output: viewSchema,
  },
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

/** Same rounded 0–100 percentage the thread context meter shows, or null when usage is unknown. */
const contextPercent = (usage: { usedTokens: number; modelContextWindow: number } | null): number | null =>
  usage !== null && usage.modelContextWindow > 0
    ? Math.round(Math.min(Math.max(usage.usedTokens / usage.modelContextWindow, 0), 1) * 100)
    : null;

export default async function directorPlugin(room: BbPluginApi): Promise<void> {
  const kv = room.storage.kv;
  const stored: Partial<Config> = (await kv.get<object>("config")) ?? {};
  // Once: a Director still on the old default look (Target, the app's color) moves to the new default.
  if ((await kv.get<number>("look")) !== 2) {
    if (stored.icon === "Target" && stored.color === "") {
      delete stored.icon;
      delete stored.color;
      await kv.set("config", stored);
    }
    await kv.set("look", 2);
  }
  let config = configSchema.catch(DEFAULTS).parse({ ...DEFAULTS, ...stored });
  let state: State = stateSchema
    .catch({ threadId: null, role: null, spawnRole: null, seen: {}, nextAt: Date.now() + FIRST_PING_MS, last: null, subject: null, spentTurn: null, scanPending: null, compact: null })
    .parse(await kv.get<unknown>("state"));
  let scans: Record<string, ScanRecord> = scansMapSchema.catch({}).parse((await kv.get<unknown>("scans")) ?? {});

  async function setState(change: Partial<State>): Promise<void> {
    state = { ...state, ...change };
    await kv.set("state", state);
    room.realtime.publish(CHANGED, { at: Date.now() });
  }
  async function saveScans(next: Record<string, ScanRecord>): Promise<void> {
    const trimmed = Object.fromEntries(
      Object.entries(next)
        .sort(([, a], [, b]) => b.at - a.at)
        .slice(0, MAX_STORED_SCANS),
    );
    scans = trimmed;
    await kv.set("scans", trimmed);
    room.realtime.publish(CHANGED, { at: Date.now() });
  }

  // What the Director learned lives with the Cloudroom account (docs/scopes/director.md#learning).
  let saved = savedSchema.nullable().catch(null).parse((await kv.get<unknown>("learned")) ?? null);
  /** The signed-in account as last seen, so the Director's instructions (built synchronously) can follow it. */
  let signedIn: string | null = null;
  const account = async () => (signedIn = (await room.sdk.cloudroom.status().catch(() => null))?.account?.id ?? null);
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
  /** Batch-save confirmed scan learnings (server caps meter credit at 12). */
  async function teachSeed(lessons: readonly { scope: "general" | "project"; target: string | null; words: string; meaning: string }[]): Promise<Learned> {
    const owner = config.learning ? await account() : null;
    if (owner === null) throw new Error(config.learning ? "Sign in to Cloudroom to save learnings." : "Learning is off. Turn it on in the Director's settings.");
    return keep(await room.sdk.cloudroom.director({ action: "teach", event: "seed", lessons }), owner);
  }

  /** The learning part of the Director's instructions: the dry run until this account's meter is full, then "save my
   *  corrections". Nothing with learning off or nobody signed in. Another account's copy counts as untaught. */
  function learningRules(): string {
    if (!config.learning || signedIn === null) return "";
    const mine = saved?.account === signedIn ? saved : null;
    return mine !== null && mine.reviewed >= mine.goal ? KEEP_LEARNING : LEARNING_MODE;
  }
  // Only the Director's own thread gets the role and the learning rules.
  room.agents.configure(({ pluginMetadata }) => ({
    tools: [],
    skills: [],
    ...(pluginMetadata.role === "director" ? { instructions: config.role + learningRules() } : {}),
  }));
  // Know the account and its meter before the first Director turn.
  void learned();

  /** The Director's thread, or null when it is gone or runs on another harness than the settings say. */
  async function director() {
    if (state.threadId === null) return null;
    const thread = await room.sdk.threads.get({ threadId: state.threadId }).catch(() => null);
    const live = thread !== null && thread.archivedAt === null && thread.deletedAt === null;
    return live && thread.providerId === config.agent.providerId ? thread : null;
  }
  /** Names the Director's current turn: when its previous turn ended. */
  const currentTurn = async () => (await director())?.latestAttentionAt ?? null;

  /** Starting, pinging and replacing the Director's thread run one at a time, so there is never a second, lost thread. */
  let turn: Promise<unknown> = Promise.resolve();
  function inTurn<T>(job: () => Promise<T>): Promise<T> {
    const run = turn.then(job, job);
    turn = run.catch(() => {});
    return run;
  }
  const runInTurn = (job: () => Promise<unknown>) =>
    void inTurn(job).catch((error) => room.log.warn(`Director task failed: ${message(error)}`));

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
    // Its instructions are fixed at start, so they need this account's meter.
    await learned();
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
    // Record its initial `latestAttentionAt` so pressing Stop on Turn 1 does not trigger auto-compact.
    await setState({
      threadId: spawned.id,
      role,
      spawnRole: role,
      subject: null,
      compact: { threadId: spawned.id, attentionAt: spawned.latestAttentionAt, pending: false, wasRead: false, failures: 0, failedAttentionAt: null },
    });
    return spawned.id;
  }

  /** Harnesses known not to support manual compaction (from executionOptions or a 409). */
  const unsupportedCompact = new Set<string>();
  const MAX_COMPACT_FAILURES = 2;

  /** Automatically compact the Director's thread when idle and at or above `config.autoCompactPercent`.
   *  Call inside `inTurn`. Returns the usage percent that triggered compaction, or null when skipped. */
  async function maybeAutoCompact(
    live: Awaited<ReturnType<typeof director>>,
    options: { force?: boolean } = {},
  ): Promise<number | null> {
    if (live === null || live.status !== "idle") return null;
    const prev = state.compact?.threadId === live.id ? state.compact : null;
    // Our own compaction just finished (or did not advance the turn): record its turn and never loop.
    if (prev?.pending) {
      const compacted = live.latestAttentionAt > prev.attentionAt;
      const editedRole = state.spawnRole !== null && config.role !== state.spawnRole;
      if (compacted && prev.wasRead) {
        await room.sdk.threads.markRead({ threadId: live.id }).catch(() => {});
      }
      await setState({
        ...(compacted && editedRole ? { role: null } : {}),
        compact: {
          threadId: live.id,
          attentionAt: live.latestAttentionAt,
          pending: false,
          wasRead: false,
          failures: compacted ? 0 : prev.failures,
          failedAttentionAt: compacted ? null : prev.failedAttentionAt,
        },
      });
      return null;
    }
    if (!config.autoCompact || unsupportedCompact.has(live.providerId)) return null;
    if (!options.force && (prev?.failures ?? 0) >= MAX_COMPACT_FAILURES) return null;
    // Skip when `latestAttentionAt` has not moved (covers Stop -> idle and already-checked turns).
    if (!options.force && prev !== null && prev.attentionAt === live.latestAttentionAt) return null;
    const { usage } = await room.sdk.threads.context({ threadId: live.id }).catch(() => ({ usage: null }));
    const percent = contextPercent(usage);
    const failures = options.force ? 0 : (prev?.failures ?? 0);
    const failedAttentionAt = options.force ? null : (prev?.failedAttentionAt ?? null);
    if (percent === null || percent < config.autoCompactPercent) {
      if (prev === null || prev.attentionAt !== live.latestAttentionAt) {
        await setState({
          compact: { threadId: live.id, attentionAt: live.latestAttentionAt, pending: false, wasRead: false, failures, failedAttentionAt },
        });
      }
      return null;
    }
    const wasRead = (live.lastReadAt ?? 0) >= live.latestAttentionAt;
    await setState({
      compact: { threadId: live.id, attentionAt: live.latestAttentionAt, pending: true, wasRead, failures, failedAttentionAt },
    });
    try {
      await room.sdk.threads.compact({ threadId: live.id });
      room.log.info(`Director auto-compacted at ${percent}% (threshold ${config.autoCompactPercent}%)`);
      return percent;
    } catch (error) {
      const reason = message(error);
      if (/does not support manual context compaction/i.test(reason)) unsupportedCompact.add(live.providerId);
      room.log.warn(`Director auto-compact skipped: ${reason}`);
      await setState({
        compact: { threadId: live.id, attentionAt: live.latestAttentionAt, pending: false, wasRead: false, failures, failedAttentionAt },
      });
      return null;
    }
  }

  /** It proposed something and waits for the user's answer, for a day at most. A new Director thread never saw the
   *  proposal, and a failed turn may never have shown it, so neither waits — unless the error came from our own compaction. */
  const waiting = (known: Learned | null, live: { id: string; status: string; latestAttentionAt: number } | null) => {
    if (known === null || known.reviewed >= known.goal || live === null || state.subject?.open !== true || Date.now() - state.subject.at > RECENT_MS) return false;
    if (live.status !== "error") return true;
    return state.compact?.threadId === live.id && state.compact.failedAttentionAt === live.latestAttentionAt;
  };

  /** Every project, the Personal one included. */
  const projects = () => room.sdk.projects.list({ includePersonal: true });

  /** Each harness's model list, read in the background; the app is told when one arrives. */
  const lists = new Map<string, { at: number; models: readonly Listed[] }>();
  const listing = new Set<string>();
  function modelList(providerId: string): readonly Listed[] | undefined {
    const known = lists.get(providerId);
    if ((known === undefined || Date.now() - known.at > MODELS_MS) && !listing.has(providerId)) {
      listing.add(providerId);
      room.sdk.system
        .executionOptions({ providerId, signal: AbortSignal.timeout(30_000) })
        .then(
          ({ models, providers }) => {
            const info = providers.find((provider) => provider.id === providerId);
            if (info?.capabilities.supportsManualCompaction === false) unsupportedCompact.add(providerId);
            else if (info?.capabilities.supportsManualCompaction === true) unsupportedCompact.delete(providerId);
            return models;
          },
          () => known?.models ?? [],
        )
        .then((models) => {
          lists.set(providerId, { at: Date.now(), models });
          room.realtime.publish(CHANGED, { at: Date.now() });
        })
        .finally(() => listing.delete(providerId));
    }
    return known?.models;
  }
  /** Waits for the Director's own harness, so a model is never called weak before its name is known. */
  function modelCheck() {
    const ids = [...new Set([...HOMES, config.agent.providerId])];
    const read = new Map(ids.flatMap((id) => {
      const models = modelList(id);
      return models === undefined ? [] : [[id, models] as const];
    }));
    return read.has(config.agent.providerId) ? checkModel(config.agent, read) : null;
  }

  /** The Director explains how it works the first time on this computer, or while it is at 0 / 50 (David, 2026-11-27).
   *  Once per Director thread: `welcomed` is the thread that last explained itself. */
  let welcomed = z.string().nullable().catch(null).parse((await kv.get<unknown>("welcomed")) ?? null);
  async function welcomeText(threadId: string | null): Promise<string | null> {
    if (threadId !== null && threadId === welcomed) return null;
    const known = await learned();
    if (welcomed !== null && known?.reviewed !== 0) return null;
    const ids = config.projectIds;
    const watching = ids === null ? "all projects" : (await projects()).filter(({ id }) => ids.includes(id)).map(({ name }) => name).join(", ") || "no projects";
    return welcome({ ping: config.ping, minutes: config.minutes, maxThreads: config.maxThreads, watching, goal: known?.goal ?? null });
  }
  async function markWelcomed(threadId: string): Promise<void> {
    welcomed = threadId;
    await kv.set("welcomed", threadId);
  }

  let pinging = false;
  /** One ping: pick stopped threads since the Director last looked (1 while learning, up to maxThreads otherwise), and hand them over. No pick, no model turn. */
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
          if (state.compact?.threadId === live.id && state.compact.pending) {
            return setState({ nextAt: now + FIRST_PING_MS, last: { at: now, text: "Waiting for auto-compact to finish" } });
          }
          return done("Skipped: the Director was still working");
        }
        // Catch-up: if the Director is idle above the auto-compact threshold (e.g. after a restart), compact first
        // and retry the ping shortly on fresh context.
        const compactedAt = await maybeAutoCompact(live);
        if (compactedAt !== null) {
          return setState({ nextAt: now + FIRST_PING_MS, last: { at: now, text: `Auto-compacting context (${compactedAt}%)` } });
        }
        // Until the user answers a proposal, it asks about nothing else.
        const known = await learned(), teaching = known !== null && known.reviewed < known.goal;
        if (waiting(known, live)) return done(`Waiting for your answer on "${state.subject?.title}"`);
        const rows = await room.sdk.threads.list({ archived: false, hasParent: false, sort: "updated", limit: 300 });
        // Stops older than the window can't be picked again, so their marks go.
        const seen = Object.fromEntries(Object.entries(state.seen).filter(([, at]) => now - at <= RECENT_MS));
        const limit = teaching ? 1 : config.maxThreads;
        const picks = pickThreads(rows, { now, seen, projectIds: config.projectIds, watchLoops: config.watchLoops }, limit);
        if (picks.length === 0) return done("Nothing new", { seen });
        const projectById = new Map((await projects()).map(({ id, name }) => [id, name]));
        const targets = picks.map((row) => ({ row, project: projectById.get(row.projectId) ?? "a project" }));
        const lessons =
          known === null
            ? ""
            : lessonsText(lessonsFor(known.lessons, targets.map(({ row, project }) => ({ id: row.id, project })))) +
              (teaching ? askFirst(known.reviewed + 1, known.goal) : KEEP_LEARNING);
        const intro = await welcomeText(live?.id ?? null);
        const sent = await say((intro === null ? "" : intro + WELCOME_THEN) + pingText(config.prompt, targets, now) + lessons);
        if (intro !== null) await markWelcomed(sent);
        const first = targets[0]!;
        const subject = targets.length === 1 ? { threadId: first.row.id, title: titleOf(first.row), project: first.project, at: now, open: teaching } : null;
        // The turn this ping starts can't count an answer: the user has not answered yet.
        const spentTurn = live?.latestAttentionAt ?? (await currentTurn());
        const nextSeen = { ...seen, ...Object.fromEntries(picks.map((row) => [row.id, row.latestAttentionAt])) };
        const summary = targets.length === 1 ? `${teaching ? "Asked you about" : "Checked"} "${titleOf(first.row)}"` : `Checked ${targets.length} threads`;
        return done(summary, { subject, spentTurn, seen: nextSeen, scanPending: null });
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
      modelCheck: modelCheck(),
      scans,
      supportsAutoCompact: !unsupportedCompact.has(config.agent.providerId),
    };
  }

  async function apply(next: Config): Promise<void> {
      const sooner = Date.now() + next.minutes * 60_000;
      const turnedOn = next.ping && !config.ping;
      const compactChanged = next.autoCompact !== config.autoCompact || next.autoCompactPercent !== config.autoCompactPercent;
      const tighterCompact = next.autoCompact && (!config.autoCompact || next.autoCompactPercent < config.autoCompactPercent);
      config = next;
      // The default role and ping message are not stored, so a better default reaches everyone who never edited theirs.
      const { role, prompt, ...rest } = config;
      await kv.set("config", { ...rest, ...(role === DEFAULT_ROLE ? {} : { role }), ...(prompt === DEFAULT_PING ? {} : { prompt }) });
      // Turning the timer on pings soon. A shorter interval applies now, not after the old one runs out.
      const resetFailures = compactChanged && state.compact && state.compact.failures > 0
        ? { compact: { ...state.compact, failures: 0, failedAttentionAt: null } }
        : {};
      await setState({ ...resetFailures, nextAt: turnedOn ? Date.now() + FIRST_PING_MS : Math.min(state.nextAt, sooner) });
      // Turning auto-compact on or lowering the threshold compacts right away if the Director is already over it.
      if (tighterCompact) runInTurn(async () => maybeAutoCompact(await director(), { force: true }));
  }
  /** Fast 1-turn scan of recent threads; must run inside `inTurn`. Returns null when fewer than 5 user threads exist. */
  async function startScan(firstOpen: boolean): Promise<{ threadId: string; scannedThreads: number } | null> {
    const live = await director();
    if (!firstOpen && live !== null && live.status !== "idle" && live.status !== "error") {
      throw new Error("The Director is still working. Wait for its current turn to finish.");
    }
    const known = await learned();
    const digest = await buildScanDigest(room, { projectIds: config.projectIds, watchLoops: config.watchLoops, excludeThreadId: live?.id ?? null });
    if (digest === null) return null;
    const prompt = scanPrompt(digest, { firstOpen, goal: known?.goal ?? null, existingLessons: known?.lessons ?? [] });
    await setState({ scanPending: { scannedThreads: digest.scannedThreads, at: Date.now() } });
    try {
      const threadId = await say(prompt);
      return { threadId, scannedThreads: digest.scannedThreads };
    } catch (error) {
      await setState({ scanPending: null });
      throw error;
    }
  }
  const scanNow = () =>
    inTurn(async () => {
      const result = await startScan(false);
      if (result === null) throw new Error("Need at least 5 past threads to scan.");
      return result;
    });
  const saveScan = (id: string, keptIds: readonly string[]) =>
    inTurn(async () => {
      const record = scans[id];
      if (!record) throw new Error("Scan not found.");
      if (record.savedAt !== null) return view();
      const picked = new Set(keptIds);
      const chosen = record.items.filter((item) => picked.has(item.id));
      if (chosen.length === 0) throw new Error("Pick at least one learning to save.");
      const updated = await teachSeed(
        chosen.map((item) => ({ scope: item.scope, target: item.target, words: item.lesson, meaning: item.observation })),
      );
      await saveScans({
        ...scans,
        [id]: {
          ...record,
          savedAt: Date.now(),
          keptIds: chosen.map((item) => item.id),
          savedMeter: { reviewed: updated.reviewed, goal: updated.goal },
        },
      });
      return view();
    });
  const proposeScan = (args: string[], fromDirector: boolean) =>
    inTurn(async () => {
      const pending = state.scanPending;
      if (fromDirector && (pending === null || Date.now() - pending.at > SCAN_WINDOW_MS)) {
        throw new Error("No active scan. Only propose a scan card during a Director scan.");
      }
      const raw = flag(args, "items");
      if (!raw) throw new Error('Pass the proposed learnings as JSON: --items \'[{"scope":"general","lesson":"...","observation":"..."}]\'.');
      const projectNames = (await projects().catch(() => [])).map(({ name }) => name);
      const items = parseScanProposal(raw, projectNames);
      const id = `scan_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
      const record: ScanRecord = {
        id,
        at: Date.now(),
        scannedThreads: pending?.scannedThreads ?? 0,
        items,
        savedAt: null,
        keptIds: [],
        savedMeter: null,
      };
      await saveScans({ ...scans, [id]: record });
      if (pending !== null) await setState({ scanPending: null });
      return `::director-scan{id="${id}"}`;
    });
  const open = () =>
    inTurn(async () => {
      const live = await director();
      // A first-time user gets the initial thread scan (or plain intro if they have <5 threads), unless the Director is busy.
      const intro = live === null || live.status === "idle" || live.status === "error" ? await welcomeText(live?.id ?? null) : null;
      if (intro === null) return { threadId: live?.id ?? (await say(INTRO)) };
      const known = await learned();
      if (known !== null && known.reviewed === 0 && known.lessons.length === 0) {
        const scanned = await startScan(true).catch(() => null);
        if (scanned !== null) {
          await markWelcomed(scanned.threadId);
          return { threadId: scanned.threadId };
        }
      }
      const threadId = await say(intro + WELCOME_ONLY);
      await markWelcomed(threadId);
      return { threadId };
    });
  const fresh = () =>
    inTurn(async () => {
      if (state.threadId !== null) await room.sdk.threads.archive({ threadId: state.threadId }).catch(() => {});
      await setState({ threadId: null, role: null, spawnRole: null, subject: null, scanPending: null, compact: null });
    });
  const count = (lessons: unknown[]) => `${lessons.length} lesson${lessons.length === 1 ? "" : "s"}`;
  const taught = (known: Learned) => `${Math.min(known.reviewed, known.goal)} of ${known.goal} turns taught`;
  /** The thread an answer is about: the one named with --thread, checked to exist, or else the one a waiting ping named.
   *  Its project is looked up, never taken from the caller. */
  async function about(id: string | undefined): Promise<{ id: string; title: string; project: string | null } | null> {
    const subject = state.subject;
    if (subject !== null && (id === subject.threadId || (id === undefined && subject.open))) return { id: subject.threadId, title: subject.title, project: subject.project };
    if (id === undefined) return null;
    const thread = await room.sdk.threads.get({ threadId: id }).catch(() => null);
    if (thread === null || thread.deletedAt !== null) throw new Error(`No thread ${id}.`);
    return { id: thread.id, title: titleOf(thread), project: (await projects()).find((project) => project.id === thread.projectId)?.name ?? null };
  }
  /** The Director records the user's answer to its proposal, or a correction given at any time. Runs one at a time with
   *  pings. From the Director's own thread, at most one answer counts per turn; the user in a terminal is not limited. */
  const learn = (step: string, args: string[], fromDirector: boolean) => inTurn(() => answer(step, args, fromDirector));
  async function answer(step: string, args: string[], fromDirector: boolean): Promise<string> {
    const subject = state.subject;
    if (step === "forget") {
      await teach("forget", { id: args[0] ?? "" });
      return "Forgotten.";
    }
    if (step === "skip") {
      if (subject?.open) await setState({ subject: { ...subject, open: false } });
      return "Skipped. Nothing was counted.";
    }
    if (step !== "approve" && step !== "correct") throw new Error("Use approve, correct, skip or forget.");
    // An answer counts whether a ping or the user's own chat message led to the proposal (ADR 20261127-221722), once
    // per Director turn, and only until the meter is full.
    const thread = await about(flag(args, "thread")?.replace(/^@thread:/, ""));
    const before = await learned(), full = before !== null && before.reviewed >= before.goal;
    const turn = fromDirector ? await currentTurn() : null;
    const counts = !full && (!fromDirector || (turn !== null && turn !== state.spentTurn));
    // Answering a waiting ping's proposal closes it; an answer about another thread leaves it waiting.
    const close = async () => {
      const answered = subject?.open && thread?.id === subject.threadId ? { subject: { ...subject, open: false } } : {};
      await setState({ ...answered, ...(counts && turn !== null ? { spentTurn: turn } : {}) });
    };
    if (step === "approve") {
      if (full) return `Nothing to count: ${taught(before)}.`;
      if (!counts) throw new Error("Only one answer counts per turn, and none before the user answers. Wait for the user's answer.");
      const known = await teach("approved");
      await close();
      return `Counted: ${taught(known)}.`;
    }
    const scope = flag(args, "scope") ?? "thread", words = flag(args, "words");
    if (scope !== "general" && scope !== "project" && scope !== "thread") throw new Error("--scope is thread, project or general.");
    if (!words?.trim()) throw new Error('Give the user\'s exact words: --words "<their words>".');
    const target = scope === "general" ? null : scope === "project" ? thread?.project : thread?.id;
    if (target === undefined) throw new Error("Name the thread this is about: --thread <id>. Or use --scope general.");
    if (target === null && scope !== "general") throw new Error(`Thread ${thread?.id} has no project. Use --scope thread.`);
    // Past the count, or after full: the lesson is saved, no turn is counted.
    const known = await teach(counts ? "corrected" : "lesson", { scope, target, words, meaning: flag(args, "meaning") ?? "" });
    await close();
    const place = scope === "general" ? "for every thread" : scope === "project" ? `for project "${target}"` : `for thread "${thread?.title}"`;
    return `Saved ${place}. ${count(known.lessons)}, ${taught(known)}.`;
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
    async scanNow() {
      const { threadId } = await scanNow();
      return { threadId };
    },
    async saveScan({ id, keptIds }) {
      return saveScan(id, keptIds);
    },
    async forget({ id }) {
      await teach("forget", { id });
      return view();
    },
    async skip() {
      await learn("skip", [], false);
      return view();
    },
  });

  // Every setting is also a `room-cli director set` away, so agents and scripts can configure it.
  const onOff = (value: string) => ({ on: true, off: false })[value];
  const orDefault = (value: string, fallback: string) => (value === "default" ? fallback : value);
  const parseCompact = (value: string): Partial<Config> => {
    const toggle = onOff(value);
    if (toggle !== undefined) return { autoCompact: toggle };
    const cleaned = value.trim().replace(/%$/, "");
    return { autoCompact: true, autoCompactPercent: cleaned ? Number(cleaned) : Number.NaN };
  };
  const SETTINGS: Record<string, (value: string) => Partial<Config>> = {
    ping: (value) => ({ ping: onOff(value) as boolean }),
    minutes: (value) => ({ minutes: Number(value) }),
    threads: (value) => ({ maxThreads: Number(value) }),
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
    compact: parseCompact,
    "auto-compact": parseCompact,
    icon: (icon) => ({ icon }),
    color: (value) => ({ color: orDefault(value, DEFAULTS.color) }),
    role: (value) => ({ role: orDefault(value, DEFAULT_ROLE) }),
    prompt: (value) => ({ prompt: orDefault(value, DEFAULT_PING) }),
  };
  const USAGE = `Usage:
  room-cli director [status] [--json]          Show the settings and the last ping
  room-cli director set <setting> <value>      Change one setting
  room-cli director ping                       Ping now
  room-cli director scan                       Scan recent threads and propose learnings
  room-cli director open                       Print the Director's thread ID, starting it if needed
  room-cli director new                        Archive its thread; the next ping starts a new one
  room-cli director lessons [--json]           Show what it learned from you
  room-cli director learn approve|skip [--thread <id>]   Answer its proposal (the Director runs these for you)
  room-cli director learn correct --thread <id> --scope thread|project|general --words <your words> [--meaning <its reading>]
  room-cli director learn forget <lesson-id>   Delete one lesson
Settings:
  ping on|off · minutes 1-1440 · threads 1-20 · provider <id> <model> · model <id> · effort <level> · tier default|fast|ultrafast
  projects all|<id,id> · loops on|off · learning on|off · compact on|off|30-95 · icon <name or emoji> · color <CSS color|default>
  role <text|default> · prompt <text|default>
`;
  room.cli.register({
    name: "director",
    summary: "Configure and run the Director",
    commands: [
      { name: "status", summary: "Show the settings and the last ping", usage: "room-cli director [status] [--json]" },
      { name: "set", summary: "Change one setting", usage: "room-cli director set <setting> <value>" },
      { name: "ping", summary: "Ping now", usage: "room-cli director ping" },
      { name: "scan", summary: "Scan recent threads and propose learnings", usage: "room-cli director scan" },
      { name: "scan-propose", summary: "Save a draft scan checklist card (used by the Director)", usage: "room-cli director scan-propose --items <json>" },
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
        const lines = Object.entries({ ...plain, threads: plain.maxThreads, provider: agent.providerId, model: agent.model, effort: agent.reasoningLevel, tier: agent.serviceTier ?? "default", projects: plain.projectIds?.join(",") ?? "all", loops: plain.watchLoops, compact: plain.autoCompact ? `${plain.autoCompactPercent}%` : "off" }).filter(([name]) => name !== "maxThreads" && name !== "projectIds" && name !== "watchLoops" && name !== "autoCompact" && name !== "autoCompactPercent");
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
        return { exitCode: 0, stdout: `${taught(known)}, ${known.approved} right first time\n${lines.join("\n") || "No lessons yet."}\n` };
      }
      if (command === "learn") {
        // Another agent's thread never teaches the Director: only its own thread, or the user in a terminal.
        if (context.threadId && context.threadId !== state.threadId) return { exitCode: 1, stderr: "Only the Director's own thread can teach it.\n" };
        return learn(key, rest, Boolean(context.threadId)).then((stdout) => ({ exitCode: 0, stdout: `${stdout}\n` }), (error: unknown) => ({ exitCode: 1, stderr: `${message(error)}\n` }));
      }
      if (command === "scan-propose") {
        if (context.threadId && context.threadId !== state.threadId) return { exitCode: 1, stderr: "Only the Director's own thread can propose scan learnings.\n" };
        return proposeScan([key, ...rest].filter(Boolean), Boolean(context.threadId)).then(
          (stdout) => ({ exitCode: 0, stdout: `${stdout}\n` }),
          (error: unknown) => ({ exitCode: 1, stderr: `${message(error)}\n` }),
        );
      }
      // Its own thread reads other threads' logs, so a prompt injection there must not rewrite its settings or start scans.
      if ((command === "set" || command === "scan") && context.threadId && context.threadId === state.threadId) {
        return { exitCode: 1, stderr: `The Director can't run ${command} itself. Ask the user to.\n` };
      }
      if (command === "ping") await ping();
      else if (command === "scan") {
        return scanNow().then(
          ({ threadId, scannedThreads }) => ({ exitCode: 0, stdout: `Scanning ${scannedThreads} threads in ${threadId}\n` }),
          (error: unknown) => ({ exitCode: 1, stderr: `${message(error)}\n` }),
        );
      }
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
  // An idle turn also checks whether the Director's context crossed the auto-compact threshold.
  room.events.on("thread.idle", ({ thread }) => {
    if (thread.id !== state.threadId) return;
    room.realtime.publish(CHANGED, { at: Date.now() });
    runInTurn(async () => maybeAutoCompact(await director()));
  });
  room.events.on("thread.failed", ({ thread }) => {
    if (thread.id !== state.threadId) return;
    room.realtime.publish(CHANGED, { at: Date.now() });
    runInTurn(async () => {
      const current = state.compact;
      if (current?.threadId === thread.id && current.pending) {
        await setState({
          compact: {
            ...current,
            attentionAt: thread.latestAttentionAt,
            pending: false,
            wasRead: false,
            failures: current.failures + 1,
            failedAttentionAt: thread.latestAttentionAt,
          },
        });
      }
    });
  });

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
