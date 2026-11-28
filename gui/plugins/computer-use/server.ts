import type {
  BbPluginApi,
  PluginCliContext,
  PluginCliResult,
  PluginInteractionResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  ACTIVE_CHANGED_CHANNEL,
  APPROVAL_RENDERER_ID,
  BROWSER_SETUP_RENDERER_ID,
  approvalResponseSchema,
  browserSetupResponseSchema,
  hostContract,
  rpcContract,
  type AppIdentity,
  type GrantedThread,
  type HostStatus,
} from "./contract.js";
import {
  BLOCKED_TOOLS,
  CLIPBOARD,
  ISOLATED_BROWSER,
  LIME_CURSOR_SUFFIX,
  PID_REQUIRED_TOOLS,
  WHOLE_SCREEN,
} from "./driver.js";

const APPROVAL_WAIT_MS = 90_000;
const APP_BUSY_MS = 60_000;

export const commands = [
  {
    name: "status",
    summary: "Show driver, macOS permission, browser control, and approval status",
    usage: "room-cli computer-use status [--json]",
  },
  {
    name: "setup",
    summary: "Ask macOS for permissions, or set up background browser control (--browser)",
    usage: "room-cli computer-use setup [--screen-recording | --browser]",
  },
  {
    name: "tools",
    summary: "List every Cua Driver tool, or describe one",
    usage: "room-cli computer-use tools [<tool>]",
  },
  {
    name: "call",
    summary: "Run one Cua Driver tool; Cloudroom asks the user once per thread",
    usage: "room-cli computer-use call <tool> ['<json-args>'] [--purpose <text>]",
  },
];

const threadHostSchema = z.object({
  host: z.object({ id: z.string() }).nullable().optional(),
  providerId: z.string().nullable().optional(),
  executionTarget: z.string().nullable().optional(),
});

export function decideGate(args: {
  tool: string;
  input: Record<string, unknown>;
}):
  | { kind: "free" }
  | { kind: "pid"; pid: number }
  | { kind: "name"; name: string }
  | { kind: "screen" }
  | { kind: "clipboard" }
  | { kind: "isolated_browser" }
  | { kind: "error"; message: string } {
  const { tool, input } = args;
  if (BLOCKED_TOOLS.has(tool))
    return { kind: "error", message: `${tool} is not available to agents in Cloudroom.` };
  if (tool === "browser_prepare" && input.allow_launch === true)
    return { kind: "isolated_browser" };
  if (tool === "launch_app") {
    const name = input.bundle_id ?? input.name;
    return typeof name === "string" && name
      ? { kind: "name", name }
      : { kind: "error", message: "launch_app needs bundle_id or name." };
  }
  if (tool === "get_desktop_state" || tool === "move_cursor") return { kind: "screen" };
  // The clipboard can hold passwords and tokens, and a write replaces what the user copied (#1960).
  if (tool === "clipboard_read" || tool === "clipboard_write")
    return { kind: "clipboard" };
  if (tool === "list_windows") return { kind: "free" };
  if (typeof input.pid === "number") return { kind: "pid", pid: input.pid };
  if (PID_REQUIRED_TOOLS.has(tool))
    return { kind: "error", message: `${tool} needs a pid so Cloudroom knows which app you are controlling. Find it with list_apps or list_windows.` };
  if (input.delivery_mode === "foreground") return { kind: "screen" };
  return { kind: "free" };
}

const CLOUDROOM_BUNDLE_ID = "dev.cloudroom.gui";

export function isCloudroomApp(key: string, selfBundleId?: string | null): boolean {
  const target = key.trim().toLowerCase();
  if (!target) return false;
  const ids = [CLOUDROOM_BUNDLE_ID];
  const extra = selfBundleId?.trim().toLowerCase();
  if (extra && extra !== "com.github.electron" && !ids.includes(extra)) ids.push(extra);
  return ids.some((id) => target === id || target.startsWith(`${id}.`));
}

const BROWSER_APP_RE =
  /^(?:com\.brave\.(?:browser|origin)|com\.google\.chrome|org\.chromium\.chromium|com\.microsoft\.edgemac|company\.thebrowser\.(?:browser|dia)|ai\.perplexity\.comet|com\.apple\.safari(?:technologypreview)?|org\.mozilla\.(?:firefox(?:developeredition)?|nightly)|com\.vivaldi\.vivaldi|com\.operasoftware\.opera(?:gx)?|app\.zen-browser\.zen|com\.kagi\.kagimacos|net\.imput\.helium)(?:$|\.)|^(?:brave|google-chrome|chrome|chromium|msedge|microsoft-edge|firefox|vivaldi|opera|zen)(?:[-.]|$)/i;
const NEW_BROWSER_WINDOW_MENU_RE = /^new\b.*\bwindow\b/i;

export function isBrowserApp(key: string): boolean {
  return BROWSER_APP_RE.test(key.trim());
}

function newTabShortcut(platform: string): string {
  return platform === "darwin" ? "cmd+t" : "ctrl+t";
}

function keyChordTokens(tool: string, input: Record<string, unknown>): string[] {
  if (tool === "hotkey" && Array.isArray(input.keys)) {
    return input.keys
      .filter((k): k is string => typeof k === "string")
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
  }
  if (tool === "press_key" && typeof input.key === "string") {
    const mods = Array.isArray(input.modifiers)
      ? input.modifiers.filter((m): m is string => typeof m === "string")
      : [];
    return [...mods, ...input.key.split("+")]
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

export function blockedBrowserAction(args: {
  tool: string;
  input: Record<string, unknown>;
  app: AppIdentity | null;
  platform: string;
}): string | null {
  const { tool, input, app, platform } = args;
  if (!app || !isBrowserApp(app.key)) return null;
  const tabHint = `Open a new tab in the existing ${app.name} window instead (browser-harness, File > New Tab, or ${newTabShortcut(platform)}).`;
  if (tool === "launch_app" && input.creates_new_application_instance === true)
    return `Refused to launch a second ${app.name} instance. ${tabHint}`;
  if (tool === "invoke_menu" && Array.isArray(input.path) && input.path.length > 0) {
    const last = input.path[input.path.length - 1];
    if (typeof last === "string" && NEW_BROWSER_WINDOW_MENU_RE.test(last.trim()))
      return `Refused to open a new ${app.name} window (${last.trim()}). ${tabHint}`;
  }
  const keys = keyChordTokens(tool, input);
  const primary =
    platform === "darwin"
      ? ["cmd", "command"]
      : platform === "linux"
        ? ["ctrl", "control"]
        : ["cmd", "command", "ctrl", "control"];
  if (keys.length >= 2 && keys.includes("n") && keys.some((m) => primary.includes(m)))
    return `Refused to open a new ${app.name} window (${keys.join("+")}). ${tabHint}`;
  return null;
}
const sessionFor = (threadId: string) => `cr-${threadId.slice(-24)}${LIME_CURSOR_SUFFIX}`;

function fail(code: string, message: string, exitCode = 1): PluginCliResult {
  return { exitCode, stdout: `${JSON.stringify({ error: code, message })}\n` };
}

// Cloudroom starts Cua Driver without --grant existing-profile, so it refuses the user's own browser profile (#1555).
function consentHint(platform: string) {
  return `Cloudroom doesn't let Cua Driver attach to the user's own browser profile. Use browser-harness, or open a new tab in the existing browser window (${newTabShortcut(platform)} / File > New Tab). Don't launch a separate browser instance unless the user asks.`;
}

function withConsentHint(stdout: string, platform: string) {
  if (!stdout.includes("browser_consent_required")) return stdout;
  try {
    const parsed = JSON.parse(stdout) as { refusal?: { code?: unknown } };
    if (parsed.refusal?.code !== "browser_consent_required") return stdout;
    return `${JSON.stringify({ ...parsed, hint: consentHint(platform) }, null, 2)}\n`;
  } catch {
    return stdout;
  }
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

type ApprovalOutcome =
  | { outcome: "submitted"; decision: "thread" | "deny" }
  | { outcome: "cancelled"; reason: string };

const grantedThreadInfoSchema = z.object({
  title: z.string().nullable().optional(),
  titleFallback: z.string().nullable().optional(),
  archivedAt: z.number().nullable().optional(),
  deletedAt: z.number().nullable().optional(),
});

const THREAD_GRANTED_PREFIX = "thread-granted/";

export default async function computerUsePlugin(room: BbPluginApi) {
  const host = room.hosts.experimental_client({ contract: hostContract });
  const pending = new Map<string, { settled: Promise<ApprovalOutcome>; startedAt: number }>();
  const pendingBrowserSetup = new Map<
    string,
    {
      request: Promise<PluginInteractionResult>;
      startedAt: number;
      controller: AbortController;
    }
  >();
  const track = (name: string, properties: Record<string, string | number | boolean | null>) =>
    room.experimental_telemetry.capture(name, { execution: "local", ...properties });
  const busy = new Map<string, { threadId: string; at: number }>();
  const active = new Map<string, { hostId: string; appName: string | null }>();
  const threadGrantedKey = (threadId: string) => `${THREAD_GRANTED_PREFIX}${encodeURIComponent(threadId)}`;
  const legacyThreadKey = (threadId: string) => `thread/${encodeURIComponent(threadId)}`;

  const activeSnapshot = () => ({
    active: [...active.entries()].map(([threadId, entry]) => ({
      threadId,
      appName: entry.appName,
    })),
  });
  const publishActive = () =>
    room.realtime.publish(ACTIVE_CHANGED_CHANNEL, activeSnapshot());
  const markActive = (threadId: string, hostId: string, appName: string | null) => {
    const prev = active.get(threadId);
    const nextApp = appName ?? prev?.appName ?? null;
    if (prev && prev.hostId === hostId && prev.appName === nextApp) return;
    active.set(threadId, { hostId, appName: nextApp });
    publishActive();
  };
  const clearActive = (hostId?: string) => {
    let changed = false;
    for (const [threadId, entry] of active) {
      if (hostId && entry.hostId !== hostId) continue;
      active.delete(threadId);
      changed = true;
    }
    if (changed) publishActive();
  };

  const isThreadGranted = async (threadId: string) =>
    (await room.storage.kv.get(threadGrantedKey(threadId))) === true;
  const grantThread = async (threadId: string) => {
    await room.storage.kv.set(threadGrantedKey(threadId), true);
  };
  const listGrantedThreads = async (): Promise<GrantedThread[]> => {
    const keys = await room.storage.kv.list(THREAD_GRANTED_PREFIX);
    const threads: GrantedThread[] = [];
    for (const key of keys) {
      if ((await room.storage.kv.get(key)) !== true) continue;
      let threadId: string;
      try {
        threadId = decodeURIComponent(key.slice(THREAD_GRANTED_PREFIX.length));
      } catch {
        continue;
      }
      if (!threadId) continue;
      try {
        const parsed = grantedThreadInfoSchema.safeParse(
          await room.sdk.threads.get({ threadId }),
        );
        if (parsed.success && (parsed.data.archivedAt != null || parsed.data.deletedAt != null)) {
          await room.storage.kv.delete(key);
          continue;
        }
        const title = parsed.success
          ? parsed.data.title?.trim() || parsed.data.titleFallback?.trim() || threadId
          : threadId;
        threads.push({ threadId, title });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        if (/\b404\b|not found|does not exist/i.test(message)) {
          await room.storage.kv.delete(key);
          continue;
        }
        threads.push({ threadId, title: threadId });
      }
    }
    return threads.sort((a, b) => a.title.localeCompare(b.title));
  };

  // A Cloud thread gets here only through Mac access (`room-cli mac computer-use` in its sandbox), so it uses this
  // computer as itself: its sidebar highlight, approval card, and app locks work as for a Local thread.
  async function threadInfo(threadId: string) {
    const thread = threadHostSchema.parse(await room.sdk.threads.get({ threadId, include: "host" }));
    const cloud = !thread.host && thread.executionTarget === "cloud";
    return {
      hostId: thread.host?.id ?? (cloud ? await localHostId(true) : null),
      provider: thread.providerId ?? null,
      cloud,
    };
  }

  // `thisComputer`: never another connected machine, which a Cloud thread's call must not control.
  async function localHostId(thisComputer = false) {
    const hosts = z
      .array(z.object({ id: z.string(), status: z.string(), machineProviderId: z.string().nullable().optional() }))
      .parse(await room.sdk.hosts.list());
    return (
      hosts.find((entry) => entry.status === "connected" && !entry.machineProviderId)?.id ??
      (thisComputer ? null : hosts.find((entry) => entry.status === "connected")?.id) ??
      null
    );
  }

  async function settings(hostId?: string | null) {
    const id = hostId === undefined ? await localHostId() : hostId;
    let status: HostStatus | null = null;
    let error: string | null = null;
    if (id) {
      try {
        status = await host.call("status", { includeBrowser: true }, { hostId: id });
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
    } else error = "No connected machine.";
    return { hostId: id, status, error, grantedThreads: await listGrantedThreads() };
  }

  async function identify(hostId: string, gate: ReturnType<typeof decideGate>) {
    if (gate.kind === "pid") return host.call("appForPid", { pid: gate.pid }, { hostId });
    if (gate.kind === "name") return host.call("appForName", { name: gate.name }, { hostId });
    if (gate.kind === "screen") return { ...WHOLE_SCREEN };
    if (gate.kind === "clipboard") return { ...CLIPBOARD };
    if (gate.kind === "isolated_browser") return { ...ISOLATED_BROWSER };
    return null;
  }

  // One approval per thread covers all apps, dialogs, clipboard, screen, and foreground focus.
  // Persistence runs on the interaction promise itself so clicks after the 90s CLI wait are never lost.
  async function approveThread(args: {
    threadId: string;
    app: AppIdentity;
    tool: string;
    purpose: string | null;
    status: HostStatus;
  }): Promise<PluginCliResult | null> {
    const { threadId, app } = args;
    if (await isThreadGranted(threadId)) return null;
    let entry = pending.get(threadId);
    if (!entry) {
      const startedAt = Date.now();
      const request = room.ui.requestInput({
        threadId,
        rendererId: APPROVAL_RENDERER_ID,
        title: "Allow this thread to use Computer Use?",
        payload: {
          app,
          tool: args.tool,
          purpose: args.purpose,
          platform: args.status.platform,
          permissions: args.status.permissions,
        },
        timeoutMs: 60 * 60_000,
      });
      const settled = request.then(async (result): Promise<ApprovalOutcome> => {
        if (result.outcome === "cancelled") {
          track("computer_use_approval", {
            app: app.key,
            tool: args.tool,
            decision: `cancelled_${result.reason}`,
            wait_ms: Date.now() - startedAt,
          });
          return { outcome: "cancelled", reason: result.reason };
        }
        const { decision: rawDecision } = approvalResponseSchema.parse(result.value);
        const decision = rawDecision === "always" ? "thread" : rawDecision;
        if (decision === "thread") await grantThread(threadId);
        track("computer_use_approval", {
          app: app.key,
          tool: args.tool,
          decision,
          wait_ms: Date.now() - startedAt,
        });
        return { outcome: "submitted", decision };
      });
      entry = { settled, startedAt };
      pending.set(threadId, entry);
      void settled
        .finally(() => {
          if (pending.get(threadId) === entry) pending.delete(threadId);
        })
        .catch(() => {});
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      entry.settled,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), APPROVAL_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    if (outcome === null) {
      track("computer_use_approval", {
        app: app.key,
        tool: args.tool,
        decision: "pending",
        wait_ms: Date.now() - entry.startedAt,
      });
      return fail(
        "approval_pending",
        "Cloudroom is asking the user to allow Computer Use in this thread. Tell the user, then run the same command again. Do not end your turn.",
        3,
      );
    }
    if (outcome.outcome === "cancelled") {
      return fail(
        "approval_cancelled",
        `The request to use Computer Use was cancelled (${outcome.reason}).`,
      );
    }
    if (outcome.decision === "deny") {
      return fail(
        "app_denied",
        "The user denied Computer Use access in this thread. Do not retry; ask the user what to do instead.",
      );
    }
    return null;
  }

  async function runCall(
    argv: string[],
    ctx: PluginCliContext,
    threadId: string,
    hostId: string,
    seen: { app: string | null },
    cloud: boolean,
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
    if (gate.kind === "name" && !app)
      return fail(
        "app_not_installed",
        `macOS doesn't know an app "${gate.name}". Check the bundle ID or name. An app inside another app (like Simulator in Xcode) may need one \`open <path to the .app>\` first, then retry.`,
      );
    if (gate.kind !== "free" && !app) return fail("app_not_found", "No running app has that pid.");
    seen.app = app?.key ?? null;
    if (app && isCloudroomApp(app.key, status.selfBundleId))
      return fail(
        "app_blocked",
        "Computer use cannot control Cloudroom itself.",
      );
    const browserBlocked = blockedBrowserAction({ tool, input, app, platform: status.platform });
    if (browserBlocked) return fail("new_browser_window_blocked", browserBlocked);
    // Clipboard (NSPasteboard, #1960) and isolated_browser (CDP launch) need approval,
    // not macOS Accessibility or a shared-app lock.
    const control = gate.kind !== "clipboard" && gate.kind !== "isolated_browser";
    if (app) {
      const holder = busy.get(app.key);
      if (
        control &&
        holder &&
        holder.threadId !== threadId &&
        Date.now() - holder.at < APP_BUSY_MS
      )
        return fail(
          "app_busy",
          `${app.name} is being used by @thread:${holder.threadId}. Wait a minute or pick another app.`,
        );
      const blocked = await approveThread({ threadId, app, tool, purpose, status });
      if (blocked) return blocked;
    }
    if (app && control) busy.set(app.key, { threadId, at: Date.now() });
    if (
      app &&
      control &&
      (await host.call("status", {}, { hostId })).permissions.accessibility ===
        false
    )
      return fail(
        "permissions_missing",
        "Cloudroom needs macOS Accessibility permission. Ask the user to grant it in Settings > Plugins > Computer Use (or run `room-cli computer-use setup` while they watch), then retry.",
      );
    if (tool !== "end_session") markActive(threadId, hostId, app?.name ?? null);
    const session = sessionFor(threadId);
    const shotsKey = threadId.replace(/[^A-Za-z0-9_-]/g, "_");
    const result = await host.call(
      "call",
      { tool, args: input, session, shotsKey, ...(cloud ? { inline: true as const } : {}) },
      { hostId, timeoutMs: 150_000, ...(ctx.signal ? { signal: ctx.signal } : {}) },
    );
    if (tool === "end_session") {
      for (const [key, holder] of busy) if (holder.threadId === threadId) busy.delete(key);
      if (active.delete(threadId)) publishActive();
    }
    if (result.driverExits > 0) track("computer_use_crash", { component: "driver", count: result.driverExits });
    return {
      exitCode: result.exitCode,
      stdout: withConsentHint(result.stdout, status.platform),
      stderr: result.stderr,
    };
  }

  async function trackedCall(
    argv: string[],
    ctx: PluginCliContext,
    threadId: string,
    hostId: string,
    provider: string | null,
    cloud: boolean,
  ) {
    const startedAt = Date.now();
    const seen: { app: string | null } = { app: null };
    let result: PluginCliResult;
    try {
      result = await runCall(argv, ctx, threadId, hostId, seen, cloud);
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

  async function runBrowserSetup(threadId: string, hostId: string): Promise<PluginCliResult> {
    const initial = await host.call(
      "status",
      { includeBrowser: true },
      { hostId, timeoutMs: 30_000 },
    );
    const browserControl = initial.browserControl;
    const pendingKey = `${threadId}\0browser-setup`;
    const clearPendingCard = () => {
      const stale = pendingBrowserSetup.get(pendingKey);
      if (!stale) return;
      pendingBrowserSetup.delete(pendingKey);
      stale.controller.abort();
    };
    if (!browserControl) {
      clearPendingCard();
      return fail("unsupported", "This host does not report browser control status yet. Update Cloudroom and retry.");
    }
    if (!browserControl.supported) {
      clearPendingCard();
      return fail(
        "unsupported",
        browserControl.reason ??
          `${browserControl.browserName} doesn't support background browser control. Use Chrome, Brave, Edge, Arc, Dia, or Comet.`,
      );
    }
    if (browserControl.ready) {
      clearPendingCard();
      return { exitCode: 0, stdout: `${JSON.stringify({ ready: true, browserControl }, null, 2)}\n` };
    }
    let entry = pendingBrowserSetup.get(pendingKey);
    if (!entry) {
      const controller = new AbortController();
      const request = room.ui.requestInput(
        {
          threadId,
          rendererId: BROWSER_SETUP_RENDERER_ID,
          title: `Set up browser control (${browserControl.browserName})`,
          payload: {
            platform: initial.platform,
            browserControl,
          },
          timeoutMs: 60 * 60_000,
        },
        { signal: controller.signal },
      );
      entry = { request, startedAt: Date.now(), controller };
      pendingBrowserSetup.set(pendingKey, entry);
      void request
        .finally(() => {
          if (pendingBrowserSetup.get(pendingKey) === entry) pendingBrowserSetup.delete(pendingKey);
        })
        .catch(() => {});
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      entry.request,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), APPROVAL_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    if (result === null) {
      return fail(
        "setup_pending",
        `Cloudroom is showing the Browser control setup card for ${browserControl.browserName}. Tell the user to finish the steps and click Check & retry, then run \`room-cli computer-use setup --browser\` again. Do not end your turn.`,
        3,
      );
    }
    if (result.outcome === "cancelled") {
      return fail("setup_cancelled", `Browser control setup was cancelled (${result.reason}).`);
    }
    const parsed = browserSetupResponseSchema.parse(result.value);
    if (parsed.action === "dismiss") {
      track("computer_use_setup", { step: "browser_control", ok: false, decision: "dismiss" });
      return fail("setup_dismissed", "The user dismissed browser control setup. Ask what they want to do instead.");
    }
    const next = await host.call(
      "status",
      { includeBrowser: true },
      { hostId, timeoutMs: 30_000 },
    );
    const ready = Boolean(next.browserControl?.ready);
    track("computer_use_setup", { step: "browser_control", ok: ready, decision: "retry" });
    return {
      exitCode: ready ? 0 : 1,
      stdout: `${JSON.stringify({ ready, browserControl: next.browserControl ?? null }, null, 2)}\n`,
    };
  }

  async function runCli(argv: string[], ctx: PluginCliContext): Promise<PluginCliResult> {
    const threadId = ctx.threadId;
    if (!threadId) return fail("no_thread", "Run this from a Cloudroom thread (ROOM_THREAD_ID is not set).");
    const { hostId, provider, cloud } = await threadInfo(threadId);
    if (!hostId) return fail("no_host", "This thread has no connected computer to control.");
    switch (argv[0]) {
      case "status": {
        const current = await settings(hostId);
        const allowed = await isThreadGranted(threadId);
        return { exitCode: 0, stdout: `${JSON.stringify({ ...current, allowedInThisThread: allowed }, null, 2)}\n` };
      }
      case "setup": {
        if (argv.includes("--browser")) return runBrowserSetup(threadId, hostId);
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
        return trackedCall(argv, ctx, threadId, hostId, provider, cloud);
      default:
        return fail("usage", "Usage: room-cli computer-use status | setup [--screen-recording | --browser] | tools [<tool>] | call <tool> ['<json>']");
    }
  }

  room.agents.configure(() => ({ tools: [], skills: ["computer-use"] }));
  room.cli.register({
    name: "computer-use",
    summary: "See and control desktop apps, with one approval per thread",
    commands,
    async run(argv, ctx) {
      try {
        return await runCli(argv, ctx);
      } catch (error) {
        return fail("error", error instanceof Error ? error.message : String(error));
      }
    },
  });

  room.rpc.register(rpcContract, {
    getActive: () => activeSnapshot(),
    getSettings: () => settings(),
    async revokeThread({ threadId }) {
      await room.storage.kv.delete(threadGrantedKey(threadId));
      await room.storage.kv.delete(legacyThreadKey(threadId));
      await release(threadId);
      return settings();
    },
    async requestPermission({ kind }) {
      const hostId = await localHostId();
      if (hostId) {
        const next = await host.call("requestPermission", { kind }, { hostId, timeoutMs: 60_000 });
        if (kind === "fullDiskAccess") {
          track("computer_use_setup", { step: "full_disk_access_opened" });
        } else {
          reportPermissions("permission_request", next);
        }
      }
      return settings(hostId);
    },
    async openBrowserInspect() {
      const hostId = await localHostId();
      if (hostId) {
        await host.call("openBrowserInspect", {}, { hostId, timeoutMs: 30_000 });
      }
      return settings(hostId);
    },
    async restart() {
      const hostId = await localHostId();
      if (hostId) {
        clearActive(hostId);
        await host.call("restart", {}, { hostId });
      }
      return settings(hostId);
    },
  });

  host.experimental_onWorkerExit(() => {
    clearActive();
    track("computer_use_crash", { component: "host_worker" });
  });

  // Computer use lasts one turn: when it ends, the thread's driver session ends too,
  // and the driver (with its screen capture) stops once no other thread uses it.
  async function release(threadId: string) {
    for (const [key, holder] of busy) if (holder.threadId === threadId) busy.delete(key);
    const entry = active.get(threadId);
    if (!entry) return;
    active.delete(threadId);
    publishActive();
    await host.call("release", { session: sessionFor(threadId) }, { hostId: entry.hostId }).catch(() => {});
  }

  for (const event of ["thread.idle", "thread.failed"] as const)
    room.events.on(event, ({ thread }) => release(thread.id));
  for (const event of ["thread.archived", "thread.deleted"] as const) {
    room.events.on(event, async ({ thread }) => {
      await room.storage.kv.delete(threadGrantedKey(thread.id));
      await room.storage.kv.delete(legacyThreadKey(thread.id));
      await release(thread.id);
    });
  }
}
