Start a thread, pick Claude Code, and let it work in your repository from Cloudroom. The plugin drives the Claude Code CLI on the host machine. It streams the agent's work into the Cloudroom timeline.

## What you get

- Permission modes `accept-edits`, `auto`, and `full`, plus a plan action in the composer.
- Reasoning levels from Low to Max, plus Ultracode, which turns on multi-agent workflow orchestration.
- Checkpoint forks, manual compaction, and native questions from the agent.
- Claude Code skills and CLAUDE.md files from your home directory and project.
- Health, usage, and install status for Claude Code on each host, with an install or update action.

## Selected skills

Skill tags selected in the composer load their `SKILL.md` instructions before Claude receives the request, anywhere in the message. Repeated tags load once per message; history keeps the original text. Missing or ambiguous skills fail visibly.

This is literal instruction loading, not native skill execution. `$ARGUMENTS` and `$ARGUMENTS[N]` are filled from the text typed after the tag. Native tool/model settings, hooks, and shell expansion require native invocation instead: type the leading slash command without selecting a tag. Plain text and unselected commands are unchanged.

## Settings

- `Claude Code memory`: let Claude Code read and write its auto-memory.
- `Disable provider subagents`: hide the native Task tool so the agent delegates through Cloudroom. On by default.
- `Disable Workflow tool`: hide the native Workflow tool.
- `Claude in Chrome`: start Claude Code with the browser tools.
- `claude.ai connectors`: load Gmail, Drive, and other connectors from your claude.ai account. Off by default.

## Requirements

- Install the Claude Code CLI (`claude`) on the host machine. The plugin can run the installer for you.
- Sign in with `claude` on that machine. Cloudroom reads the sign-in state to show account and plan.
- `Claude in Chrome` needs the Chrome extension and a claude.ai login on the host.
