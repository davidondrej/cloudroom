import type {
  PromptInput,
  QueuedMessageSystemNotice,
  SystemMessageSubject,
  ThreadEventTurnStatus,
} from "@cloudroom/domain";
import {
  events,
  getLatestThreadOutputEventRow,
  getLatestThreadSequence,
  getThread,
  isThreadQueueAutoSendPaused,
  listActiveBackgroundTaskCountsByThreadIds,
  type DbConnection,
} from "@cloudroom/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { renderTemplate } from "@cloudroom/templates";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import {
  buildParentSystemInputFromTemplateSlot,
  buildParentSystemThreadMention,
  parentSystemThreadLabel,
  queueParentSystemMessage,
  type ParentSystemInputSegment,
  type ParentSystemMessageTaxonomy,
  type ParentSystemRenderedMention,
  type ParentSystemThreadMentionSource,
} from "./parent-system-messages.js";
import {
  childOutcomeSystemMessageKind,
  systemMessageKindForTemplate,
} from "./system-message-kind.js";
import { getLastThreadOutput, getTurnErrorText } from "./thread-data.js";
import { waitForHeldMessageDrain } from "./queued-message-dispatch.js";
import { isParentNotifiableChildThread } from "./thread-parent.js";

export type ChildThreadNotificationSource = ParentSystemThreadMentionSource;

export interface ChildThreadTurnNotificationBatchItem {
  activeBackgroundCommandCount?: number;
  activeWorkflowCount: number;
  childThread: ChildThreadNotificationSource;
  failureReason?: string | null;
  terminalOutput: string | null;
  turnStatus: ThreadEventTurnStatus;
}

type ChildReport = NonNullable<QueuedMessageSystemNotice["childReport"]>;

interface ChildThreadTurnNotificationBatch {
  /** When the first turn ended, and each child's latest event then (#1208). */
  childReport: ChildReport;
  items: ChildThreadTurnNotificationBatchItem[];
  timer: ReturnType<typeof setTimeout>;
}

interface ChildThreadTurnStatusBatchLine {
  item: ChildThreadTurnNotificationBatchItem;
  mention: ParentSystemRenderedMention;
}

interface RenderChildThreadTurnStatusBatchTextArgs {
  lines: ChildThreadTurnStatusBatchLine[];
}

interface FormatChildThreadTurnStatusLineArgs {
  line: ChildThreadTurnStatusBatchLine;
}

interface BuildChildThreadTurnStatusBatchInputArgs {
  items: ChildThreadTurnNotificationBatchItem[];
}

interface BuildChildThreadNeedsAttentionInputArgs {
  blockerSummary: string | null;
  childThread: ChildThreadNotificationSource;
}

interface QueueChildThreadTurnNotificationArgs {
  childThread: ChildThreadNotificationSource;
  parentThreadId: string;
  /** Why the child failed, when the caller already knows (feedback #390). */
  failureReason?: string | null;
  /** The turn that just ended; its reply is the only one worth reporting. */
  turnId?: string;
  turnStatus: ThreadEventTurnStatus;
}

interface QueueChildThreadNeedsAttentionNotificationArgs {
  blockerSummary: string | null;
  childThread: ChildThreadNotificationSource;
  parentThreadId: string;
}

const CHILD_THREAD_TURN_NOTIFICATION_BATCH_DELAY_MS = 2_000;
const CHILD_THREAD_OUTCOME_BATCH_UPDATES_SLOT =
  "__BB_CHILD_THREAD_OUTCOME_BATCH_UPDATES__";
const CHILD_THREAD_MENTION_SLOT = "__BB_CHILD_THREAD_MENTION__";
const CHILD_THREAD_TERMINAL_OUTPUT_EXCERPT_CHAR_LIMIT = 4_000;
const CHILD_THREAD_FAILURE_REASON_CHAR_LIMIT = 1_000;
const CHILD_THREAD_BATCH_FAILURE_REASON_CHAR_LIMIT = 300;
const CHILD_THREAD_OUTPUT_TRUNCATION_MARKER = "\n\n[... output truncated ...]";
const CHILD_THREAD_INSPECTION_GUIDANCE =
  "Review the thread before deciding next steps.";
const CHILD_THREAD_INTERRUPTED_GUIDANCE =
  "The user or Cloudroom may have stopped it. Only treat this as a request to stop if the user said so in this chat.";
const CHILD_THREAD_BATCH_INTERRUPTED_GUIDANCE =
  "The user or Cloudroom may have stopped these threads. Only treat this as a request to stop if the user said so in this chat.";
const CHILD_THREAD_NEEDS_ATTENTION_FALLBACK_SUMMARY =
  "It is blocked on a pending interaction.";
const CHILD_THREAD_RUNNING_WORKFLOW_GUIDANCE =
  "A workflow it started is still running, so this output is not its final result. The thread will report again when the workflow finishes.";
const CHILD_THREAD_BATCH_RUNNING_WORKFLOW_GUIDANCE =
  "Threads with a workflow still running have not finished; they will report again when their workflow does.";
const CHILD_THREAD_RUNNING_COMMAND_GUIDANCE =
  "Background commands it started are still running, so this may not be its final result. Check its thread if you need to know.";
const CHILD_THREAD_BATCH_RUNNING_COMMAND_GUIDANCE =
  "Threads with background commands still running may not have finished. Check their threads if you need to know.";
const childThreadTurnNotificationBatches = new Map<
  string,
  ChildThreadTurnNotificationBatch
>();
/** The last turn each waiting child reported while background work ran (#862). */
const waitingChildThreadNotifiedTurnIds = new Map<string, string>();

function childThreadTurnStatusLabel(turnStatus: ThreadEventTurnStatus): string {
  switch (turnStatus) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "was interrupted";
    default: {
      const exhaustiveCheck: never = turnStatus;
      return exhaustiveCheck;
    }
  }
}

function truncateChildThreadOutput(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  const retainedLength = Math.max(
    0,
    limit - CHILD_THREAD_OUTPUT_TRUNCATION_MARKER.length,
  );
  if (retainedLength === 0) {
    return CHILD_THREAD_OUTPUT_TRUNCATION_MARKER.trimStart();
  }
  return `${text.slice(0, retainedLength).trimEnd()}${CHILD_THREAD_OUTPUT_TRUNCATION_MARKER}`;
}

function formatChildThreadCompletionOutputExcerpt(
  output: string | null,
): string {
  const trimmedOutput = output?.trim();
  // A reply of only zero-width characters is empty too (feedback #427).
  if (!trimmedOutput?.replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "")) {
    return "No final output was recorded.";
  }
  return truncateChildThreadOutput(
    trimmedOutput,
    CHILD_THREAD_TERMINAL_OUTPUT_EXCERPT_CHAR_LIMIT,
  );
}

function formatChildThreadNeedsAttentionSummary(
  summary: string | null,
): string {
  const trimmedSummary = summary?.trim();
  if (!trimmedSummary) {
    return CHILD_THREAD_NEEDS_ATTENTION_FALLBACK_SUMMARY;
  }
  return trimmedSummary;
}

function hasRunningBackgroundCommands(
  item: ChildThreadTurnNotificationBatchItem,
): boolean {
  return (item.activeBackgroundCommandCount ?? 0) > 0;
}

function formatChildThreadRunningWorkClause(
  item: ChildThreadTurnNotificationBatchItem,
): string {
  const running = (
    [
      [item.activeWorkflowCount, "workflow"],
      [item.activeBackgroundCommandCount ?? 0, "background command"],
    ] as const
  ).flatMap(([count, noun]) =>
    count > 0 ? [`${count} ${noun}${count === 1 ? "" : "s"}`] : [],
  );
  return running.length === 0
    ? ""
    : `, with ${running.join(" and ")} still running`;
}

function buildSingleChildThreadTurnStatusSegments(
  args: FormatChildThreadTurnStatusLineArgs,
): ParentSystemInputSegment[] {
  const { line } = args;
  switch (line.item.turnStatus) {
    case "completed": {
      const guidance = [
        ...(line.item.activeWorkflowCount > 0
          ? [CHILD_THREAD_RUNNING_WORKFLOW_GUIDANCE]
          : []),
        ...(hasRunningBackgroundCommands(line.item)
          ? [CHILD_THREAD_RUNNING_COMMAND_GUIDANCE]
          : []),
      ]
        .map((text) => `\n\n${text}`)
        .join("");
      return [
        { kind: "mention", mention: line.mention },
        {
          kind: "text",
          text: ` completed${formatChildThreadRunningWorkClause(line.item)}:\n\n${formatChildThreadCompletionOutputExcerpt(line.item.terminalOutput)}${guidance}`,
        },
      ];
    }
    case "failed":
      return [
        { kind: "mention", mention: line.mention },
        {
          kind: "text",
          text: ` failed.${formatChildThreadFailureReason(line.item.failureReason, CHILD_THREAD_FAILURE_REASON_CHAR_LIMIT, "\n\nError: ")}\n\n${CHILD_THREAD_INSPECTION_GUIDANCE}`,
        },
      ];
    case "interrupted":
      return [
        { kind: "mention", mention: line.mention },
        {
          kind: "text",
          text: ` was interrupted.\n\n${CHILD_THREAD_INSPECTION_GUIDANCE}\n\n${CHILD_THREAD_INTERRUPTED_GUIDANCE}`,
        },
      ];
    default: {
      const exhaustiveCheck: never = line.item.turnStatus;
      return exhaustiveCheck;
    }
  }
}

function buildChildThreadBatchStatusLineSegments(
  args: FormatChildThreadTurnStatusLineArgs,
): ParentSystemInputSegment[] {
  const { line } = args;
  return [
    { kind: "mention", mention: line.mention },
    {
      kind: "text",
      text: ` ${childThreadTurnStatusLabel(line.item.turnStatus)}${formatChildThreadRunningWorkClause(line.item)}.${line.item.turnStatus === "failed" ? formatChildThreadFailureReason(line.item.failureReason, CHILD_THREAD_BATCH_FAILURE_REASON_CHAR_LIMIT, " Error: ") : ""}`,
    },
  ];
}

function formatChildThreadFailureReason(
  reason: string | null | undefined,
  limit: number,
  prefix: string,
): string {
  const trimmed = reason?.trim();
  return trimmed ? `${prefix}${truncateChildThreadOutput(trimmed, limit)}` : "";
}

function getChildThreadFailureReason(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueChildThreadTurnNotificationArgs,
): string | null {
  if (args.turnStatus !== "failed") return null;
  if (args.failureReason) return args.failureReason;
  return args.turnId === undefined
    ? null
    : getTurnErrorText(deps.db, args.childThread.id, args.turnId);
}

function getChildThreadCompletionOutput(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueChildThreadTurnNotificationArgs,
): string | null {
  if (args.turnStatus !== "completed") {
    return null;
  }
  return getLastThreadOutput(deps.db, args.childThread.id, args.turnId);
}

function getChildThreadRunningTaskCounts(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueChildThreadTurnNotificationArgs,
) {
  const [activity] = listActiveBackgroundTaskCountsByThreadIds(deps.db, {
    threadIds: [args.childThread.id],
  });
  return {
    activeBackgroundCommandCount: activity?.activeBackgroundCommandCount ?? 0,
    activeWorkflowCount: activity?.activeWorkflowCount ?? 0,
  };
}

/**
 * Whether a background task finished or a message reached the child since the
 * reported turn started. A result that lands while that turn is still writing,
 * or a `tell` steered into it, is answered in a later turn (#862).
 */
function hasChildThreadNewsSinceTurnStarted(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadId: string,
  turnId: string,
): boolean {
  const turnStart = alias(events, "reported_turn_start");
  const turnStartSequence = deps.db
    .select({ sequence: turnStart.sequence })
    .from(turnStart)
    .where(
      and(
        eq(turnStart.threadId, threadId),
        eq(turnStart.turnId, turnId),
        eq(turnStart.type, "turn/started"),
      ),
    )
    .limit(1);
  return (
    deps.db
      .select({ sequence: events.sequence })
      .from(events)
      .where(
        and(
          eq(events.threadId, threadId),
          inArray(events.type, [
            "item/backgroundTask/completed",
            "turn/input/accepted",
          ]),
          sql`${events.sequence} > coalesce((${turnStartSequence}), 0)`,
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

/**
 * A child that woke itself with no background work finished and no message
 * since its last report has nothing new, so its parent isn't woken again
 * (#862). Results, failures, and the final turn always report.
 */
function isRepeatedChildThreadWaitingUpdate(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueChildThreadTurnNotificationArgs,
  runningCount: number,
): boolean {
  const childThreadId = args.childThread.id;
  if (
    args.turnStatus !== "completed" ||
    runningCount === 0 ||
    args.turnId === undefined
  ) {
    waitingChildThreadNotifiedTurnIds.delete(childThreadId);
    return false;
  }
  const notifiedTurnId = waitingChildThreadNotifiedTurnIds.get(childThreadId);
  if (
    notifiedTurnId !== undefined &&
    !hasChildThreadNewsSinceTurnStarted(deps, childThreadId, notifiedTurnId)
  ) {
    return true;
  }
  waitingChildThreadNotifiedTurnIds.set(childThreadId, args.turnId);
  return false;
}

function buildChildThreadTurnStatusBatchSegments(
  args: RenderChildThreadTurnStatusBatchTextArgs,
): ParentSystemInputSegment[] {
  if (args.lines.length === 1 && args.lines[0]) {
    return buildSingleChildThreadTurnStatusSegments({
      line: args.lines[0],
    });
  }

  const segments: ParentSystemInputSegment[] = [];
  segments.push({ kind: "text", text: "Child thread updates:" });
  args.lines.forEach((line, index) => {
    segments.push({ kind: "text", text: index === 0 ? "\n\n- " : "\n- " });
    segments.push(...buildChildThreadBatchStatusLineSegments({ line }));
  });
  if (args.lines.some((line) => line.item.turnStatus === "interrupted")) {
    segments.push({
      kind: "text",
      text: `\n\n${CHILD_THREAD_BATCH_INTERRUPTED_GUIDANCE}`,
    });
  }
  if (args.lines.some((line) => line.item.activeWorkflowCount > 0)) {
    segments.push({
      kind: "text",
      text: `\n\n${CHILD_THREAD_BATCH_RUNNING_WORKFLOW_GUIDANCE}`,
    });
  }
  if (args.lines.some((line) => hasRunningBackgroundCommands(line.item))) {
    segments.push({
      kind: "text",
      text: `\n\n${CHILD_THREAD_BATCH_RUNNING_COMMAND_GUIDANCE}`,
    });
  }
  return segments;
}

function buildChildThreadTurnStatusBatchLines(
  args: BuildChildThreadTurnStatusBatchInputArgs,
): ChildThreadTurnStatusBatchLine[] {
  return args.items.map((item) => ({
    item,
    mention: buildParentSystemThreadMention({
      thread: item.childThread,
    }),
  }));
}

function childThreadSubject(
  thread: ChildThreadNotificationSource,
): SystemMessageSubject {
  return {
    kind: "thread",
    threadId: thread.id,
    threadName: parentSystemThreadLabel(thread),
  };
}

function childThreadTurnStatusBatchTaxonomy(
  items: ChildThreadTurnNotificationBatchItem[],
): ParentSystemMessageTaxonomy {
  const single = items.length === 1 ? items[0] : undefined;
  if (single) {
    return {
      systemMessageKind: childOutcomeSystemMessageKind(single.turnStatus),
      systemMessageSubject: childThreadSubject(single.childThread),
    };
  }
  return {
    systemMessageKind: "child-outcome-batch",
    systemMessageSubject: { kind: "thread-batch", count: items.length },
  };
}

export function buildChildThreadTurnStatusBatchInput(
  args: BuildChildThreadTurnStatusBatchInputArgs,
): PromptInput[] {
  const lines = buildChildThreadTurnStatusBatchLines(args);
  const renderedText = renderTemplate("systemMessageChildThreadOutcomeBatch", {
    updates: CHILD_THREAD_OUTCOME_BATCH_UPDATES_SLOT,
  });
  return buildParentSystemInputFromTemplateSlot({
    renderedText,
    slot: CHILD_THREAD_OUTCOME_BATCH_UPDATES_SLOT,
    segments: buildChildThreadTurnStatusBatchSegments({ lines }),
  });
}

export function buildChildThreadNeedsAttentionInput(
  args: BuildChildThreadNeedsAttentionInputArgs,
): PromptInput[] {
  const mention = buildParentSystemThreadMention({
    thread: args.childThread,
  });
  const renderedText = renderTemplate(
    "systemMessageChildThreadNeedsAttention",
    {
      blockerSummary: formatChildThreadNeedsAttentionSummary(
        args.blockerSummary,
      ),
      threadMention: CHILD_THREAD_MENTION_SLOT,
    },
  );
  return buildParentSystemInputFromTemplateSlot({
    renderedText,
    slot: CHILD_THREAD_MENTION_SLOT,
    segments: [{ kind: "mention", mention }],
  });
}

function childThreadTurnNotificationLogMessage(
  turnStatus: ThreadEventTurnStatus,
): string {
  switch (turnStatus) {
    case "completed":
      return "Failed to queue parent completed-thread notification";
    case "failed":
      return "Failed to queue parent failed-thread notification";
    case "interrupted":
      return "Failed to queue parent interrupted-thread notification";
    default: {
      const exhaustiveCheck: never = turnStatus;
      return exhaustiveCheck;
    }
  }
}

async function flushChildThreadTurnNotificationBatch(
  deps: LoggedPendingInteractionWorkSessionDeps,
  parentThreadId: string,
): Promise<void> {
  const batch = childThreadTurnNotificationBatches.get(parentThreadId);
  if (!batch) {
    return;
  }
  childThreadTurnNotificationBatches.delete(parentThreadId);

  try {
    // Progress messages a settled interaction just released go first (#851).
    await waitForHeldMessageDrain(parentThreadId);
    await queueParentSystemMessage(deps, {
      input: buildChildThreadTurnStatusBatchInput({
        items: batch.items,
      }),
      parentThreadId,
      ...childThreadTurnStatusBatchTaxonomy(batch.items),
      childReport: batch.childReport,
    });
  } catch (error) {
    deps.logger.error(
      {
        err: error,
        parentThreadId,
        childThreads: batch.items.map((item) => ({
          childThreadId: item.childThread.id,
          turnStatus: item.turnStatus,
        })),
      },
      "Failed to queue batched parent turn notifications",
    );
  }
}

function scheduleChildThreadTurnNotificationBatchFlush(
  deps: LoggedPendingInteractionWorkSessionDeps,
  parentThreadId: string,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    void flushChildThreadTurnNotificationBatch(deps, parentThreadId);
  }, CHILD_THREAD_TURN_NOTIFICATION_BATCH_DELAY_MS);
}

function queueChildThreadTurnNotificationBatchItem(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueChildThreadTurnNotificationArgs,
): void {
  const counts = getChildThreadRunningTaskCounts(deps, args);
  if (
    isRepeatedChildThreadWaitingUpdate(
      deps,
      args,
      counts.activeWorkflowCount + counts.activeBackgroundCommandCount,
    )
  ) {
    return;
  }
  const item: ChildThreadTurnNotificationBatchItem = {
    ...counts,
    childThread: args.childThread,
    failureReason: getChildThreadFailureReason(deps, args),
    terminalOutput: getChildThreadCompletionOutput(deps, args),
    turnStatus: args.turnStatus,
  };
  const sequence = getLatestThreadSequence(deps.db, {
    threadId: args.childThread.id,
  });
  const existingBatch = childThreadTurnNotificationBatches.get(
    args.parentThreadId,
  );
  if (existingBatch) {
    existingBatch.childReport.sequences[args.childThread.id] = sequence;
    const existingIndex = existingBatch.items.findIndex(
      (entry) => entry.childThread.id === args.childThread.id,
    );
    if (existingIndex === -1) {
      existingBatch.items.push(item);
    } else {
      existingBatch.items[existingIndex] = item;
    }
    clearTimeout(existingBatch.timer);
    existingBatch.timer = scheduleChildThreadTurnNotificationBatchFlush(
      deps,
      args.parentThreadId,
    );
    return;
  }

  childThreadTurnNotificationBatches.set(args.parentThreadId, {
    childReport: {
      at: Date.now(),
      sequences: { [args.childThread.id]: sequence },
    },
    items: [item],
    timer: scheduleChildThreadTurnNotificationBatchFlush(
      deps,
      args.parentThreadId,
    ),
  });
}

function isQuietChildThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueChildThreadTurnNotificationArgs,
): boolean {
  return (
    getThread(deps.db, args.childThread.id)?.visibility === "hidden" &&
    getThread(deps.db, args.parentThreadId)?.visibility === "visible"
  );
}

export async function queueChildThreadTurnNotificationBestEffort(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueChildThreadTurnNotificationArgs,
): Promise<void> {
  try {
    if (isQuietChildThread(deps, args)) return;
    queueChildThreadTurnNotificationBatchItem(deps, args);
  } catch (error) {
    deps.logger.error(
      {
        childThreadId: args.childThread.id,
        parentThreadId: args.parentThreadId,
        turnStatus: args.turnStatus,
        err: error,
      },
      childThreadTurnNotificationLogMessage(args.turnStatus),
    );
  }
}

export async function queueChildThreadNeedsAttentionNotificationBestEffort(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueChildThreadNeedsAttentionNotificationArgs,
): Promise<void> {
  try {
    await queueParentSystemMessage(deps, {
      input: buildChildThreadNeedsAttentionInput({
        blockerSummary: args.blockerSummary,
        childThread: args.childThread,
      }),
      parentThreadId: args.parentThreadId,
      systemMessageKind: systemMessageKindForTemplate(
        "systemMessageChildThreadNeedsAttention",
      ),
      systemMessageSubject: childThreadSubject(args.childThread),
    });
  } catch (error) {
    deps.logger.error(
      {
        childThreadId: args.childThread.id,
        parentThreadId: args.parentThreadId,
        err: error,
      },
      "Failed to queue parent needs-attention notification",
    );
  }
}

/** A queued child report this old says when it is from (#1208). */
const CHILD_THREAD_LATE_NOTICE_MS = 15 * 60_000;
/** The line {@link withChildReportAge} adds, replaced on each delivery. */
const CHILD_THREAD_NOTICE_AGE_LINE =
  /\n\n(?:From [^\n]* \(\d+ (?:min|h) ago\)|(?:This child has|Children with) newer output: room-cli thread output )[^\n]*$/u;

function formatChildNoticeAge(at: number, ageMs: number): string {
  const date = new Date(at);
  const minutes = Math.max(1, Math.floor(ageMs / 60_000));
  const ago =
    minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`;
  return `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} (${ago})`;
}

/**
 * A child report the queue held says when its turns ended once it is late,
 * and which children have written output since, so the parent can't take an
 * old result for the latest (#1208). The line is rebuilt on every delivery,
 * because a notice re-queued behind a starting turn keeps the text it got.
 */
export function withChildReportAge(
  db: DbConnection,
  input: PromptInput[],
  report: ChildReport | undefined,
): PromptInput[] {
  const last = input.at(-1);
  if (report === undefined || last?.type !== "text") return input;
  const children = Object.entries(report.sequences);
  const newer = children.flatMap(([threadId, sequence]) =>
    (getLatestThreadOutputEventRow(db, { threadId })?.sequence ?? 0) > sequence
      ? [`room-cli thread output ${threadId}`]
      : [],
  );
  const ageMs = Date.now() - report.at;
  const newerOutput =
    newer.length === 0
      ? ""
      : `${children.length === 1 ? "this child has" : "children with"} newer output: ${newer.join(", ")}`;
  const line =
    ageMs >= CHILD_THREAD_LATE_NOTICE_MS
      ? `From ${formatChildNoticeAge(report.at, ageMs)}${newerOutput ? `; ${newerOutput}` : "."}`
      : `${newerOutput.charAt(0).toUpperCase()}${newerOutput.slice(1)}`;
  const text = last.text.replace(CHILD_THREAD_NOTICE_AGE_LINE, "");
  return [
    ...input.slice(0, -1),
    { ...last, text: line ? `${text}\n\n${line}` : text },
  ];
}

const CHILD_THREAD_LOST_WORK_GUIDANCE =
  "Nothing was rerun, and lost work never reports back. Check the thread before running anything again.";

/**
 * A child waiting on background work never hears that a Cloudroom restart
 * ended it, so its parent is told once (#1026). Skips a stopped child.
 */
export async function queueChildThreadLostBackgroundWorkNotifications(
  deps: LoggedPendingInteractionWorkSessionDeps,
  lost: ReadonlyMap<string, readonly { itemId: string; description: string }[]>,
): Promise<void> {
  const byParent = new Map<
    string,
    { child: ChildThreadNotificationSource; names: string[] }[]
  >();
  for (const [threadId, tasks] of lost) {
    if (tasks.length === 0) continue;
    const child = getThread(deps.db, threadId);
    if (
      (child?.status !== "idle" && child?.status !== "error") ||
      child.archivedAt !== null ||
      child.deletedAt !== null ||
      !isParentNotifiableChildThread(child) ||
      (child.visibility === "hidden" &&
        getThread(deps.db, child.parentThreadId)?.visibility === "visible") ||
      isThreadQueueAutoSendPaused(deps.db, threadId)
    ) {
      continue;
    }
    const names = tasks.map(
      ({ description: d }) => `"${d.length > 80 ? `${d.slice(0, 79)}…` : d}"`,
    );
    const siblings = byParent.get(child.parentThreadId) ?? [];
    byParent.set(child.parentThreadId, [...siblings, { child, names }]);
  }
  for (const [parentThreadId, children] of byParent) {
    const segments = children.flatMap(
      ({ child, names }, index): ParentSystemInputSegment[] => [
        ...(children.length > 1
          ? [{ kind: "text" as const, text: index === 0 ? "- " : "\n- " }]
          : []),
        {
          kind: "mention",
          mention: buildParentSystemThreadMention({ thread: child }),
        },
        {
          kind: "text",
          text: ` lost its background work when Cloudroom restarted: ${names.join(", ")}.`,
        },
      ],
    );
    const single = children.length === 1 ? children[0]!.child : null;
    await queueParentSystemMessage(deps, {
      input: buildParentSystemInputFromTemplateSlot({
        renderedText: renderTemplate("systemMessageChildThreadOutcomeBatch", {
          updates: CHILD_THREAD_OUTCOME_BATCH_UPDATES_SLOT,
        }),
        slot: CHILD_THREAD_OUTCOME_BATCH_UPDATES_SLOT,
        segments: [
          ...segments,
          { kind: "text", text: `\n\n${CHILD_THREAD_LOST_WORK_GUIDANCE}` },
        ],
      }),
      parentThreadId,
      systemMessageKind: single
        ? systemMessageKindForTemplate("systemMessageChildThreadNeedsAttention")
        : "child-outcome-batch",
      systemMessageSubject: single
        ? childThreadSubject(single)
        : { kind: "thread-batch", count: children.length },
    }).catch(() => undefined);
  }
}
