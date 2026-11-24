import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";

// npm puts only `claude.cmd` on PATH on Windows, and Node won't start a `.cmd` without a shell (#2480).
const originalPlatform = process.platform;
Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
const { completeClaudeInference } = await import("./ai-inference.js");
const { ClaudeLogin } = await import("./host-login.js");

// npm's `claude.cmd` for a node script (`resolveWindowsShim` unwraps only this exact text).
const NPM_CLAUDE_CMD =
  '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\n' +
  'IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n' +
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';

// Answers `auth status --json` as signed in, and `-p` with one result that echoes its arguments and prompt.
const FAKE_CLAUDE = `const args = process.argv.slice(2), out = (v) => console.log(JSON.stringify(v));
if (args[0] === "auth") out({ loggedIn: true });
else { let stdin = ""; process.stdin.on("data", (c) => (stdin += c)).on("end", () => out({ type: "result", result: JSON.stringify({ args, stdin }) })); }`;

const root = mkdtempSync(join(tmpdir(), "claude-npm-shim-"));
const cli = join(root, "node_modules", "@anthropic-ai", "claude-code");
mkdirSync(cli, { recursive: true });
writeFileSync(join(cli, "cli.js"), FAKE_CLAUDE);
writeFileSync(join(root, "claude.cmd"), NPM_CLAUDE_CMD);
// node.exe is on PATH, not beside the shim. Claude runs in the home folder, whose own node.exe must never run.
const [bin, home] = [join(root, "bin"), join(root, "home")];
mkdirSync(bin);
mkdirSync(home);
try { linkSync(process.execPath, join(bin, "node.exe")); } catch { symlinkSync(process.execPath, join(bin, "node.exe")); }
writeFileSync(join(home, "node.exe"), "not node");
vi.stubEnv("BB_CLAUDE_CODE_EXECUTABLE", join(root, "claude.cmd"));
vi.stubEnv("PATHEXT", ".com;.exe;.bat;.cmd");
vi.stubEnv("PATH", bin);
vi.stubEnv("HOME", home);
vi.stubEnv("USERPROFILE", home);

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
});

it("runs helper calls through npm's claude.cmd on Windows", async () => {
  const result = await completeClaudeInference({ serviceId: "claude-code", model: "haiku", reasoningEffort: "none",
    prompt: 'Name "this" thread', outputSchema: { type: "object" }, timeoutMs: 10_000 });
  expect(result).toMatchObject({ ok: true, value: { stdin: 'Name "this" thread' } });
  const args = result.ok ? (result.value.args as string[]) : [];
  expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
  expect(args.at(-1)).toMatch(/^Answer with only a JSON object.*\n\{"type":"object"\}$/su);
});

it("reads the sign-in through npm's claude.cmd on Windows", async () => {
  await expect(new ClaudeLogin().run({ action: "status" })).resolves.toMatchObject({ state: "connected" });
});
