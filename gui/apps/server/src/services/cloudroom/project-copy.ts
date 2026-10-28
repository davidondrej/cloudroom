import { COMPUTER } from "@cloudroom/domain";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, open, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { getProject, getThread, listProjectSourcesByProjectIds, setProjectGitRemoteUrlIfMissing } from "@cloudroom/db";
import { tarCommand } from "@cloudroom/process-utils";
import type { ProjectCopyProgress } from "@cloudroom/domain";
import type { AppDeps } from "../../types.js";
import { CloudroomError, UPLOAD_PART, type CloudroomClient } from "./client.js";
import { saveProjectCopyProgress } from "./store.js";
import { copyMacGithub } from "./sync.js";

type Deps = Pick<AppDeps, "db" | "hub" | "config">;
// `key` is the copy target: one folder on a shared VM, or one per thread sandbox.
// New threads get a clone of the chosen branch (default branch if none) and `.env` files, or all files of a small project not on GitHub.
// A GitHub project with no folder on the Mac (`localPath` null) is cloned only.
// Teleport also brings the local branch and uncommitted work.
export type ProjectCopyJob = { threadId: string; workspace: string; key: string; localPath: string | null; repository: string | null; clone: boolean; copyAll: boolean; teleport: boolean; branch?: string };

const exec = promisify(execFile);
// A stalled piece counts as dropped, so the retry sends it again.
const PIECE_TIMEOUT = 120_000;
const MAX_FILE = 50 * 1024 * 1024;
const MAX_TOTAL = 1024 * 1024 * 1024;
// About 10-20 seconds on a home connection.
const SMALL_PROJECT = 50 * 1024 * 1024;
export const SKIPPED = new Set(["node_modules", ".git", ".venv", "venv", ".next", ".turbo", ".cache", "__pycache__", "target", "dist", "build", ".DS_Store"]);
// Running copies, by copy key, with their thread.
const copying = new Map<string, string>();
export const FAILURE_NOTE = ".cloudroom/project-copy-failed.txt";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function githubRepository(remote: string | null): string | null {
  const repository = remote?.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)\/?$/)?.[1];
  return repository ? `https://github.com/${repository}` : null;
}

function localProjectPath(deps: Deps, projectId: string): string | undefined {
  const sources = listProjectSourcesByProjectIds(deps.db, [projectId]).filter((source) => existsSync(source.path));
  return (sources.find((source) => source.isDefault) ?? sources[0])?.path;
}

/** A project added before it had a GitHub remote picks the remote up here, at its next cloud thread. */
async function projectRemote(deps: Deps, project: { id: string; gitRemoteUrl: string | null }, path: string | null | undefined): Promise<string | null> {
  if (project.gitRemoteUrl !== null || !path) return project.gitRemoteUrl;
  const remote = (await git(path, ["remote", "get-url", "origin"]))?.trim() || null;
  if (remote) setProjectGitRemoteUrlIfMissing(deps.db, deps.hub, project.id, remote);
  return remote;
}

/** Small projects not on GitHub are uploaded whole. Counting stops at the limit, so a huge folder answers fast. */
async function smallProject(root: string): Promise<boolean> {
  return localFiles(root, "all", SMALL_PROJECT).then(() => true, () => false);
}

/** Tells a new cloud thread where a large project without GitHub lives, since its files stay on the Mac. */
export async function localProjectNote(deps: Deps, projectId: string): Promise<string | undefined> {
  const project = getProject(deps.db, projectId);
  const path = project ? localProjectPath(deps, project.id) : undefined;
  if (!project || !path || githubRepository(await projectRemote(deps, project, path)) || await smallProject(path)) return undefined;
  return `This project is not on GitHub and too large to copy, so only its \`.env\` files are here. The rest is on the user's ${COMPUTER} at \`${path}\`. Pull only what the task needs with \`room-cli mac pull\`.`;
}

export function planProjectCopy(...args: Parameters<typeof planProjectCopyOrThrow>): Promise<ProjectCopyJob | null> {
  return planProjectCopyOrThrow(...args).catch(() => null);
}

/** Like planProjectCopy, but a sandbox that can't be reached, or a folder another copy is filling, throws instead of
 *  reading as nothing left to copy. */
export async function planProjectCopyOrThrow(deps: Deps, client: CloudroomClient, threadId: string, workspace: string, { localPath, key = workspace, teleport = false, branch }: { localPath?: string; key?: string; teleport?: boolean; branch?: string } = {}): Promise<ProjectCopyJob | null> {
  const project = getProject(deps.db, getThread(deps.db, threadId)?.projectId ?? "");
  if (!project) return null;
  if (copying.has(key)) throw new Error("Another copy is filling this project folder.");
  const path = localPath ?? localProjectPath(deps, project.id) ?? null;
  const repository = githubRepository(await projectRemote(deps, project, path));
  if (!path && !repository) return null;
  const existing = await client.workspace(workspace);
  const empty = !existing || (await client.runOnVm({ command: `[ -z "$(ls -A -- ${quote(existing.path)} 2>/dev/null | grep -Fvx .cloudroom)" ]`, stdin: "" })).code === 0;
  if (!empty && teleport) return null;
  const clone = empty && Boolean(repository);
  const copyAll = empty && !repository && !teleport && path !== null && await smallProject(path);
  const job = { threadId, workspace, key, localPath: path, repository, clone, copyAll, teleport, ...(branch ? { branch } : {}) };
  // A Mac folder that can't be read has no `.env` files to send, so it reads as nothing left, never as a reason to wait.
  return clone || copyAll || teleport || (path !== null && (await localFiles(path, "env").catch(() => [])).length) ? job : null;
}

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
    .finally(() => copying.delete(job.key));
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
    if (cloneError) cloneError = await clone(deps, client, target, job.repository, branch);
  }
  const cloned = job.clone && !cloneError;
  // Git for Windows checks text files out with CRLF, so the cloud checkout must ignore line-ending-only changes.
  if (cloned && job.teleport && job.localPath && process.platform === "win32" && await checksOutCrlf(job.localPath))
    await vm(client, `git -C ${quote(target)} config core.autocrlf input`);
  if (!cloned) report({ phase: "uploading", completed: 0, total: 0 });
  // A failed clone of a small project falls back to uploading it, like a project not on GitHub.
  const scope = job.teleport ? (cloned ? "changed" : "all") : job.copyAll || (cloneError && job.localPath && await smallProject(job.localPath)) ? "all" : "env";
  let partial: string | undefined;
  if (job.localPath) {
    const folder = await mkdtemp(join(tmpdir(), "cloudroom-copy-"));
    const archive = join(folder, "project.tgz");
    try {
      const packed = await packProject(job.localPath, scope, archive);
      partial = packed.partial;
      if (packed.files) await send(client, archive, target, scope !== "changed", report);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }
  if (cloneError) throw new Error(`The GitHub clone failed${scope === "all" && !partial ? ", so your files were copied without Git history" : ""}. ${cloneError}`);
  return partial;
}

/** Tells the agent why its project folder is empty or incomplete, since it otherwise waits for files that never come. */
async function writeFailureNote(client: CloudroomClient, job: ProjectCopyJob, message: string): Promise<void> {
  const target = (await client.workspace(job.workspace))?.path;
  if (!target) return;
  const next = job.localPath
    ? `The full project is on the user's ${COMPUTER} at \`${job.localPath}\`. Pull only what the task needs with \`room-cli mac pull\`.`
    : "Tell the user, since the files are not available anywhere else.";
  const note = `Cloudroom could not copy this project into the cloud, so do not wait for more files.\n\n${message}\n\n${next}\n`;
  await vm(client, `mkdir -p -- ${quote(`${target}/.cloudroom`)} && cat > ${quote(`${target}/${FAILURE_NOTE}`)}`, Buffer.from(note));
}

/** What `room-cli files wait` reads (ADR 0209): `copying`, then `ready` or `failed: REASON`, in a file next to the
 *  project folder (a workspace ID, or a path), so Git never sees it. With `onlyIfCopying`, it changes only a copy still
 *  marked `copying`. Next to the sandbox root (`/code`), only root can write, so it falls back to sudo. */
export async function writeFilesState(client: CloudroomClient, workspace: string, state: string, onlyIfCopying = false): Promise<void> {
  const target = workspace.startsWith("/") ? workspace : (await client.workspace(workspace))?.path;
  if (!target) return;
  const file = `${target}.cloudroom-files`;
  const write = `state=$(cat) && { printf %s "$state" 2>/dev/null > ${quote(`${file}.tmp`)} && mv -f -- ${quote(`${file}.tmp`)} ${quote(file)} || printf %s "$state" | sudo -n tee ${quote(file)} >/dev/null; }`;
  await vm(client, onlyIfCopying ? `if [ "$(cat -- ${quote(file)} 2>/dev/null)" = copying ]; then ${write}; fi` : write, Buffer.from(state));
}

async function vm(client: CloudroomClient, command: string, bytes?: Buffer<ArrayBuffer>, raw = false): Promise<void> {
  const signal = bytes && AbortSignal.timeout(PIECE_TIMEOUT);
  const result = raw ? await client.runOnVm({ command }, signal, bytes) : await client.runOnVm({ command, stdin: bytes?.toString("hex") ?? "" }, signal);
  if (result.code !== 0) throw new Error(Buffer.from(result.stderr, "hex").toString().trim() || `Cloud command failed (${result.code})`);
}

/** Retries dropped connections and busy clouds for about 90 seconds, so a network blip doesn't end the copy. */
async function retry<T>(attempt: () => Promise<T>): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await attempt();
    } catch (error) {
      if (tries === 7 || !(error instanceof CloudroomError && error.retryable)) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(2_000 * 2 ** (tries - 1), 30_000)));
    }
  }
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  return await exec("git", ["-C", cwd, ...args], { maxBuffer: 256 * 1024 * 1024 }).then((result) => result.stdout, () => null);
}

/** Returns null once the clone is in place, or why it failed. gc.auto=0: auto-packing during `git log -S` in a blobless
 * clone fills the sandbox disk with deleted packs the search still holds open. */
async function clone(deps: Deps, client: CloudroomClient, target: string, repository: string, branch?: string): Promise<string | null> {
  const token = (await copyMacGithub(deps))
    ? await exec("gh", ["auth", "token", "--hostname", "github.com"], {
        timeout: 15_000,
      }).then(
        (result) => result.stdout.trim(),
        () => "",
      )
    : "";
  const temporary = quote(`${target}.cloudroom-clone`);
  const result = await client.runOnVm({
    command: [
      "export GIT_TERMINAL_PROMPT=0",
      token ? "{ { gh auth status --hostname github.com || gh auth login --hostname github.com --with-token; } && gh auth setup-git --hostname github.com; } >/dev/null 2>&1 || true" : "",
      `rm -rf -- ${temporary}`,
      `git clone --quiet --filter=blob:none -c gc.auto=0 -- ${quote(repository)} ${temporary} || { printf '\\035'; timeout 10 gh api user --jq .login 2>/dev/null; exit 1; }`,
      branch && branch !== "HEAD" ? `git -C ${temporary} checkout --quiet ${quote(branch)} 2>/dev/null || true` : "",
      `mkdir -p -- ${quote(target)} && (shopt -s dotglob && mv -n -- ${temporary}/* ${quote(target)}/) || true`,
      `rm -rf -- ${temporary}`,
      `test -e ${quote(`${target}/.git`)} || { echo 'The clone did not reach the project folder.' >&2; exit 1; }`,
    ].join("\n"),
    stdin: Buffer.from(token).toString("hex"),
  });
  if (result.code === 0) return null;
  const error = Buffer.from(result.stderr, "hex").toString().trim().slice(-300) || `git clone exited with code ${result.code}`;
  const stdout = Buffer.from(result.stdout, "hex");
  const mark = stdout.indexOf(0x1d);
  const login = mark < 0 ? "" : stdout.subarray(mark + 1).toString().trim();
  return `${cloneHint(error, /^[A-Za-z0-9-]{1,39}$/.test(login) ? login : "")} Git said: ${error}`;
}

function cloneHint(error: string, login: string): string {
  const fix = "in Settings → Cloud environment → GitHub, then start a new thread";
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

/** `all`: every project file; `changed`: uncommitted and untracked files; `env`: only `.env` files. Ignored `.env` files always count.
 *  Throws once the files pass `limit` bytes. */
export async function localFiles(root: string, scope: "all" | "changed" | "env", limit = MAX_TOTAL): Promise<string[]> {
  const listed = await git(root, ["ls-files", "-z", scope === "all" ? "--cached" : "--modified", "--others", "--exclude-standard"]);
  // `--modified` skips staged edits and staged new files, so add what the index changed since the last commit.
  const staged = listed === null || scope === "all" ? "" : await git(root, ["diff", "-z", "--name-only", "--cached"]) ?? "";
  const ignored = listed === null ? "" : await git(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]) ?? "";
  const env = ignored.split("\0").filter((path) => path && !path.endsWith("/") && isEnv(path));
  const found = listed === null ? walk(root, "") : [...new Set([...listed.split("\0"), ...staged.split("\0"), ...env].filter(Boolean))];
  const files: string[] = [];
  let total = 0;
  for await (const path of found) {
    if (scope === "env" && !isEnv(path)) continue;
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
async function packProject(root: string, scope: "all" | "changed" | "env", archive: string): Promise<{ files: number; partial?: string }> {
  try {
    const files = await localFiles(root, scope);
    if (files.length) await pack(root, files, archive);
    return { files: files.length };
  } catch (error) {
    if (scope !== "all") throw error;
    const files = await localFiles(root, "env").catch(() => { throw error; });
    if (files.length) await pack(root, files, archive).catch(() => { throw error; });
    const reason = error instanceof Error ? error.message : String(error);
    return { files: files.length, partial: `Only the \`.env\` files were copied, because the ${COMPUTER} could not pack the rest: ${reason}`.slice(0, 500) };
  }
}

async function pack(root: string, files: string[], archive: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    const tar = spawn(tarCommand(), ["--no-xattrs", "-czf", archive, "--null", "-T", "-"], { cwd: root, env: { ...process.env, COPYFILE_DISABLE: "1" }, stdio: ["pipe", "ignore", "pipe"] });
    tar.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-300); });
    tar.on("error", reject).on("close", (code) => code === 0 ? resolve() : reject(new Error(`Could not pack the project files. ${stderr.trim()}`.trim())));
    tar.stdin.end(files.map((path) => `${path}\0`).join(""));
  });
}

async function send(client: CloudroomClient, archive: string, target: string, keepExisting: boolean, report: (progress: ProjectCopyProgress) => void): Promise<void> {
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
    await vm(client, `mkdir -p -- ${quote(target)} && tar -xzf ${remote} -C ${quote(target)}${keepExisting ? " --skip-old-files" : ""}; code=$?; rm -f ${remote}; exit $code`);
  } finally {
    await client.runOnVm({ command: `rm -f ${remote}`, stdin: "" }).catch(() => {});
  }
}
