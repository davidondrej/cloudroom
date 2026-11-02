import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  WORKSPACE_OPEN_TARGET_ICON_DATA_URL_MAX_LENGTH,
  type WorkspaceOpenTarget,
} from "@cloudroom/host-daemon-contract";
import { pathExists } from "@cloudroom/process-utils";
import {
  APPS,
  findApp,
  findAppByBundleId,
  findAppByName,
  targetPathFor,
  type App,
} from "./apps.js";
import {
  appTarget,
  canOpenOverSsh,
  findAppPath,
  findBundleApp,
  findBundlePaths,
  lineInvocation,
  pathInvocation,
  sshInvocation,
} from "./commands.js";
import {
  BASIC,
  fail,
  hasExecutable,
  hasSystemExecutable,
  launch,
  requireOpenablePath,
  type ExistingPath,
  type Invocation,
  type ListWorkspaceOpenTargetsOptions,
  type Location,
  type OpenPathInTargetArgs,
  type WorkspaceOpenTargetRuntime,
} from "./system.js";

type Runtime = WorkspaceOpenTargetRuntime;

const GENERIC_PREFIX = "mac-app:";
const FILE_APP_LIMIT = 5;
const APPS_FOR_FILE_SCRIPT = `
function run(argv) {
  ObjC.import("AppKit");
  const filePath = argv[0];
  const url = $.NSURL.fileURLWithPath(filePath);
  const applications = $.NSWorkspace.sharedWorkspace.URLsForApplicationsToOpenURL(url);
  const output = [];
  for (let index = 0; index < applications.count; index += 1) {
    const applicationUrl = applications.objectAtIndex(index);
    const bundle = $.NSBundle.bundleWithURL(applicationUrl);
    const bundleId = bundle ? ObjC.unwrap(bundle.bundleIdentifier) : null;
    output.push({
      appPath: ObjC.unwrap(applicationUrl.path),
      bundleId,
    });
  }
  return JSON.stringify(output);
}
`;
const appsForFileSchema = z.array(
  z
    .object({
      appPath: z.string().min(1),
      bundleId: z.string().min(1).nullable(),
    })
    .strict(),
);

async function plistValue(appPath: string, key: string, runtime: Runtime) {
  try {
    const result = await runtime.execFile("plutil", [
      "-extract",
      key,
      "raw",
      "-o",
      "-",
      path.join(appPath, "Contents", "Info.plist"),
    ]);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function appIcon(appPath: string, runtime: Runtime) {
  const iconFile = await plistValue(appPath, "CFBundleIconFile", runtime);
  if (iconFile === null) return null;
  const iconPath = path.join(
    appPath,
    "Contents",
    "Resources",
    path.extname(iconFile) === "" ? `${iconFile}.icns` : iconFile,
  );
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "open-target-icon-"));
  try {
    await runtime.execFile("qlmanage", [
      "-t",
      "-s",
      "32",
      "-o",
      tempDir,
      iconPath,
    ]);
    const png = await fs.readFile(
      path.join(tempDir, `${path.basename(iconPath)}.png`),
    );
    const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
    return dataUrl.length > WORKSPACE_OPEN_TARGET_ICON_DATA_URL_MAX_LENGTH
      ? null
      : dataUrl;
  } catch {
    return null;
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true });
  }
}

async function knownTarget(
  app: App,
  runtime: Runtime,
  appPath: string | null,
): Promise<WorkspaceOpenTarget> {
  const icon =
    appPath !== null && app.mac !== undefined && !app.mac.builtIn
      ? await appIcon(appPath, runtime)
      : null;
  const target: WorkspaceOpenTarget = {
    ...appTarget(app),
    icon: icon === null ? app.icon : { kind: "data-url", dataUrl: icon },
  };
  if (app.mac !== undefined && (await canOpenOverSsh(app, runtime))) {
    target.remoteSshCapabilities = app.ssh!.caps;
  }
  return target;
}

async function appsForFile(filePath: string, runtime: Runtime) {
  if (!(await pathExists(filePath))) return [];
  let found: z.infer<typeof appsForFileSchema>;
  try {
    const result = await runtime.execFile("osascript", [
      "-l",
      "JavaScript",
      "-e",
      APPS_FOR_FILE_SCRIPT,
      "--",
      filePath,
    ]);
    found = appsForFileSchema.parse(JSON.parse(result.stdout.trim()));
  } catch {
    return [];
  }
  const apps: { appPath: string; bundleId: string | null; label: string }[] =
    [];
  const seen = new Set<string>();
  for (const { appPath, bundleId } of found) {
    const key = bundleId === null ? `path:${appPath}` : `bundle:${bundleId}`;
    if (!appPath.endsWith(".app") || seen.has(key)) continue;
    seen.add(key);
    apps.push({
      appPath,
      bundleId,
      label:
        (await plistValue(appPath, "CFBundleDisplayName", runtime)) ??
        (await plistValue(appPath, "CFBundleName", runtime)) ??
        path.basename(appPath, ".app"),
    });
    if (apps.length >= FILE_APP_LIMIT) break;
  }
  return apps;
}

export async function listMacTargets(
  runtime: Runtime,
  options: ListWorkspaceOpenTargetsOptions,
): Promise<WorkspaceOpenTarget[]> {
  const targets: WorkspaceOpenTarget[] = [];
  const add = (target: WorkspaceOpenTarget) => {
    if (!targets.some((existing) => existing.id === target.id)) {
      targets.push(target);
    }
  };
  for (const app of APPS) {
    if (app.mac === undefined || app.mac.builtIn) {
      add(await knownTarget(app, runtime, null));
      continue;
    }
    const appPath = await findAppPath(app, runtime);
    if (appPath !== null) add(await knownTarget(app, runtime, appPath));
  }
  const fileApps =
    options.path === undefined ? [] : await appsForFile(options.path, runtime);
  for (const found of fileApps) {
    const app =
      (found.bundleId === null
        ? undefined
        : findAppByBundleId(found.bundleId)) ?? findAppByName(found.label);
    if (app !== undefined) {
      add(await knownTarget(app, runtime, found.appPath));
    } else if (found.bundleId !== null) {
      const icon = await appIcon(found.appPath, runtime);
      add({
        id: `${GENERIC_PREFIX}${found.bundleId}`,
        label: found.label,
        kind: "native-app",
        icon:
          icon === null
            ? { kind: "symbol", name: "app" }
            : { kind: "data-url", dataUrl: icon },
        capabilities: BASIC,
      });
    }
  }
  return targets;
}

async function isInstalled(app: App, runtime: Runtime) {
  if (app.mac === undefined || app.mac.builtIn) return true;
  for (const bundleId of app.mac.bundleIds) {
    if ((await findBundlePaths(bundleId, runtime)).length > 0) return true;
  }
  return (await findAppPath(app, runtime)) !== null;
}

async function xedPath(app: App, runtime: Runtime) {
  if (await hasExecutable("xed", runtime)) return "xed";
  try {
    const developer = (
      await runtime.execFile("xcode-select", ["-p"])
    ).stdout.trim();
    const selected = path.join(developer, "usr", "bin", "xed");
    if (developer.length > 0 && (await pathExists(selected))) return selected;
  } catch {}
  const appPath = await findAppPath(app, runtime);
  if (appPath === null) return null;
  const bundled = path.join(
    appPath,
    "Contents",
    "Developer",
    "usr",
    "bin",
    "xed",
  );
  return (await pathExists(bundled)) ? bundled : null;
}

async function xcodeProject(existing: ExistingPath) {
  let directory =
    existing.type === "directory" ? existing.path : path.dirname(existing.path);
  let swiftPackage: string | null = null;
  for (;;) {
    const entries = await fs.readdir(directory).catch(() => [] as string[]);
    const container =
      entries.find((entry) => entry.endsWith(".xcworkspace")) ??
      entries.find((entry) => entry.endsWith(".xcodeproj"));
    if (container !== undefined) return path.join(directory, container);
    if (swiftPackage === null && entries.includes("Package.swift")) {
      swiftPackage = directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return swiftPackage;
    directory = parent;
  }
}

async function xcodeInvocation(
  app: App,
  existing: ExistingPath,
  at: Location,
  runtime: Runtime,
): Promise<Invocation | null> {
  const xed = await xedPath(app, runtime);
  if (xed === null) return null;
  const project = await xcodeProject(existing);
  return {
    file: xed,
    args: [
      ...(project === null ? [] : ["--project", project]),
      ...(at.lineNumber === null || existing.type !== "file"
        ? []
        : ["--line", String(at.lineNumber)]),
      existing.path,
    ],
    env: runtime.env,
  };
}

async function revealInvocation(
  app: App,
  existing: ExistingPath,
  runtime: Runtime,
): Promise<Invocation | null> {
  if (!app.reveal || existing.type !== "file") return null;
  if (!(await hasSystemExecutable(app.reveal.exe, runtime))) return null;
  return { file: app.reveal.exe, args: app.reveal.args(existing.path) };
}

async function terminalEditor(runtime: Runtime) {
  const configured = runtime.env?.VISUAL?.trim() || runtime.env?.EDITOR?.trim();
  if (configured) return configured;
  for (const candidate of ["nvim", "vim", "nano", "less"]) {
    if (await hasExecutable(candidate, runtime)) return candidate;
  }
  return null;
}

async function terminalInvocation(
  app: App,
  existing: ExistingPath,
  at: Location,
  runtime: Runtime,
): Promise<Invocation | null> {
  if (!app.terminal) return null;
  return {
    file: app.terminal.exe,
    args: app.terminal.args({
      columnNumber: app.caps.openFileAtColumn ? at.columnNumber : null,
      editorCommand:
        existing.type === "file" ? await terminalEditor(runtime) : null,
      lineNumber: at.lineNumber,
      path: existing.path,
      pathType: existing.type,
      shellPath: runtime.env?.SHELL?.trim() || "/bin/zsh",
    }),
  };
}

async function localInvocation(
  app: App,
  existing: ExistingPath,
  at: Location,
  runtime: Runtime,
): Promise<Invocation> {
  const target = targetPathFor(app, existing);
  return (
    (app.id === "xcode"
      ? await xcodeInvocation(app, existing, at, runtime)
      : null) ??
    (await lineInvocation(app, existing, at, runtime)) ??
    (await revealInvocation(app, existing, runtime)) ??
    (await pathInvocation(app, existing, runtime)) ??
    (await terminalInvocation(app, existing, at, runtime)) ?? {
      file: "open",
      args: app.mac ? ["-a", app.mac.name, "--", target] : ["--", target],
    }
  );
}

export async function openOnMac(
  args: OpenPathInTargetArgs,
  runtime: Runtime,
): Promise<void> {
  const bundleId = args.targetId.startsWith(GENERIC_PREFIX)
    ? args.targetId.slice(GENERIC_PREFIX.length)
    : null;
  const knownByBundle =
    bundleId !== null && args.context.kind === "local"
      ? findAppByBundleId(bundleId)
      : undefined;
  if (bundleId !== null && knownByBundle?.kind !== "terminal") {
    if (args.context.kind === "remote-ssh") {
      fail(
        "remote_target_unsupported",
        `${args.targetId} cannot open remote SSH paths`,
      );
    }
    const existing = await requireOpenablePath(args.path);
    if ((await findBundleApp(bundleId, runtime)) === null) {
      fail(
        "target_unavailable",
        `Workspace open target is unavailable: ${bundleId}`,
      );
    }
    return launch(
      { file: "open", args: ["-b", bundleId, "--", existing.path] },
      runtime,
    );
  }
  const app =
    knownByBundle ??
    findApp(args.targetId) ??
    fail(
      "target_unavailable",
      `Workspace open target is unavailable: ${args.targetId}`,
    );
  if (!(await isInstalled(app, runtime))) {
    fail(
      "target_unavailable",
      `Workspace open target is unavailable: ${app.label}`,
    );
  }
  if (args.context.kind === "remote-ssh") {
    return launch(
      await sshInvocation(
        app,
        { ...args, sshAuthority: args.context.sshAuthority },
        runtime,
      ),
      runtime,
    );
  }
  const existing = await requireOpenablePath(args.path);
  return launch(await localInvocation(app, existing, args, runtime), runtime);
}
