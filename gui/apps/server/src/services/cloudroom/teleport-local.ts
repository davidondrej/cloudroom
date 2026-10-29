import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, sep } from "node:path";
import { promisify } from "node:util";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  cloudroomCommands,
  cloudroomThreads,
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
import { getHostPathComparisonKey, PERSONAL_PROJECT_ID, type PromptInput, type TeleportLocalStep, type Thread, COMPUTER } from "@cloudroom/domain";
import { folderOpenerCommand, tarCommand } from "@cloudroom/process-utils";
import type { CreateThreadEnvironmentArgs } from "@cloudroom/server-contract";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { resolvePrimaryHostId } from "../hosts/primary-host.js";
import { runLiveHostCommand } from "../hosts/live-command.js";
import { workspaceContextFromPath } from "../environments/workspace-command-target.js";
import { provisionUnmanagedEnvironmentForPath } from "../threads/thread-environment-directory.js";
import { getLastProviderThreadId } from "../threads/thread-events.js";
import type { ThreadForkPoint } from "../threads/thread-fork-history.js";
import { worktreeProviderInputs } from "../threads/thread-environment-placement.js";
import { ensureProjectCheckoutForThread } from "../projects/project-source-setup.js";
import { resolveStableThreadRequestEnvironment } from "../threads/thread-request-eligibility.js";
import { DEFAULT_ENVIRONMENT_PROVIDER_ID } from "../environments/environment-provider-ids.js";
import { requestQueuedMessageDispatch } from "../threads/queued-message-dispatch.js";
import { requireThreadStoragePath } from "../threads/thread-storage.js";
import { cloudroom } from "./commands.js";
import type { CloudroomClient } from "./client.js";
import { SKIPPED } from "./project-copy.js";
import { cloudForkPoint, FORK_HARNESSES, isFiles, localCheckpoint, sourceCode } from "./fork.js";
import { binding, localTeleports, teleportProgress } from "./store.js";

type Harness = "codex" | "pi" | "claude-code" | "acp-cursor" | "acp-opencode";
const VM_SESSIONS: Record<Harness, string> = {
  codex: "$HOME/.codex/sessions",
  pi: "$HOME/.pi/agent/sessions",
  "claude-code": "$HOME/.claude/projects",
  "acp-cursor": "$HOME/.cursor/chats",
  "acp-opencode": "$HOME/.local/share/opencode",
};
const CHUNK = 8 * 1024 * 1024;
const PREVIEW_MB = 20;
const DOWNLOAD_MB = 200;
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
    step();
  }
}

async function run(deps: AppDeps, threadId: string, step: (value: TeleportLocalStep) => void): Promise<{ conflicts: number }> {
  const thread = getThread(deps.db, threadId);
  const saved = binding(deps.db, threadId);
  const harness = thread?.providerId as Harness | undefined;
  const phase = teleportProgress(deps.db, threadId)?.phase;
  if (!thread || thread.executionTarget !== "cloud" || thread.parentThreadId || thread.archivedAt || thread.deletedAt
    || !saved?.sessionId || !harness || !(harness in VM_SESSIONS) || (phase && !["complete", "cancelled", "error"].includes(phase)))
    throw new ApiError(409, "teleport_unavailable", "Teleport to Local needs a Codex, Pi, Claude Code, opencode, or Cursor cloud parent thread.");
  const nativeId = getLastProviderThreadId(deps, threadId);
  if (!nativeId || !/^[A-Za-z0-9_-]+$/.test(nativeId))
    throw new ApiError(409, "teleport_unavailable", "This cloud thread has no saved conversation yet.");
  const environment = await localEnvironment(deps, thread);
  const client = await cloudroom(deps).teleportClient(threadId);

  await cloudroom(deps).control(threadId, "stop");
  await waitUntilStopped(client, saved.sessionId);
  step("downloading");

  const vmPath = (await vm(client, findNative(harness, nativeId))).toString().trim();
  if (!vmPath) throw new ApiError(409, "teleport_unavailable", "The cloud conversation file was not found. The thread stays in Cloud.");
  const cloud = await client.sessionWorkspace(saved.sessionId);
  const lineage = harness === "codex" ? await codexLineage(client, vmPath) : [];
  const [session, changes, parents] = await Promise.all([
    download(client, vmPath),
    cloudChanges(client, cloud.path, await git(environment.path, ["rev-parse", "HEAD"]), thread.createdAt),
    Promise.all(lineage.map((path) => download(client, path))),
  ]);
  step("copying");
  if (harness === "acp-cursor" || harness === "acp-opencode") await vm(client, `rm -f ${quote(vmPath)}`).catch(() => {});
  // A parent file that differs on the Mac is set aside, unless another Local thread is still using it.
  const inUse = (id: string) => deps.db.select({ id: threads.id }).from(threads)
    .where(and(eq(threads.providerId, "codex"), eq(threads.executionTarget, "local"), isNull(threads.archivedAt), isNull(threads.deletedAt))).all()
    .some((row) => row.id !== threadId && getLastProviderThreadId(deps, row.id) === id);
  for (const [index, path] of lineage.entries()) await installNative("codex", "", path, parents[index]!, environment.path, inUse);
  if (harness === "acp-opencode") await importOpenCode(deps, threadId, environment, nativeId, session);
  else await installNative(harness, nativeId, vmPath, session, environment.path);
  const conflicts = await applyChanges(environment.path, changes.archive, randomUUID(), changes.base);
  step("switching");

  const queued = cloudroom(deps).queue(threadId);
  deps.db.transaction((tx) => {
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
  });
  cloudroom(deps).detach(threadId);
  deps.hub.notifyThread(threadId, ["status-changed", "queue-changed"]);
  deps.hub.notifyProject(thread.projectId, ["threads-changed"]);
  requestQueuedMessageDispatch(deps, { kind: "thread-ready", threadId });
  await client.close(saved.sessionId, randomUUID()).catch((error: unknown) =>
    deps.logger.warn({ threadId, error }, "Cloud session did not close after Teleport to Local"));
  return { conflicts };
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
  const point = cloudForkPoint(deps.db, source, request.sourceSeqEnd);
  const client = await cloudroom(deps).threadClient(source.id);
  const vmPath = (await vm(client, findNative(harness, saved.nativeId))).toString().trim();
  if (!vmPath) throw new ApiError(409, "fork_source_unavailable", "The source conversation file was not found in its sandbox.");
  const lineage = harness === "codex" ? await codexLineage(client, vmPath) : [];
  const [file, parents] = await Promise.all([download(client, vmPath), Promise.all(lineage.map((path) => download(client, path)))]);
  const session = file.subarray(0, file.lastIndexOf(10) + 1);
  const checkpoint = localCheckpoint(harness, session, point);
  const folder = await localForkFolder(deps, source);
  const inUse = (id: string) => deps.db.select({ id: threads.id }).from(threads)
    .where(and(eq(threads.providerId, "codex"), eq(threads.executionTarget, "local"), isNull(threads.archivedAt), isNull(threads.deletedAt))).all()
    .some((row) => getLastProviderThreadId(deps, row.id) === id);
  for (const [index, path] of lineage.entries()) await installNative("codex", "", path, parents[index]!, folder, inUse);
  const nativeId = harness === "claude-code" ? randomUUID() : saved.nativeId;
  const data = harness === "claude-code" ? Buffer.from(session.toString("utf8").split("\n").map((line) => line && JSON.stringify({ ...JSON.parse(line), sessionId: nativeId })).join("\n")) : session;
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
  const client = await cloudroom(deps).threadClient(source.id);
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
      ? new ApiError(409, "fork_unavailable", `This project has no folder on this ${computer} and no GitHub repo to clone. Add its folder here, or fork to Cloud.`)
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
    const conflicts = await applyChanges(path, changes.archive, id, changes.base);
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
    const fetch = () => exec("git", ["-C", folder, "fetch", "-q", file, `refs/cloudroom/${id}:refs/heads/${branch}`]);
    await fetch().catch(async () => { await exec("git", ["-C", folder, "fetch", "-q", "origin"]).catch(() => {}); await fetch(); });
  } catch (error) {
    const reason = error instanceof Error && "stderr" in error ? String(error.stderr).trim() : "";
    throw new ApiError(409, "fork_code_unavailable", `The Cloud thread's code could not be copied to this ${computer}: ${reason || "git fetch failed"}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return {
    environment: { type: "provider", environmentProviderId: DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree, machine: { type: "existing", hostId: hostId! }, inputs: worktreeProviderInputs({ kind: "named", name: branch }) },
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
  const client = await cloudroom(deps).teleportClient(threadId);
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
      try { await exec("git", ["-C", environment.path, "fetch", "-q", file, `refs/heads/${branch}:refs/heads/${branch}`]); }
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

export async function cloudFile(deps: AppDeps, threadId: string, path: string): Promise<Buffer> {
  if (!isAbsolute(path)) throw new ApiError(400, "invalid_path", "Cloud file paths must be absolute.");
  const hostId = resolvePrimaryHostId(deps);
  if (!hostId) throw new ApiError(409, "host_unavailable", "This computer's local host is not ready.");
  const saved = join(await requireThreadStoragePath(deps, { hostId, threadId }), "Cloud files", normalize(path));
  try {
    const data = await download(await cloudroom(deps).threadClient(threadId, !existsSync(saved)), path, PREVIEW_MB);
    await mkdir(dirname(saved), { recursive: true });
    await writeFile(saved, data);
    return data;
  } catch (error) {
    if (existsSync(saved)) return readFile(saved);
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

export async function vm(client: CloudroomClient, command: string): Promise<Buffer> {
  const result = await client.runOnVm({ command, stdin: "" });
  if (result.code !== 0 || result.truncated)
    throw new Error(Buffer.from(result.stderr, "hex").toString().trim() || `Cloud command failed (${result.code})`);
  return Buffer.from(result.stdout, "hex");
}

export function findNative(harness: Harness, nativeId: string): string {
  if (harness === "acp-opencode")
    return `mkdir -p ~/.cache/cloudroom && f=~/.cache/cloudroom/opencode-${nativeId}.json && OPENCODE_DISABLE_AUTOUPDATE=1 opencode export ${nativeId} > "$f" </dev/null && echo "$f"`;
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
  return (await vm(client, `python3 -I -c ${quote(script)} ${quote(path)}`)).toString().split("\n").filter(Boolean);
}

export async function download(client: CloudroomClient, path: string, maxMb = Infinity): Promise<Buffer> {
  const size = Number((await vm(client, `[ -f ${quote(path)} ] && wc -c < ${quote(path)} || echo -1`)).toString().trim());
  if (size < 0) throw new ApiError(404, "cloud_file_missing", `${path} is not a file in the cloud.`);
  if (size > maxMb * 1024 * 1024) throw new ApiError(413, "cloud_file_too_large", `${basename(path)} is over the ${maxMb} MB limit.`);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < size; offset += CHUNK)
    parts.push(await vm(client, `tail -c +${offset + 1} ${quote(path)} | head -c ${CHUNK}`));
  return Buffer.concat(parts);
}

export async function cloudChanges(client: CloudroomClient, workspace: string, localHead: string | null, since: number): Promise<{ archive: Buffer; base: string | null }> {
  const head = localHead?.trim();
  const archive = `.cache/cloudroom/teleport-local-${randomUUID()}.tgz`;
  const skipped = [...SKIPPED, ".cloudroom"].map((name) => `-name ${quote(name)}`).join(" -o ");
  const created = (await vm(client, [
    `cd ${quote(workspace)} || exit 1`,
    "mkdir -p ~/.cache/cloudroom",
    "if git rev-parse --git-dir >/dev/null 2>&1; then",
    "  proven=0; base=$(git reflog --format=%H HEAD 2>/dev/null | tail -n 1); [ -n \"$base\" ] || base=HEAD",
    head && /^[0-9a-f]{40,64}$/.test(head) ? `  git cat-file -e '${head}^{commit}' 2>/dev/null && shared=$(git merge-base HEAD ${head} 2>/dev/null) && { base=$shared; proven=1; }` : "",
    `  { git diff -z --name-only --no-renames --diff-filter=d "$base"; git ls-files -z --others --exclude-standard; } | ${packChangesCommand(`~/${archive}`)} || exit 1`,
    "else",
    `  proven=0; find . \\( ${skipped} \\) -prune -o \\( -type f -o -type l \\) -newermt @${Math.floor(since / 1000) - 600} -print0 | ${packChangesCommand(`~/${archive}`)} || exit 1`,
    "fi",
    `echo "$proven" "$base" ~/${archive}`,
  ].join("\n"))).toString().trim();
  const [proven, base, path] = (created.split("\n").pop() ?? "").split(" ");
  if (!path) throw new Error("The cloud file changes could not be packed. The thread stays in Cloud.");
  try {
    return { archive: await download(client, path), base: proven === "1" && base && /^[0-9a-f]{40,64}$/.test(base) ? base : null };
  } finally {
    await vm(client, `rm -f ${quote(path)}`).catch(() => {});
  }
}

export async function applyChanges(root: string, archive: Buffer, id: string, base: string | null): Promise<number> {
  const real = await realpath(root);
  const aside = join(root, ".cloudroom", "teleport", id);
  if (!(await inside(real, join(aside, "file"))))
    throw new ApiError(409, "teleport_unavailable", "This project's .cloudroom folder points outside the project. The thread stays in Cloud.");
  const folder = await mkdtemp(join(tmpdir(), "cloudroom-teleport-local-"));
  try {
    const file = join(folder, "changes.tgz");
    const staged = join(folder, "files");
    await writeFile(file, archive);
    await mkdir(staged);
    await exec(tarCommand(), ["-xzf", file, "-C", staged]);
    const paths = (await exec(tarCommand(), ["-tzf", file], { maxBuffer: 64 * 1024 * 1024 })).stdout.split(process.platform === "win32" ? /\r?\n/ : "\n")
      .map((path) => path.replace(/^\.\//, "")).filter((path) => path && !path.endsWith("/") && !isAbsolute(path) && !path.split("/").includes("..") && !inGit(path));
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
    let conflicts = 0;
    for (const [index, path] of paths.entries()) {
      const incoming = join(staged, path);
      let target = join(root, path);
      const existing = await lstat(target).catch(() => null);
      if (existing && (await same(incoming, target))) continue;
      const replace = !existing || (dirtyKeys !== null && !dirtyKeys.has(keys[index]!) && !existing.isSymbolicLink());
      if (!replace || !(await inside(real, target))) {
        target = join(aside, path);
        conflicts++;
      }
      await mkdir(dirname(target), { recursive: true });
      await cp(incoming, target, { force: true, verbatimSymlinks: true });
    }
    return conflicts;
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

async function git(cwd: string, args: string[]): Promise<string | null> {
  return exec("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024 }).then((result) => result.stdout, () => null);
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
    const header = JSON.parse(bytes.subarray(0, end).toString("utf8"));
    if (harness === "codex" && header.type === "session_meta") header.payload.cwd = cwd;
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

async function importOpenCode(deps: AppDeps, threadId: string, environment: { id: string; hostId: string; path: string }, nativeId: string, data: Buffer) {
  JSON.parse(data.toString("utf8"));
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

// Local Cursor keeps each chat in ~/.cursor/acp-sessions/<id>/, the folder the host's Teleport capture reads.
async function installCursor(nativeId: string, archive: Buffer, cwd: string) {
  const target = join(homedir(), ".cursor", "acp-sessions", nativeId);
  const staged = `${target}.${randomUUID()}.tmp`;
  await mkdir(staged, { recursive: true, mode: 0o700 });
  try {
    await writeFile(`${staged}.tgz`, archive, { mode: 0o600 });
    await exec(tarCommand(), ["-xzf", `${staged}.tgz`, "-C", staged]);
    const meta = join(staged, "meta.json");
    await writeFile(meta, JSON.stringify({ ...JSON.parse(await readFile(meta, "utf8")), cwd }));
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
