export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

export const OWNERSHIP_CHANGE_VERBS = {
  assign: "assigned to",
  release: "released from",
  transfer: "transferred to",
} as const;

// `[bb message ...]` is what older senders wrote; accept both tags.
const AGENT_MESSAGE_ENVELOPE_RE =
  /^\[(?:bb )?message from thread:([^;\]\s]+)(?:;[^\]]*)?\]\s*/;

export interface AgentMessageEnvelope {
  bodyStart: number;
  senderThreadId: string;
}

export function parseAgentMessageEnvelope(
  text: string,
): AgentMessageEnvelope | null {
  const match = AGENT_MESSAGE_ENVELOPE_RE.exec(text);
  const senderThreadId = match?.[1];
  return match && senderThreadId
    ? { bodyStart: match[0].length, senderThreadId }
    : null;
}

export function getMessageStartedAt(message: {
  createdAt: number;
  startedAt?: number;
}): number {
  return message.startedAt ?? message.createdAt;
}

export function getFirstStringField(
  record: Record<string, unknown> | null,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function plural(
  count: number,
  singular: string,
  pluralName?: string,
): string {
  return `${count} ${count === 1 ? singular : (pluralName ?? `${singular}s`)}`;
}

export function messageId(threadId: string, kind: string, key: string): string {
  return `${threadId}:${kind}:${key}`;
}

export function durationToCompactString(durationMs: number): string;
export function durationToCompactString(durationMs: undefined): undefined;
export function durationToCompactString(
  durationMs: number | undefined,
): string | undefined {
  if (durationMs === undefined) return undefined;
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0s";
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

const DIFF_COUNT_FORMATTER = new Intl.NumberFormat("en-US");

export function formatDiffCount(value: number): string {
  return DIFF_COUNT_FORMATTER.format(value);
}

export function formatDiffStatsText(input: {
  added: number;
  removed: number;
  hideZero?: boolean;
}): string {
  const addedText = `+${formatDiffCount(input.added)}`;
  const removedText = `-${formatDiffCount(input.removed)}`;
  if (!input.hideZero) return `${addedText} ${removedText}`;
  const parts: string[] = [];
  if (input.added > 0) parts.push(addedText);
  if (input.removed > 0) parts.push(removedText);
  return parts.join(" ");
}

export type TimelinePathDisplayMode = "compact" | "full";

export function fileNameFromPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const lastSlash = normalized.lastIndexOf("/");
  const candidate = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
  return candidate.length > 0 ? candidate : path;
}

export function directoryFromPath(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash === -1 ? "" : path.slice(0, lastSlash);
}

export function formatTimelinePath(
  path: string,
  mode: TimelinePathDisplayMode,
): string {
  return mode === "compact" ? fileNameFromPath(path) : path;
}

export function relativizeWorkspacePath(
  path: string,
  workspaceRoot: string | null,
): string {
  if (!workspaceRoot) return path;
  const root = workspaceRoot.replace(/\/+$/u, "");
  return root.length > 0 && path.startsWith(`${root}/`)
    ? path.slice(root.length + 1)
    : path;
}

export type FileChangeAction = "created" | "deleted" | "renamed" | "edited";

export interface FileChangeLike {
  path: string;
  kind?: string | null;
  movePath?: string | null;
  diff?: string | null;
}

export const FILE_CHANGE_VERBS: Readonly<
  Record<
    FileChangeAction,
    { past: string; present: string; infinitive: string }
  >
> = {
  created: { past: "Created", present: "Creating", infinitive: "create" },
  deleted: { past: "Deleted", present: "Deleting", infinitive: "delete" },
  renamed: { past: "Renamed", present: "Renaming", infinitive: "rename" },
  edited: { past: "Edited", present: "Editing", infinitive: "edit" },
};

const PATCH_META_PREFIXES = [
  "diff --git ",
  "index ",
  "new file mode ",
  "deleted file mode ",
  "similarity index ",
  "rename from ",
  "rename to ",
  "--- ",
  "+++ ",
  "@@",
] as const;

export function isPatchMetadataLine(line: string): boolean {
  const trimmed = line.trimEnd();
  if (trimmed === "\\ No newline at end of file") return true;
  for (const prefix of PATCH_META_PREFIXES) {
    if (trimmed.startsWith(prefix)) return true;
  }
  return false;
}

function hasSubstantiveDiff(diff: string | null | undefined): boolean {
  if (!diff) return false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+") || line.startsWith("-")) return true;
  }
  return false;
}

export function getFileChangeAction(change: FileChangeLike): FileChangeAction {
  if (change.movePath) {
    return hasSubstantiveDiff(change.diff) ? "edited" : "renamed";
  }
  const kind = (change.kind ?? "").toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
  if (kind.includes("add") || kind.includes("create")) return "created";
  if (kind.includes("delete") || kind.includes("remove")) return "deleted";
  return "edited";
}

export function formatFileChangePath(
  change: FileChangeLike,
  mode: TimelinePathDisplayMode,
): string {
  const source = formatTimelinePath(change.path, mode);
  if (!change.movePath) return source;
  if (getFileChangeAction(change) === "edited") {
    return formatTimelinePath(change.movePath, mode);
  }
  return `${source} -> ${formatTimelinePath(change.movePath, mode)}`;
}

export function getFileChangeDiffStats(change: FileChangeLike): {
  added: number;
  removed: number;
} {
  const diff = change.diff;
  if (!diff) return { added: 0, removed: 0 };

  const action = getFileChangeAction(change);
  const lines = diff.split("\n");
  let hasMeta = false;
  let plainLines = 0;
  let added = 0;
  let removed = 0;
  let sawUnified = false;

  for (const line of lines) {
    const isMeta = isPatchMetadataLine(line);
    if (isMeta) {
      hasMeta = true;
    } else if (line.trim().length > 0) {
      plainLines += 1;
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) {
      sawUnified = true;
      added += 1;
    } else if (line.startsWith("-")) {
      sawUnified = true;
      removed += 1;
    }
  }

  if (!hasMeta && (action === "created" || action === "deleted")) {
    return action === "created"
      ? { added: plainLines, removed: 0 }
      : { added: 0, removed: plainLines };
  }
  if (sawUnified) return { added, removed };
  if (action === "created") return { added: plainLines, removed: 0 };
  if (action === "deleted") return { added: 0, removed: plainLines };
  return { added: 0, removed: 0 };
}

/**
 * Line-buffered text accumulator for streamed deltas.
 * Holds incomplete trailing lines until a newline arrives or `flush()` is called.
 */
export interface VisibleTextBuffer {
  pendingChunks: string[];
  pendingLength: number;
  visibleChunks: string[];
  visibleLength: number;
  visibleCache: string | null;
}

export function createVisibleTextBuffer(): VisibleTextBuffer {
  return {
    pendingChunks: [],
    pendingLength: 0,
    visibleChunks: [],
    visibleLength: 0,
    visibleCache: null,
  };
}

export function appendVisibleTextBuffer(
  buf: VisibleTextBuffer,
  delta: string,
): boolean {
  if (delta.length === 0) return false;
  const nl = delta.lastIndexOf("\n");
  if (nl === -1) {
    buf.pendingChunks.push(delta);
    buf.pendingLength += delta.length;
    return true;
  }
  flushVisibleTextBuffer(buf);
  const complete = delta.slice(0, nl + 1);
  buf.visibleChunks.push(complete);
  buf.visibleLength += complete.length;
  if (buf.visibleCache !== null) buf.visibleCache += complete;
  const trailing = delta.slice(nl + 1);
  if (trailing.length > 0) {
    buf.pendingChunks.push(trailing);
    buf.pendingLength += trailing.length;
  }
  return true;
}

export function setVisibleTextBuffer(
  buf: VisibleTextBuffer,
  text: string,
  flushTrailing: boolean,
): void {
  buf.pendingChunks = [];
  buf.pendingLength = 0;
  buf.visibleChunks = [];
  buf.visibleLength = 0;
  buf.visibleCache = null;
  if (text.length === 0) return;

  if (flushTrailing) {
    buf.visibleChunks.push(text);
    buf.visibleLength = text.length;
    buf.visibleCache = text;
    return;
  }
  const nl = text.lastIndexOf("\n");
  if (nl === -1) {
    buf.pendingChunks.push(text);
    buf.pendingLength = text.length;
    return;
  }
  const visible = text.slice(0, nl + 1);
  buf.visibleChunks.push(visible);
  buf.visibleLength = visible.length;
  buf.visibleCache = visible;
  const trailing = text.slice(nl + 1);
  if (trailing.length > 0) {
    buf.pendingChunks.push(trailing);
    buf.pendingLength = trailing.length;
  }
}

export function flushVisibleTextBuffer(buf: VisibleTextBuffer): boolean {
  if (buf.pendingLength === 0) return false;
  if (buf.visibleCache !== null) {
    buf.visibleCache += buf.pendingChunks.join("");
  }
  buf.visibleChunks.push(...buf.pendingChunks);
  buf.visibleLength += buf.pendingLength;
  buf.pendingChunks = [];
  buf.pendingLength = 0;
  return true;
}

export function getVisibleTextBufferFullLength(buf: VisibleTextBuffer): number {
  return buf.visibleLength + buf.pendingLength;
}

export function getVisibleTextBufferFullText(buf: VisibleTextBuffer): string {
  const visible = buf.visibleCache ?? buf.visibleChunks.join("");
  return buf.pendingLength === 0
    ? visible
    : `${visible}${buf.pendingChunks.join("")}`;
}

export function getVisibleTextBufferText(
  buf: VisibleTextBuffer,
): string | undefined {
  if (buf.visibleLength === 0) return undefined;
  if (buf.visibleCache === null) {
    buf.visibleCache = buf.visibleChunks.join("");
  }
  return buf.visibleCache;
}
