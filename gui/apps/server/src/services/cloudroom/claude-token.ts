import { COMPUTER } from "@cloudroom/domain";
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execPortableFile, findCliExecutable } from "@cloudroom/process-utils";
import { claudeInstallerCommand, NO_TERMINAL, readClaudeToken, screenText, spawnInTerminal } from "@cloudroom/process-utils/claude-token";
import type { HostDaemonOnlineRpcResult } from "@cloudroom/host-daemon-contract";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { callHostOnlineRpc } from "../hosts/online-rpc.js";
import { resolvePrimaryHostId } from "../hosts/primary-host.js";
import { cliPlace, reportAgentConnect, reportCliInstall, scrub } from "./setup-telemetry.js";

export const isClaudeApiKey = (value: string) => /^sk-ant-(?!oat|ort|admin)[A-Za-z0-9_-]{1,1017}$/.test(value);
/** The Claude Code that Local threads run: PATH first, then common install folders. */
export const claudeBinary = () => findCliExecutable("claude") ?? undefined;
const failed = (message: string) => new ApiError(409, "claude_token_failed", message);
const windows = process.platform === "win32";
const here = windows ? "this PC" : `this ${COMPUTER}`;

const INSTALL = claudeInstallerCommand();
let installing: Promise<string> | null = null;
/** Installs Claude Code with Anthropic's official installer, which needs no terminal and puts it in ~/.local/bin. One install at a time. */
function installClaude(): Promise<string> {
  const started = Date.now();
  installing ??= new Promise<string>((resolve, reject) => {
    execFile(INSTALL.command, INSTALL.args, { timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      const binary = claudeBinary();
      const reason = stderr.trim().split("\n").at(-1) || (error?.killed ? "the download took longer than 10 minutes" : error?.message);
      reportCliInstall("claude", "claude_connect", binary ? "ok" : "failed", Date.now() - started, binary ? null : reason);
      if (binary) return resolve(binary);
      reject(failed(`Claude Code could not be installed${reason ? `: ${reason}` : ""}. Run \`${INSTALL.display}\` in ${windows ? "PowerShell" : "Terminal"}, then try again.`));
    });
  }).finally(() => { installing = null; });
  return installing;
}

/**
 * Connecting Claude means the user wants Claude Code in Cloudroom, so a missing CLI is installed silently (ADR 0193).
 * With the Claude desktop app's copy, sign-in goes ahead and the install runs in the background.
 */
export async function ensureClaudeCli(onError: (error: unknown) => void): Promise<void> {
  if (claudeBinary()) return;
  const install = installClaude();
  if (!desktopClaude()) await install;
  else void install.catch(onError);
}

/** The Claude Code that the Claude desktop app keeps for itself: its newest fully downloaded version. */
export function desktopClaude(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const root = join(homedir(), "Library/Application Support/Claude/claude-code");
  let versions: string[];
  try { versions = readdirSync(root); } catch { return undefined; }
  for (const version of versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
    const binary = join(root, version, "claude.app/Contents/MacOS/claude");
    try {
      if (!existsSync(join(root, version, ".verified"))) continue;
      accessSync(binary, constants.X_OK);
      return binary;
    } catch { /* incomplete version */ }
  }
  return undefined;
}

/** `claude auth status` on this Mac, or null when Claude Code is missing or the check fails. */
export function claudeAuthStatus(): Promise<{ loggedIn?: unknown; subscriptionType?: unknown } | null> {
  const binary = claudeBinary();
  if (!binary) return Promise.resolve(null);
  // Signed out exits 1 with valid JSON.
  return execPortableFile(binary, ["auth", "status", "--json"], { timeoutMs: 10_000, maxBuffer: 1024 * 1024 })
    .then(({ stdout }) => stdout, (error: { stdout?: string }) => error.stdout ?? "")
    .then((stdout) => { try { return JSON.parse(stdout) ?? null; } catch { return null; } });
}

/** The Mac's Claude plan, such as `max`. The VM needs it to offer plan-only models like Opus 1M. */
export async function claudePlan(): Promise<string | undefined> {
  const status = await claudeAuthStatus();
  const plan = status?.loggedIn === true ? status.subscriptionType : undefined;
  return typeof plan === "string" && /^[a-z_]{1,32}$/.test(plan) ? plan : undefined;
}

/** Whether Claude Code on this Mac has its own login; null when that can't be checked. */
export async function macClaudeSignedIn(): Promise<boolean | null> {
  const status = await claudeAuthStatus();
  return typeof status?.loggedIn === "boolean" ? status.loggedIn : null;
}

const isSignInUrl = (value: string) => {
  try {
    const url = new URL(value);
    return ["https://claude.ai", "https://claude.com", "https://platform.claude.com"].includes(url.origin) && ["/oauth/authorize", "/cai/oauth/authorize"].includes(url.pathname);
  } catch { return false; }
};


interface TokenRun { id: string; url: string | null; error: string | null; done: boolean; stop: () => void }
let tokenRun: TokenRun | null = null;

/**
 * Runs `claude setup-token` on this Mac for a one-year token (ADR 0121), using the Claude desktop app's copy when no CLI is installed.
 * `BROWSER` hands us Claude's sign-in link, so the app opens it itself. The token goes straight to `save`; it never reaches the UI.
 */
function runSetupToken(id: string, save: (token: string) => Promise<unknown>, deps?: AppDeps): TokenRun {
  const binary = claudeBinary() ?? desktopClaude();
  if (!binary) throw new ApiError(409, "claude_missing", `Claude Code isn't installed on ${here}.`);
  if (windows && deps) return runWindowsSetupToken(deps, id, binary, save);
  const dir = mkdtempSync(join(tmpdir(), "cloudroom-claude-"));
  const browser = join(dir, "open");
  writeFileSync(browser, `#!/bin/sh\nprintf '%s' "$1" > "$0.url"\n`, { mode: 0o700 });
  // A wide terminal keeps the token on one line.
  const child = spawnInTerminal(`stty cols 1000; exec "$CLAUDE_BIN" setup-token`, { ...process.env, CLAUDE_BIN: binary, BROWSER: browser });
  if (!child) {
    rmSync(dir, { recursive: true, force: true });
    reportAgentConnect("claude", "failed", { code: "missing_terminal", cliPlace: cliPlace(binary) });
    throw failed(NO_TERMINAL);
  }
  const stopChild = () => { try { process.kill(-child.pid!); } catch { /* already gone */ } };
  const run: TokenRun = { id, url: null, error: null, done: false, stop: () => finish("Claude sign-in was cancelled.") };
  let output = "";
  let saving = false;
  const started = Date.now();
  const finish = (error: string | null) => {
    if (run.done) return;
    Object.assign(run, { done: true, error });
    try { reportSetupToken(error, output, binary, Date.now() - started); } catch { /* telemetry never blocks sign-in */ }
    clearTimeout(timer);
    clearInterval(poll);
    stopChild();
    rmSync(dir, { recursive: true, force: true });
  };
  const timer = setTimeout(() => finish("Claude sign-in timed out. Try again."), 5 * 60_000);
  const poll = setInterval(() => {
    const url = (() => { try { return readFileSync(`${browser}.url`, "utf8").trim(); } catch { return ""; } })();
    if (isSignInUrl(url)) { run.url = url; clearInterval(poll); }
  }, 250);
  child.stdout.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-65536);
    const token = readClaudeToken(output);
    if (!token || saving) return;
    saving = true;
    stopChild();
    save(token).then(() => finish(null), (error: unknown) => finish(error instanceof Error ? error.message : String(error)));
  });
  child.on("error", () => finish("Could not start Claude Code on this computer."));
  child.on("close", () => { if (!saving) finish("Claude sign-in did not finish. Try again."); });
  return run;
}

type SetupTokenStep = (action: "start" | "read" | "cancel") => Promise<HostDaemonOnlineRpcResult<"claude.setup_token">>;

/** Windows has no `script`, so setup-token runs in a private pseudo-terminal in this PC's host daemon. Its output never
 *  becomes a terminal session; the daemon hands back only Claude's link and, once approved, the token. */
function runWindowsSetupToken(deps: AppDeps, id: string, binary: string, save: (token: string) => Promise<unknown>): TokenRun {
  const hostId = resolvePrimaryHostId(deps);
  if (!hostId) throw failed("This PC's local host is not ready yet. Try again in a moment.");
  return runDaemonSetupToken(id, binary, save, (action) => callHostOnlineRpc(deps, {
    hostId,
    timeoutMs: 15_000,
    command: { type: "claude.setup_token", action, runId: id, ...(action === "start" ? { binary } : {}) },
  }));
}

/** Polls the daemon's setup-token run. A failed call (the daemon disconnected) ends the sign-in at once. */
export function runDaemonSetupToken(id: string, binary: string, save: (token: string) => Promise<unknown>, step: SetupTokenStep): TokenRun {
  const run: TokenRun = { id, url: null, error: null, done: false, stop: () => finish("Claude sign-in was cancelled.") };
  let screen: string[] = [];
  let next: NodeJS.Timeout | undefined;
  const started = Date.now();
  const finish = (error: string | null) => {
    if (run.done) return;
    Object.assign(run, { done: true, error });
    try { reportSetupToken(error, screen.join("\n"), binary, Date.now() - started); } catch { /* telemetry never blocks sign-in */ }
    clearTimeout(timer);
    clearTimeout(next);
    void step("cancel").catch(() => {});
  };
  const timer = setTimeout(() => finish("Claude sign-in timed out. Try again."), 5 * 60_000);
  const check = (action: "start" | "read") => void step(action).then((result) => {
    if (run.done) return;
    screen = result.screen;
    if (result.url && isSignInUrl(result.url)) run.url = result.url;
    if (result.token) {
      clearTimeout(timer);
      void step("cancel").catch(() => {});
      save(result.token).then(() => finish(null), (error: unknown) => finish(error instanceof Error ? error.message : String(error)));
      return;
    }
    if (result.state !== "running") return finish("Claude sign-in did not finish. Try again.");
    next = setTimeout(() => check("read"), 500);
  }, () => finish(action === "start" ? "Could not start Claude Code on this computer." : "Cloudroom lost this PC's host during Claude sign-in. Try again."));
  check("start");
  return run;
}

const SETUP_TOKEN_CODES: Record<string, string> = {
  "Claude sign-in was cancelled.": "cancelled",
  "Claude sign-in timed out. Try again.": "timed_out",
  "Claude sign-in did not finish. Try again.": "exited_without_token",
  "Could not start Claude Code on this computer.": "could_not_start",
  "Cloudroom lost this PC's host during Claude sign-in. Try again.": "host_lost",
};
/** Telemetry for one sign-in, with Claude Code's last lines on screen: the only clue to why it quit early. */
function reportSetupToken(error: string | null, output: string, binary: string, ms: number) {
  const code = error === null ? null : SETUP_TOKEN_CODES[error] ?? "save_failed";
  const lines = screenText(output).split("\n").map(line => line.replace(/[✢✳✶✻✽·]/g, "").trim()).filter(Boolean);
  reportAgentConnect("claude", code === "cancelled" ? "cancelled" : error === null ? "ok" : "failed", {
    code,
    message: error === null ? null : code === "save_failed" ? error : scrub(lines.slice(-3).join(" | ")),
    ms,
    cliVersion: lines.join(" ").match(/Code ?v(\d+\.\d+\.\d+)/)?.[1] ?? null,
    cliPlace: cliPlace(binary),
  });
}

/** Starts Claude sign-in (or joins the running one) and waits briefly for its sign-in link. */
export async function startClaudeToken(id: string, save: (token: string) => Promise<unknown>, deps?: AppDeps): Promise<void> {
  if (!tokenRun || tokenRun.done) tokenRun = runSetupToken(id, save, deps);
  const run = tokenRun;
  for (let waited = 0; !run.url && !run.done && waited < 15_000; waited += 250) await new Promise(resolve => setTimeout(resolve, 250));
}

/** Stops the running sign-in; false when none was running. */
export function cancelClaudeToken(): boolean {
  const run = tokenRun;
  tokenRun = null;
  run?.stop();
  return Boolean(run);
}

/** Shows a running sign-in as `waiting` with its link. A finished run is reported once, then forgotten. */
export function withClaudeTokenRun<T extends { state: string; message: string | null; login_id: string | null; verification_url: string | null }>(status: T): T {
  const run = tokenRun;
  if (!run) return status;
  if (!run.done) return { ...status, state: "waiting", message: null, login_id: run.id, verification_url: run.url };
  tokenRun = null;
  return run.error ? { ...status, state: "error", message: run.error } : status;
}
