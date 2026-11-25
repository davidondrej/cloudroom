// Terminal output with ANSI escape codes as HTML for TerminalOutputBlock, which
// sets it as innerHTML. A port of ansi-to-html 0.7.2 and the entities 2.2.0
// escaping it used (both MIT), with TerminalOutputBlock's old options: same
// HTML, byte for byte. Unknown escape sequences are dropped.

// One match per text run, newline run, or escape sequence; every character
// starts one. Escape sequences keep ansi-to-html's priority. Its SGR pattern
// `(?:\d{1,3};?)+` is written as `\d+(?:;\d+)*;?`: the same matches, without
// exponential backtracking on long digit runs.
const TOKEN =
  /([^\x1b\x08\r\n]+|[\r\n]+)|\x1b\[([34])8;2;(\d+);(\d+);(\d+)m|\x1b\[([34])8;5;(\d+)m|\x1b\[(\d+(?:;\d+)*;?|)m|\x08+|\x1b\[(?:[012]?K|\(B|\d?J|\d{0,3};\d{0,3}f)|\x1b\[?[\d;]{0,3}/gy;

// entities.encodeXML: the five XML characters by name and every other
// non-ASCII character as a numeric reference, lone surrogates included.
const ESCAPE =
  /["&'<>]|[\x80-\uD7FF\uE000-\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/g;

const NAMED: Record<string, string> = {
  '"': "&quot;",
  "&": "&amp;",
  "'": "&apos;",
  "<": "&lt;",
  ">": "&gt;",
};

const escapeXml = (text: string) =>
  text.replace(
    ESCAPE,
    (char) =>
      NAMED[char] ?? `&#x${char.codePointAt(0)!.toString(16).toUpperCase()};`,
  );

const hex = (value: number) => `0${value.toString(16)}`.slice(-2);

// xterm's 256 colors: theme colors 0-15, a 6x6x6 color cube, then 24 grays.
function xtermColor(index: number): string {
  if (index < 16) return `var(--ansi-${index})`;
  if (index >= 232) return `#${hex((index - 232) * 10 + 8).repeat(3)}`;
  const cube = index - 16;
  const level = (value: number) => hex(value && value * 40 + 55);
  return `#${level(Math.floor(cube / 36))}${level(Math.floor(cube / 6) % 6)}${level(cube % 6)}`;
}

// Keyed by canonical numbers: "007" or "300" finds no color, as before.
const COLORS: Record<string, string> = Object.fromEntries(
  Array.from({ length: 256 }, (_, index) => [index, xtermColor(index)]),
);

export function terminalOutputHtml(output: string): string {
  const open: string[] = [];
  let html = "";
  const push = (tag: string, style?: string) => {
    open.push(tag);
    html += style ? `<${tag} style="${style}">` : `<${tag}>`;
  };
  const closeAll = () => {
    while (open.length > 0) html += `</${open.pop()}>`;
  };
  const foreground = (index: number | string) =>
    push("span", `color:${COLORS[index]}`);
  const background = (index: number | string) =>
    push("span", `background-color:${COLORS[index]}`);
  const graphics = (code: number) => {
    if (code === 0) closeAll();
    else if (code === 1) push("b");
    else if (code === 3) push("i");
    else if (code === 4) push("u");
    else if (code === 5 || code === 6) push("blink");
    else if (code === 8) push("span", "display:none");
    else if (code === 9) push("strike");
    else if (code === 22)
      push("span", "font-weight:normal;text-decoration:none;font-style:normal");
    else if (code === 23 || code === 24) {
      if (open.at(-1) === (code === 23 ? "i" : "u")) html += `</${open.pop()}>`;
    } else if (code === 39) push("span", "color:var(--muted-foreground)");
    else if (code === 49) push("span", "background-color:var(--background)");
    else if (code === 53) push("span", "text-decoration:overline");
    else if (code >= 30 && code <= 37) foreground(code - 30);
    else if (code >= 40 && code <= 47) background(code - 40);
    else if (code >= 90 && code <= 97) foreground(code - 82);
    else if (code >= 100 && code <= 107) background(code - 92);
  };

  for (const match of output.matchAll(TOKEN)) {
    const [, text, rgb, red, green, blue, xterm, index, codes] = match;
    if (text) html += escapeXml(text);
    else if (rgb) {
      const property = rgb === "3" ? "color" : "background-color";
      push(
        "span",
        `${property}:#${[red, green, blue].map((value) => hex(Number(value))).join("")}`,
      );
    } else if (xterm) (xterm === "3" ? foreground : background)(index);
    else if (codes !== undefined) {
      for (const code of (codes || "0").split(";"))
        graphics(Number.parseInt(code, 10));
    }
  }
  closeAll();
  return html;
}
