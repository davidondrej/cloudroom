import {
  PERSONAL_PROJECT_ID,
  threadListEntrySchema,
  type Thread,
} from "@cloudroom/domain";
import {
  columnWidths,
  printBorderlessTable,
  truncateCell,
} from "../../table.js";
import { joinValues } from "../helpers.js";

/** Keeps only the named keys of each thread, so a script or agent reads just what it needs. */
export function pickFields(
  threads: readonly object[],
  fields: string,
): Record<string, unknown>[] {
  const keys = fields
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  if (keys.length === 0) {
    throw new Error(
      "--fields needs at least one key, such as id,title,status.",
    );
  }
  const rows = threads.map((thread) => thread as Record<string, unknown>);
  // The schema's keys count too: a row leaves out keys that do not apply to it, such as executionTarget.
  const known = new Set([
    ...Object.keys(threadListEntrySchema.shape),
    ...rows.flatMap((row) => Object.keys(row)),
  ]);
  const unknown = keys.filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown --fields key ${joinValues(unknown)}. Available: ${[...known].sort().join(", ")}.`,
    );
  }
  return rows.map((row) =>
    Object.fromEntries(keys.map((key) => [key, row[key] ?? null])),
  );
}

/** A valid JSON array with one compact row per line: small, and easy to grep. */
export function printJsonLines(rows: readonly unknown[]): void {
  console.log(`[\n${rows.map((row) => JSON.stringify(row)).join(",\n")}\n]`);
}

const MAX_TITLE_WIDTH = 60;

export function printThreadTable(
  threads: Thread[],
  projectNames: ReadonlyMap<string, string>,
): void {
  const rows = threads.map((thread) => [
    `@thread:${thread.id}`,
    truncateCell(formatThreadListTitle(thread), MAX_TITLE_WIDTH),
    formatThreadListProject(thread, projectNames),
    formatThreadListStatus(thread),
    formatAge(thread.updatedAt),
  ]);
  printBorderlessTable(
    {
      head: ["ID", "Title", "Project", "Status", "Updated"],
      colWidths: columnWidths(rows, [4, 5, 7, 12, 7]),
    },
    rows,
  );
}

function formatThreadListTitle(thread: Thread): string {
  const title = thread.title?.trim();
  if (title) return title;
  const fallback = thread.titleFallback?.trim();
  if (fallback) return fallback;
  return "-";
}

function formatThreadListProject(
  thread: Thread,
  projectNames: ReadonlyMap<string, string>,
): string {
  if (thread.projectId === PERSONAL_PROJECT_ID) return "-";
  return projectNames.get(thread.projectId) ?? thread.projectId;
}

function formatThreadListStatus(thread: Thread): string {
  const flags: string[] = [];
  if (thread.archivedAt !== null) {
    flags.push("archived");
  }
  if (thread.pinnedAt !== null) {
    flags.push("pinned");
  }
  if (flags.length === 0) {
    return thread.status;
  }
  return `${thread.status} (${flags.join(", ")})`;
}

/** Time since the thread last changed: now, 5m, 3h, or 2d. */
function formatAge(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (60 * 24))}d`;
}
