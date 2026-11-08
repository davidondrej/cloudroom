import { isRawThreadId } from "@cloudroom/domain";

export const USER_MESSAGE_CHAR_CAP = 4096;

export const GENERATED_MESSAGE_COLLAPSED_PREVIEW_CHAR_CAP =
  USER_MESSAGE_CHAR_CAP;

interface BoundedMarkdownPreview {
  parseAsMarkdown: boolean;
  text: string;
  wasCapped: boolean;
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && /\s/u.test(value);
}

function scanOpenCodeSpan(text: string): {
  delimiterLength: number;
  contentStart: number;
} {
  let openDelimiterLength = 0;
  let openContentStart = -1;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "`" || isEscapedBacktick(text, index)) continue;
    let delimiterEnd = index + 1;
    while (text[delimiterEnd] === "`") delimiterEnd += 1;
    const delimiterLength = delimiterEnd - index;
    if (openDelimiterLength === 0) {
      openDelimiterLength = delimiterLength;
      openContentStart = delimiterEnd;
    } else if (delimiterLength === openDelimiterLength) {
      openDelimiterLength = 0;
      openContentStart = -1;
    }
    index = delimiterEnd - 1;
  }
  return {
    delimiterLength: openDelimiterLength,
    contentStart: openContentStart,
  };
}

export function endsInsideExactRawThreadIdCodeSpan(text: string): boolean {
  const { delimiterLength, contentStart } = scanOpenCodeSpan(text);
  return (
    delimiterLength > 0 &&
    contentStart >= 0 &&
    isRawThreadId(text.slice(contentStart))
  );
}

function cappedMarkdownPreview(text: string): BoundedMarkdownPreview {
  return {
    parseAsMarkdown: !endsInsideExactRawThreadIdCodeSpan(text),
    text,
    wasCapped: true,
  };
}

export function boundedMarkdownPreview(
  text: string,
  cap: number,
): BoundedMarkdownPreview {
  if (text.length <= cap) {
    return { parseAsMarkdown: true, text, wasCapped: false };
  }

  const previewWindow = text.slice(0, cap + 1);
  const cappedText = previewWindow.slice(0, cap);
  const capSplitsToken =
    !isWhitespace(cappedText.at(-1)) && !isWhitespace(previewWindow[cap]);
  if (!capSplitsToken) {
    return cappedMarkdownPreview(cappedText);
  }

  const lastWhitespaceIndex = cappedText.search(/\s(?=\S*$)/u);
  if (lastWhitespaceIndex < 0) {
    return { parseAsMarkdown: false, text: cappedText, wasCapped: true };
  }

  return cappedMarkdownPreview(cappedText.slice(0, lastWhitespaceIndex + 1));
}

function isEscapedBacktick(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

interface BoundedMarkdownTail {
  parseAsMarkdown: boolean;
  /** Characters added before the source slice (a code fence reopened). */
  prefixLength: number;
  /** Offset of the slice in the source text. */
  sourceStart: number;
  text: string;
}

const TOP_LEVEL_CODE_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const NESTED_CODE_FENCE =
  /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?[ \t>]*(?:`{3,}|~{3,})/u;

/**
 * The code fence still open at the end of `text` ("" when none). Returns null
 * when a fence sits in a list, quote, or indent, where the state is unclear.
 */
function openCodeFenceAt(text: string): string | null {
  let open = "";
  for (const line of text.split("\n")) {
    const fence = TOP_LEVEL_CODE_FENCE.exec(line);
    if (open) {
      const closes =
        fence?.[1][0] === open[0] &&
        fence[1].length >= open.length &&
        fence[2].trim() === "";
      if (closes) open = "";
    } else if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
      open = fence[1];
    } else if (NESTED_CODE_FENCE.test(line)) {
      return null;
    }
  }
  return open;
}

/**
 * The end of a long message. Starts at a line break so markdown still parses,
 * and reopens a code fence the cut lands inside with the same marker. When
 * that can't be done safely, the end renders as plain text.
 */
export function boundedMarkdownTail(
  text: string,
  cap: number,
): BoundedMarkdownTail {
  if (text.length <= cap) {
    return { parseAsMarkdown: true, prefixLength: 0, sourceStart: 0, text };
  }
  const windowStart = text.length - cap;
  const plainTail: BoundedMarkdownTail = {
    parseAsMarkdown: false,
    prefixLength: 0,
    sourceStart: windowStart,
    text: text.slice(windowStart),
  };
  const lineBreak = text.indexOf("\n", windowStart);
  if (lineBreak < 0 || text.length - lineBreak < cap / 4) return plainTail;
  const sourceStart = lineBreak + 1;
  const fence = openCodeFenceAt(text.slice(0, sourceStart));
  if (fence === null) return plainTail;
  const prefix = fence ? `${fence}\n` : "";
  return {
    parseAsMarkdown: true,
    prefixLength: prefix.length,
    sourceStart,
    text: `${prefix}${text.slice(sourceStart)}`,
  };
}

export function closeUnterminatedMarkdownCodeSpan(text: string): string {
  const { delimiterLength } = scanOpenCodeSpan(text);
  return delimiterLength === 0 ? text : `${text}${"`".repeat(delimiterLength)}`;
}
