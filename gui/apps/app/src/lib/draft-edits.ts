import type { PromptInput } from "@cloudroom/domain";

const STORAGE_PREFIX = "cloudroom-draft-edit";

export interface DraftNote {
  tag: string;
  text: string;
  start: number;
  end: number;
}

/** What the user did to one ```draft block: its text now, the text last sent to the agent, and pending notes. */
export interface DraftRecord {
  original: string;
  text: string;
  sent: string | null;
  notes: DraftNote[];
}

function hash(text: string): string {
  let value = 5381;
  for (let index = 0; index < text.length; index += 1) {
    value = ((value << 5) + value + text.charCodeAt(index)) | 0;
  }
  return (value >>> 0).toString(36);
}

/** `block` tells apart drafts with the same text in one message, for example by their position in it. */
export function draftStorageKey(
  threadId: string,
  messageId: string,
  original: string,
  block: string,
): string {
  return `${STORAGE_PREFIX}:${threadId}:${messageId}:${hash(original)}:${block}`;
}

const memory = new Map<string, DraftRecord | null>();

function parseDraft(raw: string | null): DraftRecord | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<DraftRecord>;
    if (typeof value.original !== "string" || typeof value.text !== "string") {
      return null;
    }
    return {
      original: value.original,
      text: value.text,
      sent: typeof value.sent === "string" ? value.sent : null,
      notes: Array.isArray(value.notes) ? value.notes : [],
    };
  } catch {
    return null;
  }
}

export function readDraft(key: string): DraftRecord | null {
  if (memory.has(key)) return memory.get(key) ?? null;
  try {
    return parseDraft(window.localStorage.getItem(key));
  } catch {
    return null;
  }
}

/** Keeps the record for this session even when the browser cannot store it; false when it was not saved to disk. */
export function writeDraft(key: string, record: DraftRecord): boolean {
  const empty =
    record.text === record.original &&
    record.sent === null &&
    record.notes.length === 0;
  memory.set(key, empty ? null : record);
  try {
    if (empty) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** True when the agent has not seen the user's latest version of this draft. */
function hasUnsentEdits(record: DraftRecord | null): boolean {
  return record !== null && record.text !== (record.sent ?? record.original);
}

function threadDraftKeys(threadId: string): string[] {
  const prefix = `${STORAGE_PREFIX}:${threadId}:`;
  const keys = new Set(
    [...memory.keys()].filter((key) => key.startsWith(prefix)),
  );
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(prefix)) keys.add(key);
    }
  } catch {
    return [...keys];
  }
  return [...keys];
}

function isCommand(input: readonly PromptInput[]): boolean {
  const first = input.find((part) => part.type === "text");
  return first?.type === "text" && first.text.trimStart().startsWith("/");
}

/**
 * Adds the final text of every draft in this thread that the user changed
 * since it last went out. Call `commit` once the message was accepted.
 * Slash commands go out unchanged and leave the edits for the next message.
 */
export function withDraftEdits(
  threadId: string,
  input: PromptInput[],
): { input: PromptInput[]; commit: () => void } {
  const unchanged = { input, commit: () => {} };
  if (input.length === 0 || isCommand(input)) return unchanged;
  const pending = threadDraftKeys(threadId).flatMap((key) => {
    const record = readDraft(key);
    return record !== null && hasUnsentEdits(record)
      ? [{ key, text: record.text }]
      : [];
  });
  if (pending.length === 0) return unchanged;
  const text = pending
    .map((draft) => `<edited_draft>\n${draft.text}\n</edited_draft>`)
    .join("\n\n");
  return {
    input: [{ type: "text", text: `${text}\n\n`, mentions: [] }, ...input],
    commit: () => {
      for (const draft of pending) {
        const current = readDraft(draft.key);
        if (current !== null)
          writeDraft(draft.key, { ...current, sent: draft.text });
      }
    },
  };
}

export interface DiffPart {
  kind: "same" | "del" | "ins";
  text: string;
}

interface Token {
  text: string;
  space: boolean;
}

function tokens(text: string): Token[] {
  return [
    ...text.matchAll(/(\s*)([\p{L}\p{N}'’%$@&#*/+-]+|[^\s\p{L}\p{N}])/gu),
  ].map((match) => ({
    text: match[2] ?? "",
    space: (match[1] ?? "").length > 0,
  }));
}

/** Word-level changes from `before` to `after`, as runs of kept, removed and added text. */
export function diffWords(before: string, after: string): DiffPart[] {
  const a = tokens(before.trim());
  const b = tokens(after.trim());
  if (a.length * b.length > 250_000) {
    return [
      { kind: "del", text: before.trim() },
      { kind: "ins", text: ` ${after.trim()}` },
    ];
  }
  const cols = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * cols + j] =
        a[i]!.text === b[j]!.text
          ? lcs[(i + 1) * cols + j + 1]! + 1
          : Math.max(lcs[(i + 1) * cols + j]!, lcs[i * cols + j + 1]!);
    }
  }
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], token: Token) => {
    const text = `${token.space && parts.length > 0 ? " " : ""}${token.text}`;
    const last = parts.at(-1);
    if (last?.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i]!.text === b[j]!.text) {
      push("same", b[j]!);
      i += 1;
      j += 1;
    } else if (
      j >= b.length ||
      (i < a.length && lcs[(i + 1) * cols + j]! >= lcs[i * cols + j + 1]!)
    ) {
      push("del", a[i]!);
      i += 1;
    } else {
      push("ins", b[j]!);
      j += 1;
    }
  }
  return parts;
}

export function wordCount(text: string): number {
  return text.split(/\s+/u).filter((word) => word.length > 0).length;
}
