import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { listThreadsWithPendingInteractionState } from "@cloudroom/db";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { providerLoginEnvironment } from "../hosts/host-environment.js";
import { requireConnectedPrimaryHostId } from "../hosts/primary-host.js";
import { toThreadListEntryResponses } from "../threads/thread-runtime-display.js";
import { claudeBinary } from "./claude-token.js";

const TIMEOUT_MS = 3 * 60_000;
const SCHEMA = { type: "object", properties: { threadIds: { type: "array", items: { type: "string" }, maxItems: 5 } }, required: ["threadIds"], additionalProperties: false };
/** Locked down like the app's other Claude helper (plugins/provider-claude-code/src/ai-inference.ts): Bash only, only these
 *  read-only commands, everything else denied, and none of the user's settings, hooks, MCP servers or saved sessions. */
const ARGS = [
  "-p", "--model", "claude-sonnet-5-5", "--effort", "high", "--no-session-persistence",
  "--tools", "Bash", "--allowedTools", ...["search", "list", "show", "history"].map((command) => `Bash(room-cli thread ${command}:*)`),
  "--permission-mode", "dontAsk", "--setting-sources", "project", "--settings", JSON.stringify({ disableAllHooks: true }),
  "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-chrome",
  "--output-format", "stream-json", "--verbose", "--json-schema", JSON.stringify(SCHEMA),
];

interface ClaudeResult { type?: string; is_error?: boolean; result?: string; structured_output?: { threadIds?: unknown } }

/** The run in progress. A new search stops it, so holding Cmd+Enter never stacks agents. */
let current: AbortController | null = null;

/** Cmd+K "Search deeper" (docs/scopes/search.md): one headless Claude Code run reads threads with room-cli and names the best 5. */
export async function deepSearch(deps: AppDeps, query: string, signal: AbortSignal) {
  const claude = claudeBinary();
  if (!claude) throw new ApiError(409, "claude_missing", "Search deeper needs Claude Code. Connect it in Settings → Agents.");
  current?.abort();
  const run = new AbortController();
  current = run;
  const stop = () => run.abort();
  signal.addEventListener("abort", stop, { once: true });
  // An empty folder as the project: no project settings or CLAUDE.md to load.
  const cwd = mkdtempSync(join(tmpdir(), "cloudroom-deep-search-"));
  try {
    const { code, result, stderr } = await runClaude(claude, prompt(query), cwd, await claudeEnv(deps), run.signal);
    if (run.signal.aborted) return [];
    const ids = result?.is_error ? null : result?.structured_output?.threadIds;
    if (!Array.isArray(ids)) {
      const reason = (result?.result?.trim() || stderr.trim() || `Claude Code exited with code ${code ?? "unknown"}.`).replace(/sk-[\w-]+/gu, "[redacted]");
      deps.logger.warn({ code, reason }, "Deep search failed");
      throw new ApiError(502, "deep_search_failed", /not logged in|\/login/iu.test(reason) ? "Sign in to Claude Code to search deeper." : code === null ? "Search deeper took too long." : reason);
    }
    const byId = new Map(listThreadsWithPendingInteractionState(deps.db, {}).map((thread) => [thread.id, thread]));
    return toThreadListEntryResponses(deps, { threads: ids.flatMap((id) => (typeof id === "string" && byId.get(id)) || []) });
  } finally {
    signal.removeEventListener("abort", stop);
    if (current === run) current = null;
    rmSync(cwd, { recursive: true, force: true });
  }
}

function prompt(query: string) {
  return `The user is looking for one of their Cloudroom threads: ${JSON.stringify(query)}. Find it with these read-only commands: \`room-cli thread search <words> --json\`, \`room-cli thread list --include-archived --fields id,title\`, and \`room-cli thread show <id> --no-pr\`. Return up to 5 thread IDs, best match first, or none if nothing fits.`;
}

/** The login the user's Claude threads run on (Accounts plugin pick or cloud login), plus room-cli on PATH. */
async function claudeEnv(deps: AppDeps): Promise<NodeJS.ProcessEnv> {
  const login = await providerLoginEnvironment(deps, { hostId: requireConnectedPrimaryHostId(deps), providerId: "claude-code" });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const { name, value } of login) {
    if (typeof value !== "string") continue;
    // A blank login variable means "unset": it clears one the machine's own shell sets.
    if (value === "") delete env[name];
    else env[name] = value;
  }
  delete env.CLAUDECODE;
  delete env.CLAUDE_AGENT_SDK_CLIENT_APP;
  const cli = process.env.ROOM_CLI;
  if (cli) env.PATH = `${dirname(cli)}${delimiter}${env.PATH ?? ""}`;
  return env;
}

/** Runs Claude with the prompt on stdin (closed at once, or Claude waits ~3 s for more), killed on abort or timeout. */
function runClaude(claude: string, input: string, cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal) {
  return new Promise<{ code: number | null; result: ClaudeResult | null; stderr: string }>((resolve) => {
    const child = spawn(claude, ARGS, { cwd, env, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, TIMEOUT_MS);
    signal.addEventListener("abort", kill, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-2_000)));
    const finish = (code: number | null) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      resolve({ code: timedOut ? null : code, result: resultLine(stdout), stderr });
    };
    child.once("error", (error) => {
      stderr = `Could not run Claude Code: ${error.message}`;
      finish(1);
    });
    child.once("close", finish);
    child.stdin.once("error", () => {});
    child.stdin.end(input);
  });
}

function resultLine(stdout: string): ClaudeResult | null {
  let result: ClaudeResult | null = null;
  for (const line of stdout.split("\n")) {
    try {
      const parsed = JSON.parse(line) as ClaudeResult;
      if (parsed?.type === "result") result = parsed;
    } catch {}
  }
  return result;
}
