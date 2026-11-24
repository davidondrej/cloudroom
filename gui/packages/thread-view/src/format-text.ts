import type { TimelineRow, TimelineRowStatus } from "@cloudroom/server-contract";
import {
  formatTimelineActivityIntentDetail,
  getTimelineActivityIntentDetailDedupeKey,
  hasTimelineExplorationIntent,
  timelineRowActivityIntents,
  type TimelineExplorationWorkRow,
} from "./intents.js";
import {
  buildTimelineRowTitle,
  findActiveLatestBundleId,
} from "./titles.js";
import { assertNever } from "./utils.js";
import {
  buildTimelineViewRows,
  buildTimelineWorkSummaryLabel,
  type ThreadTimelineViewRow,
  type TimelineViewWorkRow,
  type TimelineWorkSummaryRow,
} from "./view.js";

export type ThreadTimelineTextFormat = "json" | "minimal" | "verbose";

interface FormatContext {
  verbose: boolean;
  color: boolean;
  depth: number;
  activeLatestBundleId: string | null;
}

const ansi = (code: number, reset: number, text: string, color: boolean) =>
  color ? `\x1b[${code}m${text}\x1b[${reset}m` : text;
const dim = (t: string, c: boolean) => ansi(2, 22, t, c);
const green = (t: string, c: boolean) => ansi(32, 39, t, c);
const yellow = (t: string, c: boolean) => ansi(33, 39, t, c);
const red = (t: string, c: boolean) => ansi(31, 39, t, c);
const cyan = (t: string, c: boolean) => ansi(36, 39, t, c);

function rowHeader(label: string, ctx: FormatContext): string {
  if (ctx.depth > 0) return dim(`── ${label}`, ctx.color);
  const pad = Math.max(0, 60 - label.length - 4);
  return dim(pad > 0 ? `── ${label} ${"─".repeat(pad)}` : `── ${label}`, ctx.color);
}

function indent(text: string, prefix = "  "): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? "" : `${prefix}${line}`))
    .join("\n");
}

function statusText(status: TimelineRowStatus, color: boolean): string {
  switch (status) {
    case "pending":
      return yellow("running", color);
    case "completed":
      return green("completed", color);
    case "error":
      return red("error", color);
    case "interrupted":
      return yellow("interrupted", color);
    default:
      return assertNever(status);
  }
}

function workStatusText(row: TimelineViewWorkRow, color: boolean): string {
  if (
    (row.workKind === "command" ||
      row.workKind === "tool" ||
      row.workKind === "file-change") &&
    row.approvalStatus !== null
  ) {
    return row.approvalStatus === "denied"
      ? red("denied", color)
      : yellow("waiting", color);
  }
  return statusText(row.status, color);
}

function rowTitle(row: ThreadTimelineViewRow, ctx: FormatContext): string {
  return buildTimelineRowTitle(row, {
    summaryStyle: "bundle",
    workStyle: "default",
    isActiveLatestBundle:
      row.kind === "bundle-summary" && row.id === ctx.activeLatestBundleId,
  }).plain;
}

function nestedCtx(
  ctx: FormatContext,
  rows: readonly ThreadTimelineViewRow[] | null,
): FormatContext {
  return {
    ...ctx,
    depth: ctx.depth + 1,
    activeLatestBundleId: rows ? findActiveLatestBundleId(rows) : null,
  };
}

function formatWorkBody(row: TimelineViewWorkRow, ctx: FormatContext): string[] {
  const lines: string[] = [];
  switch (row.workKind) {
    case "command":
      lines.push(`  $ ${cyan(row.command, ctx.color)}`);
      if (ctx.verbose && row.output.trim() && !hasTimelineExplorationIntent(row)) {
        lines.push(dim(indent(row.output.trim()), ctx.color));
      }
      if (row.exitCode !== null && row.status !== "pending") {
        if (row.exitCode !== 0) {
          lines.push(dim(`  exit ${row.exitCode}`, ctx.color));
        } else if (row.output.trim().length === 0) {
          lines.push(dim("  exit code 0", ctx.color));
        }
      }
      return lines;
    case "tool":
      if (row.approvalStatus !== null) {
        lines.push(`  ${workStatusText(row, ctx.color)}`);
      }
      if (ctx.verbose && row.output.trim()) {
        lines.push(dim(indent(row.output.trim()), ctx.color));
      }
      return lines;
    case "file-change":
      if (row.approvalStatus !== null) {
        lines.push(`  ${workStatusText(row, ctx.color)}`);
      }
      if (ctx.verbose && row.change.diff) {
        lines.push(dim(indent(row.change.diff.trimEnd()), ctx.color));
      }
      return lines;
    case "plan-steps":
      if (ctx.verbose) {
        const markers = { completed: "[x]", active: "[>]", failed: "[!]", pending: "[ ]" };
        for (const step of row.steps) {
          lines.push(dim(`  ${markers[step.status ?? "pending"]} ${step.step}`, ctx.color));
        }
      }
      return lines;
    case "extension":
      if (row.presentation.detail?.trim()) {
        lines.push(dim(indent(row.presentation.detail), ctx.color));
      }
      return lines;
    case "delegation":
      if (row.childRows.length > 0) {
        lines.push(indent(formatRows(row.childRows, nestedCtx(ctx, row.childRows))));
      }
      return lines;
    case "web-search":
    case "web-fetch":
    case "image-generation":
    case "image-view":
    case "file-read":
    case "search":
    case "approval":
    case "question":
    case "workflow":
      return lines;
    default:
      return assertNever(row);
  }
}

function formatWorkRow(row: TimelineViewWorkRow, ctx: FormatContext): string {
  return [rowHeader(rowTitle(row, ctx), ctx), ...formatWorkBody(row, ctx)].join(
    "\n",
  );
}

function formatExplorationDetails(row: TimelineExplorationWorkRow): string[] {
  let lastKey: string | null = null;
  const details: string[] = [];
  for (const intent of timelineRowActivityIntents(row)) {
    if (intent.type === "unknown") continue;
    const key = getTimelineActivityIntentDetailDedupeKey(intent);
    if (key !== null && key === lastKey) continue;
    details.push(
      formatTimelineActivityIntentDetail(intent, "full", row.status === "pending"),
    );
    lastKey = key;
  }
  return details;
}

function formatSummaryRow(row: TimelineWorkSummaryRow, ctx: FormatContext): string {
  const isActive =
    row.kind === "bundle-summary" && row.id === ctx.activeLatestBundleId;
  const lines = [
    rowHeader(buildTimelineWorkSummaryLabel(row, { active: isActive }), ctx),
  ];
  if (ctx.verbose || row.kind === "bundle-summary") {
    const childCtx = nestedCtx(ctx, null);
    const details: string[] = [];
    for (const child of row.children) {
      if (child.kind === "system") {
        details.push(formatRow(child, childCtx));
      } else if (
        (child.workKind === "command" ||
          child.workKind === "file-read" ||
          child.workKind === "search") &&
        hasTimelineExplorationIntent(child)
      ) {
        for (const d of formatExplorationDetails(child)) {
          details.push(rowHeader(d, childCtx));
        }
      } else if (
        child.workKind === "web-search" ||
        child.workKind === "web-fetch" ||
        child.workKind === "image-view" ||
        child.workKind === "plan-steps" ||
        child.workKind === "extension"
      ) {
        details.push(rowHeader(rowTitle(child, childCtx), childCtx));
      } else {
        details.push(formatWorkRow(child, childCtx));
      }
    }
    if (details.length > 0) lines.push(indent(details.join("\n")));
  }
  return lines.join("\n");
}

function formatRow(row: ThreadTimelineViewRow, ctx: FormatContext): string {
  switch (row.kind) {
    case "conversation": {
      const steerLabel =
        row.role === "user" && row.turnRequest.kind === "steer"
          ? row.turnRequest.status === "pending"
            ? "steer pending"
            : row.turnRequest.status === "rejected"
              ? "steer failed"
              : "steer"
          : null;
      return [
        rowHeader(row.role === "user" ? "User" : "Assistant", ctx),
        row.text,
        ...(steerLabel ? [steerLabel] : []),
      ].join("\n");
    }
    case "work":
      return formatWorkRow(row, ctx);
    case "system": {
      const parts =
        row.systemKind === "error"
          ? [
              rowHeader("Error", ctx),
              dim(indent(row.title), ctx.color),
              row.detail ? dim(indent(row.detail), ctx.color) : "",
            ]
          : [
              rowHeader(row.title, ctx),
              row.detail ? dim(indent(row.detail), ctx.color) : "",
            ];
      return parts.filter((p) => p.length > 0).join("\n");
    }
    case "bundle-summary":
    case "step-summary":
      return formatSummaryRow(row, ctx);
    case "turn": {
      const label = rowTitle(row, ctx);
      if (!row.children || row.children.length === 0) return rowHeader(label, ctx);
      return [
        rowHeader(label, ctx),
        indent(formatRows(row.children, nestedCtx(ctx, null))),
      ].join("\n");
    }
    default:
      return assertNever(row);
  }
}

function formatRows(
  rows: readonly ThreadTimelineViewRow[],
  ctx: FormatContext,
): string {
  return rows.map((row) => formatRow(row, ctx)).join("\n\n");
}

export function formatThreadTimelineText(
  rows: readonly TimelineRow[],
  options?: { verbose?: boolean; color?: boolean },
): string {
  const viewRows = buildTimelineViewRows(rows);
  return formatRows(viewRows, {
    verbose: options?.verbose ?? false,
    color: options?.color ?? false,
    depth: 0,
    activeLatestBundleId: findActiveLatestBundleId(viewRows),
  });
}
