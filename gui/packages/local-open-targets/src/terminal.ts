import path from "node:path";
import {
  fail,
  type ExistingPath,
  type LocalTerminalRequest,
  type Location,
  type SshRequest,
} from "./system.js";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

const quote = (value: string) =>
  value === "" ? "''" : `'${value.replaceAll("'", "'\\''")}'`;

function assertSafe(command: string): string {
  if (CONTROL_CHARACTERS.test(command)) {
    fail(
      "path_not_openable",
      "This path can't be opened in a terminal because it contains control characters.",
    );
  }
  return command;
}

const EDITOR_SCRIPT = [
  "editor=''",
  'if [ -n "${VISUAL:-}" ]; then editor=$VISUAL; elif [ -n "${EDITOR:-}" ]; then editor=$EDITOR; elif command -v nvim >/dev/null 2>&1; then editor=nvim; elif command -v vim >/dev/null 2>&1; then editor=vim; elif command -v vi >/dev/null 2>&1; then editor=vi; elif command -v nano >/dev/null 2>&1; then editor=nano; elif command -v less >/dev/null 2>&1; then editor=less; fi',
  'if [ -n "$editor" ]; then editor_name=$(basename "$editor"); case "$editor_name" in nvim|vim|vi) if [ -n "$line" ] && [ -n "$column" ]; then "$editor" "+call cursor($line,$column)" "$file"; elif [ -n "$line" ]; then "$editor" "+$line" "$file"; else "$editor" "$file"; fi ;; nano) if [ -n "$line" ] && [ -n "$column" ]; then "$editor" "+$line,$column" "$file"; elif [ -n "$line" ]; then "$editor" "+$line" "$file"; else "$editor" "$file"; fi ;; less) if [ -n "$line" ]; then "$editor" "+${line}g" "$file"; else "$editor" "$file"; fi ;; *) "$editor" "$file" ;; esac; else printf "%s\\n" "No terminal editor found for $target"; fi',
].join("; ");

function openScript(request: Location & { path: string }): string {
  return [
    `target=${quote(request.path)}`,
    `line=${quote(request.lineNumber === null ? "" : String(request.lineNumber))}`,
    `column=${quote(request.columnNumber === null ? "" : String(request.columnNumber))}`,
    'if [ -d "$target" ]; then cd "$target" || exit; exec "${SHELL:-/bin/sh}"; fi',
    'if [ -f "$target" ]; then dir=$(dirname "$target") || exit; file=$(basename "$target") || exit; cd "$dir" || exit',
    EDITOR_SCRIPT,
    'exec "${SHELL:-/bin/sh}"',
    "fi",
    'printf "%s\\n" "Path is not a file or directory: $target"',
    'exec "${SHELL:-/bin/sh}"',
  ].join("; ");
}

export const localShellArgs = (request: Location & { path: string }) => [
  "/bin/sh",
  "-lc",
  openScript(request),
];

export const remoteSshArgs = (request: SshRequest) => [
  "ssh",
  "-t",
  "--",
  request.sshAuthority,
  openScript(request),
];

function splitShellWords(command: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let quoteChar: "'" | '"' | null = null;
  let escaping = false;
  for (const char of command.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
    } else if (char === "\\" && quoteChar !== "'") {
      escaping = true;
    } else if (quoteChar !== null) {
      if (char === quoteChar) quoteChar = null;
      else current += char;
    } else if (char === "'" || char === '"') {
      quoteChar = char;
    } else if (/\s/u.test(char)) {
      if (current.length > 0) words.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (escaping || quoteChar !== null) return null;
  if (current.length > 0) words.push(current);
  return words.length > 0 ? words : null;
}

function editorLocationArgs(editor: string, location: Location): string[] {
  const { lineNumber: line, columnNumber: column } = location;
  if (line === null) return [];
  const name = path
    .basename(editor.trim().split(/\s+/u)[0] ?? "")
    .replace(/\.exe$/iu, "")
    .toLowerCase();
  if (name === "nvim" || name === "vim" || name === "vi") {
    return [column === null ? `+${line}` : `+call cursor(${line},${column})`];
  }
  if (name === "nano") {
    return [column === null ? `+${line}` : `+${line},${column}`];
  }
  return name === "less" ? [`+${line}g`] : [];
}

function localCommand(request: LocalTerminalRequest): string {
  if (request.pathType === "directory") return `cd ${quote(request.path)}`;
  const cd = `cd ${quote(path.dirname(request.path))}`;
  if (request.editorCommand === null) return cd;
  const words = splitShellWords(request.editorCommand);
  if (words === null) {
    return `${cd} && ${request.editorCommand} ${quote(request.path)}`;
  }
  const location = editorLocationArgs(words[0]!, request);
  const separator = words.indexOf("--");
  const args =
    separator < 0
      ? [...words, ...location, request.path]
      : [
          ...words.slice(0, separator),
          ...location,
          ...words.slice(separator),
          request.path,
        ];
  return `${cd} && ${args.map(quote).join(" ")}`;
}

function appleScriptArgs(app: "Terminal" | "iTerm", command: string) {
  const text = assertSafe(command)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  return app === "Terminal"
    ? [
        "-e",
        `tell application "Terminal" to do script "${text}"`,
        "-e",
        'tell application "Terminal" to activate',
      ]
    : [
        "-e",
        'tell application "iTerm" to create window with default profile',
        "-e",
        `tell application "iTerm" to tell current session of current window to write text "${text}"`,
        "-e",
        'tell application "iTerm" to activate',
      ];
}

export const macTerminalLocalArgs =
  (app: "Terminal" | "iTerm") => (request: LocalTerminalRequest) =>
    appleScriptArgs(app, localCommand(request));

export const macTerminalSshArgs =
  (app: "Terminal" | "iTerm") => (request: SshRequest) =>
    appleScriptArgs(app, remoteSshArgs(request).map(quote).join(" "));

const directoryOf = (request: {
  path: string;
  pathType: ExistingPath["type"];
}) =>
  request.pathType === "directory" ? request.path : path.dirname(request.path);

export const openAppInDirectoryArgs =
  (app: string) =>
  (request: { path: string; pathType: ExistingPath["type"] }) => [
    "-a",
    app,
    directoryOf(request),
  ];

export function ghosttyLocalArgs(request: LocalTerminalRequest): string[] {
  if (request.pathType === "directory" || request.editorCommand === null) {
    return ["-a", "Ghostty", directoryOf(request)];
  }
  return [
    "-na",
    "Ghostty.app",
    "--args",
    "-e",
    request.shellPath,
    "-lc",
    localCommand(request),
  ];
}

export const ghosttySshArgs = (request: SshRequest) => [
  "-na",
  "Ghostty",
  "--args",
  "-e",
  ...remoteSshArgs(request),
];
