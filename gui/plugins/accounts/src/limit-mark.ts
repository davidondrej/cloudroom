import type { PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { claudeWindowKey, type ClaudeUsage } from "./claude.js";
import type { UsageWindow } from "./contract.js";

// Older marks and providers without a named window store just the reset time.
export const limitMarkSchema = z.union([
  z.number(),
  z.object({
    until: z.number(),
    windowKey: z.string(),
    blockedAt: z.number().optional(),
    windowReset: z.number().optional(),
    usedPercent: z.number().optional(),
    model: z.string().optional(),
  }),
]);
type Mark = z.infer<typeof limitMarkSchema>;

export function limitMark(
  rateLimits: PluginTurnFailedEvent["rateLimits"],
  previous: UsageWindow[] = [],
): Mark {
  const windows = rateLimits?.windows ?? [];
  const blocked = windows.filter((window) => window.status === "blocked");
  const resets = (blocked.length ? blocked : windows).flatMap((window) =>
    window.resetsAtMs === null ? [] : [window.resetsAtMs],
  );
  const until = resets.length ? Math.max(...resets) : Date.now() + 60 * 60_000;
  const key = blocked.length === 1 ? blocked[0]?.providerKey : null;
  if (rateLimits?.providerId !== "claude-code" || !key) return until;
  // Token-only logins may not get another reading until after an upgrade.
  const full = previous.find(
    (w) =>
      claudeWindowKey(w) === key &&
      Math.round(w.usedPercent) >= 100 &&
      w.resetsAt !== null &&
      Math.abs(w.resetsAt - until) < 1000,
  );
  const mark = { until, windowKey: key, blockedAt: Date.now() };
  return full
    ? { ...mark, usedPercent: full.usedPercent, ...(full.model ? { model: full.model } : {}) }
    : mark;
}

export function afterUsage(mark: Mark, read: ClaudeUsage, atFailure: boolean): Mark | null {
  if ((typeof mark === "number" ? mark : mark.until) <= Date.now()) return null;
  if (typeof mark === "number") return mark;
  const allowed = read.allowedWindows?.includes(mark.windowKey);
  if (read.unconfirmed && mark.windowKey !== "overage") return mark;
  if (!atFailure && allowed) return null;

  const window =
    mark.windowKey === "seven_day_overage_included" && read.includedPercent != null
      ? { usedPercent: read.includedPercent, resetsAt: mark.until, model: null }
      : read.windows.find((item) => claudeWindowKey(item) === mark.windowKey);
  if (!window) {
    // The account endpoint used to list this model and explicitly returned a list without it.
    return !atFailure &&
      mark.model &&
      read.reportedModels &&
      !read.reportedModels.includes(mark.model)
      ? null
      : mark;
  }
  const { usedPercent, resetsAt, model } = window;
  // The reading triggered by the rejection establishes a baseline, even if it already says 98%.
  const unused = usedPercent === 0 && resetsAt === null;
  const duration = mark.windowKey === "five_hour" ? 5 * 3_600_000 : 7 * 86_400_000;
  const newWindow =
    resetsAt != null &&
    mark.blockedAt != null &&
    resetsAt > (mark.windowReset ?? mark.until) + 1000 &&
    resetsAt - duration > mark.blockedAt + 1000;
  if (
    !atFailure &&
    Math.round(usedPercent) < 100 &&
    (unused || newWindow || (mark.usedPercent !== undefined && usedPercent < mark.usedPercent))
  )
    return null;
  if (
    mark.usedPercent === undefined ||
    usedPercent > mark.usedPercent ||
    (atFailure &&
      (usedPercent !== mark.usedPercent || (resetsAt != null && mark.windowReset !== resetsAt))) ||
    (model && !mark.model)
  )
    return {
      ...mark,
      usedPercent,
      ...(resetsAt != null ? { windowReset: resetsAt } : {}),
      ...(model ? { model } : {}),
    };
  return mark;
}
