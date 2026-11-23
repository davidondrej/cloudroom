import {
  isBackgroundCommandTaskType,
  parseLegacyImageGenerationCompletion,
  type JsonObject,
  type JsonValue,
  type ThreadEvent,
  type ThreadEventBackgroundTaskItem,
  type ThreadEventFileChange,
  type ThreadEventItemApprovalStatus,
  type ThreadEventItemPresentation,
  type ThreadEventItemStatus,
} from "@cloudroom/domain";
import type {
  TimelineActivityIntent,
  TimelineApprovalStatus,
  TimelineApprovalWorkRow,
  TimelineCommandWorkRow,
  TimelineDelegationWorkRow,
  TimelineExtensionWorkRow,
  TimelineFileChange,
  TimelineFileChangeWorkRow,
  TimelineFileReadWorkRow,
  TimelineImageGenerationWorkRow,
  TimelineImageViewWorkRow,
  TimelinePlanStepsWorkRow,
  TimelineRowStatus,
  TimelineSearchWorkRow,
  TimelineSourceRow,
  TimelineToolWorkRow,
  TimelineWebFetchWorkRow,
  TimelineWebSearchWorkRow,
  TimelineWorkflowWorkRow,
} from "@cloudroom/server-contract";
import { getEventParentToolCallId, getEventTurnId, type EventMeta } from "./events.js";
import { extractShellCommandFromString, parseShellCommandIntents } from "./shell.js";
import {
  appendVisibleTextBuffer,
  createVisibleTextBuffer,
  flushVisibleTextBuffer,
  getFileChangeDiffStats,
  getVisibleTextBufferFullLength,
  getVisibleTextBufferFullText,
  getVisibleTextBufferText,
  messageId,
  relativizeWorkspacePath,
  setVisibleTextBuffer,
  type VisibleTextBuffer,
} from "./utils.js";

export type ExecWorkRow =
  | TimelineCommandWorkRow
  | TimelineToolWorkRow
  | TimelineDelegationWorkRow;

export type WebWorkRow =
  | TimelineWebSearchWorkRow
  | TimelineWebFetchWorkRow
  | TimelineImageGenerationWorkRow
  | TimelineImageViewWorkRow
  | TimelineFileReadWorkRow
  | TimelineSearchWorkRow
  | TimelinePlanStepsWorkRow
  | TimelineExtensionWorkRow;

type FileEditApprovalRow = Extract<
  TimelineApprovalWorkRow,
  { approvalKind: "file-edit" }
>;

interface RawFileChange {
  path: string;
  kind?: string;
  movePath?: string | null;
  diff?: string;
}

interface FileEditRecord {
  turnId: string | null;
  callId: string;
  baseId: string;
  rawChange: RawFileChange | null;
  approvalStatus: TimelineApprovalStatus;
  status: TimelineRowStatus;
  row: TimelineFileChangeWorkRow | FileEditApprovalRow | null;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  startedAt: number;
  createdAt: number;
  stdout: string | null;
  parentToolCallId?: string;
  presentation?: ThreadEventItemPresentation;
}

interface PendingExecOutput {
  parentToolCallId?: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  startedAt: number;
  createdAt: number;
  status?: TimelineRowStatus;
  buffer: VisibleTextBuffer;
}

interface RunningExecEntry {
  row: ExecWorkRow;
  buffer: VisibleTextBuffer;
}

export interface BackgroundTaskEntry {
  row: TimelineWorkflowWorkRow;
  familyId: string | null;
  skipTranscript: boolean;
}

export interface ToolsState {
  rows: TimelineSourceRow[];
  parentByRow: Map<TimelineSourceRow, string>;
  workspaceRoot: string | null;
  runningExecByCallId: Map<string, RunningExecEntry>;
  latestExecByCallId: Map<string, ExecWorkRow>;
  finalizedExecCallIds: Set<string>;
  pendingExecOutputByCallId: Map<string, PendingExecOutput>;
  webByCallId: Map<string, WebWorkRow[]>;
  finalizedWebKeys: Set<string>;
  fileEditsByCallId: Map<string, FileEditRecord[]>;
  fileEditStdoutByScopedKey: Map<string, VisibleTextBuffer>;
  backgroundTasksByItemId: Map<string, BackgroundTaskEntry>;
  delegationModelByCallId: Map<string, string>;
}

export function createToolsState(
  rows: TimelineSourceRow[],
  parentByRow: Map<TimelineSourceRow, string>,
  workspaceRoot: string | null,
): ToolsState {
  return {
    rows,
    parentByRow,
    workspaceRoot,
    runningExecByCallId: new Map(),
    latestExecByCallId: new Map(),
    finalizedExecCallIds: new Set(),
    pendingExecOutputByCallId: new Map(),
    webByCallId: new Map(),
    finalizedWebKeys: new Set(),
    fileEditsByCallId: new Map(),
    fileEditStdoutByScopedKey: new Map(),
    backgroundTasksByItemId: new Map(),
    delegationModelByCallId: new Map(),
  };
}

export function itemStatusToRowStatus(
  status: ThreadEventItemStatus,
): TimelineRowStatus {
  switch (status) {
    case "pending":
      return "pending";
    case "completed":
      return "completed";
    case "failed":
      return "error";
    case "interrupted":
      return "interrupted";
  }
}

function toApprovalStatus(
  status: ThreadEventItemApprovalStatus,
): TimelineApprovalStatus {
  return status === "waiting_for_approval" || status === "denied" ? status : null;
}

function mergeStatus(
  current: TimelineRowStatus | undefined,
  incoming: TimelineRowStatus | undefined,
): TimelineRowStatus {
  if (!incoming) return current ?? "pending";
  if (!current) return incoming;
  if (incoming === "error") return "error";
  if (current !== "pending") return current;
  return incoming;
}

function applyApproval(
  current: TimelineApprovalStatus,
  incoming: TimelineApprovalStatus | undefined,
  incomingStatus: TimelineRowStatus | undefined,
): TimelineApprovalStatus {
  if (incoming !== undefined) return incoming;
  if (incomingStatus !== undefined) return null;
  return current;
}

function chooseIntents(
  existing: TimelineActivityIntent[],
  incoming: TimelineActivityIntent[],
): TimelineActivityIntent[] {
  if (incoming.length === 0) return existing;
  if (existing.length === 0) return incoming;
  const exSem = existing.some((i) => i.type !== "unknown");
  const inSem = incoming.some((i) => i.type !== "unknown");
  if (!exSem && inSem) return incoming;
  return incoming.length > existing.length ? incoming : existing;
}

function setParent(
  state: ToolsState,
  row: TimelineSourceRow,
  parentToolCallId: string | undefined,
): void {
  if (parentToolCallId && !state.parentByRow.has(row)) {
    state.parentByRow.set(row, parentToolCallId);
  }
}

function setJsonObjectProperty(
  out: JsonObject,
  key: string,
  value: JsonValue,
): void {
  Object.defineProperty(out, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function toJsonValue(value: unknown): JsonValue {
  let result: JsonValue | undefined;
  const pending: (
    | { value: unknown; assign: (value: JsonValue) => void }
    | { leave: object }
  )[] = [
    {
      value,
      assign: (parsed) => {
        result = parsed;
      },
    },
  ];
  const active = new WeakSet<object>();

  while (pending.length > 0) {
    const current = pending.pop()!;
    if ("leave" in current) {
      active.delete(current.leave);
      continue;
    }
    const input = current.value;
    if (
      input === null ||
      typeof input === "string" ||
      typeof input === "boolean"
    ) {
      current.assign(input);
      continue;
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input))
        throw new Error("Expected finite JSON number");
      current.assign(input);
      continue;
    }
    if (Array.isArray(input)) {
      if (active.has(input)) throw new Error("Expected acyclic JSON value");
      active.add(input);
      pending.push({ leave: input });
      const out: JsonValue[] = new Array(input.length);
      current.assign(out);
      for (let i = input.length - 1; i >= 0; i -= 1) {
        if (!(i in input)) continue;
        const index = i;
        pending.push({
          value: input[index],
          assign: (parsed) => {
            out[index] = parsed;
          },
        });
      }
      continue;
    }
    if (typeof input === "object") {
      if (active.has(input)) throw new Error("Expected acyclic JSON value");
      active.add(input);
      pending.push({ leave: input });
      const out: JsonObject = {};
      current.assign(out);
      const entries = Object.entries(input as Record<string, unknown>);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const [key, child] = entries[i]!;
        if (child === undefined) continue;
        pending.push({
          value: child,
          assign: (parsed) => {
            setJsonObjectProperty(out, key, parsed);
          },
        });
      }
      continue;
    }
    throw new Error(`Expected JSON value, got ${typeof input}`);
  }
  return result!;
}

function parseToolArgs(
  args: Record<string, unknown> | null,
): JsonObject | null {
  if (!args) return null;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(args)) {
    setJsonObjectProperty(out, k, toJsonValue(v));
  }
  return out;
}

export function shouldSuppressLowValueItem(event: ThreadEvent): boolean {
  if (event.type !== "item/started" && event.type !== "item/completed") {
    return false;
  }
  const item = event.item;
  switch (item.type) {
    case "toolCall":
    case "fileRead":
    case "search":
    case "planSteps":
    case "extension":
    case "delegation":
    case "fileChange":
      return (
        item.presentation?.suppress === true &&
        (item.status === "pending" || item.status === "completed")
      );
    default:
      return false;
  }
}

// ── Exec / ToolCall / Delegation ─────────────────────────────────────────────

interface ExecUpdate {
  kind: "command" | "tool" | "delegation";
  callId: string;
  isEnd: boolean;
  status: TimelineRowStatus;
  completedAt: number | null;
  output?: string;
  parentToolCallId?: string;
  presentation?: ThreadEventItemPresentation;
  // command
  command?: string;
  cwd?: string | null;
  activityIntents?: TimelineActivityIntent[];
  exitCode?: number | null;
  approvalStatus?: TimelineApprovalStatus;
  // tool
  toolName?: string;
  toolArgs?: JsonObject | null;
  // delegation
  childRef?: string;
  background?: boolean;
  description?: string;
}

function reconcilePendingOutput(
  entry: RunningExecEntry,
  pending: PendingExecOutput,
  state: ToolsState,
): void {
  const isTerm = entry.row.status !== "pending";
  if (isTerm) flushVisibleTextBuffer(pending.buffer);
  const pendingText = getVisibleTextBufferFullText(pending.buffer);
  if (pendingText.length > 0) {
    const callText = getVisibleTextBufferFullText(entry.buffer);
    if (!callText.includes(pendingText)) {
      const merged = pendingText.includes(callText)
        ? pendingText
        : `${pendingText}${callText}`;
      setVisibleTextBuffer(entry.buffer, merged, isTerm);
      entry.row.output = getVisibleTextBufferText(entry.buffer) ?? "";
    }
  }
  entry.row.sourceSeqStart = Math.min(entry.row.sourceSeqStart, pending.sourceSeqStart);
  entry.row.sourceSeqEnd = Math.max(entry.row.sourceSeqEnd, pending.sourceSeqEnd);
  entry.row.startedAt = Math.min(entry.row.startedAt, pending.startedAt);
  entry.row.createdAt = Math.max(entry.row.createdAt, pending.createdAt);
  setParent(state, entry.row, pending.parentToolCallId);
  entry.row.status = mergeStatus(entry.row.status, pending.status);
}

function mergeExecIntoRow(
  row: ExecWorkRow,
  update: ExecUpdate,
  meta: EventMeta,
  state: ToolsState,
  buffer: VisibleTextBuffer | null,
): void {
  if (update.presentation) row.presentation = update.presentation;
  setParent(state, row, update.parentToolCallId);

  if (row.workKind === "command" && update.kind === "command") {
    if (update.cwd && !row.cwd) row.cwd = update.cwd;
    if (update.command && update.command !== row.command) {
      row.command = update.command;
      row.activityIntents = update.activityIntents ?? [];
    } else if (update.activityIntents) {
      row.activityIntents = chooseIntents(row.activityIntents, update.activityIntents);
    }
    if (update.exitCode !== undefined) row.exitCode = update.exitCode;
    row.approvalStatus = applyApproval(
      row.approvalStatus,
      update.approvalStatus,
      update.status,
    );
  } else if (row.workKind === "tool" && update.kind === "tool") {
    if (update.toolName && !row.toolName) row.toolName = update.toolName;
    if (update.toolArgs && !row.toolArgs) row.toolArgs = update.toolArgs;
    row.approvalStatus = applyApproval(
      row.approvalStatus,
      update.approvalStatus,
      update.status,
    );
  } else if (row.workKind === "delegation" && update.kind === "delegation") {
    if (update.toolName && !row.toolName) row.toolName = update.toolName;
    if (update.childRef && !row.childRef) row.childRef = update.childRef;
    if (update.background === true) row.background = true;
    if (update.description && (!row.description || update.childRef !== undefined)) {
      row.description = update.description;
    }
  }

  if (update.completedAt !== null) {
    if (!(row.status === "interrupted" && update.status !== "error")) {
      row.completedAt = update.completedAt;
    }
  }

  const isTerm = update.status !== "pending";
  if (update.output && update.output.length > 0) {
    if (buffer) {
      if (isTerm || update.output.length >= getVisibleTextBufferFullLength(buffer)) {
        setVisibleTextBuffer(buffer, update.output, isTerm);
        row.output = getVisibleTextBufferText(buffer) ?? "";
      }
    } else if (isTerm || update.output.length >= row.output.length) {
      row.output = update.output;
    }
  }

  row.status = mergeStatus(row.status, update.status);
  row.sourceSeqEnd = Math.max(row.sourceSeqEnd, meta.seq);
  row.createdAt = Math.max(row.createdAt, meta.createdAt);
}

function createExecRow(
  threadId: string,
  turnId: string | null,
  meta: EventMeta,
  update: ExecUpdate,
  output: string,
): ExecWorkRow {
  const base = {
    id: messageId(threadId, update.kind, update.callId),
    threadId,
    turnId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    startedAt: meta.createdAt,
    createdAt: meta.createdAt,
    kind: "work" as const,
    callId: update.callId,
    output,
    completedAt: update.completedAt,
    status: update.status,
    ...(update.presentation ? { presentation: update.presentation } : {}),
  };

  if (update.kind === "command") {
    return {
      ...base,
      workKind: "command",
      command: update.command ?? "",
      cwd: update.cwd ?? null,
      source: null,
      exitCode: update.exitCode ?? null,
      approvalStatus: update.approvalStatus ?? null,
      activityIntents: update.activityIntents ?? [],
    };
  }
  if (update.kind === "delegation") {
    return {
      ...base,
      workKind: "delegation",
      toolName: update.toolName ?? "delegation",
      childRef: update.childRef ?? null,
      background: update.background ?? false,
      subagentType: null,
      description: update.description ?? null,
      childRows: [],
    };
  }
  return {
    ...base,
    workKind: "tool",
    toolName: update.toolName ?? "tool",
    toolArgs: update.toolArgs ?? null,
    approvalStatus: update.approvalStatus ?? null,
  };
}

function applyExecUpdate(
  state: ToolsState,
  threadId: string,
  turnId: string | null,
  meta: EventMeta,
  update: ExecUpdate,
): void {
  const running = state.runningExecByCallId.get(update.callId);

  if (!update.isEnd) {
    if (running) {
      mergeExecIntoRow(running.row, update, meta, state, running.buffer);
      const pending = state.pendingExecOutputByCallId.get(update.callId);
      if (pending) {
        reconcilePendingOutput(running, pending, state);
        state.pendingExecOutputByCallId.delete(update.callId);
      }
      return;
    }

    const buffer = createVisibleTextBuffer();
    if (update.output && update.output.length > 0) {
      setVisibleTextBuffer(buffer, update.output, update.status !== "pending");
    }
    const row = createExecRow(
      threadId,
      turnId,
      meta,
      update,
      getVisibleTextBufferText(buffer) ?? "",
    );
    setParent(state, row, update.parentToolCallId);
    const entry: RunningExecEntry = { row, buffer };
    const pending = state.pendingExecOutputByCallId.get(update.callId);
    if (pending) {
      reconcilePendingOutput(entry, pending, state);
      state.pendingExecOutputByCallId.delete(update.callId);
    }
    state.finalizedExecCallIds.delete(update.callId);
    state.runningExecByCallId.set(update.callId, entry);
    state.latestExecByCallId.set(update.callId, row);
    state.rows.push(row);
    return;
  }

  // End event
  if (running) {
    mergeExecIntoRow(running.row, update, meta, state, running.buffer);
    const pending = state.pendingExecOutputByCallId.get(update.callId);
    if (pending) {
      reconcilePendingOutput(running, pending, state);
      state.pendingExecOutputByCallId.delete(update.callId);
    }
    if (running.row.status !== "pending") {
      flushVisibleTextBuffer(running.buffer);
      running.row.output = getVisibleTextBufferText(running.buffer) ?? "";
    }
    state.runningExecByCallId.delete(update.callId);
    state.finalizedExecCallIds.add(update.callId);
    return;
  }

  if (state.finalizedExecCallIds.has(update.callId) && update.status !== "error") {
    return;
  }

  const latest = state.latestExecByCallId.get(update.callId);
  if (latest) {
    const tempBuffer = createVisibleTextBuffer();
    if (update.output) setVisibleTextBuffer(tempBuffer, update.output, true);
    const pending = state.pendingExecOutputByCallId.get(update.callId);
    if (pending) {
      flushVisibleTextBuffer(pending.buffer);
      const pendingText = getVisibleTextBufferFullText(pending.buffer);
      if (pendingText && !(update.output ?? "").includes(pendingText)) {
        update = {
          ...update,
          output: pendingText.includes(update.output ?? "")
            ? pendingText
            : `${pendingText}${update.output ?? ""}`,
        };
      }
      state.pendingExecOutputByCallId.delete(update.callId);
    }
    mergeExecIntoRow(latest, update, meta, state, null);
    state.finalizedExecCallIds.add(update.callId);
    return;
  }

  const buffer = createVisibleTextBuffer();
  if (update.output && update.output.length > 0) {
    setVisibleTextBuffer(buffer, update.output, true);
  }
  const row = createExecRow(
    threadId,
    turnId,
    meta,
    update,
    getVisibleTextBufferText(buffer) ?? "",
  );
  setParent(state, row, update.parentToolCallId);
  const entry: RunningExecEntry = { row, buffer };
  const pending = state.pendingExecOutputByCallId.get(update.callId);
  if (pending) {
    reconcilePendingOutput(entry, pending, state);
    state.pendingExecOutputByCallId.delete(update.callId);
  }
  flushVisibleTextBuffer(buffer);
  row.output = getVisibleTextBufferText(buffer) ?? "";
  state.latestExecByCallId.set(update.callId, row);
  state.finalizedExecCallIds.add(update.callId);
  state.rows.push(row);
}

function applyExecOutput(
  state: ToolsState,
  meta: EventMeta,
  callId: string,
  delta: string,
  mode: "append" | "replace" | "snapshot",
  parentToolCallId: string | undefined,
): void {
  const running = state.runningExecByCallId.get(callId);
  if (running) {
    if (mode === "append") {
      if (delta.length > 0) appendVisibleTextBuffer(running.buffer, delta);
    } else if (mode === "replace") {
      setVisibleTextBuffer(running.buffer, delta, false);
    } else if (delta.length >= getVisibleTextBufferFullLength(running.buffer)) {
      setVisibleTextBuffer(running.buffer, delta, true);
    }
    running.row.output = getVisibleTextBufferText(running.buffer) ?? "";
    running.row.sourceSeqEnd = Math.max(running.row.sourceSeqEnd, meta.seq);
    running.row.createdAt = Math.max(running.row.createdAt, meta.createdAt);
    running.row.status = mergeStatus(running.row.status, "pending");
    return;
  }

  const latest = state.latestExecByCallId.get(callId);
  if (latest) {
    if (mode === "append" && delta.length > 0) {
      latest.output = `${latest.output}${delta}`;
    } else if (mode === "replace" && delta.length > 0) {
      latest.output = delta;
    } else if (mode === "snapshot" && delta.length >= latest.output.length) {
      latest.output = delta;
    }
    latest.sourceSeqEnd = Math.max(latest.sourceSeqEnd, meta.seq);
    latest.createdAt = Math.max(latest.createdAt, meta.createdAt);
    latest.status = mergeStatus(latest.status, "pending");
    return;
  }

  let pending = state.pendingExecOutputByCallId.get(callId);
  if (!pending) {
    pending = {
      ...(parentToolCallId ? { parentToolCallId } : {}),
      sourceSeqStart: meta.seq,
      sourceSeqEnd: meta.seq,
      startedAt: meta.createdAt,
      createdAt: meta.createdAt,
      status: "pending",
      buffer: createVisibleTextBuffer(),
    };
    state.pendingExecOutputByCallId.set(callId, pending);
  }
  if (mode === "append") {
    if (delta.length > 0) appendVisibleTextBuffer(pending.buffer, delta);
  } else if (mode === "replace") {
    setVisibleTextBuffer(pending.buffer, delta, false);
  } else if (delta.length >= getVisibleTextBufferFullLength(pending.buffer)) {
    setVisibleTextBuffer(pending.buffer, delta, true);
  }
  pending.sourceSeqEnd = Math.max(pending.sourceSeqEnd, meta.seq);
  pending.createdAt = Math.max(pending.createdAt, meta.createdAt);
  if (!pending.parentToolCallId && parentToolCallId) {
    pending.parentToolCallId = parentToolCallId;
  }
  pending.status = mergeStatus(pending.status, "pending");
}

// ── Web / Item Activity ──────────────────────────────────────────────────────

function clampWebStatus(
  workKind: WebWorkRow["workKind"],
  status: TimelineRowStatus,
): TimelineRowStatus {
  if (
    status === "error" &&
    (workKind === "web-search" ||
      workKind === "web-fetch" ||
      workKind === "image-view")
  ) {
    return "completed";
  }
  return status;
}

function handleWebActivity(
  state: ToolsState,
  threadId: string,
  turnId: string | null,
  meta: EventMeta,
  isEnd: boolean,
  callId: string,
  workKind: WebWorkRow["workKind"],
  parentToolCallId: string | undefined,
  buildFields: () => WebWorkRow,
  applyFields: (target: WebWorkRow) => void,
  rawStatus: TimelineRowStatus,
): void {
  const scopeKey = turnId ?? "thread";
  const key = `${scopeKey}:${workKind}:${callId}`;
  if (state.finalizedWebKeys.has(key)) return;

  const bucketKey = `${scopeKey}:${callId}`;
  const existingList = state.webByCallId.get(bucketKey) ?? [];
  let match: WebWorkRow | undefined;
  for (let i = existingList.length - 1; i >= 0; i -= 1) {
    const candidate = existingList[i]!;
    if (candidate.workKind !== workKind) {
      if (candidate.status === "pending") {
        candidate.status = "interrupted";
        candidate.completedAt = meta.createdAt;
      }
    } else if (!match) {
      match = candidate;
    }
  }

  if (match) {
    match.sourceSeqEnd = Math.max(match.sourceSeqEnd, meta.seq);
    match.createdAt = Math.max(match.createdAt, meta.createdAt);
    setParent(state, match, parentToolCallId);
    applyFields(match);
    if (isEnd) {
      match.status = clampWebStatus(
        workKind,
        rawStatus === "pending" ? "completed" : rawStatus,
      );
      match.completedAt = meta.createdAt;
      state.finalizedWebKeys.add(key);
    }
    return;
  }

  const row = buildFields();
  if (isEnd) {
    row.id = messageId(threadId, workKind, `${callId}:${meta.seq}`);
    row.status = clampWebStatus(
      workKind,
      rawStatus === "pending" ? "completed" : rawStatus,
    );
    row.completedAt = meta.createdAt;
    state.finalizedWebKeys.add(key);
  }
  setParent(state, row, parentToolCallId);
  existingList.push(row);
  state.webByCallId.set(bucketKey, existingList);
  state.rows.push(row);
}

// ── File Edits ───────────────────────────────────────────────────────────────

function rawChangeToTimeline(
  change: RawFileChange,
  workspaceRoot: string | null,
): TimelineFileChange {
  return {
    path: relativizeWorkspacePath(change.path, workspaceRoot),
    kind: change.kind ?? null,
    movePath:
      change.movePath == null
        ? null
        : relativizeWorkspacePath(change.movePath, workspaceRoot),
    diff: change.diff ?? null,
    diffStats: getFileChangeDiffStats(change),
  };
}

function buildFileEditRow(
  record: FileEditRecord,
  threadId: string,
  workspaceRoot: string | null,
): TimelineFileChangeWorkRow | FileEditApprovalRow | null {
  const base = {
    threadId,
    turnId: record.turnId,
    sourceSeqStart: record.sourceSeqStart,
    sourceSeqEnd: record.sourceSeqEnd,
    startedAt: record.startedAt,
    createdAt: record.createdAt,
    kind: "work" as const,
    status: record.status,
  };
  if (record.rawChange) {
    return {
      ...base,
      id: `${record.baseId}:file-change:0`,
      workKind: "file-change",
      callId: record.callId,
      change: rawChangeToTimeline(record.rawChange, workspaceRoot),
      stdout: record.stdout,
      stderr: null,
      approvalStatus: record.approvalStatus,
      ...(record.presentation ? { presentation: record.presentation } : {}),
    };
  }
  if (record.approvalStatus !== null) {
    return {
      ...base,
      id: record.baseId,
      workKind: "approval",
      approvalKind: "file-edit",
      interactionId: record.callId,
      lifecycle: record.approvalStatus === "denied" ? "denied" : "waiting",
      target: { itemId: record.callId, toolName: null },
    };
  }
  return null;
}

function syncFileEditRecord(
  record: FileEditRecord,
  threadId: string,
  state: ToolsState,
): void {
  const nextRow = buildFileEditRow(record, threadId, state.workspaceRoot);
  if (record.row && nextRow && record.row.workKind === nextRow.workKind) {
    Object.assign(record.row, nextRow);
    setParent(state, record.row, record.parentToolCallId);
    return;
  }
  if (record.row) {
    const idx = state.rows.indexOf(record.row);
    if (idx !== -1) {
      if (nextRow) state.rows[idx] = nextRow;
      else state.rows.splice(idx, 1);
    }
  } else if (nextRow) {
    state.rows.push(nextRow);
  }
  record.row = nextRow;
  if (nextRow) setParent(state, nextRow, record.parentToolCallId);
}

function mergeFileEditStatus(
  current: TimelineRowStatus,
  incoming: TimelineRowStatus,
): TimelineRowStatus {
  if (incoming === "error") return "error";
  if (current === "pending" || current === "interrupted") return incoming;
  if (current !== "error" && incoming === "completed") return "completed";
  return current;
}

function upsertFileEditEvent(
  state: ToolsState,
  threadId: string,
  turnId: string | null,
  meta: EventMeta,
  callId: string,
  parentToolCallId: string | undefined,
  incoming:
    | { kind: "delta"; delta: string }
    | {
        kind: "item";
        changes: ThreadEventFileChange[];
        approvalStatus: TimelineApprovalStatus;
        status: TimelineRowStatus;
        presentation?: ThreadEventItemPresentation;
      },
): void {
  const allExisting = state.fileEditsByCallId.get(callId) ?? [];
  const compatible: FileEditRecord[] = [];
  const foreign: FileEditRecord[] = [];
  for (const rec of allExisting) {
    if (rec.turnId === turnId) compatible.push(rec);
    else foreign.push(rec);
  }
  const foreignBaseIds = new Set(foreign.map((r) => r.baseId));
  const scopeKey = turnId ?? "thread";
  const scopedCallKey = `${scopeKey}:${callId}`;

  let buf = state.fileEditStdoutByScopedKey.get(scopedCallKey);
  const incomingStatus: TimelineRowStatus =
    incoming.kind === "delta" ? "pending" : incoming.status;
  if (incoming.kind === "delta") {
    if (!buf) {
      buf = createVisibleTextBuffer();
      state.fileEditStdoutByScopedKey.set(scopedCallKey, buf);
    }
    if (incoming.delta.length > 0) appendVisibleTextBuffer(buf, incoming.delta);
  } else if (buf && incoming.status !== "pending") {
    flushVisibleTextBuffer(buf);
  }
  const stdout = buf ? (getVisibleTextBufferText(buf) ?? null) : null;

  const resolveBaseId = (baseKey: string) => {
    const candidate = messageId(threadId, "file-edit", baseKey);
    return foreignBaseIds.has(candidate)
      ? messageId(threadId, "file-edit", `${scopeKey}:${baseKey}`)
      : candidate;
  };

  if (incoming.kind === "item" && incoming.changes.length > 0) {
    const byMatchKey = new Map<string, FileEditRecord[]>();
    for (const rec of compatible) {
      if (!rec.rawChange) continue;
      const keys =
        rec.rawChange.movePath && rec.rawChange.movePath !== rec.rawChange.path
          ? [rec.rawChange.path, rec.rawChange.movePath]
          : [rec.rawChange.path];
      for (const k of keys) {
        const list = byMatchKey.get(k) ?? [];
        list.push(rec);
        byMatchKey.set(k, list);
      }
    }

    const used = new Set<FileEditRecord>();
    const seenIdCounts = new Map<string, number>();
    const nextCompatible: FileEditRecord[] = [];

    for (const ch of incoming.changes) {
      const raw: RawFileChange = {
        path: ch.path,
        kind: ch.kind,
        movePath: ch.movePath ?? null,
        diff: ch.diff,
      };
      const identity = raw.movePath ?? raw.path;
      const count = seenIdCounts.get(identity) ?? 0;
      seenIdCounts.set(identity, count + 1);
      const baseKey =
        count === 0 ? `${callId}:${identity}` : `${callId}:${identity}:${count}`;

      const matchKeys =
        raw.movePath && raw.movePath !== raw.path
          ? [raw.path, raw.movePath]
          : [raw.path];
      let matched: FileEditRecord | undefined;
      for (const k of matchKeys) {
        const bucket = byMatchKey.get(k);
        while (bucket && bucket.length > 0 && !matched) {
          const cand = bucket.shift()!;
          if (!used.has(cand)) matched = cand;
        }
        if (matched) {
          used.add(matched);
          break;
        }
      }

      if (matched) {
        matched.sourceSeqEnd = meta.seq;
        matched.createdAt = meta.createdAt;
        if (!matched.parentToolCallId && parentToolCallId) {
          matched.parentToolCallId = parentToolCallId;
        }
        if (incoming.presentation) matched.presentation = incoming.presentation;
        matched.rawChange = {
          path: raw.path,
          kind: raw.kind ?? matched.rawChange?.kind,
          movePath: raw.movePath ?? matched.rawChange?.movePath,
          diff: raw.diff ?? matched.rawChange?.diff,
        };
        matched.stdout = stdout;
        matched.approvalStatus = applyApproval(
          matched.approvalStatus,
          incoming.approvalStatus,
          incoming.status,
        );
        matched.status = mergeFileEditStatus(matched.status, incoming.status);
        nextCompatible.push(matched);
      } else {
        nextCompatible.push({
          turnId,
          callId,
          baseId: resolveBaseId(baseKey),
          rawChange: raw,
          approvalStatus: incoming.approvalStatus,
          status: incoming.status,
          row: null,
          sourceSeqStart: meta.seq,
          sourceSeqEnd: meta.seq,
          startedAt: meta.createdAt,
          createdAt: meta.createdAt,
          stdout,
          ...(parentToolCallId ? { parentToolCallId } : {}),
          ...(incoming.presentation ? { presentation: incoming.presentation } : {}),
        });
      }
    }

    // Replace existing rows for this callId cleanly at original position (O(1) when new)
    let firstIdx = -1;
    if (allExisting.length > 0) {
      const existingRowSet = new Set(
        allExisting
          .map((r) => r.row)
          .filter((r): r is NonNullable<typeof r> => r !== null),
      );
      if (existingRowSet.size > 0) {
        firstIdx = state.rows.findIndex((r) => existingRowSet.has(r as never));
        state.rows = state.rows.filter((r) => !existingRowSet.has(r as never));
      }
    }
    const nextAll = [...foreign, ...nextCompatible];
    const nextRows: (TimelineFileChangeWorkRow | FileEditApprovalRow)[] = [];
    for (const rec of nextAll) {
      const built = buildFileEditRow(rec, threadId, state.workspaceRoot);
      rec.row = built;
      if (built) {
        setParent(state, built, rec.parentToolCallId);
        nextRows.push(built);
      }
    }
    if (firstIdx === -1) state.rows.push(...nextRows);
    else state.rows.splice(firstIdx, 0, ...nextRows);
    state.fileEditsByCallId.set(callId, nextAll);
    return;
  }

  // Delta or empty-changes item update
  if (compatible.length === 0) {
    const rec: FileEditRecord = {
      turnId,
      callId,
      baseId: resolveBaseId(`${callId}:0`),
      rawChange: null,
      approvalStatus:
        incoming.kind === "item" ? incoming.approvalStatus : null,
      status: incomingStatus,
      row: null,
      sourceSeqStart: meta.seq,
      sourceSeqEnd: meta.seq,
      startedAt: meta.createdAt,
      createdAt: meta.createdAt,
      stdout,
      ...(parentToolCallId ? { parentToolCallId } : {}),
      ...(incoming.kind === "item" && incoming.presentation
        ? { presentation: incoming.presentation }
        : {}),
    };
    syncFileEditRecord(rec, threadId, state);
    compatible.push(rec);
  } else {
    for (const rec of compatible) {
      rec.sourceSeqEnd = meta.seq;
      rec.createdAt = meta.createdAt;
      if (!rec.parentToolCallId && parentToolCallId) {
        rec.parentToolCallId = parentToolCallId;
      }
      if (incoming.kind === "item" && incoming.presentation) {
        rec.presentation = incoming.presentation;
      }
      rec.stdout = stdout;
      rec.approvalStatus = applyApproval(
        rec.approvalStatus,
        incoming.kind === "item" ? incoming.approvalStatus : undefined,
        incomingStatus,
      );
      rec.status = mergeFileEditStatus(rec.status, incomingStatus);
      if (rec.row?.workKind === "file-change") {
        rec.row.sourceSeqEnd = rec.sourceSeqEnd;
        rec.row.createdAt = rec.createdAt;
        rec.row.status = rec.status;
        rec.row.approvalStatus = rec.approvalStatus;
        rec.row.stdout = rec.stdout;
        if (rec.presentation) rec.row.presentation = rec.presentation;
        setParent(state, rec.row, rec.parentToolCallId);
      } else {
        syncFileEditRecord(rec, threadId, state);
      }
    }
  }
  state.fileEditsByCallId.set(callId, [...foreign, ...compatible]);
}

// ── Background Tasks (Workflows / Background Commands / Agents) ──────────────

function upsertBackgroundTask(
  state: ToolsState,
  threadId: string,
  turnId: string | null,
  meta: EventMeta,
  item: ThreadEventBackgroundTaskItem,
  isEnd: boolean,
  openTurnId: string | null,
): void {
  const existing = state.backgroundTasksByItemId.get(item.id);
  if (existing) {
    existing.familyId = item.familyId ?? null;
    existing.skipTranscript = item.skipTranscript;
    existing.row.taskType = item.taskType;
    existing.row.workflowName = item.workflowName ?? null;
    existing.row.description = item.description;
    existing.row.status = itemStatusToRowStatus(item.status);
    existing.row.taskStatus = item.taskStatus;
    existing.row.workflow = item.workflow ?? null;
    existing.row.usage = item.usage ?? null;
    existing.row.summary = item.summary ?? null;
    existing.row.error = item.error ?? null;
    if (isEnd && existing.row.completedAt === null) {
      existing.row.completedAt = meta.createdAt;
      // A finished background command shows where it finished: in the turn still running then, else on its own, where
      // the agent often continues from it.
      if (isBackgroundCommandTaskType(item.taskType)) {
        existing.row.turnId = openTurnId;
        existing.row.sourceSeqStart = meta.seq;
        existing.row.sourceSeqEnd = meta.seq;
      }
    }
    existing.row.createdAt = Math.max(existing.row.createdAt, meta.createdAt);
    return;
  }

  const row: TimelineWorkflowWorkRow = {
    id: item.id,
    threadId,
    turnId: isEnd && isBackgroundCommandTaskType(item.taskType) ? openTurnId : turnId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    startedAt: meta.createdAt,
    createdAt: meta.createdAt,
    kind: "work",
    workKind: "workflow",
    status: itemStatusToRowStatus(item.status),
    itemId: item.id,
    taskType: item.taskType,
    workflowName: item.workflowName ?? null,
    description: item.description,
    model: null,
    taskStatus: item.taskStatus,
    workflow: item.workflow ?? null,
    usage: item.usage ?? null,
    summary: item.summary ?? null,
    error: item.error ?? null,
    completedAt: isEnd ? meta.createdAt : null,
    ...(item.presentation ? { presentation: item.presentation } : {}),
  };
  setParent(state, row, item.parentToolCallId);
  const entry: BackgroundTaskEntry = {
    row,
    familyId: item.familyId ?? null,
    skipTranscript: item.skipTranscript,
  };
  state.backgroundTasksByItemId.set(item.id, entry);
  state.rows.push(row);
}

// ── Public Entry Point for Fold Loop ─────────────────────────────────────────

export function projectToolEvent(
  state: ToolsState,
  event: ThreadEvent,
  meta: EventMeta,
  parentToolCallIdOverride: string | undefined,
  openTurnId: string | null = null,
): { handled: boolean; delegation?: { callId: string; childRef?: string; isEnd: boolean } } {
  const turnId = getEventTurnId(event) ?? null;
  const parentToolCallId =
    parentToolCallIdOverride ?? getEventParentToolCallId(event);

  // Background tasks
  if (
    event.type === "item/backgroundTask/progress" ||
    event.type === "item/backgroundTask/completed"
  ) {
    upsertBackgroundTask(
      state,
      event.threadId,
      turnId,
      meta,
      event.item,
      event.type === "item/backgroundTask/completed",
      openTurnId,
    );
    return { handled: true };
  }
  if (
    (event.type === "item/started" || event.type === "item/completed") &&
    event.item.type === "backgroundTask"
  ) {
    upsertBackgroundTask(
      state,
      event.threadId,
      turnId,
      meta,
      event.item,
      event.type === "item/completed",
      openTurnId,
    );
    return { handled: true };
  }

  // Command output delta
  if (event.type === "item/commandExecution/outputDelta") {
    if (event.itemId) {
      applyExecOutput(
        state,
        meta,
        event.itemId,
        event.delta,
        event.reset ? "replace" : "append",
        parentToolCallId,
      );
    }
    return { handled: true };
  }

  // Command execution started/completed
  if (
    (event.type === "item/started" || event.type === "item/completed") &&
    event.item.type === "commandExecution"
  ) {
    if (event.item.id) {
      const isEnd = event.type === "item/completed";
      const exitCode = event.item.exitCode;
      const command = extractShellCommandFromString(event.item.command);
      const existingRunning = state.runningExecByCallId.get(event.item.id)?.row;
      const reuseIntents =
        existingRunning?.workKind === "command" &&
        existingRunning.command === command;
      applyExecUpdate(state, event.threadId, turnId, meta, {
        kind: "command",
        callId: event.item.id,
        isEnd,
        command,
        cwd: event.item.cwd,
        activityIntents: reuseIntents
          ? undefined
          : parseShellCommandIntents(command),
        output: event.item.aggregatedOutput,
        exitCode,
        completedAt: isEnd ? meta.createdAt : null,
        approvalStatus: toApprovalStatus(event.item.approvalStatus),
        status:
          exitCode !== undefined && exitCode !== 0
            ? "error"
            : itemStatusToRowStatus(event.item.status),
        presentation: event.item.presentation,
        parentToolCallId,
      });
    }
    return { handled: true };
  }

  if (shouldSuppressLowValueItem(event)) {
    return { handled: true };
  }

  // ToolCall progress
  if (
    event.type === "item/toolCall/progress" ||
    event.type === "item/mcpToolCall/progress"
  ) {
    applyExecOutput(
      state,
      meta,
      event.itemId,
      event.message ?? "Progress update",
      "snapshot",
      parentToolCallId,
    );
    return { handled: true };
  }

  // Delegation lifecycle
  if (
    (event.type === "item/started" ||
      event.type === "item/completed" ||
      event.type === "item/delegation/progress" ||
      event.type === "item/delegation/completed") &&
    event.item.type === "delegation"
  ) {
    const isEnd =
      event.type === "item/completed" ||
      event.type === "item/delegation/completed";
    applyExecUpdate(state, event.threadId, turnId, meta, {
      kind: "delegation",
      callId: event.item.id,
      isEnd,
      toolName: "delegation",
      childRef: event.item.childRef,
      background: event.item.background,
      description: event.item.label,
      output: event.item.summary,
      completedAt: isEnd ? meta.createdAt : null,
      status: isEnd ? itemStatusToRowStatus(event.item.status) : "pending",
      presentation: event.item.presentation,
      parentToolCallId,
    });
    return {
      handled: true,
      delegation: {
        callId: event.item.id,
        childRef: event.item.childRef,
        isEnd,
      },
    };
  }

  // ToolCall started/completed
  if (
    (event.type === "item/started" || event.type === "item/completed") &&
    event.item.type === "toolCall"
  ) {
    if (event.item.id) {
      const isEnd = event.type === "item/completed";
      // Bridges tag Cloudroom plugin tools with server "bb"; never display it.
      const server = event.item.server;
      const prefix = server && server !== "bb" ? `${server}:` : "";
      const result = event.item.result;
      const output =
        typeof result === "string"
          ? result
          : result !== undefined
            ? JSON.stringify(result)
            : undefined;
      applyExecUpdate(state, event.threadId, turnId, meta, {
        kind: "tool",
        callId: event.item.id,
        isEnd,
        toolName: `${prefix}${event.item.tool}`,
        toolArgs: parseToolArgs(event.item.arguments ?? null),
        output: isEnd ? (output ?? event.item.error) : undefined,
        completedAt: isEnd ? meta.createdAt : null,
        status: isEnd ? itemStatusToRowStatus(event.item.status) : "pending",
        presentation: event.item.presentation,
        parentToolCallId,
      });
    }
    return { handled: true };
  }

  // Legacy image generation (provider/unhandled)
  if (event.type === "provider/unhandled") {
    const img = parseLegacyImageGenerationCompletion(event);
    if (img) {
      handleWebActivity(
        state,
        event.threadId,
        turnId,
        meta,
        true,
        img.callId,
        "image-generation",
        parentToolCallId,
        () => ({
          id: messageId(event.threadId, "image-generation", img.callId),
          threadId: event.threadId,
          turnId,
          sourceSeqStart: meta.seq,
          sourceSeqEnd: meta.seq,
          startedAt: meta.createdAt,
          createdAt: meta.createdAt,
          kind: "work",
          workKind: "image-generation",
          callId: img.callId,
          prompt: img.prompt,
          path: img.path,
          error: img.error,
          transparentBackground: img.transparentBackground,
          completedAt: meta.createdAt,
          status: itemStatusToRowStatus(img.status),
        }),
        (target) => {
          if (target.workKind !== "image-generation") return;
          target.prompt = img.prompt;
          target.path = img.path;
          target.error = img.error;
          target.transparentBackground = img.transparentBackground;
        },
        itemStatusToRowStatus(img.status),
      );
      return { handled: true };
    }
  }

  // Web & V3 item activities
  if (event.type === "item/started" || event.type === "item/completed") {
    const isEnd = event.type === "item/completed";
    const item = event.item;
    if (item.id) {
      const base = (workKind: WebWorkRow["workKind"]) => ({
        id: messageId(event.threadId, workKind, item.id),
        threadId: event.threadId,
        turnId,
        sourceSeqStart: meta.seq,
        sourceSeqEnd: meta.seq,
        startedAt: meta.createdAt,
        createdAt: meta.createdAt,
        kind: "work" as const,
        callId: item.id,
        completedAt: isEnd ? meta.createdAt : null,
        ...("presentation" in item && item.presentation
          ? { presentation: item.presentation }
          : {}),
      });

      switch (item.type) {
        case "webSearch":
          handleWebActivity(
            state,
            event.threadId,
            turnId,
            meta,
            isEnd,
            item.id,
            "web-search",
            parentToolCallId,
            () => ({
              ...base("web-search"),
              workKind: "web-search",
              queries: item.queries,
              status: "pending",
            }),
            (t) => {
              if (t.workKind === "web-search") {
                t.queries = item.queries;
                if (item.presentation) t.presentation = item.presentation;
              }
            },
            "completed",
          );
          return { handled: true };
        case "webFetch":
          handleWebActivity(
            state,
            event.threadId,
            turnId,
            meta,
            isEnd,
            item.id,
            "web-fetch",
            parentToolCallId,
            () => ({
              ...base("web-fetch"),
              workKind: "web-fetch",
              url: item.url,
              prompt: item.prompt,
              pattern: item.pattern,
              status: "pending",
            }),
            (t) => {
              if (t.workKind === "web-fetch") {
                t.url = item.url;
                t.prompt = item.prompt;
                t.pattern = item.pattern;
                if (item.presentation) t.presentation = item.presentation;
              }
            },
            "completed",
          );
          return { handled: true };
        case "imageView":
          handleWebActivity(
            state,
            event.threadId,
            turnId,
            meta,
            isEnd,
            item.id,
            "image-view",
            parentToolCallId,
            () => ({
              ...base("image-view"),
              workKind: "image-view",
              path: item.path,
              status: "pending",
            }),
            (t) => {
              if (t.workKind === "image-view") {
                t.path = item.path;
                if (item.presentation) t.presentation = item.presentation;
              }
            },
            "completed",
          );
          return { handled: true };
        case "imageGeneration":
          handleWebActivity(
            state,
            event.threadId,
            turnId,
            meta,
            isEnd,
            item.id,
            "image-generation",
            parentToolCallId,
            () => ({
              ...base("image-generation"),
              workKind: "image-generation",
              prompt: item.prompt,
              path: item.path,
              error: item.error,
              transparentBackground: item.transparentBackground,
              status: "pending",
            }),
            (t) => {
              if (t.workKind === "image-generation") {
                t.prompt = item.prompt;
                t.path = item.path;
                t.error = item.error;
                t.transparentBackground = item.transparentBackground;
                if (item.presentation) t.presentation = item.presentation;
              }
            },
            itemStatusToRowStatus(item.status),
          );
          return { handled: true };
        case "fileRead":
          handleWebActivity(
            state,
            event.threadId,
            turnId,
            meta,
            isEnd,
            item.id,
            "file-read",
            parentToolCallId,
            () => ({
              ...base("file-read"),
              workKind: "file-read",
              path: item.path,
              cmd: item.cmd ?? null,
              status: "pending",
            }),
            (t) => {
              if (t.workKind === "file-read") {
                t.path = item.path;
                t.cmd = item.cmd ?? null;
                if (item.presentation) t.presentation = item.presentation;
              }
            },
            itemStatusToRowStatus(item.status),
          );
          return { handled: true };
        case "search":
          handleWebActivity(
            state,
            event.threadId,
            turnId,
            meta,
            isEnd,
            item.id,
            "search",
            parentToolCallId,
            () => ({
              ...base("search"),
              workKind: "search",
              mode: item.mode,
              query: item.query,
              path: item.path ?? null,
              cmd: item.cmd ?? null,
              status: "pending",
            }),
            (t) => {
              if (t.workKind === "search") {
                t.mode = item.mode;
                t.query = item.query;
                t.path = item.path ?? null;
                t.cmd = item.cmd ?? null;
                if (item.presentation) t.presentation = item.presentation;
              }
            },
            itemStatusToRowStatus(item.status),
          );
          return { handled: true };
        case "planSteps":
          handleWebActivity(
            state,
            event.threadId,
            turnId,
            meta,
            isEnd,
            item.id,
            "plan-steps",
            parentToolCallId,
            () => ({
              ...base("plan-steps"),
              workKind: "plan-steps",
              steps: item.steps,
              explanation: item.explanation ?? null,
              status: "pending",
            }),
            (t) => {
              if (t.workKind === "plan-steps") {
                t.steps = item.steps;
                t.explanation = item.explanation ?? null;
                if (item.presentation) t.presentation = item.presentation;
              }
            },
            itemStatusToRowStatus(item.status),
          );
          return { handled: true };
        case "extension":
          handleWebActivity(
            state,
            event.threadId,
            turnId,
            meta,
            isEnd,
            item.id,
            "extension",
            parentToolCallId,
            () => ({
              ...base("extension"),
              workKind: "extension",
              extensionKind: item.kind,
              payload: item.payload,
              presentation: item.presentation,
              status: "pending",
            }),
            (t) => {
              if (t.workKind === "extension") {
                t.extensionKind = item.kind;
                t.payload = item.payload;
                t.presentation = item.presentation;
              }
            },
            itemStatusToRowStatus(item.status),
          );
          return { handled: true };
        case "fileChange":
          upsertFileEditEvent(
            state,
            event.threadId,
            turnId,
            meta,
            item.id,
            parentToolCallId,
            {
              kind: "item",
              changes: item.changes,
              approvalStatus: toApprovalStatus(item.approvalStatus),
              status: itemStatusToRowStatus(item.status),
              presentation: item.presentation,
            },
          );
          return { handled: true };
      }
    }
  }

  // FileChange output delta
  if (event.type === "item/fileChange/outputDelta") {
    if (event.itemId) {
      upsertFileEditEvent(
        state,
        event.threadId,
        turnId,
        meta,
        event.itemId,
        parentToolCallId,
        { kind: "delta", delta: event.delta },
      );
    }
    return { handled: true };
  }

  return { handled: false };
}

// ── Flushing & Interruption Helpers ──────────────────────────────────────────

export function flushPendingToolOutputs(state: ToolsState): void {
  for (const entry of state.runningExecByCallId.values()) {
    if (flushVisibleTextBuffer(entry.buffer)) {
      entry.row.output = getVisibleTextBufferText(entry.buffer) ?? "";
    }
  }
  if (state.fileEditStdoutByScopedKey.size === 0) return;
  let anyFlushed = false;
  for (const buf of state.fileEditStdoutByScopedKey.values()) {
    if (flushVisibleTextBuffer(buf)) anyFlushed = true;
  }
  if (!anyFlushed) return;
  for (const [callId, records] of state.fileEditsByCallId) {
    for (const rec of records) {
      const scopedKey = `${rec.turnId ?? "thread"}:${callId}`;
      const buf = state.fileEditStdoutByScopedKey.get(scopedKey);
      if (!buf) continue;
      const text = getVisibleTextBufferText(buf) ?? null;
      rec.stdout = text;
      if (rec.row?.workKind === "file-change") rec.row.stdout = text;
    }
  }
}

export function interruptPendingTools(
  state: ToolsState,
  completedAt: number | null,
  turnIds?: ReadonlySet<string>,
): void {
  const inScope = (turnId: string | null) =>
    turnIds === undefined || (turnId !== null && turnIds.has(turnId));

  const toDelete: string[] = [];
  for (const [callId, entry] of state.runningExecByCallId) {
    if (!inScope(entry.row.turnId)) continue;
    flushVisibleTextBuffer(entry.buffer);
    entry.row.output = getVisibleTextBufferText(entry.buffer) ?? "";
    if (entry.row.status === "pending") {
      entry.row.status = "interrupted";
      entry.row.completedAt = completedAt;
      if (!entry.row.output) entry.row.output = "Tool execution interrupted";
    }
    toDelete.push(callId);
  }
  for (const id of toDelete) state.runningExecByCallId.delete(id);

  for (const row of state.rows) {
    if (row.kind !== "work" || !inScope(row.turnId)) continue;
    if (row.status !== "pending") continue;
    switch (row.workKind) {
      case "command":
      case "tool":
      case "delegation":
        row.status = "interrupted";
        row.completedAt = completedAt;
        if (!row.output) row.output = "Tool execution interrupted";
        break;
      case "web-search":
      case "web-fetch":
      case "image-generation":
      case "image-view":
      case "file-read":
      case "search":
      case "plan-steps":
      case "extension":
        row.status = "interrupted";
        row.completedAt = completedAt;
        break;
    }
  }
}

export function interruptPendingFileEdits(
  state: ToolsState,
  turnIds?: ReadonlySet<string>,
): void {
  for (const records of state.fileEditsByCallId.values()) {
    for (const rec of records) {
      if (turnIds !== undefined && (rec.turnId === null || !turnIds.has(rec.turnId))) {
        continue;
      }
      if (rec.status === "pending") {
        rec.status = "interrupted";
        if (rec.row) rec.row.status = "interrupted";
      }
    }
  }
}
