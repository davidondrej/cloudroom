import { calculate } from "./arithmetic.ts";
import type { Library, Snippet } from "./library.ts";

interface Field {
  name: string;
  initial: string;
  choices: string[];
}
interface Context {
  values?: Record<string, string>;
  clipboard?: string;
  clipboardHistory?: string[];
  now?: Date;
}
const token =
  /\{(argument|clipboard|cursor|date|time|datetime|day|uuid|snippet|calculator)\b((?:"[^"]*"|[^{}"])*)\}/g;
// Pre-computed ASCII bitmaps match V8's Unicode regexes identically with O(1) lookup.
const ASCII_DELIMITER = new Uint8Array(128);
const ASCII_WORD = new Uint8Array(128);
for (let i = 0; i < 128; i++) {
  const ch = String.fromCharCode(i);
  if (/^[\s\p{P}]$/u.test(ch)) ASCII_DELIMITER[i] = 1;
  if (/^[\p{L}\p{N}_]$/u.test(ch)) ASCII_WORD[i] = 1;
}
function isLowSurrogate(code: number) {
  return code >= 0xdc00 && code <= 0xdfff;
}
function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff;
}
function trailingDelimiter(text: string): string | undefined {
  const len = text.length;
  if (!len) return undefined;
  const code = text.charCodeAt(len - 1);
  if (code < 128) return ASCII_DELIMITER[code] ? text[len - 1] : undefined;
  const start =
    isLowSurrogate(code) && len > 1 && isHighSurrogate(text.charCodeAt(len - 2))
      ? len - 2
      : len - 1;
  const ch = text.slice(start);
  return /^[\s\p{P}]$/u.test(ch) ? ch : undefined;
}
function hasWordBoundaryBefore(text: string, endExclusive: number): boolean {
  const pos = endExclusive - 1;
  if (pos < 0) return true;
  const code = text.charCodeAt(pos);
  if (code < 128) return !ASCII_WORD[code];
  const start =
    isLowSurrogate(code) && pos > 0 && isHighSurrogate(text.charCodeAt(pos - 1))
      ? pos - 1
      : pos;
  return !/^[\p{L}\p{N}_]$/u.test(text.slice(start, pos + 1));
}
function options(source: string) {
  return Object.fromEntries(
    Array.from(source.matchAll(/(\w+)=(?:"([^"]*)"|([^\s|]+))/g), (m) => [
      m[1],
      m[2] ?? m[3],
    ]),
  );
}
const attributes: Record<string, string[]> = {
  argument: ["name", "default", "options"],
  snippet: ["name"],
  clipboard: ["offset"],
  calculator: ["expression"],
  date: ["format", "locale", "offset"],
  time: ["format", "locale", "offset"],
  day: ["format", "locale", "offset"],
  datetime: ["format", "locale", "offset"],
  uuid: [],
  cursor: [],
};
function* placeholders(source: string) {
  if (!source.includes("{")) return;
  for (const match of source.matchAll(token)) {
    const [, kind, body] = match;
    if (
      !/^(?:\s+\w+=(?:"[^"]*"|[^\s|"{}]+))*\s*(?:\|\s*[a-z-]+\s*)*$/.test(body)
    )
      continue;
    const attrs = options(body);
    if (Object.keys(attrs).some((key) => !attributes[kind].includes(key)))
      continue;
    if (kind === "snippet" && !attrs.name) continue;
    yield match;
  }
}
function dateValue(kind: string, attrs: Record<string, string>, now: Date) {
  if (attrs.format && attrs.locale)
    throw new Error("Choose either a date format or a locale.");
  if (attrs.offset && !/^(?:[+-]\d+[mhdMy]\s*)+$/.test(attrs.offset))
    throw new Error("Invalid date offset.");
  const date = new Date(now);
  for (const [, n, unit] of (attrs.offset ?? "").matchAll(
    /([+-]\d+)([mhdMy])/g,
  )) {
    const amount = Number(n);
    if (unit === "y") date.setFullYear(date.getFullYear() + amount);
    if (unit === "M") date.setMonth(date.getMonth() + amount);
    if (unit === "d") date.setDate(date.getDate() + amount);
    if (unit === "h") date.setHours(date.getHours() + amount);
    if (unit === "m") date.setMinutes(date.getMinutes() + amount);
  }
  const fmt = (opt: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(attrs.locale, opt).format(date);
  if (!attrs.format) {
    if (kind === "day") return fmt({ weekday: "long" });
    if (kind === "time") return fmt({ timeStyle: "short" });
    return fmt({
      dateStyle: "medium",
      ...(kind === "datetime" && { timeStyle: "short" as const }),
    });
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = date.getHours(),
    m = date.getMonth() + 1,
    d = date.getDate(),
    y = date.getFullYear(),
    offset = -date.getTimezoneOffset();
  const digits: Record<string, string | number> = {
    yyyy: y,
    yy: pad(y % 100),
    M: m,
    MM: pad(m),
    MMM: fmt({ month: "short" }),
    MMMM: fmt({ month: "long" }),
    d,
    dd: pad(d),
    EEEE: fmt({ weekday: "long" }),
    EEE: fmt({ weekday: "short" }),
    E: fmt({ weekday: "short" }),
    H: h,
    HH: pad(h),
    h: h % 12 || 12,
    hh: pad(h % 12 || 12),
    m: date.getMinutes(),
    mm: pad(date.getMinutes()),
    s: date.getSeconds(),
    ss: pad(date.getSeconds()),
    SSS: String(date.getMilliseconds()).padStart(3, "0"),
    a: h < 12 ? "AM" : "PM",
    Z:
      (offset < 0 ? "-" : "+") +
      pad(Math.floor(Math.abs(offset) / 60)) +
      pad(Math.abs(offset) % 60),
  };
  return attrs.format.replace(
    /'([^']*)'|yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|E|HH|H|hh|h|mm|m|ss|s|SSS|a|Z/g,
    (key, literal) => literal ?? String(digits[key]),
  );
}

function buildByName(library: Library): Map<string, Snippet[]> {
  const byName = new Map<string, Snippet[]>();
  for (const snippet of library) {
    const bucket = byName.get(snippet.name);
    if (bucket) bucket.push(snippet);
    else byName.set(snippet.name, [snippet]);
  }
  return byName;
}

function reference(
  body: string,
  library: Library,
  byName?: Map<string, Snippet[]>,
) {
  const name = options(body).name;
  const matches = byName
    ? (byName.get(name) ?? [])
    : library.filter((s) => s.name === name);
  if (
    !matches.length ||
    matches.some((s) => s.text !== matches[0].text) ||
    Array.from(placeholders(matches[0].text)).some((m) => m[1] === "snippet")
  )
    throw new Error("Missing, ambiguous, or nested snippet: " + name);
  return matches[0].text;
}

function walk(
  source: string,
  library: Library,
  visit: (kind: string, body: string) => void,
  byName?: Map<string, Snippet[]>,
) {
  for (const [, kind, body] of placeholders(source)) {
    if (kind === "snippet")
      walk(reference(body, library, byName), library, visit, byName);
    else visit(kind, body);
  }
}
export function requiresClipboard(source: string, library: Library) {
  let required = false;
  walk(source, library, (kind) => {
    if (kind === "clipboard") required = true;
  });
  return required;
}
export function argumentFields(
  source: string,
  library: Library,
  byName?: Map<string, Snippet[]>,
): Field[] {
  const fields = new Map<string, Field>();
  let index = 0;
  walk(
    source,
    library,
    (kind, body) => {
      const attrs = options(body);
      if (kind === "calculator" && !attrs.expression) {
        fields.set("calculator", {
          name: "calculator",
          initial: "",
          choices: [],
        });
        return;
      }
      if (kind !== "argument") return;
      const name = attrs.name ?? String(++index);
      if (!fields.has(name))
        fields.set(name, {
          name,
          initial: attrs.default ?? "",
          choices: attrs.options?.split(",").map((s) => s.trim()) ?? [],
        });
    },
    byName,
  );
  if ([...fields.keys()].filter((k) => k !== "calculator").length > 3)
    throw new Error("A snippet can use up to three arguments.");
  return [...fields.values()];
}
function modified(value: string, body: string) {
  for (const mod of body
    .replace(/"[^"]*"/g, "")
    .split("|")
    .slice(1)
    .map((s) => s.trim())) {
    switch (mod) {
      case "uppercase":
        value = value.toUpperCase();
        break;
      case "lowercase":
        value = value.toLowerCase();
        break;
      case "trim":
        value = value.trim();
        break;
      case "percent-encode":
        value = encodeURIComponent(value);
        break;
      case "json-stringify":
        value = JSON.stringify(value);
        break;
      case "raw":
        break;
      default:
        throw new Error("Unknown placeholder modifier: " + mod);
    }
  }
  return value;
}
function renderSnippetInternal(
  source: string,
  library: Library,
  context: Context,
  byName?: Map<string, Snippet[]>,
  skipArgumentFields = false,
) {
  const values = context.values ?? {};
  if (
    typeof values !== "object" ||
    Array.isArray(values) ||
    Object.values(values).some((v) => typeof v !== "string")
  )
    throw new Error("Arguments must be a JSON object of strings.");
  const fields = skipArgumentFields
      ? []
      : argumentFields(source, library, byName),
    now = context.now ?? new Date();
  let index = 0;
  function render(template: string): { text: string; cursor?: number } {
    let text = "",
      cursor: number | undefined,
      last = 0;
    for (const match of placeholders(template)) {
      const [, kind, body] = match,
        attrs = options(body);
      text += template.slice(last, match.index);
      last = match.index + match[0].length;
      let value = "",
        innerCursor: number | undefined;
      switch (kind) {
        case "snippet": {
          const referenced = render(reference(body, library, byName));
          value = referenced.text;
          innerCursor = referenced.cursor;
          break;
        }
        case "cursor":
          innerCursor = 0;
          break;
        case "argument": {
          const name = attrs.name ?? String(++index);
          value =
            (Object.hasOwn(values, name) ? values[name] : undefined) ??
            attrs.default ??
            "";
          if (!value) throw new Error("Enter a value for " + name + ".");
          const choices = fields.find((f) => f.name === name)?.choices;
          if (choices?.length && !choices.includes(value))
            throw new Error("Choose a listed value for " + name + ".");
          break;
        }
        case "clipboard": {
          const offset = attrs.offset ?? "0";
          if (!/^\d+$/.test(offset))
            throw new Error("Clipboard offset must be a non-negative integer.");
          if (Number(offset) > 0 && !context.clipboardHistory)
            throw new Error(
              "Enable chat clipboard history or pass --clipboard-history.",
            );
          value =
            context.clipboardHistory?.[Number(offset)] ??
            (Number(offset) === 0 ? (context.clipboard ?? "") : "");
          break;
        }
        case "uuid":
          value = crypto.randomUUID().toUpperCase();
          break;
        case "calculator":
          value = calculate(attrs.expression ?? values.calculator ?? "");
          break;
        default:
          value = dateValue(kind, attrs, now);
          break;
      }
      if (innerCursor !== undefined) {
        if (cursor !== undefined)
          throw new Error("Use a single cursor placeholder.");
        cursor =
          text.length +
          (innerCursor === 0
            ? 0
            : modified(value.slice(0, innerCursor), body).length);
      }
      text += modified(value, body);
      if (text.length > 1024 * 1024)
        throw new Error("Expanded snippet exceeds 1 MiB.");
    }
    return { text: text + template.slice(last), cursor };
  }
  return render(source);
}
export function renderSnippet(
  source: string,
  library: Library,
  context: Context = {},
) {
  return renderSnippetInternal(source, library, context);
}
export type ExpansionMode = "immediate" | "keep" | "discard" | "off";
export interface CompiledSnippet {
  snippet: Snippet;
  staticResult: { text: string; cursor?: number } | null;
  hasArgs: boolean;
  needsClipboard: boolean;
  compileError: boolean;
}
interface TrieNode {
  children: Map<number, TrieNode> | null;
  entries: CompiledSnippet[] | null;
  hasConflict: boolean;
  keywordLen: number;
}
export interface CompiledMatch {
  compiled: CompiledSnippet;
  snippet: Snippet;
  choices: Snippet[];
  remove: number;
  suffix: string;
}
export interface SnippetIndex {
  readonly library: Library;
  readonly mode: ExpansionMode;
  readonly withinWords: boolean;
  readonly maxLookback: number;
  readonly byName: Map<string, Snippet[]>;
  canEndWith(text: string): boolean;
  match(before: string): CompiledMatch | undefined;
  compiledOf(snippet: Snippet): CompiledSnippet | undefined;
  renderSync(
    compiled: CompiledSnippet,
    context?: Context,
  ): { text: string; cursor?: number };
}

function compileSnippet(
  snippet: Snippet,
  library: Library,
  byName: Map<string, Snippet[]>,
): CompiledSnippet {
  if (!snippet.text.includes("{")) {
    return {
      snippet,
      staticResult: { text: snippet.text, cursor: undefined },
      hasArgs: false,
      needsClipboard: false,
      compileError: false,
    };
  }
  try {
    const found = [...placeholders(snippet.text)];
    if (!found.length) {
      return {
        snippet,
        staticResult: { text: snippet.text, cursor: undefined },
        hasArgs: false,
        needsClipboard: false,
        compileError: false,
      };
    }
    if (
      found.length === 1 &&
      found[0][1] === "cursor" &&
      !found[0][2].includes("|")
    ) {
      const m = found[0];
      const cursor = m.index!;
      return {
        snippet,
        staticResult: {
          text:
            snippet.text.slice(0, cursor) +
            snippet.text.slice(cursor + m[0].length),
          cursor,
        },
        hasArgs: false,
        needsClipboard: false,
        compileError: false,
      };
    }
    let hasArgs = false;
    let needsClipboard = false;
    let argIndex = 0;
    const argNames = new Set<string>();
    walk(
      snippet.text,
      library,
      (kind, body) => {
        if (kind === "clipboard") needsClipboard = true;
        else if (kind === "calculator") {
          if (!options(body).expression) hasArgs = true;
        } else if (kind === "argument") {
          hasArgs = true;
          argNames.add(options(body).name ?? String(++argIndex));
        }
      },
      byName,
    );
    if (argNames.size > 3) {
      return {
        snippet,
        staticResult: null,
        hasArgs: false,
        needsClipboard: false,
        compileError: true,
      };
    }
    return {
      snippet,
      staticResult: null,
      hasArgs,
      needsClipboard,
      compileError: false,
    };
  } catch {
    return {
      snippet,
      staticResult: null,
      hasArgs: false,
      needsClipboard: false,
      compileError: true,
    };
  }
}

export function compileLibrary(
  items: Library,
  mode: ExpansionMode,
  withinWords: boolean,
): SnippetIndex {
  const byName = buildByName(items);
  const compiledBySnippet = new Map<Snippet, CompiledSnippet>();
  const root: TrieNode = {
    children: null,
    entries: null,
    hasConflict: false,
    keywordLen: 0,
  };
  const endAscii = new Uint8Array(128);
  let maxKeywordLen = 0;

  for (const snippet of items) {
    const compiled = compileSnippet(snippet, items, byName);
    compiledBySnippet.set(snippet, compiled);
    if (mode === "off" || !snippet.keyword) continue;
    const kw = snippet.keyword;
    const lastCode = kw.charCodeAt(kw.length - 1);
    if (lastCode < 128) endAscii[lastCode] = 1;
    let node = root;
    for (let i = kw.length - 1; i >= 0; i--) {
      const code = kw.charCodeAt(i);
      if (!node.children) node.children = new Map();
      let next = node.children.get(code);
      if (!next) {
        next = {
          children: null,
          entries: null,
          hasConflict: false,
          keywordLen: 0,
        };
        node.children.set(code, next);
      }
      node = next;
    }
    if (!node.entries) {
      node.entries = [compiled];
      node.keywordLen = kw.length;
    } else {
      if (compiled.snippet.text !== node.entries[0].snippet.text) {
        node.hasConflict = true;
      }
      node.entries.push(compiled);
    }
    if (kw.length > maxKeywordLen) maxKeywordLen = kw.length;
  }

  const maxLookback = maxKeywordLen ? maxKeywordLen + 4 : 0;

  return {
    library: items,
    mode,
    withinWords,
    maxLookback,
    byName,
    canEndWith(text: string) {
      if (mode === "off" || !maxKeywordLen || !text.length) return false;
      const code = text.charCodeAt(text.length - 1);
      if (mode === "immediate") {
        return code < 128
          ? endAscii[code] === 1
          : (root.children?.has(code) ?? false);
      }
      return code < 128
        ? ASCII_DELIMITER[code] === 1
        : trailingDelimiter(text) !== undefined;
    },
    match(before: string) {
      if (mode === "off" || !maxKeywordLen || !before.length) return undefined;
      let end = before.length;
      let delimiter = "";
      if (mode !== "immediate") {
        const d = trailingDelimiter(before);
        if (d === undefined) return undefined;
        delimiter = d;
        end -= d.length;
      }
      let node: TrieNode | undefined = root;
      let best: TrieNode | undefined;
      for (let i = end - 1; i >= 0; i--) {
        node = node.children?.get(before.charCodeAt(i));
        if (!node) break;
        if (node.entries && (withinWords || hasWordBoundaryBefore(before, i))) {
          best = node;
        }
      }
      if (!best) return undefined;
      const first = best.entries![0];
      return {
        compiled: first,
        snippet: first.snippet,
        choices: best.hasConflict ? best.entries!.map((e) => e.snippet) : [],
        remove: best.keywordLen + delimiter.length,
        suffix: mode === "keep" ? delimiter : "",
      };
    },
    compiledOf(snippet: Snippet) {
      return compiledBySnippet.get(snippet);
    },
    renderSync(compiled: CompiledSnippet, context: Context = {}) {
      if (compiled.staticResult && !compiled.compileError) {
        return compiled.staticResult;
      }
      return renderSnippetInternal(
        compiled.snippet.text,
        items,
        context,
        byName,
        !compiled.hasArgs && !compiled.compileError,
      );
    },
  };
}

export function matchKeyword(
  before: string,
  items: Library,
  mode: ExpansionMode,
  withinWords: boolean,
) {
  if (mode === "off") return;
  const delimiter = mode === "immediate" ? "" : trailingDelimiter(before);
  if (delimiter === undefined) return;
  const end = before.length - delimiter.length;
  const input = delimiter ? before.slice(0, end) : before;
  let bestLen = 0;
  let matches: Snippet[] = [];
  for (const s of items) {
    const len = s.keyword.length;
    if (!len || len < bestLen || !input.endsWith(s.keyword)) continue;
    if (!withinWords && !hasWordBoundaryBefore(input, end - len)) continue;
    if (len > bestLen) {
      bestLen = len;
      matches = [s];
    } else {
      matches.push(s);
    }
  }
  const first = matches[0];
  if (!first) return;
  return {
    snippet: first,
    choices: matches.some((row) => row.text !== first.text) ? matches : [],
    remove: bestLen + delimiter.length,
    suffix: mode === "keep" ? delimiter : "",
  };
}
