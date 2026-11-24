import type {
  TimelineActivityIntent,
  TimelineConversationRow,
  TimelineDelegationWorkRow,
  TimelineRow,
  TimelineRowBase,
  TimelineRowStatus,
  TimelineSystemRow,
  TimelineTurnRow,
  TimelineWorkRow,
} from "@cloudroom/server-contract";
import {
  getTimelineActivityIntentDetailDedupeKey,
  hasTimelineExplorationIntent,
  timelineRowActivityIntents,
  type TimelineExplorationWorkRow,
} from "./intents.js";
import {
  assertNever,
  FILE_CHANGE_VERBS,
  getFileChangeAction,
  plural,
  type FileChangeAction,
} from "./utils.js";

export interface TimelineViewDelegationWorkRow extends Omit<
  TimelineDelegationWorkRow,
  "childRows"
> {
  childRows: ThreadTimelineViewRow[];
  inClosedStep?: boolean;
}

type TimelineViewLeafWorkRow = Exclude<
  TimelineWorkRow,
  TimelineDelegationWorkRow
> & {
  inClosedStep?: boolean;
};

export type TimelineViewWorkRow =
  | TimelineViewLeafWorkRow
  | TimelineViewDelegationWorkRow;

export type TimelineQuestionViewWorkRow = Extract<
  TimelineViewWorkRow,
  { workKind: "question" }
>;
export type TimelineViewWorkflowWorkRow = Extract<
  TimelineViewWorkRow,
  { workKind: "workflow" }
>;

type TimelineReasoningSummaryChild = Extract<
  TimelineSystemRow,
  { systemKind: "operation" }
> & {
  operationKind: "reasoning";
  status: "completed";
};

export type TimelineWorkSummaryChild =
  | TimelineViewWorkRow
  | TimelineReasoningSummaryChild;

export interface TimelineStepSummaryRow extends TimelineRowBase {
  kind: "step-summary";
  status: TimelineRowStatus;
  children: TimelineWorkSummaryChild[];
}

export interface TimelineBundleSummaryRow extends TimelineRowBase {
  kind: "bundle-summary";
  status: TimelineRowStatus;
  children: TimelineWorkSummaryChild[];
}

export type TimelineWorkSummaryRow =
  | TimelineStepSummaryRow
  | TimelineBundleSummaryRow;

export interface TimelineViewTurnRow extends Omit<TimelineTurnRow, "children"> {
  children: ThreadTimelineViewRow[] | null;
}

export type ThreadTimelineViewRow =
  | TimelineConversationRow
  | TimelineViewWorkRow
  | TimelineSystemRow
  | TimelineWorkSummaryRow
  | TimelineViewTurnRow;

type ExplorationKind = "files" | "searches" | "lists";

type WorkSummaryCategory =
  | "commands"
  | "delegations"
  | "exploration"
  | "extensions"
  | "fileChanges"
  | "imageGenerations"
  | "imageViews"
  | "planUpdates"
  | "tools"
  | "webResearch";

interface WorkSummaryCounts {
  commands: number;
  delegations: number;
  extensions: number;
  imageGenerations: number;
  imageViews: number;
  lists: number;
  planUpdates: number;
  searches: number;
  tools: number;
  webFetches: number;
  webSearches: number;
  files: number;
  fileActions: Record<FileChangeAction, number>;
  explorationOrder: ExplorationKind[];
}

function summaryCategoryForRow(
  row: TimelineViewWorkRow,
): WorkSummaryCategory | null {
  switch (row.workKind) {
    case "command":
      return hasTimelineExplorationIntent(row) ? "exploration" : "commands";
    case "tool":
      return "tools";
    case "file-read":
    case "search":
      return "exploration";
    case "plan-steps":
      return "planUpdates";
    case "extension":
      return "extensions";
    case "file-change":
      return "fileChanges";
    case "web-fetch":
    case "web-search":
      return "webResearch";
    case "image-generation":
      return "imageGenerations";
    case "image-view":
      return "imageViews";
    case "delegation":
      return "delegations";
    case "approval":
    case "question":
    case "workflow":
      return null;
    default:
      return assertNever(row);
  }
}

function summarizeWork(rows: readonly TimelineViewWorkRow[]): WorkSummaryCounts {
  const counts: WorkSummaryCounts = {
    commands: 0,
    delegations: 0,
    extensions: 0,
    imageGenerations: 0,
    imageViews: 0,
    lists: 0,
    planUpdates: 0,
    searches: 0,
    tools: 0,
    webFetches: 0,
    webSearches: 0,
    files: 0,
    fileActions: { created: 0, deleted: 0, edited: 0, renamed: 0 },
    explorationOrder: [],
  };

  const exploredFiles = new Set<string>();
  const fileSets: Record<FileChangeAction, Set<string>> = {
    created: new Set(),
    deleted: new Set(),
    edited: new Set(),
    renamed: new Set(),
  };

  const noteExploration = (kind: ExplorationKind) => {
    if (!counts.explorationOrder.includes(kind)) {
      counts.explorationOrder.push(kind);
    }
  };

  const countExploration = (row: TimelineExplorationWorkRow) => {
    for (const intent of timelineRowActivityIntents(row)) {
      if (intent.type === "read") {
        const id = intent.path ?? intent.name;
        if (id) {
          exploredFiles.add(id);
          noteExploration("files");
        }
      } else if (intent.type === "list_files") {
        counts.lists += 1;
        noteExploration("lists");
      } else if (intent.type === "search") {
        counts.searches += 1;
        noteExploration("searches");
      }
    }
  };

  for (const row of rows) {
    switch (row.workKind) {
      case "command":
        if (hasTimelineExplorationIntent(row)) countExploration(row);
        else counts.commands += 1;
        break;
      case "file-read":
      case "search":
        countExploration(row);
        break;
      case "tool":
        counts.tools += 1;
        break;
      case "plan-steps":
        counts.planUpdates += 1;
        break;
      case "extension":
        counts.extensions += 1;
        break;
      case "file-change":
        fileSets[getFileChangeAction(row.change)].add(
          row.change.movePath ?? row.change.path,
        );
        break;
      case "web-fetch":
        counts.webFetches += 1;
        break;
      case "web-search":
        counts.webSearches += Math.max(1, row.queries.length);
        break;
      case "image-generation":
        counts.imageGenerations += 1;
        break;
      case "image-view":
        counts.imageViews += 1;
        break;
      case "delegation":
        counts.delegations += 1;
        break;
      case "approval":
      case "question":
      case "workflow":
        break;
      default:
        assertNever(row);
    }
  }

  counts.files = exploredFiles.size;
  counts.fileActions = {
    created: fileSets.created.size,
    deleted: fileSets.deleted.size,
    edited: fileSets.edited.size,
    renamed: fileSets.renamed.size,
  };
  return counts;
}

function approvalSummaryLabel(
  rows: readonly TimelineViewWorkRow[],
): string | null {
  let shared: "waiting_for_approval" | "denied" | null = null;
  let commands = 0;
  let fileChanges = 0;
  let tools = 0;

  for (const row of rows) {
    if (
      row.workKind !== "command" &&
      row.workKind !== "file-change" &&
      row.workKind !== "tool"
    ) {
      return null;
    }
    if (row.approvalStatus === null) return null;
    if (shared === null) shared = row.approvalStatus;
    else if (shared !== row.approvalStatus) return null;

    if (row.workKind === "command") commands += 1;
    else if (row.workKind === "file-change") fileChanges += 1;
    else tools += 1;
  }
  if (shared === null) return null;

  const details = [
    commands > 0 ? plural(commands, "command") : null,
    fileChanges > 0 ? plural(fileChanges, "file change") : null,
    tools > 0 ? plural(tools, "tool") : null,
  ].filter((x): x is string => x !== null);

  return shared === "denied"
    ? `Denied ${details.join(", ")}`
    : `Waiting for approval on ${details.join(", ")}`;
}

function summaryPhrase(
  category: WorkSummaryCategory,
  counts: WorkSummaryCounts,
  active: boolean,
): string | null {
  const run = active ? "Running" : "Ran";
  switch (category) {
    case "exploration": {
      const parts = counts.explorationOrder
        .map((kind) =>
          kind === "files"
            ? counts.files > 0
              ? plural(counts.files, "file")
              : null
            : kind === "searches"
              ? counts.searches > 0
                ? plural(counts.searches, "search", "searches")
                : null
              : counts.lists > 0
                ? plural(counts.lists, "list")
                : null,
        )
        .filter((x): x is string => x !== null);
      return parts.length > 0
        ? `${active ? "Exploring" : "Explored"} ${parts.join(", ")}`
        : null;
    }
    case "commands":
      return counts.commands > 0
        ? `${run} ${plural(counts.commands, "command")}`
        : null;
    case "tools":
      return counts.tools > 0 ? `${run} ${plural(counts.tools, "tool")}` : null;
    case "delegations":
      return counts.delegations > 0
        ? `${run} ${plural(counts.delegations, "subagent")}`
        : null;
    case "extensions":
      return counts.extensions > 0
        ? `${run} ${plural(counts.extensions, "plugin step")}`
        : null;
    case "planUpdates":
      if (counts.planUpdates === 0) return null;
      return active
        ? "Updating plan"
        : `Updated plan ${plural(counts.planUpdates, "time")}`;
    case "fileChanges": {
      const present = (
        ["created", "deleted", "edited", "renamed"] as const
      ).filter((action) => counts.fileActions[action] > 0);
      if (present.length === 0) return null;
      if (present.length === 1) {
        const action = present[0]!;
        const verb = active
          ? FILE_CHANGE_VERBS[action].present
          : FILE_CHANGE_VERBS[action].past;
        return `${verb} ${plural(counts.fileActions[action], "file")}`;
      }
      const total = present.reduce((sum, a) => sum + counts.fileActions[a], 0);
      return `${active ? "Editing" : "Edited"} ${plural(total, "file")}`;
    }
    case "webResearch": {
      const parts: string[] = [];
      if (counts.webSearches > 0) {
        parts.push(plural(counts.webSearches, "search query", "search queries"));
      }
      if (counts.webFetches > 0) {
        parts.push(plural(counts.webFetches, "web page"));
      }
      return parts.length > 0
        ? `${active ? "Researching" : "Researched"} ${parts.join(", ")}`
        : null;
    }
    case "imageGenerations":
      return counts.imageGenerations > 0
        ? `${active ? "Generating" : "Generated"} ${plural(counts.imageGenerations, "image")}`
        : null;
    case "imageViews":
      return counts.imageViews > 0
        ? `${active ? "Viewing" : "Viewed"} ${plural(counts.imageViews, "image")}`
        : null;
    default:
      return assertNever(category);
  }
}

function splitVerbAndRest(label: string): { verb: string; rest: string } {
  const space = label.indexOf(" ");
  return space === -1
    ? { verb: label, rest: "" }
    : { verb: label.slice(0, space), rest: label.slice(space + 1) };
}

export function buildTimelineWorkSummaryLabelParts(
  row: TimelineWorkSummaryRow,
  options: { active: boolean } = { active: false },
): { verb: string; rest: string } {
  const work = row.children.filter(
    (child): child is TimelineViewWorkRow => child.kind === "work",
  );
  const approval = approvalSummaryLabel(work);
  if (approval !== null) return splitVerbAndRest(approval);

  const counts = summarizeWork(work);
  const categories: WorkSummaryCategory[] = [];
  for (const w of work) {
    const cat = summaryCategoryForRow(w);
    if (cat && !categories.includes(cat)) categories.push(cat);
  }

  const phrases = categories
    .map((cat) => summaryPhrase(cat, counts, options.active))
    .filter((p): p is string => p !== null);

  if (phrases.length === 0) {
    return { verb: options.active ? "Working" : "Worked", rest: "" };
  }

  const joined = phrases
    .map((p, i) => (i === 0 ? p : `${p.charAt(0).toLowerCase()}${p.slice(1)}`))
    .join(", ");
  return splitVerbAndRest(joined);
}

export function buildTimelineWorkSummaryLabel(
  row: TimelineWorkSummaryRow,
  options: { active: boolean } = { active: false },
): string {
  const { verb, rest } = buildTimelineWorkSummaryLabelParts(row, options);
  return rest.length === 0 ? verb : `${verb} ${rest}`;
}

function mergeStatus(
  left: TimelineRowStatus,
  right: TimelineRowStatus,
): TimelineRowStatus {
  if (left === "error" || right === "error") return "error";
  if (left === "pending" || right === "pending") return "pending";
  if (left === "interrupted" || right === "interrupted") return "interrupted";
  return "completed";
}

function dedupeBundleChildIntents(
  children: readonly TimelineWorkSummaryChild[],
): TimelineWorkSummaryChild[] {
  let lastKey: string | null = null;
  const out: TimelineWorkSummaryChild[] = [];

  for (const child of children) {
    if (child.kind === "system") {
      lastKey = null;
      out.push(child);
      continue;
    }
    if (child.workKind === "file-read" || child.workKind === "search") {
      const intent = timelineRowActivityIntents(child)[0];
      const key = intent ? getTimelineActivityIntentDetailDedupeKey(intent) : null;
      if (key !== null && key === lastKey) continue;
      lastKey = key;
      out.push(child);
      continue;
    }
    if (child.workKind !== "command" || child.activityIntents.length === 0) {
      lastKey = null;
      out.push(child);
      continue;
    }
    const wasExploration = hasTimelineExplorationIntent(child);
    const filtered: TimelineActivityIntent[] = [];
    for (const intent of child.activityIntents) {
      if (intent.type === "unknown") {
        filtered.push(intent);
        continue;
      }
      const key = getTimelineActivityIntentDetailDedupeKey(intent);
      if (key !== null && key === lastKey) continue;
      filtered.push(intent);
      lastKey = key;
    }
    if (filtered.length === child.activityIntents.length) {
      out.push(child);
    } else if (
      !wasExploration ||
      filtered.some((intent) => intent.type !== "unknown")
    ) {
      out.push({ ...child, activityIntents: filtered });
    }
  }
  return out;
}

function makeSummaryRow(
  kind: "step-summary" | "bundle-summary",
  children: readonly TimelineWorkSummaryChild[],
): TimelineWorkSummaryRow {
  const deduped = dedupeBundleChildIntents(children);
  const first = deduped[0];
  if (!first) {
    throw new Error("Cannot summarize an empty timeline activity run");
  }
  let sourceSeqStart = first.sourceSeqStart;
  let sourceSeqEnd = first.sourceSeqEnd;
  let startedAt = first.startedAt;
  let createdAt = first.createdAt;
  let turnId = first.turnId;
  let status = first.status;

  for (const child of deduped) {
    sourceSeqStart = Math.min(sourceSeqStart, child.sourceSeqStart);
    sourceSeqEnd = Math.max(sourceSeqEnd, child.sourceSeqEnd);
    startedAt = Math.min(startedAt, child.startedAt);
    createdAt = Math.max(createdAt, child.createdAt);
    status = mergeStatus(status, child.status);
    if (turnId !== child.turnId) turnId = null;
  }

  return {
    id: `${first.threadId}:${turnId ?? "thread"}:work-summary:${first.id}`,
    threadId: first.threadId,
    turnId,
    sourceSeqStart,
    sourceSeqEnd,
    startedAt,
    createdAt,
    status,
    kind,
    children: deduped,
  };
}

function isSummarizableRow(
  row: ThreadTimelineViewRow,
): row is TimelineWorkSummaryChild {
  if (
    row.kind === "system" &&
    row.systemKind === "operation" &&
    row.operationKind === "reasoning" &&
    row.status === "completed"
  ) {
    return true;
  }
  return (
    row.kind === "work" &&
    row.workKind !== "approval" &&
    row.workKind !== "question" &&
    row.workKind !== "workflow" &&
    row.workKind !== "image-generation"
  );
}

function isStepBoundary(row: ThreadTimelineViewRow): boolean {
  return (
    row.kind === "conversation" &&
    !(row.role === "user" && row.turnRequest.status === "pending")
  );
}

function closeOpenStep(work: TimelineWorkSummaryChild[]): ThreadTimelineViewRow[] {
  if (work.length === 0) return [];
  if (!work.some((row) => row.kind === "work")) return work;
  if (work.length === 1) {
    const only = work[0]!;
    return [only.kind === "work" ? { ...only, inClosedStep: true } : only];
  }
  return [makeSummaryRow("step-summary", work)];
}

function flushOpenStepAsBundles(
  work: TimelineWorkSummaryChild[],
): ThreadTimelineViewRow[] {
  if (work.length === 0) return [];
  const groups: {
    concept: WorkSummaryCategory;
    rows: TimelineWorkSummaryChild[];
  }[] = [];
  const leadingThoughts: TimelineWorkSummaryChild[] = [];

  for (const row of work) {
    if (row.kind === "system") {
      const last = groups[groups.length - 1];
      if (last) last.rows.push(row);
      else leadingThoughts.push(row);
      continue;
    }
    const concept = summaryCategoryForRow(row) ?? "tools";
    const last = groups[groups.length - 1];
    if (last && last.concept === concept) {
      last.rows.push(row);
    } else {
      groups.push({ concept, rows: [...leadingThoughts.splice(0), row] });
    }
  }

  const out: ThreadTimelineViewRow[] = [...leadingThoughts];
  for (const group of groups) {
    out.push(
      group.rows.length === 1
        ? group.rows[0]!
        : makeSummaryRow("bundle-summary", group.rows),
    );
  }
  return out;
}

type TimelineViewRowsCache = WeakMap<
  readonly TimelineRow[],
  ThreadTimelineViewRow[]
>;

export function createTimelineViewRowsCache(): TimelineViewRowsCache {
  return new WeakMap();
}

export interface BuildTimelineViewRowsOptions {
  closedScope?: boolean;
  cache?: TimelineViewRowsCache;
}

function convertRow(
  row: TimelineRow,
  cache: TimelineViewRowsCache,
): ThreadTimelineViewRow {
  if (row.kind === "work" && row.workKind === "delegation") {
    return {
      ...row,
      childRows: buildTimelineViewRows(row.childRows, {
        cache,
        closedScope: row.status !== "pending",
      }),
    };
  }
  if (row.kind === "turn") {
    return {
      ...row,
      children: row.children
        ? buildTimelineViewRows(row.children, { cache, closedScope: true })
        : null,
    };
  }
  return row;
}

export function buildTimelineViewRows(
  rows: readonly TimelineRow[],
  options: BuildTimelineViewRowsOptions = {},
): ThreadTimelineViewRow[] {
  const cached = options.cache?.get(rows);
  if (cached) return cached;

  const childCache = options.cache ?? createTimelineViewRowsCache();
  const result: ThreadTimelineViewRow[] = [];
  let openStep: TimelineWorkSummaryChild[] = [];

  for (const rawRow of rows) {
    const row = convertRow(rawRow, childCache);
    if (isSummarizableRow(row)) {
      openStep.push(row);
      continue;
    }
    if (openStep.length > 0) {
      result.push(
        ...(isStepBoundary(row)
          ? closeOpenStep(openStep)
          : flushOpenStepAsBundles(openStep)),
      );
      openStep = [];
    }
    result.push(row);
  }

  if (openStep.length > 0) {
    result.push(
      ...(options.closedScope
        ? closeOpenStep(openStep)
        : flushOpenStepAsBundles(openStep)),
    );
  }

  options.cache?.set(rows, result);
  return result;
}
