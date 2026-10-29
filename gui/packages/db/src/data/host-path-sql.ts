import {
  areHostPathsEqual,
  getHostPathComparisonKey,
  isHostPathWithin,
  isWindowsHostPath,
} from "@cloudroom/domain";
import type Database from "better-sqlite3";
import { eq, or, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

function hostPathComparisonKeyForSql(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return getHostPathComparisonKey(value) ?? value;
}

function windowsHostPathContainsForSql(
  rootPath: unknown,
  candidatePath: unknown,
): number {
  return typeof rootPath === "string" &&
    typeof candidatePath === "string" &&
    isHostPathWithin({ rootPath, candidatePath })
    ? 1
    : 0;
}

export function registerHostPathSqlFunctions(sqlite: Database.Database): void {
  sqlite.function(
    "bb_host_path_key",
    { deterministic: true },
    hostPathComparisonKeyForSql,
  );
  sqlite.function(
    "bb_host_path_contains",
    { deterministic: true },
    windowsHostPathContainsForSql,
  );
}

export function hostPathEquals(column: SQLiteColumn, path: string): SQL {
  return isWindowsHostPath(path)
    ? sql`bb_host_path_key(${column}) = ${getHostPathComparisonKey(path) ?? path}`
    : eq(column, path);
}

export function hostPathContains(column: SQLiteColumn, path: string): SQL {
  return isWindowsHostPath(path)
    ? sql`bb_host_path_contains(${column}, ${path}) = 1`
    : or(eq(column, path), sql`${path} LIKE ${column} || '/%'`)!;
}

export function sameHostPath(left: string, right: string): boolean {
  return isWindowsHostPath(right) ? areHostPathsEqual(left, right) : left === right;
}
