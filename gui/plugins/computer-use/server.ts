import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BbPluginApi,
  PluginCliContext,
  PluginCliResult,
  PluginInteractionResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  APPROVAL_RENDERER_ID,
  approvalResponseSchema,
  appSchema,
  hostContract,
  rpcContract,
  type AppIdentity,
  type HostStatus,
} from "./contract.js";
import { BLOCKED_TOOLS, LIME_CURSOR_SUFFIX, PID_REQUIRED_TOOLS, WHOLE_SCREEN } from "./driver.js";

const APPROVAL_WAIT_MS = 90_000;
const APP_BUSY_MS = 60_000;
const ALWAYS_KEY = "always-allowed";

export const commands = [
  {
    name: "status",
    summary: "Show driver, macOS permission, and approval status",
    usage: "room-cli computer-use status [--json]",
  },
  {
    name: "setup",
    summary: "Ask macOS for Accessibility (and Screen Recording with --screen-recording)",
    usage: "room-cli computer-use setup [--screen-recording]",
  },
  {
    name: "tools",
    summary: "List every Cua Driver tool, or describe one",
    usage: "room-cli computer-use tools [<tool>]",
  },
  {
    name: "call",
    summary: "Run one Cua Driver tool; Cloudroom asks the user before each new app",
    usage: "room-cli computer-use call <tool> ['<json-args>'] [--purpose <text>]",
  },
];

const threadHostSchema = z.object({
  host: z.object({ id: z.string() }).nullable().optional(),
  providerId: z.string().nullable().optional(),
});

export function decideGate(args: {
  tool: string;
  input: Record<string, unknown>;
}): { kind: "free" } | { kind: "pid"; pid: number } | { kind: "name"; name: string } | { kind: "screen" } | { kind: "error"; message: string } {
  const { tool, input } = args;
  if (BLOCKED_TOOLS.has(tool))
    return { kind: "error", message: `${tool} changes Cua Driver itself and is not available to agents.` };
  if (tool === "launch_app") {
    const name = input.bundle_id ?? input.name;
    return typeof name === "string" && name
      ? { kind: "name", name }
      : { kind: "error", message: "launch_app needs bundle_id or name." };
  }
  if (tool === "get_desktop_state") return { kind: "screen" };
  if (tool === "list_windows") return { kind: "free" };
  if (typeof input.pid === "number") return { kind: "pid", pid: input.pid };
  if (PID_REQUIRED_TOOLS.has(tool))
    return { kind: "error", message: `${tool} needs a pid so Cloudroom knows which app you are controlling. Find it with list_apps or list_windows.` };
  return { kind: "free" };
}

const sessionFor = (threadId: string) => `cr-${threadId.slice(-24)}${LIME_CURSOR_SUFFIX}`;

function fail(code: string, message: string, exitCode = 1): PluginCliResult {
  return { exitCode, stdout: `${JSON.stringify({ error: code, message })}\n` };
}

export function outcomeOf(result: PluginCliResult): { outcome: string; effect: string | null } {
  const fallback = result.exitCode === 0 ? "ok" : "error";
  try {
    const parsed = z
      .object({ error: z.string().optional(), code: z.string().optional(), effect: z.string().optional() })
      .passthrough()
      .parse(JSON.parse(result.stdout ?? ""));
    return { outcome: parsed.error ?? parsed.code ?? fallback, effect: parsed.effect ?? null };
  } catch {
    return { outcome: fallback, effect: null };
  }
}

export default async function computerUsePlugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const pending = new Map<string, { request: Promise<PluginInteractionResult>; startedAt: number }>();
  const track = (name: string, properties: Record<string, string | number | boolean | null>) =>
    bb.experimental_telemetry.capture(name, { execution: "local", ...properties });
  const busy = new Map<string, { threadId: string; at: number }>();
  const active = new Map<string, string>();
  const threadKey = (threadId: string) => `thread/${encodeURIComponent(threadId)}`;

  const readList = async (key: string) =>
    z.array(appSchema).catch([]).parse((await bb.storage.kv.get(key)) ?? []);
  const addTo = async (key: string, app: AppIdentity) => {
    const list = await readList(key);
    if (!list.some((entry) => entry.key === app.key)) await bb.storage.kv.set(key, [...list, app]);
  };

  async function threadInfo(threadId: string) {
    const thread = threadHostSchema.parse(await bb.sdk.threads.get({ threadId, include: "host" }));
    return { hostId: thread.host?.id ?? null, provider: thread.providerId ?? null };
  }

  async function localHostId() {
    const hosts = z
      .array(z.object({ id: z.string(), status: z.string(), machineProviderId: z.string().nullable().optional() }))
      .parse(await bb.sdk.hosts.list());
    return (
      hosts.find((entry) => entry.status === "connected" && !entry.machineProviderId)?.id ??
      hosts.find((entry) => entry.status === "connected")?.id ??
      null
    );
  }

  async function settings(hostId?: string | null) {
    const id = hostId === undefined ? await localHostId() : hostId;
    let status: HostStatus | null = null;
    let error: string | null = null;
    if (id) {
      try {
        status = await host.call("status", {}, { hostId: id });
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
    } else error = "No connected machine.";
    return { hostId: id, status, error, alwaysAllowed: await readList(ALWAYS_KEY) };
  }

  async function identify(hostId: string, gate: ReturnType<typeof decideGate>) {
    if (gate.kind === "pid") return host.call("appForPid", { pid: gate.pid }, { hostId });
    if (gate.kind === "name") return host.call("appForName", { name: gate.name }, { hostId });
    if (gate.kind === "screen") return { ...WHOLE_SCREEN };
    return null;
  }

  async function approve(args: {
    threadId: string;
    app: AppIdentity;
    tool: string;
    purpose: string | null;
    status: HostStatus;
  }): Promise<PluginCliResult | null> {
    const { threadId, app } = args;
    const always = await readList(ALWAYS_KEY);
    const thread = await readList(threadKey(threadId));
    if ([...always, ...thread].some((entry) => entry.key === app.key)) return null;
    const pendingKey = `${threadId}\0${app.key}`;
    let entry = pending.get(pendingKey);
    if (!entry) {
      const request = bb.ui.requestInput({
        threadId,
        rendererId: APPROVAL_RENDERER_ID,
        title: `Allow this agent to use ${app.name}?`,
        payload: {
          app,
          tool: args.tool,
          purpose: args.purpose,
          platform: args.status.platform,
          permissions: args.status.permissions,
        },
        timeoutMs: 60 * 60_000,
      });
      entry = { request, startedAt: Date.now() };
      pending.set(pendingKey, entry);
      void request.finally(() => pending.delete(pendingKey)).catch(() => {});
    }
    const { request, startedAt } = entry;
    const report = (decision: string) =>
      track("computer_use_approval", { app: app.key, tool: args.tool, decision, wait_ms: Date.now() - startedAt });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      request,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), APPROVAL_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    if (result === null) {
      report("pending");
      return fail(
        "approval_pending",
        `Cloudroom is asking the user to allow ${app.name}. Tell the user, then run the same command again. Do not end your turn.`,
        3,
      );
    }
    if (result.outcome === "cancelled") {
      report(`cancelled_${result.reason}`);
      return fail("approval_cancelled", `The request to use ${app.name} was cancelled (${result.reason}).`);
    }
    const { decision } = approvalResponseSchema.parse(result.value);
    report(decision);
    if (decision === "deny")
      return fail("app_denied", `The user denied access to ${app.name}. Do not retry; ask the user what to do instead.`);
    await addTo(decision === "always" ? ALWAYS_KEY : threadKey(threadId), app);
    return null;
  }

  async function runCall(
    argv: string[],
    ctx: PluginCliContext,
    threadId: string,
    hostId: string,
    seen: { app: string | null },
  ) {
    const tool = argv[1];
    if (!tool) return fail("usage", "Usage: room-cli computer-use call <tool> ['<json-args>'] [--purpose <text>]");
    let json = "{}";
    let purpose: string | null = null;
    for (let index = 2; index < argv.length; index++) {
      if (argv[index] === "--purpose") purpose = argv[++index] ?? null;
      else json = argv[index]!;
    }
    let input: Record<string, unknown>;
    try {
      input = z.record(z.string(), z.unknown()).parse(JSON.parse(json));
    } catch {
      return fail("invalid_json", "Tool arguments must be one JSON object, e.g. '{\"pid\":123}'.");
    }
    const gate = decideGate({ tool, input });
    if (gate.kind === "error") return fail("invalid_call", gate.message);
    const status = await host.call("prepare", {}, { hostId, timeoutMs: 10 * 60_000 }).catch((error: unknown) => {
      track("computer_use_setup", { step: "driver_install", ok: false, error: error instanceof Error ? error.message : String(error) });
      throw error;
    });
    if (status.installMs !== null) track("computer_use_setup", { step: "driver_install", ok: true, ms: status.installMs });
    if (!status.supported) return fail("unsupported", status.reason ?? "Computer use is not available on this machine.");
    const app = await identify(hostId, gate);
    if (gate.kind !== "free" && !app) return fail("app_not_found", "No running app has that pid.");
    seen.app = app?.key ?? null;
    if (app) {
      const holder = busy.get(app.key);
      if (holder && holder.threadId !== threadId && Date.now() - holder.at < APP_BUSY_MS)
        return fail("app_busy", `${app.name} is being used by @thread:${holder.threadId}. Wait a minute or pick another app.`);
      const blocked = await approve({ threadId, app, tool, purpose, status });
      if (blocked) return blocked;
      busy.set(app.key, { threadId, at: Date.now() });
    }
    if (app && (await host.call("status", {}, { hostId })).permissions.accessibility === false)
      return fail(
        "permissions_missing",
        "Cloudroom needs macOS Accessibility permission. Ask the user to grant it in Settings > Plugins > Computer Use (or run `room-cli computer-use setup` while they watch), then retry.",
      );
    active.set(threadId, hostId);
    const result = await host.call(
      "call",
      {
        tool,
        args: input,
        session: sessionFor(threadId),
        shotsDir: join(tmpdir(), "cloudroom-computer-use", threadId.replace(/[^A-Za-z0-9_-]/g, "_")),
      },
      { hostId, timeoutMs: 150_000, ...(ctx.signal ? { signal: ctx.signal } : {}) },
    );
    if (result.driverExits > 0) track("computer_use_crash", { component: "driver", count: result.driverExits });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  async function trackedCall(argv: string[], ctx: PluginCliContext, threadId: string, hostId: string, provider: string | null) {
    const startedAt = Date.now();
    const seen: { app: string | null } = { app: null };
    let result: PluginCliResult;
    try {
      result = await runCall(argv, ctx, threadId, hostId, seen);
    } catch (error) {
      result = fail("error", error instanceof Error ? error.message : String(error));
    }
    track("computer_use_call", {
      tool: argv[1] ?? null,
      app: seen.app,
      provider,
      ms: Date.now() - startedAt,
      ...outcomeOf(result),
    });
    return result;
  }

  function reportPermissions(step: string, status: HostStatus) {
    track("computer_use_setup", {
      step,
      ok: status.permissions.accessibility !== false,
      accessibility: status.permissions.accessibility,
      screen_recording: status.permissions.screenRecording,
    });
  }

  async function runCli(argv: string[], ctx: PluginCliContext): Promise<PluginCliResult> {
    const threadId = ctx.threadId;
    if (!threadId) return fail("no_thread", "Run this from a Cloudroom thread (ROOM_THREAD_ID is not set).");
    const { hostId, provider } = await threadInfo(threadId);
    if (!hostId)
      return fail("no_host", "This thread has no local machine. In Cloud threads use `room-cli computer-use` instead.");
    switch (argv[0]) {
      case "status": {
        const current = await settings(hostId);
        const allowed = await readList(threadKey(threadId));
        return { exitCode: 0, stdout: `${JSON.stringify({ ...current, allowedInThisThread: allowed }, null, 2)}\n` };
      }
      case "setup": {
        let status = await host.call("requestPermission", { kind: "accessibility" }, { hostId, timeoutMs: 60_000 });
        if (argv.includes("--screen-recording"))
          status = await host.call("requestPermission", { kind: "screenRecording" }, { hostId, timeoutMs: 60_000 });
        reportPermissions("permission_request", status);
        return { exitCode: 0, stdout: `${JSON.stringify(status, null, 2)}\n` };
      }
      case "tools": {
        const text = await host.call("describe", { tool: argv[1] ?? null }, { hostId, timeoutMs: 10 * 60_000 });
        return { exitCode: 0, stdout: text };
      }
      case "call":
        return trackedCall(argv, ctx, threadId, hostId, provider);
      default:
        return fail("usage", "Usage: room-cli computer-use status | setup | tools [<tool>] | call <tool> ['<json>']");
    }
  }

  bb.agents.configure(() => ({ tools: [], skills: ["computer-use"] }));
  bb.cli.register({
    name: "computer-use",
    summary: "See and control desktop apps, with a per-app approval from the user",
    commands,
    async run(argv, ctx) {
      try {
        return await runCli(argv, ctx);
      } catch (error) {
        return fail("error", error instanceof Error ? error.message : String(error));
      }
    },
  });

  bb.rpc.register(rpcContract, {
    getSettings: () => settings(),
    async removeAlwaysAllowed({ key }) {
      const list = await readList(ALWAYS_KEY);
      await bb.storage.kv.set(ALWAYS_KEY, list.filter((entry) => entry.key !== key));
      return settings();
    },
    async requestPermission({ kind }) {
      const hostId = await localHostId();
      if (hostId) reportPermissions("permission_request", await host.call("requestPermission", { kind }, { hostId, timeoutMs: 60_000 }));
      return settings(hostId);
    },
    async restart() {
      const hostId = await localHostId();
      if (hostId) await host.call("restart", {}, { hostId });
      return settings(hostId);
    },
  });

  host.experimental_onWorkerExit(() => track("computer_use_crash", { component: "host_worker" }));

  // Computer use lasts one turn: when it ends, the thread's driver session ends too,
  // and the driver (with its screen capture) stops once no other thread uses it.
  async function release(threadId: string) {
    for (const [key, holder] of busy) if (holder.threadId === threadId) busy.delete(key);
    const hostId = active.get(threadId);
    if (!hostId) return;
    active.delete(threadId);
    await host.call("release", { session: sessionFor(threadId) }, { hostId }).catch(() => {});
  }

  for (const event of ["thread.idle", "thread.failed"] as const)
    bb.events.on(event, ({ thread }) => release(thread.id));
  for (const event of ["thread.archived", "thread.deleted"] as const) {
    bb.events.on(event, async ({ thread }) => {
      await bb.storage.kv.delete(threadKey(thread.id));
      await release(thread.id);
    });
  }
}
