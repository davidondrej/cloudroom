import {
  COMPUTER,
  formatToolCallCommand,
  isBackgroundAgentTaskType,
  isBackgroundCommandTaskType,
  isSettledWorkflowAgentState,
} from "@cloudroom/domain";
import type {
  TimelineActivityIntent,
  TimelineApprovalStatus,
  TimelineCommandWorkRow,
  TimelineFileChange,
  TimelineFileChangeWorkRow,
  TimelineFileReadWorkRow,
  TimelineImageGenerationWorkRow,
  TimelineParentChangeSystemRow,
  TimelinePlanStepsWorkRow,
  TimelineRowPresentation,
  TimelineRowStatus,
  TimelineSearchWorkRow,
  TimelineToolWorkRow,
} from "@cloudroom/server-contract";
import {
  formatTimelineActivityIntentParts,
  getTimelineActivityIntentDetailDedupeKey,
  hasTimelineExplorationIntent,
  timelineRowActivityIntents,
  type TimelineExplorationWorkRow,
} from "./intents.js";
import {
  assertNever,
  durationToCompactString,
  FILE_CHANGE_VERBS,
  fileNameFromPath,
  formatDiffStatsText,
  formatFileChangePath,
  formatTimelinePath,
  getFileChangeAction,
  OWNERSHIP_CHANGE_VERBS,
} from "./utils.js";
import {
  buildTimelineWorkSummaryLabelParts,
  type ThreadTimelineViewRow,
  type TimelineQuestionViewWorkRow,
  type TimelineViewDelegationWorkRow,
  type TimelineViewTurnRow,
  type TimelineViewWorkRow,
  type TimelineViewWorkflowWorkRow,
  type TimelineWorkSummaryRow,
} from "./view.js";

export type TimelineTitleTone = "default" | "summary";
export type TimelineTitleLink = { kind: "thread"; threadId: string };
export type TimelineTitleSegmentAccent = "muted" | "subtle" | "file" | "warning";

export interface TimelineTitleSegment {
  text: string;
  plainText?: string;
  em: boolean;
  shimmer: boolean;
  truncate: boolean;
  accent?: TimelineTitleSegmentAccent;
  link?: TimelineTitleLink;
}

export type TimelineTitleDecoration =
  | {
      kind: "duration";
      startedAt: number;
      completedAt: number | null;
      em: boolean;
    }
  | {
      kind: "status";
      status: "denied" | "error" | "interrupted";
      durationMs: number | null;
      emphasis: boolean;
    }
  | {
      kind: "summary-status";
      errorCount: number;
      interruptedCount: number;
    }
  | { kind: "diff-stats"; added: number; removed: number }
  | {
      kind: "badge";
      glyph: string;
      label: string;
      hint: string;
      tone: "neutral" | "destructive";
    };

export type TimelineTitleAction =
  | { kind: "open-file-diff"; path: string }
  | { kind: "open-plugin-side-chat"; threadId: string };

export interface TimelineTitle {
  segments: TimelineTitleSegment[];
  decorations: TimelineTitleDecoration[];
  tone: TimelineTitleTone;
  action: TimelineTitleAction | null;
  plain: string;
}

export interface BuildTimelineRowTitleOptions {
  summaryStyle: "bundle" | "background";
  workStyle: "default" | "summary";
  isActiveLatestBundle?: boolean;
}

export interface TimelineActivityIntentTitle {
  id: string;
  intent: TimelineActivityIntent;
  title: TimelineTitle;
  intentType: "read" | "list_files" | "search";
}

type StatusVerbs = Record<TimelineRowStatus, string>;

const WEB_SEARCH_VERBS: StatusVerbs = {
  pending: "Running web search:",
  completed: "Ran web search:",
  error: "Ran web search:",
  interrupted: "Interrupted web search:",
};

const WEB_FETCH_VERBS: StatusVerbs = {
  pending: "Fetching:",
  completed: "Fetched:",
  error: "Fetched:",
  interrupted: "Interrupted fetch:",
};

const IMAGE_VIEW_VERBS: StatusVerbs = {
  pending: "Viewing image:",
  completed: "Viewed image:",
  error: "Viewed image:",
  interrupted: "Interrupted image view:",
};

const IMAGE_GEN_VERBS: StatusVerbs = {
  pending: "Generating image",
  completed: "Generated image",
  error: "Image generation failed",
  interrupted: "Interrupted image generation",
};

const DELEGATION_VERBS: StatusVerbs = {
  pending: "Running subagent:",
  completed: "Ran subagent:",
  error: "Failed subagent:",
  interrupted: "Interrupted subagent:",
};

const WORKFLOW_VERBS: StatusVerbs = {
  pending: "Running workflow:",
  completed: "Ran workflow:",
  error: "Failed workflow:",
  interrupted: "Interrupted workflow:",
};

const BG_COMMAND_VERBS: StatusVerbs = {
  pending: "Running background command:",
  completed: "Ran background command:",
  error: "Background command failed:",
  interrupted: "Background command interrupted:",
};

const BG_AGENT_VERBS: StatusVerbs = {
  pending: "Running background agent:",
  completed: "Ran background agent:",
  error: "Background agent failed:",
  interrupted: "Background agent interrupted:",
};

function collapseNewlines(text: string): string {
  return text.replace(/[\r\n]+/gu, " ");
}

function seg(
  text: string,
  opts: {
    em?: boolean;
    shimmer?: boolean;
    truncate?: boolean;
    plainText?: string;
    link?: TimelineTitleLink;
    accent?: TimelineTitleSegmentAccent;
  } = {},
): TimelineTitleSegment {
  return {
    text: collapseNewlines(text),
    em: opts.em ?? false,
    shimmer: opts.shimmer ?? false,
    truncate: opts.truncate ?? false,
    ...(opts.plainText !== undefined
      ? { plainText: collapseNewlines(opts.plainText) }
      : {}),
    ...(opts.link !== undefined ? { link: opts.link } : {}),
    ...(opts.accent !== undefined ? { accent: opts.accent } : {}),
  };
}

function visibleDuration(ms: number | null): number | null {
  return ms !== null && ms > 1_000 ? ms : null;
}

function durationDeco(
  startedAt: number,
  completedAt: number | null,
  em = false,
): TimelineTitleDecoration | null {
  if (completedAt !== null && visibleDuration(completedAt - startedAt) === null) {
    return null;
  }
  return { kind: "duration", startedAt, completedAt, em };
}

function statusDeco(
  status: "denied" | "error" | "interrupted",
  durationMs: number | null,
  emphasis = false,
): TimelineTitleDecoration {
  return {
    kind: "status",
    status,
    durationMs: visibleDuration(durationMs),
    emphasis,
  };
}

function badgeDecos(row: {
  presentation?: TimelineRowPresentation;
}): TimelineTitleDecoration[] {
  const b = row.presentation?.badge;
  return b
    ? [{ kind: "badge", glyph: b.glyph, label: b.label, hint: b.hint, tone: b.tone }]
    : [];
}

function diffStatsDeco(
  change: TimelineFileChange,
): TimelineTitleDecoration | null {
  const { added, removed } = change.diffStats;
  return added === 0 && removed === 0
    ? null
    : { kind: "diff-stats", added, removed };
}

function compact<T>(items: (T | null)[]): T[] {
  return items.filter((v): v is T => v !== null);
}

export function formatTimelineDecorationText(
  d: TimelineTitleDecoration,
): string {
  switch (d.kind) {
    case "duration":
      return d.completedAt === null
        ? ""
        : `(${durationToCompactString(d.completedAt - d.startedAt)})`;
    case "status":
      return d.durationMs !== null
        ? `(${durationToCompactString(d.durationMs)}, ${d.status})`
        : `(${d.status})`;
    case "summary-status": {
      const parts: string[] = [];
      if (d.errorCount > 0) {
        parts.push(`${d.errorCount} error${d.errorCount > 1 ? "s" : ""}`);
      }
      if (d.interruptedCount > 0) {
        parts.push(`${d.interruptedCount} interrupted`);
      }
      return parts.length === 0 ? "" : `(${parts.join(", ")})`;
    }
    case "diff-stats":
      return formatDiffStatsText({
        added: d.added,
        removed: d.removed,
        hideZero: true,
      });
    case "badge":
      return `(${d.label})`;
    default:
      return assertNever(d);
  }
}

function makeTitle(
  segments: TimelineTitleSegment[],
  decorations: TimelineTitleDecoration[] = [],
  tone: TimelineTitleTone = "default",
  action: TimelineTitleAction | null = null,
): TimelineTitle {
  const segText = segments
    .map((s) => s.plainText ?? s.text)
    .filter((t) => t.length > 0)
    .join(" ");
  const decoText = decorations
    .map(formatTimelineDecorationText)
    .filter((t) => t.length > 0)
    .join(" ");
  const plain =
    decoText.length === 0
      ? segText
      : segText.length === 0
        ? decoText
        : `${segText} ${decoText}`;
  return { segments, decorations, tone, action, plain };
}

function displayStatus(
  approvalStatus: TimelineApprovalStatus,
  status: TimelineRowStatus,
): "waiting" | "denied" | TimelineRowStatus {
  if (approvalStatus === "waiting_for_approval") return "waiting";
  if (approvalStatus === "denied") return "denied";
  return status;
}

function statusOrDurationDecos(
  status: TimelineRowStatus,
  startedAt: number,
  completedAt: number | null,
  includePendingDuration = true,
): TimelineTitleDecoration[] {
  const ms = completedAt !== null ? completedAt - startedAt : null;
  if (status === "error") return [statusDeco("error", ms)];
  if (status === "interrupted") return [statusDeco("interrupted", ms)];
  if (status === "pending" && !includePendingDuration) return [];
  return compact([durationDeco(startedAt, completedAt)]);
}

function presentedTitle(args: {
  presentation: TimelineRowPresentation;
  status: TimelineRowStatus;
  startedAt: number;
  completedAt: number | null;
  content?: string | null;
  plainContent?: string;
  em?: boolean;
}): TimelineTitle {
  const { presentation, status, startedAt, completedAt, plainContent, em = true } =
    args;
  const content = args.content === undefined ? presentation.title : args.content;
  const label =
    status === "pending"
      ? presentation.label.pending
      : presentation.label.completed;
  const segments: TimelineTitleSegment[] = [
    seg(label, { shimmer: status === "pending", truncate: !content }),
  ];
  if (content) {
    segments.push(seg(content, { em, truncate: true, plainText: plainContent }));
  }
  return makeTitle(segments, [
    ...badgeDecos({ presentation }),
    ...statusOrDurationDecos(status, startedAt, completedAt),
  ]);
}

function mapSingleExplorationTitle(
  row: TimelineExplorationWorkRow,
): TimelineTitle | null {
  if (!hasTimelineExplorationIntent(row)) return null;
  const known = timelineRowActivityIntents(row).filter(
    (i) => i.type !== "unknown",
  );
  if (known.length !== 1) return null;
  const intent = known[0]!;

  const status = displayStatus(
    row.workKind === "command" ? row.approvalStatus : null,
    row.status,
  );
  const pending = status === "pending";
  const detail = formatTimelineActivityIntentParts(intent, "compact", pending);
  const plain = formatTimelineActivityIntentParts(intent, "full", pending);
  const badges = badgeDecos(row);

  if (status === "denied" || status === "waiting") {
    const content = detail.prefix
      ? `${detail.prefix} ${detail.content}`
      : detail.content;
    const plainText = plain.prefix
      ? `${plain.prefix} ${plain.content}`
      : plain.content;
    const target = seg(content, { em: true, truncate: true, plainText });
    return makeTitle(
      status === "denied"
        ? [seg("Permission denied:"), target]
        : [seg("Waiting for approval", { shimmer: true }), seg("to use"), target],
      badges,
    );
  }

  const segments: TimelineTitleSegment[] = [];
  if (detail.prefix) segments.push(seg(detail.prefix, { shimmer: pending }));
  segments.push(
    seg(detail.content, { truncate: true, plainText: plain.content }),
  );
  const decorations = [
    ...badges,
    ...(status === "error" || status === "interrupted"
      ? [statusDeco(status, null)]
      : []),
  ];
  return makeTitle(segments, decorations);
}

function mapExecutionTitle(
  row: TimelineCommandWorkRow | TimelineToolWorkRow,
): TimelineTitle {
  const status = displayStatus(row.approvalStatus, row.status);
  const isCommand = row.workKind === "command";
  if (row.presentation && status !== "waiting" && status !== "denied" && !isCommand) {
    return presentedTitle({
      presentation: row.presentation,
      status,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    });
  }
  if (isCommand) {
    const exploration = mapSingleExplorationTitle(row);
    if (exploration) return exploration;
  }

  const content = isCommand
    ? row.command
    : formatToolCallCommand(row.toolName, row.toolArgs);
  const contentSeg = seg(content, { em: true, truncate: true });
  const badges = badgeDecos(row);

  if (status === "waiting") {
    return makeTitle(
      [
        seg("Waiting for approval", { shimmer: true }),
        seg(isCommand ? "to run" : "to use"),
        contentSeg,
      ],
      badges,
    );
  }
  if (status === "denied") {
    return makeTitle(
      [seg("Permission denied:"), contentSeg],
      [...badges, ...compact([durationDeco(row.startedAt, row.completedAt)])],
    );
  }

  const onMac =
    isCommand && /\b(room-cli|cloudroom) mac (run|pull|push)\b/.test(content);
  const label =
    status === "pending"
      ? onMac
        ? `Running on your ${COMPUTER}:`
        : isCommand
          ? "Running"
          : "Running tool:"
      : isCommand
        ? onMac
          ? `Ran on your ${COMPUTER}:`
          : "Ran"
        : "Ran tool";

  return makeTitle(
    [seg(label, { shimmer: status === "pending" }), contentSeg],
    [...badges, ...statusOrDurationDecos(status, row.startedAt, row.completedAt)],
  );
}

function mapFileChangeTitle(row: TimelineFileChangeWorkRow): TimelineTitle {
  const status = displayStatus(row.approvalStatus, row.status);
  const verbs = FILE_CHANGE_VERBS[getFileChangeAction(row.change)];
  const pathSeg = seg(formatFileChangePath(row.change, "compact"), {
    em: true,
    truncate: true,
    plainText: formatFileChangePath(row.change, "full"),
    accent: "file",
  });
  const action: TimelineTitleAction = {
    kind: "open-file-diff",
    path: row.change.movePath ?? row.change.path,
  };
  const diffDecos = compact([diffStatsDeco(row.change)]);

  switch (status) {
    case "waiting":
      return makeTitle(
        [seg("Waiting for approval", { shimmer: true }), seg("to edit"), pathSeg],
        diffDecos,
        "default",
        action,
      );
    case "denied":
      return makeTitle([seg("Permission denied:"), pathSeg], diffDecos, "default", action);
    case "pending":
      return makeTitle(
        [seg(verbs.present, { shimmer: true }), pathSeg],
        diffDecos,
        "default",
        action,
      );
    case "completed":
      return makeTitle([seg(verbs.past), pathSeg], diffDecos, "default", action);
    case "error":
      return makeTitle(
        [seg(`Failed to ${verbs.infinitive}`), pathSeg],
        [statusDeco("error", null)],
        "default",
        action,
      );
    case "interrupted":
      return makeTitle(
        [seg(`Interrupted while ${verbs.present.toLowerCase()}`), pathSeg],
        [],
        "default",
        action,
      );
    default:
      return assertNever(status);
  }
}

function mapStatusSubjectTitle(
  verbs: StatusVerbs,
  status: TimelineRowStatus,
  subject: TimelineTitleSegment,
  startedAt: number,
  completedAt: number | null,
): TimelineTitle {
  return makeTitle(
    [seg(verbs[status], { shimmer: status === "pending" }), subject],
    statusOrDurationDecos(status, startedAt, completedAt, false),
  );
}

function mapImageGenerationTitle(
  row: TimelineImageGenerationWorkRow,
): TimelineTitle {
  if (row.presentation) {
    return presentedTitle({
      presentation: row.presentation,
      status: row.status,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    });
  }
  const decorations =
    row.status === "error" || row.status === "interrupted"
      ? [statusDeco(row.status, null)]
      : compact([durationDeco(row.startedAt, row.completedAt)]);
  return makeTitle(
    [seg(IMAGE_GEN_VERBS[row.status], { shimmer: row.status === "pending" })],
    decorations,
  );
}

function mapDelegationTitle(row: TimelineViewDelegationWorkRow): TimelineTitle {
  const description = row.description ?? (row.output.trim() || row.toolName);
  if (row.presentation) {
    return presentedTitle({
      presentation: row.presentation,
      status: row.status,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      content: description,
    });
  }
  const segments: TimelineTitleSegment[] = [
    seg(DELEGATION_VERBS[row.status], { shimmer: row.status === "pending" }),
    seg(description, { em: true, truncate: true }),
  ];
  if (row.subagentType) {
    segments.push(seg(`(${row.subagentType})`, { truncate: true }));
  }
  return makeTitle(segments, compact([durationDeco(row.startedAt, row.completedAt)]));
}

function mapWorkflowTitle(row: TimelineViewWorkflowWorkRow): TimelineTitle {
  const isBgCmd = isBackgroundCommandTaskType(row.taskType);
  const isBgAgent = isBackgroundAgentTaskType(row.taskType);
  const verbs = isBgCmd
    ? BG_COMMAND_VERBS
    : isBgAgent
      ? BG_AGENT_VERBS
      : WORKFLOW_VERBS;
  const label = isBgCmd || isBgAgent ? row.description : (row.workflowName ?? row.description);
  const segments: TimelineTitleSegment[] = [
    seg(verbs[row.status]),
    seg(label, { em: true, truncate: true }),
  ];
  if (!isBgCmd && !isBgAgent) {
    const agents = row.workflow?.agents ?? [];
    if (agents.length > 0) {
      const done = agents.filter((a) => isSettledWorkflowAgentState(a.state)).length;
      segments.push(seg(`(${done}/${agents.length} agents)`));
    }
  }
  return makeTitle(segments, compact([durationDeco(row.startedAt, row.completedAt)]));
}

function mapApprovalTitle(
  row: Extract<TimelineViewWorkRow, { workKind: "approval" }>,
): TimelineTitle {
  if (row.approvalKind === "file-edit") {
    return row.lifecycle === "waiting"
      ? makeTitle([
          seg("Waiting for approval to edit", { shimmer: true }),
          seg("files", { em: true, truncate: true }),
        ])
      : makeTitle([
          seg("Permission denied:"),
          seg("file changes", { em: true, truncate: true }),
        ]);
  }

  const tool = row.target.toolName;
  const toolSeg = tool !== null ? seg(tool, { em: true, truncate: true }) : null;
  const reason = row.statusReason?.trim() || null;

  switch (row.lifecycle) {
    case "pending":
      return makeTitle(
        toolSeg
          ? [seg("Waiting for permission", { shimmer: true }), seg("to use"), toolSeg]
          : [seg("Waiting for permissions", { shimmer: true })],
      );
    case "resolving":
      return makeTitle(
        toolSeg
          ? [seg("Delivering permission", { shimmer: true }), seg("to use"), toolSeg]
          : [seg("Delivering permissions", { shimmer: true })],
      );
    case "granted": {
      const scope =
        row.grantScope === "turn"
          ? "for this turn"
          : row.grantScope === "session"
            ? "for this session"
            : null;
      const base = scope ? `Permission granted ${scope}` : "Permission granted";
      return makeTitle(toolSeg ? [seg(`${base}:`), toolSeg] : [seg(base)]);
    }
    case "denied":
      return makeTitle(
        toolSeg ? [seg("Permission denied:"), toolSeg] : [seg("Permission denied")],
      );
    case "interrupted":
      return makeTitle(
        compact([
          seg(toolSeg ? "Permission grant interrupted:" : "Permission grant interrupted"),
          toolSeg,
          reason ? seg(`(${reason})`, { truncate: true }) : null,
        ]),
      );
    default:
      return assertNever(row);
  }
}

function mapQuestionTitle(row: TimelineQuestionViewWorkRow): TimelineTitle {
  const single = row.questions.length === 1 ? row.questions[0]! : null;
  const subject = single
    ? seg(single.prompt, { em: true, truncate: true })
    : seg(`${row.questions.length} questions`, { em: true });

  switch (row.lifecycle) {
    case "pending":
      return makeTitle([
        seg(single ? "Waiting for answer" : "Waiting for answers to", { shimmer: true }),
        subject,
      ]);
    case "resolving":
      return makeTitle([
        seg(single ? "Delivering answer" : "Delivering answers to", { shimmer: true }),
        subject,
      ]);
    case "answered": {
      const answer = single ? row.answers?.[single.id] : undefined;
      const parts = answer
        ? [
            ...answer.selected.map(
              (v) => single!.options?.find((o) => o.value === v)?.label ?? v,
            ),
            ...(answer.freeText ? [answer.freeText] : []),
          ]
        : [];
      const summary = parts.join(", ");
      return makeTitle(
        compact([
          seg("Answered"),
          subject,
          summary ? seg(`— ${summary}`, { truncate: true }) : null,
        ]),
      );
    }
    case "interrupted":
      return makeTitle([seg("Asked"), subject], [statusDeco("interrupted", null)]);
    default:
      return assertNever(row.lifecycle);
  }
}

function mapFileReadTitle(row: TimelineFileReadWorkRow): TimelineTitle {
  if (row.presentation) {
    return presentedTitle({
      presentation: row.presentation,
      status: row.status,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      content: formatTimelinePath(row.path, "compact"),
      plainContent: row.path,
    });
  }
  return (
    mapSingleExplorationTitle(row) ??
    makeTitle([
      seg(row.status === "pending" ? "Reading" : "Read", {
        shimmer: row.status === "pending",
      }),
      seg(row.path, { em: true, truncate: true }),
    ])
  );
}

function searchContent(row: TimelineSearchWorkRow): string {
  const root = row.path ? ` in ${row.path}` : "";
  switch (row.mode) {
    case "content":
      return `for ${row.query}${root}`;
    case "path":
      return `matching ${row.query}${root}`;
    case "list":
      return row.path ? `in ${row.path}` : row.query ? `in ${row.query}` : "";
    default:
      return assertNever(row.mode);
  }
}

function mapSearchTitle(row: TimelineSearchWorkRow): TimelineTitle {
  if (row.presentation) {
    return presentedTitle({
      presentation: row.presentation,
      status: row.status,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      content: searchContent(row),
      em: false,
    });
  }
  return (
    mapSingleExplorationTitle(row) ??
    makeTitle([
      seg(row.status === "pending" ? "Searching" : "Searched", {
        shimmer: row.status === "pending",
      }),
      seg(searchContent(row), { truncate: true }),
    ])
  );
}

function mapPlanStepsTitle(row: TimelinePlanStepsWorkRow): TimelineTitle {
  const activeStep =
    row.steps.find((s) => s.status === "active")?.step ?? row.explanation;
  if (row.presentation) {
    return presentedTitle({
      presentation: row.presentation,
      status: row.status,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      content: row.presentation.title ?? activeStep,
      em: false,
    });
  }
  const done = row.steps.filter((s) => s.status === "completed").length;
  return makeTitle(
    [
      seg(row.status === "pending" ? "Updating plan" : "Updated plan", {
        shimmer: row.status === "pending",
      }),
      seg(activeStep ?? `${done}/${row.steps.length} steps done`, { truncate: true }),
    ],
    compact([durationDeco(row.startedAt, row.completedAt)]),
  );
}

function mapWorkTitle(
  row: TimelineViewWorkRow,
  options: BuildTimelineRowTitleOptions,
): TimelineTitle {
  let title: TimelineTitle;
  switch (row.workKind) {
    case "command":
    case "tool":
      title = mapExecutionTitle(row);
      break;
    case "file-read":
      title = mapFileReadTitle(row);
      break;
    case "search":
      title = mapSearchTitle(row);
      break;
    case "plan-steps":
      title = mapPlanStepsTitle(row);
      break;
    case "extension":
      title = presentedTitle({
        presentation: row.presentation,
        status: row.status,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        em: false,
      });
      break;
    case "file-change":
      title = mapFileChangeTitle(row);
      break;
    case "web-search":
      title = row.presentation
        ? presentedTitle({
            presentation: row.presentation,
            status: row.status,
            startedAt: row.startedAt,
            completedAt: row.completedAt,
            content: row.queries.join(", "),
            em: false,
          })
        : mapStatusSubjectTitle(
            WEB_SEARCH_VERBS,
            row.status,
            seg(row.queries.join(", ") || "web search", { truncate: true }),
            row.startedAt,
            row.completedAt,
          );
      break;
    case "web-fetch":
      title = row.presentation
        ? presentedTitle({
            presentation: row.presentation,
            status: row.status,
            startedAt: row.startedAt,
            completedAt: row.completedAt,
            content: row.url,
            em: false,
          })
        : mapStatusSubjectTitle(
            WEB_FETCH_VERBS,
            row.status,
            seg(row.url, { truncate: true }),
            row.startedAt,
            row.completedAt,
          );
      break;
    case "image-view":
      title = row.presentation
        ? presentedTitle({
            presentation: row.presentation,
            status: row.status,
            startedAt: row.startedAt,
            completedAt: row.completedAt,
            content: fileNameFromPath(row.path),
            plainContent: row.path,
          })
        : mapStatusSubjectTitle(
            IMAGE_VIEW_VERBS,
            row.status,
            seg(fileNameFromPath(row.path), { plainText: row.path, truncate: true }),
            row.startedAt,
            row.completedAt,
          );
      break;
    case "image-generation":
      title = mapImageGenerationTitle(row);
      break;
    case "delegation":
      title = mapDelegationTitle(row);
      break;
    case "workflow":
      title = mapWorkflowTitle(row);
      break;
    case "approval":
      title = mapApprovalTitle(row);
      break;
    case "question":
      title = mapQuestionTitle(row);
      break;
    default:
      return assertNever(row);
  }
  return options.workStyle === "default" ? title : { ...title, tone: "summary" };
}

function mapWorkSummaryTitle(
  row: TimelineWorkSummaryRow,
  options: BuildTimelineRowTitleOptions,
): TimelineTitle {
  const isActive =
    row.kind === "bundle-summary" && options.isActiveLatestBundle === true;
  const { verb, rest } = buildTimelineWorkSummaryLabelParts(row, {
    active: isActive,
  });

  let errorCount = 0;
  let interruptedCount = 0;
  for (const child of row.children) {
    if (child.status === "error") errorCount += 1;
    if (child.status === "interrupted") interruptedCount += 1;
  }
  const decorations: TimelineTitleDecoration[] =
    errorCount > 0 || interruptedCount > 0
      ? [{ kind: "summary-status", errorCount, interruptedCount }]
      : [];

  if (options.summaryStyle === "background") {
    return makeTitle(
      [seg(rest ? `${verb} ${rest}` : verb, { truncate: true })],
      decorations,
      "summary",
    );
  }

  const accent: TimelineTitleSegmentAccent | undefined = isActive
    ? undefined
    : "subtle";
  const verbSeg = seg(verb, { shimmer: isActive, accent, truncate: !rest });
  return makeTitle(
    rest ? [verbSeg, seg(rest, { em: true, truncate: true, accent })] : [verbSeg],
    decorations,
  );
}

function mapTurnTitle(row: TimelineViewTurnRow): TimelineTitle {
  const pending = row.status === "pending";
  if (!pending && row.completedAt !== null) {
    return makeTitle(
      [seg("Worked for", { accent: "subtle" })],
      [{ kind: "duration", startedAt: row.startedAt, completedAt: row.completedAt, em: false }],
    );
  }
  const deco = pending ? durationDeco(row.startedAt, row.completedAt, true) : null;
  return makeTitle(
    [seg(pending ? "Working" : "Worked", { shimmer: pending, accent: pending ? undefined : "subtle" })],
    compact([deco]),
  );
}

function mapParentChangeTitle(row: TimelineParentChangeSystemRow): TimelineTitle {
  const { action, previousParentThreadId, previousParentThreadTitle, nextParentThreadId, nextParentThreadTitle } =
    row.parentChange;
  const verb = OWNERSHIP_CHANGE_VERBS[action];
  const parentId = action === "release" ? previousParentThreadId : nextParentThreadId;
  const parentTitle = action === "release" ? previousParentThreadTitle : nextParentThreadTitle;

  const parentLabel = parentTitle?.trim() || "parent";
  const suffix = ` ${verb} ${parentLabel}`;
  const threadName =
    row.title.endsWith(suffix) && row.title.length > suffix.length
      ? row.title.slice(0, row.title.length - suffix.length)
      : row.threadId;

  const shimmer = row.status === "pending";
  const segments: TimelineTitleSegment[] = [
    seg(threadName, {
      em: true,
      truncate: true,
      shimmer,
      ...(row.threadId ? { link: { kind: "thread", threadId: row.threadId } } : {}),
    }),
    seg(verb, { shimmer, accent: "muted" }),
    parentId === null
      ? seg("parent")
      : seg(parentTitle ?? parentId, {
          em: true,
          truncate: true,
          link: { kind: "thread", threadId: parentId },
        }),
  ];
  const decorations =
    row.status === "error"
      ? [statusDeco("error", null, true)]
      : row.status === "interrupted"
        ? [statusDeco("interrupted", null)]
        : [];
  return makeTitle(segments, decorations);
}

function mapSystemTitle(
  row: Extract<ThreadTimelineViewRow, { kind: "system" }>,
): TimelineTitle {
  if (row.systemKind === "operation" && row.operationKind === "parent-change") {
    return mapParentChangeTitle(row);
  }
  const hasError = row.systemKind === "error" || row.status === "error";
  const isReasoning =
    row.systemKind === "operation" && row.operationKind === "reasoning";
  const isCompaction =
    row.systemKind === "operation" && row.operationKind === "compaction";
  const isWarning =
    row.systemKind === "operation" &&
    (row.operationKind === "warning" || row.operationKind === "deprecation");

  const titleText = isReasoning
    ? row.status === "pending"
      ? "Thinking…"
      : "Thought"
    : isCompaction && row.status === "pending"
      ? `${row.title}…`
      : row.title;

  const decorations: TimelineTitleDecoration[] = hasError
    ? [statusDeco("error", null, true)]
    : isReasoning ||
        (isCompaction &&
          (row.status === "pending" || row.status === "completed"))
      ? compact([durationDeco(row.startedAt, row.completedAt)])
      : [];

  return makeTitle(
    [
      seg(titleText, {
        shimmer: row.status === "pending",
        truncate: true,
        ...(isWarning ? { accent: "warning" } : {}),
      }),
    ],
    decorations,
  );
}

export function buildTimelineActivityIntentTitles(
  row: TimelineExplorationWorkRow,
): TimelineActivityIntentTitle[] {
  if (!hasTimelineExplorationIntent(row)) return [];
  let lastKey: string | null = null;
  const titles: TimelineActivityIntentTitle[] = [];
  const badges = badgeDecos(row);
  const failure =
    row.status === "error" || row.status === "interrupted"
      ? row.status
      : undefined;

  timelineRowActivityIntents(row).forEach((intent, index) => {
    if (intent.type === "unknown") return;
    const key = getTimelineActivityIntentDetailDedupeKey(intent);
    if (key !== null && key === lastKey) return;

    const pending = row.status === "pending";
    const detail = formatTimelineActivityIntentParts(intent, "compact", pending);
    const plain = formatTimelineActivityIntentParts(intent, "full", pending);
    const segments: TimelineTitleSegment[] = [];
    if (detail.prefix) segments.push(seg(detail.prefix, { shimmer: pending }));
    segments.push(
      seg(detail.content, { truncate: true, plainText: plain.content }),
    );
    const decorations = [
      ...(titles.length === 0 ? badges : []),
      ...(failure ? [statusDeco(failure, null)] : []),
    ];

    titles.push({
      id: `${row.id}:activity-intent:${index}`,
      intent,
      intentType: intent.type,
      title: makeTitle(segments, decorations),
    });
    lastKey = key;
  });

  return titles;
}

export function findTimelineFrontierRow(
  rows: readonly ThreadTimelineViewRow[],
): ThreadTimelineViewRow | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    if (row.kind === "conversation" && row.role === "user") continue;
    return row;
  }
  return null;
}

export function findActiveLatestBundleId(
  rows: readonly ThreadTimelineViewRow[],
): string | null {
  const frontier = findTimelineFrontierRow(rows);
  return frontier?.kind === "bundle-summary" ? frontier.id : null;
}

export function buildTimelineRowTitle(
  row: ThreadTimelineViewRow,
  options: BuildTimelineRowTitleOptions,
): TimelineTitle {
  switch (row.kind) {
    case "conversation":
      return makeTitle([seg(row.role === "user" ? "User" : "Assistant")]);
    case "system":
      return mapSystemTitle(row);
    case "work":
      return mapWorkTitle(row, options);
    case "bundle-summary":
    case "step-summary":
      return mapWorkSummaryTitle(row, options);
    case "turn":
      return mapTurnTitle(row);
    default:
      return assertNever(row);
  }
}
