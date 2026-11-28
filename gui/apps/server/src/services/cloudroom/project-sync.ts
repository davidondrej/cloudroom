// Lazy project catalog sync to the website (`/api/desktop/projects`) so the Mac-off PWA
// can list every project and start new Cloud threads without waking an old sandbox.
// Privacy boundary: startup/edit sync sends metadata only (names, repo URLs, defaults, start settings).
// Packed `.env` files are ONLY sent when the user starts a Cloud thread in that project.
import { createHash } from "node:crypto";
import { getAppSettings, getProjectExecutionDefaults, listPublicProjects } from "@cloudroom/db";
import type { AppDeps } from "../../types.js";
import { cloudroomSystemPrompt } from "../threads/custom-instructions.js";
import { cloudroom } from "./commands.js";
import { cloudRepository, localProjectPath, workspaceId, workspaceName } from "./project-copy.js";
import { packedEnv } from "./project-loops.js";
import type { SandboxDirectory } from "./sandboxes.js";

type Deps = Pick<AppDeps, "db" | "hub" | "config">;
type ProjectSender = Pick<SandboxDirectory, "account" | "projects">;

type SyncPayload = {
  project_id: string;
  name: string;
  repository: string | null;
  folder: string;
  workspace: string;
  default_harness: string | null;
  default_model: string | null;
  default_reasoning: string | null;
  start: {
    command_guard_enabled: boolean;
    strip_ai_co_authors: boolean;
    system_prompt?: string;
  };
  env?: string;
};

const sentDigests = new Map<string, string>();
const digestKey = (userId: string, projectId: string, withEnv: boolean) => `${userId}:${projectId}:${withEnv ? "env" : "meta"}`;
const payloadDigest = (payload: SyncPayload) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");

function startSettingsFor(deps: Deps): SyncPayload["start"] {
  const settings = getAppSettings(deps.db);
  const systemPrompt = cloudroomSystemPrompt(deps.db, "cloud");
  return {
    command_guard_enabled: settings.commandGuardEnabled,
    strip_ai_co_authors: settings.stripAiCoAuthorsEnabled,
    ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
  };
}

function buildMetadataPayload(
  deps: Deps,
  project: { id: string; name: string; gitRemoteUrl: string | null },
  start: SyncPayload["start"],
): SyncPayload {
  const defaults = getProjectExecutionDefaults(deps.db, { projectId: project.id });
  return {
    project_id: project.id,
    name: project.name,
    repository: cloudRepository(project.gitRemoteUrl),
    folder: workspaceName(project.name),
    workspace: workspaceId(project.id),
    default_harness: defaults?.providerId ?? null,
    default_model: defaults?.model ?? null,
    default_reasoning: defaults?.reasoningLevel ?? null,
    start,
  };
}

/** Syncs metadata for visible standard projects on app startup or sign-in (never packs or uploads `.env` files). */
export function syncAllProjectsToCloud(deps: Deps, sandboxes: ProjectSender): void {
  void (async () => {
    const account = await sandboxes.account().catch(() => null);
    if (!account) return;
    const projects = listPublicProjects(deps.db);
    if (!projects.length) return;
    const start = startSettingsFor(deps);
    const changed: Array<{ payload: SyncPayload; hash: string }> = [];
    for (const project of projects) {
      const payload = buildMetadataPayload(deps, project, start);
      const hash = payloadDigest(payload);
      if (sentDigests.get(digestKey(account.userId, project.id, false)) === hash) continue;
      changed.push({ payload, hash });
    }
    if (!changed.length) return;
    await sandboxes.projects({ action: "sync", projects: changed.map((item) => item.payload) });
    for (const item of changed) sentDigests.set(digestKey(account.userId, item.payload.project_id, false), item.hash);
  })().catch(() => {});
}

/** Syncs metadata for one project after create/update/source mutations (never uploads `.env` files). */
export function syncProjectToCloud(deps: Deps, projectId: string | null | undefined, sandboxes?: ProjectSender): void {
  if (!projectId) return;
  void (async () => {
    const target = sandboxes ?? cloudroom(deps as AppDeps).sandboxes;
    const account = await target.account().catch(() => null);
    if (!account) return;
    const project = listPublicProjects(deps.db).find((row) => row.id === projectId);
    if (!project) return;
    const payload = buildMetadataPayload(deps, project, startSettingsFor(deps));
    const hash = payloadDigest(payload);
    const key = digestKey(account.userId, project.id, false);
    if (sentDigests.get(key) === hash) return;
    await target.projects({ action: "upsert", project: payload });
    sentDigests.set(key, hash);
  })().catch(() => {});
}

/** Syncs metadata plus packed `.env` for a project ONLY when a Cloud thread starts in it (same trust boundary as syncLoopEnv). */
export function syncProjectWithEnvToCloud(deps: Deps, projectId: string | null | undefined, sandboxes?: ProjectSender): void {
  if (!projectId) return;
  void (async () => {
    const target = sandboxes ?? cloudroom(deps as AppDeps).sandboxes;
    const account = await target.account().catch(() => null);
    if (!account) return;
    const project = listPublicProjects(deps.db).find((row) => row.id === projectId);
    if (!project) return;
    const base = buildMetadataPayload(deps, project, startSettingsFor(deps));
    const root = localProjectPath(deps, project.id);
    const env = await packedEnv(root, base.repository).catch(() => null);
    const payload: SyncPayload = { ...base, ...(env !== null ? { env } : {}) };
    const hash = payloadDigest(payload);
    const key = digestKey(account.userId, project.id, true);
    if (sentDigests.get(key) === hash) return;
    await target.projects({ action: "upsert", project: payload });
    sentDigests.set(key, hash);
  })().catch(() => {});
}

/** Removes a deleted or hidden project from the account's cloud catalog. Never throws. */
export function deleteProjectFromCloud(deps: Deps, projectId: string, sandboxes?: ProjectSender): void {
  if (!projectId) return;
  void (async () => {
    const target = sandboxes ?? cloudroom(deps as AppDeps).sandboxes;
    const account = await target.account().catch(() => null);
    if (!account) return;
    sentDigests.delete(digestKey(account.userId, projectId, false));
    sentDigests.delete(digestKey(account.userId, projectId, true));
    await target.projects({ action: "delete", project_id: projectId });
  })().catch(() => {});
}
