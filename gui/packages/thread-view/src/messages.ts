import {
  THREAD_ACCOUNT_SWITCH_OPERATION,
  THREAD_CONTEXT_CLEAR_OPERATION,
  THREAD_HARNESS_SWITCH_OPERATION,
  THREAD_IMPORT_OPERATION,
  THREAD_MODEL_SELECTION_OPERATION,
  THREAD_TELEPORT_LOCAL_OPERATION,
  diagnosticShellEnvValue,
  isApprovalInteractionLifecycle,
  isUserQuestionInteractionLifecycle,
  ownershipChangeOperationMetadataSchema,
  readTerminalOutputLines,
  resolveSystemErrorReconnectProgress,
  type ApprovalInteractionLifecycle,
  type OwnershipChangeOperationMetadata,
  type PromptInput,
  type ProviderErrorCategory,
  type ProviderUnhandledEvent,
  type ProvisioningTranscriptEntry,
  type SystemThreadInterruptedEventData,
  type SystemThreadInterruptedReason,
  type SystemThreadProvisioningStatus,
  type Thread,
  type ThreadEvent,
  type UserQuestionInteractionLifecycle,
} from "@cloudroom/domain";
import type {
  TimelineApprovalWorkRow,
  TimelineConversationAttachments,
  TimelineConversationRow,
  TimelineConversationTurnRequest,
  TimelineNonOperationSystemRow,
  TimelineParentChange,
  TimelineQuestionWorkRow,
  TimelineRowStatus,
  TimelineSystemRow,
  TimelineUserConversationRow,
} from "@cloudroom/server-contract";

type TimelineAssistantConversationRow = Extract<
  TimelineConversationRow,
  { role: "assistant" }
>;
import {
  getEventTurnId,
  parsePromptInput,
  type AcceptedClientRequest,
  type EventMeta,
  type ParsedPromptInput,
} from "./events.js";
import { getProviderModelFallbackData } from "./extractors.js";
import {
  assertNever,
  capitalize,
  durationToCompactString,
  messageId,
  OWNERSHIP_CHANGE_VERBS,
  parseAgentMessageEnvelope,
} from "./utils.js";

export const PROVIDER_AUTH_FAILED_TITLE = "Provider authorization failed";
export const MAX_ERROR_TITLE_LENGTH = 80;

/** Antigravity's CLI reports its quota as a plain reply ("⚠ Individual quota reached. … Resets in 24m24s."), not an error. */
export function isPlanLimitReply(text: string): boolean {
  return /^\s*⚠?\s*Individual quota reached\b/u.test(text);
}

const CORE_PLAN_LIMIT = "plan limit (not Cloudroom's).";
/** Claude/Codex plan-limit text when an older Core or saved history missed the wrapper ("You've hit your Fable limit · resets …"). */
const PROVIDER_PLAN_LIMIT_RE =
  /\bYou['’]ve (?:hit|reached) your (?:\S+\s+){0,4}limit\b/iu;
const CODEX_POLICY_CODES = new Set([
  "cyberPolicy",
  "misalignmentPolicyViolation",
]);
const RECONNECT_LINE_RE = /^Reconnecting\.\.\.\s+\d+\/\d+$/u;
const HIDDEN_OPERATIONS = new Set<string>([
  "plugin_interaction",
  "edit_message",
  "checkpoint",
  THREAD_MODEL_SELECTION_OPERATION,
  THREAD_HARNESS_SWITCH_OPERATION,
  THREAD_ACCOUNT_SWITCH_OPERATION,
  THREAD_IMPORT_OPERATION,
  THREAD_TELEPORT_LOCAL_OPERATION,
  "storage_warning",
  "storage_pause",
  "storage_recovered",
]);

const ERROR_CATEGORY_TITLES: Record<ProviderErrorCategory, string> = {
  "active-turn-not-steerable": "Turn is not steerable",
  "bad-request": "Provider rejected request",
  billing: "Provider billing issue",
  "budget-exceeded": "Provider budget exceeded",
  "connection-failed": "Provider connection failed",
  "context-window-exceeded": "Context window exceeded",
  internal: "Provider internal error",
  "max-output-tokens": "Provider output token limit reached",
  "max-turns": "Maximum turns reached",
  overloaded: "Provider overloaded",
  policy: "Provider policy blocked request",
  "rate-limit": "Provider rate limit reached",
  sandbox: "Provider sandbox error",
  "stream-disconnected": "Provider stream disconnected",
  "structured-output-retries": "Structured output retries exhausted",
  "thread-rollback-failed": "Thread rollback failed",
  "too-many-failed-attempts": "Provider failed after too many attempts",
  unauthorized: PROVIDER_AUTH_FAILED_TITLE,
  unknown: "Provider error",
};

const HUMANIZED_TOKENS: Record<string, string> = {
  api: "API",
  chatgpt: "ChatGPT",
  id: "ID",
  mcp: "MCP",
  oauth: "OAuth",
  sdk: "SDK",
  ui: "UI",
  url: "URL",
};

export type ClientTurnRequestedEvent = Extract<
  ThreadEvent,
  { type: "client/turn/requested" }
>;

export function shouldPreservePendingMessages(
  threadStatus: Thread["status"] | undefined,
): boolean {
  return (
    threadStatus === "starting" ||
    threadStatus === "active" ||
    threadStatus === "pending"
  );
}

export function expectedSteerTurnId(
  event: ClientTurnRequestedEvent,
): string | null {
  return event.target.kind === "auto" || event.target.kind === "steer"
    ? event.target.expectedTurnId
    : null;
}

export function resolveTurnRequestKind(
  event: ClientTurnRequestedEvent,
  accepted: AcceptedClientRequest | undefined,
): "message" | "steer" {
  const expected = expectedSteerTurnId(event);
  if (expected === null) return "message";
  if (accepted !== undefined && accepted.turnId !== expected) return "message";
  return "steer";
}

function toAttachments(parsed: ParsedPromptInput): TimelineConversationAttachments {
  return {
    webImages: parsed.webImages,
    localImages: parsed.localImages,
    localFiles: parsed.localFiles,
    imageUrls: parsed.imageUrls,
    localImagePaths: parsed.localImagePaths,
    localFilePaths: parsed.localFilePaths,
  };
}

function buildClientUserRow(
  event: ClientTurnRequestedEvent,
  meta: EventMeta,
  input: ReadonlyArray<PromptInput>,
  requestStatus: TimelineConversationTurnRequest["status"],
  accepted: AcceptedClientRequest | undefined,
  visibleIndex: number,
): TimelineUserConversationRow | null {
  const parsed = parsePromptInput(input);
  if (!parsed) return null;

  const kind = resolveTurnRequestKind(event, accepted);
  const turnId =
    event.target.kind === "thread-start"
      ? null
      : (accepted?.turnId ??
          ("expectedTurnId" in event.target ? event.target.expectedTurnId : null));
  const rowMeta = accepted && kind === "steer" ? accepted.meta : meta;
  const envelope = parseAgentMessageEnvelope(parsed.text);
  const initiator =
    event.initiator === "user" && envelope !== null ? "agent" : event.initiator;
  const senderThreadId =
    event.senderThreadId ??
    (initiator === "agent" ? (envelope?.senderThreadId ?? null) : null);

  return {
    id: messageId(
      event.threadId,
      "user-seed",
      visibleIndex > 0 ? `${meta.seq}-${visibleIndex}` : `${meta.seq}`,
    ),
    threadId: event.threadId,
    turnId,
    sourceSeqStart: rowMeta.seq,
    sourceSeqEnd: rowMeta.seq,
    startedAt: rowMeta.createdAt,
    createdAt: rowMeta.createdAt,
    kind: "conversation",
    role: "user",
    text: parsed.text,
    mentions: parsed.mentions,
    attachments: toAttachments(parsed),
    initiator,
    senderThreadId,
    systemMessageKind: event.systemMessageKind ?? "unlabeled",
    systemMessageSubject: event.systemMessageSubject ?? null,
    turnRequest: {
      isGrouped: event.inputGroups !== undefined,
      kind,
      status: requestStatus,
    },
  };
}

export function buildClientUserRows(
  event: ClientTurnRequestedEvent,
  meta: EventMeta,
  requestStatus: TimelineConversationTurnRequest["status"],
  accepted: AcceptedClientRequest | undefined,
  threadStatus: Thread["status"] | undefined,
): TimelineUserConversationRow[] {
  if (!threadStatus) return [];
  const groups = event.inputGroups ?? [event.input];
  const rows: TimelineUserConversationRow[] = [];
  for (const input of groups) {
    const row = buildClientUserRow(
      event,
      meta,
      input,
      requestStatus,
      accepted,
      rows.length,
    );
    if (row) rows.push(row);
  }
  return rows;
}

export function buildProviderUserRow(
  event: ThreadEvent,
  meta: EventMeta,
): { row: TimelineUserConversationRow; parentToolCallId?: string } | null {
  if (event.type !== "item/completed" || event.item.type !== "userMessage") {
    return null;
  }
  const text = event.item.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
  if (text.length === 0) return null;

  return {
    row: {
      id: messageId(event.threadId, "provider-input", event.item.id),
      threadId: event.threadId,
      turnId: getEventTurnId(event) ?? null,
      sourceSeqStart: meta.seq,
      sourceSeqEnd: meta.seq,
      startedAt: meta.createdAt,
      createdAt: meta.createdAt,
      kind: "conversation",
      role: "user",
      text,
      mentions: [],
      attachments: null,
      initiator: "system",
      senderThreadId: null,
      systemMessageKind: "unlabeled",
      systemMessageSubject: null,
      turnRequest: { isGrouped: false, kind: "steer", status: "accepted" },
    },
    ...(event.item.parentToolCallId
      ? { parentToolCallId: event.item.parentToolCallId }
      : {}),
  };
}

export function buildLegacyUserRow(
  event: ThreadEvent,
  meta: EventMeta,
): TimelineAssistantConversationRow | null {
  if (event.type !== "system/manager/user_message" || !event.text) return null;
  return {
    id: messageId(event.threadId, "assistant", `legacy:${meta.seq}`),
    threadId: event.threadId,
    turnId: getEventTurnId(event) ?? null,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    startedAt: meta.createdAt,
    createdAt: meta.createdAt,
    kind: "conversation",
    role: "assistant",
    text: event.text,
    attachments: null,
    turnRequest: null,
  };
}

function detailBeyondTitle(detail: string | null, title: string): string | null {
  return detail === null || detail.trim() === title.trim() ? null : detail;
}

export function buildErrorRow(
  event: ThreadEvent,
  meta: EventMeta,
): TimelineNonOperationSystemRow | null {
  if (event.type !== "provider/error" && event.type !== "system/error") {
    return null;
  }

  const rawMessage = event.message || "Error event";
  const rawDetail =
    event.detail && event.detail !== event.message ? event.detail : null;
  const providerErrorInfo =
    event.type === "provider/error"
      ? event.errorInfo
      : CODEX_POLICY_CODES.has(event.code ?? "")
        ? {
            category: "policy" as const,
            providerCode: event.code ?? null,
            httpStatusCode: null,
          }
        : undefined;
  const reconnectState =
    event.type === "system/error"
      ? resolveSystemErrorReconnectProgress(event)
      : null;
  const isReconnect =
    reconnectState !== null ||
    (event.type === "provider/error" && event.willRetry === true) ||
    (event.type === "system/error" && event.code === "provider_reconnect");

  let title: string;
  let detail: string | null;

  if (reconnectState !== null) {
    title = `Reconnecting... ${reconnectState.attempt}/${reconnectState.total}`;
    const trimmed = rawDetail?.trim() ?? "";
    detail = trimmed.length > 0 ? trimmed : null;
  } else {
    const firstNl = rawDetail?.indexOf("\n") ?? -1;
    const firstLine =
      rawDetail === null
        ? null
        : (firstNl === -1 ? rawDetail : rawDetail.slice(0, firstNl)).trim();
    if (firstLine && RECONNECT_LINE_RE.test(firstLine)) {
      title = firstLine;
      const rest = firstNl === -1 ? "" : rawDetail!.slice(firstNl + 1).trim();
      detail = rest.length > 0 ? rest : null;
    } else {
      if (
        event.type === "provider/error" &&
        providerErrorInfo &&
        providerErrorInfo.category !== "unknown"
      ) {
        title = ERROR_CATEGORY_TITLES[providerErrorInfo.category];
        detail = detailBeyondTitle(rawDetail, title);
      } else if (event.type === "provider/error") {
        title = rawDetail ?? rawMessage;
        detail = null;
      } else {
        title = rawMessage;
        detail = detailBeyondTitle(rawDetail, rawMessage);
      }
      if (title.length > MAX_ERROR_TITLE_LENGTH) {
        detail = detail === null ? title : `${title}\n\n${detail}`;
        title = event.type === "provider/error" ? "Provider error" : "System error";
      }
    }
  }

  const combinedText = `${rawMessage}\n${rawDetail ?? ""}`;
  const planLimit =
    !isReconnect &&
    (providerErrorInfo?.category === "rate-limit" ||
      combinedText.includes(CORE_PLAN_LIMIT) ||
      // The wording fallback is only for unclassified errors: an overload saying "requests per minute limit" is no plan limit.
      ((!providerErrorInfo || providerErrorInfo.category === "unknown") &&
        PROVIDER_PLAN_LIMIT_RE.test(combinedText)));
  const refusal = !isReconnect && providerErrorInfo?.category === "policy";

  return {
    id: messageId(event.threadId, "error", `${meta.seq}`),
    threadId: event.threadId,
    turnId: getEventTurnId(event) ?? null,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    startedAt: meta.createdAt,
    createdAt: meta.createdAt,
    kind: "system",
    systemKind: isReconnect ? "reconnect" : "error",
    title,
    detail,
    status: isReconnect ? null : "error",
    ...(planLimit ? { planLimit: true } : {}),
    ...(refusal ? { refusal: true } : {}),
  };
}

export interface ProvisioningEntry {
  type: "step" | "output";
  key: string;
  text: string;
  startedAt?: number;
  status?: "started" | "completed" | "failed";
  metadata?: Record<string, unknown>;
}

export interface ProvisioningState {
  environmentId?: string;
  provisioningId: string;
  transcript: ProvisioningEntry[];
  rawDetails: string[];
}

export function provisioningTitleForStatus(
  status: TimelineRowStatus | null,
): string {
  switch (status) {
    case "completed":
      return "Provisioned thread";
    case "error":
      return "Provisioning thread failed";
    case "interrupted":
      return "Provisioning thread interrupted";
    case "pending":
    case null:
      return "Provisioning thread";
  }
}

export function readProvisioningEntries(
  entries: ProvisioningTranscriptEntry[] | undefined,
): ProvisioningEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const out: ProvisioningEntry[] = [];
  for (const entry of entries) {
    const key = entry.key.trim();
    const text = entry.text.trim();
    if (!key || !text) continue;
    if (entry.type === "step") {
      out.push({
        type: "step",
        key,
        text,
        status: entry.status ?? "started",
        ...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
        ...(entry.metadata ? { metadata: entry.metadata } : {}),
      });
    } else if (entry.type === "output") {
      out.push({
        type: "output",
        key,
        text,
        ...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
        ...(entry.metadata ? { metadata: entry.metadata } : {}),
      });
    }
  }
  return out;
}

export function mergeProvisioningState(
  existing: ProvisioningState,
  incoming: ProvisioningState,
): void {
  if (incoming.environmentId !== undefined) {
    existing.environmentId = incoming.environmentId;
  }
  for (const entry of incoming.transcript) {
    const idx =
      entry.type === "step"
        ? existing.transcript.findIndex(
            (c) => c.type === "step" && c.key === entry.key,
          )
        : -1;
    if (idx === -1) existing.transcript.push({ ...entry });
    else existing.transcript[idx] = { ...entry };
  }
  for (const d of incoming.rawDetails) {
    if (!existing.rawDetails.includes(d)) existing.rawDetails.push(d);
  }
}

export function formatProvisioningDetail(
  row: Extract<TimelineSystemRow, { systemKind: "operation" }>,
  state: ProvisioningState,
): string | null {
  const lines: string[] = [];
  for (const entry of state.transcript) {
    const durationMs =
      typeof entry.metadata?.durationMs === "number"
        ? entry.metadata.durationMs
        : null;
    const text =
      durationMs !== null &&
      (entry.status === "completed" || entry.status === "failed")
        ? `${entry.text} (${durationToCompactString(durationMs)})`
        : entry.text;
    lines.push(...readTerminalOutputLines(text));
  }

  const endedAt = row.completedAt ?? row.createdAt;
  if (row.status !== "pending" && row.status !== null && endedAt >= row.startedAt) {
    const elapsed = endedAt - row.startedAt;
    if (elapsed > 1_000) {
      lines.push(
        `${provisioningTitleForStatus(row.status)} (${durationToCompactString(elapsed)})`,
      );
    }
  }

  for (const raw of state.rawDetails) {
    for (const part of raw.split(/\n|•/u)) {
      const trimmed = part.trim();
      if (trimmed && !lines.includes(trimmed)) lines.push(trimmed);
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

const formatGb = (bytes: number, round: (n: number) => number = Math.round) =>
  `${round((bytes / 2 ** 30) * 10) / 10} GB`;

function threadInterruptedTitle(
  reason: SystemThreadInterruptedReason,
  cause?: "host-connection-lost",
  memory?: SystemThreadInterruptedEventData["memory"],
): string {
  if (cause === "host-connection-lost") {
    return "Stopped — connection to host was lost";
  }
  switch (reason) {
    case "manual-stop":
      return "Stopped manually";
    case "host-daemon-restarted":
      return "Stopped — host daemon restarted";
    case "provider-turn-idle":
      return "Stopped — provider turn stopped responding";
    case "memory-limit":
      return memory
        ? `Stopped — used ${formatGb(memory.usedBytes, Math.ceil)}, over half of your computer's ${formatGb(memory.totalBytes)} of memory`
        : "Stopped — used over half of your computer's memory";
    default:
      return assertNever(reason);
  }
}

function buildUnhandledDetail(event: ProviderUnhandledEvent): string {
  const humanized = event.rawType
    .split(/[:/._-]+/u)
    .flatMap((tok) => tok.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" "))
    .filter((tok) => tok.length > 0)
    .map((tok) => {
      const lower = tok.toLowerCase();
      return HUMANIZED_TOKENS[lower] ?? capitalize(lower);
    })
    .join(" ");
  return [
    humanized,
    `Raw event: ${event.rawType}`,
    "Payload:",
    JSON.stringify(event.rawEvent, null, 2),
  ].join("\n");
}

function ownershipTitle(
  status: string,
  metadata: OwnershipChangeOperationMetadata | null,
  threadName: string,
): string {
  if (status === "failed") return "Ownership change failed";
  if (status !== "completed") return `Ownership change ${status}`;
  if (!metadata) return "Ownership change completed";

  const verb = OWNERSHIP_CHANGE_VERBS[metadata.action];
  const rawParent =
    metadata.action === "release"
      ? metadata.previousParentThreadTitle
      : metadata.nextParentThreadTitle;
  const parent = rawParent?.trim() || "parent";
  const name = threadName.trim();
  const phrase = `${verb} ${parent}`;
  return name.length > 0 ? `${name} ${phrase}` : capitalize(phrase);
}

function operationRowStatus(rawStatus: string): TimelineRowStatus {
  if (rawStatus === "completed" || rawStatus === "noop") return "completed";
  if (rawStatus === "failed") return "error";
  return "pending";
}

function provisioningStatus(
  status: SystemThreadProvisioningStatus,
): TimelineRowStatus {
  switch (status) {
    case "active":
      return "pending";
    case "completed":
      return "completed";
    case "failed":
      return "error";
    case "cancelled":
      return "interrupted";
  }
}

function buildPermissionGrantRow(
  threadId: string,
  turnId: string | null,
  interaction: ApprovalInteractionLifecycle,
  meta: EventMeta,
): Extract<TimelineApprovalWorkRow, { approvalKind: "permission-grant" }> | null {
  if (interaction.payload.subject.kind !== "permission_grant") return null;
  const lifecycle =
    interaction.status === "resolved"
      ? interaction.resolution?.decision === "deny"
        ? "denied"
        : "granted"
      : interaction.status;
  const status: TimelineRowStatus =
    lifecycle === "pending" || lifecycle === "resolving"
      ? "pending"
      : lifecycle === "interrupted"
        ? "interrupted"
        : "completed";
  const decision = interaction.resolution?.decision;
  const grantScope =
    decision === "allow_once"
      ? "turn"
      : decision === "allow_for_session"
        ? "session"
        : null;

  return {
    id: messageId(threadId, "approval", interaction.id),
    threadId,
    turnId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    startedAt: meta.createdAt,
    createdAt: meta.createdAt,
    kind: "work",
    workKind: "approval",
    approvalKind: "permission-grant",
    interactionId: interaction.id,
    lifecycle,
    status,
    grantScope,
    statusReason: interaction.statusReason,
    target: {
      itemId: interaction.payload.subject.itemId,
      toolName: interaction.payload.subject.toolName,
    },
  };
}

function buildQuestionRow(
  threadId: string,
  turnId: string | null,
  interaction: UserQuestionInteractionLifecycle,
  meta: EventMeta,
): TimelineQuestionWorkRow {
  const lifecycle =
    interaction.status === "resolved" ? "answered" : interaction.status;
  const status: TimelineRowStatus =
    lifecycle === "pending" || lifecycle === "resolving"
      ? "pending"
      : lifecycle === "interrupted"
        ? "interrupted"
        : "completed";
  return {
    id: messageId(threadId, "question", interaction.id),
    threadId,
    turnId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    startedAt: meta.createdAt,
    createdAt: meta.createdAt,
    kind: "work",
    workKind: "question",
    interactionId: interaction.id,
    lifecycle,
    status,
    questions: interaction.payload.questions,
    answers: interaction.resolution?.answers ?? null,
    statusReason: interaction.statusReason,
  };
}

export type ParsedOperationResult =
  | {
      kind: "operation";
      row: Extract<TimelineSystemRow, { systemKind: "operation" }>;
      mode: "plain" | "provisioning" | "thread-op" | "repeated-warning";
      key?: string;
      provisioning?: ProvisioningState;
    }
  | {
      kind: "approval";
      row: Extract<TimelineApprovalWorkRow, { approvalKind: "permission-grant" }>;
    }
  | { kind: "question"; row: TimelineQuestionWorkRow };

export interface ParseOperationOptions {
  includeDiagnosticOperations?: boolean;
  providerDisplayName?: string;
  threadName: string;
}

export function parseOperationEvent(
  event: ThreadEvent,
  meta: EventMeta,
  options: ParseOperationOptions,
): ParsedOperationResult | null {
  const turnId = getEventTurnId(event) ?? null;
  const makeBase = (idKey: string) => ({
    id: messageId(event.threadId, "op", `${idKey}:${meta.seq}`),
    threadId: event.threadId,
    turnId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    startedAt: meta.createdAt,
    createdAt: meta.createdAt,
    kind: "system" as const,
    systemKind: "operation" as const,
  });

  const fallback = getProviderModelFallbackData(event);
  if (fallback !== null) {
    return {
      kind: "operation",
      mode: "plain",
      row: {
        ...makeBase("warning"),
        operationKind: "warning",
        title: `Model fallback: ${fallback.originalModel} → ${fallback.fallbackModel}`,
        detail: fallback.message,
        status: "completed",
        completedAt: meta.createdAt,
      },
    };
  }

  switch (event.type) {
    case "provider/unhandled":
      if (!options.includeDiagnosticOperations) return null;
      return {
        kind: "operation",
        mode: "plain",
        row: {
          ...makeBase("provider-unhandled"),
          operationKind: "provider-unhandled",
          title: `Unhandled ${options.providerDisplayName?.trim() || event.providerId} event`,
          detail: buildUnhandledDetail(event),
          status: "completed",
          completedAt: meta.createdAt,
        },
      };

    case "provider.env-resolved": {
      if (!options.includeDiagnosticOperations) return null;
      const detail = event.entries
        .map((entry) => {
          const source =
            entry.source === "shell"
              ? "shell"
              : "plugin" in entry.source
                ? entry.source.plugin
                : entry.source.core;
          const shown =
            entry.source === "shell"
              ? diagnosticShellEnvValue(entry.name, entry.value)
              : entry.value;
          const value = typeof shown === "string" ? shown : "••••••";
          return `${entry.name}=${value} (${source})${entry.reason ? ` — ${entry.reason}` : ""}`;
        })
        .join("\n");
      return {
        kind: "operation",
        mode: "plain",
        row: {
          ...makeBase("provider-environment"),
          operationKind: "generic",
          title: "Provider environment resolved",
          detail: detail || null,
          status: "completed",
          completedAt: meta.createdAt,
        },
      };
    }

    case "provider/warning": {
      const isDep = event.category === "deprecation";
      const isCfg = event.category === "config";
      const title = isDep
        ? "Deprecation notice"
        : isCfg
          ? "Configuration warning"
          : event.summary?.trim() || "Warning";
      const detail = (
        isDep || isCfg ? [event.summary, event.details] : [event.details]
      )
        .filter((line): line is string => Boolean(line))
        .join("\n");
      const kind = isDep ? "deprecation" : "warning";
      return {
        kind: "operation",
        mode:
          turnId === null && event.category === "general"
            ? "repeated-warning"
            : "plain",
        row: {
          ...makeBase(kind),
          operationKind: kind,
          title,
          detail: detail || null,
          status: "completed",
          completedAt: meta.createdAt,
        },
      };
    }

    case "system/thread/interrupted":
      return {
        kind: "operation",
        mode: "plain",
        row: {
          ...makeBase("thread-interrupted"),
          operationKind: "thread-interrupted",
          title: threadInterruptedTitle(event.reason, event.cause, event.memory),
          detail: null,
          status: "interrupted",
          completedAt: meta.createdAt,
        },
      };

    case "system/provider-turn-watchdog":
      return {
        kind: "operation",
        mode: "plain",
        row: {
          ...makeBase("provider-turn-watchdog"),
          operationKind: "generic",
          title: "Provider turn stopped responding",
          detail: `No provider activity for ${Math.round(event.elapsedMs / 1_000)}s after ${event.lastActivityEventType}`,
          status: "error",
          completedAt: meta.createdAt,
        },
      };

    case "system/thread-provisioning": {
      if (event.provisioningId.startsWith("thread-start:")) return null;
      const status = provisioningStatus(event.status);
      const prov: ProvisioningState = {
        ...(event.environmentId !== null
          ? { environmentId: event.environmentId }
          : {}),
        provisioningId: event.provisioningId,
        transcript: readProvisioningEntries(event.entries),
        rawDetails: [],
      };
      const row: Extract<TimelineSystemRow, { systemKind: "operation" }> = {
        ...makeBase("thread-provisioning"),
        operationKind: "thread-provisioning",
        title: provisioningTitleForStatus(status),
        detail: null,
        status,
        completedAt: status === "pending" ? null : meta.createdAt,
      };
      row.detail = formatProvisioningDetail(row, prov);
      return {
        kind: "operation",
        mode: "provisioning",
        key: event.provisioningId,
        provisioning: prov,
        row,
      };
    }

    case "system/operation": {
      if (HIDDEN_OPERATIONS.has(event.operation)) return null;
      const status = operationRowStatus(event.status);
      const isOwnership = event.operation === "ownership_change";
      const parsedOwner =
        isOwnership && event.metadata
          ? ownershipChangeOperationMetadataSchema.safeParse(event.metadata)
          : null;
      const ownerMeta = parsedOwner?.success ? parsedOwner.data : null;

      const title = isOwnership
        ? ownershipTitle(event.status, ownerMeta, options.threadName)
        : event.operation === THREAD_CONTEXT_CLEAR_OPERATION &&
            event.status === "completed"
          ? "Context cleared"
          : `${capitalize(event.operation.replace(/_/g, " "))} ${event.status}`;

      const branch =
        typeof event.metadata?.branch === "string"
          ? event.metadata.branch
          : undefined;
      const msg = event.message.trim();
      const parts = [
        msg.length > 0 && msg !== title ? msg : undefined,
        branch ? `Branch: ${branch}` : undefined,
      ].filter((v): v is string => Boolean(v));
      const detail = parts.length > 0 ? parts.join(" • ") : null;
      const completedAt = status === "pending" ? null : meta.createdAt;

      if (ownerMeta !== null) {
        const parentChange: TimelineParentChange = {
          action: ownerMeta.action,
          previousParentThreadId: ownerMeta.previousParentThreadId,
          previousParentThreadTitle: ownerMeta.previousParentThreadTitle,
          nextParentThreadId: ownerMeta.nextParentThreadId,
          nextParentThreadTitle: ownerMeta.nextParentThreadTitle,
        };
        return {
          kind: "operation",
          mode: "thread-op",
          key: event.operationId,
          row: {
            ...makeBase("operation"),
            operationKind: "parent-change",
            parentChange,
            title,
            detail,
            status,
            completedAt,
          },
        };
      }

      return {
        kind: "operation",
        mode: "thread-op",
        key: event.operationId,
        row: {
          ...makeBase("operation"),
          operationKind: "generic",
          title,
          detail,
          status,
          completedAt,
        },
      };
    }

    case "system/interaction/lifecycle": {
      if (isUserQuestionInteractionLifecycle(event.interaction)) {
        return {
          kind: "question",
          row: buildQuestionRow(event.threadId, turnId, event.interaction, meta),
        };
      }
      if (isApprovalInteractionLifecycle(event.interaction)) {
        const row = buildPermissionGrantRow(
          event.threadId,
          turnId,
          event.interaction,
          meta,
        );
        return row ? { kind: "approval", row } : null;
      }
      return null;
    }

    case "thread/context/cleared":
      return {
        kind: "operation",
        mode: "plain",
        row: {
          ...makeBase("context-clear"),
          operationKind: "context-clear",
          title: "Context cleared",
          detail: null,
          status: "completed",
          completedAt: meta.createdAt,
        },
      };

    default:
      return null;
  }
}

export function interruptOperationRow(
  row: Extract<TimelineSystemRow, { systemKind: "operation" }>,
  provisioningByRow: ReadonlyMap<TimelineSystemRow, ProvisioningState>,
): void {
  if (row.status !== "pending") return;
  row.status = "interrupted";
  row.completedAt = row.createdAt;
  switch (row.operationKind) {
    case "generic":
    case "parent-change":
      row.title = "Operation interrupted";
      break;
    case "thread-provisioning": {
      row.title = provisioningTitleForStatus("interrupted");
      const prov = provisioningByRow.get(row);
      if (prov) row.detail = formatProvisioningDetail(row, prov);
      break;
    }
    case "compaction":
      row.title = "Context compaction interrupted";
      break;
    case "context-clear":
      row.title = "Context clear interrupted";
      break;
  }
}

export function finalizeOperationRow(
  row: Extract<TimelineSystemRow, { systemKind: "operation" }>,
  threadStatus: Thread["status"] | undefined,
  provisioningByRow: ReadonlyMap<TimelineSystemRow, ProvisioningState>,
): void {
  if (row.status !== "pending") return;
  if (threadStatus === "error" && row.operationKind === "thread-provisioning") {
    row.status = "error";
    row.title = provisioningTitleForStatus("error");
    row.completedAt = row.createdAt;
    const prov = provisioningByRow.get(row);
    if (prov) row.detail = formatProvisioningDetail(row, prov);
    return;
  }
  interruptOperationRow(row, provisioningByRow);
}
