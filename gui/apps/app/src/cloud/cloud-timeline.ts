import {
  encodeClientTurnRequestIdNumber,
  threadEventSchema,
  threadScope,
  turnScope,
} from "@cloudroom/domain";
import {
  buildThreadTimelineFromEvents,
  buildThreadTimelineTurnDetailsFromEvents,
  type ThreadEventWithMeta,
} from "@cloudroom/thread-view";
import type { CompletedTurnDisplay } from "@cloudroom/domain";
import type { TimelineRow } from "@cloudroom/server-contract";

export interface CloudRecord {
  sequence: number;
  kind: string;
  timestamp_ms: number | null;
  data: unknown;
  native?: unknown;
}

type Data = Record<string, unknown>;
const object = (value: unknown): Data =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const FINISHED = [
  "completed",
  "failed",
  "interrupted",
  "unknown",
  "unknown_after_restart",
];
const WORKING = ["starting", "starting_turn", "running", "resuming"];
const PROVIDER_THREAD = "cloud";
const HIDDEN =
  /\n?<cloudroom_custom_instructions>[\s\S]*?<\/cloudroom_custom_instructions>|\n*\[Cloud (?:workspace context|fork)\]\n[\s\S]*$/g;

function requestNumber(id: string) {
  let hash = 0x811c9dc5;
  let high = 0;
  for (let index = 0; index < id.length; index++) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193) >>> 0;
    high = (high * 31 + id.charCodeAt(index)) % 0x10000;
  }
  return encodeClientTurnRequestIdNumber({ value: high * 0x100000000 + hash });
}

function promptInput(input: Data) {
  const parts = Array.isArray(input.content) ? input.content.map(object) : [];
  const content = parts
    .map((part) =>
      part.type === "text"
        ? { ...part, text: text(part.text).replace(HIDDEN, "") }
        : part,
    )
    .filter((part) => part.type !== "text" || text(part.text).trim());
  return content.length
    ? content
    : [
        {
          type: "text",
          text: text(input.text).replace(HIDDEN, ""),
          mentions: [],
        },
      ];
}

export const promptText = (input: Data) =>
  promptInput(input)
    .map((part) => (part.type === "text" ? text(part.text) : ""))
    .join("\n")
    .trim();

export class CloudThreadEvents {
  readonly events: ThreadEventWithMeta[] = [];
  state = "idle";
  cursor = 0;
  model = "";
  readonly waiting = new Map<string, { text: string; at: number }>();
  waitingVersion = 0;
  private remember(requestId: string, item: { text: string; at: number }) {
    this.waiting.set(requestId, item);
    this.waitingVersion++;
  }

  private forget(requestId: string) {
    if (this.waiting.delete(requestId)) this.waitingVersion++;
  }

  readonly promptLog: { requestId: string; text: string }[] = [];
  private readonly prompts = new Map<string, Data>();
  private readonly started = new Set<string>();
  private turnId: string | null = null;
  private piReply: { id: string; turnId: string; text: string } | null = null;

  constructor(private readonly threadId: string) {}

  private closePiReply(): unknown[] {
    const reply = this.piReply;
    this.piReply = null;
    return reply
      ? [
          {
            threadId: this.threadId,
            providerThreadId: PROVIDER_THREAD,
            scope: turnScope(reply.turnId),
            type: "item/completed",
            item: { type: "agentMessage", id: reply.id, text: reply.text },
          },
        ]
      : [];
  }

  add(records: readonly CloudRecord[]): boolean {
    const before = this.events.length;
    const previousState = this.state;
    for (const record of records) {
      if (record.sequence <= this.cursor) continue;
      this.cursor = record.sequence;
      for (const event of this.project(record)) {
        const parsed = threadEventSchema.safeParse(event);
        if (!parsed.success) continue;
        const seq = this.events.length + 1;
        this.events.push({
          event: parsed.data,
          meta: {
            id: `${this.threadId}:${seq}`,
            seq,
            createdAt: record.timestamp_ms ?? Date.now(),
          },
        });
      }
    }
    return this.events.length !== before || this.state !== previousState;
  }

  get working() {
    return WORKING.includes(this.state);
  }

  private project(record: CloudRecord): unknown[] {
    const data = object(record.data);
    const piText = record.kind === "text_delta" && !data.item_id;
    const out: unknown[] =
      piText || record.kind === "receipt" ? [] : this.closePiReply();
    const turnBase = (turnId: string) => ({
      threadId: this.threadId,
      providerThreadId: PROVIDER_THREAD,
      scope: turnScope(turnId),
    });
    if (record.kind === "receipt") {
      const command = text(data.command);
      const requestId = text(data.request_id);
      this.model = text(data.model) || this.model;
      if (command === "prompt" && data.input && requestId) {
        if (!this.prompts.has(requestId))
          this.promptLog.push({
            requestId,
            text: promptText(object(data.input)),
          });
        this.prompts.set(requestId, object(data.input));
      }
      const target = text(object(data.input).target_request_id);
      if (target && !["failed", "unknown"].includes(text(data.state))) {
        if (command === "cancel") this.forget(target);
        const queued = this.waiting.get(target);
        const edited = promptText(object(data.input));
        if (command === "edit" && queued && queued.text !== edited) {
          this.prompts.set(target, object(data.input));
          this.remember(target, { ...queued, text: edited });
        }
      }
      const prompt = this.prompts.get(requestId);
      if (command === "prompt" && prompt) {
        if (
          data.state === "accepted" &&
          !this.started.has(requestId) &&
          !prompt.teleport_handoff
        )
          this.remember(requestId, {
            text: promptText(prompt),
            at: record.timestamp_ms ?? Date.now(),
          });
        else this.forget(requestId);
      }
      if (
        ["prompt", "auto"].includes(command) &&
        FINISHED.includes(text(data.state)) &&
        this.started.has(requestId)
      ) {
        const state = text(data.state);
        out.push(...this.closePiReply(), {
          ...turnBase(requestId),
          type: "turn/completed",
          status:
            state === "completed"
              ? "completed"
              : state === "interrupted"
                ? "interrupted"
                : "failed",
        });
      }
      if (
        ["failed", "unknown"].includes(text(data.state)) &&
        text(data.error)
      ) {
        out.push({
          type: "system/error",
          scope: threadScope(),
          threadId: this.threadId,
          message: text(data.error),
        });
      }
      return out;
    }
    if (record.kind === "state") {
      this.state = text(data.state) || this.state;
      const requestId = text(data.request_id);
      if (this.state === "starting_turn" && requestId) {
        this.turnId = requestId;
        const prompt = this.prompts.get(requestId);
        this.forget(requestId);
        if (prompt && !prompt.teleport_handoff) {
          out.push({
            type: "client/turn/requested",
            scope: threadScope(),
            threadId: this.threadId,
            direction: "outbound",
            requestId: requestNumber(requestId),
            source: "tell",
            initiator: "user",
            senderThreadId: null,
            input: promptInput(prompt),
            target: { kind: "new-turn" },
            request: { method: "turn/start", params: {} },
            execution: {
              source: "client/turn/requested",
              model: text(prompt.model) || "cloud",
              reasoningLevel: "medium",
              permissionMode: "full",
              serviceTier: "default",
            },
          });
        }
        this.started.add(requestId);
        out.push({ ...turnBase(requestId), type: "turn/started" });
        if (prompt)
          out.push({
            ...turnBase(requestId),
            type: "turn/input/accepted",
            clientRequestId: requestNumber(requestId),
          });
      }
      if (["failed", "process_lost"].includes(this.state)) {
        out.push({
          type: "system/error",
          scope: threadScope(),
          threadId: this.threadId,
          message: text(data.reason) || "Cloudroom execution failed",
        });
      }
      return out;
    }
    const native = object(record.native);
    if (typeof native.method === "string")
      return this.codexFrame(native.method, object(native.params));
    const turnId = text(data.request_id) || this.turnId;
    if (!turnId || !this.started.has(turnId) || !(piText || data.item_id))
      return out;
    const base = turnBase(turnId);
    let id = `${turnId}:${text(data.item_id)}`;
    if (piText) {
      if (this.piReply?.turnId !== turnId) {
        out.push(...this.closePiReply());
        this.piReply = {
          id: `${turnId}:pi:${record.sequence}`,
          turnId,
          text: "",
        };
        out.push({
          ...base,
          type: "item/started",
          item: { type: "agentMessage", id: this.piReply.id, text: "" },
        });
      }
      this.piReply.text += text(data.delta);
      id = this.piReply.id;
    }
    if (record.kind === "text_delta" && text(data.delta)) {
      out.push({
        ...base,
        type: "item/agentMessage/delta",
        itemId: id,
        delta: text(data.delta),
      });
    } else if (
      record.kind === "item_started" ||
      record.kind === "item_completed"
    ) {
      const type =
        record.kind === "item_started" ? "item/started" : "item/completed";
      const itemType = text(data.item_type);
      if (itemType === "text" || itemType === "agentMessage") {
        out.push({
          ...base,
          type,
          item: { type: "agentMessage", id, text: text(data.text) },
        });
      } else if (itemType === "thinking" || itemType === "reasoning") {
        out.push({
          ...base,
          type,
          item: {
            type: "reasoning",
            id,
            summary: [],
            content: text(data.text) ? [text(data.text)] : [],
          },
        });
      } else if (text(data.tool_name)) {
        out.push({
          ...base,
          type,
          item: {
            type: "toolCall",
            id,
            tool: text(data.tool_name),
            status:
              type === "item/started"
                ? "pending"
                : data.is_error === true || data.status === "failed"
                  ? "failed"
                  : "completed",
            ...(data.input && typeof data.input === "object"
              ? { arguments: data.input }
              : {}),
            ...(data.result !== undefined && data.result !== null
              ? { result: data.result }
              : {}),
          },
        });
      }
    }
    return out;
  }

  private codexFrame(method: string, params: Data): unknown[] {
    const turnId = this.turnId;
    if (!turnId || !this.started.has(turnId)) return [];
    const base = {
      threadId: this.threadId,
      providerThreadId: PROVIDER_THREAD,
      scope: turnScope(turnId),
    };
    const itemId = (id: unknown) => `${turnId}:${text(id)}`;
    if (method === "item/started" || method === "item/completed") {
      const native = object(params.item);
      if (
        ["userMessage", "subAgentActivity", "collabAgentToolCall"].includes(
          text(native.type),
        )
      )
        return [];
      const status =
        method === "item/started"
          ? "pending"
          : ["failed", "declined"].includes(text(native.status))
            ? "failed"
            : native.status === "interrupted"
              ? "interrupted"
              : "completed";
      const item: Data = {
        ...native,
        id: itemId(native.id),
        status,
        approvalStatus: null,
      };
      for (const key of ["exitCode", "durationMs", "aggregatedOutput"])
        if (item[key] === null) delete item[key];
      if (native.type === "fileChange" && Array.isArray(native.changes)) {
        item.changes = native.changes.map((entry) => {
          const change = object(entry);
          return {
            ...change,
            kind:
              typeof change.kind === "string"
                ? change.kind
                : text(object(change.kind).type),
          };
        });
      }
      const event = { ...base, type: method, item };
      return threadEventSchema.safeParse(event).success
        ? [event]
        : [
            {
              ...base,
              type: method,
              item: {
                type: "toolCall",
                id: itemId(native.id),
                tool: text(native.type),
                status,
                result: native,
              },
            },
          ];
    }
    if (
      /^item\/(agentMessage\/delta|commandExecution\/outputDelta|fileChange\/outputDelta|reasoning\/(summaryTextDelta|textDelta)|plan\/delta)$/.test(
        method,
      )
    ) {
      return typeof params.delta === "string"
        ? [
            {
              ...base,
              type: method,
              itemId: itemId(params.itemId),
              delta: params.delta,
            },
          ]
        : [];
    }
    if (method === "error") {
      return [
        {
          type: "system/error",
          scope: threadScope(),
          threadId: this.threadId,
          message: text(object(params.error).message) || "Codex failed",
        },
      ];
    }
    return [];
  }
}

export type { CompletedTurnDisplay };

export function cloudTimelineRows(
  feed: CloudThreadEvents,
  threadName: string,
  completedTurnDisplay: CompletedTurnDisplay,
): TimelineRow[] {
  return buildThreadTimelineFromEvents({
    acceptedClientRequestContext: {
      acceptedClientRequestEvents: [],
      rejectedClientRequestEvents: [],
    },
    contextWindowEvents: [],
    events: feed.events,
    options: {
      completedTurnDisplay,
      includeDiagnosticOperations: false,
      includeNestedRows: false,
      isLatestPage: true,
      threadName,
      threadStatus: feed.working ? "active" : "idle",
      turnMessageDetail: "summary",
      workspaceRoot: null,
    },
  }).rows;
}

export function cloudTurnDetails(
  feed: CloudThreadEvents,
  threadName: string,
  completedTurnDisplay: CompletedTurnDisplay,
  range: { turnId: string; sourceSeqStart: number; sourceSeqEnd: number },
): TimelineRow[] | null {
  const start = feed.events.reduce(
    (seq, { event, meta }) =>
      event.type === "turn/started" &&
      "turnId" in event.scope &&
      event.scope.turnId === range.turnId
        ? Math.min(seq, meta.seq)
        : seq,
    range.sourceSeqStart,
  );
  const details = buildThreadTimelineTurnDetailsFromEvents({
    events: feed.events,
    options: {
      completedTurnDisplay,
      includeDiagnosticOperations: false,
      sourceSeqStart: start,
      sourceSeqEnd: range.sourceSeqEnd,
      threadName,
      threadStatus: feed.working ? "active" : "idle",
      workspaceRoot: null,
    },
  });
  return details.kind === "missing-match" ? null : details.rows;
}
