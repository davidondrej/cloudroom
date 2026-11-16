import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { keepAwakeHostContract, type HostState } from "./contract.js";

const STORAGE_KEY = "configuration";
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** "While agents work" keeps a machine awake this long after its last running thread, to bridge back-to-back runs. */
const GRACE_MS = 10 * 60_000;
/** A thread waiting this long on a question or approval stops keeping its machine awake. */
const WAITING_LIMIT_MS = 60 * 60_000;
/** Catches missed thread events and ends grace periods. */
const POLL_MS = 60_000;
/** Lets a burst of thread status changes settle into one check. */
const SETTLE_MS = 1_000;
const levelSchema = z.enum(["off", "working", "always"]);
const LEVEL_LABELS: Record<z.infer<typeof levelSchema>, string> = {
  off: "Off",
  working: "While agents work",
  always: "Always",
};
const USAGE = "Usage: room-cli keep-awake <status|level|enable|disable|hosts> [arguments] [--json]";

const selectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z.object({ mode: z.literal("selected"), hostIds: z.array(z.string().min(1)).min(1).max(256) }).strict(),
]);
const configurationShape = {
  level: levelSchema,
  selection: selectionSchema,
};
const configurationSchema = z.object(configurationShape).strict();
/** The old one-switch setting. A migration saved "off" for every install, so "off" was never a real choice. */
const legacySchema = z.object({ enabled: z.boolean(), selection: selectionSchema }).strict();
/** The saved configuration plus the machines the settings page lists. */
const viewSchema = z.object({
  ...configurationShape,
  hosts: z.array(
    z.object({ id: z.string(), name: z.string(), status: z.enum(["connected", "disconnected"]) }),
  ),
});
type Configuration = z.infer<typeof configurationSchema>;

/** The saved level, or the default: "Always" for the old switch's "on", "While agents work" for anything else. */
function loadConfiguration(value: unknown): Configuration {
  const current = configurationSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = legacySchema.safeParse(value);
  if (!legacy.success) return { level: "working", selection: { mode: "all" } };
  return { level: legacy.data.enabled ? "always" : "working", selection: legacy.data.selection };
}

export const keepAwakeRpcContract = defineRpcContract({
  getConfiguration: { input: z.null(), output: viewSchema },
  setConfiguration: { input: configurationSchema, output: viewSchema },
});

export default async function keepAwakePlugin(room: BbPluginApi): Promise<void> {
  const host = room.hosts.experimental_client({ contract: keepAwakeHostContract });
  let config = loadConfiguration(await room.storage.kv.get<unknown>(STORAGE_KEY));
  /** When each machine may sleep again under "While agents work". */
  const awakeUntil = new Map<string, number>();
  /** The machines the last check kept awake for agents, to apply only on a change. */
  let working = "";
  let settle: ReturnType<typeof setTimeout> | null = null;

  /** Set while the background service runs; nothing is applied outside it. */
  let signal: AbortSignal | null = null;
  let queue = Promise.resolve();
  let retry: ReturnType<typeof setTimeout> | null = null;
  let retryMs = RETRY_MIN_MS;

  /** Tell one machine its state. False if it needs another try. */
  async function applyTo(id: string, wanted: HostState, signal: AbortSignal): Promise<boolean> {
    try {
      const actual = await host.call("setState", { state: wanted }, { hostId: id, signal });
      if (actual.supported && actual.state === wanted) return true;
      if (actual.supported) room.log.warn(`Keep Awake did not reach its configured state on host ${id}; retrying`);
      else if (wanted !== "off") room.log.warn(`Keep Awake is on but host ${id} is not supported`);
      return !actual.supported;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (!signal.aborted) room.log.warn(`Could not apply Keep Awake on host ${id}: ${reason}`);
      return false;
    }
  }

  /** What one machine should do now. */
  function stateFor(id: string): HostState {
    const { level, selection } = config;
    if (level === "off" || (selection.mode === "selected" && !selection.hostIds.includes(id))) return "off";
    if (level === "always") return "display";
    return (awakeUntil.get(id) ?? 0) > Date.now() ? "awake" : "off";
  }

  /** Whether a thread has waited on a question or approval for too long. If unsure, it still counts as working. */
  async function waitedTooLong(threadId: string, signal: AbortSignal): Promise<boolean> {
    try {
      const open = await room.sdk.threads.interactions.list({ threadId, signal });
      return open.some((interaction) => Date.now() - interaction.createdAt > WAITING_LIMIT_MS);
    } catch {
      return false;
    }
  }

  /** Note which machines run threads now, and apply when that set changes. Cloud threads have no host. */
  async function checkAgents(): Promise<void> {
    const running = signal;
    if (running === null || running.aborted) return;
    const now = Date.now();
    try {
      const local = (await room.sdk.threads.listRunning({ signal: running })).flatMap(({ id, hostId }) =>
        hostId === null ? [] : [{ id, hostId }],
      );
      const waiting = await Promise.all(local.map(({ id }) => waitedTooLong(id, running)));
      local.forEach(({ hostId }, i) => {
        if (!waiting[i]) awakeUntil.set(hostId, now + GRACE_MS);
      });
    } catch (error) {
      // Blind to running threads: keep awake machines awake rather than let one sleep mid-task.
      for (const id of awakeUntil.keys()) awakeUntil.set(id, now + GRACE_MS);
      const reason = error instanceof Error ? error.message : String(error);
      if (!running.aborted) room.log.warn(`Could not list running threads: ${reason}`);
      return;
    }
    for (const [id, until] of awakeUntil) if (until <= now) awakeUntil.delete(id);
    const next = [...awakeUntil.keys()].sort().join();
    if (next === working) return;
    working = next;
    apply();
  }

  function checkSoon(): void {
    settle ??= setTimeout(() => {
      settle = null;
      void checkAgents();
    }, SETTLE_MS);
  }

  /**
   * Tell every connected machine its state. False if any needs another try.
   * It waits for every machine, so a slow one can never be overtaken by the next run.
   */
  async function applyOnce(signal: AbortSignal): Promise<boolean> {
    try {
      const machines = (await room.sdk.hosts.list()).filter((machine) => machine.status === "connected");
      const settled = await Promise.all(machines.map(({ id }) => applyTo(id, stateFor(id), signal)));
      return settled.every(Boolean);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (!signal.aborted) room.log.warn(`Could not load Keep Awake state: ${reason}`);
      return false;
    }
  }

  /** Try again after a delay that doubles until a run succeeds. */
  function retryLater(): void {
    if (retry !== null || signal === null || signal.aborted) return;
    retry = setTimeout(() => {
      retry = null;
      apply();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  }

  /** Apply the configuration now. Runs go one at a time, in order. */
  function apply(): void {
    queue = queue.then(async () => {
      const running = signal;
      if (running === null || running.aborted) return;
      if (retry !== null) clearTimeout(retry);
      retry = null;
      if (await applyOnce(running)) retryMs = RETRY_MIN_MS;
      else if (!running.aborted) retryLater();
    });
  }

  async function save(next: Configuration): Promise<void> {
    const { selection } = next;
    if (selection.mode === "selected") {
      next = { ...next, selection: { ...selection, hostIds: [...new Set(selection.hostIds)] } };
    }
    await room.storage.kv.set(STORAGE_KEY, next);
    config = next;
    apply();
  }

  const view = async () => ({
    ...config,
    hosts: (await room.sdk.hosts.list()).map(({ id, name, status }) => ({ id, name, status })),
  });

  room.rpc.register(keepAwakeRpcContract, {
    getConfiguration: view,
    async setConfiguration(next) {
      await save(next);
      return view();
    },
  });

  room.cli.register({
    name: "keep-awake",
    summary: "Configure sleep prevention",
    commands: [
      ["status", "", "Show the Keep Awake level, its hosts, and which hosts agents keep awake now"],
      ["level", " <off|working|always>", "Set the level: off, while agents work, or always (screen too)"],
      ["enable", "", "Set the level to always"],
      ["disable", "", "Set the level to off"],
      ["hosts", " [all|<host-id>...]", "Show or replace the Keep Awake host selection"],
    ].map(([name, args, summary]) => ({
      name,
      summary,
      usage: `room-cli keep-awake ${name}${args} [--json]`,
    })),
    async run(argv) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter((arg) => arg !== "--json");
      const fail = (stderr: string) => ({ exitCode: 1, stderr });
      const done = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });
      const hostIds = (separator: string, all: string) =>
        config.selection.mode === "all" ? all : config.selection.hostIds.join(separator);

      if (command === "hosts") {
        const all = args[0] === "all";
        if (all && args.length > 1) return fail('"all" cannot be combined with individual host ids');
        if (args.length > 0) {
          await save({ ...config, selection: all ? { mode: "all" } : { mode: "selected", hostIds: args } });
        }
        return done(config.selection, hostIds("\n", "All hosts"));
      }
      if (command === "level") {
        const level = levelSchema.safeParse(args[0]);
        if (args.length !== 1 || !level.success) return fail(USAGE);
        await save({ ...config, level: level.data });
        return done(config, `Keep Awake: ${LEVEL_LABELS[config.level]}`);
      }
      if (args.length > 0) return fail(USAGE);
      if (command === "status") {
        const agentHostIds = [...awakeUntil.keys()].filter((id) => stateFor(id) === "awake");
        return done(
          { ...config, agentHostIds },
          `Level: ${LEVEL_LABELS[config.level]}\nHosts: ${hostIds(", ", "all")}` +
            (config.level === "working" ? `\nAwake for agents now: ${agentHostIds.join(", ") || "none"}` : ""),
        );
      }
      if (command !== "enable" && command !== "disable") return fail(USAGE);
      await save({ ...config, level: command === "enable" ? "always" : "off" });
      return done(config, `Keep Awake: ${LEVEL_LABELS[config.level]}`);
    },
  });

  // Thread starts and stops, not every streamed change. The poll catches anything missed.
  for (const event of ["thread.active", "thread.idle", "thread.failed", "thread.archived"] as const) {
    room.events.on(event, checkSoon);
  }

  host.experimental_onWorkerExit(({ hostId }) => {
    room.log.warn(`Keep Awake host worker exited unexpectedly on host ${hostId}; retrying`);
    retryLater();
  });

  room.background.service("desired-state-reconciler", {
    async start(serviceSignal) {
      signal = serviceSignal;
      const unsubscribe = [
        room.sdk.subscribe({
          event: "host:changed",
          callback: (event) => {
            if (event.changes.includes("host-connected")) apply();
          },
        }),
        room.sdk.subscribe({
          event: "realtime:connection",
          callback: (event) => {
            if (event.state !== "connected" || !event.reconnected) return;
            apply();
            checkSoon();
          },
        }),
      ];
      const poll = setInterval(() => void checkAgents(), POLL_MS);
      await checkAgents();
      apply();
      if (!serviceSignal.aborted) {
        await new Promise((resolve) => serviceSignal.addEventListener("abort", resolve, { once: true }));
      }
      for (const stop of unsubscribe) stop();
      clearInterval(poll);
      if (settle !== null) clearTimeout(settle);
      settle = null;
      if (retry !== null) clearTimeout(retry);
      retry = null;
    },
  });
}
