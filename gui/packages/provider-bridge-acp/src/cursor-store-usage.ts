import type { ContextCategory, ContextSnapshot } from "@cloudroom/domain";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface AcpContextUsageReading {
  used: number;
  size: number;
  estimated: boolean;
  snapshot?: ContextSnapshot;
}

interface ProtobufField {
  fieldNumber: number;
  wireType: number;
  varint?: number;
  bytes?: Uint8Array;
}

interface ParsedBreakdownCategory {
  id: string;
  label: string;
  tokens: number;
}

interface ParsedTokenDetails {
  usedTokens: number;
  maxTokens: number;
  categories: ParsedBreakdownCategory[];
}

const utf8Decoder = new TextDecoder();
const MIN_CONTEXT_WINDOW_TOKENS = 16_000;
const MAX_CONTEXT_WINDOW_TOKENS = 20_000_000;
const MAX_USED_TO_WINDOW_RATIO = 4;

let warnedDecodeFailure = false;

function readVarint(
  buf: Uint8Array,
  offset: number,
): { value: number; next: number } | undefined {
  let value = 0;
  let multiplier = 1;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i++]!;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) {
      return Number.isSafeInteger(value) ? { value, next: i } : undefined;
    }
    multiplier *= 128;
    if (multiplier > 2 ** 53) {
      return undefined;
    }
  }
  return undefined;
}

function parseProtobufFields(buf: Uint8Array): ProtobufField[] {
  const fields: ProtobufField[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const tag = readVarint(buf, offset);
    if (!tag) break;
    offset = tag.next;
    const fieldNumber = Math.floor(tag.value / 8);
    const wireType = tag.value & 7;
    if (wireType === 0) {
      const val = readVarint(buf, offset);
      if (!val) break;
      offset = val.next;
      fields.push({ fieldNumber, wireType, varint: val.value });
    } else if (wireType === 1) {
      if (offset + 8 > buf.length) break;
      offset += 8;
    } else if (wireType === 2) {
      const len = readVarint(buf, offset);
      if (!len || offset + len.value > buf.length) break;
      const start = len.next;
      offset = start + len.value;
      fields.push({ fieldNumber, wireType, bytes: buf.subarray(start, offset) });
    } else if (wireType === 5) {
      if (offset + 4 > buf.length) break;
      offset += 4;
    } else {
      break;
    }
  }
  return fields;
}

function decodeCategory(buf: Uint8Array): ParsedBreakdownCategory | undefined {
  let id = "";
  let label = "";
  let tokens = 0;
  for (const field of parseProtobufFields(buf)) {
    if (field.fieldNumber === 1 && field.bytes) {
      id = utf8Decoder.decode(field.bytes);
    } else if (field.fieldNumber === 2 && field.bytes) {
      label = utf8Decoder.decode(field.bytes);
    } else if (field.fieldNumber === 3 && field.varint !== undefined) {
      tokens = field.varint;
    }
  }
  if (!id || !label || tokens <= 0) {
    return undefined;
  }
  return { id, label, tokens };
}

/**
 * Decodes Cursor's `ConversationStateStructure` root blob:
 * field 5 = `ConversationTokenDetails` (1: used_tokens, 2: max_tokens, 3: breakdown).
 */
export function decodeCursorConversationTokenDetails(
  rootBlob: Uint8Array,
): ParsedTokenDetails | undefined {
  const tokenDetailsBytes = parseProtobufFields(rootBlob).find(
    (field) => field.fieldNumber === 5 && field.bytes !== undefined,
  )?.bytes;
  if (!tokenDetailsBytes) {
    return undefined;
  }

  let usedTokens = 0;
  let maxTokens = 0;
  const categories: ParsedBreakdownCategory[] = [];

  for (const field of parseProtobufFields(tokenDetailsBytes)) {
    if (field.fieldNumber === 1 && field.varint !== undefined) {
      usedTokens = field.varint;
    } else if (field.fieldNumber === 2 && field.varint !== undefined) {
      maxTokens = field.varint;
    } else if (field.fieldNumber === 3 && field.bytes !== undefined) {
      for (const bf of parseProtobufFields(field.bytes)) {
        if (bf.fieldNumber === 3 && bf.bytes !== undefined) {
          const category = decodeCategory(bf.bytes);
          if (category) {
            categories.push(category);
          }
        }
      }
    }
  }

  if (
    usedTokens <= 0 ||
    maxTokens < MIN_CONTEXT_WINDOW_TOKENS ||
    maxTokens > MAX_CONTEXT_WINDOW_TOKENS ||
    usedTokens > maxTokens * MAX_USED_TO_WINDOW_RATIO
  ) {
    return undefined;
  }
  return { usedTokens, maxTokens, categories };
}

export function cursorConfigDirectory(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = env.CURSOR_CONFIG_DIR?.trim();
  if (configured) {
    return configured;
  }
  const xdgConfig = env.XDG_CONFIG_HOME?.trim();
  if (xdgConfig) {
    return join(xdgConfig, "cursor");
  }
  const home =
    platform === "win32"
      ? env.USERPROFILE?.trim() || env.HOME?.trim() || homedir()
      : env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  return join(home, ".cursor");
}

function cursorAcpStorePath(
  sessionId: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (
    sessionId.length === 0 ||
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId.includes("..")
  ) {
    return undefined;
  }
  return join(cursorConfigDirectory(env), "acp-sessions", sessionId, "store.db");
}

function buildSnapshot(args: {
  sessionId: string;
  model: string;
  details: ParsedTokenDetails;
}): ContextSnapshot | undefined {
  if (args.details.categories.length === 0) {
    return undefined;
  }
  const categories: ContextCategory[] = args.details.categories.map(
    (category) => ({
      id: category.id,
      label: category.label,
      kind: "used",
      tokens: category.tokens,
      entries: [],
    }),
  );
  const freeTokens = Math.max(
    0,
    args.details.maxTokens - args.details.usedTokens,
  );
  categories.push({
    id: "free",
    label: "Free space",
    kind: "free",
    tokens: freeTokens,
    entries: [],
  });
  return {
    capturedAt: new Date().toISOString(),
    providerSessionId: args.sessionId,
    providerTurnId: null,
    model: args.model,
    usedTokens: args.details.usedTokens,
    contextWindowTokens: args.details.maxTokens,
    autoCompactAtTokens: null,
    estimated: false,
    categories,
  };
}

/**
 * Reads Cursor CLI's server-computed context window usage from its local ACP
 * session SQLite store (`~/.cursor/acp-sessions/<sessionId>/store.db`).
 */
export function readCursorSessionContextUsage(args: {
  sessionId: string;
  model: string | undefined;
  env: Readonly<Record<string, string | undefined>>;
}): AcpContextUsageReading | undefined {
  const dbPath = cursorAcpStorePath(args.sessionId, args.env);
  if (dbPath === undefined || !existsSync(dbPath)) {
    return undefined;
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const metaRow = db
      .prepare("SELECT value FROM meta WHERE key = '0'")
      .get() as { value?: unknown } | undefined;
    if (typeof metaRow?.value !== "string" || metaRow.value.length === 0) {
      return undefined;
    }
    const meta = JSON.parse(
      Buffer.from(metaRow.value, "hex").toString("utf8"),
    ) as { latestRootBlobId?: unknown; lastUsedModel?: unknown };
    if (
      typeof meta.latestRootBlobId !== "string" ||
      meta.latestRootBlobId.length === 0
    ) {
      return undefined;
    }

    const blobRow = db
      .prepare("SELECT data FROM blobs WHERE id = ?")
      .get(meta.latestRootBlobId) as { data?: unknown } | undefined;
    if (!(blobRow?.data instanceof Uint8Array)) {
      return undefined;
    }

    const details = decodeCursorConversationTokenDetails(blobRow.data);
    if (!details) {
      if (!warnedDecodeFailure) {
        warnedDecodeFailure = true;
        console.error(
          `[acp-bridge] Could not decode token usage from Cursor store (${dbPath}); falling back to estimate.`,
        );
      }
      return undefined;
    }

    const modelName =
      args.model?.trim() ||
      (typeof meta.lastUsedModel === "string" && meta.lastUsedModel.trim()) ||
      "cursor";
    const snapshot = buildSnapshot({
      sessionId: args.sessionId,
      model: modelName,
      details,
    });
    return {
      used: details.usedTokens,
      size: details.maxTokens,
      estimated: false,
      ...(snapshot ? { snapshot } : {}),
    };
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors after a failed read.
    }
  }
}
