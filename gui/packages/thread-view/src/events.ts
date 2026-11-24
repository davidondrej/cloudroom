import {
  getThreadEventScopeTurnId,
  requireThreadEventScopeTurnId,
  type ClientTurnRequestId,
  type PromptInput,
  type PromptTextMention,
  type ThreadEvent,
} from "@cloudroom/domain";
import { assertNever } from "./utils.js";

export interface EventMeta {
  id: string;
  seq: number;
  createdAt: number;
}

export interface ThreadEventWithMeta {
  event: ThreadEvent;
  meta: EventMeta;
}

export interface AcceptedClientRequest {
  meta: EventMeta;
  turnId: string;
}

export interface AcceptedClientRequestContext {
  acceptedClientRequestEvents: readonly ThreadEventWithMeta[];
  rejectedClientRequestEvents: readonly ThreadEventWithMeta[];
}

export const EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT: AcceptedClientRequestContext =
  {
    acceptedClientRequestEvents: [],
    rejectedClientRequestEvents: [],
  };

export function orderEvents(
  events: readonly ThreadEventWithMeta[],
): readonly ThreadEventWithMeta[] {
  for (let i = 1; i < events.length; i += 1) {
    if (events[i - 1]!.meta.seq > events[i]!.meta.seq) {
      return [...events].sort((a, b) => a.meta.seq - b.meta.seq);
    }
  }
  return events;
}

export function buildAcceptedClientRequestById(
  context: AcceptedClientRequestContext,
  events: readonly ThreadEventWithMeta[],
): Map<ClientTurnRequestId, AcceptedClientRequest> {
  const byId = new Map<ClientTurnRequestId, AcceptedClientRequest>();
  const scan = (list: readonly ThreadEventWithMeta[]) => {
    for (const { event, meta } of list) {
      if (event.type !== "turn/input/accepted") continue;
      if (byId.has(event.clientRequestId)) continue;
      byId.set(event.clientRequestId, {
        meta,
        turnId: requireThreadEventScopeTurnId({
          type: event.type,
          scope: event.scope,
        }),
      });
    }
  };
  scan(events);
  scan(context.acceptedClientRequestEvents);
  return byId;
}

export function buildRejectedClientRequestById(
  context: AcceptedClientRequestContext,
  events: readonly ThreadEventWithMeta[],
): Map<ClientTurnRequestId, EventMeta> {
  const byId = new Map<ClientTurnRequestId, EventMeta>();
  const scan = (list: readonly ThreadEventWithMeta[]) => {
    for (const { event, meta } of list) {
      if (event.type === "client/turn/rejected" && !byId.has(event.requestId)) {
        byId.set(event.requestId, meta);
      }
    }
  };
  scan(events);
  scan(context.rejectedClientRequestEvents);
  return byId;
}

export function getEventTurnId(event: ThreadEvent): string | undefined {
  return getThreadEventScopeTurnId(event.scope);
}

export function getEventProviderThreadId(
  event: ThreadEvent,
): string | undefined {
  switch (event.type) {
    case "thread/identity":
    case "turn/started":
    case "turn/input/accepted":
    case "thread/name/updated":
    case "thread/compacted":
    case "thread/context/cleared":
    case "thread/goal/updated":
    case "thread/goal/cleared":
    case "item/started":
    case "item/completed":
    case "item/backgroundTask/progress":
    case "item/backgroundTask/completed":
    case "item/delegation/progress":
    case "item/delegation/completed":
    case "item/agentMessage/delta":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
    case "item/plan/delta":
    case "item/mcpToolCall/progress":
    case "item/toolCall/progress":
    case "thread/tokenUsage/updated":
    case "thread/contextWindowUsage/updated":
    case "turn/plan/updated":
    case "turn/diff/updated":
    case "provider/error":
    case "provider/warning":
    case "provider/modelFallback":
    case "provider/rateLimits/updated":
    case "provider.env-resolved":
    case "thread/extensionState/updated":
    case "provider/unhandled":
      return event.providerThreadId;
    case "turn/completed":
      return event.providerThreadId ?? undefined;
    case "thread/started":
    case "client/thread/start":
    case "client/turn/requested":
    case "client/turn/rejected":
    case "client/turn/start":
    case "system/error":
    case "system/manager/user_message":
    case "system/thread/interrupted":
    case "system/operation":
    case "system/interaction/lifecycle":
    case "system/permissionGrant/lifecycle":
    case "system/userQuestion/lifecycle":
    case "system/thread-provisioning":
    case "system/provider-turn-watchdog":
      return undefined;
    default:
      return assertNever(event);
  }
}

export function getEventParentToolCallId(
  event: ThreadEvent,
): string | undefined {
  switch (event.type) {
    case "item/started":
    case "item/completed":
    case "item/backgroundTask/progress":
    case "item/backgroundTask/completed":
    case "item/delegation/progress":
    case "item/delegation/completed":
      return event.item.parentToolCallId;
    case "item/agentMessage/delta":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
    case "item/plan/delta":
    case "item/mcpToolCall/progress":
    case "item/toolCall/progress":
    case "provider/unhandled":
    case "turn/started":
      return event.parentToolCallId;
    case "thread/started":
    case "thread/identity":
    case "turn/completed":
    case "turn/input/accepted":
    case "thread/name/updated":
    case "thread/compacted":
    case "thread/context/cleared":
    case "thread/goal/updated":
    case "thread/goal/cleared":
    case "thread/tokenUsage/updated":
    case "thread/contextWindowUsage/updated":
    case "turn/plan/updated":
    case "turn/diff/updated":
    case "provider/error":
    case "provider/warning":
    case "provider/modelFallback":
    case "provider/rateLimits/updated":
    case "provider.env-resolved":
    case "thread/extensionState/updated":
    case "client/thread/start":
    case "client/turn/requested":
    case "client/turn/rejected":
    case "client/turn/start":
    case "system/error":
    case "system/manager/user_message":
    case "system/thread/interrupted":
    case "system/operation":
    case "system/interaction/lifecycle":
    case "system/permissionGrant/lifecycle":
    case "system/userQuestion/lifecycle":
    case "system/thread-provisioning":
    case "system/provider-turn-watchdog":
      return undefined;
    default:
      return assertNever(event);
  }
}

export interface ParsedPromptInput {
  text: string;
  webImages: number;
  localImages: number;
  localFiles: number;
  imageUrls: string[];
  localImagePaths: string[];
  localFilePaths: string[];
  mentions: PromptTextMention[];
}

export function parsePromptInput(
  input: ReadonlyArray<PromptInput> | undefined,
): ParsedPromptInput | null {
  if (!Array.isArray(input) || input.length === 0) return null;

  const textParts: string[] = [];
  const imageUrls: string[] = [];
  const localImagePaths: string[] = [];
  const localFilePaths: string[] = [];
  const mentions: PromptTextMention[] = [];
  let webImages = 0;
  let localImages = 0;
  let localFiles = 0;
  let offset = 0;

  for (const part of input) {
    if (part.visibility === "agent-only") continue;
    switch (part.type) {
      case "text":
        if (part.text.length > 0) {
          if (part.mentions) {
            for (const m of part.mentions) {
              if (m.start >= 0 && m.end > m.start && m.end <= part.text.length) {
                mentions.push({
                  ...m,
                  start: offset + m.start,
                  end: offset + m.end,
                });
              }
            }
          }
          textParts.push(part.text);
          offset += part.text.length;
        }
        break;
      case "image":
        webImages += 1;
        if (part.url.length > 0) imageUrls.push(part.url);
        break;
      case "localImage":
        localImages += 1;
        if (part.path.length > 0) localImagePaths.push(part.path);
        break;
      case "localFile":
        localFiles += 1;
        if (part.path.length > 0) localFilePaths.push(part.path);
        break;
    }
  }

  const text = textParts.join("");
  if (!text && webImages === 0 && localImages === 0 && localFiles === 0) {
    return null;
  }
  return {
    text,
    webImages,
    localImages,
    localFiles,
    imageUrls,
    localImagePaths,
    localFilePaths,
    mentions,
  };
}

export interface BufferedTextIdentity {
  itemId: string;
  kind: "assistant" | "reasoning";
  parentToolCallId: string | null;
  turnId: string;
}

export function bufferedTextKey(id: BufferedTextIdentity): string {
  return `kind:${id.kind}|turn:${id.turnId}|parent:${id.parentToolCallId ?? "root"}|item:${id.itemId}`;
}

export function resolveBufferedTextIdentity(
  event: ThreadEvent,
  kind: "assistant" | "reasoning",
  turnIdOverride?: string,
  parentToolCallIdOverride?: string,
): BufferedTextIdentity | null {
  const turnId = turnIdOverride ?? getEventTurnId(event);
  if (!turnId) return null;

  let itemId: string | null = null;
  if (kind === "assistant") {
    if (
      event.type === "item/agentMessage/delta" ||
      event.type === "item/plan/delta"
    ) {
      itemId = event.itemId;
    } else if (
      event.type === "item/completed" &&
      (event.item.type === "agentMessage" || event.item.type === "plan")
    ) {
      itemId = event.item.id;
    }
  } else {
    if (
      event.type === "item/reasoning/summaryTextDelta" ||
      event.type === "item/reasoning/textDelta"
    ) {
      itemId = event.itemId;
    } else if (
      (event.type === "item/started" || event.type === "item/completed") &&
      event.item.type === "reasoning"
    ) {
      itemId = event.item.id;
    }
  }
  if (itemId === null) return null;

  return {
    itemId,
    kind,
    parentToolCallId:
      parentToolCallIdOverride ?? getEventParentToolCallId(event) ?? null,
    turnId,
  };
}
