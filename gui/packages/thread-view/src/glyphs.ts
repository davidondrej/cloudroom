import {
  isBackgroundAgentTaskType,
  isBackgroundCommandTaskType,
  isNamespacedGlyph,
} from "@cloudroom/domain";
import type { TimelineRowPresentation } from "@cloudroom/server-contract";
import { isSkillReadIntent, primaryTimelineActivityIntent } from "./intents.js";
import type { TimelineActivityIntentTitle } from "./titles.js";
import type { TimelineViewWorkRow } from "./view.js";

export type TimelineWorkRowGlyph =
  | "CircleQuestion"
  | "EditFile"
  | "File"
  | "FileText"
  | "Folder"
  | "Globe"
  | "ListTodo"
  | "Lock"
  | "Palette"
  | "Puzzle"
  | "Search"
  | "Terminal"
  | "UserRoundPlus"
  | "Zap";

const INTENT_GLYPHS: Record<
  "read" | "list_files" | "search",
  TimelineWorkRowGlyph
> = {
  search: "Search",
  read: "FileText",
  list_files: "Folder",
};

const WORK_KIND_GLYPHS: Record<
  Exclude<TimelineViewWorkRow["workKind"], "workflow">,
  TimelineWorkRowGlyph
> = {
  "file-change": "EditFile",
  command: "Terminal",
  tool: "Terminal",
  "file-read": "FileText",
  search: "Search",
  "plan-steps": "ListTodo",
  extension: "Puzzle",
  "web-search": "Search",
  "web-fetch": "Globe",
  "image-generation": "Palette",
  "image-view": "File",
  delegation: "UserRoundPlus",
  approval: "Lock",
  question: "CircleQuestion",
};

function isSkillReadCommandRow(row: TimelineViewWorkRow): boolean {
  return (
    row.workKind === "command" && row.activityIntents.some(isSkillReadIntent)
  );
}

export function activityIntentTitleGlyph(
  entry: TimelineActivityIntentTitle,
): TimelineWorkRowGlyph {
  return isSkillReadIntent(entry.intent)
    ? "Zap"
    : INTENT_GLYPHS[entry.intentType];
}

export function workRowPresentation(
  row: TimelineViewWorkRow,
): TimelineRowPresentation | undefined {
  return row.workKind === "approval" || row.workKind === "question"
    ? undefined
    : row.presentation;
}

function fallbackGlyphForWorkRow(
  row: TimelineViewWorkRow,
): TimelineWorkRowGlyph {
  if (
    row.workKind === "command" ||
    row.workKind === "file-read" ||
    row.workKind === "search"
  ) {
    const intent = primaryTimelineActivityIntent(row);
    if (intent && intent.type !== "unknown") {
      return INTENT_GLYPHS[intent.type];
    }
  }
  if (row.workKind === "workflow") {
    if (isBackgroundCommandTaskType(row.taskType)) return "Terminal";
    if (isBackgroundAgentTaskType(row.taskType)) return "UserRoundPlus";
    return "ListTodo";
  }
  return WORK_KIND_GLYPHS[row.workKind];
}

export function workRowGlyph<HostGlyph extends string>(
  row: TimelineViewWorkRow,
  isHostGlyph: (glyph: string) => glyph is HostGlyph,
): HostGlyph | TimelineWorkRowGlyph {
  if (isSkillReadCommandRow(row)) return "Zap";
  const presented = workRowPresentation(row)?.icon.glyph;
  if (presented !== undefined && isHostGlyph(presented)) return presented;
  return fallbackGlyphForWorkRow(row);
}

export function workRowPluginGlyph(
  row: TimelineViewWorkRow,
): string | undefined {
  if (isSkillReadCommandRow(row)) return undefined;
  const presented = workRowPresentation(row)?.icon.glyph;
  return presented !== undefined && isNamespacedGlyph(presented)
    ? presented
    : undefined;
}
