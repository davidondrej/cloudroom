import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getEnvironment, getThread } from "@cloudroom/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importNativeSessions, listNativeSessions } from "../../src/services/cloudroom/session-import.js";
import { resolveDeferredFirstTurnContext } from "../../src/services/threads/deferred-first-turn-context.js";
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
  ].map((line) => JSON.stringify(line)).join("\n"));
  await writeFile(join(piDir, "2026-09-01_pi-old.jsonl"), [
    { type: "session", id: "pi-old", timestamp: at(0), cwd: project },
    { type: "message", timestamp: at(1), message: { role: "user", content: "Old format question" } },
    { type: "message", timestamp: at(2), message: { role: "assistant", content: [{ type: "text", text: "Old format answer" }] } },
  ].map((line) => JSON.stringify(line)).join("\n"));
  await writeFile(join(piDir, "2026-09-02_bad.jsonl"), JSON.stringify({ type: "session", id: "../victim", cwd: project }) + "\n" + JSON.stringify({ type: "message", id: "x", parentId: null, message: { role: "user", content: "Escape" } }));
  await mkdir(join(piDir, "unreadable.jsonl"));
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
        ["claude-code", "claude-1", "Refactor the API", join(root, "claude-project")],
        ["acp-hermes-agent", "h-cli", "Deploy plan", join(root, "hermes-project")],
        ["acp-hermes-agent", "h-telegram", "Hi from Telegram", homedir()],
        ["pi", "pi-1", "Login fix", project],
        ["pi", "pi-old", "Old format question", project],
      ]);

      let importing = true;
      const attaching = (async () => {
        while (importing) {
          const queued = await waitForQueuedCommand(harness, ({ command }) => command.type === "environment.attach" || command.type === "project.inspect", 100).catch(() => null);
          if (queued?.command.type === "project.inspect") await reportQueuedCommandSuccess(harness, queued, { path: queued.command.path, gitRemoteUrl: null });
          if (queued?.command.type === "environment.attach") {
            await reportQueuedCommandSuccess(harness, queued, { path: queued.command.path, isGitRepo: true, isWorktree: false, branchName: "main", defaultBranch: "main", transcript: [] });
          }
        }
      })();
      const result = await importNativeSessions(harness.deps, host.id, [
        { harness: "claude-code", id: "claude-1" },
        { harness: "pi", id: "pi-1" },
        { harness: "pi", id: "pi-old" },
        { harness: "acp-hermes-agent", id: "h-cli" },
      ]);
      importing = false;
      await attaching;
      expect(result.skipped).toEqual([]);
      const threadId = (id: string) => result.imported.find((entry) => entry.id === id)!.threadId;

      const claude = await sendFirstMessage(harness, threadId("claude-1"));
      expect(claude.fork).toEqual({ sourceProviderThreadId: "claude-1" });
      expect(claude.deferred).toBeNull();
      expect(claude.startFork).toEqual({ sourceProviderThreadId: "claude-1" });
      expect(claude.sent).toBe("What's next?");

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

      let importing = true;
      const attaching = (async () => {
        while (importing) {
          const queued = await waitForQueuedCommand(harness, ({ command }) => command.type === "environment.attach" || command.type === "project.inspect", 100).catch(() => null);
          if (queued?.command.type === "project.inspect") await reportQueuedCommandSuccess(harness, queued, { path: queued.command.path, gitRemoteUrl: null });
          if (queued?.command.type === "environment.attach") {
            await reportQueuedCommandSuccess(harness, queued, { path: queued.command.path, isGitRepo: true, isWorktree: false, branchName: "main", defaultBranch: "main", transcript: [] });
          }
        }
      })();
      const result = await importNativeSessions(harness.deps, host.id, sessions.map(({ harness: app, id }) => ({ harness: app, id })));
      importing = false;
      await attaching;
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
});
