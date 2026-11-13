// Where the app's pieces live, which ports and folders to use, and each process's environment.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  APP_SURFACE_DESKTOP,
  APP_SURFACE_ENV_NAME,
  APP_SURFACE_WEB,
  parseAppSurface,
} from "@cloudroom/config/app-surface";
import {
  roomAppManagedEnvFileSchema,
  formatRoomAppConfigPath,
  formatRoomAppEnvPath,
  parseRoomAppManagedConfig,
  type RoomAppManagedConfig,
  type RoomAppManagedEnvFile,
} from "@cloudroom/config/app-managed-config";
import { parseServerBindHost, type ServerBindHost } from "@cloudroom/config/server";
import { toOptionalString } from "@cloudroom/config/strings";
import {
  ROOM_LOOPBACK_HOST,
  ROOM_PROD_HOST_DAEMON_PORT,
  ROOM_PROD_SERVER_PORT,
  applyPackagedDesktopRuntimeEnv,
  parseDataDirEnvValue,
  parsePortValue,
  resolveConfiguredDataDir,
  resolveDataDirDatabasePath,
  resolvePortFromEnv,
  resolveProdDataDir,
  stripThreadContextEnv,
} from "@cloudroom/config/runtime";

export interface AppContext {
  appDistDir: string;
  appVersion: string;
  daemonBundleDir: string;
  daemonEntry: string;
  daemonLockDir: string;
  daemonLockFile: string;
  daemonPort: number;
  dataDir: string;
  dbPath: string;
  envFile: string;
  logDir: string;
  serverEntry: string;
  serverPort: number;
  serverUrl: string;
}

export interface WorktreeRuntimePolicy {
  dataDir: string;
  hostDaemonPort: number;
  inheritedSkillsRoots: string;
  serverBindHost: ServerBindHost;
  serverPort: number;
}

export interface LauncherOptions {
  autoUpdate?: boolean;
  dataDir?: string;
  enrollKey?: string;
  help?: boolean;
  hostDaemonPort?: string;
  hostId?: string;
  joinCode?: string;
  serverBindHost?: string;
  serverPort?: string;
  serverUrl?: string;
}

export interface Runtime {
  context: AppContext;
  env: NodeJS.ProcessEnv;
  serverEnv: NodeJS.ProcessEnv;
}

export const DEV_VERSION = "0.0.0-dev";

export function parseLauncherArgs(args: string[]): {
  options: LauncherOptions;
  positionals: string[];
} {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    args,
    options: {
      "auto-update": { type: "boolean" },
      "data-dir": { type: "string" },
      "enroll-key": { type: "string" },
      "host-daemon-port": { type: "string" },
      "host-id": { type: "string" },
      "join-code": { type: "string" },
      "server-bind-host": { type: "string" },
      "server-port": { type: "string" },
      "server-url": { type: "string" },
      server: { type: "string" },
      help: { short: "h", type: "boolean" },
    },
  });
  const serverUrl = toOptionalString(values["server-url"]);
  const server = toOptionalString(values.server);
  if (serverUrl !== undefined && server !== undefined && serverUrl !== server) {
    throw new Error("--server-url and --server must match when both are set");
  }
  const options: LauncherOptions = {
    autoUpdate: values["auto-update"] === true || undefined,
    dataDir: toOptionalString(values["data-dir"]),
    enrollKey: toOptionalString(values["enroll-key"]),
    help: values.help === true || undefined,
    hostDaemonPort: toOptionalString(values["host-daemon-port"]),
    hostId: toOptionalString(values["host-id"]),
    joinCode: toOptionalString(values["join-code"]),
    serverBindHost: toOptionalString(values["server-bind-host"]),
    serverPort: toOptionalString(values["server-port"]),
    serverUrl: serverUrl ?? server,
  };
  for (const key of Object.keys(options) as (keyof LauncherOptions)[]) {
    if (options[key] === undefined) delete options[key];
  }
  return { options, positionals };
}

/** Command-line flags become the BB_* variables the server and daemon read. */
function envWithOptions(env: NodeJS.ProcessEnv, options: LauncherOptions): NodeJS.ProcessEnv {
  const next = { ...env };
  const set = (name: string, value: string | undefined): void => {
    if (value !== undefined) next[name] = value;
  };
  set("BB_DATA_DIR", options.dataDir);
  set("BB_HOST_DAEMON_AUTO_UPDATE", options.autoUpdate ? "1" : undefined);
  set("BB_HOST_DAEMON_PORT", options.hostDaemonPort);
  set("BB_SERVER_BIND_HOST", options.serverBindHost);
  set("BB_SERVER_PORT", options.serverPort);
  set("BB_SERVER_URL", options.serverUrl);
  set("BB_HOST_ID", options.hostId);
  set("BB_HOST_ENROLL_KEY", options.enrollKey ?? options.joinCode);
  return next;
}

export function resolveDataDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  return resolveConfiguredDataDir({
    defaultDataDir: resolveProdDataDir({ homeDir }),
    env,
    homeDir,
  });
}

export function readPackageVersion(packageRoot: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" && version.length > 0 ? version : DEV_VERSION;
  } catch {
    return DEV_VERSION;
  }
}

export function resolveContext(entrypointUrl: string, env: NodeJS.ProcessEnv, homeDir: string): AppContext {
  const entrypointDir = dirname(fileURLToPath(entrypointUrl));
  const packageRoot = resolve(entrypointDir, "..");
  const workspaceRoot = resolve(packageRoot, "..", "..");
  // From source (pnpm start) the entry is src/; from a build it is dist/.
  const fromSource = entrypointDir === resolve(packageRoot, "src");
  const built = (workspacePath: string, packagedPath: string): string =>
    fromSource ? resolve(workspaceRoot, workspacePath) : resolve(packageRoot, packagedPath);
  const dataDir = resolveDataDir(env, homeDir);
  const serverPort = resolvePortFromEnv({ defaultPort: ROOM_PROD_SERVER_PORT, env, name: "BB_SERVER_PORT" });
  const daemonPort = resolvePortFromEnv({ defaultPort: ROOM_PROD_HOST_DAEMON_PORT, env, name: "BB_HOST_DAEMON_PORT" });
  const unpackedAppDistDir = built("apps/app/dist", "app/dist");
  const daemonBundleDir = built("apps/host-daemon/dist", "host-daemon/dist");
  return {
    // The desktop app packs the web app inside app.asar; Electron's Node reads it there.
    appDistDir: existsSync(unpackedAppDistDir)
      ? unpackedAppDistDir
      : unpackedAppDistDir.replace(/app\.asar\.unpacked(?=[\\/])/u, "app.asar"),
    appVersion: readPackageVersion(packageRoot),
    daemonBundleDir,
    daemonEntry: resolve(daemonBundleDir, "daemon-bundle.mjs"),
    daemonLockDir: `${join(dataDir, "daemon.lock")}.lock`,
    daemonLockFile: join(dataDir, "daemon.lock"),
    daemonPort,
    dataDir,
    dbPath: resolveDataDirDatabasePath({ dataDir }),
    envFile: formatRoomAppEnvPath(dataDir),
    logDir: join(dataDir, "logs"),
    serverEntry: built("apps/server/dist/index.js", "server/dist/index.js"),
    serverPort,
    serverUrl: toOptionalString(env.BB_SERVER_URL) ?? `http://${ROOM_LOOPBACK_HOST}:${serverPort}`,
  };
}

async function readJsonFile<T>(path: string, label: string, parse: (value: unknown) => T, missing: T): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return missing;
    throw error;
  }
  try {
    return parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`Invalid ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const configWarnings = {
  warn(fields: Record<string, unknown>, message: string): void {
    process.stderr.write(`${message}: ${JSON.stringify(fields)}\n`);
  },
};

/** Settings saved in the data folder: config.json (written when a machine joins) and env.json. */
export async function readSavedSettings(dataDir: string): Promise<{ config: RoomAppManagedConfig; envFile: RoomAppManagedEnvFile }> {
  const config = await readJsonFile(formatRoomAppConfigPath(dataDir), "config", (value) =>
    parseRoomAppManagedConfig(value, { logger: configWarnings }), {});
  const envFile = await readJsonFile(formatRoomAppEnvPath(dataDir), "env", (value) =>
    roomAppManagedEnvFileSchema.parse(value), {});
  return { config, envFile };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined) throw new Error(`${name} is required for worktree startup`);
  return value;
}

/** `pnpm start -- --worktree`: each worktree gets its own ports and data, with telemetry off. */
export function resolveWorktreeRuntimePolicy(env: NodeJS.ProcessEnv, homeDir: string): WorktreeRuntimePolicy {
  return {
    dataDir: parseDataDirEnvValue({ homeDir, rawDataDir: requireEnv(env, "BB_DATA_DIR") }),
    hostDaemonPort: parsePortValue({ name: "BB_HOST_DAEMON_PORT", rawPort: requireEnv(env, "BB_HOST_DAEMON_PORT") }),
    inheritedSkillsRoots: requireEnv(env, "BB_INHERITED_SKILLS_ROOTS"),
    serverBindHost: parseServerBindHost(env.BB_SERVER_BIND_HOST ?? ROOM_LOOPBACK_HOST),
    serverPort: parsePortValue({ name: "BB_SERVER_PORT", rawPort: requireEnv(env, "BB_SERVER_PORT") }),
  };
}

function applyWorktreePolicy(env: NodeJS.ProcessEnv, policy: WorktreeRuntimePolicy): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {
    ...env,
    BB_DATA_DIR: policy.dataDir,
    BB_HOST_DAEMON_PORT: String(policy.hostDaemonPort),
    BB_INHERITED_SKILLS_ROOTS: policy.inheritedSkillsRoots,
    BB_SERVER_BIND_HOST: policy.serverBindHost,
    BB_SERVER_PORT: String(policy.serverPort),
    BB_TELEMETRY: "false",
  };
  delete next.BB_DEV_APP_PORT;
  return next;
}

/**
 * Works out folders, ports and environment. "local" runs the server here (desktop app, pnpm start);
 * "remote" talks to a server elsewhere (a joined machine's host daemon, room-cli).
 */
export async function resolveRuntime(args: {
  entrypointUrl: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  options: LauncherOptions;
  mode: "local" | "remote";
  worktreePolicy?: WorktreeRuntimePolicy | null;
}): Promise<Runtime> {
  const policy = args.worktreePolicy ?? null;
  const packagedDesktop =
    policy === null &&
    args.mode === "local" &&
    args.env.ELECTRON_RUN_AS_NODE === "1" &&
    args.env[APP_SURFACE_ENV_NAME] === APP_SURFACE_DESKTOP;
  const applyPolicy = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    if (policy !== null) return applyWorktreePolicy(env, policy);
    if (packagedDesktop) applyPackagedDesktopRuntimeEnv({ env, homeDir: args.homeDir, settingsEnv: args.env });
    return env;
  };
  const optionsEnv = envWithOptions(args.env, args.options);
  if (packagedDesktop) applyPolicy(optionsEnv);
  const { dataDir, serverUrl: defaultServerUrl } = resolveContext(args.entrypointUrl, optionsEnv, args.homeDir);
  const { config, envFile } = await readSavedSettings(dataDir);
  const saved = { ...config.config, ...envFile.env };
  const env = applyPolicy({ ...optionsEnv, ...saved });
  const serverEnv = stripThreadContextEnv(applyPolicy({
    ...optionsEnv,
    ...saved,
    ...(args.options.serverBindHost !== undefined ? { BB_SERVER_BIND_HOST: args.options.serverBindHost } : {}),
  }));
  if (args.mode === "local") {
    delete env.BB_SERVER_URL;
    delete serverEnv.BB_SERVER_URL;
  } else {
    env.BB_SERVER_URL =
      args.options.serverUrl ?? config.serverUrl ?? toOptionalString(env.BB_SERVER_URL) ?? defaultServerUrl;
  }
  return { context: resolveContext(args.entrypointUrl, env, args.homeDir), env, serverEnv };
}

const ARTIFACTS = {
  host: (c: AppContext) => [
    ["host daemon entry", c.daemonEntry],
    ["bundled room CLI", join(c.daemonBundleDir, "room-cli")],
    ["bundled room CLI chunks", join(c.daemonBundleDir, "room-cli-chunks"), "chunks"],
    ["provider bridge worker", join(c.daemonBundleDir, "bb-provider-bridge-worker.mjs")],
    ["parcel watcher child", join(c.daemonBundleDir, "bb-parcel-watcher-child.mjs")],
    ["plugin host worker", join(c.daemonBundleDir, "bb-plugin-host-worker.mjs")],
  ],
  app: (c: AppContext) => [
    ...ARTIFACTS.host(c),
    ["server entry", c.serverEntry],
    ["web app", join(c.appDistDir, "index.html")],
  ],
} as const;

function present(path: string, kind?: string): boolean {
  if (kind !== "chunks") return existsSync(path);
  try {
    return readdirSync(path).some((name) => name.endsWith(".js"));
  } catch {
    return false;
  }
}

/** Fails early, with the missing path, when the build is incomplete. */
export function assertArtifacts(context: AppContext, scope: "app" | "host"): void {
  for (const [label, path, kind] of ARTIFACTS[scope](context) as [string, string, string?][]) {
    if (!present(path, kind)) {
      throw new Error(`Missing ${label} at ${path}. Rebuild bb-app before running it.`);
    }
  }
}

export function createServerEnv(context: AppContext, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    BB_APP_VERSION: context.appVersion,
    [APP_SURFACE_ENV_NAME]: parseAppSurface(env[APP_SURFACE_ENV_NAME]) ?? APP_SURFACE_WEB,
    ROOM_CLI: join(context.daemonBundleDir, "room-cli"),
    ROOM_SERVER_URL: context.serverUrl,
    ROOM_DATA_DIR: context.dataDir,
    ROOM_HOST_DAEMON_PORT: String(context.daemonPort),
    BB_CLI_DIR: context.daemonBundleDir,
    BB_DATA_DIR: context.dataDir,
    BB_HOST_DAEMON_PORT: String(context.daemonPort),
    BB_SERVER_PORT: String(context.serverPort),
    NODE_ENV: "production",
  };
}

export function createDaemonEnv(context: AppContext, env: NodeJS.ProcessEnv, serverUrl: string): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {
    ...stripThreadContextEnv(env),
    BB_APP_VERSION: context.appVersion,
    BB_BRIDGE_DIR: context.daemonBundleDir,
    BB_CLI_DIR: context.daemonBundleDir,
    BB_DATA_DIR: context.dataDir,
    BB_HOST_DAEMON_PORT: String(context.daemonPort),
    BB_SERVER_URL: serverUrl,
    NODE_ENV: "production",
  };
  // The server's own credentials never reach the daemon.
  delete next.BB_SERVER_HEADERS;
  delete next.BB_CONNECT_MACHINE_CREDENTIAL;
  return next;
}

/** Shared by both processes when the launcher runs the whole app. */
export function createSharedEnv(context: AppContext, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...stripThreadContextEnv(env),
    BB_APP_VERSION: context.appVersion,
    BB_DATA_DIR: context.dataDir,
    BB_HOST_DAEMON_PORT: String(context.daemonPort),
    BB_SERVER_PORT: String(context.serverPort),
    NODE_ENV: "production",
  };
}

export function serverListenerUrl(bindHost: string | undefined, port: number): string {
  return `http://${parseServerBindHost(bindHost ?? ROOM_LOOPBACK_HOST)}:${String(port)}`;
}
