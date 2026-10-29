import { z } from "zod";
import { createRemoteProject, getProject, listProjectSourcesByProjectIds, listPublicProjects, setProjectGithubRepo, setProjectHidden, type ProjectRow } from "@cloudroom/db";
import type { AppDeps } from "../../types.js";
import { cloudroom } from "./commands.js";
import { localRepos } from "./local-repos.js";
import { githubRepository } from "./project-copy.js";
import { macGithubToken } from "./sandboxes.js";

/** A repo the user works on that is not a Cloudroom project yet: a Git folder on this Mac, or an `owner/name` GitHub repo. */
export type RepoSuggestion =
  | { source: "mac"; name: string; path: string; updatedAt: number }
  | { source: "github"; name: string; repo: string; updatedAt: number | null };

/** A GitHub repo by its ID, which survives renames and transfers, and its `owner/name`. The ID is null when GitHub can't tell. */
type GithubRepo = { id: number | null; repo: string };

const LIMIT = 20;
const repoSchema = z.object({ id: z.number(), full_name: z.string() });
const listSchema = z.array(repoSchema.extend({ pushed_at: z.string().nullable() }));
/** `owner/name` in lower case, so SSH, HTTPS, and `.git` remotes of one repo match. */
const repoName = (remote: string | null) => githubRepository(remote)?.slice("https://github.com/".length).replace(/\.git$/, "").toLowerCase() ?? null;

/** GitHub's answers by `owner/name` or `#id`, kept until the app restarts. Network failures are asked again next time. */
const known = new Map<string, Promise<GithubRepo | null>>();
function lookup(key: string, token: string | null): Promise<GithubRepo | null> {
  const cached = known.get(key);
  if (cached) return cached;
  const path = key.startsWith("#") ? `repositories/${key.slice(1)}` : `repos/${key}`;
  const found = fetch(`https://api.github.com/${path}`, {
    headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(10_000),
  }).then(async (response) => {
    if (response.status === 404) return null;
    const repo = repoSchema.parse(await response.json());
    return { id: repo.id, repo: repo.full_name };
  }).catch(() => { known.delete(key); return null; });
  known.set(key, found);
  return found;
}

/** The account's repos, newest push first. This Mac's `gh` login answers with push times; otherwise the website's GitHub login does. */
async function githubRepos(deps: AppDeps, token: string | null): Promise<{ connected: boolean; repos: (GithubRepo & { updatedAt: number | null })[] }> {
  if (token) {
    const response = await fetch("https://api.github.com/user/repos?sort=pushed&per_page=50", {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    const list = response?.ok ? listSchema.safeParse(await response.json().catch(() => null)) : null;
    if (list?.success) return { connected: true, repos: list.data.map((repo) => ({ id: repo.id, repo: repo.full_name, updatedAt: repo.pushed_at ? Date.parse(repo.pushed_at) : null })) };
  }
  const view = await cloudroom(deps).sandboxes.environment({ action: "githubRepos" }).catch(() => null);
  const names = view?.available ?? [];
  return { connected: Boolean(token) || names.length > 0, repos: names.map((repo) => ({ id: view?.ids?.[repo] ?? null, repo, updatedAt: view?.pushed?.[repo] ?? null })) };
}

/** The project's GitHub repo. The first answer saves its ID. A rename or transfer saves the new name, so clones never rely on GitHub's redirect from the old one. */
async function projectRepo(deps: AppDeps, project: ProjectRow, token: string | null): Promise<GithubRepo | null> {
  const name = repoName(project.gitRemoteUrl);
  if (!project.gitRemoteUrl || !name) return null;
  const repo = await lookup(project.githubRepoId ? `#${project.githubRepoId}` : name, token);
  if (!repo?.id) return { id: project.githubRepoId, repo: name };
  if (repo.id !== project.githubRepoId || repo.repo.toLowerCase() !== name) {
    const gitRemoteUrl = project.gitRemoteUrl.replace(/[\w.-]+\/[\w.-]+?(\.git)?\/?$/, (_, git: string | undefined) => `${repo.repo}${git ?? ""}`);
    setProjectGithubRepo(deps.db, deps.hub, project.id, { githubRepoId: repo.id, gitRemoteUrl });
  }
  return repo;
}

/** Matches repos by GitHub ID, and by name when an ID is unknown. */
function matcher(repos: (GithubRepo | null)[]) {
  const ids = new Set(repos.map((repo) => repo?.id));
  const names = new Set(repos.map((repo) => repo?.repo.toLowerCase()));
  return (repo: GithubRepo | null) => Boolean(repo && ((repo.id && ids.has(repo.id)) || names.has(repo.repo.toLowerCase())));
}

/** Recently updated repos on this Mac and GitHub that no project uses yet. A repo on both shows once, as the Mac folder, since it needs no clone. */
export async function repoSuggestions(deps: AppDeps): Promise<{ githubConnected: boolean; repos: RepoSuggestion[] }> {
  const token = await macGithubToken() || null;
  const [mac, github] = await Promise.all([localRepos(LIMIT * 2), githubRepos(deps, token)]);
  for (const repo of github.repos) if (repo.id) known.set(repo.repo.toLowerCase(), Promise.resolve(repo)).set(`#${repo.id}`, Promise.resolve(repo));
  const projects = listPublicProjects(deps.db);
  const paths = new Set(listProjectSourcesByProjectIds(deps.db, projects.map((project) => project.id)).map((source) => source.path.toLowerCase()));
  const macRemote = (remote: string | null) => {
    const name = repoName(remote);
    return name ? lookup(name, token).then((repo) => repo ?? { id: null, repo: name }) : null;
  };
  const [used, onMac] = await Promise.all([
    Promise.all(projects.map((project) => projectRepo(deps, project, token))),
    Promise.all(mac.map((repo) => macRemote(repo.remote))),
  ]);
  const isUsed = matcher(used), isOnMac = matcher(onMac);
  const macRepos = mac.filter((repo, index) => !paths.has(repo.path.toLowerCase()) && !isUsed(onMac[index] ?? null));
  const githubOnly = github.repos.filter((repo) => !isUsed(repo) && !isOnMac(repo));
  return {
    githubConnected: github.connected,
    repos: [
      ...macRepos.slice(0, LIMIT).map(({ name, path, updatedAt }) => ({ source: "mac" as const, name, path, updatedAt })),
      ...githubOnly.slice(0, LIMIT).map(({ repo, updatedAt }) => ({ source: "github" as const, name: repo.split("/")[1] ?? repo, repo, updatedAt })),
    ],
  };
}

/** Makes a GitHub repo a project right away, with no clone. Each machine or sandbox clones it when a thread there first needs it.
 *  Returns the existing project if one already uses the repo, and shows it again if it was hidden. */
export async function addGithubRepo(deps: AppDeps, repo: string): Promise<{ projectId: string }> {
  const token = await macGithubToken() || null;
  const found = await lookup(repo.toLowerCase(), token);
  const isRepo = matcher([found ?? { id: null, repo }]);
  const projects = listPublicProjects(deps.db, "all");
  const existing = projects[(await Promise.all(projects.map((project) => projectRepo(deps, project, token)))).findIndex(isRepo)];
  if (existing) {
    setProjectHidden(deps.db, deps.hub, existing.id, false);
    return { projectId: existing.id };
  }
  const name = found?.repo ?? repo;
  return { projectId: createRemoteProject(deps.db, deps.hub, { name: name.split("/")[1] ?? name, gitRemoteUrl: `https://github.com/${name}.git`, ...(found?.id ? { githubRepoId: found.id } : {}) }).id };
}

const branchListSchema = z.array(z.object({ name: z.string() }));
const BRANCH_PAGES = 10;

/** A project's branches on GitHub, for the Cloud branch picker when no Mac folder lists them (ADR 0181). Empty when GitHub can't be read. */
export async function githubBranches(projectId: string, deps: AppDeps): Promise<{ defaultBranch: string | null; branches: string[] }> {
  const repo = githubRepository(getProject(deps.db, projectId)?.gitRemoteUrl ?? null)?.replace(/\.git$/, "");
  if (!repo) return { defaultBranch: null, branches: [] };
  const token = await macGithubToken();
  const read = (path: string) => fetch(repo.replace("https://github.com/", "https://api.github.com/repos/") + path, {
    headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(10_000),
  }).then((response) => response.ok ? response.json().catch(() => null) : null, () => null);
  const listBranches = async () => {
    const names: string[] = [];
    for (let page = 1; page <= BRANCH_PAGES; page++) {
      const list = branchListSchema.safeParse(await read(`/branches?per_page=100&page=${page}`));
      if (!list.success) break;
      names.push(...list.data.map((branch) => branch.name));
      if (list.data.length < 100) break;
    }
    return names;
  };
  const [info, branches] = await Promise.all([read(""), listBranches()]);
  const defaultBranch = z.object({ default_branch: z.string() }).safeParse(info);
  return { defaultBranch: defaultBranch.success ? defaultBranch.data.default_branch : null, branches };
}
