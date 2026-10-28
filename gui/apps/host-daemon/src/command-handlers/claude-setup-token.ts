import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { HostDaemonOnlineRpcResult } from "@cloudroom/host-daemon-contract";
import {
  normalizeWindowsEnv,
  preparePortablePtyCommand,
} from "@cloudroom/process-utils";
import {
  readClaudeToken,
  screenText,
} from "@cloudroom/process-utils/claude-token";
import { spawn as spawnPty, type IPty } from "node-pty";
import type { HostDaemonLogger } from "../logger.js";
import { ensureNodePtySpawnHelperExecutable } from "../terminals/terminal-manager.js";
import {
  CommandDispatchError,
  type CommandOf,
} from "../command-dispatch-support.js";

// Connect Claude on Windows: `claude setup-token` needs a terminal, and Windows
// has no `script`. It runs in this daemon's own pseudo-terminal, never a
// terminal session, so no terminal list, attach, replay or input API can reach
// its output. Only this command reads the link and token.

type Result = HostDaemonOnlineRpcResult<"claude.setup_token">;

interface Run {
  pty: IPty;
  output: string;
  exited: boolean;
  lastToken: string | undefined;
  dir: string;
  timer: NodeJS.Timeout;
}

const RUN_LIMIT_MS = 6 * 60_000;
const EXIT_DRAIN_MS = 500;
const TOKEN = /sk-ant-oat[A-Za-z0-9_-]*/g;
const runs = new Map<string, Run>();
const silentLogger: HostDaemonLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function stop(runId: string): void {
  const run = runs.get(runId);
  if (!run) return;
  runs.delete(runId);
  clearTimeout(run.timer);
  if (!run.exited) {
    try {
      run.pty.kill();
    } catch {
      // Already gone.
    }
  }
  rmSync(run.dir, { recursive: true, force: true });
}

function start(runId: string, binary: string): Run {
  const windows = process.platform === "win32";
  const dir = mkdtempSync(join(tmpdir(), "cloudroom-claude-"));
  // As on macOS, BROWSER hands back Claude's own link, which returns to this
  // computer by itself; the link Claude prints instead needs a pasted code.
  const browser = join(dir, windows ? "open.cmd" : "open");
  writeFileSync(
    browser,
    windows
      ? '@echo off\r\n>"%~dp0open.url" echo(%*\r\n'
      : "#!/bin/sh\nprintf '%s' \"$1\" > \"$0.url\"\n",
    { mode: 0o700 },
  );
  const cwd = homedir();
  const env = normalizeWindowsEnv({ ...process.env, BROWSER: browser });
  const launch = preparePortablePtyCommand({
    command: binary,
    args: ["setup-token"],
    cwd,
    env,
  });
  if (!windows) ensureNodePtySpawnHelperExecutable(silentLogger);
  let pty: IPty;
  try {
    pty = spawnPty(launch.command, launch.args, {
      cols: 500,
      rows: 50,
      cwd,
      env,
      name: "xterm-256color",
    });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw new CommandDispatchError(
      "claude_setup_token_failed",
      `Could not start Claude Code: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const run: Run = {
    pty,
    output: "",
    exited: false,
    lastToken: undefined,
    dir,
    timer: setTimeout(() => stop(runId), RUN_LIMIT_MS),
  };
  pty.onData((data) => {
    run.output = (run.output + data).slice(-65536);
  });
  pty.onExit(() => {
    setTimeout(() => {
      run.exited = true;
    }, EXIT_DRAIN_MS);
  });
  runs.set(runId, run);
  return run;
}

function read(run: Run | undefined): Result {
  if (!run) return { state: "missing", url: null, token: null, screen: [] };
  let url: string | null = null;
  try {
    url =
      readFileSync(join(run.dir, "open.url"), "utf8")
        .trim()
        .replace(/^"|"$/g, "") || null;
  } catch {
    // Claude has not asked for the browser yet.
  }
  const token = readClaudeToken(run.output, true);
  const settled = run.exited || token === run.lastToken;
  run.lastToken = token;
  return {
    state: run.exited ? "exited" : "running",
    url,
    token: settled ? (token ?? null) : null,
    screen: screenText(run.output, true)
      .split("\n")
      .map((line) => line.trim().replace(TOKEN, "[token]"))
      .filter(Boolean)
      .slice(-20),
  };
}

export async function claudeSetupToken(
  command: CommandOf<"claude.setup_token">,
): Promise<Result> {
  if (command.action === "read") return read(runs.get(command.runId));
  stop(command.runId);
  if (command.action === "cancel") return read(undefined);
  if (!command.binary) {
    throw new CommandDispatchError(
      "invalid_command",
      "claude.setup_token start needs the Claude Code binary",
    );
  }
  return read(start(command.runId, command.binary));
}
