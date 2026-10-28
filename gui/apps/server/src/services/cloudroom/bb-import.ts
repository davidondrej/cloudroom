import { COMPUTER } from "@cloudroom/domain";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { findOrCreateProjectByLocalPathSource, getThread, type StoredEventRow } from "@cloudroom/db";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { createThreadFromRequest } from "../threads/thread-create.js";
import { fillProjectGitRemote } from "../projects/project-source-setup.js";
import { requireNonDestroyedHostWithStatus } from "../lib/entity-lookup.js";
import { assertUsableHostId } from "../hosts/primary-host.js";
import { INHERITED_EVENT_TYPES, selectInheritedHistoryRows } from "../threads/thread-fork-history.js";
import { parseStoredEvent } from "../threads/thread-data.js";
import { parseStoredTurnRequestEvent } from "../threads/thread-events.js";

export interface BbImportResult {
  imported: { bbThreadId: string; threadId: string; title: string }[];
  skipped: { bbThreadId: string; title: string; reason: string }[];
}

interface BbThread { id: string; title: string; providerId: string; path: string | null; projectName: string | null; environmentKind: string | null }

const BB_DB = join(homedir(), ".bb", "bb.db");
let running: Promise<BbImportResult> | null = null;

export function importBbThreads(deps: AppDeps, hostId: string): Promise<BbImportResult> {
  running ??= run(deps, hostId).finally(() => { running = null; });
  return running;
}

async function run(deps: AppDeps, hostId: string): Promise<BbImportResult> {
  if (!existsSync(BB_DB)) throw new ApiError(404, "bb_not_installed", `BB is not installed on this ${COMPUTER}.`);
  requireNonDestroyedHostWithStatus(deps, hostId);
  assertUsableHostId(deps, { hostId });
  await deps.providerRegistry.whenRegistrationsSettled();
  const mapPath = join(deps.config.dataDir, "bb-imports.json");
  const map: Record<string, string> = existsSync(mapPath) ? JSON.parse(await readFile(mapPath, "utf8")) : {};
  const bb = new Database(BB_DB, { readonly: true, fileMustExist: true });
  const result: BbImportResult = { imported: [], skipped: [] };
  try {
    for (const source of listOpenThreads(bb)) {
      const skip = (reason: string) => result.skipped.push({ bbThreadId: source.id, title: source.title, reason });
      const existing = map[source.id] ? getThread(deps.db, map[source.id]!) : null;
      if (existing && existing.deletedAt === null) { skip("Already imported."); continue; }
      if (source.environmentKind !== "project-checkout" || !source.path) { skip("Only project-checkout threads are supported."); continue; }
      if (!deps.providerRegistry.supportsFork(source.providerId)) { skip(`${source.providerId} cannot fork sessions.`); continue; }
      try {
        const thread = await importThread(deps, bb, source, hostId);
        map[source.id] = thread.id;
        await writeFile(mapPath, JSON.stringify(map, null, 2), { mode: 0o600 });
        const status = await waitForStart(deps, thread.id);
        if (status === "error") skip(`Copied to ${thread.id}, but it could not be set up. Open it to retry.`);
        else result.imported.push({ bbThreadId: source.id, threadId: thread.id, title: source.title });
      } catch (error) {
        skip(error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    bb.close();
  }
  return result;
}

export async function waitForStart(deps: AppDeps, threadId: string): Promise<string | undefined> {
  for (let waited = 0; waited < 120_000; waited += 500) {
    const status = getThread(deps.db, threadId)?.status;
    if (status !== "pending" && status !== "starting") return status;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return getThread(deps.db, threadId)?.status;
}

function listOpenThreads(bb: Database.Database): BbThread[] {
  return bb.prepare(`SELECT t.id, COALESCE(t.title, t.title_fallback, 'Imported thread') AS title, t.provider_id AS providerId,
      e.path, e.environment_provider_id AS environmentKind, p.name AS projectName
    FROM threads t LEFT JOIN environments e ON e.id = t.environment_id LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.archived_at IS NULL AND t.deleted_at IS NULL AND t.parent_thread_id IS NULL AND t.visibility = 'visible'
    ORDER BY t.updated_at`).all() as BbThread[];
}

async function importThread(deps: AppDeps, bb: Database.Database, source: BbThread, hostId: string) {
  const types = INHERITED_EVENT_TYPES.map(() => "?").join(", ");
  const rows = (bb.prepare(`SELECT id, type, data, turn_id AS turnId, item_id AS itemId, item_kind AS itemKind,
      parent_tool_call_id AS parentToolCallId, provider_thread_id AS providerThreadId, scope_kind AS scopeKind,
      sequence, created_at AS createdAt, thread_id AS threadId
    FROM events WHERE thread_id = ? AND type IN (${types}) ORDER BY sequence`).all(source.id, ...INHERITED_EVENT_TYPES) as StoredEventRow[])
    .map((row) => ({ ...row, id: "" }));
  const history = selectInheritedHistoryRows(rows);
  try {
    history.forEach(parseStoredEvent);
  } catch {
    throw new Error("BB history uses a format this Cloudroom version cannot read.");
  }
  const native = bb.prepare(`SELECT provider_thread_id AS id FROM events WHERE thread_id = ? AND provider_thread_id IS NOT NULL
    ORDER BY sequence DESC LIMIT 1`).get(source.id) as { id: string } | undefined;
  if (!native) throw new Error("No saved agent session to continue.");
  const lastRequest = history.filter((row) => row.type === "client/turn/requested").at(-1);
  const execution = lastRequest ? parseStoredTurnRequestEvent(lastRequest).execution : null;
  const { project } = findOrCreateProjectByLocalPathSource(deps.db, deps.hub, {
    name: source.projectName ?? source.path!.split("/").at(-1)!,
    source: { type: "local_path", hostId, path: source.path! },
  });
  await fillProjectGitRemote(deps, project, { hostId, path: source.path! });
  return createThreadFromRequest(deps, {
    projectId: project.id,
    providerId: source.providerId,
    title: source.title,
    environment: { type: "host", hostId, workspace: { type: "unmanaged", path: null } },
    input: [{ type: "text", text: `Imported from BB thread ${source.id}.`, mentions: [], visibility: "agent-only" }],
    origin: "sdk",
    startedOnBehalfOf: null,
    ...(execution?.model ? { model: execution.model } : {}),
    ...(execution?.reasoningLevel ? { reasoningLevel: execution.reasoningLevel } : {}),
    ...(execution?.serviceTier ? { serviceTier: execution.serviceTier } : {}),
  }, {
    providerInput: [],
    importedFork: { descriptor: { sourceProviderThreadId: native.id }, history: { kind: "rows", rows: history } },
  });
}
