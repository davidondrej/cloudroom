import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StoredEventRow } from "@cloudroom/db";
import type { AppDeps } from "../../types.js";
import { createThreadFromRequest } from "../threads/thread-create.js";
import { messagesSeed } from "../threads/thread-harness-switch.js";
import { compact, headLines, mapLimit, parseLine, readLines, shorten, tailLines, type Found, type Line, type Turn } from "./session-import.js";

export type MoreHarness = "pi" | "acp-hermes-agent" | "t3code";

const APPS: Record<MoreHarness, string> = { pi: "Pi", "acp-hermes-agent": "Hermes Agent", t3code: "T3 Code" };
const piAgentDir = () => process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const piBridgeDir = () => process.env.BB_PI_BRIDGE_SESSION_DIR?.trim() || join(homedir(), ".bb", "pi-bridge-sessions");
const hermesDb = () => join(process.env.HERMES_HOME?.trim() || join(homedir(), ".hermes"), "state.db");
const t3Db = () => join(process.env.T3CODE_HOME?.trim() || join(homedir(), ".t3"), "userdata", "statev2.sqlite");
const T3_HARNESSES: Record<string, string> = { claudeAgent: "claude-code", codex: "codex", cursor: "acp-cursor", opencode: "acp-opencode", grok: "acp-grok", pi: "pi" };
const T3_LEGACY_ID = "CASE r.provider_name WHEN 'claudeAgent' THEN json_extract(r.resume_cursor_json, '$.resume') ELSE json_extract(r.resume_cursor_json, '$.threadId') END";
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const isMoreHarness = (harness: string): harness is MoreHarness => harness in APPS;

export async function moreSessions(deps: AppDeps): Promise<Found[]> {
  await deps.providerRegistry.whenRegistrationsSettled();
  const scan = async (harness: MoreHarness, find: () => Promise<Found[]>) => {
    if (harness !== "t3code" && !deps.providerRegistry.get(harness)) return [];
    return find().catch((error: unknown) => {
      deps.logger.warn({ error, harness }, "Chat import scan failed");
      return [];
    });
  };
  return [...await scan("pi", piSessions), ...await scan("acp-hermes-agent", async () => hermesSessions()), ...await scan("t3code", async () => t3Sessions())];
}

export async function moreTurns(session: Found): Promise<Turn[]> {
  if (session.harness === "pi") return piTurns(session.path);
  return session.harness === "t3code" ? t3Turns(session.path, session.id) : hermesTurns(session.path, session.id);
}

export async function createMoreThread(deps: AppDeps, args: { hostId: string; projectId: string; session: Found; turns: Turn[]; history: StoredEventRow[] }) {
  const { session } = args;
  const app = APPS[session.harness as MoreHarness];
  const providerId = session.harness === "t3code" ? t3Harness(deps, session) : session.harness;
  const sourceProviderThreadId = session.harness === "pi" ? await stagePiSession(session) : t3Fork(session, providerId);
  const textOnly = sourceProviderThreadId === undefined;
  const history = { kind: "rows" as const, rows: args.history };
  const messages = args.turns.flatMap((turn) => [{ role: "user" as const, text: turn.text }, ...turn.replies.map((reply) => ({ role: "agent" as const, text: reply.text }))]);
  const seed = textOnly ? await messagesSeed(deps.config.dataDir, args.projectId, messages, `[Cloudroom] This chat was imported from ${app} as text only. You are continuing it in a fresh session.`) : [];
  return createThreadFromRequest(deps, {
    projectId: args.projectId,
    providerId,
    title: session.title,
    environment: { type: "host", hostId: args.hostId, workspace: { type: "unmanaged", path: null } },
    input: [{ type: "text", text: `Imported from ${app} session ${session.id}${textOnly ? " as text only" : ""}.`, mentions: [], visibility: "agent-only" }],
    origin: "sdk",
    startedOnBehalfOf: null,
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

function t3Harness(deps: AppDeps, session: Found): string {
  return session.native && deps.providerRegistry.get(session.native.harness) ? session.native.harness : "claude-code";
}

function t3Fork(session: Found, providerId: string): string | undefined {
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
