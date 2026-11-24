import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

const originalPlatform = process.platform;
Object.defineProperty(process, "platform", {
  configurable: true,
  value: "win32",
});
const { probePiVersion } = await import("./provider-maintenance.js");
const { PiRpcChild } = await import("./rpc-child.js");

const NPM_PI_CMD = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*',
  "",
].join("\r\n");
const CLI_PARTS = [
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js",
];

// pi.dev/install.ps1's managed launchers, trimmed to what they run.
const MANAGED_PI_CMD = [
  "@ECHO off",
  "SETLOCAL",
  'SET "node=node"',
  '"%node%" "%~dp0pi-launcher.js" %*',
  "EXIT /B %ERRORLEVEL%",
  "",
].join("\r\n");
const MANAGED_PI_LAUNCHER = `
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(path.dirname(__dirname), "install");
const version = fs.readFileSync(path.join(root, "current-version"), "utf8").trim();
const pkg = path.join(root, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
const bin = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).bin.pi;
const result = require("node:child_process").spawnSync(process.execPath, [path.resolve(pkg, bin), ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, PI_MANAGED_INSTALL_ROOT: root },
});
process.exit(result.status ?? 1);
`;

let root: string;

function npmPrefix(script: string, withNode = true): string {
  const dir = mkdtempSync(join(root, "npm-"));
  writeFileSync(join(dir, "pi.cmd"), NPM_PI_CMD);
  mkdirSync(join(dir, ...CLI_PARTS.slice(0, -1)), { recursive: true });
  writeFileSync(join(dir, ...CLI_PARTS), script);
  if (withNode) linkNode(dir);
  return dir;
}

function linkNode(dir: string): void {
  try {
    linkSync(process.execPath, join(dir, "node.exe"));
  } catch {
    symlinkSync(process.execPath, join(dir, "node.exe"));
  }
}

function managedPi(script: string): string {
  const agent = mkdtempSync(join(root, "pi-agent-"));
  const install = join(agent, "install");
  const pkg = join(
    install,
    "releases",
    "1.5.2",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  mkdirSync(join(agent, "bin"));
  mkdirSync(join(agent, "node"));
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(agent, "bin", "pi.cmd"), MANAGED_PI_CMD);
  writeFileSync(join(agent, "bin", "pi-launcher.js"), MANAGED_PI_LAUNCHER);
  writeFileSync(
    join(install, "managed-install.json"),
    `\uFEFF${JSON.stringify({ kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" })}`,
  );
  writeFileSync(join(install, "current-version"), "1.5.2\r\n");
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ bin: { pi: "dist/cli.js" } }),
  );
  writeFileSync(join(pkg, "dist", "cli.js"), script);
  linkNode(join(agent, "node"));
  return `${join(agent, "bin")};${join(agent, "node")}`;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bb-pi-win-shim-"));
  vi.stubEnv("BB_PI_BRIDGE_COMMAND", "");
  vi.stubEnv("BB_PI_BRIDGE_ARGS", "");
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

it("probes the version of an npm-installed pi on Windows", async () => {
  vi.stubEnv("PATH", npmPrefix("console.log('1.4.0');"));
  await expect(probePiVersion()).resolves.toEqual({
    version: "1.4.0",
    failure: null,
  });
});

it.each([
  ["an npm-installed", npmPrefix],
  ["a pi.dev-installed", managedPi],
])(
  "keeps both channel pipes when the rpc child is %s pi on Windows",
  async (_, install) => {
    const echo = [
      "const fs = require('node:fs');",
      "fs.createReadStream(null, { fd: 4 }).once('data', (line) => {",
      "  fs.writeSync(3, line);",
      "  process.exit(0);",
      "});",
    ].join("\n");
    const messages: Record<string, unknown>[] = [];
    const child = new PiRpcChild({
      cwd: root,
      env: { ...process.env, PATH: install(echo) },
      args: [],
      recordThreadId: null,
      onEvent: () => undefined,
      onChannelMessage: (message) => messages.push(message),
      onExit: () => undefined,
    });
    child.sendChannel({ kind: "ping" });
    await expect(child.waitForExit()).resolves.toMatchObject({ code: 0 });
    expect(messages).toEqual([{ kind: "ping" }]);
  },
);
