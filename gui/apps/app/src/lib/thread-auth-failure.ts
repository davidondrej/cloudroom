import type { TimelineRow } from "@cloudroom/server-contract";
import { PROVIDER_AUTH_FAILED_TITLE } from "@cloudroom/thread-view";

export function hasThreadAuthFailure(rows: readonly TimelineRow[]): boolean {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row === undefined) continue;
    if (row.kind === "turn") return hasThreadAuthFailure(row.children ?? []);
    if (
      row.kind === "system" &&
      row.systemKind === "error" &&
      row.title === PROVIDER_AUTH_FAILED_TITLE
    ) {
      return true;
    }
  }
  return false;
}
