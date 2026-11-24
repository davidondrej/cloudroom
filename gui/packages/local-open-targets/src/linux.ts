import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceOpenTarget } from "@cloudroom/host-daemon-contract";
import {
  BASIC,
  FULL,
  fail,
  hasExecutable,
  isWsl,
  type ExistingPath,
  type Invocation,
  type Location,
  type SshRequest,
  type WorkspaceOpenTargetRuntime,
} from "./system.js";
import { localShellArgs, remoteSshArgs } from "./terminal.js";

type Runtime = WorkspaceOpenTargetRuntime;

interface DesktopApp {
  id: string;
  file: string;
  exec: string;
  label: string;
}

export const DESKTOP_PREFIX = "desktop-app:";
const WORKSPACE_CATEGORIES = ["FileManager", "TerminalEmulator", "TextEditor"];
const TERMINALS = ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"];

async function firstExecutable(candidates: string[], runtime: Runtime) {
  for (const candidate of candidates) {
    if (await hasExecutable(candidate, runtime)) return candidate;
  }
  return null;
}

export async function defaultOpener(runtime: Runtime) {
  if (runtime.platform !== "linux") return null;
  return firstExecutable(
    isWsl(runtime) ? ["wslview", "xdg-open"] : ["xdg-open"],
    runtime,
  );
}

export async function fileManagerOpener(runtime: Runtime) {
  if (runtime.platform !== "linux") return null;
  return firstExecutable(
    isWsl(runtime) ? ["explorer.exe", "xdg-open"] : ["xdg-open"],
    runtime,
  );
}

export async function terminalEmulator(runtime: Runtime) {
  return runtime.platform === "linux"
    ? firstExecutable(TERMINALS, runtime)
    : null;
}

export async function listLinuxTargets(
  runtime: Runtime,
): Promise<WorkspaceOpenTarget[]> {
  const targets: WorkspaceOpenTarget[] = [];
  if (await defaultOpener(runtime)) {
    targets.push({
      id: "default-app",
      label: "Default App",
      kind: "default-app",
      icon: { kind: "symbol", name: "default-app" },
      capabilities: BASIC,
    });
  }
  if (await fileManagerOpener(runtime)) {
    targets.push({
      id: "file-manager",
      label: "File Manager",
      kind: "file-manager",
      icon: { kind: "symbol", name: "file-manager" },
      capabilities: BASIC,
    });
  }
  if ((await terminalEmulator(runtime)) !== null) {
    targets.push({
      id: "terminal",
      label: "Terminal",
      kind: "terminal",
      icon: { kind: "symbol", name: "terminal" },
      capabilities: FULL,
    });
  }
  for (const app of await listDesktopApps(runtime)) {
    targets.push({
      id: `${DESKTOP_PREFIX}${app.id}`,
      label: app.label,
      kind: "native-app",
      icon: { kind: "symbol", name: "app" },
      capabilities: BASIC,
    });
  }
  return targets;
}

function parseDesktopFile(file: string, content: string): DesktopApp | null {
  const fields = new Map<string, string>();
  let inEntry = false;
  for (const raw of content.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      inEntry = line === "[Desktop Entry]";
      continue;
    }
    const separator = line.indexOf("=");
    if (inEntry && separator > 0) {
      fields.set(
        line.slice(0, separator).trim(),
        line.slice(separator + 1).trim(),
      );
    }
  }
  const label = fields.get("Name");
  const exec = fields.get("Exec");
  const categories = fields.get("Categories")?.split(";") ?? [];
  if (
    fields.get("Type") !== "Application" ||
    fields.get("Hidden") === "true" ||
    fields.get("NoDisplay") === "true" ||
    !label ||
    !exec ||
    !categories.some((category) => WORKSPACE_CATEGORIES.includes(category))
  ) {
    return null;
  }
  return { id: path.basename(file, ".desktop"), file, exec, label };
}

async function listDesktopApps(runtime: Runtime): Promise<DesktopApp[]> {
  const apps: DesktopApp[] = [];
  for (const directory of runtime.desktopFileDirectories ?? []) {
    const entries = await fs
      .readdir(directory, { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".desktop")) continue;
      const file = path.join(directory, entry.name);
      if (apps.some((app) => app.id === path.basename(file, ".desktop")))
        continue;
      const content = await fs.readFile(file, "utf8").catch(() => null);
      const app = content === null ? null : parseDesktopFile(file, content);
      if (app !== null) apps.push(app);
    }
  }
  return apps.sort((a, b) => a.label.localeCompare(b.label));
}

function splitDesktopExec(exec: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaping = false;
  for (const char of exec) {
    if (escaping) {
      current += char;
      escaping = false;
    } else if (char === "\\") {
      escaping = true;
    } else if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/u.test(char)) {
      if (current.length > 0) tokens.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (escaping) current += "\\";
  if (current.length > 0) tokens.push(current);
  return tokens;
}

export async function desktopAppInvocation(
  id: string,
  existing: ExistingPath,
  runtime: Runtime,
): Promise<Invocation> {
  const app =
    (await listDesktopApps(runtime)).find((candidate) => candidate.id === id) ??
    fail("target_unavailable", `Workspace open target is unavailable: ${id}`);
  let usedPath = false;
  const tokens = splitDesktopExec(app.exec)
    .map((token) =>
      token.replaceAll(/%[a-zA-Z%]/gu, (code) => {
        if (code === "%%") return "%";
        if (["%f", "%F", "%u", "%U"].includes(code)) {
          usedPath = true;
          return existing.path;
        }
        if (code === "%c") return app.label;
        return code === "%k" ? app.file : "";
      }),
    )
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    fail(
      "target_unavailable",
      `Desktop app opener is unavailable: ${app.label}`,
    );
  }
  if (!usedPath) tokens.push(existing.path);
  return { file: tokens[0]!, args: tokens.slice(1), env: runtime.env };
}

const terminalArgs = (exe: string, args: string[]) =>
  exe === "gnome-terminal" ? ["--", ...args] : ["-e", ...args];

export async function terminalInvocation(
  existing: ExistingPath,
  at: Location,
  runtime: Runtime,
): Promise<Invocation> {
  const exe =
    (await terminalEmulator(runtime)) ??
    fail("target_unavailable", "Terminal opener is unavailable");
  return {
    file: exe,
    args: terminalArgs(exe, localShellArgs({ ...at, path: existing.path })),
    env: runtime.env,
  };
}

export async function terminalSshInvocation(
  request: SshRequest,
  runtime: Runtime,
): Promise<Invocation> {
  const exe = await terminalEmulator(runtime);
  if (exe === null || !(await hasExecutable("ssh", runtime))) {
    fail("target_unavailable", "Terminal remote SSH opener is unavailable");
  }
  if (runtime.platform !== "linux") {
    fail(
      "remote_target_unsupported",
      "Terminal remote SSH opener is unsupported on this platform",
    );
  }
  return {
    file: exe,
    args: terminalArgs(exe, remoteSshArgs(request)),
    env: runtime.env,
  };
}
