import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Where each CLI was found. The real lookup also checks /usr/local/bin and only checks Codex.app on macOS.
const found = vi.hoisted(() => ({ paths: {} as Record<string, string> }));
vi.mock("@cloudroom/process-utils", async (original) => ({
  ...await original<typeof import("@cloudroom/process-utils")>(),
  findCliExecutable: (cli: string) => found.paths[cli] ?? null,
}));

import { reportAgentConnect, startSetupTelemetry } from "../../src/services/cloudroom/setup-telemetry.js";

const posix = it.skipIf(process.platform === "win32");
const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
let home = "", marker = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "setup-telemetry-"));
  marker = join(home, "ran");
  process.env.HOME = home;
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "ANTHROPIC_API_KEY"]) delete process.env[name];
  found.paths = {};
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  rmSync(home, { recursive: true, force: true });
});

/** A fake CLI that leaves a marker if anything runs it. */
function fakeCli(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\necho 9.9.9\n`, { mode: 0o755 });
  return path;
}
function file(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function link(target: string, path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
  return path;
}
function npmCli(name: string, version: string, bin: string): string {
  const root = join(home, "npm", "lib", "node_modules", name);
  file(join(root, "package.json"), { name, version });
  fakeCli(join(root, bin));
  return link(join(root, bin), join(home, "npm", "bin", bin.split("/").at(-1)!));
}

const capture = vi.fn();
/** The snapshot a first launch sends 5 seconds in. */
async function firstLaunchSnapshot(): Promise<Record<string, unknown>> {
  capture.mockClear();
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  startSetupTelemetry({
    telemetry: { capture }, config: { dataDir: mkdtempSync(join(home, "data-")) }, logger: { debug: () => {} }, db: {},
    sandboxes: { setupEvent: async () => {} }, telemetryAllowed: false,
  } as never);
  vi.advanceTimersByTime(5_000);
  vi.useRealTimers();
  return snapshot("first_launch");
}
async function snapshot(reason: string): Promise<Record<string, unknown>> {
  const sent = () => capture.mock.calls.map(([event]) => event).find(event => event.name === "setup_snapshot" && event.properties.reason === reason);
  await vi.waitFor(() => expect(sent()).toBeDefined(), { timeout: 10_000 });
  return sent().properties;
}

posix("Setup telemetry never runs Codex inside Codex.app or Claude Code, at first launch or after a failed Connect (issue #96)", async () => {
  found.paths = {
    codex: fakeCli(join(home, "Applications", "Codex.app", "Contents", "Resources", "codex")),
    claude: npmCli("@anthropic-ai/claude-code", "2.1.316", "bin/claude.exe"),
  };
  file(join(home, ".claude.json"), { oauthAccount: { emailAddress: "a@b.co" } });
  file(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "t", subscriptionType: "max" } });
  const first = await firstLaunchSnapshot();
  expect(first).toMatchObject({ codex_cli_place: "app_bundle", codex_cli_version: null, claude_cli_version: "2.1.316", claude_logged_in: true, claude_plan: "max" });
  reportAgentConnect("codex", "failed", { code: "x" });
  expect(await snapshot("connect_failed")).toMatchObject({ codex_cli_version: null, claude_cli_version: "2.1.316" });
  expect(existsSync(marker)).toBe(false);
});

posix.each([
  ["Codex from npm", "codex", () => npmCli("@openai/codex", "0.166.0", "bin/codex.js"), "0.166.0"],
  ["Codex from OpenAI's installer", "codex", () => {
    const release = join(home, ".codex", "packages", "standalone", "releases", "0.55.0-aarch64-apple-darwin");
    fakeCli(join(release, "bin", "codex"));
    link("bin/codex", join(release, "codex"));
    return join(link(release, join(home, ".codex", "packages", "standalone", "current")), "codex");
  }, "0.55.0"],
  ["Codex from a Homebrew cask", "codex", () => fakeCli(join(home, "homebrew", "Caskroom", "codex", "0.46.0", "codex-aarch64-apple-darwin")), "0.46.0"],
  ["Claude Code from Anthropic's installer", "claude", () => link(fakeCli(join(home, ".local", "share", "claude", "versions", "2.1.300")), join(home, ".local", "bin", "claude")), "2.1.300"],
  ["Claude Code from the Claude app", "claude", () => fakeCli(join(home, "Library", "Application Support", "Claude", "claude-code", "2.1.290", "claude.app", "Contents", "MacOS", "claude")), "2.1.290"],
  ["Claude Code's old local install", "claude", () => {
    file(join(home, ".claude", "local", "node_modules", "@anthropic-ai", "claude-code", "package.json"), { name: "@anthropic-ai/claude-code", version: "2.0.1" });
    return fakeCli(join(home, ".claude", "local", "claude"));
  }, "2.0.1"],
  ["an unknown Codex", "codex", () => fakeCli(join(home, "bin", "codex")), null],
] as const)("Setup telemetry reads the version of %s from its files", async (_name, cli, install, version) => {
  found.paths = { [cli]: install() };
  expect((await firstLaunchSnapshot())[`${cli}_cli_version`]).toBe(version);
  expect(existsSync(marker)).toBe(false);
});

posix("Setup telemetry reads Claude Code's login from its files", async () => {
  found.paths = { claude: fakeCli(join(home, "bin", "claude")) };
  file(join(home, ".claude.json"), { numStartups: 3 });
  expect(await firstLaunchSnapshot()).toMatchObject({ claude_logged_in: false, claude_plan: null });
  found.paths = {};
  expect(await firstLaunchSnapshot()).toMatchObject({ claude_logged_in: null, claude_plan: null });
  expect(existsSync(marker)).toBe(false);
});
