import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { keepAwakeHostContract } from "./contract.js";

const STORAGE_KEY = "configuration";
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const USAGE = "Usage: room-cli keep-awake <status|enable|disable|hosts> [arguments] [--json]";

const configurationShape = {
  enabled: z.boolean(),
  selection: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("all") }).strict(),
    z
      .object({ mode: z.literal("selected"), hostIds: z.array(z.string().min(1)).min(1).max(256) })
      .strict(),
  ]),
};
const configurationSchema = z.object(configurationShape).strict();
/** The saved configuration plus the machines the settings page lists. */
const viewSchema = z.object({
  ...configurationShape,
  hosts: z.array(
    z.object({ id: z.string(), name: z.string(), status: z.enum(["connected", "disconnected"]) }),
  ),
});
type Configuration = z.infer<typeof configurationSchema>;

export const keepAwakeRpcContract = defineRpcContract({
  getConfiguration: { input: z.null(), output: viewSchema },
  setConfiguration: { input: configurationSchema, output: viewSchema },
});

export default async function keepAwakePlugin(room: BbPluginApi): Promise<void> {
  const host = room.hosts.experimental_client({ contract: keepAwakeHostContract });
  const stored = configurationSchema.safeParse(await room.storage.kv.get<unknown>(STORAGE_KEY));
  let config: Configuration = stored.success
    ? stored.data
    : { enabled: false, selection: { mode: "all" } };

  /** Set while the background service runs; nothing is applied outside it. */
  let signal: AbortSignal | null = null;
  let queue = Promise.resolve();
  let retry: ReturnType<typeof setTimeout> | null = null;
  let retryMs = RETRY_MIN_MS;

  /** Tell one machine its state. False if it needs another try. */
  async function applyTo(id: string, wanted: boolean, signal: AbortSignal): Promise<boolean> {
    try {
      const actual = await host.call("setEnabled", { enabled: wanted }, { hostId: id, signal });
      if (actual.supported && actual.enabled === wanted) return true;
      if (actual.supported) room.log.warn(`Keep Awake did not reach its configured state on host ${id}; retrying`);
      else if (wanted) room.log.warn(`Keep Awake is enabled but host ${id} is not supported`);
      return !actual.supported;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (!signal.aborted) room.log.warn(`Could not apply Keep Awake on host ${id}: ${reason}`);
      return false;
    }
  }

  /**
   * Tell every connected machine its state. False if any needs another try.
   * It waits for every machine, so a slow one can never be overtaken by the next run.
   */
  async function applyOnce(signal: AbortSignal): Promise<boolean> {
    const { enabled, selection } = config;
    try {
      const machines = (await room.sdk.hosts.list()).filter((machine) => machine.status === "connected");
      const settled = await Promise.all(
        machines.map(({ id }) =>
          applyTo(id, enabled && (selection.mode === "all" || selection.hostIds.includes(id)), signal),
        ),
      );
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
      ["status", "", "Show whether Keep Awake is enabled and which hosts it uses"],
      ["enable", "", "Enable Keep Awake"],
      ["disable", "", "Disable Keep Awake"],
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
      if (args.length > 0) return fail(USAGE);
      if (command === "status") {
        return done(config, `${config.enabled ? "Enabled" : "Disabled"}\nHosts: ${hostIds(", ", "all")}`);
      }
      if (command !== "enable" && command !== "disable") return fail(USAGE);
      await save({ ...config, enabled: command === "enable" });
      return done(config, `Keep Awake ${config.enabled ? "enabled" : "disabled"}`);
    },
  });

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
            if (event.state === "connected" && event.reconnected) apply();
          },
        }),
      ];
      apply();
      if (!serviceSignal.aborted) {
        await new Promise((resolve) => serviceSignal.addEventListener("abort", resolve, { once: true }));
      }
      for (const stop of unsubscribe) stop();
      if (retry !== null) clearTimeout(retry);
      retry = null;
    },
  });
}
