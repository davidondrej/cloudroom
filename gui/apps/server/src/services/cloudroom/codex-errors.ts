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
