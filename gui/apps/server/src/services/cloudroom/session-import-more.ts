import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { createProjectSource, listProjectSourcesByProjectIds, listPublicProjects, setProjectHidden, type StoredEventRow } from "@cloudroom/db";
import { tarCommand } from "@cloudroom/process-utils";
import type { AppDeps } from "../../types.js";
import { resolveSystemProviderModels } from "../system/execution-options.js";
import { getProviderInstallations } from "../system/provider-installations.js";
import { createThreadFromRequest } from "../threads/thread-create.js";
import { messagesSeed } from "../threads/thread-harness-switch.js";
import { localRepos } from "./local-repos.js";
import { claudeHome, compact, headLines, historyRows, mapLimit, parseLine, readLines, shorten, tailLines, type Found, type Line, type Turn } from "./session-import.js";

export type MoreHarness = "pi" | "acp-hermes-agent" | "t3code" | "conductor";

const APPS: Record<MoreHarness, string> = { pi: "Pi", "acp-hermes-agent": "Hermes Agent", t3code: "T3 Code", conductor: "Conductor" };
const piAgentDir = () => process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const piBridgeDir = () => process.env.BB_PI_BRIDGE_SESSION_DIR?.trim() || join(homedir(), ".bb", "pi-bridge-sessions");
const hermesDb = () => join(process.env.HERMES_HOME?.trim() || join(homedir(), ".hermes"), "state.db");
const t3Db = () => join(process.env.T3CODE_HOME?.trim() || join(homedir(), ".t3"), "userdata", "statev2.sqlite");
const T3_HARNESSES: Record<string, string> = { claudeAgent: "claude-code", codex: "codex", cursor: "acp-cursor", opencode: "acp-opencode", grok: "acp-grok", pi: "pi" };
const T3_LEGACY_ID = "CASE r.provider_name WHEN 'claudeAgent' THEN json_extract(r.resume_cursor_json, '$.resume') ELSE json_extract(r.resume_cursor_json, '$.threadId') END";
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const conductorDb = () => join(process.env.CONDUCTOR_APP_DIR?.trim() || join(homedir(), "Library", "Application Support", "com.conductor.app"), "conductor.db");
const CONDUCTOR_HARNESSES: Record<string, string> = { claude: "claude-code", codex: "codex", cursor: "acp-cursor", opencode: "acp-opencode" };
const EXPORT_CHAT = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;
const CONDUCTOR_FALLBACKS = ["claude-code", "codex"];
const agentChecks = new Map<string, { at: number; installed: Promise<boolean> }>();
const execFileAsync = promisify(execFile);

export const isMoreHarness = (harness: string): harness is MoreHarness => harness in APPS;
export const conductorAppFound = () => existsSync(dirname(conductorDb()));

export async function moreSessions(deps: AppDeps): Promise<Found[]> {
  await deps.providerRegistry.whenRegistrationsSettled();
  const scan = async (harness: MoreHarness, find: () => Promise<Found[]>) => {
    if ((harness === "pi" || harness === "acp-hermes-agent") && !deps.providerRegistry.get(harness)) return [];
    return find().catch((error: unknown) => {
      deps.logger.warn({ error, harness }, "Chat import scan failed");
      return [];
    });
  };
  return [...await scan("pi", piSessions), ...await scan("acp-hermes-agent", async () => hermesSessions()), ...await scan("t3code", async () => t3Sessions()), ...await scan("conductor", async () => conductorSessions())];
}

export async function moreTurns(session: Found): Promise<Turn[]> {
  if (session.harness === "pi") return piTurns(session.path);
  if (session.harness === "conductor") return conductorTurns(await conductorEvents(session));
  return session.harness === "t3code" ? t3Turns(session.path, session.id) : hermesTurns(session.path, session.id);
}

export async function createMoreThread(deps: AppDeps, args: { hostId: string; projectId: string; session: Found; turns: Turn[]; history: StoredEventRow[] }) {
  const { session } = args;
  const app = APPS[session.harness as MoreHarness];
  const agent = session.harness === "conductor" ? await conductorAgent(deps, args.hostId, session) : null;
  const providerId = agent?.providerId ?? (session.harness === "t3code" ? nativeHarness(deps, session) : session.harness);
  const sourceProviderThreadId = session.harness === "pi" ? await stagePiSession(session) : nativeFork(session, providerId) ?? (session.harness === "conductor" && session.native?.harness === providerId && providerId === "claude-code" ? await rebuildClaudeSession(deps, session) : undefined);
  const textOnly = sourceProviderThreadId === undefined;
  const turns = agent ? await conductorModels(deps, args.hostId, session, providerId, args.turns) : args.turns;
  const history = { kind: "rows" as const, rows: turns === args.turns ? args.history : historyRows(session, turns) };
  const messages = turns.flatMap((turn) => [{ role: "user" as const, text: turn.text }, ...turn.replies.map((reply) => ({ role: "agent" as const, text: reply.text }))]);
  const seed = textOnly ? await messagesSeed(deps.config.dataDir, args.projectId, messages, `[Cloudroom] This chat was imported from ${app} as text only. You are continuing it in a fresh session.`) : [];
  return createThreadFromRequest(deps, {
    projectId: args.projectId,
    providerId,
    title: session.title,
    environment: { type: "host", hostId: args.hostId, workspace: { type: "unmanaged", path: session.project ? session.cwd : null } },
    input: [{ type: "text", text: `Imported from ${app} session ${session.id}${textOnly ? " as text only" : ""}.`, mentions: [], visibility: "agent-only" }],
    origin: "sdk",
    startedOnBehalfOf: null,
    ...(agent?.installed === false && turns.at(-1)?.model !== "unknown" ? { model: turns.at(-1)?.model } : {}),
  }, sourceProviderThreadId === undefined
    ? { providerInput: [], importedText: { history, seed } }
    : { providerInput: [], importedFork: { descriptor: { sourceProviderThreadId }, history } });
}

async function stagePiSession(session: Found): Promise<string> {
  if (!SAFE_ID.test(session.id)) throw new Error("This Pi chat has an invalid session ID.");
  const staged = `import-${session.id}`;
  await mkdir(piBridgeDir(), { recursive: true, mode: 0o700 });
  await copyFile(session.path, join(piBridgeDir(), `${staged}.jsonl`));
  return staged;
}

async function piSessions(): Promise<Found[]> {
  const root = join(piAgentDir(), "sessions");
  const files = (await readdir(root, { recursive: true }).catch(() => [] as string[])).filter((file) => file.endsWith(".jsonl"));
  return compact(await mapLimit(files, async (file): Promise<Found | null> => {
    const path = join(root, file);
    const lines = await headLines(path, 256 * 1024).catch(() => []);
    const header = lines[0];
    const first = lines.map(piUserText).find(Boolean);
    if (header?.type !== "session" || typeof header.id !== "string" || !SAFE_ID.test(header.id) || typeof header.cwd !== "string" || !first) return null;
    const name = [...await tailLines(path, 64 * 1024).catch(() => [])].reverse().find((line) => line.type === "session_info" && typeof line.name === "string")?.name as string | undefined;
    const updatedAt = (await stat(path).catch(() => null))?.mtimeMs;
    return updatedAt === undefined ? null : { harness: "pi", id: header.id, title: shorten(name || first), cwd: header.cwd, updatedAt, path };
  }));
}

async function piTurns(path: string): Promise<Turn[]> {
  const lines: Line[] = [];
  for await (const line of readLines(path)) if (line.type !== "session") lines.push(line);
  const linked = lines.filter((line) => typeof line.id === "string");
  const entries = new Map(linked.map((line) => [line.id as string, line]));
  const branch: Line[] = [];
  for (let entry = linked.at(-1); entry && branch.length <= linked.length; entry = entries.get(entry.parentId)) branch.push(entry);
  const turns: Turn[] = [];
  let model = "unknown";
  for (const entry of linked.length ? branch.reverse() : lines) {
    const at = Date.parse(entry.timestamp) || Date.now();
    const user = piUserText(entry);
    if (user) { turns.push({ at, text: user, model, replies: [] }); continue; }
    const message = entry.type === "message" && entry.message?.role === "assistant" ? entry.message : null;
    if (!message) continue;
    if (typeof message.model === "string") model = message.model;
    const last = turns.at(-1);
    if (last?.replies.length === 0) last.model = model;
    const text = contentText(message.content);
    if (text) last?.replies.push({ at, text });
  }
  return turns;
}

function piUserText(line: Line): string | null {
  return line.type === "message" && line.message?.role === "user" ? contentText(line.message.content) : null;
}

function hermesSessions(): Found[] {
  const path = hermesDb();
  if (!existsSync(path)) return [];
  return withDb(path, (db) => {
    const columns = new Set((db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((column) => column.name));
    const optional = (name: string) => (columns.has(name) ? `s.${name}` : "NULL");
    const rows = db.prepare(`
      SELECT s.id, ${optional("title")} AS title, ${optional("cwd")} AS cwd,
        (SELECT content FROM messages WHERE session_id = s.id AND role = 'user' ORDER BY timestamp, id LIMIT 1) AS first,
        (SELECT MAX(timestamp) FROM messages WHERE session_id = s.id) AS lastAt
      FROM sessions s
      WHERE s.source NOT IN ('acp', 'cron', 'subagent', 'delegate') AND COALESCE(${optional("archived")}, 0) = 0
    `).all() as { id: string; title: string | null; cwd: string | null; first: unknown; lastAt: number | null }[];
    return compact(rows.map((row): Found | null => {
      const first = hermesText(row.first);
      if (!first || row.lastAt === null) return null;
      const cwd = row.cwd && existsSync(row.cwd) ? row.cwd : homedir();
      return { harness: "acp-hermes-agent", id: row.id, title: shorten(row.title || first), cwd, updatedAt: row.lastAt * 1000, path };
    }));
  });
}

function hermesTurns(path: string, id: string): Turn[] {
  return withDb(path, (db) => {
    const model = (db.prepare("SELECT model FROM sessions WHERE id = ?").get(id) as { model: string | null } | undefined)?.model || "unknown";
    const rows = db.prepare("SELECT role, content, timestamp FROM messages WHERE session_id = ? AND role IN ('user', 'assistant') ORDER BY timestamp, id").all(id) as { role: string; content: unknown; timestamp: number }[];
    const turns: Turn[] = [];
    for (const row of rows) {
      const text = hermesText(row.content);
      if (!text) continue;
      if (row.role === "user") turns.push({ at: row.timestamp * 1000, text, model, replies: [] });
      else turns.at(-1)?.replies.push({ at: row.timestamp * 1000, text });
    }
    return turns;
  });
}

function nativeHarness(deps: AppDeps, session: Found): string {
  return session.native && deps.providerRegistry.get(session.native.harness) ? session.native.harness : "claude-code";
}

function agentInstalled(deps: AppDeps, hostId: string, providerId: string): Promise<boolean> {
  const key = `${hostId}:${providerId}`;
  const cached = agentChecks.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.installed;
  const installed = getProviderInstallations(deps, { hostId, providerIds: [providerId] }).then((statuses) => statuses[providerId]?.installed ?? CONDUCTOR_FALLBACKS.includes(providerId), () => true);
  agentChecks.set(key, { at: Date.now(), installed });
  return installed;
}

async function conductorAgent(deps: AppDeps, hostId: string, session: Found): Promise<{ providerId: string; installed: boolean }> {
  const own = nativeHarness(deps, session);
  for (const providerId of new Set([own, ...CONDUCTOR_FALLBACKS])) {
    if (await agentInstalled(deps, hostId, providerId)) return { providerId, installed: true };
  }
  return { providerId: CONDUCTOR_FALLBACKS.includes(own) ? own : "claude-code", installed: false };
}

async function conductorModels(deps: AppDeps, hostId: string, session: Found, providerId: string, turns: Turn[]): Promise<Turn[]> {
  const moved = session.native?.harness !== providerId;
  if (!moved && turns.every((turn) => turn.model !== "unknown")) return turns;
  const models = (await resolveSystemProviderModels(deps, { hostId, providerId }).catch(() => null))?.models ?? [];
  const model = (models.find((entry) => entry.isDefault) ?? models[0] ?? deps.providerRegistry.get(providerId)?.fallbackModels[0])?.model ?? "unknown";
  return turns.map((turn) => (moved || turn.model === "unknown" ? { ...turn, model } : turn));
}

function nativeFork(session: Found, providerId: string): string | undefined {
  const native = session.native;
  return native?.path && !native.moved && native.harness === providerId ? native.id : undefined;
}

export function t3Claims(deps: AppDeps): Set<string> {
  const path = t3Db();
  if (!existsSync(path)) return new Set();
  try {
    return withDb(path, (db) => {
      const rows = db.prepare(`
        SELECT json_extract(payload_json, '$.driver') AS driver, json_extract(payload_json, '$.nativeThreadRef.nativeId') AS id FROM orchestration_v2_projection_provider_threads
        UNION ALL SELECT r.provider_name, ${T3_LEGACY_ID} FROM provider_session_runtime r
      `).all() as { driver: string | null; id: string | null }[];
      return new Set(rows.flatMap(({ driver, id }) => (driver && id && T3_HARNESSES[driver] ? [`${T3_HARNESSES[driver]}:${id}`] : [])));
    });
  } catch (error) {
    deps.logger.warn({ error }, "T3 Code chat scan failed");
    return new Set();
  }
}

function t3Sessions(): Found[] {
  const path = t3Db();
  if (!existsSync(path)) return [];
  return withDb(path, (db) => {
    const first = (table: string, text: string) => `(SELECT ${text} FROM ${table} m WHERE m.thread_id = t.thread_id AND m.role = 'user' ORDER BY m.created_at, m.message_id LIMIT 1)`;
    const rows = db.prepare(`
      SELECT t.thread_id AS id, t.title, t.updated_at AS updatedAt, p.workspace_root AS root,
        json_extract(t.payload_json, '$.worktreePath') AS worktree,
        json_extract(pt.payload_json, '$.driver') AS driver,
        json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') AS nativeId,
        COALESCE(r.provider_name, json_extract(t.payload_json, '$.providerInstanceId')) AS legacyDriver,
        ${T3_LEGACY_ID} AS legacyNativeId,
        COALESCE(${first("orchestration_v2_projection_messages", "json_extract(m.payload_json, '$.text')")}, ${first("projection_thread_messages", "m.text")}) AS first
      FROM orchestration_v2_projection_threads t
      JOIN projection_projects p ON p.project_id = t.project_id
      LEFT JOIN orchestration_v2_projection_provider_threads pt ON pt.provider_thread_id = t.active_provider_thread_id
      LEFT JOIN provider_session_runtime r ON r.thread_id = t.thread_id
      WHERE t.deleted_at IS NULL AND p.deleted_at IS NULL
        AND COALESCE(json_extract(t.payload_json, '$.lineage.relationshipToParent'), '') != 'subagent'
    `).all() as { id: string; title: string; updatedAt: string; root: string; worktree: string | null; driver: string | null; nativeId: string | null; legacyDriver: string | null; legacyNativeId: string | null; first: unknown }[];
    return compact(rows.map((row): Found | null => {
      const first = typeof row.first === "string" ? row.first.trim() : "";
      const updatedAt = Date.parse(row.updatedAt);
      if (!first || Number.isNaN(updatedAt)) return null;
      const [driver, nativeId] = row.driver ? [row.driver, row.nativeId] : [row.legacyDriver, row.legacyNativeId];
      const harness = driver ? T3_HARNESSES[driver] : undefined;
      const moved = row.worktree !== null && !existsSync(row.worktree);
      const native = harness ? { harness, ...(nativeId ? { id: nativeId } : {}), ...(moved ? { moved } : {}) } : undefined;
      return { harness: "t3code", id: row.id, title: shorten(row.title || first), cwd: moved ? row.root : row.worktree ?? row.root, updatedAt, path, ...(native ? { native } : {}) };
    }));
  });
}

function t3Turns(path: string, id: string): Turn[] {
  return withDb(path, (db) => {
    const read = (table: string, text: string) => db.prepare(`SELECT role, ${text} AS text, created_at AS at FROM ${table} WHERE thread_id = ? AND role IN ('user', 'assistant') ORDER BY created_at, message_id`).all(id) as { role: string; text: unknown; at: string }[];
    const v2 = read("orchestration_v2_projection_messages", "json_extract(payload_json, '$.text')");
    const v1 = read("projection_thread_messages", "text");
    const turns: Turn[] = [];
    for (const row of v1.length > v2.length ? v1 : v2) {
      const text = typeof row.text === "string" ? row.text.trim() : "";
      const at = Date.parse(row.at) || Date.now();
      if (!text) continue;
      if (row.role === "user") turns.push({ at, text, model: "unknown", replies: [] });
      else turns.at(-1)?.replies.push({ at, text });
    }
    return turns;
  });
}

export function conductorClaims(deps: AppDeps): Set<string> {
  const path = conductorDb();
  if (!existsSync(path)) return new Set();
  try {
    return withDb(path, (db) => {
      const rows = db.prepare("SELECT agent_type AS agent, claude_session_id AS id FROM sessions WHERE claude_session_id IS NOT NULL").all() as { agent: string | null; id: string }[];
      return new Set(rows.flatMap(({ agent, id }) => (CONDUCTOR_HARNESSES[agent || "claude"] ? [`${CONDUCTOR_HARNESSES[agent || "claude"]}:${id}`] : [])));
    });
  } catch (error) {
    deps.logger.warn({ error }, "Conductor chat scan failed");
    return new Set();
  }
}

function conductorSql(db: Database.Database) {
  const columns = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name));
  const workspace = columns("workspaces"), message = columns("session_messages");
  const keys = ["local_id", "id"].filter((key) => workspace.has(key)).map((key) => `w.${key}`);
  const sent = [message.has("sent_at") && "m.sent_at IS NOT NULL", message.has("cancelled_at") && "m.cancelled_at IS NULL"].filter(Boolean).join(" AND ");
  return {
    join: `s.workspace_id IN (${keys.join(", ") || "NULL"})`,
    worktree: workspace.has("workspace_path") ? "w.workspace_path" : "NULL",
    local: workspace.has("hosting_server_url") ? "COALESCE(w.hosting_server_url, '') IN ('', '/')" : "1",
    sent: sent ? ` AND (m.role <> 'user' OR (${sent}))` : "",
    full: message.has("full_message") ? "m.full_message" : "NULL",
  };
}

function conductorSessions(): Found[] {
  const path = conductorDb();
  if (!existsSync(path)) return [];
  return withDb(path, (db) => {
    const sql = conductorSql(db);
    let root = join(homedir(), "conductor");
    try {
      const setting = (db.prepare("SELECT value FROM settings WHERE key = 'conductor_root_path'").get() as { value: unknown } | undefined)?.value;
      if (typeof setting === "string" && setting) root = setting;
    } catch { /* no settings table */ }
    const rows = db.prepare(`
      SELECT s.id, s.title, s.agent_type AS agent, s.claude_session_id AS nativeId, w.directory_name AS dir, ${sql.worktree} AS worktree, r.name AS repo, r.root_path AS root,
        (SELECT m.content FROM session_messages m WHERE m.session_id = s.id AND m.role = 'user'${sql.sent} ORDER BY m.created_at LIMIT 1) AS first,
        (SELECT MAX(m.created_at) FROM session_messages m WHERE m.session_id = s.id${sql.sent}) AS lastAt
      FROM sessions s JOIN workspaces w ON ${sql.join} LEFT JOIN repos r ON r.id = w.repository_id
      WHERE ${sql.local}
    `).all() as { id: string; title: string | null; agent: string | null; nativeId: string | null; dir: string | null; worktree: string | null; repo: string | null; root: string | null; first: unknown; lastAt: unknown }[];
    const sessions = new Map<string, Found>();
    const orphans = new Map<string, string>();
    for (const row of rows) {
      const first = conductorUserText(row.first);
      const updatedAt = conductorTime(row.lastAt);
      if (!first || updatedAt === null || sessions.has(row.id)) continue;
      const base = row.root && existsSync(row.root) ? row.root : null;
      const worktree = [row.worktree, row.repo && row.dir && join(root, "workspaces", row.repo, row.dir), base && row.dir && join(base, ".conductor", row.dir)]
        .find((dir): dir is string => typeof dir === "string" && existsSync(dir));
      const repo = row.root ?? row.repo;
      if (worktree && !base && repo && !orphans.has(repo)) orphans.set(repo, worktree);
      const home = base ?? (repo ? orphans.get(repo) : undefined);
      const harness = CONDUCTOR_HARNESSES[row.agent || "claude"];
      const nativeId = row.nativeId || (harness === "claude-code" ? row.id : null);
      sessions.set(row.id, {
        harness: "conductor", id: row.id, title: shorten(row.title && row.title !== "Untitled" ? row.title : first), cwd: worktree ?? base ?? homedir(), updatedAt, path,
        ...(worktree && home && worktree !== home ? { project: home } : {}),
        ...(worktree && !base && row.repo ? { projectName: row.repo } : {}),
        ...(harness ? { native: { harness, ...(nativeId ? { id: nativeId } : {}), ...(worktree ? {} : { moved: true }) } } : {}),
      });
    }
    return [...sessions.values()];
  });
}

type ConductorEvent = { at: number | null; user: string | null; agent: Line | null };

async function conductorEvents(session: Found): Promise<ConductorEvent[]> {
  return session.path.endsWith(".db") ? conductorDbEvents(session.path, session.id) : conductorExportEvents(session.path);
}

function conductorDbEvents(path: string, id: string): ConductorEvent[] {
  return withDb(path, (db) => {
    const sql = conductorSql(db);
    const rows = db.prepare(`SELECT m.role, m.content, ${sql.full} AS full, m.created_at AS at FROM session_messages m WHERE m.session_id = ?${sql.sent} ORDER BY m.created_at, m.rowid`).all(id) as { role: string; content: unknown; full: unknown; at: unknown }[];
    const json = (value: unknown) => (typeof value === "string" ? parseLine(value) : null);
    return rows.map((row) => ({ at: conductorTime(row.at), user: row.role === "user" ? conductorUserText(row.content) : null, agent: json(row.content) ?? json(row.full) }));
  });
}

async function rebuildClaudeSession(deps: AppDeps, session: Found): Promise<string | undefined> {
  try {
    const events = await conductorEvents(session);
    if (events.some(({ agent }) => agent?.type === "system" && agent.subtype === "compact_boundary")) return undefined;
    const cwd = await realpath(session.cwd);
    const id = randomUUID();
    const blocks = (line: Line | null, type: string): Line[] => (Array.isArray(line?.message?.content) ? line.message.content.filter((block: Line) => block?.type === type) : []);
    const called = new Set(events.flatMap(({ agent }) => blocks(agent, "tool_use").map((block) => block.id)));
    const answered = new Set(events.flatMap(({ agent }) => blocks(agent, "tool_result").map((block) => block.tool_use_id)));
    const version = events.find(({ agent }) => typeof agent?.claude_code_version === "string")?.agent?.claude_code_version ?? "2.1.0";
    const lines: Line[] = [];
    const add = (type: string, message: Line, at: number | null, extra: Line = {}) => lines.push({
      parentUuid: lines.at(-1)?.uuid ?? null, isSidechain: false, userType: "external", entrypoint: "sdk-ts", cwd, sessionId: id, version, gitBranch: "",
      type, message, uuid: randomUUID(), timestamp: new Date(at ?? Date.now()).toISOString(), ...extra,
    });
    for (const { at, user, agent } of events) {
      if (user) add("user", { role: "user", content: user }, at, { promptId: randomUUID() });
      else if ((agent?.type !== "assistant" && agent?.type !== "user") || agent.parent_tool_use_id || !Array.isArray(agent.message?.content)) continue;
      else {
        const content = agent.message.content.filter((block: Line) => (block?.type !== "tool_use" || answered.has(block.id)) && (block?.type !== "tool_result" || called.has(block.tool_use_id)));
        if (content.length) add(agent.type, { ...agent.message, content }, at, agent.type === "user" && blocks(agent, "text").length ? { isMeta: true } : {});
      }
    }
    if (!lines.some((line) => line.type === "assistant")) return undefined;
    const folder = join(claudeHome(), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(join(folder, `${id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, { mode: 0o600 });
    return id;
  } catch (error) {
    deps.logger.warn({ error }, "Conductor chat could not keep its memory");
    return undefined;
  }
}

export async function conductorExport(deps: AppDeps, input: string): Promise<{ sessions: Found[]; cleanup: () => Promise<void> }> {
  const unzipped = /\.zip$/i.test(input) ? await unzipExport(input) : null;
  const cleanup = async () => { if (unzipped) await rm(unzipped, { recursive: true, force: true }); };
  try {
    const root = await exportRoot(unzipped ?? input);
    const folders = await repoFolders(deps);
    const sessions: Found[] = [];
    for (const workspace of await readdir(root, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue;
      const dir = join(root, workspace.name);
      const repo = (await readExportJson(join(dir, "workspace.json")))?.repo_url;
      for (const file of await readdir(dir, { withFileTypes: true })) {
        const id = file.isFile() ? EXPORT_CHAT.exec(file.name)?.[1] : undefined;
        const chat = id ? await readExportJson(join(dir, file.name)) : null;
        const messages: Line[] = Array.isArray(chat?.messages) ? chat.messages : [];
        const first = messages.map((message) => (message.role === "user" ? exportUserText(message, null) : null)).find(Boolean);
        const updatedAt = conductorTime(messages.at(-1)?.created_at) ?? conductorTime(chat?.created_at);
        if (!id || !first || updatedAt === null) continue;
        const harness = CONDUCTOR_HARNESSES[typeof chat?.agent === "string" ? chat.agent : "claude"];
        const sessionId = messages.map((message) => message.content?.thread_id ?? (message.content?.type === "system" ? message.content.session_id : null)).find((value) => typeof value === "string") ?? id;
        sessions.push({
          harness: "conductor", id, title: shorten(typeof chat?.title === "string" && chat.title ? chat.title : first),
          cwd: folders.get(remoteKey(repo) ?? "") ?? homedir(), updatedAt, path: join(dir, file.name), ...(typeof repo === "string" ? { repo } : {}),
          ...(harness ? { native: { harness, id: sessionId, moved: true } } : {}),
        });
      }
    }
    return { sessions, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function conductorExportEvents(file: string): Promise<ConductorEvent[]> {
  const chat = await readExportJson(file);
  const owner = (await readExportJson(join(dirname(dirname(file)), "user.json")))?.name;
  const messages: Line[] = Array.isArray(chat?.messages) ? chat.messages : [];
  return messages.map((message) => message.role === "user"
    ? { at: conductorTime(message.created_at), user: exportUserText(message, owner), agent: null }
    : { at: conductorTime(message.created_at), user: null, agent: message.content && typeof message.content === "object" ? message.content : null });
}

function conductorTurns(rows: ConductorEvent[]): Turn[] {
  const turns: Turn[] = [];
  let model = "unknown";
  for (const row of rows) {
    const at = row.at ?? Date.now();
    if (row.user) { turns.push({ at, text: row.user, model, replies: [] }); continue; }
    const reply = conductorReply(row.agent);
    if (reply?.model) {
      model = reply.model;
      const last = turns.at(-1);
      if (last) last.model = model;
    }
    if (reply?.text) turns.at(-1)?.replies.push({ at, text: reply.text });
  }
  return turns;
}

function conductorReply(line: Line | null): { text: string | null; model: string | null } | null {
  if (line?.type === "assistant" && !line.parent_tool_use_id) {
    const model = typeof line.message?.model === "string" && !line.message.model.startsWith("<") ? line.message.model : null;
    return { text: contentText(line.message?.content), model };
  }
  const event = line?.event ?? line;
  if (event?.type === "item.completed" && (event.item?.type === "agentMessage" || event.item?.type === "agent_message")) return { text: typeof event.item.text === "string" ? event.item.text.trim() || null : null, model: null };
  if (event?.type === "turn.completed" && typeof event.conductor_sdk_metadata?.model === "string") return { text: null, model: event.conductor_sdk_metadata.model };
  return null;
}

function conductorUserText(content: unknown): string | null {
  if (typeof content !== "string") return null;
  const line = content.startsWith("{") ? parseLine(content) : null;
  const text = line?.type === "user" ? contentText(line.message?.content) : content.trim() || null;
  return text && conductorMentions(text);
}

const conductorMentions = (text: string) => text.replace(/@⟦([^⟧]*)⟧\((?:[^()]|\([^()]*\))*\)/g, "@$1");

function conductorTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value) ? `${value.replace(" ", "T")}Z` : value);
  return Number.isNaN(at) ? null : at;
}

function exportUserText(message: Line, owner: unknown): string | null {
  const text = typeof message.content?.text === "string" ? conductorMentions(message.content.text.trim()) : "";
  const files = (Array.isArray(message.content?.attachments) ? message.content.attachments : [])
    .filter((file: unknown): file is string => typeof file === "string")
    .map((file: string) => basename(file).replace(/^[0-9a-f]{8}_/, ""))
    .filter((name: string) => !text.includes(`@${name}`));
  const body = [text, files.length ? `[Attached: ${files.join(", ")}]` : ""].filter(Boolean).join("\n\n");
  if (!body) return null;
  return typeof owner === "string" && typeof message.sender === "string" && message.sender && message.sender !== owner ? `${message.sender}: ${body}` : body;
}

async function exportRoot(folder: string): Promise<string> {
  const root = await realpath(folder).catch(() => { throw new Error(`Not found: ${folder}`); });
  if (existsSync(join(root, "user.json"))) return root;
  const inner = (await readdir(root, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "user.json")));
  if (inner.length === 1) return join(root, inner[0]!.name);
  throw new Error("This is not a Conductor export. Pick the folder that has user.json in it.");
}

async function readExportJson(path: string): Promise<Line | null> {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile()) return null;
  if (info.size > 64 * 1024 * 1024) throw new Error(`Cannot import ${basename(path)}: the file is larger than 64 MB.`);
  const value = parseLine(await readFile(path, "utf8"));
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

async function unzipExport(file: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "conductor-export-"));
  const [command, args] = process.platform === "linux" ? ["unzip", ["-q", file, "-d", dir]] : [tarCommand(), ["-xf", file, "-C", dir]];
  try {
    await execFileAsync(command, args, { timeout: 120_000 });
    return dir;
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`Could not unzip ${basename(file)}. Unzip it, then pick the folder.`, { cause: error });
  }
}

export function linkExportFolder(deps: AppDeps, hostId: string, session: Found): void {
  const key = remoteKey(session.repo);
  if (!key || session.cwd === homedir()) return;
  const projects = listPublicProjects(deps.db, "all");
  const sources = listProjectSourcesByProjectIds(deps.db, projects.map((project) => project.id));
  if (sources.some((source) => source.path === session.cwd)) return;
  const project = projects.find(({ id, gitRemoteUrl }) => remoteKey(gitRemoteUrl) === key && !sources.some((source) => source.projectId === id && source.hostId === hostId));
  if (!project) return;
  setProjectHidden(deps.db, deps.hub, project.id, false);
  createProjectSource(deps.db, deps.hub, { projectId: project.id, type: "local_path", hostId, path: session.cwd });
}

async function repoFolders(deps: AppDeps): Promise<Map<string, string>> {
  const folders = new Map<string, string>();
  const add = (remote: unknown, path: string | null | undefined) => {
    const key = remoteKey(remote);
    if (key && path && !folders.has(key) && existsSync(path)) folders.set(key, path);
  };
  const projects = listPublicProjects(deps.db, "all");
  const sources = listProjectSourcesByProjectIds(deps.db, projects.map((project) => project.id));
  for (const project of projects) for (const source of sources) if (source.projectId === project.id) add(project.gitRemoteUrl, source.path);
  for (const repo of await localRepos(100)) add(repo.remote, repo.path);
  try {
    if (existsSync(conductorDb())) withDb(conductorDb(), (db) => (db.prepare("SELECT remote_url, root_path FROM repos").all() as { remote_url: unknown; root_path: string | null }[]).forEach((repo) => add(repo.remote_url, repo.root_path)));
  } catch (error) {
    deps.logger.warn({ error }, "Conductor repo scan failed");
  }
  return folders;
}

function remoteKey(remote: unknown): string | null {
  if (typeof remote !== "string") return null;
  return remote.trim().toLowerCase().replace(/^[a-z+]+:\/\//, "").replace(/^[^@/]+@/, "").replace(/^([^/:]+):/, "$1/").replace(/\/+$/, "").replace(/\.git$/, "") || null;
}

function withDb<T>(path: string, read: (db: Database.Database) => T): T {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function hermesText(content: unknown): string | null {
  if (typeof content !== "string") return null;
  const parts = content.startsWith("[{") ? parseLine(content) : null;
  return Array.isArray(parts) ? contentText(parts) : content.trim() || null;
}

function contentText(content: unknown): string | null {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content) ? content.filter((part: Line) => part?.type === "text" && typeof part.text === "string").map((part: Line) => part.text).join("\n") : "";
  return text.trim() || null;
}
