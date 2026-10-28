import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { and, asc, eq, gte, isNull, notLike } from "drizzle-orm";
import { events, projects, threads } from "@cloudroom/db";
import { folderOpenerCommand } from "@cloudroom/process-utils";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { threadMessages } from "../threads/thread-transcript.js";

// docs/scopes/chat-export.md owns the file format.
export type ChatExportInput = { scope: "all" | "local" | "cloud"; days: number | null; format: "markdown" | "json" };
type ExportedThread = ReturnType<typeof exportedThreads>[number];

const day = (ms: number) => new Date(ms).toLocaleDateString("sv-SE");
const safeName = (text: string) => text.replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled";
const unique = (path: string, ext = "") => {
  let target = `${path}${ext}`;
  for (let copy = 2; existsSync(target); copy++) target = `${path} ${copy}${ext}`;
  return target;
};

function exportedThreads(deps: Pick<AppDeps, "db">, { scope, days }: Omit<ChatExportInput, "format">) {
  return deps.db.select({
    id: threads.id, title: threads.title, titleFallback: threads.titleFallback, target: threads.executionTarget,
    harness: threads.providerId, project: projects.name, createdAt: threads.createdAt, updatedAt: threads.updatedAt,
  }).from(threads).leftJoin(projects, eq(projects.id, threads.projectId)).where(and(
    isNull(threads.deletedAt),
    eq(threads.visibility, "visible"),
    scope === "all" ? undefined : eq(threads.executionTarget, scope),
    days === null ? undefined : gte(threads.updatedAt, Date.now() - days * 86_400_000),
  )).orderBy(asc(threads.createdAt)).all();
}

/** Every exportable thread, archived ones included. The Settings page counts them by place and age. */
export function exportableChats(deps: Pick<AppDeps, "db">): { target: "local" | "cloud"; updatedAt: number }[] {
  return exportedThreads(deps, { scope: "all", days: null }).map(({ target, updatedAt }) => ({ target, updatedAt }));
}

function markdown(deps: Pick<AppDeps, "db">, thread: ExportedThread, title: string): string {
  const info = `${thread.project ?? "No project"} · ${thread.target === "cloud" ? "Cloud" : "Local"} thread · ${thread.harness} · ${day(thread.createdAt)}`;
  const messages = threadMessages(deps.db, thread.id).map((message) => `## ${message.role === "user" ? "You" : "Agent"}\n\n${message.text}`);
  return `${[`# ${title}`, info, ...messages].join("\n\n")}\n`;
}

// The thread's saved history as stored, without streaming deltas (SQLite LIKE ignores case: matches textDelta too).
function json(deps: Pick<AppDeps, "db">, thread: ExportedThread, title: string): string {
  const history = deps.db.select({ type: events.type, itemKind: events.itemKind, data: events.data, createdAt: events.createdAt }).from(events)
    .where(and(eq(events.threadId, thread.id), notLike(events.type, "%delta"))).orderBy(asc(events.sequence)).all();
  return JSON.stringify({ ...thread, title, events: history.map((event) => ({ ...event, data: JSON.parse(event.data) as unknown })) }, null, 2);
}

/** Writes one file per thread into a new folder in ~/Downloads, one subfolder per project, then opens it. */
export async function exportChats(deps: Pick<AppDeps, "db">, input: ChatExportInput): Promise<{ folder: string; count: number }> {
  const list = exportedThreads(deps, input);
  if (!list.length) throw new ApiError(409, "nothing_to_export", "No chats to export.");
  const folder = unique(join(homedir(), "Downloads", `Cloudroom chats ${day(Date.now())}`));
  const ext = input.format === "json" ? ".json" : ".md";
  for (const thread of list) {
    const title = thread.title || thread.titleFallback || "Untitled thread";
    const dir = join(folder, safeName(thread.project ?? "No project"));
    await mkdir(dir, { recursive: true });
    await writeFile(unique(join(dir, `${day(thread.createdAt)} ${safeName(title)}`), ext), (input.format === "json" ? json : markdown)(deps, thread, title));
  }
  await promisify(execFile)(folderOpenerCommand(), [folder]).catch(() => {});
  return { folder, count: list.length };
}
