import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  WorkspaceOpenTargetCapabilities,
  WorkspaceOpenTargetIcon,
  WorkspaceOpenTargetKind,
} from "@cloudroom/host-daemon-contract";
import {
  BASIC,
  FULL,
  LINE_ONLY,
  type LocalTerminalRequest,
  type Location,
  type SshRequest,
} from "./system.js";
import {
  ghosttyLocalArgs,
  ghosttySshArgs,
  macTerminalLocalArgs,
  macTerminalSshArgs,
  openAppInDirectoryArgs,
} from "./terminal.js";

export interface Bundled {
  path: string[];
  requires?: string[][];
  argsPrefix?: (appPath: string) => string[];
  env?: (env: NodeJS.ProcessEnv | undefined) => NodeJS.ProcessEnv;
}

export interface Command {
  exe: string;
  bundled?: Bundled;
  fallbacks?: { exe: string; bundled?: Bundled }[];
}

type FileLocation = Location & { path: string; lineNumber: number };

export interface App {
  id: string;
  label: string;
  kind: WorkspaceOpenTargetKind;
  icon: WorkspaceOpenTargetIcon;
  caps: WorkspaceOpenTargetCapabilities;
  opensContainingDirectory?: boolean;
  mac?: {
    name: string;
    otherNames?: string[];
    bundleIds: string[];
    builtIn?: boolean;
    toolbox?: { prefix: string; exe: string };
  };
  line?: Command & { column: boolean; args: (at: FileLocation) => string[] };
  open?: Command & { args: (target: string) => string[] };
  reveal?: { exe: string; args: (target: string) => string[] };
  terminal?: { exe: string; args: (request: LocalTerminalRequest) => string[] };
  ssh?: Command & {
    caps: WorkspaceOpenTargetCapabilities;
    requires?: string[];
    args: (request: SshRequest) => string[];
  };
}

const withLine = (at: FileLocation) =>
  at.columnNumber === null
    ? `${at.path}:${at.lineNumber}`
    : `${at.path}:${at.lineNumber}:${at.columnNumber}`;

const bundled = (...relativePath: string[]): Bundled => ({
  path: relativePath,
});
const appBin = (exe: string) =>
  bundled("Contents", "Resources", "app", "bin", exe);

const CURSOR_CLI = ["Contents", "Resources", "app", "out", "cli.js"];
const CURSOR_BUNDLED: Bundled = {
  path: ["Contents", "MacOS", "Cursor"],
  requires: [CURSOR_CLI],
  argsPrefix: (appPath) => [path.join(appPath, ...CURSOR_CLI)],
  env: (env) => {
    const next: NodeJS.ProcessEnv = { ...(env ?? process.env) };
    next.VSCODE_NODE_OPTIONS = next.NODE_OPTIONS;
    next.VSCODE_NODE_REPL_EXTERNAL_MODULE = next.NODE_REPL_EXTERNAL_MODULE;
    delete next.NODE_OPTIONS;
    delete next.NODE_REPL_EXTERNAL_MODULE;
    next.ELECTRON_RUN_AS_NODE = "1";
    return next;
  },
};

function editor(
  id: string,
  label: string,
  mac: App["mac"],
  rest: Partial<App> = {},
): App {
  return {
    id,
    label,
    kind: "editor",
    icon: { kind: "builtin", name: id },
    caps: FULL,
    mac,
    ...rest,
  };
}

function vsCodeFamily(command: Command): Pick<App, "line" | "open" | "ssh"> {
  return {
    line: { ...command, column: true, args: (at) => ["-g", withLine(at)] },
    open: { ...command, args: (target) => [target] },
    ssh: {
      ...command,
      caps: FULL,
      args: (request) => [
        "--remote",
        `ssh-remote+${request.sshAuthority}`,
        ...(request.lineNumber === null
          ? [request.path]
          : [
              "-g",
              withLine({
                lineNumber: request.lineNumber,
                columnNumber: request.columnNumber,
                path: request.path,
              }),
            ]),
      ],
    },
  };
}

function jetBrains(
  id: string,
  label: string,
  icon: string,
  bundleIds: string[],
  exe: string,
  toolboxPrefix: string,
): App {
  const command = { exe, bundled: bundled("Contents", "MacOS", exe) };
  return editor(
    id,
    label,
    { name: label, bundleIds, toolbox: { prefix: toolboxPrefix, exe } },
    {
      icon: { kind: "builtin", name: icon },
      line: {
        ...command,
        column: true,
        args: (at) => [
          "--line",
          String(at.lineNumber),
          ...(at.columnNumber === null
            ? []
            : ["--column", String(at.columnNumber)]),
          at.path,
        ],
      },
      open: { ...command, args: (target) => [target] },
    },
  );
}

function terminal(
  id: string,
  label: string,
  mac: App["mac"],
  rest: Partial<App>,
): App {
  return {
    id,
    label,
    kind: "terminal",
    icon: { kind: "builtin", name: id },
    caps: FULL,
    opensContainingDirectory: true,
    mac,
    ...rest,
  };
}

function macTerminal(app: "Terminal" | "iTerm"): Partial<App> {
  return {
    terminal: { exe: "osascript", args: macTerminalLocalArgs(app) },
    ssh: {
      exe: "osascript",
      caps: FULL,
      requires: ["ssh"],
      args: macTerminalSshArgs(app),
    },
  };
}

function zedSshUri(request: SshRequest): string {
  const absolute = request.path.startsWith("/")
    ? request.path
    : `/${request.path}`;
  const uri = `ssh://${request.sshAuthority}${absolute.split("/").map(encodeURIComponent).join("/")}`;
  if (request.lineNumber === null) return uri;
  return withLine({
    path: uri,
    lineNumber: request.lineNumber,
    columnNumber: request.columnNumber,
  });
}

function textMateUri(at: FileLocation): string {
  const uri = new URL("txmt://open/");
  uri.searchParams.set("url", pathToFileURL(at.path).toString());
  uri.searchParams.set("line", String(at.lineNumber));
  if (at.columnNumber !== null) {
    uri.searchParams.set("column", String(at.columnNumber));
  }
  return uri.toString();
}

const subl = {
  exe: "subl",
  bundled: bundled("Contents", "SharedSupport", "bin", "subl"),
};
const zed = { exe: "zed", bundled: bundled("Contents", "MacOS", "zed") };

export const APPS: App[] = [
  editor(
    "vscode",
    "VS Code",
    {
      name: "Visual Studio Code",
      otherNames: ["Code"],
      bundleIds: ["com.microsoft.VSCode"],
    },
    vsCodeFamily({ exe: "code", bundled: appBin("code") }),
  ),
  editor(
    "vscode-insiders",
    "VS Code Insiders",
    {
      name: "Visual Studio Code - Insiders",
      otherNames: ["Code - Insiders"],
      bundleIds: ["com.microsoft.VSCodeInsiders"],
    },
    vsCodeFamily({ exe: "code-insiders", bundled: appBin("code") }),
  ),
  editor(
    "cursor",
    "Cursor",
    { name: "Cursor", bundleIds: ["com.todesktop.230313mzl4w4u92"] },
    vsCodeFamily({ exe: "cursor", bundled: CURSOR_BUNDLED }),
  ),
  editor(
    "sublime-text",
    "Sublime Text",
    {
      name: "Sublime Text",
      bundleIds: ["com.sublimetext.4", "com.sublimetext.3"],
    },
    {
      line: { ...subl, column: true, args: (at) => [withLine(at)] },
      open: { ...subl, args: (target) => [target] },
    },
  ),
  editor(
    "zed",
    "Zed",
    {
      name: "Zed",
      otherNames: ["Zed Preview", "Zed Nightly"],
      bundleIds: ["dev.zed.Zed"],
    },
    {
      line: { ...zed, column: true, args: (at) => [withLine(at)] },
      open: { ...zed, args: (target) => [target] },
      ssh: { ...zed, caps: FULL, args: (request) => [zedSshUri(request)] },
    },
  ),
  editor(
    "devin-desktop",
    "Devin Desktop",
    {
      name: "Devin",
      otherNames: ["Windsurf"],
      bundleIds: ["com.exafunction.windsurf"],
    },
    vsCodeFamily({
      exe: "devin-desktop",
      bundled: appBin("devin-desktop"),
      fallbacks: [{ exe: "windsurf", bundled: appBin("windsurf") }],
    }),
  ),
  editor(
    "bbedit",
    "BBEdit",
    { name: "BBEdit", bundleIds: ["com.barebones.bbedit"] },
    { caps: BASIC },
  ),
  editor(
    "textmate",
    "TextMate",
    { name: "TextMate", bundleIds: ["com.macromates.TextMate"] },
    {
      line: {
        exe: "open",
        column: true,
        args: (at) => ["-a", "TextMate", textMateUri(at)],
      },
    },
  ),
  editor(
    "emacs",
    "Emacs",
    { name: "Emacs", bundleIds: ["org.gnu.Emacs"] },
    { caps: BASIC },
  ),
  jetBrains(
    "intellij-idea",
    "IntelliJ IDEA",
    "intellij",
    ["com.jetbrains.intellij", "com.jetbrains.intellij.ce"],
    "idea",
    "intellij idea",
  ),
  jetBrains(
    "pycharm",
    "PyCharm",
    "pycharm",
    ["com.jetbrains.pycharm", "com.jetbrains.pycharm.ce"],
    "pycharm",
    "pycharm",
  ),
  jetBrains(
    "webstorm",
    "WebStorm",
    "webstorm",
    ["com.jetbrains.WebStorm"],
    "webstorm",
    "webstorm",
  ),
  jetBrains(
    "goland",
    "GoLand",
    "goland",
    ["com.jetbrains.goland"],
    "goland",
    "goland",
  ),
  jetBrains(
    "rider",
    "Rider",
    "rider",
    ["com.jetbrains.rider"],
    "rider",
    "rider",
  ),
  jetBrains(
    "rustrover",
    "RustRover",
    "rustrover",
    ["com.jetbrains.rustrover"],
    "rustrover",
    "rustrover",
  ),
  jetBrains(
    "phpstorm",
    "PhpStorm",
    "phpstorm",
    ["com.jetbrains.PhpStorm"],
    "phpstorm",
    "phpstorm",
  ),
  jetBrains(
    "android-studio",
    "Android Studio",
    "android-studio",
    ["com.google.android.studio"],
    "studio",
    "android studio",
  ),
  editor(
    "antigravity",
    "Antigravity",
    {
      name: "Antigravity",
      bundleIds: ["com.google.antigravity", "com.googlelabs.antigravity"],
    },
    vsCodeFamily({ exe: "antigravity", bundled: appBin("antigravity") }),
  ),
  editor(
    "xcode",
    "Xcode",
    { name: "Xcode", bundleIds: ["com.apple.dt.Xcode"] },
    {
      caps: LINE_ONLY,
      line: {
        exe: "xed",
        column: false,
        args: (at) => ["-l", String(at.lineNumber), at.path],
      },
    },
  ),
  {
    id: "finder",
    label: "Finder",
    kind: "file-manager",
    icon: { kind: "builtin", name: "finder" },
    caps: BASIC,
    mac: { name: "Finder", bundleIds: ["com.apple.finder"], builtIn: true },
    reveal: { exe: "open", args: (target) => ["-R", target] },
  },
  terminal(
    "terminal",
    "Terminal",
    { name: "Terminal", bundleIds: ["com.apple.Terminal"], builtIn: true },
    macTerminal("Terminal"),
  ),
  terminal(
    "iterm2",
    "iTerm2",
    { name: "iTerm", bundleIds: ["com.googlecode.iterm2"] },
    macTerminal("iTerm"),
  ),
  terminal(
    "ghostty",
    "Ghostty",
    { name: "Ghostty", bundleIds: ["com.mitchellh.ghostty"] },
    {
      terminal: { exe: "open", args: ghosttyLocalArgs },
      ssh: { exe: "open", caps: FULL, requires: ["ssh"], args: ghosttySshArgs },
    },
  ),
  terminal(
    "warp",
    "Warp",
    { name: "Warp", bundleIds: ["dev.warp.Warp", "dev.warp.Warp-Stable"] },
    {
      caps: BASIC,
      terminal: { exe: "open", args: openAppInDirectoryArgs("Warp") },
    },
  ),
  {
    id: "default-app",
    label: "Default App",
    kind: "default-app",
    icon: { kind: "symbol", name: "default-app" },
    caps: BASIC,
  },
];

export const findApp = (id: string) => APPS.find((app) => app.id === id);

export const findAppByBundleId = (bundleId: string) =>
  APPS.find((app) => app.mac?.bundleIds.includes(bundleId));

export const findAppByName = (name: string) =>
  APPS.find((app) =>
    [app.mac?.name, ...(app.mac?.otherNames ?? [])].some(
      (candidate) => candidate?.toLowerCase() === name.toLowerCase(),
    ),
  );

export const targetPathFor = (
  app: App,
  existing: { path: string; type: "directory" | "file" },
) =>
  existing.type === "file" && app.opensContainingDirectory
    ? path.dirname(existing.path)
    : existing.path;
