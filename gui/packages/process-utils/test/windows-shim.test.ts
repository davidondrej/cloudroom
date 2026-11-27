import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

const originalPlatform = process.platform;
Object.defineProperty(process, "platform", {
  configurable: true,
  value: "win32",
});
const {
  findCliExecutable,
  isClaudeNpmPlaceholder,
  resolvePortableCommand,
  resolveWindowsShim,
} = await import("../src/index.js");

const NPM_SHIM_HEAD =
  "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n";
const PI_CMD = `${NPM_SHIM_HEAD}\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r\n`;
const OPENCODE_CMD = `${NPM_SHIM_HEAD}"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*\r\n`;

let root: string;

function dir(files: Record<string, string>): string {
  const directory = mkdtempSync(join(root, "bin-"));
  for (const [name, content] of Object.entries(files)) {
    if (content === "<dir>") mkdirSync(join(directory, name));
    else writeFileSync(join(directory, name), content);
  }
  return directory;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cr-win-shim-"));
  vi.stubEnv("PATHEXT", ".com;.exe;.bat;.cmd");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: originalPlatform,
  });
});

it("runs a JS-target shim as node plus its script: the node.exe beside it, else PATH's, never the cwd's", () => {
  const npm = dir({ "pi.cmd": PI_CMD });
  const script = join(
    npm,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "bundle",
    "cli.js",
  );
  // Never a bare `node`, which Windows looks up in the project folder first: PATH's node.exe, else ENOENT.
  const project = dir({ "node.exe": "" });
  const nodejs = dir({ "node.exe": "" });
  expect(
    resolveWindowsShim({ command: "pi", args: ["--version"], cwd: project, env: { PATH: `${npm};.;${nodejs}` } }),
  ).toEqual({ command: join(nodejs, "node.exe"), args: [script, "--version"] });
  expect(resolveWindowsShim({ command: "pi", args: [], cwd: project, env: { PATH: npm } })).toEqual({
    command: join(npm, "node.exe"),
    args: [script],
  });
  // An env without PATH searches the parent's PATH, as Windows does.
  vi.stubEnv("PATH", nodejs);
  expect(resolveWindowsShim({ command: join(npm, "pi.cmd"), args: [], cwd: project, env: {} }).command).toBe(
    join(nodejs, "node.exe"),
  );
  writeFileSync(join(npm, "node.exe"), "");
  expect(
    resolveWindowsShim({ command: "pi", args: [], env: { Path: `"${npm}"` } }),
  ).toEqual({
    command: join(npm, "node.exe"),
    args: [script],
  });
});

// `\dir` and `C:dir` resolve against the working folder's drive, so they never count; a POSIX host can't express them.
it.runIf(originalPlatform === "win32")("skips PATH folders that aren't fully qualified", () => {
  const npm = dir({ "pi.cmd": PI_CMD });
  const nodejs = dir({ "node.exe": "" });
  const rooted = nodejs.slice(2);
  const driveRelative = `${nodejs.slice(0, 2)}${relative(resolve(nodejs.slice(0, 2)), nodejs)}`;
  expect(
    resolveWindowsShim({ command: join(npm, "pi.cmd"), args: [], cwd: root, env: { PATH: `${rooted};${driveRelative}` } }).command,
  ).toBe(join(npm, "node.exe"));
});

it("runs an exe-target shim's exe directly", () => {
  const npm = dir({ "opencode.cmd": OPENCODE_CMD });
  expect(
    resolveWindowsShim({
      command: join(npm, "opencode.cmd"),
      args: ["acp"],
      env: {},
    }),
  ).toEqual({
    command: join(npm, "node_modules", "opencode-ai", "bin", "opencode.exe"),
    args: ["acp"],
  });
});

it("leaves an earlier exe, a cwd command, and an unreadable shim alone, as cross-spawn picks them", () => {
  const unchanged = { command: "pi", args: [] };
  const npm = dir({ "pi.cmd": PI_CMD });
  const bun = dir({ "pi.exe": "" });
  expect(
    resolveWindowsShim({
      ...unchanged,
      env: { PATH: `${bun};${npm}` },
    }),
  ).toEqual(unchanged);
  const project = dir({ "pi.exe": "" });
  expect(
    resolveWindowsShim({ ...unchanged, cwd: project, env: { PATH: npm } }),
  ).toEqual(unchanged);
  vi.stubEnv("PATHEXT", ".exe;.cmd");
  expect(
    resolveWindowsShim({
      ...unchanged,
      cwd: project,
      env: { PATH: npm, PATHEXT: ".CMD" },
    }),
  ).toEqual(unchanged);
  const broken = dir({ "pi.cmd": "<dir>" });
  expect(resolveWindowsShim({ ...unchanged, env: { PATH: broken } })).toEqual(
    unchanged,
  );
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: "linux",
  });
  expect(resolveWindowsShim({ ...unchanged, env: { PATH: npm } })).toEqual(
    unchanged,
  );
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: "win32",
  });
});

it("leaves any shim but npm's exact templates alone", () => {
  const unchanged = { command: "pi", args: [] };
  const script = '"%dp0%\\node_modules\\pi\\cli.js" %*';
  const variants = [
    PI_CMD.replace(
      '"%_prog%"  "%dp0%',
      '"%_prog%" --require ./bootstrap.cjs "%dp0%',
    ),
    PI_CMD.replace('  SET "_prog=node"', '  SET "_prog=bun"'),
    PI_CMD.replace("endLocal & goto", "REM endLocal & goto"),
    PI_CMD.replace(
      "SETLOCAL\r\n",
      "SETLOCAL\r\n@SET NODE_OPTIONS=--require=./bootstrap.cjs\r\n",
    ),
    PI_CMD.replace("\r\n\r\nendLocal", '\r\nSET "_prog=bun"\r\n\r\nendLocal'),
    OPENCODE_CMD.replace('"%dp0%', 'REM "%dp0%'),
    OPENCODE_CMD.replace('"   %*', '" --flag   %*'),
    `@SETLOCAL\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\..\\pi\\cli.js" %*\r\n)\r\n`,
    `@echo off\r\n"C:\\node.exe" ${script}\r\n`,
  ];
  for (const shim of variants) {
    expect(
      resolveWindowsShim({
        ...unchanged,
        env: { PATH: dir({ "pi.cmd": shim }) },
      }),
    ).toEqual(unchanged);
  }
});

it("leaves cwd's extensionless command alone when PATHEXT has an empty entry, as cross-spawn does", () => {
  vi.stubEnv("PATHEXT", ".exe;.cmd;");
  const project = dir({ pi: "#!/usr/bin/env node\nconsole.log(1)\n" });
  const npm = dir({ "pi.cmd": PI_CMD });
  expect(
    resolveWindowsShim({
      command: "pi",
      args: [],
      cwd: project,
      env: { PATH: npm },
    }),
  ).toEqual({ command: "pi", args: [] });
});

it("finds a command in a quoted PATH entry", () => {
  const nodejs = dir({ "npm.cmd": "" });
  expect(
    resolvePortableCommand("npm.cmd", { env: { PATH: `"${nodejs}"` } }),
  ).toBe(join(nodejs, "npm.cmd"));
});

it("skips npm's claude.cmd when it runs the unfinished Claude stub (#1148)", () => {
  const npm = dir({});
  const shim = join(npm, "claude.cmd");
  const stub = join(npm, "node_modules", "@anthropic-ai", "claude-code", "bin");
  mkdirSync(stub, { recursive: true });
  writeFileSync(
    join(stub, "claude.exe"),
    'echo "Error: claude native binary not installed." >&2\nexit 1\n',
  );
  writeFileSync(
    shim,
    `${NPM_SHIM_HEAD}"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n`,
    { mode: 0o755 },
  );
  const native = dir({});
  writeFileSync(join(native, "claude.exe"), "", { mode: 0o755 });
  expect(isClaudeNpmPlaceholder(shim)).toBe(true);
  expect(
    findCliExecutable("claude", {
      PATH: [npm, native].join(delimiter),
      PATHEXT: ".exe;.cmd",
    }),
  ).toBe(join(native, "claude.exe"));
});

it("finds Grok (#1256), Cursor (#1709), and Hermes (#2715) in their own folders off PATH", () => {
  const home = dir({});
  mkdirSync(join(home, ".grok", "bin"), { recursive: true });
  writeFileSync(join(home, ".grok", "bin", "grok.exe"), "", { mode: 0o755 });
  expect(
    findCliExecutable("grok", { PATH: "", USERPROFILE: home, PATHEXT: ".exe" }),
  ).toBe(join(home, ".grok", "bin", "grok.exe"));
  const cursor = join(home, "Local App", "cursor-agent");
  mkdirSync(cursor, { recursive: true });
  writeFileSync(join(cursor, "cursor-agent.cmd"), "", { mode: 0o755 });
  expect(
    findCliExecutable("cursor-agent", {
      PATH: "",
      LOCALAPPDATA: join(home, "Local App"),
      PATHEXT: ".exe;.cmd",
    }),
  ).toBe(join(cursor, "cursor-agent.cmd"));
  const hermesBin = join(home, "Local App", "hermes", "bin");
  mkdirSync(hermesBin, { recursive: true });
  writeFileSync(join(hermesBin, "hermes.exe"), "", { mode: 0o755 });
  expect(
    findCliExecutable("hermes", {
      PATH: "",
      LOCALAPPDATA: join(home, "Local App"),
      PATHEXT: ".exe;.cmd",
    }),
  ).toBe(join(hermesBin, "hermes.exe"));
  const customHermesBin = join(home, "custom-hermes", "bin");
  mkdirSync(customHermesBin, { recursive: true });
  writeFileSync(join(customHermesBin, "hermes.cmd"), "", { mode: 0o755 });
  expect(
    findCliExecutable("hermes", {
      PATH: "",
      HERMES_HOME: join(home, "custom-hermes"),
      LOCALAPPDATA: join(home, "Local App"),
      PATHEXT: ".exe;.cmd",
    }),
  ).toBe(join(customHermesBin, "hermes.cmd"));
});
