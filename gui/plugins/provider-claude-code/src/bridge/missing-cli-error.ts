const MISSING_NATIVE_CLI_PATTERN = /Native CLI binary for .+ not found/;
const MISSING_CLAUDE_CLI_GUIDANCE =
  "Cloudroom could not find the Claude Code CLI on this machine. Install Claude Code (https://claude.com/claude-code), or set BB_CLAUDE_CODE_EXECUTABLE to the full path of the claude binary, then restart Cloudroom.";
// npm 12 skips Claude Code's postinstall unless allowed, leaving the package's
// own placeholder as `claude`, which macOS won't run (#1074).
const PLACEHOLDER_PATTERN = /\bspawn ENOEXEC\b/;
const PLACEHOLDER_GUIDANCE =
  "Claude Code can't start: `claude` is still Claude Code's placeholder, because npm skipped its setup script, and Cloudroom could not finish it. Run `npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest` (with sudo if your npm installs need it), then send your message again.";

/** What to do when Claude Code is missing or only its placeholder, else null. */
export function claudeCliGuidance(message: string): string | null {
  if (MISSING_NATIVE_CLI_PATTERN.test(message)) {
    return MISSING_CLAUDE_CLI_GUIDANCE;
  }
  return PLACEHOLDER_PATTERN.test(message) ? PLACEHOLDER_GUIDANCE : null;
}

export function translateMissingClaudeCliError(error: unknown): unknown {
  const guidance =
    error instanceof Error ? claudeCliGuidance(error.message) : null;
  return guidance === null ? error : new Error(guidance, { cause: error });
}
