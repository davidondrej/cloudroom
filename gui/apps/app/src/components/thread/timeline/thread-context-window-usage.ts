import type { ThreadContextWindowUsage } from "@cloudroom/server-contract";

const TOKEN_COMPACT_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 0,
});

export function calculateContextWindowUsagePercent(
  usage: ThreadContextWindowUsage,
): number {
  if (usage.modelContextWindow <= 0) return 0;
  const ratio = usage.usedTokens / usage.modelContextWindow;
  const clampedRatio = Math.min(Math.max(ratio, 0), 1);
  return Math.round(clampedRatio * 100);
}

export function formatCompactTokenCount(value: number): string {
  const safeValue = Math.max(0, Math.round(value));
  return TOKEN_COMPACT_FORMATTER.format(safeValue).toLowerCase();
}

/** Tokens the last turn added. Zero right after a compaction. */
export function lastTurnContextTokens(usage: ThreadContextWindowUsage): number {
  const history = usage.history ?? [];
  const last = history[history.length - 1];
  if (last === undefined) return 0;
  return Math.max(0, last - (history[history.length - 2] ?? 0));
}

/**
 * Turns left before the context fills or auto-compacts, at the pace since the
 * last compaction. Null until two turns show a pace.
 */
export function estimateContextTurnsLeft(
  usage: ThreadContextWindowUsage,
): number | null {
  const history = usage.history ?? [];
  let start = 0;
  for (let index = 1; index < history.length; index++) {
    if ((history[index] ?? 0) < (history[index - 1] ?? 0)) start = index;
  }
  const turns = history.length - 1 - start;
  if (turns < 1) return null;
  const perTurn =
    ((history[history.length - 1] ?? 0) - (history[start] ?? 0)) / turns;
  if (perTurn <= 0) return null;
  const limit = usage.snapshot?.autoCompactAtTokens ?? usage.modelContextWindow;
  return Math.max(0, Math.floor((limit - usage.usedTokens) / perTurn));
}
