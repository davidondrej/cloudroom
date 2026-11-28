import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { chmod, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  cloudroomCommands,
  cloudroomThreads,
  createEventId,
  createQueuedThreadMessageInTransaction,
  findProjectEnvironmentByHostPath,
  getEnvironment,
  getProject,
  getThread,
  listProjectSourcesByHost,
  listProjectSourcesByProjectIds,
  threadPluginMetadata,
  threads,
} from "@cloudroom/db";
import { chatImagePaths, getHostPathComparisonKey, legacyChatFileCopySegments, PERSONAL_PROJECT_ID, THREAD_TELEPORT_LOCAL_OPERATION, threadScope, type PromptInput, type TeleportLocalStep, type Thread, COMPUTER } from "@cloudroom/domain";
import { chatFileCopyPath, readRegularFile } from "@cloudroom/config/chat-file-copies";
import { gitSafetyArgs } from "@cloudroom/host-workspace";
import { folderOpenerCommand, tarCommand } from "@cloudroom/process-utils";
import type { CreateThreadEnvironmentArgs } from "@cloudroom/server-contract";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { readPrimaryHostIdFromDataDir, resolvePrimaryHostId } from "../hosts/primary-host.js";
import { runLiveHostCommand } from "../hosts/live-command.js";
import { workspaceContextFromPath } from "../environments/workspace-command-target.js";
import { provisionUnmanagedEnvironmentForPath } from "../threads/thread-environment-directory.js";
import { appendThreadEventInTransaction, getLastProviderThreadId } from "../threads/thread-events.js";
import type { ThreadForkPoint } from "../threads/thread-fork-history.js";
import { worktreeProviderInputs } from "../threads/thread-environment-placement.js";
import { ensureProjectCheckoutForThread } from "../projects/project-source-setup.js";
import { resolveStableThreadRequestEnvironment } from "../threads/thread-request-eligibility.js";
import { DEFAULT_ENVIRONMENT_PROVIDER_ID } from "../environments/environment-provider-ids.js";
import { requestQueuedMessageDispatch } from "../threads/queued-message-dispatch.js";
import { settleDanglingBackgroundTasksForStoppedThreadInTransaction } from "../threads/background-task-reconciliation.js";
import { NotificationBuffer } from "../lib/notification-buffer.js";
import { requireHostDataDir, saveChatFileCopyForThread } from "../threads/thread-storage.js";
import { cloudroom } from "./commands.js";
import { RECORD_VALUES, values, type CloudroomClient } from "./client.js";
import { SKIPPED } from "./project-copy.js";
import { claudeTranscriptThrough, cloudForkPoint, FORK_HARNESSES, isFiles, localCheckpoint, sourceCode } from "./fork.js";
import { binding, localTeleports, teleportProgress } from "./store.js";

type Harness = "codex" | "pi" | "claude-code" | "acp-cursor" | "acp-opencode" | "acp-antigravity";
const VM_SESSIONS: Record<Harness, string> = {
  codex: "$HOME/.codex/sessions",
  pi: "$HOME/.pi/agent/sessions",
  "claude-code": "$HOME/.claude/projects",
  "acp-cursor": "$HOME/.cursor/chats",
  "acp-opencode": "$HOME/.local/share/opencode",
  "acp-antigravity": "$HOME/.gemini/antigravity-cli/conversations",
};
const CHUNK = 3 * 1024 * 1024;
const PREVIEW_MB = 20;
const DOWNLOAD_MB = 200;
/** What one Teleport, Fork, or copy downloads in all: the Mac holds it at once, and the sandbox reports every size. */
const MAX_DOWNLOAD_MB = 1024;
/** Parsing tiny JSON values (`[{},{},...]`) takes about 30 times their bytes in memory, so a byte limit alone doesn't bound
 *  it: one conversation file holds at most this many values, over all its lines, which caps its parse at about 512 MB of
 *  heap. Tool-heavy Claude chats hold one value per about 30 bytes, so this is about 500 MB of them, where V8 can no longer
 *  hold the file as one string anyway. */
const CONVERSATION_VALUES = 64 * RECORD_VALUES;
/** The bytes left for one operation's downloads, which they share. */
export type Allowance = { mb: number; bytes: number };
export const allowance = (mb = MAX_DOWNLOAD_MB): Allowance => ({ mb, bytes: mb * 1024 * 1024 });
const exec = promisify(execFile);
// User-facing wording: Windows says "PC", as in claude-token.ts.
const computer = process.platform === "win32" ? "PC" : COMPUTER;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
// Cloud files must never land in a .git folder, where Git runs hooks and config commands on the Mac.
// Lowercase and NFC, because macOS treats ".GIT" as ".git".
const inGit = (path: string) => path.normalize("NFC").toLowerCase().split(/[\\/]/).includes(".git");
/** Packs the NUL-separated paths on stdin in the cloud. Windows can't make symlinks without Developer Mode, so a Windows
 *  host gets copies of what changed links point to, and only dangling links are left out. A folder link would arrive
 *  empty, and a link out of the project would copy cloud files (say, credentials) into it, so either fails the pack with
 *  its path, like any other unreadable file: Teleport stops and the thread stays in Cloud. */
export function packChangesCommand(archive: string, windows = process.platform === "win32"): string {
  if (!windows) return `tar -czf ${archive} --null -T -`;
  const refuse = (why: string) => `printf '%s ${why}. Remove it in the cloud, then try again. The thread stays in Cloud.\\n' "$f" >&2; exit 3`;
  const add = `add() { [ -L "$f" ] && [ ! -e "$f" ] && return; if [ -L "$f" ] && [ -d "$f" ]; then ${refuse("is a folder link, which this Windows PC cannot create")}; fi; case "$(realpath -- "$f")" in "$root"/*) ;; *) ${refuse("points outside the project, so Teleport will not copy it to this Windows PC")};; esac; printf '%s\\0' "$f"; }`;
  return `( set -o pipefail; root=$(pwd -P); ${add}; { while IFS= read -r -d '' f; do if [ -d "$f" ] && [ ! -L "$f" ]; then find "$f" -name .git -prune -o \\( -type f -o -type l \\) -print0 | { while IFS= read -r -d '' f; do add; done; } || exit; else add; fi; done; } | tar -czhf ${archive} --no-recursion --hard-dereference --null -T - )`;
}

export const teleportingToLocal = (threadId: string) => localTeleports.has(threadId);

export async function teleportToLocal(deps: AppDeps, threadId: string): Promise<{ conflicts: number }> {
  if (localTeleports.has(threadId)) throw new ApiError(409, "teleport_in_progress", "Teleport to Local is already running.");
  const step = (value?: TeleportLocalStep) => {
    if (value) localTeleports.set(threadId, value);
    else localTeleports.delete(threadId);
    deps.hub.notifyThread(threadId, ["status-changed"]);
  };
  step("stopping");
  try {
    return await run(deps, threadId, step);
  } finally {
    // A Teleport that didn't land lets go of Core's freeze at once, instead of after its 5 minutes (#237).
    const frozen = freezes.get(threadId);
    freezes.delete(threadId);
    frozen?.end(getThread(deps.db, threadId)?.executionTarget === "cloud");
    step();
  }
}

const freezes = new Map<string, NonNullable<Awaited<ReturnType<ReturnType<typeof cloudroom>["freezeForTeleport"]>>>>();

async function run(deps: AppDeps, threadId: string, step: (value: TeleportLocalStep) => void): Promise<{ conflicts: number }> {
  const thread = getThread(deps.db, threadId);
  const saved = binding(deps.db, threadId);
  const harness = thread?.providerId as Harness | undefined;
  const phase = teleportProgress(deps.db, threadId)?.phase;
  // Name the real blocker instead of the generic refusal (#1974). An unfinished move comes first: the thread may be about
  // to change place, so say nothing about where it is. "This computer" is only its own saved host id, never a fallback guess.
  if (phase && !["complete", "cancelled", "error"].includes(phase))
    throw new ApiError(409, "teleport_unavailable", `A Teleport for this thread is still in progress (${phase}). Try again once it finishes.`);
  if (thread && thread.executionTarget !== "cloud") {
    const hostId = thread.environmentId ? getEnvironment(deps.db, thread.environmentId)?.hostId : undefined;
    throw new ApiError(409, "teleport_unavailable", hostId && hostId === readPrimaryHostIdFromDataDir({ dataDir: deps.config.dataDir }) ? `This thread is already on this ${computer}.` : "This thread is not in Cloud.");
  }
  if (!thread || thread.parentThreadId || thread.archivedAt || thread.deletedAt || !harness || !(harness in VM_SESSIONS))
    throw new ApiError(409, "teleport_unavailable", "Teleport to Local needs a Codex, Pi, Claude Code, opencode, Antigravity, or Cursor cloud parent thread.");
  const nativeId = getLastProviderThreadId(deps, threadId);
  if (!saved?.sessionId || !nativeId || !/^[A-Za-z0-9_-]+$/.test(nativeId))
    throw new ApiError(409, "teleport_unavailable", "This cloud thread has no saved conversation yet.");
  const environment = await localEnvironment(deps, thread);
  const client = await cloudroom(deps).teleportClient(threadId, "teleport_local");
  // Other computers' sends wait until this lands (Core's freeze, #237); every message Core queued must be here first.
  const frozen = await cloudroom(deps).freezeForTeleport(threadId, client, saved.sessionId);
  if (frozen) freezes.set(threadId, frozen);
  await frozen?.check();

  await cloudroom(deps).control(threadId, "stop");
  await waitUntilStopped(client, saved.sessionId);
  step("downloading");

  const vmPath = (await vm(client, findNative(harness, nativeId))).toString().trim();
  if (harness === "acp-antigravity" && !/^\/tmp\/cloudroom-agy-[A-Za-z0-9_]+\.db$/.test(vmPath)) throw new ApiError(409, "teleport_unavailable", "Antigravity could not snapshot this conversation.");
  if (!vmPath) throw new ApiError(409, "teleport_unavailable", "The cloud conversation file was not found. The thread stays in Cloud.");
  const cloud = await client.sessionWorkspace(saved.sessionId);
  const lineage = harness === "codex" ? await codexLineage(client, vmPath) : [];
  const allowed = allowance();
  const local = { branch: await git(environment.path, ["branch", "--show-current"]), head: await git(environment.path, ["rev-parse", "HEAD"]) };
  const [session, changes, parents] = await Promise.all([
    download(client, vmPath, allowed),
    cloudChanges(client, cloud.path, local.head, thread.createdAt, allowed),
    downloadEach(client, lineage, allowed),
  ]);
  step("copying");
  if (harness === "acp-cursor" || harness === "acp-opencode" || harness === "acp-antigravity") await vm(client, `rm -f ${quote(vmPath)}`).catch(() => {});
  // A parent file that differs on the Mac is set aside, unless another Local thread is still using it.
  const inUse = (id: string) => deps.db.select({ id: threads.id }).from(threads)
    .where(and(eq(threads.providerId, "codex"), eq(threads.executionTarget, "local"), isNull(threads.archivedAt), isNull(threads.deletedAt))).all()
    .some((row) => row.id !== threadId && getLastProviderThreadId(deps, row.id) === id);
  for (const [index, path] of lineage.entries()) await installNative("codex", "", path, parents[index]!, environment.path, inUse);
  if (harness === "acp-antigravity") {
    if (deps.db.select({id: threads.id}).from(threads).where(and(eq(threads.providerId, harness), eq(threads.executionTarget, "local"), isNull(threads.archivedAt), isNull(threads.deletedAt))).all()
      .some(row => row.id !== threadId && getLastProviderThreadId(deps, row.id) === nativeId)) throw new Error("This Antigravity conversation is already open in another Local thread.");
    await importAntigravity(nativeId, session, cloud.path, environment.path);
  }
  else if (harness === "acp-opencode") await importOpenCode(deps, threadId, environment, nativeId, session);
  else await installNative(harness, nativeId, vmPath, session, environment.path);
  const aside = randomUUID();
  const kept = await applyChanges(environment.path, changes.archive, aside, changes.base);
  // The freeze still holds and nothing new was queued, so nothing sent meanwhile is lost.
  await frozen?.check();
  step("switching");

  const queued = cloudroom(deps).queue(threadId);
  const hub = new NotificationBuffer();
  deps.db.transaction((tx) => {
    // Background tasks still open died with the Cloud agent; the Mac would never close them (#1554).
    settleDanglingBackgroundTasksForStoppedThreadInTransaction(
      { db: tx, hub, logger: deps.logger },
      { threadId },
    );
    for (const message of queued)
      createQueuedThreadMessageInTransaction(tx, {
        threadId, content: message.content, model: message.model, reasoningLevel: message.reasoningLevel,
        permissionMode: message.permissionMode, serviceTier: message.serviceTier,
        waitingOn: null, sendAt: null, payload: { kind: "inline" }, systemNotice: null,
      });
    tx.delete(cloudroomCommands).where(eq(cloudroomCommands.threadId, threadId)).run();
    tx.delete(cloudroomThreads).where(eq(cloudroomThreads.threadId, threadId)).run();
    tx.delete(threadPluginMetadata).where(and(eq(threadPluginMetadata.threadId, threadId), inArray(threadPluginMetadata.pluginId, ["cloudroom.teleport", "cloudroom.project-copy"]))).run();
    tx.update(threads).set({ executionTarget: "local", environmentId: environment.id, status: "idle", updatedAt: Date.now() }).where(eq(threads.id, threadId)).run();
    // The agent's next turn, a queued one too, starts with this note (#1818).
    appendThreadEventInTransaction(tx, {
      threadId, environmentId: environment.id, type: "system/operation", scope: threadScope(),
      data: { operation: THREAD_TELEPORT_LOCAL_OPERATION, operationId: createEventId(), status: "completed", message: "Moved to Local", metadata: { seed: [handoffNote(cloud, local, kept, aside)] } },
    });
  });
  hub.flushInto(deps.hub);
  cloudroom(deps).detach(threadId);
  cloudroom(deps).threadStates.set(threadId, null);
  deps.hub.notifyThread(threadId, ["status-changed", "queue-changed"]);
  deps.hub.notifyProject(thread.projectId, ["threads-changed"]);
  requestQueuedMessageDispatch(deps, { kind: "thread-ready", threadId });
  void markLocal(deps, threadId, saved.sessionId);
  await client.close(saved.sessionId, randomUUID(), frozen?.id).catch((error: unknown) =>
    deps.logger.warn({ threadId, error }, "Cloud session did not close after Teleport to Local"));
  return { conflicts: kept.length };
}

/** What the resumed agent can't see for itself after Teleport to Local. */
function handoffNote(cloud: { branch: string | null; head: string | null }, local: { branch: string | null; head: string | null }, kept: string[], aside: string): PromptInput {
  const at = ({ branch, head }: typeof cloud) => [branch?.trim() && `branch ${branch.trim()}`, head?.trim() && `commit ${head.trim().slice(0, 12)}`].filter(Boolean).join(", ");
  const lines = [
    "[Teleport to Local]",
    `The user moved this thread from Cloud to their ${computer}.`,
    "Background jobs, servers, and tools installed in Cloud did not move.",
    "Cloud deletions were not applied here.",
    // Only Git knows ignored files; a folder without it copies every file changed since the thread started.
    cloud.head && "Git-ignored files (build output, .env) were not copied.",
    at(cloud) && `Cloud: ${at(cloud)}.`,
    at(local) && `Here: ${at(local)}.`,
    "Cloudroom copied the Cloud changes here as uncommitted edits.",
    "They may include earlier Cloud commits.",
    "Review them before committing.",
    ...kept.length ? [
      "These files also changed here, so they kept the local version:",
      ...kept.slice(0, 20).map((path) => `- ${path}`),
      ...kept.length > 20 ? [`- and ${kept.length - 20} more`] : [],
      `Their Cloud versions are in .cloudroom/teleport/${aside}/.`,
    ] : [],
  ];
  return { type: "text", text: lines.filter(Boolean).join("\n"), mentions: [], visibility: "agent-only" };
}

/** Its Cloud subagents report each turn through the website, which would keep sending them to the Cloud session closed
 *  here, and they would retry forever (2026-11-04). This app tells the thread about them itself now. */
async function markLocal(deps: AppDeps, threadId: string, session: string): Promise<void> {
  for (let tries = 1; ; tries++) {
    try { await cloudroom(deps).sandboxes.markLocal(threadId, session); return; }
    catch (error) {
      if (tries === 3) { deps.logger.warn({ threadId, error }, "Cloud did not save the move to the Mac"); return; }
      await new Promise((resolve) => setTimeout(resolve, tries * 2000));
    }
  }
}

function requireThisMac(deps: AppDeps, requested: CreateThreadEnvironmentArgs): void {
  const target = requested.type === "reuse" ? getEnvironment(deps.db, requested.environmentId)?.hostId
    : requested.type === "host" ? requested.hostId
    : requested.type === "provider" ? requested.machine && (requested.machine.type === "existing" ? requested.machine.hostId : "new") : undefined;
  if (target !== undefined && target !== resolvePrimaryHostId(deps))
    throw new ApiError(409, "fork_unavailable", `A Cloud thread forks to Local only on this ${computer}. Pick a folder or worktree on this ${computer}.`);
}

export async function prepareLocalFork(deps: AppDeps, source: Thread, request: { sourceSeqEnd?: number; environment: CreateThreadEnvironmentArgs }): Promise<{ fork: ThreadForkPoint; environment: CreateThreadEnvironmentArgs; note: PromptInput }> {
  requireThisMac(deps, request.environment);
  const saved = binding(deps.db, source.id);
  const harness = source.providerId as Harness;
  if (!saved?.sessionId || !saved.nativeId || !/^[A-Za-z0-9_-]+$/.test(saved.nativeId) || !FORK_HARNESSES.includes(harness))
    throw new ApiError(409, "fork_source_unavailable", `Only a started Claude Code or Codex Cloud thread can be forked to this ${computer}.`);
  const point = await cloudForkPoint(deps, source, request.sourceSeqEnd);
  const client = await cloudroom(deps).threadClient(source.id, true, "teleport_local");
  const vmPath = (await vm(client, findNative(harness, saved.nativeId))).toString().trim();
  if (!vmPath) throw new ApiError(409, "fork_source_unavailable", "The source conversation file was not found in its sandbox.");
  const lineage = harness === "codex" ? await codexLineage(client, vmPath) : [];
  const allowed = allowance();
  const [file, parents] = await Promise.all([download(client, vmPath, allowed), downloadEach(client, lineage, allowed)]);
  const session = point.through ? claudeTranscriptThrough(file, point.through) : file.subarray(0, file.lastIndexOf(10) + 1);
  const checkpoint = point.through ?? localCheckpoint(harness, session, point);
  const nativeId = harness === "claude-code" ? randomUUID() : saved.nativeId;
  const parse = conversationParser();
  const data = harness === "claude-code" ? Buffer.from(session.toString("utf8").split("\n").map((line) => line && JSON.stringify({ ...parse(line), sessionId: nativeId })).join("\n")) : session;
  const folder = await localForkFolder(deps, source);
  const inUse = (id: string) => deps.db.select({ id: threads.id }).from(threads)
    .where(and(eq(threads.providerId, "codex"), eq(threads.executionTarget, "local"), isNull(threads.archivedAt), isNull(threads.deletedAt))).all()
    .some((row) => getLastProviderThreadId(deps, row.id) === id);
  for (const [index, path] of lineage.entries()) await installNative("codex", "", path, parents[index]!, folder, inUse);
  await installNative(harness, nativeId, vmPath, data, folder);
  return {
    fork: { descriptor: { sourceProviderThreadId: nativeId, ...(checkpoint ? { sourceProviderCheckpointId: checkpoint } : {}) }, history: { kind: "thread", sourceThreadId: source.id, endSequence: point.end_sequence } },
    ...(await prepareLocalForkCode(deps, source, folder, request.environment)),
  };
}

export async function prepareLocalForkCode(deps: AppDeps, source: Thread, folder: string | null, requested: CreateThreadEnvironmentArgs): Promise<{ environment: CreateThreadEnvironmentArgs; note: PromptInput }> {
  requireThisMac(deps, requested);
  const saved = binding(deps.db, source.id);
  if (!saved?.sessionId) throw new ApiError(409, "fork_source_unavailable", "The source Cloud thread has not started yet.");
  const client = await cloudroom(deps).threadClient(source.id, true, "teleport_local");
  const cloud = await client.sessionWorkspace(saved.sessionId);
  const code = await landLocalForkCode(deps, client, source, cloud.path, folder ?? await localForkFolder(deps, source), requested);
  return {
    environment: code.environment,
    note: { type: "text", text: `[Local fork]\nThis conversation was forked from a Cloud thread and now runs on the user's ${computer}. ${code.note}`, mentions: [], visibility: "agent-only" },
  };
}

async function localForkFolder(deps: AppDeps, source: Thread): Promise<string> {
  const hostId = resolvePrimaryHostId(deps);
  const project = getProject(deps.db, source.projectId);
  if (hostId && project) await ensureProjectCheckoutForThread(deps, { project, hostId });
  return (await localEnvironment(deps, source).catch((error: unknown) => {
    throw error instanceof ApiError && error.body.code === "teleport_unavailable"
      ? new ApiError(409, "fork_unavailable", `This project has no folder on this ${computer} and no repository to clone. Add its folder here, or fork to Cloud.`)
      : error;
  })).path;
}

async function landLocalForkCode(deps: AppDeps, client: CloudroomClient, source: Thread, cloudPath: string, folder: string, requested: CreateThreadEnvironmentArgs): Promise<{ environment: CreateThreadEnvironmentArgs; note: string }> {
  const id = randomUUID().replaceAll("-", "").slice(0, 12);
  if (requested.type === "reuse" || requested.type === "host") resolveStableThreadRequestEnvironment(deps, { environment: requested, projectId: source.projectId });
  const inputs = requested.type === "provider" ? requested.inputs as { path?: string; branch?: { kind?: string } | null } | null : null;
  const switching = requested.type === "host"
    ? requested.workspace.type === "unmanaged" && requested.workspace.branch !== undefined
    : requested.type === "provider" && requested.environmentProviderId === DEFAULT_ENVIRONMENT_PROVIDER_ID.projectCheckout && inputs?.branch != null;
  const checkout = requested.type === "provider" && requested.environmentProviderId === DEFAULT_ENVIRONMENT_PROVIDER_ID.projectCheckout && !switching
    ? inputs?.path ?? folder : null;
  const path = requested.type === "reuse" ? getEnvironment(deps.db, requested.environmentId)?.path
    : requested.type === "host" && requested.workspace.type === "unmanaged" && !switching ? requested.workspace.path ?? folder
    : checkout;
  if (path) {
    const changes = await cloudChanges(client, cloudPath, await git(path, ["rev-parse", "HEAD"]), source.createdAt);
    const conflicts = (await applyChanges(path, changes.archive, id, changes.base)).length;
    return { environment: requested, note: `Cloudroom copied the files the Cloud thread changed into this folder.${conflicts ? ` ${conflicts} of them also changed here, so the Cloud copies are in .cloudroom/teleport/${id}/.` : ""}` };
  }
  const personal = source.projectId === PERSONAL_PROJECT_ID || (requested.type === "host" && requested.workspace.type === "personal")
    || (requested.type === "provider" && requested.environmentProviderId === DEFAULT_ENVIRONMENT_PROVIDER_ID.personalWorkspace);
  const named = (requested.type === "host" && requested.workspace.type === "managed-worktree" && requested.workspace.baseBranch.kind === "named")
    || (requested.type === "provider" && requested.environmentProviderId === DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree && inputs?.branch?.kind === "named");
  const hostId = resolvePrimaryHostId(deps);
  const bundle = personal || named || switching || !hostId || (await git(folder, ["rev-parse", "--git-dir"])) === null ? null : await sourceCode(client, cloudPath, id).then((code) => code && !isFiles(code.data) ? code.data : null);
  if (!bundle) return { environment: requested, note: "The Cloud thread's code was not copied here." };
  const branch = `cloudroom/fork-${id}`;
  const temporary = await mkdtemp(join(tmpdir(), "cloudroom-fork-"));
  try {
    const file = join(temporary, "code.bundle");
    await writeFile(file, bundle);
    // GIT_ALLOW_PROTOCOL=file: a checkout's `url.*.insteadOf` can't turn the local bundle into a proxy or SSH fetch.
    const fetch = () => exec("git", [...gitSafetyArgs(), "-C", folder, "fetch", "-q", file, `refs/cloudroom/${id}:refs/heads/${branch}`], { env: BUNDLE_ONLY, windowsHide: true });
    await fetch().catch(async () => { await exec("git", [...gitSafetyArgs(), "-C", folder, "fetch", "-q", "origin"], { windowsHide: true }).catch(() => {}); await fetch(); });
  } catch (error) {
    const reason = error instanceof Error && "stderr" in error ? String(error.stderr).trim() : "";
    throw new ApiError(409, "fork_code_unavailable", `The Cloud thread's code could not be copied to this ${computer}: ${reason || "git fetch failed"}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return {
    environment: { type: "provider", environmentProviderId: DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree, machine: { type: "existing", hostId: hostId! }, inputs: worktreeProviderInputs({ kind: "named", name: branch }, undefined, { kind: "default" }) },
    note: `It runs in a new worktree based on branch ${branch}, which holds the Cloud thread's code. The last commit, "Cloudroom fork: uncommitted changes", holds the work the Cloud thread had not committed.`,
  };
}

/** Copies the cloud thread's branch and its commits into the Mac project as a local branch. The agent keeps
 *  working, and uncommitted cloud changes stay in the cloud. The Mac's working tree is never touched. */
export async function copyToMac(deps: AppDeps, threadId: string): Promise<{ branch: string }> {
  const thread = getThread(deps.db, threadId);
  const saved = binding(deps.db, threadId);
  if (!thread || thread.executionTarget !== "cloud" || thread.parentThreadId || thread.deletedAt || !saved?.sessionId)
    throw new ApiError(409, "copy_unavailable", `Copy to ${computer} needs a started cloud thread.`);
  const environment = await localEnvironment(deps, thread);
  if (await git(environment.path, ["rev-parse", "--git-dir"]) === null)
    throw new ApiError(409, "copy_unavailable", `This project's folder on this ${computer} is not a Git repository.`);
  const client = await cloudroom(deps).teleportClient(threadId, "teleport_local");
  const cloud = await client.sessionWorkspace(saved.sessionId);
  const folder = await mkdtemp(join(tmpdir(), "cloudroom-copy-"));
  try {
    // First only the commits the remote lacks; the whole branch if this Mac lacks their base.
    for (const full of [false, true]) {
      const name = `.cache/cloudroom/copy-${randomUUID()}.bundle`;
      const packed = (await vm(client, [
        `cd ${quote(cloud.path)} || exit 1`,
        "branch=$(git symbolic-ref --quiet --short HEAD) || { echo 'no-branch'; exit 0; }",
        "mkdir -p ~/.cache/cloudroom",
        `git bundle create -q ~/${name} "refs/heads/$branch"${full ? "" : " --not --remotes"} 2>/dev/null || { echo 'empty'; exit 0; }`,
        `echo "$branch" ~/${name}`,
      ].join("\n"))).toString().trim().split("\n").pop() ?? "";
      if (packed === "no-branch") throw new ApiError(409, "copy_unavailable", "The cloud project is not on a branch.");
      if (packed === "empty") continue;
      const [branch, path] = packed.split(" ");
      if (!branch || !path || !/^[A-Za-z0-9._/-]+$/.test(branch)) throw new Error("The cloud branch could not be packed.");
      const file = join(folder, "branch.bundle");
      try { await writeFile(file, await download(client, path)); }
      finally { await vm(client, `rm -f ${quote(path)}`).catch(() => {}); }
      if (!full && await git(environment.path, ["bundle", "verify", "-q", file]) === null) continue;
      try { await exec("git", [...gitSafetyArgs(), "-C", environment.path, "fetch", "-q", file, `refs/heads/${branch}:refs/heads/${branch}`], { env: BUNDLE_ONLY, windowsHide: true }); }
      catch (error) {
        const reason = error instanceof Error && "stderr" in error ? String(error.stderr).trim() : "";
        throw new ApiError(409, "copy_unavailable", /checked out|rejected|non-fast-forward/.test(reason)
          ? `Your ${computer}'s ${branch} is checked out or has other commits. Switch branches or rename it, then retry.`
          : `The branch could not be copied: ${reason || "git fetch failed"}`);
      }
      return { branch };
    }
    throw new ApiError(409, "copy_unavailable", "The cloud branch has no commits to copy yet.");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** Save to Downloads: copies a cloud file into ~/Downloads under a free name and shows it, never opens it. */
export async function openOnMac(deps: AppDeps, threadId: string, path: string): Promise<{ path: string }> {
  if (getThread(deps.db, threadId)?.executionTarget !== "cloud")
    throw new ApiError(409, "open_unavailable", "Only cloud threads have cloud files.");
  const data = await download(await cloudroom(deps).threadClient(threadId), path, DOWNLOAD_MB);
  const folder = join(homedir(), "Downloads");
  await mkdir(folder, { recursive: true });
  const name = basename(path);
  const stem = name.slice(0, name.length - extname(name).length);
  let target = join(folder, name);
  for (let copy = 2; existsSync(target); copy++) target = join(folder, `${stem} ${copy}${extname(name)}`);
  await writeFile(target, data, { flag: "wx" });
  if (process.platform === "darwin") await exec("open", ["-R", target]);
  else spawn(folderOpenerCommand(), [folder], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  return { path: target };
}

type ImageDeps = Pick<AppDeps, "db" | "hub" | "config" | "providerRegistry">;
/** This Mac's data folder, which keeps a Cloud thread's copies of the files its chat showed. */
function imageDataDir(deps: ImageDeps): string {
  const hostId = resolvePrimaryHostId(deps);
  if (!hostId) throw new ApiError(409, "host_unavailable", "This computer's local host is not ready.");
  return requireHostDataDir(deps, hostId);
}

/** This Mac's copies of a cloud file the chat showed, so it still shows once the sandbox no longer has it: the current
 *  one, then where copies were saved before 2026-11-23 (read only, since agents can write thread storage). */
function savedCloudFiles(dataDir: string, threadId: string, path: string): string[] {
  const copy = chatFileCopyPath(dataDir, threadId, path);
  const legacy = legacyChatFileCopySegments(path);
  if (!copy || !legacy) throw new ApiError(400, "invalid_path", "Cloud file paths must be absolute.");
  return [copy, join(dataDir, "thread-storage", threadId, ...legacy)];
}

/** When a turn ends, its sandbox is still awake: saves the images its last message shows, so they still show after the
 *  sandbox is rebuilt from a copy without /tmp (a failover's move home, cold storage). Never wakes the sandbox. */
export async function saveCloudImages(deps: ImageDeps, threadId: string, text: string): Promise<void> {
  const paths = chatImagePaths(text).filter((path) => path.startsWith("/"));
  if (!paths.length) return;
  const requireThread = Boolean(getThread(deps.db, threadId));
  const client = await cloudroom(deps).threadClient(threadId, false).catch(() => null);
  if (!client) return;
  const dataDir = imageDataDir(deps);
  let failure: unknown;
  for (const path of paths) {
    const data = await download(client, path, PREVIEW_MB).catch(() => null);
    // Keep going: the other images can still be saved. The first error is still reported.
    if (data) await saveChatFileCopyForThread(deps, { data, dataDir, filePath: path, requireThread, threadId }).catch((error: unknown) => { failure ??= error; });
  }
  if (failure !== undefined) throw failure;
}

export async function cloudFile(deps: AppDeps, threadId: string, path: string): Promise<Buffer> {
  if (!isAbsolute(path)) throw new ApiError(400, "invalid_path", "Cloud file paths must be absolute.");
  const requireThread = Boolean(getThread(deps.db, threadId));
  const dataDir = imageDataDir(deps);
  let saved: Buffer | null = null;
  for (const file of savedCloudFiles(dataDir, threadId, path)) {
    saved = await readRegularFile(file, PREVIEW_MB * 1024 * 1024);
    if (saved) break;
  }
  try {
    // Only a copy that can be shown spares a sleeping sandbox the wake.
    const data = await download(await cloudroom(deps).threadClient(threadId, saved === null), path, PREVIEW_MB);
    // A copy that can't be saved still leaves the file to show.
    await saveChatFileCopyForThread(deps, { data, dataDir, filePath: path, requireThread, threadId }).catch(() => {});
    return data;
  } catch (error) {
    if (saved) return saved;
    throw error instanceof ApiError ? error : new ApiError(502, "cloud_file_unavailable", `Could not read ${path} from the cloud. ${error instanceof Error ? error.message : ""}`.trim());
  }
}

/** Which absolute paths exist in a thread's sandbox. A sleeping sandbox stays asleep and answers nothing. */
export async function cloudFilesExist(deps: AppDeps, threadId: string, paths: string[]): Promise<Record<string, boolean>> {
  const absolute = paths.filter((path) => isAbsolute(path));
  const client = absolute.length ? await cloudroom(deps).threadClient(threadId, false).catch(() => null) : null;
  if (!client) return {};
  const output = (await vm(client, `printf '\\035'\nfor p in ${absolute.map(quote).join(" ")}; do [ -e "$p" ] && echo 1 || echo 0; done`)).toString();
  const found = output.slice(output.indexOf("\x1d") + 1).trim().split("\n");
  if (!output.includes("\x1d") || found.length !== absolute.length || found.some((line) => line !== "0" && line !== "1")) return {};
  return Object.fromEntries(absolute.map((path, index) => [path, found[index] === "1"]));
}

async function localEnvironment(deps: AppDeps, thread: Thread) {
  const hostId = resolvePrimaryHostId(deps);
  if (!hostId) throw new ApiError(409, "host_unavailable", "This computer's local host is not ready.");
  const teleported = deps.db.select({ input: cloudroomCommands.input }).from(cloudroomCommands)
    .where(and(eq(cloudroomCommands.threadId, thread.id), eq(cloudroomCommands.command, "teleport")))
    .orderBy(desc(cloudroomCommands.createdAt)).get();
  const previous = teleported ? (JSON.parse(teleported.input) as { environmentId?: string }).environmentId : undefined;
  const folders = thread.projectId === PERSONAL_PROJECT_ID ? [await projectlessFolder(deps, hostId)] : listProjectSourcesByProjectIds(deps.db, [thread.projectId])
    .filter((source) => source.path && source.hostId === hostId)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
    .map((source) => source.path!);
  const candidates = [
    previous ? getEnvironment(deps.db, previous) : null,
    ...folders.map((path) => findProjectEnvironmentByHostPath(deps.db, thread.projectId, hostId, path)),
  ];
  const environment = candidates.find((candidate) => candidate && candidate.hostId === hostId && !candidate.isWorktree && candidate.path && existsSync(candidate.path));
  if (environment?.path) return { ...environment, path: environment.path };
  const folder = folders.find((path) => existsSync(path));
  if (!folder)
    throw new ApiError(409, "teleport_unavailable", "This project has no folder on this computer. Add the project folder here, then retry.");
  const created = await provisionUnmanagedEnvironmentForPath(deps, { hostId, path: folder, projectId: thread.projectId });
  if ("failure" in created) throw new ApiError(409, "teleport_unavailable", `${created.failure} The thread stays in Cloud.`);
  return created;
}

// Projectless threads run in the folder holding most of the user's repos, else ~/Developer.
async function projectlessFolder(deps: AppDeps, hostId: string): Promise<string> {
  const counts = new Map<string, number>();
  for (const source of listProjectSourcesByHost(deps.db, hostId))
    if (source.path) counts.set(dirname(source.path), (counts.get(dirname(source.path)) ?? 0) + 1);
  const parent = [...counts].sort((a, b) => b[1] - a[1]).map(([path]) => path).find((path) => path !== homedir() && existsSync(path));
  if (parent) return parent;
  const developer = join(homedir(), "Developer");
  await mkdir(developer, { recursive: true });
  return developer;
}

async function waitUntilStopped(client: CloudroomClient, sessionId: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if ((await client.session(sessionId)).current_request === null) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new ApiError(409, "teleport_stop_timeout", "The cloud agent did not stop. The thread stays in Cloud; try again.");
}

export async function vm(client: CloudroomClient, command: string, signal?: AbortSignal): Promise<Buffer> {
  const result = await client.runOnVm({ command, stdin: "" }, signal);
  if (result.code !== 0 || result.truncated)
    throw new Error(Buffer.from(result.stderr, "hex").toString().trim() || `Cloud command failed (${result.code})`);
  return Buffer.from(result.stdout, "hex");
}

export function findNative(harness: Harness, nativeId: string): string {
  if (harness === "acp-antigravity") {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(nativeId)) throw new Error("Invalid Antigravity conversation ID");
    const script = `import os,sqlite3,sys,tempfile
from pathlib import Path
p=Path.home()/".gemini/antigravity-cli/conversations"/(sys.argv[1]+".db")
if not p.is_file() or p.is_symlink(): sys.exit(1)
src=sqlite3.connect(p.as_uri()+"?mode=ro",uri=True)
src.execute("pragma trusted_schema=off")
if not src.execute("select 1 from trajectory_meta where cascade_id=? limit 1",(sys.argv[1],)).fetchone(): sys.exit(1)
fd,out=tempfile.mkstemp(prefix="cloudroom-agy-",suffix=".db"); os.close(fd)
dst=sqlite3.connect(out); src.backup(dst); dst.close(); src.close(); print(out)`;
    return `python3 -I -c ${quote(script)} ${quote(nativeId)}`;
  }
  // OpenCode 2 moved export under `session` (#2686); `--standalone` leaves no background service running. An unreadable
  // version runs OpenCode 1's.
  if (harness === "acp-opencode")
    return `export OPENCODE_DISABLE_AUTOUPDATE=1; v=$(opencode --version 2>/dev/null </dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1); c=export; [ "\${v%%.*}" -ge 2 ] 2>/dev/null && c="session export --standalone"
mkdir -p ~/.cache/cloudroom && f=~/.cache/cloudroom/opencode-${nativeId}.json && opencode $c ${nativeId} > "$f" </dev/null && echo "$f"`;
  // A Cursor chat is a folder (meta.json plus a SQLite store), so it travels as one archive.
  if (harness === "acp-cursor")
    return `d=$(ls -d "${VM_SESSIONS[harness]}"/*/${nativeId} 2>/dev/null | head -n1); [ -f "$d/meta.json" ] || exit 0
mkdir -p ~/.cache/cloudroom && tar -czf ~/.cache/cloudroom/cursor-${nativeId}.tgz -C "$d" --exclude='*-shm' . && echo ~/.cache/cloudroom/cursor-${nativeId}.tgz`;
  return `find "${VM_SESSIONS[harness]}" -name '*.jsonl' -printf '%T@ %p\\n' 2>/dev/null | sort -rn | cut -d' ' -f2- | while IFS= read -r f; do
  case "$f" in *${nativeId}*) echo "$f"; exit 0;; esac
  head -n1 "$f" | grep -qF '"id":"${nativeId}"' && { echo "$f"; exit 0; }
done; exit 0`;
}

/** A Codex fork stores only its new turns and reads the rest from its parents' files at saved byte offsets.
 *  Returns those parent files on the VM, nearest first, searched like Codex: active sessions, then archived. */
export async function codexLineage(client: CloudroomClient, path: string): Promise<string[]> {
  const script = `import json, os, sys
home, path = os.path.expanduser("~/.codex"), sys.argv[1]
for _ in range(64):
    with open(path, "rb") as f: base = (json.loads(f.readline()).get("payload") or {}).get("history_base")
    if not base: break
    id = base["thread_id"]
    path = next((os.path.join(d, n) for r in ("sessions", "archived_sessions") for d, _, names in os.walk(os.path.join(home, r))
                 for n in names if n.endswith(("-%s.jsonl" % id, "_%s.jsonl" % id))), None)
    if not path: sys.exit("The parent conversation %s of this forked Codex chat is missing." % id)
    print(path)
else: sys.exit("This forked Codex chat has too many parents.")`;
  const parents = (await vm(client, `python3 -I -c ${quote(script)} ${quote(path)}`)).toString().split("\n").filter(Boolean);
  // The script stops at 64, but a replaced Core can answer anything.
  if (parents.length > 64) throw new Error("This forked Codex chat has too many parents.");
  return parents;
}

export async function download(client: CloudroomClient, path: string, limit: number | Allowance = MAX_DOWNLOAD_MB, run = (command: string) => vm(client, command)): Promise<Buffer> {
  const allowed = typeof limit === "number" ? allowance(limit) : limit;
  const size = Number((await run(`[ -f ${quote(path)} ] && wc -c < ${quote(path)} || echo -1`)).toString().trim());
  if (size < 0) throw new ApiError(404, "cloud_file_missing", `${path} is not a file in the cloud.`);
  if (!Number.isSafeInteger(size)) throw new Error(`The cloud sent no valid size for ${basename(path)}.`);
  if (size > allowed.bytes) throw new ApiError(413, "cloud_file_too_large", `${basename(path)} is over the ${allowed.mb} MB limit.`);
  allowed.bytes -= size;
  const parts: Buffer[] = [];
  for (let offset = 0; offset < size; offset += CHUNK) {
    const wanted = Math.min(CHUNK, size - offset);
    const part = await run(`tail -c +${offset + 1} ${quote(path)} | head -c ${wanted}`);
    // `head -c` never sends more, so a download keeps at most its reported size, even of a file still growing.
    if (part.length > wanted) throw new Error(`The cloud sent more of ${basename(path)} than was asked for.`);
    parts.push(part);
  }
  return Buffer.concat(parts);
}

/** JSON.parse for one conversation file, whole or line by line with the same parser. */
export function conversationParser() {
  let left = CONVERSATION_VALUES;
  return (text: string) => {
    left -= values(text, left);
    if (left < 0) throw new ApiError(413, "conversation_too_complex", "This conversation is too complex to copy safely, so it stays where it is.");
    return JSON.parse(text);
  };
}

/** One file at a time, so a sandbox can't start many reads at once. */
async function downloadEach(client: CloudroomClient, paths: string[], allowed: Allowance): Promise<Buffer[]> {
  const files: Buffer[] = [];
  for (const path of paths) files.push(await download(client, path, allowed));
  return files;
}

/** Sums the changed files (NUL-separated on stdin) before packing, so changes over the limit fail in a second, not after
 *  a minute of gzip, and say which folders are big (a user's 1.3 GB of changes, 2026-11-26). Prints nothing under it. */
const SIZE_CHECK = `import json, os, sys
limit, sizes = int(sys.argv[1]), {}
def lsize(path):
    try: return os.lstat(path).st_size
    except OSError: return 0
def size(path):
    if os.path.islink(path) or not os.path.isdir(path): return lsize(path)
    total = 0
    for folder, dirs, names in os.walk(path):
        dirs[:] = [name for name in dirs if name != ".git"]
        total += sum(lsize(os.path.join(folder, name)) for name in names)
    return total
for path in filter(None, sys.stdin.buffer.read().split(b"\\0")):
    path = os.fsdecode(path)
    top = path.removeprefix("./").split("/")[0] + ("/" if "/" in path.removeprefix("./") else "")
    sizes[top] = sizes.get(top, 0) + size(path)
if sum(sizes.values()) > limit:
    print(json.dumps({"bytes": sum(sizes.values()), "top": sorted(sizes.items(), key=lambda item: -item[1])[:3]}))`;

const mb = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;

export async function cloudChanges(client: CloudroomClient, workspace: string, localHead: string | null, since: number, allowed: number | Allowance = MAX_DOWNLOAD_MB): Promise<{ archive: Buffer; base: string | null }> {
  const head = localHead?.trim();
  const id = randomUUID();
  const archive = `.cache/cloudroom/teleport-local-${id}.tgz`;
  const list = `~/.cache/cloudroom/teleport-local-${id}.list`;
  const limit = (typeof allowed === "number" ? allowed : allowed.mb) * 1024 * 1024;
  const skipped = [...SKIPPED, ".cloudroom"].map((name) => `-name ${quote(name)}`).join(" -o ");
  const command = [
    `cd ${quote(workspace)} || exit 1`,
    "mkdir -p ~/.cache/cloudroom",
    "if git rev-parse --git-dir >/dev/null 2>&1; then",
    "  proven=0; base=$(git reflog --format=%H HEAD 2>/dev/null | tail -n 1); [ -n \"$base\" ] || base=HEAD",
    head && /^[0-9a-f]{40,64}$/.test(head) ? `  git cat-file -e '${head}^{commit}' 2>/dev/null && shared=$(git merge-base HEAD ${head} 2>/dev/null) && { base=$shared; proven=1; }` : "",
    `  { git diff -z --name-only --no-renames --diff-filter=d "$base"; git ls-files -z --others --exclude-standard; } > ${list}`,
    "else",
    `  proven=0; find . \\( ${skipped} \\) -prune -o \\( -type f -o -type l \\) -newermt @${Math.floor(since / 1000) - 600} -print0 > ${list}`,
    "fi",
    // Only an early answer: without Python, the download's own size check still holds.
    `big=$(python3 -I -c ${quote(SIZE_CHECK)} ${limit} < ${list} 2>/dev/null) || big=`,
    `if [ -n "$big" ]; then rm -f ${list}; echo "too-large $big"; exit 0; fi`,
    `${packChangesCommand(`~/${archive}`)} < ${list} || { rm -f ~/${archive} ${list}; exit 1; }`,
    `rm -f ${list}`,
    `echo "$proven" "$base" ~/${archive}`,
  ].join("\n");
  try {
    const slow = "The cloud file changes took over 4 minutes to pack. The thread stays in Cloud.";
    const created = (await vm(client, `timeout -k 5s 240s bash -c ${quote(command)} || { code=$?; [ $code = 124 ] && echo ${quote(slow)} >&2; exit $code; }`)).toString().trim();
    const last = created.split("\n").pop() ?? "";
    if (last.startsWith("too-large ")) {
      const big = JSON.parse(last.slice(10)) as { bytes: number; top: [string, number][] };
      if (!Number.isFinite(big?.bytes) || !Array.isArray(big.top)) throw new Error("The cloud sent an invalid size report.");
      throw new ApiError(413, "cloud_changes_too_large", `The cloud changed ${mb(big.bytes)} of files, over the ${mb(limit)} limit for copying them here. Biggest: ${big.top.map(([path, bytes]) => `${String(path)} (${mb(Number(bytes))})`).join(", ")}. Delete them in the cloud or add them to .gitignore, then try again. Nothing was moved.`);
    }
    const [proven, base, path] = last.split(" ");
    if (!path) throw new Error("The cloud file changes could not be packed. The thread stays in Cloud.");
    return { archive: await download(client, path, allowed), base: proven === "1" && base && /^[0-9a-f]{40,64}$/.test(base) ? base : null };
  } finally {
    await vm(client, `rm -f ~/${archive} ${list}`).catch(() => {});
  }
}

const copying = new Map<string, Promise<unknown>>();

/** One Teleport or Fork copy per project at a time, so another copy can't add a link between a check and a write.
 *  Returns the files that kept the Mac's version, whose cloud copies went to `.cloudroom/teleport/<id>/`. */
export async function applyChanges(root: string, archive: Buffer, id: string, base: string | null): Promise<string[]> {
  const real = await realpath(root);
  const key = getHostPathComparisonKey(real) ?? real;
  const run = (copying.get(key) ?? Promise.resolve()).catch(() => {}).then(() => copyChanges(root, real, archive, id, base));
  const done = run.catch(() => {});
  copying.set(key, done);
  try {
    return await run;
  } finally {
    if (copying.get(key) === done) copying.delete(key);
  }
}

async function copyChanges(root: string, real: string, archive: Buffer, id: string, base: string | null): Promise<string[]> {
  const aside = join(root, ".cloudroom", "teleport", id);
  if (!(await inside(real, join(aside, "file"))))
    throw new ApiError(409, "teleport_unavailable", "This project's .cloudroom folder points outside the project. The thread stays in Cloud.");
  const folder = await mkdtemp(join(tmpdir(), "cloudroom-teleport-local-"));
  try {
    const file = join(folder, "changes.tgz");
    const staged = join(folder, "files");
    await writeFile(file, archive);
    await mkdir(staged);
    await exec(tarCommand(), ["-xzf", file, "-C", staged], { windowsHide: true });
    const paths = (await exec(tarCommand(), ["-tzf", file], { maxBuffer: 64 * 1024 * 1024, windowsHide: true })).stdout.split(process.platform === "win32" ? /\r?\n/ : "\n")
      .map((path) => path.split("/").filter((part) => part !== ".").join("/")).filter((path) => path && !path.endsWith("/") && !isAbsolute(path) && !path.split("/").includes("..") && !inGit(path)
        && path.split("/")[0]!.toLowerCase() !== ".cloudroom");
    const top = (await git(root, ["rev-parse", "--show-toplevel"]))?.trim();
    const dirty = base && top && (await realpath(top).catch(() => null)) === real ? await dirtyPaths(root, base) : null;
    const keys = await Promise.all(paths.map((path) => landsAt(root, path)));
    const dirtyKeys = dirty && new Set(await Promise.all([...dirty].map((path) => landsAt(root, path))));
    const first = new Map<string, string>();
    for (const [index, key] of keys.entries()) {
      const other = first.get(key);
      if (other !== undefined)
        throw new ApiError(409, "teleport_unavailable", `The cloud files ${other} and ${paths[index]} are the same file on this ${process.platform === "win32" ? "PC" : COMPUTER}. Rename one in the cloud, then try again. The thread stays in Cloud.`);
      first.set(key, paths[index]!);
    }
    const kept: string[] = [];
    for (const [index, path] of paths.entries()) {
      const incoming = join(staged, path);
      let target = join(root, path);
      const existing = await lstat(target).catch(() => null);
      if (existing && (await same(incoming, target))) continue;
      const replace = !existing || (dirtyKeys !== null && !dirtyKeys.has(keys[index]!) && !existing.isSymbolicLink());
      if (!replace || !(await inside(real, target))) {
        target = join(aside, path);
        kept.push(path);
        if (!(await inside(real, target)))
          throw new ApiError(409, "teleport_unavailable", `The cloud file ${path} would land outside this project. The thread stays in Cloud.`);
      }
      await mkdir(dirname(target), { recursive: true });
      await cp(incoming, target, { force: true, verbatimSymlinks: true });
    }
    return kept;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function landsAt(root: string, path: string): Promise<string> {
  let folder = join(root, path);
  const rest: string[] = [];
  while (!(await lstat(folder).catch(() => null)) && dirname(folder) !== folder) {
    rest.unshift(basename(folder));
    folder = dirname(folder);
  }
  const real = join(await realpath(folder).catch(() => folder), ...rest);
  return getHostPathComparisonKey(real) ?? real;
}

async function inside(root: string, path: string): Promise<boolean> {
  let folder = dirname(path);
  while (!(await lstat(folder).catch(() => null))) folder = dirname(folder);
  const real = await realpath(folder).catch(() => null);
  // A symlink from an earlier teleport could still point into .git.
  return !!real && (real === root || real.startsWith(root + sep)) && !inGit(real.slice(root.length));
}

async function dirtyPaths(root: string, base: string): Promise<Set<string> | null> {
  const [status, committed] = await Promise.all([
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(root, ["diff", "-z", "--name-only", "--no-renames", base, "HEAD"]),
  ]);
  if (status === null || committed === null) return null;
  const dirty = new Set(committed.split("\0").filter(Boolean));
  const entries = status.split("\0");
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.length < 4) continue;
    dirty.add(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") index++;
  }
  return dirty;
}

async function same(a: string, b: string): Promise<boolean> {
  return Promise.all([readFile(a), readFile(b)]).then(([left, right]) => left.equals(right), () => false);
}

/** Env for fetching a local bundle file: no other transport, so repo config can't redirect it. */
const BUNDLE_ONLY = { ...process.env, GIT_ALLOW_PROTOCOL: "file" };

async function git(cwd: string, args: string[]): Promise<string | null> {
  return exec("git", [...gitSafetyArgs(), "-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }).then((result) => result.stdout, () => null);
}

/** `lineage`: a Codex fork's parent file (see `codexLineage`), kept byte-for-byte. A Mac copy that already holds
 *  those bytes stays, since its own forks may read further; any other copy is set aside unless it is in use. */
async function installNative(harness: Harness, nativeId: string, vmPath: string, bytes: Buffer, cwd: string, lineage?: (id: string) => boolean) {
  if (harness === "acp-cursor") return installCursor(nativeId, bytes, cwd);
  const end = bytes.indexOf(10);
  if (end < 0) throw new Error("The cloud conversation file is empty.");
  let data = bytes;
  if (lineage) nativeId = /^rollout-.{19}-(.+)\.jsonl$/.exec(basename(vmPath))?.[1] ?? "";
  else if (harness !== "claude-code") {
    const header = conversationParser()(bytes.subarray(0, end).toString("utf8"));
    if (harness === "codex" && header.type === "session_meta") {
      const { cwd: source, runtime_workspace_roots: roots } = header.payload;
      header.payload.cwd = cwd;
      // Codex refuses to resume with another platform's roots: the old cwd maps here, other foreign roots go.
      if (typeof source === "string" && Array.isArray(roots) && source.startsWith("/") !== cwd.startsWith("/")) {
        const key = (path: string) => (path.startsWith("/") ? path : path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase());
        const mapped = [...new Set(roots.filter((root) => typeof root === "string" && (key(root) === key(source) || root.startsWith("/") === cwd.startsWith("/")))
          .map((root: string) => (key(root) === key(source) ? cwd : root)))];
        header.payload.runtime_workspace_roots = mapped.length || !roots.length ? mapped : [cwd]; // [] would mean "no workspace"
      }
    }
    if (harness === "pi" && header.type === "session") header.cwd = cwd;
    data = Buffer.concat([Buffer.from(JSON.stringify(header)), bytes.subarray(end)]);
  }
  if (!nativeId) throw new Error("The cloud conversation file has an unexpected name.");
  const target = await nativeTarget(harness, nativeId, basename(vmPath), cwd);
  if (lineage && existsSync(target)) {
    if ((await readFile(target)).subarray(0, data.length).equals(data)) return;
    if (lineage(nativeId.split("_")[0]!))
      throw new ApiError(409, "teleport_unavailable", "This forked chat's parent conversation is open in another Local thread with different history. The thread stays in Cloud.");
  }
  await mkdir(dirname(target), { recursive: true });
  if (existsSync(target)) await rename(target, `${target}.before-teleport-${Date.now()}`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, target);
}

/** agy runs commands in the first workspace saved in its conversation: `trajectory_metadata_blob`, a protobuf whose
 *  field 7 lists workspace URIs and field 1 holds workspaces (folder URI 1, git root URI 2). Moves `from` to `to` there. */
export function moveAntigravityWorkspace(blob: Uint8Array, from: string, to: string): Buffer {
  const move = (value: Buffer) => {
    if (!value.toString().startsWith("file://")) return value;
    const path = decodeURIComponent(new URL(value.toString()).pathname), root = from.replace(/\/+$/, "");
    if (path !== root && !path.startsWith(root + "/")) return value;
    return Buffer.from(pathToFileURL(join(to, path.slice(root.length))).href);
  };
  // Unchanged bytes are copied in ranges, so a large blob costs no more than its own size.
  const rewrite = (data: Buffer, map: (field: number, value: Buffer) => Buffer) => {
    const parts: Buffer[] = [];
    let at = 0, copied = 0;
    const varint = () => {
      let value = 0;
      for (let scale = 1; ; scale *= 128) {
        if (at >= data.length || scale > 2 ** 63) throw new Error("Invalid protobuf");
        const byte = data[at++]!;
        value += (byte & 127) * scale;
        if (byte < 128) return value;
      }
    };
    const encode = (value: number) => {
      const bytes: number[] = [];
      for (; value > 127; value = Math.floor(value / 128)) bytes.push((value % 128) | 128);
      return Buffer.from([...bytes, value]);
    };
    while (at < data.length) {
      const start = at, key = varint(), type = key % 8;
      if (type === 0) varint();
      else if (type === 1 || type === 5) at += type === 1 ? 8 : 4;
      else if (type !== 2) throw new Error("Invalid protobuf");
      const length = type === 2 ? varint() : 0, value = data.subarray(at, at += length);
      if (at > data.length) throw new Error("Invalid protobuf");
      const mapped = type === 2 ? map(Math.floor(key / 8), value) : value;
      if (mapped === value) continue;
      parts.push(data.subarray(copied, start), encode(key), encode(mapped.length), mapped);
      copied = at;
    }
    return parts.length ? Buffer.concat([...parts, data.subarray(copied)]) : data;
  };
  return rewrite(Buffer.from(blob), (field, value) =>
    field === 7 ? move(value) : field === 1 ? rewrite(value, (inner, uri) => (inner === 1 || inner === 2 ? move(uri) : uri)) : value);
}

/** Writes the moved workspace into the staged copy only when it is exactly the layout agy 1.5 makes: anything else, or an
 *  error, leaves the copy as it came. No triggers or foreign keys, so the update changes this one row and nothing else. */
export function moveAntigravityConversation(file: string, id: string, from: string, to: string) {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=OFF");
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='trajectory_metadata_blob'").get();
    if (table?.sql !== 'CREATE TABLE `trajectory_metadata_blob` (`id` text DEFAULT "main",`data` blob,PRIMARY KEY (`id`))'
      || db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' LIMIT 1").get()
      || db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND tbl_name='trajectory_metadata_blob' COLLATE NOCASE AND sql IS NOT NULL LIMIT 1").get()
      || db.prepare("SELECT 1 FROM sqlite_master m, pragma_foreign_key_list(m.name) WHERE m.type='table' LIMIT 1").get()
      || !db.prepare("SELECT 1 FROM trajectory_meta WHERE cascade_id=? LIMIT 1").get(id)) return;
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id='main' AND typeof(data)='blob' AND length(data) <= 1048576").get();
      const moved = row?.data instanceof Uint8Array ? moveAntigravityWorkspace(row.data, from, to) : null;
      if (moved && !moved.equals(row!.data as Uint8Array))
        db.prepare("UPDATE trajectory_metadata_blob SET data=? WHERE id='main'").run(moved);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

/** SQLite's backup includes the WAL. Preserve an existing Local copy and refuse to replace a diverged conversation. */
async function importAntigravity(id: string, bytes: Buffer, from: string, to: string) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))
    throw new Error("Invalid Antigravity conversation ID");
  const folder = join(homedir(), ".gemini", "antigravity-cli", "conversations");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const target = join(folder, id + ".db"),
    staged = join(folder, "." + randomUUID() + ".db");
  await writeFile(staged, bytes, { mode: 0o600, flag: "wx" });
  try {
    try {
      moveAntigravityConversation(staged, id, from, to);
    } catch {} // Commands then still run in the Cloud folder (#2453), as before.
    const incoming = new DatabaseSync(staged, { readOnly: true });
    try {
      incoming.exec("PRAGMA trusted_schema=OFF");
      if (!incoming.prepare("SELECT 1 FROM trajectory_meta WHERE cascade_id=? LIMIT 1").get(id))
        throw new Error("Antigravity conversation identity mismatch");
      if (existsSync(target)) {
        if (!(await lstat(target)).isFile())
          throw new Error("Antigravity conversation is not a regular file");
        incoming.prepare("ATTACH DATABASE ? AS previous").run(target);
        if (
          !incoming
            .prepare("SELECT 1 FROM previous.trajectory_meta WHERE cascade_id=? LIMIT 1")
            .get(id) ||
          incoming
            .prepare("SELECT * FROM previous.steps EXCEPT SELECT * FROM main.steps LIMIT 1")
            .get()
        )
          throw new Error(
            "This Local Antigravity conversation changed. The thread stays in Cloud.",
          );
        const previous = target + ".before-teleport-" + randomUUID();
        await writeFile(previous, "", { flag: "wx", mode: 0o600 });
        await backup(incoming, previous, { source: "previous" });
        incoming.exec("DETACH DATABASE previous");
        await chmod(target, 0o600);
        await backup(incoming, target);
      } else {
        await link(staged, target);
      }
    } finally {
      incoming.close();
    }
  } finally {
    await Promise.all(["", "-wal", "-shm"].map((suffix) => rm(staged + suffix, { force: true })));
  }
}

async function importOpenCode(deps: AppDeps, threadId: string, environment: { id: string; hostId: string; path: string }, nativeId: string, data: Buffer) {
  conversationParser()(data.toString("utf8"));
  const folder = await mkdtemp(join(tmpdir(), "cloudroom-teleport-local-"));
  try {
    const file = join(folder, `${nativeId}.json`);
    await writeFile(file, data, { mode: 0o600 });
    await runLiveHostCommand(deps, {
      hostId: environment.hostId,
      timeoutMs: 120_000,
      command: {
        type: "thread.teleport",
        action: "import",
        transferId: randomUUID(),
        threadId,
        environmentId: environment.id,
        workspaceContext: workspaceContextFromPath({ path: environment.path }),
        sessions: [{ threadId, nativeId, harness: "opencode" }],
        file,
      },
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** Cloud archives are untrusted: a symlink or hard link in one would let a later write land outside the folder. */
async function assertPlainTree(folder: string): Promise<void> {
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    const info = await lstat(join(entry.parentPath, entry.name));
    if (!info.isDirectory() && !(info.isFile() && info.nlink === 1))
      throw new ApiError(409, "teleport_unavailable", "The cloud chat contains a link, so it was not copied. The thread stays in Cloud.");
  }
}

// Local Cursor keeps each chat in ~/.cursor/acp-sessions/<id>/, the folder the host's Teleport capture reads.
async function installCursor(nativeId: string, archive: Buffer, cwd: string) {
  const target = join(homedir(), ".cursor", "acp-sessions", nativeId);
  const staged = `${target}.${randomUUID()}.tmp`;
  await mkdir(staged, { recursive: true, mode: 0o700 });
  try {
    await writeFile(`${staged}.tgz`, archive, { mode: 0o600 });
    await exec(tarCommand(), ["-xzf", `${staged}.tgz`, "-C", staged], { windowsHide: true });
    await assertPlainTree(staged);
    const meta = join(staged, "meta.json");
    await writeFile(meta, JSON.stringify({ ...conversationParser()(await readFile(meta, "utf8")), cwd }));
    if (existsSync(target)) await rename(target, `${target}.before-teleport-${Date.now()}`);
    await rename(staged, target);
  } finally {
    await rm(`${staged}.tgz`, { force: true });
    await rm(staged, { recursive: true, force: true });
  }
}

async function nativeTarget(harness: Harness, nativeId: string, name: string, cwd: string): Promise<string> {
  if (harness === "pi")
    return join(process.env.BB_PI_BRIDGE_SESSION_DIR?.trim() || join(homedir(), ".bb", "pi-bridge-sessions"), `${nativeId}.jsonl`);
  if (harness === "claude-code")
    return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${nativeId}.jsonl`);
  const sessions = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
  const existing = (await readdir(sessions, { recursive: true }).catch(() => [] as string[])).find((file) => file.endsWith(`-${nativeId}.jsonl`));
  if (existing) return join(sessions, existing);
  const date = /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(name);
  return join(sessions, ...(date ? date.slice(1) : ["teleport"]), name);
}
