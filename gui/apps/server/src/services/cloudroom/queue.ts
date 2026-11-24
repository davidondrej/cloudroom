import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { eq, max } from "drizzle-orm";
import { cloudroomCommands, type DbQueryConnection } from "@cloudroom/db";
import { serviceTierSchema, threadQueuedMessageSchema, type PromptInput, type Thread } from "@cloudroom/domain";
import type { SendMessageRequest, SendMessageResponse } from "@cloudroom/server-contract";
import { ApiError } from "../../errors.js";
import type { CloudroomClient } from "./client.js";
import { appRequestId } from "./cloud-threads.js";
import { cloudPromptLimit, commandReasoning, feature, harnessProfile, promptPayload } from "./protocol.js";
import type { CloudRuntime } from "./runtime.js";
import { sandboxThread } from "./sandboxes.js";
import { binding, command, commands, effectivePrompt, queuedPrompts, saveCommandState, teleportBlocked, unstartedTurn, type Binding, type Command } from "./store.js";

export interface QueueHooks {
  deliver: (threadId: string) => Promise<void>;
  send: (thread: Thread, payload: SendMessageRequest) => Promise<SendMessageResponse>;
  control: (threadId: string, action: "stop" | "resume", offline?: boolean) => Promise<void>;
}

/** Owns the durable Cloud command outbox, attachment uploads, and queued-message CRUD. */
export class CloudQueue {
  constructor(private readonly rt: CloudRuntime, private readonly hooks: QueueHooks) {}

  prompts(threadId: string, preloaded?: Command[]) {
    return (preloaded ?? commands(this.rt.host.db, threadId)).filter((item) => item.command === "prompt" && !JSON.parse(item.input).teleport_handoff);
  }

  currentReasoning(threadId: string, saved: Binding, preloadedPrompts?: Command[]): string {
    return this.rt.host.getExecutionOverride(threadId)?.reasoningLevelOverride ?? commandReasoning((preloadedPrompts ?? this.prompts(threadId)).at(-1)?.input ?? "") ?? saved.reasoning;
  }

  enqueue(threadId: string, id: string, action: Command["command"], input: object, at?: number): void {
    const previous = command(this.rt.host.db, id);
    if (previous) {
      const { customInstructions: _instructions, workspaceContext: _workspace, ...original } = JSON.parse(previous.input);
      if (previous.threadId !== threadId || previous.command !== action || JSON.stringify(original) !== JSON.stringify(input)) {
        throw new ApiError(409, "request_conflict", "Request ID was already used with different content");
      }
      return;
    }
    const thread = this.rt.host.getThread(threadId);
    if (!thread || !binding(this.rt.host.db, threadId)) throw new ApiError(409, "cloudroom_missing_binding", "Cloud session is unavailable");
    this.insertCommand(this.rt.host.db, thread, id, action, input, at);
    this.rt.notify(threadId);
  }

  insertCommand(db: DbQueryConnection, thread: Thread, id: string, action: Command["command"], input: object, at?: number): void {
    const createdAt = at ?? Math.max(Date.now(), (db.select({ at: max(cloudroomCommands.createdAt) }).from(cloudroomCommands).where(eq(cloudroomCommands.threadId, thread.id)).get()?.at ?? 0) + 1);
    db.insert(cloudroomCommands).values({ id, threadId: thread.id, command: action, input: JSON.stringify(this.rt.host.snapshotInstructions(db, thread, action, input)), createdAt }).run();
  }

  async uploadAttachments(
    client: CloudroomClient,
    sessionId: string,
    promptId: string,
    attachments: { name: string; kind: "image" | "file"; localPath?: string; path?: string; id?: string }[],
    projectId: string,
    parts: boolean,
  ) {
    const uploaded = [];
    for (const [index, attachment] of attachments.entries()) {
      if (attachment.path) { uploaded.push({ id: attachment.id, name: attachment.name, kind: attachment.kind, path: attachment.path }); continue; }
      if (!attachment.localPath) continue;
      const root = join(this.rt.host.config.dataDir, "attachments", projectId);
      const candidate = attachment.localPath.startsWith("/") || (process.platform === "win32" && win32.isAbsolute(attachment.localPath)) ? attachment.localPath : join(root, attachment.localPath);
      const bytes = await readFile(candidate);
      const attachmentId = `${promptId}a${index}`;
      const id = attachmentId.length <= 64 ? attachmentId : createHash("sha256").update(attachmentId).digest("hex");
      const name = attachment.name.replace(/[^a-zA-Z0-9._-]+/g, "-") || "attachment";
      // Cores with upload_parts take files in pieces small enough for every sandbox proxy.
      const accepted = parts
        ? await client.attachInParts(sessionId, id, name, attachment.kind, bytes)
        : await client.attach(sessionId, id, name, attachment.kind, { body: new Blob([bytes]).stream(), length: bytes.byteLength });
      const input = accepted.receipt.input as { id?: string; path?: string };
      uploaded.push({ id: input.id ?? accepted.receipt.request_id, name: attachment.name, kind: attachment.kind, path: String(input.path ?? "") });
    }
    return uploaded;
  }

  async queueMessage(thread: Thread, payload: SendMessageRequest) {
    if (teleportBlocked(this.rt.host.db, thread.id)) throw new ApiError(409, "teleport_in_progress", "Messages are disabled until Teleport finishes.");
    const id = await this.rt.requestId(thread.id, payload.requestId);
    await this.hooks.send(thread, { ...payload, requestId: id });
    return this.queuedMessage(binding(this.rt.host.db, thread.id)!, command(this.rt.host.db, id)!);
  }

  /** `unsent` adds messages that never reached Core, such as ones sent while the sandbox could not start. */
  queue(threadId: string, unsent = false) {
    const saved = binding(this.rt.host.db, threadId);
    if (!saved) return [];
    return queuedPrompts(this.rt.host.db, threadId, unsent).map((c) => this.queuedMessage(saved, c));
  }

  private queuedMessage(saved: Binding, c: Command) {
    const stored = effectivePrompt(this.rt.host.db, saved.threadId, c.id, true) as { text?: string; content?: PromptInput[]; revision?: number; service_tier?: string };
    const revision = stored.revision ?? 1;
    const capabilities = sandboxThread(saved.coreUrl) ? this.rt.sandboxCapabilities : this.rt.lastCapabilities;
    return threadQueuedMessageSchema.parse({
      id: c.id, threadId: saved.threadId, initiator: "user", senderThreadId: null,
      content: Array.isArray(stored.content) ? stored.content : [{ type: "text", text: stored.text ?? "", mentions: [] }],
      model: saved.model, reasoningLevel: commandReasoning(c.input) ?? saved.reasoning, permissionMode: "full",
      serviceTier: serviceTierSchema.catch("default").parse(stored.service_tier),
      sendAt: null, waitingOn: null, failureReason: null, payload: { kind: "inline" },
      editable: (c.state === "sending" || c.state === "accepted") && capabilities?.queue_edit === true,
      pausedByStop: this.stopHeld(saved), createdAt: c.createdAt, updatedAt: c.createdAt + revision - 1,
    });
  }

  /** Stop pauses Core's queue until a resume, even across turns Core starts itself (#967). Only the session that Stop
   *  paused shows it, and a resume sent after that Stop, still on its way, already lifts it. Delivery never reads this. */
  private stopHeld(saved: Binding): boolean {
    const stop = this.rt.peek(saved.threadId)?.stopReceipt;
    return saved.queuePaused && stop?.session === saved.sessionId && !commands(this.rt.host.db, saved.threadId).some((c) => c.command === "resume" && c.createdAt >= stop.at && ["sending", "accepted"].includes(c.state) && !JSON.parse(c.input).keep_paused);
  }

  async editQueued(thread: Thread, queuedMessageId: string, payload: { input: PromptInput[]; expectedUpdatedAt: number }) {
    const saved = binding(this.rt.host.db, thread.id);
    const current = command(this.rt.host.db, queuedMessageId);
    if (!saved || !current || current.threadId !== thread.id || current.command !== "prompt" || (current.state !== "sending" && current.state !== "accepted")) {
      throw new ApiError(404, "invalid_request", "Queued message not found");
    }
    const capabilities = await this.rt.queueCapabilities(saved);
    if (!feature(capabilities, "queue_edit")) throw new ApiError(409, "cloudroom_unsupported", "Cloud queue editing is not enabled.");
    const stored = effectivePrompt(this.rt.host.db, thread.id, current.id, true);
    const revision = Number(stored.revision ?? 1);
    const expectedRevision = payload.expectedUpdatedAt - current.createdAt + 1;
    const parsed = promptPayload(payload.input, thread.providerId, capabilities.attachments && (harnessProfile(capabilities, thread.providerId)?.attachments ?? true), cloudPromptLimit(capabilities));
    const input = { target_request_id: queuedMessageId, expected_revision: expectedRevision, ...parsed, reasoning: stored.reasoning ?? saved.reasoning, service_tier: stored.service_tier ?? "default" };
    const id = appRequestId(await this.rt.me(), `qe_${createHash("sha256").update(JSON.stringify([thread.id, input])).digest("hex").slice(0, 60)}`);
    const previous = command(this.rt.host.db, id);
    if (expectedRevision !== revision && !previous) throw new ApiError(409, "invalid_request", "Queued message changed since editing began");
    this.enqueue(thread.id, id, "edit", input);
    const delivery = this.hooks.deliver(thread.id);
    if (current.state === "accepted") await delivery;
    else void delivery.catch(() => {});
    const outcome = command(this.rt.host.db, id)?.state;
    if (outcome !== "accepted" && outcome !== "completed" && !(outcome === "sending" && current.state === "sending")) {
      throw new ApiError(409, "cloudroom_command_failed", "The queue edit was not confirmed. Refresh the queue before retrying.");
    }
    return this.queuedMessage(binding(this.rt.host.db, thread.id)!, command(this.rt.host.db, queuedMessageId)!);
  }

  async cancelQueued(thread: Thread, queuedMessageId: string) {
    const saved = binding(this.rt.host.db, thread.id);
    const current = command(this.rt.host.db, queuedMessageId);
    // Only a queued message: never the first prompt or the turn the thread is on, which the chat already shows.
    if (!saved || !current || current.threadId !== thread.id || current.command !== "prompt" || (current.state !== "sending" && current.state !== "accepted")
      || current.id === `first_${thread.id}` || current.id === saved.turnId || JSON.parse(current.input).teleport_handoff) {
      throw new ApiError(404, "invalid_request", "Queued message not found");
    }
    await this.rt.requireOwnThread(saved);
    // Before its session starts, Core has never seen a follow-up, so it is removed here without waking anything (#866).
    // Read from saved state, whatever the thread's status: a failed start hides its queue but a retry still sends it.
    // Check and write with no await between: delivery saves the session before it reads which prompts to send.
    const target = command(this.rt.host.db, queuedMessageId);
    if (!binding(this.rt.host.db, thread.id)?.sessionId && target?.state === "sending") {
      saveCommandState(this.rt.host.db, thread.id, queuedMessageId, "cancelled");
      return this.rt.notify(thread.id);
    }
    if (!feature(await this.rt.queueCapabilities(saved), "queue_cancel")) throw new ApiError(409, "cloudroom_unsupported", "Cloud queue cancellation is not enabled.");
    const id = randomUUID();
    this.enqueue(thread.id, id, "cancel", { target_request_id: queuedMessageId });
    const delivery = this.hooks.deliver(thread.id);
    // A message Core never confirmed is not sent while its delete is on its way, so that delete is done once saved.
    if (command(this.rt.host.db, queuedMessageId)?.state === "sending") return void delivery.catch(() => {});
    // One Core holds waits for Core's answer. A sandbox that can't take the delete yet gets it once it can: it is
    // saved, and the message stays out of the queue meanwhile. Other work failing in the same pass is not this delete's.
    await delivery.catch((error: unknown) => {
      if (command(this.rt.host.db, id)?.state === "sending" && !(error instanceof ApiError && error.status === 503)) throw error;
    });
    if (command(this.rt.host.db, id)?.state === "failed") throw new ApiError(409, "queued_message_started", "Too late: the agent already started this message.");
  }

  /** Settles a delete Core refused. True when Core never confirmed the message, or it is deleted already: the delete
   *  wins and the message is never sent. False when Core took the message, so only Core can delete it. */
  dropUnsent(threadId: string, cancel: Command): boolean {
    return this.rt.host.db.transaction((tx) => {
      const target = command(tx, JSON.parse(cancel.input).target_request_id);
      if (target?.threadId !== threadId || !["sending", "cancelled"].includes(target.state)) return false;
      if (target.state === "sending") {
        saveCommandState(tx, threadId, target.id, "cancelled");
        // It may have carried the custom instructions; the next message must.
        if (JSON.parse(target.input).customInstructions) this.rt.host.markInstructionsLost(tx, threadId);
      }
      saveCommandState(tx, threadId, cancel.id, "completed");
      return true;
    });
  }

  async reorderQueued(thread: Thread, request: { queuedMessageId: string; previousQueuedMessageId: string | null; nextQueuedMessageId: string | null }) {
    const saved = binding(this.rt.host.db, thread.id);
    const queue = this.queue(thread.id);
    if (!saved || !queue.some((item) => item.id === request.queuedMessageId)) throw new ApiError(404, "invalid_request", "Queued message not found");
    const capabilities = await this.rt.queueCapabilities(saved);
    if (!feature(capabilities, "queue_reorder")) throw new ApiError(409, "cloudroom_unsupported", "Update the cloud core to reorder queued messages.");
    const order = queue.map((item) => item.id).filter((id) => id !== request.queuedMessageId);
    const neighbor = request.previousQueuedMessageId ?? request.nextQueuedMessageId;
    if (neighbor !== null && !order.includes(neighbor)) throw new ApiError(409, "invalid_request", "Queued message order changed");
    order.splice(request.previousQueuedMessageId !== null ? order.indexOf(request.previousQueuedMessageId) + 1 : request.nextQueuedMessageId !== null ? order.indexOf(request.nextQueuedMessageId) : 0, 0, request.queuedMessageId);
    if (order.every((id, index) => id === queue[index]!.id)) return queue;
    const id = randomUUID();
    this.enqueue(thread.id, id, "reorder", { order });
    await this.hooks.deliver(thread.id);
    const outcome = command(this.rt.host.db, id)?.state;
    if (outcome !== "accepted" && outcome !== "completed") throw new ApiError(409, "cloudroom_command_failed", "The queue reorder was not confirmed. Refresh the queue before retrying.");
    return this.queue(thread.id);
  }

  async sendQueued(thread: Thread, queuedMessageId: string): Promise<SendMessageResponse> {
    const saved = binding(this.rt.host.db, thread.id);
    const queue = this.queue(thread.id);
    const queued = queue.find((item) => item.id === queuedMessageId);
    if (!saved || !queued) {
      // Core may deliver a queued prompt before its send arrives (#1203). Say so, and never send it again. `running`
      // only means the turn is starting: preparing it can still fail before the harness gets the prompt.
      const sent = command(this.rt.host.db, queuedMessageId);
      if (saved && sent?.threadId === thread.id && sent.command === "prompt" && ["delivered", "completed", "interrupted"].includes(sent.state)) return { ok: true, delivery: "sent" };
      throw new ApiError(404, "invalid_request", "Queued message not found");
    }
    const active = thread.status === "active" && saved.turnId !== null && !unstartedTurn(this.rt.host.db, thread.id);
    if (active) {
      const capabilities = await this.rt.queueCapabilities(saved);
      if (feature(capabilities, "steer") && feature(capabilities, "queue_cancel") && harnessProfile(capabilities, thread.providerId)?.steer !== false) {
        await this.hooks.send(thread, { mode: "steer", input: queued.content });
        await this.cancelQueued(thread, queuedMessageId).catch(() => {});
        return { ok: true, delivery: "sent" };
      }
    }
    if (queue[0]!.id !== queuedMessageId) throw new ApiError(409, "invalid_request", "This Cloud agent sends queued messages in order. Send or delete the earlier messages first.");
    // Over a plan limit this fails as a whole, never cancelling the message to send.
    if (active) await this.hooks.control(thread.id, "stop", false);
    await this.hooks.control(thread.id, "resume");
    return { ok: true, delivery: "queued", queuedMessage: { ...queued, pausedByStop: false } };
  }
}
