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

let root: string;

function npmPrefix(script: string, withNode = true): string {
  const dir = mkdtempSync(join(root, "npm-"));
  writeFileSync(join(dir, "pi.cmd"), NPM_PI_CMD);
  mkdirSync(join(dir, ...CLI_PARTS.slice(0, -1)), { recursive: true });
  writeFileSync(join(dir, ...CLI_PARTS), script);
  if (withNode) {
    try {
      linkSync(process.execPath, join(dir, "node.exe"));
    } catch {
      symlinkSync(process.execPath, join(dir, "node.exe"));
    }
  }
  return dir;
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

it("keeps both channel pipes when the rpc child is an npm-installed pi on Windows", async () => {
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
    env: { ...process.env, PATH: npmPrefix(echo) },
    args: [],
    recordThreadId: null,
    onEvent: () => undefined,
    onChannelMessage: (message) => messages.push(message),
    onExit: () => undefined,
  });
  child.sendChannel({ kind: "ping" });
  await expect(child.waitForExit()).resolves.toMatchObject({ code: 0 });
  expect(messages).toEqual([{ kind: "ping" }]);
});
