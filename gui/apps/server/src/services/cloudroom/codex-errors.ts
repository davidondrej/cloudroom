import { MAX_ERROR_TITLE_LENGTH } from "@cloudroom/thread-view";
import type { SessionRecord } from "./client.js";

// A ChatGPT login never sends an `sk-` key, so this rejection comes from OpenAI's own backend key.
const OPENAI_SIDE_401 = /401 Unauthorized: Incorrect API key provided: sk-[\s\S]*chatgpt\.com\/backend-api\/codex/;

export const mentionsOpenAISide401 = (record: SessionRecord): boolean =>
  OPENAI_SIDE_401.test(record.native ?? JSON.stringify(record.data));

/** Friendly title for known OpenAI-side failures; the raw Codex text stays available as detail. */
export function codexErrorFields(raw: string, outage: boolean): { message: string; detail?: string } {
  if (!OPENAI_SIDE_401.test(raw)) return { message: raw };
  return {
    message: outage
      ? "OpenAI says Codex is having issues right now."
      : "OpenAI rejected the request. Likely an OpenAI issue, not your login.",
    detail: raw,
  };
}

/** A Codex `error` frame (#949). A retry is a Reconnecting row with its cause. The final error keeps Codex's code, HTTP
 *  status and extra details and says Codex reported it; a message too long for the card's title moves to the detail. */
export function codexErrorFrameFields(raw: string, error: Record<string, unknown>, willRetry: unknown, outage: boolean): { code?: string; message: string; detail?: string } {
  const extra = typeof error.additionalDetails === "string" && error.additionalDetails.trim() ? error.additionalDetails : null;
  if (willRetry === true) return { code: "provider_reconnect", message: raw.trim() || "Reconnecting…", ...(extra ? { detail: extra } : {}) };
  const info = error.codexErrorInfo;
  const [code, value] = typeof info === "string" ? [info] : info && typeof info === "object" && !Array.isArray(info) ? Object.entries(info)[0] ?? [] : [];
  const status = value && typeof value === "object" && "httpStatusCode" in value && typeof value.httpStatusCode === "number" ? `, HTTP ${value.httpStatusCode}` : "";
  const tag = code && code !== "other" ? ` (${code}${status})` : "";
  const { message, detail } = codexErrorFields(raw, outage);
  const long = message.length > MAX_ERROR_TITLE_LENGTH;
  const source = long ? null : tag ? `Reported by Codex${tag}.` : "Reported by Codex, with no specific error code.";
  return { ...(code ? { code } : {}), message: long ? `Codex error${tag}` : message, detail: [long && message, detail, extra, source].filter(Boolean).join("\n\n") };
}
