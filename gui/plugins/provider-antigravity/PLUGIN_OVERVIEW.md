Use your Google AI plan in Cloudroom. This plugin adds Antigravity, Google's coding agent, as an agent next to Codex and Claude Code.

## What you get

- Antigravity in the agent picker, with every model your Google AI plan offers and each model's thinking levels.
- Google sign-in and sign-out from Cloudroom.
- Your plan's five-hour and weekly limits in the usage card.
- Permission modes `accept-edits` and `full`.

## How it works

The plugin launches the `agy` CLI on the host machine and talks to it over the Agent Client Protocol. Sign-in runs `agy acp --login`: Cloudroom opens Google's page and passes the one-time code back to the CLI. Usage comes from the CLI's own `/usage` command.

## Requirements

- Install the Antigravity CLI (`agy`) on the host. Settings → Agents → Harness can install it.
- A Google account with access to Antigravity.
