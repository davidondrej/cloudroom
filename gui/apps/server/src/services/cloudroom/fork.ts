import { COMPUTER } from "@cloudroom/domain";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import { and, asc, eq } from "drizzle-orm";
import { events, findLastCompletedRootStoredTurn, findLastRootStoredTurnStarted, getEnvironment, getThread, listStoredTurnCompletedRowsByTurnIds, type DbConnection } from "@cloudroom/db";
import type { Thread } from "@cloudroom/domain";
import { gitShell, msysPathToWindows } from "@cloudroom/process-utils";
import { z } from "zod";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { resolveThreadForkPoint } from "../threads/thread-fork-history.js";
import { getLastExecutionOptions } from "../threads/thread-events.js";
import { runLiveHostCommand } from "../hosts/live-command.js";
import { resolvePrimaryHostId } from "../hosts/primary-host.js";
import { workspaceContextFromPath } from "../environments/workspace-command-target.js";
import { CloudroomError, UPLOAD_PART, type CloudroomClient, type Harness, type TeleportManifest } from "./client.js";
import { cloudroom } from "./commands.js";
import { SKIPPED } from "./project-copy.js";
import { binding } from "./store.js";
import { codexLineage, download, findNative, vm } from "./teleport-local.js";

/** A Cloud fork: a new Cloud thread, in its own sandbox, that continues another Cloud thread's conversation
 *  from a chosen turn, with that thread's code (docs/scopes/sandboxes.md). Saved in the fork's first message. */
export const cloudForkSchema = z.object({
  source_thread_id: z.string(),
  end_sequence: z.number(),
  before: z.string().optional(),
  last_turn_id: z.string().optional(),
  transfer: z.string().optional(),
  local: z.object({ native_id: z.string(), checkpoint: z.string().optional() }).optional(),
});
export type CloudFork = z.infer<typeof cloudForkSchema>;
/** A thread's code: a Git bundle, or a .tgz of its files when its folder has no Git history, plus its `origin` URL.
 *  `full` packs a complete bundle, for a folder without the commits a thin bundle leaves out. */
type Code = { data: Buffer; origin: string; full?: () => Promise<Buffer> };
export const isFiles = (data: Buffer) => data[0] === 0x1f && data[1] === 0x8b;
const skippedNames = () => [...SKIPPED, ".cloudroom"].map((name) => `-name ${quote(name)}`).join(" -o ");
/** `applyForkCode`'s exit code when the folder lacks history the bundle needs. */
const MISSING_HISTORY = 3;
/** Before unpacking a source's files: removes symlinks on the way to an archive file, so tar never writes through them.
 *  A folder with no Git repository also loses the files the archive lacks, and folders it holds as files. Exact names,
 *  so any file name works. Skipped names (dependencies, build output, `.cloudroom`) stay. An empty archive removes nothing. */
const PRUNE = `import os,shutil,sys,tarfile
root,skip=sys.argv[1],set(sys.argv[3:])
with tarfile.open(sys.argv[2]) as t: names={os.path.normpath(m.name) for m in t if not m.isdir()}
if not names: sys.exit()
for n in names:
    parts=n.split(os.sep)
    for i in range(1,len(parts)):
        p=os.path.join(root,*parts[:i])
        if os.path.islink(p): os.remove(p)
if os.path.lexists(os.path.join(root,".git")): sys.exit()
for d,dirs,files in os.walk(root):
    links=[x for x in dirs if os.path.islink(os.path.join(d,x))]
    dirs[:]=[x for x in dirs if x not in skip and x not in links]
    for f in files+links:
        p=os.path.join(d,f)
        if f not in skip and os.path.relpath(p,root) not in names: os.remove(p)
for n in names:
    p=os.path.join(root,n)
    if os.path.isdir(p) and not os.path.islink(p): shutil.rmtree(p)
`;

export const FORK_HARNESSES: readonly string[] = ["claude-code", "codex"];
export const FORK_HINT = "[Cloud fork]\nThis conversation was forked from another thread and now runs in its own new sandbox. Cloudroom is copying that thread's code (its commits and uncommitted changes) into this folder. Run `room-cli files wait` before you read or change files; it returns once the code lands. Never recreate missing files.";
// Core takes teleport uploads in 1 MB parts.
const PART = 1024 * 1024;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const exec = promisify(execFile);

export function cloudForkOf(input: string | undefined): CloudFork | null {
  const fork = input ? (JSON.parse(input) as { fork?: unknown }).fork : undefined;
  return fork ? cloudForkSchema.parse(fork) : null;
}

/** A child's parent (`code_from`), whose code it starts with (ADR 0229). */
export function codeFromOf(input: string | undefined): string | undefined {
  return input ? z.object({ code_from: z.string().optional() }).parse(JSON.parse(input)).code_from : undefined;
}

export function forkTurn(db: DbConnection, threadId: string, sourceSeqEnd: number | undefined): { turnId: string; endSequence: number } {
  const started = sourceSeqEnd === undefined ? findLastCompletedRootStoredTurn(db, { threadId }) : findLastRootStoredTurnStarted(db, { threadId, atOrBeforeSequence: sourceSeqEnd });
  const completed = started && listStoredTurnCompletedRowsByTurnIds(db, { threadId, turnIds: [started.turnId] }).at(-1);
  if (!started || !completed) throw new ApiError(400, "fork_source_session_unavailable", "Fork from a message whose turn has finished.");
  return { turnId: started.turnId, endSequence: completed.sequence };
}

/** Keeps the turn holding `sourceSeqEnd` (or the last finished turn) and everything before it, like a Local fork. */
export function cloudForkPoint(db: DbConnection, source: Thread, sourceSeqEnd: number | undefined): CloudFork {
  const turn = forkTurn(db, source.id, sourceSeqEnd);
  const completed = { sequence: turn.endSequence };
  const started = { turnId: turn.turnId };
  const checkpoints = db.select({ sequence: events.sequence, data: events.data }).from(events)
    .where(and(eq(events.threadId, source.id), eq(events.type, "system/operation"))).orderBy(asc(events.sequence)).all()
    .map((row) => ({ sequence: row.sequence, ...(JSON.parse(row.data) as { operation?: string; metadata?: { id?: unknown; request_id?: unknown } }) }))
    .filter((event) => event.operation === "checkpoint" && typeof event.metadata?.id === "string");
  const fork = { source_thread_id: source.id, end_sequence: completed.sequence };
  // Codex checkpoints a turn when it ends. Claude checkpoints the user message that starts the next turn;
  // with no next turn yet, the fork copies the whole conversation.
  if (source.providerId === "codex") {
    const own = checkpoints.find((event) => event.metadata?.request_id === started.turnId);
    if (!own) throw new ApiError(400, "fork_source_session_unavailable", "That turn has no saved checkpoint to fork from.");
    return { ...fork, last_turn_id: own.metadata!.id as string };
  }
  const next = checkpoints.find((event) => event.sequence > completed.sequence);
  return next ? { ...fork, before: next.metadata!.id as string } : fork;
}

type ForkFile = { path: string; kind: "native" | "lineage"; data: Buffer };
type ForkSource = { nativeId: string; files: (transfer: string) => Promise<ForkFile[]>; code: (id: string) => Promise<Code | null> };
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));

export function localForkPoint(deps: Pick<AppDeps, "db" | "providerRegistry">, source: Thread, sourceSeqEnd: number | undefined): CloudFork {
  const point = resolveThreadForkPoint(deps, { sourceSeqEnd: sourceSeqEnd ?? forkTurn(deps.db, source.id, undefined).endSequence, sourceThread: source });
  const nativeId = point?.descriptor.sourceProviderThreadId;
  if (point?.history?.kind !== "thread" || !nativeId || !/^[A-Za-z0-9_-]+$/.test(nativeId))
    throw new ApiError(400, "fork_source_session_unavailable", "Fork from a message whose turn has finished.");
  const checkpoint = point.descriptor.sourceProviderCheckpointId;
  return { source_thread_id: source.id, end_sequence: point.history.endSequence, local: { native_id: nativeId, ...(checkpoint ? { checkpoint } : {}) } };
}

/** Copies the source conversation into this thread's new sandbox and waits until its agent is ready. The code
 *  snapshot starts at the same time and is applied once the project copy lands (`landForkCode`). */
export async function startCloudFork(
  deps: Parameters<typeof cloudroom>[0], client: CloudroomClient, threadId: string, fork: CloudFork,
  start: Omit<TeleportManifest, "request_id" | "harness" | "native_id" | "files" | "handoff" | "queued" | "fork">,
  save: (patch: Partial<CloudFork>) => void,
): Promise<{ sessionId: string; transfer: string; code: Promise<Code | Error | null> }> {
  const harness = getThread(deps.db, fork.source_thread_id)?.providerId;
  if (!harness || !FORK_HARNESSES.includes(harness))
    throw new ApiError(409, "fork_source_unavailable", "The source thread has no saved conversation to fork.");
  const source = fork.local ? localForkSource(deps, fork.source_thread_id, fork.local.native_id, harness) : await cloudForkSource(deps, fork.source_thread_id, harness);
  const snapshot = (id: string) => source.code(id).catch(asError);
  // A retry after activation keeps the started fork instead of starting a second one. Only Core's own "not found"
  // proves the saved transfer never started: a timeout (Core busy loading a big conversation) retries later, since a
  // second copy of the same conversation is always rejected.
  const done = fork.transfer ? await client.teleportStatus(fork.transfer).catch((error: unknown) => {
    if (error instanceof CloudroomError && error.status === 404 && error.message.endsWith("session not found")) return null;
    throw error;
  }) : null;
  if (fork.transfer && done?.session_id) {
    await idle(client, done.session_id);
    return { sessionId: done.session_id, transfer: fork.transfer, code: snapshot(fork.transfer) };
  }
  const transfer = `fork_${randomUUID().replaceAll("-", "")}`;
  const code = snapshot(transfer);
  const files = await source.files(transfer);
  if (files.some((entry) => entry.kind === "lineage") && (await client.capabilities()).teleport_lineage !== true)
    throw new ApiError(409, "fork_update", "Forking this Codex chat needs a newer cloud core. Try again after the next Cloudroom update.");
  const native = files.find((entry) => entry.kind === "native")!.data;
  save({ transfer, ...(fork.local ? corePoint(harness, native, fork.local.checkpoint) : {}) });
  const entries = files.map((entry) => ({ ...entry, sha256: createHash("sha256").update(entry.data).digest("hex") }));
  await client.prepareTeleport({
    ...start, request_id: transfer, harness: harness as Harness, native_id: source.nativeId, handoff: "", queued: [], fork: true,
    files: entries.map((entry) => ({ path: entry.path, size: entry.data.length, sha256: entry.sha256, kind: entry.kind, executable: false })),
  });
  for (const [index, entry] of entries.entries())
    for (let offset = 0; offset < entry.data.length; offset += PART)
      await client.uploadTeleport(transfer, index, offset, entry.sha256, entry.data.subarray(offset, offset + PART), entry.data.length);
  const sessionId = (await client.activateTeleport(transfer)).session_id;
  if (!sessionId) throw new ApiError(503, "fork_start_failed", "The fork's sandbox did not start its agent.");
  await idle(client, sessionId);
  return { sessionId, transfer, code };
}

async function cloudForkSource(deps: Parameters<typeof cloudroom>[0], sourceId: string, harness: string): Promise<ForkSource> {
  const source = binding(deps.db, sourceId);
  if (!source?.sessionId || !source.nativeId || !/^[A-Za-z0-9_-]+$/.test(source.nativeId))
    throw new ApiError(409, "fork_source_unavailable", "The source Cloud thread has no saved conversation to fork.");
  const { sessionId, nativeId } = source;
  const from = await cloudroom(deps).threadClient(sourceId);
  const workspace = (await from.sessionWorkspace(sessionId)).path;
  return {
    nativeId,
    code: (id) => sourceCode(from, workspace, id),
    files: async () => {
      const path = (await vm(from, findNative(harness as "codex" | "claude-code", nativeId))).toString().trim();
      if (!path) throw new ApiError(409, "fork_source_unavailable", "The source conversation file was not found in its sandbox.");
      const file = await download(from, path);
      // The source may be writing its next turn; a partial last line is not part of the fork.
      const files: ForkFile[] = [{ path: basename(path), kind: "native", data: file.subarray(0, file.lastIndexOf(10) + 1) }];
      // A source that is itself a Codex fork (a rewind) needs its parent files too.
      for (const parent of harness === "codex" ? await codexLineage(from, path) : [])
        files.push({ path: basename(parent), kind: "lineage", data: await download(from, parent) });
      return files;
    },
  };
}

function localForkSource(deps: Parameters<typeof cloudroom>[0], sourceId: string, nativeId: string, harness: string): ForkSource {
  const environmentId = getThread(deps.db, sourceId)?.environmentId;
  const environment = environmentId ? getEnvironment(deps.db, environmentId) : null;
  if (!environment?.path) throw new ApiError(409, "fork_source_unavailable", `The source thread's folder is not on this ${COMPUTER}.`);
  const { hostId, path } = environment;
  const target = { threadId: sourceId, environmentId: environment.id, workspaceContext: workspaceContextFromPath({ path }) };
  return {
    nativeId,
    code: async (id) => hostId === resolvePrimaryHostId(deps as AppDeps) ? localCode(path, id) : null,
    files: async (transferId) => {
      const run = (command: { action: "capture" | "read"; sessions?: { threadId: string; nativeId: string; harness: "codex" | "claude-code" }[]; keepImages?: boolean; index?: number; offset?: number }) => runLiveHostCommand(deps as AppDeps, { hostId, timeoutMs: 120_000, command: { type: "thread.teleport", transferId, ...target, ...command } });
      const capture = await run({ action: "capture", keepImages: true, sessions: [{ threadId: sourceId, nativeId, harness: harness === "codex" ? "codex" : "claude-code" }] });
      const files: ForkFile[] = [];
      for (const [index, file] of (capture.files ?? []).entries()) {
        if (file.kind !== "native" && file.kind !== "lineage") continue;
        const parts: Buffer[] = [];
        for (let offset = 0, waits = 0; ;) {
          const chunk = await run({ action: "read", index, offset });
          if (chunk.pending) {
            if (++waits > 20) throw new ApiError(503, "fork_source_busy", `${file.path} kept changing. Try the fork again.`);
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
          if (chunk.data === undefined || chunk.size === undefined) throw new Error("A local transfer chunk is missing.");
          const data = Buffer.from(chunk.data, "base64");
          parts.push(data);
          offset += data.length;
          if (offset >= chunk.size || data.length === 0) break;
        }
        files.push({ path: file.path, kind: file.kind, data: Buffer.concat(parts) });
      }
      if (!files.some((file) => file.kind === "native")) throw new ApiError(409, "fork_source_unavailable", "The source conversation was not captured.");
      return files;
    },
  };
}

const lines = (native: Buffer) => native.toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type?: string; uuid?: string; parentUuid?: string | null; isMeta?: boolean });
const prompt = (entry: ReturnType<typeof lines>[number]) => entry.type === "user" && entry.isMeta !== true;

export function corePoint(harness: string, native: Buffer, checkpoint: string | undefined): Pick<CloudFork, "before" | "last_turn_id"> {
  if (!checkpoint) return {};
  if (harness === "codex") return { last_turn_id: checkpoint.replace(/^bt[0-9a-f]{8}-\d+-/, "") };
  const entries = lines(native);
  const byId = new Map(entries.map((entry) => [entry.uuid, entry]));
  if (!byId.has(checkpoint)) throw new ApiError(409, "fork_source_session_unavailable", "That message is not in the saved conversation.");
  const after = entries.find((entry) => {
    if (!prompt(entry)) return false;
    for (let id = entry.parentUuid; id; id = byId.get(id)?.parentUuid) {
      if (id === checkpoint) return true;
      const parent = byId.get(id);
      if (!parent || prompt(parent)) return false;
    }
    return false;
  });
  return after?.uuid ? { before: after.uuid } : {};
}

export function localCheckpoint(harness: string, native: Buffer, fork: Pick<CloudFork, "before" | "last_turn_id">): string | undefined {
  if (harness === "codex") return fork.last_turn_id;
  if (!fork.before) return undefined;
  const parent = lines(native).find((entry) => entry.uuid === fork.before && prompt(entry))?.parentUuid;
  if (!parent) throw new ApiError(409, "fork_source_session_unavailable", "That message is not in the saved conversation.");
  return parent;
}

export function forkModel(deps: Pick<AppDeps, "db">, threadId: string): string | undefined {
  return binding(deps.db, threadId)?.model ?? getLastExecutionOptions(deps, threadId)?.model;
}

export const CHILD_HINT = "[Cloud child]\nYou run in your own sandbox. Cloudroom is copying your parent thread's code (its commits and uncommitted changes) into this folder. Run `room-cli files wait` before you read or change files; it returns once the code lands. Never recreate missing files.";

/** A Cloud parent's code (its branch plus uncommitted changes) for a child in a sandbox of its own (ADR 0229),
 *  applied with `landForkCode` like a fork's. Null when the parent has no folder. */
export async function threadCode(deps: Parameters<typeof cloudroom>[0], threadId: string, id: string): Promise<Code | Error | null> {
  try {
    const source = binding(deps.db, threadId);
    if (!source?.sessionId) {
      const environmentId = getThread(deps.db, threadId)?.environmentId;
      const environment = environmentId ? getEnvironment(deps.db, environmentId) : null;
      return environment?.path && environment.hostId === resolvePrimaryHostId(deps as AppDeps) ? await localCode(environment.path, id) : null;
    }
    const from = await cloudroom(deps).threadClient(threadId);
    return await sourceCode(from, (await from.sessionWorkspace(source.sessionId)).path, id);
  } catch (error) { return error instanceof Error ? error : new Error(String(error)); }
}

/** A fork's first message is a native fork (a rewind), which needs the resumed agent to be idle. */
async function idle(client: CloudroomClient, sessionId: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    const session = await client.session(sessionId);
    if (session.state === "idle" || session.current_request !== null) return;
    if (["failed", "process_lost", "closed"].includes(session.state) || tries === 240)
      throw new ApiError(503, "fork_start_failed", `The fork's agent did not start (${session.state}).`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** The source's branch plus its uncommitted changes as one extra commit, packed as a Git bundle. A folder with no Git
 *  history (a project not on GitHub) goes as its files instead, without dependencies or build output. The source is untouched. */
export async function sourceCode(from: CloudroomClient, workspace: string, id: string): Promise<Code | null> {
  return packCode({
    run: async (script) => (await vm(from, script)).toString(),
    read: (path) => download(from, path, 500),
    remove: (path) => vm(from, `rm -f ${quote(path)}`),
  }, workspace, id);
}

async function localCode(workspace: string, id: string): Promise<Code | null> {
  if (await exec("git", ["-C", workspace, "rev-parse", "-q", "--verify", "HEAD"]).then(() => false, () => true)) return null;
  if (process.platform === "win32") return windowsLocalCode(workspace, id);
  return packCode({
    run: async (script) => (await exec("sh", ["-c", script], { maxBuffer: 1024 * 1024 })).stdout,
    read: async (path) => (await exec("cat", [path], { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 })).stdout,
    remove: (path) => exec("rm", ["-f", path]),
  }, workspace, id);
}

/** Windows runs the same script with Git for Windows' shell, which prints MSYS paths such as `/c/Users/…`. */
async function windowsLocalCode(workspace: string, id: string): Promise<Code | null> {
  const shell = await gitShell();
  return packCode({
    run: async (script) => (await exec(shell.command, ["-c", script], { env: shell.env, maxBuffer: 1024 * 1024 })).stdout,
    read: (path) => readFile(msysPathToWindows(path)),
    remove: (path) => rm(msysPathToWindows(path), { force: true }),
  }, workspace, id);
}

async function packCode(at: { run: (script: string) => Promise<string>; read: (path: string) => Promise<Buffer>; remove: (path: string) => Promise<unknown> }, workspace: string, id: string): Promise<Code | null> {
  const pack = async (thin: boolean): Promise<Code | null> => {
    const [path, origin = ""] = (await at.run(codeScript(workspace, id, thin))).trim().split("\n");
    if (!path) return null;
    try { return { data: await at.read(path), origin: origin.trim() }; }
    finally { await at.remove(path).catch(() => {}); }
  };
  const code = await pack(true);
  if (!code || isFiles(code.data)) return code;
  return {
    ...code,
    full: async () => {
      const complete = await pack(false);
      if (!complete) throw new Error("The source thread's folder is gone.");
      return complete.data;
    },
  };
}

function codeScript(workspace: string, id: string, thin: boolean): string {
  const ref = `refs/cloudroom/${id}`;
  return [
    `cd ${quote(workspace)} 2>/dev/null || exit 0`,
    `if ! git rev-parse -q --verify HEAD >/dev/null 2>&1; then f=~/.cache/cloudroom/${id}.tgz && mkdir -p ~/.cache/cloudroom || exit 1`,
    // Listed first, so a folder find can't read fails the copy instead of leaving files out. A file that changes or
    // vanishes while packing (a log) is only a warning: tar exits 1 for it.
    `  l="$f.list" && find . -mindepth 1 \\( ${skippedNames()} \\) -prune -o \\( -type f -o -type l \\) -print0 > "$l" && { tar -czf "$f" --ignore-failed-read --warning=no-file-changed --null -T "$l"; [ $? -le 1 ] && [ -s "$f" ]; } && echo "$f"; code=$?; rm -f "$l"; exit $code`,
    "fi",
    // A temporary index, so the source's own staging area stays as it was. An empty file is not a valid index.
    `index=$(mktemp) && rm -f "$index" && trap 'rm -f "$index"; git update-ref -d ${ref} 2>/dev/null' EXIT`,
    `cp "$(git rev-parse --git-path index)" "$index" 2>/dev/null`,
    `GIT_INDEX_FILE="$index" git add -A >/dev/null 2>&1 && tree=$(GIT_INDEX_FILE="$index" git write-tree) || exit 1`,
    `commit=$(git -c user.name=Cloudroom -c user.email=cloudroom@localhost commit-tree "$tree" -p HEAD -m 'Cloudroom fork: uncommitted changes') || exit 1`,
    `git update-ref ${ref} "$commit" && mkdir -p ~/.cache/cloudroom || exit 1`,
    `f=~/.cache/cloudroom/${id}.bundle`,
    thin
      ? `{ git bundle create -q "$f" ${ref} --not --remotes 2>/dev/null || git bundle create -q "$f" ${ref}; } && echo "$f" || exit 1`
      : `git bundle create -q "$f" ${ref} && echo "$f" || exit 1`,
    // A thin bundle needs the commits it leaves out, so a target folder with no Git fetches them from here.
    "git remote get-url origin 2>/dev/null; true",
  ].join("\n");
}

/** Writes `data` to `~/file` in `UPLOAD_PART` pieces, since sandbox proxies drop requests over about 8 MB. */
export async function uploadInParts(client: CloudroomClient, file: string, data: Buffer, signal?: AbortSignal): Promise<void> {
  for (let offset = 0; offset < data.length; offset += UPLOAD_PART) {
    const part = new Uint8Array(data.subarray(offset, offset + UPLOAD_PART));
    const result = await client.runOnVm({ command: `mkdir -p ~/.cache/cloudroom && truncate -s ${offset} ~/${file} && cat >> ~/${file}` }, signal, part);
    if (result.code !== 0) throw new Error(Buffer.from(result.stderr, "hex").toString().trim() || "The upload failed.");
  }
}

/** Puts the source's code in the fork's folder once its project copy landed. Returns why it could not, or null. */
export async function landForkCode(client: CloudroomClient, started: { sessionId: string; transfer: string; code: Promise<Code | Error | null> | null }): Promise<string | null> {
  const code = await started.code;
  if (!code) return "The source thread's code was not copied, since it has no project folder.";
  try {
    if (code instanceof Error) throw code;
    await applyForkCode(client, (await client.sessionWorkspace(started.sessionId)).path, started.transfer, code);
    return null;
  } catch (error) {
    return `The source thread's code could not be copied: ${error instanceof Error ? error.message : String(error)}.`;
  }
}

/** Moves the fork's branch to the source's commit and leaves the source's uncommitted changes uncommitted, unless
 *  the folder already has changes. A folder with no Git repository gets one. Plain files go on top of a GitHub clone
 *  and delete only symlinks in their way; with no clone they replace the folder's files, so files the source deleted are gone here too;
 *  dependencies, build output and `.cloudroom` stay. */
async function applyForkCode(client: CloudroomClient, workspace: string, id: string, code: Code): Promise<void> {
  const files = isFiles(code.data);
  const file = `.cache/cloudroom/${id}.${files ? "tgz" : "bundle"}`;
  await uploadInParts(client, file, code.data);
  if (files) {
    const skipped = [...SKIPPED, ".cloudroom"].map(quote).join(" ");
    await vm(client, `mkdir -p ${quote(workspace)} && cd ${quote(workspace)} && python3 -I -c ${quote(PRUNE)} . ~/${file} ${skipped} && tar -xzf ~/${file}; code=$?; rm -f ~/${file}; exit $code`);
    return;
  }
  const land = () => client.runOnVm({
    command: [
      // The child of a project not on GitHub, or whose clone failed, has no repository yet.
      // Never on the default branch, so a push can't reach the user's main; the app renames it to the thread's room/ branch.
      `cd ${quote(workspace)} && { git rev-parse --git-dir >/dev/null 2>&1 || { git init -q && git symbolic-ref HEAD refs/heads/cloudroom/${id}; }; } || { rm -f ~/${file}; exit 1; }`,
      code.origin ? `git remote get-url origin >/dev/null 2>&1 || git remote add origin ${quote(code.origin)}` : "",
      // Never reset over work the agent already did here: keep it and say why the code was not copied.
      `if git rev-parse -q --verify HEAD >/dev/null && ! git diff --quiet HEAD; then echo 'The folder already had changes, so they were kept and the code was not copied in' >&2; rm -f ~/${file}; exit 1; fi`,
      // A thin bundle leaves out commits the source's remote has: fetch them, or ask for a complete bundle.
      `git bundle verify -q ~/${file} >/dev/null 2>&1 || GIT_TERMINAL_PROMPT=0 git fetch -q origin >/dev/null 2>&1; git bundle verify -q ~/${file} >/dev/null 2>&1 || { rm -f ~/${file}; exit ${MISSING_HISTORY}; }`,
      `git fetch -q ~/${file} refs/cloudroom/${id} && git reset -q --hard FETCH_HEAD && git reset -q --soft HEAD~1 && git read-tree -m HEAD`,
      `code=$?; rm -f ~/${file}; exit $code`,
    ].join("\n"),
    stdin: "",
  });
  let result = await land();
  if (result.code === MISSING_HISTORY && code.full) {
    await uploadInParts(client, file, await code.full());
    result = await land();
  }
  if (result.code !== 0 || result.truncated)
    throw new Error(Buffer.from(result.stderr, "hex").toString().trim() || (result.code === MISSING_HISTORY ? "It needs Git history this sandbox could not fetch" : `Cloud command failed (${result.code})`));
}
