import path from "node:path";

export type TerminalShellKind = "posix" | "powershell" | "cmd";

export type TerminalShellStart =
  | { mode: "shell" }
  | { mode: "command"; command: string }
  | { mode: "argv"; argv: readonly string[] };

interface ResolveWindowsTerminalShellArgs {
  env: NodeJS.ProcessEnv;
  fileExists: (filePath: string) => Promise<boolean>;
}

const WINDOWS_POWERSHELL_RELATIVE_PATH = path.win32.join(
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function shellProgramName(shell: string): string {
  const basename = shell.includes("\\")
    ? path.win32.basename(shell)
    : path.posix.basename(shell);
  return basename.toLowerCase().replace(/\.exe$/u, "");
}

export function terminalShellKind(shell: string): TerminalShellKind {
  const programName = shellProgramName(shell);
  if (programName === "pwsh" || programName === "powershell") {
    return "powershell";
  }
  if (programName === "cmd") {
    return "cmd";
  }
  return "posix";
}

// `-Command` alone exits 1 for every failure. Report a native program's own
// exit code, but only when it failed last: a stale $LASTEXITCODE from an
// earlier program, or a new cmdlet error after it, means exit 1.
const POWERSHELL_EXIT_CODE_PREFIX =
  "$global:LASTEXITCODE = 0; $__crErrorCount = $Error.Count\n";
const POWERSHELL_EXIT_CODE_SUFFIX =
  "\nif (-not $?) { if ($Error.Count -eq $__crErrorCount -and $LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1 }";

function quotePosixArgument(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * A start's command text for a POSIX shell. Windows never quotes an argument
 * list for its shells: it launches the program directly (terminal-manager).
 */
export function terminalStartCommandText(
  start: Exclude<TerminalShellStart, { mode: "shell" }>,
): string {
  return start.mode === "command"
    ? start.command
    : start.argv.map(quotePosixArgument).join(" ");
}

export function terminalShellArgs(args: {
  shell: string;
  start: TerminalShellStart;
}): string[] | string {
  const kind = terminalShellKind(args.shell);
  if (args.start.mode === "shell") {
    return kind === "powershell" ? ["-NoLogo"] : [];
  }
  const commandText = terminalStartCommandText(args.start);
  switch (kind) {
    case "powershell":
      return [
        "-NoLogo",
        "-Command",
        `${POWERSHELL_EXIT_CODE_PREFIX}${commandText}${POWERSHELL_EXIT_CODE_SUFFIX}`,
      ];
    case "cmd":
      // A raw command line: node-pty would escape quotes MSVC-style (`\"`),
      // which cmd doesn't understand. `/s` strips the outer quotes.
      return `/d /s /c "${commandText}"`;
    case "posix":
      return ["-lc", commandText];
  }
}

export function terminalShellTitle(shell: string): string {
  const basename = shell.includes("\\")
    ? path.win32.basename(shell)
    : path.posix.basename(shell);
  return basename.replace(/\.exe$/iu, "") || "Terminal";
}

export async function resolveWindowsTerminalShell(
  args: ResolveWindowsTerminalShellArgs,
): Promise<string> {
  const searchPath = args.env.PATH ?? args.env.Path ?? "";
  for (const directory of searchPath.split(path.win32.delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    const candidate = path.win32.join(directory, "pwsh.exe");
    if (await args.fileExists(candidate)) {
      return candidate;
    }
  }
  const systemRoot = args.env.SystemRoot ?? args.env.SYSTEMROOT;
  if (systemRoot !== undefined && systemRoot.length > 0) {
    const windowsPowerShell = path.win32.join(
      systemRoot,
      WINDOWS_POWERSHELL_RELATIVE_PATH,
    );
    if (await args.fileExists(windowsPowerShell)) {
      return windowsPowerShell;
    }
  }
  const commandInterpreter = args.env.ComSpec ?? args.env.COMSPEC;
  return commandInterpreter !== undefined && commandInterpreter.length > 0
    ? commandInterpreter
    : "cmd.exe";
}
