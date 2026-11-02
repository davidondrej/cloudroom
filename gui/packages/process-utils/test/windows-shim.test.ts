import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

const originalPlatform = process.platform;
Object.defineProperty(process, "platform", {
  configurable: true,
  value: "win32",
});
const { resolvePortableCommand, resolveWindowsShim } =
  await import("../src/index.js");

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

it("runs a JS-target shim as node plus its script, preferring the node.exe beside it", () => {
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
  expect(
    resolveWindowsShim({
      command: "pi",
      args: ["--version"],
      env: { PATH: npm },
    }),
  ).toEqual({
    command: "node",
    args: [script, "--version"],
  });
  writeFileSync(join(npm, "node.exe"), "");
  expect(
    resolveWindowsShim({ command: "pi", args: [], env: { Path: `"${npm}"` } }),
  ).toEqual({
    command: join(npm, "node.exe"),
    args: [script],
  });
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
