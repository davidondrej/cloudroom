import type { Thread } from "@cloudroom/domain";
import { z } from "zod";

export const threadAccessSchema = z.enum(["off", "read", "full"]);
export type ThreadAccess = z.infer<typeof threadAccessSchema>;
export const threadAccessSettingSchema = z.object({ level: threadAccessSchema });

export const THREAD_REQUEST_MS = 20_000;
export const THREAD_EVENTS = 20_000;
export const SEARCH_LIMIT = 50;
const id = z.string().min(1).max(80);
const thread = z.string().regex(/^thr_[A-Za-z0-9_-]{1,60}$/);
export const threadRequestSchema = z.discriminatedUnion("action", [
  z.object({ id, action: z.literal("read"), thread, all: z.boolean().default(false) }),
  z.object({ id, action: z.literal("tell"), thread, text: z.string().min(1).max(262_144), key: z.string().max(64).optional() }),
  z.object({ id, action: z.literal("search"), search: z.string().min(1).max(200), archived: z.boolean().default(false) }),
]);
export type ThreadRequest = z.infer<typeof threadRequestSchema>;

const ANSWER_BYTES = 900_000;
const MESSAGE_BYTES = 64_000;
const REPLY_BYTES = 200_000;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const clip = (text: string, limit: number) => Buffer.byteLength(text) <= limit ? text : `${Buffer.from(text).subarray(0, limit).toString("utf8").replace(/�+$/, "")}…`;
export const threadTitle = (row: { title: string | null; titleFallback: string | null }) => row.title || row.titleFallback || "Untitled thread";

/** Why a Cloud agent may not reach a thread outside its own tree, or null (ADR 0286): the account's level, then the key
 *  list of the sandbox it runs in (`keyList`). Only a sandbox confirmed to have none may: one with a list (a Cloud
 *  loop's run, its children and forks, ADR 0342) may be steered by the data it reads, and these threads may hold every
 *  key and the Mac (#1239). Like the Mac helper's (core/src/helper/jobs.rs `limited`) and the website's (web/lib/mobile.ts). */
export function accessRefusal(level: ThreadAccess, action: ThreadRequest["action"], keys: string[] | null | undefined): string | null {
  if (level === "off") return "The user turned off thread access in Settings > Cloud: agents can't read or message their other threads.";
  if (level === "read" && action === "tell") return "The user allows reading other threads, not messaging them (Settings > Cloud > Thread access).";
  if (keys === null) return null;
  return keys
    ? "This sandbox has only the API keys picked for its Cloud loop, so it can't read, search or message the user's other threads. Do not retry. Its own subagents and `room-cli thread tell --parent` still work. If the loop needs other threads, the user can give it all secrets in its Secrets row. That applies from its next run."
    : "Cloudroom couldn't confirm this sandbox's API keys, so it didn't reach the other thread. Try again.";
}

export function chatAnswer(target: Thread, messages: { role: string; text: string }[], cut: boolean, all: boolean) {
  const latest = [...messages].reverse().find((message) => message.role === "agent")?.text;
  const head = { id: target.id, title: threadTitle(target), state: target.archivedAt ? "archived" : target.status, reply: latest === undefined ? null : clip(latest, all ? 4_000 : REPLY_BYTES), truncated: cut };
  if (!all) return head;
  const clipped = messages.map((message) => ({ role: message.role, text: clip(message.text, MESSAGE_BYTES) }));
  let room = ANSWER_BYTES - bytes(head), start = clipped.length;
  while (start > 0 && room - bytes(clipped[start - 1]) - 1 > 0) room -= bytes(clipped[--start]) + 1;
  return { ...head, truncated: cut || start > 0, messages: clipped.slice(start) };
}

export function searchAnswer(rows: { id: string; title: string | null; titleFallback: string | null; status: string; parent: string | null; archivedAt: number | null }[]) {
  return {
    threads: rows.slice(0, SEARCH_LIMIT).map((row) => ({ id: row.id, title: threadTitle(row), state: row.archivedAt ? "archived" : row.status, parent: row.parent, machine: "local" })),
    more: rows.length > SEARCH_LIMIT,
  };
}
