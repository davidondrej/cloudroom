import { execFile } from "node:child_process";

// Pull requests for Cloud threads on the team board (docs/scopes/organizations.md#team-board). A Cloud thread has no
// environment on this computer, so Git can't be asked. Its own branch ends in the last 4 characters of its ID
// (`room/<name>-<4>`), so the owner's own pull requests in the repo are matched by that ending, through `gh` on this
// computer. Nothing when gh is missing or signed out.

export type BoardPr = { number: number; url: string; state: "draft" | "open" | "merged" | "closed"; checks: "passing" | "failing" | "pending" | "none" };
type Check = { status?: string; conclusion?: string | null; state?: string };
type Raw = { number: number; url: string; state: string; isDraft: boolean; headRefName: string; statusCheckRollup?: Check[] | null };

const CACHE_MS = 60_000;
const FAILED = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const run = (file: string, args: string[]) => new Promise<string>((resolve, reject) =>
  execFile(file, args, { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout))));

export function checksOf(rollup: Check[] | null | undefined): BoardPr["checks"] {
  if (!rollup?.length) return "none";
  if (rollup.some((check) => FAILED.has(check.conclusion ?? check.state ?? ""))) return "failing";
  return rollup.some((check) => (check.status ? check.status !== "COMPLETED" : ["PENDING", "EXPECTED"].includes(check.state ?? ""))) ? "pending" : "passing";
}

/** Returns a lookup: a Cloud thread's latest pull request in a repo, or null. One `gh` call per repo a minute. */
export function cloudPullRequests() {
  let gh: Promise<string | null> | null = null;
  const cache = new Map<string, { at: number; list: Promise<Raw[]> }>();
  const find = () => (gh ??= (async () => {
    for (const file of ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) {
      try { await run(file, ["--version"]); return file; } catch { /* the next place */ }
    }
    return null;
  })());
  const list = (repo: string) => {
    const hit = cache.get(repo);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.list;
    const read = find().then(async (file) => (file
      ? JSON.parse(await run(file, ["pr", "list", "-R", repo, "--author", "@me", "--state", "all", "--limit", "100", "--json", "number,url,state,isDraft,headRefName,statusCheckRollup"])) as Raw[]
      : [])).catch(() => []);
    cache.set(repo, { at: Date.now(), list: read });
    return read;
  };
  return async (repo: string, threadId: string): Promise<BoardPr | null> => {
    const ending = `-${threadId.slice(-4)}`;
    const pr = (await list(repo)).find((item) => item.headRefName.startsWith("room/") && item.headRefName.endsWith(ending));
    if (!pr) return null;
    const state = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open";
    return { number: pr.number, url: pr.url, state, checks: checksOf(pr.statusCheckRollup) };
  };
}
