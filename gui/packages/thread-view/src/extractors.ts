import {
  LEGACY_CODEX_GOAL_EXTENSION_KIND,
  THREAD_HARNESS_SWITCH_OPERATION,
  THREAD_MODEL_SELECTION_OPERATION,
  promptInputHasCommandMention,
  removeCommandMentionsFromPromptInput,
  requireThreadEventScopeTurnId,
  threadTimelineGoalStatusSchema,
  toPositiveNumber,
  type ContextSnapshot,
  type JsonObject,
  type JsonValue,
  type ProviderComposerCommand,
  type Thread,
  type ThreadEvent,
  type ThreadEventPlanStep,
  type ThreadEventType,
  type ThreadTimelineActivePromptMode,
  type ThreadTimelineGoal,
  type ThreadTimelineModelFallback,
  type ThreadTimelinePendingTodoItem,
  type ThreadTimelinePendingTodoItemStatus,
  type ThreadTimelinePendingTodos,
} from "@cloudroom/domain";
import type { ThreadContextWindowUsage } from "@cloudroom/server-contract";
import {
  bufferedTextKey,
  orderEvents,
  parsePromptInput,
  resolveBufferedTextIdentity,
  type ThreadEventWithMeta,
} from "./events.js";

export const THREAD_TIMELINE_EXCLUDED_EVENT_TYPES = [
  "thread/started",
  "thread/identity",
  "thread/contextWindowUsage/updated",
  "thread/tokenUsage/updated",
  "turn/diff/updated",
] as const satisfies readonly ThreadEventType[];

const MIN_DELTAS_FOR_COMPACTION = 1_000;

export function compactThreadTimelineSummaryEvents(
  events: ThreadEventWithMeta[],
): ThreadEventWithMeta[] {
  let deltaCount = 0;
  const completedKeys = new Set<string>();
  for (const { event } of events) {
    if (event.type === "item/agentMessage/delta") {
      deltaCount += 1;
    } else if (
      event.type === "item/completed" &&
      event.item.type === "agentMessage"
    ) {
      const id = resolveBufferedTextIdentity(event, "assistant");
      if (id) completedKeys.add(bufferedTextKey(id));
    }
  }

  if (deltaCount < MIN_DELTAS_FOR_COMPACTION || completedKeys.size === 0) {
    return events;
  }

  const keptFirst = new Set<string>();
  const out: ThreadEventWithMeta[] = [];
  for (const entry of events) {
    if (entry.event.type !== "item/agentMessage/delta") {
      out.push(entry);
      continue;
    }
    const id = resolveBufferedTextIdentity(entry.event, "assistant");
    if (!id) {
      out.push(entry);
      continue;
    }
    const key = bufferedTextKey(id);
    if (!completedKeys.has(key)) {
      out.push(entry);
    } else if (!keptFirst.has(key)) {
      keptFirst.add(key);
      out.push(entry);
    }
  }
  return out;
}

export function extractThreadContextWindowUsage(
  events: readonly ThreadEventWithMeta[],
): ThreadContextWindowUsage | null {
  let snapshot: ContextSnapshot | undefined;
  let estimated: boolean | undefined;
  let modelContextWindow: number | undefined;
  let usedTokens: number | undefined;
  let usageUnknown = false;

  const ordered = orderEvents(events);
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const { event } = ordered[i]!;
    if (event.type !== "thread/contextWindowUsage/updated") continue;
    const u = event.contextWindowUsage;

    if (usedTokens === undefined && !usageUnknown) {
      snapshot = u.snapshot;
      estimated = u.estimated;
      if (u.usedTokens === null) {
        usageUnknown = true;
      } else if (Number.isFinite(u.usedTokens) && u.usedTokens >= 0) {
        usedTokens = u.usedTokens;
      }
    }
    if (modelContextWindow === undefined && u.modelContextWindow !== null) {
      const valid = toPositiveNumber(u.modelContextWindow);
      if (valid !== undefined) modelContextWindow = valid;
    }
    if ((usedTokens !== undefined || usageUnknown) && modelContextWindow !== undefined) {
      break;
    }
  }

  if (usedTokens === undefined || modelContextWindow === undefined) return null;
  return {
    ...(snapshot &&
    snapshot.usedTokens === usedTokens &&
    snapshot.contextWindowTokens === modelContextWindow
      ? { snapshot }
      : {}),
    estimated: estimated ?? false,
    modelContextWindow,
    usedTokens,
  };
}

export type PlanCommand = Pick<ProviderComposerCommand, "trigger" | "name">;

export interface ThreadTimelineActivePlanTurn {
  promptMode: ThreadTimelineActivePromptMode;
  turnId: string;
}

export function extractThreadTimelineActivePlanTurn({
  events,
  planCommand,
  providerId,
  threadStatus,
}: {
  events: readonly ThreadEventWithMeta[];
  planCommand: PlanCommand | null | undefined;
  providerId: string | undefined;
  threadStatus: Thread["status"];
}): ThreadTimelineActivePlanTurn | null {
  if (threadStatus !== "active" || !providerId || !planCommand) return null;

  const requests = new Map<
    string,
    Extract<ThreadEvent, { type: "client/turn/requested" }>
  >();
  const completedTurns = new Set<string>();
  let lastInterruptSeq = -1;

  for (const { event, meta } of events) {
    if (event.type === "client/turn/requested") {
      requests.set(event.requestId, event);
    } else if (event.type === "turn/completed") {
      completedTurns.add(
        requireThreadEventScopeTurnId({ type: event.type, scope: event.scope }),
      );
    } else if (event.type === "system/thread/interrupted") {
      lastInterruptSeq = Math.max(lastInterruptSeq, meta.seq);
    }
  }

  let latest: {
    request: Extract<ThreadEvent, { type: "client/turn/requested" }>;
    seq: number;
    turnId: string;
  } | null = null;

  for (const { event, meta } of events) {
    if (event.type !== "turn/input/accepted" || meta.seq <= lastInterruptSeq) {
      continue;
    }
    const turnId = requireThreadEventScopeTurnId({
      type: event.type,
      scope: event.scope,
    });
    if (completedTurns.has(turnId)) continue;
    const request = requests.get(event.clientRequestId);
    if (!request || !promptInputHasCommandMention(request.input, planCommand)) {
      continue;
    }
    if (!latest || meta.seq > latest.seq) {
      latest = { request, seq: meta.seq, turnId };
    }
  }

  if (!latest) return null;
  const cleaned = removeCommandMentionsFromPromptInput(
    latest.request.input,
    planCommand,
  );
  return {
    promptMode: {
      mode: "plan",
      providerId,
      prompt: parsePromptInput(cleaned)?.text.trim() ?? "",
    },
    turnId: latest.turnId,
  };
}

export function extractThreadTimelineActivePromptMode(
  args: Parameters<typeof extractThreadTimelineActivePlanTurn>[0],
): ThreadTimelineActivePromptMode | null {
  return extractThreadTimelineActivePlanTurn(args)?.promptMode ?? null;
}

function parseGoalStatePayload(
  payload: unknown,
):
  | { ok: true; value: null | Omit<ThreadTimelineGoal, "sourceSeq" | "updatedAt"> }
  | { ok: false } {
  if (payload === null) return { ok: true, value: null };
  if (typeof payload !== "object" || Array.isArray(payload)) return { ok: false };
  const raw = payload as Record<string, unknown>;
  const status = threadTimelineGoalStatusSchema.safeParse(raw.status);
  if (
    !status.success ||
    typeof raw.objective !== "string" ||
    (raw.tokenBudget !== null && typeof raw.tokenBudget !== "number") ||
    typeof raw.tokensUsed !== "number" ||
    typeof raw.timeUsedSeconds !== "number"
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    value: {
      objective: raw.objective,
      status: status.data,
      tokenBudget: raw.tokenBudget,
      tokensUsed: raw.tokensUsed,
      timeUsedSeconds: raw.timeUsedSeconds,
    },
  };
}

export function extractThreadTimelineGoal(
  events: readonly ThreadEventWithMeta[],
): ThreadTimelineGoal | null {
  let bestSeq = -1;
  let best: ThreadTimelineGoal | null = null;

  for (const { event, meta } of orderEvents(events)) {
    if (
      event.type !== "thread/extensionState/updated" ||
      event.kind !== LEGACY_CODEX_GOAL_EXTENSION_KIND ||
      meta.seq <= bestSeq
    ) {
      continue;
    }
    const parsed = parseGoalStatePayload(event.payload);
    if (!parsed.ok) continue;
    bestSeq = meta.seq;
    best =
      parsed.value === null
        ? null
        : {
            sourceSeq: meta.seq,
            updatedAt: meta.createdAt,
            ...parsed.value,
          };
  }
  return best;
}

export interface ProviderModelFallbackData {
  originalModel: string;
  fallbackModel: string;
  reason: "refusal" | "provider";
  message: string;
}

function asJsonObject(value: JsonValue | undefined): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function asNonEmptyString(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function getProviderModelFallbackData(
  event: ThreadEvent,
): ProviderModelFallbackData | null {
  if (event.type === "provider/modelFallback") {
    return {
      originalModel: event.originalModel,
      fallbackModel: event.fallbackModel,
      reason: event.reason,
      message: event.message,
    };
  }
  if (
    event.type !== "provider/unhandled" ||
    event.rawEvent.method !== "sdk/message"
  ) {
    return null;
  }
  const raw = asJsonObject(asJsonObject(event.rawEvent.params)?.message);
  if (!raw) return null;
  const subtype = asNonEmptyString(raw.subtype);
  if (subtype !== "model_fallback" && subtype !== "model_refusal_fallback") {
    return null;
  }
  const originalModel = asNonEmptyString(raw.original_model);
  const fallbackModel = asNonEmptyString(raw.fallback_model);
  if (!originalModel || !fallbackModel) return null;

  return {
    originalModel,
    fallbackModel,
    reason: subtype === "model_refusal_fallback" ? "refusal" : "provider",
    message:
      asNonEmptyString(raw.content) ??
      `Switched from ${originalModel} to ${fallbackModel}.`,
  };
}

export function extractThreadTimelineModelFallback(
  events: readonly ThreadEventWithMeta[],
): ThreadTimelineModelFallback | null {
  let latestSeq = -1;
  let fallback: ThreadTimelineModelFallback | null = null;

  for (const { event, meta } of events) {
    if (meta.seq < latestSeq) continue;
    if (
      event.type === "client/turn/requested" ||
      (event.type === "system/operation" &&
        (event.operation === THREAD_HARNESS_SWITCH_OPERATION ||
          event.operation === THREAD_MODEL_SELECTION_OPERATION))
    ) {
      latestSeq = meta.seq;
      fallback = null;
      continue;
    }
    const data = getProviderModelFallbackData(event);
    if (!data) continue;
    latestSeq = meta.seq;
    fallback = { sourceSeq: meta.seq, detectedAt: meta.createdAt, ...data };
  }
  return fallback;
}

const TODO_TEXT_MAX_LENGTH = 240;
const PLAN_STEP_STATUS: Record<
  NonNullable<ThreadEventPlanStep["status"]>,
  ThreadTimelinePendingTodoItemStatus
> = {
  pending: "pending",
  active: "in_progress",
  completed: "completed",
  failed: "completed",
};

export function extractThreadTimelinePendingTodos(
  threadStatus: Thread["status"],
  events: readonly ThreadEventWithMeta[],
): ThreadTimelinePendingTodos | null {
  if (threadStatus !== "active") return null;

  let best: {
    seq: number;
    createdAt: number;
    items: ThreadTimelinePendingTodoItem[];
  } | null = null;

  for (const { event, meta } of orderEvents(events)) {
    if (event.type !== "item/completed" || event.item.type !== "planSteps") {
      continue;
    }
    if (best !== null && meta.seq <= best.seq) continue;

    const items: ThreadTimelinePendingTodoItem[] = [];
    for (const [index, step] of event.item.steps.entries()) {
      const trimmed = step.step.trim();
      if (trimmed.length === 0) continue;
      items.push({
        id: `seq:${meta.seq}:${index}`,
        text:
          trimmed.length <= TODO_TEXT_MAX_LENGTH
            ? trimmed
            : trimmed.slice(0, TODO_TEXT_MAX_LENGTH),
        status: PLAN_STEP_STATUS[step.status ?? "pending"],
      });
    }
    best = { seq: meta.seq, createdAt: meta.createdAt, items };
  }

  return best
    ? { sourceSeq: best.seq, updatedAt: best.createdAt, items: best.items }
    : null;
}
