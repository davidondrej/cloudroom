import { calculate } from "./arithmetic.ts";
import type { Library } from "./library.ts";

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

function reference(body: string, library: Library) {
  const name = options(body).name;
  const matches = library.filter((s) => s.name === name);
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
) {
  for (const [, kind, body] of placeholders(source)) {
    if (kind === "snippet") walk(reference(body, library), library, visit);
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
export function argumentFields(source: string, library: Library): Field[] {
  const fields = new Map<string, Field>();
  let index = 0;
  walk(source, library, (kind, body) => {
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
  });
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
export function renderSnippet(
  source: string,
  library: Library,
  context: Context = {},
) {
  const values = context.values ?? {};
  if (
    typeof values !== "object" ||
    Array.isArray(values) ||
    Object.values(values).some((v) => typeof v !== "string")
  )
    throw new Error("Arguments must be a JSON object of strings.");
  const fields = argumentFields(source, library),
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
          const referenced = render(reference(body, library));
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
export type ExpansionMode = "immediate" | "keep" | "discard" | "off";
export function matchKeyword(
  before: string,
  items: Library,
  mode: ExpansionMode,
  withinWords: boolean,
) {
  if (mode === "off") return;
  const delimiter =
    mode === "immediate" ? "" : before.match(/[\s\p{P}]$/u)?.[0];
  if (delimiter === undefined) return;
  const input = before.slice(0, before.length - delimiter.length);
  const matches = items
    .filter((s) => {
      if (!s.keyword || !input.endsWith(s.keyword)) return false;
      return (
        withinWords ||
        !/[\p{L}\p{N}_]$/u.test(input.slice(0, -s.keyword.length))
      );
    })
    .sort((a, b) => b.keyword.length - a.keyword.length);
  const first = matches[0];
  if (!first) return;
  const choices = matches.filter((row) => row.keyword === first.keyword);
  return {
    snippet: first,
    choices: choices.some((row) => row.text !== first.text) ? choices : [],
    remove: first.keyword.length + delimiter.length,
    suffix: mode === "keep" ? delimiter : "",
  };
}
