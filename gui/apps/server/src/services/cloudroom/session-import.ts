import { createReadStream, existsSync } from "node:fs";
import { open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { isNotNull } from "drizzle-orm";
import { events, findOrCreateProjectByLocalPathSource, getThread, type StoredEventRow } from "@cloudroom/db";
import type { AppDeps } from "../../types.js";
import { createThreadFromRequest } from "../threads/thread-create.js";
import { fillProjectGitRemote } from "../projects/project-source-setup.js";
import { requireNonDestroyedHostWithStatus } from "../lib/entity-lookup.js";
import { assertUsableHostId } from "../hosts/primary-host.js";
import { parseStoredEvent } from "../threads/thread-data.js";
import { createClientTurnRequestId } from "../threads/thread-events.js";
import { waitForStart } from "./bb-import.js";
import { createMoreThread, isMoreHarness, moreSessions, moreTurns, t3Claims, type MoreHarness } from "./session-import-more.js";

export type SessionHarness = "claude-code" | "codex" | MoreHarness;
export interface NativeSession { harness: SessionHarness; id: string; title: string; cwd: string; updatedAt: number }
export interface SessionImportResult {
  imported: { harness: SessionHarness; id: string; threadId: string; title: string }[];
  skipped: { harness: SessionHarness; id: string; title: string; reason: string }[];
}

export interface Found extends NativeSession { path: string; native?: { harness: string; id?: string; path?: string; moved?: boolean } }
export interface Turn { at: number; text: string; model: string; replies: { at: number; text: string }[] }
export type Line = Record<string, any>;

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");
const OWN_CODEX_ORIGINATORS = /^(bb|cloudroom|cloud_agents|codex_exec|teleport)/;
let running: Promise<SessionImportResult> | null = null;

export async function listNativeSessions(deps: AppDeps): Promise<NativeSession[]> {
  return (await findSessions(deps)).map(({ path: _path, native: _native, ...session }) => session);
}

export function importNativeSessions(deps: AppDeps, hostId: string, wanted: { harness: SessionHarness; id: string }[]): Promise<SessionImportResult> {
  running ??= run(deps, hostId, wanted).finally(() => { running = null; });
  return running;
}

async function run(deps: AppDeps, hostId: string, wanted: { harness: SessionHarness; id: string }[]): Promise<SessionImportResult> {
  requireNonDestroyedHostWithStatus(deps, hostId);
  assertUsableHostId(deps, { hostId });
  await deps.providerRegistry.whenRegistrationsSettled();
  const mapPath = join(deps.config.dataDir, "session-imports.json");
  const map: Record<string, string> = existsSync(mapPath) ? JSON.parse(await readFile(mapPath, "utf8")) : {};
  const found = new Map((await findSessions(deps)).map((session) => [`${session.harness}:${session.id}`, session]));
  const result: SessionImportResult = { imported: [], skipped: [] };
  for (const { harness, id } of wanted) {
    const key = `${harness}:${id}`;
    const session = found.get(key);
    const skip = (reason: string) => result.skipped.push({ harness, id, title: session?.title ?? id, reason });
    if (!session) { skip("Not found, or already in Cloudroom."); continue; }
    if (!existsSync(session.cwd)) { skip(`Its folder no longer exists: ${session.cwd}`); continue; }
    try {
      const turns = harness === "claude-code" ? await claudeTurns(session.path) : harness === "codex" ? await codexTurns(session.path) : await moreTurns(session);
      if (!turns.length) { skip("No messages to bring over."); continue; }
      const thread = await createImportedThread(deps, hostId, session, turns);
      map[key] = thread.id;
      if (session.native?.id) map[`${session.native.harness}:${session.native.id}`] = thread.id;
      await writeFile(mapPath, JSON.stringify(map, null, 2), { mode: 0o600 });
      if (await waitForStart(deps, thread.id) === "error") skip(`Copied to ${thread.id}, but it could not be set up. Open it to retry.`);
      else result.imported.push({ harness, id, threadId: thread.id, title: session.title });
    } catch (error) {
      skip(error instanceof Error ? error.message : String(error));
    }
  }
  return result;
}

async function findSessions(deps: AppDeps): Promise<Found[]> {
  const mapPath = join(deps.config.dataDir, "session-imports.json");
  const map: Record<string, string> = existsSync(mapPath) ? JSON.parse(await readFile(mapPath, "utf8")) : {};
  const known = new Set(deps.db.selectDistinct({ id: events.providerThreadId }).from(events).where(isNotNull(events.providerThreadId)).all().map((row) => row.id));
  const imported = ({ harness, id }: { harness: string; id?: string }) => {
    const threadId = map[`${harness}:${id}`];
    return threadId !== undefined && getThread(deps.db, threadId)?.deletedAt === null;
  };
  const [claude, codex] = await Promise.all([claudeFiles(), codexFiles()]);
  const files = new Map<string, string>([
    ...claude.map((path) => [`claude-code:${basename(path, ".jsonl")}`, path] as const),
    ...codex.map((path) => [`codex:${basename(path, ".jsonl").slice(-36)}`, path] as const),
  ]);
  const sessions = [...await claudeSessions(claude), ...await codexSessions(codex), ...await moreSessions(deps)];
  const claimed = t3Claims(deps);
  for (const { native } of sessions) if (native?.id) native.path = files.get(`${native.harness}:${native.id}`);
  return sessions
    .filter((session) => !claimed.has(`${session.harness}:${session.id}`) && !known.has(session.id) && !imported(session) && !(session.native?.id && imported(session.native)))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

async function claudeFiles(): Promise<string[]> {
  const root = join(claudeHome(), "projects");
  const folders = await readdir(root).catch(() => [] as string[]);
  return (await Promise.all(folders.map(async (folder) =>
    (await readdir(join(root, folder)).catch(() => [] as string[])).filter((file) => file.endsWith(".jsonl") && !file.startsWith("agent-")).map((file) => join(root, folder, file)))))
    .flat();
}

async function codexFiles(): Promise<string[]> {
  const root = join(codexHome(), "sessions");
  return (await readdir(root, { recursive: true }).catch(() => [] as string[])).filter((file) => /rollout-.*\.jsonl$/.test(file)).map((file) => join(root, file));
}

async function claudeSessions(files: string[]): Promise<Found[]> {
  return compact(await mapLimit(files, async (path): Promise<Found | null> => {
    // Stream until the first human message: newer Claude Code can write hundreds of KB of api-request lines before it.
    let cwd: string | undefined, first: string | undefined;
    for await (const line of readLines(path, 4 * 1024 * 1024)) {
      if (line.isSidechain === true || /^sdk/.test(line.entrypoint ?? "")) return null;
      cwd ??= typeof line.cwd === "string" ? line.cwd : undefined;
      first ??= claudeUserText(line) ?? undefined;
      if (cwd && first) break;
    }
    if (!cwd || !first) return null;
    const tail = await tailLines(path, 64 * 1024);
    const named = (type: string, field: string) => [...tail].reverse().find((line) => line.type === type && typeof line[field] === "string" && line[field] !== "New session")?.[field] as string | undefined;
    const title = named("custom-title", "customTitle") ?? named("ai-title", "aiTitle") ?? named("summary", "summary") ?? first;
    return { harness: "claude-code", id: basename(path, ".jsonl"), title: shorten(title), cwd, updatedAt: (await stat(path)).mtimeMs, path };
  }));
}

async function codexSessions(files: string[]): Promise<Found[]> {
  const names = new Map<string, string>();
  for (const line of (await readFile(join(codexHome(), "session_index.jsonl"), "utf8").catch(() => "")).split("\n")) {
    const entry = parseLine(line);
    if (typeof entry?.id === "string" && typeof entry.thread_name === "string") names.set(entry.id, entry.thread_name);
  }
  return compact(await mapLimit(files, async (path): Promise<Found | null> => {
    const lines = await headLines(path, 512 * 1024);
    const meta = lines[0]?.type === "session_meta" ? lines[0].payload : null;
    if (!meta?.id || !meta.cwd || !["cli", "vscode"].includes(meta.source) || OWN_CODEX_ORIGINATORS.test(meta.originator ?? "")) return null;
    const first = lines.map((line) => codexMessage(line, "UserMessage")).find(Boolean);
    if (!first) return null;
    return { harness: "codex", id: meta.id, title: shorten(names.get(meta.id) ?? first), cwd: meta.cwd, updatedAt: (await stat(path)).mtimeMs, path };
  }));
}

async function claudeTurns(path: string): Promise<Turn[]> {
  const turns: Turn[] = [];
  let model = "unknown";
  for await (const line of readLines(path)) {
    if (line.isSidechain === true) continue;
    const at = Date.parse(line.timestamp) || Date.now();
    const user = claudeUserText(line);
    if (user) { turns.push({ at, text: user, model, replies: [] }); continue; }
    if (line.type !== "assistant" || !Array.isArray(line.message?.content)) continue;
    if (typeof line.message.model === "string" && !line.message.model.startsWith("<")) model = line.message.model;
    const last = turns.at(-1);
    if (last?.replies.length === 0) last.model = model;
    const text = line.message.content.filter((block: Line) => block.type === "text").map((block: Line) => block.text).join("\n").trim();
    if (text) turns.at(-1)?.replies.push({ at, text });
  }
  return turns;
}

async function codexTurns(path: string): Promise<Turn[]> {
  const turns: Turn[] = [];
  let model = "unknown";
  for await (const line of readLines(path)) {
    if (line.type === "turn_context" && typeof line.payload?.model === "string") model = line.payload.model;
    const at = Date.parse(line.timestamp) || Date.now();
    const user = codexMessage(line, "UserMessage");
    if (user) { turns.push({ at, text: user, model, replies: [] }); continue; }
    const reply = codexMessage(line, "AgentMessage");
    if (reply) turns.at(-1)?.replies.push({ at, text: reply });
  }
  return turns;
}
function claudeUserText(line: Line): string | null {
  if (line.type !== "user" || line.isMeta || (line.origin?.kind && line.origin.kind !== "human")) return null;
  const content = line.message?.content;
  const raw = typeof content === "string" ? content : Array.isArray(content) ? content.filter((block: Line) => block.type === "text").map((block: Line) => block.text).join("\n") : "";
  const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  return text && !/^<(command-|local-command)/.test(text) ? text : null;
}

function codexMessage(line: Line, type: "UserMessage" | "AgentMessage"): string | null {
  const item = line.type === "event_msg" && line.payload?.type === "item_completed" ? line.payload.item : null;
  if (item?.type !== type || !Array.isArray(item.content)) return null;
  return item.content.map((part: Line) => typeof part.text === "string" ? part.text : "").join("\n").trim() || null;
}

async function createImportedThread(deps: AppDeps, hostId: string, session: Found, turns: Turn[]) {
  const history = historyRows(session, turns);
  history.forEach(parseStoredEvent);
  const { project } = findOrCreateProjectByLocalPathSource(deps.db, deps.hub, {
    name: basename(session.cwd) || session.cwd,
    source: { type: "local_path", hostId, path: session.cwd },
  });
  await fillProjectGitRemote(deps, project, { hostId, path: session.cwd });
  if (isMoreHarness(session.harness)) return createMoreThread(deps, { hostId, projectId: project.id, session, turns, history });
  const app = session.harness === "codex" ? "Codex" : "Claude Code";
  return createThreadFromRequest(deps, {
    projectId: project.id,
    providerId: session.harness,
    title: session.title,
    environment: { type: "host", hostId, workspace: { type: "unmanaged", path: null } },
    input: [{ type: "text", text: `Imported from ${app} session ${session.id}.`, mentions: [], visibility: "agent-only" }],
    origin: "sdk",
    startedOnBehalfOf: null,
  }, {
    providerInput: [],
    importedFork: { descriptor: { sourceProviderThreadId: session.id }, history: { kind: "rows", rows: history } },
  });
}
function historyRows(session: Found, turns: Turn[]): StoredEventRow[] {
  const rows: StoredEventRow[] = [];
  const prefix = randomUUID().slice(0, 10);
  const providerThreadId = session.id;
  const add = (type: StoredEventRow["type"], at: number, data: object, turnId: string | null, item?: string) => rows.push({
    id: "", threadId: "", type, data: JSON.stringify(data), turnId, itemId: item ?? null, itemKind: item ? "agentMessage" : null,
    parentToolCallId: null, providerThreadId: null, scopeKind: turnId ? "turn" : "thread", sequence: rows.length + 1, createdAt: at,
  });
  turns.forEach((turn, index) => {
    const turnId = `${prefix}-t${index}`;
    const requestId = createClientTurnRequestId();
    const first = index === 0;
    add("client/turn/requested", turn.at, {
      direction: "outbound", source: first ? "spawn" : "tell", initiator: "user", requestId, senderThreadId: null,
      request: { method: first ? "thread/start" : "turn/start", params: {} },
      input: [{ type: "text", text: turn.text, mentions: [] }],
      target: { kind: first ? "thread-start" : "new-turn" },
      execution: { model: turn.model, permissionMode: "full", reasoningLevel: "medium", serviceTier: "default", source: "client/turn/requested" },
    }, null);
    add("turn/started", turn.at, { providerThreadId }, turnId);
    add("turn/input/accepted", turn.at, { providerThreadId, clientRequestId: requestId }, turnId);
    turn.replies.forEach((reply, replyIndex) => {
      const itemId = `${turnId}-i${replyIndex}`;
      add("item/completed", reply.at, { providerThreadId, item: { type: "agentMessage", id: itemId, text: reply.text } }, turnId, itemId);
    });
    add("turn/completed", turn.replies.at(-1)?.at ?? turn.at, { providerThreadId, status: "completed" }, turnId);
  });
  return rows;
}

export async function* readLines(path: string, bytes?: number): AsyncGenerator<Line> {
  const input = createReadStream(path, { end: bytes === undefined ? undefined : bytes - 1 });
  try {
    for await (const text of createInterface({ input, crlfDelay: Infinity })) {
      const line = parseLine(text);
      if (line) yield line;
    }
  } finally {
    input.destroy();
  }
}

export async function headLines(path: string, bytes: number): Promise<Line[]> {
  const text = await readSlice(path, 0, bytes);
  return compact(text.split("\n").slice(0, text.length < bytes ? undefined : -1).map(parseLine));
}

export async function tailLines(path: string, bytes: number): Promise<Line[]> {
  const size = (await stat(path)).size;
  const text = await readSlice(path, Math.max(0, size - bytes), bytes);
  return compact(text.split("\n").slice(size > bytes ? 1 : 0).map(parseLine));
}

async function readSlice(path: string, start: number, bytes: number): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await file.read(buffer, 0, bytes, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

export function parseLine(text: string): Line | null {
  if (!text.trim()) return null;
  try { return JSON.parse(text) as Line; } catch { return null; }
}

export function shorten(text: string): string {
  const line = text.split("\n").map((part) => part.trim()).find(Boolean)?.replace(/( \(fork\))+$/, "") ?? "Imported chat";
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}
export async function mapLimit<T, R>(items: T[], task: (item: T) => Promise<R>, limit = 16): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await task(items[index]!); }
  }));
  return results;
}

export function compact<T>(items: (T | null | undefined)[]): T[] {
  return items.filter((item): item is T => item != null);
}
