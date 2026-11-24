export interface MessageContextTextSegment {
  kind: "text";
  text: string;
  start: number;
  end: number;
}

export interface MessageContextBlockSegment {
  kind: "context";
  text: string;
  messageNumber: number | null;
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
}

export type MessageContextSegment =
  | MessageContextTextSegment
  | MessageContextBlockSegment;

export interface CodeFenceState {
  char: "`" | "~";
  length: number;
}

const MESSAGE_NUMBER_PATTERN = /#(\d+)/u;
const OPEN_TAG_PATTERN = /<context(?:\s+message="#?(\d+)")?>\r?\n/yu;
const CLOSE_TAG_TEXT = "</context>";

export function parseMessageContextNumber(label: string): number | null {
  const match = MESSAGE_NUMBER_PATTERN.exec(label);
  const parsed = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Formats a reply context for submission and returns the body's start offset. */
export function formatSubmittedMessageContextParts(
  text: string,
  label: string,
): { text: string; bodyOffset: number } {
  const messageNumber = parseMessageContextNumber(label);
  const openTag =
    messageNumber === null
      ? "<context>"
      : `<context message="#${messageNumber}">`;
  const prefix = `${openTag}\n`;
  return {
    text: `${prefix}${text}\n${CLOSE_TAG_TEXT}`,
    bodyOffset: prefix.length,
  };
}

/** Formats a reply context for submission while keeping its message number if known. */
export function formatSubmittedMessageContext(
  text: string,
  label: string,
): string {
  return formatSubmittedMessageContextParts(text, label).text;
}

/** Updates CommonMark code-fence state for one line (`text[start..end]`, without line endings). */
export function updateCodeFenceState(
  fence: CodeFenceState | null,
  text: string,
  start: number,
  end: number,
): CodeFenceState | null {
  let index = start;
  const maxIndent = Math.min(start + 3, end);
  while (index < maxIndent && text[index] === " ") {
    index += 1;
  }
  if (index >= end) return fence;

  const char = text[index];
  if (char !== "`" && char !== "~") return fence;

  let runEnd = index + 1;
  while (runEnd < end && text[runEnd] === char) {
    runEnd += 1;
  }
  const length = runEnd - index;
  if (length < 3) return fence;

  if (fence === null) {
    // Per CommonMark, backtick fence info strings cannot contain backticks.
    if (char === "`") {
      for (let i = runEnd; i < end; i += 1) {
        if (text[i] === "`") return null;
      }
    }
    return { char, length };
  }

  if (char === fence.char && length >= fence.length) {
    for (let i = runEnd; i < end; i += 1) {
      const code = text.charCodeAt(i);
      if (code !== 32 && code !== 9) return fence;
    }
    return null;
  }

  return fence;
}

interface MatchedContextBlock {
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
  messageNumber: number | null;
}

function matchOpenTagAt(
  text: string,
  index: number,
): { end: number; messageNumber: number | null } | null {
  OPEN_TAG_PATTERN.lastIndex = index;
  const match = OPEN_TAG_PATTERN.exec(text);
  if (!match) return null;
  const parsed = match[1] ? Number.parseInt(match[1], 10) : Number.NaN;
  return {
    end: index + match[0].length,
    messageNumber: Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null,
  };
}

function lineContentEndOf(text: string, lineStart: number, lineEnd: number): number {
  const rawEnd = lineEnd === -1 ? text.length : lineEnd;
  return rawEnd > lineStart && text[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
}

function hasOpenTagOnLine(
  text: string,
  searchStart: number,
  lineContentEnd: number,
): boolean {
  let pos = text.indexOf("<context", searchStart);
  while (pos !== -1 && pos < lineContentEnd) {
    if (matchOpenTagAt(text, pos) !== null) return true;
    pos = text.indexOf("<context", pos + 1);
  }
  return false;
}

function scanClosingContextBlock(
  text: string,
  blockStart: number,
  bodyStart: number,
  messageNumber: number | null,
  respectFences: boolean,
): { block: MatchedContextBlock | null; endedInFence: boolean } {
  let depth = 1;
  let fence: CodeFenceState | null = null;
  let lineStart = bodyStart;

  while (lineStart < text.length) {
    const lineEnd = text.indexOf("\n", lineStart);
    const lineContentEnd = lineContentEndOf(text, lineStart, lineEnd);

    if (respectFences) {
      const nextFence = updateCodeFenceState(
        fence,
        text,
        lineStart,
        lineContentEnd,
      );
      if (nextFence !== fence || fence !== null) {
        fence = nextFence;
        lineStart = lineEnd === -1 ? text.length : lineEnd + 1;
        continue;
      }
    }

    let openSearchStart = lineStart;
    if (
      lineStart > bodyStart &&
      text.startsWith(CLOSE_TAG_TEXT, lineStart)
    ) {
      const closeEnd = lineStart + CLOSE_TAG_TEXT.length;
      const bodyEnd =
        lineStart - 2 >= bodyStart && text[lineStart - 2] === "\r"
          ? lineStart - 2
          : lineStart - 1;
      depth -= 1;
      if (depth === 0) {
        return {
          block: {
            start: blockStart,
            end: closeEnd,
            bodyStart,
            bodyEnd,
            messageNumber,
          },
          endedInFence: false,
        };
      }
      openSearchStart = closeEnd;
    }

    if (
      lineEnd !== -1 &&
      hasOpenTagOnLine(text, openSearchStart, lineContentEnd)
    ) {
      depth += 1;
    }

    lineStart = lineEnd === -1 ? text.length : lineEnd + 1;
  }

  return { block: null, endedInFence: fence !== null };
}

function findClosingContextBlock(
  text: string,
  blockStart: number,
  bodyStart: number,
  messageNumber: number | null,
): MatchedContextBlock | null {
  const firstPass = scanClosingContextBlock(
    text,
    blockStart,
    bodyStart,
    messageNumber,
    true,
  );
  if (firstPass.block !== null || !firstPass.endedInFence) {
    return firstPass.block;
  }
  return scanClosingContextBlock(
    text,
    blockStart,
    bodyStart,
    messageNumber,
    false,
  ).block;
}

function findSubmittedContextBlocks(text: string): MatchedContextBlock[] {
  let nextOpen = text.indexOf("<context", 0);
  const lastClose = text.lastIndexOf(CLOSE_TAG_TEXT);
  if (nextOpen === -1 || lastClose === -1) return [];

  const blocks: MatchedContextBlock[] = [];
  let fence: CodeFenceState | null = null;
  let cursor = 0;

  while (cursor < text.length) {
    if (nextOpen < cursor) {
      nextOpen = text.indexOf("<context", cursor);
    }
    if (nextOpen === -1 || nextOpen > lastClose) break;

    const lineEnd = text.indexOf("\n", cursor);
    if (cursor === 0 || text[cursor - 1] === "\n") {
      const lineContentEnd = lineContentEndOf(text, cursor, lineEnd);
      const nextFence = updateCodeFenceState(
        fence,
        text,
        cursor,
        lineContentEnd,
      );
      if (nextFence !== fence || fence !== null) {
        fence = nextFence;
        cursor = lineEnd === -1 ? text.length : lineEnd + 1;
        continue;
      }
    }

    if (lineEnd !== -1 && lineEnd < nextOpen) {
      cursor = lineEnd + 1;
      continue;
    }

    const open = matchOpenTagAt(text, nextOpen);
    if (open === null) {
      cursor = nextOpen + 1;
      continue;
    }

    const block =
      open.end <= lastClose
        ? findClosingContextBlock(text, nextOpen, open.end, open.messageNumber)
        : null;
    if (block === null) {
      cursor = open.end;
      continue;
    }

    if (text.slice(block.bodyStart, block.bodyEnd).trim().length > 0) {
      blocks.push(block);
    }
    cursor = block.end;
  }

  return blocks;
}

function skipLeadingLineBreak(text: string, start: number, end: number): number {
  if (start >= end) return start;
  if (text[start] === "\r" && text[start + 1] === "\n") return start + 2;
  return text[start] === "\n" ? start + 1 : start;
}

function trimTrailingLineBreak(text: string, start: number, end: number): number {
  if (end <= start || text[end - 1] !== "\n") return end;
  return end - 2 >= start && text[end - 2] === "\r" ? end - 2 : end - 1;
}

/** Splits a sent message into text and `<context>` segments with exact source offsets. */
export function splitMessageContextSegments(
  text: string,
): MessageContextSegment[] {
  if (!text.includes("<context")) {
    return text.length > 0
      ? [{ kind: "text", text, start: 0, end: text.length }]
      : [];
  }

  const blocks = findSubmittedContextBlocks(text);
  if (blocks.length === 0) {
    return text.length > 0
      ? [{ kind: "text", text, start: 0, end: text.length }]
      : [];
  }

  const segments: MessageContextSegment[] = [];
  let cursor = 0;

  for (const [index, block] of blocks.entries()) {
    const gapStart =
      index > 0 ? skipLeadingLineBreak(text, cursor, block.start) : cursor;
    const gapEnd = trimTrailingLineBreak(text, gapStart, block.start);
    if (gapStart < gapEnd) {
      const gapText = text.slice(gapStart, gapEnd);
      if (index === 0 || gapText.trim().length > 0) {
        segments.push({ kind: "text", text: gapText, start: gapStart, end: gapEnd });
      }
    }
    segments.push({
      kind: "context",
      text: text.slice(block.bodyStart, block.bodyEnd),
      messageNumber: block.messageNumber,
      start: block.start,
      end: block.end,
      bodyStart: block.bodyStart,
      bodyEnd: block.bodyEnd,
    });
    cursor = block.end;
  }

  const tailStart = skipLeadingLineBreak(text, cursor, text.length);
  if (tailStart < text.length) {
    segments.push({
      kind: "text",
      text: text.slice(tailStart),
      start: tailStart,
      end: text.length,
    });
  }

  return segments;
}
