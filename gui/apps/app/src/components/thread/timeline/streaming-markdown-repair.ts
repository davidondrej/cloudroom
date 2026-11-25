// Closes the markdown a streaming reply has opened but not yet closed, so its
// unfinished tail renders as it will once complete: `**bold` becomes
// `**bold**`, and `[text](http` shows as plain `text`.
//
// Ported from remend 1.3.1 (https://github.com/vercel/streamdown, Apache-2.0,
// notice in gui/NOTICE), and changed: it keeps only the completions this app
// turns on (links as text only, bold italic, bold, italic, inline code, and
// strikethrough), in remend's order and with its exact output.

const FENCE = "```";
// Text of only spaces and markers has nothing to close.
const ONLY_MARKERS = /^[\s_~*`]*$/;
const UNICODE_WORD_CHAR = /[\p{L}\p{N}_]/u;

export function closeIncompleteMarkdown(text: string): string {
  // One trailing space is dropped; two are a line break.
  let result =
    text.endsWith(" ") && !text.endsWith("  ") ? text.slice(0, -1) : text;
  result = completeLinks(result);
  result = completeBoldItalic(result);
  result = completeBold(result);
  result = completeDoubleUnderscore(result);
  result = completeSingleAsterisk(result);
  result = completeSingleUnderscore(result);
  result = completeInlineCode(result);
  return completeStrikethrough(result);
}

function isWordChar(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    UNICODE_WORD_CHAR.test(char)
  );
}

function isSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n";
}

// For each position, whether it sits in inline code or a ``` block. Every
// completion asks about the same text many times, so the last one is kept.
let codeLookup: { text: string; inside: Uint8Array } | null = null;

function isInsideCode(text: string, position: number): boolean {
  if (codeLookup?.text !== text) {
    const inside = new Uint8Array(text.length + 1);
    let inInline = false;
    let inBlock = false;
    for (let index = 0; index < text.length;) {
      const escaped = text[index] === "\\" && text[index + 1] === "`";
      const fence = !escaped && text.startsWith(FENCE, index);
      if (fence) inBlock = !inBlock;
      else if (!escaped && !inBlock && text[index] === "`") {
        inInline = !inInline;
      }
      const step = escaped ? 2 : fence ? 3 : 1;
      for (const end = index + step; index < end; index += 1) {
        inside[index + 1] = inInline || inBlock ? 1 : 0;
      }
    }
    codeLookup = { text, inside };
  }
  return codeLookup.inside[Math.min(position, text.length)] === 1;
}

// Whether position sits strictly between the backticks of a closed code span.
function isInsideClosedCodeSpan(text: string, position: number): boolean {
  let inInline = false;
  let inBlock = false;
  let start = -1;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\" && text[index + 1] === "`") {
      index += 1;
    } else if (text.startsWith(FENCE, index)) {
      inBlock = !inBlock;
      index += 2;
    } else if (!inBlock && text[index] === "`") {
      if (inInline && start < position && position < index) return true;
      start = inInline ? -1 : index;
      inInline = !inInline;
    }
  }
  return false;
}

function isInsideAnyCode(text: string, position: number): boolean {
  return isInsideCode(text, position) || isInsideClosedCodeSpan(text, position);
}

type MathState = "none" | "dollar" | "doubleDollar" | "paren" | "bracket";

// The state each of \[ \] \( \) moves math from, and to.
const LATEX_DELIMITERS: Record<string, [MathState, MathState]> = {
  "[": ["none", "bracket"],
  "]": ["bracket", "none"],
  "(": ["none", "paren"],
  ")": ["paren", "none"],
};

// Whether position sits in $…$, $$…$$, \(…\), or \[…\] math.
function isWithinMath(text: string, position: number): boolean {
  if (!text.includes("$") && !text.includes("\\(") && !text.includes("\\[")) {
    return false;
  }
  let state: MathState = "none";
  for (let index = 0; index < text.length && index < position; index += 1) {
    const next = text[index + 1];
    if (text[index] === "\\") {
      const latex = LATEX_DELIMITERS[next];
      if (next === "$") {
        index += 1;
      } else if (latex?.[0] === state) {
        state = latex[1];
        index += 1;
      }
    } else if (
      text[index] === "$" &&
      state !== "paren" &&
      state !== "bracket"
    ) {
      if (next === "$") {
        state = state === "doubleDollar" ? "none" : "doubleDollar";
        index += 1;
      } else if (state !== "doubleDollar") {
        state = state === "dollar" ? "none" : "dollar";
      }
    }
  }
  return state !== "none";
}

// Whether position sits in the (url) of a [text](url) on its line.
function isWithinLinkUrl(text: string, position: number): boolean {
  for (let index = position - 1; index >= 0; index -= 1) {
    if (text[index] === ")" || text[index] === "\n") return false;
    if (text[index] !== "(") continue;
    if (index === 0 || text[index - 1] !== "]") return false;
    const close = text.indexOf(")", position);
    const newline = text.indexOf("\n", position);
    return close !== -1 && (newline === -1 || close < newline);
  }
  return false;
}

// Whether position sits in an HTML tag on its line, like <a href="x_y">.
function isWithinHtmlTag(text: string, position: number): boolean {
  for (let index = position - 1; index >= 0; index -= 1) {
    if (text[index] === ">" || text[index] === "\n") return false;
    if (text[index] === "<") {
      const next = text[index + 1] ?? "";
      return (
        (next >= "a" && next <= "z") ||
        (next >= "A" && next <= "Z") ||
        next === "/"
      );
    }
  }
  return false;
}

function lineStart(text: string, position: number): number {
  return position > 0 ? text.lastIndexOf("\n", position - 1) + 1 : 0;
}

// Whether position's line is a thematic break made of marker, like `* * *`.
function isThematicBreakLine(
  text: string,
  position: number,
  marker: string,
): boolean {
  const line = text.slice(lineStart(text, position)).split("\n", 1)[0];
  return (
    line.split(marker).length > 3 &&
    /^[ \t]*$/.test(line.replaceAll(marker, ""))
  );
}

// `**` or `__` pairs outside ``` blocks, read left to right.
function countDoubleMarkers(text: string, marker: "*" | "_"): number {
  let count = 0;
  let inBlock = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text.startsWith(FENCE, index)) {
      inBlock = !inBlock;
      index += 2;
    } else if (
      !inBlock &&
      text[index] === marker &&
      text[index + 1] === marker
    ) {
      count += 1;
      index += 1;
    }
  }
  return count;
}

// Runs of three or more `*` outside ``` blocks: each full three counts once.
function countTripleAsterisks(text: string): number {
  let count = 0;
  let run = 0;
  let inBlock = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text.startsWith(FENCE, index)) {
      inBlock = !inBlock;
      index += 2;
    } else if (inBlock) {
      continue;
    } else if (text[index] === "*") {
      run += 1;
      continue;
    }
    count += Math.floor(run / 3);
    run = 0;
  }
  return count + Math.floor(run / 3);
}

// Single `*` outside ``` blocks that can open or close emphasis.
function countEmphasisAsterisks(text: string): number {
  let count = 0;
  let inBlock = false;
  let inWordChain = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text.startsWith(FENCE, index)) {
      inBlock = !inBlock;
      index += 2;
      continue;
    }
    if (inBlock) continue;
    if (text[index] !== "*") {
      if (!isWordChar(text[index])) inWordChain = false;
      continue;
    }
    const prev = text[index - 1] ?? "";
    const next = text[index + 1] ?? "";
    // Escaped, in math, the first of `**`, or a later `*` of a run.
    if (prev === "\\" || isWithinMath(text, index)) continue;
    if (prev !== "*" && next === "*") {
      if (text[index + 2] !== "*") continue;
    } else if (
      prev === "*" ||
      ((!prev || isSpace(prev)) && (!next || isSpace(next)))
    ) {
      continue;
    }
    const intraword = isWordChar(prev) && isWordChar(next);
    if (intraword && count % 2 === 0 && !inWordChain) continue;
    if (
      (prev && !isSpace(prev) && count % 2 === 1) ||
      (next && !isSpace(next))
    ) {
      count += 1;
      inWordChain = intraword;
    }
  }
  return count;
}

// Lone `*` or `_` outside ``` blocks that may open emphasis, up to limit: not
// doubled, escaped, in math, or inside a word. A `*` needs a non-space after
// it; a `_` must not sit in a link's URL.
function loneMarkers(text: string, marker: "*" | "_", limit = Infinity) {
  const found: number[] = [];
  let inBlock = false;
  for (let index = 0; index < text.length && found.length < limit; index += 1) {
    if (text.startsWith(FENCE, index)) {
      inBlock = !inBlock;
      index += 2;
      continue;
    }
    if (inBlock || text[index] !== marker) continue;
    const prev = text[index - 1] ?? "";
    const next = text[index + 1] ?? "";
    if (
      prev !== marker &&
      next !== marker &&
      prev !== "\\" &&
      !isWithinMath(text, index) &&
      !(marker === "*" && (!next || isSpace(next))) &&
      !(marker === "_" && isWithinLinkUrl(text, index)) &&
      !(isWordChar(prev) && isWordChar(next))
    ) {
      found.push(index);
    }
  }
  return found;
}

// `**` or `__` stays open when nothing follows it, when it starts a list item
// that spans lines, or when its line is a thematic break.
function leavesDoubleMarkerOpen(
  text: string,
  markerIndex: number,
  content: string,
  marker: "*" | "_",
): boolean {
  if (!content || ONLY_MARKERS.test(content)) return true;
  const beforeMarker = text.slice(lineStart(text, markerIndex), markerIndex);
  if (/^[\s]*[-*+][\s]+$/.test(beforeMarker) && content.includes("\n")) {
    return true;
  }
  return isThematicBreakLine(text, markerIndex, marker);
}

function completeBoldItalic(text: string): string {
  if (/^\*{4,}$/.test(text)) return text;
  const content = text.match(/\*\*\*([^*]*?)$/)?.[1];
  if (content === undefined) return text;
  const markerIndex = text.lastIndexOf("***");
  if (
    !content ||
    ONLY_MARKERS.test(content) ||
    isInsideAnyCode(text, markerIndex) ||
    isThematicBreakLine(text, markerIndex, "*") ||
    countTripleAsterisks(text) % 2 === 0
  ) {
    return text;
  }
  // Balanced `**` and `*` already close it.
  const balanced =
    countDoubleMarkers(text, "*") % 2 === 0 &&
    countEmphasisAsterisks(text) % 2 === 0;
  return balanced ? text : `${text}***`;
}

function completeBold(text: string): string {
  const content = text.match(/\*\*([^*]*\*?)$/)?.[1];
  if (content === undefined) return text;
  const markerIndex = text.lastIndexOf("**");
  if (
    isInsideAnyCode(text, markerIndex) ||
    leavesDoubleMarkerOpen(text, markerIndex, content, "*") ||
    countDoubleMarkers(text, "*") % 2 === 0
  ) {
    return text;
  }
  return content.endsWith("*") ? `${text}*` : `${text}**`;
}

function completeDoubleUnderscore(text: string): string {
  const markerIndex = text.lastIndexOf("__");
  const content = text.match(/__([^_]*?)$/)?.[1];
  if (content === undefined) {
    // `__text_` is missing only its last `_`.
    const halfClosed =
      /__[^_]+_$/.test(text) &&
      !isInsideAnyCode(text, markerIndex) &&
      countDoubleMarkers(text, "_") % 2 === 1;
    return halfClosed ? `${text}_` : text;
  }
  if (
    isInsideAnyCode(text, markerIndex) ||
    leavesDoubleMarkerOpen(text, markerIndex, content, "_") ||
    countDoubleMarkers(text, "_") % 2 === 0
  ) {
    return text;
  }
  return `${text}__`;
}

function completeSingleAsterisk(text: string): string {
  const opener = loneMarkers(text, "*", 1)[0] ?? -1;
  if (opener === -1 || isInsideAnyCode(text, opener)) return text;
  const content = text.slice(opener + 1);
  if (!content || ONLY_MARKERS.test(content)) return text;
  return countEmphasisAsterisks(text) % 2 === 1 ? `${text}*` : text;
}

function completeSingleUnderscore(text: string): string {
  const markers = loneMarkers(text, "_");
  const opener = markers[0] ?? -1;
  if (opener === -1) return text;
  const content = text.slice(opener + 1);
  if (
    !content ||
    ONLY_MARKERS.test(content) ||
    isInsideAnyCode(text, opener) ||
    markers.filter((index) => !isWithinHtmlTag(text, index)).length % 2 === 0
  ) {
    return text;
  }
  // `**bold _italic**` closes the italic inside the bold.
  const inner = text.slice(0, -2);
  if (text.endsWith("**") && countDoubleMarkers(inner, "*") % 2 === 1) {
    const boldOpener = inner.indexOf("**");
    const italicOpener = loneMarkers(inner, "_", 1)[0] ?? -1;
    if (boldOpener !== -1 && italicOpener !== -1 && boldOpener < italicOpener) {
      return `${inner}_**`;
    }
  }
  // Otherwise the `_` goes before any trailing line breaks.
  let end = text.length;
  while (end > 0 && text[end - 1] === "\n") end -= 1;
  return `${text.slice(0, end)}_${text.slice(end)}`;
}

function completeInlineCode(text: string): string {
  if (/^```[^`\n]*```?$/.test(text) && !text.includes("\n")) {
    return text.endsWith("``") && !text.endsWith(FENCE) ? `${text}\`` : text;
  }
  const lastBacktick = text.lastIndexOf("`");
  if (lastBacktick === -1 || text.split(FENCE).length % 2 === 0) return text;
  const content = text.slice(lastBacktick + 1);
  if (!content || ONLY_MARKERS.test(content)) return text;
  // Backticks that open or close a code span: not escaped, not in a ```.
  let backticks = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\" && text[index + 1] === "`") {
      index += 1;
    } else if (
      text[index] === "`" &&
      !text.slice(Math.max(0, index - 2), index + 3).includes(FENCE)
    ) {
      backticks += 1;
    }
  }
  return backticks % 2 === 1 ? `${text}\`` : text;
}

function completeStrikethrough(text: string): string {
  const content = text.match(/~~([^~]*?)$/)?.[1];
  // `~~text~` is missing only its last `~`.
  const halfClosed = content === undefined && /~~[^~]+~$/.test(text);
  if (
    (content === undefined
      ? !halfClosed
      : !content || ONLY_MARKERS.test(content)) ||
    isInsideAnyCode(text, text.lastIndexOf("~~")) ||
    text.split("~~").length % 2 === 1
  ) {
    return text;
  }
  return halfClosed ? `${text}~` : `${text}~~`;
}

// `[text](url` and `[text` show as plain `text`; an unfinished image is dropped.
function completeLinks(text: string): string {
  const urlStart = text.lastIndexOf("](");
  if (
    urlStart !== -1 &&
    !isInsideCode(text, urlStart) &&
    !text.slice(urlStart + 2).includes(")")
  ) {
    const open = matchingBracket(text, urlStart, -1);
    if (open !== -1 && !isInsideCode(text, open)) {
      return text[open - 1] === "!"
        ? text.slice(0, open - 1)
        : text.slice(0, open) + text.slice(open + 1, urlStart);
    }
  }
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (
      text[index] !== "[" ||
      isInsideCode(text, index) ||
      matchingBracket(text, index, 1) !== -1
    ) {
      continue;
    }
    if (text[index - 1] === "!") return text.slice(0, index - 1);
    // Drop the first `[` that never closes, skipping whole [text](url) links.
    let unclosed = index;
    for (let at = 0; at < index; at += 1) {
      if (text[at] !== "[" || isInsideCode(text, at) || text[at - 1] === "!") {
        continue;
      }
      const close = matchingBracket(text, at, 1);
      if (close === -1) {
        unclosed = at;
        break;
      }
      const urlEnd =
        text[close + 1] === "(" ? text.indexOf(")", close + 2) : -1;
      if (urlEnd !== -1) at = urlEnd;
    }
    return text.slice(0, unclosed) + text.slice(unclosed + 1);
  }
  return text;
}

// The bracket that pairs with the one at `from`, scanning forward from a `[`
// (step 1) or back from a `]` (step -1); -1 when there is none.
function matchingBracket(text: string, from: number, step: 1 | -1): number {
  const same = step === 1 ? "[" : "]";
  const pair = step === 1 ? "]" : "[";
  let depth = 1;
  for (let index = from + step; index >= 0 && index < text.length;) {
    if (text[index] === same) depth += 1;
    else if (text[index] === pair && --depth === 0) return index;
    index += step;
  }
  return -1;
}
