import { COMPUTER, stripGitUrlCredentials } from "@cloudroom/domain";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, realpathSync } from "node:fs";
import { lstat, mkdtemp, open, readdir, readFile, readlink, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createGzip } from "node:zlib";
import { z } from "zod";
import { getProject, getThread, listProjectSourcesByProjectIds, replaceProjectGitRemoteUrl, setProjectGitRemoteUrlIfMissing } from "@cloudroom/db";
import { tarCommand } from "@cloudroom/process-utils";
import type { ProjectCopyProgress } from "@cloudroom/domain";
import type { AppDeps } from "../../types.js";
import { resolvePrimaryHostId } from "../hosts/primary-host.js";
import { CloudroomError, UPLOAD_PART, type CloudroomClient } from "./client.js";
import { macAccessSupported } from "./previews.js";
import { sandboxThread } from "./sandboxes.js";
import { redactSecrets } from "./shares.js";
import { binding, command, saveProjectCopyProgress } from "./store.js";
import { copyMacGithub } from "./sync.js";

type Deps = Pick<AppDeps, "db" | "hub" | "config">;
// `key` is the copy target: one folder on a shared VM, or one per thread sandbox.
// New threads get a clone of the chosen branch (default branch if none) and `.env` files, or all files of a small project not on GitHub.
// A GitHub project with no folder on the Mac (`localPath` null) is cloned only.
// Teleport also brings the local branch and uncommitted work.
/** `noEnv`: the thread's sandbox may not have the project's `.env` files (ADR 0342), so none are sent. `resumed`: a copy
 *  that goes on after a pause or an app restart, while the agent may already be working, so a move's edits go aside (#1970).
 *  `forkCode`: a fork's or child's code replaces folder files after this copy, so its agent must wait for it (no heartbeat). */
export type ProjectCopyJob = { threadId: string; workspace: string; key: string; localPath: string | null; repository: string | null; clone: boolean; copyAll: boolean; teleport: boolean; branch?: string; noEnv?: boolean; resumed?: boolean; forkCode?: boolean };

const exec = promisify(execFile);
// A stalled piece counts as dropped, so the retry sends it again.
export const PIECE_TIMEOUT = 120_000;
const PACK_TIMEOUT = 5 * 60_000;
const CLONE_TIMEOUT = 15 * 60_000;
const MAX_FILE = 50 * 1024 * 1024;
const MAX_TOTAL = 1024 * 1024 * 1024;
// About 10-20 seconds on a home connection.
const SMALL_PROJECT = 50 * 1024 * 1024;
export const SKIPPED = new Set(["node_modules", ".git", ".venv", "venv", ".next", ".turbo", ".cache", "__pycache__", "target", "dist", "build", ".DS_Store"]);
// Running copies, by copy key, with their thread.
const copying = new Map<string, string>();
export const FAILURE_NOTE = ".cloudroom/project-copy-failed.txt";
// Next to the folder: `room-cli files wait` let the agent go ahead, so it may be working in it. The app never removes it (#1970).
const GAVE_UP = ".cloudroom-files-gave-up";
// Next to the folder: touched with `copying`, then each minute while this app copies into it, so `room-cli files wait` stops
// waiting once this computer goes offline, sleeps, or quits, after 4 silent minutes (#2168). Older apps write none.
const ALIVE = ".cloudroom-files-alive";
const BEAT = 60_000;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** The Core workspace and folder a project's Cloud threads use. */
export const workspaceId = (projectId: string) => `bb_${projectId}`;
export const workspaceName = (name: string) => name.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^\.+/, "").slice(0, 80) || "project";

export function githubRepository(remote: string | null): string | null {
  const repository = remote?.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)\/?$/)?.[1];
  return repository ? `https://github.com/${repository}` : null;
}

export function localProjectPath(deps: Deps, projectId: string): string | undefined {
  const sources = listProjectSourcesByProjectIds(deps.db, [projectId]).filter((source) => existsSync(source.path));
  return (sources.find((source) => source.isDefault) ?? sources[0])?.path;
}

/** Compares remotes across https and ssh forms, case, a trailing slash and `.git`. */
export function remoteKey(remote: unknown): string | null {
  if (typeof remote !== "string") return null;
  return remote.trim().toLowerCase().replace(/^[a-z+]+:\/\//, "").replace(/^[^@/]+@/, "").replace(/^([^/:]+):/, "$1/").replace(/\/+$/, "").replace(/\.git$/, "") || null;
}

/** A project added before it had a GitHub remote picks the remote up here, at its next cloud thread. A folder on this
 *  computer added while it was inside another repo saved that repo's remote: once the folder is a checkout of its own,
 *  its own origin is saved instead, so the copy, template, loops and sync agree (#1850). */
export async function projectRemote(deps: Deps, project: { id: string; gitRemoteUrl: string | null }, path: string | null | undefined): Promise<string | null> {
  if (!path) return project.gitRemoteUrl;
  const saved = project.gitRemoteUrl;
  if (saved !== null) {
    // Another computer's folder path can exist here too, as an unrelated checkout.
    const host = resolvePrimaryHostId(deps);
    const own = listProjectSourcesByProjectIds(deps.db, [project.id]).some((source) => source.hostId === host && source.path === path);
    const real = own ? (() => { try { return realpathSync(path); } catch { return null; } })() : null;
    if (!real || (await git(real, ["rev-parse", "--show-prefix"], 5_000))?.trim() !== "" || remoteKey(await git(dirname(real), ["remote", "get-url", "origin"], 5_000)) !== remoteKey(saved)) return saved;
    // A folder whose own repo has no origin keeps main's behavior for now.
    const remote = stripGitUrlCredentials((await git(real, ["remote", "get-url", "origin"], 5_000))?.trim() ?? "") || null;
    if (!remote || remoteKey(remote) === remoteKey(saved)) return saved;
    // A remote saved meanwhile wins.
    return replaceProjectGitRemoteUrl(deps.db, deps.hub, project.id, saved, remote) ? remote : getProject(deps.db, project.id)?.gitRemoteUrl ?? null;
  }
  const remote = stripGitUrlCredentials((await git(path, ["remote", "get-url", "origin"]))?.trim() ?? "") || null;
  if (remote) setProjectGitRemoteUrlIfMissing(deps.db, deps.hub, project.id, remote);
  return remote;
}

/** Fixes a stale saved remote before a project's sandbox is warmed, so its template clones the right repo (#1850). */
export async function refreshProjectRemote(deps: Deps, projectId: string): Promise<void> {
  const project = getProject(deps.db, projectId);
  const path = project?.gitRemoteUrl ? localProjectPath(deps, project.id) : undefined;
  if (project && path) await projectRemote(deps, project, path);
}

/** Small projects not on GitHub are uploaded whole. Counting stops at the limit, so a huge folder answers fast. */
async function smallProject(root: string): Promise<boolean> {
  return localFiles(root, "all", SMALL_PROJECT).then(() => true, () => false);
}

/** Tells a new cloud thread where a large project without GitHub lives, since its files stay on the Mac. */
export async function localProjectNote(deps: Deps, projectId: string): Promise<string | undefined> {
  const project = getProject(deps.db, projectId);
  const path = project ? localProjectPath(deps, project.id) : undefined;
  if (!project || !path) return undefined;
  const remote = await projectRemote(deps, project, path);
  if (githubRepository(remote) || (await smallProject(path))) return undefined;
  // A project with another remote (GitLab, Azure) keeps it, so pushing to GitHub wouldn't help; Teleport uploads it.
  const rest = macAccessSupported
    ? `The rest is on the user's ${COMPUTER} at \`${path}\`. Pull only what the task needs with \`room-cli mac pull\`.`
    : remote
      ? "Cloud agents can't reach the user's Windows computer, so ask the user to start the thread Local and Teleport it to Cloud, which uploads the project."
      : "Cloud agents can't reach the user's Windows computer, so ask the user to push the project to GitHub, then start a new thread.";
  return `This project is not on GitHub and too large to copy, so only its \`.env\` files are here. ${rest}`;
}

/** What the agent does when a failed copy left the project on the user's computer. Cloud agents can't reach Windows (ADR 0294). */
export const localFilesNote = (path: string) =>
  macAccessSupported
    ? `The full project is on the user's ${COMPUTER} at \`${path}\`. Pull only what the task needs with \`room-cli mac pull\`.`
    : "Cloud agents can't reach the user's Windows computer. Tell the user what failed: pass on any fix the message names, otherwise ask them to start a new thread.";

/** A project copy's target: one folder per thread sandbox, or one shared folder on a VM. */
export const copyKey = (sandbox: string | null, workspace: string) => sandbox ? `${sandbox}:${workspace}` : workspace;
const BUSY = "Another copy is filling this project folder.";

/** A plan that fails reads as nothing to copy, except a move's: Teleport then retries or shows the error instead of
 *  arriving without its code (#2120). A copy already filling the same folder brings the code. */
export function planProjectCopy(...args: Parameters<typeof planProjectCopyOrThrow>): Promise<ProjectCopyJob | null> {
  return planProjectCopyOrThrow(...args).catch((error: unknown) => {
    if (args[4]?.teleport && !(error instanceof Error && error.message === BUSY)) throw error;
    return null;
  });
}

/** A new thread's copy (#337): a request its just-claimed sandbox drops is tried once more a second later, and an error
 *  that remains throws, so the thread is told instead of starting with an empty folder. Its sandbox gets 10 seconds in
 *  all, so the first message never waits long (ADR 0160); the caller plans again later (#1040). Each try gets its own
 *  deadline, so the second never starts already timed out. A folder another copy fills needs nothing more. */
export function planNewProjectCopy(deps: Deps, client: CloudroomClient, threadId: string, workspace: string, options: { key: string; branch?: string }): Promise<ProjectCopyJob | null> {
  const end = Date.now() + 10_000;
  const plan = (ms: number) => planProjectCopyOrThrow(deps, client, threadId, workspace, { ...options, signal: AbortSignal.timeout(ms) });
  return plan(6_000)
    .catch(async (error: unknown) => {
      await new Promise(resolve => setTimeout(resolve, 1_000));
      if (end - Date.now() < 3_000) throw error;
      return plan(end - Date.now());
    })
    .catch((error: unknown) => {
      if (copying.has(options.key)) return null;
      throw error;
    });
}

/** Like planProjectCopy, but a sandbox that can't be reached, or a folder another copy is filling, throws instead of
 *  reading as nothing left to copy. `resumed`: a move's copy an app restart cut off, which goes on in a folder that already
 *  has files too, but only while its status still reads `copying`: older apps wrote none for a move. Its clone isn't
 *  repeated once it landed (#1970). The key defaults to the thread's own sandbox, so moves into separate sandboxes of
 *  one project never skip each other (#2120). */
export async function planProjectCopyOrThrow(deps: Deps, client: CloudroomClient, threadId: string, workspace: string, { localPath, key = copyKey(sandboxThread(binding(deps.db, threadId)?.coreUrl ?? ""), workspace), teleport = false, resumed = false, branch, signal }: { localPath?: string; key?: string; teleport?: boolean; resumed?: boolean; branch?: string; signal?: AbortSignal } = {}): Promise<ProjectCopyJob | null> {
  const project = getProject(deps.db, getThread(deps.db, threadId)?.projectId ?? "");
  if (!project) return null;
  if (copying.has(key)) throw new Error(BUSY);
  const path = localPath ?? localProjectPath(deps, project.id) ?? null;
  const repository = githubRepository(await projectRemote(deps, project, path));
  if (!path && !repository) return null;
  const existing = await client.workspace(workspace, signal);
  // Exit 1 means files are there; any other end of the check (a signal, a missing shell) says nothing about the folder.
  const check = existing && (await client.runOnVm({ command: `[ -z "$(ls -A -- ${quote(existing.path)} 2>/dev/null | grep -Fvx .cloudroom)" ]`, stdin: "" }, signal)).code;
  if (existing && check !== 0 && check !== 1) throw new CloudroomError(`Could not check the cloud project folder (exit code ${check}).`);
  const empty = !existing || check === 0;
  if (!empty && teleport && !resumed) return null;
  if (resumed) {
    const status = existing ? (await client.runOnVm({ command: `[ "$(cat -- ${quote(`${existing.path}.cloudroom-files`)} 2>/dev/null)" = copying ]`, stdin: "" }, signal)).code : 1;
    if (status !== 0 && status !== 1) throw new CloudroomError(`Could not check the cloud project copy (exit code ${status}).`);
    if (status === 1) return null;
  }
  const clone = (empty || resumed) && Boolean(repository);
  // A home folder is never uploaded whole, since it holds other projects and logins (#1120).
  const copyAll = empty && !repository && !teleport && path !== null && !envRefusal(path, repository) && await smallProject(path);
  // A Cloud loop's run that didn't pick `.env` files passes none to its children and forks (keyFields in commands.ts).
  const noEnv = z.object({ no_env: z.boolean().optional() }).safeParse(JSON.parse(command(deps.db, `first_${threadId}`)?.input ?? "{}")).data?.no_env === true;
  const job = { threadId, workspace, key, localPath: path, repository, clone, copyAll, teleport, ...(branch ? { branch } : {}), ...(noEnv ? { noEnv } : {}), ...(resumed ? { resumed } : {}) };
  // A Mac folder that can't be read has no `.env` files to send, so it reads as nothing left, never as a reason to wait.
  return clone || copyAll || teleport || (path !== null && !noEnv && (await localFiles(path, "env").catch(() => [])).length) ? job : null;
}

/** Whether a copy fills this folder (copy key) in this app. */
export const keyCopying = (key: string) => copying.has(key);

/** Whether a copy for this thread runs in this app: an app restart ends every copy, but leaves its saved progress. */
export const copyRunning = (threadId: string) => [...copying.values()].includes(threadId);

/** Saves a thread's project copy progress and refreshes its views. A thread deleted mid-copy has no row left to save to. */
export function reportProjectCopy(deps: Deps, threadId: string, progress: ProjectCopyProgress): void {
  const thread = getThread(deps.db, threadId);
  if (!thread) return;
  saveProjectCopyProgress(deps.db, threadId, progress);
  deps.hub.notifyThread(threadId, ["status-changed"]);
  if (thread.projectId) deps.hub.notifyProject(thread.projectId, ["threads-changed"]);
}

/** The copy shows as started at once, but its transfer waits for `after`, so it can't crowd out the first message on a slow connection.
 *  With `paused`, a copy cut off by a sleeping or unreachable sandbox waits instead of failing; the caller restarts it.
 *  `partial` says why the files are incomplete; the agent is told, not the user. */
export function copyProject(deps: Deps, client: CloudroomClient, job: ProjectCopyJob, done?: (error?: string, partial?: string) => void | Promise<void>, after: Promise<void> = Promise.resolve(), paused?: () => void): void {
  if (copying.has(job.key)) return;
  copying.set(job.key, job.threadId);
  // From the start, so a slow first message never reads as an offline computer.
  const beat = (job.clone || job.copyAll || job.teleport) && !job.forkCode ? heartbeat(client, job.workspace) : undefined;
  const report = (progress: ProjectCopyProgress) => {
    if (!job.clone && !job.copyAll && !job.teleport && progress.phase !== "error") return;
    reportProjectCopy(deps, job.threadId, progress);
  };
  report({ phase: job.clone ? "cloning" : "uploading", completed: 0, total: 0 });
  // Complete only once the caller landed it (its branch, a fork's code, `room-cli files wait`), so an app restart
  // before then still resumes it (#106). A landing that fails is not a copy error.
  const land = (error?: string, partial?: string) => Promise.resolve().then(() => done?.(error, partial)).catch(() => {});
  void after.then(() => run(deps, client, job, report))
    .then(async (partial) => {
      if (partial) await writeFailureNote(client, job, partial).catch(() => {});
      await land(undefined, partial);
      report({ phase: "complete", completed: 0, total: 0 });
    }, async (error: unknown) => {
      if (paused && error instanceof CloudroomError && error.retryable) {
        report({ phase: "waiting", completed: 0, total: 0 });
        paused();
        return;
      }
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      // The files are still on the Mac, so only the agent is told and pulls what it needs. The error card stays for
      // Teleport, whose uncommitted work must arrive, and for projects with no folder on the Mac.
      const quiet = job.localPath !== null && !job.teleport;
      if (!quiet) report({ phase: "error", completed: 0, total: 0, error: message });
      await writeFailureNote(client, job, message).catch(() => {});
      await (quiet ? land(undefined, message) : land(message));
      if (quiet) report({ phase: "complete", completed: 0, total: 0 });
    })
    .catch(() => {})
    .finally(() => { clearInterval(beat); copying.delete(job.key); });
}

/** Touches the copy's heartbeat now and each minute until stopped. A touch that fails waits for the next. A Core that
 *  can't take it (404 from an older one, 409 when the touch fails) is asked no more, so it logs no error each minute. */
function heartbeat(client: CloudroomClient, workspace: string): NodeJS.Timeout {
  const touch = async () => client.alive(workspace, AbortSignal.timeout(BEAT));
  const timer = setInterval(() => void touch().catch(stop), BEAT).unref();
  const stop = (error: unknown) => { if (error instanceof CloudroomError && (error.status === 404 || error.status === 409)) clearInterval(timer); };
  void touch().catch(stop);
  return timer;
}

async function run(deps: Deps, client: CloudroomClient, job: ProjectCopyJob, report: (progress: ProjectCopyProgress) => void): Promise<string | undefined> {
  const target = (await client.workspace(job.workspace))?.path;
  if (!target) throw new Error("The cloud project folder is unavailable.");
  // A retry clears the last failure's note, so the agent doesn't stop waiting for files that are on their way.
  await vm(client, `rm -f -- ${quote(`${target}/${FAILURE_NOTE}`)}`);
  // A failed Teleport clone falls back to uploading the files, so the agent can still work, then reports why Git is missing.
  let cloneError: string | null = null;
  if (job.clone && job.repository) {
    const branch = job.teleport && job.localPath ? (await git(job.localPath, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim() : job.branch;
    cloneError = await clone(deps, client, target, job.repository, branch);
    // A short pause first, since an immediate retry often hits the same GitHub timeout (#555).
    if (cloneError) cloneError = await new Promise((resolve) => setTimeout(resolve, 10_000)).then(() => clone(deps, client, target, job.repository!, branch));
  }
  const cloned = job.clone && !cloneError;
  // Git for Windows checks text files out with CRLF, so the cloud checkout must ignore line-ending-only changes.
  if (cloned && job.teleport && job.localPath && process.platform === "win32" && await checksOutCrlf(job.localPath))
    await vm(client, `git -C ${quote(target)} config core.autocrlf input`);
  if (!cloned) report({ phase: "uploading", completed: 0, total: 0 });
  // A failed clone of a small project falls back to uploading it, like a project not on GitHub.
  const scope = job.teleport ? (job.localPath && homeFolder(job.localPath) ? "env" : cloned ? "changed" : "all") : job.copyAll || (cloneError && job.localPath && !envRefusal(job.localPath, job.repository) && await smallProject(job.localPath)) ? "all" : "env";
  let partial: string | undefined, late: string | undefined;
  if (job.localPath) {
    const folder = await mkdtemp(join(tmpdir(), "cloudroom-copy-"));
    const archive = join(folder, "project.tgz");
    try {
      const packed = await packProject(job.localPath, scope, archive, job.noEnv, job.repository);
      partial = packed.partial;
      // Uncommitted edits replace checkout files only in a move's first, uninterrupted copy (#1970).
      const edits = scope === "changed" && packed.files.length ? {
        aside: `.cloudroom/local-edits/${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}`,
        env: packed.files.filter(isEnv),
        apply: !job.resumed,
      } : undefined;
      if (packed.files.length && !(await send(client, archive, target, report, edits)) && edits)
        late = `The uncommitted edits and \`.env\` files from the ${COMPUTER} arrived after you may have started working here${job.resumed ? " (the copy was cut off and resumed)" : ""}, so they replaced no file: they are in \`${edits.aside}\`, and only \`.env\` files missing here were added. Compare them with the checkout and apply what still fits.${partial ? ` ${partial}` : ""}`;
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }
  if (cloneError) throw new Error(`The GitHub clone failed${scope === "all" && !partial ? ", so your files were copied without Git history" : ""}. ${cloneError}`);
  if (late) throw new Error(late);
  return partial;
}

/** Tells the agent why its project folder is empty or incomplete, since it otherwise waits for files that never come. */
async function writeFailureNote(client: CloudroomClient, job: ProjectCopyJob, message: string): Promise<void> {
  const target = (await client.workspace(job.workspace))?.path;
  if (!target) return;
  const next = job.localPath
    ? localFilesNote(job.localPath)
    : "Tell the user, since the files are not available anywhere else.";
  const note = `Cloudroom could not copy this project into the cloud, so do not wait for more files.\n\n${message}\n\n${next}\n`;
  await vm(client, `mkdir -p -- ${quote(`${target}/.cloudroom`)} && cat > ${quote(`${target}/${FAILURE_NOTE}`)}`, Buffer.from(note));
}

/** What `room-cli files wait` reads (ADR 0209): `copying`, then `ready` or `failed: REASON`, in a file next to the
 *  project folder (a workspace ID, or a path), so Git never sees it. With `onlyIfCopying`, it changes only a copy still
 *  marked `copying`. Next to the sandbox root (`/code`), only root can write, so it falls back to sudo. With `alive`, a
 *  heartbeating copy follows, so its silence counts from this write, even if no later beat lands (#2168). */
export async function writeFilesState(client: CloudroomClient, workspace: string, state: string, onlyIfCopying = false, alive = false): Promise<void> {
  await retry(async () => {
    const target = workspace.startsWith("/") ? workspace : (await client.workspace(workspace))?.path;
    if (!target) return;
    const file = `${target}.cloudroom-files`;
    const write = `state=$(cat) && { printf %s "$state" 2>/dev/null > ${quote(`${file}.tmp`)} && mv -f -- ${quote(`${file}.tmp`)} ${quote(file)} || printf %s "$state" | sudo -n tee ${quote(file)} >/dev/null; }`;
    const beat = alive ? ` && { touch -- ${quote(`${target}${ALIVE}`)} 2>/dev/null || true; }` : "";
    await vm(client, onlyIfCopying ? `if [ "$(cat -- ${quote(file)} 2>/dev/null)" = copying ]; then ${write}; fi` : `${write}${beat}`, Buffer.from(state));
  });
}

async function vm(client: CloudroomClient, command: string, bytes?: Buffer<ArrayBuffer>, raw = false): Promise<void> {
  const signal = bytes && AbortSignal.timeout(PIECE_TIMEOUT);
  const result = raw ? await client.runOnVm({ command }, signal, bytes) : await client.runOnVm({ command, stdin: bytes?.toString("hex") ?? "" }, signal);
  if (result.code !== 0) throw new Error(Buffer.from(result.stderr, "hex").toString().trim() || `Cloud command failed (${result.code})`);
}

/** Retries dropped connections and busy clouds for about 90 seconds, so a network blip doesn't end the copy. */
export async function retry<T>(attempt: () => Promise<T>): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await attempt();
    } catch (error) {
      if (tries === 7 || !(error instanceof CloudroomError && error.retryable)) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(2_000 * 2 ** (tries - 1), 30_000)));
    }
  }
}

async function git(cwd: string, args: string[], timeout = 0): Promise<string | null> {
  return await exec("git", ["-C", cwd, ...args], { maxBuffer: 256 * 1024 * 1024, windowsHide: true, timeout }).then((result) => result.stdout, () => null);
}

/** Returns null once the clone is in place, or why it failed. gc.auto=0: auto-packing during `git log -S` in a blobless
 * clone fills the sandbox disk with deleted packs the search still holds open. */
async function clone(deps: Deps, client: CloudroomClient, target: string, repository: string, branch?: string): Promise<string | null> {
  const token = (await copyMacGithub(deps))
    ? await exec("gh", ["auth", "token", "--hostname", "github.com"], {
        timeout: 15_000,
        windowsHide: true,
      }).then(
        (result) => result.stdout.trim(),
        () => "",
      )
    : "";
  const temporary = quote(`${target}.cloudroom-clone`);
  // Holds the clone's shell PID while it runs, so an answer the connection lost can be checked against what really happened.
  // A clone a dropped request left running (#1970) ends before this one replaces its folder.
  const running = quote(`${target}.cloudroom-clone.pid`);
  const deadline = Date.now() + CLONE_TIMEOUT;
  const result = await client.runOnVm({
    command: [
      // Never on itself: after a cold restart, a stale PID can be this shell's own.
      `p=${running}; while q=$(cat -- "$p" 2>/dev/null) && [ "$q" != $$ ] && grep -qs cloudroom-clone "/proc/$q/cmdline"; do sleep 2; done`,
      // A clone that already landed (a resumed copy) is not repeated.
      `[ -e ${quote(`${target}/.git`)} ] && [ ! -e ${temporary} ] && exit 0`,
      `echo $$ > "$p"; trap 'rm -f -- "$p"' EXIT`,
      "export GIT_TERMINAL_PROMPT=0",
      // `gh auth status` asks GitHub's API, so a used-up quota reads as a bad token (#1182). Log in only when gh has no token.
      token ? "{ gh auth token --hostname github.com || gh auth login --hostname github.com --with-token; gh auth setup-git --hostname github.com; } >/dev/null 2>&1 || true" : "",
      `rm -rf -- ${temporary}`,
      `git clone --quiet --filter=blob:none -c gc.auto=0 -- ${quote(repository)} ${temporary} || { printf '\\035'; timeout 10 gh api user --jq .login 2>/dev/null; exit 1; }`,
      branch && branch !== "HEAD" ? `git -C ${temporary} checkout --quiet ${quote(branch)} 2>/dev/null || true` : "",
      // Merged, never skipping a folder or replacing a file: Teleport may have put a file the chat mentioned (`src/new.ts`) in
      // the folder already, and it wins over the clone's copy. Hard links are fast; a plain copy covers another disk.
      `mkdir -p -- ${quote(target)} && { cp -a -l -n -- ${temporary}/. ${quote(target)}/ 2>/dev/null || cp -a -n -- ${temporary}/. ${quote(target)}/; } || true`,
      `rm -rf -- ${temporary}`,
      `test -e ${quote(`${target}/.git`)} || { echo 'The clone did not reach the project folder.' >&2; exit 1; }`,
    ].join("\n"),
    stdin: Buffer.from(token).toString("hex"),
    keep: true,
  }, AbortSignal.timeout(CLONE_TIMEOUT)).catch((error: unknown) => {
    if (error instanceof CloudroomError && error.retryable) return error;
    throw error;
  });
  // A proxy's 504 or 524 or a dropped connection loses the answer, not the clone: Core keeps it running (`keep`, #1970) and it
  // can land later (#1524). So wait for its shell to end: a clone that landed is done, and only one that didn't fails as
  // before, so no copy competes with it. Older Cores end the clone with its request, so it is found dead.
  // Each check waits up to 44 s in the sandbox, under a proxy's timeout, since Core saves every VM command as a diagnostic row.
  if (result instanceof CloudroomError) {
    const check = `for _ in $(seq 22); do kill -0 "$(cat -- ${running} 2>/dev/null)" 2>/dev/null || { [ ! -e ${temporary} ] && [ -e ${quote(`${target}/.git`)} ]; exit; }; sleep 2; done; exit 3`;
    for (;;) {
      const { code } = await retry(() => client.runOnVm({ command: check, stdin: "" }));
      if (code === 0) return null;
      if (code !== 3) throw result;
      if (Date.now() >= deadline) throw new Error(`The GitHub clone did not finish in ${CLONE_TIMEOUT / 60_000} minutes.`);
    }
  }
  if (result.code === 0) return null;
  // Redacted before the cut, since the message reaches the failure note, the copy status, and `room-cli files wait` (#1847).
  const error = redactSecrets(Buffer.from(result.stderr, "hex").toString(), [token]).trim().slice(-300) || `git clone exited with code ${result.code}`;
  const stdout = Buffer.from(result.stdout, "hex");
  const mark = stdout.indexOf(0x1d);
  const login = mark < 0 ? "" : stdout.subarray(mark + 1).toString().trim();
  return `${cloneHint(error, /^[A-Za-z0-9-]{1,39}$/.test(login) ? login : "")} Git said: ${error}`;
}

function cloneHint(error: string, login: string): string {
  const fix = "in Settings → Cloud environment → GitHub, then start a new thread";
  // A dropped or slow connection, not access (#555).
  if (/HTTP (408|429|5\d\d)|RPC failed|expected 'packfile'|early EOF|promisor remote|Could not resolve host|timed out|Connection reset/i.test(error)) return "GitHub timed out or dropped the connection. That is usually temporary, not an access problem.";
  if (/could not read Username/i.test(error)) return `Cloud sandboxes have no working GitHub login, so they can only clone public repositories. Connect or switch the account ${fix}.`;
  if (/Authentication failed|Invalid username or token/i.test(error)) return `GitHub rejected the cloud's GitHub login, which may have expired. Connect or switch the account ${fix}.`;
  if (!/repository .*not found/i.test(error)) return "Check that the project's GitHub remote exists and you can access it.";
  return login
    ? `Cloud sandboxes use GitHub account @${login}, which can't see this repository, or it doesn't exist. Give @${login} access, or use Switch account ${fix}.`
    : `The cloud's GitHub login can't see this repository, or it doesn't exist. Check the account ${fix}.`;
}

/** Whether this checkout writes CRLF line endings: core.autocrlf is true in any of Git's spellings (yes, on, 1). `input` writes LF. */
export async function checksOutCrlf(path: string): Promise<boolean> {
  return (await git(path, ["config", "--bool", "--get", "core.autocrlf"]))?.trim() === "true";
}

const isEnv = (path: string) => basename(path).startsWith(".env");

function resolvedPath(path: string): string {
  try { return realpathSync(path); }
  // A folder on another host may not exist here; still check its written path.
  catch { return resolve(path); }
}

/** Whether a folder is a home folder or holds one: this computer's, or any `/home/<name>` or `/Users/<name>`, such as a
 *  WSL home seen from Windows (#1120). */
export function homeFolder(root: string): boolean {
  const folder = resolvedPath(root), above = relative(folder, resolvedPath(homedir()));
  return (!isAbsolute(above) && above.split(sep)[0] !== "..") || [resolve(root), folder].some(path => {
    const [top, , deeper] = relative(parse(path).root, path).split(sep);
    return !deeper && (!top || /^(home|users)$/i.test(top));
  });
}

/** Why a project folder's `.env` files are other projects' secrets, so none may leave this computer (#1120): the folder is
 *  a home folder or holds one, or a GitHub project's folder is no Git checkout below home. #140's rule still covers a
 *  workspace folder picked on purpose. */
export function envRefusal(root: string, repository: string | null): string | undefined {
  if (homeFolder(root))
    return `The \`.env\` files were not copied, because the project's folder \`${root}\` is a home folder or holds one, so they include other projects' secrets. Set the project's folder to the project itself to copy them.`;
  const home = resolvedPath(homedir());
  const checkout = (path: string): boolean => path !== home && (existsSync(join(path, ".git")) || (dirname(path) !== path && checkout(dirname(path))));
  if (repository && !checkout(resolvedPath(root)))
    return `The \`.env\` files were not copied, because the project's folder \`${root}\` is not a Git checkout of ${repository}, so they may belong to other projects. Set the project's folder to its checkout to copy them.`;
}

/** `all`: every project file; `changed`: uncommitted and untracked files; `env`: only `.env` files. Ignored `.env` files always count.
 *  `env` leaves out ones the last commit has and Git still tracks, even edited: the clone brings them, and edits stay here (#1405).
 *  Throws once the files pass `limit` bytes. */
export async function localFiles(root: string, scope: "all" | "changed" | "env", limit = MAX_TOTAL): Promise<string[]> {
  const listed = await git(root, ["ls-files", "-z", scope === "all" ? "--cached" : "--modified", "--others", "--exclude-standard"]);
  // `--modified` skips staged edits and staged new files, so add what the index changed since the last commit.
  const staged = listed === null || scope === "all" ? "" : await git(root, ["diff", "-z", "--name-only", "--cached"]) ?? "";
  const ignored = listed === null ? "" : await git(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]) ?? "";
  // A repo root keeps ignored `.env` files at any depth, since monorepo apps need theirs. Any other folder (a workspace, or a
  // folder inside a checkout) keeps them only at its root and nested repo roots, so it doesn't send every secret under it (#140).
  const repoRoot = listed !== null && (await git(root, ["rev-parse", "--show-prefix"]))?.trim() === "";
  const envAt = (path: string) => repoRoot || dirname(path) === "." || existsSync(join(root, dirname(path), ".git"));
  const env = ignored.split("\0").filter((path) => path && !path.endsWith("/") && isEnv(path) && envAt(path));
  // Unignored `.env` files follow the same rule, unless Git tracks them (a committed `.env.example` is project code).
  const tracked = (repoRoot && scope !== "env") || listed === null ? null : new Set((await git(root, ["ls-files", "-z", "--cached"]) ?? "").split("\0"));
  const committed = scope !== "env" || listed === null ? null : new Set((await git(root, ["ls-tree", "-r", "-z", "--name-only", "HEAD"]) ?? "").split("\0"));
  const found = listed === null ? walk(root, "") : [...new Set([...listed.split("\0"), ...staged.split("\0"), ...env].filter(Boolean))];
  const files: string[] = [];
  let total = 0;
  for await (const path of found) {
    if (scope === "env" && !isEnv(path)) continue;
    if (isEnv(path) && !envAt(path) && !tracked?.has(path)) continue;
    if (committed?.has(path) && tracked?.has(path)) continue;
    const info = await lstat(join(root, path)).catch(() => null);
    if (!info || !(info.isFile() || info.isSymbolicLink()) || info.size > MAX_FILE) continue;
    total += info.size;
    if (total > limit) throw new Error("This project is over 1 GB without ignored and large files.");
    files.push(path);
  }
  return files;
}

// A generator, so a size check can stop early in a huge folder. An unreadable subfolder is skipped, not fatal.
async function* walk(root: string, folder: string): AsyncGenerator<string> {
  const entries = await readdir(join(root, folder), { withFileTypes: true }).catch((error: unknown) => { if (!folder) throw error; return []; });
  for (const entry of entries) {
    if (SKIPPED.has(entry.name)) continue;
    const path = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walk(root, path);
    else yield path;
  }
}

/** Lists and packs the files on the Mac. A full copy that fails here for any reason (too large, cloud-only Dropbox or
 *  iCloud files, unreadable files) packs only the `.env` files instead and says why. Clones and uncommitted edits never fall back. */
async function packProject(root: string, scope: "all" | "changed" | "env", archive: string, noEnv = false, repository: string | null = null): Promise<{ files: string[]; partial?: string }> {
  // `.env` files other projects own stay here, and the agent is told why (#1120).
  const refused = noEnv ? undefined : envRefusal(root, repository);
  try {
    const listed = await localFiles(root, scope);
    const files = listed.filter(path => !(noEnv || refused) || !isEnv(path));
    if (files.length) await pack(root, files, archive);
    return { files, ...(refused && files.length < listed.length ? { partial: refused } : {}) };
  } catch (error) {
    if (scope !== "all" || noEnv || refused) throw error;
    const files = await localFiles(root, "env").catch(() => { throw error; });
    if (files.length) await pack(root, files, archive).catch(() => { throw error; });
    const reason = error instanceof Error ? error.message : String(error);
    return { files, partial: `Only the \`.env\` files were copied, because the ${COMPUTER} could not pack the rest: ${reason}`.slice(0, 500) };
  }
}

export async function pack(root: string, files: string[], archive: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "win32") return packInNode(root, files, archive);
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    const tar = spawn(tarCommand(), ["--no-xattrs", "-czf", archive, "--null", "-T", "-"], { cwd: root, env: { ...process.env, COPYFILE_DISABLE: "1" }, stdio: ["pipe", "ignore", "pipe"], timeout: PACK_TIMEOUT, windowsHide: true });
    tar.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-300); });
    tar.on("error", reject).on("close", (code) => code === 0 ? resolve() : reject(new Error(`Could not pack the project files${tar.killed ? ` within ${PACK_TIMEOUT / 60_000} minutes` : ""}. ${stderr.trim()}`.trim())));
    tar.stdin.end(files.map((path) => `${path}\0`).join(""));
  });
}

/** Windows' tar.exe reads the file list in the ANSI code page, so it can't find a UTF-8 name like `Financiën.md` and the
 *  full copy fails (#2224). There, Node writes the archive, with each name in a PAX header. */
async function packInNode(root: string, files: string[], archive: string): Promise<void> {
  const pad = (size: number) => Buffer.alloc(-size & 511);
  async function* blocks() {
    for (const path of files) {
      const info = await lstat(join(root, path));
      const link = info.isSymbolicLink() ? (await readlink(join(root, path))).replaceAll("\\", "/") : "";
      const body = link ? Buffer.alloc(0) : await readFile(join(root, path));
      const pax = Buffer.from(paxRecord("path", path) + (link ? paxRecord("linkpath", link) : ""));
      yield Buffer.concat([tarHeader("PaxHeader", "x", pax.length, 0o644, 0), pax, pad(pax.length)]);
      yield tarHeader(path, link ? "2" : "0", body.length, info.mode & 0o777, Math.max(0, Math.floor(info.mtimeMs / 1000)));
      yield body;
      yield pad(body.length);
    }
    yield Buffer.alloc(1024);
  }
  const signal = AbortSignal.timeout(PACK_TIMEOUT);
  await pipeline(Readable.from(blocks()), createGzip(), createWriteStream(archive), { signal }).catch((error: unknown) => {
    throw new Error(`Could not pack the project files${signal.aborted ? ` within ${PACK_TIMEOUT / 60_000} minutes` : ""}. ${error instanceof Error ? error.message : String(error)}`);
  });
}

/** A PAX record starts with its own length, digits included. */
function paxRecord(key: string, value: string): string {
  const size = Buffer.byteLength(` ${key}=${value}\n`), length = size + String(size).length;
  return `${length + (String(length).length > String(size).length ? 1 : 0)} ${key}=${value}\n`;
}

/** A ustar header, like the VPS app's (docker.ts). The PAX header before it holds the real name. */
function tarHeader(name: string, type: string, size: number, mode: number, mtime: number): Buffer {
  const header = Buffer.alloc(512);
  const field = (value: string, offset: number, length: number) => header.write(value, offset, length, "latin1");
  const octal = (value: number, offset: number, length: number) => field(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);
  field(name, 0, 100);
  octal(mode, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(mtime, 136, 12);
  field("        ", 148, 8);
  field(type, 156, 1);
  field("ustar\u000000", 257, 8);
  octal(header.reduce((sum, byte) => sum + byte, 0), 148, 7);
  return header;
}

/** Unpacks the archive into the project folder, never replacing a file. With `edits` (Teleport's uncommitted edits), it
 *  replaces checkout files, but only with `apply` and while `room-cli files wait` hasn't let the agent start: the status
 *  still reads `copying` and no go-ahead is marked, under the folder's lock Core takes to mark one (older Cores mark
 *  none). Otherwise the agent may be working, as a lost answer or a resumed copy can land hours later, so the archive
 *  goes to `edits.aside` and only missing `.env` files are added; then it returns false (#1970). */
async function send(client: CloudroomClient, archive: string, target: string, report: (progress: ProjectCopyProgress) => void, edits?: { aside: string; env: string[]; apply: boolean }): Promise<boolean> {
  const remote = `.cache/cloudroom/copy-${randomUUID()}.tgz`;
  try {
    const size = (await stat(archive)).size;
    // Older cores lack raw input (404) and take hex, which doubles the upload.
    const raw = await retry(() => client.runOnVm({ command: "true" }, AbortSignal.timeout(PIECE_TIMEOUT), new Uint8Array()).then(() => true, (error: unknown) => {
      if (error instanceof CloudroomError && error.status === 404) return false;
      throw error;
    }));
    const chunk = raw ? UPLOAD_PART : UPLOAD_PART / 2;
    const started = Date.now();
    const handle = await open(archive);
    try {
      for (let offset = 0; offset < size; offset += chunk) {
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(Math.min(chunk, size - offset)), 0, Math.min(chunk, size - offset), offset);
        // Truncating first lets a resent piece replace itself instead of repeating.
        await retry(() => vm(client, `mkdir -p .cache/cloudroom && truncate -s ${offset} ${remote} && cat >> ${remote}`, buffer.subarray(0, bytesRead), raw));
        const sent = offset + bytesRead;
        report({ phase: "uploading", completed: sent, total: size, secondsLeft: Math.round(((Date.now() - started) / sent) * (size - sent) / 1000) });
      }
    } finally {
      await handle.close();
    }
    const t = quote(target);
    const unpack = edits ? [
      edits.apply ? `{ flock -x -w 60 9 && [ "$(cat -- ${quote(`${target}.cloudroom-files`)} 2>/dev/null)" = copying ] && [ ! -e ${quote(`${target}${GAVE_UP}`)} ] && { tar -xzf ${remote} -C ${t}; exit; }; } 9< ${t}` : "",
      // A folder that ignores itself, so the edits never get committed by accident.
      `a=${t}/${quote(edits.aside)}; mkdir -p -- "$a" && printf '*\\n' > "$a/../.gitignore" && tar -xzf ${remote} -C "$a" || exit 1`,
      edits.env.length ? `tar -xzf ${remote} -C ${t} --skip-old-files -- ${edits.env.map(quote).join(" ")} || exit 1` : "",
      "exit 3",
    ].join("\n") : `tar -xzf ${remote} -C ${t} --skip-old-files`;
    const { code, stderr } = await client.runOnVm({ command: `mkdir -p -- ${t} && (\n${unpack}\n); code=$?; rm -f ${remote}; exit $code`, stdin: "" });
    if (code === 3 && edits) return false;
    if (code !== 0) throw new Error(Buffer.from(stderr, "hex").toString().trim() || `Cloud command failed (${code})`);
    return true;
  } finally {
    await client.runOnVm({ command: `rm -f ${remote}`, stdin: "" }).catch(() => {});
  }
}
