import type {
  TimelineActivityIntent,
  TimelineCommandWorkRow,
  TimelineFileReadWorkRow,
  TimelineSearchWorkRow,
} from "@cloudroom/server-contract";
import {
  assertNever,
  formatTimelinePath,
  type TimelinePathDisplayMode,
} from "./utils.js";

export type TimelineExplorationWorkRow =
  | TimelineCommandWorkRow
  | TimelineFileReadWorkRow
  | TimelineSearchWorkRow;

export interface TimelineActivityIntentTextParts {
  prefix: string | null;
  content: string;
}

const SKILL_FILE_NAME = "SKILL.md";

export function isSkillReadIntent(intent: TimelineActivityIntent): boolean {
  if (intent.type !== "read") return false;
  const target = (intent.path ?? intent.name).replaceAll("\\", "/");
  return target.split("/").pop() === SKILL_FILE_NAME;
}

export function timelineRowActivityIntents(
  row: TimelineExplorationWorkRow,
): readonly TimelineActivityIntent[] {
  switch (row.workKind) {
    case "command":
      return row.activityIntents;
    case "file-read":
      return [
        {
          type: "read",
          command: row.cmd ?? row.path,
          name: "fileRead",
          path: row.path,
        },
      ];
    case "search":
      if (row.mode === "content") {
        return [
          {
            type: "search",
            command: row.cmd ?? row.query,
            query: row.query,
            path: row.path,
          },
        ];
      }
      return [
        {
          type: "list_files",
          command: row.cmd ?? row.query,
          path: row.path ?? (row.query.length > 0 ? row.query : null),
        },
      ];
    default:
      return assertNever(row);
  }
}

export function primaryTimelineActivityIntent(
  row: TimelineExplorationWorkRow,
): TimelineActivityIntent | null {
  for (const intent of timelineRowActivityIntents(row)) {
    if (intent.type !== "unknown") return intent;
  }
  return null;
}

export function hasTimelineExplorationIntent(
  row: TimelineExplorationWorkRow,
): boolean {
  return primaryTimelineActivityIntent(row) !== null;
}

function formatCompactSkillTarget(path: string): string | null {
  const segments = path.replaceAll("\\", "/").split("/");
  const fileIndex = segments.length - 1;
  if (segments[fileIndex] !== SKILL_FILE_NAME) return null;

  // .../plugins/cache/<plugin>/<version>/SKILL.md -> <plugin>/SKILL.md
  const pluginName = segments[fileIndex - 2];
  if (
    pluginName &&
    segments[fileIndex - 4] === "cache" &&
    segments[fileIndex - 5] === "plugins"
  ) {
    return `${pluginName}/${SKILL_FILE_NAME}`;
  }

  for (let i = fileIndex - 1; i >= 0; i -= 1) {
    if (segments[i]) return `${segments[i]}/${SKILL_FILE_NAME}`;
  }
  return null;
}

export function formatTimelineActivityIntentParts(
  intent: TimelineActivityIntent,
  pathMode: TimelinePathDisplayMode,
  pending: boolean,
): TimelineActivityIntentTextParts {
  switch (intent.type) {
    case "read": {
      const target = intent.path ?? intent.name;
      const content =
        (pathMode === "compact" ? formatCompactSkillTarget(target) : null) ??
        formatTimelinePath(target, pathMode);
      return { prefix: pending ? "Reading" : "Read", content };
    }
    case "list_files":
      return {
        prefix: pending ? "Listing" : "Listed",
        content: intent.path ? `files in ${intent.path}` : "files",
      };
    case "search": {
      const prefix = pending ? "Searching" : "Searched";
      if (intent.query && intent.path) {
        return { prefix, content: `for ${intent.query} in ${intent.path}` };
      }
      if (intent.query) return { prefix, content: `for ${intent.query}` };
      if (intent.path) return { prefix, content: `in ${intent.path}` };
      return { prefix, content: "files" };
    }
    case "unknown":
      return { prefix: null, content: intent.command };
    default:
      return assertNever(intent);
  }
}

export function formatTimelineActivityIntentDetail(
  intent: TimelineActivityIntent,
  pathMode: TimelinePathDisplayMode,
  pending: boolean,
): string {
  const { prefix, content } = formatTimelineActivityIntentParts(
    intent,
    pathMode,
    pending,
  );
  return prefix ? `${prefix} ${content}` : content;
}

export function getTimelineActivityIntentDetailDedupeKey(
  intent: TimelineActivityIntent,
): string | null {
  switch (intent.type) {
    case "read":
      return `read:${intent.path ?? intent.name}`;
    case "list_files":
      return `list:${intent.path ?? ""}`;
    case "search":
      return `search:${intent.query ?? ""}|${intent.path ?? ""}`;
    case "unknown":
      return null;
    default:
      return assertNever(intent);
  }
}
