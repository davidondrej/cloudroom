import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import {
  experimental_defineHostEntry,
  type ExperimentalHostRpcContext,
  type ExperimentalHostWorkerLease,
} from "@get-bb/plugin-sdk/host";
import { hostContract, type HostStatus } from "./contract.js";
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

function driverEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
    CUA_DRIVER_RS_UPDATE_CHECK: "false",
  };
  // The driver reads the desktop name to avoid claiming a screen reader on GNOME, which starts Orca.
  const keys = ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "TMPDIR"];
  for (const key of [...keys, "XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP", "DESKTOP_SESSION"])
    if (process.env[key]) env[key] = process.env[key];
  return env;
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

async function install(dir: string, signal: AbortSignal) {
  const asset = assetFor(process.platform, process.arch);
  if (!asset) throw new Error(`Computer use is not available on ${process.platform}-${process.arch}`);
  await mkdir(join(dir, ".."), { recursive: true });
  const stage = await mkdtemp(join(dir, "..", ".install-"));
  try {
    const archive = join(stage, "driver.tar.gz");
    const response = await fetch(`${DRIVER.releaseUrl}/${asset.file}`, { signal });
    if (!response.ok || !response.body)
      throw new Error(`Cua Driver download failed (HTTP ${response.status})`);
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(archive));
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
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function osascript(script: string) {
  const { stdout } = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
    timeout: 15_000,
  });
  return stdout.trim();
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

  async function waylandHint() {
    if (!paths || !isGnomeWayland()) return null;
    const { stdout } = await run("gnome-extensions", ["info", "winrects@cua"], { timeout: 5_000 }).catch(() => ({ stdout: "" }));
    if (/State:\s*(ACTIVE|ENABLED)/.test(stdout)) return null;
    return `GNOME on Wayland hides app windows until the "cua WinRects" GNOME extension is on. With the user's OK, run ${join(dir(), "wayland-helper", "install.sh")} (no sudo needed), then ask them to log out and back in once.`;
  }

  async function status(): Promise<HostStatus> {
    const reason = unsupported();
    return {
      platform: process.platform,
      supported: reason === null,
      reason,
      version: DRIVER.version,
      installed: paths !== null && (await exists(join(dir(), "verified.json"))),
      running: daemon !== null && daemon.exitCode === null,
      permissions: await readPermissions().catch(() => ({ accessibility: null, screenRecording: null })),
      hint: await waylandHint(),
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
    const child = spawn(binary(), args, {
      env: { ...driverEnv(home()), CUA_DRIVER_PARENT_LIVENESS_STDIN: "1" },
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
      async status(_input, context) {
        paths = context.experimental_paths;
        return status();
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
        const args: Record<string, unknown> = { ...input.args };
        if (SESSION_TOOLS.has(input.tool) && args.session === undefined) args.session = input.session;
        const result = await run(binary(), ["call", "--socket", path, input.tool, JSON.stringify(args)], {
          env: driverEnv(home()),
          timeout: 120_000,
          maxBuffer: 32 * 1024 * 1024,
          signal: context.signal,
        }).then(
          ({ stdout, stderr }) => ({ exitCode: 0, stdout, stderr }),
          (error: { code?: unknown; stdout?: string; stderr?: string; message: string }) => ({
            exitCode: typeof error.code === "number" ? error.code : 1,
            stdout: error.stdout ?? "",
            stderr: error.stderr || error.message,
          }),
        );
        lastUsed = Date.now();
        const exits = driverExits;
        driverExits = 0;
        return { ...result, stdout: await saveImages(result.stdout, input.shotsDir), driverExits: exits };
      },
      async release({ session }) {
        if (!sessions.delete(session) || !daemon || !socket) return null;
        if (sessions.size === 0) stopDaemon();
        else
          await run(binary(), ["call", "--socket", socket, "end_session", JSON.stringify({ session })], {
            env: driverEnv(home()),
            timeout: 10_000,
          }).catch(() => {});
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
        if (process.platform === "darwin") {
          const ask = (script: string) =>
            run("/usr/bin/osascript", ["-e", script], { timeout: 10_000 }).then(
              ({ stdout }) => stdout.trim(),
              () => "",
            );
          const label = await ask(`name of application id ${JSON.stringify(name)}`);
          if (label) return { key: name, name: label };
          const key = await ask(`id of application ${JSON.stringify(name)}`);
          if (key) return { key, name };
        }
        return { key: name, name };
      },
      async requestPermission({ kind }, context) {
        paths = context.experimental_paths;
        if (process.platform !== "darwin") return status();
        if (kind === "accessibility")
          await osascript('ObjC.import("ApplicationServices"); $.AXIsProcessTrustedWithOptions($({AXTrustedCheckOptionPrompt: true}))');
        else
          await osascript('ObjC.bindFunction("CGRequestScreenCaptureAccess", ["bool", []]); $.CGRequestScreenCaptureAccess()');
        const pane = kind === "accessibility" ? "Privacy_Accessibility" : "Privacy_ScreenCapture";
        await run("/usr/bin/open", [`x-apple.systempreferences:com.apple.preference.security?${pane}`]).catch(() => {});
        stopDaemon();
        return status();
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
