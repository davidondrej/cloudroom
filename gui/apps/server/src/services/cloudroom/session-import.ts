import { execFile } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { open, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream";
import { createZstdDecompress } from "node:zlib";
import { randomUUID } from "node:crypto";
import { isNotNull } from "drizzle-orm";
import { events, findOrCreateProjectByLocalPathSource, getThread, listProjectSourcesByProjectIds, listPublicProjects, type StoredEventRow } from "@cloudroom/db";
import type { AppDeps } from "../../types.js";
import { createThreadFromRequest } from "../threads/thread-create.js";
import { fillProjectGitRemote } from "../projects/project-source-setup.js";
import { requireNonDestroyedHostWithStatus } from "../lib/entity-lookup.js";
import { assertUsableHostId } from "../hosts/primary-host.js";
import { parseStoredEvent } from "../threads/thread-data.js";
import { createClientTurnRequestId } from "../threads/thread-events.js";
import { requireThisComputer, waitForStart } from "./bb-import.js";
import { conductorClaims, conductorExport, createMoreThread, isMoreHarness, linkExportFolder, moreSessions, moreTurns, t3Claims, type MoreHarness } from "./session-import-more.js";

export type SessionHarness = "claude-code" | "codex" | MoreHarness;
export interface NativeSession { harness: SessionHarness; id: string; title: string; cwd: string; updatedAt: number }
export interface SessionImportResult {
  imported: { harness: SessionHarness; id: string; threadId: string; title: string }[];
  skipped: { harness: SessionHarness; id: string; title: string; reason: string }[];
}

export interface Found extends NativeSession { path: string; project?: string; projectName?: string; repo?: string; native?: { harness: string; id?: string; path?: string; moved?: boolean } }
export interface Turn { at: number; text: string; model: string; replies: { at: number; text: string }[] }
export type Line = Record<string, any>;

export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");
const OWN_CODEX_ORIGINATORS = /^(bb|cloudroom|cloud_agents|codex_exec|teleport)/;
const execFileAsync = promisify(execFile);
// Codex's model history adds these to user messages: setup context, AGENTS.md, shell commands, interrupts, image tags.
const CODEX_CONTEXT = /^(<(environment_context|user_instructions|user_shell_command|user_action|turn_aborted|subagent_notification|skill)>[\s\S]*<\/\2>|# AGENTS\.md instructions for [\s\S]*<\/INSTRUCTIONS>|<\/?image\b[^>]*>)$/i;
type CodexFormat = "event" | "response";
interface CodexLine { at: number; model?: string; user: string | null; reply: string | null }
let queue: Promise<unknown> = Promise.resolve();

export async function listNativeSessions(deps: AppDeps): Promise<NativeSession[]> {
  return (await findSessions(deps)).map(({ path: _path, native: _native, project: _project, projectName: _projectName, ...session }) => session);
}

function oneAtATime(task: () => Promise<SessionImportResult>): Promise<SessionImportResult> {
  const result = queue.then(task, task);
  queue = result.catch(() => null);
  return result;
}

export function importNativeSessions(deps: AppDeps, hostId: string, wanted: { harness: SessionHarness; id: string }[]): Promise<SessionImportResult> {
  return oneAtATime(() => run(deps, hostId, wanted, () => findSessions(deps)));
}

export async function listConductorExport(deps: AppDeps, path: string): Promise<NativeSession[]> {
  const { sessions, cleanup } = await conductorExport(deps, path);
  await cleanup();
  return (await unimported(deps, sessions)).map(({ path: _path, native: _native, project: _project, projectName: _projectName, repo: _repo, ...session }) => session);
}

export function importConductorExport(deps: AppDeps, hostId: string, path: string): Promise<SessionImportResult> {
  return oneAtATime(async () => {
    const { sessions, cleanup } = await conductorExport(deps, path);
    try {
      const fresh = await unimported(deps, sessions);
      return await run(deps, hostId, fresh.map(({ harness, id }) => ({ harness, id })), async () => fresh);
    } finally {
      await cleanup();
    }
  });
}

async function run(deps: AppDeps, hostId: string, wanted: { harness: SessionHarness; id: string }[], sessions: () => Promise<Found[]>): Promise<SessionImportResult> {
  requireNonDestroyedHostWithStatus(deps, hostId);
  assertUsableHostId(deps, { hostId });
  requireThisComputer(deps, hostId);
  await deps.providerRegistry.whenRegistrationsSettled();
  const mapPath = join(deps.config.dataDir, "session-imports.json");
  const map: Record<string, string> = existsSync(mapPath) ? JSON.parse(await readFile(mapPath, "utf8")) : {};
  const found = new Map((await sessions()).map((session) => [`${session.harness}:${session.id}`, session]));
  const result: SessionImportResult = { imported: [], skipped: [] };
  const handled = new Set<string>();
  for (const { harness, id } of wanted) {
    const key = `${harness}:${id}`;
    if (handled.has(key)) continue;
    handled.add(key);
    const session = found.get(key);
    const skip = (reason: string) => result.skipped.push({ harness, id, title: session?.title ?? id, reason });
    if (!session) { skip("Not found, or already in Cloudroom."); continue; }
    if (!existsSync(session.cwd)) { skip(`Its folder no longer exists: ${session.cwd}`); continue; }
    try {
      const turns = harness === "claude-code" ? await claudeTurns(session.path) : harness === "codex" ? await codexTurns(session.path) : await moreTurns(session);
      if (!turns.length) { skip(harness === "codex" ? "This Codex chat has no text messages Cloudroom can read, for example only images or shell commands." : "No messages to bring over."); continue; }
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
  const [claude, codex] = await Promise.all([claudeFiles(), codexFiles()]);
  const files = new Map<string, string>([
    ...claude.map((path) => [`claude-code:${basename(path, ".jsonl")}`, path] as const),
    ...codex.map((path) => [`codex:${basename(path.replace(/\.zst$/, ""), ".jsonl").slice(-36)}`, path] as const),
  ]);
  const sessions = [...await claudeSessions(claude), ...await codexSessions(codex), ...await moreSessions(deps)];
  const claimed = new Set([...t3Claims(deps), ...conductorClaims(deps)]);
  for (const { native } of sessions) if (native?.id) native.path = files.get(`${native.harness}:${native.id}`);
  const fresh = (await unimported(deps, sessions.filter((session) => !claimed.has(`${session.harness}:${session.id}`)))).sort((a, b) => b.updatedAt - a.updatedAt);
  // Claude can keep one session under a folder alias and its real path. List it once: the newest copy whose folder still exists.
  const once = new Map<string, Found>();
  for (const session of fresh) {
    const key = `${session.harness}:${session.id}`;
    const kept = once.get(key);
    if (!kept || (!existsSync(kept.cwd) && existsSync(session.cwd))) once.set(key, session);
  }
  return [...once.values()];
}

async function unimported(deps: AppDeps, sessions: Found[]): Promise<Found[]> {
  const mapPath = join(deps.config.dataDir, "session-imports.json");
  const map: Record<string, string> = existsSync(mapPath) ? JSON.parse(await readFile(mapPath, "utf8")) : {};
  const known = new Set(deps.db.selectDistinct({ id: events.providerThreadId }).from(events).where(isNotNull(events.providerThreadId)).all().map((row) => row.id));
  const imported = ({ harness, id }: { harness: string; id?: string }) => {
    const threadId = map[`${harness}:${id}`];
    return threadId !== undefined && getThread(deps.db, threadId)?.deletedAt === null;
  };
  return sessions.filter((session) => !known.has(session.id) && !imported(session) && !(session.native?.id && imported(session.native)));
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
  const files = (await readdir(root, { recursive: true }).catch(() => [] as string[])).filter((file) => /rollout-.*\.jsonl(\.zst)?$/.test(file));
  const plain = new Set(files);
  return files.filter((file) => !file.endsWith(".zst") || !plain.has(file.slice(0, -4))).map((file) => join(root, file));
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
    // Claude rewrites the file with bookkeeping lines on exit and reopen, so its mtime can be days after the chat.
    const updatedAt = await lastMessageAt(path, (line) => line.isSidechain !== true && (line.type === "assistant" || claudeUserText(line) !== null));
    return { harness: "claude-code", id: basename(path, ".jsonl"), title: shorten(title), cwd, updatedAt, path };
  }));
}

async function codexSessions(files: string[]): Promise<Found[]> {
  const names = new Map<string, string>();
  for (const line of (await readFile(join(codexHome(), "session_index.jsonl"), "utf8").catch(() => "")).split("\n")) {
    const entry = parseLine(line);
    if (typeof entry?.id === "string" && typeof entry.thread_name === "string") names.set(entry.id, entry.thread_name);
  }
  return compact(await mapLimit(files, async (path): Promise<Found | null> => {
    let lines = await headLines(path, 512 * 1024);
    const meta = lines[0]?.type === "session_meta" ? lines[0].payload : null;
    if (!meta?.id || !meta.cwd || !["cli", "vscode"].includes(meta.source) || OWN_CODEX_ORIGINATORS.test(meta.originator ?? "")) return null;
    let first = await firstCodexUser(lines);
    // A big pasted image or log can push the first message past the short head, so retry with up to 4 MB.
    if (!first && (path.endsWith(".zst") || (await stat(path)).size > 512 * 1024)) { lines = await headLines(path, 4 * 1024 * 1024); first = await firstCodexUser(lines); }
    // A turn ran but no message is readable: still list it, so the import says why instead of hiding it.
    if (!first && !lines.some((line) => line.type === "turn_context")) return null;
    // On Windows the mtime often stays at the session start while Codex appends. Compressed files fall back to it.
    const updatedAt = await lastMessageAt(path, (line) => (["event", "response"] as const).some((format) => codexMessage(line, "UserMessage", format) || codexMessage(line, "AgentMessage", format)));
    return { harness: "codex", id: meta.id, title: shorten(names.get(meta.id) ?? first ?? "Untitled Codex chat"), cwd: meta.cwd, updatedAt, path };
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
  for await (const { at: time, model: next, user, reply } of codexLines(readLines(path))) {
    model = next ?? model;
    const at = time || Date.now();
    if (user) { turns.push({ at, text: user, model, replies: [] }); continue; }
    if (reply) turns.at(-1)?.replies.push({ at, text: reply });
  }
  return turns;
}

// Each Codex turn starts with task_started, and a resumed chat can start with a new session_meta. A turn with item_completed
// messages repeats them as response items, so read only those; other turns (some Codex versions, plan mode, chats resumed
// across versions) have only response items. A file without either marker is one turn.
async function* codexLines(lines: AsyncIterable<Line> | Iterable<Line>): AsyncGenerator<CodexLine> {
  const message = (line: Line, format: CodexFormat) => ({ user: codexMessage(line, "UserMessage", format), reply: codexMessage(line, "AgentMessage", format) });
  // Keep only what the parser needs, so big tool outputs don't pile up in the turn.
  const slim = (line: Line) => ({
    at: Date.parse(line.timestamp), model: line.type === "turn_context" && typeof line.payload?.model === "string" ? line.payload.model as string : undefined,
    canonical: line.type === "event_msg" && line.payload?.type === "item_completed" && ["UserMessage", "AgentMessage"].includes(line.payload.item?.type),
    event: message(line, "event"), response: message(line, "response"),
  });
  let turn: ReturnType<typeof slim>[] = [];
  let last: ReturnType<typeof slim> | undefined;
  const flush = () => {
    const event = turn.some((line) => line.canonical);
    const out: CodexLine[] = turn.map((line) => ({ at: line.at, model: line.model, ...event ? line.event : line.response }));
    turn = [];
    last = undefined;
    return out;
  };
  for await (const line of lines) {
    if (line.type === "session_meta" || (line.type === "event_msg" && line.payload?.type === "task_started")) yield* flush();
    // Local compaction saves its summary as the last response item before the compacted line and in that line's message.
    if (line.type === "compacted" && last?.response.reply && String(line.payload?.message ?? "").includes(last.response.reply)) last.response.reply = null;
    const entry = slim(line);
    if (line.type === "response_item") last = entry;
    turn.push(entry);
  }
  yield* flush();
}

async function firstCodexUser(lines: Line[]): Promise<string | null> {
  for await (const { user } of codexLines(lines)) if (user) return user;
  return null;
}
// The last message's time; a big /compact summary or tool output can push it out of the short tail, so retry with 4 MB.
async function lastMessageAt(path: string, isMessage: (line: Line) => boolean): Promise<number> {
  for (const bytes of path.endsWith(".zst") ? [] : [64 * 1024, 4 * 1024 * 1024]) {
    const at = (await tailLines(path, bytes)).filter(isMessage).map((line) => Date.parse(line.timestamp)).filter((time) => !Number.isNaN(time)).at(-1);
    if (at !== undefined) return at;
  }
  return (await stat(path)).mtimeMs;
}

function claudeUserText(line: Line): string | null {
  if (line.type !== "user" || line.isMeta || line.isCompactSummary || (line.origin?.kind && line.origin.kind !== "human")) return null;
  const content = line.message?.content;
  const raw = typeof content === "string" ? content : Array.isArray(content) ? content.filter((block: Line) => block.type === "text").map((block: Line) => block.text).join("\n") : "";
  const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  return text && !/^<(command-|local-command)/.test(text) ? text : null;
}

function codexMessage(line: Line, type: "UserMessage" | "AgentMessage", format: CodexFormat): string | null {
  const response = format === "response";
  const item = response
    ? line.type === "response_item" && line.payload?.type === "message" && line.payload.role === (type === "UserMessage" ? "user" : "assistant") ? line.payload : null
    : line.type === "event_msg" && line.payload?.type === "item_completed" && line.payload.item?.type === type ? line.payload.item : null;
  if (!Array.isArray(item?.content)) return null;
  const context = (text: string) => response && type === "UserMessage" && CODEX_CONTEXT.test(text.trim());
  const text = item.content.map((part: Line) => typeof part.text === "string" && !context(part.text) ? part.text : "").join("\n").trim();
  // Plan mode wraps the whole plan reply in one tag pair.
  return (type === "AgentMessage" ? text.replace(/^<proposed_plan>((?:(?!<\/?proposed_plan>)[\s\S])*)<\/proposed_plan>$/, "$1").trim() : text) || null;
}

async function createImportedThread(deps: AppDeps, hostId: string, session: Found, turns: Turn[]) {
  const history = historyRows(session, turns);
  history.forEach(parseStoredEvent);
  linkExportFolder(deps, hostId, session);
  const folder = await projectFolder(deps, hostId, session);
  session.project = folder === session.cwd ? undefined : folder;
  const { project } = findOrCreateProjectByLocalPathSource(deps.db, deps.hub, {
    name: session.projectName ?? (basename(folder) || folder),
    source: { type: "local_path", hostId, path: folder },
  });
  await fillProjectGitRemote(deps, project, { hostId, path: folder });
  if (isMoreHarness(session.harness)) return createMoreThread(deps, { hostId, projectId: project.id, session, turns, history });
  const app = session.harness === "codex" ? "Codex" : "Claude Code";
  return createThreadFromRequest(deps, {
    projectId: project.id,
    providerId: session.harness,
    title: session.title,
    environment: { type: "host", hostId, workspace: { type: "unmanaged", path: session.project ? session.cwd : null } },
    input: [{ type: "text", text: `Imported from ${app} session ${session.id}.`, mentions: [], visibility: "agent-only" }],
    origin: "sdk",
    startedOnBehalfOf: null,
  }, {
    providerInput: [],
    importedFork: { descriptor: { sourceProviderThreadId: session.id }, history: { kind: "rows", rows: history } },
  });
}
// One project per repo: chats from a subfolder or a worktree (Codex app, claude --worktree) join the main checkout's
// project. An existing project for a subfolder of that repo still wins for chats inside it.
async function projectFolder(deps: AppDeps, hostId: string, session: Found): Promise<string> {
  const start = session.project ?? session.cwd;
  const lines = await execFileAsync("git", ["-C", start, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], { timeout: 10_000 })
    .then(({ stdout }) => stdout.trim().split("\n").map((line) => normalize(line.trim())), () => []);
  const [common, top] = lines;
  const repo = lines.length === 2 && isAbsolute(common!) && isAbsolute(top!) ? (basename(common!) === ".git" ? dirname(common!) : top!) : start;
  const real = (path: string) => realpath(path).catch(() => path);
  const [root, cwd] = await Promise.all([real(repo), real(session.cwd)]);
  const within = (path: string, parent: string) => path === parent || path.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  const sources = listProjectSourcesByProjectIds(deps.db, listPublicProjects(deps.db, "all").map((project) => project.id))
    .filter((source) => source.hostId === hostId);
  const matches = await Promise.all(sources.map(async ({ path }) => ({ path, real: await real(path) })));
  const best = matches
    .filter((match) => match.real === root || (within(match.real, root) && within(cwd, match.real)))
    .sort((a, b) => b.real.length - a.real.length)[0];
  return best?.path ?? (existsSync(repo) ? repo : start);
}

export function historyRows(session: Found, turns: Turn[]): StoredEventRow[] {
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
  const file = createReadStream(path, { end: bytes === undefined ? undefined : bytes - 1 });
  const input = path.endsWith(".zst") ? pipeline(file, createZstdDecompress(), () => {}) : file;
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
  const text = path.endsWith(".zst") ? await zstdHead(path, bytes).catch(() => "") : await readSlice(path, 0, bytes);
  return compact(text.split("\n").slice(0, text.length < bytes ? undefined : -1).map(parseLine));
}

export async function tailLines(path: string, bytes: number): Promise<Line[]> {
  const size = (await stat(path)).size;
  const text = await readSlice(path, Math.max(0, size - bytes), Math.min(size, bytes));
  return compact(text.split("\n").slice(size > bytes ? 1 : 0).map(parseLine));
}

async function readSlice(path: string, start: number, bytes: number): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, Math.min(bytes, (await file.stat()).size - start)));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

async function zstdHead(path: string, bytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of pipeline(createReadStream(path), createZstdDecompress(), () => {})) {
    chunks.push(chunk);
    if ((size += chunk.length) >= bytes) break;
  }
  return Buffer.concat(chunks).subarray(0, bytes).toString("utf8");
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
