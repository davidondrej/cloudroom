import { isUtf8 } from "node:buffer";
import type { Context } from "hono";
import mimeTypes from "mime-types";
import { z } from "zod";
import { workspaceStatusSchema, type GitBranchRefClassification, type RawDiffFileStat, type WorkspaceCommitSummary, type WorkspaceDiffTarget, type WorkspaceFileStatus, type WorkspaceStatus } from "@cloudroom/domain";
import { environmentDiffBranchesQuerySchema, environmentDiffFileQuerySchema, environmentDiffPatchRequestSchema, environmentDiffQuerySchema, environmentStatusQuerySchema, type DiffFileEntry, type DiffPatchEntry, type EnvironmentDiffBranchesResponse, type EnvironmentDiffFileQuery, type EnvironmentDiffFileResponse, type EnvironmentDiffFilesResponse } from "@cloudroom/server-contract";
import { formatShortstat, parseNameStatusSourceEntries, parseNumstatEntriesZ, parsePorcelainEntries, resolveWorkspaceFileStatusKind, resolveWorkspaceState } from "@cloudroom/host-workspace";
import { DIFF_FILE_PATCH_MAX_BYTES, WORKSPACE_DIFF_MAX_FILES, WORKSPACE_STATUS_MAX_UNTRACKED_LINE_STAT_FILES } from "../../constants.js";
import { rawDiffFileStatToEntry, selectInitialPatchPaths } from "../../routes/diff-tiering.js";
import { toWorkspaceDiffTarget } from "../../routes/environments.js";
import { normalizeBranchQuery, parseBranchListLimit } from "../../routes/branch-list-query.js";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { SandboxAsleep } from "./sandboxes.js";
import { baseBranch, binding, command, lastGitStatus, saveBinding } from "./store.js";

/** Runs a bash script in the Cloud thread's checkout and returns stdout; throws CloudGitError on failure. */
export type CloudGitRun = (script: string, stdin?: Buffer) => Promise<Buffer>;

export class CloudGitError extends Error {
  constructor(message: string, readonly exitCode: number | null) { super(message); }
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 1024 * 1024;
const MAX_PATCH_REPLY_BYTES = 12 * 1024 * 1024;
const MAX_COMMITS = 500;
const SNAPSHOTS = 5;

// One round trip per read, and no Git writes. Working-tree diffs compare against the files on disk, with untracked files
// marked intent-to-add in a throwaway index, so nothing is hashed or stored. Untracked files over 1 MiB are listed but
// never read. Hooks and textconv never run, and lazy fetches in partial clones are refused, so reads use only objects
// already in the sandbox. Git failures exit non-zero; only committed line counts and squash detection are best effort.
// Every reply is framed as "<bytes>\n<bytes of data>" so any file name survives.
const PRELUDE = `export GIT_OPTIONAL_LOCKS=0 GIT_LITERAL_PATHSPECS=1 GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=none LC_ALL=C
ulimit -t 60 2>/dev/null
g() { git -c core.hooksPath=/dev/null -c color.ui=never -c diff.noprefix=false -c diff.mnemonicPrefix=false -c diff.relative=false -c core.splitIndex=false -c core.untrackedCache=false -c core.fsmonitor=false "$@"; }
top=$(git rev-parse --show-toplevel 2>/dev/null) && cd "$top" || { echo "This folder is not a Git repository." >&2; exit 3; }
index=$(git rev-parse --git-path index); objects=$(cd "$(git rev-parse --git-path objects)" && pwd -P)
tmp=$(mktemp -d) || exit 1; trap 'rm -rf "$tmp"' EXIT
ok() { "$@" > "$tmp/out" 2> "$tmp/err"; }
send() { wc -c < "$tmp/out"; cat "$tmp/out"; }
fail() { cat "$tmp/err" >&2; exit 8; }
emit() { ok "$@" || fail; send; }
say() { printf '%s' "$1" > "$tmp/out"; send; }
empty=$(git hash-object -t tree /dev/null)
head=$(git rev-parse -q --verify 'HEAD^{commit}') || head=
untracked() {
  : > "$tmp/small"; : > "$tmp/large"
  g ls-files --others --exclude-standard -z > "$tmp/all" 2> "$tmp/err" || fail
  head -z -n "$1" "$tmp/all" | { xargs -0 -r stat --printf '%s %n\\0' -- 2>/dev/null; true; } |
    while IFS= read -r -d '' l; do s=\${l%% *}; f=\${l#* }; if [ "$s" -le ${MAX_UNTRACKED_FILE_BYTES} ]; then printf '%s\\0' "$f" >> "$tmp/small"; else printf '%s\\0' "$f" >> "$tmp/large"; fi; done
}
ita() {
  cp "$index" "$tmp/index" 2>/dev/null || rm -f "$tmp/index"; export GIT_INDEX_FILE="$tmp/index"
  [ -s "$tmp/small" ] || return 0
  mkdir -p "$tmp/objects" && GIT_OBJECT_DIRECTORY="$tmp/objects" GIT_ALTERNATE_OBJECT_DIRECTORIES="$objects" g add -N --pathspec-from-file="$tmp/small" --pathspec-file-nul > /dev/null 2> "$tmp/err" || fail
}
base() {
  d=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null); d=\${d#origin/}
  [ -n "$d" ] || for c in main master; do git rev-parse -q --verify "refs/remotes/origin/$c" >/dev/null || git rev-parse -q --verify "refs/heads/$c" >/dev/null || continue; d=$c; break; done
  b=\${1:-$d}; bref=; mb=
  [ -n "$b" ] && for r in "refs/remotes/origin/$b" "refs/heads/$b" "refs/remotes/$b"; do git rev-parse -q --verify "$r^{commit}" >/dev/null && { bref=$r; break; }; done
  [ -n "$bref" ] && [ -n "$head" ] && mb=$(git merge-base "$bref" HEAD 2>/dev/null)
  return 0
}
compare() {
  base "$1"
  [ -n "$bref" ] || { echo "Branch $1 is not in the cloud sandbox." >&2; exit 5; }
  [ -n "$mb" ] || [ -z "$head" ] || { echo "This branch shares no history with $1." >&2; exit 5; }
}
squashed() {
  g diff --no-ext-diff --no-textconv "$mb" HEAD 2>/dev/null | git patch-id --stable > "$tmp/pid"; [ "\${PIPESTATUS[0]}" = 0 ] || return 1
  p=$(cut -d' ' -f1 "$tmp/pid" | head -n 1); [ -n "$p" ] || { echo 1; return 0; }
  g log -p --no-ext-diff --no-textconv -n 1000 --format='commit %H' "$mb..$bref" 2>/dev/null | git patch-id --stable > "$tmp/pid"; [ "\${PIPESTATUS[0]}" = 0 ] || return 1
  cut -d' ' -f1 "$tmp/pid" | grep -qx "$p" && echo 1 || echo 0
}
`;

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const nul = (paths: readonly string[]) => Buffer.from(paths.map((path) => `${path}\0`).join(""));
const files = () => `emit g diff --no-ext-diff --no-textconv -M --name-status -z "$a" \${t:+"$t"}
emit g diff --no-ext-diff --no-textconv -M --numstat -z "$a" \${t:+"$t"}`;

/** Sets `a` (old side) and `t` (new side, empty for the files on disk); `mb` is the merge base for branch targets. */
function range(target: WorkspaceDiffTarget): string {
  switch (target.type) {
    case "uncommitted": return `untracked ${WORKSPACE_DIFF_MAX_FILES + 1}; ita; a=\${head:-$empty}; t=`;
    case "branch_committed": return `compare ${quote(target.mergeBaseBranch)}; a=\${mb:-$empty}; t=\${head:-$empty}`;
    case "all": return `compare ${quote(target.mergeBaseBranch)}; untracked ${WORKSPACE_DIFF_MAX_FILES + 1}; ita; a=\${mb:-$empty}; t=`;
    case "commit": return `t=$(git rev-parse -q --verify ${quote(`${target.sha}^{commit}`)}) || { echo "Commit not found." >&2; exit 5; }; a=$(git rev-parse -q --verify "$t^") || a=$empty`;
  }
}

/** Splits a framed reply. A header ending in " x" marks a part the reply budget cut off. */
function frames(output: Buffer): { text: string; bytes: Buffer; cut: boolean }[] {
  const parts: { text: string; bytes: Buffer; cut: boolean }[] = [];
  let cursor = 0;
  while (cursor < output.length) {
    const newline = output.indexOf(0x0a, cursor);
    if (newline < 0) break;
    const header = output.subarray(cursor, newline).toString().trim();
    const size = Number.parseInt(header, 10) || 0;
    const bytes = output.subarray(newline + 1, newline + 1 + size);
    parts.push({ text: bytes.toString("utf8"), bytes, cut: header.endsWith("x") });
    cursor = newline + 1 + size;
  }
  return parts;
}

const nulList = (text = "") => text.split("\0").filter(Boolean);

function changedFiles(nameStatus: string, numstat: string, small = "", large = ""): RawDiffFileStat[] {
  const untracked = new Set(nulList(small));
  const lineStats = new Map(parseNumstatEntriesZ(numstat).map((entry) => [entry.path, entry] as const));
  const listed = parseNameStatusSourceEntries(nameStatus).map((entry): RawDiffFileStat => {
    const line = lineStats.get(entry.path);
    const letter = entry.status[0] ?? "M";
    return {
      path: entry.path,
      previousPath: entry.previousPath,
      statusLetter: (["A", "M", "D", "R", "C", "T"].includes(letter) ? letter : "M") as RawDiffFileStat["statusLetter"],
      additions: line?.insertions ?? 0,
      deletions: line?.deletions ?? 0,
      binary: line !== undefined && line.insertions === null && line.deletions === null,
      origin: untracked.has(entry.path) ? "untracked" : "tracked",
    };
  });
  const unread = nulList(large).map((path): RawDiffFileStat => ({ path, previousPath: null, statusLetter: "A", additions: 0, deletions: 0, binary: true, origin: "untracked" }));
  return [...listed, ...unread];
}

function sum(files: readonly { insertions: number | null; deletions: number | null }[]): { insertions: number; deletions: number } {
  return files.reduce<{ insertions: number; deletions: number }>((total, file) => ({ insertions: total.insertions + (file.insertions ?? 0), deletions: total.deletions + (file.deletions ?? 0) }), { insertions: 0, deletions: 0 });
}

export async function cloudGitStatus(run: CloudGitRun, mergeBaseBranch?: string): Promise<WorkspaceStatus> {
  const parts = frames(await run(`${PRELUDE}
base ${quote(mergeBaseBranch ?? "")}
say "$(git symbolic-ref -q --short HEAD)"; say "$head"; say "$d"; say "$b"; say "$bref"; say "$mb"
emit g status --porcelain=v1 --untracked-files=all
untracked ${WORKSPACE_STATUS_MAX_UNTRACKED_LINE_STAT_FILES}; ita; emit cat "$tmp/small"
emit g diff --no-ext-diff --no-textconv --no-renames --numstat -z "\${head:-$empty}"
[ -n "$mb" ] || exit 0
pick=--cherry-pick; counts=$(g rev-list --cherry-pick --left-right --count "$bref...HEAD" 2>/dev/null) || { pick=; counts=$(g rev-list --left-right --count "$bref...HEAD" 2> "$tmp/err") || fail; }
say "$counts"
set -- $counts; sq=0; if [ -n "$pick" ] && [ "$1" -gt 0 ] && [ "$2" -gt 0 ]; then sq=$(squashed) || sq=0; fi; say "$sq"
emit g log $pick --right-only --reverse -n ${MAX_COMMITS} --format='%H%x1f%h%x1f%s%x1f%an%x1f%at%x00' "$bref...HEAD"
if ok g diff --no-ext-diff --no-textconv -M --name-status -z "$mb" HEAD; then send; else emit g diff --no-ext-diff --no-renames --name-status -z "$mb" HEAD; fi
if ok g diff --no-ext-diff --no-textconv -M --numstat -z "$mb" HEAD; then send; else say -; fi`));
  const [branch = "", head = "", defaultBranch = "", comparedBranch = "", baseRef = "", mergeBase = "", porcelain = "", small = "", numstat = "", counts = "", squash = "", log = "", baseNameStatus = "", baseNumstat = ""] = parts.map((part) => part.text);

  const entries = parsePorcelainEntries(porcelain);
  const counted = new Set(nulList(small));
  const lineStats = new Map(parseNumstatEntriesZ(numstat).map((entry) => [entry.path, entry] as const));
  const working: WorkspaceFileStatus[] = entries.map((entry) => {
    const unread = entry.status === "??" && !counted.has(entry.path);
    return {
      path: entry.path,
      status: resolveWorkspaceFileStatusKind(entry),
      insertions: unread ? null : lineStats.get(entry.path)?.insertions ?? 0,
      deletions: unread ? null : lineStats.get(entry.path)?.deletions ?? 0,
    };
  });
  const commits: WorkspaceCommitSummary[] = squash === "1" ? [] : log.split("\0").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [sha = "", shortSha = "", subject = "", authorName = "", authoredAt = "0"] = line.split("\x1f");
    return { sha, shortSha, subject, authorName, authoredAt: Number.parseInt(authoredAt, 10) * 1000 };
  });
  const [behindCount = 0, aheadCount = 0] = counts.trim().split(/\s+/u).map((value) => Number.parseInt(value, 10) || 0);
  const ahead = commits.length === 0 ? 0 : aheadCount;
  const uncounted = baseNumstat === "-";
  const committed: WorkspaceFileStatus[] = ahead === 0 ? [] : changedFiles(baseNameStatus, uncounted ? "" : baseNumstat).map((file) => ({
    path: file.path,
    status: file.statusLetter === "T" ? "M" : file.statusLetter,
    insertions: file.binary || uncounted ? null : file.additions,
    deletions: file.binary || uncounted ? null : file.deletions,
  }));
  const hasUntracked = entries.some((entry) => entry.status === "??");
  return {
    workingTree: {
      hasUncommittedChanges: entries.length > 0,
      state: resolveWorkspaceState({ hasCommittedChanges: ahead > 0, hasTrackedChanges: entries.some((entry) => entry.status !== "??"), hasUntracked }),
      ...sum(working),
      lineStatsComplete: working.every((file) => file.insertions !== null),
      files: working,
    },
    checkout: branch
      ? head ? { kind: "branch", branchName: branch, headSha: head } : { kind: "unborn", branchName: branch }
      : head ? { kind: "detached", headSha: head } : { kind: "unknown", reason: "HEAD is not symbolic and no commit is checked out" },
    branch: { currentBranch: branch || null, defaultBranch: defaultBranch || branch },
    mergeBase: comparedBranch && baseRef ? {
      mergeBaseBranch: comparedBranch,
      baseRef: mergeBase || null,
      aheadCount: ahead,
      behindCount,
      hasCommittedUnmergedChanges: ahead > 0,
      commits,
      ...sum(committed),
      lineStatsComplete: !uncounted,
      files: committed,
    } : null,
  };
}

export async function cloudGitDiffFiles(run: CloudGitRun, target: WorkspaceDiffTarget): Promise<Extract<EnvironmentDiffFilesResponse, { outcome: "available" }>> {
  const workingTree = target.type === "uncommitted" || target.type === "all";
  const [mergeBase = "", nameStatus = "", numstat = "", small = "", large = ""] = frames(await run(`${PRELUDE}
${range(target)}
say "$mb"
${files()}
${workingTree ? `emit cat "$tmp/small"; emit cat "$tmp/large"` : ""}`)).map((part) => part.text);
  const all = changedFiles(nameStatus, numstat, small, large);
  const stats = all.slice(0, WORKSPACE_DIFF_MAX_FILES);
  const entries = stats.map(rawDiffFileStatToEntry);
  const initialPaths = selectInitialPatchPaths(entries);
  return {
    outcome: "available",
    files: entries,
    truncated: all.length > WORKSPACE_DIFF_MAX_FILES,
    shortstat: formatShortstat({ changedFiles: entries.length, ...sum(stats.map((file) => ({ insertions: file.additions, deletions: file.deletions }))) }),
    mergeBaseRef: target.type === "branch_committed" || target.type === "all" ? mergeBase || null : null,
    initialPatches: initialPaths.length > 0 ? await cloudGitDiffPatch(run, target, initialPaths, stats).catch(() => []) : [],
  };
}

/** One `git diff` per path, each capped, with a budget for the whole reply. `known` pairs a renamed file with its old path. */
export async function cloudGitDiffPatch(run: CloudGitRun, target: WorkspaceDiffTarget, paths: readonly string[], known: readonly Pick<RawDiffFileStat, "path" | "previousPath">[] = []): Promise<DiffPatchEntry[]> {
  const unique = [...new Set(paths)];
  if (unique.length === 0) return [];
  const previous = new Map(known.map((file) => [file.path, file.previousPath] as const));
  const parts = frames(await run(`${PRELUDE}
${range(target)}
left=${MAX_PATCH_REPLY_BYTES}
while IFS= read -r -d '' p && IFS= read -r -d '' q; do
  [ "$left" -gt 0 ] || { echo "0 x"; continue; }
  n=$(( left < ${DIFF_FILE_PATCH_MAX_BYTES + 1} ? left : ${DIFF_FILE_PATCH_MAX_BYTES + 1} ))
  if [ "$p" = "$q" ]; then set -- "$p"; else set -- "$q" "$p"; fi
  g diff --no-ext-diff --no-textconv -M "$a" \${t:+"$t"} -- "$@" 2> "$tmp/err" | head -c "$n" > "$tmp/out"
  r=\${PIPESTATUS[0]}; [ "$r" = 0 ] || [ "$r" = 141 ] || fail
  s=$(wc -c < "$tmp/out"); left=$((left - s))
  if [ "$s" -ge "$n" ]; then echo "$s x"; else echo "$s"; fi; cat "$tmp/out"
done`, nul(unique.flatMap((path) => [path, previous.get(path) ?? path]))));
  return unique.map((path, index) => {
    const part = parts[index];
    const bytes = part?.bytes.subarray(0, DIFF_FILE_PATCH_MAX_BYTES) ?? Buffer.alloc(0);
    return { path, patch: bytes.toString("utf8"), truncated: part?.cut ?? true };
  });
}

export async function cloudGitFile(run: CloudGitRun, query: EnvironmentDiffFileQuery): Promise<EnvironmentDiffFileResponse> {
  const path = query.path.replace(/^\/+/u, "");
  if (path.split("/").some((segment) => segment === ".." || segment === "")) throw new ApiError(400, "invalid_request", "Invalid path");
  const onDisk = query.side === "new" && (query.target === "uncommitted" || query.target === "all");
  const revision = query.target === "commit"
    ? `${range({ type: "commit", sha: query.sha })}; rev=${query.side === "old" ? "$a" : "$t"}`
    : `rev=${query.side === "new" ? "${head:-$empty}" : query.target === "uncommitted" ? "${head:-$empty}" : quote(query.mergeBaseRef)}`;
  const content = frames(await run(`${PRELUDE}
IFS= read -r -d '' p
${onDisk
    ? `[ -f "$p" ] && [ ! -L "$p" ] || { echo "File not found." >&2; exit 6; }
case "$(realpath -e -- "$p")" in "$(pwd -P)"/*) ;; *) echo "File not found." >&2; exit 6 ;; esac
[ "$(stat -c %s -- "$p")" -le ${MAX_FILE_BYTES} ] || { echo "File is too large to show." >&2; exit 7; }
emit cat -- "$p"`
    : `${revision}
s=$(git cat-file -s "$rev:$p" 2>/dev/null) || { echo "File not found." >&2; exit 6; }
[ "$s" -le ${MAX_FILE_BYTES} ] || { echo "File is too large to show." >&2; exit 7; }
emit git cat-file blob "$rev:$p"`}`, nul([path])))[0]?.bytes ?? Buffer.alloc(0);
  const mimeType = mimeTypes.lookup(path) || undefined;
  const image = mimeType?.startsWith("image/") === true && mimeType !== "image/svg+xml";
  const utf8 = !image && isUtf8(content);
  return { path, content: content.toString(utf8 ? "utf8" : "base64"), contentEncoding: utf8 ? "utf8" : "base64", ...(mimeType ? { mimeType } : {}), sizeBytes: content.length };
}

export async function cloudGitBranches(run: CloudGitRun, query: string | undefined, limit: number, selectedBranch?: string): Promise<EnvironmentDiffBranchesResponse> {
  const [defaultBranch = "", refs = ""] = frames(await run(`${PRELUDE}base ''; say "$d"
emit g for-each-ref --format='%(refname)%09%(symref)' refs/heads refs/remotes`)).map((part) => part.text);
  const lines = refs.split("\n").map((line) => line.split("\t")).filter(([ref, symref]) => ref && !symref);
  const local = lines.flatMap(([ref = ""]) => ref.startsWith("refs/heads/") ? [ref.slice(11)] : []);
  const remote = lines.flatMap(([ref = ""]) => ref.startsWith("refs/remotes/") ? [ref.slice(13)] : []);
  const pick = (names: string[], pinned: string) => {
    const ordered = names.includes(pinned) ? [pinned, ...names.filter((name) => name !== pinned)] : names;
    const matches = query ? ordered.filter((name) => name.toLowerCase().includes(query.toLowerCase())) : ordered;
    return { names: matches.slice(0, limit), truncated: matches.length > limit };
  };
  const branches = pick(local, defaultBranch);
  const remoteBranches = pick(remote, `origin/${defaultBranch}`);
  const selected: GitBranchRefClassification | null = !selectedBranch ? null
    : { name: selectedBranch, kind: local.includes(selectedBranch) ? "local" : remote.includes(selectedBranch) ? "remote" : "missing" };
  return { branches: branches.names, branchesTruncated: branches.truncated, remoteBranches: remoteBranches.names, remoteBranchesTruncated: remoteBranches.truncated, selectedBranch: selected };
}

const NOT_A_REPO = 3;
const ASLEEP = "The cloud sandbox is asleep. Git details show here once it wakes.";
const RECENT_BYTES = 32 * 1024 * 1024;
const RECENT_ITEM_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_BYTES = 256 * 1024;
const recent = new Map<string, { value: unknown; bytes: number }>();
let recentBytes = 0;
const snapshotsSchema = z.record(z.string(), workspaceStatusSchema);

/** Keeps recent answers for a sleeping sandbox, within a byte budget; big answers are not kept. */
function remember(key: string, value: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  recentBytes -= recent.get(key)?.bytes ?? 0;
  recent.delete(key);
  if (bytes > RECENT_ITEM_BYTES) return;
  recent.set(key, { value, bytes });
  recentBytes += bytes;
  for (const [oldest, entry] of recent) {
    if (recentBytes <= RECENT_BYTES) break;
    recent.delete(oldest);
    recentBytes -= entry.bytes;
  }
}

function savedSnapshots(lastGitStatus: string | null | undefined): Record<string, WorkspaceStatus> {
  const parsed = snapshotsSchema.safeParse(lastGitStatus ? JSON.parse(lastGitStatus) as unknown : {});
  return parsed.success ? parsed.data : {};
}

/** Serves `/environments/cloudgit_<thread>/...`, the Git reads the diff and info panels make, from the Cloud thread's sandbox.
 *  Reads never wake it. While it sleeps, status comes from the snapshot saved for the same comparison branch, and diffs
 *  from this run's recent answers. */
export async function cloudGitResponse(deps: AppDeps, threadId: string, context: Context, run: CloudGitRun): Promise<unknown> {
  const saved = binding(deps.db, threadId);
  if (!saved) throw new ApiError(404, "not_found", "Environment not found");
  const workspacePath = savedWorkspacePath(saved.lastWorkspace) ?? "Cloud sandbox";
  const action = context.req.path.replace(/^.*\/environments\/[^/]+\//u, "");
  const body = context.req.method === "GET" ? null : await context.req.json() as unknown;
  const key = `${threadId} ${action} ${body === null ? new URL(context.req.url).search : JSON.stringify(body)}`;
  const snapshotKey = action === "status" ? environmentStatusQuerySchema.parse(context.req.query()).mergeBaseBranch ?? "" : "";
  const unavailable = (message: string) => ({ outcome: "unavailable", failure: { code: "unknown", workspacePath, message } });
  try {
    if (action === "status") {
      const workspace = await cloudGitStatus(run, snapshotKey || baseBranch(command(deps.db, `first_${threadId}`)?.input));
      const latest = lastGitStatus(deps.db, threadId);
      const others = Object.entries(savedSnapshots(latest)).filter(([branch]) => branch !== snapshotKey).slice(1 - SNAPSHOTS);
      // A huge status (thousands of changed files) is not saved, like remember() skips big answers.
      const next = JSON.stringify(Object.fromEntries([...others, [snapshotKey, workspace]]));
      if (next !== latest && Buffer.byteLength(JSON.stringify(workspace)) <= SNAPSHOT_BYTES) saveBinding(deps.db, threadId, { lastGitStatus: next });
      return { outcome: "available", workspace };
    }
    if (action === "pull-request") return { outcome: "absent" };
    if (action === "diff/branches") {
      const query = environmentDiffBranchesQuerySchema.parse(context.req.query());
      return await cloudGitBranches(run, normalizeBranchQuery(query.query), parseBranchListLimit(query.limit), normalizeBranchQuery(query.selectedBranch));
    }
    let value: unknown;
    if (action === "diff/files") {
      const target = toWorkspaceDiffTarget(environmentDiffQuerySchema.parse(context.req.query()));
      const files = await cloudGitDiffFiles(run, target);
      remember(`files ${threadId} ${JSON.stringify(target)}`, files.files);
      value = files;
    } else if (action === "diff/patch") {
      const request = environmentDiffPatchRequestSchema.parse(body);
      const known = recent.get(`files ${threadId} ${JSON.stringify(request.target)}`)?.value as DiffFileEntry[] | undefined;
      value = { outcome: "available", patches: await cloudGitDiffPatch(run, request.target, request.paths, known) };
    } else if (action === "diff/file") {
      value = await cloudGitFile(run, environmentDiffFileQuerySchema.parse(context.req.query()));
    } else {
      throw new ApiError(404, "not_found", "This is not available for Cloud threads yet.");
    }
    remember(key, value);
    return value;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof CloudGitError && error.exitCode === NOT_A_REPO) return { outcome: "not_applicable", reason: "non_git_environment", message: error.message };
    const message = error instanceof SandboxAsleep ? ASLEEP : error instanceof Error ? error.message : String(error);
    if (action === "status") {
      const cached = savedSnapshots(lastGitStatus(deps.db, threadId))[snapshotKey];
      return cached ? { outcome: "available", workspace: cached } : unavailable(message);
    }
    const cached = recent.get(key);
    if (cached) return cached.value;
    if (action === "diff/file") throw new ApiError(409, "cloud_git_unavailable", message);
    if (action === "diff/branches") return { branches: [], branchesTruncated: false, remoteBranches: [], remoteBranchesTruncated: false, selectedBranch: null };
    return unavailable(message);
  }
}

export function savedWorkspacePath(lastWorkspace: string | null): string | null {
  if (!lastWorkspace) return null;
  const value = JSON.parse(lastWorkspace) as { path?: unknown } | null;
  return typeof value?.path === "string" && value.path ? value.path : null;
}
