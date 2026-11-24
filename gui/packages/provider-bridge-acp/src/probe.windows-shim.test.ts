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
const { probeAcpAgent } = await import("./probe.js");

const OPENCODE_CMD =
  '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*\r\n';
const AGENT = `process.stdin.once("data", () => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, agentCapabilities: {} } }) + "\\n");
});`;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "acp-win-shim-"));
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

it("starts an npm-installed agent whose .cmd shim targets an exe (opencode) on Windows, natively too", async () => {
  const bin = join(root, "node_modules", "opencode-ai", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(root, "agent.cjs"), AGENT);
  try {
    linkSync(process.execPath, join(bin, "opencode.exe"));
  } catch {
    symlinkSync(process.execPath, join(bin, "opencode.exe"));
  }
  writeFileSync(join(root, "opencode.cmd"), OPENCODE_CMD);

  await expect(
    probeAcpAgent({
      command: join(root, "opencode.cmd"),
      args: [join(root, "agent.cjs")],
      cwd: root,
    }),
  ).resolves.toEqual({ reachable: true, fork: false });
});
