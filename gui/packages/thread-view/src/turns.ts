import {
  THREAD_ACCOUNT_SWITCH_OPERATION,
  THREAD_HARNESS_SWITCH_OPERATION,
  isBackgroundAgentTaskType,
  isLegacyDelegationToolCall,
  requireThreadEventScopeTurnId,
  type CompletedTurnDisplay,
} from "@cloudroom/domain";
import type {
  TimelineDelegationWorkRow,
  TimelineNonOperationSystemRow,
  TimelineRow,
  TimelineRowStatus,
  TimelineSourceRow,
  TimelineTurnRow,
} from "@cloudroom/server-contract";
import type { EventMeta, ThreadEventWithMeta } from "./events.js";
import {
  PROVIDER_AUTH_FAILED_TITLE,
  isPlanLimitReply,
} from "./messages.js";
import { assertNever, getFirstStringField, messageId } from "./utils.js";

export interface AssembleTimelineArgs {
  rows: TimelineSourceRow[];
  events: readonly ThreadEventWithMeta[];
  parentByRow: ReadonlyMap<TimelineSourceRow, string>;
  legacyAssistantIds: ReadonlySet<string>;
  completedTurnDisplay: CompletedTurnDisplay;
  includeNestedRows: boolean;
  turnMessageDetail: "summary" | "full";
}

interface TurnBucket {
  turnId: string;
  threadId: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  startedAt: number;
  createdAt: number;
  completedAt: number | null;
  status: TimelineRowStatus;
  rows: TimelineSourceRow[];
  externalUserBoundarySeqs: number[];
}

// ── Row Classification Helpers ───────────────────────────────────────────────

function isRetryRow(row: TimelineRow): boolean {
  return row.kind === "system" && row.systemKind === "reconnect";
}

function isErrorRow(row: TimelineRow): boolean {
  return row.kind === "system" && row.systemKind === "error";
}

function isTerminalRow(row: TimelineSourceRow): boolean {
  return (
    (row.kind === "conversation" && row.role === "assistant") ||
    (row.kind === "system" && row.systemKind === "error")
  );
}

function isUngroupableRow(
  row: TimelineSourceRow,
  legacyAssistantIds: ReadonlySet<string>,
): boolean {
  if (row.kind === "conversation" && row.role === "user") {
    return !(
      row.turnRequest.kind === "steer" &&
      (row.initiator === "agent" || row.initiator === "system")
    );
  }
  if (row.kind === "conversation" && row.role === "assistant") {
    return legacyAssistantIds.has(row.id);
  }
  return row.kind === "work" && row.workKind === "image-generation";
}

function isAssistantResponse(
  row: TimelineSourceRow | undefined,
  legacyAssistantIds: ReadonlySet<string>,
): boolean {
  return (
    row !== undefined &&
    row.kind === "conversation" &&
    row.role === "assistant" &&
    !legacyAssistantIds.has(row.id)
  );
}

function isSingletonContextMgmt(rows: readonly TimelineSourceRow[]): boolean {
  const only = rows.length === 1 ? rows[0] : undefined;
  return (
    only?.kind === "system" &&
    only.systemKind === "operation" &&
    (only.operationKind === "compaction" ||
      only.operationKind === "context-clear")
  );
}

function findLastTerminalRow(
  rows: readonly TimelineSourceRow[],
): TimelineSourceRow | undefined {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (isTerminalRow(rows[i]!)) return rows[i];
  }
  return undefined;
}

function summaryCountOf(
  rows: readonly TimelineSourceRow[],
  legacyAssistantIds: ReadonlySet<string>,
): number {
  let count = 0;
  for (const row of rows) {
    if (!isUngroupableRow(row, legacyAssistantIds)) count += 1;
  }
  return count;
}

function isErrorOrQuotaReply(row: TimelineRow): boolean {
  return (
    isErrorRow(row) ||
    (row.kind === "conversation" &&
      row.role === "assistant" &&
      isPlanLimitReply(row.text))
  );
}

function appendRow(target: TimelineRow[], row: TimelineRow): void {
  const prev = target[target.length - 1];
  if (prev && isRetryRow(prev) && isRetryRow(row)) {
    target[target.length - 1] = row;
    return;
  }
  if (
    prev &&
    isErrorOrQuotaReply(prev) &&
    row.kind === "system" &&
    row.systemKind === "operation" &&
    row.operationKind === "thread-interrupted" &&
    prev.threadId === row.threadId &&
    prev.createdAt === row.createdAt &&
    prev.startedAt === row.startedAt &&
    prev.sourceSeqEnd + 1 === row.sourceSeqStart
  ) {
    return;
  }
  target.push(row);
}

function appendAll(target: TimelineRow[], rows: readonly TimelineRow[]): void {
  for (const row of rows) appendRow(target, row);
}

// ── Step 1: Delegation Promotion & Nesting ───────────────────────────────────

function nestDelegations(
  rows: TimelineSourceRow[],
  parentByRow: ReadonlyMap<TimelineSourceRow, string>,
): TimelineSourceRow[] {
  const referencedParents = new Set(parentByRow.values());
  const promoted: TimelineSourceRow[] = rows.map((row) => {
    if (
      row.kind === "work" &&
      row.workKind === "tool" &&
      (referencedParents.has(row.callId) ||
        isLegacyDelegationToolCall({
          tool: row.toolName,
          presentation: row.presentation,
        }))
    ) {
      const delegation: TimelineDelegationWorkRow = {
        id: messageId(row.threadId, "delegation", row.callId),
        threadId: row.threadId,
        turnId: row.turnId,
        sourceSeqStart: row.sourceSeqStart,
        sourceSeqEnd: row.sourceSeqEnd,
        startedAt: row.startedAt,
        createdAt: row.createdAt,
        kind: "work",
        workKind: "delegation",
        status: row.status,
        callId: row.callId,
        toolName: row.toolName,
        childRef: null,
        background: false,
        subagentType:
          getFirstStringField(row.toolArgs, ["subagent_type", "subagentType"]) ??
          null,
        description:
          getFirstStringField(row.toolArgs, ["description", "prompt"]) ?? null,
        output: row.output,
        completedAt: row.completedAt,
        childRows: [],
        ...(row.presentation ? { presentation: row.presentation } : {}),
      };
      return delegation;
    }
    return row;
  });

  // Preserve parent mappings for promoted tool rows
  const effectiveParent = new Map<TimelineSourceRow, string>();
  const delegationCallIds = new Set<string>();
  for (let i = 0; i < rows.length; i += 1) {
    const parent = parentByRow.get(rows[i]!);
    if (parent !== undefined) effectiveParent.set(promoted[i]!, parent);
    const p = promoted[i]!;
    if (p.kind === "work" && p.workKind === "delegation") {
      delegationCallIds.add(p.callId);
    }
  }

  const childrenByCallId = new Map<string, TimelineSourceRow[]>();
  const roots: TimelineSourceRow[] = [];

  for (const row of promoted) {
    const parent = effectiveParent.get(row);
    if (parent === undefined) {
      roots.push(row);
    } else if (delegationCallIds.has(parent)) {
      const list = childrenByCallId.get(parent) ?? [];
      list.push(row);
      childrenByCallId.set(parent, list);
    }
    // Rows with a parentToolCallId whose delegation isn't in window are suppressed
  }

  const resolve = (
    row: TimelineSourceRow,
    prefix: string,
    visited: Set<string>,
  ): TimelineSourceRow => {
    const nextId = prefix ? `${prefix}${row.id}` : row.id;
    if (row.kind !== "work" || row.workKind !== "delegation") {
      return prefix ? { ...row, id: nextId } : row;
    }
    if (visited.has(row.callId)) {
      return prefix ? { ...row, id: nextId } : row;
    }
    visited.add(row.callId);

    const rawChildren = childrenByCallId.get(row.callId) ?? [];
    const childPrefix = `${nextId}:child:`;
    const resolvedChildren: TimelineSourceRow[] = [];
    let sourceSeqStart = row.sourceSeqStart;
    let sourceSeqEnd = row.sourceSeqEnd;
    let startedAt = row.startedAt;
    let createdAt = row.createdAt;

    for (const child of rawChildren) {
      const resolved = resolve(child, childPrefix, visited);
      sourceSeqStart = Math.min(sourceSeqStart, resolved.sourceSeqStart);
      sourceSeqEnd = Math.max(sourceSeqEnd, resolved.sourceSeqEnd);
      startedAt = Math.min(startedAt, resolved.startedAt);
      createdAt = Math.max(createdAt, resolved.createdAt);
      resolvedChildren.push(resolved);
    }

    visited.delete(row.callId);

    const visibleChildren: TimelineRow[] = [];
    for (const child of resolvedChildren) {
      if (
        child.kind === "work" &&
        child.workKind === "workflow" &&
        isBackgroundAgentTaskType(child.taskType)
      ) {
        continue;
      }
      appendRow(visibleChildren, child);
    }

    return {
      ...row,
      id: nextId,
      sourceSeqStart,
      sourceSeqEnd,
      startedAt,
      createdAt,
      childRows: visibleChildren,
    };
  };

  const visited = new Set<string>();
  return roots.map((row) => resolve(row, "", visited));
}

// ── Step 2: Turn Grouping & Completed Turn Folding ───────────────────────────

function buildCompletedTurnRows(
  turn: TurnBucket,
  completedTurnDisplay: CompletedTurnDisplay,
  includeNestedRows: boolean,
  turnMessageDetail: "summary" | "full",
  legacyAssistantIds: ReadonlySet<string>,
): TimelineRow[] {
  const rows = turn.rows;
  const terminal = findLastTerminalRow(rows);
  const termIdx = terminal ? rows.indexOf(terminal) : -1;
  const preTerminalRows = terminal ? rows.slice(0, termIdx) : rows;
  const trailingAfterTerminal = terminal ? rows.slice(termIdx + 1) : [];
  const preTerminalSummaryCount = summaryCountOf(
    preTerminalRows,
    legacyAssistantIds,
  );
  const keepRows =
    turnMessageDetail === "full" ||
    turn.externalUserBoundarySeqs.length > 0 ||
    isSingletonContextMgmt(preTerminalRows) ||
    trailingAfterTerminal.length > 0 ||
    preTerminalRows.some(
      (r) =>
        (terminal !== undefined && isTerminalRow(r)) ||
        isUngroupableRow(r, legacyAssistantIds),
    );

  if (completedTurnDisplay === "flat") {
    const firstNonUser = rows.findIndex(
      (r) => !(r.kind === "conversation" && r.role === "user"),
    );
    if (firstNonUser === -1) return [...rows];
    const first = rows[firstNonUser]!;
    const marker: TimelineTurnRow = {
      id: `${turn.threadId}:${turn.turnId}:turn`,
      threadId: turn.threadId,
      turnId: turn.turnId,
      sourceSeqStart: first.sourceSeqStart,
      sourceSeqEnd: turn.sourceSeqEnd,
      startedAt: turn.startedAt,
      createdAt: first.createdAt,
      kind: "turn",
      status: turn.status,
      summaryCount: 0,
      completedAt: turn.completedAt,
      children: null,
    };
    return [...rows.slice(0, firstNonUser), marker, ...rows.slice(firstNonUser)];
  }

  // Collapse mode
  let summaryRows: TimelineSourceRow[];
  let terminalRows: TimelineSourceRow[];
  let trailingRows: TimelineSourceRow[];

  if (!keepRows) {
    summaryRows = [];
    terminalRows = terminal ? [terminal] : [];
    trailingRows = [];
  } else if (!terminal) {
    summaryRows = [...rows];
    terminalRows = [];
    trailingRows = [];
  } else {
    summaryRows = [
      ...preTerminalRows,
      ...trailingAfterTerminal.filter(isRetryRow),
    ];
    terminalRows = [terminal];
    trailingRows = trailingAfterTerminal.filter((r) => !isRetryRow(r));
  }

  // Adjacent assistant responses stay visible (e.g. reply + hook reply).
  const visibleResponseIds = new Set<string>();
  for (let i = 0; i < summaryRows.length; i += 1) {
    const cur = summaryRows[i];
    const next = summaryRows[i + 1] ?? terminalRows[0];
    if (
      isAssistantResponse(cur, legacyAssistantIds) &&
      isAssistantResponse(next, legacyAssistantIds)
    ) {
      visibleResponseIds.add(cur!.id);
    }
  }

  type SummaryItem =
    | {
        kind: "summary";
        startedAt: number;
        completedAt: number | null;
        segmentIndex: number | null;
        rows: TimelineSourceRow[];
        summaryCount: number;
      }
    | { kind: "row"; row: TimelineSourceRow };

  let items: SummaryItem[];
  const boundaries = turn.externalUserBoundarySeqs;

  if (
    boundaries.length === 0 &&
    visibleResponseIds.size === 0 &&
    !summaryRows.some((r) => isUngroupableRow(r, legacyAssistantIds))
  ) {
    items = [
      {
        kind: "summary",
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        segmentIndex: null,
        rows: summaryRows,
        summaryCount: preTerminalSummaryCount,
      },
    ];
  } else {
    items = [];
    let grouped: TimelineSourceRow[] = [];
    let segIdx = 0;
    let boundaryIdx = 0;

    const pushSummary = (groupRows: TimelineSourceRow[]) => {
      if (groupRows.length === 0) return;
      let startedAt = groupRows[0]!.startedAt;
      for (let i = 1; i < groupRows.length; i += 1) {
        startedAt = Math.min(startedAt, groupRows[i]!.startedAt);
      }
      items.push({
        kind: "summary",
        startedAt,
        completedAt: null,
        segmentIndex: segIdx++,
        rows: groupRows,
        summaryCount: summaryCountOf(groupRows, legacyAssistantIds),
      });
    };

    const flush = (preserveLastTerminal = false) => {
      if (grouped.length === 0) return;
      const chunk = grouped;
      grouped = [];
      const lastTerm = preserveLastTerminal
        ? findLastTerminalRow(chunk)
        : undefined;
      if (!lastTerm) {
        pushSummary(chunk);
        return;
      }
      pushSummary(chunk.filter((r) => r.id !== lastTerm.id));
      items.push({ kind: "row", row: lastTerm });
    };

    for (const row of summaryRows) {
      while (
        boundaryIdx < boundaries.length &&
        boundaries[boundaryIdx]! < row.sourceSeqStart
      ) {
        flush(true);
        boundaryIdx += 1;
      }
      if (visibleResponseIds.has(row.id)) {
        flush(false);
        items.push({ kind: "row", row });
      } else if (isUngroupableRow(row, legacyAssistantIds)) {
        flush(
          row.kind === "conversation" &&
            row.role === "user" &&
            row.initiator === "user",
        );
        items.push({ kind: "row", row });
      } else {
        grouped.push(row);
      }
    }
    while (boundaryIdx < boundaries.length) {
      flush(true);
      boundaryIdx += 1;
    }
    flush(false);

    // If only one summary group remains, give it the whole turn's time bounds.
    const summaryGroups = items.filter((i) => i.kind === "summary");
    if (summaryGroups.length === 1) {
      summaryGroups[0]!.startedAt = turn.startedAt;
      summaryGroups[0]!.completedAt = turn.completedAt;
    }
  }

  // Unwrap singleton compaction / context-clear groups.
  const out: TimelineRow[] = [];
  for (const item of items) {
    if (item.kind === "row") {
      out.push(item.row);
      continue;
    }
    if (isSingletonContextMgmt(item.rows)) {
      out.push(item.rows[0]!);
      continue;
    }
    const nested = includeNestedRows ? item.rows : [];
    if (item.summaryCount === 0 && nested.length === 0) continue;

    let sourceSeqStart = turn.sourceSeqStart;
    let sourceSeqEnd = turn.sourceSeqEnd;
    let createdAt = turn.createdAt;
    let completedAt = item.completedAt;

    if (item.segmentIndex !== null && item.rows.length > 0) {
      sourceSeqStart = item.rows[0]!.sourceSeqStart;
      sourceSeqEnd = item.rows[0]!.sourceSeqEnd;
      createdAt = item.rows[0]!.createdAt;
      let maxCreated = item.rows[0]!.createdAt;
      for (let i = 1; i < item.rows.length; i += 1) {
        const r = item.rows[i]!;
        sourceSeqStart = Math.min(sourceSeqStart, r.sourceSeqStart);
        sourceSeqEnd = Math.max(sourceSeqEnd, r.sourceSeqEnd);
        createdAt = Math.min(createdAt, r.createdAt);
        maxCreated = Math.max(maxCreated, r.createdAt);
      }
      if (completedAt === null) completedAt = maxCreated;
    } else if (completedAt === null && item.rows.length > 0) {
      completedAt = Math.max(...item.rows.map((r) => r.createdAt));
    }

    out.push({
      id:
        item.segmentIndex === null
          ? `${turn.threadId}:${turn.turnId}:turn`
          : `${turn.threadId}:${turn.turnId}:turn:${item.segmentIndex}`,
      threadId: turn.threadId,
      turnId: turn.turnId,
      sourceSeqStart,
      sourceSeqEnd,
      startedAt: item.startedAt,
      createdAt,
      kind: "turn",
      status: turn.status,
      summaryCount: item.summaryCount,
      completedAt,
      children: includeNestedRows ? nested : null,
    });
  }

  return [...out, ...terminalRows, ...trailingRows];
}

// ── Step 3: Plan-Limit & Refusal Switch Marking ──────────────────────────────

const isPlanLimitRow = (row: TimelineRow | undefined): boolean =>
  row?.kind === "system" &&
  row.systemKind === "error" &&
  (row.planLimit === true || row.refusal === true);

const isAuthFailureRow = (row: TimelineRow | undefined): boolean =>
  row?.kind === "system" &&
  row.systemKind === "error" &&
  row.title === PROVIDER_AUTH_FAILED_TITLE;

function convertPlanLimitReplies(rows: TimelineRow[]): TimelineRow[] {
  let changed = false;
  const next = rows.map((row): TimelineRow => {
    if (
      row.kind === "conversation" &&
      row.role === "assistant" &&
      isPlanLimitReply(row.text)
    ) {
      changed = true;
      return {
        id: row.id,
        threadId: row.threadId,
        turnId: row.turnId,
        sourceSeqStart: row.sourceSeqStart,
        sourceSeqEnd: row.sourceSeqEnd,
        startedAt: row.startedAt,
        createdAt: row.createdAt,
        kind: "system",
        systemKind: "error",
        title: "Plan limit reached",
        detail: row.text.replace(/^\s*⚠?\s*/u, "").trim(),
        status: "error",
        planLimit: true,
      };
    }
    if (row.kind === "turn" && row.children) {
      const children = convertPlanLimitReplies(row.children);
      if (children !== row.children) {
        changed = true;
        return { ...row, children };
      }
    } else if (
      row.kind === "work" &&
      row.workKind === "delegation" &&
      row.childRows.length > 0
    ) {
      const childRows = convertPlanLimitReplies(row.childRows);
      if (childRows !== row.childRows) {
        changed = true;
        return { ...row, childRows };
      }
    }
    return row;
  });
  return changed ? next : rows;
}

function collectEchoDropRowIds(rows: readonly TimelineRow[]): string[] {
  const ids: string[] = [];
  const walk = (list: readonly TimelineRow[]) => {
    for (const row of list) {
      if (isAuthFailureRow(row) || isPlanLimitRow(row)) ids.push(row.id);
      if (row.kind === "turn" && row.children) walk(row.children);
    }
  };
  walk(rows);
  return ids;
}

function matchesErrorEcho(replyText: string, error: TimelineRow): boolean {
  if (error.kind !== "system") return false;
  const text = replyText.trim();
  if (text === "") return false;
  const title = error.title.trim();
  const detail = error.detail?.trim() ?? "";
  if (text === title || text === detail) return true;
  const saidIdx = detail.indexOf(" said: ");
  return (
    saidIdx !== -1 &&
    detail.slice(saidIdx + " said: ".length).trim() === text
  );
}

function collectCompletedTurnIds(
  events: readonly ThreadEventWithMeta[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const { event } of events) {
    if (event.type === "turn/completed" && event.status === "completed") {
      ids.add(
        requireThreadEventScopeTurnId({
          type: event.type,
          scope: event.scope,
        }),
      );
    }
  }
  return ids;
}

function dropErrorEchoes(
  rows: TimelineRow[],
  targetIds: ReadonlySet<string>,
  completedTurnIds: ReadonlySet<string>,
): TimelineRow[] {
  const gone = new Set<string>();
  const isEcho = (candidate: TimelineRow | undefined, error: TimelineRow) =>
    candidate?.kind === "conversation" &&
    candidate.role === "assistant" &&
    (candidate.turnId === null || !completedTurnIds.has(candidate.turnId)) &&
    (error.turnId === null || candidate.turnId === error.turnId) &&
    matchesErrorEcho(candidate.text, error);

  const scan = (list: readonly TimelineRow[]) => {
    for (let i = 0; i < list.length; i += 1) {
      const r = list[i]!;
      if (r.kind === "turn" && r.children) scan(r.children);
      if (!targetIds.has(r.id)) continue;

      const prev = list[i - 1];
      if (prev && isEcho(prev, r)) gone.add(prev.id);
      const nested = prev?.kind === "turn" ? prev.children?.at(-1) : undefined;
      if (nested && isEcho(nested, r)) gone.add(nested.id);

      // Cloud system/error rows carry turnId = null; recover the turn from the echoed reply right before it.
      const turnId =
        r.turnId ?? (prev && gone.has(prev.id) ? prev.turnId : null);
      const turn = turnId
        ? list.find((o) => o.kind === "turn" && o.turnId === turnId)
        : undefined;
      if (
        turn?.kind === "turn" &&
        turnId &&
        (turn.children === null
          ? turn.summaryCount === 0
          : turn.children.every((c) => gone.has(c.id))) &&
        list.every(
          (o) =>
            o.turnId !== turnId ||
            o === turn ||
            o === r ||
            gone.has(o.id) ||
            (o.kind === "conversation" && o.role === "user"),
        )
      ) {
        gone.add(turn.id);
      }
    }
  };
  scan(rows);
  if (gone.size === 0) return rows;

  const drop = (list: TimelineRow[]): TimelineRow[] =>
    list.flatMap((r): TimelineRow[] => {
      if (gone.has(r.id)) return [];
      if (r.kind !== "turn" || !r.children) return [r];
      const children = drop(r.children);
      const only = children.length === 1 ? children[0] : undefined;
      return only && targetIds.has(only.id) ? [only] : [{ ...r, children }];
    });
  return drop(rows);
}

function markPlanLimitSwitches(
  rows: TimelineRow[],
  events: readonly ThreadEventWithMeta[],
): TimelineRow[] {
  const completedTurnIds = collectCompletedTurnIds(events);
  const switches = events.filter(
    ({ event }) =>
      event.type === "system/operation" &&
      (event.operation === THREAD_HARNESS_SWITCH_OPERATION ||
        event.operation === THREAD_ACCOUNT_SWITCH_OPERATION),
  );
  if (switches.length === 0) {
    const echoIds = collectEchoDropRowIds(rows);
    return echoIds.length === 0
      ? rows
      : dropErrorEchoes(rows, new Set(echoIds), completedTurnIds);
  }

  const flat: TimelineRow[] = [];
  const walk = (list: readonly TimelineRow[]) => {
    for (const r of list) {
      flat.push(r);
      if (r.kind === "turn" && r.children) walk(r.children);
    }
  };
  walk(rows);

  const marks = new Map<
    string,
    NonNullable<TimelineNonOperationSystemRow["planLimitSwitch"]>
  >();
  const accountMarks = new Map<
    string,
    NonNullable<TimelineNonOperationSystemRow["planLimitAccountSwitch"]>
  >();

  for (const { event, meta } of switches) {
    if (event.type !== "system/operation") continue;
    const { from, to, resend, provider } = event.metadata ?? {};
    if (typeof from !== "string" || typeof to !== "string") continue;

    if (event.operation === THREAD_ACCOUNT_SWITCH_OPERATION) {
      if (typeof provider !== "string") continue;
      let limit: TimelineRow | undefined;
      for (const r of flat) {
        if (
          r.sourceSeqEnd < meta.seq &&
          isPlanLimitRow(r) &&
          (!limit || r.sourceSeqEnd >= limit.sourceSeqEnd)
        ) {
          limit = r;
        }
      }
      if (limit) {
        accountMarks.set(limit.id, {
          provider,
          from: accountMarks.get(limit.id)?.from ?? from,
          to,
        });
      }
      continue;
    }

    if (from === to) continue;
    let before: TimelineRow | undefined;
    for (const r of flat) {
      if (r.sourceSeqEnd >= meta.seq) continue;
      if (
        r.kind === "turn" &&
        flat.some(
          (other) =>
            other.kind !== "turn" &&
            other.turnId === r.turnId &&
            other.sourceSeqEnd < meta.seq,
        )
      ) {
        continue;
      }
      if (
        !before ||
        r.sourceSeqEnd > before.sourceSeqEnd ||
        (r.sourceSeqEnd === before.sourceSeqEnd && r.kind !== "turn")
      ) {
        before = r;
      }
    }
    if (!before || !isPlanLimitRow(before)) continue;
    const first = marks.get(before.id)?.from ?? from;
    if (first === to) {
      marks.delete(before.id);
    } else {
      marks.set(before.id, {
        from: first,
        to,
        resend: resend === true,
        at: meta.createdAt,
      });
    }
  }

  if (marks.size === 0 && accountMarks.size === 0) {
    const echoIds = collectEchoDropRowIds(rows);
    return echoIds.length === 0
      ? rows
      : dropErrorEchoes(rows, new Set(echoIds), completedTurnIds);
  }

  const applyMarks = (list: TimelineRow[]): TimelineRow[] =>
    list.map((r) => {
      if (r.kind === "turn") {
        return r.children ? { ...r, children: applyMarks(r.children) } : r;
      }
      if (r.kind !== "system" || r.systemKind !== "error") return r;
      const harness = marks.get(r.id);
      const account = accountMarks.get(r.id);
      if (!harness && !account) return r;
      return {
        ...r,
        ...(harness ? { planLimitSwitch: harness } : {}),
        ...(account ? { planLimitAccountSwitch: account } : {}),
      };
    });

  const marked = applyMarks(rows);
  return dropErrorEchoes(
    marked,
    new Set([
      ...marks.keys(),
      ...accountMarks.keys(),
      ...collectEchoDropRowIds(marked),
    ]),
    completedTurnIds,
  );
}

// ── Main Assembly Pipeline ───────────────────────────────────────────────────

export function assembleTimelineRows(
  args: AssembleTimelineArgs,
  applyPlanLimitSwitches: boolean,
): TimelineRow[] {
  const rootRows = nestDelegations(args.rows, args.parentByRow);

  const clientReqMeta = new Map<string, EventMeta>();
  const turnsById = new Map<string, TurnBucket>();
  const drafts: (
    | { kind: "turn"; turnId: string; sourceSeqStart: number; createdAt: number }
    | { kind: "row"; row: TimelineSourceRow; sourceSeqStart: number; createdAt: number }
  )[] = [];

  for (const { event, meta } of args.events) {
    if (event.type === "client/turn/requested") {
      clientReqMeta.set(event.requestId, meta);
    }
  }

  for (const { event, meta } of args.events) {
    if (event.type === "turn/started") {
      const turnId = requireThreadEventScopeTurnId({
        type: event.type,
        scope: event.scope,
      });
      if (turnsById.has(turnId)) continue;
      turnsById.set(turnId, {
        turnId,
        threadId: event.threadId,
        sourceSeqStart: meta.seq,
        sourceSeqEnd: meta.seq,
        startedAt: meta.createdAt,
        createdAt: meta.createdAt,
        completedAt: null,
        status: "pending",
        rows: [],
        externalUserBoundarySeqs: [],
      });
      drafts.push({
        kind: "turn",
        turnId,
        sourceSeqStart: meta.seq,
        createdAt: meta.createdAt,
      });
    } else if (event.type === "turn/completed") {
      const turnId = requireThreadEventScopeTurnId({
        type: event.type,
        scope: event.scope,
      });
      const turn = turnsById.get(turnId);
      if (!turn) {
        throw new Error(
          `Timeline projection found turn/completed without turn/started for ${turnId}`,
        );
      }
      turn.threadId = event.threadId;
      turn.sourceSeqStart = Math.min(turn.sourceSeqStart, meta.seq);
      turn.sourceSeqEnd = Math.max(turn.sourceSeqEnd, meta.seq);
      turn.createdAt = Math.max(turn.createdAt, meta.createdAt);
      turn.completedAt = meta.createdAt;
      turn.status =
        event.status === "completed"
          ? "completed"
          : event.status === "failed"
            ? "error"
            : event.status === "interrupted"
              ? "interrupted"
              : assertNever(event.status);
    } else if (event.type === "turn/input/accepted") {
      const turnId = requireThreadEventScopeTurnId({
        type: event.type,
        scope: event.scope,
      });
      const turn = turnsById.get(turnId);
      if (!turn) {
        throw new Error(
          `Timeline projection found turn/input/accepted without turn/started for ${turnId}`,
        );
      }
      const reqMeta = clientReqMeta.get(event.clientRequestId);
      if (reqMeta) {
        turn.threadId = event.threadId;
        turn.sourceSeqStart = Math.min(turn.sourceSeqStart, reqMeta.seq);
        turn.sourceSeqEnd = Math.max(turn.sourceSeqEnd, reqMeta.seq);
        turn.createdAt = Math.max(turn.createdAt, reqMeta.createdAt);
      }
    }
  }

  for (const row of rootRows) {
    if (row.turnId === null) {
      drafts.push({
        kind: "row",
        row,
        sourceSeqStart: row.sourceSeqStart,
        createdAt: row.createdAt,
      });
      continue;
    }
    const turn = turnsById.get(row.turnId);
    if (!turn) {
      throw new Error(
        `Timeline projection found message ${row.id} for turn ${row.turnId} without turn/started`,
      );
    }
    turn.rows.push(row);
  }
  // Turn bounds come from each turn's own flat rows (before delegation nesting),
  // so async delegated children from later turns do not stretch the parent turn
  // and non-delegation child rows still contribute to their turn's timestamps.
  for (const row of args.rows) {
    if (row.turnId === null) continue;
    const turn = turnsById.get(row.turnId);
    if (!turn) continue;
    turn.threadId = row.threadId;
    turn.sourceSeqStart = Math.min(turn.sourceSeqStart, row.sourceSeqStart);
    turn.sourceSeqEnd = Math.max(turn.sourceSeqEnd, row.sourceSeqEnd);
    turn.createdAt = Math.max(turn.createdAt, row.createdAt);
  }

  // Compute external human-user boundaries per turn.
  const humanUserRows = rootRows.filter(
    (r) => r.kind === "conversation" && r.role === "user" && r.initiator === "user",
  );
  let earliestExternalBoundary: number | undefined;
  if (humanUserRows.length > 0) {
    for (const [turnId, turn] of turnsById) {
      const seqs = new Set<number>();
      for (const u of humanUserRows) {
        if (
          u.sourceSeqStart > turn.sourceSeqStart &&
          u.sourceSeqStart < turn.sourceSeqEnd &&
          u.turnId !== turnId
        ) {
          seqs.add(u.sourceSeqStart);
        }
      }
      if (seqs.size > 0) {
        turn.externalUserBoundarySeqs = [...seqs].sort((a, b) => a - b);
        const first = turn.externalUserBoundarySeqs[0]!;
        if (
          earliestExternalBoundary === undefined ||
          first < earliestExternalBoundary
        ) {
          earliestExternalBoundary = first;
        }
      }
    }
  }

  drafts.sort(
    (a, b) => a.sourceSeqStart - b.sourceSeqStart || a.createdAt - b.createdAt,
  );

  const built: TimelineRow[] = [];
  for (const draft of drafts) {
    if (draft.kind === "row") {
      appendRow(built, draft.row);
      continue;
    }
    const turn = turnsById.get(draft.turnId)!;
    if (turn.status !== "pending" && turn.completedAt !== null) {
      appendAll(
        built,
        buildCompletedTurnRows(
          turn,
          args.completedTurnDisplay,
          args.includeNestedRows,
          args.turnMessageDetail,
          args.legacyAssistantIds,
        ),
      );
    } else {
      appendAll(built, turn.rows);
    }
  }

  // Re-order suffix after earliest external human boundary by source sequence.
  let ordered = built;
  if (earliestExternalBoundary !== undefined) {
    const startIdx = built.findIndex(
      (r) => r.sourceSeqStart >= earliestExternalBoundary!,
    );
    if (startIdx !== -1) {
      const suffix = built
        .slice(startIdx)
        .map((row, idx) => ({ row, idx }))
        .sort(
          (a, b) =>
            a.row.sourceSeqStart - b.row.sourceSeqStart ||
            a.row.sourceSeqEnd - b.row.sourceSeqEnd ||
            a.idx - b.idx,
        )
        .map((e) => e.row);
      ordered = [...built.slice(0, startIdx), ...suffix];
    }
  }

  const converted = convertPlanLimitReplies(ordered);
  return applyPlanLimitSwitches
    ? markPlanLimitSwitches(converted, args.events)
    : converted;
}
