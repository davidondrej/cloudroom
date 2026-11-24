import { stripVTControlCharacters } from "node:util";

interface BorderlessTableOptions {
  head: string[];
  colWidths: number[];
  trimTrailingWhitespace?: boolean;
}

// What a terminal draws as one character: a flag, a keycap, an emoji with its
// skin tone and joined parts, or else a single code point.
const CHARACTER =
  /\p{Regional_Indicator}\p{Regional_Indicator}|[#*0-9]\u{fe0f}?\u{20e3}|\p{Extended_Pictographic}(?:[\u{fe0f}\p{Emoji_Modifier}\u{e0020}-\u{e007f}]|\u{200d}\p{Extended_Pictographic})*|./gsu;
const EMOJI = /^(?:\p{Emoji_Presentation}|.{2,})$/su;
const ZERO_WIDTH = /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{300}-\u{36f}]/u;
// East Asian wide and fullwidth characters take two terminal columns.
const WIDE =
  /[\u{1100}-\u{115f}\u{2329}\u{232a}\u{2e80}-\u{303e}\u{3040}-\u{3247}\u{3250}-\u{4dbf}\u{4e00}-\u{a4c6}\u{a960}-\u{a97c}\u{ac00}-\u{d7a3}\u{f900}-\u{faff}\u{fe10}-\u{fe19}\u{fe30}-\u{fe6b}\u{ff01}-\u{ff60}\u{ffe0}-\u{ffe6}\u{1b000}\u{1b001}\u{1f200}-\u{1f251}\u{20000}-\u{3fffd}]/u;

function characterWidth(character: string): number {
  if (EMOJI.test(character)) return 2;
  if (ZERO_WIDTH.test(character)) return 0;
  return WIDE.test(character) ? 2 : 1;
}

/** Pads one line of a cell to `width` columns, or cuts it short with "…". */
function fitCell(text: string, width: number): string {
  const characters = stripVTControlCharacters(text).match(CHARACTER) ?? [];
  const widths = characters.map(characterWidth);
  let used = widths.reduce((sum, next) => sum + next, 0);
  if (used <= width) return text + " ".repeat(width - used);
  let cut = "";
  used = 1; // the "…"
  for (const [index, character] of characters.entries()) {
    if (used + widths[index] > width) break;
    used += widths[index];
    cut += character;
  }
  return `${cut}…${" ".repeat(width - used)}`;
}

export function renderBorderlessTable(
  options: BorderlessTableOptions,
  rows: string[][],
): string {
  const widths = options.colWidths.map((width) => Math.max(1, width));
  const hasHead = options.head.length > 0;
  const table = hasHead ? [options.head, ...rows] : rows;
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  const lines = table.flatMap((row, index) => {
    const cells = widths.map((_, column) => (row[column] ?? "").split("\n"));
    const height = Math.max(...cells.map((cell) => cell.length));
    const content = Array.from({ length: height }, (_, line) =>
      widths
        .map((width, column) => fitCell(cells[column][line] ?? "", width))
        .join("  "),
    );
    // A line under the head only, not after every row: it doubled the output.
    return hasHead && index === 1 ? [separator, ...content] : content;
  });
  return lines
    .map((line) => (options.trimTrailingWhitespace ? line.trimEnd() : line))
    .join("\n");
}

export function printBorderlessTable(
  options: BorderlessTableOptions,
  rows: string[][],
): void {
  console.log("");
  console.log(renderBorderlessTable(options, rows));
  console.log("");
}

export function columnWidths(
  rows: string[][],
  minimums: readonly number[],
): number[] {
  return minimums.map((minimum, index) =>
    Math.max(minimum, ...rows.map((row) => row[index].length)),
  );
}

export function truncateCell(value: string, maxWidth: number): string {
  const singleLine = value.replace(/\s+/gu, " ");
  if (singleLine.length <= maxWidth) return singleLine;
  return `${singleLine.slice(0, maxWidth - 1)}…`;
}
