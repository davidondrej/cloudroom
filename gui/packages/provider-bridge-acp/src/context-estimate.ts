import { statSync } from "node:fs";
import {
  acpToolCallUpdateEventSchema,
  type AcpContentBlock,
  type AcpSessionUpdate,
} from "./wire.js";

export interface AcpContextEstimateTuning {
  baseTokens: number;
  charsPerToken: number;
  defaultWindowTokens: number;
}

export interface AcpContextEstimate {
  addPrompt(blocks: readonly AcpContentBlock[]): void;
  addUpdate(update: AcpSessionUpdate): void;
  reset(): void;
  used(): number;
  windowSize(model: string | undefined): number;
}

interface ToolChars {
  kind: string | undefined;
  path: string | undefined;
  input: number;
  output: number;
}

const IMAGE_CHARS = 6_000;
const MAX_READ_CHARS = 100_000;
const TEXT_UPDATES = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
]);

function textSize(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, entry) => sum + textSize(entry), 0);
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).reduce<number>(
      (sum, [key, entry]) => sum + key.length + textSize(entry),
      0,
    );
  }
  return value === undefined || value === null ? 0 : String(value).length;
}

function blockSize(block: unknown): number {
  if (block === null || typeof block !== "object" || !("type" in block)) {
    return textSize(block);
  }
  if (block.type === "image") {
    return IMAGE_CHARS;
  }
  return "text" in block ? textSize(block.text) : textSize(block);
}

function fileSize(path: string): number {
  try {
    return Math.min(statSync(path).size, MAX_READ_CHARS);
  } catch {
    return 0;
  }
}

function inputPath(rawInput: unknown): string | undefined {
  return rawInput !== null &&
    typeof rawInput === "object" &&
    "path" in rawInput &&
    typeof rawInput.path === "string"
    ? rawInput.path
    : undefined;
}

export function createAcpContextEstimate(
  tuning: AcpContextEstimateTuning,
): AcpContextEstimate {
  let chars = 0;
  const tools = new Map<string, ToolChars>();
  const readPaths = new Set<string>();

  return {
    addPrompt(blocks) {
      for (const block of blocks) chars += blockSize(block);
    },
    addUpdate(update) {
      if (TEXT_UPDATES.has(update.sessionUpdate) && "content" in update) {
        chars += blockSize(update.content);
        return;
      }
      const parsed = acpToolCallUpdateEventSchema.safeParse(update);
      if (!parsed.success) {
        return;
      }
      const event = parsed.data;
      const previous = tools.get(event.toolCallId);
      const output = event.rawOutput ?? event.content;
      const tool: ToolChars = {
        kind: event.kind ?? previous?.kind,
        path: inputPath(event.rawInput) ?? previous?.path,
        input:
          event.rawInput === undefined
            ? (previous?.input ?? 0)
            : textSize(event.rawInput),
        output:
          output === undefined ? (previous?.output ?? 0) : textSize(output),
      };
      if (
        event.status === "completed" &&
        tool.output === 0 &&
        tool.kind === "read" &&
        tool.path !== undefined &&
        !readPaths.has(tool.path)
      ) {
        readPaths.add(tool.path);
        tool.output = fileSize(tool.path);
      }
      tools.set(event.toolCallId, tool);
    },
    reset() {
      chars = 0;
      tools.clear();
      readPaths.clear();
    },
    used() {
      let total = chars;
      for (const tool of tools.values()) total += tool.input + tool.output;
      return Math.round(tuning.baseTokens + total / tuning.charsPerToken);
    },
    windowSize(model) {
      const match = /context=(\d+(?:\.\d+)?)([km])/i.exec(model ?? "");
      if (match === null) {
        return tuning.defaultWindowTokens;
      }
      const unit = match[2]?.toLowerCase() === "m" ? 1_000_000 : 1_000;
      return Math.round(Number(match[1]) * unit);
    },
  };
}
