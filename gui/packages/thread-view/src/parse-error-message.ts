import { resolveSystemErrorReconnectProgress } from "@cloudroom/domain";
import type { ThreadEvent } from "@cloudroom/domain";
import type { EventMeta } from "./event-decode.js";
import { messageId } from "./format-helpers.js";
import type { EventProjectionErrorMessage } from "./event-projection-types.js";

const CODEX_POLICY_CODES = new Set([
  "cyberPolicy",
  "misalignmentPolicyViolation",
]);

export function parseErrorMessage(
  decoded: ThreadEvent,
  meta: EventMeta,
): EventProjectionErrorMessage | null {
  if (decoded.type !== "provider/error" && decoded.type !== "system/error")
    return null;

  const { message, detail } = decoded;
  const reconnectState =
    decoded.type === "system/error"
      ? resolveSystemErrorReconnectProgress(decoded)
      : null;
  return {
    kind: "error",
    id: messageId(decoded.threadId, "error", `${meta.seq}`),
    threadId: decoded.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    scope: decoded.scope,
    rawType: decoded.type,
    message: message || "Error event",
    detail: detail && detail !== message ? detail : null,
    ...(decoded.type === "provider/error" && decoded.errorInfo
      ? { providerErrorInfo: decoded.errorInfo }
      : {}),
    // Cloud threads keep Codex's own code: label its refusals like Local ones (provider-codex delta-translation.ts).
    ...(decoded.type === "system/error" &&
    CODEX_POLICY_CODES.has(decoded.code ?? "")
      ? {
          providerErrorInfo: {
            category: "policy" as const,
            providerCode: decoded.code ?? null,
            httpStatusCode: null,
          },
        }
      : {}),
    ...(decoded.type === "provider/error" && decoded.willRetry !== undefined
      ? { willRetry: decoded.willRetry }
      : {}),
    // A retry is a Reconnecting row whatever its wording (#949).
    ...(decoded.type === "system/error" && decoded.code === "provider_reconnect"
      ? { willRetry: true }
      : {}),
    ...(reconnectState
      ? {
          reconnectAttempt: reconnectState.attempt,
          reconnectTotal: reconnectState.total,
        }
      : {}),
  };
}
