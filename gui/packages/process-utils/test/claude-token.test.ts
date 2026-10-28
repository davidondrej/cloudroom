import { describe, expect, it } from "vitest";
import { claudeInstallerCommand, readClaudeToken, screenText } from "../src/claude-token.js";

// Built from the 2026-10-07 incident (docs/incidents/2026-10-07-onboarding-could-not-connect-agents.md), not live captures.
const TOKEN = `sk-ant-oat01-${"Ab3_-x".repeat(16)}AA`;
const intro = "\x1b]0;claude\x07\x1b[?25l\x1b[1mWelcome to Claude Code v2.1.220\x1b[22m\r\n\r\nPaste code here if prompted > \r\n";
// Claude Code 2.1.220+ redraws the "Paste code here" row in place and skips cells that already hold the same
// character, so the `o` of `sk-ant-oat01` (under the `o` of "code") is never printed.
const redrawn = `${intro}\x1b[?2026h\x1b[1A\rsk-ant-\x1b[1C${TOKEN.slice(8)}\x1b[K\r\n\r\nStore this token securely.\r\n\x1b[?2026l`;
const printed = `${intro}\r\n\x1b[32m✓\x1b[39m Long-lived authentication token created successfully!\r\n\r\n${TOKEN}\r\n\r\nStore this token securely.\r\n`;

/** Reads after every chunk, like the sign-in runners, and returns the first token found. */
function firstToken(output: string, size: number): string | undefined {
  for (let end = size; end < output.length + size; end += size) {
    const token = readClaudeToken(output.slice(0, end));
    if (token) return token;
  }
  return undefined;
}

describe("readClaudeToken", () => {
  it.each([["redrawn in place", redrawn], ["printed whole", printed]])("reads the whole token when it is %s, in any chunk size", (_, output) => {
    for (const size of [1, 7, output.length]) expect(firstToken(output, size)).toBe(TOKEN);
  });

  it("applies absolute cursor moves only for ConPTY, so macOS and Linux parse as before", () => {
    expect(screenText("ab\x1b[Hc")).toBe("abc");
    expect(screenText("ab\x1b[Hc", true)).toBe("cb");
    const conpty = `${intro}\x1b[H\x1b[3;1H${TOKEN}\x1b[K\r\n`;
    expect(readClaudeToken(conpty, true)).toBe(TOKEN);
  });

  it("reads nothing before the token is on screen", () => {
    expect(readClaudeToken(intro)).toBeUndefined();
  });
});

describe("claudeInstallerCommand", () => {
  it("keeps the macOS and Linux installer, and uses PowerShell on Windows", () => {
    expect(claudeInstallerCommand("darwin")).toEqual({
      command: "/bin/bash",
      args: ["-c", "curl -fsSL https://claude.ai/install.sh | bash"],
      display: "curl -fsSL https://claude.ai/install.sh | bash",
    });
    const windows = claudeInstallerCommand("win32");
    expect(windows.command).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    expect(windows.args.at(-1)).toBe("irm https://claude.ai/install.ps1 | iex");
  });
});
