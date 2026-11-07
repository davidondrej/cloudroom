import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAppSettings, getProject } from "@cloudroom/db";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { cloudroomSystemPrompt } from "../threads/custom-instructions.js";
import { envRefusal, githubRepository, localFiles, localProjectPath, pack, workspaceId, workspaceName } from "./project-copy.js";

type Deps = Pick<AppDeps, "db" | "hub" | "config">;
// The web's limit for a loop's packed .env files (web/lib/cloud-start.ts ENV_LIMIT).
const ENV_LIMIT = 256_000;

/** A project's .env files on this Mac, packed like a Cloud thread's copy: base64 of a .tgz. Empty when the folder has
 *  none, or when they are other projects' secrets (#1120), so a copy saved before is replaced; null when there is no folder
 *  or it can't be read, so nothing replaces the loops' saved copy. */
async function packedEnv(root: string | undefined, repository: string | null): Promise<string | null> {
  if (!root) return null;
  if (envRefusal(root, repository)) return "";
  const files = await localFiles(root, "env").catch(() => null);
  if (files === null) return null;
  if (!files.length) return "";
  const dir = await mkdtemp(join(tmpdir(), "cloudroom-loop-env-"));
  try {
    await pack(root, files, join(dir, "env.tgz"));
    const env = (await readFile(join(dir, "env.tgz"))).toString("base64");
    if (env.length > ENV_LIMIT) throw new ApiError(400, "cloud_automation", "The project's .env files are too large to copy (over 190 KB).");
    return env;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** What a Cloud loop made from a project needs, which a Cloud thread start sends too (ADR 20261101-004659): its GitHub repo,
 *  folder, .env files, and the app's system prompt and guards. The website adds the agent. */
export async function projectLoopSettings(deps: Deps, projectId: string, vps: boolean): Promise<Record<string, unknown>> {
  const project = getProject(deps.db, projectId);
  if (!project) throw new ApiError(404, "cloud_automation", "Project not found.");
  const repository = githubRepository(project.gitRemoteUrl);
  if (!repository) throw new ApiError(400, "cloud_automation", "This project is not on GitHub. Create its Cloud loop from a Cloud thread in it instead.");
  const settings = getAppSettings(deps.db), systemPrompt = cloudroomSystemPrompt(deps.db, { vps });
  const env = await packedEnv(localProjectPath(deps, project.id), repository);
  return {
    repository, workspace: workspaceId(project.id), folder: workspaceName(project.name), project_name: project.name,
    ...(env === null ? {} : { env }),
    start: { command_guard_enabled: settings.commandGuardEnabled, strip_ai_co_authors: settings.stripAiCoAuthorsEnabled, ...(systemPrompt ? { system_prompt: systemPrompt } : {}) },
  };
}

const sentEnv = new Map<string, string>();
/** At each Cloud thread start in a project, its loops get the project's current .env files, sent only when they
 *  changed since the last send (fixes #680). Never blocks or fails the start. */
export function syncLoopEnv(deps: Deps, sandboxes: { automations(body: Record<string, unknown>): Promise<unknown> }, projectId: string | null | undefined): void {
  if (!projectId) return;
  void (async () => {
    const root = localProjectPath(deps, projectId);
    if (!root) return;
    const env = await packedEnv(root, githubRepository(getProject(deps.db, projectId)?.gitRemoteUrl ?? null));
    if (env === null) return;
    const hash = createHash("sha256").update(env).digest("hex");
    if (sentEnv.get(projectId) === hash) return;
    await sandboxes.automations({ action: "env", project: projectId, env });
    sentEnv.set(projectId, hash);
  })().catch((error: unknown) => console.warn(`The project's loops did not get its .env files: ${error instanceof Error ? error.message : String(error)}`));
}
