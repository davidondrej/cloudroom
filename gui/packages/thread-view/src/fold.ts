import {
  LOCAL_WORKFLOW_TASK_TYPE,
  isBackgroundAgentTaskType,
  isBackgroundCommandTaskType,
  requireThreadEventScopeTurnId,
  type ActiveThinking,
  type CompletedTurnDisplay,
  type Thread,
  type ThreadEvent,
  type ThreadTimelineActivePromptMode,
  type ThreadTimelineGoal,
  type ThreadTimelineModelFallback,
  type ThreadTimelinePendingTodos,
} from "@cloudroom/domain";
import type {
  ThreadContextWindowUsage,
  TimelineApprovalWorkRow,
  TimelineConversationRow,
  TimelineQuestionWorkRow,
  TimelineRow,
  TimelineRowStatus,
  TimelineSourceRow,
  TimelineSystemRow,
  TimelineUserConversationRow,
  TimelineWorkflowWorkRow,
} from "@cloudroom/server-contract";

type TimelineAssistantConversationRow = Extract<
  TimelineConversationRow,
  { role: "assistant" }
>;
import {
  EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT,
  bufferedTextKey,
  buildAcceptedClientRequestById,
  buildRejectedClientRequestById,
  getEventParentToolCallId,
  getEventProviderThreadId,
  getEventTurnId,
  orderEvents,
  resolveBufferedTextIdentity,
  type AcceptedClientRequest,
  type AcceptedClientRequestContext,
  type EventMeta,
  type ThreadEventWithMeta,
} from "./events.js";
import {
  extractThreadContextWindowUsage,
  extractThreadTimelineActivePromptMode,
  extractThreadTimelineGoal,
  extractThreadTimelineModelFallback,
  extractThreadTimelinePendingTodos,
  type PlanCommand,
} from "./extractors.js";
import {
  buildClientUserRows,
  buildErrorRow,
  buildLegacyUserRow,
  buildProviderUserRow,
  finalizeOperationRow,
  formatProvisioningDetail,
  interruptOperationRow,
  mergeProvisioningState,
  parseOperationEvent,
  provisioningTitleForStatus,
  resolveTurnRequestKind,
  shouldPreservePendingMessages,
  type ClientTurnRequestedEvent,
  type ProvisioningState,
} from "./messages.js";
import {
  createToolsState,
  flushPendingToolOutputs,
  interruptPendingFileEdits,
  interruptPendingTools,
  projectToolEvent,
  type ToolsState,
} from "./tools.js";
import { assembleTimelineRows } from "./turns.js";
import {
  appendVisibleTextBuffer,
  createVisibleTextBuffer,
  durationToCompactString,
  flushVisibleTextBuffer,
  getVisibleTextBufferFullText,
  getVisibleTextBufferText,
  messageId,
  setVisibleTextBuffer,
  type VisibleTextBuffer,
} from "./utils.js";

const MAX_REASONING_DETAIL_CHARS = 32_000;

interface ReasoningLifecycle {
  key: string;
  threadId: string;
  turnId: string;
  parentToolCallId: string | null;
  sourceSeqStart: number;
  startedAt: number;
  updatedAt: number;
  updatedSeq: number;
  buffer: VisibleTextBuffer;
  deltaSummary: string;
  deltaContent: string;
}

type OpRow = Extract<TimelineSystemRow, { systemKind: "operation" }>;
type PermGrantRow = Extract<
  TimelineApprovalWorkRow,
  { approvalKind: "permission-grant" }
>;

interface FoldState {
  rows: TimelineSourceRow[];
  parentByRow: Map<TimelineSourceRow, string>;
  legacyAssistantIds: Set<string>;
  tools: ToolsState;
  seenUserIds: Set<string>;
  openTurnIds: Set<string>;
  lastStartedTurnId: string | null;
  closedTurnIds: Set<string>;
  interruptedTurnCompletedAt: Map<string, number>;
  threadInterruptedAt: number | null;
  // Delegation turn links
  delegationParentByProviderThread: Map<string, string>;
  delegationParentByTurn: Map<string, string>;
  suppressedRootParentByTurn: Map<string, string>;
  pendingDelegationLinks: Map<string, { callId: string; parentTurnId: string }[]>;
  queuedDelegationLinkCallIds: Set<string>;
  // Assistant streaming
  openAssistants: Map<
    string,
    {
      row: TimelineAssistantConversationRow;
      buffer: VisibleTextBuffer;
      visible: boolean;
    }
  >;
  finalizedAssistantKeys: Set<string>;
  // Reasoning streaming
  openReasoning: Map<string, ReasoningLifecycle>;
  finalizedReasoningKeys: Set<string>;
  reasoningAwaitingCompletion: Map<
    string,
    { row: OpRow; deltaSummary: string; deltaContent: string }
  >;
  // Operations & interactions
  openCompactions: Map<string, OpRow>;
  finalizedCompactionKeys: Set<string>;
  provisioningByScopedKey: Map<string, OpRow>;
  provisioningStateByRow: Map<TimelineSystemRow, ProvisioningState>;
  threadOpsByScopedKey: Map<string, OpRow>;
  repeatedWarnings: Map<string, { row: OpRow; count: number }>;
  permGrantsByScopedKey: Map<string, PermGrantRow>;
  questionsByScopedKey: Map<string, TimelineQuestionWorkRow>;
}

function createFoldState(workspaceRoot: string | null): FoldState {
  const rows: TimelineSourceRow[] = [];
  const parentByRow = new Map<TimelineSourceRow, string>();
  return {
    rows,
    parentByRow,
    legacyAssistantIds: new Set(),
    tools: createToolsState(rows, parentByRow, workspaceRoot),
    seenUserIds: new Set(),
    openTurnIds: new Set(),
    lastStartedTurnId: null,
    closedTurnIds: new Set(),
    interruptedTurnCompletedAt: new Map(),
    threadInterruptedAt: null,
    delegationParentByProviderThread: new Map(),
    delegationParentByTurn: new Map(),
    suppressedRootParentByTurn: new Map(),
    pendingDelegationLinks: new Map(),
    queuedDelegationLinkCallIds: new Set(),
    openAssistants: new Map(),
    finalizedAssistantKeys: new Set(),
    openReasoning: new Map(),
    finalizedReasoningKeys: new Set(),
    reasoningAwaitingCompletion: new Map(),
    openCompactions: new Map(),
    finalizedCompactionKeys: new Set(),
    provisioningByScopedKey: new Map(),
    provisioningStateByRow: new Map(),
    threadOpsByScopedKey: new Map(),
    repeatedWarnings: new Map(),
    permGrantsByScopedKey: new Map(),
    questionsByScopedKey: new Map(),
  };
}

// ── Reasoning & Assistant Helpers ────────────────────────────────────────────

function normalizeReasoningDetail(detail: string): string {
  const trimmed = detail.trim();
  if (trimmed.length <= MAX_REASONING_DETAIL_CHARS) return trimmed;
  const dropped = trimmed.length - MAX_REASONING_DETAIL_CHARS;
  return `${trimmed.slice(0, MAX_REASONING_DETAIL_CHARS)}\n…[${dropped.toLocaleString("en-US")} more characters truncated]`;
}

function finalizeReasoningKey(
  state: FoldState,
  key: string,
  meta: EventMeta,
  status: "completed" | "interrupted",
  awaitCompletion: boolean,
): void {
  const lc = state.openReasoning.get(key);
  state.openReasoning.delete(key);
  state.finalizedReasoningKeys.add(key);
  if (!lc) return;

  const fullText = getVisibleTextBufferFullText(lc.buffer);
  if (fullText.trim().length === 0) return;

  const durationMs = meta.createdAt - lc.startedAt;
  const id = messageId(lc.threadId, "op", `reasoning:${lc.key}`);
  const row: OpRow = {
    id,
    threadId: lc.threadId,
    turnId: lc.turnId,
    sourceSeqStart: lc.sourceSeqStart,
    sourceSeqEnd: meta.seq,
    startedAt: lc.startedAt,
    createdAt: meta.createdAt,
    completedAt: meta.createdAt,
    kind: "system",
    systemKind: "operation",
    operationKind: "reasoning",
    reasoningId: id,
    title:
      durationMs > 0
        ? `Thought for ${durationToCompactString(durationMs)}`
        : "Thought",
    detail: normalizeReasoningDetail(fullText),
    status,
  };
  if (lc.parentToolCallId) state.parentByRow.set(row, lc.parentToolCallId);
  state.rows.push(row);
  if (awaitCompletion) {
    state.reasoningAwaitingCompletion.set(key, {
      row,
      deltaSummary: lc.deltaSummary,
      deltaContent: lc.deltaContent,
    });
  }
}

function flushAssistants(
  state: FoldState,
  turnIdFilter?: string,
): void {
  if (state.openAssistants.size === 0) return;
  const entries = [...state.openAssistants.entries()]
    .filter(
      ([, e]) => turnIdFilter === undefined || e.row.turnId === turnIdFilter,
    )
    .sort(
      (a, b) =>
        a[1].row.sourceSeqStart - b[1].row.sourceSeqStart ||
        a[1].row.sourceSeqEnd - b[1].row.sourceSeqEnd ||
        a[1].row.createdAt - b[1].row.createdAt,
    );

  for (const [key, entry] of entries) {
    flushVisibleTextBuffer(entry.buffer);
    const text = getVisibleTextBufferText(entry.buffer);
    if (text) {
      entry.row.text = text;
      if (!entry.visible) {
        state.rows.push(entry.row);
        entry.visible = true;
      }
    }
    state.finalizedAssistantKeys.add(key);
    state.openAssistants.delete(key);
  }
}

function projectAssistantOrReasoning(
  state: FoldState,
  event: ThreadEvent,
  meta: EventMeta,
  turnId: string | undefined,
  parentToolCallId: string | undefined,
): boolean {
  // Assistant delta / completed
  const assistId = resolveBufferedTextIdentity(
    event,
    "assistant",
    turnId,
    parentToolCallId,
  );
  if (assistId) {
    const isDelta =
      event.type === "item/agentMessage/delta" ||
      event.type === "item/plan/delta";
    const text = isDelta
      ? event.delta
      : event.type === "item/completed" &&
          (event.item.type === "agentMessage" || event.item.type === "plan")
        ? event.item.text
        : "";
    if (text.length === 0) return false;

    const key = bufferedTextKey(assistId);
    if (
      state.closedTurnIds.has(assistId.turnId) ||
      state.finalizedAssistantKeys.has(key)
    ) {
      return true;
    }
    state.openTurnIds.add(assistId.turnId);

    let entry = state.openAssistants.get(key);
    if (!entry) {
      const row: TimelineAssistantConversationRow = {
        id: messageId(event.threadId, "assistant", key),
        threadId: event.threadId,
        turnId: assistId.turnId,
        sourceSeqStart: meta.seq,
        sourceSeqEnd: meta.seq,
        startedAt: meta.createdAt,
        createdAt: meta.createdAt,
        kind: "conversation",
        role: "assistant",
        text: "",
        attachments: null,
        turnRequest: null,
      };
      if (parentToolCallId) state.parentByRow.set(row, parentToolCallId);
      entry = { row, buffer: createVisibleTextBuffer(), visible: false };
      state.openAssistants.set(key, entry);
    } else {
      entry.row.sourceSeqEnd = meta.seq;
      entry.row.createdAt = meta.createdAt;
    }

    if (isDelta) {
      appendVisibleTextBuffer(entry.buffer, text);
      const visible = getVisibleTextBufferText(entry.buffer);
      if (visible) {
        entry.row.text = visible;
        if (!entry.visible) {
          state.rows.push(entry.row);
          entry.visible = true;
        }
      }
    } else {
      setVisibleTextBuffer(entry.buffer, text, true);
      const visible = getVisibleTextBufferText(entry.buffer);
      if (visible) {
        entry.row.text = visible;
        if (!entry.visible) {
          state.rows.push(entry.row);
          entry.visible = true;
        }
      }
      state.openAssistants.delete(key);
      state.finalizedAssistantKeys.add(key);
    }
    return true;
  }

  // Reasoning lifecycle
  const reasonId = resolveBufferedTextIdentity(
    event,
    "reasoning",
    turnId,
    parentToolCallId,
  );
  if (!reasonId) return false;

  const key = bufferedTextKey(reasonId);
  if (
    !state.closedTurnIds.has(reasonId.turnId) &&
    !state.finalizedReasoningKeys.has(key)
  ) {
    state.openTurnIds.add(reasonId.turnId);
    const existing = state.openReasoning.get(key);
    if (existing) {
      existing.updatedAt = meta.createdAt;
      existing.updatedSeq = meta.seq;
    } else {
      state.openReasoning.set(key, {
        key,
        threadId: event.threadId,
        turnId: reasonId.turnId,
        parentToolCallId: parentToolCallId ?? null,
        sourceSeqStart: meta.seq,
        startedAt: meta.createdAt,
        updatedAt: meta.createdAt,
        updatedSeq: meta.seq,
        buffer: createVisibleTextBuffer(),
        deltaSummary: "",
        deltaContent: "",
      });
    }
  }

  if (
    event.type === "item/reasoning/summaryTextDelta" ||
    event.type === "item/reasoning/textDelta"
  ) {
    if (event.delta.length === 0) return false;
    const lc = state.openReasoning.get(key);
    if (lc) {
      if (event.type === "item/reasoning/summaryTextDelta") {
        lc.deltaSummary += event.delta;
      } else {
        lc.deltaContent += event.delta;
      }
      appendVisibleTextBuffer(lc.buffer, event.delta);
    }
    return true;
  }

  if (event.type === "item/completed" && event.item.type === "reasoning") {
    const summaryStr = event.item.summary.join("");
    const contentStr = event.item.content.join("");
    const combined = `${summaryStr}${contentStr}`;
    const lc = state.openReasoning.get(key);
    const awaiting = state.reasoningAwaitingCompletion.get(key);
    const deltaSnapshot = lc ?? awaiting;
    const sameAsDeltas =
      deltaSnapshot !== undefined &&
      deltaSnapshot.deltaSummary === summaryStr &&
      deltaSnapshot.deltaContent === contentStr;
    const finalText = combined.length > 0 && !sameAsDeltas ? combined : null;

    if (finalText && lc) {
      setVisibleTextBuffer(lc.buffer, finalText, true);
    }

    if (awaiting) {
      state.reasoningAwaitingCompletion.delete(key);
      awaiting.row.sourceSeqEnd = meta.seq;
      if (finalText?.trim()) {
        awaiting.row.detail = normalizeReasoningDetail(finalText);
      }
    } else {
      finalizeReasoningKey(state, key, meta, "completed", false);
    }
    return combined.length > 0;
  }

  return false;
}

// ── Compaction & Keyed Operation Upserts ─────────────────────────────────────

function compactionKey(event: ThreadEvent, meta: EventMeta): string {
  if (event.type === "thread/compacted") {
    return requireThreadEventScopeTurnId({ type: event.type, scope: event.scope });
  }
  const turnId = getEventTurnId(event);
  if (event.type === "item/started" || event.type === "item/completed") {
    return turnId ?? event.item.id;
  }
  return turnId ?? `seq-${meta.seq}`;
}

function finalizeOpenCompactionRow(
  row: OpRow,
  meta: EventMeta,
  status: "completed" | "error" | "interrupted",
  detail: string | undefined,
): void {
  row.sourceSeqEnd = Math.max(row.sourceSeqEnd, meta.seq);
  row.createdAt = Math.max(row.createdAt, meta.createdAt);
  row.completedAt = meta.createdAt;
  row.status = status;
  row.title =
    status === "error"
      ? "Context compaction failed"
      : status === "completed"
        ? "Context compaction skipped"
        : "Context compaction interrupted";
  if (detail !== undefined) row.detail = detail;
}

function mergeBounds(target: TimelineSourceRow, incoming: TimelineSourceRow): void {
  if (target.turnId !== incoming.turnId) {
    throw new Error(`Cannot merge ${target.kind} messages with different scopes`);
  }
  target.sourceSeqStart = Math.min(target.sourceSeqStart, incoming.sourceSeqStart);
  target.sourceSeqEnd = Math.max(target.sourceSeqEnd, incoming.sourceSeqEnd);
  target.startedAt = Math.min(target.startedAt, incoming.startedAt);
  target.createdAt = Math.max(target.createdAt, incoming.createdAt);
}

function mergeDetails(a: string | null, b: string | null): string | null {
  const parts = [a, b].filter((v): v is string => Boolean(v));
  return parts.length === 0 ? null : [...new Set(parts)].join("\n");
}

// ── Active State Selection (Thinking, Workflows, Background Commands) ────────

function buildActiveThinking(
  state: FoldState,
  threadStatus: Thread["status"] | undefined,
): ActiveThinking | null {
  if (threadStatus !== "active") return null;
  let latest: ReasoningLifecycle | null = null;
  for (const lc of state.openReasoning.values()) {
    if (
      !latest ||
      lc.updatedSeq > latest.updatedSeq ||
      (lc.updatedSeq === latest.updatedSeq && lc.updatedAt > latest.updatedAt)
    ) {
      latest = lc;
    }
  }
  if (!latest) return null;
  return {
    id: messageId(latest.threadId, "op", `reasoning:${latest.key}`),
    text: (getVisibleTextBufferText(latest.buffer) ?? "").trim(),
    startedAt: latest.startedAt,
    updatedAt: latest.updatedAt,
  };
}

function selectActiveBackgroundLists(
  state: FoldState,
  visibleRows: readonly TimelineSourceRow[],
): {
  activeWorkflows: TimelineWorkflowWorkRow[];
  activeBackgroundCommands: TimelineWorkflowWorkRow[];
} {
  if (state.tools.backgroundTasksByItemId.size === 0) {
    return { activeWorkflows: [], activeBackgroundCommands: [] };
  }
  const callById = new Map<string, TimelineSourceRow>();
  for (const row of visibleRows) {
    if (row.kind === "work" && "callId" in row) {
      callById.set(row.callId, row);
    }
  }

  const isDirect = (row: TimelineWorkflowWorkRow): boolean => {
    const parentId = state.parentByRow.get(row);
    if (!parentId) return true;
    const call = callById.get(parentId);
    return call ? !state.parentByRow.has(call) : true;
  };

  const rootSpawningCallId = (row: TimelineWorkflowWorkRow): string | undefined => {
    let callId = state.parentByRow.get(row);
    const seen = new Set<string>();
    while (callId && !seen.has(callId)) {
      seen.add(callId);
      const call = callById.get(callId);
      const next = call ? state.parentByRow.get(call) : undefined;
      if (!next) return callId;
      callId = next;
    }
    return undefined;
  };

  // Enrich background agent models across task families (only from native delegation models)
  const modelByFamily = new Map<string, string>();
  for (const entry of state.tools.backgroundTasksByItemId.values()) {
    if (!isBackgroundAgentTaskType(entry.row.taskType)) continue;
    const genMatch = /#(\d+)$/.exec(entry.row.itemId);
    const familyKey =
      entry.familyId !== null
        ? `family:${entry.familyId}`
        : genMatch && Number(genMatch[1]) > 1
          ? entry.row.itemId.slice(0, -genMatch[0].length)
          : entry.row.itemId;
    const parentId = state.parentByRow.get(entry.row);
    const parentModel = parentId
      ? state.tools.delegationModelByCallId.get(parentId)
      : undefined;
    const model =
      parentModel ?? entry.row.model ?? modelByFamily.get(familyKey) ?? null;
    entry.row.model = model;
    if (model !== null) modelByFamily.set(familyKey, model);
  }

  const workflows: TimelineWorkflowWorkRow[] = [];
  const bgCandidates: TimelineWorkflowWorkRow[] = [];
  const representedRoots = new Set<string>();

  for (const row of visibleRows) {
    if (row.kind !== "work" || row.workKind !== "workflow" || row.status !== "pending") {
      continue;
    }
    const parentId = state.parentByRow.get(row);
    if (parentId && isDirect(row)) representedRoots.add(parentId);
    if (row.taskType === LOCAL_WORKFLOW_TASK_TYPE) {
      workflows.push(row);
    } else {
      bgCandidates.push(row);
    }
  }

  const bgCommands = bgCandidates.filter((row) => {
    const direct = isDirect(row);
    if (!direct) {
      const rootId = rootSpawningCallId(row);
      if (rootId !== undefined && representedRoots.has(rootId)) return false;
      if (!isBackgroundCommandTaskType(row.taskType)) return false;
    }
    return true;
  });

  workflows.sort((a, b) => b.startedAt - a.startedAt);
  bgCommands.sort((a, b) => b.startedAt - a.startedAt);
  return { activeWorkflows: workflows, activeBackgroundCommands: bgCommands };
}

/** A finished background command shows as its own row. Local links it to the Bash call that started it, and a linked
 *  row whose parent is no subagent would be dropped, so the link goes, unless a subagent ran the command. */
function unlinkFinishedBackgroundCommands(
  state: FoldState,
  rows: readonly TimelineSourceRow[],
): void {
  const callById = new Map<string, TimelineSourceRow>();
  for (const row of rows) {
    if (row.kind === "work" && "callId" in row) callById.set(row.callId, row);
  }
  for (const row of rows) {
    if (
      row.kind !== "work" ||
      row.workKind !== "workflow" ||
      row.status === "pending" ||
      !isBackgroundCommandTaskType(row.taskType)
    ) {
      continue;
    }
    const parent = state.parentByRow.get(row);
    if (parent === undefined) continue;
    const call = callById.get(parent);
    if (!(call && state.parentByRow.has(call))) state.parentByRow.delete(row);
  }
}

// ── Pending / Rejected Steer Rows ────────────────────────────────────────────

function buildPendingSteerRows(
  context: AcceptedClientRequestContext,
  ordered: readonly ThreadEventWithMeta[],
  threadStatus: Thread["status"],
): TimelineUserConversationRow[] {
  const acceptedById = buildAcceptedClientRequestById(context, ordered);
  const rejectedById = buildRejectedClientRequestById(context, ordered);
  const inWindowRejected = new Set<string>();
  const legacyRejectedMeta = new Map<string, EventMeta>();
  const unresolvedSteers = new Set<string>();
  const unresolvedOrder: string[] = [];
  let explicitNeedsCompanion = false;

  for (const { event, meta } of ordered) {
    if (
      event.type === "client/turn/requested" &&
      (event.target.kind === "auto" || event.target.kind === "steer") &&
      event.target.expectedTurnId !== null
    ) {
      unresolvedSteers.add(event.requestId);
      unresolvedOrder.push(event.requestId);
      explicitNeedsCompanion = false;
    } else if (event.type === "turn/input/accepted") {
      unresolvedSteers.delete(event.clientRequestId);
      explicitNeedsCompanion = false;
    } else if (event.type === "client/turn/rejected") {
      inWindowRejected.add(event.requestId);
      unresolvedSteers.delete(event.requestId);
      explicitNeedsCompanion = true;
    } else if (
      event.type === "system/error" &&
      event.code === "thread_command_failed"
    ) {
      if (explicitNeedsCompanion) {
        explicitNeedsCompanion = false;
      } else {
        let reqId = unresolvedOrder.pop();
        while (reqId && !unresolvedSteers.delete(reqId)) {
          reqId = unresolvedOrder.pop();
        }
        if (reqId) legacyRejectedMeta.set(reqId, meta);
      }
    } else {
      explicitNeedsCompanion = false;
    }
  }

  const out: TimelineUserConversationRow[] = [];
  for (const { event, meta } of ordered) {
    if (event.type !== "client/turn/requested") continue;
    if (inWindowRejected.has(event.requestId)) continue;
    const accepted = acceptedById.get(event.requestId);
    if (accepted !== undefined) continue;

    const rejMeta =
      rejectedById.get(event.requestId) ?? legacyRejectedMeta.get(event.requestId);
    if (rejMeta) {
      out.push(
        ...buildClientUserRows(event, rejMeta, "rejected", undefined, threadStatus),
      );
      continue;
    }
    if (
      resolveTurnRequestKind(event, undefined) === "steer" &&
      shouldPreservePendingMessages(threadStatus)
    ) {
      out.push(
        ...buildClientUserRows(event, meta, "pending", undefined, threadStatus),
      );
    }
  }
  return out;
}

// ── Core Single-Pass Event Folder ────────────────────────────────────────────

interface FoldEventsOptions {
  acceptedClientRequestContext: AcceptedClientRequestContext;
  includeActiveThinking: boolean;
  includeDiagnosticOperations: boolean;
  providerDisplayName?: string;
  threadName: string;
  threadStatus: Thread["status"];
  workspaceRoot: string | null;
}

export function foldEvents(
  ordered: readonly ThreadEventWithMeta[],
  opts: FoldEventsOptions,
): {
  rows: TimelineSourceRow[];
  parentByRow: Map<TimelineSourceRow, string>;
  legacyAssistantIds: Set<string>;
  activeThinking: ActiveThinking | null;
  activeWorkflows: TimelineWorkflowWorkRow[];
  activeBackgroundCommands: TimelineWorkflowWorkRow[];
  hasUnresolvedClientRequest: boolean;
} {
  const state = createFoldState(opts.workspaceRoot);

  // Pre-scan lookup tables (single fast pass)
  const acceptedById = buildAcceptedClientRequestById(
    opts.acceptedClientRequestContext,
    ordered,
  );
  const clientReqById = new Map<
    string,
    { event: ClientTurnRequestedEvent; meta: EventMeta }
  >();
  const rejectedIds = new Set<string>();
  const startedTurnIds = new Set<string>();
  const acceptedRootTurns = new Set<string>();

  for (const { event, meta } of ordered) {
    if (event.type === "client/turn/requested") {
      clientReqById.set(event.requestId, { event, meta });
    } else if (event.type === "client/turn/rejected") {
      rejectedIds.add(event.requestId);
    } else if (event.type === "turn/started") {
      startedTurnIds.add(
        requireThreadEventScopeTurnId({ type: event.type, scope: event.scope }),
      );
    }
  }
  for (const { event } of ordered) {
    if (event.type !== "turn/input/accepted") continue;
    const req = clientReqById.get(event.clientRequestId);
    if (
      req?.event.target.kind === "new-turn" ||
      req?.event.target.kind === "thread-start"
    ) {
      acceptedRootTurns.add(
        requireThreadEventScopeTurnId({ type: event.type, scope: event.scope }),
      );
    }
  }

  const pushUser = (row: TimelineUserConversationRow, parent?: string) => {
    if (state.seenUserIds.has(row.id)) return;
    state.seenUserIds.add(row.id);
    if (parent) state.parentByRow.set(row, parent);
    state.rows.push(row);
  };

  for (const { event, meta } of ordered) {
    const turnId = getEventTurnId(event);
    const providerThreadId = getEventProviderThreadId(event);
    const isRootTurn = turnId !== undefined && acceptedRootTurns.has(turnId);
    const rawParent = getEventParentToolCallId(event);

    if (event.type === "turn/started" && isRootTurn && rawParent) {
      state.suppressedRootParentByTurn.set(turnId, rawParent);
    }
    const explicitParent =
      rawParent &&
      (!isRootTurn ||
        turnId === undefined ||
        state.suppressedRootParentByTurn.get(turnId) !== rawParent)
        ? rawParent
        : undefined;

    if (event.type === "turn/started") {
      const startedId = requireThreadEventScopeTurnId({
        type: event.type,
        scope: event.scope,
      });
      if (isRootTurn) {
        state.delegationParentByTurn.delete(startedId);
      } else {
        let pendingParent: string | undefined =
          state.delegationParentByTurn.get(startedId);
        if (!pendingParent && providerThreadId) {
          const queue = state.pendingDelegationLinks.get(providerThreadId);
          while (queue && queue.length > 0) {
            const link = queue.shift()!;
            if (link.parentTurnId === startedId) continue;
            if (queue.length === 0) {
              state.pendingDelegationLinks.delete(providerThreadId);
            }
            pendingParent = link.callId;
            state.delegationParentByTurn.set(startedId, link.callId);
            break;
          }
          if (queue && queue.length === 0) {
            state.pendingDelegationLinks.delete(providerThreadId);
          }
        }
        const chosen = explicitParent ?? pendingParent;
        if (chosen) state.delegationParentByTurn.set(startedId, chosen);
      }
      state.openTurnIds.add(startedId);
      state.lastStartedTurnId = startedId;
      state.repeatedWarnings.clear();
    }

    const effectiveParent = isRootTurn
      ? explicitParent
      : (explicitParent ??
          (turnId ? state.delegationParentByTurn.get(turnId) : undefined) ??
          (providerThreadId
            ? state.delegationParentByProviderThread.get(providerThreadId)
            : undefined));

    // Settle open compactions on turn failure / provider error / compaction-skipped warning
    const compactionSettlement:
      | { status: "completed" | "error" | "interrupted"; detail?: string }
      | undefined =
      event.type === "provider/error"
        ? { status: "error", detail: event.detail ?? event.message }
        : event.type === "provider/warning" &&
            event.category === "compaction-skipped"
          ? { status: "completed", detail: event.details ?? event.summary }
          : event.type === "turn/completed" && event.status === "failed"
            ? { status: "error", detail: event.error?.message }
            : event.type === "turn/completed" && event.status === "interrupted"
              ? { status: "interrupted", detail: event.error?.message }
              : undefined;

    if (compactionSettlement && turnId) {
      let settledPending = false;
      for (const comp of state.openCompactions.values()) {
        if (comp.threadId !== event.threadId || comp.turnId !== turnId) continue;
        if (comp.status === "pending") settledPending = true;
        finalizeOpenCompactionRow(
          comp,
          meta,
          compactionSettlement.status,
          compactionSettlement.detail,
        );
      }
      if (settledPending && event.type === "provider/warning") continue;
    }

    // Turn completion & thread interruption flushes
    if (event.type === "turn/completed") {
      const completedId = requireThreadEventScopeTurnId({
        type: event.type,
        scope: event.scope,
      });
      state.closedTurnIds.add(completedId);
      state.openTurnIds.delete(completedId);
      if (event.status === "interrupted") {
        state.interruptedTurnCompletedAt.set(completedId, meta.createdAt);
      }
      const rStatus = event.status === "completed" ? "completed" : "interrupted";
      for (const [key, lc] of state.openReasoning) {
        if (lc.turnId === completedId) {
          finalizeReasoningKey(state, key, meta, rStatus, true);
        }
      }
      flushAssistants(state, completedId);
      flushPendingToolOutputs(state.tools);
    } else if (event.type === "system/thread/interrupted") {
      state.threadInterruptedAt = meta.createdAt;
      for (const comp of state.openCompactions.values()) {
        if (
          comp.threadId === event.threadId &&
          comp.status === "pending" &&
          comp.sourceSeqStart <= meta.seq
        ) {
          finalizeOpenCompactionRow(comp, meta, "interrupted", undefined);
        }
      }
      for (const id of state.openTurnIds) {
        state.interruptedTurnCompletedAt.set(id, meta.createdAt);
        state.closedTurnIds.add(id);
      }
      state.openTurnIds.clear();
      for (const key of [...state.openReasoning.keys()]) {
        finalizeReasoningKey(state, key, meta, "interrupted", true);
      }
      flushAssistants(state);
      flushPendingToolOutputs(state.tools);
    }

    // Accepted steer input
    if (event.type === "turn/input/accepted") {
      const req = clientReqById.get(event.clientRequestId);
      const acc = acceptedById.get(event.clientRequestId);
      if (req && acc && resolveTurnRequestKind(req.event, acc) === "steer") {
        for (const r of buildClientUserRows(
          req.event,
          req.meta,
          "accepted",
          acc,
          opts.threadStatus,
        )) {
          pushUser(r);
        }
      }
      continue;
    }

    // Rejected client request
    if (event.type === "client/turn/rejected") {
      const req = clientReqById.get(event.requestId);
      if (req) {
        for (const r of buildClientUserRows(
          req.event,
          meta,
          "rejected",
          undefined,
          opts.threadStatus,
        )) {
          pushUser(r);
        }
      }
      continue;
    }

    // Client turn requested
    if (event.type === "client/turn/requested") {
      if (rejectedIds.has(event.requestId)) continue;
      const acc = acceptedById.get(event.requestId);
      const visibleAcc: AcceptedClientRequest | undefined =
        acc &&
        (event.target.kind === "new-turn" ||
          event.target.kind === "thread-start" ||
          event.target.expectedTurnId === null ||
          acc.turnId === event.target.expectedTurnId ||
          startedTurnIds.has(acc.turnId))
          ? acc
          : undefined;
      if (resolveTurnRequestKind(event, visibleAcc) === "message") {
        for (const r of buildClientUserRows(
          event,
          meta,
          visibleAcc ? "accepted" : "pending",
          visibleAcc,
          opts.threadStatus,
        )) {
          pushUser(r);
        }
      }
      continue;
    }

    // Provider user message
    const provUser = buildProviderUserRow(event, meta);
    if (provUser) {
      pushUser(provUser.row, provUser.parentToolCallId);
      continue;
    }

    // Legacy user message (projected as assistant row, kept ungroupable)
    const legacyUser = buildLegacyUserRow(event, meta);
    if (legacyUser) {
      state.legacyAssistantIds.add(legacyUser.id);
      state.rows.push(legacyUser);
      continue;
    }

    // Assistant text & reasoning streams
    if (
      projectAssistantOrReasoning(state, event, meta, turnId, effectiveParent)
    ) {
      continue;
    }

    // Tools, commands, delegations, web/V3 items, file edits, background tasks
    const toolResult = projectToolEvent(
      state.tools,
      event,
      meta,
      effectiveParent,
      state.lastStartedTurnId !== null &&
        state.openTurnIds.has(state.lastStartedTurnId)
        ? state.lastStartedTurnId
        : null,
    );
    if (toolResult.handled) {
      // Sync rows reference in case file-edit replacement rebuilt the array
      state.rows = state.tools.rows;
      if (toolResult.delegation?.childRef !== undefined) {
        const { callId, childRef } = toolResult.delegation;
        if (
          childRef === providerThreadId ||
          state.queuedDelegationLinkCallIds.has(callId)
        ) {
          if (
            providerThreadId &&
            turnId &&
            !state.queuedDelegationLinkCallIds.has(callId)
          ) {
            const q = state.pendingDelegationLinks.get(providerThreadId) ?? [];
            q.push({ callId, parentTurnId: turnId });
            state.pendingDelegationLinks.set(providerThreadId, q);
            state.queuedDelegationLinkCallIds.add(callId);
          }
        } else {
          state.delegationParentByProviderThread.set(childRef, callId);
        }
      }
      continue;
    }

    // Compaction lifecycle
    if (
      ((event.type === "item/started" || event.type === "item/completed") &&
        event.item.type === "contextCompaction") ||
      event.type === "thread/compacted"
    ) {
      const key = compactionKey(event, meta);
      const isBegin = event.type === "item/started";
      if (isBegin) {
        if (!state.finalizedCompactionKeys.has(key)) {
          const existing = state.openCompactions.get(key);
          if (existing) {
            existing.sourceSeqEnd = Math.max(existing.sourceSeqEnd, meta.seq);
            existing.createdAt = Math.max(existing.createdAt, meta.createdAt);
            existing.status = "pending";
            existing.title = "Compacting context";
            if (effectiveParent && !state.parentByRow.has(existing)) {
              state.parentByRow.set(existing, effectiveParent);
            }
          } else {
            const row: OpRow = {
              id: messageId(event.threadId, "op", `compaction:${key}`),
              threadId: event.threadId,
              turnId: turnId ?? null,
              sourceSeqStart: meta.seq,
              sourceSeqEnd: meta.seq,
              startedAt: meta.createdAt,
              createdAt: meta.createdAt,
              completedAt: null,
              kind: "system",
              systemKind: "operation",
              operationKind: "compaction",
              title: "Compacting context",
              detail: null,
              status: "pending",
            };
            if (effectiveParent) state.parentByRow.set(row, effectiveParent);
            state.openCompactions.set(key, row);
            state.rows.push(row);
          }
        }
      } else {
        const existing = state.openCompactions.get(key);
        if (existing) {
          existing.sourceSeqEnd = Math.max(existing.sourceSeqEnd, meta.seq);
          existing.createdAt = Math.max(existing.createdAt, meta.createdAt);
          existing.completedAt = meta.createdAt;
          existing.status = "completed";
          existing.title = "Context compacted";
          if (effectiveParent && !state.parentByRow.has(existing)) {
            state.parentByRow.set(existing, effectiveParent);
          }
          state.openCompactions.delete(key);
          state.finalizedCompactionKeys.add(key);
        } else if (!state.finalizedCompactionKeys.has(key)) {
          const row: OpRow = {
            id: messageId(event.threadId, "op", `compaction:${key}`),
            threadId: event.threadId,
            turnId: turnId ?? null,
            sourceSeqStart: meta.seq,
            sourceSeqEnd: meta.seq,
            startedAt: meta.createdAt,
            createdAt: meta.createdAt,
            completedAt: meta.createdAt,
            kind: "system",
            systemKind: "operation",
            operationKind: "compaction",
            title: "Context compacted",
            detail: null,
            status: "completed",
          };
          if (effectiveParent) state.parentByRow.set(row, effectiveParent);
          state.rows.push(row);
          state.finalizedCompactionKeys.add(key);
        }
      }
      continue;
    }

    // Operations & interaction lifecycles
    const op = parseOperationEvent(event, meta, {
      includeDiagnosticOperations: opts.includeDiagnosticOperations,
      providerDisplayName: opts.providerDisplayName,
      threadName: opts.threadName,
    });
    if (op) {
      if (op.kind === "approval") {
        const scopeKey = `${op.row.turnId ?? "thread"}:${op.row.interactionId}`;
        const existing = state.permGrantsByScopedKey.get(scopeKey);
        if (!existing) {
          state.permGrantsByScopedKey.set(scopeKey, op.row);
          state.rows.push(op.row);
        } else {
          mergeBounds(existing, op.row);
          if (existing.status === "pending") {
            existing.status = op.row.status;
            existing.lifecycle = op.row.lifecycle;
          }
          existing.target = op.row.target;
        }
      } else if (op.kind === "question") {
        const scopeKey = `${op.row.turnId ?? "thread"}:${op.row.interactionId}`;
        const existing = state.questionsByScopedKey.get(scopeKey);
        if (!existing) {
          state.questionsByScopedKey.set(scopeKey, op.row);
          state.rows.push(op.row);
        } else {
          mergeBounds(existing, op.row);
          if (existing.status === "pending") {
            existing.status = op.row.status;
            existing.lifecycle = op.row.lifecycle;
            existing.questions = op.row.questions;
            existing.answers = op.row.answers;
            existing.statusReason = op.row.statusReason;
          }
        }
      } else if (op.mode === "provisioning" && op.key && op.provisioning) {
        const scopeKey = `${op.row.turnId ?? "thread"}:${op.key}`;
        const existing = state.provisioningByScopedKey.get(scopeKey);
        if (!existing) {
          state.provisioningByScopedKey.set(scopeKey, op.row);
          state.provisioningStateByRow.set(op.row, op.provisioning);
          state.rows.push(op.row);
        } else {
          mergeBounds(existing, op.row);
          const wasPending = existing.status === "pending";
          if (wasPending) existing.status = op.row.status;
          existing.title = provisioningTitleForStatus(existing.status);
          if (wasPending && existing.status !== "pending") {
            existing.completedAt = op.row.completedAt ?? op.row.createdAt;
          }
          const provState = state.provisioningStateByRow.get(existing)!;
          mergeProvisioningState(provState, op.provisioning);
        }
      } else if (op.mode === "thread-op" && op.key) {
        const scopeKey = `${op.row.turnId ?? "thread"}:${op.key}`;
        const existing = state.threadOpsByScopedKey.get(scopeKey);
        if (!existing) {
          state.threadOpsByScopedKey.set(scopeKey, op.row);
          state.rows.push(op.row);
        } else {
          mergeBounds(existing, op.row);
          const mergedStatus: TimelineRowStatus =
            existing.status !== "pending" && existing.status !== null
              ? existing.status
              : (op.row.status ?? "pending");
          const changed = existing.status !== mergedStatus;
          existing.status = mergedStatus;
          if (changed) {
            existing.title = op.row.title;
            if (
              op.row.operationKind === "parent-change" &&
              existing.operationKind === "parent-change"
            ) {
              existing.parentChange = op.row.parentChange;
            } else if (op.row.operationKind === "parent-change") {
              const idx = state.rows.indexOf(existing);
              const replacement: OpRow = {
                ...op.row,
                id: existing.id,
                sourceSeqStart: existing.sourceSeqStart,
                sourceSeqEnd: existing.sourceSeqEnd,
                startedAt: existing.startedAt,
                createdAt: existing.createdAt,
                detail: mergeDetails(existing.detail, op.row.detail),
                status: mergedStatus,
                completedAt:
                  mergedStatus !== "pending"
                    ? (op.row.completedAt ?? op.row.createdAt)
                    : existing.completedAt,
              };
              if (idx !== -1) state.rows[idx] = replacement;
              state.threadOpsByScopedKey.set(scopeKey, replacement);
              continue;
            }
            if (mergedStatus !== "pending") {
              existing.completedAt = op.row.completedAt ?? op.row.createdAt;
            }
          }
          existing.detail = mergeDetails(existing.detail, op.row.detail);
        }
      } else if (op.mode === "repeated-warning") {
        const key = `${op.row.turnId ?? "thread"}:warning:${JSON.stringify([op.row.title, op.row.detail])}`;
        const seen = state.repeatedWarnings.get(key);
        if (!seen) {
          state.repeatedWarnings.set(key, { row: op.row, count: 1 });
          state.rows.push(op.row);
        } else {
          seen.count += 1;
          mergeBounds(seen.row, op.row);
          seen.row.title = `${op.row.title} ×${seen.count}`;
        }
      } else {
        state.rows.push(op.row);
      }
      continue;
    }

    // Errors & reconnects
    const errRow = buildErrorRow(event, meta);
    if (errRow) {
      state.rows.push(errRow);
    }
  }

  // Finalize interrupted turns
  for (const [turnId, completedAt] of state.interruptedTurnCompletedAt) {
    const set = new Set([turnId]);
    interruptPendingTools(state.tools, completedAt, set);
    interruptPendingFileEdits(state.tools, set);
    for (const row of state.rows) {
      if (row.turnId !== turnId) continue;
      if (row.kind === "system" && row.systemKind === "operation") {
        interruptOperationRow(row, state.provisioningStateByRow);
      } else if (
        row.kind === "work" &&
        row.workKind === "approval" &&
        row.approvalKind === "permission-grant" &&
        row.status === "pending"
      ) {
        row.status = "interrupted";
        row.lifecycle = "interrupted";
      } else if (
        row.kind === "work" &&
        row.workKind === "question" &&
        row.status === "pending"
      ) {
        row.status = "interrupted";
        row.lifecycle = "interrupted";
      }
    }
  }

  // Finalize pending messages on settled threads
  if (!shouldPreservePendingMessages(opts.threadStatus)) {
    flushPendingToolOutputs(state.tools);
    interruptPendingTools(state.tools, state.threadInterruptedAt);
    interruptPendingFileEdits(state.tools);
    flushAssistants(state);
    for (const row of state.rows) {
      if (row.kind !== "system" || row.systemKind !== "operation") continue;
      if (
        opts.threadStatus === "idle" &&
        row.operationKind === "compaction" &&
        row.turnId !== null &&
        state.closedTurnIds.has(row.turnId)
      ) {
        continue;
      }
      finalizeOperationRow(row, opts.threadStatus, state.provisioningStateByRow);
    }
  }

  for (const [row, provState] of state.provisioningStateByRow) {
    if (row.systemKind === "operation") {
      row.detail = formatProvisioningDetail(row, provState);
    }
  }

  // Filter hidden background tasks & stably sort by (sourceSeqStart, createdAt)
  let visibleRows: TimelineSourceRow[];
  if (state.tools.backgroundTasksByItemId.size === 0) {
    visibleRows = state.rows;
  } else {
    const hiddenWorkflows = new Set<TimelineWorkflowWorkRow>();
    for (const entry of state.tools.backgroundTasksByItemId.values()) {
      if (entry.skipTranscript) hiddenWorkflows.add(entry.row);
    }
    visibleRows =
      hiddenWorkflows.size === 0
        ? state.rows
        : state.rows.filter(
            (r) =>
              !(
                r.kind === "work" &&
                r.workKind === "workflow" &&
                hiddenWorkflows.has(r)
              ),
          );
  }
  let needsSort = false;
  for (let i = 1; i < visibleRows.length; i += 1) {
    const prev = visibleRows[i - 1]!;
    const cur = visibleRows[i]!;
    if (
      prev.sourceSeqStart > cur.sourceSeqStart ||
      (prev.sourceSeqStart === cur.sourceSeqStart &&
        prev.createdAt > cur.createdAt)
    ) {
      needsSort = true;
      break;
    }
  }
  if (needsSort) {
    visibleRows = [...visibleRows].sort(
      (a, b) => a.sourceSeqStart - b.sourceSeqStart || a.createdAt - b.createdAt,
    );
  }

  let hasUnresolvedClientRequest = false;
  for (const reqId of clientReqById.keys()) {
    if (!rejectedIds.has(reqId) && !acceptedById.has(reqId)) {
      hasUnresolvedClientRequest = true;
      break;
    }
  }

  const { activeWorkflows, activeBackgroundCommands } =
    selectActiveBackgroundLists(state, visibleRows);
  unlinkFinishedBackgroundCommands(state, visibleRows);
  // A running background command shows as a bubble at the end of the chat, not where it started.
  const waiting = new Set(
    activeBackgroundCommands.filter((row) =>
      isBackgroundCommandTaskType(row.taskType),
    ),
  );

  return {
    rows:
      waiting.size === 0
        ? visibleRows
        : visibleRows.filter(
            (row) => !(row.kind === "work" && row.workKind === "workflow" && waiting.has(row)),
          ),
    parentByRow: state.parentByRow,
    legacyAssistantIds: state.legacyAssistantIds,
    activeThinking: opts.includeActiveThinking
      ? buildActiveThinking(state, opts.threadStatus)
      : null,
    activeWorkflows,
    activeBackgroundCommands,
    hasUnresolvedClientRequest,
  };
}

// ── Public Timeline Entry Points ─────────────────────────────────────────────

export interface BuildThreadTimelineFromEventsArgs {
  acceptedClientRequestContext: AcceptedClientRequestContext;
  contextWindowEvents: ThreadEventWithMeta[];
  events: ThreadEventWithMeta[];
  options: {
    completedTurnDisplay: CompletedTurnDisplay;
    includeDiagnosticOperations: boolean;
    includeNestedRows: boolean;
    isLatestPage: boolean;
    providerId?: string;
    providerDisplayName?: string;
    planCommand?: PlanCommand | null;
    threadStatus: Thread["status"];
    threadName: string;
    turnMessageDetail: "summary" | "full";
    workspaceRoot: string | null;
  };
}

export interface ThreadTimelineFromEventsResult {
  activePromptMode: ThreadTimelineActivePromptMode | null;
  activeThinking: ActiveThinking | null;
  activeWorkflows: TimelineWorkflowWorkRow[];
  activeBackgroundCommands: TimelineWorkflowWorkRow[];
  contextWindowUsage: ThreadContextWindowUsage | null;
  goal: ThreadTimelineGoal | null;
  modelFallback: ThreadTimelineModelFallback | null;
  pendingTodos: ThreadTimelinePendingTodos | null;
  rows: TimelineRow[];
}

export function buildThreadTimelineFromEvents(
  args: BuildThreadTimelineFromEventsArgs,
): ThreadTimelineFromEventsResult {
  const ordered = orderEvents(args.events);
  const folded =
    ordered.length === 0
      ? {
          rows: [],
          parentByRow: new Map<TimelineSourceRow, string>(),
          legacyAssistantIds: new Set<string>(),
          activeThinking: null,
          activeWorkflows: [],
          activeBackgroundCommands: [],
          hasUnresolvedClientRequest: false,
        }
      : foldEvents(ordered, {
          acceptedClientRequestContext: args.acceptedClientRequestContext,
          includeActiveThinking: true,
          includeDiagnosticOperations: args.options.includeDiagnosticOperations,
          providerDisplayName: args.options.providerDisplayName,
          threadName: args.options.threadName,
          threadStatus: args.options.threadStatus,
          workspaceRoot: args.options.workspaceRoot,
        });

  const assembled = assembleTimelineRows(
    {
      rows: folded.rows,
      events: ordered,
      parentByRow: folded.parentByRow,
      legacyAssistantIds: folded.legacyAssistantIds,
      completedTurnDisplay: args.options.completedTurnDisplay,
      includeNestedRows: args.options.includeNestedRows,
      turnMessageDetail: args.options.turnMessageDetail,
    },
    true,
  );
  const rows = folded.hasUnresolvedClientRequest
    ? [
        ...assembled,
        ...buildPendingSteerRows(
          args.acceptedClientRequestContext,
          ordered,
          args.options.threadStatus,
        ),
      ]
    : assembled;

  return {
    activePromptMode: args.options.isLatestPage
      ? extractThreadTimelineActivePromptMode({
          events: ordered,
          planCommand: args.options.planCommand,
          providerId: args.options.providerId,
          threadStatus: args.options.threadStatus,
        })
      : null,
    activeThinking: folded.activeThinking,
    activeWorkflows: folded.activeWorkflows,
    activeBackgroundCommands: folded.activeBackgroundCommands,
    contextWindowUsage: extractThreadContextWindowUsage(args.contextWindowEvents),
    goal: args.options.isLatestPage
      ? extractThreadTimelineGoal(ordered)
      : null,
    modelFallback: args.options.isLatestPage
      ? extractThreadTimelineModelFallback(ordered)
      : null,
    pendingTodos: args.options.isLatestPage
      ? extractThreadTimelinePendingTodos(args.options.threadStatus, ordered)
      : null,
    rows,
  };
}

export interface BuildThreadTimelineTurnDetailsFromEventsArgs {
  events: ThreadEventWithMeta[];
  options: {
    completedTurnDisplay: CompletedTurnDisplay;
    includeDiagnosticOperations: boolean;
    providerDisplayName?: string;
    sourceSeqEnd: number;
    sourceSeqStart: number;
    threadStatus: Thread["status"];
    threadName: string;
    workspaceRoot: string | null;
  };
}

export type ThreadTimelineTurnDetailsFromEventsResult =
  | { kind: "matched"; rows: TimelineRow[] }
  | { kind: "missing-match" }
  | { kind: "ungrouped"; rows: TimelineRow[] };

export function buildThreadTimelineTurnDetailsFromEvents(
  args: BuildThreadTimelineTurnDetailsFromEventsArgs,
): ThreadTimelineTurnDetailsFromEventsResult {
  const ordered = orderEvents(args.events);
  const folded =
    ordered.length === 0
      ? {
          rows: [],
          parentByRow: new Map<TimelineSourceRow, string>(),
          legacyAssistantIds: new Set<string>(),
        }
      : foldEvents(ordered, {
          acceptedClientRequestContext: EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT,
          includeActiveThinking: false,
          includeDiagnosticOperations: args.options.includeDiagnosticOperations,
          providerDisplayName: args.options.providerDisplayName,
          threadName: args.options.threadName,
          threadStatus: args.options.threadStatus,
          workspaceRoot: args.options.workspaceRoot,
        });

  const nestedRows = assembleTimelineRows(
    {
      rows: folded.rows,
      events: ordered,
      parentByRow: folded.parentByRow,
      legacyAssistantIds: folded.legacyAssistantIds,
      completedTurnDisplay: args.options.completedTurnDisplay,
      includeNestedRows: true,
      turnMessageDetail: "full",
    },
    false,
  ).filter(
    (r) => !(r.kind === "turn" && r.summaryCount === 0 && r.children === null),
  );

  const match = nestedRows.find(
    (r): r is Extract<TimelineRow, { kind: "turn" }> =>
      r.kind === "turn" &&
      r.sourceSeqStart === args.options.sourceSeqStart &&
      r.sourceSeqEnd === args.options.sourceSeqEnd,
  );
  if (match) return { kind: "matched", rows: match.children ?? [] };
  if (nestedRows.some((r) => r.kind === "turn")) return { kind: "missing-match" };

  return {
    kind: "ungrouped",
    rows: nestedRows.filter(
      (r) =>
        !(
          r.kind === "conversation" &&
          r.role === "user" &&
          r.initiator === "user" &&
          r.turnRequest.kind === "steer"
        ),
    ),
  };
}
