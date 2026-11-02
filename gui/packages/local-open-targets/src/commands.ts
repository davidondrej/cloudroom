import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkspaceOpenTarget } from "@cloudroom/host-daemon-contract";
import { pathExists } from "@cloudroom/process-utils";
import {
  APPS,
  targetPathFor,
  type App,
  type Bundled,
  type Command,
} from "./apps.js";
import {
  fail,
  hasExecutable,
  hasSystemExecutable,
  type ExistingPath,
  type Invocation,
  type Location,
  type SshRequest,
  type WorkspaceOpenTargetRuntime,
} from "./system.js";

type Runtime = WorkspaceOpenTargetRuntime;
type Resolved = Omit<Invocation, "args"> & { argsPrefix: string[] };

export async function findBundlePaths(
  bundleId: string,
  runtime: Runtime,
): Promise<string[]> {
  const literal = `'${bundleId.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  try {
    const result = await runtime.execFile("mdfind", [
      `kMDItemCFBundleIdentifier == ${literal}`,
    ]);
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

export async function findBundleApp(
  bundleId: string,
  runtime: Runtime,
): Promise<string | null> {
  const paths = await findBundlePaths(bundleId, runtime);
  return paths.find((candidate) => candidate.endsWith(".app")) ?? null;
}

async function findToolboxApp(app: App, runtime: Runtime) {
  const toolbox = app.mac?.toolbox;
  if (toolbox === undefined) return null;
  const home = runtime.env?.HOME ?? os.homedir();
  const queue = [
    {
      directory: path.join(
        home,
        "Library/Application Support/JetBrains/Toolbox/apps",
      ),
      depth: 0,
    },
  ];
  for (let current = queue.shift(); current; current = queue.shift()) {
    if (current.depth > 5) continue;
    const entries = await fs
      .readdir(current.directory, { withFileTypes: true })
      .catch(() => []);
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryPath = path.join(current.directory, entry.name);
      const name = entry.name.toLowerCase();
      if (
        name.endsWith(".app") &&
        name.startsWith(toolbox.prefix) &&
        (await pathExists(path.join(entryPath, "Contents/MacOS", toolbox.exe)))
      ) {
        return entryPath;
      }
      queue.push({ directory: entryPath, depth: current.depth + 1 });
    }
  }
  return null;
}

export async function findAppPath(
  app: App,
  runtime: Runtime,
): Promise<string | null> {
  if (app.mac === undefined) return null;
  for (const bundleId of app.mac.bundleIds) {
    const found = await findBundleApp(bundleId, runtime);
    if (found) return found;
  }
  const candidates = [app.mac.name, ...(app.mac.otherNames ?? [])].flatMap(
    (name) =>
      runtime.applicationDirectories.map((directory) =>
        path.join(directory, `${name}.app`),
      ),
  );
  const exists = await Promise.all(candidates.map(pathExists));
  const index = exists.findIndex(Boolean);
  return index === -1 ? findToolboxApp(app, runtime) : candidates[index]!;
}

async function resolveBundled(
  app: App,
  bundled: Bundled,
  runtime: Runtime,
): Promise<Resolved | null> {
  const appPath = await findAppPath(app, runtime);
  if (appPath === null) return null;
  const file = path.join(appPath, ...bundled.path);
  if (!(await pathExists(file))) return null;
  for (const required of bundled.requires ?? []) {
    if (!(await pathExists(path.join(appPath, ...required)))) return null;
  }
  return {
    file,
    argsPrefix: bundled.argsPrefix?.(appPath) ?? [],
    env: bundled.env?.(runtime.env) ?? runtime.env,
  };
}

export async function resolveCommand(
  app: App,
  command: Command,
  runtime: Runtime,
): Promise<Resolved | null> {
  for (const candidate of [command, ...(command.fallbacks ?? [])]) {
    const system = candidate.exe === "open" || candidate.exe === "osascript";
    const found = system
      ? await hasSystemExecutable(candidate.exe, runtime)
      : await hasExecutable(candidate.exe, runtime);
    if (found) {
      return {
        file: candidate.exe,
        argsPrefix: [],
        ...(system ? {} : { env: runtime.env }),
      };
    }
    if (candidate.bundled !== undefined) {
      const resolved = await resolveBundled(app, candidate.bundled, runtime);
      if (resolved !== null) return resolved;
    }
  }
  return null;
}

export async function lineInvocation(
  app: App,
  existing: ExistingPath,
  at: Location,
  runtime: Runtime,
): Promise<Invocation | null> {
  if (at.lineNumber === null || existing.type !== "file" || !app.line) {
    return null;
  }
  const command = await resolveCommand(app, app.line, runtime);
  if (command === null) return null;
  return {
    file: command.file,
    args: [
      ...command.argsPrefix,
      ...app.line.args({
        columnNumber: app.line.column ? at.columnNumber : null,
        lineNumber: at.lineNumber,
        path: existing.path,
      }),
    ],
    env: command.env,
  };
}

export async function pathInvocation(
  app: App,
  existing: ExistingPath,
  runtime: Runtime,
): Promise<Invocation | null> {
  if (!app.open) return null;
  const command = await resolveCommand(app, app.open, runtime);
  if (command === null) return null;
  return {
    file: command.file,
    args: [
      ...command.argsPrefix,
      ...app.open.args(targetPathFor(app, existing)),
    ],
    env: command.env,
  };
}

export async function canOpenOverSsh(app: App, runtime: Runtime) {
  if (!app.ssh) return false;
  for (const exe of app.ssh.requires ?? []) {
    if (!(await hasExecutable(exe, runtime))) return false;
  }
  return (await resolveCommand(app, app.ssh, runtime)) !== null;
}

export async function sshInvocation(
  app: App,
  request: SshRequest,
  runtime: Runtime,
): Promise<Invocation> {
  const ssh =
    app.ssh ??
    fail(
      "remote_target_unsupported",
      `${app.label} cannot open remote SSH paths`,
    );
  const unavailable = (exe: string) =>
    fail(
      "target_unavailable",
      `${app.label} remote SSH opener is unavailable: ${exe}`,
    );
  for (const exe of ssh.requires ?? []) {
    if (!(await hasExecutable(exe, runtime))) unavailable(exe);
  }
  const command =
    (await resolveCommand(app, ssh, runtime)) ?? unavailable(ssh.exe);
  return {
    file: command.file,
    args: [
      ...command.argsPrefix,
      ...ssh.args({
        columnNumber: ssh.caps.openFileAtColumn ? request.columnNumber : null,
        lineNumber: ssh.caps.openFileAtLine ? request.lineNumber : null,
        path: request.path,
        sshAuthority: request.sshAuthority,
      }),
    ],
    env: command.env,
  };
}

export const appTarget = (app: App): WorkspaceOpenTarget => ({
  id: app.id,
  label: app.label,
  kind: app.kind,
  icon: app.icon,
  capabilities: app.caps,
});

const cliExecutable = (app: App) =>
  app.mac === undefined ? null : (app.open?.exe ?? app.line?.exe ?? null);

export async function hasCli(app: App, runtime: Runtime): Promise<boolean> {
  const exe = cliExecutable(app);
  return exe !== null && (await hasExecutable(exe, runtime));
}

export async function listCliTargets(
  runtime: Runtime,
): Promise<WorkspaceOpenTarget[]> {
  const targets = await Promise.all(
    APPS.map(async (app) =>
      (await hasCli(app, runtime))
        ? {
            ...appTarget(app),
            ...(app.ssh ? { remoteSshCapabilities: app.ssh.caps } : {}),
          }
        : null,
    ),
  );
  return targets.filter((target) => target !== null);
}

export async function cliInvocation(
  app: App,
  existing: ExistingPath,
  at: Location,
  runtime: Runtime,
): Promise<Invocation> {
  return (
    (await lineInvocation(app, existing, at, runtime)) ??
    (await pathInvocation(app, existing, runtime)) ??
    fail(
      "target_unavailable",
      `Workspace open target is unavailable: ${app.label}`,
    )
  );
}
