import { LOCAL_BASH_TASK_TYPE, backgroundTaskItemStatus } from "./background-task.js";
import { threadEventSchema } from "./provider-event.js";
import type { ThreadEventScope } from "./thread-event-scope.js";

// Turns Cloud thread records from Core into the chat's thread events. The desktop server and the phone (with the Mac
// off) both use these, so a record shows the same everywhere. Callers own turns, storage, and validation.

type Data = Record<string, unknown>;
export type CloudEventBase = { threadId: string; providerThreadId: string; scope: ThreadEventScope };

const plain = (value: unknown): Data | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Data) : null;
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** A streamed piece of a reply (`text_delta`) or of reasoning (`thinking_delta`). */
export function cloudDeltaEvent(kind: string, data: Data, base: CloudEventBase, itemId: string): Data | null {
  if (kind !== "text_delta" && kind !== "thinking_delta") return null;
  return { ...base, type: kind === "text_delta" ? "item/agentMessage/delta" : "item/reasoning/textDelta", itemId, delta: data.delta };
}

/** A reply, reasoning, or tool call record (`item_started`, `item_completed`, `tool_snapshot`). ACP agents describe tools
 *  in `tool`; Claude Code (`tool_use`) and Pi name them in `tool_name`. */
export function cloudItemEvent(kind: string, data: Data, base: CloudEventBase, id: string): Data | null {
  const completed = kind === "item_completed";
  if (!completed && kind !== "item_started" && kind !== "tool_snapshot") return null;
  const type = completed ? "item/completed" : "item/started";
  if (kind !== "tool_snapshot" && (data.item_type === "text" || data.item_type === "agentMessage")) {
    const checkpoint = completed && data.harness === "claude-code" && text(data.provider_checkpoint_id);
    return { ...base, type, item: { type: "agentMessage", id, text: text(data.text), ...(checkpoint ? { providerCheckpointId: checkpoint } : {}) } };
  }
  if (kind !== "tool_snapshot" && (data.item_type === "thinking" || data.item_type === "reasoning")) {
    return { ...base, type, item: { type: "reasoning", id, summary: [], content: text(data.text) ? [text(data.text)] : [] } };
  }
  const tool = plain(data.tool);
  if (tool) {
    if (kind === "tool_snapshot") return { ...base, type: "item/toolCall/progress", itemId: id, message: JSON.stringify(tool.content ?? []) };
    const args = plain(tool.rawInput);
    return { ...base, type, item: {
      type: "toolCall", id, tool: String(tool.title ?? tool.kind ?? "Cursor tool"),
      status: !completed ? "pending" : tool.status === "completed" ? "completed" : "failed",
      ...(args ? { arguments: args } : {}),
      ...(completed ? { result: tool.rawOutput ?? tool.content ?? null } : {}),
    } };
  }
  if (kind !== "tool_snapshot" && (data.item_type === "tool_use" || (data.item_type === undefined && typeof data.tool_name === "string"))) {
    return { ...base, type, item: {
      type: "toolCall", id, tool: text(data.tool_name) || "Claude tool",
      status: !completed ? "pending" : data.is_error === true || data.status === "failed" ? "failed" : "completed",
      ...(data.input && typeof data.input === "object" ? { arguments: data.input } : {}),
      ...(data.result !== undefined ? { result: data.result } : {}),
    } };
  }
  return null;
}

/** Core states in which the agent's process, and every background command it ran, is gone. */
export const CLOUD_AGENT_GONE_STATES: readonly string[] = ["failed", "process_lost", "closed", "sleeping", "suspended", "resuming"];
/** A background command that started and has not ended: its description, and when it started (ms) if known. */
export type CloudBackgroundCommand = { description: string; startedAt: number | null };

/** A background command ending, with how long it ran when known. A command whose agent went away ends `stopped`. */
export function cloudBackgroundCommandEnd(base: CloudEventBase, id: string, command: CloudBackgroundCommand, taskStatus: "completed" | "failed" | "stopped", at: number | null, extra: { durationMs?: unknown; summary?: unknown } = {}): Data {
  const durationMs = typeof extra.durationMs === "number" ? extra.durationMs : at !== null && command.startedAt !== null ? at - command.startedAt : null;
  return { ...base, type: "item/backgroundTask/completed", item: {
    type: "backgroundTask", id, familyId: id.slice("task:".length), taskType: LOCAL_BASH_TASK_TYPE, description: command.description,
    status: backgroundTaskItemStatus(taskStatus), taskStatus, skipTranscript: false,
    ...(durationMs !== null && durationMs >= 0 ? { usage: { totalTokens: 0, toolUses: 0, durationMs } } : {}),
    ...(text(extra.summary) ? { summary: text(extra.summary) } : {}),
  } };
}

/** A Claude background command starting (`task_started`) or ending (`task_notification`), from Claude's own frame at
 *  time `at`. The chat shows it as a bubble: Claude starts a turn by itself when it ends. `started` gives a command that
 *  started and has not ended yet, else null, so an agent's or workflow's task, or a repeat, shows nothing. */
export function cloudBackgroundCommandEvent(frame: Data, base: CloudEventBase, started: (id: string) => CloudBackgroundCommand | null, at: number | null): Data | null {
  if (frame.type !== "system" || typeof frame.task_id !== "string") return null;
  const id = `task:${frame.task_id}`;
  if (frame.subtype === "task_started" && frame.task_type === LOCAL_BASH_TASK_TYPE) {
    return { ...base, type: "item/backgroundTask/progress", item: {
      type: "backgroundTask", id, familyId: frame.task_id, taskType: LOCAL_BASH_TASK_TYPE, description: text(frame.description),
      status: "pending", taskStatus: "running", skipTranscript: false,
    } };
  }
  const command = frame.subtype === "task_notification" ? started(id) : null;
  if (command === null) return null;
  const status = frame.status === "completed" || frame.status === "failed" ? frame.status : "stopped";
  return cloudBackgroundCommandEnd(base, id, command, status, at, { durationMs: plain(frame.usage)?.duration_ms, summary: frame.summary });
}

const CODEX_DELTA = /^item\/(agentMessage\/delta|commandExecution\/outputDelta|fileChange\/outputDelta|reasoning\/(summaryTextDelta|textDelta)|plan\/delta)$/;

/** A Codex item or streamed-output frame. Its user messages are skipped: the prompt already shows. Callers handle
 *  sub-agent items first. An item type the chat doesn't know shows as a generic tool call. */
export function codexItemEvent(method: string, params: Data, base: CloudEventBase, itemId: (id: unknown) => string): Data | null {
  if (CODEX_DELTA.test(method)) return { ...base, type: method, itemId: itemId(params.itemId), delta: params.delta };
  if (method !== "item/started" && method !== "item/completed") return null;
  const native = plain(params.item) ?? {};
  if (native.type === "userMessage") return null;
  const status = method === "item/started" ? "pending"
    : ["failed", "declined"].includes(String(native.status)) ? "failed"
      : native.status === "interrupted" ? "interrupted" : "completed";
  const item: Data = { ...native, id: itemId(native.id), status, approvalStatus: null };
  for (const key of ["exitCode", "durationMs", "aggregatedOutput"]) if (item[key] === null) delete item[key];
  if (native.type === "fileChange" && Array.isArray(native.changes)) {
    item.changes = native.changes.map((entry) => {
      const change = plain(entry) ?? {};
      return { ...change, kind: typeof change.kind === "string" ? change.kind : (plain(change.kind) ?? {}).type };
    });
  }
  const event = { ...base, type: method, item };
  return threadEventSchema.safeParse(event).success
    ? event
    : { ...base, type: method, item: { type: "toolCall", id: itemId(native.id), tool: String(native.type), status, result: native } };
}
