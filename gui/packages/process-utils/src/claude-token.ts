import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const TOKEN = /(sk-ant-oat[A-Za-z0-9_-]{20,})[^A-Za-z0-9_-]/;

export const NO_TERMINAL = "Claude sign-in needs the `script` command, which this computer doesn't have. Install it (on Fedora: `sudo dnf install util-linux-script`) and try again, or use an API key.";

/**
 * Starts `command` in a terminal, which Claude's sign-in needs; `stdout` carries the screen. Null when this computer can't make one.
 * macOS and Linux `script` take the command differently, and `script` needs a real pipe as input. `kill 0` ends the `sleep` if Claude exits early.
 * Fedora ships `script` in a separate package (util-linux-script), so Linux without it uses Python's pty module, with its errors on the screen.
 */
export function spawnInTerminal(command: string, env: NodeJS.ProcessEnv) {
  const tty = process.platform !== "linux" ? `/usr/bin/script -q /dev/null /bin/sh -c '${command}'`
    : existsSync("/usr/bin/script") ? `/usr/bin/script -q -c '${command}' /dev/null`
    : existsSync("/usr/bin/python3") ? `/usr/bin/python3 -c 'import pty,sys; pty.spawn(sys.argv[1:])' /bin/sh -c '${command}' 2>&1`
    : null;
  if (tty === null) return null;
  return spawn("/bin/sh", ["-c", `sleep 600 | { ${tty}; kill 0; }`], { env: { ...env, SHELL: "/bin/sh" }, stdio: ["ignore", "pipe", "ignore"], detached: true });
}

/** Rebuilds the terminal screen from raw `script` output, applying cursor moves and line clears. `conpty`: Windows'
 *  ConPTY also repaints with absolute cursor moves. */
export function screenText(output: string, conpty = false): string {
  const rows: string[][] = [];
  let row = 0, col = 0;
  for (const [, params = "", command, char] of output.matchAll(/\x1b\[([0-9;?<>=]*)([A-Za-z@`])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()*+]?[^\[\]]|([^])/gu)) {
    const n = Number(params) || 1;
    if (command === "G") col = n - 1;
    else if (command === "C") col += n;
    else if (command === "D") col = Math.max(0, col - n);
    else if (command === "A") row = Math.max(0, row - n);
    else if (command === "B") row += n;
    else if (conpty && command === "H") [row, col] = [0, 1].map(index => (Number(params.split(";")[index]) || 1) - 1) as [number, number];
    else if (command === "K") rows[row] = params === "2" ? [] : (rows[row] ?? []).slice(0, col);
    else if (char === "\r") col = 0;
    else if (char === "\n") row++;
    else if (char && char >= " ") (rows[row] ??= [])[col++] = char;
  }
  return Array.from(rows, line => Array.from(line ?? [], cell => cell ?? " ").join("")).join("\n");
}

/**
 * The one-year token in `claude setup-token` output, or undefined.
 * Claude Code (2.1.220 and later) skips characters already on screen, so the token is only whole on the rebuilt screen.
 */
export const readClaudeToken = (output: string, conpty = false): string | undefined =>
  (screenText(output, conpty).match(TOKEN) ?? output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").match(TOKEN))?.[1];

/** Anthropic's official Claude Code installer for this OS. It needs no terminal and puts `claude` in ~/.local/bin. */
export function claudeInstallerCommand(platform: NodeJS.Platform = process.platform): { command: string; args: string[]; display: string } {
  if (platform === "win32") {
    const display = "irm https://claude.ai/install.ps1 | iex";
    return { command: `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", display], display };
  }
  const display = "curl -fsSL https://claude.ai/install.sh | bash";
  return { command: "/bin/bash", args: ["-c", display], display };
}
