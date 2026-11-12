import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, symlink, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { applyThreadLifecycleEvent, createRemoteProject, getEnvironment, getProject, getThread, listProjectSourcesByProjectIds } from "@cloudroom/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importConductorExport, importNativeSessions, listConductorExport, listNativeSessions } from "../../src/services/cloudroom/session-import.js";
import { resolveDeferredFirstTurnContext } from "../../src/services/threads/deferred-first-turn-context.js";
import { getLastExecutionOptions } from "../../src/services/threads/thread-events.js";
import { pendingImportFork } from "../../src/services/threads/thread-fork-history.js";
import { sendThreadMessage } from "../../src/services/threads/thread-send.js";
import { threadMessages } from "../../src/services/threads/thread-transcript.js";
import { reportQueuedCommandSuccess, waitForQueuedCommand } from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import { seedHostSession } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

afterEach(() => vi.unstubAllEnvs());

async function fixtures() {
  const root = await mkdtemp(join(tmpdir(), "import-more-"));
  const project = join(root, "project");
  const piDir = join(root, "pi", "sessions", "--project--");
  for (const dir of [project, piDir, join(root, "hermes"), join(root, "hermes-project"), join(root, "claude-project"), join(root, "claude", "projects", "-claude-project")]) {
    await mkdir(dir, { recursive: true });
  }
  for (const [name, value] of [["PI_CODING_AGENT_DIR", "pi"], ["BB_PI_BRIDGE_SESSION_DIR", "pi-bridge"], ["HERMES_HOME", "hermes"], ["CLAUDE_CONFIG_DIR", "claude"], ["CODEX_HOME", "codex"], ["T3CODE_HOME", "t3"]]) {
    vi.stubEnv(name!, join(root, value!));
  }
  const at = (second: number) => `2026-10-01T10:00:0${second}.000Z`;
  await writeFile(join(piDir, "2026-10-01_pi-1.jsonl"), [
    { type: "session", version: 3, id: "pi-1", timestamp: at(0), cwd: project },
    { type: "message", id: "a1", parentId: null, timestamp: at(1), message: { role: "user", content: "Fix the login bug" } },
    { type: "message", id: "a2", parentId: "a1", timestamp: at(2), message: { role: "assistant", model: "sonnet", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] } },
    { type: "message", id: "a3", parentId: "a2", timestamp: at(3), message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "TOOL_RESULT_TEXT" }] } },
    { type: "message", id: "a4", parentId: "a3", timestamp: at(4), message: { role: "assistant", model: "sonnet", content: [{ type: "text", text: "Fixed it." }] } },
    { type: "message", id: "b1", parentId: "a4", timestamp: at(5), message: { role: "user", content: [{ type: "text", text: "Abandoned branch" }] } },
    { type: "message", id: "a5", parentId: "a4", timestamp: at(6), message: { role: "user", content: [{ type: "text", text: "Now add a test" }] } },
    { type: "session_info", id: "a6", parentId: "a5", timestamp: at(7), name: "Login fix" },
  ].map((line) => JSON.stringify(line)).join("\n"));
  await writeFile(join(root, "claude", "projects", "-claude-project", "claude-1.jsonl"), [
    { type: "user", cwd: join(root, "claude-project"), timestamp: at(1), message: { role: "user", content: "Refactor the API" } },
    { type: "assistant", timestamp: at(2), message: { model: "claude-test", content: [{ type: "text", text: "Done refactoring." }] } },
    { type: "user", isCompactSummary: true, isVisibleInTranscriptOnly: true, timestamp: at(3), message: { role: "user", content: `This session is being continued from a previous conversation.${" Summary.".repeat(9_000)}` } },
    { type: "user", timestamp: at(4), message: { role: "user", content: "<command-name>/exit</command-name>" } },
    { type: "last-prompt", lastPrompt: "Refactor the API" },
  ].map((line) => JSON.stringify(line)).join("\n"));
  await utimes(join(root, "claude", "projects", "-claude-project", "claude-1.jsonl"), new Date("2026-10-09"), new Date("2026-10-09"));
  await writeFile(join(piDir, "2026-09-01_pi-old.jsonl"), [
    { type: "session", id: "pi-old", timestamp: at(0), cwd: project },
    { type: "message", timestamp: at(1), message: { role: "user", content: "Old format question" } },
    { type: "message", timestamp: at(2), message: { role: "assistant", content: [{ type: "text", text: "Old format answer" }] } },
  ].map((line) => JSON.stringify(line)).join("\n"));
  await writeFile(join(piDir, "2026-09-02_bad.jsonl"), JSON.stringify({ type: "session", id: "../victim", cwd: project }) + "\n" + JSON.stringify({ type: "message", id: "x", parentId: null, message: { role: "user", content: "Escape" } }));
  await mkdir(join(piDir, "unreadable.jsonl"));
  const codexItem = (type: string, text: string) => ({ timestamp: "2026-09-02T10:00:00.000Z", type: "event_msg", payload: { type: "item_completed", item: { type, content: [{ text }] } } });
  const codexDir = join(root, "codex", "sessions", "2026", "09", "01");
  await mkdir(codexDir, { recursive: true });
  const codexResponse = (role: string, text: string) => ({ type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } });
  const codexRollout = (id: string, question: string, items = true) => [
    { type: "session_meta", payload: { id, cwd: project, source: "cli", originator: "codex_cli_rs" } },
    codexResponse("user", "<environment_context>\n  <cwd>/project</cwd>\n</environment_context>"),
    codexResponse("user", question),
    codexResponse("assistant", "Compressed Codex answer"),
    codexItem("Plan", "1. Answer the question"),
    ...items ? [codexItem("UserMessage", question), codexItem("AgentMessage", "Compressed Codex answer")] : [],
    { timestamp: "2026-10-02T10:00:00.000Z", type: "event_msg", payload: { type: "thread_goal_updated" } },
  ].map((line) => JSON.stringify(line)).join("\n");
  const rollout = (id: string) => join(codexDir, `rollout-2026-09-01T10-00-00-${id}.jsonl`);
  await writeFile(`${rollout("0199a000-0000-7000-8000-00000000000c")}.zst`, zstdCompressSync(codexRollout("0199a000-0000-7000-8000-00000000000c", "Compressed Codex question")));
  await writeFile(`${rollout("0199a000-0000-7000-8000-00000000000d")}.zst`, zstdCompressSync(codexRollout("0199a000-0000-7000-8000-00000000000d", "Stale compressed copy")));
  await writeFile(rollout("0199a000-0000-7000-8000-00000000000d"), codexRollout("0199a000-0000-7000-8000-00000000000d", "Plain Codex question"));
  await utimes(rollout("0199a000-0000-7000-8000-00000000000d"), new Date("2026-09-01"), new Date("2026-09-01"));
  const resumed = [{ type: "event_msg", payload: { type: "task_started" } }, codexResponse("user", "Resumed question"), codexItem("UserMessage", "Resumed question"), codexItem("AgentMessage", "Resumed answer"),
    { type: "session_meta", payload: { id: "0199a000-0000-7000-8000-00000000000e", cwd: project, source: "cli" } }, codexResponse("user", "Resumed again"), codexResponse("assistant", "Again answer")];
  await writeFile(rollout("0199a000-0000-7000-8000-00000000000e"), [codexRollout("0199a000-0000-7000-8000-00000000000e", "Response-only Codex question", false), ...resumed.map((line) => JSON.stringify(line))].join("\n"));
  const db = new Database(join(root, "hermes", "state.db"));
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, started_at REAL NOT NULL, title TEXT, cwd TEXT, archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL);`);
  const session = db.prepare("INSERT INTO sessions (id, source, model, started_at, title, cwd) VALUES (?, ?, 'hermes-4', 1, ?, ?)");
  const message = db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)");
  session.run("h-cli", "cli", "Deploy plan", join(root, "hermes-project"));
  [["user", "Plan the deploy"], ["assistant", null], ["tool", "TOOL_RESULT_TEXT"], ["assistant", "Here is the plan."]].forEach(([role, content], index) => message.run("h-cli", role, content, 1_800_000_000 + index));
  session.run("h-telegram", "telegram", null, null);
  message.run("h-telegram", "user", JSON.stringify([{ type: "text", text: "Hi from Telegram" }]), 1_700_000_000);
  for (const source of ["cron", "acp"]) {
    session.run(`h-${source}`, source, null, project);
    message.run(`h-${source}`, "user", "Skip me", 1_700_000_000);
  }
  db.close();
  return { root, project };
}

async function t3Fixtures() {
  const root = await mkdtemp(join(tmpdir(), "import-t3-"));
  const project = join(root, "t3-project");
  const worktree = join(root, "t3-worktree");
  const gone = join(root, "deleted-worktree");
  const claudeDir = join(root, "claude", "projects", "-t3-worktree");
  const codexDir = join(root, "codex", "sessions", "2026", "10", "01");
  for (const dir of [project, worktree, claudeDir, codexDir, join(root, "t3", "userdata")]) await mkdir(dir, { recursive: true });
  for (const [name, value] of [["T3CODE_HOME", "t3"], ["CLAUDE_CONFIG_DIR", "claude"], ["CODEX_HOME", "codex"], ["PI_CODING_AGENT_DIR", "pi"], ["HERMES_HOME", "hermes"]]) {
    vi.stubEnv(name!, join(root, value!));
  }
  const ids = { codex: "0199a000-0000-7000-8000-000000000001", switched: "0199a000-0000-7000-8000-000000000002", gone: "0199a000-0000-7000-8000-000000000003", deleted: "0199a000-0000-7000-8000-000000000004", v1: "0199a000-0000-7000-8000-000000000005" };
  const lines = (items: object[]) => items.map((line) => JSON.stringify(line)).join("\n");
  const claude = (id: string, cwd: string) => writeFile(join(claudeDir, `${id}.jsonl`), lines([
    { type: "user", entrypoint: "sdk-ts", cwd, timestamp: "2026-10-01T10:00:01.000Z", message: { role: "user", content: "Native Claude text" } },
  ]));
  const codexItem = (type: string, text: string) => ({ type: "event_msg", payload: { type: "item_completed", item: { type, content: [{ text }] } } });
  const rollout = (id: string, cwd: string, body: object[]) => writeFile(join(codexDir, `rollout-2026-10-01T10-00-00-${id}.jsonl`), lines([
    { type: "session_meta", payload: { id, cwd, source: "vscode", originator: "T3 Code" } },
    ...body,
  ]));
  await claude("claude-t3", worktree);
  await claude("claude-v1", project);
  await rollout(ids.codex, project, [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Speed up the build" }] } },
    { type: "event_msg", payload: { type: "agent_message", message: "Build is faster." } },
  ]);
  for (const [id, cwd] of [[ids.switched, worktree], [ids.gone, gone], [ids.deleted, project], [ids.v1, project]] as const) {
    await rollout(id, cwd, [codexItem("UserMessage", "Native Codex text"), codexItem("AgentMessage", "Native Codex reply")]);
  }
  const db = new Database(join(root, "t3", "userdata", "statev2.sqlite"));
  db.exec(`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL, deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, active_provider_thread_id TEXT, updated_at TEXT NOT NULL, deleted_at TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
    CREATE TABLE orchestration_v2_projection_messages (message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE projection_thread_messages (message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE provider_session_runtime (thread_id TEXT PRIMARY KEY, provider_name TEXT NOT NULL, resume_cursor_json TEXT);`);
  db.prepare("INSERT INTO projection_projects VALUES ('p1', ?, NULL)").run(project);
  const thread = db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, 'p1', ?, ?, '2026-10-01T10:00:00.000Z', ?, ?)");
  const provider = (id: string, driver: string, nativeId: string) => db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?)").run(id, JSON.stringify({ driver, nativeThreadRef: { driver, nativeId, strength: "strong" } }));
  const message = db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES (?, ?, ?, ?, ?)");
  const legacy = db.prepare("INSERT INTO projection_thread_messages VALUES (?, ?, ?, ?, ?)");
  const runtime = db.prepare("INSERT INTO provider_session_runtime VALUES (?, ?, ?)");
  const add = (id: string, title: string, active: [string, string] | null, payload: object, messages: [string, string][], deletedAt: string | null = null) => {
    thread.run(id, title, active && `pt-${id}`, deletedAt, JSON.stringify(payload));
    if (active) provider(`pt-${id}`, ...active);
    messages.forEach(([role, text], index) => message.run(`${id}-m${index}`, id, role, `2026-10-01T10:00:0${index}.000Z`, JSON.stringify({ text })));
  };
  add("t3-claude", "Dark mode", ["claudeAgent", "claude-t3"], { worktreePath: worktree }, [["user", "Add dark mode"], ["assistant", "Dark mode added."]]);
  provider("pt-t3-claude-before", "codex", ids.switched);
  add("t3-codex", "Faster build", ["codex", ids.codex], { worktreePath: null }, [["user", "Speed up the build"], ["assistant", "Build is faster."]]);
  add("t3-cursor", "Cursor chat", ["cursor", "cursor-1"], {}, [["user", "Rename the app"], ["system", "SYSTEM_TEXT"], ["assistant", "Renamed it."]]);
  add("t3-antigravity", "Antigravity chat", ["antigravity", "ag-1"], {}, [["user", "Write the docs"], ["assistant", "Docs written."]]);
  add("t3-gone", "", ["codex", ids.gone], { worktreePath: gone }, [["user", "Preview only"]]);
  [["user", "Old V1 question"], ["assistant", "Old V1 answer"]].forEach(([role, text], index) => legacy.run(`gone-${index}`, "t3-gone", role, text, `2026-09-01T10:00:0${index}.000Z`));
  add("t3-v1", "V1 Codex chat", null, { providerInstanceId: "codex", historyOrigin: "v1_import" }, [["user", "V1 Codex question"]]);
  runtime.run("t3-v1", "codex", JSON.stringify({ threadId: ids.v1 }));
  add("t3-v1-claude", "V1 Claude chat", null, { providerInstanceId: "claudeAgent", historyOrigin: "v1_import" }, [["user", "V1 Claude question"]]);
  runtime.run("t3-v1-claude", "claudeAgent", JSON.stringify({ threadId: "t3-v1-claude", resume: "claude-v1" }));
  add("t3-subagent", "Subagent", ["codex", "sub-1"], { lineage: { parentThreadId: "t3-codex", relationshipToParent: "subagent" } }, [["user", "Child task"]]);
  add("t3-deleted", "Deleted", ["codex", ids.deleted], {}, [["user", "Gone"]], "2026-10-02T00:00:00.000Z");
  add("t3-empty", "Empty", ["codex", "empty-1"], {}, []);
  db.close();
  return { project, worktree, ids };
}

async function conductorFixtures() {
  const root = await mkdtemp(join(tmpdir(), "import-conductor-"));
  const repo = join(root, "repo");
  const worktree = join(root, "conductor", "workspaces", "repo", "lima");
  const claudeDir = join(root, "claude", "projects", "-lima");
  const codexDir = join(root, "codex", "sessions", "2026", "10", "01");
  const exportDir = join(root, "export", "conductor-export-2026-11-05");
  for (const dir of [repo, worktree, claudeDir, codexDir, join(root, "app"), join(root, "clone"), join(root, "conductor", "workspaces", "gone", "davis"), join(root, "conductor", "workspaces", "gone", "lagos"), join(exportDir, "Cloud_ab12"), join(exportDir, "Elsewhere_cd34"), join(exportDir, "Clone_ef56")]) await mkdir(dir, { recursive: true });
  for (const [name, value] of [["CONDUCTOR_APP_DIR", "app"], ["CLAUDE_CONFIG_DIR", "claude"], ["CODEX_HOME", "codex"], ["T3CODE_HOME", "t3"], ["PI_CODING_AGENT_DIR", "pi"], ["HERMES_HOME", "hermes"]]) {
    vi.stubEnv(name!, join(root, value!));
  }
  const ids = { claude: "c0ffee00-0000-4000-8000-000000000001", cloud: "c0ffee00-0000-4000-8000-000000000002", codex: "0199a000-0000-7000-8000-0000000000c1" };
  const lines = (items: object[]) => items.map((line) => JSON.stringify(line)).join("\n");
  await writeFile(join(claudeDir, `${ids.claude}.jsonl`), lines([{ type: "user", entrypoint: "sdk-ts", cwd: worktree, timestamp: "2026-10-01T10:00:00.000Z", message: { role: "user", content: "The login page crashes" } }]));
  await writeFile(join(codexDir, `rollout-2026-10-01T10-00-00-${ids.codex}.jsonl`), lines([
    { type: "session_meta", payload: { id: ids.codex, cwd: worktree, source: "exec", originator: "codex_sdk_ts" } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ text: "Speed up the build" }] } } },
  ]));
  const db = new Database(join(root, "app", "conductor.db"));
  db.exec(`CREATE TABLE repos (id TEXT PRIMARY KEY, name TEXT, root_path TEXT, remote_url TEXT);
    CREATE TABLE workspaces (local_id TEXT PRIMARY KEY, id TEXT, repository_id TEXT, directory_name TEXT, workspace_path TEXT, state TEXT, hosting_server_url TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT, agent_type TEXT, claude_session_id TEXT, title TEXT DEFAULT 'Untitled', is_hidden INTEGER DEFAULT 0);
    CREATE TABLE session_messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, full_message TEXT, created_at TEXT, sent_at TEXT, cancelled_at TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  db.prepare("INSERT INTO settings VALUES ('conductor_root_path', ?)").run(join(root, "conductor"));
  db.prepare("INSERT INTO repos VALUES ('r1', 'repo', ?, 'git@github.com:acme/repo.git')").run(repo);
  db.prepare("INSERT INTO repos VALUES ('r2', 'clone', ?, 'https://github.com/acme/clone.git')").run(join(root, "clone"));
  db.prepare("INSERT INTO repos VALUES ('r3', 'gone', ?, NULL)").run(join(root, "gone"));
  db.prepare("INSERT INTO workspaces VALUES ('w5', 'w5', 'r3', 'davis', ?, 'ready', NULL)").run(join(root, "conductor", "workspaces", "gone", "davis"));
  db.prepare("INSERT INTO workspaces VALUES ('w6', 'w6', 'r3', 'lagos', ?, 'ready', NULL)").run(join(root, "conductor", "workspaces", "gone", "lagos"));
  const workspace = db.prepare("INSERT INTO workspaces VALUES (?, ?, 'r1', ?, ?, ?, ?)");
  workspace.run("w1", "w1", "lima", worktree, "ready", null);
  workspace.run("w2", "w2", "oslo", join(root, "conductor", "workspaces", "repo", "oslo"), "archived", "");
  workspace.run("w3", "w3", "lima", null, "ready", "/");
  workspace.run("w4", "w4", "cloud", "/home/vercel-sandbox/repo", "ready", "https://conductor.example");
  const session = db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)");
  const message = db.prepare("INSERT INTO session_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const say = (sessionId: string, role: string, content: object | string | null, at: number, extra: { full?: object; sent?: string | null; cancelled?: string } = {}) => message.run(
    `${sessionId}-${at}`, sessionId, role, typeof content === "string" || content === null ? content : JSON.stringify(content), extra.full ? JSON.stringify(extra.full) : null,
    `2026-10-01T10:00:0${at}.000Z`, extra.sent === undefined ? `2026-10-01T10:00:0${at}.000Z` : extra.sent, extra.cancelled ?? null,
  );
  const reply = (text: string, model = "claude-opus-5-5") => ({ type: "assistant", parent_tool_use_id: null, message: { model, content: [{ type: "text", text }] } });
  session.run("s1", "w1", "claude", ids.claude, "Fix login", 0);
  say("s1", "user", "The login page crashes", 0);
  say("s1", "assistant", { type: "assistant", message: { content: [{ type: "thinking", thinking: "THINKING_TEXT" }] } }, 1);
  say("s1", "assistant", reply("Found the crash."), 2);
  say("s1", "assistant", { type: "user", message: { content: [{ type: "tool_result", content: "TOOL_RESULT_TEXT" }] } }, 3);
  say("s1", "assistant", { type: "result", result: "Found the crash." }, 4);
  say("s1", "user", "QUEUED_TEXT", 5, { sent: null });
  say("s1", "user", "CANCELLED_TEXT", 6, { cancelled: "2026-10-01T10:00:07.000Z" });
  session.run("s2", "w1", "claude", "c0ffee00-0000-4000-8000-00000000000b", "Untitled", 0);
  say("s2", "user", { type: "user", message: { role: "user", content: [{ type: "text", text: "Add a regression test" }] } }, 0);
  say("s2", "assistant", null, 1, { full: reply("Test added.") });
  session.run("s3", "w1", "claude", null, "Closed tab", 1);
  say("s3", "user", "Old closed chat", 0);
  session.run("s4", "w2", "claude", null, "Archived work", 0);
  say("s4", "user", "Archived question", 0);
  say("s4", "assistant", reply("Archived answer."), 1);
  session.run("s5", "w3", "codex", ids.codex, "Faster build", 0);
  say("s5", "user", "Speed up the build", 0);
  say("s5", "assistant", { event: { type: "item.completed", item: { id: "i1", type: "agentMessage", text: "Build is faster.", phase: "final_answer" } }, thread_id: ids.codex }, 1);
  session.run("s11", "w5", "claude", null, "Repo folder gone", 0);
  say("s11", "user", "Fix the footer", 0);
  say("s11", "assistant", reply("Fixed it."), 1);
  session.run("s12", "w6", "claude", null, "Second worktree", 0);
  say("s12", "user", "Fix the header", 0);
  say("s12", "assistant", reply("Fixed that too."), 1);
  session.run("s13", "w3", "gemini", null, "Unknown agent", 0);
  say("s13", "user", "Tidy the docs", 0);
  say("s13", "assistant", reply("Tidied them."), 1);
  session.run("s10", "w3", "cursor", null, "Cursor chat", 0);
  say("s10", "user", "Rename the app", 0);
  say("s10", "assistant", reply("Renamed it."), 1);
  session.run("s9", "w1", "claude", "c0ffee00-0000-4000-8000-00000000000c", "Compacted chat", 0);
  say("s9", "user", "A very long chat", 0);
  say("s9", "assistant", { type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: 1_000_000 } }, 1);
  say("s9", "assistant", reply("Still going."), 2);
  session.run("s8", "w3", "codex", "0199a000-0000-7000-8000-0000000000c2", "No Codex here", 0);
  say("s8", "user", "Tidy the imports", 0);
  say("s8", "assistant", { type: "item.completed", item: { id: "i1", type: "agent_message", text: "Imports are tidy." } }, 1);
  session.run("s6", "w4", "claude", null, "Cloud chat", 0);
  say("s6", "user", "Cloud only", 0);
  session.run("s7", "w1", "claude", null, "Untitled", 0);
  db.close();

  const chat = (title: string | null, messages: object[]) => JSON.stringify({ title, created_at: "2026-10-04T03:00:00.000Z", archived_at: null, agent: "claude", model: "opus-5-5-1m", workspace: "Cloud", messages });
  const agent = (at: number, content: object) => ({ role: "agent", sender: null, created_at: `2026-10-04T03:00:0${at}.000Z`, content });
  const user = (at: number, sender: string, text: string, attachments: string[] = []) => ({ role: "user", sender, created_at: `2026-10-04T03:00:0${at}.000Z`, content: { text, attachments } });
  await writeFile(join(exportDir, "user.json"), JSON.stringify({ name: "Maty", email: "maty@example.com" }));
  await writeFile(join(exportDir, "Cloud_ab12", "workspace.json"), JSON.stringify({ name: "Cloud", repo_url: "https://github.com/acme/repo", organization: "Acme" }));
  await writeFile(join(exportDir, "Cloud_ab12", `2026-10-04_Check_the_sandbox_${ids.cloud}.json`), chat("Check the sandbox", [
    user(0, "Maty", "@⟦shot (1).png⟧(.context%2Fattachments%2Fassets%2Fa1%2Fshot%20(1).png) Check the sandbox", ["Cloud_ab12/attachments/chat/18fc3eb2_shot (1).png", "Cloud_ab12/attachments/chat/c8e843cd_logs.txt"]),
    agent(1, { type: "system", subtype: "init", cwd: "/home/vercel-sandbox/repo", session_id: ids.cloud }),
    agent(2, { type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "thinking", thinking: "THINKING_TEXT", signature: "sig" }, { type: "tool_use", id: "toolu_done", name: "Bash", input: { command: "uname -a" } }] } }),
    agent(3, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_done", content: "TOOL_RESULT_TEXT" }] } }),
    agent(4, reply("Sandbox is fine.")),
    agent(5, { type: "result", subtype: "success", result: "Sandbox is fine." }),
    user(6, "Teammate", "Also check the logs"),
    agent(7, reply("Logs are clean.")),
    agent(8, { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_cut_off", name: "Bash", input: {} }] } }),
  ]));
  await writeFile(join(exportDir, "Cloud_ab12", `2026-10-04_Fix_login_${ids.claude}.json`), chat("Fix login", [user(0, "Maty", "The login page crashes")]));
  await writeFile(join(exportDir, "Cloud_ab12", "2026-10-04_Untitled_c0ffee00-0000-4000-8000-00000000000e.json"), chat(null, []));
  await writeFile(join(root, "outside.json"), chat("Outside", [user(0, "Maty", "OUTSIDE_TEXT")]));
  await symlink(join(root, "outside.json"), join(exportDir, "Cloud_ab12", "2026-10-04_Link_c0ffee00-0000-4000-8000-00000000000f.json"));
  await writeFile(join(exportDir, "Elsewhere_cd34", "workspace.json"), JSON.stringify({ name: "Elsewhere", repo_url: "https://github.com/acme/elsewhere" }));
  await writeFile(join(exportDir, "Elsewhere_cd34", "2026-10-05_Untitled_c0ffee00-0000-4000-8000-000000000010.json"), chat(null, [user(0, "Maty", "Plan the launch")]));
  await writeFile(join(exportDir, "Clone_ef56", "workspace.json"), JSON.stringify({ name: "Clone", repo_url: "https://github.com/acme/clone" }));
  await writeFile(join(exportDir, "Clone_ef56", "2026-10-06_Use_my_clone_c0ffee00-0000-4000-8000-000000000011.json"), chat("Use my clone", [user(0, "Maty", "Use my clone")]));
  return { root, repo, worktree, ids, exportDir: dirname(exportDir) };
}

async function importAll(harness: TestAppHarness, hostId: string, wanted: Parameters<typeof importNativeSessions>[2] | (() => ReturnType<typeof importNativeSessions>), installed: (agent: string) => boolean = () => true) {
  let importing = true;
  const attaching = (async () => {
    while (importing) {
      const queued = await waitForQueuedCommand(harness, ({ command }) => command.type === "environment.attach" || command.type === "project.inspect" || command.type === "provider.installation.status" || command.type === "provider.health", 100).catch(() => null);
      if (queued?.command.type === "provider.health") await reportQueuedCommandSuccess(harness, queued, { supported: true, health: { status: "ready", statusMessage: null, accountEmail: null, planLabel: null, installedVersion: null, minimumSupportedVersion: null, canInstall: false, canUpdate: false, loginCommand: null } });
      if (queued?.command.type === "project.inspect") await reportQueuedCommandSuccess(harness, queued, { path: queued.command.path, gitRemoteUrl: null });
      if (queued?.command.type === "provider.installation.status") await reportQueuedCommandSuccess(harness, queued, { executableName: queued.command.providerId, executablePath: null, installed: installed(queued.command.providerId), installSource: installed(queued.command.providerId) ? "external" : "notInstalled", currentVersion: null, latestVersion: null, minimumSupportedVersion: null, npmPackageName: null, npmGlobalPackageVersion: null, installAction: null, needsUpdate: false, versionUnsupported: false });
      if (queued?.command.type === "environment.attach") {
        await reportQueuedCommandSuccess(harness, queued, { path: queued.command.path, isGitRepo: true, isWorktree: false, branchName: "main", defaultBranch: "main", transcript: [] });
      }
    }
  })();
  const result = await (typeof wanted === "function" ? wanted() : importNativeSessions(harness.deps, hostId, wanted));
  importing = false;
  await attaching;
  return result;
}

async function sendFirstMessage(harness: TestAppHarness, threadId: string) {
  const deferred = resolveDeferredFirstTurnContext(harness.deps.db, threadId);
  const fork = pendingImportFork(harness.deps.db, threadId);
  const thread = getThread(harness.deps.db, threadId)!;
  await sendThreadMessage(harness.deps, {
    environment: getEnvironment(harness.deps.db, thread.environmentId!)!,
    payload: { input: textInput("What's next?"), mode: "start", model: "default", permissionMode: "full", reasoningLevel: "medium", serviceTier: "default" },
    thread,
    trigger: "user",
  });
  const start = await waitForQueuedCommand(harness, ({ command }) => command.type === "thread.start" && command.threadId === threadId);
  if (start.command.type !== "thread.start") throw new Error("Expected thread.start");
  const sent = start.command.input.map((part) => (part.type === "text" ? part.text : part.type)).join("\n");
  return { deferred, fork, startFork: start.command.fork, sent };
}

describe("Pi, Hermes, and T3 Code chat import", () => {
  it("lists every app, forks Claude Code and Pi on the first message, and hands Hermes the text", async () => {
    const { root, project } = await fixtures();
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host-import-more" });
      const sessions = await listNativeSessions(harness.deps);
      expect(sessions.map(({ harness: app, id, title, cwd }) => [app, id, title, cwd]).sort((a, b) => a[1]!.localeCompare(b[1]!))).toEqual([
        ["codex", "0199a000-0000-7000-8000-00000000000c", "Compressed Codex question", project],
        ["codex", "0199a000-0000-7000-8000-00000000000d", "Plain Codex question", project],
        ["codex", "0199a000-0000-7000-8000-00000000000e", "Response-only Codex question", project],
        ["claude-code", "claude-1", "Refactor the API", join(root, "claude-project")],
        ["acp-hermes-agent", "h-cli", "Deploy plan", join(root, "hermes-project")],
        ["acp-hermes-agent", "h-telegram", "Hi from Telegram", homedir()],
        ["pi", "pi-1", "Login fix", project],
        ["pi", "pi-old", "Old format question", project],
      ]);

      const result = await importAll(harness, host.id, [
        { harness: "claude-code", id: "claude-1" },
        { harness: "codex", id: "0199a000-0000-7000-8000-00000000000c" },
        { harness: "codex", id: "0199a000-0000-7000-8000-00000000000d" },
        { harness: "codex", id: "0199a000-0000-7000-8000-00000000000e" },
        { harness: "pi", id: "pi-1" },
        { harness: "pi", id: "pi-old" },
        { harness: "acp-hermes-agent", id: "h-cli" },
      ]);
      expect(result.skipped).toEqual([]);
      const threadId = (id: string) => result.imported.find((entry) => entry.id === id)!.threadId;

      const claude = await sendFirstMessage(harness, threadId("claude-1"));
      expect(claude.fork).toEqual({ sourceProviderThreadId: "claude-1" });
      expect(claude.deferred).toBeNull();
      expect(claude.startFork).toEqual({ sourceProviderThreadId: "claude-1" });
      expect(claude.sent).toBe("What's next?");

      expect(threadMessages(harness.deps.db, threadId("0199a000-0000-7000-8000-00000000000c"))).toEqual([
        { role: "user", text: "Compressed Codex question" },
        { role: "agent", text: "Compressed Codex answer" },
      ]);
      expect(threadMessages(harness.deps.db, threadId("0199a000-0000-7000-8000-00000000000d"))).toEqual([
        { role: "user", text: "Plain Codex question" },
        { role: "agent", text: "Compressed Codex answer" },
      ]);
      expect(threadMessages(harness.deps.db, threadId("0199a000-0000-7000-8000-00000000000e"))).toEqual([
        { role: "user", text: "Response-only Codex question" },
        { role: "agent", text: "Compressed Codex answer" },
        { role: "user", text: "Resumed question" },
        { role: "agent", text: "Resumed answer" },
        { role: "user", text: "Resumed again" },
        { role: "agent", text: "Again answer" },
      ]);
      expect(threadMessages(harness.deps.db, threadId("pi-1"))).toEqual([
        { role: "user", text: "Fix the login bug" },
        { role: "agent", text: "Fixed it." },
        { role: "user", text: "Now add a test" },
      ]);
      expect(threadMessages(harness.deps.db, threadId("pi-old"))).toEqual([
        { role: "user", text: "Old format question" },
        { role: "agent", text: "Old format answer" },
      ]);
      expect(existsSync(join(root, "pi-bridge", "import-pi-1.jsonl"))).toBe(true);
      const pi = await sendFirstMessage(harness, threadId("pi-1"));
      expect(pi.fork).toEqual({ sourceProviderThreadId: "import-pi-1" });
      expect(pi.deferred).toBeNull();
      expect(pi.startFork).toEqual({ sourceProviderThreadId: "import-pi-1" });
      expect(pi.sent).toBe("What's next?");

      const hermes = await sendFirstMessage(harness, threadId("h-cli"));
      expect(hermes.fork).toBeNull();
      expect(hermes.startFork).toBeUndefined();
      expect(hermes.sent).toContain("imported from Hermes Agent as text only");
      expect(hermes.sent).toContain("Plan the deploy");
      expect(hermes.sent).toContain("Here is the plan.");
      expect(hermes.sent).toContain("What's next?");
      expect(hermes.sent).not.toContain("TOOL_RESULT_TEXT");

      const updatedAt = Object.fromEntries(sessions.map(({ id, updatedAt }) => [id, updatedAt]));
      expect([updatedAt["claude-1"], updatedAt["0199a000-0000-7000-8000-00000000000d"]]).toEqual([Date.parse("2026-10-01T10:00:02.000Z"), Date.parse("2026-09-02T10:00:00.000Z")]);
      expect(threadMessages(harness.deps.db, threadId("claude-1"))).toEqual([{ role: "user", text: "Refactor the API" }, { role: "agent", text: "Done refactoring." }, { role: "user", text: "What's next?" }]);
    });
  }, 60_000);

  it("imports T3 Code chats: forks Claude Code and Codex, hands other agents the text, and hides duplicates", async () => {
    const { project, worktree, ids } = await t3Fixtures();
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host-import-t3" });
      const sessions = await listNativeSessions(harness.deps);
      expect(sessions.map(({ harness: app, id, title, cwd }) => [app, id, title, cwd]).sort((a, b) => a[1]!.localeCompare(b[1]!))).toEqual([
        ["t3code", "t3-antigravity", "Antigravity chat", project],
        ["t3code", "t3-claude", "Dark mode", worktree],
        ["t3code", "t3-codex", "Faster build", project],
        ["t3code", "t3-cursor", "Cursor chat", project],
        ["t3code", "t3-gone", "Preview only", project],
        ["t3code", "t3-v1", "V1 Codex chat", project],
        ["t3code", "t3-v1-claude", "V1 Claude chat", project],
      ]);
      expect(Object.keys(sessions[0]!)).not.toContain("native");

      const result = await importAll(harness, host.id, sessions.map(({ harness: app, id }) => ({ harness: app, id })));
      expect(result.skipped).toEqual([]);
      const threadId = (id: string) => result.imported.find((entry) => entry.id === id)!.threadId;
      const imported = (id: string) => ({ provider: getThread(harness.deps.db, threadId(id))!.providerId, fork: pendingImportFork(harness.deps.db, threadId(id)) });

      expect(imported("t3-claude")).toEqual({ provider: "claude-code", fork: { sourceProviderThreadId: "claude-t3" } });
      expect(threadMessages(harness.deps.db, threadId("t3-claude"))).toEqual([{ role: "user", text: "Add dark mode" }, { role: "agent", text: "Dark mode added." }]);
      expect(imported("t3-codex")).toEqual({ provider: "codex", fork: { sourceProviderThreadId: ids.codex } });
      expect(threadMessages(harness.deps.db, threadId("t3-codex"))).toEqual([{ role: "user", text: "Speed up the build" }, { role: "agent", text: "Build is faster." }]);
      expect(imported("t3-v1")).toEqual({ provider: "codex", fork: { sourceProviderThreadId: ids.v1 } });
      expect(imported("t3-v1-claude")).toEqual({ provider: "claude-code", fork: { sourceProviderThreadId: "claude-v1" } });
      expect(imported("t3-cursor")).toEqual({ provider: "acp-cursor", fork: null });
      expect(imported("t3-antigravity")).toEqual({ provider: "claude-code", fork: null });
      expect(imported("t3-gone")).toEqual({ provider: "codex", fork: null });
      expect(threadMessages(harness.deps.db, threadId("t3-gone"))).toEqual([{ role: "user", text: "Old V1 question" }, { role: "agent", text: "Old V1 answer" }]);

      expect((await sendFirstMessage(harness, threadId("t3-codex"))).startFork).toEqual({ sourceProviderThreadId: ids.codex });
      const cursor = await sendFirstMessage(harness, threadId("t3-cursor"));
      expect(cursor.startFork).toBeUndefined();
      expect(cursor.sent).toContain("imported from T3 Code as text only");
      expect(cursor.sent).toContain("Renamed it.");
      expect(cursor.sent).not.toContain("SYSTEM_TEXT");

      expect(await listNativeSessions(harness.deps)).toEqual([]);
    });
  }, 60_000);

  it("imports Conductor chats from its database and its Cloud export, each chat once", async () => {
    const { root, repo, worktree, ids, exportDir } = await conductorFixtures();
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host-import-conductor" });
      expect((await listNativeSessions(harness.deps)).map(({ harness: app, id, title, cwd }) => [app, id, title, cwd]).sort((a, b) => a[1]!.localeCompare(b[1]!))).toEqual([
        ["conductor", "s1", "Fix login", worktree],
        ["conductor", "s10", "Cursor chat", worktree],
        ["conductor", "s11", "Repo folder gone", join(root, "conductor", "workspaces", "gone", "davis")],
        ["conductor", "s12", "Second worktree", join(root, "conductor", "workspaces", "gone", "lagos")],
        ["conductor", "s13", "Unknown agent", worktree],
        ["conductor", "s2", "Add a regression test", worktree],
        ["conductor", "s3", "Closed tab", worktree],
        ["conductor", "s4", "Archived work", repo],
        ["conductor", "s5", "Faster build", worktree],
        ["conductor", "s8", "No Codex here", worktree],
        ["conductor", "s9", "Compacted chat", worktree],
      ]);

      const result = await importAll(harness, host.id, ["s1", "s2", "s3", "s4", "s5"].map((id) => ({ harness: "conductor" as const, id })));
      expect(result.skipped).toEqual([]);
      const threadId = (id: string, from = result) => from.imported.find((entry) => entry.id === id)!.threadId;
      const imported = (id: string, from = result) => {
        const thread = getThread(harness.deps.db, threadId(id, from))!;
        return { provider: thread.providerId, fork: pendingImportFork(harness.deps.db, thread.id), path: getEnvironment(harness.deps.db, thread.environmentId!)!.path, project: listProjectSourcesByProjectIds(harness.deps.db, [thread.projectId])[0]!.path };
      };
      expect(imported("s1")).toEqual({ provider: "claude-code", fork: { sourceProviderThreadId: ids.claude }, path: worktree, project: repo });
      expect(threadMessages(harness.deps.db, threadId("s1"))).toEqual([{ role: "user", text: "The login page crashes" }, { role: "agent", text: "Found the crash." }]);
      const rebuilt = { sourceProviderThreadId: expect.stringMatching(/^[0-9a-f-]{36}$/) };
      expect(imported("s2")).toEqual({ provider: "claude-code", fork: rebuilt, path: worktree, project: repo });
      expect(threadMessages(harness.deps.db, threadId("s2"))).toEqual([{ role: "user", text: "Add a regression test" }, { role: "agent", text: "Test added." }]);
      expect(imported("s3")).toEqual({ provider: "claude-code", fork: null, path: worktree, project: repo });
      const textOnly = await sendFirstMessage(harness, threadId("s3"));
      expect(textOnly.sent).toContain("imported from Conductor as text only");
      expect(textOnly.sent).toContain("Old closed chat");
      expect(imported("s4")).toEqual({ provider: "claude-code", fork: rebuilt, path: repo, project: repo });
      expect(imported("s5")).toEqual({ provider: "codex", fork: { sourceProviderThreadId: ids.codex }, path: worktree, project: repo });
      expect(threadMessages(harness.deps.db, threadId("s5"))).toEqual([{ role: "user", text: "Speed up the build" }, { role: "agent", text: "Build is faster." }]);
      expect((await listConductorExport(harness.deps, exportDir)).map(({ id, title, cwd }) => [id, title, cwd]).sort()).toEqual([
        [ids.cloud, "Check the sandbox", repo],
        ["c0ffee00-0000-4000-8000-000000000010", "Plan the launch", homedir()],
        ["c0ffee00-0000-4000-8000-000000000011", "Use my clone", join(root, "clone")],
      ]);
      const goneRepo = await importAll(harness, host.id, ["s11", "s12"].map((id) => ({ harness: "conductor" as const, id })));
      const [davis, lagos] = ["s11", "s12"].map((id) => getThread(harness.deps.db, threadId(id, goneRepo))!);
      expect(getProject(harness.deps.db, davis!.projectId)?.name).toBe("gone");
      expect(lagos!.projectId).toBe(davis!.projectId);
      expect(getEnvironment(harness.deps.db, lagos!.environmentId!)?.path).toBe(join(root, "conductor", "workspaces", "gone", "lagos"));
      const githubOnly = createRemoteProject(harness.deps.db, harness.deps.hub, { name: "Acme clone", gitRemoteUrl: "https://github.com/acme/clone.git" });
      const cloud = await importAll(harness, host.id, () => importConductorExport(harness.deps, host.id, exportDir));
      expect(cloud.skipped).toEqual([]);
      expect(imported(ids.cloud, cloud)).toEqual({ provider: "claude-code", fork: rebuilt, path: repo, project: repo });
      expect(threadMessages(harness.deps.db, threadId(ids.cloud, cloud))).toEqual([
        { role: "user", text: "@shot (1).png Check the sandbox\n\n[Attached: logs.txt]" },
        { role: "agent", text: "Sandbox is fine." },
        { role: "user", text: "Teammate: Also check the logs" },
        { role: "agent", text: "Logs are clean." },
      ]);
      const first = await sendFirstMessage(harness, threadId(ids.cloud, cloud));
      expect(first.sent).toBe("What's next?");
      const sessionId = first.startFork!.sourceProviderThreadId;
      const folder = (await realpath(repo)).replace(/[^a-zA-Z0-9]/g, "-");
      const session = (await readFile(join(root, "claude", "projects", folder, `${sessionId}.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(session.map(({ type, message }) => [type, typeof message.content === "string" ? message.content : message.content.map((block: { type: string }) => block.type)])).toEqual([
        ["user", "@shot (1).png Check the sandbox\n\n[Attached: logs.txt]"],
        ["assistant", ["thinking", "tool_use"]],
        ["user", ["tool_result"]],
        ["assistant", ["text"]],
        ["user", "Teammate: Also check the logs"],
        ["assistant", ["text"]],
      ]);
      expect(session.every((line, index) => line.parentUuid === (session[index - 1]?.uuid ?? null) && line.sessionId === sessionId && line.entrypoint === "sdk-ts")).toBe(true);
      expect((await importConductorExport(harness.deps, host.id, exportDir)).imported).toEqual([]);
      const cloneThread = getThread(harness.deps.db, threadId("c0ffee00-0000-4000-8000-000000000011", cloud))!;
      expect([cloneThread.projectId, getEnvironment(harness.deps.db, cloneThread.environmentId!)!.path]).toEqual([githubOnly.id, join(root, "clone")]);
    });
  }, 60_000);

  it.each([
    ["Codex is missing: a Codex chat moves to Claude Code", "s8", ["codex"], "claude-code", null, "test-provider-default"],
    ["the agent is unknown: the chat lands on Claude Code with its default model", "s13", [], "claude-code", null, "test-provider-default"],
    ["a Claude chat was compacted: it comes over as text", "s9", [], "claude-code", null, "claude-opus-5-5"],
    ["Claude Code is missing: a Claude chat moves to Codex", "s2", ["claude-code"], "codex", null, "test-provider-default"],
    ["no agent is installed: a Cursor chat stays readable on Claude Code", "s10", ["acp-cursor", "claude-code", "codex"], "claude-code", null, "test-provider-default"],
    ["no agent is installed: a Claude chat keeps its memory for later", "s2", ["claude-code", "codex"], "claude-code", { sourceProviderThreadId: expect.any(String) }, "claude-opus-5-5"],
  ])("imports a Conductor chat when %s", async (_name, id, missing, provider, fork, model) => {
    await conductorFixtures();
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: `host-import-${id}-${missing.length}-${provider}` });
      const { imported, skipped } = await importAll(harness, host.id, [{ harness: "conductor", id }], (agent) => !missing.includes(agent));
      expect(skipped).toEqual([]);
      const threadId = imported[0]!.threadId;
      expect([getThread(harness.deps.db, threadId)!.providerId, pendingImportFork(harness.deps.db, threadId)]).toEqual([provider, fork]);
      expect(threadMessages(harness.deps.db, threadId).length).toBe(2);
      expect(getLastExecutionOptions(harness.deps, threadId)?.model).toBe(model);
    });
  }, 60_000);

  it("dates imported chats by the original chat, and a later turn still moves one to the top", async () => {
    const root = await mkdtemp(join(tmpdir(), "import-dates-"));
    await mkdir(join(root, "claude", "projects", "p"), { recursive: true });
    await mkdir(join(root, "claude", "projects", "p-alias"), { recursive: true });
    for (const name of ["PI_CODING_AGENT_DIR", "BB_PI_BRIDGE_SESSION_DIR", "HERMES_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "T3CODE_HOME"]) vi.stubEnv(name, join(root, name === "CLAUDE_CONFIG_DIR" ? "claude" : name));
    const at = (month: number, minute: number) => `2026-0${month}-01T10:0${minute}:00.000Z`;
    for (const month of [1, 2, 3]) {
      await writeFile(join(root, "claude", "projects", "p", `chat-${month}.jsonl`), [{ type: "user", cwd: root, timestamp: at(month, 0), message: { role: "user", content: `Chat ${month}` } },
        { type: "assistant", timestamp: at(month, 5), message: { content: [{ type: "text", text: "Done." }] } }].map((line) => JSON.stringify(line)).join("\n"));
    }
    // Claude keeps one session under a folder alias and its real path: it imports once, even when asked for twice.
    await writeFile(join(root, "claude", "projects", "p-alias", "chat-1.jsonl"), await readFile(join(root, "claude", "projects", "p", "chat-1.jsonl")));
    await withTestHarness(async (harness) => {
      const hostId = seedHostSession(harness.deps, { id: "host-import-dates" }).host.id;
      expect((await listNativeSessions(harness.deps)).map(({ id }) => id)).toEqual(["chat-3", "chat-2", "chat-1"]);
      const result = await importAll(harness, hostId, [3, 2, 1, 1].map((month) => ({ harness: "claude-code", id: `chat-${month}` })));
      const threads = () => result.imported.map(({ threadId }) => getThread(harness.deps.db, threadId)!);
      expect(threads().map((thread) => [thread.title, thread.createdAt, thread.latestAttentionAt])).toEqual([3, 2, 1].map((month) => [`Chat ${month}`, Date.parse(at(month, 0)), Date.parse(at(month, 5))]));
      for (const type of ["run.preparing", "run.started", "run.succeeded"] as const) applyThreadLifecycleEvent(harness.deps.db, { threadId: result.imported[2]!.threadId, event: { type } });
      expect(threads()[2]!.latestAttentionAt).toBeGreaterThan(Date.now() - 60_000);
    });
  }, 60_000);
});

describe("Claude Code and Codex chat import", () => {
  it("puts chats from a repo, its subfolder, and its worktrees in one project", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "import-group-")));
    const repo = join(root, "app"), sub = join(repo, "web"), worktree = join(root, "codex-worktrees", "a1", "app"), claudeTree = join(repo, ".claude", "worktrees", "fix");
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "a.txt"), "a");
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-qm", "init");
    git("worktree", "add", "-q", worktree);
    git("worktree", "add", "-q", claudeTree);
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "claude"));
    vi.stubEnv("CODEX_HOME", join(root, "codex"));
    const claude = async (id: string, cwd: string) => {
      const dir = join(root, "claude", "projects", id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${id}.jsonl`), [
        { type: "user", cwd, timestamp: "2026-10-01T10:00:00.000Z", message: { role: "user", content: `Question ${id}` } },
        { type: "assistant", timestamp: "2026-10-01T10:00:01.000Z", message: { model: "claude-x", content: [{ type: "text", text: "Answer" }] } },
      ].map((line) => JSON.stringify(line)).join("\n"));
    };
    const codex = async (id: string, cwd: string) => {
      const dir = join(root, "codex", "sessions", "2026", "10", "01");
      await mkdir(dir, { recursive: true });
      const item = (type: string, text: string) => ({ timestamp: "2026-10-01T10:00:00.000Z", type: "event_msg", payload: { type: "item_completed", item: { type, content: [{ text }] } } });
      await writeFile(join(dir, `rollout-2026-10-01T10-00-00-${id}.jsonl`), [
        { type: "session_meta", payload: { id, cwd, source: "vscode", originator: "codex_desktop" } }, item("UserMessage", `Question ${id}`), item("AgentMessage", "Answer"),
      ].map((line) => JSON.stringify(line)).join("\n"));
    };
    const ids = { root: "0199b000-0000-7000-8000-000000000001", tree: "0199b000-0000-7000-8000-000000000002" };
    await claude("claude-sub", sub);
    await claude("claude-tree", claudeTree);
    await codex(ids.root, repo);
    await codex(ids.tree, worktree);
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host-import-group" });
      const result = await importAll(harness, host.id, [
        { harness: "claude-code", id: "claude-sub" }, { harness: "claude-code", id: "claude-tree" }, { harness: "codex", id: ids.root }, { harness: "codex", id: ids.tree },
      ]);
      expect(result.skipped).toEqual([]);
      const threads = result.imported.map(({ threadId }) => getThread(harness.deps.db, threadId)!);
      expect(new Set(threads.map((thread) => thread.projectId)).size).toBe(1);
      expect(listProjectSourcesByProjectIds(harness.deps.db, [threads[0]!.projectId]).map((source) => source.path)).toEqual([repo]);
      expect(threads.map((thread) => getEnvironment(harness.deps.db, thread.environmentId!)!.path)).toEqual([sub, claudeTree, repo, worktree]);
    });
  }, 60_000);
});
