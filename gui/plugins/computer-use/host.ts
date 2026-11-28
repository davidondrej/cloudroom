import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  constants,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import {
  experimental_defineHostEntry,
  type ExperimentalHostRpcContext,
  type ExperimentalHostWorkerLease,
} from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import { hostContract, type AppIdentity, type HostStatus } from "./contract.js";
import { inspectBrowserControl, openBrowserInspectPage } from "./browser-control.js";
import { DRIVER, SESSION_TOOLS, assetFor } from "./driver.js";

const run = promisify(execFile);
const IDLE_STOP_MS = 2 * 60_000;

type Paths = ExperimentalHostRpcContext["experimental_paths"];

// GNOME on Wayland hides app windows from Cua until its WinRects extension is on.
function isGnomeWayland() {
  return (
    process.platform === "linux" &&
    process.env.XDG_SESSION_TYPE === "wayland" &&
    /gnome/i.test(process.env.XDG_CURRENT_DESKTOP ?? "")
  );
}

// Cua blocks WinRects on GNOME Shells its metadata doesn't list (50+ crashed sessions), so offer it
// only on a Shell that metadata lists. Not installed: install first. Installed without metadata: unknown.
export function unsupportedGnomeHint(shellVersion: string, metadata: string | null, installed: boolean) {
  if (!installed)
    return `GNOME on Wayland may hide app windows from Cua. Whether its "cua WinRects" helper supports this GNOME Shell is unknown until the driver is installed: run \`room-cli computer-use tools\` once to install it, then check \`status\` again.`;
  let supported: unknown;
  try {
    supported = metadata && JSON.parse(metadata)["shell-version"];
  } catch {}
  if (!Array.isArray(supported))
    return `Cua's "cua WinRects" helper metadata is missing, so whether it supports this GNOME Shell is unknown and app windows may be hidden. Don't install or enable it.`;
  const major = /GNOME Shell (\d+)/.exec(shellVersion)?.[1];
  if (major && supported.includes(major)) return null;
  return `Cua's "cua WinRects" helper supports only GNOME Shell ${supported.join(", ")}, and this is GNOME Shell ${major ?? "of unknown version"}, so app windows may be hidden and window capture limited. Don't install or enable it: Cua blocks it on newer GNOME after it crashed desktop sessions.`;
}

export function driverEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
    CUA_DRIVER_RS_UPDATE_CHECK: "false",
  };
  // The driver reads the desktop name to avoid claiming a screen reader on GNOME, which starts Orca.
  const keys = ["DISPLAY", "WAYLAND_DISPLAY", "CUA_DRIVER_RS_ENABLE_WAYLAND", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "TMPDIR"];
  for (const key of [...keys, "XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP", "DESKTOP_SESSION"])
    if (process.env[key]) env[key] = process.env[key];
  return env;
}

// HOME is private, so X11 needs XAUTHORITY for its cookie (#2450). But a set XAUTHORITY stops
// the driver finding the cookie itself, so pass it only if the local X server accepts its cookie.
export function workingXauthority(display = process.env.DISPLAY, file = process.env.XAUTHORITY, socketDir = "/tmp/.X11-unix") {
  return new Promise<string | undefined>((resolve) => {
    let socket: Socket | undefined;
    let settled = false;
    const done = (ok: boolean) => {
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(ok ? file : undefined);
    };
    const timer = setTimeout(() => done(false), 2_000);
    const number = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(display ?? "")?.[1];
    void (async () => {
      const cookie = number && file ? await readCookie(file, number) : undefined;
      if (!cookie || settled) return done(false);
      const name = Buffer.from("MIT-MAGIC-COOKIE-1");
      const setup = Buffer.alloc(12 + 20 + cookie.length + (-cookie.length & 3));
      setup.write("l");
      setup.writeUInt16LE(11, 2);
      setup.writeUInt16LE(name.length, 6);
      setup.writeUInt16LE(cookie.length, 8);
      name.copy(setup, 12);
      cookie.copy(setup, 32);
      socket = connect(join(socketDir, `X${number}`));
      socket.once("connect", () => socket?.write(setup));
      socket.once("data", (reply) => done(reply[0] === 1));
      for (const event of ["error", "end", "close"]) socket.once(event, () => done(false));
    })().catch(() => done(false));
  });
}

// The cookie the X client would pick, or nothing if the file is not a small, fully valid Xauthority file.
async function readCookie(file: string, number: string) {
  if (!(await stat(file)).isFile()) return undefined;
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  let data: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64 * 1024) return undefined;
    data = await handle.readFile();
  } finally {
    await handle.close();
  }
  // Entries: a 2-byte family, then address, display number, auth name and cookie, each length-prefixed.
  let at = 0;
  const field = () => {
    const end = at + 2 + data.readUInt16BE(at);
    if (end > data.length) throw new RangeError("truncated Xauthority entry");
    const value = data.subarray(at + 2, end);
    at = end;
    return value;
  };
  let cookie: Buffer | undefined;
  while (at < data.length) {
    const family = data.readUInt16BE(at);
    at += 2;
    const [address, entryNumber, name, value] = [field(), field(), field(), field()];
    const host = family === 0xffff || (family === 256 && address.toString() === hostname());
    if (!cookie && host && [number, ""].includes(entryNumber.toString()) && name.toString() === "MIT-MAGIC-COOKIE-1")
      cookie = value;
  }
  return cookie;
}

async function exists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function sha256(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

// GitHub's release download sometimes answers 5xx for a while (#1242). Other 4xx answers are final.
async function download(url: string, archive: string, signal: AbortSignal, delays: number[]) {
  let failure = "";
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt) await sleep(delays[attempt - 1], undefined, { signal });
    let status = 0;
    try {
      const response = await fetch(url, { signal });
      if (response.ok && response.body)
        return await pipeline(Readable.fromWeb(response.body as never), createWriteStream(archive));
      status = response.status;
    } catch (error) {
      // Network failures are TypeErrors; local file errors (ENOSPC, EACCES...) carry a syscall.
      if (signal.aborted || (error as NodeJS.ErrnoException).syscall) throw error;
    }
    failure = status ? `HTTP ${status}` : "network error";
    if (status && status < 500 && status !== 408 && status !== 429)
      throw new Error(`Cua Driver download failed (${failure})`);
  }
  throw new Error(
    `Cua Driver download failed (${failure}) after ${delays.length + 1} tries. GitHub's download server is having trouble; nothing was installed. Try again in a few minutes.`,
  );
}

export async function pruneOldVersions(dir: string) {
  const parent = dirname(dir);
  const current = basename(dir);
  const entries = await readdir(parent).catch(() => []);
  await Promise.all(
    entries
      .filter((name) => name !== current && !name.startsWith(".install-"))
      .map((name) => rm(join(parent, name), { recursive: true, force: true }).catch(() => {})),
  );
}

export async function install(dir: string, signal: AbortSignal, delays = [2_000, 5_000, 15_000]) {
  const asset = assetFor(process.platform, process.arch);
  if (!asset) throw new Error(`Computer use is not available on ${process.platform}-${process.arch}`);
  await mkdir(join(dir, ".."), { recursive: true });
  const stage = await mkdtemp(join(dir, "..", ".install-"));
  try {
    const archive = join(stage, "driver.tar.gz");
    await download(`${DRIVER.releaseUrl}/${asset.file}`, archive, signal, delays);
    if ((await sha256(archive)) !== asset.sha256)
      throw new Error("Cua Driver download failed its checksum; nothing was installed");
    const extra = process.platform === "linux" ? ["wayland-helper"] : [];
    await run("tar", ["-xzf", archive, "-C", stage, "cua-driver", ...extra], { signal });
    const binary = join(stage, "cua-driver");
    if (process.platform === "darwin") {
      await run("/usr/bin/codesign", ["--verify", "--strict", binary], { signal });
      const { stderr } = await run("/usr/bin/codesign", ["-dv", binary], { signal });
      if (!stderr.includes(`TeamIdentifier=${DRIVER.macTeamId}`))
        throw new Error("Cua Driver is not signed by Cua AI; nothing was installed");
    }
    const { stdout } = await run(binary, ["--version"], { signal, env: driverEnv(stage) });
    if (stdout.trim() !== `cua-driver ${DRIVER.version}`)
      throw new Error(`Unexpected Cua Driver version: ${stdout.trim()}`);
    await rm(archive);
    await writeFile(join(stage, "verified.json"), JSON.stringify({ sha256: await sha256(binary) }));
    await rm(dir, { recursive: true, force: true });
    await rename(stage, dir);
    await pruneOldVersions(dir);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function osascript(
  script: string,
  env?: NodeJS.ProcessEnv,
  options?: { timeout?: number; signal?: AbortSignal },
) {
  const { stdout } = await run(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", script],
    {
      timeout: options?.timeout ?? 15_000,
      env,
      signal: options?.signal,
    },
  );
  return stdout.trim();
}

// Cua Driver finds a launch_app name only as <name>.app in these folders (apps/mod.rs
// locate_by_name; its other two are under its private HOME). A bundle_id goes to LaunchServices.
const APP_ROOTS = [
  "/Applications",
  "/System/Applications",
  "/System/Applications/Utilities",
  "/Applications/Utilities",
];

// The app macOS knows by this bundle ID, or else by this name (as AppleScript finds it), so apps
// nested in another app, such as Simulator in Xcode, resolve too. Null when macOS doesn't know it.
async function resolveApp(ref: string): Promise<AppIdentity | null> {
  const app = JSON.parse(
    await osascript(`ObjC.import("AppKit");
(() => {
  const ws = $.NSWorkspace.sharedWorkspace, ref = ${JSON.stringify(ref)};
  const urlFor = (id) => { const u = ws.URLForApplicationWithBundleIdentifier(id); return u && !u.isNil() ? u : null; };
  let url = urlFor(ref);
  if (!url) try { url = urlFor(Application(ref).id()); } catch (e) {}
  const bundle = url && $.NSBundle.bundleWithURL(url);
  if (!bundle || bundle.isNil() || bundle.bundleIdentifier.isNil()) return "{}";
  const name = $.NSFileManager.defaultManager.displayNameAtPath(url.path).js.replace(/\\.app$/, "");
  return JSON.stringify({ key: bundle.bundleIdentifier.js, name });
})()`),
  ) as Partial<AppIdentity>;
  return app.key ? { key: app.key, name: app.name || app.key } : null;
}

// A name the driver can't find (#975) goes to it as the bundle ID macOS knows. Paths stay (#914).
async function withBundleId(args: Record<string, unknown>) {
  const name = args.name;
  if (process.platform !== "darwin" || typeof args.bundle_id === "string")
    return;
  if (typeof name !== "string" || !name || name.includes("/")) return;
  const file = name.endsWith(".app") ? name : `${name}.app`;
  const roots = APP_ROOTS.map((root) => exists(join(root, file)));
  if ((await Promise.all(roots)).some(Boolean)) return;
  const app = await resolveApp(name);
  if (app) args.bundle_id = app.key;
}

// Cua Driver's own cold launch (platform-macos apps/nsworkspace.rs, tools/launch_app.rs):
// NSWorkspace in the background with an `oapp` event so the app opens its window, then the
// prior frontmost app gets focus back whenever the new app takes it (registered + 1.5 s).
function launchScript(app: string, byName: boolean) {
  return `ObjC.import("AppKit");
(() => {
  const ws = $.NSWorkspace.sharedWorkspace, ref = ${JSON.stringify(app)};
  const trimmed = ref.replace(/\\/+$/, "");
  const file = trimmed.endsWith(".app") ? trimmed : trimmed + ".app";
  const roots = ${JSON.stringify(APP_ROOTS)};
  const hasSlash = ${byName} && trimmed.includes("/");
  const path = hasSlash
    ? (trimmed.startsWith("/") && trimmed.endsWith(".app") && $.NSFileManager.defaultManager.fileExistsAtPath(trimmed) ? trimmed : undefined)
    : ${byName}
      ? roots.map((root) => root + "/" + file).find((p) => $.NSFileManager.defaultManager.fileExistsAtPath(p))
      : undefined;
  const url = path ? $.NSURL.fileURLWithPath(path) : hasSlash ? null : ws.URLForApplicationWithBundleIdentifier(ref);
  const bundle = url && !url.isNil() ? $.NSBundle.bundleWithURL(url) : null;
  const bid = bundle && !bundle.isNil() && bundle.bundleIdentifier && !bundle.bundleIdentifier.isNil() ? bundle.bundleIdentifier.js : "";
  if (!url || url.isNil() || !bid) return "not_found";
  if (bid === "com.trycua.driver" || bid === "com.trycua.driver.local") return "protected";
  const live = () => {
    const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bid);
    if (!apps || apps.isNil()) return false;
    for (let i = 0; i < apps.count; i++) if (!apps.objectAtIndex(i).isTerminated) return true;
    return false;
  };
  if (live()) return "running";
  // JXA can hand back JS null for a nil result.
  const frontApp = () => { try { const a = ws.frontmostApplication; return a && !a.isNil() ? a : null; } catch (e) { return null; } };
  const idOf = (a) => { try { const b = a && a.bundleIdentifier; return b && !b.isNil() ? b.js : ""; } catch (e) { return ""; } };
  const prior = frontApp();
  const config = $.NSWorkspaceOpenConfiguration.configuration;
  config.setActivates(false);
  config.setAddsToRecentItems(false);
  const target = $.NSAppleEventDescriptor.descriptorWithBundleIdentifier(bid);
  config.setAppleEvent($.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(0x61657674, 0x6f617070, target, -1, 0));
  // A null handler aborts osascript when LaunchServices calls it from another thread.
  ws.openApplicationAtURLConfigurationCompletionHandler(url, config, (app, error) => {});
  let up = 0;
  for (const deadline = Date.now() + 10000; Date.now() < (up ? up + 1500 : deadline); ) {
    const next = Date.now() + 50;
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
    if (Date.now() < next) delay((next - Date.now()) / 1000);
    if (prior && idOf(frontApp()) === bid) prior.activateWithOptions(0);
    if (!up && live()) up = Date.now();
  }
  return up && live() ? "launched" : up ? "exited" : "timeout";
})()`;
}

type PrelaunchResult = { ok: true } | { ok: false; message: string };

function prelaunchErrorDetail(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return "cancelled";
  const err = error as {
    killed?: boolean;
    stderr?: string;
    message?: string;
    code?: unknown;
  };
  if (err.killed) return "launcher timed out";
  const stderr = err.stderr?.trim();
  if (stderr) return stderr;
  if (
    error instanceof Error &&
    !error.message.includes("osascript -l JavaScript")
  )
    return error.message;
  return typeof err.code === "number"
    ? `launcher exited with code ${err.code}`
    : "launcher failed";
}

// An app the driver cold-starts inherits the driver's private HOME (#942), so the host starts
// it first the driver's way, but with the user's own HOME; the driver's launch_app then finds
// it running. If prelaunch fails or cannot confirm the app is running, return an error instead
// of letting the driver cold-start it with its private HOME (#2745). Inspector ports, new
// instances and extra arguments need the driver's own launch, so those keep the private HOME.
// Never pass process.env: it has ELECTRON_RUN_AS_NODE, which breaks Electron apps.
async function openWithUserHome(
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<PrelaunchResult> {
  const byName = typeof args.bundle_id !== "string";
  const app = byName ? args.name : args.bundle_id;
  const extra = args.additional_arguments;
  const hasInspectorPort =
    typeof args.webkit_inspector_port === "number" &&
    Number.isInteger(args.webkit_inspector_port) &&
    args.webkit_inspector_port >= 0;
  if (
    process.platform !== "darwin" ||
    typeof app !== "string" ||
    !app ||
    hasInspectorPort ||
    args.creates_new_application_instance === true ||
    (Array.isArray(extra) && extra.some((arg) => typeof arg === "string"))
  )
    return { ok: true };
  let outcome: string;
  try {
    outcome = await osascript(launchScript(app, byName), driverEnv(homedir()), {
      timeout: 20_000,
      signal,
    });
  } catch (error) {
    return {
      ok: false,
      message: `Could not confirm "${app}" started with your home folder (${prelaunchErrorDetail(error, signal)}). Refused to fall back to Cua Driver's private profile.`,
    };
  }
  if (outcome === "running" || outcome === "launched") return { ok: true };
  if (outcome === "timeout") {
    return {
      ok: false,
      message: `Timed out waiting for "${app}" to start with your home folder. Refused to fall back to Cua Driver's private profile.`,
    };
  }
  if (outcome === "exited") {
    return {
      ok: false,
      message: `"${app}" exited before startup could be confirmed with your home folder. Refused to fall back to Cua Driver's private profile.`,
    };
  }
  if (outcome === "protected") {
    return {
      ok: false,
      message: `launch_app cannot launch "${app}" because it is a protected Cua Driver bundle.`,
    };
  }
  if (outcome === "not_found" || outcome === "skip") {
    return {
      ok: false,
      message: `Could not locate "${app}" to start it with your home folder. Refused to fall back to Cua Driver's private profile.`,
    };
  }
  return {
    ok: false,
    message: `Could not confirm "${app}" started with your home folder (unexpected prelaunch result: ${JSON.stringify(outcome)}). Refused to fall back to Cua Driver's private profile.`,
  };
}

async function readPermissions(): Promise<HostStatus["permissions"]> {
  if (process.platform !== "darwin") return { accessibility: null, screenRecording: null };
  const result = JSON.parse(
    await osascript(
      'ObjC.import("ApplicationServices"); ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]); JSON.stringify({accessibility: $.AXIsProcessTrusted(), screenRecording: $.CGPreflightScreenCaptureAccess()})',
    ),
  ) as HostStatus["permissions"];
  return result;
}

async function saveImages(stdout: string, shotsDir: string) {
  if (!stdout.includes("_b64")) return stdout;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      stdout.replace(
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
      ),
    );
  } catch {
    return stdout;
  }
  const writes: { file: string; data: Buffer }[] = [];
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const match = /^(.*)_(png|jpeg|jpg)_b64$/.exec(key);
      if (match && typeof entry === "string") {
        const file = join(shotsDir, `${match[1]}-${randomUUID().slice(0, 8)}.${match[2] === "png" ? "png" : "jpg"}`);
        writes.push({ file, data: Buffer.from(entry, "base64") });
        out[`${match[1]}_file`] = file;
      } else out[key] = visit(entry);
    }
    return out;
  };
  const result = visit(parsed);
  if (writes.length === 0) return stdout;
  await mkdir(shotsDir, { recursive: true, mode: 0o700 });
  await Promise.all(writes.map(({ file, data }) => writeFile(file, data, { mode: 0o600 })));
  return JSON.stringify(result, null, 2);
}

// Drivers whose Cloudroom died (parent is now launchd), e.g. from builds that piped stderr.
async function reapOrphans() {
  if (process.platform === "win32") return;
  const { stdout } = await run("/bin/ps", ["-axo", "pid=,ppid=,command="]);
  for (const line of stdout.split("\n")) {
    const [, pid, ppid, command] = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line) ?? [];
    if (ppid === "1" && command?.includes("/host-data/cua-driver/") && command.includes(" serve --socket "))
      process.kill(Number(pid), "SIGKILL");
  }
}

type DriverCallResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

// Cua Driver's exact bring_to_front checks WindowServer visibility and AX focus, not macOS Space
// membership (#1625), and marks a call unverified whenever any same-app layer-0 window sits above
// the target, even an untitled 41 px Chrome helper (#1506). Reconcile exact bring_to_front results
// with an immediate list_windows read inside the same host call:
// - Never report activation when list_windows shows the target on another Space (on_current_space:
//   false) or off screen; return a recoverable off-Space or unverified failure instead.
// - When unverified only because untitled <100 px layer-0 helpers of the same app sit above a
//   focused, on-screen target on the current Space, report it as activated.
// Like the driver's own verified result, this is a snapshot: another app's window may sit above
// the target, and focus or the active Space can change after the check.
const exactBringToFrontSchema = z
  .object({
    status: z.string().optional(),
    code: z.enum([
      "bring_to_front_exact_window_verified",
      "bring_to_front_exact_window_unverified",
    ]),
    pid: z.number(),
    window_id: z.number(),
    exact_window_effect: z.record(z.string(), z.unknown()).optional(),
    observed: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const focusedWindowSchema = z
  .object({
    code: z.literal("bring_to_front_exact_window_unverified"),
    pid: z.number(),
    window_id: z.number(),
    process_activated: z.literal(true),
    exact_window_effect: z
      .object({
        focused: z.literal(true),
        target_visible_ordinary: z.literal(true),
      })
      .passthrough(),
    observed: z
      .object({
        front_process_matches_target: z.literal(true),
        focused_window_id: z.number(),
        process_front_window_on_display: z.number(),
      })
      .passthrough(),
  })
  .passthrough();
const listedWindowsSchema = z.object({
  current_space_id: z.number().nullable().optional(),
  windows: z.array(
    z.object({
      window_id: z.number(),
      pid: z.number(),
      title: z.string(),
      layer: z.number().optional(),
      z_index: z.number().nullable().optional(),
      is_on_screen: z.boolean().optional(),
      on_current_space: z.boolean().nullable().optional(),
      current_space_id: z.number().nullable().optional(),
      space_ids: z.array(z.number()).nullable().optional(),
      bounds: z.object({ width: z.number(), height: z.number() }),
    }),
  ),
});

function clearOnScreenEffects(effect: Record<string, unknown> | undefined) {
  return {
    target_visible_ordinary: false,
    ...(effect && "front_in_process_on_display" in effect
      ? { front_in_process_on_display: false }
      : {}),
    ...(effect && "frontmost_ordinary" in effect
      ? { frontmost_ordinary: false }
      : {}),
    ...(effect && "unobstructed" in effect ? { unobstructed: false } : {}),
  };
}

export async function reconcileBringToFront(
  tool: string,
  input: Record<string, unknown>,
  result: DriverCallResult,
  listWindows: (pid: number) => Promise<DriverCallResult>,
): Promise<DriverCallResult> {
  if (tool !== "bring_to_front" || typeof input.window_id !== "number") {
    return result;
  }
  try {
    const parsed = exactBringToFrontSchema.parse(JSON.parse(result.stdout));
    if (parsed.pid !== input.pid || parsed.window_id !== input.window_id) {
      return result;
    }
    const verified = parsed.code === "bring_to_front_exact_window_verified";
    if (verified !== (result.exitCode === 0)) return result;
    const listed = await listWindows(parsed.pid);
    if (listed.exitCode !== 0) return result;
    const { windows, current_space_id } = listedWindowsSchema.parse(
      JSON.parse(listed.stdout),
    );
    const target = windows.find(
      (w) => w.window_id === parsed.window_id && w.pid === parsed.pid,
    );
    if (target?.on_current_space === false) {
      const offSpace = {
        ...parsed,
        status: parsed.status === "failed" ? "failed" : "partial",
        activated: false,
        code: "bring_to_front_window_off_space",
        exact_window_effect: {
          ...parsed.exact_window_effect,
          ...(target.is_on_screen === false
            ? clearOnScreenEffects(parsed.exact_window_effect)
            : {}),
          verified: false,
          on_current_space: false,
        },
        observed: {
          ...parsed.observed,
          on_current_space: false,
          ...(target.is_on_screen !== undefined
            ? { is_on_screen: target.is_on_screen }
            : {}),
          current_space_id: target.current_space_id ?? current_space_id ?? null,
          space_ids: target.space_ids ?? null,
        },
        message:
          "bring_to_front: target window is still on another macOS Space (on_current_space=false), so foreground activation is not verified and foreground input may fail or end incomplete. Stay in the background, use browser-harness for Chromium browsers, or ask the user to move the window to the current Space.",
      };
      return {
        ...result,
        exitCode: 1,
        stdout: `${JSON.stringify(offSpace, null, 2)}\n`,
      };
    }
    if (verified) {
      if (target?.is_on_screen !== false) return result;
      const offScreen = {
        ...parsed,
        status: "partial",
        activated: false,
        code: "bring_to_front_exact_window_unverified",
        exact_window_effect: {
          ...parsed.exact_window_effect,
          ...clearOnScreenEffects(parsed.exact_window_effect),
          verified: false,
        },
        observed: { ...parsed.observed, is_on_screen: false },
        message:
          "bring_to_front: target window is not on screen immediately after activation, so foreground activation is not verified.",
      };
      return {
        ...result,
        exitCode: 1,
        stdout: `${JSON.stringify(offScreen, null, 2)}\n`,
      };
    }
    const focused = focusedWindowSchema.parse(parsed);
    if (focused.observed.focused_window_id !== input.window_id) return result;
    if (
      target?.is_on_screen !== true ||
      (target.layer ?? 0) !== 0 ||
      typeof target.z_index !== "number"
    ) {
      return result;
    }
    const targetZ = target.z_index;
    const above = windows.filter(
      (w) =>
        w.pid === focused.pid &&
        w.is_on_screen !== false &&
        (w.layer ?? 0) === 0 &&
        typeof w.z_index === "number" &&
        w.z_index > targetZ,
    );
    const helper = (w: (typeof windows)[number]) =>
      !w.title &&
      Math.min(w.bounds.width, w.bounds.height) < 100 &&
      w.on_current_space !== false;
    if (
      !above.some(
        (w) => w.window_id === focused.observed.process_front_window_on_display,
      ) ||
      !above.every(helper)
    ) {
      return result;
    }
    const accepted = {
      ...focused,
      status: "activated",
      activated: true,
      code: "bring_to_front_exact_window_focused",
    };
    return {
      ...result,
      exitCode: 0,
      stdout: `${JSON.stringify(accepted, null, 2)}\n`,
    };
  } catch {
    return result;
  }
}

export function createHostEntry() {
  let daemon: ChildProcess | null = null;
  let socket: string | null = null;
  let installing: Promise<void> | null = null;
  let verified = false;
  let lastUsed = 0;
  let installMs: number | null = null;
  let driverExits = 0;
  let lease: ExperimentalHostWorkerLease | null = null;
  let paths: Paths | null = null;
  const sessions = new Set<string>();
  // Sessions ended at a turn's end while another thread kept the driver running.
  const ended = new Set<string>();

  const dir = () => join(paths!.dataDir, "cua-driver", DRIVER.version);
  const binary = () => join(dir(), "cua-driver");
  const home = () => join(paths!.dataDir, "home");

  function unsupported(): string | null {
    if (process.platform === "win32") return "Computer use isn't available on Windows yet.";
    if (!assetFor(process.platform, process.arch))
      return `Computer use is not available on ${process.platform}-${process.arch}.`;
    if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
      return "This Linux machine has no desktop session (DISPLAY is not set).";
    return null;
  }

  async function waylandHint(installed: boolean) {
    if (!paths || !isGnomeWayland()) return null;
    const helper = join(dir(), "wayland-helper");
    const shell = await run("gnome-shell", ["--version"], { timeout: 5_000 }).catch(() => ({ stdout: "" }));
    const metadata = await readFile(join(helper, "winrects@cua", "metadata.json"), "utf8").catch(() => null);
    const unsupported = unsupportedGnomeHint(shell.stdout, metadata, installed);
    if (unsupported) return unsupported;
    const { stdout } = await run("gnome-extensions", ["info", "winrects@cua"], { timeout: 5_000 }).catch(() => ({ stdout: "" }));
    if (/State:\s*(ACTIVE|ENABLED)/.test(stdout)) return null;
    return `GNOME on Wayland hides app windows until the "cua WinRects" GNOME extension is on. With the user's OK, run ${join(helper, "install.sh")} (no sudo needed), then ask them to log out and back in once.`;
  }

  function selfBundleId(): string | null {
    if (process.platform !== "darwin") return null;
    const id = process.env.__CFBundleIdentifier?.trim();
    if (!id || id.toLowerCase() === "com.github.electron") return "dev.cloudroom.gui";
    return id;
  }

  async function status(includeBrowser = false): Promise<HostStatus> {
    const reason = unsupported();
    // One install snapshot for both fields, so the hint never contradicts `installed`.
    const installed = paths !== null && (await exists(join(dir(), "verified.json")));
    const [permissions, browserControl, hint] = await Promise.all([
      readPermissions().catch(() => ({ accessibility: null, screenRecording: null })),
      includeBrowser ? inspectBrowserControl().catch(() => undefined) : Promise.resolve(undefined),
      waylandHint(installed),
    ]);
    return {
      platform: process.platform,
      supported: reason === null,
      reason,
      version: DRIVER.version,
      installed,
      running: daemon !== null && daemon.exitCode === null,
      permissions,
      ...(browserControl ? { browserControl } : {}),
      hint,
      selfBundleId: selfBundleId(),
    };
  }

  async function ensureInstalled(signal: AbortSignal) {
    if (verified) return;
    const record = join(dir(), "verified.json");
    const helperMissing = isGnomeWayland() && !(await exists(join(dir(), "wayland-helper")));
    if (!helperMissing && (await exists(record))) {
      const expected = (JSON.parse(await readFile(record, "utf8")) as { sha256: string }).sha256;
      if ((await sha256(binary()).catch(() => "")) === expected) {
        verified = true;
        return;
      }
    }
    const started = Date.now();
    installing ??= install(dir(), signal)
      .then(() => {
        installMs = Date.now() - started;
      })
      .finally(() => {
        installing = null;
      });
    await installing;
    verified = true;
  }

  function stopDaemon() {
    const child = daemon;
    child?.kill("SIGTERM");
    setTimeout(() => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 3_000).unref();
    sessions.clear();
    ended.clear();
    daemon = null;
    socket = null;
    void lease?.dispose();
    lease = null;
  }

  async function reachable(path: string) {
    return new Promise<boolean>((resolve) => {
      const client = connect(path);
      client.once("connect", () => {
        client.end();
        resolve(true);
      });
      client.once("error", () => resolve(false));
    });
  }

  async function ensureDaemon(context: ExperimentalHostRpcContext) {
    const reason = unsupported();
    if (reason) throw new Error(reason);
    await ensureInstalled(context.lifecycle.signal);
    lastUsed = Date.now();
    if (daemon && daemon.exitCode === null && socket) return socket;
    await mkdir(home(), { recursive: true });
    const socketDir = await mkdtemp(join(tmpdir(), "crcu-"));
    const path = join(socketDir, "d.sock");
    const args = ["serve", "--socket", path];
    if (process.platform === "darwin")
      args.push("--embedded", "--host-bundle-id", process.env.__CFBundleIdentifier ?? "dev.cloudroom.gui");
    // stderr must be a file: when Cloudroom dies, the driver logs its shutdown, and a
    // broken stderr pipe kept it running forever (with screen capture on).
    const logFile = join(home(), "driver.log");
    const log = await open(logFile, "w");
    const xauthority = process.platform === "linux" ? await workingXauthority() : undefined;
    const child = spawn(binary(), args, {
      env: { ...driverEnv(home()), ...(xauthority && { XAUTHORITY: xauthority }), CUA_DRIVER_PARENT_LIVENESS_STDIN: "1" },
      stdio: ["pipe", "ignore", log.fd],
    });
    await log.close();
    child.stdin?.on("error", () => {});
    child.once("exit", () => {
      if (daemon !== child) return;
      driverExits++;
      stopDaemon();
      void rm(socketDir, { recursive: true, force: true });
    });
    daemon = child;
    socket = path;
    lease ??= context.experimental_retainWorker();
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) break;
      if (await reachable(path)) return path;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    stopDaemon();
    const tail = (await readFile(logFile, "utf8").catch(() => "")).slice(-2000);
    throw new Error(`Cua Driver did not start. ${tail.trim()}`.trim());
  }

  const timer = setInterval(() => {
    if (daemon && Date.now() - lastUsed > IDLE_STOP_MS) stopDaemon();
  }, 30_000);
  timer.unref();
  void reapOrphans().catch(() => {});

  return experimental_defineHostEntry({
    contract: hostContract,
    handlers: {
      async status(input, context) {
        paths = context.experimental_paths;
        return status(input.includeBrowser === true);
      },
      async prepare(_input, context) {
        paths = context.experimental_paths;
        if (!unsupported()) await ensureInstalled(context.lifecycle.signal);
        const reported = installMs;
        installMs = null;
        return { ...(await status()), installMs: reported };
      },
      async call(input, context) {
        paths = context.experimental_paths;
        sessions.add(input.session);
        const path = await ensureDaemon(context);
        // A running driver keeps an ended label, and only start_session revives it (#1597).
        if (ended.delete(input.session)) {
          const start = JSON.stringify({ session: input.session });
          const argv = ["call", "--socket", path, "start_session", start];
          const env = driverEnv(home());
          await run(binary(), argv, { env, timeout: 10_000 }).catch(() => {});
        }
        const args: Record<string, unknown> = { ...input.args };
        if (SESSION_TOOLS.has(input.tool) && args.session === undefined) args.session = input.session;
        if (input.tool === "launch_app") {
          await withBundleId(args).catch(() => {});
          const prelaunch = await openWithUserHome(args, context.signal);
          if (!prelaunch.ok) {
            lastUsed = Date.now();
            const exits = driverExits;
            driverExits = 0;
            return {
              exitCode: 1,
              stdout: `${JSON.stringify({ error: "launch_failed", message: prelaunch.message })}\n`,
              stderr: "",
              driverExits: exits,
            };
          }
        }
        const runTool = (
          tool: string,
          toolArgs: Record<string, unknown>,
          timeout: number,
        ) =>
          run(
            binary(),
            ["call", "--socket", path, tool, JSON.stringify(toolArgs)],
            {
              env: driverEnv(home()),
              timeout,
              maxBuffer: 32 * 1024 * 1024,
              signal: context.signal,
            },
          ).then(
            ({ stdout, stderr }) => ({ exitCode: 0, stdout, stderr }),
            (error: {
              code?: unknown;
              stdout?: string;
              stderr?: string;
              message: string;
            }) => ({
              exitCode: typeof error.code === "number" ? error.code : 1,
              stdout: error.stdout ?? "",
              stderr: error.stderr || error.message,
            }),
          );
        const raw = await runTool(input.tool, args, 120_000);
        const result = await reconcileBringToFront(
          input.tool,
          args,
          raw,
          (pid) => runTool("list_windows", { pid }, 30_000),
        );
        lastUsed = Date.now();
        const exits = driverExits;
        driverExits = 0;
        const shotsDir = join(tmpdir(), "cloudroom-computer-use", input.shotsKey);
        const stdout = input.inline ? result.stdout : await saveImages(result.stdout, shotsDir);
        return { ...result, stdout, driverExits: exits };
      },
      async release({ session }) {
        if (!sessions.delete(session) || !daemon || !socket) return null;
        if (sessions.size === 0) stopDaemon();
        else {
          ended.add(session);
          await run(binary(), ["call", "--socket", socket, "end_session", JSON.stringify({ session })], {
            env: driverEnv(home()),
            timeout: 10_000,
          }).catch(() => {});
        }
        return null;
      },
      async describe(input, context) {
        paths = context.experimental_paths;
        await ensureInstalled(context.lifecycle.signal);
        const args = input.tool ? ["describe", input.tool] : ["list-tools"];
        const { stdout } = await run(binary(), args, { env: driverEnv(home()), timeout: 30_000 });
        return stdout;
      },
      async appForPid({ pid }) {
        if (process.platform === "darwin") {
          const { stdout } = await run("/usr/bin/lsappinfo", ["info", "-only", "bundleid", "-only", "name", String(pid)], {
            timeout: 10_000,
          }).catch(() => ({ stdout: "" }));
          const key = /"CFBundleIdentifier"\s*=\s*"([^"]+)"/.exec(stdout)?.[1];
          const name = /"LSDisplayName"\s*=\s*"([^"]+)"/.exec(stdout)?.[1];
          if (key) return { key, name: name ?? key };
          const app = JSON.parse(
            await osascript(
              `ObjC.import("AppKit"); const a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); JSON.stringify(a.isNil() ? {} : {key: a.bundleIdentifier.js, name: a.localizedName.js})`,
            ),
          ) as { key?: string; name?: string };
          return app.key ? { key: app.key, name: app.name ?? app.key } : null;
        }
        const name = (await readFile(`/proc/${pid}/comm`, "utf8").catch(() => "")).trim();
        return name ? { key: name, name } : null;
      },
      async appForName({ name }) {
        if (process.platform !== "darwin") return { key: name, name };
        return resolveApp(name).catch(() => ({ key: name, name }));
      },
      async requestPermission({ kind }, context) {
        paths = context.experimental_paths;
        if (process.platform !== "darwin") return status();
        if (kind === "fullDiskAccess") {
          await run("/usr/bin/open", [
            "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
          ]).catch(() => {});
          return status(true);
        }
        if (kind === "accessibility")
          await osascript('ObjC.import("ApplicationServices"); $.AXIsProcessTrustedWithOptions($({AXTrustedCheckOptionPrompt: true}))');
        else
          await osascript('ObjC.bindFunction("CGRequestScreenCaptureAccess", ["bool", []]); $.CGRequestScreenCaptureAccess()');
        const pane = kind === "accessibility" ? "Privacy_Accessibility" : "Privacy_ScreenCapture";
        await run("/usr/bin/open", [`x-apple.systempreferences:com.apple.preference.security?${pane}`]).catch(() => {});
        stopDaemon();
        return status();
      },
      async openBrowserInspect(_input, context) {
        paths = context.experimental_paths;
        const current = await status(true);
        if (current.browserControl) {
          await openBrowserInspectPage(current.browserControl).catch(() => {});
        }
        return current;
      },
      async restart(_input, context) {
        paths = context.experimental_paths;
        stopDaemon();
        return status();
      },
    },
    dispose() {
      clearInterval(timer);
      stopDaemon();
    },
  });
}

export default createHostEntry();
