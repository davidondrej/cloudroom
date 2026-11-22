import type { TimelineActivityIntent } from "@cloudroom/server-contract";

const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh"]);
const SEGMENT_BREAKS = new Set(["&&", "||", "|", ";", "\n"]);
const DOUBLE_QUOTE_ESCAPABLE = new Set(["$", "`", '"', "\\", "\n"]);
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/u;

const SEARCH_VALUE_FLAGS = new Set([
  "-g", "--glob", "-t", "--type", "-T", "--type-not",
  "-A", "--after-context", "-B", "--before-context",
  "-C", "--context", "-m", "--max-count",
]);
const FIND_VALUE_FLAGS = new Set([
  "-name", "-iname", "-path", "-ipath", "-type", "-maxdepth", "-mindepth",
  "-size", "-mtime", "-mmin", "-user", "-group", "-perm", "-regex", "-iregex",
]);
const HEAD_TAIL_VALUE_FLAGS = new Set(["-n", "-c"]);
const EMPTY_FLAGS = new Set<string>();

interface ShellToken {
  readonly value: string;
  readonly quoted: boolean;
}

function unwrapQuoted(value: string): string {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== "'" && quote !== '"') || value[value.length - 1] !== quote) {
    return value;
  }
  const inner = value.slice(1, -1);
  if (quote === "'") return inner;

  let out = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (ch === "\\" && i + 1 < inner.length && DOUBLE_QUOTE_ESCAPABLE.has(inner[i + 1]!)) {
      out += inner[i + 1]!;
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

export function extractShellCommandFromString(
  value: string,
): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  const match = /^(\S+)\s+(-lc|-c)\s+([\s\S]+)$/.exec(trimmed);
  if (!match) return trimmed;

  const program = match[1]!;
  const shellName = program.split("/").pop() ?? program;
  if (!SHELL_WRAPPERS.has(shellName)) return trimmed;
  return unwrapQuoted(match[3]!.trim());
}

function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = "";
  let hasQuoted = false;
  let hasUnquoted = false;
  let quote: "'" | '"' | null = null;
  let escaping = false;

  const flush = () => {
    const fullyQuoted = hasQuoted && !hasUnquoted;
    if (current.length > 0 || fullyQuoted) {
      tokens.push({ value: current, quoted: fullyQuoted });
    }
    current = "";
    hasQuoted = false;
    hasUnquoted = false;
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (escaping) {
      current += ch;
      if (quote !== null) hasQuoted = true;
      else hasUnquoted = true;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      if (
        quote === "'" ||
        (quote === '"' &&
          (command[i + 1] === undefined ||
            !DOUBLE_QUOTE_ESCAPABLE.has(command[i + 1]!)))
      ) {
        current += ch;
        hasQuoted = true;
      } else {
        escaping = true;
      }
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
        if (current.length === 0) hasQuoted = true;
      } else {
        current += ch;
        hasQuoted = true;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\n") {
      flush();
      tokens.push({ value: "\n", quoted: false });
      continue;
    }
    if (/\s/u.test(ch)) {
      flush();
      continue;
    }
    if (ch === "|" || ch === "&" || ch === ";") {
      if (ch === "&" && command[i + 1] === ">") {
        flush();
        if (command[i + 2] === ">") {
          tokens.push({ value: "&>>", quoted: false });
          i += 2;
        } else {
          tokens.push({ value: "&>", quoted: false });
          i += 1;
        }
        continue;
      }
      flush();
      const next = command[i + 1];
      if ((ch === "|" && next === "|") || (ch === "&" && next === "&")) {
        tokens.push({ value: `${ch}${next}`, quoted: false });
        i += 1;
      } else {
        tokens.push({ value: ch, quoted: false });
      }
      continue;
    }
    if (ch === "<" || ch === ">") {
      let prefix = "";
      if (hasUnquoted && !hasQuoted && (current === "&" || /^\d+$/u.test(current))) {
        prefix = current;
        current = "";
        hasUnquoted = false;
      } else if (current.length > 0 || hasQuoted) {
        flush();
      }
      const n1 = command[i + 1];
      const n2 = command[i + 2];
      let op = ch;
      if (ch === ">" && (n1 === ">" || n1 === "|" || n1 === "(" || n1 === "&")) {
        op = `${ch}${n1}`;
      } else if (ch === "<") {
        if (n1 === "<" && (n2 === "<" || n2 === "-")) op = `<${n1}${n2}`;
        else if (n1 === "<" || n1 === "(" || n1 === ">") op = `<${n1}`;
      }
      tokens.push({ value: `${prefix}${op}`, quoted: false });
      i += op.length - 1;
      continue;
    }
    current += ch;
    hasUnquoted = true;
  }

  if (escaping) {
    current += "\\";
    hasUnquoted = true;
  }
  flush();
  return tokens;
}

function scanRedirect(
  tokens: readonly ShellToken[],
  index: number,
): { isWrite: boolean; extra: number } | null {
  const token = tokens[index];
  if (!token || token.quoted) return null;
  const v = token.value;
  const next = tokens[index + 1]?.value;

  if (/^(?:\d+|&)?<<-?$/u.test(v)) return { isWrite: true, extra: 1 };
  if (/^(?:\d+|&)?<<<$/u.test(v)) return { isWrite: false, extra: 1 };
  if (v === "<(" || v === ">(") {
    let extra = 0;
    for (let j = index + 1; j < tokens.length; j += 1) {
      extra += 1;
      if (tokens[j]!.value.endsWith(")")) break;
    }
    return { isWrite: false, extra };
  }
  if (/^(?:\d+|&)?<>$/u.test(v)) return { isWrite: true, extra: 1 };
  if (/^(?:\d+|&)?<$/u.test(v)) return { isWrite: false, extra: 1 };
  if (/^(?:\d+|&)?>\|$/u.test(v)) {
    return { isWrite: next !== "/dev/null", extra: 1 };
  }
  if (/^(\d*|&)>>?&$/u.test(v)) {
    return { isWrite: false, extra: next === undefined ? 0 : 1 };
  }
  const match = /^(\d+|&)?>>?$/u.exec(v);
  if (match) {
    if (next === undefined) return { isWrite: false, extra: 0 };
    const prefix = match[1] ?? "";
    const isWrite = !/^[2-9]/u.test(prefix) && next !== "/dev/null";
    return { isWrite, extra: 1 };
  }
  return null;
}

function collectPositionals(
  args: readonly ShellToken[],
  valueFlags: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; ) {
    const redir = scanRedirect(args, i);
    if (redir) {
      i += 1 + redir.extra;
      continue;
    }
    const token = args[i]!;
    if (!token.quoted && token.value.startsWith("-") && token.value !== "-") {
      i += valueFlags.has(token.value) ? 2 : 1;
      continue;
    }
    out.push(token.value);
    i += 1;
  }
  return out;
}

function classifySegment(
  tokens: readonly ShellToken[],
  fullCommand: string,
): { kind: "write" } | { kind: "intent"; intent: TimelineActivityIntent } | { kind: "none" } {
  let cmdIndex = 0;
  while (
    cmdIndex < tokens.length &&
    !tokens[cmdIndex]!.quoted &&
    ENV_ASSIGN_RE.test(tokens[cmdIndex]!.value)
  ) {
    cmdIndex += 1;
  }
  const cmdToken = tokens[cmdIndex];
  if (!cmdToken) return { kind: "none" };

  const args = tokens.slice(cmdIndex + 1);
  const slash = cmdToken.value.lastIndexOf("/");
  const name = slash >= 0 ? cmdToken.value.slice(slash + 1) : cmdToken.value;

  if (name === "tee") return { kind: "write" };
  if (
    name === "sed" &&
    args.some(
      (t) =>
        !t.quoted &&
        (t.value === "--in-place" ||
          t.value.startsWith("--in-place=") ||
          /^-i(?:$|[^-])/u.test(t.value)),
    )
  ) {
    return { kind: "write" };
  }
  for (let i = 0; i < args.length; ) {
    const redir = scanRedirect(args, i);
    if (redir) {
      if (redir.isWrite) return { kind: "write" };
      i += 1 + redir.extra;
    } else {
      i += 1;
    }
  }

  switch (name) {
    case "rg":
    case "grep": {
      const pos = collectPositionals(args, SEARCH_VALUE_FLAGS);
      return {
        kind: "intent",
        intent: {
          type: "search",
          command: fullCommand,
          query: pos[0] ?? null,
          path: pos.length > 1 ? pos[pos.length - 1]! : null,
        },
      };
    }
    case "find": {
      const path = collectPositionals(args, FIND_VALUE_FLAGS)[0];
      return path
        ? { kind: "intent", intent: { type: "list_files", command: fullCommand, path } }
        : { kind: "none" };
    }
    case "ls": {
      const path = collectPositionals(args, EMPTY_FLAGS)[0] ?? ".";
      return {
        kind: "intent",
        intent: { type: "list_files", command: fullCommand, path },
      };
    }
    case "cat":
    case "nl":
    case "head":
    case "tail": {
      const flags =
        name === "head" || name === "tail" ? HEAD_TAIL_VALUE_FLAGS : EMPTY_FLAGS;
      const path = collectPositionals(args, flags)[0];
      return path
        ? { kind: "intent", intent: { type: "read", command: fullCommand, name, path } }
        : { kind: "none" };
    }
    case "sed": {
      if (!args.some((t) => !t.quoted && t.value === "-n")) return { kind: "none" };
      const path = collectPositionals(args, EMPTY_FLAGS)[1];
      return path
        ? { kind: "intent", intent: { type: "read", command: fullCommand, name: "sed", path } }
        : { kind: "none" };
    }
    default:
      return { kind: "none" };
  }
}

export function parseShellCommandIntents(
  command: string | undefined,
): TimelineActivityIntent[] {
  if (!command) return [];

  const tokens = tokenizeShell(command);
  const segments: ShellToken[][] = [];
  let current: ShellToken[] = [];
  for (const token of tokens) {
    if (!token.quoted && SEGMENT_BREAKS.has(token.value)) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) segments.push(current);

  let firstIntent: TimelineActivityIntent | null = null;
  for (const segment of segments) {
    const result = classifySegment(segment, command);
    if (result.kind === "write") return [];
    if (result.kind === "intent" && firstIntent === null) {
      firstIntent = result.intent;
    }
  }
  return firstIntent ? [firstIntent] : [];
}
